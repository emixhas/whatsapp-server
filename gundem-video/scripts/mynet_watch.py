#!/usr/bin/env python3
"""Mynet manşet takibi: ana sayfadaki manşet alanının (en çok 6 haber) yeni girenlerini bulur.

Kullanım:
  python3 scripts/mynet_watch.py --list            manşetteki haberler (JSON)
  python3 scripts/mynet_watch.py --check           yeni girenler; ilk çalıştırmada mevcutları "görüldü" sayar
  python3 scripts/mynet_watch.py --article URL     haberin başlığı, özeti, metni, görseli ve dup (videosu üretildi mi) (JSON)

Sayfa yapısı değişebileceği için tek bir sınıf adına bağlı değildir:
  1. Sınıfı/kimliği manşet, slider, swiper, carousel, headline içeren ilk blok (en az 3 haber linki) seçilir.
  2. Bulunamazsa sayfadaki görselli ilk haber linkleri alınır.
Haber linki: aynı sitede, sonu uzun sayısal kimlikle biten adres (Mynet haber adresleri böyledir).
Haber metni sırasıyla JSON-LD articleBody, makale paragrafları, og:description'dan alınır.
Durum: data/mynet_state.json {seen: {url: ilk görülme}, lastCheck}.
"""
import html
import json
import re
import ssl
import subprocess
import sys
import time
import urllib.parse
import urllib.request
from html.parser import HTMLParser
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import DATA, load_json, save_json, settings  # noqa: E402

try:
    import certifi
    CTX = ssl.create_default_context(cafile=certifi.where())
except ImportError:
    CTX = ssl.create_default_context()

UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36"
CFG = {"url": "https://www.mynet.com/", "count": 6, **((settings().get("mynet") or {}))}
STATE = DATA / "mynet_state.json"
BLOCK = re.compile(r"(manset|manşet|headline|slider|swiper|carousel|mainnews|main-news|topnews|top-news|spot)", re.I)
ARTICLE = re.compile(r"-\d{8,}(?:/|\.html?)?(?:[?#].*)?$")


def get(url: str) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept-Language": "tr-TR,tr;q=0.9",
                                               "Accept": "text/html,application/xhtml+xml,*/*;q=0.8"})
    try:
        with urllib.request.urlopen(req, timeout=20, context=CTX) as r:
            raw = r.read(4 * 1024 * 1024)
            cs = r.headers.get_content_charset() or ""
    except Exception as e:  # bazı siteler Python istemcisini reddeder (403/429, TLS); curl ile bir kez daha dene
        try:
            out = subprocess.run(["curl", "-sSL", "--compressed", "-m", "25", "-A", UA, "-H", "Accept-Language: tr-TR,tr;q=0.9",
                                  "-w", "\n%{http_code}", url], capture_output=True, timeout=30)
        except Exception:
            raise e
        body, _, code = out.stdout.rpartition(b"\n")
        if out.returncode != 0 or not code.strip().startswith(b"2") or not body:
            raise e
        raw, cs = body, ""
    if not cs:  # charset başlıkta yoksa sayfanın meta etiketinden (Türkçe sitelerde windows-1254 / iso-8859-9 görülür)
        m = re.search(rb'<meta[^>]+charset=["\']?([\w-]+)', raw[:4096], re.I)
        cs = m.group(1).decode() if m else "utf-8"
    try:
        return raw.decode(cs, "replace")
    except LookupError:
        return raw.decode("utf-8", "replace")


class Links(HTMLParser):
    """Her <a> için: adres, title, içindeki görselin alt/src'i, metni ve atalarının sınıf/kimlik dizisi."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.stack, self.links, self.cur = [], [], None

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag not in ("img", "br", "meta", "link", "input", "source", "hr"):
            self.stack.append((tag, f"{a.get('class', '')} {a.get('id', '')}"))
        if tag == "a" and a.get("href"):
            self.cur = {"href": a["href"], "title": a.get("title") or "", "img": "", "alt": "", "text": "",
                        "ctx": [c for _, c in self.stack[:-1] if c.strip()], "order": len(self.links)}
        elif tag == "img" and self.cur is not None:
            self.cur["alt"] = self.cur["alt"] or a.get("alt") or ""
            self.cur["img"] = self.cur["img"] or a.get("data-src") or a.get("data-original") or a.get("src") or ""

    def handle_endtag(self, tag):
        if tag == "a" and self.cur is not None:
            self.links.append(self.cur)
            self.cur = None
        for i in range(len(self.stack) - 1, -1, -1):
            if self.stack[i][0] == tag:
                del self.stack[i:]
                break

    def handle_data(self, data):
        if self.cur is not None:
            self.cur["text"] += data


def headlines(page: str, base: str, count: int) -> list:
    p = Links()
    p.feed(page)
    host = urllib.parse.urlsplit(base).netloc.replace("www.", "")

    def norm(l):
        u = urllib.parse.urljoin(base, html.unescape(l["href"]))
        if host not in urllib.parse.urlsplit(u).netloc or not ARTICLE.search(urllib.parse.urlsplit(u).path):
            return None
        title = re.sub(r"\s+", " ", l["title"] or l["alt"] or l["text"]).strip()
        return {"url": u.split("#")[0], "title": title, "image": urllib.parse.urljoin(base, l["img"]) if l["img"] else "", "ctx": l["ctx"]}

    links = [x for x in (norm(l) for l in p.links) if x]
    # 1) manşet bloğu: link atalarından manşet/slider adlı en dış kapsayıcıyı bul, o gruptaki ilk linkler
    groups: dict = {}
    for x in links:
        key = next((c for c in x["ctx"] if BLOCK.search(c)), None)
        if key:
            groups.setdefault(key, []).append(x)
    chosen = []
    for key, items in groups.items():  # sözlük sırası = sayfada ilk görünme sırası
        uniq = list({i["url"]: i for i in items}.values())
        if len(uniq) >= 3:
            chosen = uniq
            break
    # 2) yedek: görselli ilk haber linkleri
    if not chosen:
        chosen = list({x["url"]: x for x in links if x["image"]}.values()) or list({x["url"]: x for x in links}.values())
    out = [{k: v for k, v in x.items() if k != "ctx"} for x in chosen[:count]]
    # haber değeri (YouTube kuralı ve üretim önceliği): ölüm, kaza, asgari ücret, zam… → valuable
    from news_value import score
    kw = (settings().get("youtubePolicy") or {}).get("extraKeywords")
    from breaking_watch import match_produced, source_count
    for x in out:
        srcs = sorted(set(source_count(x["title"])) | {"Mynet"})
        v = score(x["title"], kw)
        x["valuable"], x["valueReason"], x["sources"] = v["valuable"], v["reason"], srcs
        if len(srcs) > 1:
            x["valueReason"] += f" · {len(srcs)} kaynakta"
        # bu haberin videosu üretildi mi (üretilen haber hafızası; manşette özet yok: başlık + adres). Panel burada yalnız adres
        # eşleşmesinde atlar (genel başlık aynı ildeki başka olayı da tutar); sayfa okununca --article başlık + açıklama + gövdeyle karar verir
        m = match_produced(x["title"], url=x["url"])
        x["dup"], x["dupInfo"] = bool(m), m
    return out


# meta etiketi: tırnaklı değerin içindeki <, > ya da kesme işareti etiketi bölmez (content="<CANLI> …" tam okunur); tırnaklı değer
# yalnız "<meta" geçemez, bozuk etiket (kaçmamış tırnak: content="Bakan: "Vergi…">) eski düz bölmeyle ilk >'de biter, sonraki
# og:title/og:image etiketlerini yutmaz
_META_TAG = re.compile(r"<meta\b(?:[^<>\"']|\"(?:[^\"<]|<(?!meta\b))*\"|'(?:[^'<]|<(?!meta\b))*')*>|<meta\b[^>]*>", re.I)


def _meta(page: str, *names, keys: str = "property|name") -> str:
    # değer açılış tırnağıyla kapanır: content="Kadıköy'de …" kesme işaretinde kesilmez (Türkçe başlıklarda çok sık; eskiden
    # og:title "Kadıköy" olarak okunuyordu — Mynet, son dakika siteleri ve haber araması başlık/özetleri)
    for tag in _META_TAG.findall(page):
        k = re.search(rf'(?:{keys})\s*=\s*(["\'])(.*?)\1', tag, re.I | re.S)
        v = re.search(r'content\s*=\s*(["\'])(.*?)\1', tag, re.I | re.S)
        if k and v and k.group(2).lower() in names and v.group(2).strip():
            return html.unescape(v.group(2)).strip()
    return ""


def _clean(t: str) -> str:
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", t or ""))).strip()


def _ld_items(page: str):
    for blob in re.findall(r'<script[^>]+application/ld\+json[^>]*>(.*?)</script>', page, re.S | re.I):
        try:
            data = json.loads(blob.strip())
        except Exception:
            continue
        for d in (data if isinstance(data, list) else data.get("@graph", [data]) if isinstance(data, dict) else []):
            if isinstance(d, dict):
                yield d


def _paragraphs(page: str) -> str:
    """Makale gövdesi: itemprop=articleBody / article etiketi içindeki paragraflar; yoksa sayfadaki uzun paragraflar."""
    page = re.sub(r"<(script|style|noscript|figure|aside|nav|footer)\b.*?</\1>", " ", page, flags=re.S | re.I)
    m = re.search(r'<(div|section|article)\b[^>]*itemprop=["\']articleBody["\'][^>]*>', page, re.I) \
        or re.search(r'<(div|section)\b[^>]*class=["\'][^"\']*(?:article[-_]?(?:body|content|text|detail)|news[-_]?(?:body|content|text|detail)|haber[-_]?(?:detay|metin|icerik)|content[-_]?(?:body|text)|post[-_]?content|entry[-_]?content|detail[-_]?(?:body|content|text))[^"\']*["\'][^>]*>', page, re.I) \
        or re.search(r"<article\b[^>]*>", page, re.I)
    scopes = [page[m.start():m.start() + 60000]] if m else []
    scopes.append(page)
    for scope in scopes:
        paras = [_clean(p) for p in re.findall(r"<p\b[^>]*>(.*?)</p>", scope, re.S | re.I)]
        text = " ".join(p for p in paras if len(p) > 50 and not re.search(r"(çerez|cookie|abone ol|tüm hakları|copyright|whatsapp kanal|google news)", p, re.I))
        if len(text) > 200:
            return text
    return ""


def article(url: str) -> dict:
    page = get(url)
    body = headline = desc_ld = site = ""
    for d in _ld_items(page):
        if not body and d.get("articleBody"):
            body = _clean(str(d["articleBody"]))
        if not headline and d.get("headline") and re.search(r"(Article|Posting|Report)", str(d.get("@type", ""))):
            headline = _clean(str(d["headline"]))
            desc_ld = _clean(str(d.get("description") or ""))
        pub = d.get("publisher")
        if not site and isinstance(pub, dict) and pub.get("name"):
            site = _clean(str(pub["name"]))
    if len(body) < 200:
        body = _paragraphs(page) or body
    title = _meta(page, "og:title", "twitter:title") or headline or _clean((re.search(r"<title>(.*?)</title>", page, re.S | re.I) or [None, ""])[1])
    desc = _meta(page, "og:description", "description", "twitter:description") or desc_ld
    site = _meta(page, "og:site_name") or site
    return {"url": url, "title": html.unescape(title).strip(), "description": desc, "body": re.sub(r"\s+", " ", body).strip()[:3000],
            "image": _meta(page, "og:image", "twitter:image"), "site": site}


def check() -> dict:
    items = headlines(get(CFG["url"]), CFG["url"], int(CFG["count"]))
    st = load_json(STATE, {})
    first = "seen" not in st
    seen = st.get("seen", {})
    new = [] if first else [i for i in items if i["url"] not in seen]
    now = time.strftime("%Y-%m-%dT%H:%M:%S")
    for i in items:
        seen.setdefault(i["url"], now)
    # eski kayıtlar 7 günden sonra silinir
    cutoff = time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(time.time() - 7 * 86400))
    seen = {u: t for u, t in seen.items() if t >= cutoff}
    save_json(STATE, {"seen": seen, "lastCheck": now, "items": items})
    return {"ok": True, "first": first, "items": items, "new": new}


def with_dup(a: dict) -> dict:
    """Okunan habere tekrar engeli: başlık + açıklama + gövde + adresle üretilen haber hafızasına bakılır (kullanıcı isteği,
    18 Ekim: "ürettiğimiz haberi tekrar yakalamayalım"); panel otomatik yolda dup ise üretmez."""
    from breaking_watch import match_produced
    m = match_produced(a.get("title") or "", " ".join(x for x in (a.get("description"), a.get("body")) if x), a.get("url") or "") if a.get("title") else None
    return {**a, "dup": bool(m), "dupInfo": m}


if __name__ == "__main__":
    try:
        if "--article" in sys.argv:
            out = with_dup(article(sys.argv[sys.argv.index("--article") + 1]))
        elif "--list" in sys.argv:
            out = {"ok": True, "items": headlines(get(CFG["url"]), CFG["url"], int(CFG["count"]))}
        else:
            out = check()
    except Exception as e:
        out = {"ok": False, "error": str(e)[:300]}
    print(json.dumps(out, ensure_ascii=False))
