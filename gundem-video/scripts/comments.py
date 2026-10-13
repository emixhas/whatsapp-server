#!/usr/bin/env python3
"""Yorum toplama (günlük yorum özeti için): son 7 günde yayınlanan videoların YENİ yorumları. YouTube
commentThreads (mevcut izinle), Instagram /{media}/comments (instagram_business_manage_comments ya da Facebook
girişinde instagram_manage_comments izni; eski bağlantıda "yeniden bağla" gerekir). TikTok yorum API'si sunmaz.
Görülen yorumlar data/comments_state.json'da (30 gün); özeti panel Claude ile yazar ve WhatsApp'a gönderir.
Bu betik yanıt vermez; anında otomatik yanıt ayrı: scripts/comment_reply.py (kullanıcı kararı, 14 Ekim).

  python3 scripts/comments.py         # son satır JSON {comments: [...], errors: {...}}
  python3 scripts/comments.py --all   # görülenleri de getir (deneme)
"""
import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import DATA, episode_meta, load_json, metrics, now_iso, save_json  # noqa: E402

FILE = DATA / "comments_state.json"


def _recent(days=7):
    lim = datetime.now(timezone.utc) - timedelta(days=days)
    for name, v in (metrics().get("videos") or {}).items():
        for p in ("youtube", "instagram"):
            x = v.get(p) or {}
            try:
                ok = x.get("id") and datetime.fromisoformat(x.get("publishedAt", "")).astimezone(timezone.utc) > lim
            except ValueError:
                ok = False
            if ok:
                yield name, p, x


def main(show_all=False):
    seen = load_json(FILE, {}) or {}
    out, errors = [], {}
    yt = None
    for name, plat, x in _recent():
        meta = episode_meta(name) or {}
        title = meta.get("publishTitle") or next((s.get("title") for s in meta.get("segments", []) if s.get("kind") == "haber"), name)
        try:
            if plat == "youtube":
                if yt is None:
                    from publish import yt_service
                    yt = yt_service()
                r = yt.commentThreads().list(part="snippet", videoId=x["id"], maxResults=50, order="time", textFormat="plainText").execute()
                rows = [(it["id"], it["snippet"]["topLevelComment"]["snippet"]) for it in r.get("items", [])]
                rows = [(cid, {"author": s.get("authorDisplayName"), "text": s.get("textDisplay"), "at": s.get("publishedAt"), "likes": s.get("likeCount", 0)}) for cid, s in rows]
            else:
                from publish import ig_call, ig_creds
                d = ig_call("GET", f"{x['id']}/comments", {"fields": "id,text,username,timestamp,like_count", "limit": 50}, ig_creds())
                rows = [(c["id"], {"author": c.get("username"), "text": c.get("text"), "at": c.get("timestamp"), "likes": c.get("like_count", 0)}) for c in d.get("data", [])]
        except Exception as e:
            msg = str(e)
            if plat == "instagram" and ("permission" in msg.lower() or "(#10)" in msg or "(#200)" in msg):
                msg = "Instagram yorumlarını okumak için izin yok: Ayarlar → Instagram'ı yeniden bağlayın (yorum izni eklendi)"
            elif plat == "youtube" and "commentsDisabled" in msg:
                continue
            errors[plat] = msg[:200]
            continue
        for cid, c in rows:
            if not c.get("text") or (cid in seen and not show_all):
                continue
            seen[cid] = now_iso()
            out.append({"platform": plat, "video": name, "title": title, **c})
    lim = (datetime.now(timezone.utc) - timedelta(days=30)).isoformat()
    save_json(FILE, {k: v for k, v in seen.items() if v >= lim})
    out.sort(key=lambda c: c.get("at") or "")
    print(json.dumps({"comments": out[-200:], "errors": errors}, ensure_ascii=False))


if __name__ == "__main__":
    main("--all" in sys.argv)
