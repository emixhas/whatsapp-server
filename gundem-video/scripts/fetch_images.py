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
İKİNCİ GEÇİŞ (kullanıcı isteği: "kesinlikle öncelik video"): arama bitince kendi videosunu bulamayan bölüm, AYNI
HABERİN başka bölümünde bulunan videoyu oynatır (tek konulu anlık videoda tüm bölümler aynı haberdir; çok haberlide
aynı haber sayfası + ≥2 ortak kök ya da çoklu son dakikada aynı `item`). Birebir aynı görünmesin diye önceki
kullanımın bittiği saniyeden başlar (`videoStart`), video biterse başa sarar; kanca dikey, kart yatay ise görüntü bu
bölümün boyutuna yeniden çerçevelenir. Hiçbir bölümde video yoksa fotoğraflara geçilir.
Fotoğraf yine indirilir (kapak ve video bulunamazsa arka plan için).

FARKLI FARKLI GÖRSELLER (kullanıcı isteği: "video yoksa farklı farklı görseller; tek görsel ile üretmek mantıksız,
mecbur kalırsak tek görsel"): videosuz bölüme süresine göre clamp(ceil(süre / 3,5 sn), 1, 4) fotoğraf düşer, Remotion
`MediaBg` bunları çapraz kararmalı Ken Burns slaytı olarak oynatır. Önce hiçbir bölümde kullanılmamış fotoğraflar
verilir; yetmezse en az kullanılan tekrar girer (ardışık bölümlerin ilk fotoğrafı aynı olmaz). İlk fotoğraf haberin kendi
fotoğrafıdır (og:image/RSS, en büyüğü); ilk haber kancadan önce seçer, kapak (Thumb) haberin kendi fotoğrafı kalır. Görsel havuzu sırayla:
haberin kendi sayfası (og:image, twitter:image, image_src, RSS görseli; sonra JSON-LD "image", makale gövdesindeki
<img> — src/data-src/data-original/data-lazy-src/srcset'in en büyüğü —, <figure> ve galeri görselleri), aynı haberin
diğer bölümlerinin sayfaları, aynı olayı veren diğer siteler (`same_story_pages`) ve haber araması (`searched_pages`).
Logo/ikon/reklam/avatar/piksel adresleri (kelime yalnız kısa dizin/dosya adında: "logo.png", "/icons/"; haberin kendi
fotoğrafında kelimeye bakılmaz) ve küçükler (ek görselde en az 400x250, oran 0,4-3,2) elenir. Aynı fotoğrafın farklı
boy/site kopyaları ffmpeg ile çıkarılan 9x8 gri "fark özeti" (dHash) ile tek sayılır: tüm kare ≤ 10 ya da ortadaki kare
≤ 8 bit fark; dokusu az görselde (açıklama/tweet ekran görüntüsü, düz grafik, renk geçişi) ≤ 2; en büyüğü kalır. Bütçe: ek fotoğraf için video başına en çok `media.imageTries` (40) indirme ve 10 ek
sayfa, T0'dan `videoSearchSeconds + imageSearchSeconds` (420 + 120 sn) sonra ek fotoğraf aranmaz; haberin kendi
fotoğrafı (og:image, RSS) eskisi gibi bölüm başına 8 denemeyle, süre sınırı olmadan alınır (kapak eksik kalmasın).
Yeniden yayında eski videonun fotoğrafları (imageSrcs) indirilip özetleri çıkarılır, başka adresteki kopyaları da elenir.

Kaynak sırası (segment başına):
  1. Haberin kendi sayfası (articleUrl): og:image, twitter:image, image_src → yayıncının tam boy fotoğrafı.
     Video: önce yt-dlp (açık kaynak, binlerce siteyi tanır; sayfaya gömülü oynatıcıdaki videoyu bulur,
     en çok 1080p ve yalnızca ilk N saniyeyi indirir), olmazsa sayfadaki og:video / <video> / JSON-LD
     contentUrl adresleri ffmpeg ile (mp4 ya da m3u8); en son sayfadaki gömülü YouTube/Dailymotion/Vimeo
     oynatıcısı yt-dlp ile (kullanıcı kararıyla açık; settings.media.allowYoutubeEmbeds). YouTube için yt-dlp
     JavaScript çalıştırıcısı olarak Node kullanır (Remotion için zaten kurulu) ve yt-dlp-ejs bileşenini ister.
  2. RSS'in verdiği küçük görsel (imageUrl).
  Her görsel adresi için önce bilinen HD sürümleri denenir (BBC ichef genişliği, AA thumbs_b_c, WordPress
  -800x450 eki, ?w= parametresi); çalışan en büyük sürüm alınır.

Çıktılar (public/images/, git dışı):
  seg-XX-k.jpg      1840x1120 haber kartı (fotoğraf geniş ise kırpılır, değilse bulanık zemin + tam fotoğraf), k = 0..3
  seg-XX-k-tall.jpg 1080x1920 kanca/dikey kapak: fotoğrafın TAMAMI keskin, arkası aynı fotoğrafın bulanığı
  vid-XX.mp4        haber videosu (sessiz, en çok settings.media.maxVideoSeconds sn), kart için 1280x780,
                    kanca için 1080x1920; aynı bulanık zemin yöntemi. Büyütme lanczos ile, JPEG kalite 2.
episode.json: `images`/`imagesTall` (slayt), `image`/`imageTall` ilk fotoğraf (kapak ve Thumb), `imageSrc` ilk fotoğrafın
adresi, `imageSrcs` hepsi (yeniden yayında kaçınılır), `video`/`videoDuration`/`videoStart`/`videoSrc`.
"""
import html
import json
import math
import os
import re
import shutil
import ssl
import subprocess
import sys
import time
import urllib.parse
import urllib.request
from html.parser import HTMLParser
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
         "imageSearchSeconds": 120, "imageTries": 40, **(settings().get("media") or {})}
T0 = time.time()
SECS_PER_IMG = 3.5   # videosuz bölümde her fotoğrafın ekranda kalma süresi (bölüme en çok 4 fotoğraf)
IMG_PAGES = 10       # fotoğraf için açılan ek haber sayfası (video başına)
# tek konulu anlık haber: bütün kanca/haber bölümleri aynı olay (çoklu son dakikada ANLIK_MULTI ile her haber ayrı)
SINGLE = os.environ.get("ANLIK") == "1" and not os.environ.get("ANLIK_MULTI")
# Yeniden yayın (REMAKE=1, panel "🔁 Yeniden yayınla"): eski videonun haber sayfaları ve görsel kaynakları kullanılmaz
REMAKE = os.environ.get("REMAKE") == "1"
try:
    _rj = json.loads((ROOT / "work" / "remake.json").read_text(encoding="utf-8")) if REMAKE else {}
    AVOID = set(_rj.get("avoid") or [])
except Exception:
    _rj, AVOID = {}, set()
OLD_IMGS: list = []  # eski videoda gösterilen fotoğraflar: başka adresteki/boydaki kopyaları da kullanılmaz (özetle)
try:  # eski videonun slaytındaki TÜM fotoğraflar da (imageSrcs; panelin avoid listesi yalnız ilkini bilir)
    _old = json.loads((ROOT / "out" / Path(_rj.get("of") or "").with_suffix(".json").name).read_text(encoding="utf-8")) if _rj.get("of") else {}
    OLD_IMGS = [u for s in _old.get("segments", []) for u in (s.get("imageSrcs") or [s.get("imageSrc")]) if u]
    AVOID |= set(OLD_IMGS)
except Exception:
    pass
OLD_IMGS = list(dict.fromkeys(OLD_IMGS + [u for u in AVOID if re.search(r"\.(?:jpe?g|png|webp)(?:\?|$)", u, re.I)]))


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
EMPTY = ([], [], [], [])
# makale gövdesi sayılan kaplar ve içindeki fotoğrafı ALINMAYAN bloklar (ilgili haber, yan sütun, reklam, yorum, menü…)
BODY_CLS = re.compile(r"article|haber[-_]?(?:detay|metin|icerik|govde|text|content|body)|news[-_]?(?:detail|content|body|text)|"
                      r"detail[-_]?(?:content|text|body)|entry[-_]?content|post[-_]?(?:content|body)|content[-_]?(?:body|detail|text)|"
                      r"story[-_]?body|galeri|gallery", re.I)
SKIP_CLS = re.compile(r"related|ilgili|benzer|diger|other|recommend|oneri|sidebar|comment|yorum|footer|navbar|menu|social|share|paylas|"
                      r"banner|advert|reklam|(?<![a-z])ads?(?![a-z])|promo|outbrain|taboola|widget|most[-_]?read|popular|cok[-_]?okunan|"
                      r"author|yazar|swiper|slider|carousel|manset|breadcrumb|logo|(?<![a-z])(?:list|liste|feed|more|next|prev)(?![a-z])", re.I)


def _largest(srcset: str) -> str:
    """srcset içindeki en büyük (w ya da x tanımlı) adres."""
    best, bv = "", -1.0
    for u, v in re.findall(r"([^\s,][^\s]*)\s+(\d+(?:\.\d+)?)[wx]", srcset):
        if float(v) > bv:
            best, bv = u, float(v)
    return best or (srcset.split()[0].strip(",") if srcset.strip() else "")


class _BodyImgs(HTMLParser):
    """Makale gövdesindeki (<article>, articleBody, haber-detay… kabı), <figure> ve galeri içindeki fotoğraf adresleri.
    İlgili haber/yan sütun/reklam/yorum blokları atlanır; birden çok gövde kabı varsa en çok fotoğraflısı alınır
    (ilgili haber kartları tek tek <article> olur, asıl haberin gövdesi tek kapta çok fotoğraflıdır)."""
    VOID = {"img", "br", "hr", "meta", "link", "input", "source", "wbr", "area", "base", "col", "embed", "param", "track"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.stack: list = []    # [etiket, tür ("body" | "skip" | "fig" | ""), en dıştaki gövde kabının no'su]
        self.regions: dict = {}  # gövde kabı no → adresler
        self.figs: list = []     # gövde dışındaki <figure> fotoğrafları
        self.n = 0

    def handle_starttag(self, tag, attrs):
        a = {k: (v or "") for k, v in attrs}
        if tag in ("img", "source", "a"):
            self._media(tag, a)
        if tag in self.VOID or tag in ("html", "body"):
            return
        key = f"{a.get('class', '')} {a.get('id', '')} {a.get('itemprop', '')}"
        kind = ("skip" if tag in ("aside", "nav", "footer") or SKIP_CLS.search(key) else
                "body" if tag == "article" or BODY_CLS.search(key) else "fig" if tag == "figure" else "")
        region = self.stack[-1][2] if self.stack else None
        if region is None and kind == "body":
            self.n += 1
            region = self.n
        self.stack.append([tag, kind, region])

    def handle_endtag(self, tag):
        for k in range(len(self.stack) - 1, -1, -1):  # kapanmamış <p>/<li> gibi etiketler de düşer
            if self.stack[k][0] == tag:
                del self.stack[k:]
                return

    def _media(self, tag, a):
        kinds = [k for _, k, _ in self.stack]
        region = self.stack[-1][2] if self.stack else None
        if "skip" in kinds or (region is None and "fig" not in kinds):
            return
        if tag == "a":  # galeri: küçük resmin bağlandığı tam boy fotoğraf
            u = a.get("href", "")
            if not re.search(r"\.(?:jpe?g|png|webp)(?:\?|$)", u, re.I):
                return
        else:
            try:  # genişlik/yükseklik yazılı küçük resim (ikon, simge) alınmaz
                if 0 < int(a.get("width") or 0) < 200 or 0 < int(a.get("height") or 0) < 120:
                    return
            except ValueError:
                pass
            u = _largest(a.get("data-srcset") or a.get("srcset") or "") or next(
                (a[k] for k in ("data-original", "data-src", "data-lazy-src", "data-lazy", "src") if a.get(k) and not a[k].startswith("data:")), "")
        if u and not re.search(r"\.(?:mp4|m3u8|webm|mov)(?:\?|$)", u, re.I):
            (self.regions.setdefault(region, []) if region is not None else self.figs).append(u)

    def result(self) -> list:
        return max(self.regions.values(), key=len, default=[]) + self.figs


def _ld_images(page: str) -> list:
    """JSON-LD "image" alanları (adres, dizi ya da ImageObject); yayıncı logosu ve yazar fotoğrafı alınmaz."""
    out = []

    def img(v):
        if isinstance(v, str):
            out.append(v)
        elif isinstance(v, list):
            for x in v:
                img(x)
        elif isinstance(v, dict):
            img(v.get("contentUrl") or v.get("url") or "")

    def walk(o):
        if isinstance(o, list):
            for x in o:
                walk(x)
        elif isinstance(o, dict):
            t = o.get("@type")
            if re.search(r"Organization|Person|WebSite|Brand", " ".join(t) if isinstance(t, list) else str(t or "")):
                return
            if "image" in o:
                img(o["image"])
            for k, v in o.items():
                if k not in ("image", "publisher", "author", "creator", "logo", "brand", "sourceOrganization"):
                    walk(v)

    for raw in re.findall(r"<script[^>]+application/ld\+json[^>]*>(.*?)</script>", page, re.S | re.I):
        try:
            walk(json.loads(raw.strip(), strict=False))
        except Exception:
            pass
    return out


def page_media(url: str) -> tuple[list, list, list, list]:
    """Haber sayfasındaki görsel adresleri (og:image…), doğrudan video dosyaları, gömülü oynatıcılar ve ek fotoğraflar
    (JSON-LD, makale gövdesi, <figure>/galeri) — mutlak adres, önem sırasıyla."""
    try:
        page = get(url, 3 * 1024 * 1024, timeout=15).decode("utf-8", "replace")
    except Exception as e:
        print(f"  ! haber sayfası açılamadı ({url[:60]}): {e}", file=sys.stderr)
        return EMPTY
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
    body = _BodyImgs()
    try:
        body.feed(page)
        body.close()
    except Exception:
        pass
    imgs = uniq(imgs)
    extra = [u for u in uniq(_ld_images(page) + body.result()) if u not in imgs][:12]
    return imgs, vids, embeds, extra


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


# ---------- fotoğraf havuzu: farklı fotoğraflar, aynı fotoğrafın kopyaları tek ----------
JUNK = re.compile(r"(?<![a-z])(?:logo|icon|favicon|avatar|sprite|banner|ads?|advert|reklam|pixel|placeholder|blank|spacer|loading|emoji)s?(?![a-z])", re.I)
JUNK_HOST = re.compile(r"doubleclick|googlesyndication|google-analytics|googletagmanager|scorecardresearch|facebook\.com/tr|adservice|criteo|taboola|outbrain", re.I)
_photos: list = []      # benzersiz fotoğraflar {f, w, h, u, hash}; fotoğraf no = sıra
_url_photo: dict = {}   # indirilen adres → fotoğraf no (None: indirilemedi ya da fotoğraf değil)
_url_small: dict = {}   # yalnız ek görsel eşiğine (400x250) takılan adres → (dosya, w, h): kendi fotoğrafı olarak istenirse (300x200) alınır
_tries = 0              # ek fotoğraf indirme denemesi, video başına (media.imageTries)
_ptries = 0             # haberin kendi fotoğrafı (og:image, RSS) için deneme
_ptry_cap = 8           # main() bölüm sayısı × 8 yapar (eski best_image sınırı)
_pages_opened = 0       # fotoğraf için açılan ek haber sayfası (IMG_PAGES)
_searched: dict = {}    # haber araması sonuçları (video ve fotoğraf aynı aramayı kullanır)


def junk_img(u: str, primary: bool = False) -> bool:
    """Logo, ikon, reklam, avatar, sayaç pikseli gibi haber fotoğrafı olmayan adresler. Kelime yalnız kısa dizin/dosya
    adında aranır ("logo.png", "/icons/", "banner_728x90.jpg"): başlıktan üretilen uzun adlar ("google-pixel-10-tanitildi.jpg",
    "thy-yeni-logo-tanitildi.jpg") elenmez. Haberin kendi fotoğrafında (og:image, RSS; primary) kelimeye hiç bakılmaz
    (eski davranış): yalnız reklam alan adı ve uzantı; boyut eşiği zaten var."""
    p = urllib.parse.urlsplit(u)
    if JUNK_HOST.search(p.netloc + p.path) or re.search(r"\.(?:svg|gif|ico)$", p.path, re.I):
        return True
    if primary:
        return False
    path = urllib.parse.unquote(p.path)
    if re.search(r"(?<!\d)1x1(?!\d)", f"{path}?{p.query}"):
        return True
    for part in path.split("/"):  # ölçü parçası (300x250) kelime sayılmaz
        words = [w for w in re.split(r"[\W_]+", re.sub(r"\.\w{2,4}$", "", part)) if w and not re.fullmatch(r"\d+x\d+", w)]
        if len(words) <= 2 and JUNK.search(part):
            return True
    return False


def avoided(u: str) -> bool:
    return u in AVOID or bool(set(hd_variants(u)) & AVOID)


def img_time_ok() -> bool:
    """Ek fotoğraf araması için süre (video aramasının sınırı + imageSearchSeconds)."""
    return time.time() - T0 < float(MEDIA.get("videoSearchSeconds") or 420) + float(MEDIA.get("imageSearchSeconds") or 120)


def img_hash(f: Path):
    """9x8 gri ölçek fark özeti (dHash): tüm fotoğraf ve ortadaki kare (aynı fotoğrafın farklı oranda kırpılmış kopyası da
    yakalansın); her özetle birlikte dokusu: belirgin (> 3 gri düzey) komşu farklarının AZ olan yöndeki sayısı (düz zeminde
    de tek yönlü renk geçişinde de küçük, fotoğrafta büyük). Düz renk (boş yer tutucu) ya da okunamayan dosya için None."""
    flt = "[0:v]split[a][b];[a]scale=9:8:flags=area[x];[b]crop=min(iw\\,ih):min(iw\\,ih),scale=9:8:flags=area[y];[x][y]vstack,format=gray"
    try:
        px = subprocess.run(["ffmpeg", "-v", "error", "-i", str(f), "-frames:v", "1", "-filter_complex", flt, "-f", "rawvideo", "-pix_fmt", "gray", "-"],
                            capture_output=True, timeout=30).stdout
    except subprocess.TimeoutExpired:
        return None
    if len(px) < 144 or max(px[:72]) - min(px[:72]) < 6:
        return None

    def bits(o):
        b = down = up = 0
        for y in range(8):
            for x in range(8):
                left, right = px[o + y * 9 + x], px[o + y * 9 + x + 1]
                b = b << 1 | (left > right)
                down += left - right > 3
                up += right - left > 3
        return b, min(down, up)
    return bits(0), bits(72)


def _same_photo(a, b) -> bool:
    """Aynı fotoğraf mı: tüm kare özeti ≤10 ya da (farklı oranda kırpılmış kopya) ortadaki kare özeti ≤8 bit farklı.
    Dokusu az özette (beyaz zeminli açıklama/tweet ekran görüntüsü, düz grafik, renk geçişi: doku < 8) bit'lerin çoğu boş
    zeminden ya da geçişin yönünden gelir, farklı görseller de yakın çıkar: orada neredeyse birebir aynılık (≤2) aranır."""
    return any(bin(x ^ y).count("1") <= (lim if min(tx, ty) >= 8 else 2)
               for (x, tx), (y, ty), lim in ((a[0], b[0], 10), (a[1], b[1], 8)))


def _add_photo(f: Path, w: int, h: int, u: str):
    """İndirilen fotoğrafı havuza koyar; aynı fotoğrafın başka kopyası varsa büyüğü kalır. Fotoğraf no ya da None."""
    hs = img_hash(f)
    if not hs:
        f.unlink(missing_ok=True)
        return None
    for k, p in enumerate(_photos):
        if _same_photo(hs, p["hash"]):
            if w * h > p["w"] * p["h"]:  # aynı fotoğrafın büyük kopyası: küçüğü silinir (özet de büyüğün)
                p["f"].unlink(missing_ok=True)
                p.update(f=f, w=w, h=h, u=u, hash=hs)
            else:
                f.unlink(missing_ok=True)
            return k
    _photos.append({"f": f, "w": w, "h": h, "u": u, "hash": hs})
    return len(_photos) - 1


def get_photo(base: str, referer: str, primary: bool):
    """Adresin çalışan en büyük HD sürümünü indirir; fotoğraf no ya da None. Kendi sayfasının fotoğrafı (primary) eski
    eşikle (300x200), kendi bütçesiyle ve süre sınırı olmadan (kapak eksik kalmasın); ek fotoğraf en az 400x250,
    media.imageTries bütçesi ve süre içinde."""
    global _tries, _ptries
    for u in hd_variants(base):
        if primary and u in _url_small:  # önce ek görsel olarak indirilip küçük bulunmuştu: kendi eşiğiyle yeniden bakılır
            f, w, h = _url_small.pop(u)
            _url_photo[u] = _add_photo(f, w, h, u)
        if u in _url_photo:
            if _url_photo[u] is not None:
                return _url_photo[u]
            continue
        if primary and _ptries >= _ptry_cap or not primary and (_tries >= int(MEDIA.get("imageTries") or 40) or not img_time_ok()):
            return None
        if primary:
            _ptries += 1
        else:
            _tries += 1
        pid = None
        try:
            data = get(u, 25 * 1024 * 1024, referer=referer)
            f = OUT / f"img-{_ptries + _tries:03d}.raw"
            f.write_bytes(data)
            w, h, _ = probe(f)
            mw, mh = (300, 200) if primary else (400, 250)
            if w >= mw and h >= mh and 0.4 < w / h < 3.2:  # logo, ikon, şerit değil
                pid = _add_photo(f, w, h, u)
            elif not primary and w >= 300 and h >= 200 and 0.4 < w / h < 3.2:
                _url_small[u] = (f, w, h)  # dosya kalır (iş sonunda *.raw silinir)
            else:
                f.unlink(missing_ok=True)
        except Exception:
            pass
        _url_photo[u] = pid
        if pid is not None:
            return pid  # bu adayın en büyük çalışan sürümü bulundu
    return None


def iter_photos(srcs: list, pages: dict, strict: bool = True):
    """Kaynakları sırayla açıp fotoğraf numaralarını verir; tembeldir, yeterince fotoğraf bulununca durulur.
    Kaynak: ("all", [(adres, referer, primary)…]) hepsi indirilir, en büyüğü önce verilir, ("urls", […])
    tek tek, ("page", sayfa) açılınca fotoğrafları, ("search", sorgu) haber aramasında bulunan sayfalar.
    strict=False: yeniden yayında başka fotoğraf yoksa eski videonun fotoğrafı da girer (hiç görsel olmamasından iyi)."""
    global _pages_opened
    done_u, done_p = set(), set()
    queue = list(srcs)
    while queue:
        kind, val = queue.pop(0)
        if kind == "search":
            if img_time_ok():
                queue[0:0] = [("page", p) for p in searched(val)]
            continue
        if kind == "page":
            if not val or val in done_p:
                continue
            done_p.add(val)
            if val not in pages:
                if _pages_opened >= IMG_PAGES or not img_time_ok():
                    continue
                _pages_opened += 1
                pages[val] = page_media(val)
            imgs, _, _, extra = pages[val]
            queue[0:0] = [("urls", [(u, val, False) for u in imgs + extra])]
            continue
        got = []
        for u, ref, primary in val:
            if u in done_u or junk_img(u, primary) or strict and avoided(u):
                continue
            done_u.add(u)
            pid = get_photo(u, ref, primary)
            if pid is None or strict and _photos[pid].get("banned"):
                continue
            if kind == "all":
                got.append(pid)
            else:
                yield pid
        # haberin kendi fotoğrafları (og:image, twitter:image, RSS): en büyüğü önce (eski best_image; kapak bunu alır)
        yield from sorted(dict.fromkeys(got), key=lambda p: -_photos[p]["w"] * _photos[p]["h"])


def photo_sources(i: int, info: dict, pages: dict, seg: dict) -> list:
    """Bölümün fotoğraf kaynakları önem sırasıyla: kendi sayfası (og:image, RSS, sonra gövde/JSON-LD/galeri), aynı haberin
    diğer bölümlerinin sayfaları, aynı olayı veren diğer siteler, haber araması. Yeniden yayında önce diğer siteler."""
    art, rss = info[i]["art"], info[i]["rss"]
    imgs, _, _, extra = pages.get(art, EMPTY) if art else EMPTY
    own = [("all", [(u, art or "", True) for u in imgs + ([rss] if rss else [])]), ("urls", [(u, art or "", False) for u in extra])]
    story = [("page", info[j]["art"]) for j in info if j != i and info[j]["art"] and info[j]["art"] != art and same_story(info[i], info[j])]
    other = [("page", p) for p in same_story_pages(seg, art or "")]
    search = [("search", info[i]["query"])] if info[i]["query"] else []
    return other + own + story + search if REMAKE else own + story + other + search


def render_photo(pid: int, i: int, k: int, done: dict):
    """Fotoğrafı kart (1840x1120) ve dikey (1080x1920) boyuta getirir; başka bölümde zaten ölçeklendiyse kopyalar."""
    card, tall_f = OUT / f"seg-{i:02d}-{k}.jpg", OUT / f"seg-{i:02d}-{k}-tall.jpg"
    if pid not in done:
        p = _photos[pid]
        ok1 = ff(["-i", str(p["f"]), "-filter_complex", "[0:v]" + frame_filter(p["w"], p["h"], 1840, 1120), "-frames:v", "1", "-q:v", "2", str(card)])
        ok2 = ff(["-i", str(p["f"]), "-filter_complex", "[0:v]" + fill_filter(1080, 1920), "-frames:v", "1", "-q:v", "2", str(tall_f)])
        done[pid] = (card if ok1 else None, tall_f if ok2 else None)
        return done[pid]
    c0, t0 = done[pid]
    if c0:
        shutil.copyfile(c0, card)
    if t0:
        shutil.copyfile(t0, tall_f)
    return card if c0 else None, tall_f if t0 else None


def same_story(a: dict, b: dict) -> bool:
    """İki bölüm aynı haber mi: tek konulu anlıkta hepsi; çoklu son dakikada aynı haber no; diğerlerinde aynı haber
    sayfası ve ≥2 ortak kök (farklı haber aynı sayfaya eşlenmiş olabilir)."""
    if SINGLE:
        return True
    if a.get("item") and b.get("item"):
        return a["item"] == b["item"]
    return bool(a["art"]) and a["art"] == b["art"] and len(a["kw"] & b["kw"]) >= 2


def video_slot(used: dict, key: str, dur: float, need: float) -> float:
    """Aynı video başka bölümde de oynuyorsa önceki kullanımın bittiği saniyeden başlar; video biterse başa sarar."""
    start = used.get(key, 0.0) % dur if dur > 0 else 0.0
    if dur - start < min(2.0, dur / 2):  # sonunda oynatacak kadar görüntü kalmadıysa baştan
        start = 0.0
    used[key] = start + need
    return round(start, 1)


def reframe_video(src: Path, dst: Path, w: int, h: int) -> float:
    """Paylaşılan videoyu bu bölümün boyutuna getirir: dikeyden karta ortadan kırpılır (görüntü ortada, bulanık zemin
    kenarda kalır), karttan dikeye bulanık zeminle sığdırılır. Süresini döndürür (0 = olmadı)."""
    sw, sh, _ = probe(src)
    if not sw:
        return 0.0
    flt = cover_filter(w, h) if sh > sw and w > h else frame_filter(sw, sh, w, h)
    ok = ff(["-i", str(src), "-filter_complex", "[0:v]" + flt, "-an", "-r", "30", "-c:v", "libx264", "-preset", "medium", "-crf", "19",
             "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(dst)], timeout=240)
    return probe(dst)[2] if ok and dst.exists() else 0.0


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


def searched(query: str) -> list:
    """Aynı sorgu video ve fotoğraf için bir kez aranır."""
    if query not in _searched:
        _searched[query] = searched_pages(query)
    return _searched[query]


def youtube_search(query: str, dst: Path, w: int, h: int, secs: float, used: dict | None = None) -> tuple[float, str]:
    """YouTube'da en yeni videolar arasında haber başlığıyla arar; başlığı uyuşan ilk videonun ilk saniyelerini alır
    (`used`: bu video önceki bölümde oynadıysa o saniyeler de alınır ki bu bölüm kaldığı yerden devam etsin)."""
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
        d = fetch_video_ytdlp(url, dst, w, h, min(float(MEDIA.get("maxVideoSeconds") or 20), secs + (used or {}).get(url, 0.0)))
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
    _, vids, embeds, _ = pages[page]
    d = fetch_video(vids, page, dst, w, h, secs) if vids else 0.0
    if not d and MEDIA.get("allowYoutubeEmbeds"):
        for emb in embeds[:2]:
            d = fetch_video_ytdlp(emb, dst, w, h, secs)
            if d:
                break
    return d


def _sn(x: float) -> str:
    return f"{x:.1f}".replace(".", ",")


def main():
    global _ptry_cap
    ep_path = Path(sys.argv[1])
    ep = json.loads(ep_path.read_text(encoding="utf-8"))
    OUT.mkdir(parents=True, exist_ok=True)
    for f in list(OUT.glob("seg-*")) + list(OUT.glob("vid-*")) + list(OUT.glob("*.raw")):
        f.unlink()
    pages: dict = {}
    found_src: dict = {}  # haber sayfası → videonun bulunduğu kaynak (aynı haberin kanca + kart segmentleri)
    first_haber = next((k for k, x in enumerate(ep["segments"]) if x.get("kind") == "haber"), -1)
    n_img = n_vid = n_hd = n_cards = 0
    info: dict = {}     # bölüm no → {art, rss, kw, query, tall, item} (fotoğraf havuzu ve aynı haber kararı için)
    videos: list = []   # bulunan videolar {i, path, dur, src, tall}: aynı haberin videosuz bölümleri bunları oynatır
    used_s: dict = {}   # video kaynağı → kullanılan son saniye (aynı videonun sonraki kullanımı oradan başlar)
    # şablon video (deprem/maç/piyasa/takvim): her kanca/haber segmentine sırayla bilgi kartı, arama yapılmaz
    from info_card import cards_for_episode
    cards, k = cards_for_episode(), 0
    for i, seg in enumerate(ep["segments"] if not cards else []):
        art, rss = seg.get("articleUrl"), seg.get("imageUrl")
        if seg.get("kind") in ("hook", "haber", "sesli") and (art or rss or MEDIA.get("video")):
            query = seg.get("title") if seg.get("kind") == "haber" else (next((x.get("title") for x in ep["segments"] if x.get("kind") == "haber"), "") or seg.get("title"))
            info[i] = {"art": art, "rss": rss, "kw": _stems(f"{seg.get('title', '')} {seg.get('narration', '')}"), "tall": seg["kind"] == "hook",
                       "query": f"{query or ''} {' '.join((seg.get('narration') or '').split()[:6])}".strip(), "item": seg.get("item")}
    # 1) her bölüm için video araması (fotoğraflar sonra, havuzdan dağıtılır)
    for i, seg in enumerate(ep["segments"]):
        if seg.get("kind") not in ("hook", "haber", "sesli"):
            continue
        if cards:
            c = cards[k % len(cards)]
            k += 1
            card, tall_f = OUT / f"seg-{i:02d}.jpg", OUT / f"seg-{i:02d}-tall.jpg"
            shutil.copyfile(ROOT / c["card"], card)
            shutil.copyfile(ROOT / c["tall"], tall_f)
            seg["image"], seg["imageTall"], seg["imageSize"] = f"images/{card.name}", f"images/{tall_f.name}", "1840x1120"
            seg["infoCard"] = True
            if c.get("video") and (ROOT / c["video"]).exists():  # derleme: eski videodan kesilmiş haber görüntüsü
                dst = OUT / f"vid-{i:02d}.mp4"
                shutil.copyfile(ROOT / c["video"], dst)
                seg["video"], seg["videoDuration"], seg["infoCard"] = f"images/{dst.name}", c.get("videoDuration") or 8, False
                if c.get("sound"):  # videonun kendi sesi bu bölümde duyulur (FullFrame.tsx, sesli bölüm)
                    seg["sound"] = True
                if c.get("fullFrame"):  # dikey video tüm kareyi kaplar (FullFrame.tsx)
                    seg["fullFrame"] = True
                n_vid += 1
            n_img += 1
            n_cards = min(len(cards), n_cards + 1)
            continue
        if i not in info:
            continue
        art, tall, seg_kw, query = info[i]["art"], info[i]["tall"], info[i]["kw"], info[i]["query"]
        if art and art not in pages:
            pages[art] = page_media(art)
        need = float(seg.get("duration") or 6)
        # video ÖNCE: kanca dikey tam ekran, haber kartı 1280x780 (kart oranı 920x560)
        if MEDIA.get("video"):
            dst = OUT / f"vid-{i:02d}.mp4"
            # aynı haberin sonraki bölümleri de bu videoyu paylaşabilir: onların süresi kadar da indirilir (en çok maxVideoSeconds)
            rest = need + sum(float(ep["segments"][j].get("duration") or 6) for j in info if j > i and same_story(info[i], info[j]))
            secs = min(float(MEDIA.get("maxVideoSeconds") or 20), max(6.0, rest + 1))
            vw, vh = (1080, 1920) if tall else (1280, 780)
            star = tall or seg.get("breaking") or first_haber == i  # kanca ve manşet: süre sınırı yok
            in_budget = lambda: star or time.time() - T0 < float(MEDIA.get("videoSearchSeconds") or 420)
            # kaynağın videosu önceki bölümde oynadıysa o saniyeler de indirilir ki bu bölüm kaldığı yerden devam etsin
            # (kendi sayfası, diğer site, arama ya da YouTube aynı kaynağa çıksa da birebir aynı görüntü tekrar etmesin)
            secs_for = lambda s: min(float(MEDIA.get("maxVideoSeconds") or 20), secs + used_s.get(s, 0.0))
            d, via, src = 0.0, "", ""
            hit = found_src.get(art) if art else None
            # aynı haberin başka segmentinde (kanca ↔ ilk kart) bulunan video kaynağı; farklı haber aynı sayfaya
            # eşlenmişse kullanılmaz (kök uyumu ya da anlık haber şart)
            if hit and hit["src"] not in AVOID and (os.environ.get("ANLIK") == "1" or len(seg_kw & hit["kw"]) >= 2):
                src = hit["src"]
                d = fetch_video_ytdlp(src, dst, vw, vh, secs_for(src)) if "youtube.com/watch" in src else video_from_page(src, pages, dst, vw, vh, secs_for(src))
                via = "aynı haberin videosu" if d else ""
            if not d and art and art not in AVOID:  # yeniden yayında eski haber sayfası atlanır
                d = video_from_page(art, pages, dst, vw, vh, secs_for(art))
                src, via = art, "haber sayfası"
            if not d and in_budget():
                for alt in same_story_pages(seg, art or ""):
                    d = video_from_page(alt, pages, dst, vw, vh, secs_for(alt))
                    if d:
                        src, via = alt, f"aynı haber, {urllib.parse.urlparse(alt).netloc.replace('www.', '')}"
                        break
                    if not in_budget():
                        break
            if not d and in_budget():
                for alt in searched(query):
                    d = video_from_page(alt, pages, dst, vw, vh, secs_for(alt))
                    if d:
                        src, via = alt, f"haber araması, {urllib.parse.urlparse(alt).netloc.replace('www.', '')}"
                        break
            if not d and in_budget():
                d, src = youtube_search(query, dst, vw, vh, secs, used_s)
                via = "YouTube araması" if d else ""
            if d:
                start = video_slot(used_s, src, d, need)
                seg["video"], seg["videoDuration"] = f"images/{dst.name}", round(d, 2)
                if start:
                    seg["videoStart"] = start
                seg["videoSrc"] = src  # kaynak adres (sonraki yeniden yayında aynı görüntü kullanılmasın)
                n_vid += 1
                videos.append({"i": i, "path": dst, "dur": round(d, 2), "src": src, "tall": tall})
                if art and src:
                    found_src.setdefault(art, {"src": src, "kw": seg_kw})
                frm = f", {_sn(start)} sn'den" if start else ""
                print(f"  🎞 video {seg.get('title', '')[:40]}: {d:.1f} sn ({via}{frm})")
            else:
                print(f"  📷 bu bölüm için video bulunamadı: {seg.get('title', '')[:50]}")
    # 2) video bulunamayan bölüm AYNI HABERİN başka bölümündeki videoyu oynatır: önceki kullanımın bittiği saniyeden
    #    başlar (birebir aynı görünmesin), video biterse başa sarar; kanca dikey ↔ kart yatay ise yeniden çerçevelenir
    n_shared = 0
    for i in sorted(info):
        seg = ep["segments"][i]
        pool = [v for v in videos if same_story(info[v["i"]], info[i])] if not seg.get("video") else []
        if not pool:
            continue
        tall = info[i]["tall"]
        v = max(pool, key=lambda x: (x["tall"] == tall, x["dur"]))  # önce aynı yönlü, sonra en uzun video
        path, dur = v["path"], v["dur"]
        if v["tall"] != tall:
            path = OUT / f"vid-{i:02d}.mp4"
            dur = reframe_video(v["path"], path, *((1080, 1920) if tall else (1280, 780)))
            if not dur:
                continue
            videos.append({"i": i, "path": path, "dur": round(dur, 2), "src": v["src"], "tall": tall})
        start = video_slot(used_s, v["src"], dur, float(seg.get("duration") or 6))
        seg["video"], seg["videoDuration"], seg["videoSrc"] = f"images/{path.name}", round(dur, 2), v["src"]
        if start:
            seg["videoStart"] = start
        n_vid += 1
        n_shared += 1
        print(f"  🎞 video (aynı haberin videosu, {_sn(start)} sn'den) {seg.get('title', '')[:50]}")
    # 3) fotoğraflar: videolu bölüme kapak ve yedek için bir fotoğraf (önce bunlar: kapak eksik kalmasın), videosuz bölüme
    #    süresine göre FARKLI fotoğraflar; önce hiç kullanılmamışlar, yetmezse en az kullanılan, ardışık ilk fotoğraf farklı
    _ptry_cap = 8 * max(1, len(info))
    if REMAKE:  # eski videonun fotoğrafları indirilip özetleri çıkarılır: başka sitedeki/boydaki kopyaları da elenir
        for u in OLD_IMGS[:8]:
            pid = get_photo(u, "", True)
            if pid is not None:
                _photos[pid]["banned"] = True
    chosen: dict = {}
    want: dict = {}
    reused: dict = {}
    used_p: dict = {}   # fotoğraf no → videosuz bölümlerde kaç kez gösterildi
    with_video = [i for i in sorted(info) if ep["segments"][i].get("video")]
    # ilk haberin ilk fotoğrafı kapaktır (Thumb, render_thumbs): videosuzsa kancadan önce seçer ki haberin kendi fotoğrafı
    # (og:image) ona kalsın; kanca sonraki farklı fotoğrafı alır
    for i in with_video + sorted((i for i in info if i not in with_video), key=lambda i: (i != first_haber, i)):
        seg = ep["segments"][i]
        try:
            srcs = photo_sources(i, info, pages, seg)
            if i in with_video:
                pid = next(iter_photos(srcs, pages), None)
                if pid is None and REMAKE:
                    pid = next(iter_photos(srcs, pages, strict=False), None)
                chosen[i] = [] if pid is None else [pid]
                continue
            n = max(1, min(4, math.ceil(float(seg.get("duration") or 6) / SECS_PER_IMG)))
            seen, pick = [], []
            for pid in iter_photos(srcs, pages):
                if pid not in seen:
                    seen.append(pid)
                if pid in pick or used_p.get(pid):
                    continue
                pick.append(pid)
                if len(pick) >= n:
                    break
            if not seen and REMAKE:  # yeniden yayında başka fotoğraf yok: mecburen eski fotoğraf
                seen = list(dict.fromkeys(iter_photos(srcs, pages, strict=False)))[:1]
            fresh = len(pick)
            for pid in sorted((p for p in seen if p not in pick), key=lambda p: used_p.get(p, 0)):
                if len(pick) >= n:
                    break
                pick.append(pid)  # yeterli yeni fotoğraf yok: başka bölümde gösterilmiş olan da girer
            # yeni fotoğraflar önde, bulunduğu sırayla: ilk olan haberin kendi fotoğrafı (og:image/RSS, en büyüğü; Thumb/kapak
            # ilk fotoğrafı kullanır), sonra gövde/galeri, diğer siteler; tekrar girenler sonda
            # ardışık bölümler aynı fotoğrafla açılmasın: ilk haber kancadan önce seçtiği için iki komşuya da bakılır
            near = (max((j for j in info if j < i), default=None), min((j for j in info if j > i), default=None))
            firsts = {chosen[j][0] for j in near if j is not None and j not in with_video and chosen.get(j)}
            if pick and pick[0] in firsts:
                k = next((k for k, p in enumerate(pick) if p not in firsts), None)
                alt = next((p for p in seen if p not in firsts), None)
                if k is not None:
                    pick[0], pick[k] = pick[k], pick[0]
                elif alt is not None:
                    pick = [alt] + pick[1:]
            for p in pick:
                used_p[p] = used_p.get(p, 0) + 1
            chosen[i], want[i], reused[i] = pick, n, len(pick) - fresh
        except Exception as e:  # ağ/dosya hatası tüm üretimi düşürmesin
            print(f"  ! görsel seçilemedi ({seg.get('title', '')[:40]}): {str(e)[:80]}", file=sys.stderr)
            chosen.setdefault(i, [])
    done: dict = {}
    distinct = set()
    for i in sorted(chosen):
        seg, title = ep["segments"][i], ep["segments"][i].get("title", "")[:40]
        imgs, talls, srcs, ok = [], [], [], []
        for pid in chosen[i]:
            c, t = render_photo(pid, i, len(imgs), done)
            if not c:
                continue
            imgs.append(f"images/{c.name}")
            if t:
                talls.append(f"images/{t.name}")
            srcs.append(_photos[pid]["u"])
            ok.append(pid)
        if not imgs:
            if info[i]["art"] or info[i]["rss"]:
                print(f"  ! görsel alınamadı: {title}", file=sys.stderr)
            continue
        distinct.update(ok)
        p0 = _photos[ok[0]]
        seg["image"], seg["images"] = imgs[0], imgs
        if talls:
            seg["imageTall"], seg["imagesTall"] = talls[0], talls
        seg["imageSize"] = f"{p0['w']}x{p0['h']}"
        seg["imageSrc"], seg["imageSrcs"] = srcs[0], srcs  # yeniden yayında bu adreslerin hiçbiri kullanılmaz
        n_img += len(imgs)
        if seg.get("video"):
            print(f"  🖼 kapak fotoğrafı {p0['w']}x{p0['h']} {title}")
        elif len(imgs) > 1:
            again = f" ({reused[i]} tanesi başka bölümde de var)" if reused.get(i) else ""
            print(f"  🖼 {len(imgs)} farklı görsel {title}{again}")
        elif want.get(i, 1) > 1:
            print(f"  🖼 tek görsel (başka görsel bulunamadı) {title}")
        else:
            print(f"  🖼 1 görsel {p0['w']}x{p0['h']} {title}")
    n_hd = sum(_photos[p]["w"] >= 1200 for p in distinct)
    for f in OUT.glob("*.raw"):
        f.unlink()
    ep_path.write_text(json.dumps(ep, ensure_ascii=False, indent=2), encoding="utf-8")
    shared = f" ({n_shared} bölümde aynı haberin videosu)" if n_shared else ""
    print(f"{n_img} haber görseli hazır ({len(distinct) + n_cards} farklı, {n_hd} tanesi HD), {n_vid} haber videosu{shared}")


if __name__ == "__main__":
    main()
