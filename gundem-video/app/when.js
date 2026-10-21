// Mesajdaki yayın saatini çözer (kullanıcı isteği: "haber linki gönderdiğimde saatini de yazayım, bunu şu saatte paylaş;
// saat yazmazsam direkt paylaşsın"). Türkçe ifadeler: "18:30'da", "18.30", "saat 6'da", "akşam 8'de", "sabah 9", "öğlen 12",
// "gece 1", "yarın 10:00", "yarın sabah 9", "Cuma 18:30'da", "haftaya salı 10'da", "öbür gün saat 9'da", "25 Ekim'de 18:30'da",
// "20 dakika sonra", "2 saat sonra", "yarım saat sonra".
// Gün belirtilmeyen saat geçmişte kaldıysa yarına; dönemsiz "saat 8" bugünün en yakın geleceği (08:00 ya da 20:00) sayılır.
// Dönüş: { at: Date | null, rest: saat ifadesi (ve kullanılan gün sözü) çıkarılmış metin, label: "bugün 18:30", doubt: saat alındı ama
// yayın isteğiyle yazıldığı kesin değil — WhatsApp yanıtına doubtNote satırı —, ignored: (yalnız at yokken) alınmayan saat ("21:15") }.
// YAPI (10.-12. tur, ÖNCE SAHİP; inceleme, 20 Ekim): saat HEAD'in (c0937ab) kendi kodunun (headWhen, kalıplar birebir) aldığı saattir, günü
// HEAD'in günüdür (önce göreli süre "2 saat sonra", sonra metindeki ilk dönem/saat/iki noktalı saat; "yarın/bugün" metnin herhangi bir yerinde;
// dönemsiz noktalı saat "12.50" yalnız ekli ya da metinde yayın fiili varsa; dönemsiz yalın saat en yakın 08:00/20:00; geçmiş saat yarına).
// HEAD'den yalnız şu adı konmuş yerlerde ayrılır:
// - ŞÜPHE (doubt; yalnız yanıttaki satırı değiştirir): sıkı kural (strictWhen, 9. tur) HEAD'in saatini almazdı — yapıştırılan altyazıdaki
//   olay saati olabilir ("Saat 14:30'da meydana gelen kazada…") — ya da saati bağlayan söz zayıf: "olsun" saate bitişik değil ("Akşam 9'da
//   Taksim'de konser, haber olsun"; "Saat 20:00 olsun", "18:30'da olsun" bağlar), fiil -AlIm/-sIn biçiminde ("paylaşalım", "herkes
//   paylaşsın"; edilgen "yayınlansın" değil), saatin yan cümlesinde dolgu dışı söz var ("Cenaze namazı 15:30'da, paylaşalım", "Sabah 8'de
//   Esenyurt'ta yangın, haber yap, paylaş"; saatten önceki fiil, sahibin üretim/kurgu sözü, selamlama ve hesap adları sayılmaz; yayın fiilinin
//   nesnesi sayılır — "yangın haberini 18:30'da paylaş" şüpheli, 13. tur), "kadar" "bekle"den önce değil ("18:00'e kadar paylaş, hayat
//   kurtar") ya da metinde izleyiciye söz var (herkes, hepiniz, sizler; 13. tur: takipte kalın, kaçırmayın, bildirimleri açın, videonu…).
//   14. tur (inceleme, 21 Ekim): METNİN GERİ KALANI da — bağlayan fiilin dışında herhangi bir yerde dolgu dışı söz ("Cuma 20:00'de paylaş,
//   çekilişe katıl", "Cumartesi 14:00 olsun, Taksim'de toplanalım", "Kadıköy'de yangın çıktı, Cuma 20:00'de paylaş"; selamlama, teşekkür,
//   gülme ve hitap — Emixhas — sayılmaz; geçiş kuralında HEAD'in saatinin yan cümlesi olayın anlatımıdır), saate bitişik olmayan gün sözü
//   ("📍 🗓 Cumartesi ⏰ 21:00'da"; bitişik gün sözüne bitişik olan sayılmaz: "25 Ekim Pazar 11:00'de") ya da etkinlik kartı işareti (📍 🗓 ⏰).
//   16. tur (inceleme, 21 Ekim): metnin herhangi bir yerinde olumsuz görünen yayın sözü ya da birden çok yayın sözü (pubNeg) ve saate bitişik
//   olmayan yarın/bugün de. ŞÜPHELİ SAAT HEAD saat aldıysa HEAD'in BÜTÜN sonucudur (saati, günü, talimatı; karışım yok).
// - Saate bitişik gün sözü (gün adı, "haftaya (salı)", "öbür gün", "25 Ekim'de", "bugün değil yarın 19:00'da") HEAD'in gününe YALNIZ saat
//   şüphesizken yeğlenir ve o zaman talimattan kesilir; şüpheli saatte HEAD'in sonucu, gün sözü talimatta kalır (11.-12. tur; "Pazartesi 20:00'de çektim, yarın paylaş" altı gün sonraya, "Cumartesi 20:00'de Harbiye'de konser, yarın paylaş"
//   cumartesiye planlanıyordu). Ad da olan gün adı (pazar, cuma, salı…) yalnız yalın ya da günü/akşamı/sabahı/gecesi/öğleden sonra ile gündür
//   ("Kadıköy pazarı 18:30'da" değil); gün adının ardından dönem/saat/sayı/yayın fiili/dolgu dışı söz gelirse ad tamlamasıdır ("18:30'da Cuma
//   maçının haberini paylaş", "pazar yeri", "Cuma namazı"; 12. tur).
// - HEAD saat bulamazsa sıkı kuralın bitişik ya da araya yalnız dolgu giren yayın fiiliyle ("yarın 10'da paylaş") ya da metin yalnız saat +
//   dolguyken ("Cuma 9'da") aldığı saat, günü yalnız kendi bitişik gün sözü (yoksa günsüz: bugün, geçmişse yarın; şüpheli geçmiş an ertesi güne);
//   HEAD'in saati sıkı kurala göre şüpheliyken sıkı kural başka bir saati aynı sıkılıkta ve ŞÜPHESİZ alıyorsa o saat (16. tur: iki saatli metin
//   şüpheli olduğundan "Tören 10:00'da başladı, öğlen 12'de paylaş" HEAD'in 10:00'ı + şüphe satırı) — HEAD'in saatinin bitişiğinde ya da aynı yan cümlede en çok iki rakamsız söz sonra
//   herhangi biçimde yayın fiili varsa ("bunu 18:30'da paylaşırsın, maç 20:00'de olsun", "18:30'da hemen değil paylaş, yarın 9'da da paylaş")
//   ya da öbür saati yalnız "olsun" bağlıyorsa değil.
// - Talimattan (rest) saatin yanındaki fiil HEAD'in kestiği kadar kesilir ("paylaşmanı istiyorum"dan "istiyorum" kalır: "mizah istiyorum" tür
//   etiketidir); 14. tur: her biçimde ("komik bir video 16:45'te paylaşırız" → "komik bir video"; 11.-13. turda istek biçimi olmayan fiil
//   kalıyor, tür/fragman isteğini düşürüyordu), göreli saatte bütün kelime; saatin ardındaki "sularında/civarı" da kesilir.
// SIKI KURAL (9. tur): aynı yan cümlede istek biçiminde yayın fiili (paylaş, yayınla, yayımla, at, gönder, yükle, koy, planla, ayarla,
// zamanla, "yayına al/koy/at/ver", saatten sonra "olsun"; emir, istek, kibar soru, şart "-sAn iyi olur", "-mAnI istiyorum", "-mAn lazım",
// "-AcAksIn", sahibin "-AcAğIz/-cAz"ı) — fiil saatten önce ya da sonra, arada en çok 6 söz, arada cümle sonu [.!?;] ve başka çekimli fiil
// (-DI, -mIş, -Iyor, -AcAk, -mAlI, -DIğI, ortaç -An, var/yok/değil) yok — ya da metin saatten başka yalnız etiket, dolgu, süre, tür sözü ve
// yayın fiilinden oluşuyorsa ("<link> 18:30'da", "40 saniye, 18:30'da"); bekçiler: fiilden sonra aktarma/amaç/soru/istek sözü (dedi, diye,
// mı, istedi), tırnak içindeki saat, ardından ad gelen yalın "at"/"koyun", tire ya da kesme işaretiyle ad olan fiil, "paylaş butonu", yan
// cümle sonunda olmayan yalın "zamanla", dolgudan başka söz, tire ya da -InIzI nesnesi olan izleyiciye çoğul emir. Ses/görüntü konumu
// (YouTube "12:30'dan itibaren") commands.js'te ⟪…⟫ ile gizlenir, dolgu sayılır.
// ALINMAYAN SAAT satırı (ignored; HEAD de almadıysa) yalnız saat bağlamında: "saat" sözü, bulunma eki ('da/'de/'ta/'te), sularında/civarı/itibarıyla
// ya da yanında yayın fiili; ölçülü ondalık sayı ("4.25 büyüklüğünde", "12.45 saniyelik", "9.58 ile", "0.52 santim", "47.20 TL") değil.
// Uzun girdi (WhatsApp mesajı en çok 65.536 karakter): HEAD kalıpları ilk eşleşmede durur; sıkı kural metni bir kez tarar, saat başına
// ~80 karakterlik pencereye bakar, en çok ilk 20 saat adayı.

const DAY = 86400000;
const pad = (n) => String(n).padStart(2, "0");
const L = "a-zçğıöşüâîû";
const NL = `(?![${L}])`;
// istek biçiminde yayın fiili eki (tr-TR küçük harfli metinde, kelimenin tamamı): yalın kök, -(y)In(Iz), -(y)AlIm, -sIn(lAr), -sAnA,
// -(I)r mIsIn(Iz), -(y)Abilir misin, -(y)Abilirsin (çoğulu -(y)Abilirsiniz değil), -(y)Iver(sene/in/ir misin), -sAn(Iz)/-(I)rsAn(Iz)
// (+ iyi olur/sevinirim), -mAk/-mAnI/-mAsInI istiyorum/rica ediyorum, -mAk/-mAn lazım/gerek, -mAlIsIn, tekil -(y)AcAksIn/-(y)AcAk mIsIn,
// sahibin "biz"i -(y)AcAğIz/-(y)AcAz/-cAz ("18:30'da paylaşcaz", "paylaşacağız"), -sAk iyi olur, -mAmIz lazım, -(y)AbilirIz, gündelik
// -(y)AcAn/-IcAn ("paylaşacan", "atıcan"), tekil -mAyI unutma (izleyiciye "paylaşmayı unutmayın" değil), edilgen istek -Il/-nsIn
// ("paylaşılsın", "yayınlansın") ve -Il/-nmAsInI istiyorum; Türkçe harfsiz yazım da ("paylas", "yayinla", "gonder", "yukle"; 10. tur)
const WANT = "(?:istiyoru[mz]|isterim|rica\\s+ediyoru[mz]|rica\\s+ederim)";
const PUB_SFX = `(?:y?[ıiuü]n(?:[ıiuü]z)?|y?[ae]l[ıi]m|s[ıiuü]n(?:l[ae]r)?|s[ae]n[ae]|[aeıiuü]?r\\s*m[ıiuü]s[ıiuü]n(?:[ıiuü]z)?|`
  + `y?[ae]bilir(?:\\s*m[ıi]s[ıi]n(?:[ıi]z)?|s[ıi]n|[ıi]z)|y?[ıiuü]ver(?:s[ae]n[ae]|[ıi]n(?:[ıi]z)?|[ıi]r\\s*m[ıi]s[ıi]n(?:[ıi]z)?)?|`
  + `(?:[aeıiuü]?r)?s[ae]n(?:[ıi]z)?(?:\\s+(?:iyi|g[üu]zel|harika|s[üu]per)\\s+olur|\\s+sevinirim)?|s[ae]k\\s+(?:iyi|g[üu]zel)\\s+olur|`
  + `m[ae](?:k|n[ıi]|s[ıi]n[ıi])\\s+${WANT}|(?:[ıiuü]l|n)m[ae]s[ıi]n[ıi]\\s+${WANT}|m[ae]l[ıi]s[ıi]n|`
  + `y?[aeıiuü]?c[ae](?:ks[ıi]n|k\\s*m[ıi]s[ıi]n|[ğg][ıi]z|z|n)|m[ae](?:k|n|m[ıi]z)\\s+(?:laz[ıi]m|gerek(?:iyor)?)|m[ae]y[ıi]\\s+unutma|(?:[ıiuü]l|n)s[ıiuü]n)?`;
const PUB_STEM = `(?:payla[şs]|yay[ıi]nla|yay[ıi]mla|g[öo]nder|y[üu]kle|planla|ayarla|zamanla|koy(?!un${NL})|at)`;
const PUB_VERB = `(?:${PUB_STEM}${PUB_SFX}|yay[ıi]na\\s+(?:koy|al|at|ver)${PUB_SFX}|yay[ıi]na\\s+(?:gir|[çc][ıi]k)s[ıi]n|yay[ıi]nda\\s+olsun)${NL}`;
const PUB_RE = new RegExp(`(?<![${L}])(?:${PUB_VERB}|olsun${NL})`, "g");
const PUB_ONLY = new RegExp(`^${PUB_VERB}$`); // saatin yanındaki fiil istek biçimi mi (yalnız o zaman talimattan kesilir)
// HEAD'in saatine bitişik (yalnız boşlukla) ya da aynı yan cümlede en çok iki söz sonra (rakamsız: "18:30'da hemen değil paylaş"; "18:30'da
// değil 20:00'de paylaş" değil) yayın fiili, HERHANGİ biçimde ("paylaşırsın", "atarsın" da): sıkı kural başka saate geçmez
const PUB_ANY = `(?:(?:payla[şs]|yay[ıi]nla|yay[ıi]mla|g[öo]nder|y[üu]kle|planla|ayarla|zamanla)[${L}]*|(?:at|koy)(?:[aıe]?r[${L}]*|s[ae]n[${L}]*|[ıi]n[${L}]*|[ae]bilir[${L}]*|[ıi]ver[${L}]*)?${NL})`;
const PUB_NEXT = new RegExp(`^[^\\S\\n]+${PUB_ANY}`), PUB_NEXT2 = new RegExp(`^(?:[^\\S\\n]+[^\\s.,!?;:\\d]+){0,2}?[^\\S\\n]+${PUB_ANY}`), PUB_PREV = new RegExp(`(?<![${L}])${PUB_ANY}[^\\S\\n]+$`);
// ikinci kişi geniş zaman ("18:30'da paylaşırsın"): HEAD gibi talimattan kesilir (tür etiketi kalsın), şüphe kalır
const AOR2 = new RegExp(`(?:payla[şs]|yay[ıi]nla|yay[ıi]mla|g[öo]nder|y[üu]kle|planla)[aeıiuü]?rs[ıiuü]n(?:[ıiuü]z)?${NL}`, "y");
// bağlayan fiil kökten hemen sonra -AlIm ya da etken -sIn ("paylaşalım", "herkes paylaşsın"; edilgen "yayınlansın", "paylaşılsın" ve ikinci kişi
// "paylaşabilirsin", "paylaşacaksın" değil): şüphe
const WE_THEY = new RegExp(`^(?:${PUB_STEM}|al|ver)(?:y?[ae]l[ıi]m|s[ıiuü]n(?:l[ae]r)?)$`);
const PLURAL = /(?<!s)[ıiuü]n(?:[ıiuü]z)?$/; // izleyiciye çoğul emir: paylaşın, yayınlayın, gönderin (paylaşsın, yayınlansın değil)
const BOUND = /[.!?;\n]/; // yan cümle sınırı (virgül, iki nokta, tire, parantez sınır değil: "paylaş, 18:30'da", "paylaş: 18:30")
const GAP_W = 6; // saatle bağlanan fiil arasında en çok söz ("akşam 8 gibi bunun haberini yap ve yayınla"; 9. turda 4'tü)
const CLOCK_IN = /\d{1,2}[:.]\d{2}|saat\s*\d/; // arada başka saat: fiil ona bağlıdır ("saat 14:30'da kaza, haber yap 18:00'de yayınla")
// fiil ile saat arasındaki çekimli fiil (araya giren yan cümle saati başka yükleme bağlar: "12:00'de başlıyor: hemen paylaş", "06:45'te
// kalkacak, … ayarlayın"): -DI (yaygın -DI'lı adlar değil), -mIş, -Iyor, -AcAk, -mAlI, -DIğI, ortaç -An (bulunma/ayrılma -dAn değil),
// var/yok/değil; kesme işaretli özel ad ("Esenyurt'ta") fiil değil
const PAST_X = new Set(["kedi", "kendi", "şimdi", "hindi", "hadi", "haydi", "ordu", "altı", "üstü", "artı", "örtü", "yedi", "parodi", "komedi",
  "trajedi", "melodi", "parti", "kutu", "adı", "tadı", "kaydı", "yurdu", "saati", "şirketi", "devleti", "milleti", "bütün", "butun", "otomatik",
  "artık", "artik", "dikkatli", "tamamını", "hepsini", "sadık", "kanalımızda", "tekrar", "tatlı", "dostum", "kardeşim", "geç", "günlük", "haftalık"]);
const PART_X = new Set(["lütfen", "lutfen", "hemen", "zaman", "insan", "ekran", "meydan", "erken", "bazen", "tamamen", "otomatikman", "kazan", "orman", "duman",
  "aslan", "vatan", "liman", "ayran", "mekan", "mekân", "kalkan", "kapan", "yalan", "tavan", "bayan", "sultan", "divan", "ozan", "yaban",
  "itibaren", "zaten", "kısmen", "aslen", "nispeten", "düşman", "kervan", "harman", "çoban", "devran", "yemen", "beden"]);
const FIN_V = new RegExp(`^[${L}]{2,}(?:m[ıiuü]ş|[ıiuü]?yor|[ae]c[ae][kğ]|m[ae]l[ıi]|[dt][ıiuü]ğ)[${L}]*$`);
const FIN_DI = new RegExp(`^[${L}]{2,}[dt][ıiuü](?:m|n|k|z|n[ıiuü]z|l[ae]r)?$`);
const FIN_AN = new RegExp(`^[${L}]{2,}[ae]n$`);
// çekimli fiil gibi biten sık ad, ad ve zarf (sahibin "18:30'da aynen paylaş", "18:30'da bakan açıklamasını paylaş"; 10. tur) ve zaman zarf-fiili
// -DIğIndA ("maç 18:30'da bittiğinde paylaş": saat yayın saatidir)
const NOT_FIN = new Set(["aynen", "acilen", "altın", "kadın", "yardım", "gündüz", "yıldız", "aydın", "plan", "başkan", "bakan", "erdoğan", "ramazan", "kurban",
  "hakan", "furkan", "volkan", "iran", "kendin", "efendim", "ciddi", "akşamüstü", "açıklamalı", "altyazılı", "müzikli", "logolu", "kapaklı",
  "başlıklı", "etiketli", "hashtagli", "türkçe", "ingilizce", "ilk", "son", "tam", "erkenden", "hemencecik", "doğru", "beraber", "birlikte"]);
const FIN_X = new RegExp(`^(?:lazım|lazim|gerek|gerekiyor|şart|[${L}]{2,}[dt][ae]y[ıi][mz]|(?!olsun$|kesin$)[${L}]{2,}[^r]s[ıiuü]n(?:l[ae]r)?)$`);
const finite = (w) => !/['’]/.test(w) && w.length < 60 && !NOT_FIN.has(w) && !new RegExp(`[dt][ıiuü]ğ[ıiuü]nd[ae]$`).test(w) && (w === "var" || w === "yok" || w === "değil" || w === "diil" || FIN_X.test(w) || FIN_V.test(w)
  || (FIN_DI.test(w) && !PAST_X.has(w)) || (FIN_AN.test(w) && !/[dt][ae]n$/.test(w) && !PART_X.has(w)));
// arada çekimli fiil var mı ("-AcAk şekilde/biçimde" zarf yan cümlesi değil: "18:30'da paylaşılacak şekilde ayarla") ya da dolgu dışında
// 4'ten çok söz ("Yarın 09:00'a kadar 0 Rh- kan lazım, paylaş" değil; "akşam 8 gibi bunun haberini yap ve yayınla" sayılır)
const finIn = (ts) => ts.some((w, i) => finite(w) && !/^(?:şekilde|biçimde|gibi)$/.test(ts[i + 1] || "")) || ts.filter((w) => !FILLW.test(w) && w !== "gibi").length > 4;
// çoğul emirde ve yalın "at"tan sonra sayılan dolgu sözü (tür etiketi, bu/şu, hedef hesap, zarf)
const FILLW = new RegExp(`^(?:mizah|mizahi|komik|trend|viral|haber[${L}]*|video[${L}]*|olarak|bunu|şunu|bu|şu|lütfen|yarın|bugün|da|de|hemen|`
  + `direkt|direk|doğrudan|otomatik(?:man)?|hepsine|hepsinde|tüm|bütün|hesaplar(?:a|da)?|her|yerde|sadece|yalnız|yalnızca|`
  + `yap|yapın|hazırla|hazırlayın|ve|sonra|teşekkürler|teşekkür|tesekkurler|sağol|saol|sağolun|saolun|tşk|tsk|abi|kanka|hocam|günaydın|gunaydin|selam|selamlar|`
  + `merhaba|[0-9][0-9:.'’${L}]*|`
  + `saat|yarım|bir|akşam|sabah|öğlen?|gece|ikindi|kanal[${L}]*|sayfa[${L}]*|hesab[${L}]*|story|post|reels?|hikaye[${L}]*|hikâye[${L}]*|`
  + `bunun|bundan|şunun|benzerini|aynısını|kısa|uzun|saniye[${L}]*|dakika[${L}]*|fragman[${L}]*|mizah[${L}]*|komik[${L}]*|`
  + `(?:instagram|insta|ig|youtube|yt|tiktok|reels|shorts)(?:['’]?(?:y?[ae]|[dt][ae]|y?[ıi]))?)$`);
// metin yalnız saat + dolgu mu (yayın fiilleri önce atılır): tür etiketi, dolgu, süre birimi, dönem ve gün sözü, konum bağlacı, yalın
// "yap/hazırla", "ve", "olsun", hedef hesap ("haber yap 18:30", "mizah 18:30'da", "40 saniye, 18:30'da", "haber yap ve paylaş. 18:30'da")
const FILL = new Set(["mizah", "mizahi", "komik", "trend", "viral", "haber", "esprili", "komedi", "video", "videosu", "videoyu", "olarak", "bunu", "yap",
  "hazırla", "şunu", "bu", "şu", "lütfen", "saniye", "saniyelik", "sn", "dakika", "dakikalık", "dk", "da", "de", "ta", "te", "a", "e", "ya", "ye",
  "gibi", "civarı", "civarında", "sularında", "itibaren", "itibariyle", "itibarıyla", "arası", "yarın", "bugün", "saat", "sabah", "öğle", "öğlen",
  "öğleden", "sonra", "akşam", "gece", "ikindi", "ve", "olsun", "haftaya", "öbür", "öbürgün", "gün", "günü", "hemen", "direkt", "otomatik",
  "pazartesi", "salı", "çarşamba", "perşembe", "cuma", "cumartesi", "pazar", "ocak", "şubat", "mart", "nisan", "mayıs", "haziran", "temmuz",
  "ağustos", "eylül", "ekim", "kasım", "aralık", "instagram", "insta", "ig", "youtube", "yt", "tiktok", "reels", "shorts", "facebook", "fb", "x",
  "twitter", "buçuk", "buçukta", "dan", "den", "tan", "ten", "olunca", "geçince", "aynı", "anda", "birden", "bizim", "kesinlikle", "ama",
  // üretim isteğinin kendisi ve selamlama ("haberini yap, 18:30'da", "abi bunun benzerini yap 18:30'da"; 10. tur)
  "haberi", "haberini", "bunun", "bundan", "kısa", "uzun", "bir", "bi", "haberleştir", "habere", "çevir", "benzerini", "aynısını", "fragman",
  "fragmanı", "analizi", "analiz", "et", "yapar", "mısın", "misin", "link", "linki", "linkteki", "merhaba", "selam", "abi", "kanka", "hocam", "teşekkürler",
  "günaydın", "gunaydin", "sağol", "saol", "sağolun", "saolun", "selamlar", "yapın", "hazırlayın", "gibisini", "gibisinden", "buna", "benzer",
  "benzeri", "böylesini",
  // kurgu talimatı ("haber yap, 40 saniye, orijinal sesi kalsın, başını kes, 18:30'da")
  "orijinal", "sesi", "sesini", "kalsın", "başını", "sonunu", "kes", "kısalt", "altyazı", "altyazılı", "ekle", "müzik", "müziği", "müziğini", "kaldır", "dikey", "yatay"]);
const DOW = { pazar: 0, pazartesi: 1, salı: 2, çarşamba: 3, perşembe: 4, cuma: 5, cumartesi: 6 };
const MON = ["ocak", "şubat", "mart", "nisan", "mayıs", "haziran", "temmuz", "ağustos", "eylül", "ekim", "kasım", "aralık"];
const DAYN = "(cumartesi|cuma|pazartesi|pazar|salı|çarşamba|perşembe)";
// gün sözü: 1 yarın/bugün, 2 öbür gün, 3 haftaya + gün, 4 gün adı, 5-6 tarih ("25 ekim'de"), 7 gün içi dönem (akşamı, sabahı, gecesi, öğleden sonra).
// Gün adı yalnız yalın ya da günü/akşamı/sabahı/gecesi/öğleden sonra ile (ad da olan pazar, cuma, salı…: "Kadıköy pazarı", "pazara", "pazarda",
// "Pazar'a" gün değil; 11. tur); ardından dönem, saat, sayı, yayın fiili ya da dolgu (ve, da/de, bunu, şunu, hemen) dışında bir söz gelirse ad
// tamlamasıdır, gün değil (12. tur; inceleme, 20 Ekim: "18:30'da Cuma maçının haberini paylaş", "18:30'da cumartesi etkinliğini paylaş", "pazar
// yeri", "Cuma namazı")
const DAYX = `(?<![${L}\\d])(?:(yarın|bugün)|(öbür\\s?gün)|haftaya(?:\\s+${DAYN})?|${DAYN}(?!['’]?[${L}])`
  + `(?!\\s+(?!(?:günü|akşamı|sabahı|gecesi|öğleden|akşam|sabah|öğlen?|gece|ikindi|saat|ve|ya|da|de|bunu|şunu|hemen|${PUB_ANY})${NL})[${L}])`
  + `|(\\d{1,2})\\s+(${MON.join("|")})(?:['’]?(?:[dt][ae]|y?[ae]|y?[ıi]))?)${NL}(?:\\s+(?:günü|(akşamı|sabahı|gecesi|öğleden\\s+sonra)))?`;
const DAY_BEFORE = new RegExp(`${DAYX}\\s*$`);
const DAY_BEFORE_C = new RegExp(`${DAYX}\\s*,?\\s*$`); // HEAD saatinin önünde (virgül de: "Yarın, 18:30'da paylaş")
const DAY_AFTER = new RegExp(`^\\s+${DAYX}`);
const DAY_VERB = new RegExp(`(?<![${L}])(yarın|bugün|öbür\\s?gün)\\s+$`);
const DAY_PER = { akşamı: "akşam", sabahı: "sabah", gecesi: "gece" };
const dayPer = (w) => (w ? DAY_PER[w] || "öğleden sonra" : "");
// sayıdan sonraki bulunma eki (WhatsApp yanıtındaki "15:00'te paylaş" örneği): okunuşun son sözüne göre
const LOC = ["da", "de", "de", "te", "te", "te", "da", "de", "de", "da"]; // 0 (sıfır) … 9 (dokuz)
const TENS = { 1: "da", 2: "de", 3: "da", 4: "ta", 5: "de" }; // on, yirmi, otuz, kırk, elli
const locTr = (n) => (n % 10 ? LOC[n % 10] : n ? TENS[n / 10] : "da");
const atTr = (hhmm) => { const [h, mi] = String(hhmm).split(":").map(Number); return locTr(mi || h); };
// "bugün 18:30" → "bugün 18:30'da" (yanıttaki "… yayınlanacak" satırlarında doğru ek)
export const atLabel = (label) => `${label}'${atTr(String(label).split(" ").pop())}`;
// yayın saati sayılmayan saat için WhatsApp yanıtına TEK kısa satır, bir dahaki gönderim için (önerilen yazım parseWhen'de şüphesiz saattir);
// sahibin kendi WhatsApp videosunda link yok: video açıklamasıyla gönderilir (12. tur; inceleme, 20 Ekim)
export const timeNote = (hhmm, video = false) => `⏰ Metindeki ${hhmm} yayın saati sayılmadı; saatli yayın için ${video ? "videoyu" : "linki"} "${hhmm}'${atTr(hhmm)} paylaş" `
  + `${video ? "açıklamasıyla" : "yazarak"} gönderin.`;
// şüpheli yayın saati (doubt): saat alındı, sahip olay saatiyse yayını öne alabilir ya da iptal edebilir (planlı yayın video hazır olunca
// data/scheduled_publish.json'a yazılır; "planlı yayını şimdi yayınla" bekleyenlerin hepsini hemen yayınlar, "planlı yayını iptal et"
// hepsini yayınlamadan bırakır — ikisi de video gelince işe yarar)
export const doubtNote = (label) => `⏰ ${atLabel(label)} yayınlanacak. Bu saat haberdeki olayın saatiyse video gelince *planlı yayını şimdi yayınla* ya da *planlı yayını iptal et* yazın.`;

export function whenLabel(at, now = new Date()) {
  const d0 = new Date(now); d0.setHours(0, 0, 0, 0);
  const diff = Math.floor((new Date(at).setHours(0, 0, 0, 0) - d0) / DAY);
  const day = diff === 0 ? "bugün" : diff === 1 ? "yarın" : new Date(at).toLocaleDateString("tr-TR", { day: "numeric", month: "long" });
  return `${day} ${pad(new Date(at).getHours())}:${pad(new Date(at).getMinutes())}`;
}

// ---------- HEAD (c0937ab) kuralı: kalıplar birebir; yalnız fiil yakalama grupları eklendi (eşleşme aynı)
const H_REL = /(\d{1,3}|bir|yarım)\s*(dakika|dk|saat)\s*sonra(?:\s*((?:paylaş|yayınla|at|gönder)\w*))?/;
const H_PER = "(sabah|öğle(?:n|den sonra)?|akşam|gece|ikindi)";
const H_SFX = "(?:\\s?['’]?(?:[ıiuü]?n?(?:da|de|ta|te))(?=\\s|$|[.,!?]))?";
const H_VERB = "(?:\\s+((?:paylaş|yayınla|yayımla|gönder|yükle|planla)[a-zçğıöşü]*(?:\\s+m[ıi]s[ıi]n)?)(?=\\s|$|[.,!?]))?";
const H_ABS = new RegExp(`(?:${H_PER}\\s*(?:saat\\s*)?(\\d{1,2})(?:[:.](\\d{2}))?|saat\\s*(\\d{1,2})(?:[:.](\\d{2}))?|(?<![\\d.,])(\\d{1,2})[:.](\\d{2})(?![\\d.,]))${H_SFX}${H_VERB}`);
const H_DAY = /(?:^|\s)(yarın|bugün)(?=\s|$)/;
const H_PRICE_V = /(paylaş|yayınla|yayımla|gönder|planla|(^|\s)at(\s|$))/;
const cutSpans = (t0, spans) => { let r = t0; for (const [a, b] of [...spans].sort((x, y) => y[0] - x[0])) r = r.slice(0, a) + " " + r.slice(b); return r.replace(/\s+/g, " ").trim(); };
// saatin yanındaki fiil yalnız istek biçimi ya da ikinci kişi geniş zamansa ("paylaşırsın": yanındaki tür etiketi kalsın) kesilir, HEAD'in
// kestiği kadar (11. tur: "paylaşmanı istiyorum"dan "istiyorum", "paylaşırsan iyi olur"dan "iyi olur" HEAD gibi talimatta kalır — "mizah
// istiyorum" tür etiketidir); göreli saatte HEAD'in \w* kesimi Türkçe harfte bölünüyordu ("paylaş" + "ırsan"): bütün kelime (+ "mısın");
// istek biçimi değilse kesilmez ("1 saat sonra paylaşılan görüntülerde" kalır)
const PUB_AT = new RegExp(PUB_VERB, "y"), WORD_AT = new RegExp(`[${L}]+(?:\\s+m[ıi]s[ıi]n${NL})?`, "y");
// "paylaşım yap" da istek: HEAD gibi "paylaşım" kesilir (13. tur; inceleme, 20 Ekim: "haber olarak 21:15'te paylaşım yap"ta talimatta kalan
// "paylaşım" haber isteğini bozuyordu, HEAD'in "haber olarak yap"ı haber)
const PUB_NOUN_AT = new RegExp(`payla[şs][ıi]m(?:[ıi]|[ıi]n[ıi])?\\s+yap${PUB_SFX}${NL}`, "y");
// HEAD'in kestiği fiil HER biçimde kesilir (14. tur; inceleme, 21 Ekim: 11.-13. turda yalnız istek biçimi kesiliyordu, talimatta kalan
// "komik bir video 16:45'te paylaşırız", "fragman 18:30'da yayınlanır", "mizah videosu. 19:00'da yayınlanırsa iyi olur" fiili HEAD'in
// tür/fragman kararını düşürüyordu): mutlak saatte HEAD'in kesimi birebir (bitişik paylaş/yayınla/yayımla/gönder/yükle/planla + ek, "mısın");
// göreli saatte paylaş/yayınla/gönder'in bütün kelimesi (HEAD'in \w* kesimi Türkçe harfte bölünüyordu); "at…" yalnız istek biçimiyse
// ("2 saat sonra Ataşehir'de" kalır)
const REL_STEM_AT = /(?:paylaş|yayınla|gönder)/y;
const verbCut = (low, vs, coreEnd, headEnd) => {
  if (headEnd !== undefined) return headEnd;
  PUB_AT.lastIndex = vs; AOR2.lastIndex = vs; PUB_NOUN_AT.lastIndex = vs; REL_STEM_AT.lastIndex = vs;
  if (!PUB_AT.test(low) && !AOR2.test(low) && !PUB_NOUN_AT.test(low) && !REL_STEM_AT.test(low)) return coreEnd;
  WORD_AT.lastIndex = vs; return WORD_AT.test(low) ? WORD_AT.lastIndex : coreEnd;
};
// saatin ardındaki yaklaşıklık sözü talimattan saatle birlikte kesilir (14. tur: "Mizah videosu; 21:30 sularında post et" talimatında kalan
// "sularında" tür ifadesinin ardını uzatıyordu)
const APPROX = new RegExp(`^[^\\S\\n]+(?:sularında|civarında|civarı|civarlarında|raddelerinde)${NL}`);
// saate bitişik gün sözü: {add | dow | date, per (gün içi dönem), a, b: kesilecek yer}
const dayOfMatch = (m, a, now) => {
  const b = a + m[0].length, per = dayPer(m[7]);
  if (m[1] === "yarın") return { add: 1, a, b, per };
  if (m[1] === "bugün") return { add: 0, a, b, per };
  if (m[2]) return { add: 2, a, b, per };
  if (/^\s*haftaya/.test(m[0])) {
    if (!m[3]) return { add: 7, a, b, per };
    const toMon = (8 - now.getDay()) % 7 || 7; // gelecek pazartesi
    return { add: toMon + (DOW[m[3]] + 6) % 7, a, b, per };
  }
  if (m[4]) return { dow: DOW[m[4]], a, b, per };
  const day = Number(m[5]), mon = MON.indexOf(m[6]);
  if (!(day >= 1 && day <= 31) || mon < 0) return null;
  const d = new Date(now.getFullYear(), mon, day);
  return d.getMonth() === mon ? { date: d, a, b, per } : null;
};
const adjDay = (low, s, e, now) => {
  const b0 = Math.max(0, s - 48), mb = low.slice(b0, s).match(DAY_BEFORE_C);
  if (mb && !(mb.index === 0 && b0 > 0 && /[\p{L}\p{N}]/u.test(low[b0 - 1]))) return dayOfMatch(mb, b0 + mb.index, now);
  const ma = low.slice(e, e + 48).match(DAY_AFTER);
  return ma ? dayOfMatch(ma, e + ma.index, now) : null;
};
const perHour = (period, h) => {
  if (period.startsWith("öğleden") || period === "akşam" || period === "ikindi") return h < 12 ? h + 12 : h;
  if (period.startsWith("öğle")) return h < 6 ? h + 12 : h;
  if (period === "gece") return h >= 7 && h < 12 ? h + 12 : h;
  return h;
};
// saat + gün sözü → an (gün adı sıradaki o gün, bugünse ve saat gelmediyse bugün; "bugün" geçmiş saatte bugün kalır — HEAD gibi)
const atDay = (base, h, min, d, now) => {
  const at = new Date(base); at.setHours(h, min, 0, 0);
  if (d.date) at.setFullYear(d.date.getFullYear(), d.date.getMonth(), d.date.getDate());
  else if (d.dow !== undefined) { const k = (d.dow - now.getDay() + 7) % 7; at.setDate(at.getDate() + k); if (at <= now) at.setDate(at.getDate() + 7); }
  else at.setDate(at.getDate() + d.add);
  return at;
};
// saatin yanında (yalnız boşlukla) herhangi biçimde yayın fiili var mı
const pubNear = (low, s, e, re = PUB_NEXT) => re.test(low.slice(e, e + 48)) || PUB_PREV.test(low.slice(Math.max(0, s - 48), s));
// HEAD'in seçtiği saat, HEAD'in günüyle: {at, rest, s, e (saat ifadesinin yeri, bitişik fiil hariç), pub (bitişik yayın fiili), adj (saate
// bitişik gün sözüyle {at, rest}; yalnız saat şüphesizken kullanılır)} ya da null; noktalı fiyat reddi {price: "12:50", s}
function headWhen(t0, now) {
  const low = t0.toLocaleLowerCase("tr-TR");
  let m = low.match(H_REL);
  if (m) {
    const n = m[1] === "bir" ? 1 : m[1] === "yarım" ? 0.5 : Number(m[1]);
    const ms = (m[2] === "saat" ? 3600000 : 60000) * n;
    if (ms > 0 && ms <= 7 * DAY) {
      const end = m.index + m[0].length, vs = m[3] ? end - m[3].length : -1;
      let ce = vs < 0 ? end : vs; while (ce > m.index && /\s/.test(low[ce - 1])) ce--;
      const at = new Date(now.getTime() + ms);
      return { at, rest: cutSpans(t0, [[m.index, vs < 0 ? end : verbCut(low, vs, ce)]]), s: m.index, e: ce, pub: vs >= 0 || pubNear(low, m.index, ce, PUB_NEXT2), adj: null };
    }
  }
  const dayM = low.match(H_DAY);
  const dayOff = dayM?.[1] === "yarın" ? 1 : 0;
  m = low.match(H_ABS);
  if (!m) return null;
  const period = m[1] || "";
  let h = Number(m[2] ?? m[4] ?? m[6]);
  const min = Number(m[3] ?? m[5] ?? m[7] ?? 0);
  if (!(h >= 0 && h <= 24 && min >= 0 && min <= 59)) return null;
  if (h === 24) h = 0;
  const explicitColon = m[6] !== undefined;
  // "12.50" fiyat da olabilir: dönemsiz/"saat"siz noktalı saat yalnız ek ("12.50'de") ya da metinde yayın fiili varsa saat sayılır
  if (explicitColon && !m[0].includes(":") && !/(da|de|ta|te)$/.test(m[0].trim()) && !H_PRICE_V.test(low)) return { price: `${pad(h)}:${pad(min)}`, s: m.index };
  const s = m.index, end = s + m[0].length, vs = m[8] ? end - m[8].length : -1;
  let ce = vs < 0 ? end : vs; while (ce > s && /\s/.test(low[ce - 1])) ce--;
  // HEAD'in fiil listesinde olmayan bitişik fiil ("18:30'da at", "18:30'a planla") HEAD gibi talimatta kalır: "bunun benzerini yapıp 18:30'da at"
  // (-Ip + istek fiili) tanıyıcılarda benzer video kalsın
  const ax = vs < 0 ? APPROX.exec(low.slice(end, end + 24)) : null;
  const cutEnd = vs < 0 ? end + (ax ? ax[0].length : 0) : verbCut(low, vs, ce, end);
  const base = new Date(now); base.setSeconds(0, 0);
  const pub = vs >= 0 || pubNear(low, s, ce, PUB_NEXT2);
  // saate bitişik gün sözü (geçmişte kalan tarih değil): yalnız saat şüphesizken HEAD'in gününe yeğlenir (parseWhen)
  let adj = null;
  const d = adjDay(low, s, ce, now);
  if (d) {
    const at = atDay(base, perHour(period || d.per, h), min, d, now);
    if (!(d.date && at <= now)) adj = { at, rest: cutSpans(t0, [[s, cutEnd], [d.a, d.b]]) };
  }
  // HEAD (c0937ab), birebir: "yarın/bugün" metnin herhangi bir yerinde, dönemsiz yalın saat en yakın 08:00/20:00, geçmiş saat yarına
  h = perHour(period, h);
  let rest = cutSpans(t0, [[s, cutEnd]]);
  if (dayM) rest = rest.replace(new RegExp(`(^|\\s)${dayM[1]}(?=\\s|$)`, "i"), " ").replace(/\s+/g, " ").trim();
  const at = new Date(base); at.setDate(at.getDate() + dayOff); at.setHours(h, min, 0, 0);
  if (!period && !explicitColon && !dayM && h >= 1 && h <= 12) {
    // dönemsiz "saat 8": bugünün en yakın gelecekteki 08:00 ya da 20:00'ı
    const a = new Date(at), b = new Date(at); b.setHours(h === 12 ? 12 : h + 12);
    const cands = [a, b].filter((x) => x > now).sort((x, y) => x - y);
    return { at: cands[0] || (() => { const x = new Date(a); x.setDate(x.getDate() + 1); return x; })(), rest, s, e: ce, pub, adj };
  }
  if (period === "gece" && h < 6 && !dayM && at <= now) at.setDate(at.getDate() + 1);  // "gece 1" → bu gece
  if (!dayM && at <= now) at.setDate(at.getDate() + 1);  // geçmişte kalan saat: yarın
  return { at, rest, s, e: ce, pub, adj };
}

// ---------- SIKI KURAL (9. tur): yalnız şüphe işareti ve HEAD'in saat bulamadığı metin için
// göreli: "20 dakika sonra", "2 saat sonra", "yarım saat sonra", "bir saat sonra"; dönem + saat, "saat X", ya da HH:MM / HH.MM; ek bulunma
// ('da) ya da kesme işaretli yönelme ('a/'ye: "18:30'a planla")
const REL = new RegExp(`(?<![${L}\\d])(\\d{1,3}|bir|yarım)\\s*(dakika|dk|saat)\\s*sonra${NL}(\\s+(?:${PUB_VERB}|olsun${NL}))?`, "g");
const PER = "(sabah|öğle(?:n|den sonra)?|akşam|gece|ikindi)";
const SFX = "(?:(?:\\s?['’]?(?:[ıiuü]?n?(?:da|de|ta|te))|['’]y?[ae])(?=\\s|$|[.,!?]))?";
const ABS = new RegExp(`(?:${PER}\\s*(?:saat\\s*)?(\\d{1,2})(?:[:.](\\d{2}))?|saat\\s*(\\d{1,2})(?:[:.](\\d{2}))?|(?<![\\d.,])(\\d{1,2})[:.](\\d{2})(?![\\d.,]))`
  + `${SFX}(\\s+(?:${PUB_VERB}|olsun${NL}))?`, "g");
// gün sözü + yalın saat ("yarın 10'da", "Cuma 9'da", "haftaya salı 10'da", "öbür gün 9'da", "Cuma akşamı 8'de"): saat adayı yalnız sayının
// kendisi (gün sözü dayOf ile ayrıca bulunur, gün içi dönem — akşamı, gecesi — saate uygulanır); dönemsiz saat yazıldığı gibi
const DAYH = new RegExp(`${DAYX}\\s+((\\d{1,2})['’](?:[dt][ae]|y?[ae])(?=\\s|$|[.,!?])(\\s+(?:${PUB_VERB}|olsun${NL}))?)`, "g");
const dayHour = (m) => { const x = [m[8]]; x.index = m.index + m[0].length - m[8].length; x[1] = dayPer(m[7]) || undefined; x[4] = m[9]; x[8] = m[10]; x.dayh = true; return x; };
const firstN = (re, s, n) => { const out = []; re.lastIndex = 0; for (const m of s.matchAll(re)) { out.push(m); if (out.length >= n) break; } return out; };
const toks = (s) => s.match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu) || [];
// noktalı sayının önünde/ardında para ya da birim sözü: fiyat, saat değil (alınmayan saat satırı çıkmaz)
const MONEY_B = /(?:^|[^\p{L}])(?:dolar|euro|avro|sterlin|altın|altını|benzin|benzinin|motorin|mazot|fiyat\p{L}*|kur|kuru|borsa|endeks|faiz|enflasyon|zam|lira|tl|₺|\$|€|%)\s*$/u;
const MONEY_A = /^\s*(?:tl|₺|lira|liraya|liradan|dolar|euro|avro|\$|€|%|kuruş|puan|milyon|milyar|bin|kg|km|metre|derece|°)(?!\p{L})/u;
// alınmayan saat satırı yalnız saat bağlamında (11. tur): bulunma eki, ardından sularında/civarı/itibarıyla; ölçülü ondalık sayı değil
const LOC_SFX = /['’]?[ıiuü]?n?(?:da|de|ta|te)$/;
const CLOCK_A = /^\s*(?:sularında|sularinda|civarı|civari|civarında|civarinda|itibarıyla|itibariyle|itibaren)(?!\p{L})/u;
const MEASURE_A = /^\s*(?:büyüklüğünde|saniye\p{L}*|metre\p{L}*|santim\p{L}*|cm|mm|ortalama\p{L}*|ile|lira\p{L}*|kuruş\p{L}*|tl|km|kg|derece\p{L}*|puan\p{L}*|yüzde|%)(?!\p{L})/u;
const MEASURE_B = /(?:^|[^\p{L}])(?:ortalama\p{L}*|yüzde|boy\p{L}*|kilo\p{L}*|ağırlı\p{L}*|uzunlu\p{L}*|büyüklü\p{L}*|%)\s*$/u;
// saatin yan cümlesinde sayılmayan söz (şüphe denetimi): dolgu, yayın fiili, sahibin üretim/kurgu isteği, soru eki ("bunun benzerini hazırlar
// mısın 18:30'da paylaş")
const PROD_W = new RegExp(`^(?:yap|hazırla|üret|anlat|çiz|kes|kısalt|kırp|ekle|kullan|sil|özetle|çevir|kaldır)(?:y?[ıiuü]n(?:[ıiuü]z)?|y?[ıiuü]p|[aeıiuü]?r|s[ae]n[ae]|[ae]bilir|[ıiuü]ver)?$`);
const PUB_W = new RegExp(`^${PUB_ANY}$`); // yayın fiili sözü (herhangi biçimde)
// sahibin yayın isteğindeki zarf ve bağlaçlar ("18:30 için planla", "18:30'da tekrar paylaş", "17:00'de tüm platformlarda paylaş", "Cuma akşamı 8'de")
// sahibin hitabı da (14. tur: metnin geri kalanına bakılınca "Merhaba Emixhas. Cuma 13:05'te paylaş" şüpheli sayılıyordu)
const SIDE_W = /^(?:için|tekrar|mutlaka|hem|doğru|değil|şekilde|biçimde|artık|aynen|ayrıca|önce|bekle|akşamı|sabahı|gecesi|günü|platform\p{L}*|ve|ile|emixhas|jarvis|reis|usta|kardeşim|kardeş|canım|dostum|kanki|eyvallah)$/u;
const SIDE_OK = (w0) => { const w = w0.replace(/['’]\p{L}*$/u, ""); return FILLW.test(w) || FILL.has(w) || SIDE_W.test(w) || PROD_W.test(w) || PUB_W.test(w) || /^m[ıiuü]s[ıiuü]n(?:[ıiuü]z)?$/.test(w); };
// selamlama ve etiket öbekleri sıkı kuralda dolgu (uzunluk korunur: kesim asıl metinde)
// izleyiciye söz (yalnız şüphe); 13. tur: izleyici çağrısı da ("Bu videoyu Cuma 20:00'de paylaşın, takipte kalın", "Videonu Pazar 18:00'de
// yükle, kaçırmayın!" duyurusu şüphesiz cumaya/pazara planlanıyordu)
const VIEW_ALL = new RegExp(`(?<![${L}])(?:herkes|herkese|hepiniz|hepimiz|sizler|takipte\\s+kal[ıi]n|takip\\s+edin|abone\\s+olun|kaçırmay[ıi]n|`
  + `bildirim(?:ler)?i?\\s+aç[ıi]n|en\\s+(?:güzeli|iyisi)\\s+kazan[ıi]r|videonu(?:zu)?|hik[aâ]yen(?:iz)?(?:de|e)|story['’]?n(?:iz)?(?:de|e))${NL}`);
// ikinci yayın isteği (14. tur; yalnız şüphe): bağlayan fiilden başka istek biçiminde yayın fiili ("Cuma 20:00'de story at Lütfen paylaşın 🙏",
// "Cumartesi 12:00'de paylaşın! Hemen paylaş!"); bağlayan fiile yalnız virgül ya da ve/veya ile bağlı olan aynı istektir ("18:30'da yükle ve paylaş")
const PUB2 = new RegExp(`^(?:payla[şs]|yay[ıi]nla|yay[ıi]mla|g[öo]nder|y[üu]kle)${PUB_SFX}$`);
const COORD = /^[\s,]*(?:(?:ve|veya)[\s,]*)?$/;
const PHRASE_FILL = new RegExp(`(?<![${L}])(?:iyi\\s+akşamlar|kolay\\s+gelsin|sağ\\s+olun|son\\s+(?:dakika|dk))${NL}`, "g");
// METNİN GERİ KALANI (14. tur; inceleme, 21 Ekim: 13. turun şüphesi yalnız saatin yan cümlesine bakıyordu, "Cuma 20:00'de paylaş, çekilişe
// katıl", "Cumartesi 14:00 olsun, Taksim'de toplanalım", "bugün 19.30'da paylaşmayı unutma! yorumlara yaz", "📍 🗓 Cumartesi ⏰ 21:00'da"
// duyurusu şüphesiz alınıp başka güne planlanıyordu): bağlayan fiilin dışında metnin HERHANGİ bir yerinde dolgu dışı söz (SIDE_OK değil;
// selamlama ve teşekkür sayılmaz), saate bitişik olmayan gün sözü (gün adı, haftaya, öbür gün, tarih; yarın/bugün HEAD'in gün kuralıdır) ya
// da etkinlik kartı işareti varsa şüphe (yalnız şüphe: saat yine alınır, gün HEAD'in)
const COURTESY = new RegExp(`(?<![${L}])(?:sağ\\s+ol(?:un)?|eline\\s+sağlık|emeğine\\s+sağlık|iyi\\s+(?:günler|geceler|çalışmalar)|selam[üu]n\\s*aleyk[üu]m|aleyk[üu]m\\s*selam|saygılar(?:ımla)?|a?(?:ha){2,}h?|ah(?:ah)+|(?:js){2,}j?|xd+)${NL}`, "g");
const CARD = /[📍📅📆🗓⏰⏱⌚\u{1F550}-\u{1F567}]/u;
// 15. tur (inceleme, 21 Ekim; yalnız şüphe, gün HEAD'in): gün sözü HER biçimde — ardında hitap, teşekkür, "olsun", satır sonu ya da kesme
// işaretli ek ("Cuma lütfen 21:15'te paylaş", "21:15'te paylaş, Cuma teşekkürler", "Cuma'ya 18:30'a planla", "Cuma olsun, 18:30'da paylaş"
// şüphesiz alınıyordu; ad tamlaması kuralı yalnız günün seçimine bakar); 16. tur: yarın/bugün de (ekli ve Türkçe harfsiz yazımı da: "18:30'da
// paylaş, yarın değil", "yarin 18:30'da paylas" — HEAD Türkçe harfsiz "yarin"i görmez —; saate bitişik olan sayılmaz, gün yine HEAD'in)
const DAY_WORD = new RegExp(`(?<![${L}\\d])(?:(?:yar[ıi]n|bug[üu]n)[${L}]*|obur\\s?gun|haftaya|öbür\\s?gün|${DAYN}(?:['’][${L}]*|y?[ae]|y?[ıi]|n?[ıi]n|[dt][ae]n?|s[ıi])?|`
  + `\\d{1,2}\\s+(?:${MON.join("|")})(?:['’][${L}]*|[dt][ae]|y?[ae]|y?[ıi])?)${NL}`, "g");
// OLUMSUZ YAYIN SÖZÜ (16. tur; inceleme, 21 Ekim: 15. turun -mA/-mAyIn/-mAsIn/-mAyAlIm kalıbı dışındaki "paylaşmaaa", "paylaşmayız",
// "paylaşmayacağız", "yayınlamazsın", "atmayalım mı" saati sonraki yan cümlenin olumlu fiiline bağlayıp reddedilen güne şüphesiz planlanıyordu;
// 39.213 üretilmiş sahip mesajında 817): metnin HERHANGİ bir yerinde yayın kökü (paylaş, yayınla, yayımla, yükle, gönder, planla, at, koy,
// yayına al/koy/at/ver; edilgen -Il/-n de; Türkçe harfsiz yazım da) + olumsuz görünen -mA/-mI her biçimde (paylaşma, paylaşmaaa, paylaşmam,
// paylaşmaz, paylaşmadan, paylaşmıcaz, paylaşmıyoruz, paylaşılmasın, yayınlanmasın, atmayalım…); istek adı olumsuz değil: -mAk, -mAnI/-mAnIzI/
// -mAsInI/-mAyI + istiyorum/rica/unutma/lazım/gerek/şart ("paylaşmanı istiyorum", "paylaşmayı unutma"), -mAm/-mAn/-mAnIz/-mAmIz/-mAsI +
// lazım/gerek/şart, -mAlI, geçmiş -mIş
const NEG_OK = `(?:[ae]k|[ae](?:n[ıi](?:z[ıi])?|s[ıi]n[ıi]|y[ıi])\\s+(?:${WANT}|unut[${L}]*|rica[${L}]*|laz[ıi]m|gerek[${L}]*|[şs]art)|`
  + `[ae](?:m|n|n[ıi]z|m[ıi]z|s[ıi])\\s+(?:laz[ıi]m|gerek[${L}]*|[şs]art)|[ae]l[ıi]|[ıiuü]ş)`;
const NEG_PUB = new RegExp(`(?<![${L}])(?:payla[şs]|yay[ıi]nla|yay[ıi]mla|y[üu]kle|g[öo]nder|planla|at|koy|yay[ıi]na\\s+(?:al|koy|at|ver))`
  + `(?:[ıiuü]l|n)?m(?!${NEG_OK})[aeıiuü]`);
// yayın sözü, herhangi biçimde (olumsuz ve ad da: paylaşım, yükleme, gönderi; at/koy yalnız fiil ekleriyle): metinde birden çoksa şüphe
// ("Cuma 18:30'da yükle ve paylaş", "Cuma 20:00'de paylaşma, bugün paylaş"); yanında ret sözü — "sakın", "istemiyorum/istemem/istenmesin…",
// "gerek yok/gerekmez", "lazım değil" (60 karakter içinde) ya da hemen ardında "değil/olmaz/olmasın" — da şüphe
const PUB_WORD = new RegExp(`(?<![${L}])(?:(?:payla[şs]|yay[ıi]nla|yay[ıi]mla|y[üu]kle|g[öo]nder|planla)[${L}]*|yay[ıi]na\\s+(?:al|koy|at|ver)[${L}]*|`
  + `(?:at|koy)(?:[aıe]?r[${L}]*|s[ae]n[${L}]*|[ıi]n[${L}]*|[ae]bilir[${L}]*|[ıi]ver[${L}]*|[ıiuü]l[${L}]*|m[aeıiuü][${L}]*)?${NL})`, "g");
const NEG_NEAR = new RegExp(`(?<![${L}])(?:sak[ıi]n|iste(?:m(?:iyor|em|ez|eyiz|eyin|esin|eyece|edi)|nmiyor|nmez|nmesin)[${L}]*|`
  + `gerek(?:\\s+yok|mez|miyor)|laz[ıi]m\\s+de[ğg]il)${NL}`, "g");
const NEG_AFTER = new RegExp(`^\\s+(?:değil|diil|olmaz|olmas[ıi]n)${NL}`);
const pubNeg = (low) => {
  if (NEG_PUB.test(low)) return true;
  const ps = []; PUB_WORD.lastIndex = 0; let m;
  while ((m = PUB_WORD.exec(low))) { if (ps.push([m.index, PUB_WORD.lastIndex]) > 1) return true; }
  if (!ps.length) return false;
  const [a, z] = ps[0];
  if (NEG_AFTER.test(low.slice(z, z + 12))) return true;
  NEG_NEAR.lastIndex = Math.max(0, a - 60);
  while ((m = NEG_NEAR.exec(low)) && m.index <= z + 60) if (m.index + m[0].length >= a - 60) return true;
  return false;
};
const N_DAYS = new RegExp(`(?<![${L}\\d])(?:\\d{1,3}|bir|iki|üç|dört|beş|altı|yedi|sekiz|dokuz|on|birkaç)\\s*gün\\s+sonra${NL}`);

// sıkı kural: {first: kabul edilen ilk saat (9. tur sonucu), okAt: s yerindeki aday kabul edildi mi, ignored, dotted}
function strictWhen(t0, now, want) {
  // marka adı (büyük harfli "Instagram'a", "IG'ye", "Insta'ya" tr-TR küçük harfte ı): yalnız ı → i, uzunluk korunur (kesim asıl metinde)
  const low = t0.toLocaleLowerCase("tr-TR").replace(/ınsta/g, "insta").replace(new RegExp(`(?<![${L}])ıg(?![${L}])`, "g"), "ig")
    .replace(PHRASE_FILL, (x) => " ".repeat(x.length));
  // pencere: yan cümleyi aşmayan ~80 karakter (kelime ortasında kesilmez)
  const winA = (e) => { let b = Math.min(low.length, e + 80); while (b < low.length && b < e + 160 && /[\p{L}\p{N}]/u.test(low[b])) b++; const w = low.slice(e, b); const k = w.search(BOUND); return k < 0 ? w : w.slice(0, k); };
  const winB = (s) => { let a = Math.max(0, s - 80); while (a > 0 && a > s - 160 && /[\p{L}\p{N}]/u.test(low[a - 1])) a--; const w = low.slice(a, s); let k = -1; for (let i = w.length - 1; i >= 0; i--) if (BOUND.test(w[i])) { k = i; break; } return { w: w.slice(k + 1), a: a + k + 1 }; };
  const cands = [...firstN(REL, low, 20).map((m) => ({ m, rel: true })), ...firstN(ABS, low, 20).map((m) => ({ m, rel: false })),
    ...firstN(DAYH, low, 20).map((m) => ({ m: dayHour(m), rel: false }))]
    .sort((a, b) => a.m.index - b.m.index).slice(0, 20);
  const out = { first: null, okAt: false, ignored: "" };
  if (!cands.length) return out;
  // 15. tur (yalnız şüphe): metinde iki ya da daha çok saat (fiyat biçimli noktalı sayı — ek ve "saat" sözü olmayan "12.50" — saat sayılmaz;
  // "deprem 09:42'de … 19:00'da paylaş", "18:30'da değil 19:00'da paylaş" şüpheli, gün HEAD'in) ve "N gün sonra"
  // (aynı saatin iki adayı — dönemli "öğleden sonra 3'te" ve gün sözlü "Pazar … 3'te" — bir saattir: saatin bittiği yer tektir)
  const clocks = new Set();
  for (const { m, rel } of cands) {
    if (rel) continue;
    const h0 = Number(m[2] ?? m[4] ?? m[6]), mi0 = Number(m[3] ?? m[5] ?? m[7] ?? 0);
    if (!(h0 >= 0 && h0 <= 24 && mi0 >= 0 && mi0 <= 59)) continue;
    let ce = m.index + m[0].length - (m[8] ? m[8].length : 0); while (ce > m.index && /\s/.test(low[ce - 1])) ce--;
    const core = low.slice(m.index, ce);
    if (m[6] !== undefined && !core.includes(":") && !/(da|de|ta|te|['’]y?[ae])$/.test(core)) continue;
    clocks.add(ce);
    if (clocks.size > 1) break;
  }
  const multi = clocks.size > 1, nDays = N_DAYS.test(low);
  const dayM = low.match(H_DAY); // HEAD'in "yarın/bugün"ü (talimattan çıkarılır: strictPick)
  out.dayW = dayM ? dayM[1] : "";
  // tırnak içi (alıntı: "Annem: 'akşam 8'de gönder şu videoyu'", "'saat 12'de paylaş' dedim"); iki yanı harf/rakam olan kesme işareti ektir
  const quotes = [];
  { let open = -1; const q = /['’"“”‘«»]/g; let m, n = 0;
    while ((m = q.exec(low)) && n++ < 4000) {
      const i = m.index, a = low[i - 1] || " ", b = low[i + 1] || " ";
      if (/[\p{L}\p{N}]/u.test(a) && /[\p{L}\p{N}]/u.test(b)) continue;
      if (open < 0 && !/[\p{L}\p{N}]/u.test(a)) open = i;
      else if (open >= 0 && !/[\p{L}\p{N}]/u.test(b)) { quotes.push([open, i]); open = -1; }
    } }
  if (quotes.length) { let o = "", k = 0; for (const [a, b] of quotes) { o += low.slice(k, a) + " "; k = b + 1; } o += low.slice(k);
    if ((o.match(/\p{L}+/gu) || []).every((w) => FILL.has(w))) quotes.length = 0; }
  const quoted = (i) => quotes.some(([a, b]) => i > a && i < b);
  // metin yalnız saat + dolgu mu (metin başına bir kez; izleyiciye çoğul emir dolgu değil: "Saat 21:00 — paylaşın!"); ⟪…⟫ gizli konum
  const onlyFill = (low.replace(/⟪[^⟪⟫]*⟫/g, " ").replace(PUB_RE, (v) => (PLURAL.test(v) ? v : " ")).match(/\p{L}+/gu) || []).every((w) => FILL.has(w));
  // fiilden sonra gelen bekçiler: aktarma/amaç/soru/başkasının isteği, kesme işareti ya da tireyle ad, "paylaş butonu"
  const badAfter = (s) => /^['’-][\p{L}]/u.test(s) || /^\s+(?:buton|tuş|düğme)/u.test(s)
    || new RegExp(`^[\\s,.!?"'‘’“”«»]*(?:diye|de(?:r|rken|rsen|yince|yip|yerek|di|miş|niyor|nilen)[${L}]*|di(?:yor(?!u[mz]${NL})|yen|yecek|yerek)[${L}]*|`
      + `m[ıiuü]${NL}|(?:iste|isti)(?!yoru[mz]${NL}|rim${NL}|riz${NL})[${L}]*|çağrı[${L}]*|talep[${L}]*|talebi[${L}]*)${NL}`).test(s);
  // bağlanan fiil geçerli mi: v = fiil metni, s0/e0 = fiilin yeri, between = saatle fiil arasındaki metin, clause = yan cümle
  const verbOk = (v, s0, e0, between, clause) => {
    const nx = toks(low.slice(e0, e0 + 40))[0];
    if (badAfter(low.slice(e0, e0 + 40)) || quoted(s0)) return false;
    const stem = v.replace(/\s+/g, " ");
    // yalın "at"/"atın" ve "koy": ardından ad gelirse ad ("at arabası", "at binen", "at yarışı"); "göz at" deyim
    if (/^(?:at|atın|atınız|koy)$/.test(stem) && ((nx && !FILLW.test(nx) && !BOUND.test(low.slice(e0, e0 + 3)) && !/^\s*[,:(–—-]/.test(low.slice(e0, e0 + 3)))
      || /(?<![\p{L}])göz\s+$/u.test(low.slice(Math.max(0, s0 - 6), s0)))) return false;
    // yalın "zamanla" yalnız yan cümlenin sonunda fiil ("18:30'a zamanla"; "zamanla ısınacak" zarf)
    if (stem === "zamanla" && toks(winA(e0)).length) return false;
    if (PLURAL.test(stem)) { // izleyiciye çoğul emir: arada yalnız dolgu, tire yok, "-InIzI" nesnesi yok
      if (/[–—-]/.test(between) || !toks(between).every((w) => FILLW.test(w))) return false;
      if (new RegExp(`[${L}][ıiuü]n[ıiuü]z[ıiuü]${NL}`).test(clause)) return false;
    }
    return true;
  };
  // saatle fiil arası yalnız dolgu ("yarın 10'da bunu paylaş", "paylaş, yarın 10'da") ya da "-AcAk şekilde" ("yarın 10'da paylaşılacak şekilde
  // ayarla"): HEAD'in bulmadığı saat bu bağla da eklenir ("Yarın 10'da Kızılay'da buluşalım, paylaş!" değil)
  const ZARF = /^(?:şekilde|biçimde)$/;
  const tightGap = (ts) => ts.every((w, i) => FILLW.test(w) || (/[ae]c[ae]k$/.test(w) && ZARF.test(ts[i + 1] || "")) || (ZARF.test(w) && /[ae]c[ae]k$/.test(ts[i - 1] || "")));
  // saatin ardında (arada en çok 4 söz, çekimli fiil yok) ya da önünde istek biçiminde yayın fiili
  const linked = (s, e) => {
    const wa = winA(e), wb = winB(s), clause = wb.w + low.slice(s, e) + wa;
    PUB_RE.lastIndex = 0;
    for (const vm of wa.matchAll(PUB_RE)) {
      const between = wa.slice(0, vm.index), ts = toks(between);
      if (ts.length > GAP_W || finIn(ts) || CLOCK_IN.test(between)) break;
      if (verbOk(vm[0], e + vm.index, e + vm.index + vm[0].length, between, clause)) return { s: e + vm.index, ve: e + vm.index + vm[0].length, v: vm[0], direct: !ts.length, tight: tightGap(ts) };
    }
    const vs = [...wb.w.matchAll(PUB_RE)].filter((m) => m[0] !== "olsun").reverse();
    const tail = toks(wa.split(/[,()]/)[0]).slice(0, GAP_W); // saatten sonra yan cümlenin geri kalanı: "paylaş, olay 14:00'te oldu" değil
    if (finIn(tail)) return null;
    for (const vm of vs) {
      const between = wb.w.slice(vm.index + vm[0].length), ts = toks(between);
      if (ts.length > GAP_W || finIn(ts) || CLOCK_IN.test(between)) break;
      if (verbOk(vm[0], wb.a + vm.index, wb.a + vm.index + vm[0].length, between, clause)) return { s: wb.a + vm.index, ve: wb.a + vm.index + vm[0].length, v: vm[0], direct: !ts.length, tight: tightGap(ts) };
    }
    return null;
  };
  // saate bitişik gün sözü (ya da bağlanan fiilin hemen önündeki "yarın/bugün"): {off: gün farkı ya da tarih, a, b: kesilecek yer}
  const dayOf = (s, e, verbAt) => {
    const b0 = Math.max(0, s - 40), mb = low.slice(b0, s).match(DAY_BEFORE), ma = mb ? null : low.slice(e, e + 40).match(DAY_AFTER);
    const mv = mb || ma || verbAt === undefined ? null : low.slice(Math.max(0, verbAt - 20), verbAt).match(DAY_VERB);
    if (mb) return dayOfMatch(mb, b0 + mb.index, now);
    if (ma) return dayOfMatch(ma, e + ma.index, now);
    if (!mv) return null;
    const a = verbAt - mv[0].length, b = a + mv[0].length, w = mv[1].replace(/\s/g, "");
    return w === "yarın" ? { add: 1, a, b } : w === "bugün" ? { add: 0, a, b } : { add: 2, a, b };
  };
  // saati bağlayan söz zayıf mı (yalnız şüphe; kabulü değiştirmez): "olsun" saate bitişik değil ("haber olsun", "kısa olsun"; metin yalnız saat
  // + dolguysa değil), fiil -AlIm / etken -sIn ("paylaşalım", "herkes paylaşsın"), saatin yan cümlesinde (virgüle kadar) dolgu dışı söz
  // ("Cenaze namazı 15:30'da, paylaşalım", "Sabah 8'de Esenyurt'ta yangın, haber yap, paylaş"); b: {v, s, e, direct} ya da {fill}
  const side = (s, e0, b) => {
    const sx = /^['’][\p{L}]+/u.exec(low.slice(e0, e0 + 12)), e = e0 + (sx ? sx[0].length : 0); // saate bitişik ek ("18:30'dan", "8'e")
    let a = Math.max(0, s - 80), z = Math.min(low.length, e + 80);
    for (let i = s - 1; i >= a; i--) if (/[.!?;,\n]/.test(low[i])) { a = i + 1; break; }
    for (let i = e; i < z; i++) if (/[.!?;,\n]/.test(low[i])) { z = i; break; }
    // saatin yan cümlesi ve saatle bağlayan fiil arası; fiilin kendisi ve ardı sayılmaz ("Saat 14:30, Kadıköy, kaza, hemen paylaş" şüpheli;
    // "18:30'da yükle ama önce bana göster" değil)
    const vin = !!b && b.s !== undefined;
    const r0 = vin ? Math.min(a, b.e) : a; // saatten önceki fiil sayılmaz ("yayına al 18:30'da")
    const parts = vin && b.s >= e ? [low.slice(a, s), low.slice(e, b.s)]
      : vin && b.e <= s ? [low.slice(r0, Math.max(r0, b.s)), low.slice(Math.max(r0, b.e), s), low.slice(e, z)] : [low.slice(a, s), low.slice(e, z)];
    // "kadar" yalnız "bekle"den önce ("18:30'a kadar bekle sonra paylaş"); "18:00'e kadar paylaş, hayat kurtar" son tarihtir (şüpheli)
    const ts = toks(parts.join(" ").replace(/⟪[^⟪⟫]*⟫/g, " "));
    // istek fiilinin -(s)InI/-yI nesnesi de dolgu dışı sözdür (13. tur; inceleme, 20 Ekim: 12. turun nesne muafiyeti "Tahminini Cuma 20:00'de
    // paylaş", "Fotoğrafını saat 20:00'de paylaş, çekilişe katıl" altyazısını şüphesiz alıp cumaya planlıyordu): şüphe satırı alır, gün HEAD'in günü
    return !ts.every((w, i) => SIDE_OK(w) || (w === "kadar" && /^bekle/.test(ts[i + 1] || "")));
  };
  // izleyiciye söz ("2 saat sonra paylaşın, herkes uyanmış olsun", "Saat 20:00 olsun, herkes sokakta!"): yalnız şüphe
  const toAll = VIEW_ALL.test(low);
  // metnin geri kalanı (14. tur): ilk dört dolgu dışı sözün yeri ve ilk iki gün sözünün başı, metin başına bir kez (uzun girdide erken durur);
  // bağlayan fiilin içindeki söz ("paylaşmayı unutma", "paylaşmanı istiyorum") ve saate bitişik gün sözü sayılmaz
  const card = CARD.test(low);
  let hc0 = -1, hc1 = -1; // HEAD'in saatinin yan cümlesi (want yerinden noktalama/virgül/satır sonuna kadar)
  if (want >= 0) { hc0 = want; while (hc0 > 0 && !/[.!?;,\n]/.test(low[hc0 - 1])) hc0--; hc1 = want; while (hc1 < low.length && hc1 < want + 400 && !/[.!?;,\n]/.test(low[hc1])) hc1++; }
  let bad0 = null, days0 = null;
  const bads = () => {
    if (bad0) return bad0;
    bad0 = [];
    const sc = low.replace(/⟪[^⟪⟫]*⟫/g, (x) => " ".repeat(x.length)).replace(COURTESY, (x) => " ".repeat(x.length));
    const re = /[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu; let m;
    while (bad0.length < 4 && (m = re.exec(sc))) {
      // büyük harfle yazılan söz tr-TR küçük harfte ı alır ("MIZAH" → "mızah")
      if (SIDE_OK(m[0]) || SIDE_OK(m[0].replace(/ı/g, "i")) || (m[0] === "kadar" && /^\s+bekle/u.test(sc.slice(re.lastIndex, re.lastIndex + 12)))) continue;
      bad0.push([m.index, re.lastIndex]);
    }
    return bad0;
  };
  let pub0 = null;
  const pubs = () => {
    if (pub0) return pub0;
    pub0 = [];
    const sc = low.replace(/⟪[^⟪⟫]*⟫/g, (x) => " ".repeat(x.length));
    const re = /[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu; let m;
    while (pub0.length < 3 && (m = re.exec(sc))) if (PUB2.test(m[0]) && !quoted(m.index)) pub0.push([m.index, re.lastIndex]);
    return pub0;
  };
  const days = () => {
    if (days0) return days0;
    days0 = []; DAY_WORD.lastIndex = 0; let m;
    while (days0.length < 6 && (m = DAY_WORD.exec(low))) days0.push([m.index, m.index + m[0].length]);
    return days0;
  };
  // saate bitişik gün sözünün başı (headWhen adjDay ve sıkı kuralın dayOf'u gibi; yoksa -1)
  const adjA = (s, e) => {
    const b0 = Math.max(0, s - 48), mb = low.slice(b0, s).match(DAY_BEFORE_C);
    if (mb && !(mb.index === 0 && b0 > 0 && /[\p{L}\p{N}]/u.test(low[b0 - 1]))) return b0 + mb.index;
    const ma = low.slice(e, e + 48).match(DAY_AFTER);
    return ma ? e + ma[0].length - ma[0].trimStart().length : -1;
  };
  // kullanılan gün sözüne bitişik gün sözü de kullanılmıştır ("25 Ekim Pazar 11:00'de"); HEAD'in saatinden başka saatte (geçiş kuralı) HEAD'in
  // saatinin yan cümlesindeki gün sözü olayın anlatımıdır ("Cuma günü 13:00'te cenaze var, haberini yap, Perşembe 20:00'de paylaş")
  const otherDay = (s, e, da) => {
    const ds = days(); if (!ds.length) return false;
    const used = new Set([adjA(s, e), da]);
    const near = ([a, z], [b, y]) => (z <= b && /^[\s,]*$/.test(low.slice(z, b))) || (y <= a && /^[\s,]*$/.test(low.slice(y, a)));
    for (let k = 0; k < 2; k++) for (const d of ds) if (!used.has(d[0]) && ds.some((u) => used.has(u[0]) && near(d, u))) used.add(d[0]);
    return ds.some(([a, z]) => !used.has(a) && !(s !== want && a >= hc0 && z <= hc1));
  };
  // metnin herhangi bir yerinde olumsuz görünen yayın sözü ya da birden çok yayın sözü (16. tur; metin başına bir kez)
  let neg0 = null;
  const negPub = () => (neg0 ??= pubNeg(low));
  const weak = (s, e, b, da) => {
    if (!b) return false;
    if (card || multi || nDays || negPub() || otherDay(s, e, da)) return true;
    if (b.fill) return false;
    if (toAll) return true;
    const v = b.v.trim(), w = v.split(/\s+/).pop();
    if (v === "olsun") { if (!b.direct && !b.fillOk) return true; }
    else if (WE_THEY.test(w)) return true;
    // HEAD'in saatinden başka saatte (geçiş kuralı: "Tören 10:00'da başladı, öğlen 12'de paylaş") HEAD'in saatinin yan cümlesi olayın
    // anlatımıdır, sayılmaz
    if (bads().some(([a, z]) => !(b.s !== undefined && a >= b.s && z <= b.e) && !(s !== want && a >= hc0 && z <= hc1))) return true;
    if (v !== "olsun" && b.s !== undefined && pubs().some(([a, z]) => !(a >= b.s && z <= b.e) && !(s !== want && a >= hc0 && z <= hc1)
      && !COORD.test(a >= b.e ? low.slice(b.e, a) : z <= b.s ? low.slice(z, b.s) : "x"))) return true;
    return side(s, e, b);
  };
  // tight: fiil saate bitişik, arası yalnız dolgu ya da metin yalnız saat + dolgu (HEAD'in bulmadığı saat yalnız böyleyse eklenir)
  const take = (res, s, e, tight, b, da) => {
    const wk = weak(s, e, b, da);
    if (!out.first) { out.first = res; out.firstS = s; out.firstTight = tight; out.firstOlsun = !!b && !b.fill && b.v.trim() === "olsun"; out.firstWeak = wk; }
    if (s === want) { out.okAt = true; out.okWeak = wk; }
  };
  for (const { m, rel: isRel } of cands) {
    if (out.first && (want < 0 || m.index > want)) break;
    const s = m.index, e = s + m[0].length, verb = isRel ? m[3] : m[8];
    const ve = verb ? e - verb.length : e; // saatin kendi sonu (bitişik fiil hariç)
    if (isRel) {
      const n = m[1] === "bir" ? 1 : m[1] === "yarım" ? 0.5 : Number(m[1]);
      const ms = (m[2] === "saat" ? 3600000 : 60000) * n;
      if (!(ms > 0 && ms <= 7 * DAY) || quoted(s)) continue;
      const vs0 = verb ? ve + verb.length - verb.trimStart().length : -1;
      const own = !!verb && verbOk(verb.trim(), vs0, e, "", winB(s).w + low.slice(s, e) + winA(e));
      const lk = own ? null : linked(s, ve);
      if (!own && !lk && !onlyFill) continue;
      const at = new Date(now.getTime() + ms), r = cutSpans(t0, [[s, own ? e : ve]]);
      const b = own ? { v: verb.trim(), s: vs0, e, direct: true } : lk ? { ...lk, e: lk.ve, fillOk: onlyFill } : { fill: true };
      take({ at, rest: r, restNoDay: r, label: whenLabel(at, now), adj: true }, s, ve, own || (lk ? lk.tight : onlyFill), b);
      continue;
    }
    const period = m[1] || "";
    let h = Number(m[2] ?? m[4] ?? m[6]);
    const min = Number(m[3] ?? m[5] ?? m[7] ?? 0);
    if (!(h >= 0 && h <= 24 && min >= 0 && min <= 59)) continue;
    if (h === 24) h = 0;
    const explicitColon = m[6] !== undefined;
    const core = low.slice(s, ve).trim();
    // "12.50" fiyat da olabilir: dönemsiz/"saat"siz noktalı saat yalnız ek ("12.50'de") ya da yayın fiiliyle saat sayılır
    const price = explicitColon && !core.includes(":") && !/(da|de|ta|te|['’]y?[ae])$/.test(core);
    h = perHour(period, h);
    const clause = winB(s).w + low.slice(s, e) + winA(e);
    const vs0 = verb ? ve + verb.length - verb.trimStart().length : -1;
    const own = verb && !quoted(s) ? verbOk(verb.trim(), vs0, e, "", clause) : false;
    const lk = own || quoted(s) ? null : linked(s, ve);
    if (!own && !lk && !(onlyFill && !price && !quoted(s))) {
      // alınmayan saat (yanıtta tek satır) yalnız saat bağlamında: "saat N", dönem, bulunma eki ('da/'de/'ta/'te), ardından sularında/civarı/
      // itibarıyla ya da yanında yayın fiili; ölçülü/paralı sayı ("4.25 büyüklüğünde", "12.45 saniyelik", "9.58 ile", "47.20 TL") ve tırnak içi değil
      const af = low.slice(ve, ve + 24), bf = low.slice(Math.max(0, s - 24), s);
      const clock = m[4] !== undefined || !!period || LOC_SFX.test(core) || CLOCK_A.test(af) || pubNear(low, s, ve);
      if (!out.ignored && clock && !m.dayh && !quoted(s) && !MEASURE_A.test(af) && !MEASURE_B.test(bf) && !MONEY_A.test(af) && !MONEY_B.test(bf)) out.ignored = `${pad(h)}:${pad(min)}`;
      continue;
    }
    const d = dayOf(s, ve, own ? vs0 : lk ? lk.s : undefined);
    const spans = [[s, own ? e : ve]];
    const restNoDay = cutSpans(t0, spans);
    if (d) spans.push([d.a, d.b]);
    const base = new Date(now); base.setSeconds(0, 0);
    const rest = cutSpans(t0, spans);
    let at;
    if (d) at = atDay(base, d.per && !period ? perHour(d.per, h) : h, min, d, now);
    else {
      at = new Date(base); at.setHours(h, min, 0, 0);
      if (!period && !explicitColon && h >= 1 && h <= 12) {
        // dönemsiz "saat 8": bugünün en yakın gelecekteki 08:00 ya da 20:00'ı
        const a = new Date(at), b = new Date(at); b.setHours(h === 12 ? 12 : h + 12);
        const cs = [a, b].filter((x) => x > now).sort((x, y) => x - y);
        at = cs[0] || (() => { const x = new Date(a); x.setDate(x.getDate() + 1); return x; })();
      } else {
        if (period === "gece" && h < 6 && at <= now) at.setDate(at.getDate() + 1);  // "gece 1" → bu gece
        if (at <= now) at.setDate(at.getDate() + 1);  // geçmişte kalan saat: yarın
      }
    }
    const b = own ? { v: verb.trim(), s: vs0, e, direct: true } : lk ? { ...lk, e: lk.ve, fillOk: onlyFill && !price } : { fill: true };
    take({ at, rest, restNoDay, label: whenLabel(at, now), adj: !!d }, s, ve, own || (lk ? lk.tight : true), b, d ? d.a : undefined);
  }
  return out;
}

// sıkı kuralın aldığı saat (yalnız HEAD'in saati yokken ya da geçişte şüphesizken; 16. tur, inceleme, 21 Ekim: şüpheli yolda HEAD'in gün kuralı
// sıkı kuralın saatiyle karışıyordu — "Bugün 15:00'te kaza oldu, yarın 9'da paylaş" metindeki "bugün"le bugün 09:00, geçmiş saat, hemen yayın):
// günü YALNIZ saatin kendi bitişik gün sözü (ya da bağlanan fiilin hemen önündeki "yarın/bugün"); yoksa günsüz saat — bugün, dönemsiz yalın saat
// en yakın 08:00/20:00, geçmiş saat yarına (HEAD'in günsüz saat kuralı). Bitişik olmayan "yarın/bugün" günü değiştirmez, şüphe satırı getirir;
// HEAD'in gün kuralının "yarın/bugün"ü yine talimattan çıkar (14. tur: "<link> yarın 10'da paylaş MIZAH 👍" talimatında kalan "yarın" tür
// etiketini bozuyordu). Şüpheli saat geçmişte kalmaz: "Yarın paylaş, bugün 9'da paylaşma" saat 10'da bugün 09:00 olup hemen yayınlanıyordu,
// geçmiş an ertesi güne geçer (HEAD'in günsüz geçmiş saat kuralı; şüphe satırı kalır, sahip iptal edebilir)
const strictPick = (st, now) => {
  const at = new Date(st.first.at);
  if (st.firstWeak) while (at <= now) at.setDate(at.getDate() + 1);
  const rest = st.first.adj ? st.first.rest : st.dayW ? st.first.restNoDay.replace(new RegExp(`(^|\\s)${st.dayW}(?=\\s|$)`, "i"), " ").replace(/\s+/g, " ").trim() : st.first.restNoDay;
  return { at, rest, label: whenLabel(at, now), doubt: st.firstWeak };
};
export function parseWhen(text, now = new Date()) {
  const t0 = String(text || "");
  const head = headWhen(t0, now);
  if (head?.at) {
    const st = strictWhen(t0, now, head.s);
    // HEAD ilk saati alır; o saat sıkı kurala göre şüpheliyken sıkı kural başka bir saati bitişik yayın isteğiyle alıyorsa o saat yayın saatidir
    // ("Tören 10:00'da başladı, öğlen 12'de paylaş", "Dün akşam 20:00'de yangın çıktı, yarın 10'da paylaş"; 10. tur) — HEAD'in saatinin
    // bitişiğinde herhangi biçimde yayın fiili varsa ya da öbür saati yalnız "olsun" bağlıyorsa değil ("bunu 18:30'da paylaşırsın, maç
    // 20:00'de olsun" → 18:30; 11. tur)
    // 16. tur: geçiş yalnız şüphesizse; şüpheliyse HEAD'in bütün sonucu (saati VE günü, karışım yok)
    if (!st.okAt && st.first && st.firstTight && st.firstS !== head.s && !head.pub && !st.firstOlsun) {
      if (!st.firstWeak) return strictPick(st, now);
      return { at: head.at, rest: head.rest, label: whenLabel(head.at, now), doubt: true };
    }
    // saate bitişik gün sözü yalnız şüphesiz saatte (sıkı kural saati zayıf olmayan bağla aldı); şüpheli saatte HEAD'in günü ve gün sözü talimatta
    // kalır (11.-12. tur; inceleme, 20 Ekim: "Cumartesi 20:00'de Harbiye'de konser, yarın paylaş", "<haber linki> 18:30'da Cuma maçının haberini
    // paylaş" şüpheli saati başka güne taşıyıp onaysız yayınlıyordu)
    const use = st.okAt && !st.okWeak && head.adj ? head.adj : head;
    return { at: use.at, rest: use.rest, label: whenLabel(use.at, now), doubt: !st.okAt || st.okWeak };
  }
  // HEAD saat bulamadı: yalnız sıkı kuralın bitişik ya da araya yalnız dolgu giren yayın fiiliyle ("yarın 10'da paylaş", "yarın 10'da bunu
  // paylaş", "dolar 12.50 oldu, 18:30'da yükle") ya da metin yalnız saat + dolguyken ("Cuma 9'da") aldığı saat; arası söz dolu bağ ("Yarın
  // 10'da Kızılay'da buluşalım, paylaş!" altyazısı) HEAD gibi saat sayılmaz. Yoksa alınmayan saat bağlamlı saat (yanıttaki satır)
  const st = strictWhen(t0, now, -1);
  if (st.first && st.firstTight) return strictPick(st, now);
  return { at: null, rest: t0, label: "", doubt: false, ...(st.ignored ? { ignored: st.ignored } : {}) };
}
