#!/usr/bin/env python3
"""Abone/takipçi takibi: YouTube abone, Instagram ve TikTok takipçi sayısı. Her senkronda (sync_metrics.py, saatte bir)
anlık sayı data/followers.json'a yazılır (saatte en çok bir kayıt, 400 gün); bugün / bu hafta (7 gün) / 30 günde
kazanılan bu kayıtların farkından hesaplanır, günlük kazanım serisi son 14 gün için çıkar.

Notlar: YouTube abone sayısını 1000'in üstünde yuvarlar (ör. 12.345 → 12.300), küçük günlük değişimler görünmeyebilir.
TikTok sayısı "user.info.stats" izni ister: eski bağlantıda yoksa yeniden bağlanmalı (hata mesajı bunu söyler).

  python3 scripts/followers.py --sync   # sayıları çek, kaydet, özeti yaz
  python3 scripts/followers.py          # yalnızca kayıtlı veriden özet
"""
import json
import sys
from datetime import datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import DATA, load_json, now_iso, save_json  # noqa: E402

FILE = DATA / "followers.json"   # {"snapshots": [{"at": iso, "youtube": n, "instagram": n, "tiktok": n}], "errors": {...}}
PLATS = ("youtube", "instagram", "tiktok")


def fetch_youtube() -> dict:
    from publish import yt_service
    r = yt_service().channels().list(part="statistics,snippet", mine=True).execute()
    it = (r.get("items") or [{}])[0]
    st = it.get("statistics", {})
    if st.get("hiddenSubscriberCount"):
        raise RuntimeError("kanalda abone sayısı gizli (YouTube Studio → Ayarlar → Kanal → abone sayısını göster)")
    return {"count": int(st.get("subscriberCount", 0)), "views": int(st.get("viewCount", 0)), "videos": int(st.get("videoCount", 0)),
            "name": it.get("snippet", {}).get("title")}


def fetch_instagram() -> dict:
    from publish import ig_call, ig_creds
    creds = ig_creds()
    d = ig_call("GET", creds[0], {"fields": "followers_count,media_count,username"}, creds)
    return {"count": int(d.get("followers_count", 0)), "videos": int(d.get("media_count", 0)), "name": d.get("username")}


def fetch_tiktok() -> dict:
    from publish import TT_API, tt_access_token, tt_http
    H = {"Authorization": f"Bearer {tt_access_token()}"}
    try:
        r = tt_http("GET", f"{TT_API}/user/info/?fields=follower_count,likes_count,video_count,display_name", None, H)
    except RuntimeError as e:
        if "scope" in str(e).lower():
            raise RuntimeError("TikTok takipçi sayısı için izin yok; Ayarlar → Yayın hesapları → TikTok'u yeniden bağlayın") from e
        raise
    err = (r.get("error") or {})
    if err.get("code") not in (None, "", "ok"):
        if "scope" in str(err).lower():
            raise RuntimeError("TikTok takipçi sayısı için izin yok; Ayarlar → Yayın hesapları → TikTok'u yeniden bağlayın")
        raise RuntimeError(err.get("message") or str(err))
    u = (r.get("data") or {}).get("user", {})
    return {"count": int(u.get("follower_count", 0)), "likes": int(u.get("likes_count", 0)), "videos": int(u.get("video_count", 0)),
            "name": u.get("display_name")}


def connected() -> dict:
    try:
        from publish import status
        st = status()
        return {p: bool((st.get(p) or {}).get("connected")) for p in PLATS}
    except Exception:
        return {p: False for p in PLATS}


def sync() -> dict:
    data = load_json(FILE, {"snapshots": []})
    conn = connected()
    snap, info, errors = {"at": now_iso()}, data.get("info", {}), {}
    for p, fn in (("youtube", fetch_youtube), ("instagram", fetch_instagram), ("tiktok", fetch_tiktok)):
        if not conn.get(p):
            continue
        try:
            r = fn()
            snap[p] = r["count"]
            info[p] = {k: v for k, v in r.items() if k != "count"}
        except Exception as e:
            errors[p] = str(e)[:200]
    snaps = data.get("snapshots", [])
    if any(p in snap for p in PLATS):
        # saatte bir kayıt yeter: aynı saatteki son kaydın üzerine yazılır
        if snaps and snaps[-1]["at"][:13] == snap["at"][:13]:
            snaps[-1] = {**snaps[-1], **snap}
        else:
            snaps.append(snap)
    cutoff = (datetime.now().astimezone() - timedelta(days=400)).isoformat()
    data.update({"snapshots": [s for s in snaps if s["at"] >= cutoff], "info": info, "errors": errors, "lastSync": now_iso()})
    save_json(FILE, data)
    return summary(data)


def _local(ts: str) -> datetime:
    return datetime.fromisoformat(ts).astimezone()


def _value_at(snaps: list, p: str, before: datetime):
    """`before` anından önceki son kayıt (yoksa None)."""
    v = None
    for s in snaps:
        if p in s and _local(s["at"]) <= before:
            v = s[p]
    return v


def summary(data=None) -> dict:
    data = data or load_json(FILE, {"snapshots": []})
    snaps = sorted(data.get("snapshots", []), key=lambda s: s["at"])
    now = datetime.now().astimezone()
    midnight = now.replace(hour=0, minute=0, second=0, microsecond=0)
    out = {"platforms": {}, "info": data.get("info", {}), "errors": data.get("errors", {}), "lastSync": data.get("lastSync")}
    for p in PLATS:
        have = [s for s in snaps if p in s]
        if not have:
            continue
        cur, first = have[-1][p], have[0]
        since = _local(first["at"])

        def gain(start: datetime):
            base = _value_at(have, p, start)
            return (cur - base, False) if base is not None else (cur - first[p], True)  # True: kayıt bu dönemden yeni

        today, tp = gain(midnight)
        week, wp = gain(now - timedelta(days=7))
        month, mp = gain(now - timedelta(days=30))
        # son 14 günün günlük kazanımı (gün sonu değerleri farkı)
        daily = []
        for k in range(13, -1, -1):
            d0 = midnight - timedelta(days=k)
            d1 = d0 + timedelta(days=1)
            inday = [s for s in have if d0 <= _local(s["at"]) < d1]
            if not inday:  # o gün hiç kayıt yok (takip başlamadı ya da Mac kapalıydı)
                daily.append({"date": d0.date().isoformat(), "gain": None})
                continue
            start = _value_at(have, p, d0 - timedelta(seconds=1))
            partial = start is None  # gün başında kayıt yok: takibin başladığı gün, ilk kayda göre
            if partial:
                start = inday[0][p]
            daily.append({"date": d0.date().isoformat(), "gain": inday[-1][p] - start, "partial": partial})
        out["platforms"][p] = {"current": cur, "today": today, "week": week, "month": month,
                               "partial": {"today": tp, "week": wp, "month": mp}, "since": since.isoformat(), "daily": daily}
    ps = out["platforms"].values()
    out["total"] = {k: sum(v[k] for v in ps) for k in ("current", "today", "week", "month")} if out["platforms"] else None
    return out


def spoken(s: dict) -> str:
    """Emixhas'ın sesli/WhatsApp yanıtı."""
    if not s.get("platforms"):
        return "Henüz abone verisi yok. Yayın hesapları bağlıysa izlenmeler güncellenince gelir."
    name = {"youtube": "YouTube'da", "instagram": "Instagram'da", "tiktok": "TikTok'ta"}
    unit = {"youtube": "abone", "instagram": "takipçi", "tiktok": "takipçi"}
    fmt = lambda n: f"{n:,}".replace(",", ".")  # noqa: E731
    sign = lambda n: f"artı {fmt(n)}" if n > 0 else f"eksi {fmt(-n)}" if n < 0 else "değişiklik yok"  # noqa: E731
    parts = [f"{name[p]} {fmt(v['current'])} {unit[p]}, bugün {sign(v['today'])}, bu hafta {sign(v['week'])}" for p, v in s["platforms"].items()]
    t = s["total"]
    return "; ".join(parts) + f". Toplam {fmt(t['current'])} kişi, bu hafta {sign(t['week'])}."


if __name__ == "__main__":
    s = sync() if "--sync" in sys.argv else summary()
    s["text"] = spoken(s)
    print(json.dumps(s, ensure_ascii=False))
