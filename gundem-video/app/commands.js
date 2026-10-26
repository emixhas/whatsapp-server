import { parseWhen } from "./when.js";
// Türkçe sesli komutları kural tabanlı çözer. LLM yok, token yok.
const NUM = { "on beş": 15, onbeş: 15, yirmi: 20, otuz: 30, "kırk beş": 45, kırkbeş: 45, kırk: 40, elli: 50, altmış: 60, yetmiş: 70, seksen: 80, doksan: 90, yüz: 100, "yüz yirmi": 120, "bir dakika": 60, "iki dakika": 120, "bir buçuk dakika": 90 };

// Türkçe küçük harfte "Instagram" → "ınstagram" olur; marka adı düzeltilir ki kurallar yakalasın
const norm = (s) => s.toLocaleLowerCase("tr-TR").replace(/ınsta/g, "insta").replace(/[.,!?']/g, " ").replace(/\s+/g, " ").trim();

function extractSeconds(t) {
  const m = t.match(/(\d{2,3})\s*(saniye|sn)/);
  if (m) return Number(m[1]);
  const d = t.match(/(\d)\s*dakika/);
  if (d) return Number(d[1]) * 60;
  for (const [w, n] of Object.entries(NUM).sort((a, b) => b[0].length - a[0].length)) if (t.includes(w)) return n;
  return null;
}
function extractHours(t) {
  const m = t.match(/(\d{1,2})\s*saat/);
  if (m) return Number(m[1]);
  for (const [w, n] of Object.entries({ bir: 1, iki: 2, üç: 3, dört: 4, beş: 5, altı: 6, sekiz: 8, on: 10, "on iki": 12 }))
    if (t.includes(`${w} saat`)) return n;
  return null;
}

// JS'de \b Türkçe harflerle çalışmaz; kelime sınırı için boşluk/satır başı-sonu kullanılır.
const STRIP_WORDS = ["emixhas", "emiks has", "emiks", "youtube", "yutup", "yutub", "dan", "da", "tan", "ta", "git", "gidip", "şu", "bu", "şarkıyı", "şarkısını", "şarkı", "parçayı", "parçasını", "parça", "müziğini", "müziği", "müzik", "videosunu", "videoyu", "video", "klibini", "klibi", "klip", "aç", "açar mısın", "çal", "çalar mısın", "oynat", "başlat", "lütfen", "hemen", "bana", "bir", "tane", "isimli", "adlı"];
const extractQuery = (t) => {
  let q = " " + t.replace(/[:;]/g, " ") + " ";
  for (const w of STRIP_WORDS.sort((a, b) => b.length - a.length)) q = q.split(" " + w + " ").join(" ");
  return q.replace(/\s+/g, " ").trim();
};

// Video sitesi linkleri (kullanıcı isteği, 18 Ekim: "attığım youtube haber linklerini de alsın"). WhatsApp'ta "youtu.be/…",
// "www.youtube.com/watch?v=…", "instagram.com/reel/…" çoğu zaman https:// olmadan gelir: bilinen video sitelerinde şemasız adres de
// link sayılır ve https:// ile tamamlanır (önünde harf/nokta/@ olan "notyoutube.com" ya da e-posta değil). Şemasız adres yalnız video,
// kanal ya da oynatma listesi adresiyse link sayılır ("instagram.com/hesap" gibi diğerleri eskisi gibi düz metin).
const VIDEO_HOSTS = String.raw`(?:[\w-]+\.)*(?:youtube\.com|youtu\.be|youtube-nocookie\.com|instagram\.com|tiktok\.com|x\.com|twitter\.com|facebook\.com|fb\.watch)`;
const LINK_RE = new RegExp(String.raw`https?:\/\/[^\s<>"'’]+|(?<![\w.@\/-])` + VIDEO_HOSTS + String.raw`\/[^\s<>"'’]*`, "i");
// videosu indirilip kurgulanan paylaşımlar; YouTube'da canlı yayın (/live/, kanalın /@kanal/live sayfası), gömülü oynatıcı (/embed/,
// youtube-nocookie.com/embed/) ve klip (/clip/) de video linkidir (eskiden haber sayfası sanılıp okunamıyordu)
const SOCIAL_RE = /^https?:\/\/([\w-]+\.)*(instagram\.com\/(reels?|p|tv)\/|tiktok\.com\/|(x|twitter)\.com\/[^/\s]+\/status\/|youtube\.com\/(shorts\/|watch|live\/|embed\/|v\/|clip\/)|youtube-nocookie\.com\/embed\/|youtu\.be\/|facebook\.com\/(reel|watch|share|[^/\s]+\/videos)|fb\.watch\/)/i;
const YT_LIVE_TAB = /^https?:\/\/([\w-]+\.)*youtube\.com\/(@[^/?#\s]+|(channel|c|user)\/[^/?#\s]+)\/live\/?([?#]|$)/i;
const YT_CHANNEL = /^https?:\/\/([\w-]+\.)*youtube\.com\/(@|(channel|c|user)\/)/i;
const YT_PLAYLIST = /^https?:\/\/([\w-]+\.)*youtube\.com\/playlist\b/i;
const YT_OTHER = /^https?:\/\/([\w-]+\.)*(youtube\.com|youtu\.be)(\/|$)/i;
const PLATFORM = [[/instagram\.com/i, "Instagram"], [/tiktok\.com/i, "TikTok"], [/(^|\.)(x|twitter)\.com/i, "X"], [/youtube|youtu\.be/i, "YouTube"], [/facebook\.com|fb\.watch/i, "Facebook"]];
const VIDEO_ASK = "haberin video linkini gönderin (videoda Paylaş → Kopyala: youtu.be/… ya da youtube.com/watch?v=…)";
// şemasız TikTok adresi yalnız video yoluysa link (inceleme, 18 Ekim: düz metindeki "tiktok.com/@hesap" profil sayfası video indirmeye gidiyordu)
const TT_VIDEO = /^https?:\/\/(?:(?:vm|vt)\.tiktok\.com\/[\w-]|([\w-]+\.)*tiktok\.com\/(@[^/?#\s]+\/(video|photo)\/|t\/|v\/|embed\/))/i;
// Mesajdaki ilk link: {raw: yazıldığı gibi, url: https:// ile tamamlanmış ve sondaki noktalama atılmış}; yoksa null.
// WhatsApp biçimi de atılır: *kalın*, ~üstü çizili~ (sondaki * ~), _italik_ (sondaki _ yalnız link _ ile başlıyorsa; kısa kodun son harfi olabilir).
export function findLink(text) {
  const s = String(text || ""), m = s.match(LINK_RE);
  if (!m) return null;
  let url = (/^https?:\/\//i.test(m[0]) ? m[0] : "https://" + m[0]).replace(/[).,;:!?*~]+$/, "");
  if (s[m.index - 1] === "_") url = url.replace(/[_).,;:!?*~]+$/, "");
  if (!/^https?:\/\//i.test(m[0])) {  // şemasız: yalnız video, kanal ya da oynatma listesi adresi ("youtube.com/feed/trending" düz metin)
    const v = videoLink(url);
    if (!v || !["video", "channel", "playlist"].includes(v.kind) || (v.platform === "TikTok" && !TT_VIDEO.test(url))) return null;
  }
  // linke bitişik tür etiketi (kullanıcı isteği, 19 Ekim: "linki verirken link/mizah ya da link/trend yazayım"): video adresinden ayrılır
  // (yt-dlp "watch?v=ID/mizah" adresini indiremez), `tag` olarak döner; çağıran türü ayrı alan (`kind`) olarak taşır. Büyük harf ve
  // harfsiz yazım ("/MIZAH": tr-TR küçük harfte ı) ve bitişik "#mizah" da (uzunluk değişmez, tm.index asıl adreste doğru yeri keser)
  const tm = url.toLocaleLowerCase("tr-TR").replace(/ı/g, "i").match(/[/#]+(mizah|komik|trend|viral|haber)\/*$/);
  if (tm && videoLink(url.slice(0, tm.index))?.kind === "video") return { raw: m[0], url: url.slice(0, tm.index), tag: tm[1] };
  return { raw: m[0], url, tag: "" };
}
// Tür etiketi → video türü (linke bitişik "/mizah" ya da linkin yanında yalnız "mizah", "#trend", "haber"; serbest cümledeki kelime değil:
// "trende yangın", "şakalaşırken" haberi viral/mizah olmasın — inceleme, 19 Ekim). {kind, rest}: rest'ten etiket kelimesi atılır.
// (prototipsiz nesne: "constructor", "tostring" gibi kelimeler etiket sanılmasın; Python `in` ile aynı sonuç)
const KIND_TAG = Object.assign(Object.create(null), { mizah: "mizah", mizahi: "mizah", komik: "mizah", trend: "trend", viral: "trend", haber: "haber" });
// olumsuz fiil eki (katlanmış metinde fiil kökünden hemen sonra; scripts/common.py VERB_NEG aynı kalıp, server.js de kullanır): yapma,
// yapmayın(ız), yapmasın, yapmasana, yapmadan, yapmaz, yapmam(alı), yapmayan, yapmayız, yapmayacak (yapmayacaz/yapmayacam), yapmayalım,
// yapmıyor, yapmıcaz/yapmıycaz/yapmıcan (konuşma dili; inceleme, 19 Ekim); "yapmak", "yapmasını" istek
export const VERB_NEG = String.raw`m(?:[ae](?:yin(?:iz)?|sin|s[ae]n[ae]|d[ae]n|z|m(?:[ae]li)?|y[ae]n|y[iu]z|y[ae]c[ae][kgmnz]\p{L}*|y[ae]lim)?(?!\p{L})|[iu](?:yor|y?c[ae][kgmnz])\p{L}*)`;
// etiketin yanında sayılan dolgu: süre birimi, lütfen/olarak/bunu/şunu, yayın fiili — olumsuzu değil ("mizah olarak paylaşma" etiket
// değil; inceleme, 19 Ekim) —, teşekkür ve selamlama (12. tur; inceleme, 20 Ekim: saati kesilen "mizah olarak 20.15'te yükleyin teşekkürler"
// türünü kaybediyordu), hitap (14. tur: HEAD'in kestiği "abi mizah 18:30'da paylaşılacak" fiilinden sonra "abi mizah" etiket). server.js
// contentKindOf ve scripts/common.py _KIND_FILL aynı kural
export const KIND_FILL = new RegExp(String.raw`^(?:saniye|saniyelik|sn|dakika|dakikalik|dk|lutfen|olarak|bunu|sunu|at|atar|misin|`
  + String.raw`tesekkur(?:ler)?|tsk(?:ler)?|sagol(?:un)?|saol(?:un)?|eyvallah|selam(?:lar)?|merhaba|gunaydin|abi|abla|kanka|hocam|reis|usta|emixhas|`
  + String.raw`(?:paylas|yayinla|yayimla|gonder|yukle)(?!${VERB_NEG})\p{L}*)$`, "u");
// haber dışındaki etiketin (mizah/komik/viral/trend) yanında "yap"/"olsun" da dolgu: "mizah yap", "komik yapar mısın", "trend olsun", "haber
// yapma mizah yap" (inceleme, 19 Ekim; "haber yap" zaten haber isteği, etiket sayılmaz; "viral olsun" kayıp çocuk/yardım çağrısıdır: "Paylaşın
// viral olsun 🙏" etiket değil). scripts/common.py _KIND_DO, server.js aynı kural
export const KIND_DO = /^(?:yap(?:in(?:iz)?|sana|alim|sin|ar|abilir)?|olsun)$/u;
// (server.js kindFold ve scripts/common.py kind_fold ile aynı: şapkalı â/î/û da; uzunluk korunur, kesim asıl metinde)
const kfold = (x) => String(x || "").toLocaleLowerCase("tr-TR").replace(/[ıöçşüğâîû]/g, (c) => ({ ı: "i", ö: "o", ç: "c", ş: "s", ü: "u", ğ: "g", â: "a", î: "i", û: "u" })[c]);
// başta ayraçla etiket (tagKind; scripts/common.py _KIND_LEAD ve server.js KIND_LEAD aynı kural, istek fiili kökleri server.js ASK_V ile aynı);
// başlık biçimli iki nokta yalnız kısa metinde (ardından en çok 4 kelime, kesme işaretli ek aynı kelime: "#trend: sesi kalsın"; inceleme,
// 19 Ekim: linkin yanına yapıştırılan "Trend: Gençler arasında yayılan tehlikeli akım iki can aldı" viral video oluyordu)
const LEAD_ASK_V = String.raw`(?:anlat|yap|hazirla|uret|sun(?!un(?![a-z]))|yaz|paylas|kurgula|ver|yayinla|yayimla|goster|cek|at|gonder|yukle|isle|seslendir|oku|cevir|donustur|olustur|canlandir|tasarla|ciz|koy(?!un(?![a-z]))|ekle|kullan|tut|ozetle|duzenle)`;
const LEAD_WORD = String.raw`\p{L}+(?:['’]\p{L}+)*(?!\p{L}|['’]\p{L})`;
const LEAD_RE = new RegExp(String.raw`^\s*#?(mizah|mizahi|komik|trend|viral|haber)\s*(?:[,;\-–/]|:(?=(?:(?:(?!\p{L})[\s\S])*${LEAD_WORD}){0,4}(?:(?!\p{L})[\s\S])*$))`
  + String.raw`(?!\s*#?(?:mizah|mizahi|komik|trend|viral|haber)(?!\p{L})`
  + String.raw`(?!\s+(?:gibi|seklinde|tarzinda|formatinda|diliyle|olarak|amacli|olsun|(?:video|icerik|paylasim|${LEAD_ASK_V})\p{L}*)(?!\p{L})))\s*`, "u");
// gülme işareti (server.js LAUGH, common.py _LAUGH aynı kalıp; kfold'lu metinde)
const LAUGH = new RegExp(String.raw`[😂🤣😹😆😅😁😄😝🤪🙈🤭😜😛😀😃🙃💀]|(?<!\p{L})(?:a?(?:ha){2,}h?|ah(?:ah)+|(?:js){2,}j?|(?:sj){2,}s?|(?:kd){2,}k?|(?:ks){2,}k?|xd+|:d+)(?!\p{L})`, "u");
export function tagKind(tag, rest) {
  if (KIND_TAG[kfold(tag)]) return { kind: KIND_TAG[kfold(tag)], rest };
  // başta ayraçla yazılmış etiket: "mizah, kısa kes", "#trend: sesi kalsın" (kfold uzunluğu korur: kesim asıl metinde); ardından başka
  // yalın etiket gelirse seçim açık bırakılmıştır ("haber, mizah, viral fark etmez sen seç", "haber/mizah sen karar ver"), etiket değil;
  // ikinci etiket ifadenin başıysa ("mizah, haber gibi anlat", "mizah, komik video yapma") baştaki etiket geçer (common.py _KIND_LEAD aynı)
  // "Haber: Kedi itfaiyeyi alarma geçirdi 😂" (gülmeli kısa başlık) baştaki etiket değil (9. tur; server.js contentKindOf aynı kural)
  const lead = kfold(rest).match(LEAD_RE), laugh = LAUGH.test(kfold(rest));
  if (lead && !(lead[1] === "haber" && lead[0].includes(":") && laugh)) return { kind: KIND_TAG[lead[1]], rest: String(rest).slice(lead[0].length) };
  // yalnız etiket: "mizah", "#trend", "_viral_" (haber > mizah > trend); yanında yalnız yayın fiili, süre ya da dolgu kelimesi de
  // olabilir: "mizah 18:30'da paylaş", "trend 40 saniye", "bunu mizah olarak paylaş" (inceleme, 19 Ekim); haber dışındaki etiketin
  // yanında "yap"/"olsun" da ("mizah yap", KIND_DO). Etiket atılır, süre kalır.
  const f = kfold(rest), words = f.match(/[\p{L}]+/gu) || [], soft = !words.includes("haber") && !(words.includes("viral") && words.includes("olsun"));
  const fill = (w) => KIND_FILL.test(w) || (soft && KIND_DO.test(w));
  if (words.some((w) => KIND_TAG[w]) && words.every((w) => KIND_TAG[w] || fill(w))) {
    const ks = new Set(words.filter((w) => KIND_TAG[w]).map((w) => KIND_TAG[w]));
    let out = "", at = 0;
    for (const m of f.matchAll(/[#_*]*(\p{L}+)[_*]*/gu)) if (KIND_TAG[m[1]] || (soft && KIND_DO.test(m[1]))) { out += String(rest).slice(at, m.index) + " "; at = m.index + m[0].length; }
    out = (out + String(rest).slice(at)).replace(/\s+/g, " ").trim();
    const left = kfold(out).match(/[\p{L}\d]+/gu) || [];
    if (ks.has("mizah") && laugh) ks.delete("haber"); // "😂 #komik #haber" mizah (9. tur)
    return { kind: ks.has("haber") ? "haber" : ks.has("mizah") ? "mizah" : "trend", rest: left.every(fill) ? "" : out };
  }
  return { kind: "", rest };
}
// Link türü: {kind: "video" | "channel" | "playlist" | "page", platform, url, reply?}; video sitesi değilse null.
// YouTube kanal/oynatma listesi/diğer sayfa haber videosu değildir: haber sayfası gibi okunmaya çalışılmaz, Türkçe yanıt verilir.
export function videoLink(url) {
  url = String(url || "").trim();
  const platform = (PLATFORM.find(([re]) => re.test(url.replace(/^https?:\/\//i, "").split("/")[0])) || [])[1];
  if (!platform) return null;
  if (SOCIAL_RE.test(url) || YT_LIVE_TAB.test(url)) return { kind: "video", platform, url };
  if (YT_PLAYLIST.test(url)) return { kind: "playlist", platform, url, reply: `Bu bir YouTube oynatma listesi linki; ${VIDEO_ASK}.` };
  if (YT_CHANNEL.test(url)) return { kind: "channel", platform, url, reply: `Bu bir YouTube kanal linki; ${VIDEO_ASK}. Kanalın canlı yayını için kanal adresinin sonuna /live ekleyin (youtube.com/@kanal/live).` };
  if (YT_OTHER.test(url)) return { kind: "page", platform, url, reply: `Bu bir YouTube sayfası, video linki değil; ${VIDEO_ASK}.` };
  return null;
}
// Videodaki konum (kullanıcı isteği, 18 Ekim; uzun YouTube videosunda hangi bölümün alınacağı, scripts/social_video.py okur):
// "12:30'dan itibaren", "12:30'daki", "1:02:10", "12:30-16:00 arası", "12:30'dan 16:00'ya kadar" yayın saati değildir: parseWhen'e
// gitmeden gizlenir, talimatta kalır. Eksiz "18:30", "18:30'da", "saat 18:30'dan itibaren paylaş" ve "18:30'dan sonra/itibaren
// paylaş|yayınla|gönder|yükle|yayına al|atar mısın" eskisi gibi yayın saati. Konum yalnız YouTube'da ayrılır (social_video.py yalnız
// orada bölüm seçer); Instagram/TikTok/X'te "18:30'dan itibaren paylaş" eskisi gibi yayın saati (inceleme, 18 Ekim).
const TS = String.raw`\d{1,2}(?:[:.]\d{2}){1,2}`;
const POS_RE = new RegExp(String.raw`(?<![\d.:])(?<!saat\s)(?:${TS}\s*['’]?\s*(?:d[ae]n|t[ae]n)\s+${TS}\s*['’]?\s*y?[ae]\s+kadar|${TS}\s*['’]?\s*(?:d[ae]n|t[ae]n)?\s*(?:[-–—]|ile)\s*${TS}|${TS}\s*['’]?\s*(?:d[ae]n|t[ae]n|d[ae]ki|t[ae]ki)(?![\p{L}])(?!\s+(?:sonra|itibaren)\s+(?:paylaş|yayın|yayım|gönder|yükle|at(?:ar|ır|ın|sın|sana|abilir)?(?![\p{L}])))|\d{1,2}:\d{2}:\d{2})(?!\d)`, "giu");
// Yayın saati (when.js parseWhen: HEAD'in aldığı saat; yayın isteğiyle yazılmamışsa doubt — yanıtta "olayın saatiyse…" satırı); konum ⟪…⟫ ile gizlenir
const whenKeepingPositions = (text, keep = true) => {
  const saved = [];
  const masked = keep ? text.replace(POS_RE, (m) => { saved.push(m); return `⟪POS${String.fromCharCode(65 + saved.length - 1)}⟫`; }) : text;
  const w = parseWhen(masked);
  // linke bitişik ek ("youtu.be/…'yi haber yap") talimata girmez
  return { ...w, rest: w.rest.replace(/⟪POS([A-Z])⟫/g, (_, c) => saved[c.charCodeAt(0) - 65] ?? "").replace(/^\s*['’]\p{L}{0,6}(?=\s|$)/u, "") };
};
// LİNKTE AÇMA (11.-13. tur; inceleme, 20 Ekim: 8-10. turların yeni kural takımları her turda sahibin HEAD'de açılan isteklerinden bir aileyi —
// "aç, annem de görsün", "şunu aç, tam ekran yap", "Kim haklı, zaman gösterir" altyazısı… — ters çeviriyordu; haber linki üretilirse ONAYSIZ
// yayınlanır, yanlış açma yalnız tarayıcıyı açar). YAPI: karar HEAD'in (c0937ab) kendi kuralıdır (headOpen, birebir); yeni kod HEAD'den yalnız
// adı konmuş istisnalarla ayrılır.
// - HABER SAYFASI LİNKİ (video/sosyal medya linki olmayan her link: anlık yol; 13. tur, inceleme, 20 Ekim: istisnalar sahibin "aç dediler,
//   açsana", "aç diye sana gönderdim", "aç, haber yapalım mı?" isteğini üretip onaysız yayınlıyordu): açılır = HEAD açar || ONLY2, İSTİSNA YOK.
//   Bilerek kabul: "<haber linki> Aç kalan köpeklere mama dağıtıldı", "<haber linki> bu haberi göster, haber yap" HEAD gibi açılır (sahip
//   "haber yap" diye yeniden gönderir; yanlış üretim onaysız yayındır).
// - VİDEO LİNKİ (üretim onay ister): açılır = (HEAD açar && (bir yan cümlesi kendi başına tam açma isteği || istisna yok)) || ONLY2.
// - ONLY2 (ekleme): HER link türünde (HEAD yalnız video linkinde; "şunu açar mısın <haber linki>" üretilip yayınlanıyordu) linkin dışında yalnız
//   açma isteği: aç/göster/oynat/çal'ın emir, kibar ve soru biçimleri (aç, açar mısın, açsana, açıver, açın, açabilir misin, gösterir misin,
//   oynatır mısın, çal…), tekrarlı da, ve yalnız dolgu (şunu, bunu, şu, bu, linki, videoyu, sayfayı, lütfen, hemen, abi, kanka, reis, hadi, bi,
//   bir, bakalım, şimdi, da/de, bana, Safari'de, tarayıcıda, telefonda, YouTube'da; emoji, noktalama); Türkçe harfsiz yazım da ("sunu acar misin");
//   14. tur: selamlama, teşekkür, hitap (selam, merhaba, teşekkürler, sağ ol, acaba, kardeşim, acil, Emixhas…) ve sahibin birinci tekil amaç sözü
//   ("açar mısın, okuyacağım", "aç bakayım") da dolgu (haber linkinde açılmayan istek anlık video olup onaysız yayınlanıyordu).
// - YAN CÜMLE AÇMA İSTEĞİ (13. tur, video linkinde): linkin dışındaki metnin bir yan cümlesi (noktalama, satır sonu ya da ve/sonra/ama/ancak/
//   fakat/veya/yoksa ile ayrılan) kendi başına ONLY2 ise istisnalar sayılmaz ("aç dediler, açsana", "aç diye sana gönderdim, açar mısın"); E2'nin
//   "aç ve/veya susuz" sıfatı bağlaçla bölünmez.
// - İSTİSNA (HEAD açar, üretilir; YALNIZ video linkinde), yalnız bunlar:
//   E1 üretim isteği, server.js tanıyıcılarıyla (useDetectors) linkin dışındaki metinde, YALNIZ hiçbir aç/göster kendi yan cümlesinde tam bir açma
//      isteği değilse (12. tur; inceleme, 20 Ekim: "<haber linki> aç, haber yapalım mı?", "son dakika, aç bakalım", "haber yap demedim, aç"
//      üretilip onaysız yayınlanıyordu): açma sözünün solunda yan cümle başına (noktalama, ve/sonra/ama, olumsuz aktarma "demedim", emir
//      biçiminde üretim fiili: "haber yap aç") kadar yalnız dolgu varsa ("aç", "şunu aç", "bana göster", "önce aç", "son dakika aç") HEAD gibi
//      açılır; E1 yalnız açma fiilinin tümleci dolgu dışı sözken ("<link> bu filmi haber gibi göster, 40 saniye"). Tanıyıcılar olumsuz aktarma ("haber yap demedim") ve "son dakika" etiketi
//      atılmış metne bakar: haber isteği (newsRequest), benzer video (recreateAsk), fragman isteği yalnız açma fiilleri etkisizken ve kendi istek
//      fiiliyle ("fragman analizi yap"; "fragmanı göster", "aç, yeni fragman" betimleme), açık tür yalnız linke bitişik etiket, tagKind etiketi
//      (haber sayfası linkinde "haber" etiketi değil) ya da açma dışı istek fiilli tür ifadesi (server.js kindAsk: "mizah yap", "mizah olarak
//      paylaş", "komik video yap"; "şunu aç, çok komik bir video 😂" betimleme; "<link> mizah aç" HEAD gibi açılır);
//   E2 sıfat "aç": hemen ardından (yalnız boşluk) kal- ("aç kalsın", "aç kalanını", "aç kaldığım/kaldığın yerden", "aç kaldığı yerden" değil:
//      açma isteğinin ardındaki söz), bırak-'ın edilgen, ortaç, geçmiş, süren ve ad biçimleri (bırakılan, bırakan, bıraktı, bırakmış, bırakıyor,
//      bırakacak, bırakmak; emir "aç bırak", "aç bırakma" değil), susuz, gözlü, "ve susuz", "veya susuz" ya da önünde günlerce/haftalarca/aylarca
//      ("Aç kalan köpeklere belediye mama dağıttı", "Günlerce aç ve susuz kalan kedi");
//   E3 aktarma (üçüncü kişi): açma fiilinin hemen ardından (boşluk, tırnak, virgül) deyince, dedi/dediler/dediği, demiş/demişler/demişti, diyen,
//      derken, diyerek, diye ("Polis kimliğini göster deyince …"); sahibin kendi ısrarı değil (12. tur: "aç dedim", "aç dedik ya", "aç demiştim",
//      "aç diye yazdım/gönderdim" — "diye"den sonra birinci kişi geçmiş zaman; 13. tur: birinci kişi "dediğim", "demiş miydim" ve "diye"nin yan
//      cümlesinde birinci kişi fiil: "aç diye mesaj attım", "aç diye yazıyoruz", "göster diye ricada bulundum", "aç diye bekliyorum"; 14. tur:
//      "diyerek" ve "derken" de — "aç diyerek gönderdim", "aç derken bunu kastettim" —, aktarmadan sonra yine açma fiili sahibin şikâyetidir:
//      "aç deyince açılsın", "göster dediğinde açılmıyor").
//   E1 SORU VE ERTELEMEDE YOK (13. tur): soru (soru eki mı/mi…, "?") ya da erteleme/dilek sözü (uygunsa, istersen, olursa, belki, istiyorum,
//      isterim, lazım, gerek, düşünüyorum, -AlIm) geçen yan cümle tanıyıcılara gitmez: "haber yapalım mı aç bakalım", "haber yapmak istiyorum
//      önce aç", "haber yapmak lazım önce aç", "aç, uygunsa haber yap" açılır.
//   E2/E3 sözcük başınadır (yan cümle içinde, ham metinde): metinde istisnasız başka bir aç/göster varsa HEAD gibi açılır.
// HEAD (c0937ab), birebir: video linkinde linkin dışında yalnız açma isteği ("youtu.be/… oynat", "şunu açar mısın youtu.be/…")
const OPEN_ONLY = /^(?:(?:şunu|bunu|şu|bu|videoyu|linki|lütfen|hemen)\s+)*(?:aç|çal|oynat|göster)(?:ar|ır|ın|sana|abilir)?(?:\s+(?:mısın|mısınız|misin|misiniz|lütfen))*$/;
const headOpen = (raw, t, lk, vl) => /(^|\s)(aç|göster)(\s|$)/.test(t) || !!(vl && OPEN_ONLY.test(norm(String(raw).replace(lk.raw, " "))));
// HEAD'in gördüğü aç/göster sözcükleri (norm noktalama ve kesmeyi boşluk yapar): tr-TR küçük harfli ham metinde
const HEAD_TOK = /(?<=^|[\s.,!?'])(?:aç|göster)(?=[\s.,!?']|$)/gu;
const OPEN_ADJ_A = new RegExp(String.raw`^\s+(?:kal(?!s[ıi]n|an[ıi](?:n[ıia]|nd[ae]n?)?(?!\p{L})|dı[ğg][ıi](?:m|n|m[ıi]z|n[ıi]z)(?!\p{L})|dı[ğg][ıi]\s+yerden)\p{L}*|`
  + String.raw`bırak(?:ıl|an|t[ıi]|mış|ıyor|acak|ma[ks])\p{L}*|susuz(?!\p{L})|gözlü(?!\p{L})|ve\s+susuz(?!\p{L})|veya\s+susuz(?!\p{L}))`, "u"); // E2
const OPEN_ADJ_B = /(?<!\p{L})(?:günlerce|haftalarca|aylarca)\s+$/u;
// birinci kişi fiil (sahibin ısrarı, 13. tur): -DIm/-DIk, -mIştIm, -Iyorum/-Iyoruz, -AcAğIm/-AcAz/-cAm, -IrIm/-ArIz, -mIydIm; aynı sonla biten
// sık adlar fiil değil ("Fragmanı göster diye yorum yazanlar…" aktarmadır)
const FIRST_P = String.raw`(?!(?:yorum|durum|kurum|forum|serum|erzurum|birim|sürüm|yardım|adım|hocam)(?!\p{L}))\p{L}+(?:[dt][ıiuü][mk]|m[ıiuü]şt[ıiuü][mk]|yoru[mz]|[ae]?c[ae][ğk]?[ıi]?[mz]|[aeıiuü]?r[ıiuü][mz]|m[ıiuü]y[dt][ıiuü][mk])(?!\p{L})`;
// "diyerek" ve "derken" de yalnız ardından birinci kişi fiil gelmiyorsa (14. tur; inceleme, 21 Ekim: "aç diyerek gönderdim", "aç derken bunu
// kastettim" sahibin ısrarıdır)
const OPEN_SAY = new RegExp(String.raw`^[\s"'“”‘’«»,]*(?:(?:diye|diyerek|derken)(?![^.,;:!?\n]{0,40}?(?<!\p{L})${FIRST_P})|deyince|dedi(?:ler|[ğg](?![ıi]m)\p{L}*|kler\p{L}*)?|`
  + String.raw`demiş(?:ler\p{L}*|tir|ti)?(?!\s+m[ıi]y[dt][ıi][mk](?!\p{L}))|diyen)(?!\p{L})`, "u"); // E3
// aktarmadan sonra yine açma fiili sahibin şikâyetidir, E3 değil (14. tur: "aç deyince açılsın", "göster dediğinde açılmıyor")
const SAY_SAME = new RegExp(String.raw`^[\s"'“”‘’«»,]*(?:deyince|dedi\p{L}*|demiş\p{L}*|diyen|diye|diyerek|derken)[^.,;:!?\n]{0,30}?(?<!\p{L})(?:aç|göster|oynat|çal)\p{L}`, "u");
// E2/E3: HEAD'in gördüğü her aç/göster sıfat ya da aktarma mı (yalnız tam kelime koluyla açılan metinde; OPEN_ONLY kolunda istisna yok)
const adjOrSay = (raw, lk, vl) => {
  if (vl && OPEN_ONLY.test(norm(String(raw).replace(lk.raw, " ")))) return false;
  const low = String(raw).toLocaleLowerCase("tr-TR");
  let n = 0;
  for (const m of low.matchAll(HEAD_TOK)) {
    const after = low.slice(m.index + m[0].length, m.index + m[0].length + 40), before = low.slice(Math.max(0, m.index - 24), m.index);
    if (!((m[0] === "aç" && (OPEN_ADJ_A.test(after) || OPEN_ADJ_B.test(before))) || (OPEN_SAY.test(after) && !SAY_SAME.test(after)))) return false;
    n++;
  }
  return n > 0;
};
// ONLY2: linkin dışında yalnız açma isteği (kfold'lu sözler; kesme işareti birleşir: "Safari'de" → safaride)
const ONLY_V = /^(?:ac|goster|oynat|cal)(?:s[ae]n[ae]|s[ae]n[iı]z[ae]|[iu]n(?:[iu]z)?|[iu]ver(?:s[ae]n[ae]|[iu]n)?|(?:[ai]r|[ae]bilir)(?:m[iu]s[iu]n(?:[iu]z)?)?)?$/u;
const ONLY_Q = /^(?:[ai]r|[ae]bilir)(?:m[iu]s[iu]n(?:[iu]z)?)?$/u; // soru biçimi: ardından (bitişik ya da ayrı) mısın gelmeli
const ONLY_P = /^m[iu]s[iu]n(?:[iu]z)?$/u;
// selamlama, teşekkür ve hitap da dolgu (14. tur; inceleme, 21 Ekim: haber linkinde "selam, açar mısın?", "açar mısın teşekkürler", "açsana
// kardeşim" yalnız açma isteği sayılmıyor, anlık video olup onaysız yayınlanıyordu)
const ONLY_F = new Set(["sunu", "bunu", "su", "bu", "linki", "videoyu", "sayfayi", "lutfen", "hemen", "abi", "kanka", "reis", "hadi", "bi", "bir", "bakalim",
  "simdi", "da", "de", "bana", "safaride", "tarayicida", "telefonda", "youtubeda", "selam", "selamlar", "merhaba", "gunaydin", "hocam", "iyi",
  "aksamlar", "gunler", "tesekkurler", "tesekkur", "ederim", "tsk", "sagol", "saol", "sagolun", "saolun", "sag", "ol", "olun", "eyvallah", "acaba",
  "kardesim", "kardes", "canim", "usta", "kanki", "dostum", "rica", "etsem", "zahmet", "ya", "emixhas", "jarvis", "acil"]);
// sahibin amaç sözü (birinci tekil gelecek/istek/şimdiki zaman: "açar mısın, okuyacağım", "aç bakayım", "göster izleyeyim"; 14. tur): dolgu
// f: kfold'lu metin (uzun metinde yan cümle başına yeniden katlanmasın; toLocaleLowerCase çağrısı pahalı)
const ONLY_ME = /^\p{L}{2,}(?:y?[ae]c[ae]g[iu]m|y?[ae]y[iu]m|[iu]?yorum)$/u;
const only2F = (f) => {
  const w = f.replace(/['’]/g, "").match(/[\p{L}\p{N}]+/gu) || [];
  let verb = false;
  for (let i = 0; i < w.length; i++) {
    const v = ONLY_V.exec(w[i]);
    if (v) {
      verb = true;
      const sfx = w[i].replace(/^(?:ac|goster|oynat|cal)/u, "");
      if (ONLY_Q.test(sfx) && !/m[iu]s[iu]n(?:[iu]z)?$/u.test(sfx) && !ONLY_P.test(w[i + 1] || "")) return false; // "açar" (geniş zaman) tek başına değil
      continue;
    }
    if (ONLY_P.test(w[i]) && i > 0 && (ONLY_V.test(w[i - 1]) || ONLY_P.test(w[i - 1]))) continue;
    if (!ONLY_F.has(w[i]) && !ONLY_ME.test(w[i])) return false;
  }
  return verb;
};
const only2 = (rest) => only2F(kfold(rest));
// E1 daraltma (12. tur): yan cümlesinde tam açma isteği. Solunda yalnız bu dolgu (kfold'lu, kesmesiz) ve "son dakika"/"son dk" etiketi
// varsa aç/göster tam açma isteğidir; noktalama, bağlaç (ve, sonra, ama, ancak, fakat, veya, yoksa), olumsuz aktarma ve emir biçiminde üretim
// fiili ("haber yap aç": Türkçede fiil yan cümleyi bitirir) yan cümle başıdır
const PURE_F = new Set([...ONLY_F, "once", "sadece", "yalniz", "yalnizca", "haydi", "ya", "artik", "acil", "flas", "sondakika", "selam", "merhaba",
  "gunaydin", "hocam", "haberi", "siteyi"]);
const OPEN_BND = new Set(["ve", "sonra", "ama", "ancak", "fakat", "veya", "yoksa"]);
const OPEN_BND_V = /^(?:yap|hazirla|uret|cek|yaz|paylas|gonder|yukle|yayinla|yayimla|kes|kisalt|ekle|ozetle|anlat|ciz|kurgula|cevir)(?:y?[iu]n(?:[iu]z)?|sana)?$/u;
// olumsuz aktarma (kfold'lu, tek söz): demedim, demedik, dememiştim, demiyorum, demem, demez, demeyin, deme ("haber yap demedim, aç")
const NEG_SAY_W = /^de(?:me(?:di|mis)\p{L}*|miyor\p{L}*|mem(?:iz)?|mez\p{L}*|meyin(?:iz)?|meyece\p{L}*|me)$/u;
const WCH = /[\p{L}\p{N}'’]/u;
// solundaki söz (kfold'lu metinde i'den geriye, lim'e kadar): [başı, sonu] ya da null (pencere başı) / "işaret" (yan cümle başı); geriye
// karakter karakter (uzun metinde her aç/göster için yalnız bir-iki söz okunur)
const prevTok = (f, i, lim) => {
  while (i > lim && /\s/.test(f[i - 1])) i--;
  if (i <= lim) return null;
  if (!WCH.test(f[i - 1])) return "işaret";
  let j = i; while (j > lim && WCH.test(f[j - 1])) j--;
  return [j, i];
};
const pureOpen = (rest) => {
  const low = String(rest).toLocaleLowerCase("tr-TR"), f = kfold(rest); // kfold uzunluğu korur: yerler aynı
  for (const m of low.matchAll(HEAD_TOK)) {
    const lim = Math.max(0, m.index - 64);
    let i = m.index, ok = true;
    for (;;) {
      const t = prevTok(f, i, lim);
      if (t === "işaret") break; // yan cümle başı
      // pencere bitti: metnin başıysa ya da pencereden önce işaret varsa tam istek (kesik sözle değil)
      if (t === null) { ok = lim === 0 || (!WCH.test(f[lim - 1]) && !/\s/.test(f[lim - 1])); break; }
      if (t[0] === lim && lim > 0) { ok = false; break; }
      const w = f.slice(t[0], t[1]).replace(/['’]/g, "");
      if (OPEN_BND.has(w) || NEG_SAY_W.test(w) || OPEN_BND_V.test(w)) break; // yan cümle başı
      if (PURE_F.has(w)) { i = t[0]; continue; }
      if (w === "dakika" || w === "dk") { const u = prevTok(f, t[0], lim); if (Array.isArray(u) && f.slice(u[0], u[1]) === "son") { i = u[0]; continue; } }
      ok = false; break;
    }
    if (ok) return true;
  }
  return false;
};
// tanıyıcıya gitmeyen: olumsuz aktarılan istek (yan cümle başından olumsuz aktarmaya kadar: "haber yap demedim") ve "son dakika" etiketi
const NEG_QUOTE = /(?<=^|[.,;:!?\n])[^.,;:!?\n]*?(?<!\p{L})de(?:me(?:di|miş)\p{L}*|miyor\p{L}*|mem(?:iz)?|mez\p{L}*|meyin(?:iz)?|meyece\p{L}*|me)(?!\p{L})/gu;
const SD_WORDS = /(?<!\p{L})(?:son\s*(?:dakika|dk)|sondakika)(?!\p{L})/gu;
const prodText = (x) => String(x || "").toLocaleLowerCase("tr-TR").replace(NEG_QUOTE, " ").replace(SD_WORDS, " ");
// server.js tanıyıcıları (haber isteği, benzer video, fragman isteği, fiilli tür ifadesi): server.js açılışta verir; verilmemişse E1 yok
let DET = null;
export const useDetectors = (d) => { DET = d; };
// açma fiilleri etkisiz ("x"): fragman ve tür isteği yalnız açma dışı istek fiiliyle sayılsın ("fragmanı göster" açılır)
const OPEN_TOK_F = /(?<![\p{L}\p{N}])(?:ac|goster|oynat|cal)(?:s[ae]n[ae]|[iu]n(?:[iu]z)?|[iu]ver\p{L}*|[ai]r|[ae]bilir)?(?![\p{L}\p{N}])/gu;
// E1 soru/erteleme yan cümlesi (13. tur; kfold'lu metinde): soru eki (kibar istek "yapar mısın" değil) ya da "?", erteleme/dilek sözü, -AlIm
// önerisi (dolgu "bakalım/görelim" değil); yan cümle noktalamayla biter (işareti dahil)
const QD_CLAUSE = /[^.,;:!?…\n]*[.,;:!?…\n]*/gu;
const QD_RE = new RegExp(String.raw`\?|(?<![\p{L}\p{N}])(?:m[iu](?:y[iu][mz]|d[iu]r|y[dt][iu]\p{L}*|ym[iu]s\p{L}*)?|uygunsa|mumkunse|musaitsen\p{L}*|`
  + String.raw`isterse[nk]\p{L}*|olursa|belki|ist(?:iyor|iyo|er(?:im|iz|din|dim))\p{L}*|lazim|gerek\p{L}*|dusunuyor\p{L}*|`
  + String.raw`(?!(?:bakalim|gorelim)(?![\p{L}\p{N}]))\p{L}+y?[ae]l[iu]m(?:m[iu])?)(?![\p{L}\p{N}])`, "u");
// metin bir kez katlanır (kfold uzunluğu korur: yan cümlenin özgün metni aynı yerden alınır)
const noQD = (s0) => {
  const s = String(s0 || ""), f = kfold(s);
  if (f.length !== s.length) return s.replace(QD_CLAUSE, (c) => (QD_RE.test(kfold(c)) ? " " : c));
  return f.replace(QD_CLAUSE, (c, i) => (QD_RE.test(c) ? " " : s.slice(i, i + c.length)));
};
const prodAsk = (rest0, tag, insRest0) => {
  if (!DET || pureOpen(rest0)) return false;
  const rest = prodText(noQD(rest0)), tk = KIND_TAG[kfold(tag)] || tagKind("", prodText(noQD(insRest0))).kind;
  if (tk) return true;
  if (DET.newsRequest(rest) || DET.recreateAsk(rest)) return true;
  const neutral = kfold(rest).replace(OPEN_TOK_F, "x");
  return !!(DET.trailerAsk(`${neutral} x`) || DET.kindAsk(neutral));
};
// yan cümlesi kendi başına tam açma isteği (13. tur, video linkinde istisnaları geçersiz kılar): noktalama, satır sonu ya da bağlaçla ayrılır
const OPEN_CLAUSE = /[.,;:!?…\n]+|(?<![\p{L}\p{N}])(?:ve|sonra|ama|ancak|fakat|veya|yoksa)(?![\p{L}\p{N}])/iu;
const OPEN_HINT = /(?<![\p{L}\p{N}])(?:ac|goster|oynat|cal)/u;
// E2'nin "aç ve/veya susuz" sıfatı bağlaçla bölünmez ("Aç ve susuz kalan kuşlara su koyun" yan cümle açma isteği değil)
const ADJ_VE = /(?<![\p{L}\p{N}])ac(?=\s+(?:ve|veya)\s+susuz(?![\p{L}\p{N}]))/gu;
const clauseOpen = (rest) => kfold(rest).replace(ADJ_VE, "x").split(OPEN_CLAUSE).some((c) => c && OPEN_HINT.test(c) && only2F(c));
// HABER SAYFASI LİNKİNDE İSTEK BİÇİMİ (15.-16. tur; inceleme, 21 Ekim: "açar mısın, haber yapalım mı?", "haber yapma, açsana" ve 16. turda
// ONLY_V dışındaki "açsan şunu", "açarsan sevinirim", "açabilirsen", "açmaz mısın", "açamaz mısın", "açıverir misin", "açar msn", "açarmsın",
// "göstersen", "oynatsan", "çalsan", "açmanı rica ediyorum", "açman lazım", "açıp bakar mısın", "linki açıp okur musun", "açalım şunu",
// "oynatıp izler misin" üretilip onaysız yayınlanıyordu): linkin dışındaki metinde kökü aç/göster/oynat/çal olan ve istek eki taşıyan HERHANGİ bir
// söz geçiyorsa başka söz ne olursa olsun açılır. İstek eki (kfold'lu, kökten hemen sonra; uzatılmış harf birleşince de: "açsanaa", "açarmısınn"):
// emir ve kibar biçim (yalın kök, -sAnA, -sAnIzA, -In(Iz), -mAlIsIn), şart -sAn(Iz)/-sn/-ArsAn(Iz)/-IrsAn(Iz)/-AbilirsAn(Iz), öneri -AlIm, -Iver
// (açıver, açıversen, açıverin…), soru -Ar/-Ir/-mAz/-AmAz/-Abilir/-AcAk/-Iverir + mI(sIn) bitişik ya da ayrı (konuşma dilinde ms, msn, msın,
// mısn), -Ip + aynı yan cümlede en çok üç söz içinde istek biçiminde fiil ("açıp bakar mısın", "açıp bak"), -mAk/-mAn/-mAnI/-mAnIz(I)/-mAsInI +
// istiyorum/isterim/rica/lazım/gerek/şart. İstek olmayan biçim sayılmaz (ek listede yok): geçmiş -DI, -mIş, ortaç -An/-Ilan, açık, açlık, açılış,
// açıklama, gösteri, oyun, çalış-, edilgen çalın- ("çalındı", "çalınan"), olumsuz "açma", yalın geniş zaman "açar". Yalnız sıfat "aç" sayılmaz:
// HEMEN ardındaki söz kal- (kalan, kalmış, kaldı, kaldığı, kalır, kalacak, kalıyor, kalarak, kalma, yalın kal; "kalsın", "kalanını", "kaldığım/
// kaldığın yerden", "kaldığı yerden" değil), bırak-'ın edilgen/ortaç/geçmiş/süren/ad biçimi, susuz ya da "ve/veya susuz" (16. tur: 15. turun
// yan cümlede herhangi bir kal…/bırak… sözü kalabalık, kalp, kaldır, kale, kalite'yi de sayıyordu — "ac bakalim kalabalik mi" üretiliyordu);
// HEAD'in yalın "aç"ı yine açar. Yanlış açma yalnız tarayıcıyı açar, üretim onaysız yayındır
const ADJ_TAIL = new RegExp(String.raw`^[^\S\n]+(?:(?:ve|veya)[^\S\n]+susuz|susuz|birak(?:il|an|ti|mis|iyor|acak|ma[ks])\p{L}*|`
  + String.raw`kal(?!s[iu]n|an[iu](?:n[iu]a?|nd[ae]n?)?(?![\p{L}\p{N}])|d[iu]g[iu](?:m|n|m[iu]z|n[iu]z)(?![\p{L}\p{N}])|d[iu]g[iu]\s+yerden)`
  + String.raw`(?:an|m[iu]s|d[iu](?!r)|[iu]r|[ae]c[ae]k|[iu]yor|[ae]rak|m[ae]|(?![\p{L}\p{N}]))\p{L}*)(?![\p{L}\p{N}])`, "u");
// istek eki (kökten sonraki kısmın tamamı); soru eki ayrı yazılınca (REQ_Q + REQ_QP), -Ip (REQ_IP + REQ_VERB), ad + isteme (REQ_NOUN + REQ_WANT)
const REQ_QB = String.raw`(?:[aeiu]r|m[ae]z|[ae]m[ae]z|[ae]bilir|[ae]c[ae]k|[iu]ver(?:[iu]r|[ae]bilir))`;
const REQ_QE = String.raw`(?:m[iu](?:s(?:[iu]n(?:[iu]z)?|n)?)?|ms(?:[iu]n(?:[iu]z)?|n)?)`;
const REQ_A = new RegExp(String.raw`^(?:|s[ae]n[ae]|s[ae]n[iu]z[ae]|[iu]n(?:[iu]z)?|s[ae]?n|s[ae]n[iu]z|[aeiu]rs[ae]n(?:[iu]z)?|[ae]bilirs[ae]n(?:[iu]z)?|`
  + String.raw`[ae]l[iu]m|m[ae]l[iu]s[iu]n(?:[iu]z)?|[iu]ver(?:s[ae]n[ae]?|s[ae]n[iu]z[ae]?|[iu]n(?:[iu]z)?|[ae]l[iu]m)?|${REQ_QB}${REQ_QE})$`, "u");
const REQ_Q = new RegExp(String.raw`^${REQ_QB}$`, "u"), REQ_QP = new RegExp(String.raw`^${REQ_QE}$`, "u");
const REQ_IP = /^[iu]p$/u, REQ_NOUN = /^m[ae](?:k|n|n[iu]|n[iu]z|n[iu]z[iu]|s[iu]n[iu])$/u;
const REQ_WANT = /^(?:istiyor\p{L}*|isterim|isteriz|rica|lazim|gerek\p{L}*|sart)$/u;
// -Ip'ten sonraki istek fiili: istek ekiyle biten söz ya da yalın/çoğul emir (bak, oku, izle, dinle, incele, gör, yap, anlat…)
const REQ_VERB = new RegExp(String.raw`(?:s[ae]n[ae]|s[ae]n[iu]z[ae]|[ae]bilir|[aeiu]rs[ae]n(?:[iu]z)?|[ae]l[iu]m|[iu]ver\p{L}*|${REQ_QB}${REQ_QE})$|`
  + String.raw`^(?:bak|bakin|oku|okuyun|izle|izleyin|dinle|dinleyin|incele|inceleyin|gor|gorun|yap|yapin|hazirla|hazirlayin|anlat|soyle|yaz|`
  + String.raw`kontrol|goz|kaydet|indir|paylas|gonder|ac|cal|oynat|goster)$`, "u");
// aday kelime: kökü aç/göster/oynat/çal olabilecek tek kelimeler bunlar (uzatılmış harfle de); uzun metinde bütün kelimeler diziye alınmaz
const OPEN_CAND = /(?<![\p{L}\p{N}])(?:a+c+|g+o+s+t+e+r+|o+y+n+a+t+|c+a+l+)[\p{L}\p{N}]*/gu;
const OPEN_STEM = /^(?:ac|goster|oynat|cal)/u;
const reqOpen = (rest) => {
  const f = kfold(rest);
  if (!OPEN_HINT.test(f)) return false;
  const C = new RegExp(OPEN_CAND), N = /[\p{L}\p{N}]+/gu; let m;
  const next = (i) => { N.lastIndex = i; return N.exec(f)?.[0] || ""; };
  while ((m = C.exec(f))) {
    const end = m.index + m[0].length, w1 = m[0].replace(/(\p{L})\1+/gu, "$1");
    for (const w of w1 === m[0] ? [m[0]] : [m[0], w1]) {
      const st = OPEN_STEM.exec(w); if (!st) continue;
      const sfx = w.slice(st[0].length);
      if (REQ_A.test(sfx)) { if (!(sfx === "" && st[0] === "ac" && ADJ_TAIL.test(f.slice(end, end + 80)))) return true; break; }
      if (REQ_Q.test(sfx)) { if (REQ_QP.test(next(end))) return true; break; } // "açar" (geniş zaman) tek başına değil
      if (REQ_NOUN.test(sfx)) { if (REQ_WANT.test(next(end))) return true; break; }
      if (REQ_IP.test(sfx)) {
        const cl = f.slice(end, end + 60).split(/[.,;:!?…\n]/u)[0];
        if ((cl.match(/[\p{L}\p{N}]+/gu) || []).slice(0, 3).some((t) => REQ_VERB.test(t) || REQ_QP.test(t))) return true;
        break;
      }
    }
  }
  return false;
};
// açılır: haber sayfası linkinde (video linki değil: anlık yol) HEAD açar || ONLY2 || istek biçimi, istisna yok (13. ve 15. tur); video
// linkinde (HEAD açar && (yan cümlesi tam açma isteği || istisna yok)) || ONLY2
const openAsk = (raw, t, lk, vl, rest, insRest) => {
  if (only2(rest)) return true;
  if (vl?.kind !== "video" && reqOpen(rest)) return true;
  if (!headOpen(raw, t, lk, vl)) return false;
  if (vl?.kind !== "video") return true;
  return clauseOpen(rest) || (!adjOrSay(raw, lk, vl) && !prodAsk(rest, lk.tag, insRest));
};
// talimatta harf/rakam yoksa (linkin çevresindeki parantez, tırnak, WhatsApp *kalın* işareti) talimat boştur: varsayılan haber talimatı geçer
const insOf = (s) => { const x = String(s || "").replace(/\s+/g, " ").trim(); return /[\p{L}\p{N}]/u.test(x) ? x : ""; };

// Türkçe harfler ASCII'ye katlanır ("guncelle", "güncelleme var mi" de tanınsın)
const fold = (x) => x.replace(/[üÜ]/g, "u").replace(/[öÖ]/g, "o").replace(/[ıİI]/g, "i").replace(/[şŞ]/g, "s").replace(/[çÇ]/g, "c").replace(/[ğĞ]/g, "g");
const UPD_FILL = "(?:emixhas|lutfen|hemen|simdi|hadi|haydi|bi|bir|artik|kanka|abi|sen)";
const SELF_UPDATE = new RegExp(`^(?:${UPD_FILL} )*(?:(?:sistemi|paneli|kendini|kodu|yazilimi|programi|uygulamayi|emixhasi|emixhas i|sistem|panel|kod) )?(?:${UPD_FILL} )*` +
  "(?:guncelle|guncellesene|guncelleyiver|guncelle(?:r|yebilir) misin|guncellemeyi al|guncellemeleri al|guncellemeyi yukle|guncellemeleri yukle|guncellemeyi yap|" +
  `guncelleme yap|guncelleme(?:yi)? yapar misin|son surume gec|son surumu al|yeni surumu al|update)(?: ${UPD_FILL})*$`);
const UPDATE_CHECK = /^(?:emixhas )?(?:(?:yeni )?(?:bir )?(?:guncelleme|surum|update)(?:ler)? (?:var mi|geldi mi)|guncel misin|(?:sistem|panel|kod) guncel mi|son surumde misin)$/;
export function parseCommand(raw) {
  const t = norm(raw);
  if (!t) return { action: "none", reply: "Sizi duyamadım." };
  // Kendini güncelleme (kullanıcı isteği, 19 Ekim: "WhatsApp'tan güncelle yazayım, panel kendini güncellesin, güncelle butonuna basmışım
  // gibi"): yalnız tüm mesaj bu kalıpsa ("izlenmeleri güncelle", "kapakları güncelle" başka komut; "kendini güncelleyebilir mi?" soru,
  // beyne gider). "güncelleme var mı" yalnız bakar, çekmez.
  // WhatsApp biçim işareti (*güncelle*), emoji ve noktalama atılır; "güncelle?" soru gibi yazıldıysa yalnız bakar (çekmez)
  const tu = fold(t).replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
  if (SELF_UPDATE.test(tu)) return { action: /\?\s*\S{0,4}\s*$/u.test(String(raw).trim()) ? "update_check" : "self_update", reply: "" };
  if (UPDATE_CHECK.test(tu)) return { action: "update_check", reply: "" };
  // 🎬 Fragman takibi (kullanıcı isteği, 24 Ekim): "fragman takibi" / "fragman takibi durumu" → durum; "fragman takibini aç / kapat / durdur / başlat";
  // "fragman kanallarını tara" / "fragmanları tara" / "fragman kanallarını kontrol et" → şimdi tara; "fragman kanalı ekle @NetflixTurkiye" /
  // "fragman kanalı çıkar @NetflixTurkiye" (kanalın linki ya da UC… kimliği de olur). Linkli mesaj kurallarından ÖNCE: kanal linki "video linkini
  // gönderin" yanıtına ya da açma kuralına düşmesin. Tek fragman linki ve "fragman yap" talimatı buraya girmez (takip/kanal sözü yok).
  {
    const tt = t.replace(/[:;–—-]+/g, " ").replace(/\s+/g, " ").trim(); // "ekle: @kanal", "takibi - kapat"
    const twTrack = /(^| )fragman (takibi|takibini|takibine|takip)( |$)/.test(tt);
    const twChan = /(^| )fragman kanal\S*( |$)/.test(tt) || /(^| )fragmanları (tara|tarasın|kontrol et)( |$)/.test(tt);
    if (twTrack || twChan) {
      const ch = (String(raw).match(/(https?:\/\/[^\s<>"']*youtube\.com\/[^\s<>"']+|(?:^|\s)@[\w.-]{2,}|(?:^|\s)UC[\w-]{20,})/i) || [""])[0].trim().replace(/[).,;!?]+$/, "");
      if (/(^| )(ekle|eklesene|ekleyin|ekler misin|eklenecek|eklensin)( |$)/.test(tt)) return ch ? { action: "trailer_watch", add: ch, reply: "" } : { action: "none", reply: "Hangi kanalı ekleyeyim? Kanal adını @ ile ya da linkini yazın: fragman kanalı ekle @NetflixTurkiye" };
      if (/(^| )(çıkar|çıkart|çıkarın|sil|silin|kaldır|kaldırın)( |$)/.test(tt)) return ch ? { action: "trailer_watch", remove: ch, reply: "" } : { action: "none", reply: "Hangi kanalı çıkarayım? fragman kanalı çıkar @NetflixTurkiye" };
      if (/(^| )(tara|tarasın|tarayın|kontrol et|bak|şimdi)( |$)/.test(tt)) return { action: "trailer_watch", scan: true, reply: "" };
      if (twTrack) { // "fragman kanallarına bayıldım" gibi fiilsiz kanal sözü komut değil (aşağıdaki yollara düşer)
        if (/(^| )(kapat|kapatın|kapa|durdur|durdurun|iptal et|devre dışı bırak)( |$)/.test(tt)) return { action: "trailer_watch", on: false, reply: "" };
        if (/(^| )(aç|açın|başlat|başlatın|etkinleştir|devam et)( |$)/.test(tt)) return { action: "trailer_watch", on: true, reply: "" };
        return { action: "trailer_watch", reply: "" };
      }
    }
  }
  // "youtube'dan X'i aç", "X şarkısını çal", "git youtube'da X'i oynat". Linkli mesajda fiil tam kelime olmalı: YouTube linkinin yanına
  // yazılan talimattaki "amaç", "kaç", "açıkla" (kullanıcı isteği, 18 Ekim: "<fragman linki> … amaç bir filmin fragmanını analiz edip…")
  // müzik açma sanılmasın; link aşağıda sosyal medya videosuna (fragman analizi) gider. Kibar/ekli emir biçimleri yine açar ("açar mısın",
  // "çalar mısın", "oynatır mısın", "açsana", "açın", "açabilir misin"; STRIP_WORDS'teki açma istekleri).
  // Video sitesi linkiyle gelen açma isteği aşağıda o linki tarayıcıda açar (eskiden linkin harfleri YouTube'da aranıyordu).
  const lk = findLink(raw);
  const hasLink = !!lk;
  const vl = lk ? videoLink(lk.url) : null;
  if (!vl && /(youtube|yutub|yutup|şarkı|parça|müzik|klib)/.test(t) && (hasLink ? /(^| )(aç|çal|oynat|başlat)(ar|ır|ın|sana|abilir)?( |$)/ : /(aç|çal|oynat|başlat)/).test(t)) {
    const q = extractQuery(t);
    if (q.length > 1) return { action: "open_youtube", query: q, reply: "" };
    return { action: "none", reply: "Hangi şarkıyı açayım?" };
  }
  const rawl = raw.toLocaleLowerCase("tr-TR").replace(/[’']/g, "'").trim();
  if (/^(.+?)\s*(sitesini|sayfasını|adresini)\s*aç$/.test(rawl)) return { action: "open_url", target: rawl.replace(/\s*(sitesini|sayfasını|adresini)\s*aç$/, "").trim(), reply: "" };
  if (/^(google ?da|googleda|internette)\s+(.+?)\s+(ara|arat)$/.test(t)) return { action: "open_url", target: "https://www.google.com/search?q=" + encodeURIComponent(t.replace(/^(google ?da|googleda|internette)\s+/, "").replace(/\s+(ara|arat)$/, "")), reply: "" };
  // sondakika.com takibi: "sondakika.com'u kontrol et", "sondakika takibini kapat/aç", "sondakika.com takibi açık mı?".
  // Anlık haber ("son dakika <konu>") ve genel "iptal/kapat" kurallarından ÖNCE: "son dakika takibini kapat" konu sanılmasın.
  // Açık anlık haber biçimi ("son dakika: …", "anlık haber: …") hiç buraya girmez: konuda sondakika.com ya da "iptal" geçebilir.
  // Takip adları tam kelime (takibi/takibini/takibine/takip/izleyicisi…): "son dakika takibe alınan şüpheli…", "izleyicileri şok eden…"
  // haber konusudur. Kapat/aç fiili de tam kelime: "kapatıldı", "durduruldu", "iptal edildi" takibi kapatmaz.
  // Sitenin ana sayfa linki de takip komutudur (ana sayfadan haber videosu yapılmaz); habere giden link aşağıda anlık habere gider.
  const sdLink = (String(raw).match(/https?:\/\/[^\s<>"']+/i) || [""])[0].replace(/[).,;!?]+$/, "");
  const sdHome = !sdLink || /^https?:\/\/(www\.)?sondakika\.com\/?(son-dakika\/?)?$/i.test(sdLink);
  const sdExplicit = /^(?:emixhas[,\s]*)?(?:son ?dakika|anl[ıi]k haber)(?: videosu)?(?: (?:üret|yap|hazırla|çek))?\s*[:\-–]/i.test(String(raw).trim());
  const sdSite = /(^| )son ?dakika com( |\/|$)/.test(t) || /(^| )sondakika (sitesi|adresi|sayfası)\S*( |$)/.test(t);
  const sdTrack = /(^| )(son ?dakika( com)?|sondakika (sitesi|sitesinin)) (takibi|takibini|takibine|takip|izleyicisi|izleyicisini|izlemesi|izlemesini)( |$)/.test(t);
  const sdOff = /(^| )(kapat|kapatın|kapatır|kapa|durdur|durdurun|durdurur|iptal et|devre dışı bırak)( |$)/.test(t);
  const sdOn = /(^| )(aç|açın|açar|başlat|başlatır|etkinleştir|devam|devam et)( |$)/.test(t);
  const sdQ = /\?\s*$/.test(String(raw).trim()) || /(^| )(mı|mi|mu|mü|mısın|misin|neden|niye|nasıl|durum\S*)( |$)/.test(t);
  const sdLook = /(^| )(kontrol|tara|bak|yokla|ne var|yeni haber)/.test(t);
  // takip ya da site adı + bir niyet (aç/kapat, kontrol, soru); ana sayfa linki tek başına da kontrol demektir
  if (!sdExplicit && sdHome && (sdSite || sdTrack) && (sdLink || sdOff || sdOn || sdQ || sdLook) && (sdLink || t.split(" ").length <= 10) && !(sdLink && /(^| )(aç|göster)( |$)/.test(t) && !sdTrack)) {
    if (sdOff) return { action: "sondakika", on: false, reply: "" };
    if (sdOn) return { action: "sondakika", on: true, reply: "" };
    return { action: "sondakika", check: !sdQ || sdLook, reply: "" };
  }
  // Anlık haber: "son dakika: <konu>" / "anlık haber: <konu>" → o konuda tek konulu son dakika videosu.
  // İki nokta (ya da tire) zorunlu: "son dakika haberleri neler" gibi sorular tetiklemesin.
  const an = String(raw).trim().match(/^(?:emixhas[,\s]*)?(?:son ?dakika|anl[ıi]k haber)(?: videosu)?(?: (?:üret|yap|hazırla|çek))?\s*[:\-–]\s*([\s\S]{8,})$/i);
  // "son dakika: <YouTube/sosyal medya video linki>" haber sayfası değil, videodan son dakika haberidir (talimatta "son dakika" kalır:
  // fragman analizine dönmez); mizah/viral etiketli linke "son dakika" eklenmez (panel ANLIK kartı gibi; inceleme, 19 Ekim: Claude'a
  // istenen tür mizahken "son dakika" talimatı gidiyordu); kanal/oynatma listesi linkine Türkçe yanıt
  if (an && vl && an[1].includes(lk.raw)) {
    if (vl.kind !== "video") return { action: "none", reply: vl.reply };
    const w = whenKeepingPositions(an[1].replace(lk.raw, " "), vl.platform === "YouTube");
    const tk = tagKind(lk.tag, w.rest), fun = ["trend", "mizah"].includes(tk.kind);
    // talimat "son dakika: …" (etiket biçimi): tür haber, yalnız şaka altyazısında değil (server.js contentKindOf'un zayıf haber biçimi:
    // gülme işareti ya da reddedilenler atılmış metinde açık mizah/viral ifadesi varsa tür talimattan; inceleme, 20 Ekim: "son dakika:
    // <fragman başlıklı link> vizyon tarihini de ekle", "… kısa kes" fragman analizine gidiyordu; "Son dakika: gol yiyen kaleci 😂 mizah
    // videosu" mizah, "son dakika: <link> mizah değil, ciddi haber", "Son dakika: Komedi dizisinin setinde yangın çıktı" haber)
    const r = insOf(tk.rest), ins = fun ? r : r ? `son dakika: ${r}` : "son dakika";
    return { action: "social_video", url: vl.url, instruction: ins.replace(/\s+/g, " ").trim(), ...(tk.kind ? { kind: tk.kind } : {}), publishAt: w.at ? w.at.toISOString() : undefined, ...(w.at && w.doubt ? { timeDoubt: true } : {}), ...(w.ignored ? { ignoredTime: w.ignored } : {}), reply: "" };
  }
  if (an) return { action: "anlik", topic: an[1].trim(), duration: 30, reply: "" };
  // Haber linki → sayfa okunur, ondan son dakika videosu ("aç" denirse tarayıcıda açılır)
  if (lk) {
    // yayın saati (kullanıcı isteği: "linki gönderip bunu şu saatte paylaş diyeyim; saat yazmazsam direkt paylaşsın"); YouTube video
    // linkinde videodaki konum ("12:30'dan itibaren") yayın saati sanılmaz, talimatta kalır
    const rest0 = String(raw).replace(lk.raw, " ");
    const when = vl?.kind === "video" ? whenKeepingPositions(rest0, vl.platform === "YouTube") : parseWhen(rest0);
    // açma (openAsk: HEAD'in kararı + adı konmuş istisnalar + ONLY2; "aç", "aç bakalım", "şunu açar mısın <haber linki>")
    if (openAsk(raw, t, lk, vl, rest0, when.rest)) return { action: "open_url", target: lk.url, reply: "" };
    const publishAt = when.at ? when.at.toISOString() : undefined;
    // yanıtta tek satır (server.js handleCommand): alınan saat şüpheliyse (olay saati olabilir; when.js doubtNote) ya da açık yazılmış saat
    // alınmadıysa (when.js timeNote)
    const ign = { ...(when.at && when.doubt ? { timeDoubt: true } : {}), ...(when.ignored ? { ignoredTime: when.ignored } : {}) };
    // sosyal medya paylaşımı: videosu indirilip kurgulanır (linkin dışında yazılan, nasıl bir haber istendiğidir)
    if (vl?.kind === "video") { const tk = tagKind(lk.tag, when.rest); return { action: "social_video", url: vl.url, instruction: insOf(tk.rest), ...(tk.kind ? { kind: tk.kind } : {}), publishAt, ...ign, reply: "" }; }
    if (vl?.reply) return { action: "none", reply: vl.reply };  // YouTube kanal / oynatma listesi / diğer sayfa
    return { action: "anlik", topic: String(raw).trim(), duration: extractSeconds(t) || 30, publishAt, ...ign, reply: "" };
  }
  // İki noktasız: "son dakika Eşref Tek geri dönüyor", "son dakika X ile haber üret", "X hakkında son dakika videosu yap".
  // Soru cümleleri ("son dakika haberleri neler", "son dakika var mı") tetiklemez; konu haber sitelerinde aranır.
  const trimCmd = (x) => x.replace(/\s*\d{2,3}\s*(?:saniye|sn)(?:lik)?/gi, "").replace(/\s+(?:ile ilgili|ile|hakkında|konulu|konusunda|için)?\s*(?:son ?dakika\s+)?(?:bir\s+)?(?:haber(?:i|ini|leri)?|video(?:su|sunu|yu)?)?\s*(?:üret|yap|hazırla|çek|paylaş|yayınla)\w*\s*$/i, "").replace(/\s+(?:ile|hakkında|konulu|konusunda|için)\s*$/i, "").trim();
  const question = /\?\s*$/.test(String(raw).trim()) || /(^|\s)(neler|nedir|ne var|ne oldu|var mı|varmı|kaç|hangi|mı|mi|mu|mü)(\s|$)/.test(t);
  const an2 = String(raw).trim().match(/^(?:emixhas[,\s]*)?(?:son ?dakika|anl[ıi]k haber)\s+([\s\S]{6,})$/i);
  if (an2 && !question && !/^(?:haber(?:ler)?(?:i|ini)?|video(?:su)?)(?:\s|$)/i.test(an2[1])) {
    const topic = trimCmd(an2[1]);
    if (topic.length >= 6) return { action: "anlik", topic, duration: extractSeconds(t) || 30, reply: "" };
  }
  const an3 = String(raw).trim().match(/^(?:emixhas[,\s]*)?([\s\S]{6,}?)\s+(?:hakkında|ile ilgili|konulu|konusunda)\s+(?:son ?dakika\s+)?(?:bir\s+)?(?:haber|video)\w*\s+(?:üret|yap|hazırla|çek)\w*\s*$/i);
  if (an3 && !question) return { action: "anlik", topic: an3[1].trim(), duration: extractSeconds(t) || 30, reply: "" };
  // Süresi geçen videolar: "süresi geçenleri liste dışı yap", "liste dışı yapılanları geri aç"
  if (/liste dışı/.test(t)) return { action: "expire", restore: /(geri al|geri aç|herkese açık|kaldır)/.test(t), reply: "" };
  // Instagram temizliği: "instagramda son 7 günde 1000 izlenmenin altındakileri sil" → önce liste, "evet sil" ile silinir
  if (/^(evet,? sil|evet sil hepsini|sil onaylıyorum|onaylıyorum sil)$/.test(t)) return { action: "ig_cleanup_confirm", reply: "" };
  // Instagram'da ikişer paylaşılmış gönderiler: "instagram tekrarlarını sil", "instagramda çift paylaşılanları sil", "instagram tekrarları" → liste, "evet sil"
  // tekrar sözü gönderiyle birlikte ("tekrarları", "çift paylaşılanlar", "mükerrer gönderiler", "kopya gönderiler"); "tekrar bağla/yükle/paylaş" değil
  if (/(instagram|insta)/.test(t) && (/tekrarlar/.test(t) || /(çift|ikişer|iki kez|mükerrer|kopya|tekrar)\s+(paylaş(ıl|ım)|yüklen|gönderi|kopya|post)/.test(t))
      && !/(bağla|yeniden|tekrar (yükle|paylaş|gönder|at)|(yükle|paylaş|gönder|at|yayınla)( |$)|üret)/.test(t)) return { action: "ig_dups", days: Number((t.match(/(\d+)\s*gün/) || [])[1]) || 7, reply: "" };
  // otomatik Instagram temizliği: "otomatik silmeyi kapat/aç", "silinecek videolar", "silinmeye aday videolar"
  if (/otomatik (silme|temizli)/.test(t) && /(kapat|durdur|iptal)/.test(t)) return { action: "ig_autoclean", on: false, reply: "" };
  if (/otomatik (silme|temizli)/.test(t) && /(^| )(aç|başlat|etkinleştir)( |$)/.test(t)) return { action: "ig_autoclean", on: true, reply: "" };
  if (/(silinecek|silinmeye aday|silinecek olan)( instagram)? (video|gönderi)/.test(t) || /otomatik (silme|temizli)/.test(t)) return { action: "ig_autoclean", reply: "" };
  if (/(instagram|insta)/.test(t) && /(^|\s)sil/.test(t) && /(izlenme|görüntülenme|izlenen)/.test(t)) {
    const days = Number((t.match(/(\d+)\s*gün(?!den eski)/) || [])[1]) || 7;
    const mx = t.match(/(\d[\d.]*)\s*(?:bin\s*)?(?:izlenme|görüntülenme)/);
    let max = mx ? Number(mx[1].replace(/\./g, "")) : /bin (izlenme|görüntülenme)/.test(t) ? 1000 : 1000;
    if (mx && /bin\s*(izlenme|görüntülenme)/.test(t.slice(mx.index))) max *= 1000;
    const ageH = t.match(/(\d+)\s*saatten eski/) ? Number(t.match(/(\d+)\s*saatten eski/)[1]) : t.match(/(\d+)\s*günden eski/) ? Number(t.match(/(\d+)\s*günden eski/)[1]) * 24 : 0;
    return { action: "ig_cleanup", days, max, minAgeH: ageH, reply: "" };
  }
  // Şablon videolar: "depremleri kontrol et", "piyasa videosu üret", "maç sonuçlarını kontrol et", "yarının hatırlatmasını üret"
  if (/deprem(leri)? (kontrol|var m)|son depremler/.test(t)) return { action: "info", kind: "quake", reply: "" };
  if (/(piyasa|döviz|altın) (videosu|kartı)/.test(t) && /(üret|yap|hazırla|çek)/.test(t)) return { action: "info", kind: "market", reply: "" };
  if (/maç (sonuçlarını|sonucunu|sonuçları)/.test(t) && /(kontrol|bak|üret)/.test(t)) return { action: "info", kind: "match", reply: "" };
  if (/(takvim|hatırlatma)/.test(t) && /(üret|yap|hazırla)/.test(t) && /(yarın|takvim)/.test(t)) return { action: "info", kind: "calendar", reply: "" };
  if (/(meteoroloji|hava durumu|turuncu kod|kırmızı kod) (uyarı|kontrol)/.test(t) || /meteoroloji uyarılarını kontrol/.test(t)) return { action: "info", kind: "weather", reply: "" };
  if (/(zam|rekor) (alarmı|kontrol)/.test(t) || /akaryakıt (zammı|fiyatlarını kontrol)/.test(t)) return { action: "info", kind: "alarm", reply: "" };
  if (/(haftanın en çok izlenen|pazar derlemesi|derleme)/.test(t) && /(üret|yap|hazırla)/.test(t)) return { action: "info", kind: "weeklyTop", reply: "" };
  // En çok izlenen saatlerde tekrar: "en çok izlenen saatler", "altın saat tekrarını kapat", "altın saat tekrarını şimdi yap"
  if (/(en çok izlenen saat|altın saat|izlenen saatlerde)/.test(t)) return { action: "peak", run: /(şimdi|hemen) (yap|üret|yayınla|çalıştır)/.test(t), on: /(^|\s)(kapat|durdur)/.test(t) ? false : /(^|\s)(aç|başlat|etkinleştir)(\s|$)/.test(t) ? true : null, reply: "" };
  // Tutan videoyu farklı haliyle yeniden yayınla: "en çok izlenen videoyu yeniden yayınla", "son videoyu yeniden yayınla"
  if (/(yeniden|tekrar) (yayınla|paylaş|üret)/.test(t) && /video/.test(t)) return { action: "remake", which: /(en çok|en fazla|tutan|izlenen|viral)/.test(t) ? "top" : "last", reply: "" };
  if (/kapak(ları|lari)? (yeniden|tekrar) (yükle|gönder)/.test(t)) return { action: "yt_thumbs", reply: "" };
  // Yükleme sırasından çıkarma / silme (kullanıcı isteği, 26 Ekim: "haberin değeri geçmişse silebilmeliyim, sıradan çıkartmalıyım"): "sıradan çıkar 2",
  // "instagram sırasından 2'yi çıkar", "2 numarayı sıradan çıkar", "2. sıradakini sil", "sıradan sil 3" (video Mac'ten de silinir), "sıradan çıkar
  // 2026-10-24-3". norm() nokta ve kesmeyi boşluğa çevirir ("2'yi" → "2 yi", "2." → "2"); \b Türkçe harfte çalışmaz, kelime sınırı boşlukla aranır.
  // "sıradan" (= alelade) başka cümlelerde de geçer: fiil YALNIZ emir/kibar biçimiyle ve ya numara/video adı var ya da fiil "sıradan/sırasından"a
  // (aralarında en çok numara/sıra sözleri) bitişik ("sıradan haberleri sil", "sıradan haberlerden 5 tane kaldıralım mı" komut değil).
  {
    const VERB = /(?:^|\s)(?:çıkar(?:t)?(?:sana|ın)?|kaldır(?:sana|ın)?|sil(?:sene|in)?|çıkar(?:t)?ır mısın|siler misin|kaldırır mısın)(?=\s|$)/;
    const hasQ = /(?:^|\s)sıra(?:dan|sından|daki\S*)(?=\s|$)/.test(t);
    if (hasQ && VERB.test(t) && !/sıraya al/.test(t)) {
      const name = (t.match(/(?:^|\s)(\d{4}-\d{2}-\d{2}-\d+)(?:\s+mp4)?(?=\s|$)/) || [])[1] || "";
      const toks = t.split(" "), isV = (w) => VERB.test(" " + w), near = (i) => toks.slice(Math.max(0, i - 3), i + 4).some((w) => /^sıra/.test(w) || isV(w));
      let num = ""; // "2", "2 yi"/"2yi", "2 numara…", "2 nolu", "3 sıradaki": sıra sözüne ya da fiile en çok üç kelime uzaklıkta
      if (!name) toks.forEach((w, i) => { const m = w.match(/^(\d{1,2})(?:yi|yı)?$/); if (m && !num && near(i)) num = m[1]; });
      const adjacent = /(?:^|\s)sıra(?:dan|sından)(?:\s+(?:\d{1,2}(?:yi|yı)?|yi|yı|numara\S*|nolu|no lu|videoyu|videosunu|haberi|olanı|\d{4}-\d{2}-\d{2}-\d+|mp4))*\s+(?:çıkar|çıkart|kaldır|sil)/.test(t);
      if (name || num || adjacent) {
        const pm = t.match(/(?:^|\s)(instagram|insta|youtube|tiktok)(?=\s|$)/);
        return { action: "queue_drop", n: num ? Number(num) : 0, name, platform: pm ? (pm[1] === "insta" ? "instagram" : pm[1]) : "", del: /(?:^|\s)sil(?:sene|in|er misin)?(?=\s|$)/.test(t), reply: "" };
      }
    }
  }
  // Yayın sırası: "instagram sırası", "tiktok sırası", "yayın kuyruğu", "sırada ne var", "bekleyen videolar", "yükleme sırası"
  if (/(tiktok|youtube|instagram|insta|yayın|yükleme)? ?sıra(sı|da ne var|daki videolar)|(tiktok|youtube|instagram|insta|yayın|yükleme) kuyruğu|bekleyen (video|yükleme)/.test(t) && !/sıraya al/.test(t)) return { action: "queue", reply: "" };
  // Ağır süreçleri ve üretimi durdur (ısınma): "her şeyi durdur", "modelleri kapat", "üretimi durdur"
  if (/(her şeyi|hepsini|tüm modelleri|modelleri|bütün işlemleri|arka plan|üretimi|sistemi|tüm sistemi) (durdur|kapat|bitir|dinlendir)/.test(t)) return { action: "stopall", reply: "" };
  // Dinlenmeden çık: "sistemi başlat", "sistemi uyandır", "sisteme devam"
  if (/\bsistem(i|e)? (başlat|uyandır|aç|devam|çalıştır)/.test(t)) return { action: "rest_end", reply: "" };
  if (/^(dur|sus|tamam dur|yeter|kes|sessiz ol|teşekkürler|sağ ol)$/.test(t)) return { action: "stop", reply: "" };
  // planlı yayınlar (linkle birlikte saat verilen videolar)
  if (/planl[ıi] yay[ıi]n|zamanlanm[ıi]ş yay[ıi]n|bekleyen yay[ıi]n/.test(t))
    return { action: "scheduled", cancel: /(iptal|vazgeç|sil|kaldır|durdur)/.test(t), now: /(şimdi|hemen) (yayınla|paylaş)/.test(t), reply: "" };
  if (/(iptal|boş ver|vazgeç)/.test(t)) return { action: "none", reply: "Tamam, iptal." };
  // Instagram hikâyesi (günün en çok izlenenleri): "günün hikayesini paylaş", "hikayeye at", "hikaye paylaşımını kapat"
  if (/(hikaye|hikâye|story|stori)/.test(t) && !/(^| )m[iı]( |$)|m[iı]s[iı]n/.test(t)) {
    if (/(kapat|durdur|atma|paylaşma)/.test(t)) return { action: "ig_stories", toggle: false, reply: "" };
    if (/(otomatik|her akşam|her gün).*(aç|başlat|etkinleştir)|(^| )aç( |$)/.test(t)) return { action: "ig_stories", toggle: true, reply: "" };
    if (/(paylaş|yayınla|yükle|gönder|(^| )at( |$)|ekle)/.test(t)) return { action: "ig_stories", reply: "" };
  }
  if (/(yayınla|paylaş).*(youtube|instagram|tiktok|tik tok)/.test(t) || /(youtube|instagram|tiktok|tik tok).*(yayınla|paylaş|yükle)/.test(t))
    return { action: "publish", platforms: ["youtube", "instagram", "tiktok"].filter((p) => t.replace("tik tok", "tiktok").includes(p)), reply: "" };
  // Uzun veya bileşik cümleler (iki istek, soru, gerekçe) hızlı kurallara değil beyne gider.
  const words = t.split(" ").length;
  if (/(abone|takipçi)/.test(t) && /(kaç|sayı|durum|ne kadar|kazan|arttı|var mı|göster|söyle)/.test(t)) return { action: "followers", reply: "" };
  if (/yorum(lar|ları)?\S* (şimdi )?(yanıtla|cevapla)|yorumlara (yanıt|cevap) ver/.test(t)) return { action: "comments_reply", reply: "" };
  if (/\byorum(lar|ları)?\b.*(özet|özetle|ne diyor|neler|oku)|yorum özeti/.test(t)) return { action: "comments_digest", reply: "" };
  if (/(haftanın özeti|haftalık özet).*(üret|hazırla|yap|başlat|çıkar)/.test(t)) return { action: "weekly_summary", reply: "" };
  if (/(günün özeti|günlük özet|uzun özet).*(üret|hazırla|yap|başlat|çıkar)/.test(t)) return { action: "daily_summary", reply: "" };
  if (/haftal[ıi]k.*(rapor|özet|performans)|(bu|geçen) hafta.*(nasıl gitti|rapor)/.test(t)) return { action: "weekly_report", reply: "" };
  if (words > 9 || /(^| )(ve|bir de|sonra da|neden|niye|niçin|sence|hangisi|nasıl)( |$)/.test(t)) return { action: "brain", reply: "" };
  if (/^(sesini|sesi|konuşmanı|biraz)?\s*(biraz\s*)?(daha\s*)?(hızlandır|hızlı konuş)\s*(lütfen)?$/.test(t) || /^(ses|konuşma)\s*(hızını)?\s*(biraz\s*)?(artır|yükselt|hızlandır)$/.test(t)) return { action: "voice_speed", delta: 25, reply: "" };
  if (/^(sesini|sesi|konuşmanı|biraz)?\s*(biraz\s*)?(daha\s*)?(yavaşlat|yavaş konuş)\s*(lütfen)?$/.test(t) || /^(ses|konuşma)\s*(hızını)?\s*(biraz\s*)?(azalt|düşür|yavaşlat)$/.test(t)) return { action: "voice_speed", delta: -25, reply: "" };
  if (/(doğal ses|gerçekçi ses|insan sesi|chatterbox)/.test(t)) return { action: /(kapat|durdur)/.test(t) ? "voice_natural_off" : "voice_natural_on", reply: "" };
  if (/(whatsapp|vatsap|watsap)/.test(t)) return { action: /(gönder|yolla|at)/.test(t) ? "whatsapp_send" : "whatsapp_on", reply: "" };
  if (/(tünel|tunnel|cloudflare)/.test(t)) return { action: /(kapat|durdur)/.test(t) ? "tunnel_off" : "tunnel_on", reply: "" };
  if (/(zamanlay|otomatik|periyodik)/.test(t)) {
    if (/(kapat|durdur|iptal)/.test(t)) return { action: "schedule_off", reply: "" };
    return { action: "schedule_on", hours: extractHours(t), reply: "" };
  }
  if (/(üret|oluştur|hazırla|yap|çek|başlat)/.test(t) && /(video|gündem|özet|haber)/.test(t))
    return { action: "generate", duration: extractSeconds(t) || 30, reply: "" };
  if (/(üret|oluştur|hazırla|başlat)/.test(t) && extractSeconds(t))
    return { action: "generate", duration: extractSeconds(t), reply: "" };
  if (/(izlenme|istatistik|metrik).*(güncelle|çek|yenile|tazele)/.test(t) || /(güncelle|tazele).*(izlenme|istatistik)/.test(t)) return { action: "sync_metrics", reply: "" };  // "izlenmeleri güncelle" oynatmaya gitmesin
  if (/(son|en yeni|sonuncu).*(oynat|aç|göster|izle)/.test(t) || /(oynat|izle)/.test(t)) return { action: "play_latest", reply: "" };
  if (/finder/.test(t)) return { action: "reveal", reply: "" };
  if (/(paylaş|gönder|telefon)/.test(t)) return { action: "share", reply: "" };
  if (/\b(sistem kontrol|kontrol et|kendini test et|test yap|sistem testi|her şey yolunda mı)\b/.test(t)) return { action: "selftest", reply: "" };
  if (/(durum|ne durumda|nasıl gidiyor|bitti mi|kaç video)/.test(t)) return { action: "status", reply: "" };
  if (/(rapor|özet ver|nasıl gitti|performans)/.test(t)) return { action: "report", reply: "" };
  if (/(plan|strateji|ne yapalım|öneri)/.test(t)) return { action: "plan", reply: "" };
  if (/(listele|videoları göster|yenile)/.test(t)) return { action: "refresh", reply: "Liste yenilendi." };
  if (/(merhaba|selam|jarvis)/.test(t)) return { action: "none", reply: "Buradayım. Video üret, son videoyu oynat, paylaş veya durum diyebilirsiniz." };
  return { action: "brain", reply: "" };  // kural yok → Jarvis'in beyni düşünsün
}
