#!/usr/bin/env python3
"""Yayınlanmış videoların izlenme/beğeni/yorum verisini çeker, data/metrics.json'u günceller.

Kademeli takip (kullanıcı kararı: haberlerimiz günlük; 3 gün sonra haberin değeri kalmaz): `settings.metricsSync`
{freshHours 72, dailyUntilDays 7}. Yayından ilk 72 saat her senkronda (panel `metricsSyncMinutes`, varsayılan 20 dk),
72 saat-7 gün arası günde bir (haftalık rapor toplamları için), 7 günden eski video artık sorgulanmaz (son değer kalır).
72 saati geçince ilk ölçüm `views72h` olarak saklanır: analizler (kategori, saat, başlık varyantı, en iyi videolar) videoyu
bu "3. gün" değeriyle karşılaştırır, eski haberin sonradan gelen izlenmesi kararları çarpıtmaz.
"""
import json
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import load_env, merge_fresh_publish, metrics, now_iso, save_metrics, settings  # noqa: E402

CFG = {"freshHours": 72, "dailyUntilDays": 7, **(settings().get("metricsSync") or {})}


def _age_hours(ts: str) -> float | None:
    try:
        return (datetime.now(timezone.utc) - datetime.fromisoformat(str(ts).replace("Z", "+00:00"))).total_seconds() / 3600
    except Exception:
        return None


def due(rec: dict) -> bool:
    """Bu platform kaydı bu senkronda sorgulansın mı (yaşa göre)."""
    age = _age_hours(rec.get("publishedAt", ""))
    if age is None or age <= float(CFG["freshHours"]):
        return True
    if "views72h" not in rec and age <= float(CFG["freshHours"]) + 24:
        return True  # 72. saati yeni geçti: "3. gün" değeri hemen ölçülsün
    if age > float(CFG["dailyUntilDays"]) * 24:
        return False
    last = _age_hours(rec.get("lastSync", ""))
    return last is None or last >= 20


def snapshot(rec: dict) -> None:
    """72 saati geçen videonun o anki izlenmesi bir kez saklanır (haberin "değer penceresi")."""
    age = _age_hours(rec.get("publishedAt", ""))
    if age is not None and age > float(CFG["freshHours"]) and "views72h" not in rec and rec.get("views") is not None:
        rec["views72h"] = rec["views"]


def sync_youtube(m):
    ids = {name: v["youtube"]["id"] for name, v in m["videos"].items() if v.get("youtube", {}).get("id") and due(v["youtube"])}
    if not ids:
        return 0
    from publish import yt_service
    yt = yt_service()
    id_list = list(ids.values())
    stats = {}
    for i in range(0, len(id_list), 50):
        r = yt.videos().list(part="statistics", id=",".join(id_list[i:i + 50])).execute()
        for it in r.get("items", []):
            stats[it["id"]] = it["statistics"]
    for name, vid in ids.items():
        s = stats.get(vid)
        if s:
            m["videos"][name]["youtube"].update({
                "views": int(s.get("viewCount", 0)), "likes": int(s.get("likeCount", 0)),
                "comments": int(s.get("commentCount", 0)), "lastSync": now_iso()})
            snapshot(m["videos"][name]["youtube"])
    return len(stats)


def sync_instagram(m):
    from publish import ig_call, ig_creds
    try:
        creds = ig_creds()
    except RuntimeError:
        return 0
    n = 0
    for name, v in m["videos"].items():
        mid = v.get("instagram", {}).get("id")
        if not mid or not due(v["instagram"]):
            continue
        data = None
        for metrics_list in ("views,reach,likes,comments,shares,saved", "plays,reach,likes,comments,shares,saved"):
            try:
                data = ig_call("GET", f"{mid}/insights", {"metric": metrics_list}, creds).get("data", [])
                break
            except Exception as e:
                err = e
        if data is None:
            print(f"  ! instagram {name}: {err}", file=sys.stderr)
            continue
        vals = {d["name"]: (d.get("values") or [{}])[0].get("value", 0) for d in data}
        v["instagram"].update({"views": vals.get("views", vals.get("plays", 0)), "reach": vals.get("reach", 0), "likes": vals.get("likes", 0),
                               "comments": vals.get("comments", 0), "shares": vals.get("shares", 0), "saves": vals.get("saved", 0), "lastSync": now_iso()})
        snapshot(v["instagram"])
        n += 1
    return n


def sync_tiktok(m):
    ours = {name: v["tiktok"] for name, v in m["videos"].items() if v.get("tiktok", {}).get("publish_id") and due(v["tiktok"])}
    if not ours:
        return 0
    from publish import TT_API, tt_access_token, tt_http
    H = {"Authorization": f"Bearer {tt_access_token()}"}
    fields = "id,title,create_time,view_count,like_count,comment_count,share_count,share_url"
    videos, cursor = [], None
    for _ in range(5):  # son ~100 video
        body = {"max_count": 20, **({"cursor": cursor} if cursor else {})}
        r = tt_http("POST", f"{TT_API}/video/list/?fields={fields}", body, H).get("data", {})
        videos += r.get("videos", [])
        if not r.get("has_more"):
            break
        cursor = r.get("cursor")
    by_id = {v["id"]: v for v in videos}
    by_title = {v.get("title", ""): v for v in videos}
    n = 0
    for name, t in ours.items():
        v = by_id.get(t.get("id")) or by_title.get(t.get("title", ""))
        if not v:
            continue
        t.update({"id": v["id"], "url": v.get("share_url") or t.get("url"), "views": v.get("view_count", 0), "likes": v.get("like_count", 0),
                  "comments": v.get("comment_count", 0), "shares": v.get("share_count", 0), "lastSync": now_iso()})
        snapshot(t)
        n += 1
    return n


def main():
    m = metrics()
    out = {"youtube": 0, "instagram": 0, "tiktok": 0, "errors": []}
    for plat, fn in (("youtube", sync_youtube), ("instagram", sync_instagram), ("tiktok", sync_tiktok)):
        try:
            out[plat] = fn(m)
        except Exception as e:
            out["errors"].append(f"{plat}: {e}")
    m["lastSync"] = now_iso()
    save_metrics(merge_fresh_publish(m))  # bu arada yayınlanan videoların kayıtları (publish.py) ezilmesin
    try:  # abone/takipçi anlık sayıları (data/followers.json)
        from followers import sync as followers_sync
        f = followers_sync()
        out["followers"] = {p: v["current"] for p, v in f["platforms"].items()}
        out["errors"] += [f"{p} abone: {e}" for p, e in f.get("errors", {}).items()]
    except Exception as e:
        out["errors"].append(f"abone: {e}")
    print(json.dumps(out, ensure_ascii=False))


if __name__ == "__main__":
    main()
