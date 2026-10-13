#!/usr/bin/env python3
"""Claude'suz şablon videolar (deprem, maç sonucu, piyasa, takvim) için ortak yardımcılar.

Bu videoların bilgisi kesin veridir (AFAD, ESPN, kur verisi, takvim); senaryo şablondan yazılır, Claude çağrılmaz
(sıfır token, uydurma riski yok, deprem gibi haberlerde dakikalar içinde hazır). Görsel olarak haber fotoğrafı yerine
kodla çizilen bilgi kartı (`src/InfoCard.tsx`: deprem haritası, skor tablosu, piyasa tablosu, takvim yaprağı) kullanılır.

İş klasörü `work/jobs/<ad>/`: `claude_out.json` (şablon senaryo), `cards.json` (kart prop'ları), `meta.json`.
Panel `startAnlik(..., {templateDir, info})` ile `TEMPLATE_DIR` verir; `pipeline.sh` senaryoyu kopyalar, Claude'u atlar,
seslendirmeden sonra `python3 scripts/info_card.py --render DIR` kartları çizer (`cards_out.json`), `fetch_images` her
kanca/haber segmentine sırayla bir kart koyar ve video/fotoğraf aramaz.
"""
import json
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import ROOT  # noqa: E402

JOBS = ROOT / "work" / "jobs"
MONTHS = ["Ocak", "Şubat", "Mart", "Nisan", "Mayıs", "Haziran", "Temmuz", "Ağustos", "Eylül", "Ekim", "Kasım", "Aralık"]
DAYS = ["Pazartesi", "Salı", "Çarşamba", "Perşembe", "Cuma", "Cumartesi", "Pazar"]


def tr_date(t: float | None = None, weekday: bool = False) -> str:
    lt = time.localtime(t or time.time())
    return f"{lt.tm_mday} {MONTHS[lt.tm_mon - 1]}" + (f" {DAYS[lt.tm_wday]}" if weekday else "")


def num_tr(x: float, d: int = 1) -> str:
    """4.8 → "4,8"; 1250.5 → "1.250,50" (d=2)."""
    s = f"{x:,.{d}f}"
    return s.replace(",", "_").replace(".", ",").replace("_", ".")


def make_script(hook_title: str, hook: str, items: list, titles: dict, hashtags: list, importance: int, reason: str,
                source: str, category: str) -> dict:
    """Anlık şemasında senaryo: kanca + intro + haber segmentleri + outro (intro/outro metnini assemble yazar)."""
    segs = [{"kind": "hook", "title": hook_title, "narration": hook, "source": source, "category": category},
            {"kind": "intro", "narration": "Son dakika."}]
    for it in items:
        segs.append({"kind": "haber", "title": it["title"], "narration": it["narration"], "source": it.get("source") or source,
                     "category": it.get("category") or category, **({"breaking": True} if it.get("breaking") else {})})
    segs.append({"kind": "outro", "narration": "Takip etmeyi unutma."})
    return {"titles": titles, "hashtags": hashtags, "importance": importance, "importanceReason": reason, "segments": segs}


def new_job(name: str, script: dict, cards: list, meta: dict | None = None) -> Path:
    """İş klasörünü yazar (eskisini siler) ve yolunu döndürür (proje köküne göre)."""
    d = JOBS / re.sub(r"[^\w.-]+", "-", name)[:80]
    if d.exists():
        shutil.rmtree(d, ignore_errors=True)
    d.mkdir(parents=True, exist_ok=True)
    (d / "claude_out.json").write_text(json.dumps(script, ensure_ascii=False, indent=2), encoding="utf-8")
    (d / "cards.json").write_text(json.dumps(cards, ensure_ascii=False, indent=2), encoding="utf-8")
    # gereken en kısa süre: assemble kelime sınırı süre × 2,4 (intro/outro hariç); panel bundan kısa süre vermez
    words = sum(len(x["narration"].split()) for x in script["segments"] if x["kind"] not in ("intro", "outro"))
    meta = {**(meta or {}), "duration": min(60, int(words / 2.4) + 3)}
    (d / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    # 3 günden eski iş klasörleri temizlenir
    for old in JOBS.iterdir():
        if old.is_dir() and old != d and time.time() - old.stat().st_mtime > 3 * 86400:
            shutil.rmtree(old, ignore_errors=True)
    return d.relative_to(ROOT)


def render(job_dir: Path) -> list:
    """cards.json'daki her kartı geniş (1840x1120) ve dikey (1080x1920) çizer → cards_out.json [{card, tall}]."""
    job_dir = (ROOT / job_dir) if not job_dir.is_absolute() else job_dir
    cards = json.loads((job_dir / "cards.json").read_text(encoding="utf-8"))
    jobs, out = [], []
    for i, props in enumerate(cards):
        wide, tall = job_dir / f"card-{i}.jpg", job_dir / f"card-{i}-tall.jpg"
        jobs += [{"id": "InfoCard", "out": str(wide.relative_to(ROOT)), "props": {**props, "tall": False}},
                 {"id": "InfoCardTall", "out": str(tall.relative_to(ROOT)), "props": {**props, "tall": True}}]
        out.append({"card": str(wide.relative_to(ROOT)), "tall": str(tall.relative_to(ROOT))})
    jf = job_dir / "card_jobs.json"
    jf.write_text(json.dumps(jobs, ensure_ascii=False), encoding="utf-8")
    try:
        r = subprocess.run(["node", str(ROOT / "scripts" / "render_thumbs.mjs"), str(jf)], cwd=ROOT, capture_output=True, text=True, timeout=600)
        if r.returncode != 0:
            print(f"  ! bilgi kartı çizilemedi: {(r.stdout + r.stderr).strip()[-300:]}", file=sys.stderr)
    except Exception as e:
        print(f"  ! bilgi kartı çizilemedi: {e}", file=sys.stderr)
    ok = [c for c in out if (ROOT / c["card"]).exists() and (ROOT / c["tall"]).exists()]
    (job_dir / "cards_out.json").write_text(json.dumps(ok, ensure_ascii=False), encoding="utf-8")
    print(f"  🗂 bilgi kartı: {len(ok)}/{len(out)} çizildi")
    return ok


def cards_for_episode() -> list:
    """fetch_images için: TEMPLATE_DIR'de çizilmiş kartlar (yoksa boş)."""
    d = os.environ.get("TEMPLATE_DIR", "").strip()
    if not d:
        return []
    f = ROOT / d / "cards_out.json"
    try:
        return [c for c in json.loads(f.read_text(encoding="utf-8")) if (ROOT / c["card"]).exists()]
    except Exception:
        return []


if __name__ == "__main__":
    if "--render" in sys.argv:
        render(Path(sys.argv[sys.argv.index("--render") + 1]))
    else:
        print(__doc__)
