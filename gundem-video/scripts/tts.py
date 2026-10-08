#!/usr/bin/env python3
"""Senaryodaki her segmenti yerel olarak seslendirir ve public/episode.json üretir.

Motor sırası (narrationEngine=auto): Trendyol-TTS (VoxCPM2 tabanlı Türkçe, en doğal) → EMA Lightning
(34 MB, hızlı) → Chatterbox → macOS 'say' (Yelda) → Piper. Hepsi tamamen yerel, API anahtarı yok.
Rakamlar seslendirmeden önce yazıya çevrilir (tr_numbers.py).

Kullanım: python3 scripts/tts.py work/script.json public/episode.json
"""
import json
import os
import re
import shutil
import subprocess
import sys
import wave
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import settings  # noqa: E402
from natural_tts import chatterbox_ready, chatterbox_tts  # noqa: E402
from tr_numbers import normalize_tr  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
_S = settings()
TR = _S.get("turkishVoice", {})
TR_PY = ROOT / TR.get("python", ".venv-tr/bin/python")
TR_BIN = ROOT / TR.get("trendyolBin", ".venv-tr/bin/trendyol-tts")
TR_MLX = ROOT / TR.get("mlxModel", "models/Trendyol-TTS-mlx")
VOICE = os.environ.get("PIPER_VOICE", str(ROOT / "voices" / "tr_TR-dfki-medium.onnx"))
PIPER_LENGTH = os.environ.get("PIPER_LENGTH_SCALE", "0.82")  # <1 daha hızlı. 1.0 ≈ 120 kelime/dk, 0.82 ≈ 150 (haber temposu)
PAUSE_SEC = 0.15  # her segment sonuna sessizlik (Piper zaten cümle sonu boşluğu ekler)


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


def tts_piper(text: str, out: Path) -> None:
    subprocess.run(
        ["piper", "--model", VOICE, "--length_scale", PIPER_LENGTH, "--noise_scale", "0.5", "--noise_w_scale", "0.6",
         "--sentence_silence", "0.12", "--output_file", str(out)],
        input=text.encode("utf-8"), check=True, capture_output=True,
    )


def tts_macos_say(text: str, out: Path) -> None:
    aiff = out.with_suffix(".aiff")
    v = _S.get("voice", {})
    subprocess.run(["say", "-v", v.get("name", "Yelda"), "-r", str(int(v.get("rate", 195)) - 15), "-o", str(aiff), text], check=True)
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(aiff), "-ar", "44100", "-ac", "1", str(out)], check=True)
    aiff.unlink(missing_ok=True)


def tts_silent(text: str, out: Path) -> None:
    """Ses motoru olmadan boru hattını test etmek için: metin uzunluğuna göre sessizlik üretir."""
    secs = max(1.0, len(text) / 15.0)
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono", "-t", f"{secs:.2f}", str(out)], check=True)


def tr_lower(w: str) -> str:
    return w.replace("İ", "i").replace("I", "ı").lower()


def prep_text(text: str) -> str:
    """Yerel modeller için: rakamlar yazıya, BÜYÜK HARFLİ kelimeler (NATO, MEB) normal yazıma."""
    t = normalize_tr(text)
    return re.sub(r"\b([A-ZÇĞİÖŞÜ]{4,})\b", lambda m: m.group(1)[0] + tr_lower(m.group(1)[1:]), t)


def resample(src: Path, out: Path) -> None:
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(src), "-ar", "44100", "-ac", "1", str(out)], check=True)
    if src != out:
        src.unlink(missing_ok=True)


def trendyol_mlx_ready() -> bool:
    return TR_BIN.exists() and TR_MLX.is_dir() and any(TR_MLX.iterdir())


_import_cache: dict = {}
_disabled: set = set()  # bu çalıştırmada çöken motorlar


def python_with(module: str):
    """module'ü içe aktarabilen ilk Python yorumlayıcısı (proje .venv'i ya da .venv-tr), yoksa None."""
    if module in _import_cache:
        return _import_cache[module]
    found = None
    for py in (Path(sys.executable), TR_PY):
        if py.exists() and subprocess.run([str(py), "-c", f"import {module}"], capture_output=True).returncode == 0:
            found = py
            break
    _import_cache[module] = found
    return found


def tts_trendyol(text: str, out: Path) -> None:
    """Trendyol-TTS, MLX çalışma zamanı (Apple Silicon'da yerel). 48 kHz üretir, 44.1 kHz'e çevrilir."""
    tmp = out.with_name(out.stem + ".tr.wav")
    env = {**os.environ, "MLX_ARTIFACT_DIR": str(TR_MLX), "INFERENCE_SEED": str(TR.get("seed", 42))}
    cmd = [str(TR_BIN), "--text", prep_text(text), "--out", str(tmp), "--device", "mps", "--backend", "mlx",
           "--cfg", str(TR.get("cfg", 2.0)), "--steps", str(TR.get("steps", 16)), "--max-len", "4096", "--mlx-artifact-dir", str(TR_MLX)]
    r = subprocess.run(cmd, capture_output=True, text=True, env=env, cwd=ROOT)
    if r.returncode != 0 or not tmp.exists():
        raise RuntimeError("trendyol-tts: " + (r.stderr or r.stdout).strip()[-400:])
    resample(tmp, out)


def tts_trendyol_batch(jobs: list) -> None:
    """Trendyol-TTS, PyTorch/MPS yolu (MLX yoksa ya da klon sesi istendiyse). Model bir kez yüklenir."""
    env = {**os.environ, "VOX_MODEL": TR.get("torchModel", "Trendyol/Trendyol-TTS"), "VOX_CFG": str(TR.get("cfg", 2.0)),
           "VOX_STEPS": str(TR.get("steps", 16)), "VOX_SEED": str(TR.get("seed", 42))}
    ref = TR.get("refVoice") or ""
    if ref and (ROOT / ref).exists():
        env["VOX_REF"] = str(ROOT / ref)
    r = subprocess.run([str(TR_PY), str(ROOT / "scripts" / "voxcpm_tts.py")], input=json.dumps(jobs), text=True, cwd=ROOT, env=env, capture_output=True)
    if r.returncode != 0:
        raise RuntimeError("voxcpm: " + r.stderr.strip()[-400:])


def tts_ema_batch(jobs: list) -> None:
    """EMA Lightning: 8.6M parametre, ElevenLabs düzeyinde doğallık ölçümü, CPU'da gerçek zamanın 6 katı hızlı."""
    py = python_with("ema_lightning")
    env = {**os.environ, "EMA_SPEED": str(TR.get("emaSpeed", 1.0))}
    r = subprocess.run([str(py), str(ROOT / "scripts" / "ema_tts.py")], input=json.dumps(jobs), text=True, cwd=ROOT, env=env, capture_output=True)
    if r.returncode != 0:
        raise RuntimeError("ema: " + r.stderr.strip()[-400:])


def tts_chatterbox(text: str, out: Path) -> None:
    if not chatterbox_tts(text, out):
        raise RuntimeError("chatterbox sunucusu yanıt vermedi")
    # Chatterbox 24 kHz mono üretir; videoya tutarlı girsin diye 44.1 kHz'e çevir
    tmp = out.with_name(out.stem + ".cb.wav")
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(out), "-ar", "44100", "-ac", "1", str(tmp)], check=True)
    tmp.replace(out)


def say_has_voice(name: str) -> bool:
    if not shutil.which("say"):
        return False
    try:
        out = subprocess.run(["say", "-v", "?"], capture_output=True, text=True, timeout=10).stdout
    except Exception:
        return False
    return any(line.split()[0] == name and "tr_TR" in line for line in out.splitlines() if line.strip())


def pick_engine():
    """(ad, işlev, toplu_mu). Toplu motorlar iş listesi alır; diğerleri (metin, çıktı) alır."""
    forced = os.environ.get("TTS_ENGINE") or _S.get("narrationEngine", "auto")
    if forced == "silent":
        return "silent", tts_silent, False
    if forced in ("auto", "trendyol") and "trendyol" not in _disabled:
        backend = TR.get("backend", "auto")
        want_clone = bool(TR.get("refVoice")) and (ROOT / TR.get("refVoice", "")).exists()
        if backend in ("auto", "mlx") and trendyol_mlx_ready() and not want_clone:
            return "trendyol", tts_trendyol, False
        if backend in ("auto", "torch") and python_with("voxcpm"):
            return "trendyol-torch", tts_trendyol_batch, True
        if forced == "trendyol":
            print("  ! Trendyol-TTS kurulu değil (bash scripts/install_turkish_voice.sh), yedek motora düşülüyor", file=sys.stderr)
    if forced in ("auto", "ema") and "ema" not in _disabled:
        if python_with("ema_lightning"):
            return "ema", tts_ema_batch, True
        if forced == "ema":
            print("  ! EMA Lightning kurulu değil (pip install ema-lightning), yedek motora düşülüyor", file=sys.stderr)
    if forced in ("auto", "chatterbox") and "chatterbox" not in _disabled:
        if chatterbox_ready():
            return "chatterbox", tts_chatterbox, False
        if forced == "chatterbox":
            print("  ! chatterbox sunucusu hazır değil, yedek motora düşülüyor", file=sys.stderr)
    if forced == "auto" and say_has_voice(_S.get("voice", {}).get("name", "Yelda")):
        return "say", tts_macos_say, False
    if forced == "piper" and shutil.which("piper") and Path(VOICE).exists():
        return "piper", tts_piper, False
    if forced == "say" and shutil.which("say"):
        return "say", tts_macos_say, False
    if shutil.which("piper") and Path(VOICE).exists():
        return "piper", tts_piper, False
    if shutil.which("say"):
        return "say", tts_macos_say, False
    sys.exit("Ne Piper modeli ne de macOS 'say' bulundu. README'deki kurulum adımlarına bakın.")


# Yayın kalitesi işleme: alçak uğultuyu kes, konuşma netliğini (3 kHz) hafif kaldır, dinamikleri
# toparla, sonuna kısa sessizlik. Tüm motorlarda uygulanır; Piper'ın düz tınısını belirgin iyileştirir.
POLISH = "highpass=f=70,equalizer=f=180:t=q:w=1.2:g=-1.5,equalizer=f=3000:t=q:w=1:g=2.2,equalizer=f=8000:t=q:w=1.5:g=1," \
         "acompressor=threshold=-20dB:ratio=2.5:attack=8:release=140:makeup=2,alimiter=limit=0.95"


def add_pause(path: Path) -> None:
    tmp = path.with_name(path.stem + ".tmp.wav")
    af = (POLISH + "," if os.environ.get("TTS_POLISH", "1") != "0" else "") + f"apad=pad_dur={PAUSE_SEC}"
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(path), "-af", af, "-ar", "44100", "-ac", "1", str(tmp)], check=True)
    tmp.replace(path)


def fallback(engine_name: str, err: Exception, script_path: str, episode_path: str):
    """Seçili motor çöktüyse onu devre dışı bırakıp otomatik sırayla devam eder (loga yazar)."""
    print(f"  ! {engine_name} başarısız ({str(err)[:300]}); yedek motora düşülüyor", file=sys.stderr)
    os.environ["TTS_ENGINE"] = "auto"
    _S["narrationEngine"] = "auto"
    _disabled.add(engine_name.split("-")[0])
    return main(script_path, episode_path)


def main(script_path: str, episode_path: str):
    script = json.loads(Path(script_path).read_text(encoding="utf-8"))
    audio_dir = ROOT / "public" / "audio"
    audio_dir.mkdir(parents=True, exist_ok=True)
    for f in audio_dir.glob("seg-*.wav"):
        f.unlink()

    engine_name, engine, batch = pick_engine()
    outs = [audio_dir / f"seg-{i:02d}.wav" for i in range(len(script["segments"]))]
    if batch:
        # Model bir kez yüklenir; metinler normalize edilmiş halde topluca üretilir
        tmps = [o.with_name(o.stem + ".raw.wav") for o in outs]
        try:
            engine([{"text": prep_text(seg["narration"]), "out": str(t)} for seg, t in zip(script["segments"], tmps)])
        except Exception as e:
            return fallback(engine_name, e, script_path, episode_path)
        for t, o in zip(tmps, outs):
            resample(t, o)
    segments = []
    for i, seg in enumerate(script["segments"]):
        out = outs[i]
        if not batch:
            try:
                engine(seg["narration"], out)
            except Exception as e:
                if engine_name not in ("trendyol", "ema", "chatterbox"):
                    raise
                return fallback(engine_name, e, script_path, episode_path)
        add_pause(out)
        seg = dict(seg)
        seg["audio"] = f"audio/{out.name}"
        seg["duration"] = round(wav_duration(out), 3)
        seg["words"] = word_timings(seg["narration"], seg["duration"], PAUSE_SEC)
        segments.append(seg)

    episode = {k: v for k, v in script.items() if k != "segments"}
    episode["segments"] = segments
    Path(episode_path).write_text(json.dumps(episode, ensure_ascii=False, indent=2), encoding="utf-8")
    total = sum(s["duration"] for s in segments)
    print(f"[{engine_name}] {len(segments)} segment, toplam {total:.1f} sn -> {episode_path}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
