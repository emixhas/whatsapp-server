#!/usr/bin/env python3
"""Günün en çok izlenenleri Instagram hikâyesinde (kullanıcı isteği: "günün en çok izlenen haberlerini Instagram'da hikâye at").

Her akşam `settings.igStories.hour` (21:00) son 24 saatin Shorts videoları izlenmeye göre sıralanır (uzun özetler ve Pazar
derlemesi hariç; aynı olay — yeniden yayın dahil — bir kez; son 2 günün hikâyesinde yer alan video tekrar girmez). Hikâyeler
sırayla: 1) sıralama kartı (`InfoCard` ranking, `story` düzeni: başlık, 1-2-3, izlenme), 2) her video (60 sn'den uzunsa son
haber kartının bittiği yerden kesilir, ses yumuşak biter). Instagram API'si hikâyeye bağlantı/anket çıkartması eklemez; hikâye
24 saat sonra kendiliğinden kalkar. Dosyalar `work/stories/<gün>/`, durum `data/ig_stories.json`, log 📸.

  python3 scripts/ig_stories.py --plan             # sıralama (paylaşmaz)
  python3 scripts/ig_stories.py --run [--force]    # hazırla + paylaş (bugün paylaşıldıysa --force ister)
  python3 scripts/ig_stories.py --run --dry-run    # yalnız dosyaları hazırla
"""
import json
import re
import shutil
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from analyze import LONG, video_rows  # noqa: E402
from breaking_watch import same_event  # noqa: E402
from common import DATA, OUT, ROOT, episode_meta, load_json, save_json, settings  # noqa: E402

STATE = DATA / "ig_stories.json"
WORK = ROOT / "work" / "stories"


def cfg() -> dict:
    return {"enabled": True, "hour": 21, "minute": 0, "count": 3, "minViews": 1, "maxSeconds": 59, "rankCard": True,
            **(settings().get("igStories") or {})}


def views_txt(v: int) -> str:
    return f"{v:,}".replace(",", ".")


def recent_story_names(days: int = 2) -> set:
    st = load_json(STATE, {}) or {}
    return {n for h in st.get("history") or [] if time.time() - h.get("at", 0) < days * 86400 for n in h.get("videos") or []}


def pick(n: int, min_views: int = 1) -> list:
    now, skip = time.time(), recent_story_names()
    rows = []
    for r in video_rows():
        meta = episode_meta(r["name"]) or {}
        if r.get("format") in LONG or meta.get("infoKind") == "derleme" or r["name"] in skip or (r["views"] or 0) < min_views:
            continue
        if not (OUT / r["name"]).exists():
            continue
        try:
            ts = datetime.strptime(f"{r['date']} {r['time']}", "%Y-%m-%d %H:%M").timestamp()
        except Exception:
            continue
        if now - ts > 86400:
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


def duration_of(p: Path) -> float:
    r = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", str(p)], capture_output=True, text=True)
    try:
        return float(r.stdout.strip())
    except ValueError:
        return 0.0


def story_video(r: dict, dst: Path, max_s: float) -> Path | None:
    """≤ max_s ise olduğu gibi kopyalanır; uzunsa son sığan haber kartının sonundan kesilir (cümle ortasında bitmesin)."""
    src = OUT / r["name"]
    total = duration_of(src)
    if not total:
        return None
    if total <= max_s:
        shutil.copyfile(src, dst)
        return dst
    cut, t = 0.0, 0.0
    for s in r["meta"].get("segments") or []:
        t += float(s.get("duration") or 0)
        if s.get("kind") in ("haber", "hook") and t <= max_s - 0.3:
            cut = t
    if cut < 15:  # haber kartı sığmıyor (tek uzun haber): süre sınırında kes
        cut = max_s - 0.3
    fade = max(0.0, cut - 0.5)
    ok = subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(src), "-t", f"{cut:.2f}",
                         "-vf", f"fade=t=out:st={fade:.2f}:d=0.5", "-af", f"afade=t=out:st={fade:.2f}:d=0.5",
                         "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
                         "-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-movflags", "+faststart", str(dst)], capture_output=True).returncode == 0
    return dst if ok and dst.exists() else None


def rank_card(top: list, d: Path, day: str) -> Path | None:
    from info_card import render, tr_date
    card = {"kind": "ranking", "story": True, "label": settings().get("channelName") or "Türkiye Gündemi", "stamp": tr_date(weekday=True),
            "title": "Bugün en çok bunları izlediniz", "sub": "Videolar sıradaki hikâyelerde",
            "ranking": [{"title": re.sub(r"\s+", " ", r["title"]).strip(), "views": views_txt(r["views"])} for r in top]}
    (d / "cards.json").write_text(json.dumps([card], ensure_ascii=False), encoding="utf-8")
    ok = render(d)
    if not ok:
        return None
    dst = d / f"hikaye-{day}-0.jpg"
    shutil.copyfile(ROOT / ok[0]["tall"], dst)
    return dst


def run(force: bool = False, dry: bool = False) -> dict:
    c = cfg()
    day = time.strftime("%Y%m%d")
    st = load_json(STATE, {}) or {}
    if st.get("day") == day and not force and not dry:
        return {"ok": False, "error": "Bugünün hikâyeleri zaten paylaşıldı.", "already": True}
    top = pick(int(c["count"]), int(c.get("minViews") or 0))
    if not top:
        return {"ok": False, "error": "Son 24 saatte izlenme verisi olan video yok."}
    d = WORK / day
    shutil.rmtree(d, ignore_errors=True)
    d.mkdir(parents=True, exist_ok=True)
    for old in WORK.iterdir():  # 3 günden eski hikâye klasörleri
        if old.is_dir() and old != d and time.time() - old.stat().st_mtime > 3 * 86400:
            shutil.rmtree(old, ignore_errors=True)
    files, used = [], []
    if c.get("rankCard", True):
        try:
            card = rank_card(top, d, day)
        except Exception as e:
            card = None
            print(f"  ! sıralama kartı: {str(e)[:160]}", file=sys.stderr)
        if card:
            files.append(card)
        else:
            print("📸 Instagram hikâye: sıralama kartı çizilemedi, yalnız videolar paylaşılacak", flush=True)
    for i, r in enumerate(top, 1):
        v = story_video(r, d / f"hikaye-{day}-{i}.mp4", float(c["maxSeconds"]))
        if v:
            files.append(v)
            used.append(r)
        else:
            print(f"📸 Instagram hikâye: {r['name']} hazırlanamadı, atlandı", flush=True)
    if not used:
        return {"ok": False, "error": "Hikâye videoları hazırlanamadı (ffmpeg)."}
    top_out = [{"name": r["name"], "title": r["title"], "views": r["views"]} for r in used]
    if dry:
        return {"ok": True, "dryRun": True, "files": [str(f.relative_to(ROOT)) for f in files], "top": top_out}
    import publish
    try:
        res = publish.ig_story_publish(files)
    except Exception as e:
        return {"ok": False, "error": str(e)[:300], "top": top_out}
    names = {f"hikaye-{day}-{i}.mp4": r for i, r in enumerate(top, 1)}
    for x in res:
        r = names.get(x["file"])
        what = f"{r['title'][:70]} ({views_txt(r['views'])} izlenme)" if r else "sıralama kartı"
        print(f"📸 Instagram hikâye: {'paylaşıldı' if x['ok'] else 'PAYLAŞILAMADI'} — {what}" + ("" if x["ok"] else f": {x['error']}"), flush=True)
    okn = sum(1 for x in res if x["ok"])
    if okn:
        hist = [h for h in st.get("history") or [] if time.time() - h.get("at", 0) < 14 * 86400]
        hist.append({"at": time.time(), "day": day, "videos": [names[x["file"]]["name"] for x in res if x["ok"] and x["file"] in names]})
        save_json(STATE, {"day": day, "at": time.time(), "results": res, "top": top_out, "history": hist})
    return {"ok": okn > 0, "published": okn, "failed": len(res) - okn, "results": res, "top": top_out,
            **({} if okn else {"error": "; ".join(x.get("error", "") for x in res if not x["ok"])[:300]})}


if __name__ == "__main__":
    try:
        if "--run" in sys.argv:
            out = run(force="--force" in sys.argv, dry="--dry-run" in sys.argv)
        else:
            c = cfg()
            out = {"ok": True, "top": [{"name": r["name"], "title": r["title"], "views": r["views"]} for r in pick(int(c["count"]), int(c.get("minViews") or 0))],
                   "state": {k: v for k, v in (load_json(STATE, {}) or {}).items() if k != "history"}}
    except Exception as e:
        out = {"ok": False, "error": str(e)[:300]}
    print(json.dumps(out, ensure_ascii=False))
