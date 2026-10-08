#!/usr/bin/env python3
"""Claude'un ürettiği segment JSON'unu doğrular, tarih ve bölüm bilgisini ekler.

Kullanım: python3 scripts/assemble_script.py work/claude_out.json work/script.json
"""
import json
import re
import sys
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
AYLAR = ["Ocak", "Şubat", "Mart", "Nisan", "Mayıs", "Haziran", "Temmuz", "Ağustos", "Eylül", "Ekim", "Kasım", "Aralık"]
import os
DURATION = int(os.environ.get("DURATION", "30"))
MAX_WORDS_TOTAL = int(os.environ.get("WORDS", str(DURATION * 24 // 10))) + 6   # küçük tolerans
_H = int(os.environ.get("HABER", str(max(2, DURATION // 8))))
HABER_MIN, HABER_MAX = max(2, _H - 1), min(12, _H + 1)
CATEGORIES = {"finans", "siyaset", "spor", "hava", "toplum", "teknoloji", "saglik", "dunya", "parti", "egitim", "genel"}


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


def episode_of_day(date: str) -> int:
    return len(list((ROOT / "out").glob(f"{date}-*.mp4"))) + 1


def main(src: str, dst: str):
    raw = Path(src).read_text(encoding="utf-8")
    data = extract_json(raw)
    segs = data.get("segments", [])
    haber = [s for s in segs if s.get("kind") == "haber"]
    if not (HABER_MIN <= len(haber) <= HABER_MAX):
        sys.exit(f"Haber sayısı {len(haber)}, beklenen {HABER_MIN}-{HABER_MAX}")
    if segs[0].get("kind") != "intro" or segs[-1].get("kind") != "outro":
        sys.exit("İlk segment intro, son segment outro olmalı")
    for s in segs:
        if not s.get("narration", "").strip():
            sys.exit("Boş seslendirme metni")
        s["narration"] = expand_abbr(s["narration"])
        if s.get("title"):
            s["title"] = expand_abbr(s["title"])
        if s["kind"] == "haber" and not s.get("title", "").strip():
            sys.exit("Haber segmentinde başlık yok")
        if s["kind"] == "haber" and s.get("category") not in CATEGORIES:
            print(f"  ! bilinmeyen kategori {s.get('category')!r}, 'genel' kullanıldı", file=sys.stderr)
            s["category"] = "genel"
    breaking = [s for s in haber if s.get("breaking")]
    for s in breaking[1:]:
        s["breaking"] = False  # en fazla bir manşet
    words = sum(len(s["narration"].split()) for s in segs)
    if words > MAX_WORDS_TOTAL:
        sys.exit(f"Toplam {words} kelime, üst sınır {MAX_WORDS_TOTAL}. Senaryo {DURATION} saniyeye sığmaz.")

    now = datetime.now()
    date = now.strftime("%Y-%m-%d")
    out = {
        "date": date,
        "dateLabel": f"{now.day} {AYLAR[now.month - 1]} {now.year}",
        "episodeOfDay": episode_of_day(date),
        "timeLabel": now.strftime("%H:%M"),
        "targetDuration": DURATION,
        "format": os.environ.get("FORMAT", "ozel"),
        "formatLabel": os.environ.get("FORMAT_LABEL", "Gündem"),
        "music": f"music/{os.environ.get('FORMAT', 'aksam') if os.environ.get('FORMAT', 'aksam') in ('sabah', 'ogle', 'aksam') else 'aksam'}.mp3",
        "segments": segs,
    }
    Path(dst).write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"{len(haber)} haber, {words} kelime, günün {out['episodeOfDay']}. videosu -> {dst}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
