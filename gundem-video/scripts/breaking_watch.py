#!/usr/bin/env python3
"""Çoklu son dakika takibi: Hürriyet, Sözcü, NTV, AA, Habertürk… son dakika RSS akışlarındaki YENİ haberleri bulur,
aynı olayı veren kaynakları birleştirir (tek video) ve video adayı seçer. Mynet manşeti ayrıca mynet_watch.py'de.

Aday kuralı (settings.breaking): haber değerliyse (news_value) YA DA en az `minSources` (3) farklı sitede çıktıysa
(çok konuşulan). 3+ kaynak ayrıca YouTube için değerli sayılır (ANLIK_SOURCE_COUNT → assemble_script).
Videosu üretilmiş haber aday olmaz: üretilen haber hafızası (scripts/news_memory.py, data/breaking_produced.json; HER
videoda assemble_script yazar, pencere settings.dedup.hours, varsayılan 48) adres, başlık ve içerikle (başlık + özet)
karşılaştırır. Burada yalnız adres eşleşmesi (ya da bağlantısız haber) adaydan düşer; başlık/özet eşleşmesi adayda dup +
dupInfo olarak kalır, panel sayfayı okuyunca gövdeyle yeniden bakar (aynı ildeki başka olay başlıktan ayrılamaz), sayfa
okunamazsa bu karara uyar. İlk çalıştırmada her kaynağın mevcut haberleri "görüldü" sayılır.

  python3 scripts/breaking_watch.py --check          # {"ok", "sources": {ad: {ok, count, error}}, "candidates": [...], "dups": [...]}
  python3 scripts/breaking_watch.py --list           # panel için son haberler ve kaynak durumu
  python3 scripts/breaking_watch.py --item LINK      # paneldeki "Video üret" düğmesinin haberi
  python3 scripts/breaking_watch.py --count "başlık" # bu olayı kaç farklı kaynak verdi (son 12 saat)
  python3 scripts/breaking_watch.py --mark "başlık" [--url ADRES] [--text METİN]  # bu haber üretime alındı (sıradayken tekrar yakalanmasın)
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
PRODUCED = DATA / "breaking_produced.json"  # üretilen haber hafızası (news_memory.py; eski [{title, at}] de okunur)
RECENT_H = 12  # son dakika sitelerindeki haberlerin tutulduğu süre (kaynak sayımı); üretilen haber penceresi settings.dedup.hours
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


def match_produced(title: str, text: str = "", url: str = "", hours=None, mode: str = "full", exclude=None):
    """Bu haberin videosu üretildi mi: {video, title, kind, reason, at, ago} ya da None (kullanıcı isteği, 18 Ekim: "ürettiğimiz
    haberi tekrar yakalamayalım"; kurallar scripts/news_memory.py). text: özet/gövde, url: haber adresi — ne kadar bağlam
    verilirse başka sözlerle yazılmış aynı haber o kadar iyi tanınır. mode "title": yalnız başlık, exclude: bu videonun kendi
    kayıtları sayılmaz (viral devam haberi)."""
    from news_memory import match
    return match(title, text, url, hours, mode, exclude)


def already_produced(title: str, text: str = "", url: str = "", hours=None, mode: str = "full", exclude=None) -> bool:
    return match_produced(title, text, url, hours, mode, exclude) is not None


def mark_produced(title: str, url: str = "", text: str = "") -> None:
    from news_memory import mark
    mark(title, url, text)


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
    clusters, dups = [], []
    for f in fresh:
        hit = next((cl for cl in clusters if same_event(cl["title"], f["title"])), None)
        if hit:
            continue
        srcs = source_count(f["title"], st)
        v = score(f"{f['title']} {f['summary'][:200]}", kw)
        multi = len(srcs) >= int(c["minSources"])
        if not (v["valuable"] or multi):
            continue
        # videosu üretilmiş haber aday olmaz (başlık + özet + adres). Yalnız adres eşleşmesi (ya da sayfası okunamayacak bağlantısız
        # haber) burada düşer; başlık/özet eşleşmesi adayda kalır (dup), panel sayfa gövdesiyle karar verir: genel başlık ("Konya'da
        # yolcu otobüsü devrildi") aynı ildeki başka olayı da tutar, kullanıcı isteği 18 Ekim: "ürettiğimiz haberi tekrar yakalamayalım"
        m = match_produced(f["title"], f["summary"], f["link"])
        if m and (m["reason"] == "aynı haber adresi" or not f["link"]):  # panel loga yazar ("… atlandı — …"); aynı video için bir kez
            if not any(d["video"] == m["video"] and d["matched"] == m["title"] for d in dups):
                dups.append({"title": f["title"], "source": f["source"], "video": m["video"], "matched": m["title"], "ago": m["ago"], "reason": m["reason"]})
            continue
        clusters.append({"title": f["title"], "url": f["link"], "source": f["source"], "summary": f["summary"],
                         "sources": srcs, "count": len(srcs), "valuable": v["valuable"],
                         "valueReason": v["reason"] + (f" · {len(srcs)} kaynakta" if len(srcs) > 1 else ""), "dup": bool(m), "dupInfo": m})
    clusters.sort(key=lambda x: (x["valuable"], x["count"]), reverse=True)
    return {"ok": True, "sources": status, "fresh": len(fresh), "candidates": clusters, "dups": dups[:5]}


def listing() -> dict:
    st = load_json(STATE, {})
    rec = sorted(recent_items(st), key=lambda i: i.get("at", 0), reverse=True)
    from news_value import score
    kw = (settings().get("youtubePolicy") or {}).get("extraKeywords")
    items = [i for i in rec if i["source"] != "Mynet"][:20]
    out = []
    for i in items:  # panelde her haberin yanında: değerli mi, kaç sitede, bu haberin videosu var mı (hangisi, ne zaman)
        v = score(f"{i['title']} {(i.get('summary') or '')[:200]}", kw)
        m = match_produced(i["title"], i.get("summary") or "", i.get("link") or "")
        out.append({"source": i["source"], "title": i["title"], "link": i["link"], "valuable": v["valuable"], "valueReason": v["reason"],
                    "sources": source_count(i["title"], st), "produced": bool(m), "producedInfo": m})
    marks = load_json(PRODUCED, [])
    return {"ok": True, "sources": st.get("status", {}), "lastCheck": st.get("lastCheck"), "recent": out,
            "produced": [{k: p.get(k) for k in ("title", "at", "video", "kind")} for p in (marks if isinstance(marks, list) else [])[-10:] if isinstance(p, dict)]}


def find_recent(link: str):
    """Panelden seçilen haber (bağlantısıyla); başlık ve özet istemciden değil kayıttan alınır."""
    for i in recent_items():
        if i["source"] != "Mynet" and link and i.get("link") == link:
            m = match_produced(i["title"], i.get("summary") or "", link)
            return {**i, "sources": source_count(i["title"]), "produced": bool(m), "producedInfo": m}
    return None


if __name__ == "__main__":
    try:
        if "--mark" in sys.argv:  # panel bir adayı üretime aldığında (kuyrukta beklerken tekrar seçilmesin)
            arg = lambda k: sys.argv[sys.argv.index(k) + 1] if k in sys.argv else ""  # noqa: E731
            mark_produced(arg("--mark"), arg("--url"), arg("--text"))
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
