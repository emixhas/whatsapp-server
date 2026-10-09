#!/usr/bin/env python3
"""Haftalık performans raporu (WhatsApp metni): son 7 günün videoları, platform toplamları, en çok izlenen 5 video
(platformu ve linkiyle), en iyi kategori/saat/format, anlık ve düzenli karşılaştırması, önceki haftayla fark ve öneriler.
Panel her pazartesi `weeklyReport.hour`da çağırır; WhatsApp "haftalık rapor" da çalıştırır.

  python3 scripts/weekly_report.py            # son JSON satırı: {"ok", "text", "file", "summary"}
"""
import json
import sys
from collections import defaultdict
from datetime import date, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from analyze import video_rows  # noqa: E402
from common import DATA  # noqa: E402

PLAT = {"youtube": ("YouTube", "yt_views"), "instagram": ("Instagram", "ig_views"), "tiktok": ("TikTok", "tt_views")}
CAT = {"finans": "Ekonomi", "siyaset": "Siyaset", "parti": "Siyaset", "asayis": "Asayiş", "spor": "Spor", "hava": "Hava",
       "toplum": "Toplum", "egitim": "Eğitim", "teknoloji": "Teknoloji", "saglik": "Sağlık", "dunya": "Dünya", "genel": "Gündem"}


def fmt(n):
    return f"{int(n or 0):,}".replace(",", ".")


def week_rows(rows, start, end):
    return [r for r in rows if r.get("date") and start <= r["date"] <= end]


def best(groups):
    g = {k: sum(v) / len(v) for k, v in groups.items() if v}
    return max(g.items(), key=lambda x: x[1]) if g else None


def main():
    today = date.today()
    start, end = (today - timedelta(days=7)).isoformat(), (today - timedelta(days=1)).isoformat()
    pstart, pend = (today - timedelta(days=14)).isoformat(), (today - timedelta(days=8)).isoformat()
    rows = video_rows()
    week, prev = week_rows(rows, start, end), week_rows(rows, pstart, pend)
    total, ptotal = sum(r["views"] for r in week), sum(r["views"] for r in prev)
    lines = [f"📊 *Haftalık rapor* ({start} – {end})", ""]
    lines.append(f"🎬 {len(week)} video üretildi, toplam {fmt(total)} izlenme"
                 + (f" (önceki hafta {fmt(ptotal)}, {'+' if total >= ptotal else ''}{round((total - ptotal) / ptotal * 100)}%)" if ptotal else ""))
    plats = {}
    for p, (name, key) in PLAT.items():
        vids = [r for r in week if r["published"].get(p)]
        views = sum(r.get(key) or 0 for r in vids)
        plats[p] = views
        if vids:
            lines.append(f"• {name}: {len(vids)} video, {fmt(views)} izlenme, ortalama {fmt(views / len(vids))}")
    lead = max(plats.items(), key=lambda x: x[1]) if any(plats.values()) else None
    if lead:
        lines.append(f"🏆 En çok izlenen platform: *{PLAT[lead[0]][0]}*")
    top = sorted([r for r in week if r["views"]], key=lambda r: r["views"], reverse=True)[:5]
    if top:
        lines += ["", "🔝 *En çok izlenenler*"]
        for i, r in enumerate(top, 1):
            bp = max(PLAT, key=lambda p: r.get(PLAT[p][1]) or 0)
            url = r["urls"].get(bp) or next(iter(r["urls"].values()), "")
            lines.append(f"{i}. {r.get('publishTitle') or r.get('firstTitle') or r['name']} — {fmt(r['views'])} ({PLAT[bp][0]} önde)" + (f"\n   {url}" if url else ""))
    by_cat, by_hour, kind = defaultdict(list), defaultdict(list), defaultdict(list)
    for r in week:
        if not r["views"]:
            continue
        for c in set(r["categories"]):
            by_cat[c].append(r["views"])
        if r["hour"] is not None:
            by_hour[r["hour"]].append(r["views"])
        kind["anlık" if r.get("format") == "anlik" else "düzenli"].append(r["views"])
    bc, bh = best(by_cat), best(by_hour)
    tips = []
    if bc or bh or kind:
        lines += ["", "🔎 *Ne tuttu*"]
        if bc:
            lines.append(f"• En iyi kategori: {CAT.get(bc[0], bc[0])} (video başına {fmt(bc[1])})")
            tips.append(f"{CAT.get(bc[0], bc[0])} haberlerine kancada daha çok yer ver.")
        if bh:
            lines.append(f"• En iyi saat: {bh[0]:02d}:00 civarı (video başına {fmt(bh[1])})")
        for k, v in kind.items():
            lines.append(f"• {k.title()} videolar: ortalama {fmt(sum(v) / len(v))}")
        if kind.get("anlık") and kind.get("düzenli"):
            a, d = sum(kind["anlık"]) / len(kind["anlık"]), sum(kind["düzenli"]) / len(kind["düzenli"])
            tips.append("Anlık haberler düzenli videolardan iyi gidiyor; değerli manşetleri kaçırma." if a > d * 1.2
                        else "Düzenli 5 saatlik videolar anlıklardan iyi gidiyor; anlık sayısını artırmaya gerek yok." if d > a * 1.2 else "")
    if lead and plats[lead[0]] and len([v for v in plats.values() if v]) > 1:
        low = min((p for p in plats if plats[p]), key=lambda p: plats[p])
        if plats[low] < plats[lead[0]] * 0.25:
            tips.append(f"{PLAT[low][0]} geride kalıyor; kapak ve ilk 2 saniyeyi o platformda kontrol et.")
    unpublished = [r for r in week if not any(r["published"].values())]
    if unpublished:
        tips.append(f"{len(unpublished)} video hiçbir platformda yayınlanmadı; yayın bağlantılarını kontrol et.")
    if not week:
        lines.append("Bu hafta video yok. Zamanlayıcı açık mı?")
    elif not total:
        lines.append("İzlenme verisi henüz yok (hesaplar bağlı mı, izlenmeler güncellendi mi?).")
    tips = [t for t in tips if t]
    if tips:
        lines += ["", "💡 *Öneriler*"] + [f"• {t}" for t in tips]
    text = "\n".join(lines)
    out = DATA / "reports" / f"hafta-{today.isoformat()}.md"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(text + "\n", encoding="utf-8")
    summary = (f"Haftalık rapor hazır. Bu hafta {len(week)} video, toplam {fmt(total)} izlenme"
               + (f"; en çok {PLAT[lead[0]][0]} izlendi." if lead else ".") + " Ayrıntıyı WhatsApp'a gönderdim.")
    print(json.dumps({"ok": True, "text": text, "file": str(out), "summary": summary}, ensure_ascii=False))


if __name__ == "__main__":
    main()
