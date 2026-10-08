#!/usr/bin/env python3
"""Arka plan müzik yatakları, kodla sentezlenir (stdlib). Üç format için üç yatak, 40 sn, döngülenebilir.
Çıktı: public/music/sabah.wav, ogle.wav, aksam.wav. Düşük seviyede, anlatımın altında kalır.
"""
import math
import random
import struct
import wave
from pathlib import Path

SR = 44100
OUT = Path(__file__).resolve().parent.parent / "public" / "music"
random.seed(11)


def env_ad(n, a, d):
    out = []
    for i in range(n):
        t = i / SR
        out.append(min(1.0, t / a) if t < a else math.exp(-(t - a) / d))
    return out


def pad_note(freq, sec, amp, detune=0.004):
    n = int(SR * sec); e = env_ad(n, 0.6, sec)
    out = []
    for i in range(n):
        t = i / SR
        s = math.sin(2 * math.pi * freq * t) + 0.5 * math.sin(2 * math.pi * freq * (1 + detune) * t) + 0.25 * math.sin(2 * math.pi * freq * 2 * t)
        out.append(amp * e[i] * s / 1.75)
    return out


def kick(sec=0.35, amp=0.5):
    n = int(SR * sec); out = []
    for i in range(n):
        t = i / SR
        f = 120 * math.exp(-t * 18) + 45
        out.append(amp * math.exp(-t * 9) * math.sin(2 * math.pi * f * t))
    return out


def hat(sec=0.06, amp=0.12):
    n = int(SR * sec); y = 0.0; out = []
    for i in range(n):
        y += 0.6 * (random.uniform(-1, 1) - y)
        out.append(amp * math.exp(-i / SR * 60) * (random.uniform(-1, 1) - y))
    return out


def render(name, bpm, chords, kick_pattern, hat_on, pad_amp, sec=40.0):
    total = int(SR * sec)
    mix = [0.0] * total
    beat = 60.0 / bpm
    bar = beat * 4
    # akor yatağı: her bar bir akor
    nbars = int(sec / bar) + 1
    for b in range(nbars):
        chord = chords[b % len(chords)]
        start = int(b * bar * SR)
        for f in chord:
            note = pad_note(f, bar * 1.2, pad_amp)
            for i, v in enumerate(note):
                if start + i < total:
                    mix[start + i] += v
    # ritim
    nbeats = int(sec / beat) + 1
    for k in range(nbeats):
        pos = int(k * beat * SR)
        if kick_pattern[k % len(kick_pattern)]:
            for i, v in enumerate(kick()):
                if pos + i < total:
                    mix[pos + i] += v
        if hat_on:
            for sub in (0, 0.5):
                p2 = int((k + sub) * beat * SR)
                for i, v in enumerate(hat(amp=0.09 if sub else 0.13)):
                    if p2 + i < total:
                        mix[p2 + i] += v
    # döngü için uçları yumuşat ve normalize et
    fade = int(SR * 1.5)
    for i in range(fade):
        mix[i] *= i / fade
        mix[total - 1 - i] *= i / fade
    peak = max(1e-6, max(abs(v) for v in mix))
    mix = [v / peak * 0.6 for v in mix]
    OUT.mkdir(parents=True, exist_ok=True)
    with wave.open(str(OUT / f"{name}.wav"), "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR)
        w.writeframes(b"".join(struct.pack("<h", int(max(-1, min(1, v)) * 32767)) for v in mix))
    print(f"  {name}.wav  {sec:.0f} sn  {bpm} bpm")


A3, C4, D4, E4, F4, G4, A4, B4, C5, D5, E5 = 220.0, 261.63, 293.66, 329.63, 349.23, 392.0, 440.0, 493.88, 523.25, 587.33, 659.25
print("Müzik yatakları:")
# Sabah: aydınlık, hafif, majör, orta tempo
render("sabah", 96, [[C4, E4, G4], [F4, A4, C5], [G4, B4, D5], [C4, E4, G4]], [1, 0, 1, 0], True, 0.22)
# Öğle (son dakika): gergin, minör, hızlı nabız
render("ogle", 112, [[A3, C4, E4], [A3, C4, E4], [F4 / 2, A3, C4], [G4 / 2, B4 / 2, D4]], [1, 1, 1, 1], True, 0.18)
# Akşam (günün özeti): derin, sakin, yavaş
render("aksam", 84, [[D4 / 2, F4 / 2, A3], [A3 / 2, C4 / 2, E4 / 2], [F4 / 2, A3, C4], [G4 / 2, B4 / 2, D4]], [1, 0, 0, 0], False, 0.26)
