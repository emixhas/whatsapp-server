#!/usr/bin/env python3
"""Claude'un ürettiği segment JSON'unu doğrular, tarih ve bölüm bilgisini ekler.

Kullanım: python3 scripts/assemble_script.py work/claude_out.json work/script.json
"""
import json
import re
import sys
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import DATA, save_json, load_json  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
AYLAR = ["Ocak", "Şubat", "Mart", "Nisan", "Mayıs", "Haziran", "Temmuz", "Ağustos", "Eylül", "Ekim", "Kasım", "Aralık"]
import os
DURATION = int(os.environ.get("DURATION", "30"))
MAX_WORDS_TOTAL = int(os.environ.get("WORDS", str(DURATION * 24 // 10))) + 6   # küçük tolerans
_H = int(os.environ.get("HABER", str(max(2, DURATION // 8))))
HABER_MIN, HABER_MAX = max(2, _H - 1), min(12, _H + 1)
CATEGORIES = {"finans", "siyaset", "spor", "hava", "toplum", "teknoloji", "saglik", "dunya", "parti", "egitim", "asayis", "genel"}
# Asayiş zorlaması: Claude ne derse desin bu kalıplar geçen yurt içi haber "asayis" olur (şehit haberi siyasete düşmesin)
ASAYIS = re.compile(r"(şehit|saldırı|saldırgan|terör|bombalı|patlama|cinayet|öldür|katlet|bıçakl|silahl|kurşun|ateş aç|kaza|yaralan|yaralı|yangın|kaçırıl|gasp|rehin|çatışma|infaz|intihar|boğul|polis memuru|jandarma)", re.I)
# Sabit kapanış cümlesi (src/scenes/Outro.tsx animasyonuyla uyumlu, ~7 sn)
OUTRO_TEXT = "Son beş saatin Türkiye gündemi buydu. Her beş saatte bir son dakika haberleriyle buradayız, takip etmeyi unutma."
# Anlık (tek konulu son dakika) videonun kapanışı; panelden "Anlık haber üret" ile ANLIK=1 gelir
ANLIK = os.environ.get("ANLIK") == "1"
OUTRO_ANLIK = "Gelişmeleri takip etmeye devam ediyoruz. Son dakika haberleri için takip etmeyi unutma."


# Seslendirme motorları kısaltmaları yanlış okur; bilinen kısaltmalar açılır (kelime sınırı ile).
ABBR = [
    (r"\bAKP\b", "AK Parti"), (r"\bCHP\b", "Cumhuriyet Halk Partisi"),
    (r"\bMHP\b", "Milliyetçi Hareket Partisi"), (r"\bTCMB\b", "Merkez Bankası"), (r"\bTBMM\b", "Meclis"),
    (r"\bMEB\b", "Milli Eğitim Bakanlığı"), (r"\bİBB\b", "İstanbul Büyükşehir Belediyesi"), (r"\bABB\b", "Ankara Büyükşehir Belediyesi"),
    (r"\bABD\b", "Amerika"), (r"\bAB\b", "Avrupa Birliği"), (r"\bBM\b", "Birleşmiş Milletler"),
    (r"\bTÜİK\b", "Türkiye İstatistik Kurumu"), (r"\bSGK\b", "Sosyal Güvenlik Kurumu"), (r"\bÖSYM\b", "Ölçme Seçme ve Yerleştirme Merkezi"),
    (r"\bYÖK\b", "Yükseköğretim Kurulu"), (r"\bTSK\b", "Türk Silahlı Kuvvetleri"), (r"\bMSB\b", "Milli Savunma Bakanlığı"),
    (r"\bTFF\b", "Futbol Federasyonu"), (r"\bTHY\b", "Türk Hava Yolları"), (r"\bEPDK\b", "Enerji Piyasası Düzenleme Kurumu"),
    (r"\bBDDK\b", "Bankacılık Düzenleme ve Denetleme Kurumu"), (r"\bSPK\b", "Sermaye Piyasası Kurulu"), (r"\bAFAD\b", "Afet ve Acil Durum Yönetimi"),
    (r"\bMGK\b", "Milli Güvenlik Kurulu"), (r"\bDMO\b", "Devlet Malzeme Ofisi"), (r"\bKDV\b", "Katma Değer Vergisi"), (r"\bÖTV\b", "Özel Tüketim Vergisi"),
    (r"(\d)\s*TL\b", r"\1 lira"), (r"\bTL\b", "lira"), (r"%\s*(\d)", r"yüzde \1"), (r"(\d)\s*%", r"yüzde \1"),
    (r"(\d)\s*km\b", r"\1 kilometre"), (r"(\d)\s*kg\b", r"\1 kilogram"),
]


NOT_POSSESSIVE = {"AK Parti", "Birleşmiş Milletler", "Avrupa Birliği Komisyonu"}  # tamlama olmayan çok kelimeli açılımlar
BACK = "aıou"
VOICELESS = "pçtkfsşh"
SUFFIX_RE = re.compile(r"'(de|da|te|ta|den|dan|ten|tan|ye|ya|e|a|yi|yı|yu|yü|i|ı|u|ü|nin|nın|nun|nün|in|ın|un|ün|yle|yla|le|la|nde|nda|nden|ndan|ne|na|ni|nı|nu|nü)\b")


def _last_vowel(w: str):
    for ch in reversed(w.lower()):
        if ch in "aeıioöuü":
            return ch
    return "e"


def _harmonize(word: str, suf: str) -> str:
    """Açılım sonrası ek uyumu: Meclis'de → Meclis'te, ABD'den → Amerika'dan."""
    v = _last_vowel(word); back = v in BACK; rounded = v in "oöuü"
    ends_vowel = word[-1].lower() in "aeıioöuü"; voiceless = word[-1].lower() in VOICELESS
    A = "a" if back else "e"
    I = ("u" if back else "ü") if rounded else ("ı" if back else "i")
    D = "t" if voiceless else "d"
    kind = {"de": "LOC", "da": "LOC", "te": "LOC", "ta": "LOC", "nde": "LOC", "nda": "LOC",
            "den": "ABL", "dan": "ABL", "ten": "ABL", "tan": "ABL", "nden": "ABL", "ndan": "ABL",
            "ye": "DAT", "ya": "DAT", "e": "DAT", "a": "DAT", "ne": "DAT", "na": "DAT",
            "yi": "ACC", "yı": "ACC", "yu": "ACC", "yü": "ACC", "i": "ACC", "ı": "ACC", "u": "ACC", "ü": "ACC", "ni": "ACC", "nı": "ACC", "nu": "ACC", "nü": "ACC",
            "nin": "GEN", "nın": "GEN", "nun": "GEN", "nün": "GEN", "in": "GEN", "ın": "GEN", "un": "GEN", "ün": "GEN",
            "yle": "INS", "yla": "INS", "le": "INS", "la": "INS"}[suf]
    # Tamlama bitişleri ("Bakanlığı", "Kurumu", "Partisi", "Birliği") 3. tekil iyelik taşır → ek -n- ile bağlanır
    possessive = len(word.split()) > 1 and word not in NOT_POSSESSIVE
    if kind == "LOC":
        return f"{word}'" + ("nd" + A if possessive else D + A)
    if kind == "ABL":
        return f"{word}'" + ("nd" + A + "n" if possessive else D + A + "n")
    if kind == "DAT":
        return f"{word}'" + ("n" + A if possessive else ("y" + A if ends_vowel else A))
    if kind == "ACC":
        return f"{word}'" + ("n" + I if possessive else ("y" + I if ends_vowel else I))
    if kind == "GEN":
        return f"{word}'" + ("n" + I + "n" if possessive else (("n" if ends_vowel else "") + I + "n"))
    if kind == "INS":
        return f"{word}'" + ("yl" + A if (ends_vowel or possessive) else "l" + A)
    return f"{word}'{suf}"


def expand_abbr(text: str) -> str:
    targets = []
    for pat, rep in ABBR:
        if "\\1" in rep:
            text = re.sub(pat, rep, text)
            continue
        if re.search(pat, text):
            text = re.sub(pat, rep, text)
            targets.append(rep)
    for rep in set(targets):
        text = re.sub(re.escape(rep) + SUFFIX_RE.pattern, lambda m: _harmonize(rep, m.group(1)), text)
    return text


def extract_json(text: str):
    m = re.search(r"\{.*\}", text, re.S)  # Claude kod bloğu eklerse içinden JSON'u al
    if not m:
        sys.exit("Claude çıktısında JSON bulunamadı")
    return json.loads(m.group(0))


def _norm_words(t: str):
    return set(w for w in re.sub(r"[^\w\s]", " ", t.lower()).split() if len(w) > 3)


def attach_images(segs):
    """Her haberi work/news.json'daki en benzer başlıkla eşleştirir; haber sayfası adresini (articleUrl, tam boy
    fotoğraf ve video oradan alınır) ve varsa RSS görselini (imageUrl) segmente koyar."""
    news = load_json(ROOT / "work" / "news.json", {}).get("items", []) if (ROOT / "work" / "news.json").exists() else []
    if not news:
        return 0
    n = 0
    for s in segs:
        if s.get("kind") not in ("haber", "hook"):
            continue
        words = _norm_words(s.get("title", "") + " " + s.get("narration", ""))
        best, score = None, 0.0
        for it in news:
            if not it.get("image") and not it.get("link"):
                continue
            iw = _norm_words(it.get("title", "") + " " + (it.get("summary") or ""))
            if not iw:
                continue
            j = len(words & iw) / len(words | iw)
            if j > score:
                best, score = it, j
        if best and score >= 0.08:
            if best.get("image"):
                s["imageUrl"] = best["image"]
            if (best.get("link") or "").startswith("http"):
                s["articleUrl"] = best["link"]
            s["imageSource"] = best.get("source")
            n += 1
    return n


GUNLER = ["Pazartesi", "Salı", "Çarşamba", "Perşembe", "Cuma", "Cumartesi", "Pazar"]


def _words(t: str):
    return sorted({w for w in re.sub(r"[^\w\s]", " ", (t or "").lower()).split() if len(w) > 3})


def record_used_news(segs, video: str):
    """Videoya giren haberleri data/used_news.json'a yazar (48 saat tutulur); slim_news bunları eler."""
    from datetime import timedelta, timezone
    path = DATA / "used_news.json"
    now = datetime.now(timezone.utc)
    rows = [u for u in load_json(path, []) if u.get("at", "") >= (now - timedelta(hours=48)).isoformat()]
    for s in segs:
        if s.get("kind") in ("haber", "hook"):
            rows.append({"t": s.get("title", ""), "w": _words(s.get("title", "")), "wn": _words(s.get("narration", "")), "at": now.isoformat(), "video": video})
    save_json(path, rows)


def record_category_suggestions(segs):
    """Claude'un önerdiği yeni kategorileri sayar; 3 kez görülen öneri geliştirme kuyruğuna yazılır."""
    path = DATA / "category_suggestions.json"
    sug = load_json(path, {})
    changed = False
    for s in segs:
        name = re.sub(r"[^a-zçğıöşü_]", "", (s.get("categorySuggestion") or "").lower())
        if not name or name in CATEGORIES:
            continue
        s["categoryLabel"] = name.upper().replace("I", "I").replace("İ", "İ")  # kartta hemen görünür; görsel/ses en yakın kategoriden
        row = sug.setdefault(name, {"count": 0, "examples": [], "queued": False})
        row["count"] += 1
        row["last"] = datetime.now().isoformat(timespec="minutes")
        if s.get("title") and s["title"] not in row["examples"]:
            row["examples"] = (row["examples"] + [s["title"]])[-5:]
        print(f"  🧩 kategori önerisi: {name} ({row['count']}. kez) — {s.get('title', '')[:50]}", file=sys.stderr)
        if row["count"] >= 3 and not row["queued"]:
            row["queued"] = True
            imp = DATA / "improvements.md"
            head = "# Emixhas geliştirme kuyruğu\n\nBir görevi uygulamak için proje klasöründe Claude Code'u açıp bu dosyadaki ilk açık görevi vermeniz yeterli; uygulanınca [x] işaretleyin.\n\n"
            line = f"- [ ] {datetime.now().isoformat(timespec='minutes')} Yeni kategori ekle: '{name}' (Claude {row['count']} kez önerdi; örnekler: {'; '.join(row['examples'][:3])}). src/categories.ts, src/illustrations/, scripts/make_sfx.py, prompts/senaryo.md ve assemble_script.CATEGORIES birlikte güncellensin; npm run typecheck geçsin.\n"
            imp.write_text((imp.read_text(encoding="utf-8") if imp.exists() else head) + line, encoding="utf-8")
            print(f"  🛠 '{name}' kategorisi 3 kez önerildi → geliştirme kuyruğuna yazıldı", file=sys.stderr)
        changed = True
    if changed:
        save_json(path, sug)


def episode_of_day(date: str) -> int:
    """O günün bölüm sayısı: bitmiş videolar + sürmekte olan üretimlerin rezervasyonları."""
    used = set()
    for f in (ROOT / "out").glob(f"{date}-*"):
        m = re.match(rf"{re.escape(date)}-(\d+)(\.mp4|\.reserved)$", f.name)
        if m:
            used.add(int(m.group(1)))
    n = 1
    while n in used:
        n += 1
    return n


def tr_upper(t: str) -> str:
    """Türkçe büyük harf (i → İ, ı → I); Python'un upper() i'yi yanlış olarak I yapar."""
    return (t or "").replace("i", "İ").replace("ı", "I").upper()


def short_title(t: str, max_chars: int = 32, max_words: int = 4) -> str:
    """Ekran başlığını kelime ortasından KESMEDEN kısaltır: en çok max_words kelime ve max_chars karakter.
    İlk kelime tek başına uzunsa bile bütün kalır (video tarafı puntoyu küçültüp sığdırır)."""
    words = (t or "").replace("…", " ").split()
    out = []
    for w in words[:max_words]:
        if out and len(" ".join(out + [w])) > max_chars:
            break
        out.append(w)
    return " ".join(out).rstrip(",;:-–")


def regular_slot_of_day(date: str) -> int:
    """Kaçıncı 5 saatlik video: o günün anlık olmayan videoları + 1 (anlık videolar sayımı kaydırmaz)."""
    n = 0
    for f in (ROOT / "out").glob(f"{date}-*.json"):
        if re.match(rf"{re.escape(date)}-\d+\.json$", f.name) and load_json(f, {}).get("format") != "anlik":
            n += 1
    return n + 1


def main(src: str, dst: str):
    raw = Path(src).read_text(encoding="utf-8")
    data = extract_json(raw)
    segs = data.get("segments", [])
    haber = [s for s in segs if s.get("kind") == "haber"]
    if not (HABER_MIN <= len(haber) <= HABER_MAX):
        sys.exit(f"Haber sayısı {len(haber)}, beklenen {HABER_MIN}-{HABER_MAX}")
    if segs[0].get("kind") == "intro" and len(segs) > 1 and segs[1].get("kind") != "hook":
        # Kanca yoksa ilk haberden üret: ilk cümle, en fazla 9 kelime
        first = next((x for x in segs if x.get("kind") == "haber"), None)
        if first:
            sent = re.split(r"(?<=[.!?])\s", first["narration"].strip())[0]
            words = sent.split()
            hook = {"kind": "hook", "title": tr_upper(" ".join(first["title"].split()[:3])), "narration": " ".join(words[:9]).rstrip(",;:") + ("." if not sent.endswith((".", "!", "?")) else ""),
                    "source": first.get("source"), "category": first.get("category"), "breaking": first.get("breaking", False)}
            segs.insert(0, hook)
            print("  kanca otomatik üretildi (Claude vermedi)", file=sys.stderr)
    if segs[0].get("kind") != "hook" or segs[-1].get("kind") != "outro":
        sys.exit("İlk segment hook (kanca), son segment outro olmalı")
    if len(segs) > 1 and segs[1].get("kind") != "intro":
        sys.exit("İkinci segment intro olmalı")
    # Outro her videoda aynı kancalı kapanış: marka tutarlılığı için Claude'un yazdığı metin ezilir
    segs[-1]["narration"] = OUTRO_ANLIK if ANLIK else OUTRO_TEXT
    hk = segs[0]
    if len(hk.get("narration", "").split()) > 10:
        hk["narration"] = " ".join(hk["narration"].split()[:10]).rstrip(",;:") + "."
    hk["title"] = tr_upper(short_title(hk.get("title") or " ".join(hk["narration"].split()[:3])))
    if hk.get("category") not in CATEGORIES:
        hk["category"] = next((x.get("category") for x in segs if x.get("kind") == "haber" and x.get("category") in CATEGORIES), "genel")
    for s in segs:
        if not s.get("narration", "").strip():
            sys.exit("Boş seslendirme metni")
        s["narration"] = expand_abbr(s["narration"])
        if s.get("title"):
            s["title"] = expand_abbr(s["title"])
        if s["kind"] == "haber" and not s.get("title", "").strip():
            sys.exit("Haber segmentinde başlık yok")
        if s["kind"] in ("haber", "hook") and s.get("category") not in CATEGORIES:
            print(f"  ! bilinmeyen kategori {s.get('category')!r}, 'genel' kullanıldı", file=sys.stderr)
            s["category"] = "genel"
        if s["kind"] in ("haber", "hook") and s.get("category") not in ("asayis", "dunya", "hava") and ASAYIS.search(f"{s.get('title', '')} {s['narration']}"):
            print(f"  kategori {s.get('category')} → asayis ({s.get('title', '')[:40]})", file=sys.stderr)
            s["category"] = "asayis"
    if ANLIK and haber:
        haber[0]["breaking"] = True  # anlık videonun ilk haberi her zaman SON DAKİKA kartı
        segs[0]["breaking"] = True
    breaking = [s for s in haber if s.get("breaking")]
    for s in breaking[1:]:
        s["breaking"] = False  # en fazla bir manşet
    words = sum(len(s["narration"].split()) for s in segs if s["kind"] != "outro")
    if words > MAX_WORDS_TOTAL:
        sys.exit(f"Toplam {words} kelime, üst sınır {MAX_WORDS_TOTAL}. Senaryo {DURATION} saniyeye sığmaz.")

    matched = attach_images(segs)
    if matched:
        print(f"  {matched} haber kaynağıyla eşleşti (fotoğraf ve video haber sayfasından alınacak)")
    now = datetime.now()
    date = now.strftime("%Y-%m-%d")
    titles = data.get("titles") or {}
    first = next((x for x in haber), {})
    title_a = expand_abbr(titles.get("A") or first.get("title", "Günün özeti"))
    title_b = expand_abbr(titles.get("B") or title_a)
    cover = short_title(expand_abbr(titles.get("cover") or first.get("title", "")), max_chars=30, max_words=5)
    ep_n = episode_of_day(date_str := now.strftime("%Y-%m-%d"))
    variant = "A" if ep_n % 2 == 1 else "B"  # dönüşümlü A/B: tek bölümler A, çift bölümler B
    hours = int(load_json(DATA / "settings.json", {}).get("scheduleHours") or 5)
    from datetime import timedelta
    start = now - timedelta(hours=hours)
    record_category_suggestions(segs)
    out = {
        "titles": {"A": title_a, "B": title_b, "cover": cover},
        "titleVariant": variant,
        "publishTitle": title_a if variant == "A" else title_b,
        "date": date,
        "dateLabel": f"{now.day} {AYLAR[now.month - 1]} {now.year}",
        "dayLabel": f"{now.day} {AYLAR[now.month - 1]} {GUNLER[now.weekday()]}",
        "episodeOfDay": ep_n,
        "slotLabel": "ANLIK HABER" if ANLIK else f"{regular_slot_of_day(date)}. {hours} SAAT",
        "timeRange": now.strftime("%H:%M") if ANLIK else f"{start.strftime('%H:%M')}–{now.strftime('%H:%M')}",
        "anlik": ANLIK,
        "scheduleHours": hours,
        "timeLabel": now.strftime("%H:%M"),
        "targetDuration": DURATION,
        "format": os.environ.get("FORMAT", "ozel"),
        "formatLabel": os.environ.get("FORMAT_LABEL", "Gündem"),
        "music": "music/ogle.mp3" if ANLIK else f"music/{os.environ.get('FORMAT', 'aksam') if os.environ.get('FORMAT', 'aksam') in ('sabah', 'ogle', 'aksam') else 'aksam'}.mp3",
        "segments": segs,
    }
    Path(dst).write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
    record_used_news(segs, f"{date}-{ep_n}")
    print(f"{len(haber)} haber, {words} kelime, günün {out['episodeOfDay']}. videosu ({out['slotLabel']}, {out['timeRange']}) -> {dst}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
