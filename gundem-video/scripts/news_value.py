#!/usr/bin/env python3
"""Haber değeri: YouTube'un günlük yükleme sınırı yüzünden anlık/Mynet videolarından yalnız "değerli" olanlar
YouTube'a gider (otomatik 5 saatlik üretimler her zaman gider). Değerli = halkı doğrudan ilgilendiren haber:
can kaybı, kaza/afet, emekli/memur maaşı ve asgari ücret, zam/fiyat/vergi, tatil/bayram/izin,
sınav/yasak duyurusu, terör/saldırı, sosyal yardım/burs/kredi/piyasa rekoru, salgın/gıda ve ilaç güvenliği,
milli takım ve milli sporcu başarısı.

Karar iki kaynaktan: anahtar kelime grupları (aşağıda, settings.youtubePolicy.extraKeywords ile genişletilir)
ve senaryoyu yazan modelin verdiği "importance" (1-5): 4-5 her zaman değerli, 1-2 anahtar kelimeyi geçersiz kılar.

  python3 scripts/news_value.py "Asgari ücrete yüzde 30 zam"     # {"valuable": true, "score": 3, "strong": true, ...}

Çok değerli (strong): değerlilerin içinde ülkenin tamamını ilgilendiren ya da büyük olay olanlar (aşağıda NATIONAL/STRONG);
sondakika.com yalnız bunları üretir (settings.sondakika.strictValuable). YouTube kuralı ve diğer kaynaklar "valuable" ile sürer.
"""
import json
import re
import sys


def tr_lower(t: str) -> str:
    return t.replace("I", "ı").replace("İ", "i").lower()


# (grup adı, ağırlık, desenler) — desenler küçük harfli metinde kelime başından aranır
GROUPS = [
    ("can kaybı", 3, [r"öldü", r"ölü\b", r"ölüm", r"hayatını kaybet", r"yaşamını yitir", r"can kaybı", r"cansız",
                      r"şehit", r"vefat", r"cinayet", r"öldürül", r"cenaze"]),
    ("kaza/afet", 3, [r"kaza(?:sı|da|ya|nın|lar\w*)?\b", r"deprem", r"sel(?:de|deki|den|e|i)?\b", r"yangın", r"patlama",
                      r"çöktü", r"çökme", r"heyelan", r"çığ\b", r"fırtına", r"hortum", r"yaralı", r"enkaz", r"göçük", r"mahsur kal", r"maden\w*[^.!?]{0,30}(?:kaza|patlama|mahsur|göçük)",
                      r"pistten çık", r"acil iniş", r"raydan çık", r"(?:gemi|tekne|feribot)\w*[^.!?]{0,20}(?:battı|alabora|karaya otur)"]),
    ("emekli/memur maaşı", 3, [r"emekli", r"memur", r"maaş", r"kök maaş", r"refah payı", r"toplu sözleşme",
                               r"enflasyon fark", r"bayram ikramiye", r"ikramiye", r"promosyon", r"bağ-?kur", r"sgk",
                               r"dul ve yetim", r"asgari ücret", r"asgari geçim"]),
    ("zam/fiyat/vergi", 3, [r"zam(?:m[ıi]|l[ıi]|landı|lar\w*| oran\w*)?\b", r"faiz", r"enflasyon", r"akaryakıt",
                            r"benzin", r"motorin", r"doğal ?gaz", r"elektri[kğ]", r"vergi", r"ötv", r"kdv", r"harç",
                            r"kira artış", r"köprü ve otoyol", r"tüik"]),
    ("tatil/izin", 3, [r"tatil", r"bayram", r"arife", r"idari izin", r"resmi tatil", r"köprü günü", r"uzun hafta sonu",
                       r"okullar", r"karne", r"ara tatil", r"yarıyıl"]),
    ("kamu duyurusu", 3, [r"sınav", r"kpss", r"yks\b", r"lgs\b", r"yasak", r"kısıtlama", r"bedelli", r"askerlik",
                          r"af\b", r"genelge", r"resmi gazete"]),
    ("güvenlik", 3, [r"terör", r"saldırı", r"bomba", r"silahlı", r"rehine"]),
    # suç ve vahşet (kullanıcı kararı: "kan donduran cani" türü haberler hemen üretilir). "boğaz", "şiddetli yağış",
    # "katılım" gibi yanlış eşleşmeler olmasın diye ekler açık yazıldı
    ("suç ve vahşet", 3, [r"cani\b", r"canice", r"katil\b", r"katili\b", r"katilin", r"katiller", r"vahşet", r"dehşet", r"kan donduran",
                          r"boğ(?:du|muş|arak|ularak|ulmuş)\b", r"boğazını sık", r"kaynar su", r"bıçak(?:la|ladı|landı|lı|layarak)",
                          r"darp", r"dövdü", r"dövülerek", r"işkence", r"kadına şiddet", r"çocuğa şiddet", r"şiddet uygula",
                          r"istismar", r"kaçırıldı", r"kaçırılan", r"kurşunla", r"silahla vur", r"pompalı", r"av tüfeğiyle",
                          r"tutuklandı.{0,40}(?:öldür|cinayet)", r"gözaltı.{0,40}(?:öldür|cinayet)", r"cinayet"]),
    # kullanıcı kararı: halkı ilgilendiren hiçbir haber kaçmasın — aşağıdaki gruplar da tek başına değerli
    ("kayıp ve arama", 3, [r"kayıp (?:\d+ )?(?:çocuk|kız|kadın|genç|öğrenci|adam|dağcı|balıkçı|pilot|kişi|işçi|madenci)", r"kayıp olarak aran",
                           r"kayıptan haber", r"kayıplara karıştı", r"izine rastlan", r"arama kurtarma", r"arama çalışma",
                           r"cesedi bulun", r"cansız bedeni"]),
    ("kesinti ve ulaşım", 3, [r"elektrik kesinti", r"su kesinti", r"doğal ?gaz kesinti", r"kesinti yapılacak", r"elektrikler kesil",
                              r"sular kesil", r"(?:yol|köprü|tünel|otoyol)\w* (?:trafiğe )?kapat", r"trafiğe kapandı", r"ulaşıma kapandı",
                              r"uçuş\w* iptal", r"sefer\w* iptal", r"seferler durdu", r"havalimanı kapan", r"grev", r"metro seferleri",
                              r"marmaray", r"feribot seferleri", r"köprü geçiş", r"otoyol ücret", r"toplu taşıma"]),
    ("hava ve doğa uyarısı", 3, [r"turuncu kod", r"kırmızı kod", r"sarı kod", r"meteoroloji\w* uyar", r"afad\w* uyar",
                                 r"kar yağışı", r"sağanak", r"kuvvetli yağış", r"şiddetli (?:yağış|yağmur|rüzgar|fırtına|kar)",
                                 r"yağış uyarı", r"fırtına uyarı", r"(?:hava|meteorolojik) uyarı", r"dolu yağ", r"sıcak hava dalga", r"aşırı sıcak",
                                 r"orman yangın", r"kuraklık", r"baraj doluluk", r"toz taşınımı", r"hava kirliliği", r"tsunami",
                                 r"yanardağ", r"buzlanma", r"don olayı", r"lodos"]),
    ("yeni düzenleme", 3, [r"zorunlu (?:oldu|hale|olacak|uygulama)", r"yürürlüğe gir", r"yeni dönem başl", r"trafik ceza",
                           r"ehliyet", r"pasaport", r"kimlik kart", r"e-devlet", r"mhrs", r"yönetmelik", r"kanun teklifi",
                           r"meclis'?ten geçti", r"kabul edildi", r"yasalaştı", r"ceza(?:sı)? (?:artırıldı|geliyor|kesilecek)",
                           r"yeni düzenleme", r"başvurular? başla", r"son başvuru", r"son gün"]),
    ("büyük siyaset", 3, [r"erken seçim", r"seçim tarihi", r"referandum", r"kabine", r"bakan(?:lığa)? (?:atandı|görevden)",
                          r"görevden alındı", r"istifa etti", r"kayyum", r"dokunulmazlı", r"parti kapatma",
                          r"(?:belediye başkanı|milletvekili|bakan|vali|kaymakam)\w*[^.]{0,40}(?:gözaltı|tutuklandı|görevden)",
                          r"cumhurbaşkanı\w*[^.]{0,30}(?:müjde|açıkladı|duyurdu|imzaladı)", r"kararname"]),
    ("dünya ve savaş", 3, [r"savaş(?!çı)", r"ateşkes", r"nükleer", r"füze", r"hava saldırı", r"işgal", r"darbe", r"soykırım",
                           r"nato", r"türkiye'?ye (?:tehdit|yaptırım|saldırı)", r"sınır ötesi", r"tahliye edil", r"sığınmacı",
                           r"göçmen", r"büyükelçi"]),
    ("iş ve geçim", 3, [r"iflas", r"konkordato", r"işten çıkar", r"işçi çıkar", r"fabrika\w* kapan", r"maaşlar\w* ödenmedi",
                        r"kira(?:cı|lar| fiyat| artışı| zammı)", r"ev sahibi", r"konut fiyat", r"otomobil fiyat", r"araç fiyat",
                        r"ekmek fiyat", r"indirim (?:geldi|yapıldı)", r"(?:benzin|motorin|akaryakıt)\w* indirim", r"fiyatı düştü",
                        r"kredi (?:faiz|çekmek|kartı borç)", r"borç yapılandırma", r"vergi affı", r"prim affı", r"emeklilikte yaşa takılan|eyt"]),
    ("eğitim duyurusu", 3, [r"meb\b", r"meb'(?:in|den|e|ten)", r"milli eğitim bakan", r"öğretmen atama", r"okullar ne zaman", r"okullar açıl", r"eğitim öğretim yılı", r"ders saat",
                            r"servis ücret", r"kyk yurt", r"üniversite harç", r"tercih (?:sonuç|dönemi)", r"sınav sonuç"]),
    # kullanıcı kararı (KOSGEB, vergi affı, yeni mahkum affı): devlet desteği, hibe ve af düzenlemeleri tek başına değerli
    ("destek ve af", 3, [r"kosgeb", r"hibe", r"faizsiz kredi", r"devlet desteği", r"girişimci desteği", r"esnaf kredi",
                         r"vergi aff", r"prim aff", r"imar aff", r"trafik cezası aff", r"cezası? aff", r"aff[ıi] (?:geliyor|çıktı|yasası|müjde)",
                         r"af yasa", r"genel af", r"mahkum\w*[^.]{0,30}(?:af|tahliye|izin)", r"infaz (?:düzenleme|paketi|indirim|yasası)",
                         r"yargı paketi", r"ceza indirimi", r"tahliyeler? başla", r"denetimli serbestlik", r"borç(?:lar)? silin",
                         r"yapılandırma (?:geldi|başladı|müjde)", r"vergi borcu"]),
    # kullanıcı kararı ("6 gün sonra doğum günüydü! Kahreden olay", "15 yaşındaki Murat'ın hayatı karardı"): yürek
    # yakan insan hikâyeleri ve acı olaylar tek başına değerli; magazin korumasından muaf
    ("acı olay", 3, [r"kahreden", r"yürek yakan", r"yürekleri (?:yaktı|dağlayan)", r"acı olay", r"acı haber", r"acı son",
                     r"feci (?:kaza|ölüm|olay|son)", r"hayatı karardı", r"kurtulamadı", r"kurtarılamadı", r"hayata tutunamadı",
                     r"(?:gün|hafta|ay) sonra (?:doğum günü|düğün|nikah|mezuniyet)", r"doğum günü\w*[^.!]{0,40}(?:öldü|hayatını kaybet|kaza|ölüm)",
                     r"\d+ yaşındaki[^.!]{0,60}(?:öldü|hayatını kaybet|hayatı karardı|kurtulamadı|yaralandı|kayboldu|darp|bıçak|kaçırıl|istismar)",
                     r"gözyaşlarıyla", r"son yolculuğuna", r"toprağa verildi", r"gözyaşı(?:na| sel)", r"özür diledi ama",
                     r"(?:anne|baba|eş|çocuğ|kardeş)\w*[^.!]{0,30}(?:gözü önünde|kollarında)", r"ölümden döndü"]),
    # kullanıcı kararı ("Ünlü oyuncu yeni dizisini tanıttı tarzı haberleri de değerli sayalım"): magazin ve ünlü haberleri
    ("magazin ve ünlüler", 3, [r"ünlü (?:oyuncu|şarkıcı|sunucu|isim|çift|manken|model|yönetmen|komedyen|rapçi|sanatçı|fenomen|youtuber)",
                               r"oyuncu", r"şarkıcı", r"sanatçı", r"sunucu", r"magazin", r"yeni dizi", r"dizisi", r"dizinin", r"dizide",
                               r"filmi\b", r"vizyona gir", r"albüm", r"klip", r"konser", r"sahneye", r"evlen", r"boşan", r"nişanlan",
                               r"sevgili", r"aşk iddia", r"bebek müjde", r"hamile", r"reyting", r"sosyal medya paylaşım",
                               r"(?:instagram|tiktok)\w* paylaşım", r"kırmızı halı", r"ödül töreni", r"survivor", r"masterchef"]),
    # adli olay: tek başına yetmez (her gün çok sayıda), başka bir grupla ya da modelin 4-5 önemiyle değerli olur
    # kullanıcı kararı (14 Ekim, "Vali Gül'den İstanbul için yeni uyarı" — bu tarz haberler değerli): resmi makamdan uyarı/duyuru/
    # tedbir. Makam ve eylem aynı cümlede olmalı ("Vali ziyaret etti", "dikkat çeken" yakalanmaz).
    ("resmi uyarı", 3, [r"(?:vali|kaymakam|bakan|afad|emniyet|jandarma|sahil güvenlik|belediye|itfaiye|kızılay|diyanet|"
                        r"sağlık müdürlüğü|il sağlık|dsi|karayolları|tedaş|aski|iski|başkent ?gaz|igdaş)\w*[^.!?]{0,70}?"
                        r"(?:uyar|duyur|tedbir|önlem|talimat|çağrı|alarm|acil\b|dikkat(?! çek)|genelge|karar (?:al|ver)|"
                        r"(?:kritik|önemli|flaş|yeni) açıklama)",
                        r"(?:uyar|duyuru|tedbir|önlem|talimat|çağrı|genelge)\w*[^.!?]{0,40}?(?:vali|kaymakam|bakanlığ|afad|emniyet)"]),
    ("adli olay", 2, [r"operasyon", r"gözaltı", r"tutuklandı", r"uyuşturucu", r"çete", r"kaçakçılık", r"yolsuzluk", r"rüşvet",
                      r"skandal", r"iddianame", r"hapis cezası", r"müebbet", r"firari"]),
    # "burs" Bursa'yı, "kura" kuralı yakalamasın diye ekler açık yazıldı; piyasa haberi yalnız rekor/çöküşle değerli
    ("para ve destek", 3, [r"sosyal yardım", r"kira yardım", r"doğum yardım", r"evde bakım", r"aile destek", r"engelli maaş",
                           r"engelli aylı", r"yaşlı aylı", r"65 yaş aylı", r"işsizlik maaş", r"işsizlik ödene", r"kısa çalışma ödene",
                           r"destek ödeme", r"hesaplara yatı", r"kyk", r"öğrenim kredi", r"burs(?:u|un|lar\w*)?\b", r"toki",
                           r"sosyal konut", r"kredi kart", r"taksit sınır", r"konut kredi", r"ihtiyaç kredi", r"ilaç fiyat",
                           r"(?:dolar|euro|avro|gram altın|altın|ons)\w*[^.]{0,40}(?:rekor|zirve)", r"rekor[^.]{0,30}(?:dolar|euro|altın)",
                           r"borsa\w*[^.]{0,40}(?:çöktü|çöküş|sert düş|devre kesici|rekor)", r"devre kesici"]),
    ("sağlık ve gıda", 3, [r"salgın", r"virüs", r"vaka sayı", r"zehirlen", r"toplatma", r"toplatıl", r"piyasadan çekil",
                           r"geri çağır", r"tağşiş", r"hileli ürün", r"sağlığı tehlikeye", r"gıda uyarı", r"içme suyu",
                           r"kuş gribi", r"kızamık", r"kolera", r"şap hastalı", r"kuduz", r"aşı takvim", r"zorunlu aşı"]),
    # milli başarı: SOFT (spor) korumasından muaftır; kulüp maçı ve transfer sayılmaz
    ("milli başarı", 3, [r"(?:a milli|milli takım|milliler|ay-yıldızlı|filenin sultanları|12 dev adam|bizim çocuklar)[^.]{0,60}"
                         r"(?:kazan|galib|yendi|turladı|tur atladı|finale|yarı finale|çeyrek finale|şampiyon|madalya|tarih yazdı|bilet)",
                         r"olimpiyat\w*[^.]{0,40}(?:altın|gümüş|bronz|madalya|şampiyon)", r"(?:altın|gümüş|bronz) madalya",
                         r"dünya şampiyonu (?:ol|old)", r"avrupa şampiyonu (?:ol|old)", r"milli sporcu\w*[^.]{0,40}(?:şampiyon|madalya)"]),
]


# magazin/spor: anahtar kelime tek başına yetmez ("ünlü oyuncu tatilde"); model 4-5 derse değerli
# magazin artık değerli (kullanıcı kararı); koruma yalnız sıradan kulüp/spor haberi için kaldı
SOFT = [r"futbolcu", r"teknik direktör", r"transfer", r"süper lig", r"maç(?:ı|ta|tan)?\b"]


# Süper Lig'in ilk 5 takımı (kullanıcı kararı: maç sonucu, transfer, teknik direktör… haberleri değerli). Liste
# standings.py önbelleğinden (ESPN puan durumu, 12 saatte bir); takım adı tek başına yetmez (Beşiktaş/Başakşehir ilçe adı,
# Galatasaray Lisesi), metinde futbol bağlamı da olmalı. Karşılaştırma Türkçe karaktersiz (fold) yapılır.
SPORT_CONTEXT = [r"mac", r"gol", r"transfer", r"imza", r"teknik direktor", r"hoca", r"kadro", r"sakat", r"derbi", r"puan",
                 r"lig", r"kupa", r"yendi", r"kazandi", r"berabere", r"maglup", r"futbol", r"forvet", r"stoper", r"kaleci",
                 r"orta saha", r"sozlesme", r"bonservis", r"deplasman", r"ilk 11", r"taraftar", r"hakem", r"penalti",
                 r"skor", r"galibiyet", r"yenilgi", r"antrenman", r"kamp\b", r"kampa\b", r"kampta\b", r"tribun", r"kirmizi kart", r"sampiyon"]
NICK = {"galatasaray": [r"cimbom", r"sari-kirmizili", r"sari kirmizili"], "fenerbahce": [r"kanarya", r"sari-lacivertli", r"sari lacivertli"],
        "besiktas": [r"siyah-beyazli", r"siyah beyazli", r"kara kartal"], "trabzonspor": [r"bordo-mavili", r"bordo mavili", r"karadeniz firtinasi"]}


def top_team_hit(text: str):
    """İlk 5'teki bir takım + futbol bağlamı varsa takımın adı, yoksa None."""
    try:
        from standings import cached_top, fold
    except Exception:
        return None
    f = fold(text)
    if not any(re.search(r"(?<![a-z0-9])" + p, f) for p in SPORT_CONTEXT):
        return None
    for name in cached_top():
        key = fold(name)
        pats = [re.escape(key.split()[0] if key != "gaziantep fk" else "gaziantep")] + NICK.get(key, [])
        if any(re.search(r"(?<![a-z0-9])" + p, f) for p in pats):
            return name
    return None


# ÇOK DEĞERLİ (kullanıcı kararı, 23 Ekim: sondakika.com'dan "sadece çok değerli, kıymetli haberleri çekelim"; art arda üretilen sıradan
# değerli haberler Instagram'ın "too many actions" engeline takılıyordu). Değerli haberlerin içinde ülkenin tamamını ilgilendiren ya da
# büyük olay olanlar: 1) NATIONAL grubundan vuruş (maaş/asgari ücret, tatil/izin, kamu duyurusu, büyük siyaset, milli başarı);
# 2) STRONG kalıbı (ulusal zam/vergi/faiz, terör/bomba/şehit/patlama, afet ölçeği sözleri, kırmızı/turuncu kod, orman yangını, salgın/
# toplatma, sosyal yardım/KYK/TOKİ, af/infaz paketi, savaş/ateşkes/NATO, uçuş iptali/grev, yürürlüğe giren düzenleme…); 3) ölçek: ≥3 ölü/
# yaralı/kişi ya da ≥5,0 büyüklüğünde deprem; 4) iki farklı aileden vuruş (olay ailesi: can kaybı, kaza/afet, acı olay, suç ve vahşet,
# kayıp ve arama, güvenlik tek aile — "silahlı saldırı: 1 yaralı" yerel olay —; uyarı ailesi: hava ve doğa uyarısı + resmi uyarı + eğitim
# duyurusu + yeni düzenleme — bakanlık/vali duyurusu —; fiyat ailesi: zam/fiyat/vergi + kesinti ve ulaşım + iş ve geçim — "elektrik"
# iki grupta da geçer —; adli olay sayılmaz; magazin ve ilk 5 takım ancak
# başka bir aileyle: "ünlü oyuncu kazada öldü" çok değerli, "ünlü oyuncu nişanlandı" değil). Tek ölümlü yerel kaza, cinayet, yerel
# yağış uyarısı, elektrik kesintisi, magazin, transfer: değerli ama ÇOK değerli değil. Modelin önemi 5 → çok değerli; 1-2 → değil.
NATIONAL = {"emekli/memur maaşı", "tatil/izin", "kamu duyurusu", "büyük siyaset", "milli başarı"}
FAMILY = {"can kaybı": "olay", "kaza/afet": "olay", "acı olay": "olay", "suç ve vahşet": "olay", "kayıp ve arama": "olay", "güvenlik": "olay",
          "hava ve doğa uyarısı": "uyarı", "resmi uyarı": "uyarı", "eğitim duyurusu": "uyarı", "yeni düzenleme": "uyarı",
          "zam/fiyat/vergi": "fiyat", "kesinti ve ulaşım": "fiyat", "iş ve geçim": "fiyat"}
NO_FAMILY = {"adli olay", "magazin/spor"}          # ikili sayımda yok
WEAK_FAMILY = {"magazin ve ünlüler", "ilk 5 takım"}  # yalnız başka bir aileyle birlikte
STRONG = [
    # ulusal fiyat/zam/vergi/faiz
    r"zam(?:m[ıi]|landı| geldi| yolda| kararı| oran\w*| müjde)", r"asgari ücret", r"(?:akaryakıt|benzin|motorin|lpg|doğal ?gaz|elektri[kğ]|köprü)\w*[^.!?]{0,30}(?:zam|indirim|fiyat|tarife)",
    r"faiz kararı", r"faiz(?:i|leri)? (?:artır|indir|sabit)", r"enflasyon (?:rakam|veri|açıklandı|oran)", r"vergi (?:zam|artış|aff|düzenleme|dilim)", r"ötv", r"kdv",
    r"kira (?:artış|zam)", r"köprü ve otoyol", r"tüik", r"merkez bankası",
    # terör ve büyük güvenlik olayı
    r"terör", r"bomba", r"rehine", r"şehit", r"patlama", r"darbe", r"suikast", r"saldırı\w*[^.!?]{0,30}(?:\d{2,}|çok sayıda|onlarca)",
    # afet ölçeği
    r"çok sayıda", r"onlarca", r"yüzlerce", r"binlerce", r"facia", r"katliam", r"felaket", r"ölü sayısı", r"can kayb\w*[^.!?]{0,20}(?:art|yüksel)",
    r"tsunami", r"kırmızı kod", r"turuncu kod", r"orman yangın", r"heyelan", r"çığ", r"sel felaket", r"sel(?:de|ler)?[^.!?]{0,30}(?:öl|kayıp|mahsur|sürükle)", r"hortum",
    r"(?:bina|apartman|köprü|tünel|maden)\w*[^.!?]{0,20}çök", r"göçük", r"maden\w*[^.!?]{0,30}(?:kaza|patlama|mahsur|göçük)",
    r"(?:uça[kğ]|helikopter|tren|gemi|feribot|otobüs)\w*[^.!?]{0,30}(?:düştü|kaza|devrildi|battı|çarpıştı|raydan|pistten|acil iniş)",
    # sağlık ve gıda ulusal
    r"salgın", r"toplatıl", r"toplatma", r"piyasadan çekil", r"geri çağır", r"zehirlen\w*[^.!?]{0,30}(?:\d{2,}|çok sayıda|onlarca|yüzlerce)",
    r"kuş gribi", r"kızamık", r"kolera", r"şap hastalı", r"zorunlu aşı",
    # para ve destek ulusal
    r"sosyal yardım", r"kira yardım", r"doğum yardım", r"evde bakım", r"engelli (?:maaş|aylı)", r"yaşlı aylı", r"65 yaş", r"işsizlik (?:maaş|ödene)",
    r"kyk", r"öğrenim kredi", r"toki", r"sosyal konut", r"kredi kart", r"taksit sınır", r"konut kredi", r"ihtiyaç kredi",
    r"(?:dolar|euro|avro|gram altın|altın|ons)\w*[^.!?]{0,40}(?:rekor|zirve|tarihi)", r"borsa\w*[^.!?]{0,40}(?:çöktü|çöküş|sert düş|devre kesici|rekor)",
    # destek ve af
    r"af yasa", r"genel af", r"infaz (?:düzenleme|paketi|indirim|yasası)", r"yargı paketi", r"vergi aff", r"prim aff", r"imar aff", r"cezası? aff",
    r"kosgeb", r"hibe", r"faizsiz kredi", r"devlet desteği", r"borç(?:lar)? silin", r"yapılandırma",
    # dünya ve savaş (Türkiye'yi ilgilendiren)
    r"savaş(?!çı)", r"ateşkes", r"nükleer", r"füze", r"işgal", r"nato", r"türkiye'?ye (?:tehdit|yaptırım|saldırı)", r"sınır ötesi", r"büyükelçi\w*[^.!?]{0,20}(?:çağrıldı|sınır dışı)",
    # ulaşım ve kesinti ulusal
    r"uçuş\w* iptal", r"seferler durdu", r"havalimanı kapan", r"grev", r"marmaray", r"metro seferleri", r"köprü geçiş", r"otoyol ücret", r"toplu taşıma\w*[^.!?]{0,20}(?:zam|ücret|ücretsiz)",
    r"(?:elektrik|su|doğal ?gaz) kesinti\w*[^.!?]{0,40}(?:\d{2,} (?:il|ilçe)|il genelinde|türkiye)", r"\d{2,} ilde", r"türkiye genelinde", r"yurt genelinde", r"81 il",
    # yeni düzenleme ulusal
    r"yürürlüğe gir", r"meclis'?ten geçti", r"yasalaştı", r"resmi gazete", r"zorunlu (?:oldu|hale|olacak)", r"ehliyet", r"pasaport", r"kimlik kart",
    r"trafik ceza", r"kanun teklifi", r"kararname", r"genelge",
    # eğitim ulusal
    r"okullar (?:ne zaman|açıl|tatil|kapat)", r"öğretmen atama", r"sınav (?:sonuç|tarih|ertelen|iptal)", r"yks", r"lgs", r"kpss",
]
_STRONG_RE = [re.compile(r"(?<![\wçğıöşü])" + p) for p in STRONG]
_COUNT_RE = re.compile(r"(?<![\w.,])(\d{1,4})(?: bin)? (?:kişi|ölü|yaralı|can|işçi|öğrenci|asker|polis|vatandaş|çocuk|madenci|turist|yolcu|kişinin|kişiyi|kişiye)")
_MAG_RE = re.compile(r"(\d(?:[.,]\d)?)\s*(?:büyüklüğ|şiddet)")


def strong_hits(t: str, hits: list) -> list:
    """Çok değerli nedenleri (boş liste: değil). t küçük harfli metin, hits score()'un grupları."""
    fams = {}
    for h in hits:
        if h in NO_FAMILY or h.startswith("anahtar:"):
            continue
        key = "ilk 5 takım" if h.startswith("ilk 5 takım") else h
        fams.setdefault(FAMILY.get(key, key), key)
    why = [h for h in hits if h in NATIONAL]
    m = next((p for p in _STRONG_RE if p.search(t)), None)
    if m:
        why.append(f"ulusal ölçek: {m.search(t).group(0)[:30]}")
    for c in _COUNT_RE.finditer(t):
        n = int(c.group(1)) * (1000 if " bin" in c.group(0) else 1)
        if n >= 3:
            why.append(f"ölçek: {c.group(0)}")
            break
    for c in _MAG_RE.finditer(t):
        try:
            if float(c.group(1).replace(",", ".")) >= 5.0:
                why.append(f"deprem {c.group(1)}")
                break
        except ValueError:
            pass
    if len(fams) >= 2 and any(k not in WEAK_FAMILY for k in fams.values()):
        why.append("birden çok değer grubu: " + " + ".join(fams.values()))
    return why


def score(text: str, extra_keywords=None, importance=None) -> dict:
    t = tr_lower(text or "")
    hits = []
    total = 0
    team = top_team_hit(text or "")
    if team:
        hits.append(f"ilk 5 takım: {team}")
        total += 3
    for name, w, pats in GROUPS:
        found = next((p for p in pats if re.search(r"(?<![\wçğıöşü])" + p, t)), None)
        if found:
            hits.append(name)
            total += w
    for kw in extra_keywords or []:
        kw = tr_lower(str(kw).strip())
        if kw and kw in t:
            hits.append(f"anahtar: {kw}")
            total += 3
    imp = None
    try:
        imp = int(importance) if importance is not None else None
    except (TypeError, ValueError):
        imp = None
    # model 1-2 dediyse (magazin: "ünlünün annesi vefat etti") anahtar kelime tek başına yetmez
    soft = not team and not ({"can kaybı", "milli başarı", "suç ve vahşet", "kayıp ve arama", "dünya ve savaş", "acı olay", "magazin ve ünlüler"} & set(hits)) and any(re.search(r"(?<![\wçğıöşü])" + p, t) for p in SOFT)
    valuable = (imp is not None and imp >= 4) or (total >= 3 and not soft and (imp is None or imp >= 3))
    if soft and total >= 3 and not valuable:
        hits.append("magazin/spor")
    reason = ", ".join(hits) or (f"önem {imp}/5" if imp else "sıradan haber")
    if imp is not None and hits:
        reason += f" · önem {imp}/5"
    # çok değerli: değerli + (ulusal grup, ulusal kalıp, ölçek ya da iki aile); modelin önemi 5 → çok değerli, 1-2 → değil
    sw = strong_hits(t, hits) if valuable else []
    strong = valuable and (imp == 5 or (bool(sw) and (imp is None or imp >= 3)))
    if valuable and imp == 5 and not sw:
        sw = [f"önem {imp}/5"]
    return {"valuable": valuable, "score": total, "importance": imp, "reasons": hits, "reason": reason,
            "strong": strong, "strongReason": ", ".join(sw) if strong else ("değerli ama çok değerli değil" if valuable else "")}


if __name__ == "__main__":
    print(json.dumps(score(" ".join(sys.argv[1:]) or sys.stdin.read()), ensure_ascii=False))
