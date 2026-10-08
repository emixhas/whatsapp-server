#!/usr/bin/env python3
"""EMA Lightning (Apache-2.0, 34 MB, Türkçe) ile toplu seslendirme. Modeli bir kez yükler.
stdin: [{"text": "...", "out": "/path.wav"}, ...]   Ortam: EMA_SPEED (0.25-4, varsayılan 1.0), EMA_SEED
"""
import json
import os
import sys


def main():
    jobs = json.loads(sys.stdin.read())
    from ema_lightning import EMA
    tts = EMA()
    speed = float(os.environ.get("EMA_SPEED", "1.0"))
    seed = int(os.environ.get("EMA_SEED", "7"))
    for j in jobs:
        tts.say(j["text"], path=j["out"], speed=speed, seed=seed, sample_rate=48000)
        print(f"[ema] {os.path.basename(j['out'])} hazır", file=sys.stderr, flush=True)


if __name__ == "__main__":
    main()
