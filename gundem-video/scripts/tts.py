#!/usr/bin/env python3
"""Senaryodaki her segmenti yerel olarak seslendirir ve public/episode.json üretir.

Sesler scripts/voices.py kataloğundan gelir; seçim data/settings.json → narration:
  {"mode": "single", "voice": "trendyol"}  ya da  {"mode": "alternate", "voiceA": "vox-kadin", "voiceB": "vox-erkek"}
Dönüşümlü modda kanca=A, intro=B, 1. haber=A, 2. haber=B … Bir ses çökerse o ses bu çalıştırma
için kapatılır ve ilgili segmentler otomatik sıradaki sesle yeniden üretilir (loga yazar).
Rakamlar seslendirmeden önce yazıya çevrilir (tr_numbers.py).

Kullanım: python3 scripts/tts.py work/script.json public/episode.json
"""
import json
import os
import subprocess
import sys
import wave
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import voices  # noqa: E402
from common import ROOT  # noqa: E402

PAUSE_SEC = 0.15  # her segment sonuna sessizlik


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


# Yayın kalitesi işleme: alçak uğultuyu kes, konuşma netliğini (3 kHz) hafif kaldır, dinamikleri
# toparla, sonuna kısa sessizlik. Tüm motorlarda uygulanır; Piper'ın düz tınısını belirgin iyileştirir.
POLISH = "highpass=f=70,equalizer=f=180:t=q:w=1.2:g=-1.5,equalizer=f=3000:t=q:w=1:g=2.2,equalizer=f=8000:t=q:w=1.5:g=1," \
         "acompressor=threshold=-20dB:ratio=2.5:attack=8:release=140:makeup=2,alimiter=limit=0.95"


def voice_gain_db(v: dict) -> float:
    """Ses seviyesi: tüm segmentler önce aynı yüksekliğe getirilir (-18 LUFS), sonra kadın sesi
    settings.narration.femaleGainDb (varsayılan +3 dB), erkek sesi maleGainDb (0) kadar yükseltilir.
    Cinsiyeti belirsiz motorlar (Trendyol, EMA…) kadın sesi sayılır; katalogdaki tek erkek ses vox-erkek."""
    n = voices._S.get("narration", {}) or {}
    key = "maleGainDb" if v.get("gender") == "erkek" else "femaleGainDb"
    return float(n.get(key, 0.0 if key == "maleGainDb" else 3.0))


def add_pause(path: Path, gain_db: float = 0.0) -> None:
    tmp = path.with_name(path.stem + ".tmp.wav")
    # eşit yükseklik + ses kazancı; limitleyici bozulmayı (patlamayı) önler
    level = f"loudnorm=I=-18:TP=-2:LRA=11,volume={gain_db:+.1f}dB,alimiter=limit=0.95"
    af = (POLISH + "," if os.environ.get("TTS_POLISH", "1") != "0" else "") + level + f",apad=pad_dur={PAUSE_SEC}"
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(path), "-af", af, "-ar", "44100", "-ac", "1", str(tmp)], check=True)
    tmp.replace(path)


def main(script_path: str, episode_path: str):
    script = json.loads(Path(script_path).read_text(encoding="utf-8"))
    segs = script["segments"]
    audio_dir = ROOT / "public" / "audio"
    audio_dir.mkdir(parents=True, exist_ok=True)
    for f in audio_dir.glob("seg-*.wav"):
        f.unlink()
    outs = [audio_dir / f"seg-{i:02d}.wav" for i in range(len(segs))]
    chosen = voices.assign(len(segs))
    pending = list(range(len(segs)))
    for attempt in range(6):
        jobs = [{"voice": chosen[i], "text": segs[i]["narration"], "out": outs[i]} for i in pending]
        try:
            voices.synthesize(jobs)
            pending = []
            # panel bu satırı "Ses modeli sorunsuz başlatıldı" diye seslendirir
            print(f"🔊 ses modeli sorunsuz başlatıldı: {' + '.join(dict.fromkeys(c['label'] for c in chosen))}", flush=True)
            break
        except RuntimeError as e:
            bad = str(e).split(":")[0]
            print(f"  ! ses '{bad}' başarısız ({str(e)[:240]}); yedek sese geçiliyor", file=sys.stderr)
            voices._disabled.add(bad)
            pending = [i for i in pending if not outs[i].exists() or chosen[i]["id"] == bad]
            repl = voices.resolve("auto")
            for i in pending:
                if chosen[i]["id"] == bad:
                    chosen[i] = repl
    if pending:
        sys.exit("Seslendirme tamamlanamadı")

    segments = []
    for i, seg in enumerate(segs):
        out = outs[i]
        add_pause(out, voice_gain_db(chosen[i]))
        seg = dict(seg)
        seg["audio"] = f"audio/{out.name}"
        seg["voice"] = chosen[i]["id"]
        seg["duration"] = round(wav_duration(out), 3)
        seg["words"] = word_timings(seg["narration"], seg["duration"], PAUSE_SEC)
        segments.append(seg)

    episode = {k: v for k, v in script.items() if k != "segments"}
    episode["segments"] = segments
    Path(episode_path).write_text(json.dumps(episode, ensure_ascii=False, indent=2), encoding="utf-8")
    total = sum(s["duration"] for s in segments)
    used = " + ".join(dict.fromkeys(c["label"] for c in chosen))
    print(f"[{used}] {len(segments)} segment, toplam {total:.1f} sn -> {episode_path}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
