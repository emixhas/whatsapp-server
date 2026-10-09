#!/usr/bin/env python3
"""Haber fotoğraflarını ve videolarını EN YÜKSEK çözünürlükte indirir, ölçekler ve episode.json'a yazar.

Kullanım: python3 scripts/fetch_images.py public/episode.json

Kaynak sırası (segment başına):
  1. Haberin kendi sayfası (articleUrl): og:image, twitter:image, image_src → yayıncının tam boy fotoğrafı.
     Video: önce yt-dlp (açık kaynak, binlerce siteyi tanır; sayfaya gömülü oynatıcıdaki videoyu bulur,
     en çok 1080p ve yalnızca ilk N saniyeyi indirir), olmazsa sayfadaki og:video / <video> / JSON-LD
     contentUrl adresleri ffmpeg ile (mp4 ya da m3u8). YouTube gömmeleri varsayılan olarak alınmaz
     (YouTube'a yeniden yüklemek telif eşleşmesi doğurur; settings.media.allowYoutubeEmbeds).
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
import re
import ssl
import subprocess
import sys
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
MEDIA = {"video": True, "maxVideoSeconds": 20, "allowYoutubeEmbeds": False, **(settings().get("media") or {})}


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


def page_media(url: str) -> tuple[list, list]:
    """Haber sayfasındaki görsel ve video adresleri (mutlak), önem sırasıyla."""
    try:
        page = get(url, 3 * 1024 * 1024, timeout=15).decode("utf-8", "replace")
    except Exception as e:
        print(f"  ! haber sayfası açılamadı ({url[:60]}): {e}", file=sys.stderr)
        return [], []
    imgs = _meta(page, "og:image:secure_url", "og:image", "og:image:url", "twitter:image", "twitter:image:src", "image")
    imgs += re.findall(r'<link[^>]+rel=["\']image_src["\'][^>]+href=["\']([^"\']+)', page, re.I)
    vids = _meta(page, "og:video:secure_url", "og:video:url", "og:video", "twitter:player:stream", "contenturl")
    vids += re.findall(r'<(?:video|source)\b[^>]*\bsrc=["\']([^"\']+\.(?:mp4|m3u8)[^"\']*)', page, re.I)
    vids += re.findall(r'"contentUrl"\s*:\s*"([^"]+\.(?:mp4|m3u8)[^"]*)"', page)
    vids += re.findall(r'["\'](https?:[^"\']+\.(?:mp4|m3u8)(?:\?[^"\']*)?)["\']', page)[:3]
    absu = lambda u: urllib.parse.urljoin(url, html.unescape(u.replace("\\/", "/")))
    uniq = lambda xs: list(dict.fromkeys(absu(x) for x in xs if x and not x.startswith("data:")))
    # gömülü oynatıcı sayfaları (YouTube vb.) video dosyası değildir
    vids = [v for v in uniq(vids) if re.search(r"\.(mp4|m3u8)(\?|$)", v, re.I) and not re.search(r"youtube|youtu\.be|dailymotion|vimeo", v)]
    return uniq(imgs), vids


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


def main():
    ep_path = Path(sys.argv[1])
    ep = json.loads(ep_path.read_text(encoding="utf-8"))
    OUT.mkdir(parents=True, exist_ok=True)
    for f in list(OUT.glob("seg-*")) + list(OUT.glob("vid-*")):
        f.unlink()
    pages: dict = {}
    n_img = n_vid = n_hd = 0
    for i, seg in enumerate(ep["segments"]):
        if seg.get("kind") not in ("hook", "haber"):
            continue
        art, rss = seg.get("articleUrl"), seg.get("imageUrl")
        if not art and not rss:
            continue
        if art and art not in pages:
            pages[art] = page_media(art)
        p_imgs, p_vids = pages.get(art, ([], [])) if art else ([], [])
        cands = list(dict.fromkeys(p_imgs + ([rss] if rss else [])))
        tall = seg["kind"] == "hook"
        # video: kanca dikey tam ekran, haber kartı 1280x780 (kart oranı 920x560)
        if MEDIA.get("video") and art:
            dst = OUT / f"vid-{i:02d}.mp4"
            secs = min(float(MEDIA.get("maxVideoSeconds") or 20), max(6.0, float(seg.get("duration") or 8) + 1))
            vw, vh = (1080, 1920) if tall else (1280, 780)
            d = fetch_video_ytdlp(art, dst, vw, vh, secs) or (fetch_video(p_vids, art, dst, vw, vh, secs) if p_vids else 0.0)
            if d:
                seg["video"], seg["videoDuration"] = f"images/{dst.name}", round(d, 2)
                n_vid += 1
                print(f"  🎞 video {seg.get('title', '')[:40]}: {d:.1f} sn")
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
        print(f"  🖼 {w}x{h} {seg.get('title', '')[:40]}")
    for f in OUT.glob("*.raw"):
        f.unlink()
    ep_path.write_text(json.dumps(ep, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"{n_img} haber görseli hazır ({n_hd} tanesi HD), {n_vid} haber videosu")


if __name__ == "__main__":
    main()
