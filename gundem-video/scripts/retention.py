#!/usr/bin/env python3
"""İzleyici tutma analizi (kullanıcı kararı: izleyicinin videonun hangi saniyesinde ayrıldığını öğren, senaryoya geri besle).

YouTube Analytics (`yt-analytics.readonly`, eski bağlantıda "Yeniden bağla"): her video için `audienceWatchRatio`
(videonun %1'lik dilimlerinde hâlâ izleyenlerin oranı) ve `averageViewPercentage`. Veri YouTube'da ~2 gün gecikir; yayından
2-28 gün sonraki videolar, 7 günden genç olanlar 2 günde bir yeniden çekilir (`data/retention.json`).

Eğri videonun kendi segment süreleriyle (out/<ad>.json) bölümlere ayrılır: kanca, intro, her haber kartı, kapanış. Özet:
her bölümden sonra kalan izleyici (%), bölüm başına kayıp, ortalama izlenme yüzdesi, en çok kaybedilen bölüm. `analyze.py`
özeti insights'a ve senaryo ipucuna koyar (ör. "izleyicinin %40'ı kancada ayrılıyor: kancayı …").

  python3 scripts/retention.py --sync      # yeni verileri çek + özet
  python3 scripts/retention.py --summary   # yalnız özet
"""
import json
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import DATA, episode_meta, load_json, metrics, save_json  # noqa: E402

FILE = DATA / "retention.json"
LONG = ("gunluk", "haftalik")


def _parse(ts: str):
    try:
        return datetime.fromisoformat(str(ts).replace("Z", "+00:00"))
    except Exception:
        return None


def sync(limit: int = 15) -> dict:
    from publish import yt_service
    ya = yt_service(api=("youtubeAnalytics", "v2"))
    st = load_json(FILE, {}) or {}
    vids = st.setdefault("videos", {})
    now = datetime.now(timezone.utc)
    todo = []
    for name, v in metrics()["videos"].items():
        y = v.get("youtube") or {}
        pub = _parse(y.get("publishedAt", "")) if y.get("id") else None
        if not pub:
            continue
        age = (now - pub).total_seconds() / 86400
        have = vids.get(name) or {}
        stale = time.time() - float(have.get("fetchedAt") or 0) > 2 * 86400
        if 2 <= age <= 28 and (not have or (age < 9 and stale)):
            todo.append((pub, name, y["id"]))
    done, errors = 0, []
    for pub, name, vid in sorted(todo, reverse=True)[:limit]:
        start, end = pub.strftime("%Y-%m-%d"), now.strftime("%Y-%m-%d")
        try:
            curve = ya.reports().query(ids="channel==MINE", startDate=start, endDate=end, metrics="audienceWatchRatio",
                                       dimensions="elapsedVideoTimeRatio", filters=f"video=={vid}").execute().get("rows") or []
            tot = ya.reports().query(ids="channel==MINE", startDate=start, endDate=end, metrics="views,averageViewDuration,averageViewPercentage",
                                     filters=f"video=={vid}").execute().get("rows") or []
        except Exception as e:
            errors.append(f"{name}: {str(e)[:120]}")
            if "403" in str(e) or "insufficient" in str(e).lower():
                break  # izin yok: diğerlerini denemeye gerek yok
            continue
        rec = {"fetchedAt": time.time(), "curve": [[round(float(r[0]), 3), round(float(r[1]), 4)] for r in curve]}
        if tot:
            rec.update({"views": int(tot[0][0]), "avgDur": float(tot[0][1]), "avgPct": float(tot[0][2])})
        vids[name] = rec
        done += 1
    st["updatedAt"] = time.time()
    st["summary"] = summarize(vids)
    save_json(FILE, st)
    return {"ok": not errors or done > 0, "fetched": done, "errors": errors[:3], "summary": st["summary"]}


def at(curve: list, x: float) -> float | None:
    """Eğrinin x (0-1) noktasındaki değeri (doğrusal ara değer)."""
    if not curve:
        return None
    if x <= curve[0][0]:
        return curve[0][1]
    for (x0, y0), (x1, y1) in zip(curve, curve[1:]):
        if x0 <= x <= x1:
            return y0 + (y1 - y0) * ((x - x0) / (x1 - x0) if x1 > x0 else 0)
    return curve[-1][1]


def video_parts(name: str, curve: list) -> dict | None:
    """Her bölümün sonunda kalan izleyici oranı (videonun başına göre, 0-1)."""
    meta = episode_meta(name) or {}
    segs = meta.get("segments") or []
    if not segs or meta.get("format") in LONG or len(curve) < 10:
        return None
    total = sum(float(s.get("duration") or 0) for s in segs)
    base = at(curve, curve[0][0]) or 0
    if total <= 0 or base <= 0:
        return None
    out, t, hi = {}, 0.0, 0
    for s in segs:
        start = t
        t += float(s.get("duration") or 0)
        k = s.get("kind")
        if k == "haber":
            hi += 1
            k = f"haber{hi}"
        out[k] = {"start": min(1.0, at(curve, start / total) / base), "end": min(1.0, at(curve, t / total) / base)}
    return out


def summarize(vids: dict) -> dict:
    parts = [p for p in (video_parts(n, v.get("curve") or []) for n, v in vids.items()) if p]
    if not parts:
        return {"videos": 0}
    mean = lambda xs: round(sum(xs) / len(xs) * 100, 1) if xs else None  # noqa: E731
    keep = {}
    for k in ("hook", "intro", "haber1", "haber2", "haber3", "haber4"):
        xs = [p[k]["end"] for p in parts if k in p]
        if len(xs) >= max(2, len(parts) // 3):
            keep[k] = mean(xs)
    reach = [p["outro"]["start"] for p in parts if "outro" in p]
    loss = {
        "hook": mean([1 - p["hook"]["end"] for p in parts if "hook" in p]),
        "intro": mean([p["intro"]["start"] - p["intro"]["end"] for p in parts if "intro" in p]),
        "haber": mean([p[k]["start"] - p[k]["end"] for p in parts for k in p if k.startswith("haber")]),
        "outro": mean([p["outro"]["start"] - p["outro"]["end"] for p in parts if "outro" in p]),
    }
    pct = [v["avgPct"] for v in vids.values() if v.get("avgPct") is not None]
    worst = max((k for k in loss if loss[k] is not None and k != "outro"), key=lambda k: loss[k], default=None)
    hints = []
    if loss["hook"] is not None and loss["hook"] >= 30:
        hints.append(f"Kancada (ilk saniyeler) izleyici kaybı %{loss['hook']:.0f}: kanca en çarpıcı rakam ya da yerle başlasın, 8 kelimeyi geçmesin, ilk kelimede konu belli olsun.")
    if loss["haber"] is not None and loss["haber"] >= 15:
        hints.append(f"Haber kartı başına izleyici kaybı ~%{loss['haber']:.0f}: her haberin en önemli bilgisi ilk cümlede olsun, cümleler kısa olsun.")
    note = ""
    if loss["intro"] is not None and loss["intro"] >= 10:
        note = f"Intro'da izleyici kaybı %{loss['intro']:.0f} (intro sabit metin; kısaltmak izlenmeyi artırabilir)."
    names = {"hook": "kanca", "intro": "intro", "haber": "haber kartları"}
    return {"videos": len(parts), "avgViewPct": round(sum(pct) / len(pct), 1) if pct else None, "keep": keep,
            "reachOutro": mean(reach), "loss": loss, "worst": names.get(worst), "hints": hints, "note": note}


if __name__ == "__main__":
    try:
        if "--sync" in sys.argv:
            res = sync()
        else:
            res = {"ok": True, "summary": summarize((load_json(FILE, {}) or {}).get("videos") or {})}
    except Exception as e:
        res = {"ok": False, "error": str(e)[:300]}
    print(json.dumps(res, ensure_ascii=False))
