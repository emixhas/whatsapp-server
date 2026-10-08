#!/usr/bin/env python3
"""Performans analizi: hangi kategori, süre ve saat tutuyor? data/insights.json + prompt ipucu üretir."""
import json
import sys
from collections import defaultdict
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import load_json, DATA, OUT, episode_meta, metrics, now_iso, save_json  # noqa: E402


def video_rows():
    m = metrics()
    rows = []
    for p in sorted(OUT.glob("*.mp4")):
        meta = episode_meta(p.name) or {}
        mv = m["videos"].get(p.name, {})
        yt, ig, tt = mv.get("youtube", {}), mv.get("instagram", {}), mv.get("tiktok", {})
        haber = [s for s in meta.get("segments", []) if s.get("kind") == "haber"]
        rows.append({
            "name": p.name, "date": meta.get("date"), "time": meta.get("timeLabel"),
            "hour": int(meta["timeLabel"].split(":")[0]) if meta.get("timeLabel") else None,
            "duration": round(sum(s.get("duration", 0) for s in meta.get("segments", []))),
            "targetDuration": meta.get("targetDuration"),
            "categories": [h.get("category", "genel") for h in haber],
            "breaking": any(h.get("breaking") for h in haber),
            "firstTitle": haber[0]["title"] if haber else None,
            "titleVariant": meta.get("titleVariant"), "publishTitle": meta.get("publishTitle"),
            "format": meta.get("format"),
            "published": {"youtube": bool(yt.get("id")), "instagram": bool(ig.get("id")), "tiktok": bool(tt.get("publish_id"))},
            "yt_views": yt.get("views"), "yt_likes": yt.get("likes"),
            "ig_views": ig.get("views"), "ig_likes": ig.get("likes"), "ig_shares": ig.get("shares"), "ig_saves": ig.get("saves"),
            "tt_views": tt.get("views"), "tt_likes": tt.get("likes"), "tt_shares": tt.get("shares"),
            "views": (yt.get("views") or 0) + (ig.get("views") or 0) + (tt.get("views") or 0),
            "urls": {k: v.get("url") for k, v in (("youtube", yt), ("instagram", ig), ("tiktok", tt)) if v.get("url")},
        })
    return rows


def avg(xs):
    xs = [x for x in xs if x is not None]
    return round(sum(xs) / len(xs)) if xs else None


def main():
    rows = video_rows()
    with_data = [r for r in rows if r["views"] > 0]
    by_cat, by_dur, by_hour, by_var, by_fmt = defaultdict(list), defaultdict(list), defaultdict(list), defaultdict(list), defaultdict(list)
    for r in with_data:
        for c in set(r["categories"]):
            by_cat[c].append(r["views"])
        if r["targetDuration"]:
            by_dur[str(r["targetDuration"])].append(r["views"])
        if r["hour"] is not None:
            by_hour[f"{r['hour']:02d}"].append(r["views"])
        if r.get("titleVariant"):
            by_var[r["titleVariant"]].append(r["views"])
        if r.get("format"):
            by_fmt[r["format"]].append(r["views"])
    cat_avg = {k: avg(v) for k, v in by_cat.items()}
    dur_avg = {k: avg(v) for k, v in by_dur.items()}
    hour_avg = {k: avg(v) for k, v in by_hour.items()}
    var_avg = {k: avg(v) for k, v in by_var.items()}
    fmt_avg = {k: avg(v) for k, v in by_fmt.items()}
    top = sorted(with_data, key=lambda r: -r["views"])[:5]
    breaking_avg = avg([r["views"] for r in with_data if r["breaking"]])
    normal_avg = avg([r["views"] for r in with_data if not r["breaking"]])

    # Senaryo prompt'una ipucu (Claude okur). Veri yoksa nötr.
    hints = []
    if len(with_data) >= 3:
        best_cats = sorted(cat_avg.items(), key=lambda kv: -(kv[1] or 0))[:3]
        if best_cats:
            hints.append("En çok izlenen kategoriler: " + ", ".join(f"{k} (~{v})" for k, v in best_cats) + ". Uygun haber varsa bunlara öncelik ver.")
        if breaking_avg and normal_avg and breaking_avg > normal_avg * 1.3:
            hints.append("SON DAKİKA manşetli videolar belirgin daha çok izleniyor; gerçekten büyük bir haber varsa manşet ver.")
        if var_avg.get("A") and var_avg.get("B"):
            better = "A" if var_avg["A"] >= var_avg["B"] else "B"
            hints.append(f"Başlık stili {better} ({'haberci, somut' if better == 'A' else 'merak uyandıran'}) daha çok izleniyor; bu stili güçlü yaz.")
        if top and top[0]["firstTitle"]:
            hints.append("En çok tutan açılış başlıkları: " + "; ".join(f"“{r['firstTitle']}”" for r in top[:3]) + ". Benzer netlikte, somut ve kısa açılış başlıkları yaz.")
    hint_text = " ".join(hints) if hints else "Henüz yeterli performans verisi yok; kuralları uygula."

    sugg = load_json(DATA / "category_suggestions.json", {}) if "load_json" in globals() else {}
    insights = {
        "categorySuggestions": sugg,
        "generatedAt": now_iso(), "videoCount": len(rows), "publishedCount": sum(1 for r in rows if any(r["published"].values())),
        "withDataCount": len(with_data), "totalViews": sum(r["views"] for r in rows),
        "byCategory": cat_avg, "byDuration": dur_avg, "byHour": hour_avg, "byTitleVariant": var_avg, "byFormat": fmt_avg,
        "breakingAvg": breaking_avg, "normalAvg": normal_avg,
        "top": [{k: r[k] for k in ("name", "firstTitle", "views", "yt_views", "ig_views", "tt_views", "categories", "targetDuration", "urls")} for r in top],
        "hint": hint_text, "rows": rows,
    }
    save_json(DATA / "insights.json", insights)
    (DATA / "prompt_hint.txt").write_text(hint_text, encoding="utf-8")
    print(json.dumps({k: v for k, v in insights.items() if k != "rows"}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
