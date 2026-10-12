#!/usr/bin/env python3
"""Viral alarmı: 24 saatten genç bir video, son 20 videonun (24 saatten eski) ortanca toplam izlenmesinin
`settings.viral.ratio` (3) katını ve en az `minViews` (200) izlenmeyi geçtiyse bir kez bildirilir
(data/viral.json). Aynı olayla ilgili video yayınlandıktan SONRA düşmüş yeni bir haber varsa (son dakika/Mynet
taraması, breaking_watch.recent_items; daha önce üretilmemiş) devam videosu adayı döner; panel onu değerli haber
toplayıcısına verir. Yeni bilgi yoksa devam videosu üretilmez (aynı haberi tekrar anlatmak izleyiciyi kaçırır).

  python3 scripts/viral_watch.py   # son satır JSON {viral: [{video, title, views, ratio, url, followUp}]}
"""
import json
import statistics
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import DATA, episode_meta, load_json, metrics, now_iso, save_json, settings  # noqa: E402

FILE = DATA / "viral.json"
PLATS = ("youtube", "instagram", "tiktok")


def _dt(s):
    try:
        return datetime.fromisoformat(s).astimezone(timezone.utc)
    except Exception:
        return None


def main():
    cfg = {"enabled": True, "ratio": 3, "minViews": 200, "followUp": True, **(settings().get("viral") or {})}
    if not cfg["enabled"]:
        print(json.dumps({"viral": [], "skipped": "kapalı"}))
        return
    now = datetime.now(timezone.utc)
    rows = []
    for name, v in (metrics().get("videos") or {}).items():
        pubs = [_dt(v[p].get("publishedAt")) for p in PLATS if isinstance(v.get(p), dict) and v[p].get("publishedAt")]
        pubs = [p for p in pubs if p]
        if not pubs:
            continue
        per = {p: int(v[p].get("views") or 0) for p in PLATS if isinstance(v.get(p), dict)}
        rows.append({"name": name, "pub": min(pubs), "views": sum(per.values()), "per": per,
                     "urls": {p: v[p].get("url") for p in PLATS if isinstance(v.get(p), dict) and v[p].get("url")}})
    old = sorted((r for r in rows if now - r["pub"] > timedelta(hours=24)), key=lambda r: r["pub"], reverse=True)[:20]
    if len(old) < 5:
        print(json.dumps({"viral": [], "note": f"karşılaştırma için en az 5 eski video gerekir (şu an {len(old)})"}, ensure_ascii=False))
        return
    base = max(1, statistics.median(r["views"] for r in old))
    seen = load_json(FILE, {}) or {}
    out = []
    for r in rows:
        age = (now - r["pub"]).total_seconds() / 3600
        if age > 24 or r["name"] in seen or r["views"] < cfg["minViews"] or r["views"] < base * cfg["ratio"]:
            continue
        meta = episode_meta(r["name"]) or {}
        if meta.get("format") in ("gunluk", "haftalik"):
            continue
        titles = [s.get("title", "") for s in meta.get("segments", []) if s.get("kind") == "haber"]
        best = max(r["per"], key=r["per"].get) if r["per"] else None
        item = {"video": r["name"], "title": meta.get("publishTitle") or (titles[0] if titles else r["name"]), "views": r["views"],
                "ratio": round(r["views"] / base, 1), "baseline": round(base), "ageHours": round(age, 1), "platform": best,
                "url": r["urls"].get(best) if best else None, "followUp": None}
        if cfg["followUp"] and titles:
            try:
                from breaking_watch import already_produced, recent_items, same_event
                pub_ts = r["pub"].timestamp()
                cands = [i for i in recent_items() if i.get("at", 0) > pub_ts and any(same_event(t, i.get("title", "")) for t in titles[:2])
                         and not already_produced(i.get("title", ""))]
                if cands:
                    c = cands[-1]
                    item["followUp"] = {"title": c["title"], "source": c.get("source"), "url": c.get("link"),
                                        "text": f"Önceki videomuzdaki haberin devamı: {titles[0]}. Yeni gelişme: {c['title']}. {(c.get('summary') or '')[:600]}"}
            except Exception as e:
                item["followUpError"] = str(e)[:120]
        seen[r["name"]] = {"at": now_iso(), "views": r["views"], "ratio": item["ratio"]}
        out.append(item)
    save_json(FILE, {k: v for k, v in seen.items() if _dt(v.get("at")) and now - _dt(v["at"]) < timedelta(days=14)})
    print(json.dumps({"viral": out, "baseline": round(base)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
