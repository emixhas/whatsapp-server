#!/usr/bin/env python3
"""Senaryodaki her segmenti yerel olarak seslendirir ve public/episode.json üretir.

Sesler scripts/voices.py kataloğundan gelir; seçim data/settings.json → narration:
  {"mode": "single", "voice": "trendyol"}  ya da  {"mode": "alternate", "voiceA": "vox-kadin", "voiceB": "vox-erkek"}
Dönüşümlü modda kanca=A, intro=B, 1. haber=A, 2. haber=B … Bir ses çökerse o ses bu çalıştırma
için kapatılır ve ilgili segmentler otomatik sıradaki sesle yeniden üretilir (loga yazar).
Rakamlar seslendirmeden önce yazıya çevrilir (tr_numbers.py).

Kullanım: python3 scripts/tts.py work/script.json public/episode.json
"""
import json
import math
import os
import shutil
import subprocess
import sys
import wave
from array import array
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import align  # noqa: E402
import censor  # noqa: E402
import voices  # noqa: E402
from common import ROOT  # noqa: E402

PAUSE_SEC = 0.15  # her segment sonuna sessizlik


def word_timings(text: str, duration: float, pad: float):
    """Segment süresini kelimelere karakter ağırlığıyla dağıtır. TTS temposu sabit olduğu için
    yanan altyazı için yeterince isabetli; noktalama sonrası kısa duraklama payı bırakır."""
    words = text.split()
    if not words:
        return []
    speech = max(0.05, duration - pad)
    weights = []
    for w in words:
        core = sum(1 for ch in w if ch.isalnum())
        wt = 0.6 + core  # her kelimenin sabit bir eşik süresi + harf başına
        if w.endswith((".", "!", "?")):
            wt += 2.2
        elif w.endswith((",", ";", ":")):
            wt += 1.0
        weights.append(wt)
    total = sum(weights)
    out, t = [], 0.0
    for w, wt in zip(words, weights):
        d = speech * wt / total
        out.append({"w": w, "s": round(t, 3), "e": round(t + d, 3)})
        t += d
    return out


def wav_duration(path: Path) -> float:
    with wave.open(str(path), "rb") as w:
        return w.getnframes() / float(w.getframerate())


# Yayın kalitesi işleme: alçak uğultuyu kes, konuşma netliğini (3 kHz) hafif kaldır, dinamikleri
# toparla, sonuna kısa sessizlik. Tüm motorlarda uygulanır; Piper'ın düz tınısını belirgin iyileştirir.
POLISH = "highpass=f=70,equalizer=f=180:t=q:w=1.2:g=-1.5,equalizer=f=3000:t=q:w=1:g=2.2,equalizer=f=8000:t=q:w=1.5:g=1," \
         "acompressor=threshold=-20dB:ratio=2.5:attack=8:release=140:makeup=2,alimiter=limit=0.95"


def voice_gain_db(v: dict) -> float:
    """Ses seviyesi: tüm segmentler önce aynı yüksekliğe getirilir (-18 LUFS), sonra kadın sesi
    settings.narration.femaleGainDb (varsayılan +3 dB), erkek sesi maleGainDb (0) kadar yükseltilir.
    Cinsiyeti belirsiz motorlar (Trendyol, EMA…) kadın sesi sayılır; katalogdaki tek erkek ses vox-erkek."""
    n = voices._S.get("narration", {}) or {}
    key = "maleGainDb" if v.get("gender") == "erkek" else "femaleGainDb"
    return float(n.get(key, 0.0 if key == "maleGainDb" else 3.0))


# Ses hızı (kullanıcı isteği, 27 Ekim: "konuşan erkeğin sesini çok az hızlandıralım"): settings.narration.maleSpeed (varsayılan 1,07 =
# %7 hızlı) ve femaleSpeed (1,0); 0,85-1,25. Perde değişmez: ffmpeg'de rubberband varsa o (daha temiz), yoksa atempo. Sentezden hemen
# sonra, hizalamadan ÖNCE uygulanır: altyazı ve bip zamanları hızlanmış sese göre çıkar.
SPEED_DEFAULT = {"erkek": 1.07, "kadin": 1.0}
_RUBBERBAND = None


def voice_speed(v: dict) -> float:
    n = voices._S.get("narration", {}) or {}
    g = "erkek" if v.get("gender") == "erkek" else "kadin"
    try:
        f = float(n.get("maleSpeed" if g == "erkek" else "femaleSpeed", SPEED_DEFAULT[g]))
    except (TypeError, ValueError):
        f = SPEED_DEFAULT[g]
    return max(0.85, min(1.25, f))


def change_tempo(path: Path, factor: float) -> None:
    """Sesi perdeyi değiştirmeden factor kadar hızlandırır/yavaşlatır (yerinde)."""
    global _RUBBERBAND
    if abs(factor - 1.0) < 0.005:
        return
    if _RUBBERBAND is None:
        r = subprocess.run(["ffmpeg", "-hide_banner", "-filters"], capture_output=True, text=True)
        _RUBBERBAND = " rubberband " in (r.stdout or "")
    af = f"rubberband=tempo={factor:.3f}" if _RUBBERBAND else f"atempo={factor:.3f}"
    tmp = path.with_name(path.stem + ".tempo.wav")
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(path), "-af", af, "-ar", "44100", "-ac", "1", str(tmp)], check=True)
    tmp.replace(path)


# Seslendirme yoğunluğu (kullanıcı isteği, 27 Ekim: "kadın ve erkeğin ses seviyesini artıralım"): eşit yükseklik ve ses kazancından sonra
# yayın tipi sıkıştırma (3:1, -21 dB, yumuşak diz, +4 dB) ve -1 dBFS tepe sınırı. Konuşmanın tepe/ortalama farkı ~15 dB'den ~11,5 dB'ye
# iner: aynı tepe seviyesinde ~2-3 dB daha yüksek duyulur, son video -12 LUFS hedefine (pipeline.sh) tepe sınırını aşmadan ulaşabilir.
# Ölçüm (espeak-ng Türkçe konuşma, kadın +3 dB): eski zincir -14,8 LUFS / tepe 0 dB, yeni -12,6 LUFS / tepe -1 dB.
# settings.audio.voiceCompress false eski zinciri kullanır.
VOICE_MAX = "acompressor=threshold=-21dB:ratio=3:attack=5:release=70:knee=4:makeup=4,alimiter=limit=0.89:attack=4:release=60:level=false"


def add_pause(path: Path, gain_db: float = 0.0) -> None:
    tmp = path.with_name(path.stem + ".tmp.wav")
    # eşit yükseklik + ses kazancı; sıkıştırıcı + limitleyici seslendirmeyi yoğunlaştırır, bozulmayı (patlamayı) önler
    dense = (voices._S.get("audio") or {}).get("voiceCompress") is not False
    level = f"loudnorm=I=-18:TP=-2:LRA=11,volume={gain_db:+.1f}dB," + (VOICE_MAX if dense else "alimiter=limit=0.95")
    af = (POLISH + "," if os.environ.get("TTS_POLISH", "1") != "0" else "") + level + f",apad=pad_dur={PAUSE_SEC}"
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(path), "-af", af, "-ar", "44100", "-ac", "1", str(tmp)], check=True)
    tmp.replace(path)


# Hassas kelime bipi (kullanıcı şikâyeti, 27 Ekim: "bip sonrası bir bozuk ses de gelebiliyor"): eskiden cümle hassas kelimenin
# önünden ve arkasından PARÇALARA bölünüp her parça ayrı seslendiriliyordu; "etti." gibi tek kelimelik parçayı ses modelleri (VoxCPM,
# Trendyol) bozuk/gevelenmiş okuyordu, tek başına okunan kelimenin tonlaması da cümleye uymuyordu. Şimdi segment BÜTÜN seslendirilir;
# kelimenin sesteki yeri altyazı hizalamasından (metin hizalama → konuşma tanıma → duraklama çapası) gelir; o aralıkta konuşma ~10 dB
# kısılır (kelime arkadan duyulur, anlaşılır) ve üstüne aynı yükseklikte 1 kHz bip biner. Kenarlar 15 ms yumuşak (tık sesi yok).
BLEEP_HZ = 1000.0
BLEEP_DUCK_DB = -10.0
BLEEP_RAMP = 0.015
# yöntemin isabetine göre pay (sn, önce/sonra): metin hizalama kareye oturur; duraklama çapası kelime içi ±0,1 sn kayabilir
BLEEP_MARGIN = {"metin hizalama": (0.03, 0.04), "konuşma tanıma": (0.06, 0.07), "duraklama çapası": (0.10, 0.10)}


def _rcos(x: float) -> float:
    """0 → 1 yumuşak geçiş (yükseltilmiş kosinüs)."""
    x = 0.0 if x <= 0 else 1.0 if x >= 1 else x
    return 0.5 - 0.5 * math.cos(math.pi * x)


def bleep_spans(path: Path, spans: list, how: str) -> list:
    """Segment sesinde (mono 16 bit wav, yerinde) verilen kelime aralıklarına bip bindirir; birbirine 0,15 sn'den yakın aralıklar tek
    bip olur. Dönüş: uygulanan aralıklar [(başlangıç, bitiş)], sn. Bip seviyesi konuşmanın kendi RMS'i (seslendirme motoru ve kazançtan
    bağımsız): bip baskın, kısılmış kelime ~10 dB altta."""
    pre, post = BLEEP_MARGIN.get(how, (0.18, 0.18))
    with wave.open(str(path), "rb") as w:
        ch, sw, sr, n = w.getnchannels(), w.getsampwidth(), w.getframerate(), w.getnframes()
        frames = w.readframes(n)
    if ch != 1 or sw != 2:  # add_pause hep mono 16 bit yazar; başka biçim gelirse önce çevrilir
        tmp = path.with_name(path.stem + ".pcm.wav")
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(path), "-ac", "1", "-c:a", "pcm_s16le", str(tmp)], check=True)
        tmp.replace(path)
        return bleep_spans(path, spans, how)
    a = array("h")
    a.frombytes(frames)
    if sys.byteorder == "big":
        a.byteswap()
    dur = n / float(sr)
    iv = sorted((max(0.0, float(s_) - pre), min(dur, float(e_) + post)) for s_, e_ in spans if float(e_) > float(s_))
    merged: list = []
    for s_, e_ in iv:
        if merged and s_ - merged[-1][1] < 0.15:
            merged[-1][1] = max(merged[-1][1], e_)
        else:
            merged.append([s_, e_])
    if not merged:
        return []
    gate = 0.02 * 32767
    loud = [x for x in a if x > gate or x < -gate]
    ref = math.sqrt(sum(x * x for x in loud) / len(loud)) if loud else 3000.0
    amp = min(0.5 * 32767, ref * math.sqrt(2.0))  # bipin RMS'i konuşmanınkine eşit
    duck = 10 ** (BLEEP_DUCK_DB / 20.0)
    w2 = 2.0 * math.pi * BLEEP_HZ
    for s_, e_ in merged:
        i0, i1 = max(0, int((s_ - BLEEP_RAMP) * sr)), min(n, int(math.ceil((e_ + BLEEP_RAMP) * sr)))
        for i in range(i0, i1):
            t = i / float(sr)
            wv = _rcos((t - (s_ - BLEEP_RAMP)) / BLEEP_RAMP) if t < s_ else _rcos(((e_ + BLEEP_RAMP) - t) / BLEEP_RAMP) if t > e_ else 1.0
            v = a[i] * (1.0 - (1.0 - duck) * wv)
            if s_ <= t <= e_:
                v += amp * _rcos(min((t - s_) / BLEEP_RAMP, (e_ - t) / BLEEP_RAMP)) * math.sin(w2 * (t - s_))
            a[i] = 32767 if v > 32767 else -32768 if v < -32768 else int(round(v))
    if sys.byteorder == "big":
        a.byteswap()
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(a.tobytes())
    return [(round(x, 3), round(y, 3)) for x, y in merged]


def main(script_path: str, episode_path: str):
    script = json.loads(Path(script_path).read_text(encoding="utf-8"))
    segs = script["segments"]
    audio_dir = ROOT / "public" / "audio"
    audio_dir.mkdir(parents=True, exist_ok=True)
    for f in audio_dir.glob("seg-*.wav"):
        f.unlink()
    outs = [audio_dir / f"seg-{i:02d}.wav" for i in range(len(segs))]
    chosen = voices.assign(len(segs))
    snd = {i for i, seg in enumerate(segs) if seg.get("kind") == "sesli"}  # videonun kendi sesi: seslendirilmez
    # Hassas kelimeler (censor.py): segment bütün seslendirilir, kelimenin sesteki yerine hizalamadan sonra bip biner (bleep_spans)
    hits = {i: censor.token_hits(seg["narration"]) for i, seg in enumerate(segs) if i not in snd} if censor.audio_on() else {}
    hits = {i: h for i, h in hits.items() if h}
    beeped = sum(len(h) for h in hits.values())
    if beeped:
        print(f"  🔇 {beeped} hassas kelime bipleniyor (cümle bütün okunur, bip kelimenin üstüne biner; kelime arkadan kısık duyulur), "
              "yazıda yıldızla gizleniyor", flush=True)
    for i in snd:  # süresi klip kadar sessiz ses: sahne zamanlaması sesten geldiği için
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i", "anullsrc=r=24000:cl=mono",
                        "-t", f"{float(segs[i].get('soundDuration') or 1):.3f}", str(outs[i])], check=True)
    pending = [i for i in range(len(segs)) if i not in snd]
    for attempt in range(6):
        jobs = [{"voice": chosen[i], "text": segs[i]["narration"], "out": outs[i]} for i in pending]
        try:
            voices.synthesize(jobs)
            pending = []
            # panel bu satırı "Ses modeli sorunsuz başlatıldı" diye seslendirir
            print(f"🔊 ses modeli sorunsuz başlatıldı: {' + '.join(dict.fromkeys(c['label'] for c in chosen))}", flush=True)
            break
        except RuntimeError as e:
            bad = str(e).split(":")[0]
            print(f"  ! ses '{bad}' başarısız ({str(e)[:240]}); yedek sese geçiliyor", file=sys.stderr)
            voices._disabled.add(bad)
            pending = [i for i in pending if not outs[i].exists() or chosen[i]["id"] == bad]
            repl = voices.resolve("auto")
            for i in pending:
                if chosen[i]["id"] == bad:
                    chosen[i] = repl
    if pending:
        sys.exit("Seslendirme tamamlanamadı")
    sped = {}
    for i in range(len(segs)):  # sese göre hız (erkek sesi biraz hızlı); altyazı ve bip zamanları bundan sonra çıkar
        if i not in snd:
            f = voice_speed(chosen[i])
            if abs(f - 1.0) >= 0.005:
                change_tempo(outs[i], f)
                sped[chosen[i]["label"]] = f
    for label, f in sped.items():
        print(f"  ⏩ {label}: konuşma %{round((f - 1) * 100):+d} hızlı (perde aynı; ayar: Ayarlar → Sesler)", flush=True)

    # hizalama işlenmemiş seste yapılır (sıkıştırıcı gürültüyü yükseltiyor): önce tüm segmentlerin ham kopyası, sonra
    # metin hizalama (MMS) bütün segmentler için TEK seferde (1,2 GB model bir kez yüklenir); hassas kelimeli segment de hizalanır,
    # bip bu kelime zamanlarına biner
    raws = {}
    for i in range(len(segs)):
        raws[i] = outs[i].with_name(outs[i].stem + ".align.wav")
        shutil.copyfile(outs[i], raws[i])
    try:
        align.mms_batch([(raws[i], censor.mask(seg["narration"]).split(), seg["narration"].split()) for i, seg in enumerate(segs) if i not in snd])
    except Exception as e:
        print(f"  ! metin hizalama atlandı: {str(e)[:160]}", file=sys.stderr)
    segments = []
    for i, seg in enumerate(segs):
        out = outs[i]
        raw = raws[i]
        if i in snd:  # orijinal sesli bölüm: altyazı videodaki konuşmanın kelimeleri (wa_video.py, konuşma tanıma)
            raw.unlink(missing_ok=True)
            seg = dict(seg, audio=f"audio/{out.name}", voice="orijinal", duration=round(wav_duration(out), 3), captionSync="orijinal ses",
                       words=[{"w": censor.mask(w["w"]), "s": w["s"], "e": w["e"]} for w in seg.get("soundWords") or []])
            seg.pop("soundWords", None)
            segments.append(seg)
            continue
        add_pause(out, voice_gain_db(chosen[i]))
        seg = dict(seg)
        seg["audio"] = f"audio/{out.name}"
        seg["voice"] = chosen[i]["id"]
        seg["duration"] = round(wav_duration(out), 3)
        # yanan altyazı ses ile eş zamanlı (align.py): metin hizalama / konuşma tanıma varsa gerçek kelime zamanları, yoksa duraklama
        # çapaları. Hassas kelime yıldızlı (int*har); bip bu zamanlara göre kelimenin üstüne biner.
        shown = censor.mask(seg["narration"]).split()
        words, how = align.align(shown, raw, 0.0, spoken=seg["narration"].split())
        if how == "konuşma tanıma" and align.LAST_COVERAGE is not None:
            seg["captionCoverage"] = round(align.LAST_COVERAGE, 2)
        if not words:
            words, how = word_timings(" ".join(shown), seg["duration"], PAUSE_SEC), "tahmin"
        raw.unlink(missing_ok=True)
        if i in hits:
            spans = [(words[k]["s"], words[k]["e"]) for k in hits[i] if k < len(words)]
            try:
                seg["bleeps"] = [list(x) for x in bleep_spans(out, spans, how)]
            except Exception as e:  # bozuk ses dosyası: üretim durmasın, kelime bipsiz kalır (yazıda yine yıldızlı)
                print(f"  ! {i}. segment: bip uygulanamadı ({str(e)[:120]}); hassas kelime bipsiz kaldı", file=sys.stderr)
            if how not in BLEEP_MARGIN:
                print(f"  ! {i}. segment: kelime zamanları tahmini ({how}); bip geniş tutuldu (±0,18 sn)", file=sys.stderr)
        seg["words"] = words
        seg["captionSync"] = how
        segments.append(seg)

    sync = [s_.get("captionSync") for s_ in segments if s_.get("captionSync")]
    if sync:
        cov = [s_["captionCoverage"] for s_ in segments if s_.get("captionCoverage") is not None]
        note = ""
        if cov:
            note = f" (konuşma tanıma kelimelerin %{round(sum(cov) / len(cov) * 100)}'ini sesle doğrudan eşledi)"
        if "metin hizalama" not in sync and not cov:
            note = " — metin hizalama kurulu değil: Mac'te bir kez 'bash scripts/install_align.sh' çalıştırın, altyazı sese birebir oturur"
        print("  🔤 altyazı senkronu: " + ", ".join(f"{k} {sync.count(k)}" for k in dict.fromkeys(sync)) + note, flush=True)
    # altyazı kaydırma (panel ayarı): sabit bir gecikme/erken gelme varsa tek ayarla düzeltilir; Remotion okur
    try:
        lead = float((voices._S.get("captions") or {}).get("leadSec", 0.06))
    except Exception:
        lead = 0.06
    episode = {k: v for k, v in script.items() if k != "segments"}
    episode["segments"] = segments
    episode["captionLead"] = lead
    Path(episode_path).write_text(json.dumps(episode, ensure_ascii=False, indent=2), encoding="utf-8")
    total = sum(s["duration"] for s in segments)
    used = " + ".join(dict.fromkeys(c["label"] for c in chosen))
    print(f"[{used}] {len(segments)} segment, toplam {total:.1f} sn -> {episode_path}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
