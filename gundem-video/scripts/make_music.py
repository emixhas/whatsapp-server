#!/usr/bin/env python3
"""Arka plan müzik yatakları — tamamı kodla sentezlenir (numpy; telifli dosya, örnek ya da dışarıdan ses yok).

Kullanıcı isteği, 27 Ekim: "arkalara belgesel, son dakika haber gibileri için çok az duyulacak şekilde müzik ekleyelim". Eski üç yatak
(sabah/öğle/akşam) çoğunlukla 60-660 Hz pad ve davuldan oluşuyordu ve 0,07 seviyesinde karışımda ölçülemiyordu (telefon hoparlörü 200 Hz
altını vermez). Yeni yataklar telefonda duyulan 300-4000 Hz bandında piyano, yaylı, pizzicato, marimba, saat tıkırtısı gibi çalgılarla
yazılır, hepsi -20 LUFS'a getirilir (seviye Remotion'da konuşmaya göre ayarlanır: settings.music.levelDb) ve kesintisiz döngü olur
(halka tampon: notaların ve yankının kuyruğu başa sarar; mp3 kodlayıcı payı ffmpeg'de kırpılır).

Yataklar (assemble_script.music_bed seçer):
  sondakika  son dakika / deprem / meteoroloji / alarm: saat tıkırtısı, kesik synth nabzı, alçak gerilim, 4 ölçüde bir vuruş
  belgesel   belgesel, bilgi, uzun video özeti, görüntülü haber: yavaş piyano arpeji, sıcak yaylı, alçak çello
  hikaye     çizilmiş/canlandırılmış hikâye, kıssa, masal: müzik kutusu ezgisi, pizzicato, yumuşak pad
  viral      sosyal medyada çok izlenen: canlı pluck akorları, el çırpma, bas
  mizah      mizah: zıplayan pizzicato bas, marimba, tahta blok
  fragman    fragman analizi: alçak yaylı ostinato, "braam" vuruşları, gerilim, yükselen geçiş
  sabah / ogle / aksam  düzenli gündem formatları (aydınlık / enerjik / sakin)

Kullanım: python3 scripts/make_music.py [yatak ...]   (yatak verilmezse hepsi; çıktı public/music/<ad>.mp3)
"""
import math
import re
import subprocess
import sys
import tempfile
import wave
from pathlib import Path

import numpy as np

SR = 44100
ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "public" / "music"
TARGET_LUFS = -20.0
TAU = 2 * math.pi


def midi(name: str) -> int:
    m = re.fullmatch(r"([A-G])([#b]?)(-?\d)", name)
    base = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}[m.group(1)] + {"#": 1, "b": -1, "": 0}[m.group(2)]
    return 12 * (int(m.group(3)) + 1) + base


def hz(n) -> float:
    return 440.0 * 2 ** (((midi(n) if isinstance(n, str) else n) - 69) / 12)


def tline(sec: float) -> np.ndarray:
    return np.arange(int(sec * SR)) / SR


# ---------- çalgılar (tek kanal numpy dizisi döner) ----------
def piano(f, dur, vel=1.0, bright=1.0):
    t = tline(dur + 2.2)
    out = np.zeros_like(t)
    for h, a in enumerate([1, .55, .32, .2, .12, .08, .05, .03], 1):
        fh = f * h * math.sqrt(1 + 0.0004 * h * h)
        if fh > 9000:
            break
        out += a * (bright ** (h - 1)) * np.sin(TAU * fh * t) * np.exp(-t * (0.9 + 0.75 * h))
    env = np.minimum(1, t / 0.004) * np.where(t < dur, 1.0, np.exp(-(t - dur) / 0.3))
    return 0.35 * vel * out * env


def pad(f, dur, bright=6, att=0.9, rel=1.2, rng=None):
    rng = rng or np.random.default_rng(int(f))
    t = tline(dur + rel * 1.5)
    out = np.zeros_like(t)
    for det in (-0.0055, 0.0, 0.006):
        ph = rng.random() * TAU
        for h in range(1, bright + 1):
            out += math.exp(-h / (bright * 0.55)) / h * np.sin(TAU * f * (1 + det) * h * t + ph * h)
    env = np.minimum(1, t / att) * np.where(t < dur, 1.0, np.exp(-(t - dur) / rel))
    return 0.07 * out * env * (1 + 0.06 * np.sin(TAU * 0.21 * t))


def pluck(f, dur=0.45, vel=1.0, decay=6.0):
    t = tline(dur + 0.6)
    out = np.zeros_like(t)
    for h, a in enumerate([1, .55, .3, .16, .08, .04], 1):
        out += a * np.sin(TAU * f * h * t) * np.exp(-t * (decay + 2.6 * h))
    env = np.minimum(1, t / 0.002) * np.where(t < dur, 1.0, np.exp(-(t - dur) / 0.08))
    return 0.4 * vel * out * env


def pizz(f, vel=1.0):
    return pluck(f, 0.25, vel, decay=11.0)


def marimba(f, vel=1.0):
    t = tline(0.9)
    out = np.sin(TAU * f * t) * np.exp(-t * 6) + 0.35 * np.sin(TAU * f * 4 * t) * np.exp(-t * 16) + 0.1 * np.sin(TAU * f * 9.8 * t) * np.exp(-t * 30)
    return 0.45 * vel * out * np.minimum(1, t / 0.0015)


def bell(f, vel=1.0, decay=2.2):  # müzik kutusu / çelesta
    t = tline(2.6)
    out = np.zeros_like(t)
    for r, a, d in ((1, 1, 1), (2.756, .38, 1.8), (5.404, .16, 3.2), (8.933, .05, 5)):
        out += a * np.sin(TAU * f * r * t) * np.exp(-t * decay * d)
    return 0.3 * vel * out * np.minimum(1, t / 0.001)


def synth_pulse(f, dur=0.14, vel=1.0, harm=7):
    t = tline(dur + 0.1)
    out = np.zeros_like(t)
    for h in range(1, harm + 1, 2):
        out += np.sin(TAU * f * h * t) / h
    env = np.minimum(1, t / 0.003) * np.exp(-t / (dur * 0.6))
    return 0.25 * vel * out * env


def bass(f, dur, vel=1.0):
    t = tline(dur + 0.25)
    out = np.sin(TAU * f * t) + 0.35 * np.sin(TAU * 2 * f * t) + 0.12 * np.sin(TAU * 3 * f * t)
    env = np.minimum(1, t / 0.006) * np.where(t < dur, 0.75 + 0.25 * np.exp(-t * 4), np.exp(-(t - dur) / 0.06) * 0.75)
    return 0.35 * vel * out * env


def kick(vel=1.0, rng=None):
    rng = rng or np.random.default_rng(1)
    t = tline(0.45)
    f = 45 + 80 * np.exp(-t * 28)
    body = np.sin(TAU * np.cumsum(f) / SR) * np.exp(-t * 8)
    click = rng.standard_normal(len(t)) * np.exp(-t * 600) * 0.25
    return 0.55 * vel * (body + click)


def noise_hp(n, rng):
    x = rng.standard_normal(n)
    return np.diff(x, prepend=0.0)


def hat(vel=1.0, open_=False, rng=None):
    rng = rng or np.random.default_rng(2)
    t = tline(0.25 if open_ else 0.08)
    return 0.12 * vel * noise_hp(len(t), rng) * np.exp(-t * (14 if open_ else 55))


def clap(vel=1.0, rng=None):
    rng = rng or np.random.default_rng(3)
    t = tline(0.3)
    n = noise_hp(len(t), rng)
    env = sum(np.exp(-np.maximum(0, t - d) * 40) * (t >= d) for d in (0, 0.011, 0.022)) * np.exp(-t * 6)
    return 0.16 * vel * n * env


def tick(vel=1.0, rng=None, pitch=2400):  # saat tıkırtısı (telefonda duyulur)
    rng = rng or np.random.default_rng(4)
    t = tline(0.04)
    return 0.32 * vel * (np.sin(TAU * pitch * t) * np.exp(-t * 260) + 0.5 * noise_hp(len(t), rng) * np.exp(-t * 900))


def woodblock(vel=1.0):
    t = tline(0.12)
    return 0.4 * vel * (np.sin(TAU * 1180 * t) + 0.5 * np.sin(TAU * 2740 * t)) * np.exp(-t * 55)


def braam(f, dur=3.0, vel=1.0, rng=None):
    rng = rng or np.random.default_rng(5)
    t = tline(dur + 1.0)
    out = np.zeros_like(t)
    for det in (-0.004, 0.0, 0.005):
        for h in range(1, 22):
            out += np.sin(TAU * f * (1 + det) * h * t + rng.random() * TAU) / h ** 0.85
    env = np.minimum(1, t / 0.07) * np.exp(-t / (dur * 0.55))
    return 0.05 * vel * np.tanh(1.4 * out * env)


def riser(sec, vel=1.0, rng=None, f0=180, f1=1400):
    rng = rng or np.random.default_rng(6)
    t = tline(sec)
    x = t / sec
    sweep = np.sin(TAU * np.cumsum(f0 * (f1 / f0) ** x) / SR)
    return 0.12 * vel * (0.6 * noise_hp(len(t), rng) * x ** 2.5 + sweep * x ** 2)


def boom(vel=1.0, rng=None):  # alçak vuruş + gürültü kabarması
    rng = rng or np.random.default_rng(7)
    t = tline(2.2)
    f = 38 + 50 * np.exp(-t * 9)
    return 0.5 * vel * (np.sin(TAU * np.cumsum(f) / SR) * np.exp(-t * 2.6) + 0.15 * noise_hp(len(t), rng) * np.exp(-t * 5))


def strings_trem(f, dur, vel=1.0):  # yüksek yaylı tremolo (gerilim)
    t = tline(dur + 0.6)
    out = sum(np.sin(TAU * f * h * t) / h for h in range(1, 6))
    trem = 0.6 + 0.4 * np.sin(TAU * 9.0 * t) ** 2
    env = np.minimum(1, t / 0.4) * np.where(t < dur, 1.0, np.exp(-(t - dur) / 0.3))
    return 0.05 * vel * out * trem * env


# ---------- halka tampon (kesintisiz döngü) ----------
class Bed:
    def __init__(self, bpm, bars, beats=4, seed=11):
        self.bpm, self.beat = bpm, 60.0 / bpm
        self.bar = beats * self.beat
        self.bars = bars
        self.n = int(round(bars * self.bar * SR))
        self.L, self.R = np.zeros(self.n), np.zeros(self.n)
        self.rng = np.random.default_rng(seed)

    def at(self, bar, beat=0.0):
        return bar * self.bar + beat * self.beat

    def add(self, t, sig, gain=1.0, pan=0.0, human=0.006):
        t += self.rng.uniform(-human, human) if human else 0.0
        a = (pan + 1) * math.pi / 4
        for buf, g in ((self.L, math.cos(a) * math.sqrt(2)), (self.R, math.sin(a) * math.sqrt(2))):
            s = sig * gain * g
            i = int(round(t * SR)) % self.n
            while len(s):
                k = min(len(s), self.n - i)
                buf[i:i + k] += s[:k]
                s, i = s[k:], 0

    def reverb(self, tau=0.6, wet=0.25, pre=0.018):
        """Dairesel evrişimli yankı (kuyruk başa sarar, döngü kesintisiz); sol/sağ ayrı gürültü dürtüsü (genişlik)."""
        m = min(self.n, int(SR * tau * 6))
        out = []
        for k, buf in enumerate((self.L, self.R)):
            rng = np.random.default_rng(100 + k)
            t = np.arange(m) / SR
            ir = rng.standard_normal(m) * np.exp(-t / tau) * (t > pre)
            ir[:int(pre * SR)] = 0
            ir /= np.sqrt(np.sum(ir ** 2)) or 1
            pad = np.zeros(self.n)
            pad[:m] = ir
            w = np.fft.irfft(np.fft.rfft(buf) * np.fft.rfft(pad), self.n)
            out.append(buf * (1 - wet) + w * wet * 1.4)
        self.L, self.R = out

    def eq(self, lo=55.0, hi=11000.0, tilt_db=0.0):
        """Yumuşak alçak kesici (lo), tepe kesici (hi), isteğe bağlı eğim (+: tiz)."""
        f = np.fft.rfftfreq(self.n, 1 / SR)
        g = 1 / np.sqrt(1 + (lo / np.maximum(f, 1)) ** 4) / np.sqrt(1 + (f / hi) ** 4)
        if tilt_db:
            g *= 10 ** (tilt_db / 20 * np.log2(np.maximum(f, 20) / 1000) / 4)
        self.L = np.fft.irfft(np.fft.rfft(self.L) * g, self.n)
        self.R = np.fft.irfft(np.fft.rfft(self.R) * g, self.n)


def chord(names):
    return [hz(x) for x in names.split()]


# ---------- yataklar ----------
def bed_sondakika():
    b = Bed(124, 32, seed=21)
    prog = ["D3 A3 D4 F4", "Bb2 F3 Bb3 D4", "G2 D3 G3 Bb3", "A2 E3 A3 C#4"]  # Dm Bb Gm A
    roots = ["D3", "Bb2", "G2", "A2"]
    for bar in range(b.bars):
        c = bar // 2 % 4
        sec = bar // 8  # 0..3 bölüm: yoğunluk değişir
        if bar % 2 == 0:
            for f in chord(prog[c])[1:]:
                b.add(b.at(bar), pad(f * 2, b.bar * 2 - 0.2, bright=5, att=0.5, rng=b.rng), 0.55, pan=b.rng.uniform(-.4, .4), human=0)
            b.add(b.at(bar), pad(hz(roots[c]), b.bar * 2 - 0.1, bright=4, att=0.3, rng=b.rng), 0.6, human=0)  # alçak gerilim
        for s in range(16):  # kesik synth nabzı (16'lık)
            acc = (1.0, .45, .7, .45)[s % 4]
            f = hz(roots[c]) * (2 if s % 8 < 6 else 3)
            if sec == 0 and s % 2:
                continue
            b.add(b.at(bar, s / 4), synth_pulse(f, 0.11, acc), 0.8, pan=(-.25 if s % 2 else .25))
        for e in range(8):  # saat tıkırtısı (8'lik, vuruşta vurgulu)
            b.add(b.at(bar, e / 2), tick(1.0 if e % 2 == 0 else 0.55, b.rng, 2600 if e % 2 == 0 else 3100), 0.75, pan=.15, human=0.002)
        if sec >= 1:
            for k in (0, 2):
                b.add(b.at(bar, k), kick(0.8, b.rng), 0.75, human=0.002)
            for k in (1, 3):
                b.add(b.at(bar, k + 0.5), hat(0.8, rng=b.rng), 0.8, pan=-.3, human=0.004)
        if bar % 4 == 0:
            b.add(b.at(bar), boom(0.9, b.rng), 0.3, human=0)
        if bar % 8 == 7:
            b.add(b.at(bar), riser(b.bar, 0.9, b.rng), 0.7, human=0)
        if bar % 4 == 2 and sec >= 2:  # yüksek "uyarı" ezgisi
            for k, n in enumerate(["A4", "D5", "F5", "E5"]):
                b.add(b.at(bar, k), bell(hz(n), 0.6, decay=3), 0.5, pan=.35)
    b.reverb(0.45, 0.22)
    b.eq(lo=90, tilt_db=1.5)
    return b


def bed_belgesel():
    b = Bed(72, 20, seed=31)
    prog = ["A2 E3 A3 C4 E4", "F2 C3 A3 C4 F4", "C3 G3 C4 E4 G4", "G2 D3 G3 B3 D4", "D3 A3 D4 F4 A4", "F2 C3 A3 C4 F4", "E2 B2 E3 G#3 B3", "A2 E3 A3 C4 E4"]
    arp = [0, 2, 3, 4, 3, 2, 3, 1]
    for bar in range(b.bars):
        c = chord(prog[bar // 2 % len(prog)])
        if bar % 2 == 0:
            b.add(b.at(bar), bass(c[0], b.bar * 2 - 0.3, 0.7), 0.4, human=0)  # alçak çello
            for f in c[1:4]:
                b.add(b.at(bar), pad(f * 2, b.bar * 2 - 0.3, bright=6, att=1.6, rel=1.8, rng=b.rng), 0.6, pan=b.rng.uniform(-.5, .5), human=0)
        for e, k in enumerate(arp):  # yavaş piyano arpeji (8'lik)
            if bar >= 16 and e % 2:
                continue  # son bölüm seyrek: döngü başına yumuşak dönüş
            f = c[k] * (4 if k < 2 else 2)
            b.add(b.at(bar, e / 2), piano(f, b.beat * 0.9, 0.55 + 0.25 * (e == 0)), 1.0, pan=(e - 3.5) / 8)
        if bar % 4 == 3 and 4 <= bar < 16:  # tek tük yüksek nota (ezgi parçası)
            b.add(b.at(bar, 2), piano(c[-1] * 2, b.beat * 2, 0.45, bright=0.9), 0.8, pan=.3)
    b.reverb(0.9, 0.32)
    b.eq(lo=90, hi=9000)
    return b


def bed_hikaye():
    b = Bed(84, 24, seed=41)
    prog = ["F2 C3 F3 A3", "D2 A2 D3 F3", "Bb2 F3 Bb3 D4", "C3 G3 C4 E4"]
    motif = [("C5", 0), ("A4", 1), ("F4", 1.5), ("G4", 2), ("A4", 3)], [("D5", 0), ("C5", 1), ("A4", 2), ("F4", 3)], \
            [("Bb4", 0), ("A4", 1), ("G4", 1.5), ("F4", 2), ("D4", 3)], [("E4", 0), ("G4", 1), ("C5", 2), ("Bb4", 3)]
    for bar in range(b.bars):
        c = chord(prog[bar % 4])
        b.add(b.at(bar), pad(c[1] * 2, b.bar - 0.1, bright=4, att=0.7, rng=b.rng), 0.5, human=0)
        b.add(b.at(bar), pad(c[3], b.bar - 0.1, bright=4, att=0.7, rng=b.rng), 0.45, pan=.3, human=0)
        for e in range(8):  # pizzicato bas yürüyüşü
            f = (c[0], c[1], c[2], c[1])[e // 2 % 4] if e % 2 == 0 else None
            if f:
                b.add(b.at(bar, e / 2), pizz(f, 0.8), 0.9, pan=-.2)
        if 4 <= bar < 20:  # müzik kutusu ezgisi
            for n, beat in motif[bar % 4]:
                b.add(b.at(bar, beat), bell(hz(n), 0.65), 0.75, pan=.25)
        elif bar % 2 == 0:
            b.add(b.at(bar, 2), bell(c[3] * 2, 0.4), 0.6, pan=.25)
    b.reverb(0.7, 0.3)
    b.eq(lo=90, hi=10000)
    return b


def bed_viral():
    b = Bed(118, 32, seed=51)
    prog = ["G3 B3 D4 G4", "E3 G3 B3 E4", "C3 E3 G3 C4", "D3 F#3 A3 D4"]
    roots = ["G2", "E2", "C2", "D2"]
    hook = [("D5", 0), ("B4", .75), ("G4", 1.5), ("A4", 2.5), ("B4", 3)]
    for bar in range(b.bars):
        c, r = chord(prog[bar % 4]), hz(roots[bar % 4])
        sec = bar // 8
        for k in range(4):
            b.add(b.at(bar, k), kick(0.8, b.rng), 0.3 if sec else 0.18, human=0.002)
        for k in (1, 3):
            b.add(b.at(bar, k), clap(0.9, b.rng), 0.8, human=0.003)
        for e in range(8):
            b.add(b.at(bar, e / 2), hat(0.6 + 0.3 * (e % 2), rng=b.rng), 0.7, pan=.3, human=0.003)
            b.add(b.at(bar, e / 2), bass(r * (4 if e % 4 == 3 else 2), b.beat * 0.4, 0.7), 0.4, human=0.002)
        for k, beat in enumerate((0, 0.75, 1.5, 2.5, 3.25)):  # senkoplu pluck akorları
            for f in c[1:]:
                b.add(b.at(bar, beat), pluck(f * 2, 0.22, 0.6), 0.9, pan=(-.4 if k % 2 else .4), human=0.003)
        if sec in (1, 3):
            for n, beat in hook:
                b.add(b.at(bar, beat), bell(hz(n), 0.55, decay=3.2), 0.6, pan=.2)
    b.reverb(0.4, 0.2)
    b.eq(lo=90, tilt_db=1.5)
    return b


def bed_mizah():
    b = Bed(132, 32, seed=61)
    prog = [("C3", "C4 E4 G4"), ("G2", "B3 D4 G4"), ("A2", "C4 E4 A4"), ("F2", "C4 F4 A4")]
    tune = [("E5", 0), ("G5", .5), ("E5", 1), ("C5", 1.5), ("D5", 2), ("Eb5", 2.5), ("E5", 3)], [("D5", 0), ("B4", 1), ("G4", 2), ("A4", 2.5), ("B4", 3)], \
           [("C5", 0), ("E5", .5), ("A5", 1), ("G5", 2), ("E5", 3)], [("F5", 0), ("E5", .5), ("D5", 1), ("C5", 1.5), ("A4", 2), ("C5", 3)]
    for bar in range(b.bars):
        r, up = prog[bar % 4]
        for k in range(4):  # "um-pa": kökte pizzicato bas, ara vuruşta akor
            if k % 2 == 0:
                b.add(b.at(bar, k), pizz(hz(r) * (1 if k == 0 else 1.5), 0.95), 1.0, pan=-.2)
            else:
                for f in chord(up):
                    b.add(b.at(bar, k), pizz(f, 0.55), 0.6, pan=.2)
        b.add(b.at(bar, 1.5), woodblock(0.7), 0.6, pan=.4)
        b.add(b.at(bar, 3.5), woodblock(0.5), 0.6, pan=-.4)
        if 8 <= bar < 24 or bar % 2:
            for n, beat in tune[bar % 4]:
                b.add(b.at(bar, beat), marimba(hz(n), 0.8), 0.8, pan=.15)
    b.reverb(0.35, 0.18)
    b.eq(lo=90, tilt_db=1.0)
    return b


def bed_fragman():
    b = Bed(90, 24, seed=71)
    prog = ["C2", "Ab1", "Eb2", "G1"]
    for bar in range(b.bars):
        r = hz(prog[bar // 2 % 4])
        sec = bar // 8
        for e in range(8):  # alçak yaylı ostinato (kesik 8'lik)
            b.add(b.at(bar, e / 2), pluck(r * 4 * (1.5 if e % 4 == 3 else 1), 0.18, 0.9 if e % 2 == 0 else 0.6, decay=4), 1.0, pan=(-.3 if e % 2 else .3))
            b.add(b.at(bar, e / 2), tick(0.6 if sec else 0.35, b.rng, 1900), 0.5, pan=.2, human=0.002)
        if bar % 4 == 0:
            b.add(b.at(bar), braam(r * 2, 3.2, 1.0, b.rng), 0.6, human=0)
            b.add(b.at(bar), boom(0.8, b.rng), 0.25, human=0)
        if bar % 2 == 0:
            b.add(b.at(bar), strings_trem(hz("G4"), b.bar * 2 - 0.2), 0.8 if sec else 0.5, pan=-.3, human=0)
            b.add(b.at(bar), strings_trem(hz("Ab4"), b.bar * 2 - 0.2), 0.5 if sec else 0.3, pan=.3, human=0)
        if bar % 8 == 7:
            b.add(b.at(bar), riser(b.bar, 1.0, b.rng, 120, 1800), 0.8, human=0)
    b.reverb(0.8, 0.28)
    b.eq(lo=75, hi=9500)
    return b


def bed_gundem(kind):
    if kind == "sabah":  # aydınlık, hafif, majör
        b, prog, roots, drums = Bed(100, 24, seed=81), ["E3 G3 C4 E4", "C3 E3 A3 C4", "C3 F3 A3 C4", "D3 G3 B3 D4"], ["C2", "A1", "F2", "G2"], 1
    elif kind == "ogle":  # enerjik, minör, hızlı nabız
        b, prog, roots, drums = Bed(116, 32, seed=82), ["C3 E3 A3 C4", "C3 F3 A3 C4", "C3 E3 G3 C4", "D3 G3 B3 D4"], ["A1", "F1", "C2", "G1"], 2
    else:  # akşam: derin, sakin
        b, prog, roots, drums = Bed(80, 20, seed=83), ["D3 F3 A3 D4", "D3 F3 Bb3 D4", "C3 F3 A3 C4", "C3 E3 G3 C4"], ["D2", "Bb1", "F2", "C2"], 0
    for bar in range(b.bars):
        c, r = chord(prog[bar % 4]), hz(roots[bar % 4])
        for f in c[:3]:
            b.add(b.at(bar), pad(f * 2, b.bar - 0.1, bright=5, att=0.5, rng=b.rng), 0.45, pan=b.rng.uniform(-.4, .4), human=0)
        b.add(b.at(bar), bass(r * 2, b.bar * 0.9, 0.6), 0.3 if kind == "ogle" else 0.4, human=0)
        step = 2 if kind == "aksam" else 4
        for e in range(step * 4 // 2):
            k = (0, 1, 2, 1)[e % 4]
            if kind == "ogle":
                b.add(b.at(bar, e / step * 2 / 2), synth_pulse(c[k] * 2, 0.1, 0.8 if e % 2 == 0 else 0.5), 0.9, pan=(-.3 if e % 2 else .3))
            else:
                b.add(b.at(bar, e * 4 / (step * 2)), piano(c[k] * 2, b.beat * 0.8, 0.6), 0.75, pan=(e % 4 - 1.5) / 5)
        if drums:
            for k in range(4):
                if drums == 2 or k % 2 == 0:
                    b.add(b.at(bar, k), kick(0.7, b.rng), 0.25, human=0.002)
            for e in range(8):
                b.add(b.at(bar, e / 2), hat(0.5 + 0.3 * (e % 2), rng=b.rng), 0.6, pan=.3, human=0.003)
            if drums == 2:
                for e in range(8):
                    b.add(b.at(bar, e / 2), tick(0.5, b.rng, 2800), 0.35, pan=-.2, human=0.002)
    b.reverb(0.55 if kind != "ogle" else 0.4, 0.26)
    b.eq(lo=90, tilt_db=1.0)
    return b


BEDS = {"sondakika": bed_sondakika, "belgesel": bed_belgesel, "hikaye": bed_hikaye, "viral": bed_viral, "mizah": bed_mizah,
        "fragman": bed_fragman, "sabah": lambda: bed_gundem("sabah"), "ogle": lambda: bed_gundem("ogle"), "aksam": lambda: bed_gundem("aksam")}


def lufs(path: Path) -> float:
    r = subprocess.run(["ffmpeg", "-hide_banner", "-nostats", "-i", str(path), "-af", "ebur128", "-f", "null", "-"], capture_output=True, text=True)
    vals = [l for l in r.stderr.splitlines() if l.strip().startswith("I:")]
    return float(vals[-1].split()[1]) if vals else -70.0


def write_wav(path: Path, L, R):
    x = np.stack([L, R], axis=1)
    x = np.clip(x, -1, 1)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR)
        w.writeframes((x * 32767).astype("<i2").tobytes())


def render(name: str) -> dict:
    b = BEDS[name]()
    peak = max(np.max(np.abs(b.L)), np.max(np.abs(b.R))) or 1.0
    L, R = b.L / peak * 0.5, b.R / peak * 0.5
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td) / f"{name}.wav"
        write_wav(tmp, L, R)
        gain = 10 ** ((TARGET_LUFS - lufs(tmp)) / 20)
        g = min(gain, 0.89 / max(np.max(np.abs(L)), np.max(np.abs(R))))  # tepe -1 dBFS'i geçmesin
        write_wav(tmp, L * g, R * g)
        OUT.mkdir(parents=True, exist_ok=True)
        mp3 = OUT / f"{name}.mp3"
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(tmp), "-c:a", "libmp3lame", "-b:a", "96k", "-ar", str(SR), str(mp3)], check=True)
        got = lufs(mp3)
    sec = b.n / SR
    print(f"  {name}.mp3  {sec:.1f} sn  {b.bpm} bpm  {got:.1f} LUFS")
    return {"name": name, "seconds": round(sec, 2), "lufs": got}


if __name__ == "__main__":
    names = sys.argv[1:] or list(BEDS)
    print("Müzik yatakları:")
    for n in names:
        if n not in BEDS:
            sys.exit(f"bilinmeyen yatak: {n} (olanlar: {', '.join(BEDS)})")
        render(n)
