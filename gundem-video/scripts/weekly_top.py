#!/usr/bin/env python3
"""Pazar derlemesi (kullanıcı kararı): haftanın en çok izlenen 5 haberi tek 60 saniyelik Shorts'ta, geri sayımla.

Son 7 günün Shorts videoları (uzun özetler, piyasa/takvim kartları ve önceki derlemeler hariç), izlenmeye göre sıralanır
(`analyze.video_rows`: 72 saati geçende "3. gün" değeri); aynı olay (`same_event`) bir kez. Her videonun ilk haber kartının
görüntü alanı (Shorts karesinde 920x560, x=80 y=220) ffmpeg ile kesilir → derlemenin haber segmentinin görüntüsü; kanca
sıralama tablosu kartı. Seslendirme şablondan (Claude yok): "Beşinci sırada, çarşamba günü: <başlık>. <ilk cümle>". Göreli
zaman sözcüğü (dün/yarın) içeren cümle okunmaz, "bugün" o günün adına çevrilir. `settings.weeklyTop` {enabled, weekday 0
(pazar), hour 18, minute 0, count 5}.

  python3 scripts/weekly_top.py --job    # iş klasörü (panel pazar 18:00'de)
  python3 scripts/weekly_top.py --list   # yalnız sıralama
"""
import json
import re
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from analyze import LONG, video_rows  # noqa: E402
from breaking_watch import same_event  # noqa: E402
from common import OUT, ROOT, episode_meta, settings  # noqa: E402
from info_card import DAYS, make_script, new_job, tr_date  # noqa: E402

RANK_WORD = {1: "Birinci", 2: "İkinci", 3: "Üçüncü", 4: "Dördüncü", 5: "Beşinci"}


def cfg() -> dict:
    return {"enabled": True, "weekday": 0, "hour": 18, "minute": 0, "count": 5, "duration": 60, **(settings().get("weeklyTop") or {})}


def pick(n: int) -> list:
    now = time.time()
    rows = []
    for r in video_rows():
        meta = episode_meta(r["name"]) or {}
        if r.get("format") in LONG or meta.get("infoKind") in ("piyasa", "takvim", "derleme") or not r["views"]:
            continue
        if not (OUT / r["name"]).exists():
            continue
        try:
            ts = datetime.strptime(f"{r['date']} {r['time']}", "%Y-%m-%d %H:%M").timestamp()
        except Exception:
            continue
        if now - ts > 7 * 86400:
            continue
        rows.append({**r, "ts": ts, "meta": meta, "title": r.get("firstTitle") or meta.get("publishTitle") or ""})
    rows.sort(key=lambda r: -r["views"])
    out = []
    for r in rows:
        if any(same_event(r["title"], x["title"]) for x in out):
            continue
        out.append(r)
        if len(out) == n:
            break
    return out


def clip(r: dict, dst_dir: Path, i: int) -> dict | None:
    """İlk haber kartının görüntü alanını keser (sessiz, ~8 sn) + bir kare (yedek görsel)."""
    segs = r["meta"].get("segments") or []
    t = 0.0
    for s in segs:
        if s.get("kind") == "haber":
            start, dur = t + 0.7, max(3.0, min(9.0, float(s.get("duration") or 8) - 1.0))
            break
        t += float(s.get("duration") or 0)
    else:
        return None
    src = OUT / r["name"]
    vid, img = dst_dir / f"clip-{i}.mp4", dst_dir / f"clip-{i}.jpg"
    vf = "crop=920:560:80:220,scale=1280:780,setsar=1"
    ok = subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-ss", f"{start:.2f}", "-t", f"{dur:.2f}", "-i", str(src), "-an", "-vf", vf,
                         "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", str(vid)], capture_output=True).returncode == 0
    ok2 = subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-ss", f"{start + 1:.2f}", "-i", str(src), "-frames:v", "1", "-vf",
                          "crop=920:560:80:220,scale=1840:1120", "-q:v", "2", str(img)], capture_output=True).returncode == 0
    if not (ok and ok2 and vid.exists() and img.exists()):
        return None
    return {"video": str(vid.relative_to(ROOT)), "image": str(img.relative_to(ROOT)), "videoDuration": round(dur, 2)}


def summary_sentence(r: dict) -> str:
    h = next((s for s in r["meta"].get("segments") or [] if s.get("kind") == "haber"), None)
    if not h:
        return ""
    first = re.split(r"(?<=[.!?])\s", (h.get("narration") or "").strip())[0]
    if re.search(r"\b(dün|yarın|az önce|şu sıralar|bu sabah|bu akşam)\b", first, re.I) or len(first.split()) > 20:
        return ""
    day = DAYS[datetime.fromtimestamp(r["ts"]).weekday()].lower()
    return re.sub(r"\b[Bb]ugün\b", f"{day} günü", first)


def views_txt(v: int) -> str:
    return f"{v:,}".replace(",", ".")


def build_job() -> dict:
    c = cfg()
    top = pick(int(c["count"]))
    if len(top) < 3:
        return {"ok": False, "error": f"son 7 günde izlenme verili yeterli video yok ({len(top)})"}
    name = f"derleme-{time.strftime('%Y%m%d')}"
    from info_card import JOBS
    d = JOBS / name
    d.mkdir(parents=True, exist_ok=True)
    media = [clip(r, d, i) for i, r in enumerate(top)]
    items = []
    n = len(top)
    for rank in range(n, 0, -1):  # geri sayım: 5 → 1
        r = top[rank - 1]
        day = DAYS[datetime.fromtimestamp(r["ts"]).weekday()].lower()
        sent = summary_sentence(r)
        title = re.sub(r"\s+", " ", r["title"]).strip().rstrip(".")
        spoken_title = re.sub(r"\b[Bb]ugün\b", f"{day} günü", title)
        tw, sw = set(re.findall(r"\w+", spoken_title.lower())), set(re.findall(r"\w+", (sent or "").lower()))
        if sent and len(tw & sw) >= 0.6 * max(1, min(len(tw), len(sw))):
            sent = ""  # ilk cümle başlığın tekrarı
        items.append({"title": title, "narration": f"{RANK_WORD[rank]} sırada {day} gününün haberi: {spoken_title}." + (f" {sent}" if sent else ""),
                      "category": (r.get("categories") or ["genel"])[0], "displayIndex": rank})
    ranking = [{"title": re.sub(r"\s+", " ", r["title"]), "views": views_txt(r["views"])} for r in top]
    rank_card = {"kind": "ranking", "label": "HAFTANIN EN ÇOK İZLENENLERİ", "stamp": tr_date(), "ranking": ranking}
    cards = [rank_card] + [media[rank - 1] or rank_card for rank in range(n, 0, -1)]
    script = make_script(hook_title="HAFTANIN EN ÇOK İZLENENLERİ", hook=f"Haftanın en çok izlenen {n} haberi.", items=items,
                         titles={"A": f"Haftanın en çok izlenen {n} haberi ({tr_date()})", "B": f"Bu hafta en çok bunları izlediniz: 1 numara {top[0]['title'][:40]}",
                                 "cover": "HAFTANIN EN ÇOK İZLENENLERİ"},
                         hashtags=["#haftanınözeti", "#gündem", "#ençokizlenen", "#haber"], importance=4,
                         reason="haftanın en çok izlenenleri", source="Türkiye Gündemi", category="genel")
    keep = {p.name for p in d.glob("clip-*")}
    # new_job klasörü yeniden kurar: klipleri koru
    tmp = {k: (d / k).read_bytes() for k in keep}
    job = new_job(name, script, cards, {"top": [r["name"] for r in top]})
    for k, b in tmp.items():
        (ROOT / job / k).write_bytes(b)
    return {"ok": True, "job": str(job), "top": [{"name": r["name"], "title": r["title"], "views": r["views"]} for r in top],
            "clips": sum(1 for m in media if m)}


if __name__ == "__main__":
    try:
        if "--job" in sys.argv:
            res = build_job()
        else:
            res = {"ok": True, "top": [{"name": r["name"], "title": r["title"], "views": r["views"]} for r in pick(int(cfg()["count"]))]}
    except Exception as ex:
        res = {"ok": False, "error": str(ex)[:300]}
    print(json.dumps(res, ensure_ascii=False))
