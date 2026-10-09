#!/usr/bin/env python3
"""Emixhas'ın sesi: stdin'deki metni wav olarak stdout'a yazar. Tamamen yerel.

Motor seçimi (data/settings.json → voice.engine): kataloğdaki bir ses kimliği (ema, trendyol,
vox-kadin, vox-erkek, klon-…, chatterbox, yelda, piper) ya da auto (= ema → chatterbox → yelda → piper;
Trendyol/VoxCPM anında yanıt için yavaş olduğundan auto'da kullanılmaz). voice.rate EMA hızına çevrilir.
"""
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import voices  # noqa: E402
from common import settings  # noqa: E402

V = {**{"engine": "auto", "name": "Yelda", "rate": 195}, **settings().get("voice", {})}
# Emixhas'ın kısa yanıtları için ağır model açılmaz: Chatterbox yalnızca zaten açıksa kullanılır
QUICK = ["ema", "chatterbox", "yelda", "piper"]


def usable(v) -> bool:
    if v["engine"] == "chatterbox":
        return voices.chatterbox_ready()
    return voices.available(v)[0]


def pick():
    eng = {"say": "yelda"}.get(V["engine"], V["engine"])
    if eng != "auto":
        v = voices.voice(eng)
        if v and usable(v):
            return v
    for cand in QUICK:
        v = voices.voice(cand)
        if v and usable(v):
            return v
    return None


def main():
    text = sys.stdin.read().strip()
    if not text:
        sys.exit(1)
    v = pick()
    if not v:
        sys.exit(2)
    speed = round(max(0.7, min(1.4, int(V["rate"]) / 195)), 2)
    with tempfile.TemporaryDirectory() as td:
        wav = Path(td) / "r.wav"
        try:
            voices.synthesize([{"voice": v, "text": text, "out": wav}], speed=speed)
        except RuntimeError as e:
            print(f"[speak] {e}", file=sys.stderr)
            voices._disabled.add(v["id"])
            alt = next((voices.voice(c) for c in QUICK if voices.voice(c) and usable(voices.voice(c))), None)
            if not alt:
                sys.exit(2)
            voices.synthesize([{"voice": alt, "text": text, "out": wav}], speed=speed)
        sys.stdout.buffer.write(wav.read_bytes())


if __name__ == "__main__":
    main()
