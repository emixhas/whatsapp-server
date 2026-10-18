#!/usr/bin/env python3
"""Sosyal medya paylaşım linkinden haber videosu için kaynak (kullanıcı isteği: "Instagram'da viral olmuş bir haberin linkini
göndersem videoyu çekip bizim stilimizde haber yapar mısın").

Desteklenen: Instagram (reel, gönderi, tv), TikTok, X/Twitter, YouTube (shorts, video), Facebook (reel, video). yt-dlp ile video
(≤1080p, ≤10 dk, ≤300 MB) `work/wa_inbox/`a iner; paylaşımın açıklaması, hesabı, izlenme/beğeni ve tarihi okunur. Sonra aynı olay
haber sitelerinde aranır (`news_lookup.py --topic`, açıklamanın ilk anlamlı kelimeleri): bulunursa doğrulanmış bilgi olarak montaj
planına gider. Instagram çoğu zaman girişsiz video vermez: `settings.social.cookiesFromBrowser` ("chrome", "safari"…, o tarayıcıda
Instagram'a giriş yapılmış olmalı) ya da `secrets/social_cookies.txt` (Netscape çerez dosyası) yt-dlp'ye verilir.

Fragman (kullanıcı isteği, 18 Ekim: "bir filmin fragmanını analiz edip kullanıcıların aşırı dikkatini çekecek yapıda kurmamız
lazım"): başlıkta fragman/trailer/teaser geçerse (römork anlamı, soru başlığı ve "tanıtım filmi" hariç) ya da açıklamanın ilk ~200
karakterinde güçlü bir ifade (official trailer, resmi fragman, "85. Bölüm Fragmanı") varsa `social.trailer` true,
`social.film` başlıktan ayıklanmış film/dizi adı (fragman kelimeleri, Official/Resmi, "| kanal", "(2026)", 4K/HD, #1, emoji atılır),
`social.bolum` varsa bölüm ("200. Bölüm"). Haber araması film adıyla yapılır ("<film> fragman", bulunamazsa "<film> film"/"<film>
dizi"): vizyon tarihi/oyuncular doğrulanmış haberden gelsin. Fragman olmayan paylaşımda davranış aynı.

  python3 scripts/social_video.py --url URL
  python3 scripts/social_video.py --film "BAŞLIK"      # fragman tanıma + film adı denemesi (ağsız)
Son satır JSON: {ok, file, social: {platform, handle, uploader, credit, caption, url, views, likes, date, trailer, film, bolum,
tags}, related: [...]}
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
# fragman tanıma (re.I Türkçe I/ı, İ/i eşlemesini yapar; \w Türkçe harfleri kapsar → kelime sınırı doğru çalışır). Yalnız Türkçe
# ekleri alınır: fragmanı, fragmanları, fragmanda… ("fragmantasyon" fragman değil)
_TWORD = r"(?:fragman(?:[ıiae]\w*|l[ae]r\w*|d[ae]\w*)?|trailer(?:s|[ıi]\w*)?|teaser(?:s|[ıi]\w*)?|tan[ıi]t[ıi]m\s+film\w*)"
# otomatik tanıma (kullanıcı "fragman" yazmadan fragman moduna geçer), yanlış pozitifler ayıklanır: "tanıtım filmi" sayılmaz (parti,
# belediye, ürün, üniversite tanıtım filmi film fragmanı değil; talimatta "fragman" yazılırsa yine fragman modu), römork anlamındaki
# trailer ("Truck and trailer crash", "Trailer park fire", "travel trailer") ve fragmandan soru olarak söz eden haber başlığı
# ("Fragman yayınlandı mı? Bakanlık açıklama yaptı") fragman değil. Açıklamada yalnız güçlü ifade (haber açıklamasında "fragman" geçebilir).
TRAILER = re.compile(r"(?<!\w)(?:fragman(?:[ıiae]\w*|l[ae]r\w*|d[ae]\w*)?|trailer(?:s|[ıi]\w*)?|teaser(?:s|[ıi]\w*)?)(?!\w)", re.I)
_VEHICLE = re.compile(r"(?<!\w)(?:(?:tractor|semi|truck|lorry|travel|horse|boat|utility|camper|cargo|car|flatbed|enclosed|dump|livestock|tow|rv)"
                      r"(?:\s+and)?[\s-]+trailers?|trailers?[\s-]+(?:park|parks|home|homes|hitch\w*|truck\w*|crash\w*|fire|tow\w*|camp\w*|house|"
                      r"life|living|sway|wiring|tires?|rental|accident|overturn\w*|jackknif\w*))(?!\w)", re.I)
_DESC_TRAILER = re.compile(r"(?<!\w)(?:official\s+(?:trailer|teaser)|teaser\s+trailer|resm[iî]\s+(?:fragman|teaser)\w*|"
                           r"\d+\s*\.\s*b[öo]l[üu]m\s+(?:\d+\s*\.\s*)?fragman\w*)(?!\w)", re.I)
# fragman kelimesinin yanındaki sıfatlar (yalnız bitişikken atılır: "Final Destination", "The Final Reckoning" adın parçası kalır)
_MODS = (r"(?:official|offical|final|new|first|full|main|international|ultimate|exclusive|extended|teaser|resmi|yeni|ilk|son|"
         r"t[üu]rk[çc]e|altyaz[ıi]l[ıi]|dublajl[ıi]|orijinal|uzun|k[ıi]sa|tam|hd|4k|"
         r"concept|fan[\s-]?made|unofficial|ai|parody|parodi|hayran\s+yap[ıi]m[ıi])")  # hayran yapımı: "Concept Trailer", "AI Trailer"
# yalnız "hayran yapımı" işareti olan başlık parçası film adı değildir ("FAN MADE | Spider-Man 4 Trailer" → "Spider-Man 4")
_FAN = re.compile(r"^(?:fan[\s-]?made|unofficial|concept|parod[iy]|ai(?:\s+generated)?|hayran\s+yap[ıi]m[ıi])$", re.I)
_PHRASE = re.compile(rf"(?<!\w)(?:\d+\s*\.\s*)?(?:{_MODS}\s+)*{_TWORD}(?!\w)(?:\s*#?\s*\d+(?!\w))?(?:\s+{_MODS}(?!\w))*", re.I)
_QUALITY = re.compile(r"(?<!\w)(?:4k|8k|u?hd|fhd|full\s+hd|1080p|720p|2160p|imax)(?!\w)|#\d+", re.I)
_PLATFORM = re.compile(r"^(?:netflix|prime\s+video|amazon\s+prime(?:\s+video)?|disney\+?|hbo(?:\s+max)?|max|apple\s+tv\+?|blutv|tod|exxen|gain|"
                       r"tabii|trt\s*1|trt|atv|show\s*tv|star\s*tv|kanal\s*d|now|tv8|fox|warner\s+bros\.?(?:\s+pictures)?|universal(?:\s+pictures)?|"
                       r"sony\s+pictures|paramount(?:\s+pictures)?|marvel(?:\s+(?:studios|entertainment))?|dc|a24|lionsgate|pixar|dreamworks|"
                       r"cgv\s+mars|cinemaximum|paribu\s+cineverse|in\s+theaters.*|only\s+in\s+theaters.*|now\s+streaming.*|coming\s+soon.*|"
                       r"(?:sadece\s+)?sinemalarda.*|yak[ıi]nda.*|vizyonda.*)(?:\s+(?:t[üu]rkiye|turkey|tr))?$", re.I)
_STUDIO_PREFIX = re.compile(r"^(?:marvel\s+studios|disney|pixar|dreamworks|lucasfilm|netflix|hbo|a24)(?:'s|’s|'|’)?\s+(?=\S)", re.I)
_EPISODE = re.compile(r"(?<!\w)(?:\d+\s*\.?\s*b[öo]l[üu]m\w*|b[öo]l[üu]m\s*\d+|episode\s*\d+|ep\.?\s*\d+)(?!\w)", re.I)
_EDGE = " -–—:|,;!?/·•\"'“”‘’"


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


# tırnak içindeki replik ("Ne oldu sana?") soru başlığı sayılmaz; Türkçe kesme işareti (Netflix'te, Dune'un) tırnak değildir
_QUOTED = re.compile(r"[\"“”«»][^\"“”«»]*[\"“”«»]|(?<!\w)['‘’][^'‘’]*['‘’](?!\w)")


def _trailer_part(x: str) -> bool:
    """Başlık parçası fragman mı: fragman kelimesi geçer ve kelimeden SONRA (tırnak dışında) soru işareti yoktur. "GTA 6 fragmanı ne
    zaman çıkacak?" soru başlığıdır; "Who Killed Sara? Season 3 Trailer", "Bu Şehri Kim Yaktı? Resmi Fragman" ve "… 2. Fragman "Ne
    oldu sana?"" fragmandır."""
    m = TRAILER.search(x)
    return bool(m) and "?" not in _QUOTED.sub(" ", x[m.end():])


def is_trailer(title: str, description: str = "") -> bool:
    """Başlıkta fragman/trailer/teaser geçiyor mu (römork anlamı ve fragmandan soru olarak söz eden başlık parçası hariç, `_trailer_part`)
    ya da açıklamanın ilk ~200 karakterinde güçlü fragman ifadesi."""
    parts = re.split(r"\s*[|｜•·]\s*|\s+[-–—]\s+|:\s+", _VEHICLE.sub(" ", title or ""))
    return any(_trailer_part(x) for x in parts) or bool(_DESC_TRAILER.search(_VEHICLE.sub(" ", (description or "")[:200])))


def _strip(t: str) -> str:
    t = re.sub(r"\s+", " ", t or "").strip(_EDGE + " ")
    return t[:-1].rstrip(_EDGE) if t.endswith(".") and not re.search(r"[^\W\d_]{2}\.$", t) else t


def _case(t: str) -> str:
    """TAMAMI BÜYÜK HARF başlığı düzeltir (Mission: Impossible); Türkçe harf varsa Türkçe büyük/küçük harf kuralıyla."""
    letters = [c for c in t if c.isalpha()]
    if len(letters) < 4 or any(c.islower() for c in letters):
        return t
    tr = bool(re.search(r"[ÇĞİÖŞÜ]", t))
    low = (lambda w: w.replace("I", "ı").replace("İ", "i").lower()) if tr else str.lower

    def word(w):
        if re.fullmatch(r"[IVXLC]+|[A-Z0-9]*\d[A-Z0-9]*", w):  # roma rakamı (II), rakamlı ad (F1, 3D)
            return w
        lw = low(w)
        return (("İ" if lw[0] == "i" and tr else lw[0].upper()) + lw[1:]) if lw else w
    return re.sub(r"[^\W_]+", lambda m: word(m.group(0)), t)


def film_name(title: str, uploader: str = "") -> tuple[str, str]:
    """Fragman başlığından (film/dizi adı, bölüm). "Dune: Part Three | Official Trailer" → ("Dune: Part Three", "");
    "Kuruluş Osman 200. Bölüm Fragmanı" → ("Kuruluş Osman", "200. Bölüm"); "TEASER - Avatar: Fire and Ash" → ("Avatar: Fire and Ash", "")."""
    t = re.sub(r"#[^\W\d_]\w*", " ", title or "")  # #Dune #Trailer
    t = re.sub(r"[^\w\s:;,.!?'’\"&+\-–—|/()\[\]#]", " ", t)  # emoji ve simgeler (🔥, ★, *)
    noise = re.compile(r"\d{4}|fragman|trailer|teaser|tan[ıi]t[ıi]m|4k|hd|1080|official|resmi|altyaz|dublaj|subtit|dubbed|t[üu]rk[çc]e|english|"
                       r"movie|film|dizi|series|netflix|prime|disney|hbo|apple|imax", re.I)
    t = re.sub(r"[(\[【]([^)\]】]*)[)\]】]", lambda m: " " if noise.search(m.group(1)) else m.group(0), t)  # (2026) (Türkçe Altyazılı) [4K]
    up = re.sub(r"\s+", " ", uploader or "").strip().casefold()
    parts, chosen = [p for p in re.split(r"\s*[|｜•·]\s*|\s+//\s+", t) if p.strip()], ""
    for part in parts:  # ilk anlamlı parça (fragman kelimesi, platform, kanal adı ya da yalnız kalite yazısı olan parçalar atlanır)
        m = _PHRASE.search(part)
        cand = part
        if m:  # fragman ifadesinden önce ad varsa o ("Gladiator II - Resmi Fragman"), yoksa sonrası ("TEASER - Avatar")
            before, after = _strip(_QUALITY.sub(" ", part[:m.start()])), _strip(_QUALITY.sub(" ", part[m.end():]))
            cand = before if len(re.sub(r"[\W\d_]", "", before)) >= 2 else after
        cand = _strip(_QUALITY.sub(" ", _PHRASE.sub(" ", cand)))
        if len(re.sub(r"[\W\d_]", "", cand)) < 2 or _PLATFORM.match(cand) or (up and cand.casefold() == up) or _FAN.match(cand):
            continue
        chosen = cand
        break
    chosen = _STUDIO_PREFIX.sub("", chosen)
    ep = _EPISODE.search(chosen)
    bolum = _strip(ep.group(0)) if ep else ""
    if ep:
        chosen = chosen[:ep.start()] + " " + chosen[ep.end():]
    chosen = re.sub(r"\s+(?:filmi|dizisi)$", "", _strip(chosen), flags=re.I)
    chosen = _strip(chosen)
    if len(re.sub(r"[\W\d_]", "", chosen)) < 2:  # ad bulunamadı: başlığın fragman kelimeleri atılmış hali, o da yoksa boş
        chosen = _strip(_QUALITY.sub(" ", _PHRASE.sub(" ", re.sub(r"[|｜•·]", " ", t))))
        chosen = chosen if len(re.sub(r"[\W\d_]", "", chosen)) >= 2 and not _PLATFORM.match(chosen) else ""
    return _case(chosen)[:80], _case(bolum)


def _lookup(topic: str, timeout: int = 90) -> list:
    try:
        r = subprocess.run([sys.executable, str(ROOT / "scripts/news_lookup.py"), "--topic", topic], cwd=ROOT,
                           capture_output=True, text=True, timeout=timeout)
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


def related(caption: str, title: str, film: str = "", series: bool = False) -> list:
    if film:  # fragman: haber siteleri film adıyla aranır (vizyon tarihi, oyuncular, yönetmen doğrulanmış haberden gelsin)
        for q in (f"{film} fragman", f"{film} {'dizi' if series else 'film'}"):
            out = _lookup(q, timeout=75)
            if out:
                return out
        return []
    words = [w for w in re.findall(r"[\wçğıöşüÇĞİÖŞÜ]{3,}", clean_caption(caption) or clean_caption(title)) if not w.isdigit()][:10]
    if len(words) < 3:
        return []
    return _lookup(" ".join(words))


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
    # fragman (kullanıcı isteği, 18 Ekim): film adı başlıktan; panel talimata ve fragman ayarına göre fragman analizine geçer. Otomatik
    # tanıma yalnız YouTube'da (yardım ve panel metni): TikTok/X/Facebook haber klibinin açıklamasındaki "trailer" (römork), "fragmanda
    # yoktu" gibi sözler haber videosunu fragman moduna ve film adıyla aramaya çevirmesin; talimatta "fragman" yazılırsa her platformda olur
    try:
        trailer = plat == "YouTube" and is_trailer(title, caption)
        film, bolum = film_name(title, str(social["uploader"] or ""))
    except Exception:  # ad ayıklama hiçbir zaman indirmeyi düşürmesin
        trailer, film, bolum = False, "", ""
    series = bool(bolum or re.search(r"sezon|season|episode|dizi|series", f"{title} {caption[:200]}", re.I))
    social.update({"trailer": trailer, "film": film, "bolum": bolum,
                   "tags": [str(x) for x in (info.get("tags") or [])[:15]]})
    return {"ok": True, "file": str(video), "social": social, "related": related(caption, title, film if trailer and film else "", series)}


if __name__ == "__main__":
    try:
        if "--film" in sys.argv:  # ağsız deneme: fragman mı, film adı ne
            t = sys.argv[sys.argv.index("--film") + 1]
            f, b = film_name(t)
            print(json.dumps({"ok": True, "trailer": is_trailer(t), "film": f, "bolum": b}, ensure_ascii=False))
            sys.exit(0)
        res = fetch(sys.argv[sys.argv.index("--url") + 1]) if "--url" in sys.argv else {"ok": False, "error": "kullanım: --url URL"}
    except Exception as e:
        res = {"ok": False, "error": str(e)[:300]}
    print(json.dumps(res, ensure_ascii=False))
