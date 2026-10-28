#!/usr/bin/env python3
"""Gerçekçi görsel üretimi (benzer video sahneleri; kullanıcı isteği, 27 Ekim: "benzerini sıfırdan yap gönderilerimiz çok basit çizimlerle
oluyor; rakip üreticiler çok gerçekçi üretiyor"; 28 Ekim: "daha gerçekçi, daha bol detaylı; süre çok önemli değil, görseller çok çok
gerçekçi olsun"). Mac'te yerel ve ücretsiz: mflux + Z-Image-Turbo (Apache-2.0), ayrı ortam .venv-image (scripts/install_image.sh kurar),
üretici scripts/zimage_run.py (model bir kez yüklenir).

Motor (models/image/READY.json):
  sürüm 2 (28 Ekim): asıl depodan Mac'in belleğine göre tam hassasiyet (bf16) ya da 8 bit yerel kopya (models/image/zimage-<düzey>), yerel
    1152x2048 (Z-Image'ın önerdiği en büyük 9:16 boyut; bu boyutta bellek yetmezse 864x1536), sabit kaydırma 3 zamanlaması, 8 adım (modelin
    kendi ayarı); kare büyütülmez, keskinleştirilmez; uzun üretimde Mac uyumaz (caffeinate)
  sürüm 1 (27 Ekim, eski kurulum): hazır 4 bit depo (filipstrand), 720x1280, mflux'un çözünürlüğe bağlı zamanlaması, 1080x1920'ye büyütme;
    çalışmaya devam eder, panel "⬆ Yükselt" ile sürüm 2'ye geçilir

  ready()            → (hazır mı, neden değil): Apple Silicon + .venv-image + models/image/READY.json (sürüm 2'de model klasörü de)
  generate(shots, out_dir, log) → {anahtar: kare jpg yolu ya da None}, bilgi
      shots: [{"key": "s1-0", "prompt": "...", "seed": 123}]; aynı (model, boyut, adım, zamanlama, tohum, tarif) work/image_cache/'ten gelir
      (düzeltme turunda değişmeyen sahneler yeniden üretilmez). İlerleme log'a: "🎨 görsel 3/9 hazır (4 dk 5 sn; kalan ~25 dk)".
  budget(target)     → bir videonun en çok kaç fotoğrafı (süre, settings.image.maxPhotos, maxPhotoMinutes ve kurulumdaki deneme süresi)
Ayarlar settings.image {enabled true, maxPhotos 28, maxPhotoMinutes 480, badge; uzman ayarı: model, width, height, steps, scheduler,
perImageSec}. Eski maxImages/maxMinutes (16/15) okunmaz: panel her ayar kaydında varsayılanları settings.json'a yazdığı için kullanıcının
seçimi değil eski varsayılanın kopyasıdır.
Test için IMAGE_RUNNER="<python> <betik>" gerçek üretici yerine verilen betiği çalıştırır (aynı spec/çıktı düzeni) ve motoru hazır sayar.

Komut satırı: python3 scripts/image_gen.py --status   (JSON: ready, why, version, tier, model, width, height, estSec, upgrade …)
"""
import hashlib
import json
import math
import os
import platform
import re
import shlex
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path

try:
    import fcntl
except ImportError:  # Windows: kilit yok (motor zaten yalnız Mac'te)
    fcntl = None

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import ROOT, settings  # noqa: E402

VENV_PY = ROOT / ".venv-image" / "bin" / "python"
READY = ROOT / "models" / "image" / "READY.json"
CACHE = ROOT / "work" / "image_cache"
LOCK = CACHE / ".uretim.lock"  # aynı anda tek üretim (iki iş iki modeli birden yükleyip 16 GB belleği taşırmasın)
_TQDM = re.compile(r"\d+%\||it/s\]|s/it\]")
DEFAULTS = {"enabled": True, "maxPhotos": 28, "maxPhotoMinutes": 480, "badge": "Yapay zekâ ile canlandırıldı"}
LEGACY = {"version": 1, "model": "filipstrand/Z-Image-Turbo-mflux-4bit", "tier": "q4", "width": 720, "height": 1280, "steps": 9, "scheduler": None}
TIERS = {"bf16": "tam hassasiyet", "q8": "8 bit", "q6": "6 bit", "q4": "4 bit", "q4hazir": "4 bit"}
# Stil satırı (planda gorsel_stil yoksa; araştırma, 28 Ekim): çekimden bağımsız tek fotoğraf görünümü — objektif, alan derinliği ve ışık
# her tarifin kendi çekim cümlesinde (geniş planda derin odak, yakında flu arka plan çelişmesin); "cinematic", "photorealistic", "8k" gibi
# etiketler cildi plastikleştirir; Turbo'da olumsuz tarif olmadığı için "no text" yazılmaz (yazıyı anmak onu çağırır)
STYLE_DEFAULT = ("candid documentary photograph on a full-frame digital camera, natural true-to-life colors, soft natural contrast, "
                 "fine natural grain, unretouched")


def _num(v, d: float) -> float:
    """Sayı (READY.json elle bozulmuş olabilir): pozitif sonlu değilse d."""
    try:
        x = float(v)
    except (TypeError, ValueError, OverflowError):
        return d
    return x if math.isfinite(x) and x > 0 else d


def engine() -> dict:
    """Kurulu motor (READY.json). Sürüm 2: {"version": 2, "model": yerel klasör, "tier", "width", "height", "steps", "scheduler",
    "genSec" (kurulumda testW x testH boyutunda bir görselin süresi), "testW", "testH", "loadSec", "ram", "fallback" (en yüksek düzey
    kurulamadıysa nedeni: "disk", "indirme" — yeniden denenebilir — ya da "bellek"; yoksa "")}. Sürüm 1, bozuk ya da olmayan dosya:
    eski 4 bit kurulum (LEGACY + "testSec": 512x896 denemenin süresi); dosya yoksa ready() zaten hazır değil der."""
    try:
        r = json.loads(READY.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        r = {}
    r = r if isinstance(r, dict) else {}
    if _num(r.get("version"), 1) >= 2 and isinstance(r.get("model"), str) and r["model"].strip():
        w, h = int(_num(r.get("width"), 1152)), int(_num(r.get("height"), 2048))
        return {"version": 2, "model": r["model"].strip(), "tier": str(r.get("tier") or ""), "width": w, "height": h,
                "steps": int(_num(r.get("steps"), 9)), "scheduler": "linear" if r.get("scheduler") == "linear" else "static_shift3",
                "genSec": _num(r.get("genSec"), 0.0), "testW": int(_num(r.get("testW"), w)), "testH": int(_num(r.get("testH"), h)),
                "loadSec": _num(r.get("loadSec"), 0.0), "ram": _num(r.get("ram"), 0.0),
                "fallback": r["fallback"] if r.get("fallback") in ("disk", "indirme", "bellek") else ""}
    return {**LEGACY, "testSec": _num(r.get("testSec"), 0.0), "loadSec": _num(r.get("loadSec"), 0.0)}


def cfg() -> dict:
    # settings.image nesne değilse (ör. "image": false ya da "kapalı") anahtar sayılır; liste/sayı bütün benzer video işlerini çökertmesin
    # (inceleme, 28 Ekim; server.js imageCfg aynı kural)
    v = settings().get("image")
    user = v if isinstance(v, dict) else {} if v is None or isinstance(v, (list, tuple)) else {"enabled": v}
    e = engine()
    base = {**DEFAULTS, **{k: e[k] for k in ("model", "width", "height", "steps", "scheduler")}}
    c = {**base, **{k: x for k, x in user.items() if k not in ("version", "tier")}, "version": e["version"], "tier": e.get("tier") or ""}
    for k, lo, hi in (("width", 256, 2048), ("height", 256, 2048), ("steps", 2, 50), ("maxPhotos", 4, 40), ("maxPhotoMinutes", 10, 1440)):
        try:
            c[k] = max(lo, min(hi, int(c[k])))
        except (TypeError, ValueError, OverflowError):
            c[k] = base[k]
    c["width"], c["height"] = c["width"] // 16 * 16, c["height"] // 16 * 16
    try:
        c["perImageSec"] = max(30, min(3600, int(user["perImageSec"]))) if user.get("perImageSec") is not None else None
    except (TypeError, ValueError, OverflowError):
        c["perImageSec"] = None
    c["model"] = c["model"].strip() if isinstance(c.get("model"), str) and c["model"].strip() else e["model"]
    c["scheduler"] = c["scheduler"] if c.get("scheduler") in ("static_shift3", "linear") else e["scheduler"]
    c["badge"] = str(c["badge"]).strip()[:60] if isinstance(c.get("badge"), str) else DEFAULTS["badge"]  # "" etiketsiz
    return c


def enabled() -> bool:
    """Panel anahtarı (settings.image.enabled): kapalıysa benzer video çizimle yapılır (talimatta "gerçekçi" denirse yine fotoğraf)."""
    v = cfg().get("enabled")
    return not (v is False or v == 0 or str(v).strip().lower() in ("false", "0", "kapalı"))


def est_sec() -> float:
    """Bir fotoğrafın tahmini üretim süresi, sn. Sürüm 2: kurulumdaki deneme üretim boyutunda ölçülür (genSec); boyut ayarla değiştirildiyse
    işlem yükü piksel sayısının ~1,2. kuvvetiyle değişir (dikkat katmanları: 864x1536 → 1152x2048 piksel 1,78 kat, işlem ~2 kat). Sürüm 1:
    512x896 deneme piksel oranıyla büyütülür. Deneme yoksa sürüm 2'de 300, sürüm 1'de 45."""
    c, e = cfg(), engine()
    if e["version"] >= 2:
        if e["genSec"] <= 0:
            return 300.0
        ratio = (c["width"] * c["height"]) / max(1, e["testW"] * e["testH"])
        return round(min(3600.0, 2.0 + e["genSec"] * ratio ** 1.2 * c["steps"] / max(1, e["steps"])), 1)
    t = e.get("testSec") or 0.0
    if t <= 0:
        return 45.0
    return round(min(600.0, 2.0 + t * 1.15 * (c["width"] * c["height"]) / (512 * 896) * c["steps"] / 9), 1)


def budget(target: float) -> int:
    """Bir videonun en çok kaç fotoğrafı: ~3,2 sn'ye bir fotoğraf (sahne başına 2-4 çekim; 60 sn'lik videoda 19), en çok maxPhotos ve
    maxPhotoMinutes içinde üretilebilecek kadar (en az 4)."""
    c = cfg()
    try:
        by_len = round(float(target or 30) / 3.2)
    except (TypeError, ValueError, OverflowError):
        by_len = 10
    by_time = int(c["maxPhotoMinutes"] * 60 // max(1.0, est_sec()))
    return max(4, min(c["maxPhotos"], by_len, by_time))


def stall_sec() -> int:
    """Bir görselin en uzun süresi, sn (ilerleme satırı bu kadar gelmezse üretici takılmış sayılır): ayar perImageSec ya da tahminin 3 katı,
    en az 5 dk."""
    c = cfg()
    return int(c["perImageSec"] or max(300, round(est_sec() * 3)))


def _cap_sec() -> int:
    """Bir üretimin en uzun süresi, sn: en uzun videonun (90 sn) bütçesindeki fotoğrafların tahmini süresi × 1,6 + 4 dk (bütçe maxPhotoMinutes'ı
    zaten aşmaz; bitmiş görseller yine kullanılır, kalanlar komşu sahneden)."""
    return int(240 + 1.6 * min(cfg()["maxPhotoMinutes"] * 60, est_sec() * budget(90)))


def job_minutes() -> int:
    """Fotoğraflı benzer videonun fotoğraf payı, dk: başka videonun üretimini bekleme (en çok onun süre sınırı) + kendi üretimi (üretilemeyen
    fotoğrafların başka tohumla ikinci denemesi bunun içinde kalır: o yalnız birkaç fotoğraftır). server.js recreateTimeoutMin bunu iş süresine
    ekler (wa_video.py --visual-mode yanıtında)."""
    return math.ceil(2 * _cap_sec() / 60)


def _about(sec: float) -> str:
    """Yaklaşık süre: "45 sn", "12 dk", "1,5 saat"."""
    if sec < 90:
        return f"{max(1, round(sec))} sn"
    if sec < 90 * 60:
        return f"{round(sec / 60)} dk"
    return f"{sec / 3600:.1f}".replace(".", ",").replace(",0", "") + " saat"


def _sec_text(v) -> str:
    """İlerleme satırındaki süre: 100 sn'nin altında eskisi gibi "21.3 sn", üstünde "4 dk 12 sn"."""
    try:
        s = float(v)
    except (TypeError, ValueError, OverflowError):
        return f"{v} sn"
    return f"{v} sn" if not math.isfinite(s) or s < 100 else f"{int(s // 60)} dk {int(s % 60)} sn"


def eta_text() -> str:
    """Panelin başlangıç mesajı için: "fotoğraf başına ~4 dk, video başına ~40 dk-1,6 saat" (30 ve 90 sn'lik videonun bütçesiyle)."""
    est = est_sec()
    lo, hi = budget(30) * est + 60, budget(90) * est + 60
    span = _about(lo) if _about(lo) == _about(hi) else f"{_about(lo)}-{_about(hi)}"
    return f"fotoğraf başına ~{_about(est)}, video başına ~{span}"


def _runner() -> list | None:
    alt = os.environ.get("IMAGE_RUNNER", "").strip()
    return shlex.split(alt) if alt else None


def supported() -> bool:
    """Apple Silicon Mac mi (Rosetta altında çalışan Python da: sysctl hw.optional.arm64)."""
    if platform.system() != "Darwin":
        return False
    if platform.machine() == "arm64":
        return True
    try:
        sc = shutil.which("sysctl") or "/usr/sbin/sysctl"  # launchd servisinin PATH'inde /usr/sbin yok
        return subprocess.run([sc, "-n", "hw.optional.arm64"], capture_output=True, text=True, timeout=5).stdout.strip() == "1"
    except (OSError, subprocess.SubprocessError):
        return False


def ready() -> tuple:
    """(True, "") ya da (False, Türkçe neden)."""
    if _runner():
        return True, ""
    if not supported():
        return False, "yalnız Apple Silicon Mac'te çalışır"
    if not VENV_PY.exists():
        return False, "kurulu değil (bir kez: bash scripts/install_image.sh ya da panel → 📡 → 📷 Gerçekçi görseller → Kur)"
    if not READY.exists():
        return False, "kurulum tamamlanmamış (bash scripts/install_image.sh yeniden çalıştırın)"
    e = engine()
    if e["version"] >= 2 and not Path(e["model"]).is_dir():
        return False, "model klasörü bulunamadı (panel → 📡 → 📷 → Kur ya da bash scripts/install_image.sh ile yeniden kurun)"
    return True, ""


def status() -> dict:
    ok, why = ready()
    e, c = engine(), cfg()
    return {"ready": ok, "why": why, "version": e["version"], "tier": c["tier"], "model": c["model"], "width": c["width"], "height": c["height"],
            "testSec": e.get("genSec") or e.get("testSec") or None, "installed": VENV_PY.exists(), "enabled": enabled(),
            "estSec": est_sec() if ok else None, "fallback": e.get("fallback") or "", "supported": bool(_runner()) or supported(),
            "upgrade": (e["version"] < 2 and READY.exists()) or e.get("fallback") in ("disk", "indirme")}


def _key(c: dict, prompt: str, seed: int) -> str:
    """Önbellek anahtarı: model, boyut, adım, tohum, tarif ve zamanlama (sürüm 1'de zamanlama yok: anahtar eskisiyle aynı)."""
    k = [c["model"], c["width"], c["height"], c["steps"], int(seed), prompt] + ([c["scheduler"]] if c.get("scheduler") else [])
    return hashlib.sha1(json.dumps(k, ensure_ascii=False).encode()).hexdigest()


def _prune(keep: int = 400) -> None:
    try:
        files = sorted(CACHE.glob("*.png"), key=lambda p: p.stat().st_mtime, reverse=True)
        for p in files[keep:]:
            p.unlink(missing_ok=True)
    except OSError:
        pass


def frame_size(c: dict) -> tuple:
    """Remotion'a verilen karenin boyutu: sürüm 2'de üretim boyutu (1152x2048 küçültülmez: PhotoScene'in 1,10'a kadar yaklaşmasında kare
    keskin kalır; 1080'den dar üretim 1080x1920'ye büyütülür), sürüm 1'de 1080x1920."""
    if c["version"] < 2 or c["width"] < 1080:
        return 1080, 1920
    return c["width"], c["width"] * 16 // 9 // 2 * 2


def _to_frame(src: Path, dst: Path, c: dict) -> bool:
    """Üretilen görsel → kare jpg (oran uymazsa ortadan kırpılır). Sürüm 2: keskinleştirme yok, en yüksek jpg kalitesi, renk ayrıntısı tam
    (4:4:4; araştırma, 28 Ekim: büyütme, keskinleştirme ve jpg 3 ince dokuyu siliyordu). Sürüm 1: eskisi gibi 1080x1920'ye büyütme ve hafif
    keskinleştirme."""
    w, h = frame_size(c)
    vf = f"scale={w}:{h}:force_original_aspect_ratio=increase:flags=lanczos,crop={w}:{h}" + ("" if c["version"] >= 2 else ",unsharp=5:5:0.35")
    q = ["-q:v", "2", "-pix_fmt", "yuvj444p"] if c["version"] >= 2 else ["-q:v", "3"]
    r = subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(src), "-vf", vf, *q, str(dst)], capture_output=True)
    return r.returncode == 0 and dst.exists() and dst.stat().st_size > 5000


def _installing() -> bool:
    """Kurulum betiği çalışıyor mu (models/image/.kuruluyor içinde canlı süreç; server.js imageInstalling ile aynı): kilidi o tutuyorsa
    bekleme satırı "başka bir video" demesin (inceleme, 28 Ekim)."""
    try:
        pid = int((ROOT / "models" / "image" / ".kuruluyor").read_text().strip())
        os.kill(pid, 0)
        return pid > 0
    except PermissionError:
        return True
    except (OSError, ValueError):
        return False


def _lock(log):
    """Üretim kilidi (fcntl.flock; süreç ölürse kendiliğinden bırakılır): (dosya, beklenen sn) ya da (None, sn) süre dolduysa. İnceleme, 28 Ekim:
    WhatsApp videosu, link ve düzeltme işleri aynı anda çalışabiliyor; iki Z-Image-Turbo süreci 16 GB Mac'te belleği taşırıp ikisini de bozuyordu.
    Başka videonun üretimi en çok onun süre sınırı kadar beklenir (_cap_sec), sonra bu videonun sahneleri çizime düşer."""
    if fcntl is None:
        return True, 0.0
    f = open(LOCK, "a+")
    t0, said, wait_max = time.time(), False, _cap_sec()
    while True:
        try:
            fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
            if said:
                log(f"🎨 sıra geldi ({max(1, round((time.time() - t0) / 60))} dk beklendi)")
            return f, time.time() - t0
        except OSError:
            if not said:
                log("🎨 görsel motoru kuruluyor (deneme görseli üretiliyor); bitince başlanacak" if _installing() else
                    "🎨 başka bir videonun gerçekçi görselleri üretiliyor; o bitince başlanacak")
                said = True
            if time.time() - t0 > wait_max:
                f.close()
                return None, time.time() - t0
            time.sleep(3)


def _split(shots: list, out_dir: Path) -> tuple:
    """(ayar, {key: kare | None} önbellekten gelenler, üretilecekler [(shot, önbellek png)], bilgi)."""
    c = cfg()
    res, todo, info = {}, [], {"made": 0, "cached": 0, "failed": 0, "error": "", "sec": 0.0}
    for s in shots:
        png = CACHE / f"{_key(c, s['prompt'], s['seed'])}.png"
        if png.exists() and png.stat().st_size > 5000:
            res[s["key"]] = out_dir / f"{s['key']}.jpg" if _to_frame(png, out_dir / f"{s['key']}.jpg", c) else None
            info["cached"] += 1
        else:
            todo.append((s, png))
    return c, res, todo, info


def generate(shots: list, out_dir: Path, log=print) -> tuple:
    """Görselleri üretir (önbellekte olanlar hemen gelir). Dönüş ({key: Path | None}, {"made", "cached", "failed", "error", "sec"})."""
    out_dir.mkdir(parents=True, exist_ok=True)
    CACHE.mkdir(parents=True, exist_ok=True)
    c, res, todo, info = _split(shots, out_dir)
    if not todo:
        return res, info

    def fail(why):
        for s, _ in todo:
            res[s["key"]] = None
        info.update(failed=len(todo), error=why)
        return res, info

    ok, why = ready()
    if not ok:
        return fail(why)
    lk, waited = _lock(log)
    if lk is None:
        return fail(f"başka bir videonun görselleri {round(waited / 60)} dakikada bitmedi")
    try:
        # kilit beklendiyse motor bu arada değişmiş olabilir (inceleme, 28 Ekim: yükseltme kurulumu kilidi bırakınca READY.json'u yazıp eski
        # modeli siliyor, bekleyen video eski ayarla başlıyordu): ayar, önbellek ve hazırlık yeniden okunur
        if waited > 0.5:
            c, res, todo, info = _split(shots, out_dir)
            if not todo:
                return res, info
            ok, why = ready()
            if not ok:
                return fail(why)
        return _generate(c, todo, res, info, out_dir, log)
    finally:
        if lk is not True:
            lk.close()


def _generate(c: dict, todo: list, res: dict, info: dict, out_dir: Path, log) -> tuple:
    tmp = out_dir / "_uret"
    tmp.mkdir(exist_ok=True)
    ram = engine().get("ram") or 0
    spec = {"model": c["model"], "steps": c["steps"], **({"scheduler": c["scheduler"]} if c.get("scheduler") else {}),
            **({"cacheGB": 1 if ram <= 24 else 4} if c["version"] >= 2 and ram else {}),
            "jobs": [{"prompt": s["prompt"], "seed": int(s["seed"]), "w": c["width"], "h": c["height"], "out": str(tmp / f"{i}.png")} for i, (s, _) in enumerate(todo)]}
    sp = tmp / "spec.json"
    sp.write_text(json.dumps(spec, ensure_ascii=False), encoding="utf-8")
    # Rosetta altında çalışan panelden (x86_64 Node/Python) MLX açılmaz: üretici her zaman Apple Silicon olarak başlar (inceleme, 28 Ekim)
    native = ["arch", "-arm64"] if platform.system() == "Darwin" and platform.machine() != "arm64" and shutil.which("arch") else []
    # saatler süren üretimde Mac boşta uyumasın (caffeinate -i: süreç bitene kadar; ekran kararabilir)
    awake = ["caffeinate", "-i"] if platform.system() == "Darwin" and shutil.which("caffeinate") else []
    cmd = (_runner() or [*awake, *native, str(VENV_PY), str(ROOT / "scripts" / "zimage_run.py")]) + [str(sp)]
    # süre sınırları: bütün iş en çok bütçe süresinin 1,6 katı + 4 dk; ayrıca görsel başına bekçi (stall_sec; model açılışında daha uzun):
    # ilerleme satırı o kadar gelmezse üretici takılmıştır (saatlerce boşa beklenmesin). Bitmiş görseller yine kullanılır, kalanlar komşu sahneden.
    est, stall = est_sec(), stall_sec()
    limit = min(240 + stall * len(todo), _cap_sec())
    load_lim = max(900, int(engine().get("loadSec", 0) * 3) + 600)
    reuse = f", {info['cached']} tanesi önceki üretimden" if info["cached"] else ""
    tier = f" {TIERS[c['tier']]}" if c.get("tier") in TIERS else ""
    log(f"🎨 {len(todo)} gerçekçi görsel üretiliyor (Z-Image-Turbo{tier}, {c['width']}x{c['height']}, Mac'te yerel; görsel başına ~{_about(est)}, "
        f"toplam ~{_about(est * len(todo) + 60)}{reuse})")
    t0 = time.time()
    env = dict(os.environ)
    if not Path(env.get("SSL_CERT_FILE") or "/yok").exists() and Path("/etc/ssl/cert.pem").exists():
        env["SSL_CERT_FILE"] = "/etc/ssl/cert.pem"
    env.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
    if Path(c["model"]).is_dir():  # yerel kopya: indirme sunucusuna hiç gidilmez (internetsiz de çalışır)
        env["HF_HUB_OFFLINE"] = "1"
    out_text, err_tail, done_i, hit, secs = "", [], set(), [], []
    last, loaded = [time.time()], [False]
    try:
        p = subprocess.Popen(cmd, cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env)
        stop = threading.Event()

        def watch():
            while not stop.wait(2):
                now = time.time()
                why = ("süre" if now - t0 > limit else
                       "takıldı" if now - last[0] > (stall if loaded[0] else load_lim) else "")
                if why:
                    hit.append(why)
                    p.kill()
                    return

        threading.Thread(target=watch, daemon=True).start()
        try:
            for line in p.stderr:
                line = line.strip()
                try:
                    ev = json.loads(line)
                except ValueError:
                    ev = None
                if not isinstance(ev, dict):  # düz satır (ilerleme çubuğu satırları hata özetine girmez)
                    if line and not _TQDM.search(line):
                        err_tail = (err_tail + [line])[-6:]
                    continue
                if "load" in ev:
                    last[0], loaded[0] = time.time(), True
                    log(f"🎨 görsel modeli yüklendi ({ev.get('load')} sn)")
                elif "i" in ev:
                    try:
                        k = int(ev["i"])
                    except (TypeError, ValueError):
                        continue
                    last[0] = time.time()
                    n = ev.get("n", len(todo))
                    if ev.get("ok"):
                        done_i.add(k - 1)
                        secs.append(_num(ev.get("sec"), est))
                    left = len(todo) - k
                    eta = f"; kalan ~{_about(sum(secs) / len(secs) * left)}" if left > 0 and secs else ""
                    pk = f"; bellek {str(ev['peakGB']).replace('.', ',')} GB" if k == 1 and isinstance(ev.get("peakGB"), (int, float)) else ""
                    log(f"🎨 görsel {k}/{n} {'hazır' if ev.get('ok') else 'üretilemedi'} ({_sec_text(ev.get('sec'))}{eta}{pk})")
                    if ev.get("truncated"):
                        log(f"  ! {k}. görselin tarifi 512 belirteç sınırında kesildi (sonu modele gitmedi)")
            out_text = p.stdout.read()
            p.wait()
        finally:
            stop.set()
    except OSError as e:
        info["error"] = f"üretici çalıştırılamadı: {str(e)[:160]}"
    out = {}
    try:
        out = json.loads((out_text or "").strip().splitlines()[-1])
    except (ValueError, IndexError):
        if hit:
            info["error"] = (f"üretici {limit} sn süre sınırında durduruldu" if hit[0] == "süre" else
                             f"üretici {round((stall if loaded[0] else load_lim) / 60)} dakikadır ilerleme vermedi (takıldı), durduruldu")
        elif not info["error"]:
            info["error"] = (" | ".join(err_tail) or f"üretici {round(time.time() - t0)} sn içinde sonuç vermedi")[-300:]
    if out and not out.get("ok"):
        info["error"] = str(out.get("error") or "bilinmeyen hata")[:300]
    results = out.get("results") or {}
    if not out and done_i:  # süre doldu ya da üretici yarıda düştü: ilerleme satırında "hazır" denen görseller yine kullanılır
        results = {str(tmp / f"{i}.png"): "ok" for i in done_i}
        log(f"  ! görsel üretimi yarıda kaldı ({info['error'][:120]}); biten {len(done_i)} görsel kullanılıyor")
    for i, (s, png) in enumerate(todo):
        made = tmp / f"{i}.png"
        if results.get(str(made)) == "ok" and made.exists() and made.stat().st_size > 5000:
            shutil.move(str(made), png)
            res[s["key"]] = out_dir / f"{s['key']}.jpg" if _to_frame(png, out_dir / f"{s['key']}.jpg", c) else None
        else:
            res[s["key"]] = None
        info["made" if res[s["key"]] else "failed"] += 1
    info["sec"] = round(time.time() - t0, 1)
    shutil.rmtree(tmp, ignore_errors=True)
    _prune()
    return res, info


if __name__ == "__main__":
    if "--status" in sys.argv:
        print(json.dumps(status(), ensure_ascii=False))
