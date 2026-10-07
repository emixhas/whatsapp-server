#!/usr/bin/env python3
"""Panelin sesli yanıtı: stdin'deki metni Piper (yoksa macOS say) ile wav olarak stdout'a yazar."""
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
VOICE = os.environ.get("PIPER_VOICE", str(ROOT / "voices" / "tr_TR-dfki-medium.onnx"))
text = sys.stdin.read().strip()
if not text:
    sys.exit(1)
with tempfile.TemporaryDirectory() as td:
    wav = Path(td) / "r.wav"
    if shutil.which("piper") and Path(VOICE).exists():
        subprocess.run(["piper", "--model", VOICE, "--length_scale", "0.9", "--output_file", str(wav)], input=text.encode(), check=True, capture_output=True)
    elif shutil.which("say"):
        aiff = Path(td) / "r.aiff"
        subprocess.run(["say", "-v", "Yelda", "-o", str(aiff), text], check=True)
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(aiff), str(wav)], check=True)
    else:
        sys.exit(2)
    sys.stdout.buffer.write(wav.read_bytes())
