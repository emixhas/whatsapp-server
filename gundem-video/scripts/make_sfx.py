#!/usr/bin/env python3
"""Tüm ses efektlerini kodla sentezler (stdlib, dış dosya yok). Çıktı: public/sfx/*.wav

Kullanım: python3 scripts/make_sfx.py
"""
import math
import random
import struct
import wave
from pathlib import Path

SR = 44100
OUT = Path(__file__).resolve().parent.parent / "public" / "sfx"
random.seed(7)  # her çalıştırmada aynı sesler


def silence(sec):
    return [0.0] * int(SR * sec)


def env(n, attack=0.005, decay=0.3, curve=4.0):
    """Hızlı atak, üstel sönüm zarfı."""
    a = int(SR * attack)
    out = []
    for i in range(n):
        if i < a:
            out.append(i / max(a, 1))
        else:
            t = (i - a) / SR
            out.append(math.exp(-t * curve / decay))
    return out


def tone(freq, sec, decay=0.3, amp=0.5, harmonics=(1.0,), vibrato=0.0, vib_rate=6.0, attack=0.005):
    n = int(SR * sec)
    e = env(n, attack=attack, decay=decay)
    out = []
    for i in range(n):
        t = i / SR
        f = freq * (1 + vibrato * math.sin(2 * math.pi * vib_rate * t))
        s = sum(h * math.sin(2 * math.pi * f * (k + 1) * t) for k, h in enumerate(harmonics))
        out.append(amp * e[i] * s / sum(harmonics))
    return out


def noise(sec, amp=0.5, cutoff=0.1, attack=0.01, decay=0.3):
    """Tek kutuplu alçak geçiren filtreli beyaz gürültü. cutoff 0..1 (1 = filtresiz)."""
    n = int(SR * sec)
    e = env(n, attack=attack, decay=decay)
    y, out = 0.0, []
    for i in range(n):
        y += cutoff * (random.uniform(-1, 1) - y)
        out.append(amp * e[i] * y)
    return out


def mix(*layers):
    n = max(len(l[0]) + int(SR * l[1]) for l in layers)
    out = [0.0] * n
    for samples, offset in layers:
        o = int(SR * offset)
        for i, s in enumerate(samples):
            out[o + i] += s
    peak = max(1e-6, max(abs(s) for s in out))
    return [s / peak * 0.85 for s in out]


def save(name, samples):
    OUT.mkdir(parents=True, exist_ok=True)
    with wave.open(str(OUT / name), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(b"".join(struct.pack("<h", int(max(-1, min(1, s)) * 32767)) for s in samples))
    print(f"  {name}  {len(samples)/SR:.2f} sn")


def main():
    print("Ses efektleri üretiliyor:")
    # Geçiş: filtreli gürültü süpürmesi
    save("whoosh.wav", mix((noise(0.55, cutoff=0.35, attack=0.15, decay=0.25), 0)))
    # Intro vuruşu: yükselen üç nota + yumuşak darbe
    save("sting.wav", mix(
        (noise(0.25, amp=0.6, cutoff=0.08, decay=0.12), 0),
        (tone(523, 0.9, decay=0.5, harmonics=(1, 0.3)), 0.00),
        (tone(659, 0.9, decay=0.5, harmonics=(1, 0.3)), 0.12),
        (tone(784, 1.2, decay=0.7, harmonics=(1, 0.3)), 0.24),
    ))
    # Outro: iki çan
    save("chime.wav", mix(
        (tone(1047, 1.4, decay=0.9, harmonics=(1, 0.4, 0.15)), 0),
        (tone(1568, 1.6, decay=1.0, harmonics=(1, 0.4, 0.15)), 0.3),
    ))
    # Finans: kasa "ka-ching" + bozuk para
    coins = [(tone(random.choice([4186, 4699, 5274]), 0.12, decay=0.05, amp=0.3, harmonics=(1, 0.5)), 0.45 + k * 0.07) for k in range(5)]
    save("kasa.wav", mix(
        (noise(0.08, amp=0.7, cutoff=0.5, decay=0.04), 0),
        (tone(2093, 0.5, decay=0.25, harmonics=(1, 0.6, 0.2)), 0.02),
        (tone(2637, 0.9, decay=0.5, harmonics=(1, 0.5, 0.2)), 0.12),
        *coins,
    ))
    # Siyaset: tokmak vuruşu x2
    knock = lambda off: [(tone(140, 0.3, decay=0.08, amp=0.9, harmonics=(1, 0.5)), off), (noise(0.08, amp=0.6, cutoff=0.25, decay=0.04), off)]
    save("tokmak.wav", mix(*knock(0), *knock(0.22)))
    # Spor: hakem düdüğü (trilli)
    save("duduk.wav", mix((tone(2900, 0.7, decay=0.9, amp=0.6, harmonics=(1, 0.2), vibrato=0.025, vib_rate=38, attack=0.02), 0)))
    # Hava: yağmur + iki damla
    save("yagmur.wav", mix(
        (noise(2.2, amp=0.5, cutoff=0.12, attack=0.4, decay=2.5), 0),
        (tone(3200, 0.15, decay=0.06, amp=0.25), 0.6),
        (tone(3600, 0.15, decay=0.06, amp=0.25), 1.3),
    ))
    # Toplum: şehir uğultusu + uzak korna
    save("sehir.wav", mix(
        (noise(1.8, amp=0.5, cutoff=0.03, attack=0.3, decay=2.0), 0),
        (tone(392, 0.35, decay=0.3, amp=0.25, harmonics=(1, 0.6, 0.3)), 0.7),
        (tone(466, 0.35, decay=0.3, amp=0.2, harmonics=(1, 0.6, 0.3)), 0.72),
    ))
    # Teknoloji: yükselen dijital bip dizisi
    blips = [(tone(880 * (1.26 ** k), 0.09, decay=0.05, amp=0.5, harmonics=(1, 0, 0.3, 0, 0.15)), k * 0.11) for k in range(6)]
    save("blip.wav", mix(*blips))
    # Sağlık: kalp atışı "lub-dub"
    beat = lambda off, a: (tone(58, 0.28, decay=0.1, amp=a, harmonics=(1, 0.3), attack=0.01), off)
    save("kalp.wav", mix(beat(0, 0.9), beat(0.16, 0.6), beat(0.75, 0.9), beat(0.91, 0.6)))
    # Dünya: havadar pad + süpürme
    save("dunya.wav", mix(
        (tone(220, 1.6, decay=1.2, amp=0.4, harmonics=(1, 0.5, 0.25), attack=0.25), 0),
        (tone(330, 1.6, decay=1.2, amp=0.3, harmonics=(1, 0.5), attack=0.3), 0.05),
        (noise(0.6, amp=0.3, cutoff=0.3, attack=0.2, decay=0.3), 0),
    ))
    # Genel: iki tonlu bildirim
    save("bildirim.wav", mix(
        (tone(880, 0.35, decay=0.2, harmonics=(1, 0.3)), 0),
        (tone(1175, 0.6, decay=0.35, harmonics=(1, 0.3)), 0.13),
    ))


if __name__ == "__main__":
    main()
