#!/usr/bin/env python3
"""Günlük uzun özet için haber listesi: bugün üretilen videolardaki haberler (zaten seçilmiş, önemli) + günün RSS
haberleri. Aynı olay birleşir (breaking_watch.same_event); sıralama: son dakika/değerli → kaç videoda/kaynakta
geçtiği → RSS önem puanı. Claude'a giden kısa liste work/news_prompt.json'a, haber sayfası adresleri (fotoğraf ve
video için) work/news.json'a eklenir (assemble_script.attach_images eşler).

  python3 scripts/daily_news.py work/news.json work/news_prompt.json 10
"""
import json
import sys
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from breaking_watch import same_event  # noqa: E402
from common import OUT, load_json, save_json  # noqa: E402
from news_value import score as value_score  # noqa: E402
from slim_news import score as rss_score  # noqa: E402


def todays_segments(day: str) -> list:
    out = []
    for f in sorted(OUT.glob(f"{day}-*.json")):
        meta = load_json(f, {})
        if meta.get("format") == "gunluk" or not f.name[len(day) + 1:-5].isdigit():
            continue
        for s in meta.get("segments", []):
            if s.get("kind") != "haber" or not s.get("title"):
                continue
            out.append({"title": s["title"], "summary": s.get("narration", ""), "source": s.get("source") or meta.get("sourceName") or "",
                        "category": s.get("category"), "link": s.get("articleUrl") or meta.get("sourceUrl") or "",
                        "image": s.get("imageUrl") or "", "breaking": bool(s.get("breaking")), "video": f.name, "anlik": bool(meta.get("anlik"))})
    return out


def main(news_path: str, dst: str, n: int):
    day = date.today().isoformat()
    produced = todays_segments(day)
    rss = load_json(news_path, {}).get("items", [])
    clusters = []
    for it in produced + [dict(r, rss=True) for r in rss]:
        hit = next((c for c in clusters if same_event(c["title"], it["title"])), None)
        if hit:
            hit["count"] += 1
            hit["sources"].add(it.get("source") or "")
            hit["breaking"] = hit["breaking"] or it.get("breaking", False)
            if not hit.get("link") and it.get("link"):
                hit["link"] = it["link"]
            continue
        v = value_score(f"{it['title']} {(it.get('summary') or '')[:200]}")
        clusters.append({**it, "breaking": bool(it.get("breaking")), "count": 1, "sources": {it.get("source") or ""}, "valuable": v["valuable"],
                         "p": rss_score(it), "fromVideo": not it.get("rss")})
    clusters.sort(key=lambda c: (c["breaking"] or c["valuable"], c["fromVideo"], c["count"], c["p"]), reverse=True)
    chosen = clusters[:max(n * 2, n + 4)]  # Claude seçsin diye biraz fazlası
    slim = [{"b": c["title"], "o": (c.get("summary") or "")[:260], "k": c.get("source") or "", "c": len(c["sources"] - {""}),
             "v": 1 if c["fromVideo"] else 0, "d": 1 if (c["breaking"] or c["valuable"]) else 0, "kat": c.get("category") or ""} for c in chosen]
    save_json(Path(dst), {"aciklama": "b=başlık o=özet k=kaynak c=kaç kaynakta geçti v=1 bugün kısa videoda işlendi "
                                     "d=1 değerli/son dakika (can kaybı, afet, zam, maaş, tatil…) kat=kategori",
                          "tarih": day, "haberler": slim})
    # attach_images için: haber sayfası adresleri news.json'a (yoksa) eklenir
    have = {r.get("link") for r in rss}
    extra = [{"source": c.get("source") or "", "title": c["title"], "summary": (c.get("summary") or "")[:400], "link": c["link"],
              "image": c.get("image") or None, "published": None} for c in chosen if c.get("link") and c["link"] not in have]
    if extra:
        save_json(Path(news_path), {**load_json(news_path, {}), "items": rss + extra})
    print(f"günün özeti: {len(produced)} haber bugünkü videolardan, {len(rss)} RSS → {len(clusters)} olay, "
          f"{len(slim)} tanesi Claude'a gidiyor (değerli/son dakika: {sum(s['d'] for s in slim)})")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2], int(sys.argv[3]) if len(sys.argv) > 3 else 10)
