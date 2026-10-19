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
  // (yt-dlp "watch?v=ID/mizah" adresini indiremez), `tag` olarak döner; çağıran talimata ekler
  const tm = url.toLocaleLowerCase("tr-TR").match(/\/+(mizah|komik|trend|viral|haber)\/*$/);
  if (tm && videoLink(url.slice(0, tm.index))?.kind === "video") return { raw: m[0], url: url.slice(0, tm.index), tag: tm[1] };
  return { raw: m[0], url, tag: "" };
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
const whenKeepingPositions = (text, keep = true) => {
  const saved = [];
  const w = parseWhen(keep ? text.replace(POS_RE, (m) => { saved.push(m); return `⟪POS${String.fromCharCode(65 + saved.length - 1)}⟫`; }) : text);
  // linke bitişik ek ("youtu.be/…'yi haber yap") talimata girmez
  return { ...w, rest: w.rest.replace(/⟪POS([A-Z])⟫/g, (_, c) => saved[c.charCodeAt(0) - 65] ?? "").replace(/^\s*['’]\p{L}{0,6}(?=\s|$)/u, "") };
};
// Video linkinde yalnız açma isteği ("youtu.be/… oynat", "şunu açar mısın youtu.be/…"): linkin dışında başka söz kalmamalı. Ses talimatı
// ("haber yap, kendi sesiyle oynat", "sesiyle çal", "videonun sesini açın") haber isteğidir (inceleme, 18 Ekim: tarayıcıda açılıyordu)
const OPEN_ONLY = /^(?:(?:şunu|bunu|şu|bu|videoyu|linki|lütfen|hemen)\s+)*(?:aç|çal|oynat|göster)(?:ar|ır|ın|sana|abilir)?(?:\s+(?:mısın|mısınız|misin|misiniz|lütfen))*$/;
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
  // fragman analizine dönmez); kanal/oynatma listesi linkine Türkçe yanıt
  if (an && vl && an[1].includes(lk.raw)) {
    if (vl.kind !== "video") return { action: "none", reply: vl.reply };
    const w = whenKeepingPositions(an[1].replace(lk.raw, " "), vl.platform === "YouTube");
    return { action: "social_video", url: vl.url, instruction: `son dakika ${lk.tag || ""} ${w.rest}`.replace(/\s+/g, " ").trim(), publishAt: w.at ? w.at.toISOString() : undefined, reply: "" };
  }
  if (an) return { action: "anlik", topic: an[1].trim(), duration: 30, reply: "" };
  // Haber linki → sayfa okunur, ondan son dakika videosu ("aç" denirse tarayıcıda açılır)
  if (lk) {
    // video linkinde yalnız açma isteği varsa çal/oynat ve kibar biçimleri de açar ("şunu açar mısın", OPEN_ONLY); "12:30'dan oynat",
    // "kendi sesiyle oynat" haber talimatıdır
    if (/(^|\s)(aç|göster)(\s|$)/.test(t) || (vl && OPEN_ONLY.test(norm(String(raw).replace(lk.raw, " ")))))
      return { action: "open_url", target: lk.url, reply: "" };
    // yayın saati (kullanıcı isteği: "linki gönderip bunu şu saatte paylaş diyeyim; saat yazmazsam direkt paylaşsın"); YouTube video
    // linkinde videodaki konum ("12:30'dan itibaren") yayın saati sanılmaz, talimatta kalır
    const when = vl?.kind === "video" ? whenKeepingPositions(String(raw).replace(lk.raw, " "), vl.platform === "YouTube") : parseWhen(String(raw).replace(lk.raw, " "));
    const publishAt = when.at ? when.at.toISOString() : undefined;
    // sosyal medya paylaşımı: videosu indirilip kurgulanır (linkin dışında yazılan, nasıl bir haber istendiğidir)
    if (vl?.kind === "video") return { action: "social_video", url: vl.url, instruction: insOf(`${lk.tag || ""} ${when.rest}`), publishAt, reply: "" };
    if (vl?.reply) return { action: "none", reply: vl.reply };  // YouTube kanal / oynatma listesi / diğer sayfa
    return { action: "anlik", topic: String(raw).trim(), duration: extractSeconds(t) || 30, publishAt, reply: "" };
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
  // Yayın sırası: "tiktok sırası", "sırada ne var", "bekleyen videolar"
  if (/(tiktok|youtube|yayın|yükleme)? ?sıra(sı|da ne var|daki videolar)|bekleyen (video|yükleme)/.test(t) && !/sıraya al/.test(t)) return { action: "queue", reply: "" };
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
