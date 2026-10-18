#!/usr/bin/env python3
"""Instagram trend radarı: haber/viral hesaplarının son videolarından hesabın kendi normalinin çok üstünde izlenenleri ya da hızla
yükselenleri bulur (kullanıcı isteği, 18 Ekim: "bazen çok izlenen videolar oluyor, trend; onlara nasıl bir yol izleyebiliriz";
kullanıcı kararı: YALNIZ panelde gösterilir — WhatsApp mesajı yok, otomatik üretim yok —, kaynak Instagram trendleri).

Kullanım:
  python3 scripts/ig_trends.py --scan    hesapları (+ resmi API varsa hashtag'leri) tarar, data/ig_trends.json yazar
  python3 scripts/ig_trends.py --list    son tarama sonucu (data/ig_trends.json)
Son satır her zaman tek satır JSON'dur; tamamen başarısız taramada {ok:false, error} (Türkçe), çıkış kodu yine 0.

Yöntem sırası:
  1. resmi API: Instagram Facebook Girişi ile bağlıysa (secrets/instagram_token.json `via: facebook` ya da .env IG_USER_ID +
     IG_ACCESS_TOKEN; publish.ig_creds ile aynı kural) graph.facebook.com Business Discovery her hesap için (yalnız işletme/içerik
     üreticisi hesaplarını görür) + hashtag araması top_media (Meta uygulamasında Instagram Public Content Access özelliği gerekir;
     7 günde en çok 30 FARKLI hashtag — sınır burada sayılır, hashtag kimlikleri önbellekte). Instagram Girişi (varsayılan,
     graph.instagram.com) bu iki uç noktayı sunmaz; o zaman doğrudan 2. yol.
  2. herkese açık profil (girişsiz): i.instagram.com/api/v1/users/web_profile_info/?username=… (x-ig-app-id + masaüstü tarayıcı
     User-Agent'ı). Resmi API'nin bulamadığı (kişisel) hesaplar da buradan denenir.
  3. çerezli: YALNIZ settings.igTrends.useCookies açıksa (varsayılan KAPALI: kanalın yayın yaptığı hesap kullanılır) aynı istek
     tarayıcı çerezleriyle (secrets/social_cookies.txt ya da settings.social.cookiesFromBrowser, yt-dlp ile okunur).
Nazik: hesaplar arası 2-4 sn rastgele bekleme, en çok 20 hesap, tarama en çok ~4 dk; 401/403/429/"Please wait"/challenge/giriş
sayfası gelince tarama durur ve o yöntem 6 saat duraklatılır (data/ig_trends_state.json `pause`).

Puan (yalnız video/reels, yaşı ≤ maxAgeHours): ölçü izlenme, yoksa beğeni (`metric` hangisi olduğunu yazar); hız = ölçü /
max(yaş saat, 0,5); hesabın normali = aynı hesabın diğer son videolarının (yaş sınırı yok) aynı ölçüdeki ortancası; kat = ölçü /
normal (karşılaştırılacak 3'ten az video varsa yok); trend = (kat ≥ minRatio ve (izlenme ≥ minViews ya da beğeni ≥ minLikes)) ya da
(aynı ölçüde en hızlı 3 video, aynı alt sınır ve yaşa göre düzeltilmiş kat — ölçü / √yaş, hesabın diğer videolarının
ortancasına bölünür — ≥ 1,5: `fast`; karşılaştırma yoksa — hashtag — bu bekçi aranmaz). Sıra: trend → kat → hız; en iyi 30
data/ig_trends.json'a:
{at, lastTry, method, accounts: {ad: {ok, error, followers, n, method}}, items: [{account, url, shortcode, caption, thumb, views,
likes, comments, metric, ageH, velocity, ratio, trend, fast, takenAt, source: "hesap"|"#etiket"}], errors, notes, pausedUntil,
pauseReason}. Tamamen başarısız taramada önceki liste ve `at` korunur, `error` yazılır.
Token ve çerez hiçbir çıktıya ve loga yazılmaz (Graph hata metninden de `access_token=` silinir).
"""
import http.cookiejar
import json
import math
import random
import re
import statistics
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import DATA, SECRETS, load_env, load_json, save_json, settings  # noqa: E402

OUT = DATA / "ig_trends.json"
STATE = DATA / "ig_trends_state.json"
IG_TOKEN_FILE = SECRETS / "instagram_token.json"
GRAPH = "https://graph.facebook.com/v21.0"   # publish.FB_API ile aynı sürüm
WEB_BASE = "https://i.instagram.com"
APP_ID = "936619743392459"                   # instagram.com web uygulamasının herkese açık uygulama kimliği
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36"
# server.js igTrendsCfg() ile aynı varsayılanlar. Hesap adları çevrimdışı doğrulanamadı: bulunamayan hesap panelde "bulunamadı" görünür
DEFAULTS = {"enabled": True, "intervalMin": 60,
            "accounts": ["cnnturk", "haberturk", "trthaber", "ntv", "ahaber", "anadoluajansi", "onedio", "gzt", "bpthaber", "tv100"],
            "hashtags": ["sondakika", "gundem"], "maxAgeHours": 48, "minRatio": 2, "minViews": 20000, "minLikes": 2000, "top": 15,
            "useCookies": False}
MAX_ACCOUNTS = 20
MAX_HASHTAGS = 10        # tarama başına
HASHTAG_CAP = 30         # Instagram: 7 günde en çok 30 farklı hashtag
WEEK = 7 * 86400
PAUSE_S = 6 * 3600       # engel gelince girişsiz/çerezli yol bu kadar dinlenir
RATE_PAUSE_S = 3600      # resmi API istek sınırında
DELAY = (2.0, 4.0)       # hesaplar arası rastgele bekleme (sn)
BUDGET = 240             # sn: bir taramanın yeni hesaba başlama sınırı (panel 6 dk sonra keser)
KEEP = 30
TOP_FAST = 3
FAST_ADJ = 1.5           # hız kuralında yaşa göre düzeltilmiş kat alt sınırı (karşılaştırma yoksa — hashtag — aranmaz)
TIMEOUT = 20
MAX_BYTES = 4_000_000
NAME = re.compile(r"^[a-z0-9._]{1,30}$")
RESERVED = {"p", "reel", "reels", "tv", "explore", "stories", "accounts", "direct"}
SC = re.compile(r"/(?:reel|reels|p|tv)/([A-Za-z0-9_-]{5,64})")
BLOCK_MSG = re.compile(r"please wait|wait a few minutes|try again later|checkpoint|challenge|login_required|require_login|"
                       r"feedback_required|rate.?limit|too many requests", re.I)
RATE_CODES = {4, 17, 32, 613, 80002}
BD_MEDIA = "id,caption,like_count,comments_count,media_type,media_product_type,permalink,timestamp,thumbnail_url,media_url"
BD_EXTRA = "view_count"   # izlenme alanı bazı API sürümlerinde yok: bilinmeyen alan hatasında bir hafta istenmez
HT_MEDIA = "id,caption,like_count,comments_count,media_type,permalink,timestamp"
METHOD_TR = {"resmi": "resmi API", "web": "herkese açık profil", "cerez": "çerezli"}


class Blocked(Exception):
    """401/403/429, "Please wait", challenge ya da giriş sayfası: tarama durur, yöntem 6 saat duraklar."""


class NotFound(Exception):
    pass


class GraphError(Exception):
    def __init__(self, msg, code=None, sub=None, status=None):
        super().__init__(msg)
        self.code, self.sub, self.status = code, sub, status


# ---------------- yardımcılar
def _int(v):
    if isinstance(v, bool) or v is None:
        return None
    try:
        n = int(float(v))
    except (TypeError, ValueError):
        return None
    return n if n >= 0 else None   # gizli beğeni sayısı -1 gelebilir


def _count(edge):
    return _int(edge.get("count")) if isinstance(edge, dict) else None


def _scrub(s) -> str:
    return re.sub(r"(access_token=)[^&\s\"']+", r"\1***", str(s))


def _cap(t) -> str:
    return re.sub(r"\s+", " ", str(t or "")).strip()[:300]


def _ts_iso(s):
    """Graph zaman damgası ("2026-10-18T09:12:44+0000") → epoch sn."""
    if not s:
        return None
    for f in ("%Y-%m-%dT%H:%M:%S%z", "%Y-%m-%dT%H:%M:%S.%f%z"):
        try:
            return int(datetime.strptime(str(s), f).timestamp())
        except ValueError:
            continue
    return None


def _sc_url(permalink, reel=False):
    m = SC.search(str(permalink or ""))
    if not m:
        return None, None
    sc = m.group(1)
    kind = "reel" if reel or re.search(r"/reels?/", str(permalink)) else "p"
    return sc, f"https://www.instagram.com/{kind}/{sc}/"


def _hm(ts) -> str:
    return time.strftime("%H:%M", time.localtime(ts))


def norm_account(x) -> str:
    s = str(x or "").strip()
    m = re.search(r"instagram\.com/([^/?#\s]+)", s, re.I)
    if m:
        s = m.group(1)
    return s.lstrip("@").strip().strip("/").lower()


def norm_tag(x) -> str:
    s = re.sub(r"\s+", "", str(x or "").strip().lstrip("#")).replace("İ", "i").replace("I", "ı").lower()
    return s if re.fullmatch(r"\w{1,100}", s) else ""


def _list(v):
    if isinstance(v, str):
        v = re.split(r"[\s,;]+", v)
    return [x for x in (v if isinstance(v, list) else []) if str(x or "").strip()]


def cfg() -> dict:
    raw = settings().get("igTrends")
    c = dict(DEFAULTS, **(raw if isinstance(raw, dict) else {}))

    def num(k, lo, hi):
        try:
            v = float(c.get(k))
        except (TypeError, ValueError):
            v = float(DEFAULTS[k])
        return min(hi, max(lo, v))
    c.update(maxAgeHours=num("maxAgeHours", 1, 168), minRatio=num("minRatio", 1, 100), minViews=num("minViews", 0, 1e10),
             minLikes=num("minLikes", 0, 1e10), accounts=_list(c.get("accounts")), hashtags=_list(c.get("hashtags")),
             useCookies=c.get("useCookies") is True or str(c.get("useCookies")).strip().lower() in ("true", "1"))
    return c


def load_state() -> dict:
    s = load_json(STATE, {})
    s = s if isinstance(s, dict) else {}
    for k in ("pause", "pauseWhy", "hashtagIds", "hashtagUses", "trendSeen"):
        if not isinstance(s.get(k), dict):
            s[k] = {}
    return s


def paused(state, method, now) -> bool:
    try:
        return float(state["pause"].get(method) or 0) > now
    except (TypeError, ValueError):
        return False


def pause(state, method, now, why, secs=PAUSE_S):
    state["pause"][method] = now + secs
    state["pauseWhy"][method] = why


def _http(url, headers, timeout=TIMEOUT):
    """(durum kodu, gövde). HTTP hatası istisna değil, kodla döner; bağlantı hatası istisnadır."""
    req = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read(MAX_BYTES)
    except urllib.error.HTTPError as e:
        try:
            body = e.read(MAX_BYTES)
        except Exception:
            body = b""
        return e.code, body


def _reason(e) -> str:
    r = getattr(e, "reason", None) or e
    return _scrub(str(r))[:120] or e.__class__.__name__


def _sleep():
    lo, hi = DELAY
    if hi > 0:
        time.sleep(random.uniform(lo, hi))


# ---------------- 1) resmi API (Facebook Girişi)
def official_creds():
    """(kimlik bilgisi, neden). Instagram Girişi'nde (graph.instagram.com) Business Discovery ve hashtag araması yoktur."""
    tok = load_json(IG_TOKEN_FILE, None)
    if isinstance(tok, dict) and tok.get("access_token"):
        if tok.get("via") != "facebook":
            return None, "Instagram, Instagram Girişi ile bağlı (resmi API başka hesapları ve hashtag'leri göstermiyor)"
        if not str(tok.get("user_id") or "").isdigit():
            return None, "Facebook Girişi bağlantısında Instagram hesap kimliği yok; panelden yeniden bağlayın"
        return {"uid": str(tok["user_id"]), "token": tok["access_token"]}, None
    env = load_env()
    if env.get("IG_USER_ID") and env.get("IG_ACCESS_TOKEN"):
        return {"uid": str(env["IG_USER_ID"]), "token": env["IG_ACCESS_TOKEN"]}, None
    return None, "Instagram bağlı değil"


def graph(cr, path, params):
    q = urllib.parse.urlencode({**params, "access_token": cr["token"]})
    try:
        st, body = _http(f"{GRAPH}/{path}?{q}", {"User-Agent": "TurkiyeGundemi/1.0", "Accept": "application/json"}, timeout=30)
    except Exception as e:
        raise GraphError(f"bağlantı hatası: {_reason(e)}")
    try:
        j = json.loads(body.decode("utf-8", "replace") or "{}")
    except ValueError:
        j = None
    if st == 200 and isinstance(j, dict) and "error" not in j:
        return j
    err = j.get("error") if isinstance(j, dict) else None
    err = err if isinstance(err, dict) else {}
    raise GraphError(_scrub(err.get("message") or f"HTTP {st}")[:240], _int(err.get("code")), _int(err.get("error_subcode")), st)


def g_kind(e: GraphError) -> str:
    msg = str(e).lower()
    if e.code in RATE_CODES or e.status == 429:
        return "rate"
    if e.code in (102, 190):
        return "token"
    if "nonexisting field" in msg or "nonexistent field" in msg or "tried accessing" in msg:
        return "field"
    if e.sub == 2207013 or e.code == 110 or any(k in msg for k in ("cannot be found", "cannot find", "not found", "does not exist", "invalid user")):
        return "notfound"
    if e.code == 10 or (e.code is not None and 200 <= e.code < 300):
        return "perm"
    return "other"


def _media(m, reel_hint=False):
    if not isinstance(m, dict):
        return None
    reel = m.get("media_product_type") == "REELS" or reel_hint
    sc, url = _sc_url(m.get("permalink"), reel=reel)
    if not sc:
        return None
    video = m.get("media_type") == "VIDEO" or m.get("media_product_type") == "REELS"
    views = None
    for k in ("view_count", "views", "video_view_count", "play_count"):
        v = _int(m.get(k))
        if v:   # 0 = API'nin artık doldurmadığı eski alan
            views = v
            break
    thumb = m.get("thumbnail_url") or (m.get("media_url") if m.get("media_type") == "IMAGE" else None)
    return {"shortcode": sc, "url": url, "video": video, "views": views, "likes": _int(m.get("like_count")),
            "comments": _int(m.get("comments_count")), "takenAt": _ts_iso(m.get("timestamp")), "caption": _cap(m.get("caption")),
            "thumb": thumb if isinstance(thumb, str) and thumb.startswith("https://") else None}


def _extra_ok(state, now) -> bool:
    x = state.get("bdExtra")
    return not (isinstance(x, dict) and x.get("ok") is False and now - float(x.get("at") or 0) < WEEK)


def bd_fetch(cr, acc, state, now):
    """Business Discovery: (takipçi, gönderiler). İzlenme alanı hoşgörüyle istenir: bilinmeyen alan hatası taramayı bozmaz."""
    for extra in ([True, False] if _extra_ok(state, now) else [False]):
        media = BD_MEDIA + ("," + BD_EXTRA if extra else "")
        fields = f"business_discovery.username({acc}){{followers_count,media_count,media.limit(25){{{media}}}}}"
        try:
            j = graph(cr, cr["uid"], {"fields": fields})
        except GraphError as e:
            if extra and g_kind(e) == "field":
                state["bdExtra"] = {"ok": False, "at": now}
                continue
            raise
        if extra:
            state["bdExtra"] = {"ok": True, "at": now}
        b = j.get("business_discovery")
        if not isinstance(b, dict):
            raise GraphError("cannot be found", code=110)
        posts = [p for p in (_media(m) for m in ((b.get("media") or {}).get("data") or [])) if p]
        return _int(b.get("followers_count")), posts
    raise GraphError("cannot be found", code=110)


def hashtag_ok(state, tag, now) -> bool:
    uses = state["hashtagUses"]
    for t, ts in list(uses.items()):
        try:
            if now - float(ts) > WEEK:
                del uses[t]
        except (TypeError, ValueError):
            del uses[t]
    return tag in uses or len(uses) < HASHTAG_CAP


def hashtag_posts(cr, tag, state, now):
    """Hashtag'in en iyi gönderileri. Kimlik önbellekte (her kullanım 7 günlük pencerede sayılır; denemeden ÖNCE yazılır)."""
    ids = state["hashtagIds"]
    hid = (ids.get(tag) or {}).get("id") if isinstance(ids.get(tag), dict) else None
    if not hid:
        state["hashtagUses"][tag] = now
        j = graph(cr, "ig_hashtag_search", {"user_id": cr["uid"], "q": tag})
        data = j.get("data") or []
        hid = str(data[0].get("id") or "") if data and isinstance(data[0], dict) else ""
        if not hid:
            raise GraphError("hashtag not found", code=110)
        ids[tag] = {"id": hid, "at": now}
    state["hashtagUses"][tag] = now
    j = graph(cr, f"{hid}/top_media", {"user_id": cr["uid"], "fields": HT_MEDIA, "limit": "50"})
    return [p for p in (_media(m) for m in (j.get("data") or [])) if p]


# ---------------- 2) / 3) herkese açık profil (girişsiz ya da çerezli)
def load_cookies():
    """({header, csrftoken}, hata). Çerez değerleri hiçbir yere yazılmaz."""
    jar, src = None, ""
    f = SECRETS / "social_cookies.txt"
    try:
        if f.exists():
            jar, src = http.cookiejar.MozillaCookieJar(str(f)), "secrets/social_cookies.txt"
            jar.load(ignore_discard=True, ignore_expires=True)
        else:
            b = str((settings().get("social") or {}).get("cookiesFromBrowser") or "").strip().lower()
            if not b:
                return None, "çerez kaynağı yok (Ayarlar → 📡 \"Sosyal medya çerezleri\" ya da secrets/social_cookies.txt)"
            src = f"{b} tarayıcısı"
            from yt_dlp.cookies import YDLLogger, extract_cookies_from_browser

            class Quiet(YDLLogger):
                def debug(self, *a, **k):
                    pass
                info = warning = error = debug
            jar = extract_cookies_from_browser(b, logger=Quiet())
    except Exception as e:
        return None, f"çerezler okunamadı ({src or 'tarayıcı'}): {str(e)[:120]}"
    pairs = {c.name: c.value for c in jar if str(c.domain or "").lstrip(".").endswith("instagram.com") and c.value}
    if "sessionid" not in pairs:
        return None, f"{src}: Instagram oturum çerezi yok (o tarayıcıda Instagram'a giriş yapın)"
    return {"header": "; ".join(f"{k}={v}" for k, v in pairs.items()), "csrftoken": pairs.get("csrftoken")}, None


def web_user(acc, cookies=None) -> dict:
    h = {"User-Agent": UA, "x-ig-app-id": APP_ID, "Accept": "*/*", "Accept-Language": "tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7",
         "Referer": f"https://www.instagram.com/{acc}/", "Origin": "https://www.instagram.com", "X-Requested-With": "XMLHttpRequest"}
    if cookies:
        h["Cookie"] = cookies["header"]
        if cookies.get("csrftoken"):
            h["X-CSRFToken"] = cookies["csrftoken"]
    st, body = _http(f"{WEB_BASE}/api/v1/users/web_profile_info/?" + urllib.parse.urlencode({"username": acc}), h)
    if st == 404:
        raise NotFound()
    if st in (401, 403, 429):
        raise Blocked(f"HTTP {st}")
    text = body.decode("utf-8", "replace")
    try:
        j = json.loads(text)
    except ValueError:
        if re.search(r"<html|<!doctype", text[:600], re.I):
            raise Blocked("giriş sayfası döndü")
        raise RuntimeError(f"beklenmeyen yanıt (HTTP {st})")
    if not isinstance(j, dict):
        raise RuntimeError(f"beklenmeyen yanıt (HTTP {st})")
    msg = str(j.get("message") or "")
    if j.get("require_login") or j.get("checkpoint_url") or j.get("spam") or BLOCK_MSG.search(msg):
        raise Blocked(msg[:120] or "giriş istendi")
    if re.search(r"not found|bulunamad", msg, re.I):
        raise NotFound()
    if st != 200:
        raise RuntimeError(f"HTTP {st}{': ' + msg[:120] if msg else ''}")
    u = j["data"].get("user") if isinstance(j.get("data"), dict) else None
    if not isinstance(u, dict):
        raise NotFound()
    return u


def parse_web(u):
    """(takipçi, gönderiler, gizli mi). Alanlar savunmacı okunur: eksik sayı None kalır."""
    posts, seen = [], set()
    for key in ("edge_felix_video_timeline", "edge_owner_to_timeline_media"):
        edges = (u.get(key) or {}).get("edges") if isinstance(u.get(key), dict) else None
        for e in edges if isinstance(edges, list) else []:
            n = e.get("node") if isinstance(e, dict) else None
            if not isinstance(n, dict):
                continue
            sc = str(n.get("shortcode") or "").strip()
            if not re.fullmatch(r"[A-Za-z0-9_-]{5,64}", sc) or sc in seen:
                continue
            seen.add(sc)
            pt = str(n.get("product_type") or "")
            vs = [x for x in (_int(n.get("video_play_count")), _int(n.get("video_view_count"))) if x is not None]
            likes = _count(n.get("edge_liked_by"))
            if likes is None:
                likes = _count(n.get("edge_media_preview_like"))
            comments = _count(n.get("edge_media_to_comment"))
            if comments is None:
                comments = _count(n.get("edge_media_preview_comment"))
            ce = (n.get("edge_media_to_caption") or {}).get("edges") if isinstance(n.get("edge_media_to_caption"), dict) else None
            cap = ce[0].get("node", {}).get("text") if isinstance(ce, list) and ce and isinstance(ce[0], dict) and isinstance(ce[0].get("node"), dict) else ""
            thumb = n.get("thumbnail_src") or n.get("display_url")
            posts.append({"shortcode": sc, "url": f"https://www.instagram.com/{'reel' if pt == 'clips' else 'p'}/{sc}/",
                          "video": bool(n.get("is_video")) or pt in ("clips", "igtv") or n.get("__typename") in ("GraphVideo", "XDTGraphVideo"),
                          "views": max(vs) if vs else None, "likes": likes, "comments": comments,
                          "takenAt": _int(n.get("taken_at_timestamp")), "caption": _cap(cap),
                          "thumb": thumb if isinstance(thumb, str) and thumb.startswith("https://") else None})
    return _count(u.get("edge_followed_by")), posts, bool(u.get("is_private"))


# ---------------- puan
def _agefix(now, p) -> float:
    return math.sqrt(max(1.0, (now - (p.get("takenAt") or now)) / 3600))


def score(groups, c, now):
    """groups: [(hesap ya da None, kaynak, gönderiler)] → sıralı öğeler."""
    out = []
    for acc, source, posts in groups:
        vids = [p for p in posts if p.get("video")]
        for p in vids:
            if not p.get("takenAt"):
                continue
            age = max(0.0, (now - p["takenAt"]) / 3600)
            if age > c["maxAgeHours"]:
                continue
            kind = "views" if p.get("views") is not None else "likes" if p.get("likes") is not None else None
            if not kind:
                continue
            val = p[kind]
            others = [q for q in vids if q is not p and q.get(kind) is not None] if acc else []
            med = statistics.median([q[kind] for q in others]) if len(others) >= 3 else 0
            ratio = round(val / med, 2) if med > 0 else None
            # hız kuralının bekçisi: yaşa göre düzeltilmiş kat (ölçü / √yaş; izlenme ilk saatlerde hızlı birikir). Düz "en hızlı 3"
            # büyük hesabın sıradan taze videosunu da trend sayıyordu (sahte veride kat 0,8); taze ama gerçekten hızlı video geçer
            adj_base = [q[kind] / _agefix(now, q) for q in others]
            adj_med = statistics.median(adj_base) if len(adj_base) >= 3 else 0
            adj = (val / _agefix(now, p)) / adj_med if adj_med > 0 else None
            floor = (p.get("views") or 0) >= c["minViews"] or (p.get("likes") or 0) >= c["minLikes"]
            out.append({"account": acc, "url": p["url"], "shortcode": p["shortcode"], "caption": p.get("caption") or "",
                        "thumb": p.get("thumb"), "views": p.get("views"), "likes": p.get("likes"), "comments": p.get("comments"),
                        "metric": kind, "ageH": round(age, 1), "velocity": round(val / max(age, 0.5), 1), "ratio": ratio,
                        "trend": bool(ratio is not None and ratio >= c["minRatio"] and floor), "fast": False, "_floor": floor, "_adj": adj,
                        "takenAt": int(p["takenAt"]) * 1000, "source": source})
    # aynı gönderi hem hesaptan hem hashtag'den gelirse hesap kaydı kalır (hesabın normaliyle karşılaştırılmış)
    best = {}
    for it in out:
        k = it["shortcode"]
        if k not in best or (best[k]["account"] is None and it["account"]):
            best[k] = it
    items = list(best.values())
    for kind in ("views", "likes"):   # izlenme ve beğeni hızı karşılaştırılamaz: her ölçünün kendi en hızlıları
        for it in sorted((x for x in items if x["metric"] == kind), key=lambda x: -x["velocity"])[:TOP_FAST]:
            # bekçi yalnız hashtag öğesinde (hesap yok) aranmaz; karşılaştıracak videosu az (<3) hesabın öğesi hız kuralıyla trend
            # olmaz (inceleme, 18 Ekim: çoğu fotoğraf paylaşan hesabın sıradan 3 videosu da "hızla yükseliyor" oluyordu)
            if it["_floor"] and (it["_adj"] >= FAST_ADJ if it["_adj"] is not None else it["account"] is None):
                it["fast"] = it["trend"] = True
    for it in items:
        it.pop("_floor", None)
        it.pop("_adj", None)
    items.sort(key=lambda x: (0 if x["trend"] else 1, -x["ratio"] if x["ratio"] is not None else float("inf"), -x["velocity"]))
    return items[:KEEP]


# ---------------- tarama
def scan() -> dict:
    c, state, now, t0 = cfg(), load_state(), time.time(), time.time()
    prev = load_json(OUT, {})
    prev = prev if isinstance(prev, dict) else {}
    results, groups, errors, notes, used = {}, [], [], [], []
    names = []
    for raw in c["accounts"]:
        a = norm_account(raw)
        if a in names:
            continue
        if not NAME.match(a) or a in RESERVED:
            results[str(raw)[:40]] = {"ok": False, "error": "geçersiz kullanıcı adı", "followers": None, "n": 0, "method": None}
            continue
        names.append(a)
    if len(names) > MAX_ACCOUNTS:
        notes.append(f"En çok {MAX_ACCOUNTS} hesap taranır; {len(names) - MAX_ACCOUNTS} hesap atlandı.")
        names = names[:MAX_ACCOUNTS]
    tags = []
    for raw in c["hashtags"]:
        t = norm_tag(raw)
        if t and t not in tags:
            tags.append(t)
    if len(tags) > MAX_HASHTAGS:
        notes.append(f"Taramada en çok {MAX_HASHTAGS} hashtag; fazlası atlandı.")
        tags = tags[:MAX_HASHTAGS]
    if not names and not tags:
        return finish(prev, state, now, results, groups, errors, notes, used, c, fail="Hesap ve hashtag listesi boş; panelden hesap ekleyin.")

    def ok(acc, fol, posts, method):
        results[acc] = {"ok": True, "error": None, "followers": fol, "n": sum(1 for p in posts if p.get("video")), "method": method}
        groups.append((acc, "hesap", posts))
        if method not in used:
            used.append(method)

    def bad(acc, err, method=None):
        results[acc] = {"ok": False, "error": err, "followers": None, "n": 0, "method": method}

    # 1) resmi API
    cr, why = official_creds()
    pending = list(names)
    if cr and paused(state, "official", now):
        notes.append(f"Resmi API istek sınırı nedeniyle {_hm(state['pause']['official'])}'e kadar dinleniyor.")
        cr = None
    official_live = bool(cr)
    if cr:
        for acc in names:
            if time.time() - t0 > BUDGET:
                break
            try:
                fol, posts = bd_fetch(cr, acc, state, now)
                ok(acc, fol, posts, "resmi")
                pending.remove(acc)
            except GraphError as e:
                k = g_kind(e)
                if k == "notfound":
                    bad(acc, "resmi API'de bulunamadı (işletme/içerik üreticisi hesabı değil ya da ad yanlış)", "resmi")
                    continue
                if k == "rate":
                    pause(state, "official", now, f"istek sınırı: {e}", RATE_PAUSE_S)
                    errors.append(f"Resmi API istek sınırına takıldı ({e}); 1 saat dinlenecek, kalan hesaplar herkese açık profilden denenecek.")
                elif k == "token":
                    errors.append(f"Instagram (Facebook Girişi) bağlantısı geçersiz ya da süresi dolmuş: {e}. Panelden yeniden bağlayın.")
                elif k == "perm":
                    errors.append(f"Resmi API izni yok (Business Discovery): {e}")
                else:
                    bad(acc, f"resmi API hatası: {e}", "resmi")
                    continue
                official_live = False
                break
    elif names and why:  # bağlı ama dinleniyor (istek sınırı): neden yukarıdaki notta; "kullanılamıyor: None" yazılmasın
        notes.append(f"Resmi API kullanılamıyor: {why}. Herkese açık profil okunuyor.")

    # 2) herkese açık profil, 3) çerezli (yalnız ayar açıksa)
    if pending:
        mode = None
        if not paused(state, "web", now):
            mode = "web"
        elif c["useCookies"] and not paused(state, "cookies", now):
            mode = "cerez"
        cookies = None
        if mode == "cerez":
            cookies, cerr = load_cookies()
            if not cookies:
                errors.append(f"Çerezli okuma yapılamadı: {cerr}")
                mode = None
        if mode is None:
            until = [state["pause"].get(m) for m in ("web", "cookies") if paused(state, m, now)]
            if until:
                w = state["pauseWhy"].get("web") or state["pauseWhy"].get("cookies") or ""
                errors.append(f"Instagram girişsiz okumayı engellemişti ({w}); {_hm(max(until))}'e kadar beklenecek.")
            for acc in pending:
                if acc not in results:
                    bad(acc, "taranmadı (duraklatıldı)")
        i, streak, last_err = 0, 0, ""
        while mode and i < len(pending):
            acc = pending[i]
            if time.time() - t0 > BUDGET:
                for a in pending[i:]:
                    if not results.get(a, {}).get("ok"):
                        bad(a, "taranmadı (süre doldu)")
                notes.append("Tarama süresi doldu; kalan hesaplar sonraki taramada.")
                break
            if i or results:
                _sleep()
            try:
                u = web_user(acc, cookies if mode == "cerez" else None)
                fol, posts, private = parse_web(u)
                if private and not posts:
                    bad(acc, "gizli hesap", mode)
                else:
                    ok(acc, fol, posts, mode)
                streak = 0
            except NotFound:
                if not results.get(acc, {}).get("ok"):
                    bad(acc, "bulunamadı", mode)
                streak = 0
            except Blocked as e:
                pause(state, "web" if mode == "web" else "cookies", now, str(e))
                if mode == "web" and c["useCookies"] and not paused(state, "cookies", now):
                    cookies, cerr = load_cookies()
                    if cookies:
                        notes.append(f"Girişsiz okuma engellendi ({e}); çerezli okumaya geçildi.")
                        mode = "cerez"
                        continue   # aynı hesap çerezle yeniden
                    errors.append(f"Çerezli okuma yapılamadı: {cerr}")
                label = "Girişsiz" if mode == "web" else "Çerezli"
                errors.append(f"{label} okuma Instagram tarafından engellendi ({e}); tarama durduruldu, {_hm(now + PAUSE_S)}'e kadar bu yol denenmeyecek.")
                for a in pending[i:]:
                    if not results.get(a, {}).get("ok"):
                        bad(a, "taranmadı (Instagram engelledi)", mode)
                break
            except Exception as e:
                err = _reason(e)
                bad(acc, f"okunamadı: {err}", mode)
                streak = streak + 1 if err == last_err else 1
                last_err = err
                if streak >= 3:   # her hesapta aynı hata: Instagram'ı boşuna yormayalım
                    errors.append(f"Art arda 3 hesapta aynı hata ({err}); tarama durduruldu.")
                    for a in pending[i + 1:]:
                        if not results.get(a, {}).get("ok"):
                            bad(a, "taranmadı (art arda hata)", mode)
                    break
            i += 1
        nf = [a for a in pending if results.get(a, {}).get("error") == "bulunamadı"]
        if len(nf) >= 3 and not any(results.get(a, {}).get("ok") for a in pending):
            notes.append("Hiçbir hesap bulunamadı: adlar yanlış olabilir ya da Instagram girişsiz isteğe boş yanıt veriyor olabilir.")

    # hashtag'ler: yalnız resmi API (Facebook Girişi + Instagram Public Content Access)
    if tags:
        if not official_live:
            # neden: bağlantı yok (why) ya da bağlı hesapta resmi API şu an kullanılamıyor (istek sınırı, token, izin; uyarı yukarıda)
            notes.append(f"Hashtag'ler ({', '.join('#' + t for t in tags)}) taranmadı: "
                         + ("yalnız Facebook Girişi ile bağlı hesapta resmi API ile aranabilir." if why else "resmi API şu an kullanılamıyor (yukarıdaki uyarıya bakın)."))
        else:
            for t in tags:
                if time.time() - t0 > BUDGET:
                    break
                if not hashtag_ok(state, t, now):
                    errors.append(f"#{t}: 7 günde en çok {HASHTAG_CAP} farklı hashtag aranabilir, sınır dolu; atlandı.")
                    continue
                try:
                    groups.append((None, "#" + t, hashtag_posts(cr, t, state, now)))
                    if "resmi" not in used:
                        used.append("resmi")
                except GraphError as e:
                    k = g_kind(e)
                    if k == "perm":
                        errors.append(f"Hashtag araması izni yok (Meta uygulamasında Instagram Public Content Access gerekli): {e}")
                        break
                    if k == "rate":
                        pause(state, "official", now, f"istek sınırı: {e}", RATE_PAUSE_S)
                        errors.append(f"Hashtag araması istek sınırına takıldı ({e}).")
                        break
                    errors.append(f"#{t}: {'bulunamadı' if k == 'notfound' else e}")
    fail = None
    if not any(r.get("ok") for r in results.values()) and not any(src != "hesap" for _, src, _ in groups):
        fail = errors[0] if errors else "Hiçbir hesap okunamadı: " + "; ".join(f"@{a}: {r.get('error')}" for a, r in list(results.items())[:5])
    return finish(prev, state, now, results, groups, errors, notes, used, c, fail=fail)


def finish(prev, state, now, results, groups, errors, notes, used, c, fail=None) -> dict:
    ms = int(now * 1000)
    pu = [float(state["pause"][m]) for m in ("web", "cookies") if paused(state, m, now)]
    # panelde gösterilen duraklama: kullanılan yola göre (resmi API varken girişsiz yolun duraklaması yalnız bilgi)
    pinfo = {"pausedUntil": int(min(pu) * 1000) if pu else None,
             "pauseReason": (state["pauseWhy"].get("web") or state["pauseWhy"].get("cookies")) if pu else None}
    if fail:
        # hiçbir hesaba istek atılmadıysa (duraklatma) son gerçek taramanın hesap durumları kalır; duraklama bilgi satırında görünür
        tried = any(not str(r.get("error") or "").startswith("taranmadı") for r in results.values())
        cache = {**prev, "lastTry": ms, "accounts": (results if tried else prev.get("accounts")) or results or {}, "errors": errors, "notes": notes,
                 "error": fail, "ok": False, **pinfo}
        cache.setdefault("items", [])
        save_json(OUT, cache)
        save_json(STATE, state)
        return {"ok": False, "error": fail, "accounts": results, "errors": errors, "notes": notes, **pinfo, "newTrends": []}
    items = score(groups, c, now)
    seen = state["trendSeen"]
    for k, ts in list(seen.items()):
        try:
            if now - float(ts) > WEEK:
                del seen[k]
        except (TypeError, ValueError):
            del seen[k]
    new = [it for it in items if it["trend"] and it["shortcode"] not in seen]
    for it in items:
        if it["trend"]:
            seen[it["shortcode"]] = now
    cache = {"ok": True, "at": ms, "lastTry": ms, "method": "+".join(used) or None, "accounts": results, "items": items,
             "errors": errors, "notes": notes, "error": None, **pinfo}
    save_json(OUT, cache)
    state["lastScan"] = ms
    save_json(STATE, state)
    return {**cache, "newTrends": [{k: it[k] for k in ("account", "source", "url", "caption", "views", "likes", "metric", "ratio", "fast")} for it in new]}


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    if "--scan" in argv:
        try:
            out = scan()
        except Exception as e:   # beklenmeyen hata da JSON olarak dönsün (panel çıkış koduna bakmaz)
            out = {"ok": False, "error": f"tarama hatası: {_scrub(e)[:200]}"}
        print(json.dumps(out, ensure_ascii=False))
    elif "--list" in argv:
        d = load_json(OUT, {})
        print(json.dumps(d if isinstance(d, dict) and d else {"ok": False, "error": "Henüz tarama yapılmadı."}, ensure_ascii=False))
    else:
        print(__doc__)
        print(json.dumps({"ok": False, "error": "kullanım: --scan | --list"}, ensure_ascii=False))


if __name__ == "__main__":
    main()
