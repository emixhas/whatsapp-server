#!/usr/bin/env python3
"""Türkçe haber RSS kaynaklarından son başlıkları toplar. Dış API veya anahtar gerektirmez.

Kullanım: python3 scripts/fetch_news.py work/news.json
"""
import json
import ssl
import sys
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from html import unescape
import re

FEEDS = [
    ("AA", "https://www.aa.com.tr/tr/rss/default?cat=guncel"),
    ("TRT Haber", "https://www.trthaber.com/manset_articles.rss"),
    ("NTV", "https://www.ntv.com.tr/gundem.rss"),
    ("BBC Türkçe", "https://feeds.bbci.co.uk/turkce/rss.xml"),
]
MAX_PER_FEED = 12
UA = "Mozilla/5.0 (gundem-video; +local)"


def ssl_context():
    """python.org Python'u macOS'ta sistem sertifikalarını görmez; certifi varsa onu kullan."""
    try:
        import certifi
        return ssl.create_default_context(cafile=certifi.where())
    except ImportError:
        return ssl.create_default_context()


CTX = ssl_context()


def strip_html(s: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", "", unescape(s or ""))).strip()


def parse_date(s: str):
    try:
        d = parsedate_to_datetime(s)
        return d.astimezone(timezone.utc).isoformat()
    except Exception:
        return None


def fetch(source: str, url: str):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=20, context=CTX) as r:
        root = ET.fromstring(r.read())
    items = []
    for it in root.iter("item"):
        title = strip_html(it.findtext("title", ""))
        if not title:
            continue
        items.append({
            "source": source,
            "title": title,
            "summary": strip_html(it.findtext("description", ""))[:400],
            "link": (it.findtext("link") or "").strip(),
            "published": parse_date(it.findtext("pubDate", "")),
        })
        if len(items) >= MAX_PER_FEED:
            break
    return items


def main(out_path: str):
    all_items, errors = [], []
    for source, url in FEEDS:
        try:
            all_items += fetch(source, url)
        except Exception as e:  # kaynak düşerse diğerleri devam eder
            errors.append(f"{source}: {e}")
    # Aynı başlığı farklı kaynaklardan tekrar etme
    seen, unique = set(), []
    for it in all_items:
        key = re.sub(r"\W+", "", it["title"].lower())[:60]
        if key in seen:
            continue
        seen.add(key)
        unique.append(it)
    unique.sort(key=lambda x: x["published"] or "", reverse=True)
    payload = {"fetched_at": datetime.now(timezone.utc).isoformat(), "errors": errors, "items": unique}
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    print(f"{len(unique)} haber, {len(errors)} hata -> {out_path}")
    for e in errors:
        print("  !", e, file=sys.stderr)
    if not unique:
        sys.exit(1)


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "work/news.json")
