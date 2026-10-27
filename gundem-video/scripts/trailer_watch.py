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
DEFAULTS = {"enabled": True, "intervalMin": 120, "channels": [], "maxAgeHours": 24, "maxPerDay": 0, "autoPublish": True, "notify": False,
            "onlyTrailers": True, "soundSeconds": 10, "firstFreshHours": 12, "pageScan": True, "staleDays": 10,
            "paused": [], "autoEnd": True}  # paused: duraklatılan kanallar (sezon arası; kart kalır, taranmaz); autoEnd: sezon finali gelince "dizi bitti"
ENDED_CHECK_SEC = 24 * 3600  # dizi bitti sayılan kanal günde bir "yeni sezon" için okunur
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36"
NS = {"a": "http://www.w3.org/2005/Atom", "yt": "http://www.youtube.com/xml/schemas/2015", "media": "http://search.yahoo.com/mrss/"}


def cfg() -> dict:
    raw = settings().get("trailerWatch")
    s = raw if isinstance(raw, dict) else {}
    out = {**DEFAULTS, **s}
    out["channels"] = [str(x).strip() for x in (out.get("channels") or []) if str(x).strip()] if isinstance(out.get("channels"), list) else []
    out["paused"] = [str(x).strip() for x in (out.get("paused") or []) if str(x).strip()] if isinstance(out.get("paused"), list) else []
    for k in ("intervalMin", "maxAgeHours", "maxPerDay", "soundSeconds", "firstFreshHours"):
        try:
            v = float(out.get(k))
            out[k] = v if (v > 0 or (k in ("soundSeconds", "maxPerDay", "firstFreshHours") and v == 0)) else DEFAULTS[k]
        except (TypeError, ValueError):
            out[k] = DEFAULTS[k]
    out["pageScan"] = out.get("pageScan") is not False
    out["autoEnd"] = out.get("autoEnd") is not False
    return out


def _promo_keys(p: dict) -> dict:
    return {k: p.get(k) for k in ("label", "text", "tur", "no", "bolum", "sezon", "yeniSezon", "final", "film")} if p else None


def is_new_season(p: dict) -> bool:
    """Yeni sezon fragmanı: "Yeni Sezon" sözü ya da bölümsüz/1. bölümlü sezon tanıtımı (final değil)."""
    p = p or {}
    if p.get("final"):
        return False
    return bool(p.get("yeniSezon") or (p.get("sezon") and (p.get("bolum") in (None, 0, 1))))


def single_series(trailers: list, pinfo: dict) -> bool:
    """Kanal tek dizili mi: akıştaki fragmanların dizi adları (film_name) tek ise. Show TV gibi çok dizili kanalda bir dizinin finali kanalı kapatmaz."""
    films = {((pinfo.get(x["videoId"]) or {}).get("film") or "").casefold().strip() for x in trailers}
    films.discard("")
    return len(films) <= 1


def reopen(key: str) -> dict:
    """"Dizi bitti" durumunu elle kaldır (panel "▶ Yeniden aç", --reopen KEY); sonraki taramada normal okunur."""
    st = load_json(STATE, {}) or {}
    chans = st.get("channels") if isinstance(st.get("channels"), dict) else {}
    ch = chans.get(channel_key(key)) or chans.get(key)
    if not ch:
        return {"ok": False, "error": "kanal kayıtlı değil"}
    was = bool(ch.pop("ended", None)); ch.pop("endedCheckedAt", None); ch.pop("endedCheckedTs", None); ch.pop("finalNote", None)
    save_json(STATE, st)
    return {"ok": True, "reopened": was, "key": channel_key(key)}


_REL = re.compile(r"(\d+)\s*(saniye|dakika|saat|gün|hafta|ay|yıl|second|minute|hour|day|week|month|year)", re.I)
_REL_SEC = {"saniye": 1, "second": 1, "dakika": 60, "minute": 60, "saat": 3600, "hour": 3600, "gün": 86400, "day": 86400, "hafta": 604800, "week": 604800,
            "ay": 2592000, "month": 2592000, "yıl": 31536000, "year": 31536000}


def rel_seconds(text: str):
    """"3 saat önce" / "3 hours ago" / "Streamed 2 days ago" → saniye; okunamazsa None."""
    m = _REL.search(str(text or ""))
    if not m:
        return None
    return int(m.group(1)) * _REL_SEC[m.group(2).lower()]


def page_videos(cid: str, now: float | None = None) -> list:
    """Kanalın videolar sayfasından (ytInitialData) son videolar: RSS gecikince ya da okunamayınca yedek (kullanıcı isteği, 26 Ekim: "asla
    kaçırmayalım"). Yayın zamanı yaklaşıktır ("3 saat önce" → şimdi − 3 saat; approx: True). Hata: boş liste."""
    now = now or time.time()
    try:
        html = http(f"https://www.youtube.com/channel/{cid}/videos", timeout=25)
    except Exception:
        return []
    out, seen = [], set()
    for chunk in html.split('"videoRenderer":')[1:]:
        chunk = chunk[:6000]
        mid = re.match(r'\{"videoId":"([\w-]{11})"', chunk)
        if not mid or mid.group(1) in seen:
            continue
        mt = re.search(r'"title":\{"runs":\[\{"text":"((?:[^"\\]|\\.)*)"', chunk)
        mp = re.search(r'"publishedTimeText":\{"simpleText":"([^"]*)"', chunk)
        if not mt:
            continue
        title = json.loads('"' + mt.group(1) + '"') if "\\" in mt.group(1) else mt.group(1)
        secs = rel_seconds(mp.group(1)) if mp else None
        seen.add(mid.group(1))
        out.append({"videoId": mid.group(1), "title": title.strip(), "published": "", "ts": (now - secs) if secs is not None else 0.0, "url": f"https://www.youtube.com/watch?v={mid.group(1)}",
                    "description": "", "author": "", "approx": True, "ago": (mp.group(1) if mp else "")})
    return out


def fetch_items(ch: dict, c: dict, now: float) -> tuple:
    """Kanalın videoları: RSS (kesin zaman) + videolar sayfası (yedek; RSS'te olmayanlar eklenir, zaman yaklaşık). (liste, hata) — ikisi de
    okunamazsa hata."""
    items, err = [], ""
    try:
        items = feed(ch["channelId"])
    except Exception as e:
        err = f"akış okunamadı ({str(e)[:100]})"
    if c.get("pageScan", True):
        have = {x["videoId"] for x in items}
        extra = [x for x in page_videos(ch["channelId"], now) if x["videoId"] not in have and x["ts"]]
        if extra:
            items = sorted(items + extra, key=lambda x: x["ts"], reverse=True)
            err = ""
    if not items and err:
        return [], err
    return items, ""


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
        return bool(re.search(r"fragman|trailer|teaser|tan[ıi]t[ıi]m|[öo]n\s*g[öo]sterim", title or "", re.I))


def promo(title: str, desc: str, author: str = "") -> dict:
    """Tanıtım türü + dizi adı ve bölüm (social_video.promo_info / film_name): {label, text, tur, no, bolum, film}; ayrıştırılamazsa {}."""
    try:
        import social_video as sv
        p = dict(sv.promo_info(title, desc) or {})
        film, _ = sv.film_name(title, author)
        p["film"] = film
        return p
    except Exception:
        return {}


def scan(now: float | None = None) -> dict:
    now = now or time.time()
    c = cfg()
    st = load_json(STATE, {}) or {}
    chans = st.get("channels") if isinstance(st.get("channels"), dict) else {}
    seen = st.get("seen") if isinstance(st.get("seen"), dict) else {}
    seen = {k: v for k, v in seen.items() if isinstance(v, (int, float)) and now - v < 14 * 86400}
    new, errors, ended, reopened = [], [], [], []
    keys = []
    paused_keys = {channel_key(x) for x in c["paused"]}  # kullanıcı isteği, 27 Ekim: "sezon arası" — kart kalır, taranmaz, tek tıkla geri açılır
    for inp in c["channels"]:
        key = channel_key(inp)
        if key in keys:
            continue
        keys.append(key)
        ch = dict(chans.get(key) or {})
        ch["input"] = inp
        ch.setdefault("addedAt", now_iso())  # kanalın eklenme anı (hiç fragman gelmeyen kanalda "N gündür fragman yok" uyarısı buna göre)
        if key in paused_keys:
            ch["paused"] = True
            chans[key] = ch
            continue
        ch.pop("paused", None)
        # dizi bitti (kullanıcı isteği, 27 Ekim: "sezon finali gelince kanal kendiliğinden dizi bitti durumuna düşsün, taranmasın; yeni sezon
        # fragmanı gelince yeniden açılsın"): günde bir okunur, yalnız yeni sezon fragmanı kanalı açar ve üretilir; diğer videolar kaydedilir
        if ch.get("ended"):
            if now - float(ch.get("endedCheckedTs") or 0) < ENDED_CHECK_SEC:
                chans[key] = ch
                continue
            ch["endedCheckedAt"] = now_iso(); ch["endedCheckedTs"] = now
        if not ch.get("channelId"):
            r = resolve(inp)
            if r.get("error"):
                ch["error"] = r["error"]
                errors.append(f"{inp}: {r['error']}")
                chans[key] = ch
                continue
            ch.update({"channelId": r["channelId"], "name": r.get("name") or inp})
        items, err = fetch_items(ch, c, now)
        if err:
            ch["error"] = err
            errors.append(f"{ch.get('name') or inp}: {ch['error']}")
            ch["lastChecked"] = now_iso()
            chans[key] = ch
            continue
        ch.pop("error", None)
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
        if ch.get("ended"):  # dizi bitti: yalnız yeni sezon fragmanı kanalı açar (ve üretilir); diğer yeni videolar kaydedilir, üretilmez
            last_ts = float(ch.get("lastTs") or 0)
            cand = [x for x in reversed(trailers) if x["ts"] > last_ts and x["videoId"] not in seen and x["videoId"] != ch.get("lastVideoId")]
            pinfo = {x["videoId"]: promo(x["title"], x.get("description", ""), x.get("author") or ch.get("name") or "") for x in trailers} if cand else {}
            opener = [x for x in cand if is_new_season(pinfo.get(x["videoId"]) or {})]
            if not opener:
                for x in cand:
                    seen[x["videoId"]] = now
                chans[key] = ch
                continue
            ch.pop("ended", None); ch.pop("endedCheckedAt", None); ch.pop("endedCheckedTs", None); ch.pop("finalNote", None)
            reopened.append({"key": key, "channel": ch.get("name") or inp, "title": opener[-1]["title"]})
            for x in cand:  # yeni sezon fragmanından önceki (sezon arası) videolar üretilmez
                if x["ts"] < opener[0]["ts"]:
                    seen[x["videoId"]] = now
        if not ch.get("lastVideoId"):  # ilk tarama: son fragman kaydedilir; son firstFreshHours saatin fragmanları üretilir (kanal eklenince taze fragman kaçmasın)
            ch.update({"lastVideoId": latest["videoId"], "lastTitle": latest["title"], "lastPublished": latest["published"], "lastTs": latest["ts"],
                       "lastUrl": latest["url"], "first": True})
            fresh0 = [x for x in reversed(trailers) if x["ts"] and now - x["ts"] <= float(c.get("firstFreshHours") or 0) * 3600 and x["videoId"] not in seen]
            for x in trailers:
                if x["videoId"] not in {y["videoId"] for y in fresh0}:
                    seen.setdefault(x["videoId"], now)
            pinfo = {x["videoId"]: promo(x["title"], x.get("description", ""), x.get("author") or ch.get("name") or "") for x in trailers} if (fresh0 or c["autoEnd"]) else {}
            for x in fresh0:
                p = pinfo.get(x["videoId"]) or {}
                new.append({"key": key, "channel": ch.get("name") or inp, "channelId": ch["channelId"], **{k: x[k] for k in ("videoId", "title", "published", "url", "description")},
                            "promo": _promo_keys(p), "previous": [], "first": True})
                seen[x["videoId"]] = now
            lp = pinfo.get(latest["videoId"]) or {}
            if c["autoEnd"] and lp.get("final"):  # kanalın son fragmanı final: tek dizili kanalda dizi bitti, çok dizili kanalda not
                _mark_final(ch, latest, lp, single_series(trailers, pinfo), ended, key, inp, now)
            chans[key] = ch
            continue
        ch.pop("first", None)
        last_ts = float(ch.get("lastTs") or 0)
        fresh = [x for x in reversed(trailers) if x["ts"] > last_ts and x["videoId"] not in seen and now - x["ts"] <= c["maxAgeHours"] * 3600
                 and x["videoId"] != ch.get("lastVideoId")]
        pinfo = {x["videoId"]: promo(x["title"], x.get("description", ""), x.get("author") or ch.get("name") or "") for x in trailers} if fresh else {}
        finals = [x for x in fresh if (pinfo.get(x["videoId"]) or {}).get("final")]
        if c["autoEnd"] and finals:
            _mark_final(ch, finals[-1], pinfo.get(finals[-1]["videoId"]) or {}, single_series(trailers, pinfo), ended, key, inp, now)
        for x in fresh:
            p = pinfo.get(x["videoId"]) or {}
            # aynı dizinin aynı bölümünün daha önce yayınlanan tanıtımları (akıştaki eski videolar; kanalın son 15 videosu): kurguda "ilk
            # fragmandan sonra ikinci fragman da geldi" bağı için (içerikleri bilinmez, yalnız başlık ve tarih)
            prev = [{"videoId": y["videoId"], "title": y["title"], "published": y["published"], "label": (pinfo.get(y["videoId"]) or {}).get("label")}
                    for y in sorted(trailers, key=lambda z: z["ts"]) if y["ts"] < x["ts"] and p.get("bolum") and (pinfo.get(y["videoId"]) or {}).get("bolum") == p["bolum"]
                    and ((pinfo.get(y["videoId"]) or {}).get("film") or "").casefold() == (p.get("film") or "").casefold()][-6:]
            new.append({"key": key, "channel": ch.get("name") or inp, "channelId": ch["channelId"], **{k: x[k] for k in ("videoId", "title", "published", "url", "description")},
                        "promo": _promo_keys(p), "previous": prev})
            seen[x["videoId"]] = now
        if trailers[0]["ts"] > last_ts:
            ch.update({"lastVideoId": latest["videoId"], "lastTitle": latest["title"], "lastPublished": latest["published"], "lastTs": latest["ts"], "lastUrl": latest["url"]})
        chans[key] = ch
    chans = {k: v for k, v in chans.items() if k in keys}  # listeden çıkarılan kanal unutulur
    st = {"channels": chans, "seen": seen, "lastScan": now_iso(), "lastNew": [x["videoId"] for x in new] or st.get("lastNew") or []}
    save_json(STATE, st)
    return {"ok": True, "channels": chans, "new": new, "errors": errors, "ended": ended, "reopened": reopened, "lastScan": st["lastScan"]}


def _mark_final(ch: dict, x: dict, p: dict, single: bool, ended: list, key: str, inp: str, now: float | None = None) -> None:
    """Sezon finali fragmanı: tek dizili kanalda "dizi bitti" (günde bir yeni sezon için bakılır), çok dizili kanalda yalnız not (tarama sürer)."""
    rec = {"at": now_iso(), "title": x["title"], "videoId": x["videoId"], "film": p.get("film") or "", "published": x.get("published")}
    if single:
        ch["ended"] = rec; ch["endedCheckedAt"] = now_iso(); ch["endedCheckedTs"] = now or time.time(); ch.pop("finalNote", None)
        ended.append({"key": key, "channel": ch.get("name") or inp, "title": x["title"], "film": rec["film"]})
    else:
        ch["finalNote"] = rec


if __name__ == "__main__":
    a = sys.argv
    try:
        if "--resolve" in a:
            res = {"ok": True, **resolve(a[a.index("--resolve") + 1])}
        elif "--reopen" in a:
            res = reopen(a[a.index("--reopen") + 1])
        elif "--status" in a:
            st = load_json(STATE, {}) or {}
            res = {"ok": True, "channels": st.get("channels") or {}, "lastScan": st.get("lastScan"), "cfg": cfg()}
        else:
            res = scan()
    except Exception as e:
        res = {"ok": False, "error": str(e)[:300]}
    print(json.dumps(res, ensure_ascii=False))
