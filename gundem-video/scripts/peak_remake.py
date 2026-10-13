#!/usr/bin/env python3
"""En çok izlenen saatlerde tekrar (kullanıcı isteği: "en çok izlenen 3 saatte, günün en çok izlenen haberini sırasıyla
farklı şekilde, mümkünse farklı görsellerle yeniden 30 saniyelik yayınlasın").

  python3 scripts/peak_remake.py --plan     # en çok izlenen yayın saatleri (izlenme verisinden; az veride varsayılan)
  python3 scripts/peak_remake.py --pick     # şu an yeniden yayınlanacak video (son 24 saatin en çok izleneni)
  python3 scripts/peak_remake.py --status   # plan + bugün yapılanlar

Saatler: uzun olmayan (Shorts) videoların yayın saatine göre toplam izlenme ortalaması, komşu saatlerle yumuşatılır
(0,5 · önceki + sonraki); aday saat kendi verisi olan (en az `minPerHour` 2 video) saattir, 24 saatten genç videolar
(izlenmesi oturmadı) sayılmaz. `fromHour`-`toHour` (08-23) arasındaki en iyi `count` (3) saat, aralarında en az
`minGapHours` (3) saat; eksik kalırsa varsayılanlarla tamamlanır. İzlenme verili video `minVideos`ten (12) azsa `defaultHours` (12, 18, 21: öğle arası ve akşam) kullanılır.

Seçim ("sırasıyla"): son 24 saatte üretilmiş, en az `minViews` izlenmeli videolardan en çok izleneni; bugün (son 24 saat)
bu özellikle ya da elle yeniden yayınlanmış haberler (aynı olay, `breaking_watch.same_event`) atlanır. Böylece 1. saatte
günün 1 numaralı haberi, 2. saatte henüz tekrarlanmamış en çok izlenen haber… Kayıt `data/peak_remake.json` (panel yazar).
"""
import json
import sys
import time
from collections import defaultdict
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from analyze import LONG, video_rows  # noqa: E402
from common import DATA, OUT, load_json, settings  # noqa: E402

STATE = DATA / "peak_remake.json"


def cfg() -> dict:
    return {"enabled": True, "count": 3, "defaultHours": [12, 18, 21], "fromHour": 8, "toHour": 23, "minGapHours": 3,
            "minVideos": 12, "minPerHour": 2, "minViews": 10, "duration": 30, "leadMin": 20, **(settings().get("peakRemake") or {})}


def plan() -> dict:
    c = cfg()
    n_want = max(1, min(5, int(c["count"])))
    now = time.time()
    # 24 saatten genç videoların izlenmesi henüz oturmadı; saat hesabına girmez
    rows = [r for r in video_rows() if r["hour"] is not None and r.get("format") not in LONG and r["views"] > 0
            and now - _made_at(r["name"], {"date": r.get("date"), "timeLabel": r.get("time")}) > 86400]
    by = defaultdict(list)
    for r in rows:
        by[r["hour"]].append(r["views"])
    allowed = [h for h in range(24) if int(c["fromHour"]) <= h <= int(c["toHour"])]
    if len(rows) < int(c["minVideos"]):
        hours = sorted(int(h) for h in c["defaultHours"])[:n_want]
        return {"hours": hours, "source": "varsayılan", "videos": len(rows),
                "note": f"İzlenme verili {len(rows)} video var; en az {c['minVideos']} olunca saatler verinizden hesaplanır. Şimdilik öğle arası ve akşam saatleri."}
    mean = {h: sum(v) / len(v) for h, v in by.items()}

    def smooth(h):
        parts = [(mean.get(h), 1.0), (mean.get((h - 1) % 24), 0.5), (mean.get((h + 1) % 24), 0.5)]
        parts = [(v, w) for v, w in parts if v is not None]
        return sum(v * w for v, w in parts) / sum(w for _, w in parts) if parts else None

    # yalnız kendi verisi olan saat aday olur (en az minPerHour video); komşular puanı yumuşatır
    scored = sorted(((smooth(h), h) for h in allowed if len(by.get(h, [])) >= int(c["minPerHour"])), reverse=True)
    hours = []
    for sc, h in scored:
        if all(min(abs(h - x), 24 - abs(h - x)) >= int(c["minGapHours"]) for x in hours):
            hours.append(h)
        if len(hours) == n_want:
            break
    for h in sorted(int(x) for x in c["defaultHours"]):  # veri yetmezse varsayılanla tamamla
        if len(hours) >= n_want:
            break
        if all(min(abs(h - x), 24 - abs(h - x)) >= int(c["minGapHours"]) for x in hours):
            hours.append(h)
    detail = [{"hour": h, "avg": round(smooth(h) or 0), "n": len(by.get(h, []))} for h in hours]
    return {"hours": sorted(hours), "source": "izlenme verisi", "videos": len(rows), "detail": detail}


def _made_at(name: str, meta: dict) -> float:
    try:
        return datetime.strptime(f"{meta.get('date')} {meta.get('timeLabel')}", "%Y-%m-%d %H:%M").timestamp()
    except Exception:
        p = OUT / name
        return p.stat().st_mtime if p.exists() else 0.0


def pick() -> dict:
    from breaking_watch import same_event
    c = cfg()
    now = time.time()
    done = [d for d in (load_json(STATE, {}) or {}).get("done", []) if now - float(d.get("at") or 0) < 86400 and d.get("name")]
    metas = {}
    for f in OUT.glob("*.json"):
        m = load_json(f, {}) or {}
        if m.get("segments"):
            metas[f.stem + ".mp4"] = m
    # son 24 saatte (elle ya da bu özellikle) yeniden yayınlanmış videolar ve onların haberleri
    remade = {d["name"] for d in done} | {m["remakeOf"] for n, m in metas.items() if m.get("remakeOf") and now - _made_at(n, m) < 86400}
    remade_titles = [d.get("title", "") for d in done] + [r["firstTitle"] or "" for r in video_rows() if r["name"] in remade]
    cands, skipped = [], 0
    for r in video_rows():
        m = metas.get(r["name"])
        # zamana bağlı şablon videolar (piyasa, takvim, zam/rekor, derleme) yeniden yayınlanmaz
        if not m or r.get("format") in LONG or m.get("archived") or m.get("infoKind") in ("piyasa", "takvim", "alarm", "derleme") or not (OUT / r["name"]).exists():
            continue
        if now - _made_at(r["name"], m) > 86400:
            continue
        title = r["firstTitle"] or r.get("publishTitle") or ""
        if r["name"] in remade or (m.get("remakeOf") in remade) or any(t and same_event(title, t) for t in remade_titles):
            skipped += 1
            continue
        cands.append((r["views"], r["name"], title))
    cands.sort(reverse=True)
    if not cands:
        why = "son 24 saatte yeniden yayınlanmamış video yok" if skipped else "son 24 saatte üretilmiş video yok"
        return {"ok": False, "reason": why}
    views, name, title = cands[0]
    if views < int(c["minViews"]):
        return {"ok": False, "reason": f"günün en çok izlenen videosu ({title[:60]}) {views} izlenmede, en az {c['minViews']} gerekiyor"}
    return {"ok": True, "video": name, "title": title, "views": views, "rank": 1, "others": len(cands) - 1}


if __name__ == "__main__":
    try:
        if "--pick" in sys.argv:
            out = pick()
        elif "--status" in sys.argv:
            st = load_json(STATE, {}) or {}
            day = time.strftime("%Y-%m-%d")
            out = {"ok": True, "plan": plan(), "cfg": cfg(), "today": [d for d in st.get("done", []) if d.get("day") == day]}
        else:
            out = {"ok": True, **plan()}
    except Exception as e:
        out = {"ok": False, "reason": str(e)[:300]}
    print(json.dumps(out, ensure_ascii=False))
