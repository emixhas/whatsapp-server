#!/usr/bin/env python3
"""Haftanın özeti için haber listesi: son 7 günde videolara girmiş haberler (zaten seçilmiş, önemli). Aynı olay
birleşir (breaking_watch.same_event); sıra: değerli/son dakika → kaç videoda işlendiği → izlenme. Claude'a giden liste
work/news_prompt.json'a, haber sayfası adresleri (fotoğraf/video için) work/news.json'a eklenir.

  python3 scripts/weekly_news.py work/news.json work/news_prompt.json 10
"""
import sys
from datetime import date, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from breaking_watch import same_event  # noqa: E402
from common import OUT, load_json, metrics, save_json  # noqa: E402
from news_value import score as value_score  # noqa: E402

GUN = ["Pazartesi", "Salı", "Çarşamba", "Perşembe", "Cuma", "Cumartesi", "Pazar"]


def week_segments(days=7) -> list:
    start = (date.today() - timedelta(days=days - 1)).isoformat()
    vids = metrics().get("videos", {})
    out = []
    for f in sorted(OUT.glob("*.json")):
        meta = load_json(f, {}) or {}
        d = meta.get("date") or f.name[:10]
        if d < start or meta.get("format") in ("gunluk", "haftalik") or not f.name[:4].isdigit():
            continue
        v = vids.get(f.stem + ".mp4", {})
        views = sum(int((v.get(p) or {}).get("views") or 0) for p in ("youtube", "instagram", "tiktok"))
        try:
            gun = GUN[date.fromisoformat(d).weekday()]
        except ValueError:
            gun = ""
        for s in meta.get("segments", []):
            if s.get("kind") != "haber" or not s.get("title"):
                continue
            out.append({"title": s["title"], "summary": s.get("narration", ""), "source": s.get("source") or meta.get("sourceName") or "",
                        "category": s.get("category"), "link": s.get("articleUrl") or meta.get("sourceUrl") or "", "image": s.get("imageUrl") or "",
                        "breaking": bool(s.get("breaking")), "views": views, "day": gun, "date": d})
    return out


def main(news_path: str, dst: str, n: int):
    segs = week_segments()
    clusters = []
    for it in segs:
        hit = next((c for c in clusters if same_event(c["title"], it["title"])), None)
        if hit:
            hit["count"] += 1
            hit["views"] += it["views"]
            hit["breaking"] = hit["breaking"] or it["breaking"]
            if it["date"] > hit["date"]:  # olayın en son hali (gelişen haber) anlatılsın
                hit.update({k: it[k] for k in ("title", "summary", "date", "day") if it.get(k)})
            if not hit.get("link") and it.get("link"):
                hit["link"] = it["link"]
            continue
        v = value_score(f"{it['title']} {(it.get('summary') or '')[:200]}")
        clusters.append({**it, "count": 1, "valuable": v["valuable"]})
    clusters.sort(key=lambda c: (c["breaking"] or c["valuable"], c["count"], c["views"]), reverse=True)
    chosen = clusters[:max(n * 2, n + 4)]
    slim = [{"b": c["title"], "o": (c.get("summary") or "")[:300], "k": c.get("source") or "", "g": c.get("day") or "",
             "c": c["count"], "i": c["views"], "d": 1 if (c["breaking"] or c["valuable"]) else 0, "kat": c.get("category") or ""} for c in chosen]
    save_json(Path(dst), {"aciklama": "b=başlık o=özet (videomuzdaki anlatım) k=kaynak g=haftanın hangi günü c=kaç videoda işlendi "
                                     "(yüksek = haftanın gelişen olayı) i=izlenme d=1 değerli/son dakika kat=kategori",
                          "hafta": f"{(date.today() - timedelta(days=6)).isoformat()} – {date.today().isoformat()}", "haberler": slim})
    rss = load_json(news_path, {}).get("items", [])
    have = {r.get("link") for r in rss}
    extra = [{"source": c.get("source") or "", "title": c["title"], "summary": (c.get("summary") or "")[:400], "link": c["link"],
              "image": c.get("image") or None, "published": None} for c in chosen if c.get("link") and c["link"] not in have]
    if extra:
        save_json(Path(news_path), {**load_json(news_path, {}), "items": rss + extra})
    print(f"haftanın özeti: {len(segs)} haber son 7 günün videolarından → {len(clusters)} olay, {len(slim)} tanesi Claude'a gidiyor "
          f"(değerli/son dakika: {sum(s['d'] for s in slim)})")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2], int(sys.argv[3]) if len(sys.argv) > 3 else 10)
