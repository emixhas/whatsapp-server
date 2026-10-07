#!/usr/bin/env python3
"""Yayınlanmış videoların izlenme/beğeni/yorum verisini çeker, data/metrics.json'u günceller."""
import json
import sys
import urllib.parse
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import load_env, metrics, now_iso, save_metrics  # noqa: E402


def sync_youtube(m):
    ids = {name: v["youtube"]["id"] for name, v in m["videos"].items() if v.get("youtube", {}).get("id")}
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
    return len(stats)


def sync_instagram(m):
    env = load_env()
    if not env.get("IG_ACCESS_TOKEN"):
        return 0
    n = 0
    for name, v in m["videos"].items():
        mid = v.get("instagram", {}).get("id")
        if not mid:
            continue
        q = urllib.parse.urlencode({"metric": "plays,reach,likes,comments,shares,saved", "access_token": env["IG_ACCESS_TOKEN"]})
        try:
            with urllib.request.urlopen(f"https://graph.facebook.com/v21.0/{mid}/insights?{q}", timeout=30) as r:
                data = json.loads(r.read()).get("data", [])
        except Exception as e:
            print(f"  ! instagram {name}: {e}", file=sys.stderr)
            continue
        vals = {d["name"]: (d.get("values") or [{}])[0].get("value", 0) for d in data}
        v["instagram"].update({"views": vals.get("plays", 0), "reach": vals.get("reach", 0), "likes": vals.get("likes", 0),
                               "comments": vals.get("comments", 0), "shares": vals.get("shares", 0), "saves": vals.get("saved", 0), "lastSync": now_iso()})
        n += 1
    return n


def sync_tiktok(m):
    ours = {name: v["tiktok"] for name, v in m["videos"].items() if v.get("tiktok", {}).get("publish_id")}
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
    save_metrics(m)
    print(json.dumps(out, ensure_ascii=False))


if __name__ == "__main__":
    main()
