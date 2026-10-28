#!/usr/bin/env python3
"""Gerçekçi görsel motorunun kurulum yardımcısı (scripts/install_image.sh çağırır; .venv-image içinde çalışır).

  image_setup.py plan               → {"ram": GB, "tiers": ["bf16", "q8", "q6", "q4", "q4hazir"], "cached": GB}
  image_setup.py save DÜZEY HEDEF   → Z-Image-Turbo'nun asıl deposu (Tongyi-MAI, mflux'un sabitlediği sürüm) indirilir, DÜZEY'de (bf16 tam
                                      hassasiyet; q8/q6/q4 MLX nicemleme) yerel kopya HEDEF klasörüne kaydedilir (sözlük dosyaları dahil:
                                      kopya internetsiz açılır); "q4hazir" eski kurulumun hazır 4 bit deposundan (~6 GB; asıl depo bu Mac'te
                                      açılamazsa son çare)
  image_setup.py test MODEL G Y     → üretim ayarlarıyla deneme görseli (GxY, 8 adım, sabit kaydırma 3): {"genSec", "loadSec", "peakGB",
                                      "tokens", "out"}; üretim kilidi tutulur (aynı anda çalışan bir videonun üretimiyle bellek yarışmasın)
  image_setup.py finalize DÜZEY YENİ SÜRÜM BELLEK SN AÇILIŞ G Y BÜYÜK TEPE GERİ
                                    → kurulumun son adımı, ÜRETİM KİLİDİ altında: yerel kopya yerine taşınır, READY.json (sürüm 2) yazılır,
                                      indirme önbelleği temizlenir (cleanup), başka düzeylerin klasörleri silinir
  image_setup.py cleanup            → indirme önbelleğinden artık gerekmeyen Z-Image kopyaları silinir (asıl depo — yerel kopya kaydedildi —
                                      ve eski 4 bit depo): kazanılan GB
Her komut stdout'a tek satır JSON yazar ({"ok": …}; save hatasında "stage": "indirme" | "disk" | "yukleme"); mflux'un indirme ve uyarı
satırları stderr'e (inceleme, 28 Ekim: mflux "Downloading model…" satırını stdout'a yazıyor, kurulumun sonuç okuması bozuluyordu).

Seçim (araştırma, 28 Ekim, mflux 0.24.0 kaynağı): eski hazır 4 bit depo (filipstrand) metin kodlayıcıyı, görüntü modelini ve VAE'yi 4 bitte
çalıştırıyordu; 4 bit ince ayrıntıyı (parmak, saç, takı, küçük yazı) kaybettiriyor, 8 bit tam hassasiyete çok yakın. Bellek (ağırlıklar): tam
hassasiyet ~20,5 GB, 8 bit ~11 GB, 6 bit ~8,4 GB, 4 bit ~5,9 GB; zimage_run.py metin kodlayıcıyı ayrı aşamada boşalttığı için üretimde ~15,5 /
~7 GB. Bu yüzden 30 GB ve üstü bellekte tam hassasiyet, altında 8 bit; düşük düzeyler de asıl depoyu tam hassasiyette açıp nicemler (14 GB
altı bellekte yalnız hazır 4 bit depo). Deneme görseli üretilemezse bir alt düzey denenir.
"""
import errno
import json
import shutil
import subprocess
import sys
import time
import traceback
from pathlib import Path


def ram_gb() -> float:
    try:
        sc = shutil.which("sysctl") or "/usr/sbin/sysctl"  # launchd servisinin PATH'inde /usr/sbin yok
        return int(subprocess.run([sc, "-n", "hw.memsize"], capture_output=True, text=True, timeout=10).stdout.strip()) / 1e9
    except (OSError, ValueError, subprocess.SubprocessError):
        return 0.0


def plan() -> dict:
    r = ram_gb()
    tiers = (["bf16"] if r >= 30 else []) + (["q8", "q6", "q4"] if r >= 14 or r == 0 else []) + ["q4hazir"]
    return {"ok": True, "ram": round(r, 1), "tiers": tiers, "cached": round(_cached("Tongyi-MAI/Z-Image-Turbo"), 1)}


def _cached(repo: str) -> float:
    """İndirme önbelleğinde deponun kapladığı GB (yarıda kalmış kurulumun indirdiği dosyalar yeniden inmez; disk hesabından düşülür)."""
    try:
        from huggingface_hub import constants
        d = Path(constants.HF_HUB_CACHE) / f"models--{repo.replace('/', '--')}"
        return sum(p.stat().st_size for p in d.rglob("*") if p.is_file() and not p.is_symlink()) / 1e9 if d.is_dir() else 0.0
    except Exception:
        return 0.0


BITS = {"bf16": None, "q8": 8, "q6": 6, "q4": 4, "q4hazir": None}
HUB_4BIT = "filipstrand/Z-Image-Turbo-mflux-4bit"  # eski kurulumun deposu: metin kodlayıcı, görüntü modeli ve VAE önceden 4 bit


_NET_MODS = ("huggingface_hub", "hf_xet", "requests", "urllib3", "httpx", "httpcore", "ssl", "socket", "http")


def _stage(e: BaseException) -> str:
    """Kaydetme hatasının aşaması: "disk" (yer kalmadı), "indirme" (ağ ya da indirme sunucusu: hata indirme kodunda doğdu) ya da "yukleme"
    (bellek, model açılamadı). Kurulum buna göre karar verir: indirme ve disk hatasında yarım indirme silinmez, yeniden deneme önerilir."""
    chain, x = [], e
    while x is not None and x not in chain and len(chain) < 10:
        chain.append(x)
        x = x.__cause__ or x.__context__
    if any(isinstance(x, OSError) and x.errno == errno.ENOSPC for x in chain):
        return "disk"
    for x in chain:
        if isinstance(x, (ConnectionError, TimeoutError)) or (type(x).__module__ or "").split(".")[0] in _NET_MODS:
            return "indirme"
        if any("huggingface_hub" in f.filename or "hf_xet" in f.filename for f in traceback.extract_tb(x.__traceback__)):
            return "indirme"
    return "yukleme"


def save(tier: str, dest: str) -> dict:
    from mflux.models.common.config import ModelConfig
    from mflux.models.z_image import ZImage
    t0 = time.time()
    out = Path(dest)
    shutil.rmtree(out, ignore_errors=True)
    try:
        model = (ZImage(model_config=ModelConfig.z_image_turbo(), model_path=HUB_4BIT) if tier == "q4hazir"
                 else ZImage(model_config=ModelConfig.z_image_turbo(), quantize=BITS[tier]))
        out.parent.mkdir(parents=True, exist_ok=True)
        model.save_model(str(out))
    except Exception as e:
        shutil.rmtree(out, ignore_errors=True)
        return {"ok": False, "stage": _stage(e), "error": f"{type(e).__name__}: {str(e)[:300]}"}
    size = sum(p.stat().st_size for p in out.rglob("*") if p.is_file()) / 1e9
    return {"ok": True, "path": str(out), "gb": round(size, 1), "sec": round(time.time() - t0, 1)}


def _take_lock():
    """Üretim kilidi (image_gen ile aynı dosya): bir video görsel üretiyorsa onun bitmesi beklenir; beklenecekse bir kez söylenir (kurulumun
    stdout'una, panel loga alır)."""
    import fcntl
    lock = ROOT / "work" / "image_cache" / ".uretim.lock"
    lock.parent.mkdir(parents=True, exist_ok=True)
    lk = open(lock, "a+")
    try:
        fcntl.flock(lk, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        print("  ! bir videonun gerçekçi fotoğrafları üretiliyor; o bitince devam edilecek", file=sys.stderr, flush=True)
        fcntl.flock(lk, fcntl.LOCK_EX)
    return lk


ROOT = Path(__file__).resolve().parent.parent
TEST_PROMPT = ("Medium close-up at eye level of a Turkish fisherman in his early seventies with a sun-weathered face, deep "
               "forehead wrinkles, a short white beard and grey stubble, wearing a navy wool cap and a faded yellow raincoat. He sits on the "
               "edge of a small wooden fishing boat and mends a green nylon net across his knees, calloused fingers holding the twine. "
               "Behind him a quiet Istanbul harbour at dawn, calm grey-blue water, moored boats softly out of focus. Soft golden light "
               "from the left, water droplets on the net. Shot with a 50mm lens at f/2.8, focus on his face and hands. Natural skin texture "
               "with visible pores. Candid documentary photograph on a full-frame digital camera, natural true-to-life colors, soft natural "
               "contrast, fine natural grain, unretouched. Vertical 9:16 composition, the main subject in the upper two thirds of the frame, "
               "the bottom third calm and uncluttered.")


def test(model: str, w: str, h: str) -> dict:
    import tempfile
    lk = _take_lock()  # bir video görsel üretiyorsa onun bitmesi beklenir
    tmp = Path(tempfile.mkdtemp(prefix="imgtest-"))
    try:
        gen = tmp / "deneme.png"
        sp = tmp / "spec.json"
        sp.write_text(json.dumps({"model": model, "steps": 8, "scheduler": "static_shift3",
                                  "jobs": [{"prompt": TEST_PROMPT, "seed": 7, "w": int(w), "h": int(h), "out": str(gen)}]}), encoding="utf-8")
        r = subprocess.run([sys.executable, str(ROOT / "scripts" / "zimage_run.py"), str(sp)], capture_output=True, text=True, cwd=ROOT)
        evs = []
        for line in r.stderr.splitlines():
            try:
                d = json.loads(line)
            except ValueError:
                continue
            if isinstance(d, dict):
                evs.append(d)
        try:
            out = json.loads(r.stdout.strip().splitlines()[-1])
        except (ValueError, IndexError):
            out = {"ok": False, "error": (r.stderr.strip().splitlines() or ["çıktı yok"])[-1][:300]}
        img = next((e for e in evs if "i" in e), {})
        if not out.get("ok") or (out.get("results") or {}).get(str(gen)) != "ok" or not gen.is_file():
            return {"ok": False, "error": str(out.get("error") or (out.get("results") or {}).get(str(gen)) or "deneme görseli üretilemedi")[:300]}
        keep = ROOT / "work" / "image_deneme.png"
        keep.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(gen, keep)
        return {"ok": True, "genSec": img.get("sec"), "loadSec": out.get("load"), "peakGB": out.get("peakGB"), "tokens": img.get("tokens"),
                "out": str(keep)}
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
        lk.close()


def cleanup(keep_main: bool = False) -> dict:
    """keep_main: asıl deponun (yarım) indirmesi kalır — en yüksek düzey disk ya da indirme yüzünden kurulamadı, yeniden denemede
    inen dosyalar yeniden inmesin."""
    from huggingface_hub import constants
    freed = 0.0
    for repo in ((HUB_4BIT,) if keep_main else ("Tongyi-MAI/Z-Image-Turbo", HUB_4BIT)):
        d = Path(constants.HF_HUB_CACHE) / f"models--{repo.replace('/', '--')}"
        if d.is_dir():
            freed += _cached(repo)
            shutil.rmtree(d, ignore_errors=True)
    return {"ok": True, "freed": round(freed, 1)}


def finalize(tier: str, new: str, ver: str, ram: str, gen: str, load: str, w: str, h: str, big: str, peak: str, fallback: str) -> dict:
    """Kurulumun son adımı ÜRETİM KİLİDİ altında (inceleme, 28 Ekim: kilidi bekleyen bir video eski ayarla başlıyor, kurulum READY.json'u
    yazıp eski modeli silerken o videonun modeli altından gidiyordu): yerel kopya yerine taşınır, READY.json (sürüm 2; "fallback": en yüksek
    düzey kurulamadıysa nedeni) yazılır, indirme önbelleği temizlenir, başka düzeylerin klasörleri silinir. Kilidi bekleyen video ardından
    yeni motoru okur (image_gen.generate kilitten sonra ayarı yeniden okur)."""
    lk = _take_lock()
    try:
        img = ROOT / "models" / "image"
        dest = img / f"zimage-{tier}"
        shutil.rmtree(dest, ignore_errors=True)
        Path(new).rename(dest)

        def num(x):
            try:
                return float(x)
            except (TypeError, ValueError):
                return 0.0

        d = {"version": 2, "model": str(dest.resolve()), "tier": tier, "mflux": ver, "ram": num(ram), "width": int(w), "height": int(h),
             "steps": 8, "scheduler": "static_shift3", "genSec": num(gen), "loadSec": num(load), "peakGB": num(peak), "testW": int(w),
             "testH": int(h), "testSec": num(gen), "tests": {f"{w}x{h}": num(gen), **({"1152x2048": num(big)} if big else {})},
             **({"fallback": fallback} if fallback else {}), "at": int(time.time())}
        (img / "READY.json").write_text(json.dumps(d, ensure_ascii=False), encoding="utf-8")
        freed = cleanup(keep_main=fallback in ("disk", "indirme"))["freed"]
        for t in BITS:
            if t != tier:
                shutil.rmtree(img / f"zimage-{t}", ignore_errors=True)
        return {"ok": True, "path": str(dest), "freed": freed}
    finally:
        lk.close()


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    real, sys.stdout = sys.stdout, sys.stderr  # stdout'a yalnız sonuç satırı (kütüphanelerin print'leri stderr'e)
    try:
        res = (plan() if cmd == "plan" else save(sys.argv[2], sys.argv[3]) if cmd == "save" else test(sys.argv[2], sys.argv[3], sys.argv[4]) if cmd == "test"
               else finalize(*sys.argv[2:13]) if cmd == "finalize" and len(sys.argv) >= 13 else cleanup() if cmd == "cleanup"
               else {"ok": False, "error": "kullanım: plan | save DÜZEY HEDEF | test MODEL GENİŞLİK YÜKSEKLİK | finalize … | cleanup"})
    except Exception as e:
        res = {"ok": False, "error": f"{type(e).__name__}: {str(e)[:300]}"}
    print(json.dumps(res, ensure_ascii=False), file=real, flush=True)
    sys.exit(0 if res.get("ok") else 1)
