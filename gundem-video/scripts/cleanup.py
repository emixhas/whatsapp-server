#!/usr/bin/env python3
"""Disk temizliği (kullanıcı isteği, 19 Ekim: "tüm üretilen haberleri ve videoları, normal videolar dahil 2 gün sonra diskten
silelim — kapaklar da dahil"). Panel saatte bir çağırır; `settings.cleanup` {enabled true, days 2 (1-60)}.

`days` günden eski her video (5 saatlik, anlık, şablon, sosyal medya, fragman, özet, günün/haftanın özeti; yayınlanmış olsun olmasın):
mp4, kapakları (-kapak, -kapakA, -kapakB, -kapakYT), render artığı (-render.mp4) ve paneldeki küçük resmi (work/thumbs) silinir.
Kayıt (json, birkaç KB) KALIR ve `archived` alır: raporlar, analiz, haftanın özeti, yorum yanıtları ve izlenme takibi onunla çalışır;
platformdaki video ve istatistik de kalır. Silinmez: yükleme sırasında (publish_queue), planlı yayında (scheduled_publish) ya da
WhatsApp'ta yayın onayı bekleyen (wa_pending) video ve demo/test videoları (adı rakamla başlamayan).
Pazar derlemesi (weekly_top.py, son 7 günün en çok izlenenleri) videonun kendisini kullandığı için silmeden önce derlemenin kestiği
~8 sn'lik bölüm `work/derleme_parca/` altına ayrılır (8 gün tutulur; derleme kapalıysa ayrılmaz).
Ayrıca `days` günden eski: work/jobs (video/şablon iş klasörleri, kurgu parçaları), work/wa_inbox (indirilen/gönderilen kaynak
videolar), work/stories (hikâye dosyaları); videosu silinmiş eski kapaklar ve küçük resimler.

  python3 scripts/cleanup.py            # sil, son satır JSON {deleted, freedMb, other}
  python3 scripts/cleanup.py --dry-run  # yalnızca listele
"""
import json
import math
import shutil
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import DATA, OUT, ROOT, load_json, metrics, now_iso, save_json, settings  # noqa: E402

WORK = ROOT / "work"
THUMBS = WORK / "thumbs"
COVERS = ("-kapak.jpg", "-kapakA.jpg", "-kapakB.jpg", "-kapakYT.jpg")
PARCA_DAYS = 8  # Pazar derlemesi son 7 günü sıralar


def cfg() -> dict:
    raw = settings().get("cleanup")
    c = raw if isinstance(raw, dict) else {"enabled": False} if raw is False else {}
    try:
        days = float(c.get("days", 2))
    except (TypeError, ValueError):
        days = 2.0
    days = days if math.isfinite(days) and days > 0 else 2.0
    return {**c, "enabled": c.get("enabled", True) is not False, "days": max(1.0, min(60.0, days))}


def size_of(p: Path) -> int:
    try:
        if p.is_dir():
            return sum(f.stat().st_size for f in p.rglob("*") if f.is_file())
        return p.stat().st_size
    except OSError:
        return 0


def age_days(p: Path, now: float) -> float:
    try:
        if p.is_dir():  # klasörün en yeni dosyası (içine yeni dosya yazılmışsa genç sayılır)
            m = max([p.stat().st_mtime] + [f.stat().st_mtime for f in p.rglob("*") if f.is_file()])
        else:
            m = p.stat().st_mtime
    except OSError:
        return 0.0
    return (now - m) / 86400


def protected() -> set:
    """Henüz yayınlanacak videolar: yükleme sırası, planlı yayın, WhatsApp onayı."""
    names = {x.get("video") for x in (load_json(DATA / "publish_queue.json", []) or []) if isinstance(x, dict)}
    names |= {x.get("video") for x in (load_json(DATA / "scheduled_publish.json", []) or []) if isinstance(x, dict)}
    p = load_json(DATA / "wa_pending.json", None)
    if isinstance(p, dict) and p.get("video"):
        names.add(p["video"])
    return {str(n) for n in names if n}


def remove(p: Path, dry: bool) -> int:
    n = size_of(p)
    if not dry:
        try:
            shutil.rmtree(p) if p.is_dir() else p.unlink()
        except OSError:
            return 0
    return n


def main(dry=False):
    c = cfg()
    if not c["enabled"] and not dry:
        print(json.dumps({"deleted": [], "freedMb": 0, "skipped": "kapalı"}))
        return
    days, now = c["days"], time.time()
    vids, keep = metrics().get("videos", {}), protected()
    deleted, freed, other = [], 0, {"kapak": 0, "kucukResim": 0, "isKlasoru": 0, "kaynakVideo": 0, "hikaye": 0, "derlemeParcasi": 0, "derlemeAyrildi": 0}
    weekly = None
    for mp4 in sorted(OUT.glob("*.mp4")):
        if not mp4.name[:4].isdigit() or mp4.name.endswith("-render.mp4") or mp4.name in keep:  # demo/test, render artığı, yayını bekleyen
            continue
        age = age_days(mp4, now)
        if age < days:
            continue
        published = [p for p, v in (vids.get(mp4.name) or {}).items() if isinstance(v, dict) and (v.get("id") or v.get("publish_id"))]
        size = mp4.stat().st_size
        deleted.append({"video": mp4.name, "ageDays": round(age, 1), "published": published, "mb": round(size / 1e6, 1)})
        if dry:
            freed += size
            continue
        try:  # Pazar derlemesi bu videoyu seçebilir: derlemenin keseceği bölüm şimdiden ayrılır (hata olsa da silme sürer)
            if weekly is None:
                import weekly_top as weekly
            if weekly.cfg().get("enabled") is not False and weekly.save_clip(mp4.name):
                other["derlemeAyrildi"] += 1
        except Exception as e:
            print(f"  ! derleme parçası ayrılamadı ({mp4.name}): {str(e)[:120]}", file=sys.stderr)
        meta_file = mp4.with_suffix(".json")
        meta = load_json(meta_file, {}) or {}
        if meta:
            save_json(meta_file, {**meta, "archived": now_iso()})
        freed += remove(mp4, False)
    # videosu silinmiş (bu turda ya da daha önce) dosyalar: kapaklar ve render artığı (videosu duran genç dosyaya dokunulmaz), paneldeki
    # küçük resim (panel yalnız videosu duranları listeler)
    gone = {d["video"] for d in deleted}
    for f in sorted(OUT.glob("*.jpg")) + sorted(OUT.glob("*-render.mp4")):
        stem = next((f.name[: -len(x)] for x in (*COVERS, "-render.mp4") if f.name.endswith(x)), None)
        if not stem or not stem[:4].isdigit() or stem + ".mp4" in keep:
            continue
        if stem + ".mp4" not in gone and ((OUT / (stem + ".mp4")).exists() or age_days(f, now) < days):
            continue
        freed += remove(f, dry)
        other["kapak"] += 1
    for f in sorted(THUMBS.glob("*.jpg")) if THUMBS.exists() else []:
        name = f.stem + ".mp4"
        if not f.name[:4].isdigit() or name in keep or (name not in gone and (OUT / name).exists()):
            continue
        freed += remove(f, dry)
        other["kucukResim"] += 1
    # iş klasörleri, kaynak videolar, hikâye dosyaları: days günden eski
    for folder, key, limit in ((WORK / "jobs", "isKlasoru", days), (WORK / "wa_inbox", "kaynakVideo", days), (WORK / "stories", "hikaye", days),
                               (WORK / "derleme_parca", "derlemeParcasi", max(days, PARCA_DAYS))):
        if not folder.exists():
            continue
        for p in sorted(folder.iterdir()):
            if age_days(p, now) >= limit:
                freed += remove(p, dry)
                other[key] += 1
    for d in deleted:
        print(f"🧹 {'silinecek' if dry else 'silindi'}: {d['video']} ({d['ageDays']} gün, {d['mb']} MB, "
              f"{'yayında: ' + ', '.join(d['published']) if d['published'] else 'yayınlanmamıştı'})")
    print(json.dumps({"deleted": deleted, "freedMb": round(freed / 1e6), "other": other, "days": days, "dryRun": dry}, ensure_ascii=False))


if __name__ == "__main__":
    main("--dry-run" in sys.argv)
