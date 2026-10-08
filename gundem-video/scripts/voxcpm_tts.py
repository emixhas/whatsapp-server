#!/usr/bin/env python3
"""Trendyol-TTS (VoxCPM2 tabanlı Türkçe model) ile toplu seslendirme — PyTorch/MPS yedek yolu.

MLX çalışma zamanı (trendyol-tts komutu) yoksa ya da ses klonlama isteniyorsa kullanılır.
Modeli bir kez yükler, stdin'den gelen JSON listesindeki her öğeyi üretir:
  [{"text": "...", "out": "/path/seg-00.wav", "instruct": "(A male news anchor…)", "ref": "/path/ref.wav"}, ...]
instruct: VoxCPM2 ses tasarımı (metnin başına parantezli açıklama); ref: klonlanacak referans wav.
Ortam: VOX_MODEL (Trendyol/Trendyol-TTS, openbmb/VoxCPM2 ya da models/… yerel kopya), VOX_CFG,
VOX_STEPS, VOX_SEED. .venv-tr içinde çalıştırılır.
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
    cfg = float(os.environ.get("VOX_CFG", "2.0"))
    steps = int(os.environ.get("VOX_STEPS", "16"))
    seed = int(os.environ.get("VOX_SEED", "42"))
    import inspect
    try:
        params = set(inspect.signature(model.generate).parameters)
    except (TypeError, ValueError):
        params = set()
    accepts = lambda k: (not params) or (k in params) or ("kwargs" in params)
    print(f"[voxcpm] generate parametreleri: {sorted(params) or 'bilinmiyor'}", file=sys.stderr, flush=True)
    for j in jobs:
        text = (j.get("instruct", "") + j["text"]) if j.get("instruct") else j["text"]
        kw = {"text": text}
        for key, val in (("cfg_value", cfg), ("inference_timesteps", steps), ("seed", seed), ("max_len", 4096)):
            if accepts(key):
                kw[key] = val
        ref = j.get("ref") or os.environ.get("VOX_REF") or ""
        if ref and Path(ref).exists():
            for key in ("reference_wav_path", "prompt_wav_path"):
                if accepts(key):
                    kw[key] = ref
                    break
        try:
            wav = model.generate(**kw)
        except TypeError as e:
            # Eski/yeni API farkı: yalnızca metinle dene
            print(f"[voxcpm] parametre uyuşmazlığı ({e}); yalnızca metinle deneniyor", file=sys.stderr, flush=True)
            wav = model.generate(text=text)
        sr = getattr(getattr(model, "tts_model", None), "sample_rate", None) or getattr(model, "sample_rate", None) or 48000
        sf.write(j["out"], wav, int(sr))
        print(f"[voxcpm] {Path(j['out']).name} hazır", file=sys.stderr, flush=True)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        import traceback
        tb = traceback.format_exc().strip().splitlines()
        print("[voxcpm] HATA: " + " | ".join(tb[-3:]), file=sys.stderr, flush=True)
        sys.exit(1)
