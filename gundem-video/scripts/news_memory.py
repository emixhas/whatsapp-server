#!/usr/bin/env python3
"""Üretilen haber hafızası (kullanıcı isteği, 18 Ekim: "ürettiğimiz haberi tekrar yakalamayalım"): otomatik yakalama (Mynet,
son dakika siteleri, sondakika.com, değerli haber toplayıcısı) videosunu ürettiğimiz bir haberi, başka sitede başka sözlerle
yazılmış olsa da, bir daha üretmez. Elle istekler engellenmez (panel yalnız loga önceki videoyu yazar).

Kayıt `data/breaking_produced.json` (adı korunur; eski {title, at} kayıtları da okunur). `assemble_script` HER videoda hikâye
başına bir kayıt yazar: düzenli 5 saatlik videoda her haber (kanca en benzer haberine katılır), anlık/şablon/sosyal medya
videosunda tek kayıt, çoklu anlıkta her haber ayrı. Kayıt {at, video, kind (regular|anlik|multi|video|trailer|template|mark),
title (bizim başlığımız), src (kaynak başlıkları), urls (normalize kaynak adresleri), words (başlık + seslendirme + kaynak
başlık/metin kökleri), anchors (özel ad kökleri), tanchors (başlıklardaki özel adlar), places / tplaces (yer adları), nums /
tnums (dikkat çekici sayılar), mk (başlıkta "artçı/yine…"), open (6+ deprem: gelişmeler serbest)}. Yazılmayanlar: piyasa,
takvim, zam/rekor alarmı, Pazar derlemesi, günün/haftanın özeti (haber üretmez, özetler). Video çıkmadan biten üretimin
kayıtlarını `pipeline.sh` siler (`--drop`). Panelin `--mark` çağrısı kind "mark" kaydı yazar (başlık + adres + kaynağın metni;
sıradaki iş beklerken aynı haber ikinci kez yakalanmasın): MARK_H saat sayılır, assemble aynı haberin işaretini siler (yerine
zengin kayıt). Saklama max(dedup.hours, 48) saat, en çok MAX_ENTRIES kayıt.

Eşleşme (`match`, sırasıyla; pencere `settings.dedup.hours`, varsayılan 48, 6-168):
  a) aynı adres (şema, www./m./amp./mobil., izleme parametreleri ve # atılır — ?id=, ?p=, HaberID=, YouTube/Facebook v=
     kalır —, baştaki /amp/, sondaki / ve /amp, Google AMP önbelleği; ana sayfa adres sayılmaz)
  b) `same_event(başlık, kayıt başlığı ya da kaynak başlığı)` (eski kural), çelişki ve konu farkı yok (iki başlığın ilk içerik
     sözcüğü karşı haberde hiç geçmiyor: "Konut satışları…" ↔ "Otomobil satışları…")
  c) içerik: aday başlık + metnin ilk 600 karakteri kayıt kökleriyle; ortak özel ad ya da dikkat çekici sayı şart; sonra
     ≥ N_COMMON özel ad dışı ortak kök + başlık kapsaması ≥ T_COVER, ya da ≥3 ortak özel ad + aynı sayı (maç, deprem);
     örtüşme katsayısı ≥ T_OVERLAP; çelişki yok
Yalnız başlıkla (b) aynı ildeki başka olay ayrılamaz ("Konya'da yolcu otobüsü devrildi"): panel otomatik yolda listeden yalnız
adres eşleşmesinde atlar, gerisine haber sayfası okununca gövdeyle bakar.
Çelişki (b ve c'de veto): iki başlıkta da karşı haberde hiç geçmeyen özel ad (Manisa ↔ Malatya, Konyaspor ↔ Kasımpaşa) ya da
bir başlıkta karşıda olmayan ad + karşı metinde bunda olmayan ≥2 ad; kaydın başlığındaki yer adayda yok ve adayın yeri (başlık
ya da giriş: "Bismil ilçesinde") kayıtta yok; iki başlıkta da karşıda olmayan akaryakıt/fatura kalemi (benzin ↔ motorin);
başlıktaki skor / ondalık (deprem büyüklüğü ±0,2) / oran / ≥10 tam sayı / birimli sayı ("5 katlı" ↔ "3 katlı") karşı haberde
yok ve karşı başlığınki de bunda yok; saatler 30 dk'dan fazla ayrı; yeni başlıkta kayıtta olmayan durum (tutuklandı, serbest
bırakıldı, adli kontrol, taburcu, beraat, iddianame) ya da "artçı, ikinci, yeniden, yine, bir X daha, bu kez, yeni <olay>"
(yeni gelişme). Eşikler Türkçe test derleminde (aynı haber farklı sitede / benzer kelimeli farklı haber; kalibrasyon +
sonradan yazılmış iki doğrulama seti + bağımsız inceleme derlemi) sıfır yanlış eşleşmeyle seçildi: yanlış eşleşme gerçek bir
haberi sessizce düşürür, kaçan eşleşme en kötü ikinci video yapar.
`settings.dedup.enabled: false` → eski davranış: 12 saat, yalnız başlık (b), düzenli 5 saatlik videoların kayıtları sayılmaz.

  python3 scripts/news_memory.py --list            # son kayıtlar (özet)
  python3 scripts/news_memory.py --check '[{"title": "…", "text": "…", "url": "…", "noMark": false}]'   # {ok, results: [{dup, match}]}
  python3 scripts/news_memory.py --group '[{"title": "…", "text": "…", "url": "…"}, …]'   # {ok, groups, reasons}: partide aynı haber
  python3 scripts/news_memory.py --drop 2026-10-18-3 --since 1760800000   # video çıkmadı: bu üretimin kayıtları silinir
"""
import functools
import json
import os
import re
import sys
import time
import urllib.parse
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import DATA, ROOT, load_json, save_json, settings  # noqa: E402

FILE = DATA / "breaking_produced.json"
KEEP_MIN_H = 48          # kayıtlar en az bu kadar tutulur (pencere kısaltılsa da geri açılınca kaybolmasın)
MAX_ENTRIES = 800        # dosya sınırı (48 saatte ~150-250 kayıt beklenir)
MARK_H = 3               # üretime alınış işareti (video yok) bu kadar saat sayılır: sıra + üretim için yeter, üretim düşerse haber
                         # 48 saat kilitlenmesin (başarılı üretimde assemble işareti siler, yerine zengin kayıt yazar)
OLD_H = 12               # dedup kapalıyken eski pencere
NO_MEMORY = {"piyasa", "takvim", "alarm", "derleme"}  # haber olmayan şablonlar: hiçbir şeyi engellemesin
# Eşikler (Türkçe derlem: 41+41 kalibrasyon, 15+15 ve 10+10 doğrulama çifti; 66 farklı haberde 0 yanlış eşleşme, aynı haberin
# %88'i tanınır; N=2'de doğrulama setinde yanlış eşleşme çıktı, T 0,1-0,35 arası aynı sonuç)
N_COMMON = 3             # özel ad dışında en az bu kadar ortak kök
T_OVERLAP = 0.2          # ortak kök / küçük kümenin boyu
T_COVER = 0.5            # aday başlığının (ya da kayıt başlığının) en az yarısı karşı haberde geçmeli
TEXT_CHARS = 600         # adayın metninden bakılan kısım (başlık + giriş; uzun gövde ilgisiz kelime taşır)

# --------------------------------------------------------------------------- metin

STOP = {"için", "ile", "olan", "olarak", "sonra", "daha", "göre", "yeni", "oldu", "etti", "dedi", "açıkladı", "haber",
        "son", "dakika", "flaş", "gelişme", "açıklama", "neler", "nedir", "belli"}  # breaking_watch.STOP ile aynı
# içerik karşılaştırmasında sayılmayan genel haber kökleri (5 harf): fiiller, zaman, yer kalıpları, her kazada geçenler
CSTOP = {
    "açıkl", "yapıl", "yaptı", "yapta", "yapar", "edild", "ediyo", "ettiğ", "olduğ", "olmuş", "olaca", "olmas", "olmad", "olduk",
    "bulun", "belir", "bildi", "duyur", "söyle", "kayde", "ifade", "aktar", "verdi", "veril", "verec", "alınd", "alına", "aldığ",
    "geldi", "gelen", "gelme", "gitti", "çıktı", "çıkan", "çıkar", "başla", "ardın", "karşı", "üzere", "kadar", "birli", "ilgil",
    "konuş", "yönel", "ancak", "ayrıc", "hemen", "bugün", "yarın", "dünkü", "geçen", "saatl", "sular", "sabah", "akşam", "öğlen",
    "gece", "günü", "günde", "günün", "neden", "nedey", "sonuc", "şekil", "durum", "hafta", "yılın", "yıl", "ayın",
    "yaral", "hasta", "kişi", "kişin", "kişil", "olay", "olayd", "olayı", "olayl", "olaya", "ekipl", "ekibi", "ekip", "sevk",
    "meyda", "hayat", "kaybe", "yaşam", "yitir", "öldü", "kaldı", "türki", "türk", "yüzde", "lira", "milyo", "milya", "büyük",
    "ilçes", "ilçed", "ilçe", "ilind", "ilini", "mahal", "kilom", "metre", "saat", "dakik", "sanat", "usta", "ünlü", "efsan",
    "ocak", "şubat", "mart", "nisan", "mayıs", "hazir", "temmu", "ağust", "eylül", "ekim", "kasım", "aralı",
    "pazar", "salı", "çarşa", "perşe", "cuma", "cumar", "şimdi", "artık", "bile", "bütün", "tüm", "hala", "henüz",
    "dikka", "uyard", "uyarı", "çağrı", "sosya", "medya", "payla", "hesab", "video", "görün", "anlar", "kamer", "yansı",
    "bakan", "başka", "cumhu", "vali", "valil", "valis", "genel", "müdür", "kurum", "kurul", "kulüb",
}
# özel ad sayılmayan büyük harfli sözcükler: unvan/genel ad kökleri (5 harf) ve tam sözcük olarak ay/gün adları ("Kasım" ayı
# özel ad değil ama "Kasımpaşa" özel ad: kök değil tam sözcük karşılaştırılır)
ANCHOR_STOP = {"son", "dakik", "flaş", "bakan", "başka", "cumhu", "vali", "valil", "valis", "genel", "müdür", "sayın", "prof",
               "doç", "dr", "türki", "türk", "haber", "video", "canlı", "özel", "yeni", "ünlü", "usta", "efsan", "bugün", "yarın",
               "işte", "bu", "o", "şu", "ve", "ile", "bir", "en", "ne", "neden", "nasıl", "kim", "kimdi", "hangi", "ilk", "resmi", "resme"}
ANCHOR_STOP_WORDS = set("ocak şubat mart nisan mayıs haziran temmuz ağustos eylül ekim kasım aralık pazartesi salı çarşamba perşembe "
                        "cuma cumartesi pazar dün".split())
# cümle başında da özel ad sayılanlar (81 il, büyük kulüpler, sık geçen adlar); tam sözcük karşılaştırılır
GAZ = set("""adana adıyaman afyonkarahisar afyon ağrı amasya ankara antalya artvin aydın balıkesir bilecik bingöl bitlis bolu
burdur bursa çanakkale çankırı çorum denizli diyarbakır edirne elazığ erzincan erzurum eskişehir gaziantep giresun gümüşhane
hakkari hatay ısparta mersin istanbul izmir kars kastamonu kayseri kırklareli kırşehir kocaeli konya kütahya malatya manisa
kahramanmaraş mardin muğla muş nevşehir niğde ordu rize sakarya samsun siirt sinop sivas tekirdağ tokat trabzon tunceli
şanlıurfa uşak van yozgat zonguldak aksaray bayburt karaman kırıkkale batman şırnak bartın ardahan ığdır yalova karabük kilis
osmaniye düzce galatasaray fenerbahçe beşiktaş trabzonspor başakşehir konyaspor kasımpaşa samsunspor göztepe kayserispor
antalyaspor alanyaspor sivasspor rizespor eyüpspor bodrumspor erdoğan bahçeli imamoğlu yavaş şimşek yerlikaya fidan trump
putin zelenski netanyahu mourinho gazze israil ukrayna rusya amerika avrupa""".split())
MARKER = re.compile(r"(?<![\w])(artçı|ikinci|yeniden|yine|bir kez daha|bir daha|yeni bir|bir [a-zçğıöşü]+ daha|bu kez|bu sefer|"
                    r"yeni (?:orman )?(?:deprem|yangın|zam|saldırı|operasyon|kaza|patlama|sel|dalga|çatışma|gözaltı|grev)\w*)(?![\w])")
# aynı davada durum değişikliği yeni gelişmedir (gözaltı → tutuklandı, serbest bırakıldı…): (desen, kayıtta aranan 5 harflik kök)
DEV = [(re.compile(r"tutuklan"), "tutuk"), (re.compile(r"serbest bırakıl"), "serbe"), (re.compile(r"adli kontrol"), "kontr"),
       (re.compile(r"taburcu"), "tabur"), (re.compile(r"beraat"), "beraa"), (re.compile(r"iddianame"), "iddia")]
# akaryakıt/fatura kalemleri başlıkta konu belirler: "Benzine 1 lira 25 kuruş zam" ↔ "Motorine 1 lira 25 kuruş zam" farklı haber
FUEL = {"benzi", "motor", "mazot", "otoga", "doğal", "elekt"}
# yer adı: bulunma/ayrılma ekli özel ad (Kadıköy'de, Dilovası'nda, Silvan'dan) ya da "… ilçesinde/mahallesinde/köyünde"
LOC = re.compile(r"([A-ZÇĞİÖŞÜ][^\W\d_]+)(?:['’](?:n?[dt][ae]n?)\b|\s+(?:ilçe|mahalle|köy|beldes)\w*)")
# yer sayılmayan genel adlar (çok sözcüklü adın son sözcüğü: "Devlet Hastanesi'nde", "Tepe Mahallesi'nde", "… Havalimanı'nda")
PLACE_STOP = {"hasta", "mahal", "cadde", "sokak", "bulva", "meyda", "haval", "otoga", "köprü", "ünive", "fabri", "cezae", "karak",
              "adliy", "mahke", "beled", "valil", "kayma", "emniy", "janda", "merke", "bölge", "kavşa", "istas", "termi", "liman",
              "tesis", "sites", "stadı", "stady", "okulu", "parkı", "köyü", "mecli", "bakan"}
NUMW = {"iki": 2, "üç": 3, "dört": 4, "beş": 5, "altı": 6, "yedi": 7, "sekiz": 8, "dokuz": 9}
TENS = {"on": 10, "yirmi": 20, "otuz": 30, "kırk": 40, "elli": 50, "altmış": 60, "yetmiş": 70, "seksen": 80, "doksan": 90}
MONTHS = "ocak|şubat|mart|nisan|mayıs|haziran|temmuz|ağustos|eylül|ekim|kasım|aralık"


def low(t: str) -> str:
    """Türkçe küçük harf (İ → i, I → ı); Python'un lower()'ı İ'yi "i̇" yapar."""
    return (t or "").replace("I", "ı").replace("İ", "i").lower()


@functools.lru_cache(maxsize=4096)
def _expand(t: str) -> str:
    """Kısaltmalar seslendirmedeki gibi açılır (TCMB → Merkez Bankası, AFAD → Afet ve Acil Durum Yönetimi): kaynak "TCMB",
    bizim seslendirmemiz "Merkez Bankası" yazar; iki taraf aynı biçimde karşılaştırılsın."""
    try:
        from assemble_script import expand_abbr
        return expand_abbr(t or "")
    except Exception:
        return t or ""


# eş anlamlı haber kalıpları tek köke: "vefat etti" = "hayatını kaybetti" = "yaşamını yitirdi" (başlık ve giriş farklı söyler)
SYNONYM = [(re.compile(r"hayatını kaybe\w*|yaşamını yitir\w*|can verdi\w*|vefat\w*|(?<![\w])öldü(?![\w])"), " vefat ")]


def _no_suffix(t: str) -> str:
    """Kesme işaretinden sonraki ek atılır ("Malatya'daki" → "Malatya"): ek ("daki", "deki", "ndan") içerik kökü sayılmasın."""
    return re.sub(r"['’][^\W\d_]+", "", t)


def cstems(text: str) -> set:
    """İçerik kökleri: 4+ harfli sözcüklerin ilk 5 harfi, genel haber kelimeleri ve kesme işaretli ekler hariç."""
    out = set()
    t = _no_suffix(low(_expand(text)))
    for rx, rep in SYNONYM:
        t = rx.sub(rep, t)
    for w in re.findall(r"[^\W\d_]+", t):
        if len(w) > 3 and w not in STOP:
            s = w[:5]
            if s not in CSTOP and w[:4] not in CSTOP:
                out.add(s)
    return out


def lower_words(text: str) -> set:
    """Metinde küçük harfle de geçen sözcükler: cümle başındaki "Kayıp" metinde "kayıp olan" diye geçiyorsa özel ad değildir."""
    return {w for w in re.findall(r"[^\W\d_]+", _expand(text)) if w[0].islower()}


def proper(text: str, lower_ctx=frozenset()) -> set:
    """Özel ad kökleri (ilk 5 harf), Türkçe kurala göre: kesme işaretli ek (Kadıköy'de, Erdoğan'ın) her zaman özel addır;
    cümle ortasında büyük harfle başlayan sözcük, kısaltma (CHP, KAP), cümle başında ise yalnız il/kulüp/sık ad listesindeki
    ya da hemen ardından büyük harfli sözcük gelen (Merkez Bankası; ama haberin herhangi bir yerinde küçük harfle de geçiyorsa
    — "Kayıp Rojin'in" / "kayıp olan" — sıfattır) sayılır. Tamamı büyük harfli başlıkta (SON DAKİKA: …) büyük harf bilgi
    taşımaz: yalnız kesme işaretli ve listedeki sözcükler."""
    text = _expand(text)
    letters = [c for c in text if c.isalpha()]
    shout = bool(letters) and sum(c.isupper() for c in letters) / len(letters) > 0.7
    toks = list(re.finditer(r"[^\W\d_]+(?:['’][^\W\d_]+)?", text))
    out = set()
    for i, m in enumerate(toks):
        w = m.group(0)
        root = re.split(r"['’]", w)[0]
        lw = low(root)
        if len(lw) < 2 or lw[:5] in ANCHOR_STOP or lw in ANCHOR_STOP or lw in ANCHOR_STOP_WORDS:
            continue
        apos = root != w
        if shout:
            if (apos and len(lw) >= 3) or lw in GAZ:
                out.add(lw[:5])
            continue
        if not root[0].isupper():
            continue
        prev = text[:m.start()].rstrip()
        initial = not prev or prev[-1] in ".!?:;…\"“”«»(|\n—–"
        abbr = root.isupper() and 2 <= len(root) <= 6
        nxt = toks[i + 1] if i + 1 < len(toks) else None
        nxt_cap = bool(nxt) and nxt.group(0)[0].isupper() and not text[m.end():nxt.start()].strip()
        if apos or abbr or not initial or lw in GAZ or (nxt_cap and lw not in lower_ctx):
            out.add(lw[:5])
    return out


def places(text: str) -> set:
    """Yer adı kökleri (5 harf): "Kadıköy'de", "Dilovası'nda", "Silvan'dan", "Bismil ilçesinde" (yer vetosu, `conflict`)."""
    return {low(m.group(1))[:5] for m in LOC.finditer(_expand(text or ""))} - ANCHOR_STOP - PLACE_STOP


def _f(x: str) -> float:
    return float(x.replace(",", "."))


def numbers(text: str) -> dict:
    """Dikkat çekici sayılar türüne göre: time (dakika), score ("3-0"), pct, dec (ondalık), int (≥10, yıl/tarih/sıra değil).
    "4,8" = "4.8"; "4 bin" = "4.000" = 4000; "22 bin 104" = 22104; "on sekiz" = 18; "1 lira 25 kuruş" = 1,25."""
    t = low(_expand(text))
    used = [False] * len(t)
    out = {"time": set(), "score": set(), "pct": set(), "dec": set(), "int": set(), "unit": set()}

    def take(m, g=0):
        a, b = m.span(g)
        if any(used[a:b]):
            return False
        for k in range(a, b):
            used[k] = True
        return True
    for m in re.finditer(r"saat\s*(\d{1,2})[.:](\d{2})(?!\d)|(?<![\d.,])(\d{1,2}):(\d{2})(?!\d)", t):
        h, mi = (m.group(1), m.group(2)) if m.group(1) else (m.group(3), m.group(4))
        if int(h) < 24 and int(mi) < 60 and take(m):
            out["time"].add(int(h) * 60 + int(mi))
    for m in re.finditer(rf"(?<![\d.,])(\d{{1,2}})\s*[-–]\s*(\d{{1,2}})(?![\d.,])(?!\s*(?:{MONTHS}|yaş))", t):
        if take(m):
            out["score"].add(f"{int(m.group(1))}-{int(m.group(2))}")
    for m in re.finditer(r"(\d+)\s*lira\s*(\d{1,2})\s*kuruş", t):
        if take(m):
            out["dec"].add(round(int(m.group(1)) + int(m.group(2)) / 100, 2))
    for m in re.finditer(r"yüzde\s*(\d+(?:[.,]\d+)?)", t):
        if take(m):
            out["pct"].add(round(_f(m.group(1)), 2))
    for m in re.finditer(r"(?<![\d.,])(\d+(?:[.,]\d+)?)\s*(bin|milyon|milyar)(?![\w])(?:\s+(\d{1,3})(?![\d.,]))?", t):
        v = _f(m.group(1)) * {"bin": 1e3, "milyon": 1e6, "milyar": 1e9}[m.group(2)] + (int(m.group(3)) if m.group(3) and m.group(2) == "bin" else 0)
        if take(m):
            out["int"].add(int(v))
    for m in re.finditer(r"(?<![\d.,])\d{1,3}(?:\.\d{3})+(?![\d,]|\.\d)", t):
        if take(m):
            out["int"].add(int(m.group(0).replace(".", "")))
    for m in re.finditer(r"(?<![\d.,])(\d{1,4})[.,](\d{1,2})(?![\d])", t):
        if take(m):
            out["dec"].add(round(_f(m.group(0)), 2))
    for m in re.finditer(r"(?<![\d.,])(\d+)(?![\d])", t):
        if any(used[m.start():m.end()]):
            continue
        v = int(m.group(1))
        after = t[m.end():m.end() + 12]
        if v < 10 or 1900 <= v <= 2100 or re.match(r"\.\s+[a-zçğıöşü]", after) or re.match(rf"\s*(?:{MONTHS})", after):
            continue
        out["int"].add(v)
    # birimli sayı (yalnız çelişki için): "5 katlı" ↔ "3 katlı" farklı bina, "18 yaralı" = "on sekiz yaralı"
    for m in re.finditer(r"(?<![\d.,])(?<!yüzde )(\d{1,3})(?:['’][a-zçğıöşü]+)?\s+([a-zçğıöşü]{3,})", t):
        if not re.match(rf"(?:{MONTHS}|bin|milyon|milyar|lira|dolar|euro|yıl|ay|gün|saat|dakika)", m.group(2)):
            out["unit"].add(f"{int(m.group(1))}|{m.group(2)[:5]}")
    words = re.findall(r"[a-zçğıöşü]+", t)  # yazıyla sayı: "on sekiz yaralı" → 18 (yalnız ≥10 dikkat çekici)
    i = 0
    while i < len(words):
        v, j = 0, i
        if words[j] in TENS:
            v += TENS[words[j]]
            j += 1
        if j < len(words) and words[j] in NUMW:
            v += NUMW[words[j]]
            j += 1
        if v >= 10:
            out["int"].add(v)
        if v and j < len(words) and len(words[j]) >= 3 and words[j] not in ("bin", "milyon", "milyar"):
            out["unit"].add(f"{v}|{words[j][:5]}")
        i = max(j, i + 1)
    return out


def _approx(kind: str, a, b, quake=False) -> bool:
    if kind == "score":
        return a == b
    if kind == "time":
        return abs(a - b) <= 30
    if kind == "dec":
        return abs(a - b) <= (0.21 if quake and a < 10 and b < 10 else max(0.011, 0.002 * max(abs(a), abs(b))))
    if kind == "pct":
        return abs(a - b) <= max(0.051, 0.002 * max(abs(a), abs(b)))
    return abs(a - b) <= max(0, 0.001 * max(abs(a), abs(b)))


# izleme parametreleri (adresten atılır); diğer sorgu parametreleri haberin kimliğidir (?id=, ?p=, HaberID=, Facebook ?v=)
TRACK = re.compile(r"^(?:utm_\w+|at_\w+|mc_\w+|fbclid|gclid|yclid|dclid|igsh|igshid|si|ref|ref_src|amp|output|share|feature|s|t|"
                   r"ocid|cmpid|xtor|_ga|from|rss|source|ito)$", re.I)


def norm_url(u: str) -> str:
    """Karşılaştırma için adres: şema, www./m./amp./mobil., izleme parametreleri (utm_, at_, fbclid, amp…) ve # atılır, haberin
    kimliği olan sorgu (?id=, ?p=, HaberID=, Facebook ?v=) kalır; baştaki /amp/, sondaki / ve /amp, Google AMP önbelleği
    (*.cdn.ampproject.org/c/s/site/yol) asıl adrese; youtu.be/ID, /shorts/ID, /embed/ID, /live/ID → youtube.com/watch?v=ID;
    Instagram /reel/ /p/ /tv/ aynı gönderi. Ana sayfa ve video kimliksiz YouTube adresi haber göstermez: "" döner."""
    u = (u or "").strip()
    if not u:
        return ""
    if not re.match(r"^[a-z][a-z0-9+.-]*://", u, re.I):
        u = "http://" + u
    try:
        p = urllib.parse.urlsplit(u)
    except ValueError:
        return ""
    host = re.sub(r"^(?:www\d?|m|amp|mobil|mobile)\.", "", (p.hostname or "").lower())
    if not host:
        return ""
    path = p.path or ""
    if host.endswith(".cdn.ampproject.org"):
        m = re.match(r"^/[a-z]/(s/)?(.+)$", path)
        return norm_url(("https://" if m.group(1) else "http://") + m.group(2)) if m else ""
    if host in ("youtube.com", "youtu.be", "youtube-nocookie.com", "music.youtube.com"):
        vid = urllib.parse.parse_qs(p.query).get("v", [""])[0]
        if not vid:
            m = re.match(r"^/(?:shorts/|embed/|live/|v/)?([\w-]{6,})/?$", path) if host != "youtu.be" else re.match(r"^/([\w-]{6,})", path)
            vid = m.group(1) if m and (host == "youtu.be" or not path.startswith("/watch")) else ""
        if vid:
            return f"youtube.com/watch?v={vid}"
        if path.rstrip("/") in ("", "/watch"):
            return ""
    if host == "instagram.com":
        m = re.match(r"^/(?:[\w.]+/)?(?:p|reel|reels|tv)/([\w-]+)", path)
        if m:
            return f"instagram.com/p/{m.group(1)}"
    path = re.sub(r"/amp/?$", "", re.sub(r"^/amp(?=/)", "", path)).rstrip("/")
    q = sorted((k.lower(), v) for k, v in urllib.parse.parse_qsl(p.query) if not TRACK.match(k))
    if not path and not q:
        return ""
    return host + path + ("?" + urllib.parse.urlencode(q) if q else "")


# --------------------------------------------------------------------------- öznitelik

def _nums_json(n: dict) -> dict:
    return {k: sorted(v) for k, v in n.items() if v}


def _nums_set(n) -> dict:
    out = {"time": set(), "score": set(), "pct": set(), "dec": set(), "int": set(), "unit": set()}
    for k, v in (n or {}).items():
        if k in out:
            out[k] = set(v)
    return out


def features(title: str, text: str = "", url: str = "", src=(), full=None) -> dict:
    """Karşılaştırma öznitelikleri. title + src başlıklar, text gövde/seslendirme (adayda ilk TEXT_CHARS karakter)."""
    titles = [title or ""] + [s for s in src if s]
    body = text if full else (text or "")[:TEXT_CHARS]
    joined = " ".join(titles) + " " + body
    tn = [numbers(t) for t in titles]
    tnums = {k: set().union(*(x[k] for x in tn)) for k in tn[0]}
    allnums = numbers(joined)
    for k in allnums:
        allnums[k] |= tnums[k]
    lc = frozenset(low(w) for w in lower_words(joined))
    tanch = set().union(*(proper(t, lc) for t in titles))
    anch = tanch | set().union(*(proper(p, lc) for p in re.split(r"\n+", body) if p.strip())) if body else set(tanch)
    words = cstems(joined)
    tplaces = set().union(*(places(t) for t in titles))
    from breaking_watch import stems as bstems
    return {"title": title or "", "src": [s for s in src if s], "urls": [x for x in {norm_url(u) for u in ([url] if isinstance(url, str) else url)} if x],
            "words": words, "twords": cstems(title or ""), "tstems": [cstems(t) for t in titles if t], "anchors": anch, "tanchors": tanch,
            "nums": allnums, "tnums": tnums, "mk": any(MARKER.search(low(t)) for t in titles), "quake": "depre" in words,
            "bst": [(t, bstems(t)) for t in titles if t], "tplaces": tplaces, "places": tplaces | places(body)}


def _entry_feats(e: dict) -> dict:
    """Kayıttaki öznitelikler (eski {title, at} kaydı başlıktan hesaplanır)."""
    if "words" not in e:
        f = features(e.get("title", ""), src=e.get("src") or [], url=e.get("urls") or [])
        return {**f, **{k: e[k] for k in ("at", "video", "kind") if k in e}}
    words = set(e.get("words") or [])
    from breaking_watch import stems as bstems
    titles = [t for t in [e.get("title", ""), *(e.get("src") or [])] if t]
    return {"title": e.get("title", ""), "src": e.get("src") or [], "urls": e.get("urls") or [], "words": words,
            "tstems": [cstems(t) for t in titles], "bst": [(t, bstems(t)) for t in titles],
            "anchors": set(e.get("anchors") or []), "tanchors": set(e.get("tanchors") or []), "nums": _nums_set(e.get("nums")),
            "tnums": _nums_set(e.get("tnums")), "mk": bool(e.get("mk")), "quake": "depre" in words,
            "places": set(e.get("places") or []), "tplaces": set(e.get("tplaces") or [])}  # yer alanı olmayan kayıtta yer vetosu yok


def to_entry(f: dict, **extra) -> dict:
    """Dosyaya yazılacak kayıt (kümeler sıralı listeye, kısaltılmış)."""
    return {**extra, "title": f["title"][:200], "src": [s[:200] for s in dict.fromkeys(f["src"]) if s != f["title"]][:6],
            "urls": sorted(f["urls"])[:12], "words": sorted(f["words"])[:180], "anchors": sorted(f["anchors"])[:60],
            "tanchors": sorted(f["tanchors"])[:30], "nums": _nums_json(f["nums"]), "tnums": _nums_json(f["tnums"]),
            "places": sorted(f["places"])[:30], "tplaces": sorted(f["tplaces"])[:10], **({"mk": 1} if f["mk"] else {})}


# --------------------------------------------------------------------------- kurallar

def conflict(c: dict, e: dict):
    """İki haber farklı olay mı (eşleşmeyi veto eder)? Neden metni ya da None."""
    pe = e["anchors"] | e["words"]
    pc = c["anchors"] | c["words"]
    ca = {a for a in c["tanchors"] if a not in pe}
    ea = {a for a in e["tanchors"] if a not in pc}
    if ca and ea:
        return f"farklı özel ad ({', '.join(sorted(ca))[:40]} ↔ {', '.join(sorted(ea))[:40]})"
    # bir başlıkta karşı haberde hiç geçmeyen ad var ve karşı haberin metninde de bunda geçmeyen en az 2 ad (Gürcistan ↔ Barış
    # Boyun, İtalya): aynı bakanın iki ayrı operasyonu; tek eksik ad (takma ad "Aslan", soyadı) çelişki sayılmaz
    ca_all = {a for a in c["anchors"] if a not in pe}
    ea_all = {a for a in e["anchors"] if a not in pc}
    if (ca and len(ea_all) >= 2) or (ea and len(ca_all) >= 2):
        return f"farklı özel ad ({', '.join(sorted(ca or ca_all))[:40]} ↔ {', '.join(sorted(ea_all or ea))[:40]})"
    # yer: kaydın başlığındaki yer (ilçe) adayda hiç yok VE adayın (başlık + giriş) yeri kayıtta hiç yok. İl düzeyindeki başlıkta
    # ayırt eden ilçe çoğunlukla yalnız girişte yazar ("Diyarbakır'da silahlı kavga" + "Bismil ilçesinde" ↔ Silvan'daki kayıt)
    ep = {p for p in e["tplaces"] if p not in pc | c["places"]}
    cp = {p for p in c["places"] if p not in pe | e["places"]}
    if ep and cp:
        return f"farklı yer ({', '.join(sorted(cp))[:40]} ↔ {', '.join(sorted(ep))[:40]})"
    # akaryakıt/fatura kalemi: iki başlıkta da karşı haberde hiç geçmeyen kalem (benzin ↔ motorin, elektrik ↔ doğalgaz)
    cf = {w for w in c["twords"] if w in FUEL and w not in e["words"]}
    ef = {w for t in e["tstems"] for w in t if w in FUEL and w not in c["words"]}
    if cf and ef:
        return f"farklı kalem ({', '.join(sorted(cf))} ↔ {', '.join(sorted(ef))})"
    quake = c["quake"] and e["quake"]
    for k in ("score", "dec", "pct", "int"):
        ct, et = c["tnums"][k], e["tnums"][k]
        if ct and et and not any(_approx(k, x, y, quake) for x in ct for y in e["nums"][k]) \
                and not any(_approx(k, y, x, quake) for y in et for x in c["nums"][k]):
            return f"farklı sayı ({k})"
    cu, eu = _units(c["tnums"]["unit"]), _units(e["tnums"]["unit"])
    for u in set(cu) & set(eu):  # aynı birim, başka sayı: "5 katlı" ↔ "3 katlı" (karşı metinde de geçmiyorsa)
        if not cu[u] & eu[u] and not cu[u] & _units(e["nums"]["unit"]).get(u, set()) and not eu[u] & _units(c["nums"]["unit"]).get(u, set()):
            return f"farklı sayı ({u})"
    if c["nums"]["time"] and e["nums"]["time"] and not any(_approx("time", a, b) for a in c["nums"]["time"] for b in e["nums"]["time"]):
        return "farklı saat"
    tl = low(c["title"])
    for rx, st in DEV:  # yeni başlıkta kayıtta olmayan durum ("… tutuklandı" ↔ "…'e gözaltı"): davanın yeni gelişmesi
        if rx.search(tl) and st not in e["words"]:
            return "yeni gelişme (durum)"
    if c["mk"] and not e["mk"]:
        return "yeni gelişme (artçı/ikinci/yine…)"
    return None


def _units(xs) -> dict:
    out = {}
    for x in xs:
        v, _, u = str(x).partition("|")
        out.setdefault(u, set()).add(v)
    return out


def name_conflict(a: str, b: str, b_text: str = "") -> bool:
    """İki başlık farklı yer/kişi/kurum mu anlatıyor (Malatya ↔ Manisa depremi): ikisinde de karşı haberde hiç geçmeyen özel ad.
    viral_watch devam haberi seçerken kullanır (aynı türden başka ildeki olay "devam" sayılmasın)."""
    fa, fb = features(a), features(b, b_text)
    ca = {x for x in fa["tanchors"] if x not in fb["anchors"] | fb["words"]}
    cb = {x for x in fb["tanchors"] if x not in fa["anchors"] | fa["words"]}
    return bool(ca and cb)


def new_info(title: str, known_text: str = "", video: str = "") -> set:
    """Başlığın bilinen haberde (metin + o videonun hafıza kayıtları) geçmeyen içerik kökleri: viral_watch devam haberinde yeni
    bilgi var mı ("… 12 bina hasar gördü" → {bina, gördü}); boşsa aynı haberin tekrarıdır (manşette duran ilk haber)."""
    known = cstems(known_text)
    if video:
        for e, ef in load():
            if e.get("video") == video:
                known |= ef["words"]
    return {w for w in cstems(title) - proper(title) if not _present(w, known)}


def _shared_num(c: dict, e: dict) -> bool:
    quake = c["quake"] and e["quake"]
    return any(_approx(k, x, y, quake) for k in ("score", "dec", "pct", "int") for x in c["nums"][k] for y in e["nums"][k])


def _present(w: str, words: set) -> bool:
    """Kök karşı haberde var mı (4 harf yeter: "kapalı" ↔ "kapatıldı" aynı sözcük ailesi)."""
    return w in words or any(x[:4] == w[:4] for x in words)


def subject(title: str, skip: set) -> str:
    """Başlığın konusu: özel ad olmayan ilk içerik kökü (Türkçe başlık çoğunlukla konuyla başlar)."""
    t = _no_suffix(low(_expand(title)))
    for rx, rep in SYNONYM:
        t = rx.sub(rep, t)
    for w in re.findall(r"[^\W\d_]+", t):
        st = w[:5]
        if len(w) > 3 and w not in STOP and st not in CSTOP and w[:4] not in CSTOP and st not in skip:
            return st
    return ""


def subject_conflict(c: dict, e: dict, t: str) -> bool:
    """Başlıkların konusu farklı: iki başlığın konusu da karşı haberde hiç geçmiyor ("Konut satışları eylülde yüzde 12 arttı" ↔
    "Otomobil satışları eylülde yüzde 12 arttı"). Yalnız başlık kuralında (b): eski same_event genel sözcüklerle (eylül, yüzde,
    arttı) ≥4 ortak kök bulup farklı haberleri birleştiriyordu."""
    skip = c["tanchors"] | e["tanchors"]
    sc, se = subject(c["title"], skip), subject(t, skip)
    return bool(sc and se and not _present(sc, e["words"]) and not _present(se, c["words"]))


def _same(x: set, y: set) -> bool:
    """breaking_watch.same_event, kökleri önceden hesaplanmış başlıklar için (aynı kural)."""
    if not x or not y:
        return False
    n = len(x & y)
    return n >= 4 or (n >= 2 and n / len(x | y) >= 0.34)


def rule_title(c: dict, e: dict):
    """(b) eski kural: başlık başlıkla (same_event), çelişki ve konu farkı yoksa."""
    cs = c["bst"][0][1] if c["bst"] else set()
    for t, ts in e["bst"]:
        if _same(cs, ts):
            return None if conflict(c, e) or subject_conflict(c, e, t) else f"başlık benzer: {t[:60]}"
    return None


def content_score(c: dict, e: dict) -> dict:
    """(c) ölçüleri (test derlemi ve kayıt için de). Başlık kapsaması özel adlar dışındaki başlık kökleriyle ölçülür: aynı kişinin
    (Özgür Özel) iki ayrı açıklaması adlar yüzünden "kapsanmış" sayılmasın."""
    common = c["words"] & e["words"]
    anchors = c["anchors"] | e["anchors"]
    shared = c["anchors"] & e["anchors"]
    tc = c["twords"] - anchors
    cover_c = len(tc & e["words"]) / len(tc) if tc else 0.0
    cover_e = max([len((t - anchors) & c["words"]) / len(t - anchors) for t in e["tstems"] if t - anchors] or [0.0])
    return {"common": len(common), "plain": len(common - anchors), "overlap": len(common) / max(1, min(len(c["words"]), len(e["words"]))),
            "cover": max(cover_c, cover_e), "anchor": bool(shared), "anchors": len(shared), "num": _shared_num(c, e)}


def rule_content(c: dict, e: dict, n_common=None, t_overlap=None, t_cover=None):
    """(c) iki yol: (1) ortak özel ad ya da sayı + başlık kapsaması + ≥N özel ad dışı ortak kök; (2) maç/deprem gibi neredeyse
    yalnız adlardan oluşan haber: ≥3 ortak özel ad VE ortak dikkat çekici sayı (skor, büyüklük). İkisinde de örtüşme ≥ T."""
    s = content_score(c, e)
    if s["overlap"] < (t_overlap or T_OVERLAP) or not (s["anchor"] or s["num"]):
        return None
    words = s["plain"] >= (n_common or N_COMMON) and s["cover"] >= (t_cover or T_COVER)
    names = s["anchors"] >= 3 and s["num"]
    if not (words or names) or conflict(c, e):
        return None
    how = f"{s['common']} ortak kök" if words else f"{s['anchors']} ortak ad + aynı sayı"
    return f"içerik benzer ({how}, %{round(100 * s['overlap'])})"


def match_feats(c: dict, e: dict, mode: str = "full"):
    """Tek kayıtla eşleşme nedeni (a → b → c) ya da None."""
    if mode != "title" and c["urls"] and set(c["urls"]) & set(e["urls"]):
        return "aynı haber adresi"
    r = rule_title(c, e)
    if r or mode == "title":
        return r
    return rule_content(c, e)


# --------------------------------------------------------------------------- dosya

def cfg() -> dict:
    c = {"enabled": True, "hours": 48, **(settings().get("dedup") or {})}
    try:
        c["hours"] = int(min(168, max(6, round(float(c.get("hours") or 48)))))
    except (TypeError, ValueError):
        c["hours"] = 48
    c["enabled"] = c.get("enabled") not in (False, 0, "false", "0")
    return c


_CACHE = {"mtime": None, "rows": []}


def load() -> list:
    """Kayıtlar (öznitelikleriyle); dosya değişmediyse süreç içinde yeniden okunmaz."""
    try:
        mt = FILE.stat().st_mtime_ns
    except OSError:
        return []
    if _CACHE["mtime"] != mt:
        raw = load_json(FILE, [])
        rows = []
        for e in raw if isinstance(raw, list) else []:
            if isinstance(e, dict) and (e.get("title") or e.get("urls")):
                try:
                    rows.append((e, _entry_feats(e)))
                except Exception:
                    continue
        _CACHE.update(mtime=mt, rows=rows)
    return _CACHE["rows"]


def _at(e: dict) -> float:
    """Kaydın zamanı; bozuk değer (elle düzenlenmiş dosya: "abc", liste) 0 sayılır: pencere dışı, sonraki yazmada silinir."""
    try:
        return float(e.get("at") or 0)
    except (TypeError, ValueError):
        return 0.0


def write(entries: list, drop=None) -> None:
    """Kayıt ekler; saklama süresini geçenler ve drop(kayıt) doğru olanlar silinir."""
    keep = max(KEEP_MIN_H, cfg()["hours"]) * 3600
    raw = load_json(FILE, [])
    rows = [e for e in (raw if isinstance(raw, list) else []) if isinstance(e, dict) and time.time() - _at(e) < keep and not (drop and drop(e))]
    rows += entries
    save_json(FILE, rows[-MAX_ENTRIES:])


def mark(title: str, url: str = "", text: str = "") -> None:
    """Panel bir haberi üretime aldı (video henüz yok; sıradayken aynı haber ikinci kez yakalanmasın). Kaynağın metni de
    verilirse başka sözlerle yazılmış aynı haber içerikle tanınır (yalnız başlıkla değil). MARK_H saat sayılır; üretim
    assemble'a ulaşınca record_episode işareti siler (yerine zengin kayıt)."""
    f = features(title, (text or "")[:1400], url, full=True)
    write([to_entry(f, at=time.time(), video=None, kind="mark")])


def drop_video(video: str, since: float = 0.0) -> int:
    """Üretim video çıkmadan bitti (hata, ⏸/⏹ durdurma; pipeline.sh cleanup): bu çalıştırmanın assemble'da yazdığı kayıtlar
    silinir, video yokken haber 48 saat engellenmesin. since: çalıştırmanın başlangıcı (aynı adlı eski kayıtlara dokunulmaz)."""
    raw = load_json(FILE, [])
    if not video or not isinstance(raw, list):
        return 0
    rows = [e for e in raw if not (isinstance(e, dict) and e.get("video") == video and e.get("kind") != "mark" and _at(e) >= since)]
    if len(rows) != len(raw):
        save_json(FILE, rows)
    return len(raw) - len(rows)


def ago(at: float) -> str:
    try:
        m = max(1, int((time.time() - float(at or 0)) / 60))
    except (TypeError, ValueError):
        m = 1
    return f"{m} dk" if m < 60 else f"{m // 60} saat" + (f" {m % 60} dk" if m < 600 and m % 60 >= 5 else "")


def match(title: str, text: str = "", url: str = "", hours=None, mode: str = "full", exclude=None, no_mark: bool = False):
    """En yeni eşleşen kayıt {video, title, kind, reason, at, ago} ya da None. Açık (open) kayıtlar engellemez, işaretler
    (kind "mark") MARK_H saatten sonra sayılmaz. mode "title": yalnız başlık kuralı (b); exclude: bu videonun kendi kayıtları
    sayılmaz (viral_watch devam haberi: eskiden yalnız anlık videolar ve panelin işaretleri kayıtlıydı, viral videonun kendi
    haber başlıkları devam haberini engellemezdi); no_mark: işaretler hiç sayılmaz (panel sıradaki işi kuyruktan çıkarırken:
    kendi işareti ve sıradaki diğer işlerin işaretleri). Ayar kapalıyken eski davranış: 12 saat, yalnız başlık, düzenli 5 saatlik
    videoların kayıtları yok (eskiden hafızada yalnız anlık/şablon/sosyal medya videoları ve panelin işaretleri vardı)."""
    if not (title or url):
        return None
    c = cfg()
    if not c["enabled"]:
        hours, mode = OLD_H, "title"
    win = float(hours or c["hours"]) * 3600
    now = time.time()
    feats = features(title, text, url)
    for e, ef in reversed(load()):
        at = _at(e)
        mk = e.get("kind") == "mark"
        if now - at >= win or e.get("open") or (exclude and e.get("video") == exclude) or (mk and (no_mark or now - at >= MARK_H * 3600)) \
                or (not c["enabled"] and e.get("kind") == "regular"):
            continue
        why = match_feats(feats, ef, mode)
        if why:
            return {"video": e.get("video"), "title": e.get("title", ""), "kind": e.get("kind") or "anlik", "reason": why, "at": at, "ago": ago(at)}
    return None


def already(title: str, text: str = "", url: str = "", hours=None, mode: str = "full", exclude=None, no_mark: bool = False) -> bool:
    return match(title, text, url, hours, mode, exclude, no_mark) is not None


# --------------------------------------------------------------------------- assemble_script: videonun hikâyeleri

def _strong(seg_text: str, item_title: str) -> bool:
    """attach_images'in eşlediği RSS haberi gerçekten bu haber mi (eşleşme eşiği düşük; yanlış kaynak hafızaya girmesin)."""
    from breaking_watch import same_event
    it = cstems(item_title)
    return bool(it) and (same_event(seg_text.split(". ")[0], item_title) or (len(it & cstems(seg_text)) >= 2 and len(it & cstems(seg_text)) / len(it) >= 0.5))


def episode_entries(meta: dict, segs: list, video: str, env=None, work: Path = None) -> list:
    """Videodaki hikâyeler (assemble_script çağırır). meta: çıktı JSON'u (titles, format, infoKind…)."""
    env = os.environ if env is None else env
    work = work or (ROOT / "work")
    info = (env.get("INFO_KIND") or "").strip()
    if info in NO_MEMORY or env.get("GUNLUK") == "1":
        return []
    anlik = env.get("ANLIK") == "1"
    kind = ("trailer" if env.get("TRAILER") == "1" else "video") if info == "video" else "template" if info else \
        ("multi" if env.get("ANLIK_MULTI") else "anlik") if anlik else "regular"
    now = time.time()
    base = {"at": now, "video": video, "kind": kind, **({"info": info} if info else {}),
            **({"remake": env.get("REMAKE_OF")} if env.get("REMAKE_OF") else {})}
    story = [s for s in segs if s.get("kind") in ("hook", "haber", "sesli")]
    news = {}
    try:
        for it in load_json(work / "news.json", {}).get("items", []) or []:
            if it.get("link"):
                news[it["link"]] = it
    except Exception:
        news = {}

    def seg_text(ss):
        return ". ".join(f"{s.get('title', '')}. {s.get('narration', '')}" for s in ss)

    def rss(ss):  # attach_images'in güvenilir eşleşmeleri: kaynak başlığı, özeti ve adresi
        src, urls, body = [], [], []
        for s in ss:
            it = news.get(s.get("articleUrl") or "")
            if it and _strong(f"{s.get('title', '')}. {s.get('narration', '')}", it.get("title", "")):
                src.append(it.get("title", ""))
                urls.append(s["articleUrl"])
                body.append((it.get("summary") or "")[:300])
        return src, urls, body
    out = []
    if kind == "multi":
        items = load_json(work / "anlik_items.json", []) or []
        for i, m in enumerate(items, 1):
            ss = [s for s in story if s.get("item") == i]
            title = next((s.get("title") for s in ss if s.get("kind") == "haber" and s.get("title")), "") or m.get("title", "")
            f = features(title, seg_text(ss) + "\n" + str(m.get("text") or "")[:TEXT_CHARS], [m.get("url") or ""], src=[m.get("title") or ""], full=True)
            out.append(to_entry(f, **base))
        return out
    if kind == "regular":
        groups = [[s] for s in story if s.get("kind") == "haber"]
        for h in (s for s in story if s.get("kind") == "hook"):  # kanca, anlattığı habere katılır
            hs = cstems(seg_text([h]))
            if groups:
                max(groups, key=lambda g: len(hs & cstems(seg_text(g))))[0:0] = [h]
        for g in groups:
            src, urls, body = rss(g)
            title = next((s.get("title") for s in g if s.get("kind") == "haber"), "")
            f = features(title, seg_text(g) + "\n" + "\n".join(body), urls, src=src, full=True)
            out.append(to_entry(f, **base))
        return out
    # tek hikâye: anlık, şablon (deprem/maç/meteoroloji), sosyal medya/WhatsApp videosu, fragman
    topic_p = work / "anlik_topic.txt"
    topic = topic_p.read_text(encoding="utf-8") if topic_p.exists() else ""
    src_title = (env.get("ANLIK_TITLE") or "").strip() or re.split(r"(?<=[.!?])\s|\n", topic.strip())[0][:200]
    src = [src_title]
    urls = [env.get("ANLIK_URL") or ""]
    urls += [p.get("url") or "" for p in (load_json(work / "anlik_pages.json", []) or []) if isinstance(p, dict)]
    extra = ""
    open_ = False
    tdir = env.get("TEMPLATE_DIR") or ""
    if tdir:
        jm = load_json(ROOT / tdir / "meta.json", {}) or {}
        so = jm.get("social") or {}
        src += [str(so.get("title") or "")[:200], re.split(r"\n", str(so.get("caption") or "").strip())[0][:200]]
        urls.append(str(so.get("url") or ""))
        open_ = float(((jm.get("event") or {}).get("mag")) or 0) >= 6  # büyük depremde gelişmeler serbest (eski kural)
    if not urls[0]:  # bağlantısız anlık haber (yazılan konu): RSS eşleşmesi yalnız güçlüyse
        s2, u2, b2 = rss(story)
        src += s2
        urls += u2
        extra = "\n".join(b2)
    titles = meta.get("titles") or {}
    title = titles.get("A") or next((s.get("title") for s in story if s.get("kind") == "haber"), "") or src_title
    f = features(title, seg_text(story) + "\n" + topic[:TEXT_CHARS] + "\n" + extra, urls, src=src, full=True)
    out.append(to_entry(f, **base, **({"open": True} if open_ else {})))
    return out


def record_episode(meta: dict, segs: list, video: str) -> int:
    """Videonun hikâyelerini yazar. Panelin bu haberi üretime alırken yazdığı işaretler (kind "mark": başlığı videonun kaynak
    başlıklarından biri ya da adresi videonun adreslerinden biri, son MARK_H saatte) silinir: yerine zengin kayıt geçer (işaret
    yalnız başlık + giriş taşır, 48 saat kalırsa gevşek eşleşir; viral devam haberinde viral videonun kendi işareti sayılmasın)."""
    rows = episode_entries(meta, segs, video)
    if rows:
        titles = {str(t)[:200] for r in rows for t in [r.get("title"), *(r.get("src") or [])] if t}
        urls = {u for r in rows for u in r.get("urls") or []}
        now = time.time()

        def covered(e):
            return e.get("kind") == "mark" and now - _at(e) < MARK_H * 3600 and (
                str(e.get("title") or "")[:200] in titles or bool(urls & set(e.get("urls") or [])))
        write(rows, drop=covered)
    return len(rows)


def group(items: list) -> dict:
    """Aynı partideki haberlerden aynı olayı başka sözlerle verenler (panel değerli haber toplayıcısı): her haber kendinden önceki,
    partide kalan bir haberle eşleşirse onun sırası (groups[i] = j), değilse kendi sırası. Önceki haber kayıt gibi (başlık +
    metin + adres) karşılaştırılır; kurallar ve vetolar `match` ile aynı."""
    feats = [features(str(x.get("title") or ""), str(x.get("text") or ""), str(x.get("url") or "")) for x in items]
    ents = [_entry_feats(to_entry(features(str(x.get("title") or ""), str(x.get("text") or "")[:1400], str(x.get("url") or ""), full=True)))
            for x in items]
    groups, reasons = [], []
    for i, f in enumerate(feats):
        g, why = i, None
        if f["title"]:
            for j in range(i):
                if groups[j] == j and feats[j]["title"]:
                    why = match_feats(f, ents[j])
                    if why:
                        g = j
                        break
        groups.append(g)
        reasons.append(why)
    return {"groups": groups, "reasons": reasons}


if __name__ == "__main__":
    try:
        if "--check" in sys.argv:
            q = json.loads(sys.argv[sys.argv.index("--check") + 1])
            res = []
            for x in q if isinstance(q, list) else [q]:
                m = match(str(x.get("title") or ""), str(x.get("text") or ""), str(x.get("url") or ""), no_mark=bool(x.get("noMark")))
                res.append({"dup": bool(m), "match": m})
            out = {"ok": True, "results": res}
        elif "--group" in sys.argv:
            q = json.loads(sys.argv[sys.argv.index("--group") + 1])
            out = {"ok": True, **group([x for x in q if isinstance(x, dict)] if isinstance(q, list) else [])}
        elif "--drop" in sys.argv:
            since = float(sys.argv[sys.argv.index("--since") + 1]) if "--since" in sys.argv else 0.0
            out = {"ok": True, "dropped": drop_video(sys.argv[sys.argv.index("--drop") + 1], since)}
        elif "--list" in sys.argv:
            out = {"ok": True, "cfg": cfg(), "entries": [{k: e.get(k) for k in ("at", "video", "kind", "title", "src", "urls")} for e, _ in load()[-30:]]}
        else:
            out = {"ok": False, "error": "kullanım: --check JSON | --group JSON | --drop VİDEO [--since T] | --list"}
    except Exception as e:
        out = {"ok": False, "error": str(e)[:300]}
    print(json.dumps(out, ensure_ascii=False))
