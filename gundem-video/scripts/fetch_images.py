#!/usr/bin/env python3
"""Haber fotoğraflarını ve videolarını EN YÜKSEK çözünürlükte indirir, ölçekler ve episode.json'a yazar.

Kullanım: python3 scripts/fetch_images.py public/episode.json

ÖNCELİK VİDEO (kullanıcı kararı: "her zaman önceliğimiz video; video yoksa mecbur kalırsak foto"). Her kanca/haber
için video sırayla aranır, ilk bulunan kullanılır:
  a) haberin kendi sayfası (aşağıdaki 1. madde),
  b) aynı olayı veren DİĞER sitelerin sayfaları (work/news.json'da başlık+metin kökleri uyan haberler, anlık haberde
     work/anlik_pages.json),
  c) Bing Haberler'de başlıkla arama → bulunan haber sayfaları,
  d) YouTube'da EN YENİ videolar arasında başlıkla arama (ytsearchdate; başlığı haberle uyuşan, ≤ 30 dk video).
b-d ek arama süresi `settings.media.videoSearchSeconds` (420 sn) ile sınırlıdır; kanca ve ilk (manşet) haber bu
sınırdan bağımsız hep tam aranır. Bir sayfada bulunan video aynı haberin diğer segmentinde önce denenir.
Fotoğraf yine indirilir (kapak ve video bulunamazsa arka plan için).

Kaynak sırası (segment başına):
  1. Haberin kendi sayfası (articleUrl): og:image, twitter:image, image_src → yayıncının tam boy fotoğrafı.
     Video: önce yt-dlp (açık kaynak, binlerce siteyi tanır; sayfaya gömülü oynatıcıdaki videoyu bulur,
     en çok 1080p ve yalnızca ilk N saniyeyi indirir), olmazsa sayfadaki og:video / <video> / JSON-LD
     contentUrl adresleri ffmpeg ile (mp4 ya da m3u8); en son sayfadaki gömülü YouTube/Dailymotion/Vimeo
     oynatıcısı yt-dlp ile (kullanıcı kararıyla açık; settings.media.allowYoutubeEmbeds). YouTube için yt-dlp
     JavaScript çalıştırıcısı olarak Node kullanır (Remotion için zaten kurulu) ve yt-dlp-ejs bileşenini ister.
  2. RSS'in verdiği küçük görsel (imageUrl).
  Her görsel adresi için önce bilinen HD sürümleri denenir (BBC ichef genişliği, AA thumbs_b_c, WordPress
  -800x450 eki, ?w= parametresi). En büyük piksel alanlı görsel seçilir; 1600 px ve üstü bulununca durulur.

Çıktılar (public/images/, git dışı):
  seg-XX.jpg      1840x1120 haber kartı (fotoğraf geniş ise kırpılır, değilse bulanık zemin + tam fotoğraf)
  seg-XX-tall.jpg 1080x1920 kanca/dikey kapak: fotoğrafın TAMAMI keskin, arkası aynı fotoğrafın bulanığı
  vid-XX.mp4      haber videosu (sessiz, en çok settings.media.maxVideoSeconds sn), kart için 1280x780,
                  kanca için 1080x1920; aynı bulanık zemin yöntemi. Büyütme lanczos ile, JPEG kalite 2.
"""
import html
import json
import os
import re
import shutil
import ssl
import subprocess
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import ROOT, settings  # noqa: E402

try:
    import certifi
    CTX = ssl.create_default_context(cafile=certifi.where())
except ImportError:
    CTX = ssl.create_default_context()

UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36"
OUT = ROOT / "public" / "images"
MEDIA = {"video": True, "maxVideoSeconds": 20, "allowYoutubeEmbeds": True, "youtubeSearch": True, "videoSearchSeconds": 420,
         **(settings().get("media") or {})}
T0 = time.time()
# Yeniden yayın (REMAKE=1, panel "🔁 Yeniden yayınla"): eski videonun haber sayfaları ve görsel kaynakları kullanılmaz
REMAKE = os.environ.get("REMAKE") == "1"
try:
    AVOID = set(json.loads((ROOT / "work" / "remake.json").read_text(encoding="utf-8")).get("avoid") or []) if REMAKE else set()
except Exception:
    AVOID = set()


def get(url: str, limit: int, referer: str = "", timeout: int = 20) -> bytes:
    h = {"User-Agent": UA, "Accept": "*/*"}
    if referer:
        h["Referer"] = referer
    with urllib.request.urlopen(urllib.request.Request(url, headers=h), timeout=timeout, context=CTX) as r:
        return r.read(limit)


# ---------- sayfadan tam boy görsel ve video adresleri ----------
def _meta(page: str, *names: str) -> list:
    out = []
    for tag in re.findall(r"<meta\b[^>]*>", page, re.I):
        key = re.search(r'(?:property|name|itemprop)\s*=\s*["\']([^"\']+)["\']', tag, re.I)
        val = re.search(r'content\s*=\s*["\']([^"\']+)["\']', tag, re.I)
        if key and val and key.group(1).lower() in names:
            out.append(html.unescape(val.group(1)).strip())
    return out


EMBED = re.compile(r"(youtube\.com/(?:embed|watch|shorts)|youtube-nocookie\.com/embed|youtu\.be/|dailymotion\.com/(?:embed/)?video|player\.vimeo\.com/video)", re.I)


def page_media(url: str) -> tuple[list, list, list]:
    """Haber sayfasındaki görsel adresleri, doğrudan video dosyaları ve gömülü oynatıcılar (mutlak), önem sırasıyla."""
    try:
        page = get(url, 3 * 1024 * 1024, timeout=15).decode("utf-8", "replace")
    except Exception as e:
        print(f"  ! haber sayfası açılamadı ({url[:60]}): {e}", file=sys.stderr)
        return [], [], []
    imgs = _meta(page, "og:image:secure_url", "og:image", "og:image:url", "twitter:image", "twitter:image:src", "image")
    imgs += re.findall(r'<link[^>]+rel=["\']image_src["\'][^>]+href=["\']([^"\']+)', page, re.I)
    vids = _meta(page, "og:video:secure_url", "og:video:url", "og:video", "twitter:player:stream", "contenturl")
    vids += re.findall(r'<(?:video|source)\b[^>]*\bsrc=["\']([^"\']+\.(?:mp4|m3u8)[^"\']*)', page, re.I)
    vids += re.findall(r'"contentUrl"\s*:\s*"([^"]+\.(?:mp4|m3u8)[^"]*)"', page)
    vids += re.findall(r'["\'](https?:[^"\']+\.(?:mp4|m3u8)(?:\?[^"\']*)?)["\']', page)[:3]
    absu = lambda u: urllib.parse.urljoin(url, ("https:" + u) if u.startswith("//") else html.unescape(u.replace("\\/", "/")))
    uniq = lambda xs: list(dict.fromkeys(absu(x) for x in xs if x and not x.startswith("data:")))
    embeds = re.findall(r'<iframe\b[^>]*\b(?:data-)?src=["\']([^"\']+)', page, re.I) + vids
    embeds = [e for e in uniq(embeds) if EMBED.search(e)]
    # gömülü oynatıcı sayfaları (YouTube vb.) video dosyası değildir; onları yt-dlp açar
    vids = [v for v in uniq(vids) if re.search(r"\.(mp4|m3u8)(\?|$)", v, re.I) and not EMBED.search(v)]
    return uniq(imgs), vids, embeds


# ---------- HD sürüm adayları ----------
def hd_variants(u: str) -> list:
    """Bilinen küçük-görsel kalıplarından büyük sürüm adresleri üretir; asıl adres en sonda kalır."""
    out = []
    v = re.sub(r"(ichef\.bbci\.co\.uk/(?:news|ace/ws|images/ic))/(\d+)(?:x\d+)?/", r"\1/1024/", u)
    out.append(v)
    out.append(re.sub(r"thumbs_[a-z]_c_", "thumbs_b_c_", u))                              # AA
    out.append(re.sub(r"-\d{2,4}x\d{2,4}(?=\.(?:jpe?g|png|webp)(?:\?|$))", "", u, flags=re.I))  # WordPress
    p = urllib.parse.urlsplit(u)
    q = urllib.parse.parse_qsl(p.query, keep_blank_values=True)
    if any(k.lower() in ("w", "width", "h", "height", "resize", "size") for k, _ in q):
        nq = [(k, "1920" if k.lower() in ("w", "width") else val) for k, val in q if k.lower() not in ("h", "height", "resize", "size")]
        out.append(urllib.parse.urlunsplit(p._replace(query=urllib.parse.urlencode(nq))))
    # önce gerçekten farklı (büyük) sürümler, asıl adres en sonda
    return [x for x in dict.fromkeys(out) if x != u] + [u]


def probe(path: Path) -> tuple[int, int, float]:
    r = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height:format=duration",
                        "-of", "json", str(path)], capture_output=True, text=True)
    try:
        j = json.loads(r.stdout)
        s = j["streams"][0]
        return int(s["width"]), int(s["height"]), float(j.get("format", {}).get("duration") or 0)
    except Exception:
        return 0, 0, 0.0


_img_cache: dict = {}


def best_image(cands: list, referer: str, tmp: Path):
    """Adayları indirip en büyük gerçek fotoğrafı seçer: (dosya, genişlik, yükseklik, adres) ya da None."""
    best = None
    tries = 0
    for base in cands:
        for u in hd_variants(base):
            if u in _img_cache:
                got = _img_cache[u]
            else:
                if tries >= 8:
                    break
                tries += 1
                got = None
                try:
                    data = get(u, 25 * 1024 * 1024, referer=referer)
                    f = tmp.with_name(f"{tmp.stem}-{tries}.raw")
                    f.write_bytes(data)
                    w, h, _ = probe(f)
                    if w >= 300 and h >= 200 and 0.4 < w / h < 3.2:  # logo, ikon, şerit değil
                        got = (f, w, h, u)
                    else:
                        f.unlink(missing_ok=True)
                except Exception:
                    pass
                _img_cache[u] = got
            if got and (not best or got[1] * got[2] > best[1] * best[2]):
                best = got
            if got:
                break  # bu adayın en büyük çalışan sürümü bulundu; sıradaki adaya geç
        if best and best[1] >= 1600:
            break
    return best


# ---------- ölçekleme: büyütme yok gibi, bulanık zemin ----------
def fill_filter(w: int, h: int) -> str:
    """Fotoğrafın tamamı keskin ortada, arkası aynı görüntünün bulanık büyütülmüşü (dikey/kare uyumsuzluğu)."""
    return (f"split[a][b];[a]scale={w}:{h}:force_original_aspect_ratio=increase:flags=lanczos,crop={w}:{h},boxblur=28:2,eq=brightness=-0.12[bg];"
            f"[b]scale={w}:{h}:force_original_aspect_ratio=decrease:flags=lanczos[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2")


def cover_filter(w: int, h: int) -> str:
    return f"scale={w}:{h}:force_original_aspect_ratio=increase:flags=lanczos,crop={w}:{h}"


def frame_filter(src_w: int, src_h: int, w: int, h: int) -> str:
    """Oranlar yakınsa kırp (ekran dolu), uzaksa fotoğrafı bölmeden bulanık zeminle sığdır."""
    return cover_filter(w, h) if abs((src_w / src_h) / (w / h) - 1) < 0.22 else fill_filter(w, h)


def ff(args: list, timeout: int = 120) -> bool:
    try:
        return subprocess.run(["ffmpeg", "-y", "-loglevel", "error", *args], timeout=timeout).returncode == 0
    except subprocess.TimeoutExpired:
        return False


def _finish_video(raw: Path, dst: Path, w: int, h: int) -> float:
    """İndirilen ham klibi sessiz, 30 fps, hedef boyuta (kırpma ya da bulanık zemin) çevirir."""
    sw, sh, dur = probe(raw)
    ok = sw >= 320 and dur >= 3 and ff(["-i", str(raw), "-filter_complex", "[0:v]" + frame_filter(sw, sh, w, h), "-an", "-r", "30", "-c:v", "libx264",
                                         "-preset", "medium", "-crf", "19", "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(dst)], timeout=240)
    raw.unlink(missing_ok=True)
    return probe(dst)[2] if ok and dst.exists() else 0.0


def ytdlp_cmd() -> list | None:
    for py in (ROOT / ".venv" / "bin" / "python3", Path(sys.executable)):
        if py.exists() and subprocess.run([str(py), "-c", "import yt_dlp"], capture_output=True).returncode == 0:
            return [str(py), "-m", "yt_dlp"]
    return None


def fetch_video_ytdlp(page_url: str, dst: Path, w: int, h: int, seconds: float) -> float:
    """yt-dlp ile haber sayfasındaki videonun ilk `seconds` saniyesini en çok 1080p indirir."""
    cmd = ytdlp_cmd()
    if not cmd or not page_url:
        return 0.0
    tmpl = str(dst.with_name(dst.stem + ".yt.%(ext)s"))
    args = [*cmd, "--no-playlist", "--quiet", "--no-warnings", "--socket-timeout", "20", "--max-filesize", "300M",
            "-f", "bv*[height<=1080][ext=mp4]/bv*[height<=1080]/b[height<=1080]/bv*/b",
            "--download-sections", f"*0-{int(seconds)}", "--force-keyframes-at-cuts", "--remux-video", "mp4",
            "--user-agent", UA, "-o", tmpl, page_url]
    node = shutil.which("node")
    if node:  # YouTube imza çözümü için JavaScript çalıştırıcısı
        args[-1:-1] = ["--js-runtimes", f"node:{node}", "--remote-components", "ejs:github"]
    if not MEDIA.get("allowYoutubeEmbeds"):
        args[-1:-1] = ["--match-filter", "extractor_key!=Youtube"]
    try:
        subprocess.run(args, timeout=240, capture_output=True)
    except subprocess.TimeoutExpired:
        pass
    got = sorted(dst.parent.glob(dst.stem + ".yt.*"), key=lambda f: f.stat().st_size, reverse=True)
    for extra in got[1:]:
        extra.unlink(missing_ok=True)
    return _finish_video(got[0], dst, w, h) if got else 0.0


def fetch_video(urls: list, referer: str, dst: Path, w: int, h: int, seconds: float) -> float:
    """İlk çalışan video adresinden en çok `seconds` sn sessiz klip üretir; süresini döndürür (0 = yok)."""
    for u in urls[:3]:
        raw = dst.with_suffix(".src.mp4")
        hdr = f"User-Agent: {UA}\r\nReferer: {referer}\r\n"
        if not ff(["-headers", hdr, "-t", f"{seconds:.1f}", "-i", u, "-an", "-c:v", "copy", str(raw)], timeout=150) or not raw.exists():
            raw.unlink(missing_ok=True)
            if not ff(["-headers", hdr, "-t", f"{seconds:.1f}", "-i", u, "-an", "-c:v", "libx264", "-preset", "veryfast", str(raw)], timeout=180):
                raw.unlink(missing_ok=True)
                continue
        d = _finish_video(raw, dst, w, h)
        if d:
            return d
    return 0.0


# ---------- Video arama: kendi sayfası yoksa aynı haberin diğer sayfaları, haber araması, YouTube ----------
def _stems(t: str) -> set:
    try:
        from topic_news import stems
        return stems(t)
    except Exception:
        return {w[:4] for w in re.findall(r"\w{3,}", (t or "").lower())}


_NEWS = None


def same_story_pages(seg: dict, own: str) -> list:
    """Aynı olayı veren diğer sitelerin haber sayfaları (en uyumlu 4)."""
    global _NEWS
    if _NEWS is None:
        try:
            _NEWS = json.loads((ROOT / "work" / "news.json").read_text(encoding="utf-8")).get("items", [])
        except Exception:
            _NEWS = []
        try:  # anlık haber: panelin sitelerde bulduğu sayfalar
            _NEWS = [{"title": "", "summary": "", "link": p.get("url"), "anlik": True}
                     for p in json.loads((ROOT / "work" / "anlik_pages.json").read_text(encoding="utf-8"))] + _NEWS
        except Exception:
            pass
    kw = _stems(f"{seg.get('title', '')} {seg.get('narration', '')}")
    out = []
    for it in _NEWS:
        link = it.get("link") or ""
        if not link.startswith("http") or link == own:
            continue
        if it.get("anlik") and (os.environ.get("ANLIK") == "1"):
            out.append((99, link))
            continue
        s = len(kw & _stems(f"{it.get('title', '')} {(it.get('summary') or '')[:300]}"))
        if s >= max(2, int(len(kw) * 0.35)):
            out.append((s, link))
    out.sort(key=lambda x: -x[0])
    return [l for l in dict.fromkeys(l for _, l in out) if l not in AVOID][:4]


def searched_pages(query: str) -> list:
    """Bing Haberler'de başlıkla arama: doğrudan haber sayfası linkleri."""
    try:
        from news_lookup import parse_bing
        q = urllib.parse.quote(query[:120])
        xml = get(f"https://www.bing.com/news/search?q={q}&format=rss&setlang=tr&cc=TR", 2 * 1024 * 1024, timeout=15).decode("utf-8", "replace")
        kw = _stems(query)
        return [x["url"] for x in parse_bing(xml) if x["url"] not in AVOID and len(kw & _stems(x["title"] + " " + x["summary"])) >= max(2, int(len(kw) * 0.5))][:3]
    except Exception as e:
        print(f"  ! haber araması yapılamadı: {str(e)[:80]}", file=sys.stderr)
        return []


def youtube_search(query: str, dst: Path, w: int, h: int, secs: float) -> tuple[float, str]:
    """YouTube'da en yeni videolar arasında haber başlığıyla arar; başlığı uyuşan ilk videonun ilk saniyelerini alır."""
    cmd = ytdlp_cmd()
    if not cmd or not MEDIA.get("allowYoutubeEmbeds") or not MEDIA.get("youtubeSearch"):
        return 0.0, ""
    try:
        r = subprocess.run([*cmd, "--flat-playlist", "--quiet", "--no-warnings", "--print", "%(id)s\t%(duration)s\t%(title)s",
                            f"ytsearchdate10:{query[:100]}"], capture_output=True, text=True, timeout=60)
    except subprocess.TimeoutExpired:
        return 0.0, ""
    kw = _stems(query)
    need = max(2, int(len(kw) * 0.5 + 0.5))
    for line in r.stdout.splitlines():
        vid, dur, title = (line.split("\t", 2) + ["", "", ""])[:3]
        try:
            dur_s = float(dur)
        except ValueError:
            dur_s = 0.0
        if not vid or len(kw & _stems(title)) < need or not (5 <= dur_s <= 1800):
            continue
        url = f"https://www.youtube.com/watch?v={vid}"
        if url in AVOID:  # yeniden yayında eski videonun klibi alınmaz
            continue
        d = fetch_video_ytdlp(url, dst, w, h, secs)
        if d:
            return d, url
    return 0.0, ""


def video_from_page(page: str, pages: dict, dst: Path, w: int, h: int, secs: float) -> float:
    """Bir haber sayfasından video: yt-dlp, sayfadaki video dosyaları, gömülü oynatıcılar."""
    d = fetch_video_ytdlp(page, dst, w, h, secs)
    if d:
        return d
    if page not in pages:
        pages[page] = page_media(page)
    _, vids, embeds = pages[page]
    d = fetch_video(vids, page, dst, w, h, secs) if vids else 0.0
    if not d and MEDIA.get("allowYoutubeEmbeds"):
        for emb in embeds[:2]:
            d = fetch_video_ytdlp(emb, dst, w, h, secs)
            if d:
                break
    return d


def main():
    ep_path = Path(sys.argv[1])
    ep = json.loads(ep_path.read_text(encoding="utf-8"))
    OUT.mkdir(parents=True, exist_ok=True)
    for f in list(OUT.glob("seg-*")) + list(OUT.glob("vid-*")):
        f.unlink()
    pages: dict = {}
    found_src: dict = {}  # haber sayfası → videonun bulunduğu kaynak (aynı haberin kanca + kart segmentleri)
    first_haber = next((k for k, x in enumerate(ep["segments"]) if x.get("kind") == "haber"), -1)
    n_img = n_vid = n_hd = 0
    for i, seg in enumerate(ep["segments"]):
        if seg.get("kind") not in ("hook", "haber"):
            continue
        art, rss = seg.get("articleUrl"), seg.get("imageUrl")
        if not art and not rss and not MEDIA.get("video"):
            continue
        if art and art not in pages:
            pages[art] = page_media(art)
        p_imgs, p_vids, p_embeds = pages.get(art, ([], [], [])) if art else ([], [], [])
        cands = list(dict.fromkeys(p_imgs + ([rss] if rss else [])))
        tall = seg["kind"] == "hook"
        # video ÖNCE: kanca dikey tam ekran, haber kartı 1280x780 (kart oranı 920x560)
        if MEDIA.get("video"):
            dst = OUT / f"vid-{i:02d}.mp4"
            secs = min(float(MEDIA.get("maxVideoSeconds") or 20), max(6.0, float(seg.get("duration") or 8) + 1))
            vw, vh = (1080, 1920) if tall else (1280, 780)
            star = tall or seg.get("breaking") or first_haber == i  # kanca ve manşet: süre sınırı yok
            in_budget = lambda: star or time.time() - T0 < float(MEDIA.get("videoSearchSeconds") or 420)
            d, via = 0.0, ""
            seg_kw = _stems(f"{seg.get('title', '')} {seg.get('narration', '')}")
            hit = found_src.get(art) if art else None
            # aynı haberin başka segmentinde (kanca ↔ ilk kart) bulunan video kaynağı; farklı haber aynı sayfaya
            # eşlenmişse kullanılmaz (kök uyumu ya da anlık haber şart)
            if hit and hit["src"] not in AVOID and (os.environ.get("ANLIK") == "1" or len(seg_kw & hit["kw"]) >= 2):
                src = hit["src"]
                d = fetch_video_ytdlp(src, dst, vw, vh, secs) if "youtube.com/watch" in src else video_from_page(src, pages, dst, vw, vh, secs)
                via = "aynı haberin videosu" if d else ""
            if not d and art and art not in AVOID:  # yeniden yayında eski haber sayfası atlanır
                d = video_from_page(art, pages, dst, vw, vh, secs)
                src, via = art, "haber sayfası"
            if not d and in_budget():
                for alt in same_story_pages(seg, art or ""):
                    d = video_from_page(alt, pages, dst, vw, vh, secs)
                    if d:
                        src, via = alt, f"aynı haber, {urllib.parse.urlparse(alt).netloc.replace('www.', '')}"
                        break
                    if not in_budget():
                        break
            query = seg.get("title") if seg.get("kind") == "haber" else (next((x.get("title") for x in ep["segments"] if x.get("kind") == "haber"), "") or seg.get("title"))
            query = f"{query or ''} {' '.join((seg.get('narration') or '').split()[:6])}".strip()
            if not d and in_budget():
                for alt in searched_pages(query):
                    d = video_from_page(alt, pages, dst, vw, vh, secs)
                    if d:
                        src, via = alt, f"haber araması, {urllib.parse.urlparse(alt).netloc.replace('www.', '')}"
                        break
            if not d and in_budget():
                d, src = youtube_search(query, dst, vw, vh, secs)
                via = "YouTube araması" if d else ""
            if d:
                seg["video"], seg["videoDuration"] = f"images/{dst.name}", round(d, 2)
                seg["videoSrc"] = src  # kaynak adres (sonraki yeniden yayında aynı görüntü kullanılmasın)
                n_vid += 1
                if art and src:
                    found_src.setdefault(art, {"src": src, "kw": seg_kw})
                print(f"  🎞 video {seg.get('title', '')[:40]}: {d:.1f} sn ({via})")
            else:
                print(f"  📷 video bulunamadı, fotoğraf kullanılacak: {seg.get('title', '')[:50]}")
        best = None
        if REMAKE:  # önce eski videoda kullanılmamış kaynaklar: aynı haberin diğer sayfalarının fotoğrafları
            fresh = []
            for alt in same_story_pages(seg, art or "")[:2]:
                if alt not in pages:
                    pages[alt] = page_media(alt)
                fresh += pages[alt][0][:2]
            fresh = [c for c in dict.fromkeys(fresh + cands) if c not in AVOID and not (set(hd_variants(c)) & AVOID)]
            best = best_image(fresh, art or "", OUT / f"seg-{i:02d}.tmp") if fresh else None
        if not best:
            best = best_image(cands, art or "", OUT / f"seg-{i:02d}.tmp") if cands else None
        if not best:
            if cands:
                print(f"  ! görsel alınamadı: {seg.get('title', '')[:50]}", file=sys.stderr)
            continue
        f, w, h, u = best
        card, tall_f = OUT / f"seg-{i:02d}.jpg", OUT / f"seg-{i:02d}-tall.jpg"
        ok1 = ff(["-i", str(f), "-filter_complex", "[0:v]" + frame_filter(w, h, 1840, 1120), "-frames:v", "1", "-q:v", "2", str(card)])
        ok2 = ff(["-i", str(f), "-filter_complex", "[0:v]" + fill_filter(1080, 1920), "-frames:v", "1", "-q:v", "2", str(tall_f)])
        if ok1:
            seg["image"] = f"images/{card.name}"
            n_img += 1
            n_hd += w >= 1200
        if ok2:
            seg["imageTall"] = f"images/{tall_f.name}"
        seg["imageSize"] = f"{w}x{h}"
        seg["imageSrc"] = u
        print(f"  🖼 {w}x{h} {seg.get('title', '')[:40]}")
    for f in OUT.glob("*.raw"):
        f.unlink()
    ep_path.write_text(json.dumps(ep, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"{n_img} haber görseli hazır ({n_hd} tanesi HD), {n_vid} haber videosu")


if __name__ == "__main__":
    main()
