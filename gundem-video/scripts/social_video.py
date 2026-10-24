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

YouTube haber linki (kullanıcı isteği, 18 Ekim: "attığım youtube haber linklerini de alsın"): önce video indirilmeden bilgi + altyazı
(elle yazılmış ya da otomatik, tr/en, vtt) alınır (`--skip-download`). Süre ≤ `settings.social.maxSeconds` (600) ise video eskisi
gibi bütün iner. Daha uzunsa (haber programı, uzun röportaj, biten canlı yayın) en çok `longWindowSeconds` (240) sn'lik bölüm
`--download-sections` ile iner: talimatta zaman varsa o ("12:30'dan itibaren", "5. dakikadan", "1:02:10", "12:30-16:00 arası",
"son 3 dakika", "başındaki"; yoksa linkteki t=), yoksa altyazıda başlık + talimat kelimelerine (4 harflik kökler) en çok uyan bölüm
(bütün altyazı satırlarıyla, cümle ortasından başlamaz), o da yoksa konuşmanın başladığı yer. `maxLongSeconds` (3 saat) üstü video
yalnız talimatta/linkte zaman verilirse alınır. YouTube klibi (/clip/) normal yolla iner (aralığı yt-dlp keser). Canlı yayında
yayının son `liveSeconds` (120) sn'si kaydedilir (yt-dlp -g ile HLS adresi, ffmpeg -live_start_index ile geriye dönük), başlamamış
yayın Türkçe hata. Altyazının bölüme denk gelen satırları bölümün
başına göre kaydırılıp `social.captions` [[başlangıç, bitiş, metin], …] olarak verilir: wa_video.py konuşma tanıma bir şey
çıkarmazsa döküm olarak kullanır. YouTube "bot değilim" / giriş / yaş sınırı / üyelere özel / gizli / ülke engeli hatalarında
Türkçe yol gösterilir (YouTube'a giriş yapılmış tarayıcının çerezleri). Diğer platformlarda akış ve yt-dlp argümanları aynı.

  python3 scripts/social_video.py --url URL [--instruction "TALİMAT"] [--kind haber|trend|mizah]
  python3 scripts/social_video.py --film "BAŞLIK"      # fragman tanıma + film adı denemesi (ağsız)
Son satır JSON: {ok, file, social: {platform, handle, uploader, credit, caption, url, views, likes, date, trailer, film, bolum,
tags; YouTube'da ek olarak captions, captionsLang, sourceDuration, window {start, end, reason} (klipte clip: true) ya da live,
liveSeconds; note}, related: [...]}. Öncesindeki "🔗"/"📡" satırları ilerleme logudur (panel loga taşır).
"""
import html
import json
import math
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path
from urllib.parse import urljoin
from urllib.request import urlopen

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import kare_cfg, ROOT, SECRETS, content_kind, news_request, recreate_ask, recreate_on, settings, summary_cfg, summary_secs, trailer_ask  # noqa: E402

PLATFORMS = [(r"instagram\.com", "Instagram"), (r"tiktok\.com", "TikTok"), (r"(^|\.)(x|twitter)\.com", "X"),
             (r"youtube\.com|youtu\.be", "YouTube"), (r"facebook\.com|fb\.watch", "Facebook")]
INBOX = ROOT / "work" / "wa_inbox"
# fragman tanıma (re.I Türkçe I/ı, İ/i eşlemesini yapar; \w Türkçe harfleri kapsar → kelime sınırı doğru çalışır). Yalnız Türkçe
# ekleri alınır: fragmanı, fragmanları, fragmanda… ("fragmantasyon" fragman değil)
_TWORD = r"(?:fragman(?:[ıiae]\w*|l[ae]r\w*|d[ae]\w*)?|trailer(?:s|[ıi]\w*)?|teaser(?:s|[ıi]\w*)?|(?:[öo]n\s*)?tan[ıi]t[ıi]m\w*(?:\s+film\w*)?|[öo]n\s*g[öo]ster[iİı]m\w*)"
# Dizi tanıtım biçimleri (kullanıcı isteği, 24 Ekim: "bazı filmlerin 2. ve 3. fragmanları çıkabiliyor; 16. bölüm tanıtımı, 16. bölüm fragmanı,
# 16. bölüm 1. fragman, 2. fragman, 16. bölüm ön tanıtım, ön gösterim"): bölüm/sezon/final/dizi bağlamındaki "tanıtım(ı)" ("tanıtım filmi/videosu"
# değil), "ön tanıtım" ve "ön gösterim" de fragmandır (`is_trailer`); hangi tanıtım olduğu `promo_info` ile ayrıştırılır (etiket + giriş cümlesi)
# "tanıtım" ardından etkinlik/ürün sözü gelirse dizi tanıtımı değil (tanıtım filmi/videosu/toplantısı/gecesi/lansmanı/stratejisi…)
_PROMO = re.compile(r"(?<!\w)(?:[öo]n\s*tan[ıi]t[ıi]m\w*|[öo]n\s*g[öo]ster[iİı]m\w*|tan[ıi]t[ıi]m(?:[ıi]|lar[ıi]?)?(?!\w)"
                    r"(?!\s*(?:film|video|klip|reklam|spot|toplant|gece|etkinli|lansman|stand|g[üu]n[üu]|t[öo]ren|stratej|ders|kampanya|bro[şs][üu]r|kitap|yaz[ıi]|metn|afi[şs]|turu|gezisi|s[üu]reci)))", re.I)
_SERIES_CTX = re.compile(r"(?<!\w)(?:\d+\s*\.?\s*b[öo]l[üu]m\w*|b[öo]l[üu]m\s*\d+|(?:yeni|son|final)\s+b[öo]l[üu]m\w*|episode\s*\d+|sezon\w*|season\w*|final\w*|dizi\w*|series)(?!\w)", re.I)
_SEASON_PH = re.compile(r"(?<!\w)(?:\d{1,2}\s*\.?\s*sezon\w*|sezon\s*\d{1,2}|season\s*\d{1,2}|(?:yeni|new)\s+(?:sezon|season|b[öo]l[üu]m)\w*|sezon\s+finali|season\s+finale)(?!\w)", re.I)  # "Yeni Bölüm" de ad değil
_FINAL_PH = re.compile(r"(?<!\w)(?:final\s+b[öo]l[üu]m\w*|\(\s*final\w*\s*\)|final(?=\s+(?:fragman|tan[ıi]t[ıi]m|teaser|trailer|[öo]n\s*(?:tan[ıi]t[ıi]m|g[öo]ster))))", re.I)
# otomatik tanıma (kullanıcı "fragman" yazmadan fragman moduna geçer), yanlış pozitifler ayıklanır: "tanıtım filmi" sayılmaz (parti,
# belediye, ürün, üniversite tanıtım filmi film fragmanı değil; talimatta "fragman" yazılırsa yine fragman modu), römork anlamındaki
# trailer ("Truck and trailer crash", "Trailer park fire", "travel trailer") ve fragmandan soru olarak söz eden haber başlığı
# ("Fragman yayınlandı mı? Bakanlık açıklama yaptı") fragman değil. Açıklamada yalnız güçlü ifade (haber açıklamasında "fragman" geçebilir).
TRAILER = re.compile(r"(?<!\w)(?:fragman(?:[ıiae]\w*|l[ae]r\w*|d[ae]\w*)?|trailer(?:s|[ıi]\w*)?|teaser(?:s|[ıi]\w*)?)(?!\w)", re.I)
_VEHICLE = re.compile(r"(?<!\w)(?:(?:tractor|semi|truck|lorry|travel|horse|boat|utility|camper|cargo|car|flatbed|enclosed|dump|livestock|tow|rv)"
                      r"(?:\s+and)?[\s-]+trailers?|trailers?[\s-]+(?:park|parks|home|homes|hitch\w*|truck\w*|crash\w*|fire|tow\w*|camp\w*|house|"
                      r"life|living|sway|wiring|tires?|rental|accident|overturn\w*|jackknif\w*))(?!\w)", re.I)
_DESC_TRAILER = re.compile(r"(?<!\w)(?:official\s+(?:trailer|teaser)|teaser\s+trailer|resm[iî]\s+(?:fragman|teaser)\w*|"
                           r"\d+\s*\.\s*b[öo]l[üu]m\s+(?:\d+\s*\.\s*)?(?:fragman|tan[ıi]t[ıi]m|[öo]n\s*(?:tan[ıi]t[ıi]m|g[öo]ster[iİı]m))\w*)(?!\w)", re.I)
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


# YouTube çerez yolu (kullanıcı isteği, 18 Ekim: YouTube'un "Sign in to confirm you're not a bot" engeli): YouTube'a giriş yapılmış
# tarayıcının çerezleri yt-dlp'ye verilir (panel 📡 "Sosyal medya çerezleri" = settings.social.cookiesFromBrowser)
YT_COOKIES = ("Mac'te YouTube'a giriş yaptığınız tarayıcının adını panelde Ayarlar → 📡 Otomatik içerikler → \"Sosyal medya çerezleri\" "
              "alanına yazın (chrome ya da safari; ya da secrets/social_cookies.txt) ve linki yeniden gönderin.")


def hint(err: str, plat: str) -> str:
    low = err.lower()
    # tarayıcı çerezi okunamadı (yanlış tarayıcı adı, Safari'de Tam Disk Erişimi yok): giriş istemekle karıştırılmasın
    if re.search(r"cookies? database|unsupported browser|failed to decrypt|binarycookies|keyring|cookie\w*.{0,120}(operation not permitted|permission denied)", low):
        return ("Tarayıcı çerezleri okunamadı: panelde \"Sosyal medya çerezleri\" alanındaki tarayıcı adını kontrol edin (chrome, safari, "
                "firefox, edge, brave; o tarayıcıda giriş yapılmış olmalı). Safari için paneli çalıştıran uygulamaya (Terminal) Sistem Ayarları → "
                "Gizlilik ve Güvenlik → Tam Disk Erişimi verin ya da secrets/social_cookies.txt kullanın.")
    if plat == "YouTube":  # YouTube'a özel nedenler (Instagram metni YouTube için yanıltıcıydı)
        if "not a bot" in low or ("confirm you" in low and "bot" in low):
            return "YouTube \"bot olmadığınızı doğrulayın\" diyerek giriş istiyor (çok istek ya da IP adresi yüzünden). " + YT_COOKIES
        if re.search(r"live event will begin|premieres? in|will begin in|is_upcoming|scheduled for|starts in", low):
            return "Yayın henüz başlamadı; başladığında linki yeniden gönderin (canlı yayının son 2 dakikasını alırım)."
        if re.search(r"confirm your age|age[- ]restrict|inappropriate for some users|age-gate", low):
            return "Video yaş sınırlı: YouTube izlemek için yaşı doğrulanmış bir hesapla giriş istiyor. " + YT_COOKIES
        if re.search(r"members[- ]only|join this channel|channel'?s? members|available to this channel", low):
            return "Video yalnız kanal üyelerine açık: üye olan bir YouTube hesabıyla giriş gerekir. " + YT_COOKIES
        if "private video" in low or "video is private" in low:
            return ("Video gizli (özel): yalnız sahibinin izin verdiği hesaplar izleyebilir. Herkese açık ya da liste dışı bir video linki "
                    "gönderin; erişimi olan bir hesabınız varsa: " + YT_COOKIES)
        if re.search(r"(not made this video available|blocked it|not available) in your country|geo[- ]?restrict|geo[- ]?block", low):
            return "Video bu ülkede gösterilmiyor (yükleyen ya da hak sahibi engellemiş); indirilemiyor. Başka bir kaynaktaki videoyu gönderin."
        if "http error 429" in low or "too many requests" in low:
            return "YouTube çok fazla istek yüzünden geçici olarak engelledi (HTTP 429). Biraz sonra yeniden deneyin; sürerse " + YT_COOKIES
        if re.search(r"video unavailable|has been removed|account .{0,60}terminated|no longer available|does not exist", low):
            return "Video kaldırılmış ya da erişilemiyor (YouTube: video kullanılamıyor). Linki kontrol edin."
        if any(k in low for k in ("sign in", "login", "log in", "cookies")):
            return "YouTube bu videoyu girişsiz vermiyor. " + YT_COOKIES
    if "does not pass filter" in low:  # yalnız YouTube'da uzun videodan bölüm seçilir
        return f"Video {round(social_cfg()['maxSeconds'] / 60)} dakikadan uzun; uzun videodan bölüm seçmeyi yalnız YouTube linkinde yapabiliyorum."
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


def _promo_part(x: str) -> bool:
    """Başlık parçası dizi tanıtımı mı ("16. Bölüm Tanıtımı", "Ön Tanıtım", "Ön Gösterim"; soru başlığı değil)."""
    m = _PROMO.search(x)
    return bool(m) and "?" not in _QUOTED.sub(" ", x[m.end():])


def is_trailer(title: str, description: str = "") -> bool:
    """Başlıkta fragman/trailer/teaser geçiyor mu (römork anlamı ve fragmandan soru olarak söz eden başlık parçası hariç, `_trailer_part`)
    ya da açıklamanın ilk ~200 karakterinde güçlü fragman ifadesi; ya da dizi bağlamında (bölüm, sezon, final, dizi — başlıkta ya da
    açıklamanın başında) "tanıtım(ı)" / "ön tanıtım" / "ön gösterim" ("Üniversitemizin tanıtım filmi", "Yeni iPhone ön gösterim" değil)."""
    parts = re.split(r"\s*[|｜•·]\s*|\s+[-–—]\s+|:\s+", _VEHICLE.sub(" ", title or ""))
    if any(_trailer_part(x) for x in parts) or bool(_DESC_TRAILER.search(_VEHICLE.sub(" ", (description or "")[:200]))):
        return True
    ctx = bool(_SERIES_CTX.search(title or "")) or bool(_SERIES_CTX.search((description or "")[:200]))
    return ctx and any(_promo_part(x) for x in parts)


_TR_UNITS = ["", "bir", "iki", "üç", "dört", "beş", "altı", "yedi", "sekiz", "dokuz"]
_TR_TENS = ["", "on", "yirmi", "otuz", "kırk", "elli", "altmış", "yetmiş", "seksen", "doksan"]


def tr_number(n: int) -> str:
    """1-999 yazıyla ("on altı", "yüz", "iki yüz beş")."""
    n = int(n)
    if n <= 0 or n >= 1000:
        return str(n)
    out = []
    if n >= 100:
        out.append(("" if n // 100 == 1 else _TR_UNITS[n // 100] + " ") + "yüz")
    if n % 100 >= 10:
        out.append(_TR_TENS[n % 100 // 10])
    if n % 10:
        out.append(_TR_UNITS[n % 10])
    return " ".join(out)


def tr_ordinal(n: int) -> str:
    """Türkçe sıra sayısı yazıyla: 1 → birinci, 2 → ikinci, 4 → dördüncü, 16 → on altıncı, 100 → yüzüncü (ünlü uyumu; seslendirme için).
    Sayı yazıyla söylenemiyorsa (0, 1000+) "16." biçimi döner."""
    w = tr_number(n)
    if not w or w.isdigit():
        return f"{n}."
    last = w.split()[-1]
    v = [c for c in last if c in "aeıioöuü"][-1]
    sv = {"a": "ı", "ı": "ı", "e": "i", "i": "i", "o": "u", "u": "u", "ö": "ü", "ü": "ü"}[v]
    if last.endswith("t"):  # dört → dördüncü
        last = last[:-1] + "d"
    suffix = ("" if last[-1] in "aeıioöuü" else sv) + "nc" + sv
    return " ".join(w.split()[:-1] + [last + suffix])


def _tr_cap(t: str) -> str:
    return (("İ" if t[0] == "i" else "I" if t[0] == "ı" else t[0].upper()) + t[1:]) if t else t


def promo_info(title: str, description: str = "") -> dict:
    """Fragman başlığından tanıtımın türü: {tur: fragman|teaser|tanitim|on_tanitim|on_gosterim, no (2. fragman → 2), bolum (16. Bölüm → 16),
    sezon, yeniSezon, final, label (Türkçe büyük harf etiket: "16. BÖLÜM 2. FRAGMAN", "16. BÖLÜM TANITIMI", "16. BÖLÜM ÖN GÖSTERİM",
    "FİNAL FRAGMANI", "2. SEZON TANITIMI", "2. FRAGMAN"; sıradan film fragmanında None → eski etiket kuralı), text (giriş cümlesi,
    yazıyla: "On altıncı bölümün ikinci fragmanı.")}. Kullanıcı isteği, 24 Ekim: bir bölümün tanıtımı, 1./2. fragmanı, ön tanıtımı ve ön
    gösterimi ayrı videolardır; hangisi olduğu etikette ve girişte söylenir."""
    t = re.sub(r"\s+", " ", str(title or "")).replace("İ", "i").replace("I", "ı").lower()
    t = _VEHICLE.sub(" ", t)
    g = lambda m: next((x for x in m.groups() if x), None) if m else None  # noqa: E731
    bolum = g(re.search(r"(?<!\w)(?:(\d{1,3})\s*\.?\s*b[öo]l[üu]m\w*|b[öo]l[üu]m\s*(\d{1,3})(?!\w)|episode\s*(\d{1,3})(?!\w))", t))
    sezon = g(re.search(r"(?<!\w)(?:(\d{1,2})\s*\.?\s*sezon\w*|season\s*(\d{1,2})(?!\w)|s(\d{1,2})e\d+(?!\w))", t))
    new_season = bool(re.search(r"(?<!\w)(?:yeni|new)\s+(?:sezon|season)\w*", t))
    season_finale = bool(re.search(r"(?<!\w)(?:sezon\s+finali|season\s+finale)", t))
    final = season_finale or bool(_FINAL_PH.search(t))
    no = g(re.search(r"(?<!\w)(\d{1,2})\s*\.\s*(?=(?:[öo]n\s*)?(?:fragman|trailer|teaser|tan[ıi]t[ıi]m)\w*(?!\w))", t)
           or re.search(r"(?<!\w)(?:fragman|trailer|teaser|tan[ıi]t[ıi]m)\w*\s*#\s*(\d{1,2})(?!\w)|(?<!\w)(?:trailer|teaser)\s+(\d)(?!\w)|(?<!\w)(?:fragman|tan[ıi]t[ıi]m)\w*\s+(\d{1,2})\s*$", t))
    tur = ("on_gosterim" if re.search(r"(?<!\w)[öo]n\s*g[öo]ster[iı]m", t) else "on_tanitim" if re.search(r"(?<!\w)[öo]n\s*tan[ıi]t[ıi]m", t)  # "sezon tanıtımı" ön tanıtım değil
           else "teaser" if re.search(r"(?<!\w)teaser", t) else "tanitim" if _PROMO.search(t) else "fragman")
    bolum, sezon, no = (int(bolum) if bolum else None), (int(sezon) if sezon else None), (int(no) if no else None)
    if no is not None and no == bolum and not re.search(r"(?<!\w)\d{1,2}\s*\.\s*b[öo]l[üu]m\w*\s+\d{1,2}\s*\.", t):
        no = None  # "16. Bölüm Fragmanı": 16 bölüm numarasıdır, fragman sırası değil
    head = f"{bolum}. BÖLÜM" if bolum else f"{sezon}. SEZON" if sezon else "YENİ SEZON" if new_season else ""
    if season_finale and not bolum:
        head = "SEZON FİNALİ"
    elif final:
        head = f"{head} FİNAL".strip()
    has_head = bool(head)
    kind = {"on_gosterim": "ÖN GÖSTERİM", "on_tanitim": "ÖN TANITIM", "teaser": "TEASER", "tanitim": "TANITIMI" if has_head else "TANITIM",
            "fragman": f"{no}. FRAGMAN" if no else "FRAGMANI" if has_head else ""}[tur]
    label = " ".join(x for x in (head, kind) if x)
    if not (has_head or no or tur in ("on_gosterim", "on_tanitim", "tanitim")):
        label = ""  # sıradan film fragmanı / teaser: etiket kuralı değişmez (YENİ FRAGMAN / FRAGMAN)
    if len(label) > 30:
        label = label[:31].rsplit(" ", 1)[0] if " " in label[:31] else label[:30]
    # giriş cümlesi (seslendirme; sayılar yazıyla)
    core = {"on_gosterim": "ön gösterim", "on_tanitim": "ön tanıtımı", "teaser": "kısa fragmanı", "tanitim": "tanıtımı",
            "fragman": f"{tr_ordinal(no)} fragmanı" if no else "fragmanı"}[tur]
    if bolum:
        hs, gen, abl = f"{tr_ordinal(bolum)} bölüm", f"{tr_ordinal(bolum)} bölümün", f"{tr_ordinal(bolum)} bölümden"
    elif season_finale:
        hs, gen, abl = "sezon finali", "sezon finalinin", "sezon finalinden"
    elif sezon:
        hs, gen, abl = f"{tr_ordinal(sezon)} sezon", f"{tr_ordinal(sezon)} sezonun", f"{tr_ordinal(sezon)} sezondan"
    elif new_season:
        hs, gen, abl = "yeni sezon", "yeni sezonun", "yeni sezondan"
    elif final:
        hs, gen, abl = "final bölümü", "final bölümünün", "final bölümünden"
    else:
        hs = gen = abl = ""
    if not label:
        text = ""
    elif final and bolum:
        text = f"{hs}, final {core}." if tur != "on_gosterim" else f"{hs}, finalden ön gösterim."
    elif tur == "on_gosterim":
        text = f"{abl} ön gösterim." if abl else "Ön gösterim."
    elif tur == "tanitim":
        text = f"{hs} tanıtımı." if hs else "Tanıtım."
    elif hs:
        text = f"{gen} {core}."
    else:
        text = f"{core}." if tur != "fragman" else (f"{tr_ordinal(no)} fragman." if no else "Fragman.")
    return {"tur": tur, "no": no, "bolum": bolum, "sezon": sezon, "yeniSezon": new_season, "final": final, "label": label or None,
            "text": _tr_cap(text) if text else None}


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
        if m:  # fragman ifadesinden önce ad varsa o ("Gladiator II - Resmi Fragman"), yoksa sonrası ("TEASER - Avatar"); yalnız bölüm/sezon
            # sözü olan ön kısım ad değildir ("Bölüm 45 Fragman - Uzak Şehir" → Uzak Şehir)
            before, after = _strip(_QUALITY.sub(" ", part[:m.start()])), _strip(_QUALITY.sub(" ", part[m.end():]))
            cand = before if len(re.sub(r"[\W\d_]", "", _FINAL_PH.sub(" ", _SEASON_PH.sub(" ", _EPISODE.sub(" ", before))))) >= 2 else after
        cand = _strip(_QUALITY.sub(" ", _PHRASE.sub(" ", cand)))
        if len(re.sub(r"[\W\d_]", "", cand)) < 2 or _PLATFORM.match(cand) or (up and cand.casefold() == up) or _FAN.match(cand):
            continue
        chosen = cand
        break
    chosen = _STUDIO_PREFIX.sub("", chosen)
    ep = _EPISODE.search(chosen) or _EPISODE.search(t)  # bölüm başlığın başka parçasında da olabilir ("Bölüm 45 Fragman - Uzak Şehir")
    bolum = _strip(ep.group(0)) if ep else ""
    if ep and _EPISODE.search(chosen):
        chosen = _EPISODE.sub(" ", chosen, count=1)
    chosen = _FINAL_PH.sub(" ", _SEASON_PH.sub(" ", chosen))  # "2. Sezon", "Yeni Sezon", "Final Bölümü", "(Final)" ad değil
    chosen = re.sub(r"\s+(?:filmi|dizisi)$", "", _strip(chosen), flags=re.I)
    chosen = _strip(chosen)
    if len(re.sub(r"[\W\d_]", "", chosen)) < 2:  # ad bulunamadı: başlığın fragman/bölüm kelimeleri atılmış hali, o da yoksa boş
        chosen = _strip(_QUALITY.sub(" ", _FINAL_PH.sub(" ", _SEASON_PH.sub(" ", _EPISODE.sub(" ", _PHRASE.sub(" ", re.sub(r"[|｜•·]", " ", t)))))))
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


# ---------- YouTube haber linki (kullanıcı isteği, 18 Ekim: "attığım youtube haber linklerini de alsın"): uzun video, canlı yayın, altyazı
SOCIAL_DEFAULTS = {"maxSeconds": 600, "longWindowSeconds": 240, "maxLongSeconds": 3 * 3600, "liveSeconds": 120}
FMT = "bv*[height<=1080][ext=mp4]+ba[ext=m4a]/bv*[height<=1080]+ba/b[height<=1080]/b"
# Uzun video özeti (kullanıcı isteği, 19 Ekim: "uzun bir YouTube videosu göndersem bunu analiz edip 40 saniyelik habere dökebilir
# miyiz, videodan çarpıcı sahneleri de alarak"): videonun TAMAMI analiz için düşük çözünürlükte iner (kareler, sahne geçişleri, gerekirse
# konuşma tanıma), seçilen anlar sonra `download_sections` ile HD iner. H.264 önce (uzun videoda sahne taraması hızlı olsun).
PROXY_FMT = "bv*[height<=360][vcodec^=avc1]+ba/bv*[height<=360]+ba/b[height<=360]/bv*[height<=480]+ba/b[height<=480]/wv*+ba/w"
# Özet, ses ve haber istekleri Türkçe harfsiz yazımla da tanınır (WhatsApp'ta "ozetle", "carpici sahneler"; inceleme, 19 Ekim): talimat
# `_fold` ile katlanır, kalıplar katlanmış biçimde yazılır. Talimatta açık özet isteği (özet/özetle, summarize, highlights, recap): her
# uzunlukta (90 sn üstü) özet modu; genel sözler (analiz, çarpıcı sahne, en önemli an, öne çıkan) kendi ses isteğinden sonra bakılır
SUMMARY_ASK = re.compile(r"(?<!\w)(?:ozet\w*|summar\w*|highlights?|recap\w*)", re.I)
SUMMARY_HINT = re.compile(r"(?<!\w)(?:analiz\w*|analys\w*|carpici\s+(?:sahne|an|anlar|yer|goruntu|kisim|bolum)\w*|"
                          r"en\s+(?:onemli|carpici|ilginc|dikkat\s+cekici)\s+(?:yer|an|anlar|sahne|kisim|bolum|goruntu)\w*|one\s+cikan\w*)", re.I)
# özet istemeyen talimat: videonun kendi sesi istenirse uzun videoda eski yol (bölüm + kendi sesi). Önce olumsuz istek (sesi kapat,
# orijinal ses olmasın, kendi sesini kullanma, videonun sesi gelmesin, sessiz, yalnız seslendirme) bakılır: kendi ses isteği sayılmaz;
# "ses" sözcüğü bitmeli ("kendi seslendirmenle", "gerçek seslendirme" ses isteği değil); "tamamı/baştan sona" yalnız paylaş/oynat ile
# ("baştan sona izle ve haber yap" uzun videoda özet isteğidir)
NO_KEEP_SOUND = re.compile(r"(?<!\w)ses(?:i|ini|in|leri|lerini)?\s+(?:kapat(?!ma)|kis(?!ma)|olmasin|olmayacak|gitsin|gelmesin|duyulmasin|istemiyorum|"
                           r"kullanma(?!k)|kullanmadan|verme(?!k))|(?<!\w)sessiz|(?:yalniz|sadece|hep)\s+seslendir", re.I)
KEEP_SOUND = re.compile(r"(?:orijinal|kendi|videonun|gercek|asil|dogal)\s+ses(?:i|ini|iyle|le|leri|lerini|leriyle)?(?!\w)|(?<!\w)sesiyle(?!\w)|"
                        r"(?<!\w)ses(?:i|ini)\s+(?:kullan|koru|kalsin|acik|duyulsun|olsun)|"
                        r"(?<!\w)(?:tamam\w*|hepsini|bastan\s+sona)\s+(?:paylas|oynat|yayinla|ver|koy|kullan)\w*", re.I)
# altyazı/başlık eşleşmesinde sayılmayan kelimeler (topic_news.STOP + haber videolarının kalıp sözleri, zaman ve kurgu talimatı)
KW_STOP = {"için", "ile", "olan", "olarak", "sonra", "daha", "göre", "yeni", "oldu", "etti", "dedi", "açıkladı", "haber", "son", "dakika",
           "bugün", "şimdi", "hakkında", "ilgili", "konu", "video", "anlık", "gündem", "olay", "olayı", "kadar", "gibi", "çok", "bir", "iki",
           "ama", "fakat", "veya", "şu", "bu", "da", "de", "mi", "ne", "nasıl", "haberi", "haberler", "haberleri", "videosu", "videoyu",
           "videonun", "canlı", "yayın", "yayını", "izle", "özel", "tıkla", "abone", "kanal", "kanalı", "shorts", "the", "and", "for", "with",
           "yap", "yapın", "hazırla", "üret", "kısım", "kısmı", "kısmını", "bölüm", "bölümü", "bölümünü", "itibaren", "saniye", "arası",
           "sesi", "sesini", "kapat", "kullan", "kes", "başındaki", "baştaki", "sonundaki", "ortasındaki", "anlat", "tarafsız", "lütfen"}


def social_cfg() -> dict:
    """settings.social: sayı alanları bozuk/0 ise varsayılan (600 sn bütün video, 240 sn bölüm, 3 saat üst sınır, canlıda 120 sn)."""
    raw = settings().get("social")
    s = raw if isinstance(raw, dict) else {}

    def num(k: str) -> float:
        try:
            x = float(s.get(k))
        except (TypeError, ValueError):
            return float(SOCIAL_DEFAULTS[k])
        return x if math.isfinite(x) and x > 0 else float(SOCIAL_DEFAULTS[k])
    return {**s, **{k: num(k) for k in SOCIAL_DEFAULTS}}


def _low(t: str) -> str:
    return (t or "").replace("I", "ı").replace("İ", "i").lower()


def _fold(t: str) -> str:
    """Türkçe küçük harf + harfsiz yazım (ö→o, ç→c, ş→s, ü→u, ğ→g, ı→i): "özetle" ile "ozetle" aynı."""
    return _low(t).translate(str.maketrans("öçşüğıâîû", "ocsugiaiu"))


# linke bitişik tür etiketi (panel --kind: link/mizah, link/trend, link/haber); yoksa talimattaki açık etiket (common.content_kind)
KIND_TAG = ""


def kind_of(instruction: str) -> str:
    return KIND_TAG or content_kind(instruction)


def keep_sound(instruction: str) -> bool:
    """Talimat videonun kendi sesini istiyor mu (olumsuzu — "sesi kapat", "orijinal ses olmasın" — istemez)."""
    t = _fold(instruction)
    return not NO_KEEP_SOUND.search(t) and bool(KEEP_SOUND.search(t))


def trailer_auto() -> bool:
    """settings.trailer açık ve başlıktan otomatik tanıma açık mı (server.js trailerCfg ile aynı hoşgörülü kural)."""
    raw = settings().get("trailer")
    t = raw if isinstance(raw, dict) else {"enabled": False} if raw is False or raw == "false" else {}
    off = lambda v: v is False or v == 0 or str(v).strip().lower() in ("false", "0")  # noqa: E731
    return not off(t.get("enabled")) and not off(t.get("autoDetect"))


def hms(t: float) -> str:
    t = int(round(t))
    return f"{t // 3600}:{t % 3600 // 60:02d}:{t % 60:02d}" if t >= 3600 else f"{t // 60}:{t % 60:02d}"


def dur_text(t: float) -> str:
    t = int(round(t))
    if t >= 3600:
        return f"{t // 3600} sa {t % 3600 // 60} dk" if t % 3600 // 60 else f"{t // 3600} saat"
    return f"{t // 60} dk" if t >= 60 else f"{t} sn"


def span_text(t: float) -> str:
    return f"{int(t // 60)} dakika" if t >= 60 and t % 60 < 1 else f"{int(round(t))} saniye"


def parse_vtt(text: str) -> list:
    """WebVTT → [(başlangıç, bitiş, metin)]. YouTube otomatik altyazısı kayan iki satırdır (önceki satır tekrar eder, kelime zaman
    etiketleri <00:00:01.120><c>…</c>, 10 ms'lik geçiş ipuçları): yalnız yeni satır alınır; bitiş sonraki satırın başını geçmez."""
    ts = re.compile(r"(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{3})")
    sec = lambda m: int(m.group(1) or 0) * 3600 + int(m.group(2)) * 60 + int(m.group(3)) + int(m.group(4)) / 1000  # noqa: E731
    cues, prev = [], []
    for block in re.split(r"\n\n+", (text or "").replace("\r", "")):  # yalnız boş satır ayırır: YouTube'un " " satırı ipucunun içindedir
        lines = block.strip("\n").split("\n")
        ti = next((i for i, x in enumerate(lines) if "-->" in x), None)
        if ti is None:
            continue
        a, b = (ts.search(x) for x in lines[ti].split("-->", 1))
        if not a or not b:
            continue
        rows = [(re.search(r"<\d{1,2}:\d{2}[:.]|<c[ .>]", x) is not None,
                 re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]*>", "", x)).replace(chr(0x200B), "")).strip()) for x in lines[ti + 1:]]
        rows = [(tag, x) for tag, x in rows if x]
        raw = [x for _, x in rows]
        if any(tag for tag, _ in rows):  # kelime zamanlı satır yeni söylenendir (aynı cümle art arda söylense de)
            new = [x for tag, x in rows if tag]
        else:  # geçiş ipucu ya da elle yazılmış altyazı: önceki ipucunun son satırı tekrar etmez
            new = [] if raw == prev else raw[1:] if raw and prev and raw[0] == prev[-1] else raw
        if raw:
            prev = raw
        if new:
            cues.append([sec(a), sec(b), " ".join(new)])
    for i in range(len(cues) - 1):
        if cues[i + 1][0] > cues[i][0]:
            cues[i][1] = min(cues[i][1], cues[i + 1][0])
    return [(round(a, 2), round(max(b, a + 0.1), 2), t) for a, b, t in cues]


def pick_captions(stem: str, info: dict) -> tuple[list, str]:
    """İnen altyazılardan en iyisi: elle yazılmış tr → elle en → otomatik özgün dil (-orig) → otomatik tr → otomatik en."""
    manual = set((info.get("subtitles") or {}).keys())
    files = []
    for f in INBOX.glob(f"{stem}.*.vtt"):
        lang = f.name[len(stem) + 1:-4]
        auto = lang not in manual
        files.append(((auto, (0 if lang.endswith("-orig") else 1) if auto else 0, 0 if lang.split("-")[0].lower() == "tr" else 1), lang, f))
    best = ([], "")
    for _, lang, f in sorted(files):
        try:
            cues = parse_vtt(f.read_text(encoding="utf-8", errors="replace"))
        except OSError:
            continue
        if len(cues) >= 3:
            best = (cues, f"{lang}{'' if lang in manual else ' (otomatik)'}")
            break
    for f in INBOX.glob(f"{stem}.*.vtt"):
        f.unlink(missing_ok=True)
    return best


_TSP = r"(\d{1,3})[:.](\d{2})(?:[:.](\d{2}))?"
# aralık: "12:30-16:00", "12:30 ile 16:00", "12:30'dan 16:00'ya kadar" (inceleme, 18 Ekim: Türkçe aralığın sonu yok sayılıyordu);
# "12:30'dan itibaren" aralık değil
_RANGE = re.compile(rf"(?<![\d.:]){_TSP}\s*['’]?\s*(?:(?:d[ae]n|t[ae]n)?\s*(?:[-–—]|ile|ila)|(?:d[ae]n|t[ae]n)\s)\s*{_TSP}(?!\d)")
_FROM = re.compile(rf"(?<![\d.:]){_TSP}\s*['’]?\s*(?:d[ae]n|t[ae]n|d[ae]ki|t[ae]ki|d[ae]|t[ae])(?!\w)")
_HMS = re.compile(r"(?<![\d.:])(\d{1,2}):(\d{2}):(\d{2})(?!\d)")
_COLON = re.compile(r"(?<![\d.:])(\d{1,3}):(\d{2})(?![\d:])")
_ORD = re.compile(r"(?<![\d.,])(\d{1,3})\s*(?:\.|['’]?\s*(?:[ıiuü]nc[ıiuü]|nc[ıiuü]))\s*(dakika|dk|saniye|sn)")
_FROM_N = re.compile(r"(?<![\d.,])(\d{1,3})\s*(dakika|dk|saniye|sn)\w*?\s*['’]?\s*(?:d[ae]n|t[ae]n|s[ıi]nd[ae]n)\s+(?:itibaren|sonra\w*|başla\w*)")
_NOT_KEEP = r"(?!\w*\s*['’]?\s*(?:y[ıi]|[ıi]|n[ıi])?\s*(?:kes|at|atla|sil|çıkar|kullanma|alma|gösterme))"
_LAST = re.compile(rf"(?<!\w)son\s+(\d{{1,3}})\s*(dakika|dk|saniye|sn){_NOT_KEEP}")
_FIRST = re.compile(rf"(?<!\w)ilk\s+(\d{{1,3}})\s*(dakika|dk|saniye|sn){_NOT_KEEP}")
_END_W = re.compile(r"(?<!\w)(?:sonundaki|sonunu|son\s+kısm\w*|son\s+bölüm\w*|sonlar[ıi]nd\w*|bitişindeki|kapanıştaki)(?!\w)")
_START_W = re.compile(r"(?<!\w)(?:başındaki|baştaki|başını|en\s+baştan|baştan\s+itibaren|açılıştaki|girişteki|başlangıcındaki)(?!\w)")
_MID_W = re.compile(r"(?<!\w)(?:ortasındaki|ortasını|ortalarındaki|orta\s+kısm\w*)(?!\w)")


def _ts_sec(a, b, c) -> int:
    return int(a) * 3600 + int(b) * 60 + int(c) if c is not None else int(a) * 60 + int(b)


def _unit(n, u) -> int:
    return int(n) * (60 if u.startswith("d") else 1)


def time_hint(instruction: str, dur: float, window: float, max_s: float) -> dict | None:
    """Talimattaki zaman → {start, length, reason}. "12:30-16:00 arası" (en çok max_s), "1:02:10", "12:30'dan itibaren", "5. dakikadan",
    "5 dakikadan itibaren", "son 3 dakika", "ilk 2 dakika", "sonundaki", "başındaki", "ortasındaki". "ilk 5 sn'yi kes", "son 10 saniyeyi
    kullanma" bölüm seçimi değil (kurgu talimatı); 20 sn'den kısa "son/ilk N" de."""
    t = _low(instruction)
    m = _RANGE.search(t)
    if m:
        a, b = _ts_sec(*m.group(1, 2, 3)), _ts_sec(*m.group(4, 5, 6))
        if b - a >= 5:
            return {"start": a, "length": min(b - a, max_s), "reason": f"talimatta istenen aralık: {m.group(0).strip()}"}
    for rx in (_HMS, _FROM):
        m = rx.search(t)
        if m:
            return {"start": _ts_sec(*m.groups()[:3]) if rx is _FROM else _ts_sec(*m.groups()), "length": window,
                    "reason": f"talimatta istenen yer: {m.group(0).strip()}"}
    m = _COLON.search(t)  # eksiz "45:10": 24'ten büyük dakika yayın saati olamaz
    if m and int(m.group(1)) >= 24:
        return {"start": _ts_sec(m.group(1), m.group(2), None), "length": window, "reason": f"talimatta istenen yer: {m.group(0)}"}
    for rx in (_ORD, _FROM_N):
        m = rx.search(t)
        if m:
            return {"start": _unit(*m.group(1, 2)), "length": window, "reason": f"talimatta istenen yer: {m.group(0).strip()}"}
    for rx, last in ((_LAST, True), (_FIRST, False)):
        m = rx.search(t)
        if m and _unit(*m.group(1, 2)) >= 20:
            n = min(_unit(*m.group(1, 2)), max_s)
            return {"start": max(0.0, dur - n) if last else 0.0, "length": n, "reason": f"talimatta istenen: {m.group(0).strip()}"}
    for rx, where in ((_END_W, "end"), (_START_W, "start"), (_MID_W, "mid")):
        m = rx.search(t)
        if m:
            st = max(0.0, dur - window) if where == "end" else 0.0 if where == "start" else max(0.0, dur / 2 - window / 2)
            return {"start": st, "length": window, "reason": f"talimatta istenen: {m.group(0)}"}
    return None


def url_time(url: str) -> float | None:
    """Zaman damgalı YouTube linki (Paylaş → Başlangıç): ?t=1380, &t=23m10s, ?start=90."""
    m = re.search(r"[?&#](?:t|start|time_continue)=([\dhms.]+)", url or "")
    if not m:
        return None
    v = m.group(1)
    if re.fullmatch(r"\d+(?:\.\d+)?s?", v):
        return float(v.rstrip("s"))
    p = re.fullmatch(r"(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?", v)
    return int(p.group(1) or 0) * 3600 + int(p.group(2) or 0) * 60 + int(p.group(3) or 0) if p and any(p.groups()) else None


def kw_stems(t: str) -> set:
    return {w[:4] for w in re.findall(r"[^\W\d_]{3,}", _low(t)) if w not in KW_STOP}


def choose_window(dur: float, window: float, max_s: float, cues: list, title: str, instruction: str, uploader: str = "",
                  url: str = "") -> dict:
    """Uzun videodan indirilecek bölüm {start, end, reason}: talimattaki zaman → linkteki t= → altyazıda başlık + talimat kelimeleri
    (4 harflik kökler; talimat 2 kat, çok geçen kök az ağırlıklı; bölüm bütün altyazı satırlarından, cümle ortasından başlamaz)
    → konuşmanın başladığı yer (altyazı yoksa baştan)."""
    h = time_hint(instruction, dur, window, max_s)
    if not h and url_time(url) is not None:
        h = {"start": url_time(url), "length": window, "reason": f"linkteki başlangıç zamanı ({hms(url_time(url))})"}
    if h:
        st = float(h["start"])
        if st >= dur - 20:  # videonun sonunu aşan istek: son bölüm
            st = max(0.0, dur - h["length"])
        return {"start": round(st, 2), "end": round(min(dur, st + h["length"]), 2), "reason": h["reason"]}
    best = None
    if cues:
        drop = kw_stems(uploader)
        wts = {k: 1.0 for k in kw_stems(title) - drop}
        wts.update({k: 2.0 for k in kw_stems(re.sub(r"\d+", " ", instruction or "")) - drop})
        cst = [kw_stems(c[2]) & wts.keys() for c in cues]
        df = {k: sum(1 for x in cst if k in x) for k in wts}
        idf = {k: wts[k] * math.log(1 + len(cues) / (1 + df[k])) for k in wts}
        need = min(2, len([k for k in wts if df[k]]))
        for i in range(len(cues)):
            if not cst[i]:
                continue
            seen, hits, j = set(), 0.0, i
            while j < len(cues) and cues[j][1] - cues[i][0] <= window:
                seen |= cst[j]
                hits += sum(idf[k] for k in cst[j])
                j += 1
            if len(seen) < need and not (seen & {k for k, w in wts.items() if w > 1}):
                continue
            score = (round(sum(idf[k] for k in seen), 6), round(hits, 6))
            if best is None or score > best[0]:
                best = (score, i, seen)
    if best:
        i = best[1]
        punct = sum(1 for c in cues if re.search(r"[.!?…]\s*$", c[2])) >= max(3, len(cues) // 20)
        k = i
        if punct:  # cümle başına kadar geri (en çok 20 sn)
            while k > 0 and not re.search(r"[.!?…]\s*$", cues[k - 1][2]) and cues[i][0] - cues[k - 1][0] <= 20:
                k -= 1
            if k > 0 and not re.search(r"[.!?…]\s*$", cues[k - 1][2]):
                k = i
        elif k > 0 and cues[i][0] - cues[k - 1][0] <= 6:  # noktalama yok (otomatik altyazı): bir satır önceden
            k -= 1
        st = cues[k][0]
        if dur - st < window:  # eşleşme videonun sonunda (kapanış özeti): bölüm geriye kayar, 18 sn yerine bütün pencere iner
            st = next((c[0] for c in cues if c[0] >= dur - window), st)
        why = "altyazıda başlık ve talimatla en uyumlu bölüm" if instruction.strip() else "altyazıda başlıkla en uyumlu bölüm"
        why += f": {', '.join(sorted(best[2]))[:60]}"
    else:
        st = next((c[0] for c in cues if c[0] <= 120), 0.0) if cues else 0.0
        why = "altyazıda başlıkla eşleşen bölüm yok: konuşmanın başladığı yerden" if cues else "altyazı yok: baştan"
    ends = [c[1] for c in cues if c[0] >= st and c[1] - st <= window]
    en = ends[-1] + 0.3 if ends and ends[-1] - st >= window * 0.6 else st + window
    if best and ends:  # noktalamalı altyazıda bölüm cümle sonunda biter (bölümün %70'i kalıyorsa)
        sent = [c[1] for c in cues if c[0] >= st and c[1] - st <= window and re.search(r"[.!?…]\s*$", c[2])]
        if sent and sent[-1] - st >= window * 0.7:
            en = sent[-1] + 0.3
    return {"start": round(max(0.0, st - 0.2), 2), "end": round(min(dur, en), 2), "reason": why}


def retime(cues: list, start: float, end: float) -> list:
    """Bölümün altyazısı, bölüm başına göre (0'dan)."""
    return [[round(max(0.0, a - start), 1), round(min(b, end) - start, 1), t] for a, b, t in cues if a >= start - 0.3 and a < end - 0.3][:600]


def _live_playlist(url: str, secs: float) -> tuple[str, int | None, float]:
    """HLS canlı yayın listesi: (ffmpeg girdisi, geriye dönük parça sayısı, listedeki toplam süre). Ana liste (master) ise ≤1080p en iyi
    alt liste. Okunamazsa (adres, None, 0): ffmpeg canlı uçtan kaydeder."""
    try:
        txt = urlopen(url, timeout=20).read(4_000_000).decode("utf-8", "replace")
    except Exception:
        return url, None, 0.0
    if not txt.lstrip().startswith("#EXTM3U"):
        return url, None, 0.0
    if "#EXT-X-STREAM-INF" in txt:
        vs, lines = [], txt.splitlines()
        for i, x in enumerate(lines):
            if x.startswith("#EXT-X-STREAM-INF"):
                h = int((re.search(r"RESOLUTION=\d+x(\d+)", x) or [0, 0])[1])
                bw = int((re.search(r"BANDWIDTH=(\d+)", x) or [0, 0])[1])
                nxt = next((y.strip() for y in lines[i + 1:] if y.strip() and not y.startswith("#")), "")
                if nxt:
                    vs.append((h <= 1080, h, bw, urljoin(url, nxt)))
        if not vs:
            return url, None, 0.0
        return _live_playlist(max(vs)[3], secs)
    # bir parça fazlası: kayıt canlı uca varmadan -t dolar (yoksa ffmpeg süreyi bitirmek için yeni parçayı bekler)
    durs = [float(x) for x in re.findall(r"#EXTINF:\s*([\d.]+)", txt)]
    total, k = 0.0, 0
    for d in reversed(durs):
        k += 1
        total += d
        if total >= secs + (durs[-1] if durs else 0):
            break
    return url, k or None, sum(durs)


def record_live(base: list, auth: list, url: str, stem: str, secs: float) -> tuple[Path | None, str, str]:
    """Canlı yayının son `secs` sn'si: yt-dlp -g → HLS adresi → ffmpeg -live_start_index (geriye dönük parça) -t secs. (dosya, hata, not)"""
    try:
        g = subprocess.run([*base, "-g", "-f", "b[height<=1080]/b", *auth, url], capture_output=True, text=True, timeout=150)
    except subprocess.TimeoutExpired:
        return None, "canlı yayın adresi 2,5 dakikada alınamadı", ""
    urls = [u for u in (g.stdout or "").split() if re.match(r"^[a-z]+://", u)][:2]
    if not urls:
        err = (g.stderr or g.stdout or "canlı yayın adresi alınamadı").strip().splitlines()
        return None, hint(" ".join(err[-3:]), "YouTube"), ""
    out = INBOX / f"{stem}.mp4"
    cmd, back = ["ffmpeg", "-y", "-loglevel", "error"], 0.0
    for u in urls:
        src, k, total = _live_playlist(u, secs)
        back = back or total
        cmd += (["-live_start_index", str(-k)] if k else []) + ["-i", src]
    cmd += ["-t", str(int(secs))] + (["-map", "0:v:0", "-map", "1:a:0"] if len(urls) > 1 else ["-map", "0:v:0?", "-map", "0:a:0?"])
    cmd += ["-c", "copy", "-movflags", "+faststart", str(out)]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=int(secs) * 2 + 120)
    except subprocess.TimeoutExpired:
        return None, "canlı yayın kaydı zamanında bitmedi", ""
    if not out.exists() or out.stat().st_size < 50_000:
        out.unlink(missing_ok=True)
        return None, f"canlı yayın kaydedilemedi ({(r.stderr or '').strip()[-160:] or 'ffmpeg çıktı vermedi'})", ""
    note = (f"canlı yayından son {span_text(secs)} alındı" if back >= secs - 1
            else f"canlı yayından {span_text(secs)} kaydedildi (yayının geriye dönük kısmı kısa olduğu için son kısmı canlı kaydedildi)")
    return out, "", note


def _probe_secs(p: Path) -> float | None:
    r = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(p)], capture_output=True, text=True)
    try:
        return round(float(r.stdout.strip()), 1)
    except ValueError:
        return None


def _log(msg: str) -> None:
    print(msg, flush=True)


def _auth(plat: str) -> list:
    """yt-dlp giriş/çerez ve YouTube JS çalıştırıcı argümanları (ayar ya da secrets/social_cookies.txt)."""
    cfg, auth = social_cfg(), []
    if (SECRETS / "social_cookies.txt").exists():
        auth += ["--cookies", str(SECRETS / "social_cookies.txt")]
    elif cfg.get("cookiesFromBrowser"):
        auth += ["--cookies-from-browser", str(cfg["cookiesFromBrowser"]).strip()]
    node = shutil.which("node")
    if node and plat == "YouTube":
        auth += ["--js-runtimes", f"node:{node}", "--remote-components", "ejs:github"]
    return auth


def wants_summary(instruction: str, dur: float, plat: str = "YouTube", title: str = "", caption: str = "") -> tuple[bool, str]:
    """Uzun video özeti mi (ve neden): talimatta özet/analiz isteği (90 sn üstü videoda) ya da kendiliğinden (YouTube, `minSeconds`tan
    uzun; talimatta zaman, kendi ses ya da fragman isteği yoksa, fragman başlığı değilse). Kapalıysa hiç."""
    c = summary_cfg()
    if not c["enabled"] or dur <= 90:
        return False, ""
    if recreate_ask(instruction) and recreate_on():  # benzer video (sıfırdan): "bu videoyu analiz edip benzerini yap" özet değil
        return False, ""
    t = _fold(instruction)
    if trailer_ask(instruction):  # fragman analizi kendi yolunda (yalnız istek biçimi: server.js trailerAsk aynı; "fragman çekimleri" değil)
        return False, ""
    # fragman başlıklı YouTube videosu (inceleme, 19 Ekim: "analiz et", "özetle" fragman analizini özet yoluna çeviriyordu; fragman
    # analizi zaten fragmanın özetidir): fragman analizi açık ve başlıktan tanıma açıkken açık haber isteği (common.news_request, server.js
    # newsRequest aynı kural) yoksa özet değil
    if plat == "YouTube" and (title or caption) and is_trailer(title, caption) and trailer_auto() and not news_request(instruction):
        return False, ""
    if SUMMARY_ASK.search(t):
        return True, "talimatta özet istendi"
    if keep_sound(instruction):  # "kendi sesiyle" açık isteği genel sözlerden ("analiz", "en önemli an") önce gelir
        return False, ""
    if SUMMARY_HINT.search(t):
        return True, "talimatta özet istendi"
    # viral/mizah etiketli video haber özeti değildir (kendi sesiyle oynar): kendiliğinden özetlenmez
    if plat == "YouTube" and c["auto"] and dur > c["minSeconds"] and not is_trailer(title, caption) \
            and kind_of(instruction) not in ("trend", "mizah"):
        return True, f"video {round(c['minSeconds'] / 60)} dakikadan uzun"
    return False, ""


def download_sections(url: str, sections: list, tag: str, timeout: int = 900) -> tuple[list, str]:
    """Uzun videonun seçilen anları HD (≤1080p): [(başlangıç, bitiş)] → [Path | None] (aynı sırayla) ve hata metni. Tek yt-dlp çağrısı,
    her aralık ayrı dosya (`--download-sections`, `--force-keyframes-at-cuts`: dosyanın 0. saniyesi aralığın başı)."""
    cmd = ytdlp()
    if not cmd or not sections:
        return [None] * len(sections), "yt-dlp kurulu değil" if not cmd else ""
    INBOX.mkdir(parents=True, exist_ok=True)
    plat = platform_of(url)
    secs = []
    for a, b in sections:
        secs += ["--download-sections", f"*{float(a):.2f}-{float(b):.2f}"]
    tmpl = str(INBOX / f"{tag}-%(section_start)d.%(ext)s")
    try:
        r = subprocess.run([*cmd, "--no-playlist", "--no-warnings", "--socket-timeout", "25", "-f", FMT, "--merge-output-format", "mp4", *secs,
                            "--force-keyframes-at-cuts", "-o", tmpl, *_auth(plat), url], capture_output=True, text=True, timeout=timeout)
        err = "" if r.returncode == 0 else hint(" ".join((r.stderr or r.stdout or "").strip().splitlines()[-3:]), plat)
    except subprocess.TimeoutExpired:
        err = f"HD bölümler {timeout // 60} dakikada inmedi"
    out = []
    for a, b in sections:
        got = [p for p in INBOX.glob(f"{tag}-{int(float(a))}.*") if p.suffix.lower() in (".mp4", ".mkv", ".webm", ".mov") and ".part" not in p.name]
        p = max(got, key=lambda x: x.stat().st_size) if got else None
        d = _probe_secs(p) if p else None
        out.append(p if p and d and d >= (float(b) - float(a)) * 0.5 else None)  # yarım inen bölüm yok sayılır (proxy'den kesilir)
    return out, err


def fetch(url: str, instruction: str = "", kare: bool = False) -> dict:
    """kare=True (kullanıcı isteği, 23 Ekim: "link kare video"): videonun TAMAMI 1080p iner (en çok settings.kare.maxSeconds, 30 dk); bölüm
    seçimi ve uzun video özeti kararı yapılmaz (wa_video.build_kare tamamını kendi sesiyle kare videoya çevirir)."""
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
    cfg = social_cfg()
    base = [*cmd, "--no-playlist", "--no-warnings", "--socket-timeout", "25"]
    args = [*base, "--max-filesize", "300M", "--match-filter", f"duration <? {int(cfg['maxSeconds'])}",
            "-f", FMT, "--merge-output-format", "mp4", "--write-info-json", "-o", tmpl]
    kc = kare_cfg() if kare else {}
    if kare:  # kare uzun video: 30 dakikaya kadar bütün video, dosya sınırı geniş (10 dk 1080p ~300-600 MB)
        args = [*base, "--max-filesize", "1500M", "--match-filter", f"duration <? {int(kc['maxSeconds'])}",
                "-f", FMT, "--merge-output-format", "mp4", "--write-info-json", "-o", tmpl]
    auth = _auth(plat)
    args += auth
    meta, cues, cap_lang, extra, r = {}, [], "", {}, None
    if plat == "YouTube":  # önce bilgi + altyazı (video inmeden): süre, canlı yayın, altyazı
        try:
            m = subprocess.run([*base, "--skip-download", "--ignore-errors", "--ignore-no-formats-error", "--write-info-json", "--write-subs",
                                "--write-auto-subs", "--sub-langs", "tr.*,en.*", "--sub-format", "vtt/best", "-o", tmpl, *auth, url],
                               capture_output=True, text=True, timeout=180)
        except subprocess.TimeoutExpired:
            return {"ok": False, "error": "YouTube video bilgisi 3 dakikada alınamadı"}
        for f in INBOX.glob(f"{stem}*.info.json"):
            try:
                meta = json.loads(f.read_text(encoding="utf-8"))
            except Exception:
                pass
            f.unlink(missing_ok=True)
        if not meta:
            for f in INBOX.glob(f"{stem}.*.vtt"):
                f.unlink(missing_ok=True)
            err = (m.stderr or m.stdout or "video bilgisi alınamadı").strip().splitlines()
            return {"ok": False, "error": hint(" ".join(err[-3:]), plat)}
        cues, cap_lang = pick_captions(stem, meta)
        if cues:
            _log(f"🔗 YouTube altyazısı: {cap_lang}, {len(cues)} satır")
    status = meta.get("live_status")
    dur = float(meta.get("duration") or 0)
    # YouTube klibi (/clip/): yt-dlp asıl videonun bilgisini ve klibin aralığını (section_start/end) verir; yalnız o aralık iner
    cs, ce = meta.get("section_start"), meta.get("section_end")
    clip = (cs, min(ce, cs + cfg["maxSeconds"])) if isinstance(cs, (int, float)) and isinstance(ce, (int, float)) and ce > cs else None
    if status == "is_upcoming":  # başlamamış yayın / gala (premiere): planlanan saat varsa yazılır
        at = meta.get("release_timestamp")
        msg = hint("is_upcoming", plat)
        return {"ok": False, "error": msg.replace("başlamadı;", f"başlamadı (planlanan başlangıç {time.strftime('%d.%m %H:%M', time.localtime(at))});", 1)
                if isinstance(at, (int, float)) else msg}
    if meta.get("is_live") or status == "is_live":  # canlı yayın: şu andan geriye son liveSeconds sn (talimatta "son 3 dakika" varsa o)
        secs = cfg["liveSeconds"]
        lm = _LAST.search(_low(instruction))
        if lm and _unit(*lm.group(1, 2)) >= 20:
            secs = min(_unit(*lm.group(1, 2)), cfg["maxSeconds"])
        _log(f"📡 canlı yayın: son {span_text(secs)} kaydediliyor")
        video, err, note = record_live(base, auth, url, stem, secs)
        if not video:
            return {"ok": False, "error": err}
        _log(f"📡 {note}")
        extra = {"live": True, "liveSeconds": int(secs), "note": note}
    elif status == "post_live" and not dur:
        return {"ok": False, "error": "Canlı yayın yeni bitti; YouTube kaydı hazırlıyor. Birkaç dakika sonra linki yeniden gönderin."}
    elif kare and not clip:  # kare uzun video: tamamı (bölüm seçimi, özet yok); süre sınırı settings.kare.maxSeconds
        if dur > kc["maxSeconds"]:
            return {"ok": False, "error": f"Video çok uzun ({dur_text(dur)}); kare video için en çok {dur_text(kc['maxSeconds'])} uzunluğundaki videonun "
                                          "tamamını alabiliyorum. Daha kısa bir video gönderin ya da \"özet reels\" yazın."}
        _log(f"⬛ kare video{f' ({dur_text(dur)})' if dur else ''}: videonun tamamı 1080p indiriliyor (bölüm seçimi yok)")
        try:
            r = subprocess.run([*args, url], capture_output=True, text=True, timeout=1500)
        except subprocess.TimeoutExpired:
            return {"ok": False, "error": "videonun tamamı 25 dakikada inmedi (internet yavaş ya da video çok uzun)"}
        extra = {"kare": True, "note": f"kare video: {dur_text(dur) + ' ' if dur else ''}videonun tamamı alındı"}
    elif (summ := (not clip and plat == "YouTube" and not (time_hint(instruction, dur, cfg["longWindowSeconds"], cfg["maxSeconds"]) or url_time(url) is not None)
                   and wants_summary(instruction, dur, plat, str(meta.get("title") or ""), str(meta.get("description") or "")))) and summ[0] and dur > cfg["maxSeconds"]:
        # uzun video özeti: videonun tamamı analiz için düşük çözünürlükte (en çarpıcı anlar wa_video.py'de seçilip HD iner); zaman
        # yazılmışsa (talimat, t=) eski yol: o bölüm iner. Üst sınır longSummary.maxSeconds (3 saat).
        sc = summary_cfg()
        if dur > sc["maxSeconds"]:
            return {"ok": False, "error": f"Video çok uzun ({dur_text(dur)}); en çok {dur_text(sc['maxSeconds'])} uzunluğundaki videoyu baştan sona inceleyebiliyorum. "
                                          "Linkin yanına haberin geçtiği zamanı yazın (ör. \"1:02:10'dan itibaren\"): o bölümden haber yaparım."}
        _log(f"🔗 uzun video ({dur_text(dur)}): tamamı incelenecek ({summ[1]}) — analiz için düşük çözünürlükte indiriliyor, en çarpıcı anlar sonra HD alınacak")
        try:
            r = subprocess.run([*base, "-f", PROXY_FMT, "--merge-output-format", "mkv", "--write-info-json", "-o", tmpl, *auth, url],
                               capture_output=True, text=True, timeout=1500)
        except subprocess.TimeoutExpired:
            return {"ok": False, "error": "videonun tamamı 25 dakikada inmedi (internet yavaş ya da video çok uzun); zaman yazarak bir bölümünü isteyin"}
        capf, ncap = None, len(cues)
        if cues:  # tüm altyazı (600 satır sınırı yok): wa_video.py dosyadan okur
            capf = INBOX / f"{stem}.captions.json"
            capf.write_text(json.dumps([list(c) for c in cues], ensure_ascii=False), encoding="utf-8")
        cues = []
        extra = {"summary": True, "summaryProxy": True, "summaryReason": summ[1], "sourceDuration": dur, "duration": dur,
                 **({"captionsFile": str(capf), "captionsCount": ncap} if capf else {}),
                 "note": f"uzun video ({dur_text(dur)}): tamamı inceleniyor; en çarpıcı anlarıyla {summary_secs(instruction)} saniyelik haber hazırlanacak"}
    elif dur > cfg["maxSeconds"] or clip:  # uzun video (haber programı, uzun röportaj, biten canlı yayın) ya da klip: yalnız o bölüm iner
        explicit = clip or time_hint(instruction, dur, cfg["longWindowSeconds"], cfg["maxSeconds"]) or url_time(url) is not None
        if dur > cfg["maxLongSeconds"] and not explicit:
            return {"ok": False, "error": f"Video çok uzun ({dur_text(dur)}); bölümü en çok {dur_text(cfg['maxLongSeconds'])} uzunluğundaki videoda kendim seçiyorum. "
                                          "Linkin yanına haberin geçtiği zamanı yazın (ör. \"1:02:10'dan itibaren\") ya da videonun o anından "
                                          "zaman damgalı link gönderin (YouTube'da Paylaş → Başlangıç)."}
        w = ({"start": round(float(clip[0]), 2), "end": round(float(clip[1]), 2), "reason": "YouTube klibinin kendi aralığı"} if clip else
             choose_window(dur, cfg["longWindowSeconds"], cfg["maxSeconds"], cues, str(meta.get("title") or ""), instruction,
                           str(meta.get("uploader") or meta.get("channel") or ""), url))
        if clip:
            # klipte aralığı yt-dlp kendisi keser (section_start/end; bilgideki duration klibin süresi). --download-sections klip adresinde
            # aralığı İKİNCİ kez kaydırıyordu (29+29=58 → bitişi geçen başlangıç, boş dosya; inceleme, 18 Ekim): normal indirme yolu,
            # altyazı (asıl videonun) klibin aralığına göre kaydırılır
            what = f"YouTube klibi ({dur_text(dur)}): asıl videonun {hms(w['start'])}–{hms(w['end'])} arası"
            _log(f"🔗 {what} indiriliyor")
            try:
                r = subprocess.run([*args, url], capture_output=True, text=True, timeout=360)
            except subprocess.TimeoutExpired:
                return {"ok": False, "error": "indirme 6 dakikada bitmedi"}
            note = f"{what} alındı"
        else:
            _log(f"🔗 uzun video ({dur_text(dur)}): {hms(w['start'])}–{hms(w['end'])} arası indiriliyor ({w['reason']})")
            try:
                r = subprocess.run([*base, "-f", FMT, "--merge-output-format", "mp4", "--download-sections", f"*{w['start']:.2f}-{w['end']:.2f}",
                                    "--force-keyframes-at-cuts", "-o", tmpl, *auth, url], capture_output=True, text=True, timeout=720)
            except subprocess.TimeoutExpired:
                return {"ok": False, "error": "videonun bölümü 12 dakikada inmedi"}
            note = f"uzun video ({dur_text(dur)}): {hms(w['start'])}–{hms(w['end'])} arası alındı ({w['reason']})"
        cues = retime(cues, w["start"], w["end"])
        extra = {"window": w, "note": note, **({"clip": True} if clip else {})}
    else:
        try:
            r = subprocess.run([*args, url], capture_output=True, text=True, timeout=360)
        except subprocess.TimeoutExpired:
            return {"ok": False, "error": "indirme 6 dakikada bitmedi"}
    vids = sorted((p for p in INBOX.glob(f"{stem}.*") if p.suffix.lower() in (".mp4", ".mkv", ".webm", ".mov")), key=lambda p: p.stat().st_size, reverse=True)
    if not vids:
        err = (((r.stderr or r.stdout) if r else "") or "video bulunamadı").strip().splitlines() or ["video bulunamadı"]
        return {"ok": False, "error": hint(" ".join(err[-3:]), plat)}
    video = vids[0]
    if video.suffix.lower() != ".mp4" and not extra.get("summaryProxy"):  # webm/mkv → mp4 (özetin analiz kopyası çevrilmez: uzun, gereksiz)
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
    info = info or meta
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
    if plat == "YouTube":  # bölüm/canlı: süre inen parçanın süresi; altyazı wa_video'da konuşma tanıma boş kalırsa döküm olur
        if extra.get("summaryProxy"):  # özet: videonun tamamı (düşük çözünürlük); altyazı dosyada
            social.update({**extra, "captionsLang": cap_lang} if extra.get("captionsFile") else extra)
        elif extra:
            social.update({"duration": _probe_secs(video), "sourceDuration": None if clip else dur or None, **extra})  # klipte asıl video süresi bilinmez
        if cues:
            social.update({"captions": [list(c) for c in cues][:600], "captionsLang": cap_lang})
    if extra.get("kare"):  # kare uzun video: inen dosyanın süresi (bütün video); özet kararı yok
        social.update({"duration": _probe_secs(video) or dur or None, **extra})
    if not social.get("summary") and not extra.get("live") and not extra.get("window") and not extra.get("kare"):  # videonun tamamı indi: talimat özet isterse özet modu
        full = _probe_secs(video) or float(info.get("duration") or 0)
        ok, why = wants_summary(instruction, full, plat, title, caption) if not clip else (False, "")
        if ok:
            social.update({"summary": True, "summaryReason": why, "sourceDuration": full,
                           "note": f"video ({dur_text(full)}) inceleniyor; en çarpıcı anlarıyla {summary_secs(instruction)} saniyelik haber hazırlanacak"})
    # fragman (kullanıcı isteği, 18 Ekim): film adı başlıktan; panel talimata ve fragman ayarına göre fragman analizine geçer. Otomatik
    # tanıma yalnız YouTube'da (yardım ve panel metni): TikTok/X/Facebook haber klibinin açıklamasındaki "trailer" (römork), "fragmanda
    # yoktu" gibi sözler haber videosunu fragman moduna ve film adıyla aramaya çevirmesin; talimatta "fragman" yazılırsa her platformda olur
    try:
        trailer = plat == "YouTube" and is_trailer(title, caption)
        film, bolum = film_name(title, str(social["uploader"] or ""))
    except Exception:  # ad ayıklama hiçbir zaman indirmeyi düşürmesin
        trailer, film, bolum = False, "", ""
    series = bool(bolum or re.search(r"sezon|season|episode|dizi|series", f"{title} {caption[:200]}", re.I))
    try:  # dizi tanıtım türü (16. bölüm 2. fragman, tanıtım, ön tanıtım, ön gösterim): etiket ve giriş cümlesi wa_video'da
        promo = promo_info(title, caption) if trailer else None
    except Exception:
        promo = None
    social.update({"trailer": trailer, "film": film, "bolum": bolum, "promo": promo,
                   "tags": [str(x) for x in (info.get("tags") or [])[:15]]})
    # mizah videosu haber sitelerinde aranmaz (haber değil; 75 sn boşuna beklenmesin); benzer video (sıfırdan) da: bilgi yalnız
    # referansın kendisinden (döküm, kareler, açıklama)
    skip = kind_of(instruction) == "mizah" or (recreate_ask(instruction) and recreate_on())
    rel = [] if skip else related(caption, title, film if trailer and film else "", series)
    return {"ok": True, "file": str(video), "social": social, "related": rel}


if __name__ == "__main__":
    try:
        if "--film" in sys.argv:  # ağsız deneme: fragman mı, film adı ne
            t = sys.argv[sys.argv.index("--film") + 1]
            f, b = film_name(t)
            print(json.dumps({"ok": True, "trailer": is_trailer(t), "film": f, "bolum": b, "promo": promo_info(t) if is_trailer(t) else None}, ensure_ascii=False))
            sys.exit(0)
        if "--sections" in sys.argv:  # deneme: python3 scripts/social_video.py --sections URL 754-770,1200-1215 [--tag ad]
            u, rng = sys.argv[sys.argv.index("--sections") + 1], sys.argv[sys.argv.index("--sections") + 2]
            tag = sys.argv[sys.argv.index("--tag") + 1] if "--tag" in sys.argv else f"bolum-{int(time.time())}"
            files, err = download_sections(u, [tuple(float(x) for x in r.split("-")) for r in rng.split(",")], tag)
            print(json.dumps({"ok": any(files), "files": [str(f) if f else None for f in files], "error": err}, ensure_ascii=False))
            sys.exit(0)
        ins = sys.argv[sys.argv.index("--instruction") + 1] if "--instruction" in sys.argv else ""
        if "--kind" in sys.argv and sys.argv[sys.argv.index("--kind") + 1] in ("haber", "trend", "mizah"):
            KIND_TAG = sys.argv[sys.argv.index("--kind") + 1]
        res = fetch(sys.argv[sys.argv.index("--url") + 1], ins, kare="--kare" in sys.argv) if "--url" in sys.argv else {"ok": False, "error": "kullanım: --url URL"}
    except Exception as e:
        res = {"ok": False, "error": str(e)[:300]}
    print(json.dumps(res, ensure_ascii=False))
