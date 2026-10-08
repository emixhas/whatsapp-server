#!/usr/bin/env python3
"""Senaryodaki her segmenti yerel olarak seslendirir ve public/episode.json üretir.

Öncelik: Piper (voices/ altındaki Türkçe model). Yoksa macOS 'say' (Yelda sesi).
İkisi de tamamen yerel çalışır, internet veya API anahtarı gerekmez.

Kullanım: python3 scripts/tts.py work/script.json public/episode.json
"""
import json
import os
import shutil
import subprocess
import sys
import wave
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import settings  # noqa: E402
from natural_tts import chatterbox_ready, chatterbox_tts  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
_S = settings()
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
    forced = os.environ.get("TTS_ENGINE") or _S.get("narrationEngine", "auto")
    if forced == "silent":
        return "silent", tts_silent
    if forced in ("auto", "chatterbox"):
        if chatterbox_ready():
            return "chatterbox", tts_chatterbox
        if forced == "chatterbox":
            print("  ! chatterbox sunucusu hazır değil, yedek motora düşülüyor", file=sys.stderr)
    if forced == "auto" and say_has_voice(_S.get("voice", {}).get("name", "Yelda")):
        return "say", tts_macos_say
    if forced == "piper" and shutil.which("piper") and Path(VOICE).exists():
        return "piper", tts_piper
    if forced == "say" and shutil.which("say"):
        return "say", tts_macos_say
    if shutil.which("piper") and Path(VOICE).exists():
        return "piper", tts_piper
    if shutil.which("say"):
        return "say", tts_macos_say
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


def main(script_path: str, episode_path: str):
    script = json.loads(Path(script_path).read_text(encoding="utf-8"))
    audio_dir = ROOT / "public" / "audio"
    audio_dir.mkdir(parents=True, exist_ok=True)
    for f in audio_dir.glob("seg-*.wav"):
        f.unlink()

    engine_name, engine = pick_engine()
    segments = []
    for i, seg in enumerate(script["segments"]):
        out = audio_dir / f"seg-{i:02d}.wav"
        engine(seg["narration"], out)
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
