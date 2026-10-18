#!/usr/bin/env python3
"""sondakika.com takibi: siteye düşen YENİ haberleri bulur; panel 5 dakikada bir --check çalıştırır ve her yeni haber için
onaysız son dakika videosu üretir (kullanıcı isteği, 17 Ekim).

Kullanım:
  python3 scripts/sondakika_watch.py --list            son haberler (JSON)
  python3 scripts/sondakika_watch.py --check           yeni girenler; ilk çalıştırmada mevcutları "görüldü" sayar (video üretilmez)
  python3 scripts/sondakika_watch.py --article URL     haberin başlığı, özeti, metni, görseli + yayın zamanı ve sayfadaki video

Sayfa yapısı görülmeden yazıldığı için tek bir sınıf adına bağlı değildir; katmanlı keşif:
  1. RSS/Atom: önce son çalışan akış, sonra settings.sondakika.rss adayları, sonra ana sayfadaki
     <link rel="alternate" type="application/rss+xml|atom+xml"> (aday adres akış yerine HTML "RSS listesi" sayfası
     dönerse oradaki .xml/rss linkleri de denenir; genel akışlar önce, kategori akışları sona). Öğeden başlık, link,
     tarih, açıklama, görsel (enclosure / media:content / media:thumbnail / açıklamadaki img) ve varsa video eki okunur.
     Çalışan ilk akış kullanılır.
  2. Akış yoksa "son dakika" sayfası (listUrl; ulaşılamazsa sessizce atlanır) ve ana sayfa (settings.sondakika.url):
     aynı sitede sonu ≥6 haneli sayısal kimlikle biten haber linkleri. Haber, sayfada göründüğü her son-dakika/breaking/
     flash/ticker/latest/son-haber/news-list… adlı bloğun üyesidir; en az 3 haberli bloklardan güçlü ad → daha içteki →
     sayfada önce gelen seçilir (bloklar sınıf adıyla değil öğe kimliğiyle ayrılır); yoksa sayfa sırasıyla linkler.
Kaynak (akış adresi ya da okunan sayfalar) değişirse: yeni listenin çoğu zaten görüldüyse (aynı haberler) ya da kaynak son
3 saatte kullanıldıysa normal tarama; değilse o tarama ilk tarama sayılır (başka listenin eski haberleri "yeni" sanılıp sel
olmasın). Geçici bir RSS hatasında ana sayfaya düşüp geri dönmek böylece haber kaçırmaz.
Durum: data/sondakika_state.json {seen: {url: son görülme}, lastCheck, method, source, bases: {kaynak: son kullanılma},
items (son liste, en çok 20)}.
"""
import html
import json
import re
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import DATA, load_json, save_json, settings  # noqa: E402
import mynet_watch as mw  # noqa: E402
from mynet_watch import CTX, UA, Links, _clean, _ld_items  # noqa: E402

STATE = DATA / "sondakika_state.json"
DEFAULT_RSS = ["https://www.sondakika.com/rss/", "https://www.sondakika.com/rss.xml", "https://www.sondakika.com/sondakika.xml"]
COUNT = 20       # panelde ve durum dosyasında tutulan son haber sayısı; yenilik her listenin (sayfanın) ilk COUNT haberinde aranır
BUDGET = 80      # sn: bir taramada adres denemeye ayrılan en uzun süre (panel 120 sn sonra keser)
SAME_LIST = 0.5  # kaynak değişince yeni listenin ilk haberlerinin en az yarısı zaten görüldüyse aynı liste sayılır
RESUME_H = 3     # son 3 saatte kullanılmış kaynağa dönüş normal taramadır (arada düşen haberler kaçmasın)
ARTICLE = re.compile(r"[-_/]\d{6,}(?:/|\.html?|\.aspx?)?$")
BLOCK = re.compile(r"(son-?dakika|sondakika|breaking|fla[sş]|ticker|latest|son-?haber|lastnews|last-?news|son-?eklenen|news-?list|haber-?list|newslist)", re.I)
# bitişik "sondakika" sitenin adı (dış sarmalayıcıda da geçer); güçlü sayılmaz, ayraçlı "son-dakika" sayılır
STRONG = re.compile(r"(son[-_ ]dakika|breaking|fla[sş]|ticker|latest|son-?haber|lastnews|last-?news|son-?eklenen)", re.I)
# akış sırası yalnız yol + sorguya bakar (alan adındaki "sondakika" her adreste geçer): genel akış önce, kategori akışı sona
FEED_PREF = re.compile(r"(son-?dakika|sondakika|tum|tüm|anasayfa|ana-sayfa|manset|gundem|guncel|haberler|rss\.xml$|/rss/?$)", re.I)
FEED_CAT = re.compile(r"(ekonomi|finans|spor|futbol|magazin|dunya|dünya|saglik|sağlık|teknoloji|bilim|yasam|yaşam|kultur|kültür|sanat|egitim|eğitim|politika|siyaset|otomobil|turizm|emlak|kadin|kadın|yerel|astroloji|video|foto)", re.I)
PREFIX = re.compile(r"^\s*(?:son\s*dak[iİı]ka|flaş|flas|sıcak gelişme)\s*[:|!\-–—]+\s*", re.I)


def cfg() -> dict:
    c = {"url": "https://www.sondakika.com/", "listUrl": "https://www.sondakika.com/son-dakika/", "rss": DEFAULT_RSS}
    c.update(settings().get("sondakika") or {})
    return c


def _decode(raw: bytes, cs: str = "") -> str:
    if not cs:  # başlıkta yoksa XML bildiriminden ya da meta etiketinden (Türkçe akışlarda windows-1254 / iso-8859-9 görülür)
        m = re.search(rb'<\?xml[^>]+encoding=["\']([\w-]+)', raw[:300]) or re.search(rb'<meta[^>]+charset=["\']?([\w-]+)', raw[:4096], re.I)
        cs = m.group(1).decode() if m else "utf-8"
    try:
        return raw.decode(cs, "replace")
    except LookupError:
        return raw.decode("utf-8", "replace")


def _curl(url: str, err: Exception) -> str:
    """Bot engelinde curl ile bir kez daha (mynet_watch.get gibi); ham baytlar _decode ile çözülür ki yanıt başlığındaki ve
    XML bildirimindeki karakter kümesi (windows-1254 akış) bu yolda da okunsun. curl de düşerse ilk hata yükselir."""
    try:
        out = subprocess.run(["curl", "-sSL", "--compressed", "-m", "25", "-A", UA, "-H", "Accept-Language: tr-TR,tr;q=0.9",
                              "-w", "\n%{content_type}\n%{http_code}", url], capture_output=True, timeout=30)
    except Exception:
        raise err
    parts = out.stdout.rsplit(b"\n", 2)
    if out.returncode != 0 or len(parts) != 3 or not parts[2].strip().startswith(b"2") or not parts[0]:
        raise err
    m = re.search(rb"charset=([\w-]+)", parts[1], re.I)
    return _decode(parts[0], m.group(1).decode() if m else "")


def fetch(url: str) -> str:
    """Sayfa ya da akış metni. Bot engelinde (403/429/503, TLS) curl ile bir kez daha denenir;
    404 ve zaman aşımında tekrar denenmez (5 dk'lık taramada boşuna beklenmesin)."""
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept-Language": "tr-TR,tr;q=0.9",
                                               "Accept": "application/rss+xml,application/atom+xml,application/xml,text/xml,text/html;q=0.9,*/*;q=0.8"})
    try:
        with urllib.request.urlopen(req, timeout=15, context=CTX) as r:
            return _decode(r.read(4 * 1024 * 1024), r.headers.get_content_charset() or "")
    except urllib.error.HTTPError as e:
        if e.code not in (403, 429, 503):
            raise
        return _curl(url, e)
    except (TimeoutError, socket.timeout):
        raise
    except urllib.error.URLError as e:
        if isinstance(e.reason, (TimeoutError, socket.timeout)):
            raise
        return _curl(url, e)


def _why(e: Exception) -> str:
    if isinstance(e, urllib.error.HTTPError):
        return f"HTTP {e.code}"
    if isinstance(e, (TimeoutError, socket.timeout)) or "timed out" in str(e):
        return "zaman aşımı"
    if isinstance(e, urllib.error.URLError):
        return f"bağlantı kurulamadı ({str(e.reason)[:60]})"
    return str(e)[:80] or type(e).__name__


def _host(u: str) -> str:
    h = urllib.parse.urlsplit(u).netloc.lower()
    for p in ("www.", "m."):
        h = h[len(p):] if h.startswith(p) else h
    return h


def _key(u: str) -> str:
    """Görülenler anahtarı: alan adı (www'suz) + yol (sondaki / yok) + izleme parametreleri atılmış sorgu."""
    sp = urllib.parse.urlsplit(u)
    q = "&".join(p for p in sp.query.split("&") if p and not p.lower().startswith(("utm_", "ref=", "from=", "source=")))
    return f"{_host(u)}{sp.path.rstrip('/').lower()}{'?' + q if q else ''}"


def _title(t: str) -> str:
    return PREFIX.sub("", re.sub(r"\s+", " ", html.unescape(t or "")).strip()).strip()


def _iso(s: str) -> str:
    s = (s or "").strip()
    if not s or re.fullmatch(r"\d{4}-\d{2}-\d{2}", s):  # yalnız gün: saati bilinmez (gece yarısı sayılırsa her haber "bayat" olur)
        return ""
    try:
        d = parsedate_to_datetime(s)  # RSS: "Sat, 17 Oct 2026 14:05:00 +0300"
    except Exception:
        try:
            d = datetime.fromisoformat(s.replace("Z", "+00:00"))  # Atom / JSON-LD: ISO 8601
        except Exception:
            return ""
    if d.tzinfo is None:
        d = d.astimezone()  # bölgesiz saat yerel sayılır
    return d.astimezone(timezone.utc).isoformat()


# ---------- RSS / Atom (düzenli ifadeyle: bozuk XML'de de çalışsın, & kaçmamış akışlar sık görülür)
def _inner(blk: str, name: str) -> str:
    m = re.search(rf"<{name}\b[^>]*?(?<!/)>(.*?)</{name}>", blk, re.S | re.I)
    if not m:
        return ""
    return html.unescape(re.sub(r"<!\[CDATA\[(.*?)\]\]>", r"\1", m.group(1), flags=re.S))


def _attrs(tag: str) -> dict:
    return {k.lower(): html.unescape(v) for k, v in re.findall(r'([\w:-]+)\s*=\s*["\']([^"\']*)["\']', tag)}


def is_feed(text: str) -> bool:
    head = text.lstrip("﻿ \r\n\t")[:3000]
    f, h = re.search(r"<(rss|feed|rdf:rdf|channel)\b", head, re.I), re.search(r"<(html|body)\b", head, re.I)
    return bool(f) and (not h or f.start() < h.start())


def feed_items(text: str, base: str) -> list:
    out = []
    for blk in re.findall(r"<(?:item|entry)\b[^>]*>(.*?)</(?:item|entry)>", text, re.S | re.I):
        link = raw = _clean(_inner(blk, "link"))
        if not link.startswith("http"):  # Atom: <link rel="alternate" href="…"/>; yoksa göreli RSS linki (/haber/…) kalır
            alts = [_attrs(t) for t in re.findall(r"<link\b[^>]*>", blk, re.I)]
            link = next((a.get("href", "") for a in alts if a.get("rel", "alternate") == "alternate" and a.get("href")), "") or raw
        if not link.startswith("http"):
            g = _clean(_inner(blk, "guid")) or _clean(_inner(blk, "id"))
            link = g if g.startswith("http") else urllib.parse.urljoin(base, link) if link else ""
        title = _title(_clean(_inner(blk, "title")))
        if not link or not title:
            continue
        desc_html = _inner(blk, "description") or _inner(blk, "summary") or _inner(blk, "content:encoded") or _inner(blk, "content")
        image = video = ""
        for name, tag in re.findall(r"<(enclosure|media:content|media:thumbnail)\b([^>]*)>", blk, re.I):
            a = _attrs(tag)
            u, typ = a.get("url", ""), (a.get("type") or a.get("medium") or "").lower()
            if not u:
                continue
            if "video" in typ or re.search(r"\.(mp4|m3u8|webm)(\?|$)", u, re.I):
                video = video or u
            elif "image" in typ or name.lower() == "media:thumbnail" or re.search(r"\.(jpe?g|png|webp)(\?|$)", u, re.I):
                image = image or u
        if not image:
            m = re.search(r"<image\b[^>]*>\s*(?:<url>)?\s*(https?://[^<\s]+)", blk, re.I) or re.search(r'<img[^>]+src=["\']([^"\']+)', desc_html, re.I)
            image = m.group(1) if m else ""
        pub = _iso(_clean(_inner(blk, "pubDate") or _inner(blk, "published") or _inner(blk, "updated") or _inner(blk, "dc:date")))
        out.append({"url": link, "title": title, "image": urllib.parse.urljoin(link, image) if image else "",
                    "video": video, "description": _clean(desc_html)[:400], "published": pub})
    if out and all(x["published"] for x in out):  # en yeniden eskiye (akış sırası karışık olabilir)
        out.sort(key=lambda x: x["published"], reverse=True)
    return out


def feed_links(page: str, base: str) -> list:
    """Sayfadaki akış adresleri: <link rel=alternate type=rss/atom> ve (RSS listesi sayfasında) aynı sitedeki .xml/rss linkleri.
    Genel akışlar (son dakika, tüm haberler, ana sayfa, gündem) önce."""
    found = []
    for tag in re.findall(r"<link\b[^>]*>", page, re.I):
        a = _attrs(tag)
        if re.search(r"(rss|atom)\+xml", a.get("type", ""), re.I) and a.get("href"):
            found.append(urllib.parse.urljoin(base, a["href"]))
    host = _host(base)
    for href in re.findall(r'<a\b[^>]*href=["\']([^"\']+)', page, re.I):
        u = urllib.parse.urljoin(base, html.unescape(href))
        h = _host(u)  # rss.sondakika.com gibi alt alan adları da sitenin akışıdır
        if (h == host or h.endswith("." + host)) and re.search(r"(\.xml|\.rss|/rss/?[\w-]*)(\?|$)", urllib.parse.urlsplit(u).path + "?", re.I):
            found.append(u)
    uniq = list(dict.fromkeys(found))

    def rank(u):
        sp = urllib.parse.urlsplit(u)
        p = sp.path + ("?" + sp.query if sp.query else "")
        return 2 if FEED_CAT.search(p) else 0 if FEED_PREF.search(p) else 1
    return sorted(uniq, key=rank)


# ---------- HTML (ana sayfa ve son dakika sayfası)
class _Links(Links):
    """mynet_watch.Links + atalarda öğenin sayfadaki sıra numarası (kimliği): aynı sınıf adlı ayrı kutular (son dakika,
    spor ve "en çok okunanlar"ın hepsinde "news-list") tek grup sanılmasın. ctx: [(sıra no, "sınıf kimlik"), …]"""

    def __init__(self):
        super().__init__()
        self.n = 0

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        self.n += 1
        if tag not in ("img", "br", "meta", "link", "input", "source", "hr"):
            self.stack.append((tag, f"{a.get('class') or ''} {a.get('id') or ''}", self.n))
        if tag == "a" and a.get("href"):
            self.cur = {"href": a["href"], "title": a.get("title") or "", "img": "", "alt": "", "text": "",
                        "ctx": [(n, c) for _, c, n in self.stack[:-1] if c.strip()], "order": len(self.links)}
        elif tag == "img" and self.cur is not None:
            self.cur["alt"] = self.cur["alt"] or a.get("alt") or ""
            self.cur["img"] = self.cur["img"] or a.get("data-src") or a.get("data-original") or a.get("src") or ""


def page_items(page: str, base: str) -> list:
    p = _Links()
    p.feed(page)
    host, by_url, links, groups = _host(base), {}, [], {}
    for l in p.links:
        u = urllib.parse.urljoin(base, html.unescape(l["href"].strip()))
        sp = urllib.parse.urlsplit(u)
        if _host(u) != host or not ARTICLE.search(sp.path):
            continue
        u = urllib.parse.urlunsplit((sp.scheme, sp.netloc, sp.path, sp.query, ""))
        cands = [_title(x) for x in (l["title"], l["alt"], l["text"]) if x and x.strip()]
        title = next((c for c in cands if len(c) >= 12), max(cands, key=len) if cands else "")
        img = l["img"] if l["img"] and not l["img"].startswith("data:") else ""
        x = by_url.get(u)
        if x:  # aynı haberin görsel linki ve başlık linki (ya da hem manşette hem son dakika listesinde): eksik alanları tamamla
            x["title"] = x["title"] if len(x["title"]) >= 12 else (title if len(title) > len(x["title"]) else x["title"])
            x["image"] = x["image"] or (urllib.parse.urljoin(base, img) if img else "")
        else:
            x = by_url[u] = {"url": u, "title": title, "image": urllib.parse.urljoin(base, img) if img else "", "video": "",
                             "description": "", "published": ""}
            links.append(x)
        # haber, göründüğü HER yerdeki her son dakika/akış bloğunun üyesidir: manşet slider'ında da duran son dakika haberi
        # listeden düşmesin (sitenin adı "sondakika" olduğu için dıştaki sarmalayıcı da blok sayılır; aşağıda zayıf kalır)
        for depth, (n, c) in enumerate(l["ctx"]):
            if BLOCK.search(c):
                g = groups.setdefault(n, {"name": c, "depth": depth, "urls": set(), "items": []})
                if u not in g["urls"]:
                    g["urls"].add(u)
                    g["items"].append(x)
    # en az 3 haberli bloklar: önce güçlü ad (son-dakika/breaking/ticker…), sonra daha içteki blok, sonra sayfada önce gelen
    good = [(0 if STRONG.search(g["name"]) else 1, -g["depth"], i, g["items"]) for i, g in enumerate(groups.values()) if len(g["items"]) >= 3]
    chosen = min(good, key=lambda g: g[:3])[3] if good else links
    return [dict(x) for x in chosen]


def _state() -> dict:
    """Durum dosyası. Elle bozulmuş ya da yanlış türdeyse (null, liste, sayı zamanlı seen…) boş sayılır: o tarama ilk tarama
    olur ve dosya yeniden yazılır (yoksa her tarama hata verip takip kalıcı olarak dururdu)."""
    st = load_json(STATE, {})
    st = st if isinstance(st, dict) else {}
    for k in ("seen", "bases"):
        v = st.get(k)
        v = {a: b for a, b in v.items() if isinstance(b, str)} if isinstance(v, dict) else {}
        if v:
            st[k] = v
        else:
            st.pop(k, None)
    for k in ("method", "source"):
        if not isinstance(st.get(k), str):
            st.pop(k, None)
    return st


def discover() -> dict:
    """Katmanlı keşif. {method, source, items (tümü), top (yeniliğin arandığı anahtarlar), tried}"""
    c, st, start = cfg(), _state(), time.time()
    tried, pages = [], {}

    def attempt(u):
        if time.time() - start > BUDGET:
            tried.append(f"{u} → süre doldu")
            return None
        try:
            t = fetch(u)
            tried.append(f"{u} → okundu")
            return t
        except Exception as e:
            tried.append(f"{u} → {_why(e)}")
            return None

    def try_feed(u, more):
        text = attempt(u)
        if text is None:
            return None
        if is_feed(text):
            items = feed_items(text, u)
            if items:
                return items
            tried[-1] = f"{u} → akışta haber yok"
        else:  # aday adres akış değil, HTML (ör. "RSS listesi" sayfası): içindeki akış linkleri sonra denenir
            pages[u] = text
            more.extend(feed_links(text, u))
            tried[-1] = f"{u} → akış değil (HTML)"
        return None

    def feed_result(u, items):  # akış en yeniden eskiye: yenilik ilk COUNT haberde
        return {"method": "rss", "source": u, "items": items, "top": [_key(x["url"]) for x in items[:COUNT]], "tried": tried}

    # 1) RSS/Atom: son çalışan akış, ayardaki adaylar, ana sayfanın bildirdiği ve RSS listesi sayfasındaki akışlar
    cands = ([st["source"]] if st.get("method") == "rss" and st.get("source") else []) + list(c.get("rss") or [])
    more, done = [], set()
    for u in dict.fromkeys(cands):
        done.add(u)
        items = try_feed(u, more)
        if items:
            return feed_result(u, items)
    home = attempt(c["url"]) if c.get("url") else None
    if home is not None:
        more = feed_links(home, c["url"]) + more
    for u in [u for u in dict.fromkeys(more) if u not in done][:4]:
        items = try_feed(u, [])
        if items:
            return feed_result(u, items)
    # 2) HTML: son dakika sayfası (asıl liste) önce, sonra ana sayfa (son dakika bloğu ya da sayfa sırası); aynı haber bir kez.
    # Yenilik her sayfanın KENDİ ilk COUNT haberinde aranır: ana sayfanın uzun listesi son dakika sayfasını 20'nin dışına itmesin.
    got_by = {}
    if c.get("listUrl"):
        lp = attempt(c["listUrl"])
        got = page_items(lp, c["listUrl"]) if lp else []
        if got:
            got_by[c["listUrl"]] = got
    if home is not None:
        got = page_items(home, c["url"])
        if got:
            got_by[c["url"]] = got
    uniq, top = {}, []
    for got in got_by.values():
        for x in got:  # aynı haber iki sayfada: son dakika sayfasındaki kalır
            uniq.setdefault(_key(x["url"]), x)
        top += [_key(x["url"]) for x in got[:COUNT]]
    items = list(uniq.values())
    if items:  # kaynak adı sabit sırada (ana sayfa + son dakika sayfası): sıra değişti diye "kaynak değişti" sanılmasın
        used = [u for u in (c.get("url"), c.get("listUrl")) if u in got_by]
        return {"method": "html", "source": " + ".join(used), "items": items, "top": list(dict.fromkeys(top)), "tried": tried}
    if any(t.endswith("→ okundu") or "akış" in t for t in tried):
        raise RuntimeError("sondakika.com'da haber linki bulunamadı (sayfa yapısı değişmiş olabilir); denenen adresler: " + "; ".join(tried))
    raise RuntimeError("sondakika.com okunamadı (RSS ve sayfa); denenen adresler: " + "; ".join(tried))


def annotate(items: list) -> list:
    """Haber değeri (YouTube kuralı), bu olayı veren diğer siteler ve videosu üretildi mi (üretilen haber hafızası: başlık +
    açıklama + adres; dupInfo hangi video, ne zaman). Panel burada yalnız adres eşleşmesinde atlar; başlık/açıklama eşleşmesine
    sayfa okununca (--article) gövdeyle bakar (HTML'den okunan haberde açıklama boştur, başlık aynı ildeki başka olayı da tutar)."""
    from breaking_watch import STATE as BSTATE, match_produced, source_count
    from news_value import score
    kw = (settings().get("youtubePolicy") or {}).get("extraKeywords")
    bst = load_json(BSTATE, {})
    for x in items:
        srcs = sorted(set(source_count(x["title"], bst) if x["title"] else []) | {"Sondakika.com"})
        v = score(f"{x['title']} {(x.get('description') or '')[:200]}", kw)
        x["valuable"], x["valueReason"], x["sources"] = v["valuable"], v["reason"], srcs
        if len(srcs) > 1:
            x["valueReason"] += f" · {len(srcs)} kaynakta"
        m = match_produced(x["title"], x.get("description") or "", x.get("url") or "") if x["title"] else None
        x["dup"], x["dupInfo"] = bool(m), m
    return items


def check() -> dict:
    from breaking_watch import same_event
    d = discover()
    method, source, allitems, top = d["method"], d["source"], d["items"], set(d["top"])
    items = allitems[:COUNT]
    st = _state()
    seen, bases = st.get("seen", {}), st.get("bases", {})

    def stamp(t):
        return time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(t))
    now = stamp(time.time())
    first, changed = not seen, False
    if not first and source != st.get("source"):
        # kaynak değişti (RSS geçici düştü → ana sayfa, başka akış adayı, ayardan yeni adres): aynı haberlerin listesiyse ya da
        # bu kaynağa son RESUME_H saatte bakıldıysa normal tarama (arada düşen haber kaçmasın); değilse başka bir listenin eski
        # haberleri "yeni" sanılıp sel olmasın diye bu kaynakla ilk tarama
        known = sum(1 for k in top if k in seen) / max(1, len(top))
        changed = first = known < SAME_LIST and bases.get(source, "") < stamp(time.time() - RESUME_H * 3600)
    new = [] if first else [i for i in allitems if _key(i["url"]) in top and _key(i["url"]) not in seen]
    for i in allitems:  # listenin tamamı görüldü (son görülme) sayılır: aşağıdan yukarı kayan eski haber "yeni" sanılmasın,
        seen[_key(i["url"])] = now  # listede duran haber 7 günlük temizlikte silinip yeniden "yeni" olmasın
    uniq = []  # aynı partide aynı olayı veren iki haber tek sayılır (en yenisi kalır)
    for i in new:
        if not (i["title"] and any(u["title"] and same_event(i["title"], u["title"]) for u in uniq)):
            uniq.append(i)
    annotate(items + [i for i in uniq if not any(i is x for x in items)])
    # 7 gündür görünmeyen haberler ve kullanılmayan kaynaklar silinir
    cutoff = stamp(time.time() - 7 * 86400)
    seen = {u: t for u, t in seen.items() if t >= cutoff}
    bases = {u: t for u, t in {**bases, source: now}.items() if t >= cutoff}
    save_json(STATE, {"seen": seen, "lastCheck": now, "method": method, "source": source, "bases": bases, "items": items})
    return {"ok": True, "first": first, "sourceChanged": changed, "method": method, "source": source, "items": items, "new": uniq}


# ---------- haber sayfası
def _meta_q(page: str, *names) -> str:
    """mynet_watch._meta (değer açılış tırnağıyla kapanır, bozuk etiket sonrakileri yutmaz) + itemprop anahtarı."""
    return mw._meta(page, *names, keys="property|name|itemprop")


def _published(page: str) -> str:
    for d in _ld_items(page):
        if d.get("datePublished"):
            v = _iso(str(d["datePublished"]))
            if v:
                return v
    cands = [_meta_q(page, "article:published_time", "og:article:published_time", "pubdate", "publishdate", "publish-date", "datepublished", "date")]
    m = re.search(r'itemprop=["\']datePublished["\'][^>]*content=["\']([^"\']+)', page, re.I)
    cands.append(m.group(1) if m else "")
    # son çare <time>: yalnız saatli değer ve varsa <article> içindeki ilk etiket (sayfa başındaki gün tarihi ya da başka haber değil)
    i = page.lower().find("<article")
    m = re.search(r'<time\b[^>]*datetime=["\']([^"\']*\d[T ]\d{1,2}:\d{2}[^"\']*)["\']', page[i:] if i >= 0 else page, re.I)
    cands.append(m.group(1) if m else "")
    return next((v for v in map(_iso, cands) if v), "")


def _video(page: str, base: str) -> str:
    """Haber sayfasındaki video (öncelik videoda; fetch_images asıl indirmeyi yapar, burada yalnız var mı diye bakılır)."""
    v = _meta_q(page, "og:video:secure_url", "og:video:url", "og:video", "twitter:player:stream")
    if not v:
        for d in _ld_items(page):
            vids = [d] if "VideoObject" in str(d.get("@type", "")) else d.get("video") if isinstance(d.get("video"), list) else [d.get("video")]
            for x in vids or []:
                if isinstance(x, dict) and (x.get("contentUrl") or x.get("embedUrl")):
                    v = str(x.get("contentUrl") or x.get("embedUrl"))
                    break
            if v:
                break
    if not v:
        m = re.search(r'<(?:video|source)\b[^>]*src=["\']([^"\']+\.(?:mp4|m3u8|webm)[^"\']*)', page, re.I) \
            or re.search(r'<iframe\b[^>]*src=["\']([^"\']*(?:youtube\.com/embed|youtube-nocookie\.com/embed|dailymotion\.com/embed|player\.vimeo\.com)[^"\']*)', page, re.I)
        v = m.group(1) if m else ""
    return urllib.parse.urljoin(base, html.unescape(v)) if v else ""


def article(url: str) -> dict:
    """mynet_watch.article ile aynı biçim + published (yayın zamanı, UTC ISO), video (sayfadaki video adresi) ve dup/dupInfo (bu
    haberin videosu üretildi mi — başlık + açıklama + gövde + adresle: --check'ten bu yana başka kaynak üretmiş olabilir,
    üretimden hemen önce yeniden)."""
    page = fetch(url)
    orig = mw.get
    mw.get = lambda _u: page  # article() sayfayı get() ile alır; aynı sayfa ikinci kez indirilmesin
    try:
        a = mw.article(url)
    finally:
        mw.get = orig
    # mw.article'ın bulamadığı itemprop meta değerleri; kısa kalmış değer (eski sürümlerde kesme işaretinde kesilirdi) uzunuyla düzeltilir
    for k, names in (("title", ("og:title", "twitter:title")), ("description", ("og:description", "description", "twitter:description")), ("site", ("og:site_name",))):
        v, cur = _meta_q(page, *names), a.get(k) or ""
        if v and len(v) > len(cur) and v.startswith(cur):
            a[k] = v
    a["published"], a["video"] = _published(page), _video(page, url)
    return mw.with_dup(a)


if __name__ == "__main__":
    try:
        if "--article" in sys.argv:
            out = article(sys.argv[sys.argv.index("--article") + 1])
        elif "--list" in sys.argv:
            d = discover()
            out = {"ok": True, "method": d["method"], "source": d["source"], "items": annotate(d["items"][:COUNT])}
        else:
            out = check()
    except Exception as e:
        out = {"ok": False, "error": str(e)[:700]}
    print(json.dumps(out, ensure_ascii=False))
