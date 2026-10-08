#!/usr/bin/env python3
"""Emixhas'ın sesi: stdin'deki metni wav olarak stdout'a yazar. Tamamen yerel.

Motor seçimi (data/settings.json → voice.engine):
  auto      : EMA Lightning (hızlı ve doğal Türkçe) → Chatterbox → macOS Yelda → Piper
  ema       : EMA Lightning (pip install ema-lightning; voice.rate'e göre hız)
  trendyol  : Trendyol-TTS (en doğal ama yanıt başına birkaç saniye bekletir)
  chatterbox: Chatterbox sunucusu (varsa)
  say       : macOS sesi (voice.name, voice.rate kelime/dk)
  piper     : Piper (voice.piperLength hız, voice.piperNoise doğallık)
"""
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import ROOT, settings  # noqa: E402
from natural_tts import chatterbox_ready, chatterbox_tts  # noqa: E402
import tts as narr  # noqa: E402  (Trendyol/EMA motorları ve metin normalizasyonu)

VOICE_ONNX = os.environ.get("PIPER_VOICE", str(ROOT / "voices" / "tr_TR-dfki-medium.onnx"))
V = {**{"engine": "auto", "name": "Yelda", "rate": 195, "piperLength": 0.85, "piperNoise": 0.5}, **settings().get("voice", {})}


def say_has_voice(name: str) -> bool:
    if not shutil.which("say"):
        return False
    try:
        out = subprocess.run(["say", "-v", "?"], capture_output=True, text=True, timeout=10).stdout
    except Exception:
        return False
    return any(line.split()[0] == name and "tr_TR" in line for line in out.splitlines() if line.strip())


def tts_say(text: str, wav: Path):
    aiff = wav.with_suffix(".aiff")
    subprocess.run(["say", "-v", V["name"], "-r", str(int(V["rate"])), "-o", str(aiff), text], check=True, capture_output=True)
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(aiff), "-ar", "44100", "-ac", "1", str(wav)], check=True)


def tts_piper(text: str, wav: Path):
    subprocess.run(["piper", "--model", VOICE_ONNX, "--length_scale", str(V["piperLength"]), "--noise_scale", str(V["piperNoise"]),
                    "--noise_w_scale", "0.6", "--sentence_silence", "0.15", "--output_file", str(wav)],
                   input=text.encode(), check=True, capture_output=True)


def tts_ema(text: str, wav: Path):
    narr.TR["emaSpeed"] = round(max(0.7, min(1.4, int(V["rate"]) / 195)), 2)  # 195 kelime/dk ≈ 1.0
    narr.tts_ema_batch([{"text": narr.prep_text(text), "out": str(wav)}])


def main():
    text = sys.stdin.read().strip()
    if not text:
        sys.exit(1)
    engine = V["engine"]
    if engine == "auto":
        engine = "ema" if narr.python_with("ema_lightning") else "chatterbox" if chatterbox_ready() else ("say" if say_has_voice(V["name"]) else "piper")
    with tempfile.TemporaryDirectory() as td:
        wav = Path(td) / "r.wav"
        done = False
        if engine in ("ema", "trendyol"):
            try:
                if engine == "trendyol" and narr.trendyol_mlx_ready():
                    narr.tts_trendyol(text, wav)
                else:
                    tts_ema(text, wav)
                done = True
            except Exception as e:
                print(f"[speak] {engine} başarısız: {str(e)[:200]}", file=sys.stderr)
                engine = "chatterbox" if chatterbox_ready() else "say"
        if done:
            pass
        elif engine == "chatterbox" and chatterbox_tts(text, wav):
            pass
        elif engine == "say" and shutil.which("say"):
            tts_say(text, wav)
        elif shutil.which("piper") and Path(VOICE_ONNX).exists():
            tts_piper(text, wav)
        elif shutil.which("say"):
            tts_say(text, wav)
        else:
            sys.exit(2)
        sys.stdout.buffer.write(wav.read_bytes())


if __name__ == "__main__":
    main()
