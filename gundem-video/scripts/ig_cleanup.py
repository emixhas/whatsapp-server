#!/usr/bin/env python3
"""Instagram temizliği (kullanıcı isteği: "7 gün içinde Instagram'da 1000 izlenmenin altında olan tümünü sil").

  python3 scripts/ig_cleanup.py --plan --days 7 --max 1000 [--min-age-hours 0]
      silinecekleri listeler (hiçbir şey silmez): son `days` gün içinde Instagram'a yüklenmiş, izlenmesi `max`'ın altında,
      en az `min-age-hours` saatlik videolar. İzlenmesi hiç ölçülmemiş video listeye girmez (bilinmeyen = silinmez).
  python3 scripts/ig_cleanup.py --auto-plan --max 5000 --wait-hours 72 --max-age-days 30 [--keep a.mp4,b.mp4]
      otomatik temizliğin listesi: ready (silinecek), upcoming (karar saatini bekleyen), kept (korunan); hiçbir şey silmez.
  python3 scripts/ig_cleanup.py --run --names a.mp4,b.mp4 --max 1000
      yalnız verilen videoları siler; silmeden hemen önce Instagram'dan güncel izlenmeyi tekrar okur, bu arada `max`'ı
      geçen video silinmez. Yalnız Instagram gönderisi silinir (YouTube, TikTok ve Mac'teki kopya kalır); metriklerden
      Instagram kaydı düşer. Her silme `data/ig_cleanup_log.json`a yazılır ve stdout'a "🗑 …" satırı olarak basılır.
"""
import json
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import DATA, episode_meta, load_json, metrics, now_iso, save_json, save_metrics  # noqa: E402

LOG = DATA / "ig_cleanup_log.json"


def _age_h(ts: str) -> float | None:
    try:
        return (datetime.now(timezone.utc) - datetime.fromisoformat(str(ts).replace("Z", "+00:00"))).total_seconds() / 3600
    except Exception:
        return None


def title_of(name: str) -> str:
    meta = episode_meta(name) or {}
    first = next((s.get("title") for s in meta.get("segments") or [] if s.get("kind") == "haber"), "")
    return meta.get("publishTitle") or first or name


def plan(days: float, max_views: int, min_age_h: float = 0) -> dict:
    out, unknown = [], []
    for name, v in metrics()["videos"].items():
        ig = v.get("instagram") or {}
        if not ig.get("id"):
            continue
        age = _age_h(ig.get("publishedAt", ""))
        if age is None or age > days * 24 or age < min_age_h:
            continue
        if ig.get("views") is None:
            unknown.append(name)
            continue
        if int(ig["views"]) < max_views:
            out.append({"name": name, "title": title_of(name)[:90], "views": int(ig["views"]), "ageH": round(age, 1), "url": ig.get("url")})
    out.sort(key=lambda x: x["views"])
    return {"ok": True, "items": out, "unknown": unknown, "days": days, "max": max_views, "minAgeH": min_age_h}


def auto_plan(max_views: int, wait_h: float, max_age_d: float, keep: list) -> dict:
    """Otomatik temizlik (kullanıcı isteği, 17 Ekim: "5000 altında izlenen videoları otomatik silelim, sayıları panelde göreyim,
    değiştireyim, silinmeye adayları da göreyim"): yalnız Instagram. ready = `wait_h` saati geçmiş ve izlenmesi `max_views` altında
    (silinecek), upcoming = henüz `wait_h` dolmamış ama şu an altında (karar saati gelince yeniden bakılır), kept = korumaya alınanlar.
    `max_age_d` günden eski gönderilere bakılmaz; izlenmesi ölçülmemiş gönderi silinmez."""
    ready, upcoming, kept, unknown = [], [], [], []
    keep = set(keep or [])
    for name, v in metrics()["videos"].items():
        ig = v.get("instagram") or {}
        if not ig.get("id"):
            continue
        age = _age_h(ig.get("publishedAt", ""))
        if age is None or age > max_age_d * 24:
            continue
        if ig.get("views") is None:
            unknown.append(name)
            continue
        views = int(ig["views"])
        item = {"name": name, "title": title_of(name)[:90], "views": views, "ageH": round(age, 1), "url": ig.get("url")}
        if name in keep:
            kept.append(item)
        elif views < max_views:
            (ready if age >= wait_h else upcoming).append({**item, **({} if age >= wait_h else {"hoursLeft": round(wait_h - age, 1)})})
    ready.sort(key=lambda x: x["views"])
    upcoming.sort(key=lambda x: x.get("hoursLeft", 0))
    return {"ok": True, "ready": ready, "upcoming": upcoming, "kept": kept, "unknown": unknown,
            "max": max_views, "waitHours": wait_h, "maxAgeDays": max_age_d}


def fresh_views(ig: dict) -> int | None:
    """Silmeden hemen önce güncel izlenme (Instagram içgörüsü)."""
    from publish import ig_call, ig_creds
    creds = ig_creds()
    for metrics_list in ("views", "plays"):
        try:
            data = ig_call("GET", f"{ig['id']}/insights", {"metric": metrics_list}, creds).get("data", [])
            return int((data[0].get("values") or [{}])[0].get("value", 0)) if data else None
        except Exception:
            continue
    return None


def run(names: list, max_views: int) -> dict:
    from publish import ig_delete
    done, kept, failed = [], [], []
    log = load_json(LOG, []) or []
    for name in names:
        m = metrics()
        ig = (m["videos"].get(name) or {}).get("instagram") or {}
        if not ig.get("id"):
            kept.append({"name": name, "why": "Instagram'da kaydı yok"})
            continue
        views = fresh_views(ig)
        if views is None:
            views = ig.get("views")
        if views is not None and int(views) >= max_views:
            kept.append({"name": name, "why": f"izlenmesi {views} oldu, silinmedi"})
            print(f"🗑 Instagram: SİLİNMEDİ {name} — izlenmesi {views} ({max_views} sınırını geçti)", flush=True)
            continue
        title = title_of(name)[:80]
        r = ig_delete(ig)
        rec = {"at": now_iso(), "video": name, "title": title, "views": views, "url": ig.get("url"), "ok": r.get("ok"), "message": r.get("message")}
        log.append(rec)
        if r.get("ok"):
            m = metrics()
            m["videos"].get(name, {}).pop("instagram", None)
            save_metrics(m)
            done.append(rec)
            print(f"🗑 Instagram: silindi {name} — \"{title}\" ({views} izlenme)", flush=True)
        else:
            failed.append(rec)
            print(f"🗑 Instagram: SİLİNEMEDİ {name} — {r.get('message')}{' · ' + ig.get('url') if ig.get('url') else ''}", flush=True)
        time.sleep(1)
    save_json(LOG, log[-500:])
    return {"ok": True, "deleted": done, "kept": kept, "failed": failed}


if __name__ == "__main__":
    a = sys.argv

    def arg(k, d):
        return a[a.index(k) + 1] if k in a and len(a) > a.index(k) + 1 else d
    try:
        if "--auto-plan" in a:
            res = auto_plan(int(arg("--max", 5000)), float(arg("--wait-hours", 72)), float(arg("--max-age-days", 30)),
                            [x for x in arg("--keep", "").split(",") if x])
        elif "--run" in a:
            res = run([x for x in arg("--names", "").split(",") if x], int(arg("--max", 1000)))
        else:
            res = plan(float(arg("--days", 7)), int(arg("--max", 1000)), float(arg("--min-age-hours", 0)))
    except Exception as e:
        res = {"ok": False, "error": str(e)[:300]}
    print(json.dumps(res, ensure_ascii=False))
