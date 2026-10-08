#!/usr/bin/env python3
"""Trendyol-TTS (VoxCPM2 tabanlı Türkçe model) ile toplu seslendirme — PyTorch/MPS yedek yolu.

MLX çalışma zamanı (trendyol-tts komutu) yoksa ya da ses klonlama isteniyorsa kullanılır.
Modeli bir kez yükler, stdin'den gelen JSON listesindeki her öğeyi üretir:
  [{"text": "...", "out": "/path/seg-00.wav"}, ...]
Ortam: VOX_MODEL (varsayılan Trendyol/Trendyol-TTS ya da models/Trendyol-TTS), VOX_REF (klon için
referans wav, isteğe bağlı), VOX_CFG, VOX_STEPS, VOX_SEED. .venv-tr içinde çalıştırılır.
"""
import json
import os
import sys
from pathlib import Path


def main():
    jobs = json.loads(sys.stdin.read())
    import soundfile as sf  # voxcpm ile gelir
    import torch
    from voxcpm import VoxCPM

    model_id = os.environ.get("VOX_MODEL", "Trendyol/Trendyol-TTS")
    local_candidate = Path("models") / model_id.split("/")[-1]
    if not Path(model_id).exists() and local_candidate.exists():
        model_id = str(local_candidate)  # önceden indirilmiş yerel kopya
    device = "mps" if torch.backends.mps.is_available() else "cpu"
    print(f"[voxcpm] model yükleniyor: {model_id} ({device})", file=sys.stderr, flush=True)
    model = VoxCPM.from_pretrained(model_id, load_denoiser=False)
    ref = os.environ.get("VOX_REF") or None
    if ref and not Path(ref).exists():
        ref = None
    cfg = float(os.environ.get("VOX_CFG", "2.0"))
    steps = int(os.environ.get("VOX_STEPS", "16"))
    seed = int(os.environ.get("VOX_SEED", "42"))
    for j in jobs:
        kw = dict(text=j["text"], cfg_value=cfg, inference_timesteps=steps, seed=seed, max_len=4096)
        if ref:
            kw["reference_wav_path"] = ref
        wav = model.generate(**kw)
        sf.write(j["out"], wav, model.tts_model.sample_rate)
        print(f"[voxcpm] {Path(j['out']).name} hazır", file=sys.stderr, flush=True)


if __name__ == "__main__":
    main()
