#!/usr/bin/env python3
"""Elle verilen son dakika talimatı için haberin kendisini bulur (Claude bilgi uydurmasın diye).

Kullanım:
  python3 scripts/news_lookup.py --url URL       haber linki: sayfayı okur (başlık, özet, metin, site adı)
  python3 scripts/news_lookup.py --topic "KONU" [--pages 8]   kısa konu: haberi arar, en iyi eşleşenin sayfasını okur

--topic şu kaynaklarda arar: son çekilen RSS (work/news.json), son dakika siteleri ve Mynet manşeti
(breaking_watch.recent_items), Bing Haberler RSS (doğrudan haber linki verir) ve Google Haberler RSS (yalnız
başlık + kaynak; linki yönlendirme olduğu için okunmaz, ilgili haber olarak eklenir). Son 7 günden eski
haber sayılmaz. Eşleşme: konudaki anlamlı kelimelerin 4 harflik kökleri; kelimelerin en az %60'ı başlık ya da
özette geçmeli (tek kelimelik konuda o kelime). Çıktı JSON:
  {"ok": true, "found": true, "best": {title, description, body, site, url}, "related": [{k, b, o, s}],
   "pages": [{url, source}]}   pages = okunabilen haber sayfaları (en çok 4, `--pages` ile 8): video segmentleri fotoğraf ve videoyu
   bu sayfalardan sırayla alır (kanca + ilk haber ana haberden), böylece görüntüler farklı sitelerden gelir.
Bulunamazsa found=false; panel o zaman kısa konuyla video üretmez, link ya da ayrıntı ister.
"""
import html
import json
import re
import sys
import time
import urllib.parse
from concurrent.futures import ThreadPoolExecutor
from email.utils import parsedate_to_datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import ROOT  # noqa: E402
from mynet_watch import article, get  # noqa: E402
from topic_news import stems  # noqa: E402

MAX_AGE_DAYS = 7


def site_name(url: str, page_site: str = "") -> str:
    if page_site:
        return page_site
    host = urllib.parse.urlparse(url).netloc.lower()
    return re.sub(r"^(www\d?|m|amp|mobil)\.", "", host)


def read(url: str) -> dict:
    if not re.match(r"^https?://", url or ""):
        return {"ok": False, "error": "geçerli bir haber linki değil"}
    try:
        a = article(url)
    except Exception as e:
        return {"ok": False, "error": f"sayfa açılamadı ({str(e)[:120]})"}
    text = " ".join(x for x in (a.get("description"), a.get("body")) if x)
    if not a.get("title") or len(text) < 60:
        return {"ok": False, "error": "sayfada haber metni bulunamadı", "title": a.get("title", "")}
    a["site"] = site_name(url, a.get("site", ""))
    a["ok"] = True
    return a


def _age_ok(pub: str) -> bool:
    if not pub:
        return True
    try:
        ts = parsedate_to_datetime(pub).timestamp()
    except Exception:
        try:
            ts = time.mktime(time.strptime(pub[:19], "%Y-%m-%dT%H:%M:%S"))
        except Exception:
            return True
    return time.time() - ts < MAX_AGE_DAYS * 86400


def _tag(block: str, name: str) -> str:
    m = re.search(rf"<{name}\b[^>]*>(.*?)</{name}>", block, re.S | re.I)
    if not m:
        return ""
    v = re.sub(r"^<!\[CDATA\[(.*)\]\]>$", r"\1", m.group(1).strip(), flags=re.S)
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", html.unescape(v)))).strip()


def parse_bing(xml: str) -> list:
    out = []
    for block in re.findall(r"<item>(.*?)</item>", xml, re.S | re.I):
        link = html.unescape(_tag(block, "link"))
        q = urllib.parse.parse_qs(urllib.parse.urlparse(link).query)
        url = (q.get("url") or [link])[0]
        out.append({"title": _tag(block, "title"), "summary": _tag(block, "description"), "url": url,
                    "source": _tag(block, "News:Source") or site_name(url), "published": _tag(block, "pubDate"), "direct": True})
    return out


def parse_google(xml: str) -> list:
    out = []
    for block in re.findall(r"<item>(.*?)</item>", xml, re.S | re.I):
        src = _tag(block, "source")
        title = _tag(block, "title")
        if src and title.endswith(" - " + src):
            title = title[: -len(src) - 3]
        out.append({"title": title, "summary": "", "url": _tag(block, "link"), "source": src or "Google Haberler",
                    "published": _tag(block, "pubDate"), "direct": False})
    return out


def local_items() -> list:
    out = []
    try:
        for it in json.load(open(ROOT / "work" / "news.json", encoding="utf-8")).get("items", []):
            out.append({"title": it.get("title", ""), "summary": it.get("summary", ""), "url": it.get("link", ""),
                        "source": it.get("source", ""), "published": it.get("published", ""), "direct": True})
    except Exception:
        pass
    try:
        from breaking_watch import recent_items
        for it in recent_items():
            out.append({"title": it.get("title", ""), "summary": it.get("summary", ""), "url": it.get("link", ""),
                        "source": it.get("source", ""), "published": "", "direct": True})
    except Exception:
        pass
    return out


def search(topic: str, max_pages: int = 4) -> dict:
    kw = stems(topic)
    if not kw:
        return {"ok": True, "found": False, "related": [], "errors": ["konu çok kısa"]}
    q = urllib.parse.quote(re.sub(r"\s+", " ", topic).strip()[:120])
    items, errors = local_items(), []
    for name, url, parser in (("Bing Haberler", f"https://www.bing.com/news/search?q={q}&format=rss&setlang=tr&cc=TR", parse_bing),
                              ("Google Haberler", f"https://news.google.com/rss/search?q={q}&hl=tr&gl=TR&ceid=TR:tr", parse_google)):
        try:
            items += parser(get(url))
        except Exception as e:
            errors.append(f"{name}: {str(e)[:80]}")
    need = 1 if len(kw) == 1 else max(2, int(len(kw) * 0.6 + 0.999))
    scored, seen = [], set()
    for it in items:
        key = re.sub(r"\W+", "", it["title"].lower())[:60]
        if not it["title"] or key in seen or not _age_ok(it.get("published", "")):
            continue
        s = len(kw & stems(f"{it['title']} {it['summary']}"))
        if s >= need:
            seen.add(key)
            scored.append((s, it))
    scored.sort(key=lambda x: (x[0], x[1]["direct"]), reverse=True)
    related = [{"k": it["source"], "b": it["title"], "o": it["summary"][:300], "s": ""} for _, it in scored[:8]]
    # En iyi N (varsayılan 4; otomatik son dakikada 8 — "haberin tüm kaynakları") doğrudan linkin sayfası aynı anda okunur:
    # ilki ana haber, hepsi fotoğraf/video kaynağı (pages); aynı siteden ikinci sayfa alınmaz (farklı siteler, farklı görüntü)
    cands, hosts = [], set()
    for _, it in scored:
        host = site_name(it["url"]) if it["direct"] and it["url"] else ""
        if host and host not in hosts:
            hosts.add(host)
            cands.append(it)
        if len(cands) >= max_pages:
            break
    with ThreadPoolExecutor(max_workers=min(8, max(1, len(cands)))) as ex:
        reads = list(ex.map(lambda it: (it, read(it["url"])), cands))
    best, pages = None, []
    for it, a in reads:
        if not a.get("ok"):
            continue
        site = a.get("site") or it.get("source") or site_name(it["url"])
        pages.append({"url": it["url"], "source": site})
        for r in related:
            if r["b"] == it["title"]:
                r["k"], r["o"] = site, " ".join(x for x in (a.get("description"), a.get("body")) if x)[:500]
        if not best:
            best = {k: a.get(k, "") for k in ("title", "description", "body", "url", "image")}
            best["site"] = site
    if not best and scored:  # sayfa okunamadı ama haber başlıkları var: başlık + özetle yetin
        it = scored[0][1]
        if it["summary"] or len(scored) >= 2:
            best = {"title": it["title"], "description": it["summary"], "body": "", "site": it["source"],
                    "url": it["url"] if it["direct"] else "", "image": ""}
    return {"ok": True, "found": bool(best), "best": best, "related": related, "pages": pages, "errors": errors, "matched": len(scored)}


if __name__ == "__main__":
    try:
        if "--url" in sys.argv:
            out = read(sys.argv[sys.argv.index("--url") + 1])
        elif "--topic" in sys.argv:
            mp = int(sys.argv[sys.argv.index("--pages") + 1]) if "--pages" in sys.argv else 4
            out = search(sys.argv[sys.argv.index("--topic") + 1], max(1, min(8, mp)))
        else:
            out = {"ok": False, "error": "kullanım: --url URL | --topic KONU"}
    except Exception as e:
        out = {"ok": False, "error": str(e)[:300]}
    print(json.dumps(out, ensure_ascii=False))
