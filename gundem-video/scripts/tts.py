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

ROOT = Path(__file__).resolve().parent.parent
VOICE = os.environ.get("PIPER_VOICE", str(ROOT / "voices" / "tr_TR-dfki-medium.onnx"))
PIPER_LENGTH = os.environ.get("PIPER_LENGTH_SCALE", "0.82")  # <1 daha hızlı. 1.0 ≈ 120 kelime/dk, 0.82 ≈ 150 (haber temposu)
PAUSE_SEC = 0.15  # her segment sonuna sessizlik (Piper zaten cümle sonu boşluğu ekler)


def wav_duration(path: Path) -> float:
    with wave.open(str(path), "rb") as w:
        return w.getnframes() / float(w.getframerate())


def tts_piper(text: str, out: Path) -> None:
    subprocess.run(
        ["piper", "--model", VOICE, "--length_scale", PIPER_LENGTH, "--sentence_silence", "0.12", "--output_file", str(out)],
        input=text.encode("utf-8"), check=True, capture_output=True,
    )


def tts_macos_say(text: str, out: Path) -> None:
    aiff = out.with_suffix(".aiff")
    subprocess.run(["say", "-v", "Yelda", "-r", "175", "-o", str(aiff), text], check=True)
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(aiff), "-ar", "44100", "-ac", "1", str(out)], check=True)
    aiff.unlink(missing_ok=True)


def tts_silent(text: str, out: Path) -> None:
    """Ses motoru olmadan boru hattını test etmek için: metin uzunluğuna göre sessizlik üretir."""
    secs = max(1.0, len(text) / 15.0)
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono", "-t", f"{secs:.2f}", str(out)], check=True)


def pick_engine():
    forced = os.environ.get("TTS_ENGINE")
    if forced == "silent":
        return "silent", tts_silent
    if forced == "say" and shutil.which("say"):
        return "say", tts_macos_say
    if shutil.which("piper") and Path(VOICE).exists():
        return "piper", tts_piper
    if shutil.which("say"):
        return "say", tts_macos_say
    sys.exit("Ne Piper modeli ne de macOS 'say' bulundu. README'deki kurulum adımlarına bakın.")


def add_pause(path: Path) -> None:
    tmp = path.with_name(path.stem + ".tmp.wav")
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(path), "-af", f"apad=pad_dur={PAUSE_SEC}", str(tmp)], check=True)
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
        segments.append(seg)

    episode = {k: v for k, v in script.items() if k != "segments"}
    episode["segments"] = segments
    Path(episode_path).write_text(json.dumps(episode, ensure_ascii=False, indent=2), encoding="utf-8")
    total = sum(s["duration"] for s in segments)
    print(f"[{engine_name}] {len(segments)} segment, toplam {total:.1f} sn -> {episode_path}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
