#!/usr/bin/env python3
"""Çoklu son dakika takibi: Hürriyet, Sözcü, NTV, AA, Habertürk… son dakika RSS akışlarındaki YENİ haberleri bulur,
aynı olayı veren kaynakları birleştirir (tek video) ve video adayı seçer. Mynet manşeti ayrıca mynet_watch.py'de.

Aday kuralı (settings.breaking): haber değerliyse (news_value) YA DA en az `minSources` (3) farklı sitede çıktıysa
(çok konuşulan). 3+ kaynak ayrıca YouTube için değerli sayılır (ANLIK_SOURCE_COUNT → assemble_script).
Aynı olay için son 12 saatte video üretildiyse (data/breaking_produced.json; her anlık üretimde assemble_script
yazar) aday olmaz. İlk çalıştırmada her kaynağın mevcut haberleri "görüldü" sayılır.

  python3 scripts/breaking_watch.py --check          # {"ok", "sources": {ad: {ok, count, error}}, "candidates": [...]}
  python3 scripts/breaking_watch.py --list           # panel için son haberler ve kaynak durumu
  python3 scripts/breaking_watch.py --item LINK      # paneldeki "Video üret" düğmesinin haberi
  python3 scripts/breaking_watch.py --count "başlık" # bu olayı kaç farklı kaynak verdi (son 12 saat)
  python3 scripts/breaking_watch.py --mark "başlık"  # bu olay için video üretiliyor (tekrar engeli)
"""
import json
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import DATA, load_json, save_json, settings  # noqa: E402

STATE = DATA / "breaking_state.json"       # {seen: {link: ts}, recent: [{source, title, link, at}], status: {...}}
PRODUCED = DATA / "breaking_produced.json"  # [{title, at}] — üretilmiş anlık videolar (tekrar engeli)
RECENT_H = 12
DEFAULT_SOURCES = [
    {"name": "Hürriyet", "url": "https://www.hurriyet.com.tr/rss/anasayfa"},
    {"name": "Sözcü", "url": "https://www.sozcu.com.tr/feeds-son-dakika"},
    {"name": "NTV", "url": "https://www.ntv.com.tr/son-dakika.rss"},
    {"name": "AA", "url": "https://www.aa.com.tr/tr/rss/default?cat=guncel"},
    {"name": "Habertürk", "url": "https://www.haberturk.com/rss/manset.xml"},
]
STOP = {"için", "ile", "olan", "olarak", "sonra", "daha", "göre", "yeni", "oldu", "etti", "dedi", "açıkladı", "haber",
        "son", "dakika", "flaş", "gelişme", "açıklama", "neler", "nedir", "belli"}


def cfg() -> dict:
    c = {"enabled": True, "intervalMin": 15, "perSource": 8, "minSources": 3, "maxPerDay": 4, "duration": 30,
         "sources": DEFAULT_SOURCES}
    c.update(settings().get("breaking") or {})
    return c


def low(t: str) -> str:
    return (t or "").replace("I", "ı").replace("İ", "i").lower()


def stems(t: str) -> set:
    """Türkçe ekleri kabaca atmak için kelimenin ilk 5 harfi (deprem/depremde/depremin → depre)."""
    return {w[:5] for w in re.sub(r"[^\wçğıöşü\s]", " ", low(t)).split() if len(w) > 3 and w not in STOP and not w.isdigit()}


def same_event(a: str, b: str) -> bool:
    x, y = stems(a), stems(b)
    if not x or not y:
        return False
    common = len(x & y)
    return common >= 4 or (common >= 2 and common / len(x | y) >= 0.34)


def _now() -> float:
    return time.time()


def recent_items(st=None) -> list:
    st = st if st is not None else load_json(STATE, {})
    items = [i for i in st.get("recent", []) if _now() - i.get("at", 0) < RECENT_H * 3600]
    # Mynet manşeti de çok kaynak sayımına girer
    for m in (load_json(DATA / "mynet_state.json", {}).get("items") or []):
        items.append({"source": "Mynet", "title": m.get("title", ""), "link": m.get("url", ""), "at": _now()})
    return items


def source_count(title: str, st=None) -> list:
    """Bu olayı veren farklı kaynak adları."""
    return sorted({i["source"] for i in recent_items(st) if same_event(title, i.get("title", ""))})


def already_produced(title: str) -> bool:
    return any(_now() - p.get("at", 0) < RECENT_H * 3600 and same_event(title, p.get("title", ""))
               for p in load_json(PRODUCED, []))


def mark_produced(title: str) -> None:
    lst = [p for p in load_json(PRODUCED, []) if _now() - p.get("at", 0) < 48 * 3600]
    lst.append({"title": title, "at": _now()})
    save_json(PRODUCED, lst)


def fetch_source(src: dict, n: int) -> list:
    from fetch_news import fetch
    return fetch(src["name"], src["url"])[:n]


def check() -> dict:
    from news_value import score
    c = cfg()
    st = load_json(STATE, {})
    seen, status = st.get("seen", {}), st.get("status", {})
    recent = [i for i in st.get("recent", []) if _now() - i.get("at", 0) < RECENT_H * 3600]
    fresh = []
    for src in c["sources"]:
        name = src["name"]
        try:
            items = fetch_source(src, int(c["perSource"]))
            status[name] = {"ok": True, "count": len(items), "at": _now()}
        except Exception as e:
            status[name] = {"ok": False, "error": str(e)[:160], "at": _now()}
            continue
        first = not any(k.startswith(name + "|") for k in seen)
        for it in items:
            key = f"{name}|{it['link'] or it['title']}"
            if key in seen:
                continue
            seen[key] = _now()
            entry = {"source": name, "title": it["title"], "link": it["link"], "summary": it.get("summary", ""), "at": _now()}
            recent.append(entry)
            pub = it.get("published")
            too_old = False
            if pub:
                try:
                    too_old = (datetime.now(timezone.utc) - datetime.fromisoformat(pub)).total_seconds() > 3 * 3600
                except Exception:
                    pass
            if not first and not too_old:
                fresh.append(entry)
    st.update({"seen": {k: v for k, v in seen.items() if _now() - v < 7 * 86400}, "recent": recent[-400:],
               "status": status, "lastCheck": _now()})
    save_json(STATE, st)
    kw = (settings().get("youtubePolicy") or {}).get("extraKeywords")
    # aynı olayı veren yeni haberleri tek adayda topla
    clusters = []
    for f in fresh:
        hit = next((cl for cl in clusters if same_event(cl["title"], f["title"])), None)
        if hit:
            continue
        srcs = source_count(f["title"], st)
        v = score(f"{f['title']} {f['summary'][:200]}", kw)
        multi = len(srcs) >= int(c["minSources"])
        if already_produced(f["title"]):
            continue
        if not (v["valuable"] or multi):
            continue
        clusters.append({"title": f["title"], "url": f["link"], "source": f["source"], "summary": f["summary"],
                         "sources": srcs, "count": len(srcs), "valuable": v["valuable"],
                         "valueReason": v["reason"] + (f" · {len(srcs)} kaynakta" if len(srcs) > 1 else "")})
    clusters.sort(key=lambda x: (x["valuable"], x["count"]), reverse=True)
    return {"ok": True, "sources": status, "fresh": len(fresh), "candidates": clusters}


def listing() -> dict:
    st = load_json(STATE, {})
    rec = sorted(recent_items(st), key=lambda i: i.get("at", 0), reverse=True)
    from news_value import score
    kw = (settings().get("youtubePolicy") or {}).get("extraKeywords")
    items = [i for i in rec if i["source"] != "Mynet"][:20]
    out = []
    for i in items:  # panelde her haberin yanında: değerli mi, kaç sitede, bu olay için video var mı
        v = score(f"{i['title']} {(i.get('summary') or '')[:200]}", kw)
        out.append({"source": i["source"], "title": i["title"], "link": i["link"], "valuable": v["valuable"], "valueReason": v["reason"],
                    "sources": source_count(i["title"], st), "produced": already_produced(i["title"])})
    return {"ok": True, "sources": st.get("status", {}), "lastCheck": st.get("lastCheck"), "recent": out,
            "produced": load_json(PRODUCED, [])[-10:]}


def find_recent(link: str):
    """Panelden seçilen haber (bağlantısıyla); başlık ve özet istemciden değil kayıttan alınır."""
    for i in recent_items():
        if i["source"] != "Mynet" and link and i.get("link") == link:
            return {**i, "sources": source_count(i["title"]), "produced": already_produced(i["title"])}
    return None


if __name__ == "__main__":
    try:
        if "--mark" in sys.argv:  # panel bir adayı üretime aldığında (kuyrukta beklerken tekrar seçilmesin)
            mark_produced(sys.argv[sys.argv.index("--mark") + 1])
            out = {"ok": True}
        elif "--count" in sys.argv:
            t = sys.argv[sys.argv.index("--count") + 1]
            s = source_count(t)
            out = {"ok": True, "sources": s, "count": len(s), "produced": already_produced(t)}
        elif "--item" in sys.argv:
            it = find_recent(sys.argv[sys.argv.index("--item") + 1])
            out = {"ok": bool(it), "item": it} if it else {"ok": False, "error": "Haber listede yok (12 saatten eski olabilir); \"Şimdi kontrol et\"e basın."}
        elif "--list" in sys.argv:
            out = listing()
        else:
            out = check()
    except Exception as e:
        out = {"ok": False, "error": str(e)[:300]}
    print(json.dumps(out, ensure_ascii=False))
