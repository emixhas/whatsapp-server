#!/usr/bin/env python3
"""Mynet manşet takibi: ana sayfadaki manşet alanının (en çok 6 haber) yeni girenlerini bulur.

Kullanım:
  python3 scripts/mynet_watch.py --list            manşetteki haberler (JSON)
  python3 scripts/mynet_watch.py --check           yeni girenler; ilk çalıştırmada mevcutları "görüldü" sayar
  python3 scripts/mynet_watch.py --article URL     haberin başlığı, özeti, metni ve görseli (JSON)

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
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept-Language": "tr-TR,tr;q=0.9"})
    with urllib.request.urlopen(req, timeout=20, context=CTX) as r:
        raw = r.read(4 * 1024 * 1024)
        cs = r.headers.get_content_charset() or "utf-8"
    return raw.decode(cs, "replace")


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
    for x in out:
        v = score(x["title"], kw)
        x["valuable"], x["valueReason"] = v["valuable"], v["reason"]
    return out


def _meta(page: str, *names) -> str:
    for tag in re.findall(r"<meta\b[^>]*>", page, re.I):
        k = re.search(r'(?:property|name)\s*=\s*["\']([^"\']+)', tag, re.I)
        v = re.search(r'content\s*=\s*["\']([^"\']*)', tag, re.I)
        if k and v and k.group(1).lower() in names and v.group(1).strip():
            return html.unescape(v.group(1)).strip()
    return ""


def article(url: str) -> dict:
    page = get(url)
    body = ""
    for blob in re.findall(r'<script[^>]+application/ld\+json[^>]*>(.*?)</script>', page, re.S | re.I):
        try:
            data = json.loads(blob.strip())
        except Exception:
            continue
        for d in (data if isinstance(data, list) else data.get("@graph", [data]) if isinstance(data, dict) else []):
            if isinstance(d, dict) and d.get("articleBody"):
                body = html.unescape(re.sub(r"<[^>]+>", " ", str(d["articleBody"])))
                break
        if body:
            break
    if not body:
        paras = [re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", p))).strip() for p in re.findall(r"<p\b[^>]*>(.*?)</p>", page, re.S | re.I)]
        body = " ".join(p for p in paras if len(p) > 50)[:3000]
    title = _meta(page, "og:title", "twitter:title") or (re.search(r"<title>(.*?)</title>", page, re.S | re.I) or [None, ""])[1]
    desc = _meta(page, "og:description", "description", "twitter:description")
    return {"url": url, "title": html.unescape(title).strip(), "description": desc, "body": re.sub(r"\s+", " ", body).strip()[:3000],
            "image": _meta(page, "og:image", "twitter:image")}


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


if __name__ == "__main__":
    try:
        if "--article" in sys.argv:
            out = article(sys.argv[sys.argv.index("--article") + 1])
        elif "--list" in sys.argv:
            out = {"ok": True, "items": headlines(get(CFG["url"]), CFG["url"], int(CFG["count"]))}
        else:
            out = check()
    except Exception as e:
        out = {"ok": False, "error": str(e)[:300]}
    print(json.dumps(out, ensure_ascii=False))
