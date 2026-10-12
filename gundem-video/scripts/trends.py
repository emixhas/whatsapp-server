#!/usr/bin/env python3
"""Google Trends Türkiye: şu an en çok aranan konular (https://trends.google.com/trending/rss?geo=TR).
30 dakika önbellek (data/trends.json). Haber seçimi (slim_news) aranan konuya uyan habere "t":1 koyar ve önceliklendirir,
assemble_script videoya giren aranan ifadeyi hashtag yapar, panel son dakika kartında listeler.

  python3 scripts/trends.py            # önbellekten ya da canlı; son satır JSON {ok, items:[{term, traffic, news}]}
  python3 scripts/trends.py --refresh  # önbelleği yok say
"""
import json
import re
import sys
import time
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import DATA, load_json, save_json  # noqa: E402

URL = "https://trends.google.com/trending/rss?geo=TR"
FILE = DATA / "trends.json"
CACHE_S = 30 * 60
STOP = {"ve", "ile", "mi", "ne", "nedir", "son", "dakika", "haber", "haberleri", "bugün", "canlı", "maç", "izle"}


def low(t: str) -> str:
    return (t or "").replace("I", "ı").replace("İ", "i").lower()


def stems(t: str) -> list:
    return [w[:5] for w in re.findall(r"[\wçğıöşü]+", low(t)) if len(w) >= 3 and w not in STOP]


def parse(xml: bytes) -> list:
    root = ET.fromstring(xml)
    out = []
    for it in root.iter("item"):
        term = (it.findtext("title") or "").strip()
        if not term:
            continue
        get = lambda el, name: next((c.text or "" for c in el if c.tag.endswith(name)), "")  # noqa: E731 (ht: ad alanı)
        news = [get(n, "news_item_title").strip() for n in it if n.tag.endswith("news_item")]
        out.append({"term": term, "traffic": get(it, "approx_traffic").strip(), "news": [n for n in news if n][:3]})
    return out


def fetch(refresh=False) -> dict:
    cache = load_json(FILE, {}) or {}
    if not refresh and cache.get("items") and time.time() - cache.get("at", 0) < CACHE_S:
        return {"ok": True, "cached": True, **cache}
    try:
        req = urllib.request.Request(URL, headers={"User-Agent": "Mozilla/5.0 (Macintosh) gundem-video"})
        with urllib.request.urlopen(req, timeout=15) as r:
            items = parse(r.read())
        data = {"at": time.time(), "items": items[:25]}
        save_json(FILE, data)
        return {"ok": True, **data}
    except Exception as e:  # erişilemezse eski liste (varsa) kullanılır
        return {"ok": False, "error": str(e)[:200], **cache}


def match(text: str, items: list) -> list:
    """Metne uyan aranan ifadeler: ifadenin anlamlı kelimelerinin hepsi metinde (5 harflik kök) geçmeli."""
    have = set(stems(text))
    hits = []
    for it in items:
        need = stems(it["term"])
        if need and all(w in have for w in need):
            hits.append(it["term"])
    return hits


def current() -> list:
    """Önbellekteki liste (2 saatten eskiyse boş): haber seçimi ağ beklemesin."""
    c = load_json(FILE, {}) or {}
    return c.get("items", []) if time.time() - c.get("at", 0) < 2 * 3600 else []


if __name__ == "__main__":
    r = fetch("--refresh" in sys.argv)
    print(json.dumps(r, ensure_ascii=False))
