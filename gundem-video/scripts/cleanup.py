#!/usr/bin/env python3
"""Disk temizliği (her gece, panel çağırır): `settings.cleanup.days` (30) günden eski ve en az bir platformda
yayınlanmış videoların Mac'teki mp4'ü silinir; yayınlanmamışlar iki katı süre (60 gün) bekler. Kayıt (json), kapaklar,
izlenme verisi ve platformdaki video KALIR: json'a `archived` yazılır, analiz ve raporlar videoyu saymaya devam eder.
Sınır sırasında bekleyen ya da demo videolar silinmez.

  python3 scripts/cleanup.py            # sil, son satır JSON {deleted, freedMb}
  python3 scripts/cleanup.py --dry-run  # yalnızca listele
"""
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import DATA, OUT, load_json, metrics, now_iso, save_json, settings  # noqa: E402


def main(dry=False):
    cfg = {"enabled": True, "days": 30, **(settings().get("cleanup") or {})}
    if not cfg["enabled"] and not dry:
        print(json.dumps({"deleted": [], "freedMb": 0, "skipped": "kapalı"}))
        return
    days = max(7, int(cfg["days"]))
    vids = metrics().get("videos", {})
    queued = {x.get("video") for x in (load_json(DATA / "publish_queue.json", []) or [])}
    now, deleted, freed = time.time(), [], 0
    for mp4 in sorted(OUT.glob("*.mp4")):
        if not mp4.name[:4].isdigit() or mp4.name in queued:  # demo/test videoları ve yükleme sırasındakiler
            continue
        age = (now - mp4.stat().st_mtime) / 86400
        published = [p for p, v in (vids.get(mp4.name) or {}).items() if isinstance(v, dict) and (v.get("id") or v.get("publish_id"))]
        if age < days or (not published and age < days * 2):
            continue
        size = mp4.stat().st_size
        deleted.append({"video": mp4.name, "ageDays": round(age), "published": published, "mb": round(size / 1e6, 1)})
        if dry:
            continue
        meta_file = mp4.with_suffix(".json")
        meta = load_json(meta_file, {}) or {}
        save_json(meta_file, {**meta, "archived": now_iso()})
        mp4.unlink()
        freed += size
        for extra in (OUT / (mp4.stem + "-render.mp4"),):
            if extra.exists():
                freed += extra.stat().st_size
                extra.unlink()
    for d in deleted:
        print(f"🧹 {'silinecek' if dry else 'silindi'}: {d['video']} ({d['ageDays']} gün, {d['mb']} MB, "
              f"{'yayında: ' + ', '.join(d['published']) if d['published'] else 'yayınlanmamıştı'})")
    print(json.dumps({"deleted": deleted, "freedMb": round(freed / 1e6), "dryRun": dry}, ensure_ascii=False))


if __name__ == "__main__":
    main("--dry-run" in sys.argv)
