#!/usr/bin/env python3
"""Fragman takibi (kullanıcı isteği, 24 Ekim: "yayınlanan YouTube kanallarının fragmanlarını panele gireyim, kanalları tarasın, en son
yayınladığı fragmanı kaydetsin, yeni fragman düşerse anında fragmandan sahneler koyarak, çarpıcı yerlerinin orijinallerini de koyarak
kancalı bir yapıyla yayınlasın").

  python3 scripts/trailer_watch.py --scan     settings.trailerWatch.channels kanallarını tarar (YouTube RSS: kanal başına tek istek),
                                              data/trailer_watch.json yazar; son satır JSON {ok, channels, new: [...], errors}
  python3 scripts/trailer_watch.py --status   kayıtlı durum (kanallar, son fragmanlar, hatalar)
  python3 scripts/trailer_watch.py --resolve X  tek kanalı çöz (deneme)

Kanal girdisi: "@NetflixTurkiye", "NetflixTurkiye", "https://www.youtube.com/@NetflixTurkiye[/videos]", ".../channel/UC…", ".../c/Ad",
".../user/Ad" ya da "UC…" kimliği. Kimlik kanal sayfasından ("externalId"/"channelId"/canonical) okunur, olmazsa yt-dlp ile; bir kez çözülüp
saklanır. Videolar YouTube'un kanal RSS akışından (https://www.youtube.com/feeds/videos.xml?channel_id=UC…; son 15 video, yayın saati,
başlık, açıklama) okunur; fragman mı kararı `social_video.is_trailer` (başlıkta fragman/trailer/teaser, römork ve soru başlıkları hariç;
`onlyTrailers: false` ise kanalın her yeni videosu). İLK taramada kanalın en son fragmanı yalnız KAYDEDİLİR (üretilmez); sonraki taramalarda
ondan yeni, `maxAgeHours` saatten genç ve daha önce görülmemiş fragmanlar `new` listesine girer (eskiden yeniye); kanalın son fragmanı
güncellenir, görülenler 14 gün saklanır. Üretim ve yayın kararı panelde (server.js trailerWatchScan → socialVideoNews fragman yolu).
"""
import json
import re
import subprocess
import sys
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import DATA, load_json, now_iso, save_json, settings  # noqa: E402

STATE = DATA / "trailer_watch.json"
DEFAULTS = {"enabled": True, "intervalMin": 10, "channels": [], "maxAgeHours": 24, "maxPerDay": 4, "autoPublish": True, "notify": False,
            "onlyTrailers": True, "soundSeconds": 10}
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36"
NS = {"a": "http://www.w3.org/2005/Atom", "yt": "http://www.youtube.com/xml/schemas/2015", "media": "http://search.yahoo.com/mrss/"}


def cfg() -> dict:
    raw = settings().get("trailerWatch")
    s = raw if isinstance(raw, dict) else {}
    out = {**DEFAULTS, **s}
    out["channels"] = [str(x).strip() for x in (out.get("channels") or []) if str(x).strip()] if isinstance(out.get("channels"), list) else []
    for k in ("intervalMin", "maxAgeHours", "maxPerDay", "soundSeconds"):
        try:
            v = float(out.get(k))
            out[k] = v if (v > 0 or (k == "soundSeconds" and v == 0)) else DEFAULTS[k]
        except (TypeError, ValueError):
            out[k] = DEFAULTS[k]
    return out


def http(url: str, timeout: float = 20) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept-Language": "tr-TR,tr;q=0.9,en;q=0.6"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode("utf-8", "replace")


def channel_key(inp: str) -> str:
    """Kanal girdisinin sade anahtarı: @handle → "@handle" (küçük harf), UC… → kimlik, adres → yol parçası."""
    t = str(inp or "").strip()
    if re.fullmatch(r"UC[\w-]{20,}", t):
        return t
    m = re.search(r"youtube\.com/(?:channel/(UC[\w-]{20,})|@([^/?#\s]+)|(?:c|user)/([^/?#\s]+))", t, re.I)
    if m:
        return m.group(1) or ("@" + m.group(2).lower() if m.group(2) else "c/" + m.group(3))
    return "@" + t.lstrip("@").lower()


def channel_url(inp: str) -> str:
    t = str(inp or "").strip()
    if t.startswith("http"):
        return t.split("?")[0].rstrip("/")
    if re.fullmatch(r"UC[\w-]{20,}", t):
        return f"https://www.youtube.com/channel/{t}"
    return f"https://www.youtube.com/@{t.lstrip('@')}"


def resolve(inp: str) -> dict:
    """{channelId, name} ya da {error}. Önce kanal sayfası (externalId / channelId / canonical), olmazsa yt-dlp."""
    t = str(inp or "").strip()
    m = re.search(r"(UC[\w-]{20,})", t)
    if m and (t.startswith("UC") or "/channel/" in t):
        cid, name = m.group(1), ""
        try:
            html = http(f"https://www.youtube.com/channel/{cid}")
            mt = re.search(r'<meta property="og:title" content="([^"]*)"', html)
            name = (mt.group(1) if mt else "").strip()
        except Exception:
            pass
        return {"channelId": cid, "name": name or cid}
    url = channel_url(t)
    try:
        html = http(url)
        mid = re.search(r'"externalId":"(UC[\w-]{20,})"', html) or re.search(r'"channelId":"(UC[\w-]{20,})"', html) \
            or re.search(r'<link rel="canonical" href="https://www\.youtube\.com/channel/(UC[\w-]{20,})"', html)
        if mid:
            mt = re.search(r'<meta property="og:title" content="([^"]*)"', html)
            return {"channelId": mid.group(1), "name": (mt.group(1) if mt else "").strip() or t.lstrip("@")}
    except Exception as e:
        err = str(e)[:120]
    else:
        err = "kanal kimliği sayfada bulunamadı"
    try:  # yedek: yt-dlp (video indirmeden kanal bilgisi)
        import social_video as sv
        cmd = sv.ytdlp()
        if cmd:
            r = subprocess.run([*cmd, "--skip-download", "--playlist-items", "0", "-J", "--no-warnings", url], capture_output=True, text=True, timeout=60)
            if r.returncode == 0 and r.stdout.strip():
                j = json.loads(r.stdout)
                cid = j.get("channel_id") or j.get("uploader_id") or j.get("id")
                if isinstance(cid, str) and cid.startswith("UC"):
                    return {"channelId": cid, "name": str(j.get("channel") or j.get("uploader") or j.get("title") or t.lstrip("@"))}
            err = (r.stderr or err).strip().splitlines()[-1][:120] if r.stderr else err
    except Exception as e:
        err = str(e)[:120]
    return {"error": f"kanal çözülemedi ({err}); adresi https://www.youtube.com/@kanal biçiminde yazın"}


def feed(cid: str) -> list:
    """Kanalın RSS akışı: [{videoId, title, published (ISO), ts, url, description, author}] yeniden eskiye."""
    xml = http(f"https://www.youtube.com/feeds/videos.xml?channel_id={cid}")
    root = ET.fromstring(xml)
    out = []
    for e in root.findall("a:entry", NS):
        vid = (e.findtext("yt:videoId", default="", namespaces=NS) or "").strip()
        if not vid:
            continue
        pub = (e.findtext("a:published", default="", namespaces=NS) or "").strip()
        try:
            ts = datetime.fromisoformat(pub.replace("Z", "+00:00")).timestamp()
        except ValueError:
            ts = 0.0
        g = e.find("media:group", NS)
        desc = (g.findtext("media:description", default="", namespaces=NS) if g is not None else "") or ""
        out.append({"videoId": vid, "title": (e.findtext("a:title", default="", namespaces=NS) or "").strip(), "published": pub, "ts": ts,
                    "url": f"https://www.youtube.com/watch?v={vid}", "description": desc.strip()[:300],
                    "author": (e.findtext("a:author/a:name", default="", namespaces=NS) or "").strip()})
    out.sort(key=lambda x: x["ts"], reverse=True)
    return out


def is_trailer(title: str, desc: str) -> bool:
    try:
        import social_video as sv
        return bool(sv.is_trailer(title, desc))
    except Exception:
        return bool(re.search(r"fragman|trailer|teaser", title or "", re.I))


def scan(now: float | None = None) -> dict:
    now = now or time.time()
    c = cfg()
    st = load_json(STATE, {}) or {}
    chans = st.get("channels") if isinstance(st.get("channels"), dict) else {}
    seen = st.get("seen") if isinstance(st.get("seen"), dict) else {}
    seen = {k: v for k, v in seen.items() if isinstance(v, (int, float)) and now - v < 14 * 86400}
    new, errors = [], []
    keys = []
    for inp in c["channels"]:
        key = channel_key(inp)
        if key in keys:
            continue
        keys.append(key)
        ch = dict(chans.get(key) or {})
        ch["input"] = inp
        if not ch.get("channelId"):
            r = resolve(inp)
            if r.get("error"):
                ch["error"] = r["error"]
                errors.append(f"{inp}: {r['error']}")
                chans[key] = ch
                continue
            ch.update({"channelId": r["channelId"], "name": r.get("name") or inp})
        try:
            items = feed(ch["channelId"])
            ch.pop("error", None)
        except Exception as e:
            ch["error"] = f"akış okunamadı ({str(e)[:100]})"
            errors.append(f"{ch.get('name') or inp}: {ch['error']}")
            ch["lastChecked"] = now_iso()
            chans[key] = ch
            continue
        if not ch.get("name") and items:
            ch["name"] = items[0].get("author") or inp
        trailers = [x for x in items if (not c["onlyTrailers"]) or is_trailer(x["title"], x["description"])]
        ch["videos"] = len(items)
        ch["trailers"] = len(trailers)
        ch["lastChecked"] = now_iso()
        if not trailers:
            chans[key] = ch
            continue
        latest = trailers[0]
        if not ch.get("lastVideoId"):  # ilk tarama: son fragman kaydedilir, üretilmez
            ch.update({"lastVideoId": latest["videoId"], "lastTitle": latest["title"], "lastPublished": latest["published"], "lastTs": latest["ts"],
                       "lastUrl": latest["url"], "first": True})
            seen.setdefault(latest["videoId"], now)
            chans[key] = ch
            continue
        ch.pop("first", None)
        last_ts = float(ch.get("lastTs") or 0)
        fresh = [x for x in reversed(trailers) if x["ts"] > last_ts and x["videoId"] not in seen and now - x["ts"] <= c["maxAgeHours"] * 3600
                 and x["videoId"] != ch.get("lastVideoId")]
        for x in fresh:
            new.append({"key": key, "channel": ch.get("name") or inp, "channelId": ch["channelId"], **{k: x[k] for k in ("videoId", "title", "published", "url", "description")}})
            seen[x["videoId"]] = now
        if trailers[0]["ts"] > last_ts:
            ch.update({"lastVideoId": latest["videoId"], "lastTitle": latest["title"], "lastPublished": latest["published"], "lastTs": latest["ts"], "lastUrl": latest["url"]})
        chans[key] = ch
    chans = {k: v for k, v in chans.items() if k in keys}  # listeden çıkarılan kanal unutulur
    st = {"channels": chans, "seen": seen, "lastScan": now_iso(), "lastNew": [x["videoId"] for x in new] or st.get("lastNew") or []}
    save_json(STATE, st)
    return {"ok": True, "channels": chans, "new": new, "errors": errors, "lastScan": st["lastScan"]}


if __name__ == "__main__":
    a = sys.argv
    try:
        if "--resolve" in a:
            res = {"ok": True, **resolve(a[a.index("--resolve") + 1])}
        elif "--status" in a:
            st = load_json(STATE, {}) or {}
            res = {"ok": True, "channels": st.get("channels") or {}, "lastScan": st.get("lastScan"), "cfg": cfg()}
        else:
            res = scan()
    except Exception as e:
        res = {"ok": False, "error": str(e)[:300]}
    print(json.dumps(res, ensure_ascii=False))
