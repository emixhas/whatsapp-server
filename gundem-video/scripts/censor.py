#!/usr/bin/env python3
"""Hassas kelimeleri platform denetimine takılmayacak, ama anlaşılır kalacak şekilde gizler (kullanıcı isteği).

- Seste: cümle bütün okunur, kelimenin sesteki yeri hizalamadan bulunur; orada konuşma kısılır ve üstüne "bip" biner (tts.py
  `bleep_spans`, kelimeler `token_hits()`); kelime arkadan duyulur, anlaşılır.
- Yazıda (açıklama, yayın başlığı, ekrandaki başlıklar, yanan altyazı): kelimenin bir harfi yıldızla gizlenir
  (`mask()`): intihar → int*har, silah → s*lah, ölüm → ö*üm, cinayet → c*nayet. Hassas kelime içeren hashtag atılır.

Kelime listesi `settings.censor.words` ile değiştirilir (kök ya da düzenli ifade; Türkçe ekler kendiliğinden kapsanır);
panelden eklenen düz kelimeler `settings.censor.extra`. `settings.censor` {enabled, audio, text, words, extra}.

Gereksiz bip olmasın (kullanıcı şikâyeti, 27 Ekim: "bazen gereksiz kelimelerin biplendiğini görüyorum"): eşleşme noktalı i ile noktasız ı'yı
AYIRIR (eskiden büyük-küçük harf duyarsız eşleşme ikisini aynı sayıyordu: "törene katıldı", "katılım payı" katil diye biplenirdi) ve
`EXEMPT` listesindeki deyim, kurum, yer, kişi ve eser adlarının içindeki hassas kelime gizlenmez (bir istisna eşleşmesi hassas kelimeyi
TAMAMEN kapsarsa). Liste dar tutuldu: gerçek şiddeti anlatabilecek biçimler (silah bırakıp kaçtı, bomba iddiası, saatli bomba gibi düzenek,
denizde boğuldu, kana boğuldu…) biplenmeye devam eder.

Kullanım (deneme): python3 scripts/censor.py "Genç kadın intihar etti, silahla vurulan adam öldü."
"""
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import settings  # noqa: E402

# Kökler (küçük harf, Türkçe). Yanlış eşleşmeyi önlemek için kısa köklerde ek kalıbı açık yazılır
# (ör. "öl" ölçü/ölçek'i yakalamasın, "boğ" Boğaz'ı yakalamasın).
DEFAULT_WORDS = [
    "intihar", r"öl(?:üm|ü|dü|dür|en|me|müş|ecek|ür)", "silah", "cinayet", r"katil", r"katle", r"bıçak",
    "kurşun", "tecavüz", "istismar", "taciz", "uyuşturucu", r"ces(?:et|ed)", "işkence", "vahşet",
    r"boğ(?:ul|arak|du|duğu|dular)", r"tabanca", r"pompalı", r"rehin", r"bomba", r"terör",
]

# Gizlenmeyecek kalıplar (Türkçe küçük harfe çevrilmiş metinde aranır; büyük-küçük harf duyarlı: i ile ı ayrı). Bir hassas kelime ancak
# buradaki bir eşleşmenin TAMAMEN içindeyse bip/yıldız almaz; aynı cümledeki başka hassas kelime gizlenmeye devam eder ("Havuzda boğulan
# çocuğun ailesi gözyaşlarına boğuldu" → yalnız "boğulan"). Kaynak: 27 Ekim taraması (sözlük, deyim, özel ad ve eşleştirici açıları; her
# aday ayrıca çürütülmeye çalışıldı; gerçek şiddeti de anlatabilen geniş kalıplar alınmadı).
_S = r"[\w'’]*"  # kelimenin kalanı (ekler, kesme işareti)
EXEMPT = [
    # silah: kurumlar, süreçler, adlar
    rf"silahlı\s*kuvvetler{_S}", rf"silahlı\s+hizmetler\s+komite{_S}", rf"silahtar{_S}", rf"silahçıoğlu{_S}", rf"silahş[oö]r{_S}",
    rf"silahsızlanma{_S}", r"silah(?:larını)?\s+bırak(?:ılma|ma)(?:sı|sının|sına|ya|yı)?(?=\s+(?:ve\s+fesih\s+)?(?:süre[cç]|tören|karar|adım|aşama))",
    # örgütün silah bırakması (çözüm süreci): özne örgüt/PKK olmalı ("şüpheli silah bırakıp kaçtı" biplenir)
    rf"(?:örgüt[\w'’]*|pkk[\w'’]*|terör\s+örgüt[\w'’]*)\s+(?:[\w'’]+\s+){{0,2}}?silah(?:larını)?\s+bırak(?!ma(?:d|z|m|yacak|yacağ|yan|yın|yız|yıp)|mıyor){_S}",
    rf"yapay\s+zek[aâ](?:da|daki|nın)?\s+(?:alanında(?:ki)?\s+)?silahlanma\s+yarış{_S}",
    rf"(?:nükleer\s+|kitle\s+imha\s+)?silahlar(?:ının|ın)\s+yayılmas(?:ının\s+önlenmesi|ını\s+önleme){_S}",
    rf"kimyasal\s+silah(?:ların\s+yasaklanması|lar\s+sözleşmesi){_S}", r"silahlara\s+veda",
    r"cehennem\s+silahı(?=\s+(?:\d+\s+)?(?:film|seri|dizi|fragman))",
    # boğ-: "X-e boğuldu/boğdu" mecazi (gözyaşı, alkış, gol, borç, sis…); kana, sele, suya, dumana DEĞİL
    r"(?:göz\s?yaş(?:ı|lar[ıi])?na|kahkaha(?:ya|lar[ae])|alkış(?:a|lar[ae])|övgü(?:ye|ler[ae])|tebrik(?:e|ler[ae])|coşkuya|çiçe(?:ğe|kler[ae])|"
    r"hediye(?:ye|ler[ae])|ilgiye|mesaj(?:a|lar[ae])|karanlığa|sise|toza|çöpe|bor(?:ca|cuna|çlara|çlarına)|vergi(?:ye|ler[ae])|bürokrasiye|"
    r"ıslık(?:a|lar[ae])|yuha(?:ya|lar[ae])|tezahürat(?:a|lar[ae])|fark(?:a|lar[ae])|gol(?:e|ler[ae])|pozisyon(?:a|lar[ae])|öpücük(?:e|ler[ae])|"
    r"iltifat(?:a|lar[ae])|soru(?:ya|lar[ae])|yas[ae]|hüzne|kedere|matem[ae]|sevince|neşeye|bayraklar(?:ın)?a|kırmızı[\s-]?beyaza)"
    rf"\s+(?:adeta\s+|resmen\s+)?boğ{_S}",
    # bomba: mecazi, yiyecek, hava, spor, yer ve şirket adları ("bomba iddiası", "bomba transferi" DEĞİL: gerçek bomba da olabilir)
    rf"(?:soru|mesaj|reklam|telefon|bildirim|e-posta|eleştiri|yorum|spam|tweet|paylaşım|şut|sms)(?:lar(?:la)?)?\s+bombardıman{_S}",
    rf"(?:vitamin(?:i)?|kalori|lezzet|protein|şeker|enerji|antioksidan|lif|besin|mineral|omega(?:-?3)?)\s+bomba(?:sı|ları){_S}",
    rf"(?:çikolatalı|kremalı|fıstıklı|lotuslu|nutellalı|frambuazlı)\s+bomba{_S}", rf"bomba\s+tatlı{_S}", rf"(?:su|yağmur)\s+bomba(?:sı|ları){_S}",
    rf"saatli\s+bomba(?:\s+gibi\s+(?:bekl|dur|tıkırd|tıkla)|ya\s+dönüş(?!t[üu]r)){_S}", r"saatli\s+bombalar\s+gibi(?![\w'’])", rf"bombaj{_S}",
    # magazin/siyaset argosu "bomba itiraf/açıklama/karar" yalnız eksiz ("bomba açıklaması", "bomba kararı", "bomba iddia edilen paket" değil)
    r"bomba\s+(?:itiraf|ayrılık|aşk|açıklama|gelişme|isim|ismi|karar)(?:lar|ler)?(?![\w'’])", r"bomba\s+iddia(?:lar(?:da)?)?(?![\w'’])(?!\s+e[dt])",
    rf"(?:zam|indirim)\s+bomba{_S}", r"bomba\s+(?:zam(?!an)|indirim|kampanya)" + _S,
    r"bomba\s*transfer(?:ler)?(?![\w'’])", r"transfer(?:de|in)?\s+bomba(?:sı(?:nı|na|nın)?|yı|nın)?(?![\w'’])",
    rf"transferde\s+(?:[\w'’]+\s+){{0,2}}?bomba{_S}\s+(?:[\w'’]+\s+){{0,2}}?patlat{_S}",
    rf"(?<!üzerine )(?<!üstüne )bomba\s+(?:gibi\s+(?:düş|dön|başla)|etkisi\s+(?:yarat|yap)){_S}",
    r"bombay(?:['’][\w'’]*)?(?![\w'’])", rf"bombardier{_S}", rf"bombastik{_S}", rf"bombacı\s+mülayim{_S}",
    # öl-: abartı, deyim, istatistik, anma, yer ve eser adları
    rf"(?:gülmekten|meraktan|şarjı)\s+(?:adeta\s+|resmen\s+)?öl{_S}", rf"ölümsüz{_S}", rf"ölümüne\s+(?:bir\s+)?(?:mücadele|oyna|oyun|[aâ]şık){_S}",
    rf"ölüm[\s\-–]*kalım\s+(?:maç|mesele){_S}", rf"ölü\s+(?:sezon|mevsim|dönem|toprağ|nokta|yatırım|piksel){_S}", rf"ölü\s+kedi\s+sıçrama{_S}",
    rf"öldürücü\s+(?:pas|asist|gol|kontra|forvet|şut){_S}",
    rf"ölmeden\s+önce\s+(?:mutlaka\s+|kesinlikle\s+)?(?:gör|gez|git|gid|yap|oku|izle|dinle|tad|tat|dene|ye|keşfet|yaşa){_S}\s+gereken",
    rf"ölüm\s*grub{_S}", r"ölüm\s+(?:risk(?:i|in|ini|inde|leri)|oran(?:ı|ın|ını|ında|ları)|hızı(?:nı|nda)?)(?![\w'’])", rf"atatürk(?:['’](?:ün|ü))?\s+ölüm{_S}",
    # anma: "ölüm yıl dönümü", "ölümünün 13. yılında", "Atatürk'ün 88. ölüm yıl dönümü", "Ulu Önder'in ölüm yıl dönümü"
    r"ölüm(?:ünün|ün|ü)?\s+(?:(?:\d+\s*(?:[.'’]\s*(?:[ıiuü]?nc[ıiuü])?)?|(?:[a-zçğıöşü]+\s+)?[a-zçğıöşü]+(?:ıncı|inci|uncu|üncü)|ilk)\s+)?"
    r"yıl(?:\s?dönüm[\w'’]*|ı(?:nda|nı)?(?![\w'’]))",
    r"(?:atatürk(?:['’]?(?:ün|ü))?|ata['’](?:nın|mızın|mızı|yı)|ulu\s+önder(?:['’]?(?:in|i))?),?\s+(?:(?:\d+(?:\s*\.|['’]?[iıuü]?nc[iıuü])|"
    r"(?:[a-zçğıöşü]+\s+)?[a-zçğıöşü]+nc[iıuü])\s*)?ölüm(?:ünün|ü)?(?=\s+(?:(?:\d+(?:\s*\.|['’]?[iıuü]?nc[iıuü])|(?:[a-zçğıöşü]+\s+)?[a-zçğıöşü]+nc[iıuü])\s*)?yıl|\s+üzerinden)",
    rf"ölüdeniz{_S}", rf"ölü\s+deniz['’](?!e\s+dön){_S}", r"ölü\s+deniz(?=\s+(?:kıyı|sahil|çamur|tuz|suyu|bölge|havza))", r"ölüm\s+vadisi(?:['’](?!ne\s+(?:dön|çevir))[\w'’]*|(?=\s+(?:milli|ulusal)\s+park))",
    rf"ölüler\s+günü{_S}", rf"ölümlü\s*dünya{_S}", r"ölürüm\s+sana(?:['’][\w'’]*)?(?![\w'’])", r"görevimiz\s+tehlike\s*[:\-–—,]?\s*ölümcül\s+hesaplaşma",
    r"ölü\s+ozanlar\s+derneği", r"ölene\s+kadar(?=\s+dizisi)", r"ölü\s+canlar(?![\w'’])", r"ölmeye\s+yatmak(?=['’]|\s+roman)",
    r"ölmez(?:oğlu[\w'’]*|['’][\w'’]+|\s+çiçe[kğ][\w'’]*)?(?![\w'’])", rf"(?:kurşunoğlu|kurşuncu){_S}",
    r"(?:bombat|ölüce|işkencedere|öldümler|kurşunkaya|kurşunçavuş)(?:['’][\w'’]*)?(?![\w'’])", r"(?:pompalı|kurşunluk)(?:['’][\w'’]*|(?=\s+(?:mahalle|köy)))",
    # bıçak: deyim (ameliyat, sınır), sofra takımı, soyadı, film adı
    rf"bıçak\s+kemiğe\s+day{_S}", rf"bıçak\s+altına\s+(?:yat|gir|alın){_S}", rf"çatal[\s-]+bıçak\s+(?:takım|set){_S}",
    rf"bıçak\s+gibi\s+(?:kesil{_S}|kesen\s+(?:soğuk|ayaz|rüzg[aâ]r|poyraz){_S})", r"bıçak\s+sırtı(?:nda(?:ki)?)?(?![\w'’])", rf"bıçak[çc]ı{_S}",
    r"bıçaklar\s+çekildi(?:['’][\w'’]*|(?=\s+(?:film|fragman|seri|gizem)))",
    # işkence: gündelik sıkıntı, kurum adı
    r"(?:trafi(?:k|ği)|metrobüs(?:ü)?|metro(?:su)?|otobüs(?:ü)?|marmaray|yol(?:u)?|yolculu(?:k|ğu)|kuyru(?:k|ğu)|sıca(?:k|ğı)|sıcaklık|nem|sivrisinek|"
    rf"gürültü(?:sü)?|çamur|toz|kar|buzlanma|bekleyiş(?:i)?)\s+işkence{_S}", rf"işkencenin\s+önlenmesi{_S}",
    # kurşun: kalem, metal, renk, benzin, yer adı
    rf"kurşun\s*kalem{_S}", rf"kurşunsuz{_S}", r"kurşun(?:[iî](?:ye|ler|den|de)?(?![\w'’])|\s+(?:rengi|grisi)" + _S + ")",
    r"kurşun(?:\s+(?:zehirlen|içer(?:en|d|ir|me|iyor|iğ|ik)|oran|miktar|seviye|düzey|maden|boru|fiyat|ve\s+(?:kadmiyum|cıva|civa|arsenik|çinko|nikel))|"
    rf"[\s-]+çinko){_S}", rf"(?:oranda|miktarda|düzeyde|seviyede)\s+kurşun{_S}", rf"kurşunlu\s+(?:benzin|boya){_S}",
    r"kurşunlu(?:['’][\w'’]+|\s+(?:şelale|ilçe|belediye|kaymakam|köy|plaj|cami|kaplıca)" + _S + r"|\s+han(?:ı[\w'’]*|['’][\w'’]+)?(?![\w'’]))",
    # katle-, istismar, rehin, intihar, tecavüz, tabanca, cinayet, katil, terör, taciz, pompalı: mecazi ve teknik kullanımlar, adlar
    r"(?:şarkı(?:yı|ları)|parça(?:yı|ları)|türkü(?:yü|leri)|marş(?:ı|ımızı)(?:['’]?nı)?|nota(?:yı|ları)|türkçe(?:yi|mizi)|ingilizce(?:yi)?|almanca(?:yı)?|"
    rf"dil(?:i|ini|imizi))\s+(?:adeta\s+|resmen\s+)?katle[dt]{_S}",
    r"(?:din(?:[iî]|in)?|dini\s+duyguları(?:n[ıi])?|duygu(?:ları|larını|larımızı|ların)?|iyi\s+niyet(?:i|ini|imizi)?|inanç(?:ları|larını)?|inancın|siyasi|"
    rf"açı[kğ][ıi]n[ıi]|açıklar[ıi]n[ıi]|zafiyet(?:ler)?[ıi](?:n[ıi])?)\s+istismar{_S}",
    r"(?:altın(?:lar)?[ıi]n[ıi]|altın|ev(?:ini|imizi|lerini)|aracını|araçlarını|arabasını|otomobilini|tapusunu|mücevherlerini|ziynetlerini|"
    rf"bileziklerini|telefonunu)\s+rehin\s+bırak{_S}", rf"rehin(?:li|ci){_S}", rf"rehin\s+(?:hakk|sözleşme|ver){_S}",
    r"(?:siyas[iî]|siyasal|politik)\s+intihar[\w'’]*(?!\s+(?:saldır|bombac|eylem|yele|tim))", r"(?:zor\s+ölüm|intihar\s+timi)(?:\s+\d+(?:[.,]\d+)?)?"
    r"(?:['’][\w'’]+|(?=\s+(?:seri|film(?:i|in|inin|ine|ini|inde|iyle)?(?![\w'’]))))", rf"çiçek\s+ayının\s+katil{_S}",
    rf"(?:hava\s+sahas[ıi]na|kara\s*sular[ıi]na|(?:egemenlik|telif|marka|mülkiyet|patent|kişilik|tasarım)\s+hak(?:kı|ları)na)\s+tecavüz{_S}",
    rf"(?:marka|patent|telif|tasarım|mülkiyet|faydalı\s+model)\s+hak(?:k[ıi]|lar){_S}\s+tecavüz{_S}",
    rf"(?:masaj|silikon|boya|püskürtme|perçin|zımba|tutkal|sprey|köpük|lehim|ısı|sıcak\s+hava|su)\s+tabanca(?:sı|ları){_S}", rf"tabanca\s+(?:boya|cila){_S}",
    rf"(?:hukuk|ekolojik)\s+cinayet{_S}", rf"(?:sessiz\s+katil|katil\s+balina){_S}",
    r"katil\s+arı(?:lar|ları|ların|lara|larla|larda|lardan|nın|ya|yı|yla|da|dan|sı)?(?![\w'’])",
    r"terörsüz(?:lük[\w'’]*|türkiye[\w'’]*)?(?![\w'’])",
    rf"(?:aklanması(?:nın)?(?:\s+önlenmesi)?\s+ve\s+terörün\s+finansman{_S}|terörün\s+finansmanının\s+önlenmesi{_S})",
    r"tac[iı]zer(?:['’][\w'’]*)?(?![\w'’])",
    rf"pompal[ıi]yor{_S}", rf"(?:ısı\s+pompalı{_S}|pompalı\s+(?:hidroelektrik\s+)?depolama{_S})", rf"pompalı\s+(?:termos|sabunluk){_S}",
]
_EXEMPT_RX = re.compile(r"(?<![\wçğıöşü])(?:" + "|".join(f"(?:{x})" for x in EXEMPT) + ")")

_LOW = str.maketrans({"I": "ı", "İ": "i"})
VOWELS = set("aeıioöuüAEIİOÖUÜâîû")


def cfg() -> dict:
    c = {"enabled": True, "audio": True, "text": True, "words": DEFAULT_WORDS, "extra": [], **(settings().get("censor") or {})}
    # panelden eklenen kelimeler (düz kelime; düzenli ifade karakterleri kaçırılır)
    extra = [re.escape(tr_lower(str(w).strip())) for w in (c.get("extra") or []) if str(w).strip()]
    c["words"] = list(c.get("words") or DEFAULT_WORDS) + extra
    return c


def tr_lower(t: str) -> str:
    """Uzunluğu koruyan Türkçe küçük harf (İ → i, I → ı); konumlar özgün metinle aynı kalır."""
    return "".join(ch.translate(_LOW).lower()[:1] if ch in "Iİ" else ch.lower()[:1] or ch for ch in t)


def _rx_lower(w: str) -> str:
    """Kalıbın harflerini Türkçe küçük harfe çevirir (ters bölülü kaçışlara — \\W, \\S, \\D — dokunmaz)."""
    out, esc = [], False
    for ch in str(w):
        out.append(ch if esc else tr_lower(ch))
        esc = ch == "\\" and not esc
    return "".join(out)


def _pattern(words=None):
    words = words or cfg()["words"]
    # kelime başında başlar, ekleriyle birlikte kelime sonuna kadar uzanır. Metin tr_lower ile küçük harfe çevrildiği için eşleşme büyük-küçük
    # harf DUYARLI: Python'un duyarsız eşleşmesi i ile ı'yı aynı sayıyordu ("katıldı", "katılım" katil diye biplenirdi)
    return re.compile(r"(?<![\wçğıöşü])(?:" + "|".join(f"(?:{_rx_lower(w)})" for w in words) + r")[\wçğıöşü']*")


def spans(text: str, words=None) -> list:
    """Hassas kelimelerin (başlangıç, bitiş) konumları; `EXEMPT` eşleşmesinin tamamen içinde kalanlar hariç."""
    if not text:
        return []
    low = tr_lower(text)
    hits = [(m.start(), m.end()) for m in _pattern(words).finditer(low)]
    if not hits:
        return []
    ex = [(m.start(), m.end()) for m in _EXEMPT_RX.finditer(low)]
    return [(a, b) for a, b in hits if not any(x <= a and b <= y for x, y in ex)]


def mask_word(w: str) -> str:
    """Bir harfi yıldızla gizler, kelime okunur kalır: kısa kelimede 2. harf, uzunda 2. harften sonraki ilk ünlü."""
    core = w.split("'")[0]
    rest = w[len(core):]
    if len(core) <= 2:
        return core[0] + "*" + rest if core else w
    idx = 1
    if len(core) > 4:
        idx = next((i for i in range(1, len(core) - 1) if core[i] in VOWELS), 1)
    return core[:idx] + "*" + core[idx + 1:] + rest


def mask(text: str, words=None) -> str:
    if not text or not cfg().get("enabled") or not cfg().get("text"):
        return text
    out, last = [], 0
    for a, b in spans(text, words):
        out.append(text[last:a] + mask_word(text[a:b]))
        last = b
    return "".join(out) + text[last:]


def has(text: str) -> bool:
    return bool(text) and bool(spans(text))


def audio_on() -> bool:
    """Seste bip açık mı (settings.censor.enabled ve audio)."""
    c = cfg()
    return bool(c.get("enabled")) and bool(c.get("audio"))


def token_hits(text: str, words=None) -> list:
    """Hassas kelime içeren kelimelerin sırası; kelimeler `text.split()` ile aynı bölünür (seslendirme ve altyazı bu sırayı kullanır).
    tts.py segmenti bütün seslendirir ve bu kelimelerin sesteki yerine bip bindirir (kelime arkadan kısık duyulur — kullanıcı isteği:
    "hem duyulsun hem biplensin")."""
    sp = spans(text, words)
    if not sp:
        return []
    return [k for k, m in enumerate(re.finditer(r"\S+", text)) if any(a < m.end() and b > m.start() for a, b in sp)]


def clean_tags(tags: list) -> list:
    """Hassas kelime içeren hashtag'ler atılır (#int*har geçerli etiket olmaz)."""
    if not cfg().get("enabled") or not cfg().get("text"):
        return tags
    return [t for t in tags if not has(str(t).lstrip("#"))]


if __name__ == "__main__":
    t = " ".join(sys.argv[1:]) or "Genç kadın intihar etti; silahla vurulan adam öldü, cesedi bulundu. Ölçü ve Boğaz etkilenmedi."
    print(mask(t))
    print([t.split()[k] for k in token_hits(t)])
