#!/usr/bin/env python3
"""Z-Image-Turbo ile toplu görsel üretimi — .venv-image içinde çalışır (scripts/install_image.sh kurar; scripts/image_gen.py çağırır).

Kullanım: .venv-image/bin/python scripts/zimage_run.py <spec.json>
  spec: {"model": "filipstrand/Z-Image-Turbo-mflux-4bit", "steps": 9,
         "jobs": [{"prompt": "...", "seed": 7, "w": 720, "h": 1280, "out": "/mutlak/yol.png"}, ...]}
Model bir kez yüklenir, işler sırayla üretilir. İlerleme stderr'e satır başına JSON ({"i", "n", "sec", "ok"}), sonuç stdout'a tek
satır JSON {"ok": true, "load": sn, "results": {out: "ok" | "hata: …"}}. Bir görselin hatası diğerlerini durdurmaz.
"""
import gc
import json
import sys
import time


def main() -> int:
    spec = json.load(open(sys.argv[1], encoding="utf-8"))
    jobs = spec.get("jobs") or []
    t0 = time.time()
    try:
        from mflux.models.common.config import ModelConfig
        from mflux.models.z_image import ZImage
        model = ZImage(model_config=ModelConfig.z_image_turbo(), model_path=spec.get("model") or None)
    except Exception as e:  # kurulum ya da bellek sorunu: hiçbir görsel üretilemez
        print(json.dumps({"ok": False, "error": f"model yüklenemedi: {type(e).__name__}: {str(e)[:300]}"}))
        return 1
    load = round(time.time() - t0, 1)
    print(json.dumps({"load": load, "n": len(jobs)}), file=sys.stderr, flush=True)
    res = {}
    for i, j in enumerate(jobs, 1):
        t = time.time()
        try:
            w, h = int(j.get("w") or 720) // 16 * 16, int(j.get("h") or 1280) // 16 * 16
            img = model.generate_image(seed=int(j.get("seed") or 0), prompt=str(j["prompt"]), num_inference_steps=int(spec.get("steps") or 9),
                                       width=w, height=h)
            img.save(path=j["out"], overwrite=True)
            res[j["out"]] = "ok"
        except Exception as e:
            res[j["out"]] = f"hata: {type(e).__name__}: {str(e)[:200]}"
        print(json.dumps({"i": i, "n": len(jobs), "sec": round(time.time() - t, 1), "ok": res[j["out"]] == "ok"}), file=sys.stderr, flush=True)
        gc.collect()
    print(json.dumps({"ok": True, "load": load, "results": res}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
