#!/usr/bin/env python3
"""Gerçekçi görsel üretimi (benzer video sahneleri; kullanıcı isteği, 27 Ekim: "benzerini sıfırdan yap gönderilerimiz çok basit çizimlerle
oluyor; rakip üreticiler çok gerçekçi üretiyor"). Mac'te yerel ve ücretsiz: mflux + Z-Image-Turbo (Apache-2.0, 4 bit), ayrı ortam
.venv-image (scripts/install_image.sh kurar), üretici scripts/zimage_run.py (model bir kez yüklenir).

  ready()            → (hazır mı, neden değil): Apple Silicon + .venv-image + models/image/READY.json
  generate(shots, out_dir, log) → {anahtar: 1080x1920 jpg yolu ya da None}, bilgi
      shots: [{"key": "s1-0", "prompt": "...", "seed": 123}]; aynı (model, boyut, adım, tohum, tarif) work/image_cache/'ten gelir
      (düzeltme turunda değişmeyen sahneler yeniden üretilmez). İlerleme log'a: "🎨 görsel 3/9 hazır (21 sn)".
  budget(target)     → bir videonun en çok kaç fotoğrafı (süre, settings.image.maxImages, maxMinutes ve kurulumdaki deneme süresi)
Ayarlar settings.image {enabled true, model, width 720, height 1280, steps 9, perImageSec 240, maxImages 16, maxMinutes 15, badge}.
Test için IMAGE_RUNNER="<python> <betik>" gerçek üretici yerine verilen betiği çalıştırır (aynı spec/çıktı düzeni) ve motoru hazır sayar.

Komut satırı: python3 scripts/image_gen.py --status   (JSON: ready, why, model, testSec)
"""
import hashlib
import json
import os
import platform
import shlex
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import ROOT, settings  # noqa: E402

VENV_PY = ROOT / ".venv-image" / "bin" / "python"
READY = ROOT / "models" / "image" / "READY.json"
CACHE = ROOT / "work" / "image_cache"
DEFAULTS = {"enabled": True, "model": "filipstrand/Z-Image-Turbo-mflux-4bit", "width": 720, "height": 1280, "steps": 9, "perImageSec": 240,
            "maxImages": 16, "maxMinutes": 15, "badge": "Yapay zekâ ile canlandırıldı"}
STYLE_DEFAULT = ("photorealistic cinematic documentary photograph, natural light, 35mm lens, shallow depth of field, realistic skin texture, "
                 "subtle film grain, no text")


def cfg() -> dict:
    c = {**DEFAULTS, **(settings().get("image") or {})}
    for k, lo, hi in (("width", 256, 1440), ("height", 256, 2048), ("steps", 2, 50), ("perImageSec", 30, 1800), ("maxImages", 3, 40),
                      ("maxMinutes", 3, 60)):
        try:
            c[k] = max(lo, min(hi, int(c[k])))
        except (TypeError, ValueError):
            c[k] = DEFAULTS[k]
    c["width"], c["height"] = c["width"] // 16 * 16, c["height"] // 16 * 16
    c["badge"] = str(c["badge"]).strip()[:60] if isinstance(c.get("badge"), str) else DEFAULTS["badge"]  # "" etiketsiz
    return c


def enabled() -> bool:
    """Panel anahtarı (settings.image.enabled): kapalıysa benzer video çizimle yapılır (talimatta "gerçekçi" denirse yine fotoğraf)."""
    v = cfg().get("enabled")
    return not (v is False or v == 0 or str(v).strip().lower() in ("false", "0", "kapalı"))


def est_sec() -> float:
    """Bir fotoğrafın tahmini üretim süresi, sn: kurulumdaki deneme (512x896) piksel oranıyla büyütülür; deneme yoksa 45."""
    c = cfg()
    try:
        t = float(json.loads(READY.read_text(encoding="utf-8")).get("testSec") or 0)
    except (OSError, ValueError, TypeError, AttributeError):
        t = 0.0
    if t <= 0:
        return 45.0
    return round(min(600.0, 2.0 + t * 1.15 * (c["width"] * c["height"]) / (512 * 896) * c["steps"] / 9), 1)


def budget(target: float) -> int:
    """Bir videonun en çok kaç fotoğrafı: ~3,5 sn'ye bir fotoğraf, en çok maxImages ve maxMinutes içinde üretilebilecek kadar (en az 4)."""
    c = cfg()
    by_len = round(float(target or 30) / 3.5)
    by_time = int(c["maxMinutes"] * 60 // max(1.0, est_sec()))
    return max(4, min(c["maxImages"], by_len, by_time))


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
        return subprocess.run(["sysctl", "-n", "hw.optional.arm64"], capture_output=True, text=True, timeout=5).stdout.strip() == "1"
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
    return True, ""


def status() -> dict:
    ok, why = ready()
    info = {}
    try:
        info = json.loads(READY.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        pass
    return {"ready": ok, "why": why, "model": info.get("model") or cfg()["model"], "testSec": info.get("testSec"), "installed": VENV_PY.exists(),
            "enabled": enabled(), "estSec": est_sec() if ok else None,
            "supported": bool(_runner()) or supported()}


def _key(c: dict, prompt: str, seed: int) -> str:
    return hashlib.sha1(json.dumps([c["model"], c["width"], c["height"], c["steps"], int(seed), prompt], ensure_ascii=False).encode()).hexdigest()


def _prune(keep: int = 400) -> None:
    try:
        files = sorted(CACHE.glob("*.png"), key=lambda p: p.stat().st_mtime, reverse=True)
        for p in files[keep:]:
            p.unlink(missing_ok=True)
    except OSError:
        pass


def _to_frame(src: Path, dst: Path) -> bool:
    """Üretilen görsel → 1080x1920 jpg (oran uymazsa ortadan kırpılır), hafif keskinleştirme."""
    r = subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(src), "-vf",
                        "scale=1080:1920:force_original_aspect_ratio=increase:flags=lanczos,crop=1080:1920,unsharp=5:5:0.35",
                        "-q:v", "3", str(dst)], capture_output=True)
    return r.returncode == 0 and dst.exists() and dst.stat().st_size > 5000


def generate(shots: list, out_dir: Path, log=print) -> tuple:
    """Görselleri üretir (önbellekte olanlar hemen gelir). Dönüş ({key: Path | None}, {"made", "cached", "failed", "error", "sec"})."""
    c = cfg()
    out_dir.mkdir(parents=True, exist_ok=True)
    CACHE.mkdir(parents=True, exist_ok=True)
    res, todo, info = {}, [], {"made": 0, "cached": 0, "failed": 0, "error": "", "sec": 0.0}
    for s in shots:
        png = CACHE / f"{_key(c, s['prompt'], s['seed'])}.png"
        if png.exists() and png.stat().st_size > 5000:
            res[s["key"]] = out_dir / f"{s['key']}.jpg" if _to_frame(png, out_dir / f"{s['key']}.jpg") else None
            info["cached"] += 1
        else:
            todo.append((s, png))
    if not todo:
        return res, info
    ok, why = ready()
    if not ok:
        for s, _ in todo:
            res[s["key"]] = None
        info.update(failed=len(todo), error=why)
        return res, info
    tmp = out_dir / "_uret"
    tmp.mkdir(exist_ok=True)
    spec = {"model": c["model"], "steps": c["steps"],
            "jobs": [{"prompt": s["prompt"], "seed": int(s["seed"]), "w": c["width"], "h": c["height"], "out": str(tmp / f"{i}.png")} for i, (s, _) in enumerate(todo)]}
    sp = tmp / "spec.json"
    sp.write_text(json.dumps(spec, ensure_ascii=False), encoding="utf-8")
    cmd = (_runner() or [str(VENV_PY), str(ROOT / "scripts" / "zimage_run.py")]) + [str(sp)]
    # süre sınırı: görsel başına perImageSec, ama bütün iş en çok bütçe süresinin 1,6 katı + 4 dk (panelin iş sınırı aşılmasın; bitmiş görseller
    # yine kullanılır, kalanlar komşu sahneden)
    limit = min(240 + c["perImageSec"] * len(todo), 240 + int(c["maxMinutes"] * 60 * 1.6))
    reuse = f", {info['cached']} tanesi önceki üretimden" if info["cached"] else ""
    log(f"🎨 {len(todo)} gerçekçi görsel üretiliyor (Z-Image-Turbo, Mac'te yerel; görsel başına ~{round(est_sec())} sn{reuse})")
    t0 = time.time()
    env = dict(os.environ)
    if not Path(env.get("SSL_CERT_FILE") or "/yok").exists() and Path("/etc/ssl/cert.pem").exists():
        env["SSL_CERT_FILE"] = "/etc/ssl/cert.pem"
    env.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
    out_text, err_tail, done_i = "", [], set()
    try:
        p = subprocess.Popen(cmd, cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env)
        killer = threading.Timer(limit, lambda: p.kill())
        killer.start()
        try:
            for line in p.stderr:
                line = line.strip()
                try:
                    ev = json.loads(line)
                except ValueError:
                    if line:
                        err_tail = (err_tail + [line])[-6:]
                    continue
                if "load" in ev:
                    log(f"🎨 görsel modeli yüklendi ({ev['load']} sn)")
                elif "i" in ev:
                    log(f"🎨 görsel {ev['i']}/{ev['n']} {'hazır' if ev.get('ok') else 'üretilemedi'} ({ev.get('sec')} sn)")
                    if ev.get("ok"):
                        done_i.add(int(ev["i"]) - 1)
            out_text = p.stdout.read()
            p.wait()
        finally:
            killer.cancel()
    except OSError as e:
        info["error"] = f"üretici çalıştırılamadı: {str(e)[:160]}"
    out = {}
    try:
        out = json.loads((out_text or "").strip().splitlines()[-1])
    except (ValueError, IndexError):
        if not info["error"]:
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
            res[s["key"]] = out_dir / f"{s['key']}.jpg" if _to_frame(png, out_dir / f"{s['key']}.jpg") else None
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
