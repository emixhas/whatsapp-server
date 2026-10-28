#!/usr/bin/env python3
"""Z-Image-Turbo ile toplu görsel üretimi — .venv-image içinde çalışır (scripts/install_image.sh kurar; scripts/image_gen.py çağırır).

Kullanım: .venv-image/bin/python scripts/zimage_run.py <spec.json>
  spec: {"model": "<kurulumun kaydettiği yerel kopya ya da HF deposu>", "quantize": null | 8 | 6 | 4 (yalnız asıl depodan yüklerken; yerel
         kopyanın kendi düzeyi geçer), "steps": 8, "scheduler": "static_shift3" | "linear", "cacheGB": 2,
         "jobs": [{"prompt": "...", "seed": 7, "w": 1152, "h": 2048, "out": "/mutlak/yol.png"}, ...]}
En yüksek gerçekçilik için (kullanıcı isteği, 28 Ekim: "görseller çok çok gerçekçi olsun, süre önemli değil"; dayanak mflux 0.24.0 kaynağı):
- Bellek: önce bütün tarifler metin kodlayıcıyla kodlanır, kodlayıcı (Qwen3-4B; 8 bitte ~4,3 GB, tam hassasiyette ~8 GB) bellekten atılır,
  sonra görseller üretilir: tepe bellek iki aşamanın toplamı değil büyüğü (16 GB Mac'te 8 bit sığar; mflux komut satırı tek görselde aynısını
  yapar). MLX önbelleği sınırlanır ve her görselden sonra boşaltılır (yoksa serbest kalan tamponlar görselden görsele birikir).
- Zamanlama: mflux'un varsayılan "linear" zamanlaması 1 MP'nin üstünde kaydırmayı büyütür (864x1536'da 3,8, 1088x1920'de 6,3: ayrıntı son
  büyük adıma kalır); Z-Image-Turbo'nun kendi ayarı sabit kaydırma 3'tür (diffusers ZImagePipeline): "static_shift3" bunu uygular
  (720x1280'de ikisi zaten aynı).
- Tarif 512 belirteçte sessizce kesilir (mflux yalnız loga yazar): belirteç sayısı ilerleme satırında ("tokens", "truncated").
- Adım: Z-Image-Turbo'nun kendi ayarı 8 dönüştürücü adımı (resmî örnek "9 adım = 8 ileri geçiş"; mflux'ta adım = ileri geçiş).
Model bir kez yüklenir. İlerleme stderr'e satır başına JSON ({"load", "n", "bits", "staged", "peakGB"}, sonra her görselde {"i", "n", "sec",
"ok", "tokens", "truncated", "peakGB"}: tepe bellek, kurulum bununla bellek düzeyini seçer), sonuç stdout'a tek satır JSON {"ok": true, "load":
sn, "peakGB", "results": {out: "ok" | "hata: …"}}. Bir görselin hatası diğerlerini durdurmaz; aşamalı kodlama (mflux'un iç işlevlerine
dayanır) kurulamazsa kodlayıcı bellekte kalarak eskisi gibi üretilir.
"""
import gc
import json
import sys
import time

SHIFT = 3.0  # Z-Image-Turbo scheduler_config: shift 3.0, use_dynamic_shifting false


def _static_shift_scheduler():
    """mflux'a "static_shift3" adıyla kaydedilen zamanlayıcı: sigma düğümleri linspace(1, 1/n, n), sabit kaydırma shift·s/(1+(shift−1)·s),
    Euler adımı (LinearScheduler.step ile aynı). set_image_seq_len tanımlı değil: Config çözünürlüğe göre kaydırma uygulamaz."""
    import mlx.core as mx
    from mflux.models.common.schedulers import register_contrib
    from mflux.models.common.schedulers.base_scheduler import BaseScheduler

    class StaticShiftScheduler(BaseScheduler):
        def __init__(self, config):
            self.config = config
            n = config.num_inference_steps
            s = mx.linspace(1.0, 1.0 / n, n).astype(mx.float32)
            self._sigmas = mx.concatenate([SHIFT * s / (1 + (SHIFT - 1) * s), mx.zeros(1)])

        @property
        def sigmas(self):
            return self._sigmas

        def step(self, noise, timestep, latents, **kwargs):
            dt = (self._sigmas[timestep + 1] - self._sigmas[timestep]).astype(latents.dtype)
            return latents + noise.astype(latents.dtype) * dt

    register_contrib(StaticShiftScheduler, "static_shift3")


def _cache(mx, limit_gb: float = 2.0) -> None:
    for f in (getattr(mx, "set_cache_limit", None), getattr(getattr(mx, "metal", None), "set_cache_limit", None)):
        if f:
            try:
                f(int(limit_gb * 1000**3))
                return
            except Exception:
                continue


def _peak(mx, reset: bool = False):
    """Tepe bellek, GB (MLX 0.32 mx.get_peak_memory; eski sürümde mx.metal altında); okunamazsa None. reset: sayaç sıfırlanır."""
    for ns in (mx, getattr(mx, "metal", None)):
        f = getattr(ns, "reset_peak_memory" if reset else "get_peak_memory", None)
        if f:
            try:
                v = f()
                return None if reset else round(float(v) / 1e9, 2)
            except Exception:
                continue
    return None


def _clear(mx) -> None:
    gc.collect()
    for f in (getattr(mx, "clear_cache", None), getattr(getattr(mx, "metal", None), "clear_cache", None)):
        if f:
            try:
                f()
                return
            except Exception:
                continue


def main() -> int:
    spec = json.load(open(sys.argv[1], encoding="utf-8"))
    jobs = spec.get("jobs") or []
    t0 = time.time()
    # stdout'a yalnız sonuç satırı: kütüphanelerin print'leri stderr'e (uzun üretimde dolan stdout borusu süreci kilitlemesin)
    out, sys.stdout = sys.stdout, sys.stderr
    try:
        import mlx.core as mx
        from mflux.models.common.config import ModelConfig
        from mflux.models.z_image import ZImage
        q = spec.get("quantize")
        model = ZImage(model_config=ModelConfig.z_image_turbo(), model_path=spec.get("model") or None, quantize=int(q) if q else None)
    except Exception as e:  # kurulum ya da bellek sorunu: hiçbir görsel üretilemez
        print(json.dumps({"ok": False, "error": f"model yüklenemedi: {type(e).__name__}: {str(e)[:300]}"}), file=out)
        return 1
    try:
        _cache(mx, float(spec.get("cacheGB") or 2))
    except (TypeError, ValueError):
        _cache(mx)
    sched = spec.get("scheduler") or None
    if sched == "static_shift3":
        try:
            _static_shift_scheduler()
        except Exception as e:  # mflux sürümü farklı: varsayılan zamanlama
            print(f"zamanlayıcı kurulamadı ({type(e).__name__}: {e}); varsayılan kullanılıyor", file=sys.stderr, flush=True)
            sched = None
    # 1) aşamalı kodlama: her ayrı tarif bir kez kodlanır, kodlayıcı atılır
    ntok, maxlen = {}, 512
    try:
        from mflux.models.z_image.model.z_image_text_encoder.prompt_encoder import PromptEncoder
        tok = model.tokenizers["z_image"]
        maxlen = int(getattr(tok, "max_length", 512) or 512)
        enc = {}
        for j in jobs:
            p = str(j["prompt"])
            if p in enc:
                continue
            ntok[p] = int(mx.sum(tok.tokenize(p).attention_mask[0]).item())
            e = PromptEncoder.encode_prompt(prompt=p, tokenizer=tok, text_encoder=model.text_encoder)
            mx.eval(e)  # tembel değerlendirme: kodlayıcı atılmadan önce hesaplanmalı
            enc[p] = e
        model.text_encoder = None  # MLX Module: öznitelik sözlükten çıkar, kodlayıcının ağırlıkları serbest kalır
        model._encode_prompts = lambda *, prompt, negative_prompt, guidance: (enc[prompt], None)  # Turbo: CFG yok, olumsuz tarif yok
        staged = True
    except Exception as e:
        print(f"aşamalı kodlama kurulamadı ({type(e).__name__}: {str(e)[:160]}); kodlayıcı bellekte kalıyor", file=sys.stderr, flush=True)
        staged = False
    _clear(mx)
    load = round(time.time() - t0, 1)
    peak = _peak(mx)
    print(json.dumps({"load": load, "n": len(jobs), "bits": getattr(model, "bits", None), "staged": staged, "peakGB": peak}), file=sys.stderr, flush=True)
    # 2) görseller
    res = {}
    for i, j in enumerate(jobs, 1):
        t = time.time()
        p = str(j["prompt"])
        _peak(mx, reset=True)
        try:
            w, h = int(j.get("w") or 720) // 16 * 16, int(j.get("h") or 1280) // 16 * 16
            img = model.generate_image(seed=int(j.get("seed") or 0), prompt=p, num_inference_steps=int(spec.get("steps") or 9),
                                       width=w, height=h, scheduler=sched)
            img.save(path=j["out"], overwrite=True)
            res[j["out"]] = "ok"
        except Exception as e:
            res[j["out"]] = f"hata: {type(e).__name__}: {str(e)[:200]}"
        pk = _peak(mx)
        peak = max(x for x in (peak, pk, 0.0) if x is not None)
        print(json.dumps({"i": i, "n": len(jobs), "sec": round(time.time() - t, 1), "ok": res[j["out"]] == "ok", "tokens": ntok.get(p),
                          "truncated": (ntok.get(p) or 0) >= maxlen, "peakGB": pk}), file=sys.stderr, flush=True)
        _clear(mx)
    print(json.dumps({"ok": True, "load": load, "peakGB": peak or None, "results": res}), file=out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
