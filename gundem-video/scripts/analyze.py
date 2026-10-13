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
    # mp4'ü disk temizliğinde silinmiş (arşivlenmiş) videolar da analize girer: kaydı (json) kalır
    names = {p.name for p in OUT.glob("*.mp4")} | {f.stem + ".mp4" for f in OUT.glob("*.json") if (load_json(f, {}) or {}).get("archived")}
    for p in sorted(OUT / n for n in names):
        meta = episode_meta(p.name) or {}
        mv = m["videos"].get(p.name, {})
        yt, ig, tt = mv.get("youtube", {}), mv.get("instagram", {}), mv.get("tiktok", {})
        # haberin değer penceresi ilk 3 gün (sync_metrics): 72 saati geçen videonun "3. gün" değeri kullanılır
        yt, ig, tt = ({**x, "views": x["views72h"]} if x.get("views72h") is not None else x for x in (yt, ig, tt))
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


LONG = ("gunluk", "haftalik")  # yatay uzun videolar saat analizine girmez (yayın saatleri sabit)


def best_hours(rows: list) -> dict:
    """En iyi yayın saati: platform başına saat ortalaması (en az 2 video) ve 5 saatlik slotları kaydırma önerisi.
    Öneri yalnızca yeterli veri (15+ izlenmeli düzenli video) ve en az %15 kazanç varsa verilir; komşu saatler
    yumuşatılır (tek videonun şansı öneriyi belirlemesin)."""
    regular = [r for r in rows if r["hour"] is not None and r.get("format") not in LONG]
    per = {}
    for pl, key in (("youtube", "yt_views"), ("instagram", "ig_views"), ("tiktok", "tt_views")):
        by = defaultdict(list)
        for r in regular:
            if r.get(key):
                by[r["hour"]].append(r[key])
        per[pl] = sorted(({"hour": h, "avg": avg(v), "n": len(v)} for h, v in by.items() if len(v) >= 2), key=lambda x: -x["avg"])[:3]
    by = defaultdict(list)
    for r in regular:
        if r["views"]:
            by[r["hour"]].append(r["views"])
    n = sum(len(v) for v in by.values())
    out = {"platforms": per, "videos": n, "suggestion": None}
    sch = load_json(DATA / "schedule.json", {})
    hours = int(sch.get("hours") or 5)
    slots = sch.get("slots") or list(range(0, 24, hours))
    out["slots"] = slots
    if n < 15:
        out["note"] = f"Öneri için en az 15 izlenme verili video gerekir (şu an {n})."
        return out
    mean = {h: sum(v) / len(v) for h, v in by.items()}

    def smooth(h):
        vals = [mean[x % 24] for x in (h - 1, h, h + 1) if x % 24 in mean]
        return sum(vals) / len(vals) if vals else None

    def score(off):
        vals = [smooth((s + off) % 24) for s in slots]
        vals = [v for v in vals if v is not None]
        return sum(vals) / len(vals) if len(vals) >= max(2, len(slots) - 1) else None  # verisi olmayan saat "iyi" sayılmasın

    cur = score(0)
    cands = [(off, score(off)) for off in range(-(hours // 2), hours // 2 + 1) if off]
    cands = [(o, sc) for o, sc in cands if sc is not None]
    if cur and cands:
        off, sc = max(cands, key=lambda x: x[1])
        gain = round((sc - cur) / cur * 100)
        if gain >= 15:
            out["suggestion"] = {"offset": off, "slots": sorted((s + off) % 24 for s in slots), "gainPct": gain,
                                 "text": f"Üretim saatlerini {abs(off)} saat {'ileri' if off > 0 else 'geri'} almak izlenmeyi ~%{gain} artırabilir "
                                         f"({', '.join(f'{h:02d}:00' for h in sorted((s + off) % 24 for s in slots))})."}
    return out


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
    top = sorted(with_data, key=lambda r: -r["views"])[:10]
    # Platform analizi: toplam, video başına ortalama, platformun en çok izlenen videosu; her videonun en güçlü platformu
    PL = (("youtube", "yt_views"), ("instagram", "ig_views"), ("tiktok", "tt_views"))
    by_platform = {}
    for pl, key in PL:
        vals = [(r, r.get(key) or 0) for r in rows if r.get(key)]
        best = max(vals, key=lambda x: x[1]) if vals else None
        by_platform[pl] = {"total": sum(v for _, v in vals), "videos": len(vals), "avg": round(sum(v for _, v in vals) / len(vals)) if vals else 0,
                           "best": {"name": best[0]["name"], "title": best[0]["firstTitle"], "views": best[1], "url": (best[0].get("urls") or {}).get(pl)} if best else None,
                           "top": [{"name": r["name"], "title": r["firstTitle"], "views": v, "url": (r.get("urls") or {}).get(pl)} for r, v in sorted(vals, key=lambda x: -x[1])[:3]]}
    for r in rows:
        per = {pl: r.get(key) or 0 for pl, key in PL}
        r["bestPlatform"] = max(per, key=per.get) if any(per.values()) else None
    leader = max(by_platform, key=lambda k: by_platform[k]["total"]) if any(v["total"] for v in by_platform.values()) else None
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
    # izleyici tutma (scripts/retention.py): izleyicinin ayrıldığı bölüm senaryo ipucuna girer
    retention = (load_json(DATA / "retention.json", {}) or {}).get("summary") or {}
    if retention.get("videos", 0) >= 3:
        hints = (retention.get("hints") or []) + hints  # önce: az token modunda ipucu 300 karakterde kesilir
    hint_text = " ".join(hints) if hints else "Henüz yeterli performans verisi yok; kuralları uygula."

    sugg = load_json(DATA / "category_suggestions.json", {}) if "load_json" in globals() else {}
    insights = {
        "categorySuggestions": sugg,
        "generatedAt": now_iso(), "videoCount": len(rows), "publishedCount": sum(1 for r in rows if any(r["published"].values())),
        "withDataCount": len(with_data), "totalViews": sum(r["views"] for r in rows),
        "byCategory": cat_avg, "byDuration": dur_avg, "byHour": hour_avg, "byTitleVariant": var_avg, "byFormat": fmt_avg,
        "breakingAvg": breaking_avg, "normalAvg": normal_avg,
        "top": [{k: r.get(k) for k in ("name", "firstTitle", "views", "yt_views", "ig_views", "tt_views", "bestPlatform", "categories", "targetDuration", "urls")} for r in top],
        "byPlatform": by_platform, "leadingPlatform": leader, "bestHours": best_hours(rows), "retention": retention,
        "hint": hint_text, "rows": rows,
    }
    try:  # abone/takipçi: güncel, bugün, 7 gün, 30 gün, günlük seri (scripts/followers.py)
        from followers import summary as followers_summary
        insights["followers"] = followers_summary()
    except Exception as e:
        insights["followers"] = {"error": str(e)[:200]}
    save_json(DATA / "insights.json", insights)
    (DATA / "prompt_hint.txt").write_text(hint_text, encoding="utf-8")
    print(json.dumps({k: v for k, v in insights.items() if k != "rows"}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
