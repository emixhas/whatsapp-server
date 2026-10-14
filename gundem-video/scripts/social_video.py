#!/usr/bin/env python3
"""Sosyal medya paylaşım linkinden haber videosu için kaynak (kullanıcı isteği: "Instagram'da viral olmuş bir haberin linkini
göndersem videoyu çekip bizim stilimizde haber yapar mısın").

Desteklenen: Instagram (reel, gönderi, tv), TikTok, X/Twitter, YouTube (shorts, video), Facebook (reel, video). yt-dlp ile video
(≤1080p, ≤10 dk, ≤300 MB) `work/wa_inbox/`a iner; paylaşımın açıklaması, hesabı, izlenme/beğeni ve tarihi okunur. Sonra aynı olay
haber sitelerinde aranır (`news_lookup.py --topic`, açıklamanın ilk anlamlı kelimeleri): bulunursa doğrulanmış bilgi olarak montaj
planına gider. Instagram çoğu zaman girişsiz video vermez: `settings.social.cookiesFromBrowser` ("chrome", "safari"…, o tarayıcıda
Instagram'a giriş yapılmış olmalı) ya da `secrets/social_cookies.txt` (Netscape çerez dosyası) yt-dlp'ye verilir.

  python3 scripts/social_video.py --url URL
Son satır JSON: {ok, file, social: {platform, handle, uploader, credit, caption, url, views, likes, date}, related: [...]}
"""
import json
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import ROOT, SECRETS, settings  # noqa: E402

PLATFORMS = [(r"instagram\.com", "Instagram"), (r"tiktok\.com", "TikTok"), (r"(^|\.)(x|twitter)\.com", "X"),
             (r"youtube\.com|youtu\.be", "YouTube"), (r"facebook\.com|fb\.watch", "Facebook")]
INBOX = ROOT / "work" / "wa_inbox"


def platform_of(url: str) -> str:
    host = re.sub(r"^https?://", "", url).split("/")[0].lower()
    return next((name for pat, name in PLATFORMS if re.search(pat, host)), "Sosyal medya")


def ytdlp() -> list | None:
    for py in (ROOT / ".venv" / "bin" / "python3", Path(sys.executable)):
        if py.exists() and subprocess.run([str(py), "-c", "import yt_dlp"], capture_output=True).returncode == 0:
            return [str(py), "-m", "yt_dlp"]
    return [shutil.which("yt-dlp")] if shutil.which("yt-dlp") else None


def hint(err: str, plat: str) -> str:
    low = err.lower()
    if any(k in low for k in ("login", "log in", "cookies", "rate-limit", "private", "not available", "empty media response")):
        return (f"{plat} bu videoyu girişsiz vermiyor ya da paylaşım gizli. Mac'te Chrome'da {plat}'a giriş yapın ve panelde "
                f"Ayarlar → 📡 Otomatik içerikler → \"Sosyal medya çerezleri\" alanına chrome yazın (ya da secrets/social_cookies.txt).")
    if "unsupported url" in low:
        return "Bu link desteklenmiyor (paylaşımın kendi linkini gönderin)."
    if "max-filesize" in low or "larger than" in low:
        return "Video çok büyük (300 MB üstü)."
    return err[-200:]


def clean_caption(t: str) -> str:
    t = re.sub(r"#\w+", " ", t or "")
    t = re.sub(r"[^\w\s.,:;!?'\"()%₺$€/-]", " ", t)
    return re.sub(r"\s+", " ", t).strip()


def related(caption: str, title: str) -> list:
    words = [w for w in re.findall(r"[\wçğıöşüÇĞİÖŞÜ]{3,}", clean_caption(caption) or clean_caption(title)) if not w.isdigit()][:10]
    if len(words) < 3:
        return []
    try:
        r = subprocess.run([sys.executable, str(ROOT / "scripts/news_lookup.py"), "--topic", " ".join(words)], cwd=ROOT,
                           capture_output=True, text=True, timeout=90)
        j = json.loads(r.stdout.strip().splitlines()[-1])
    except Exception:
        return []
    if not j.get("found"):
        return []
    out = []
    b = j.get("best") or {}
    if b.get("title"):
        out.append({"site": b.get("site"), "baslik": b.get("title"), "metin": (b.get("body") or b.get("description") or "")[:1200], "url": b.get("url")})
    for x in (j.get("related") or [])[:4]:
        out.append({"site": x.get("s"), "baslik": x.get("k"), "metin": (x.get("o") or "")[:300]})
    return out


def fetch(url: str) -> dict:
    cmd = ytdlp()
    if not cmd:
        return {"ok": False, "error": "yt-dlp kurulu değil (.venv'de pip install yt-dlp)"}
    plat = platform_of(url)
    INBOX.mkdir(parents=True, exist_ok=True)
    for old in INBOX.iterdir():
        if time.time() - old.stat().st_mtime > 3 * 86400:
            old.unlink(missing_ok=True)
    stem = f"social-{int(time.time())}"
    tmpl = str(INBOX / f"{stem}.%(ext)s")
    args = [*cmd, "--no-playlist", "--no-warnings", "--socket-timeout", "25", "--max-filesize", "300M", "--match-filter", "duration <? 600",
            "-f", "bv*[height<=1080][ext=mp4]+ba[ext=m4a]/bv*[height<=1080]+ba/b[height<=1080]/b", "--merge-output-format", "mp4",
            "--write-info-json", "-o", tmpl]
    s = settings().get("social") or {}
    if (SECRETS / "social_cookies.txt").exists():
        args += ["--cookies", str(SECRETS / "social_cookies.txt")]
    elif s.get("cookiesFromBrowser"):
        args += ["--cookies-from-browser", str(s["cookiesFromBrowser"]).strip()]
    node = shutil.which("node")
    if node and plat == "YouTube":
        args += ["--js-runtimes", f"node:{node}", "--remote-components", "ejs:github"]
    try:
        r = subprocess.run([*args, url], capture_output=True, text=True, timeout=360)
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": "indirme 6 dakikada bitmedi"}
    vids = sorted((p for p in INBOX.glob(f"{stem}.*") if p.suffix.lower() in (".mp4", ".mkv", ".webm", ".mov")), key=lambda p: p.stat().st_size, reverse=True)
    if not vids:
        err = (r.stderr or r.stdout or "video bulunamadı").strip().splitlines()
        return {"ok": False, "error": hint(" ".join(err[-3:]), plat)}
    video = vids[0]
    if video.suffix.lower() != ".mp4":  # webm/mkv → mp4 (ffmpeg her birini okur ama dosya adı tutarlı olsun)
        mp4 = video.with_suffix(".mp4")
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(video), "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
                        "-c:a", "aac", str(mp4)])
        video.unlink(missing_ok=True)
        video = mp4
    info = {}
    for f in INBOX.glob(f"{stem}*.info.json"):
        try:
            info = json.loads(f.read_text(encoding="utf-8"))
        except Exception:
            pass
        f.unlink(missing_ok=True)
    handle = info.get("uploader_id") or info.get("channel") or info.get("uploader") or ""
    handle = str(handle).lstrip("@")
    caption = str(info.get("description") or "").strip()
    title = str(info.get("title") or "").strip()
    d = str(info.get("upload_date") or "")
    social = {"platform": plat, "handle": handle, "uploader": info.get("uploader") or info.get("channel") or handle,
              "credit": f"{plat} / @{handle}" if handle else plat, "caption": caption[:2000],
              "title": title[:200], "url": info.get("webpage_url") or url, "views": info.get("view_count"), "likes": info.get("like_count"),
              "comments": info.get("comment_count"), "date": f"{d[6:8]}.{d[4:6]}.{d[:4]}" if len(d) == 8 else None,
              "duration": info.get("duration")}
    return {"ok": True, "file": str(video), "social": social, "related": related(caption, title)}


if __name__ == "__main__":
    try:
        res = fetch(sys.argv[sys.argv.index("--url") + 1]) if "--url" in sys.argv else {"ok": False, "error": "kullanım: --url URL"}
    except Exception as e:
        res = {"ok": False, "error": str(e)[:300]}
    print(json.dumps(res, ensure_ascii=False))
