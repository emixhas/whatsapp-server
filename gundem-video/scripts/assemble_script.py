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
CATEGORIES = {"finans", "siyaset", "spor", "hava", "toplum", "teknoloji", "saglik", "dunya", "parti", "egitim", "asayis", "sinema", "genel"}
# Asayiş zorlaması: Claude ne derse desin bu kalıplar geçen yurt içi haber "asayis" olur (şehit haberi siyasete düşmesin)
# Zorlanmayanlar: dunya, hava ve sinema (fragmanın konusu cinayet/patlama/çatışma olabilir; kullanıcı isteği, 18 Ekim:
# "bir filmin fragmanını analiz edip …" → film haberi asayiş kartına düşmesin). Fragman analizinde (TRAILER=1) hiç zorlanmaz (oyun
# fragmanı "teknoloji", tanıtım filmi "siyaset"/"genel" olabilir); fragman dışında "sinema" etiketli gerçek zarar ("Dizi setinde kaza:
# genç oyuncu hayatını kaybetti") yine asayiş olur (GERCEK_OLAY; Claude ne derse desin). GERCEK_OLAY ekli ve edilgen biçimleri kapsar
# (öldü, 2 yaralı, yaralanarak, öldürüldü, rehin alındı); etken fiil ("katil öldürdü": filmin konusu) sayılmaz. Tek konulu anlık
# videoda karar haber başına değil olay başınadır (main: real_story): bir kartta gerçek zarar varsa tüm sinema kartları asayiş olur
ASAYIS_MUAF = ("asayis", "dunya", "hava", "sinema")
TRAILER = os.environ.get("TRAILER") == "1"
GERCEK_OLAY = re.compile(r"(hayatını kaybet|can verdi|şehit|öldü(?!r)|ölü\b|öldürül|yaralan|yaralı|gözaltı|tutuklan|kaçırıl|rehin)", re.I)
ASAYIS = re.compile(r"(şehit|saldırı|saldırgan|terör|bombalı|patlama|cinayet|öldür|katlet|bıçakl|silahl|kurşun|ateş aç|kaza(?!n)|yaralan|yaralı|yangın|kaçırıl|gasp|rehin|çatışma|infaz|intihar|boğul|polis memuru|jandarma)", re.I)
# Sabit kapanış cümlesi (src/scenes/Outro.tsx animasyonuyla uyumlu, ~7 sn)
OUTRO_TEXT = "Son beş saatin Türkiye gündemi buydu. Her beş saatte bir son dakika haberleriyle buradayız, takip etmeyi unutma."
# Anlık (tek konulu son dakika) videonun kapanışı; panelden "Anlık haber üret" ile ANLIK=1 gelir
ANLIK = os.environ.get("ANLIK") == "1"
OUTRO_ANLIK = "Gelişmeleri takip etmeye devam ediyoruz. Son dakika haberleri için takip etmeyi unutma."
# Şablon video (deprem/maç/piyasa/takvim, scripts/info_card.py): etiket, intro/outro ve SON DAKİKA kartı panelden env ile
INFO_KIND = os.environ.get("INFO_KIND", "").strip()
INFO_LABEL = os.environ.get("INFO_LABEL", "").strip()
# Günlük uzun özet (yatay, YouTube): pipeline GUNLUK=1, prompts/gunluk.md, Remotion GunlukOzet
GUNLUK = os.environ.get("GUNLUK") == "1"
OUTRO_GUNLUK = "Bugünün Türkiye gündemi buydu. Her beş saatte bir kısa haberlerle, her akşam günün özetiyle buradayız. Abone olmayı unutma."
INTRO_GUNLUK = "Günün özeti. Bugün Türkiye'de öne çıkan haberler."
# Haftanın özeti: GUNLUK=1 + HAFTALIK=1 (aynı yatay kompozisyon), prompts/haftalik.md, scripts/weekly_news.py
HAFTALIK = GUNLUK and os.environ.get("HAFTALIK") == "1"
OUTRO_HAFTALIK = ("Bu haftanın Türkiye gündemi buydu. Her beş saatte bir kısa haberlerle, her akşam günün özetiyle, "
                  "her pazar haftanın özetiyle buradayız. Abone olmayı unutma.")
INTRO_HAFTALIK = "Haftanın özeti. Bu hafta Türkiye'de öne çıkan haberler."


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
        sys.exit("Claude çıktısında JSON bulunamadı. Claude'un yanıtı: " + (text.strip()[:300] or "(boş)"))
    try:
        return json.loads(m.group(0))
    except json.JSONDecodeError as e:
        sys.exit(f"Claude'un JSON'u bozuk ya da yarım ({e.msg}, {len(text)} karakter); yanıt kesilmiş olabilir")


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


def topic_hashtags(data: dict) -> list:
    """Modelin yazdığı konuya özel hashtag'ler (scripts/hashtags.py temizler; genel etiketler sonra eklenir)."""
    from hashtags import clean
    out = []
    for t in data.get("hashtags") or []:
        c = clean(expand_abbr(str(t).lstrip("#")))
        if c and c not in out and c not in ("#haber", "#gündem", "#türkiye", "#sondakika", "#shorts"):
            out.append(c)
    try:  # videoda geçen Google Trends aranan ifadesi hashtag olur (scripts/trends.py)
        from trends import current, match
        text = " ".join(f"{s.get('title', '')} {s.get('narration', '')}" for s in data.get("segments", []) if s.get("kind") in ("hook", "haber"))
        for term in match(text, current())[:2]:
            c = clean(term.replace(" ", ""))
            if c and c not in out:
                out.insert(0, c)
    except Exception:
        pass
    return out[:6]


def sinema_value(v: dict, magazin: bool = True) -> dict:
    """Fragman analizinde (kullanıcı isteği, 18 Ekim: fragman videoları; yalnız TRAILER=1) fragmanın konusu (cinayet, patlama, savaş…)
    gerçek olay değildir: bu gruplar değer gerekçesi ve hashtag (#kaza, #asayiş, #sondakika) olmaz. Film/dizi fragmanı (`magazin`:
    tüm segmentler sinema) "magazin ve ünlüler" sayılır (kullanıcı kararı: "Ünlü oyuncu yeni dizisini tanıttı tarzı haberleri de
    değerli sayalım"); oyun fragmanı ya da tanıtım filminde yalnız olay grupları atılır."""
    from news_value import GROUPS
    olay = {"can kaybı", "kaza/afet", "güvenlik", "suç ve vahşet", "kayıp ve arama", "dünya ve savaş", "acı olay", "adli olay", "magazin/spor"}
    hits = [r for r in v.get("reasons", []) if r not in olay]
    if magazin and "magazin ve ünlüler" not in hits:
        hits.append("magazin ve ünlüler")
    weight = {name: w for name, w, _ in GROUPS}
    imp = v.get("importance")
    reason = ", ".join(hits) + (f" · önem {imp}/5" if imp is not None else "") if hits else (f"önem {imp}/5" if imp else "sıradan haber")
    total = sum(weight.get(r, 3) for r in hits)
    # news_value.score ile aynı kural: magazin grubu varken model 1-2 demediyse değerli; değilse önem 4-5 ya da puan ≥3 ve önem ≥3
    return {**v, "reasons": hits, "reason": reason, "score": total,
            "valuable": (imp is None or imp >= 3) if magazin else ((imp is not None and imp >= 4) or (total >= 3 and (imp is None or imp >= 3)))}


def news_value(data: dict, segs: list) -> dict:
    """Anlık videonun YouTube değeri (scripts/news_value.py): anahtar kelime + modelin verdiği önem."""
    from news_value import score
    pol = load_json(DATA / "settings.json", {}).get("youtubePolicy") or {}
    text = " ".join(f"{s.get('title', '')} {s.get('narration', '')}" for s in segs if s.get("kind") in ("hook", "haber"))
    topic = DATA.parent / "work" / "anlik_topic.txt"  # konunun başı (başlık + özet); uzun gövde yanlış pozitif yapar
    text += " " + (topic.read_text(encoding="utf-8")[:300] if topic.exists() else "")
    v = score(text, pol.get("extraKeywords"), data.get("importance"))
    if TRAILER:  # fragman dışında sinema etiketli haberin olay grupları kalır (setteki gerçek kaza #kaza almalı)
        v = sinema_value(v, {s.get("category") for s in segs if s.get("kind") in ("hook", "haber")} == {"sinema"})
    n = int(os.environ.get("ANLIK_SOURCE_COUNT") or 1)  # breaking_watch: bu olayı veren farklı site sayısı
    if n > 1:
        v["reasons"].append(f"{n} kaynakta")
        v["reason"] += f" · {n} kaynakta"
        if n >= 3 and (v.get("importance") or 3) >= 3:  # çok konuşulan haber YouTube için de değerli
            v["valuable"] = True
    if data.get("importanceReason"):
        v["importanceReason"] = str(data["importanceReason"])[:200]
    print(f"  haber değeri: {'DEĞERLİ' if v['valuable'] else 'sıradan'} ({v['reason']})")
    return v


def week_range(now) -> str:
    """Haftanın özeti için tarih aralığı: "6–12 Ekim" ya da ay değişiyorsa "29 Eylül–5 Ekim"."""
    from datetime import timedelta
    a = now - timedelta(days=6)
    return f"{a.day}–{now.day} {AYLAR[now.month - 1]}" if a.month == now.month else f"{a.day} {AYLAR[a.month - 1]}–{now.day} {AYLAR[now.month - 1]}"


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


def intro_text() -> str:
    """Sabit intro cümlesi: format adı + "son N saatin Türkiye gündemi"."""
    if ANLIK:
        return os.environ.get("INFO_INTRO", "").strip() or "Son dakika."
    if GUNLUK:
        return INTRO_HAFTALIK if HAFTALIK else INTRO_GUNLUK
    hours = int(load_json(DATA / "settings.json", {}).get("scheduleHours") or 5)
    label = os.environ.get("FORMAT_LABEL", "").strip() or "Gündem"
    label = label[:1] + label[1:].replace("I", "ı").replace("İ", "i").lower()  # "Güne Başlarken" → "Güne başlarken"
    return f"{label}, son {hours} saatin Türkiye gündemi."


def regular_slot_of_day(date: str) -> int:
    """Kaçıncı 5 saatlik video: o günün anlık olmayan videoları + 1 (anlık videolar sayımı kaydırmaz)."""
    n = 0
    for f in (ROOT / "out").glob(f"{date}-*.json"):
        if re.match(rf"{re.escape(date)}-\d+\.json$", f.name) and load_json(f, {}).get("format") not in ("anlik", "gunluk", "haftalik"):
            n += 1
    return n + 1


# şablon videolarda (Claude yazmaz) ve Claude yazmadıysa ilk yorum
FIRST_COMMENT = {"deprem": "Depremi hissettiniz mi? Bulunduğunuz ili yorumlara yazın, geçmiş olsun 👇",
                 "mac": "Maçı nasıl buldunuz? Sizce maçın en iyisi kimdi? 👇",
                 "piyasa": "Sizce dolar ve altın bu hafta nereye gider? Tahmininizi yazın 👇",
                 "takvim": "Bu hatırlatma işinize yaradı mı? Başka hangi tarihleri hatırlatalım? 👇",
                 "meteo": "Sizin ilinizde durum nasıl? Yorumlara yazın, dikkatli olun 👇",
                 "alarm": "Bu fiyatlar bütçenizi nasıl etkiliyor? Yorumlara yazın 👇",
                 "derleme": "Bu hafta sizi en çok hangi haber etkiledi? 👇"}


def first_comment(data: dict, segs: list) -> str | None:
    t = str(data.get("firstComment") or "").strip() or FIRST_COMMENT.get(INFO_KIND, "")
    if not t:
        t = "Siz bu konuda ne düşünüyorsunuz? Yorumlarda buluşalım 👇"
    try:  # hassas kelimeler yorumda da yıldızlı
        import censor
        t = censor.mask(t)
    except Exception:
        pass
    return expand_abbr(t)[:300]


def main(src: str, dst: str):
    raw = Path(src).read_text(encoding="utf-8")
    data = extract_json(raw)
    segs = data.get("segments", [])
    haber = [s for s in segs if s.get("kind") == "haber"]
    # şablon videoda (deprem/maç/piyasa/takvim/derleme) haber sayısını veri belirler (1-6); Claude senaryosunda sınır
    if os.environ.get("TEMPLATE_DIR") and not 1 <= len(haber) <= 6:
        sys.exit(f"Şablon senaryoda haber sayısı {len(haber)} (1-6 olmalı)")
    if not os.environ.get("TEMPLATE_DIR") and not (HABER_MIN <= len(haber) <= HABER_MAX):
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
    segs[-1]["narration"] = (os.environ.get("INFO_OUTRO", "").strip() or OUTRO_ANLIK) if ANLIK else OUTRO_HAFTALIK if HAFTALIK else OUTRO_GUNLUK if GUNLUK else OUTRO_TEXT
    # Intro da sabit: "Güne başlarken, son 5 saatin Türkiye gündemi." (anlık haberde "Son dakika.")
    if len(segs) > 1 and segs[1].get("kind") == "intro":
        segs[1]["narration"] = intro_text()
    hk = segs[0]
    if len(hk.get("narration", "").split()) > 10:
        hk["narration"] = " ".join(hk["narration"].split()[:10]).rstrip(",;:") + "."
    hk["title"] = tr_upper(short_title(hk.get("title") or " ".join(hk["narration"].split()[:3])))
    if hk.get("category") not in CATEGORIES:
        hk["category"] = next((x.get("category") for x in segs if x.get("kind") == "haber" and x.get("category") in CATEGORIES), "genel")

    def _txt(x):
        return f"{x.get('title', '')} {x.get('narration', '')}"
    # tek konulu anlık video (çoklu değil) tek olaydır: bir sinema kartı gerçek zarar anlatıyorsa ("Dizi setinde yangın: 3 kişi
    # yaralandı") aynı olayın diğer sinema kartları da asayiş olur ("İtfaiye yangını söndürdü" klaketli SİNEMA kartına düşmesin)
    real_story = ANLIK and not os.environ.get("ANLIK_MULTI") and not TRAILER and any(
        x.get("kind") in ("hook", "haber") and x.get("category") == "sinema" and ASAYIS.search(_txt(x)) and GERCEK_OLAY.search(_txt(x))
        for x in segs)
    for s in segs:
        if s.get("kind") == "sesli":  # WhatsApp/sosyal medya görüntüsü kendi sesiyle oynar: seslendirme yok, süre klipten
            if float(s.get("soundDuration") or 0) <= 0:
                sys.exit("Orijinal sesli bölümün süresi yok")
            s["narration"] = ""
            if s.get("title"):
                s["title"] = expand_abbr(s["title"])
            continue
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
        txt = f"{s.get('title', '')} {s['narration']}"
        cat = s.get("category")
        if s["kind"] in ("haber", "hook") and not TRAILER and (ASAYIS.search(txt) or (real_story and cat == "sinema")) and (
                cat not in ASAYIS_MUAF or (cat == "sinema" and (real_story or GERCEK_OLAY.search(txt)))):
            print(f"  kategori {s.get('category')} → asayis ({s.get('title', '')[:40]})", file=sys.stderr)
            s["category"] = "asayis"
    if ANLIK and haber and os.environ.get("INFO_BREAKING", "") != "0":
        haber[0]["breaking"] = True  # anlık videonun ilk haberi her zaman SON DAKİKA kartı
        segs[0]["breaking"] = True
    src_name, src_url = os.environ.get("ANLIK_SOURCE", "").strip(), os.environ.get("ANLIK_URL", "").strip()
    breaking = [s for s in haber if s.get("breaking")]
    for s in breaking[1:]:
        s["breaking"] = False  # en fazla bir manşet
    words = sum(len(s["narration"].split()) for s in segs if s["kind"] not in ("outro", "intro"))
    if words > MAX_WORDS_TOTAL:
        sys.exit(f"Toplam {words} kelime, üst sınır {MAX_WORDS_TOTAL}. Senaryo {DURATION} saniyeye sığmaz.")

    matched = attach_images(segs)
    multi = load_json(DATA.parent / "work" / "anlik_items.json", []) if ANLIK and os.environ.get("ANLIK_MULTI") else []
    if multi:  # çoklu son dakika: her segment kendi haberinin sayfasından fotoğraf/video alır, kendi kaynağını gösterir
        def which(s, k):
            try:
                i = int(s.get("item") or 0)
            except (TypeError, ValueError):
                i = 0
            if 1 <= i <= len(multi):
                return i - 1
            words = {w[:5] for w in re.findall(r"\w{5,}", f"{s.get('title', '')} {s.get('narration', '')}".lower())}
            best = max(range(len(multi)), key=lambda j: len(words & {w[:5] for w in re.findall(r"\w{5,}", (multi[j].get("title") or "").lower())}))
            return best if words else min(k, len(multi) - 1)
        for k, s in enumerate(x for x in segs if x.get("kind") in ("hook", "haber")):
            m = multi[which(s, max(0, k - 1))]
            s["item"] = multi.index(m) + 1
            if m.get("url"):
                s["articleUrl"] = m["url"]
                s.pop("imageUrl", None)
            if m.get("source"):
                s["source"] = m["source"]
        src_name = " · ".join(dict.fromkeys(m.get("source") or "" for m in multi if m.get("source"))) or src_name
        src_url = ""
        print(f"  çoklu son dakika: {len(multi)} haber tek videoda ({src_name})")
    # sosyal medya linkinden video (INFO_KIND video + adres): kaynak videoda gösterilmez, açıklamanın en altında tek satır (kullanıcı kararı)
    if ANLIK and src_url and INFO_KIND != "video":  # haber sitesinden gelen anlık haber: fotoğraf/video o haberin sayfasından
        for s in segs:
            if s.get("kind") in ("hook", "haber"):
                s["articleUrl"] = src_url
                s.pop("imageUrl", None)
                if src_name and s.get("source") in (None, "", "Türkiye Gündemi"):
                    s["source"] = src_name
        pages = load_json(DATA.parent / "work" / "anlik_pages.json", []) if not multi else []
        rest = [p for p in pages if p.get("url") and p["url"] != src_url]
        if rest:  # elle verilen konu sitelerde arandı: sonraki kartlar fotoğraf/videoyu diğer sitelerin sayfasından alır
            for k, s in enumerate(haber[1:]):
                p = rest[k % len(rest)]
                s["articleUrl"] = p["url"]
                if p.get("source") and s.get("source") in (None, "", "Türkiye Gündemi", src_name):
                    s["source"] = p["source"]
            print(f"  görüntüler {1 + len(rest)} haber sayfasından alınacak")
        if src_name:  # kanca ve ilk haber kartı her zaman asıl kaynağı gösterir
            segs[0]["source"] = src_name
            if haber:
                haber[0]["source"] = src_name
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
        "slotLabel": (INFO_LABEL or "ANLIK HABER") if ANLIK else "HAFTANIN ÖZETİ" if HAFTALIK else "GÜNÜN ÖZETİ" if GUNLUK else f"{regular_slot_of_day(date)}. {hours} SAAT",
        "timeRange": now.strftime("%H:%M") if ANLIK else week_range(now) if HAFTALIK else f"00:00–{now.strftime('%H:%M')}" if GUNLUK else f"{start.strftime('%H:%M')}–{now.strftime('%H:%M')}",
        "anlik": ANLIK,
        "infoKind": INFO_KIND or None,  # şablon video türü: deprem | mac | piyasa | takvim
        "userVideo": os.environ.get("USER_VIDEO") == "1" or None,
        "trailer": os.environ.get("TRAILER") == "1" or None,  # fragman analizi: açıklama "🎬 FRAGMAN: …", #sondakika yerine #fragman
        "summary": os.environ.get("SUMMARY") == "1" or None,  # uzun video özeti: intro ve açıklamada kendi etiketi (ÖZET…), son dakika değil
        "publishAt": os.environ.get("PUBLISH_AT") or None,  # WhatsApp'ta yazılan yayın saati (post_pipeline o saate planlar)  # WhatsApp'tan gönderilen görüntüden montaj (yayın onayla)
        "expiresAt": data.get("expiresAt") or None,  # bilgi bu andan sonra eskir: expire_videos.py YouTube'da liste dışı yapar
        "firstComment": first_comment(data, segs),  # yayından sonra YouTube/Instagram'a kanal adına ilk yorum
        "value": news_value(data, segs) if ANLIK else None,
        "hashtags": topic_hashtags(data),
        "sourceName": src_name or None,
        "sourceUrl": src_url or None,
        "sources": [{"name": m.get("source"), "url": m.get("url"), "title": m.get("title")} for m in multi] or None,
        "scheduleHours": hours,
        "timeLabel": now.strftime("%H:%M"),
        "targetDuration": DURATION,
        "format": os.environ.get("FORMAT", "ozel"),
        "remakeOf": os.environ.get("REMAKE_OF") or None,  # tutan videonun farklı senaryo/görselle yeniden yayını
        "peakHour": int(os.environ["PEAK_HOUR"]) if os.environ.get("PEAK_HOUR", "").isdigit() else None,  # en çok izlenen saat tekrarı
        "formatLabel": os.environ.get("FORMAT_LABEL", "Gündem"),
        "music": "music/ogle.mp3" if ANLIK else f"music/{os.environ.get('FORMAT', 'aksam') if os.environ.get('FORMAT', 'aksam') in ('sabah', 'ogle', 'aksam') else 'aksam'}.mp3",
        "segments": segs,
    }
    record_used_news(segs, f"{date}-{ep_n}")  # tekrar engeli özgün başlıklarla
    # Üretilen haber hafızası (kullanıcı isteği, 18 Ekim: "ürettiğimiz haberi tekrar yakalamayalım"; scripts/news_memory.py):
    # HER videonun hikâyeleri (düzenli, anlık, çoklu, sosyal medya/WhatsApp, fragman, deprem/maç/meteoroloji) kaynak başlığı,
    # adresi ve metniyle kaydedilir; Mynet/son dakika/sondakika.com otomatik yakalaması aynı haberi başka sözlerle de tanır.
    # piyasa/takvim/alarm/derleme ve günün/haftanın özeti yazılmaz. Hassas kelime yıldızlamasından önce (özgün başlıklar).
    try:
        from news_memory import record_episode
        n_mem = record_episode(out, segs, f"{date}-{ep_n}")
        if n_mem:
            print(f"  üretilen haber hafızasına {n_mem} haber yazıldı (otomatik yakalama bunları tekrar üretmez)")
    except Exception as e:
        print(f"  ! üretilen haber hafızası yazılamadı: {e}")
    # Hassas kelimeler (censor.py): ekrandaki başlıklar, kapak ve yayın başlığı yıldızlı yazılır (int*har, s*lah);
    # seslendirme metni özgün kalır, tts.py o kelimelerin yerine bip koyar ve altyazıyı yıldızlı üretir.
    try:
        import censor
        for s in segs:
            if s.get("kind") in ("hook", "haber") and s.get("title"):
                s["title"] = censor.mask(s["title"])
        out["titles"] = {k: censor.mask(v) for k, v in out["titles"].items()}
        out["publishTitle"] = censor.mask(out["publishTitle"])
        out["hashtags"] = censor.clean_tags(out.get("hashtags") or [])
    except Exception as e:
        print(f"  ! hassas kelime gizleme atlandı: {e}", file=sys.stderr)
    Path(dst).write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"{len(haber)} haber, {words} kelime, günün {out['episodeOfDay']}. videosu ({out['slotLabel']}, {out['timeRange']}) -> {dst}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
