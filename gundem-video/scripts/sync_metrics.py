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


def main():
    m = metrics()
    out = {"youtube": 0, "instagram": 0, "errors": []}
    for plat, fn in (("youtube", sync_youtube), ("instagram", sync_instagram)):
        try:
            out[plat] = fn(m)
        except Exception as e:
            out["errors"].append(f"{plat}: {e}")
    m["lastSync"] = now_iso()
    save_metrics(m)
    print(json.dumps(out, ensure_ascii=False))


if __name__ == "__main__":
    main()
