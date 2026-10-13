#!/usr/bin/env python3
"""Yorumlara anında otomatik yanıt (kullanıcı kararı: "gelen yorumu yakalayıp anında mantıklı bir cevap versin").

Panel `settings.autoReply.intervalMin` (5) dakikada bir:
  python3 scripts/comment_reply.py --fetch          # yanıtlanmamış yeni yorumlar + her birinin video özeti (JSON)
  python3 scripts/comment_reply.py --post FILE      # FILE: [{id, platform, reply}] → yanıtları yayınlar (reply boşsa atlar)
Yanıt metnini panel Claude ile yazar (`prompts/yanit.md`, toplu tek çağrı, düşük effort).

- YouTube: kanalın tüm yorumları tek istekle (`commentThreads.list allThreadsRelatedToChannelId`, 1 kota birimi); yanıt
  `comments.insert` (50 birim, `youtube.force-ssl` izni). Günlük yükleme kotası korunsun diye `maxPerDay.youtube` (20).
- Instagram: son `recentHours` (72) saatte yüklenen en çok 10 gönderinin yorumları; yanıt `/{comment}/replies`
  (instagram_business_manage_comments). `maxPerDay.instagram` (60).
- TikTok API yorum okuma/yazma sunmaz.
Kanalın kendi yorumları, zaten yanıt verdiğimiz yorumlar ve `maxAgeHours` (48) saatten eskiler alınmaz. Her yorum bir kez
değerlendirilir (`data/reply_state.json`); yanıtlar `data/reply_log.json`. `settings.autoReply` {enabled, intervalMin,
maxAgeHours, recentHours, maxPerDay {youtube, instagram}}.
"""
import json
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import DATA, episode_meta, load_json, metrics, now_iso, save_json, settings  # noqa: E402

STATE = DATA / "reply_state.json"
LOG = DATA / "reply_log.json"


def cfg() -> dict:
    c = {"enabled": True, "intervalMin": 5, "maxAgeHours": 48, "recentHours": 72, **(settings().get("autoReply") or {})}
    c["maxPerDay"] = {"youtube": 20, "instagram": 60, **(c.get("maxPerDay") or {})}
    return c


def _age_h(ts: str) -> float:
    try:
        return (datetime.now(timezone.utc) - datetime.fromisoformat(str(ts).replace("Z", "+00:00"))).total_seconds() / 3600
    except Exception:
        return 1e9


def video_context(name: str) -> tuple:
    meta = episode_meta(name) or {}
    segs = [s for s in meta.get("segments") or [] if s.get("kind") in ("hook", "haber")]
    title = meta.get("publishTitle") or next((s.get("title") for s in segs if s.get("kind") == "haber"), name)
    ctx = " ".join(s.get("narration", "") for s in segs)[:700]
    return title, ctx


def state() -> dict:
    st = load_json(STATE, {}) or {}
    st.setdefault("seen", {})
    today = time.strftime("%Y-%m-%d")
    if st.get("day") != today:
        st["day"], st["count"] = today, {"youtube": 0, "instagram": 0}
    st["seen"] = {k: v for k, v in st["seen"].items() if time.time() - float(v) < 10 * 86400}
    return st


def _yt_ready() -> str | None:
    """YouTube yorumlarına yanıt için hata metni ya da None (bağlı ve youtube.force-ssl izni var)."""
    from publish import SECRETS, YT_COMMENT, yt_scopes
    if not (SECRETS / "youtube_token.json").exists():
        return "bağlı değil"
    if YT_COMMENT not in yt_scopes():
        return "yorum izni yok: Ayarlar → YouTube → 🔄 Yeniden bağla (tüm izinleri onaylayın)"
    return None


def _later(ts: str, than: str) -> bool:
    return _age_h(ts) < _age_h(than)


def fetch() -> dict:
    c = cfg()
    st = state()
    m = metrics()["videos"]
    by_yt = {v["youtube"]["id"]: n for n, v in m.items() if (v.get("youtube") or {}).get("id")}
    out, errors = [], {}

    def add(cid, plat, parent, video, text, our_q=None, vid=None):
        title, ctx = video_context(video) if video else ("", "")
        out.append({"id": cid, "platform": plat, "parent": parent, "video": video or vid, "title": title, "context": ctx,
                    "text": (text or "")[:500], **({"ourComment": our_q[:300]} if our_q else {})})

    # YouTube: kanalın tüm yorumları tek istekte (kanalın kendi yüklediği, metrikte olmayan videolar dahil)
    yt_err = _yt_ready()
    if yt_err and yt_err != "bağlı değil":
        errors["youtube"] = yt_err
    if not yt_err and st["count"]["youtube"] < c["maxPerDay"]["youtube"]:
        try:
            from publish import yt_service
            yt = yt_service()
            if not st.get("channelId"):
                st["channelId"] = yt.channels().list(part="id", mine=True).execute()["items"][0]["id"]
            me = st["channelId"]
            r = yt.commentThreads().list(part="snippet,replies", allThreadsRelatedToChannelId=me, order="time", maxResults=50,
                                         textFormat="plainText").execute()
            for it in r.get("items", []):
                sn = it["snippet"]
                top = sn["topLevelComment"]["snippet"]
                tid, vid = it["id"], sn.get("videoId")
                if not sn.get("canReply", True):
                    continue
                reps = (it.get("replies") or {}).get("comments", [])
                mine = [x["snippet"] for x in reps if (x["snippet"].get("authorChannelId") or {}).get("value") == me]
                if (top.get("authorChannelId") or {}).get("value") == me:
                    # kendi yorumumuz (ilk yorum sorusu): altına cevap yazan izleyicilere, biz o cevaptan sonra yazmadıysak
                    for x in reps:
                        rs = x["snippet"]
                        if x["id"] in st["seen"] or (rs.get("authorChannelId") or {}).get("value") == me or _age_h(rs.get("publishedAt")) > c["maxAgeHours"]:
                            continue
                        if any(_later(y.get("publishedAt"), rs.get("publishedAt")) for y in mine):
                            continue
                        add(x["id"], "youtube", tid, by_yt.get(vid), rs.get("textDisplay"), our_q=top.get("textDisplay"), vid=vid)
                    continue
                if tid in st["seen"] or mine or _age_h(top.get("publishedAt")) > c["maxAgeHours"]:
                    continue
                add(tid, "youtube", tid, by_yt.get(vid), top.get("textDisplay"), vid=vid)
        except Exception as e:
            msg = str(e)
            errors["youtube"] = "yorum izni yok: Ayarlar → YouTube → 🔄 Yeniden bağla" if "insufficient" in msg.lower() else msg[:200]
    # Instagram: son gönderilerin yorumları (ve ilk yorumumuzun altına yazılan cevaplar)
    if st["count"]["instagram"] < c["maxPerDay"]["instagram"]:
        recent = sorted(((v["instagram"].get("publishedAt", ""), n, v["instagram"]) for n, v in m.items()
                         if (v.get("instagram") or {}).get("id") and _age_h(v["instagram"].get("publishedAt", "")) <= c["recentHours"]), reverse=True)[:10]
        if recent:
            try:
                from publish import ig_call, ig_creds
                creds = ig_creds()
                if not st.get("igUsername"):
                    st["igUsername"] = ig_call("GET", creds[0], {"fields": "username"}, creds).get("username", "")
                me = st["igUsername"]
                for _, name, ig in recent:
                    d = ig_call("GET", f"{ig['id']}/comments", {"fields": "id,text,username,timestamp,replies{id,text,username,timestamp}", "limit": 50}, creds)
                    for cm in d.get("data", []):
                        reps = (cm.get("replies") or {}).get("data", [])
                        mine = [r for r in reps if r.get("username") == me]
                        if cm.get("username") == me:
                            for r in reps:
                                if r["id"] in st["seen"] or r.get("username") == me or _age_h(r.get("timestamp")) > c["maxAgeHours"]:
                                    continue
                                if any(_later(y.get("timestamp"), r.get("timestamp")) for y in mine):
                                    continue
                                add(r["id"], "instagram", cm["id"], name, r.get("text"), our_q=cm.get("text"))
                            continue
                        if cm["id"] in st["seen"] or mine or _age_h(cm.get("timestamp")) > c["maxAgeHours"]:
                            continue
                        add(cm["id"], "instagram", cm["id"], name, cm.get("text"))
            except Exception as e:
                msg = str(e)
                errors["instagram"] = "yorum izni yok: Instagram'ı yeniden bağlayın" if ("permission" in msg.lower() or "(#10)" in msg or "(#200)" in msg) else msg[:200]
    save_json(STATE, st)
    pending = {x["id"] for x in st.get("retry", {}).values()}
    return {"ok": True, "comments": [x for x in out if x["id"] not in pending][:15], "errors": errors, "retry": len(st.get("retry") or {})}


def post(items: list) -> dict:
    """Yanıtları yayınlar. Yayınlanamayan yanıt (izin, ağ, kota) metniyle saklanır ve sonraki turlarda en çok 3 kez denenir."""
    c = cfg()
    st = state()
    st.setdefault("retry", {})
    log = load_json(LOG, []) or []
    done, skipped, failed = [], 0, []
    yt = creds = None
    try:
        import censor
        mask = censor.mask
    except Exception:
        mask = lambda t: t  # noqa: E731
    queue = list(items) + [x for k, x in st["retry"].items() if k not in {i.get("id") for i in items}]
    for it in queue:
        cid, plat, reply = it.get("id"), it.get("platform"), str(it.get("reply") or "").strip()
        if not cid or plat not in ("youtube", "instagram"):
            continue
        st["seen"][cid] = time.time()
        if not reply:
            skipped += 1
            continue
        if st["count"][plat] >= c["maxPerDay"][plat]:
            st["retry"][cid] = {**it, "tries": it.get("tries", 0)}  # sınır doldu: yarın yayınlansın
            continue
        reply = mask(reply)[:300]
        parent = it.get("parent") or cid
        try:
            if plat == "youtube":
                if yt is None:
                    from publish import yt_service
                    yt = yt_service()
                yt.comments().insert(part="snippet", body={"snippet": {"parentId": parent, "textOriginal": reply}}).execute()
            else:
                if creds is None:
                    from publish import ig_creds
                    creds = ig_creds()
                from publish import ig_call
                ig_call("POST", f"{parent}/replies", {"message": reply}, creds)
            st["count"][plat] += 1
            st["retry"].pop(cid, None)
            rec = {"at": now_iso(), "platform": plat, "comment": str(it.get("text", ""))[:200], "reply": reply, "video": it.get("video")}
            log.append(rec)
            done.append(rec)
            print(f"💬 yanıt ({plat}): \"{rec['comment'][:60]}\" → \"{reply[:90]}\"", flush=True)
        except Exception as e:
            tries = int(it.get("tries", 0)) + 1
            if tries < 3:
                st["retry"][cid] = {**it, "reply": reply, "tries": tries}
            else:
                st["retry"].pop(cid, None)
            failed.append({"id": cid, "platform": plat, "error": str(e)[:160]})
            print(f"💬 yanıt yazılamadı ({plat}{', yeniden denenecek' if tries < 3 else ', bırakıldı'}): {str(e)[:120]}", flush=True)
    save_json(STATE, st)
    save_json(LOG, log[-1000:])
    return {"ok": True, "replied": len(done), "skipped": skipped, "failed": failed, "count": st["count"], "retry": len(st["retry"])}


if __name__ == "__main__":
    try:
        if "--post" in sys.argv:
            res = post(json.loads(Path(sys.argv[sys.argv.index("--post") + 1]).read_text(encoding="utf-8")))
        else:
            res = fetch()
    except Exception as e:
        res = {"ok": False, "error": str(e)[:300]}
    print(json.dumps(res, ensure_ascii=False))
