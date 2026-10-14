#!/usr/bin/env python3
"""Yanan altyazıyı sesle eş zamanlar (kullanıcı isteği: "alt yazı ses ile eşit gitmeli").

Üç yol, sırayla:
  0. Metni sese zorla hizalama (MMS, `scripts/mms_align.py`, ayrı ortam .venv-align): bilinen metin sesin karelerine
     oturtulur, en isabetlisi. Kurulum: bash scripts/install_align.sh
  1. Konuşma tanıma ile kelime zamanları (mlx-whisper; Apple Silicon'da hızlı, Türkçe). Kuruluysa ve
     `settings.captions.whisper` kapalı değilse kullanılır: ses yazıya dökülür, tanınan kelimeler senaryodaki
     kelimelerle sırayla eşlenir (difflib), eşlenen kelime gerçek zamanını alır, eşlenmeyen komşuları arasında
     paylaştırılır. Kurulum: bash scripts/install_align.sh
  2. Sessizlik çapası (her zaman): sesin gerçek başı/sonu ve cümle içi duraklamalar (ffmpeg silencedetect) bulunur;
     noktalama olan kelime sonları en yakın duraklamaya oturtulur, aradaki kelimeler harf ağırlığıyla dağıtılır.
     Eski yöntem (tüm segmente harf ağırlığıyla yayma) kayıyordu; çapalar kaymayı her duraklamada sıfırlar.

Kullanım (deneme): python3 scripts/align.py public/audio/seg-01.wav "Seslendirme metni burada."
"""
import difflib
import re
import os
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import settings  # noqa: E402

PUNCT_END = (".", "!", "?")
PUNCT_MID = (",", ";", ":")


def spoken_len(w: str) -> int:
    """Kelimenin SÖYLENEN uzunluğu: rakamlar yazıya çevrilir ("5" → "beş", "1.250" → "bin iki yüz elli"), yıldızlı
    kelime özgün uzunlukta sayılır. Ekranda "5" tek harf ama söylenmesi uzun; eski ağırlık bu yüzden kayıyordu."""
    try:
        from voices import prep_text
        sp = prep_text(w.replace("*", "a"))
    except Exception:
        sp = w
    return sum(1 for ch in sp if ch.isalnum())


def _weight(w: str) -> float:
    wt = 0.6 + spoken_len(w)
    if w.endswith(PUNCT_END):
        wt += 1.2  # cümle sonu uzatması (duraklamanın kendisi çapalarla ayrıca bulunur)
    elif w.endswith(PUNCT_MID):
        wt += 0.5
    return wt


def spread(words: list, start: float, end: float) -> list:
    """Kelimeleri [start, end] aralığına söylenen uzunluk ağırlığıyla yayar."""
    if not words:
        return []
    weights = [_weight(w) for w in words]
    total = sum(weights) or 1.0
    span = max(0.05, end - start)
    out, t = [], start
    for w, wt in zip(words, weights):
        d = span * wt / total
        out.append({"w": w, "s": round(t, 3), "e": round(t + d, 3)})
        t += d
    return out


def noise_floor(wav: Path) -> int:
    """Uyarlanır sessizlik eşiği: ortalama sesin 17 dB altı (-50…-28 dB arası). Sabit -38 dB, arka plan uğultusu ya da
    yankısı olan seslerde duraklamaları kaçırıyordu."""
    r = subprocess.run(["ffmpeg", "-hide_banner", "-nostats", "-i", str(wav), "-af", "volumedetect", "-f", "null", "-"],
                       capture_output=True, text=True)
    m = re.search(r"mean_volume: (-?[\d.]+) dB", r.stderr)
    return int(max(-50, min(-28, (float(m.group(1)) if m else -21) - 17)))


def silences(wav: Path, noise_db: int | None = None, min_d: float = 0.12) -> tuple:
    """(sessizlik aralıkları [(başlangıç, bitiş)], toplam süre)."""
    if noise_db is None:
        noise_db = noise_floor(wav)
    r = subprocess.run(["ffmpeg", "-hide_banner", "-nostats", "-i", str(wav), "-af", f"silencedetect=noise={noise_db}dB:d={min_d}",
                        "-f", "null", "-"], capture_output=True, text=True)
    starts = [float(x) for x in re.findall(r"silence_start: (-?[\d.]+)", r.stderr)]
    ends = [float(x) for x in re.findall(r"silence_end: ([\d.]+)", r.stderr)]
    dur = re.search(r"Duration: (\d+):(\d+):([\d.]+)", r.stderr)
    total = int(dur.group(1)) * 3600 + int(dur.group(2)) * 60 + float(dur.group(3)) if dur else 0.0
    pairs = [(max(0.0, s), e) for s, e in zip(starts, ends)]
    if len(starts) > len(ends):  # sonda biten sessizlik
        pairs.append((max(0.0, starts[-1]), total))
    return pairs, total


def by_silence(words: list, wav: Path, pad: float) -> list:
    pairs, total = silences(wav)
    if total <= 0:
        return []
    v0, v1 = 0.0, max(0.1, total - pad)
    if pairs and pairs[0][0] <= 0.02:  # baştaki sessizlik
        v0 = min(pairs[0][1], v1 - 0.1)
    tail = [p for p in pairs if p[1] >= total - 0.02]
    if tail:
        v1 = max(v0 + 0.1, tail[0][0])
    inner = [p for p in pairs if p[0] > v0 + 0.05 and p[1] < v1 - 0.05]
    # her noktalama kelime sonu için tahmini zaman → en yakın duraklama (±0,7 sn, sırayı bozmadan)
    est = spread(words, v0, v1)
    anchors, used, last_t = [], set(), v0
    for i, w in enumerate(words[:-1]):
        if not w.endswith(PUNCT_END + PUNCT_MID):
            continue
        t = est[i]["e"]
        best = None
        for k, (a, b) in enumerate(inner):
            if k in used or a < last_t:
                continue
            if abs(a - t) <= 0.7 and (best is None or abs(a - t) < abs(inner[best][0] - t)):
                best = k
        if best is not None:
            used.add(best)
            anchors.append((i, inner[best][0], inner[best][1]))
            last_t = inner[best][1]
    out, start_i, t0 = [], 0, v0
    for i, a, b in anchors:
        out += spread(words[start_i:i + 1], t0, a)
        start_i, t0 = i + 1, b
    out += spread(words[start_i:], t0, v1)
    return out


_WHISPER = None
LAST_COVERAGE = None  # son konuşma tanıma hizalamasında sesle doğrudan eşlenen kelime oranı (log için)


def _auto_install(c: dict) -> None:
    """Apple Silicon Mac'te mlx-whisper yoksa bir kez kurmayı dener (kullanıcı: altyazı senkronu "çok önemli").
    `captions.autoInstall: false` kapatır; başarısız deneme 24 saatte bir tekrarlanır."""
    import importlib.util
    import json
    import platform
    import time
    if c.get("autoInstall") is False or importlib.util.find_spec("mlx_whisper") or platform.system() != "Darwin" or platform.machine() != "arm64":
        return
    mark = Path(__file__).resolve().parent.parent / "work" / ".align_install.json"
    try:
        if time.time() - json.loads(mark.read_text()).get("at", 0) < 86400:
            return
    except Exception:
        pass
    mark.parent.mkdir(parents=True, exist_ok=True)
    mark.write_text(json.dumps({"at": time.time()}))
    print("  🔤 altyazı senkronu için konuşma tanıma (mlx-whisper) kuruluyor (bir kez)…", file=sys.stderr, flush=True)
    r = subprocess.run([sys.executable, "-m", "pip", "install", "--quiet", "mlx-whisper"], capture_output=True, text=True, timeout=600)
    importlib.invalidate_caches()
    print("  🔤 mlx-whisper " + ("kuruldu; model ilk kullanımda indirilir" if r.returncode == 0 else f"kurulamadı: {(r.stderr or '')[-160:]}"),
          file=sys.stderr, flush=True)


def _whisper():
    """mlx-whisper (ya da faster-whisper) kuruluysa tanıma fonksiyonu; değilse None."""
    global _WHISPER
    if _WHISPER is not None:
        return _WHISPER or None
    c = settings().get("captions") or {}
    if c.get("whisper") is False:
        _WHISPER = False
        return None
    _auto_install(c)
    try:
        import mlx_whisper  # noqa: F401
        # large-v3-turbo: Türkçede small'dan belirgin isabetli kelime zamanı, Apple Silicon'da segment başına ~1-2 sn
        # (ilk kullanımda ~1,6 GB iner). Yüklenemezse bir kez small'a düşer.
        models = [c.get("whisperModel") or "mlx-community/whisper-large-v3-turbo", "mlx-community/whisper-small-mlx"]

        def run(path):
            while True:
                try:
                    r = mlx_whisper.transcribe(str(path), path_or_hf_repo=models[0], language="tr", word_timestamps=True, verbose=None)
                    break
                except Exception as e:
                    if len(models) < 2:
                        raise
                    print(f"  ! konuşma tanıma modeli {models[0]} açılamadı ({str(e)[:80]}); {models[1]} kullanılıyor", file=sys.stderr)
                    models.pop(0)
            return [(w["word"], float(w["start"]), float(w["end"])) for s in r.get("segments", []) for w in s.get("words", [])]
        _WHISPER = run
    except Exception:
        try:
            from faster_whisper import WhisperModel
            m = WhisperModel(c.get("fasterWhisperModel") or "small", compute_type="int8")

            def run(path):
                segs, _ = m.transcribe(str(path), language="tr", word_timestamps=True)
                return [(w.word, float(w.start), float(w.end)) for s in segs for w in (s.words or [])]
            _WHISPER = run
        except Exception:
            _WHISPER = False
    return _WHISPER or None


def _norm(w: str) -> str:
    return re.sub(r"[^\wçğıöşü]", "", w.replace("I", "ı").replace("İ", "i").lower())


def by_whisper(words: list, wav: Path, spoken: list | None = None) -> list:
    """Tanınan kelimelerle eşleştirme. `spoken`: seslendirilen biçim (rakamlar yazıya çevrilmiş olabilir; yoksa words)."""
    run = _whisper()
    if not run:
        return []
    try:
        rec = run(wav)
    except Exception as e:
        print(f"  ! konuşma tanıma hizalaması atlandı: {str(e)[:120]}", file=sys.stderr)
        return []
    if len(rec) < max(2, len(words) // 3):
        return []
    a = [_norm(w) for w in (spoken or words)]
    b = [_norm(w) for w, _, _ in rec]
    times = [None] * len(words)
    for blk in difflib.SequenceMatcher(None, a, b, autojunk=False).get_matching_blocks():
        for k in range(blk.size):
            if blk.a + k < len(words):
                _, s, e = rec[blk.b + k]
                times[blk.a + k] = (s, e)
    global LAST_COVERAGE
    LAST_COVERAGE = sum(1 for t in times if t) / max(1, len(words))
    if sum(1 for t in times if t) < max(2, len(words) // 2):
        return []  # tanıma metne yeterince uymadı
    # eşlenmeyen kelimeler: önceki eşlenenin sonu ile sonraki eşlenenin başı arasına yayılır
    out, i = [], 0
    while i < len(words):
        if times[i]:
            out.append({"w": words[i], "s": round(times[i][0], 3), "e": round(times[i][1], 3)})
            i += 1
            continue
        j = i
        while j < len(words) and not times[j]:
            j += 1
        t0 = out[-1]["e"] if out else (rec[0][1] if rec else 0.0)
        t1 = times[j][0] if j < len(words) else (rec[-1][2] if rec else t0 + 0.5)
        out += spread(words[i:j], t0, max(t0 + 0.05 * (j - i), t1))
        i = j
    return out


ROOT = Path(__file__).resolve().parent.parent
ALIGN_PY = ROOT / ".venv-align" / "bin" / "python"


def _mms_python():
    """Metin hizalama (MMS) için torchaudio'lu Python: önce ayrı ortam .venv-align, yoksa torchaudio'su olan proje Python'u."""
    if ALIGN_PY.exists():
        return ALIGN_PY
    try:
        from voices import python_with
        return python_with("torchaudio")
    except Exception:
        return None


_MMS_CACHE: dict = {}  # wav yolu → kelime zamanları (mms_batch doldurur; model bir kez yüklenir)


def _pairs(words: list, spoken: list | None):
    try:
        from tr_numbers import _SCORE, _SPORT
        from voices import prep_text
        src = list(spoken or words)
        # skor bağlamı cümle düzeyinde (tek kelimede "4-1" bağlamsız kalır): seslendirmeyle aynı okunuş ("dört bir")
        sport = bool(_SPORT.search(" ".join(src)))
        sp = [prep_text(_SCORE.sub(r"\1 \2", w) if sport else w.replace("*", "")) for w in src]
    except Exception:
        sp = list(spoken or words)
    if len(sp) != len(words):
        sp = list(words)
    return [[w, x] for w, x in zip(words, sp)]


def mms_batch(jobs: list) -> int:
    """Tüm segmentleri tek süreçte hizalar (model bir kez yüklenir). jobs: [(wav, words, spoken)]. Başarılı sayı."""
    if (settings().get("captions") or {}).get("forcedAlign") is False or not jobs:
        return 0
    py = _mms_python()
    if not py:
        return 0
    import json
    import tempfile
    payload = [{"wav": str(w), "pairs": _pairs(ws, sp)} for w, ws, sp in jobs]
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False)
        tmp = f.name
    try:
        env = dict(os.environ)
        if not Path(env.get("SSL_CERT_FILE") or "/yok").exists() and Path("/etc/ssl/cert.pem").exists():
            env["SSL_CERT_FILE"] = "/etc/ssl/cert.pem"  # model indirmesi: python.org Python'u sistem sertifikalarını görmez
        r = subprocess.run([str(py), str(ROOT / "scripts" / "mms_align.py"), tmp], capture_output=True, text=True, timeout=900, env=env)
        out = json.loads((r.stdout or "").strip().splitlines()[-1]) if (r.stdout or "").strip() else {"ok": False, "error": (r.stderr or "")[-200:]}
    except Exception as e:
        out = {"ok": False, "error": str(e)[:200]}
    finally:
        Path(tmp).unlink(missing_ok=True)
    if not out.get("ok"):
        err = str(out.get("error"))
        hint = (" — model indirilemedi (sertifika); Mac'te bir kez: bash scripts/install_align.sh" if "CERTIFICATE_VERIFY_FAILED" in err
                else "")
        print(f"  ! metin hizalama çalışmadı: {err[:200]}{hint}", file=sys.stderr)
        return 0
    n = 0
    for (w, ws, _), res in zip(jobs, out.get("results") or []):
        if res.get("ok") and len(res.get("words") or []) == len(ws):
            _MMS_CACHE[str(w)] = res["words"]
            n += 1
        else:
            print(f"  ! metin hizalama ({Path(w).name}): {str(res.get('error', 'kelime sayısı tutmadı'))[:120]}", file=sys.stderr)
    return n


def by_mms(words: list, wav: Path, spoken: list | None = None) -> list:
    """Metni sese zorla hizalama sonucu (önce mms_batch ile toplu hesaplanır; yoksa bu segment için tek başına)."""
    if str(wav) not in _MMS_CACHE:
        mms_batch([(wav, words, spoken)])
    res = _MMS_CACHE.get(str(wav)) or []
    return res if len(res) == len(words) else []


def align(words: list, wav: Path, pad: float, spoken: list | None = None) -> tuple:
    """(zamanlı kelimeler, yöntem adı). words: ekranda görünecek kelimeler (yıldızlı olabilir)."""
    global LAST_COVERAGE
    LAST_COVERAGE = None
    if not words:
        return [], "boş"
    w = by_mms(words, wav, spoken)  # en isabetli: bilinen metin sese oturtulur
    if w:
        return w, "metin hizalama"
    w = by_whisper(words, wav, spoken)
    if w:
        return w, "konuşma tanıma"
    s = by_silence(words, wav, pad)
    if s:
        return s, "duraklama çapası"
    return [], "yok"


if __name__ == "__main__":
    wav, text = Path(sys.argv[1]), " ".join(sys.argv[2:])
    res, how = align(text.split(), wav, 0.15)
    print(how)
    for x in res:
        print(f"{x['s']:6.2f}–{x['e']:6.2f}  {x['w']}")
