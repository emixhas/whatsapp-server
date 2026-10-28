// Video kuyruğu (kullanıcı isteği, 20 Ekim: "hem panelden hem WhatsApp'tan 3-5 video seçersem sıralasın, kuyruktan devam etsin; iptal de
// edebilelim"): link videoları (WhatsApp, panel, trend kartı, otomatik trend) TEK sıralı kuyrukta bekler, sırası gelen socialVideoNews ile
// indirilir ve kurgulanır (aynı anda tek paylaşım), kurgusu biten startAnlik'in kendi sırasına (anlikQueue) geçer. Sahibin işleri (WhatsApp,
// panel) otomatik trend işlerinden önce (kendi aralarında geliş sırasıyla); sahibin en çok 10, otomatiğin en çok 5 işi bekler; 6 saatten eski
// bekleyen iş bayatlar (logda). Kuyruk data/video_queue.json'da: panel yeniden başlarsa bekleyenler kalır, yarım kalan iş baştan başlar
// (hiçbir şey yayınlanmadı: yayın her link videosunda onaya gelir). İptal: bekleyen iş çıkarılır; hazırlanan işin süreçleri (social_video.py,
// wa_video.py ve altındaki yt-dlp/ffmpeg) öldürülür; üretime geçmiş iş anlık sırasından çıkarılır ya da yalnız onun üretimi durdurulur.
// KİMLİK (4. tur, inceleme, 20 Ekim: sıra numarası iki yanıtta farklı videoları gösterip "kuyruk iptal N" yanlış videoyu iptal ediyordu):
// her iş girerken kısa, değişmeyen bir numara alır (#7; artan sayaç video_queue.json'da, 24 saat içinde tekrar etmez). Her yanıt, panel
// satırı ve log satırı bu numarayı yazar; "kuyruk iptal 7" / "#7 iptal" yalnız o işi iptal eder; sıradaki yer ("2. sıra") hiçbir komutta
// tutamak değildir ("2. sırayı iptal et" listeyi gösterip numarayı sorar).
// Bağlam: işin socialVideoNews çağrısı AsyncLocalStorage içinde koşar; server.js runLines süreci kaydeder (iptalde öldürülür, üretim
// sonunun temizliği — reap — bu süreçlere ve torunlarına dokunmaz), sendW otomatik ve iptal edilen işte WhatsApp'a yazmaz, startAnlik işi
// etiketler (opts.vq) ve iptal edilmişse başlatmaz.
import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { findLink, videoLink, parseCommand } from "./commands.js";
import { whenLabel } from "./when.js";

const als = new AsyncLocalStorage();
// yalnız süren (canlı) işin bağlamı: iş bittikten sonra bu bağlamdan doğan zamanlayıcı/olay işi etiketlemesin
export const vqCtx = () => { const c = als.getStore(); return c && c.live ? c : null; };
// süren kuyruk işinin numarası log satırları için (" (#7)"; kuyruk işi değilse "")
export const vqTag = () => { const c = vqCtx(); return c?.no ? ` (#${c.no})` : ""; };
// sahibe giden hata mesajı için numara + link (" (#7 · instagram.com/reel/…)"; 5. tur, inceleme, 20 Ekim: üç linkten hangisinin düştüğü yazmıyordu)
export const vqWho = () => { const c = vqCtx(); return c?.no ? ` (#${c.no} · ${shortUrl(c.url)})` : ""; };

const OWNER_MAX = 10, AUTO_MAX = 5, STALE_MS = 6 * 3600000, NO_RESET_MS = 24 * 3600000, IDLE_RESET_MS = 3600000, NO_MAX = 999;
const SRC = { whatsapp: "WhatsApp", panel: "panel", "trend-auto": "🤖 otomatik" };
const STEP = { indiriliyor: "indiriliyor", kurgu: "kurgu yapılıyor", "üretiliyor": "üretiliyor", "iptal ediliyor": "iptal ediliyor" };
// Instagram gönderisi kısa koduyla (reel/p/tv aynı gönderi, ?igsh= paylaşım eki yok sayılır); diğerleri alan + yol + sorgu (izleme ekleri atılır)
export function normUrl(u) {
  try {
    const x = new URL(String(u || "").trim()), host = x.hostname.replace(/^(www\.|m\.)/, "").toLowerCase();
    const ig = host.endsWith("instagram.com") && x.pathname.match(/^\/(?:reels?|p|tv)\/([A-Za-z0-9_-]+)/);
    if (ig) return `instagram:${ig[1]}`;
    for (const k of [...x.searchParams.keys()]) if (/^(si|igsh|igshid|feature|utm_\w+|fbclid|is_from_webapp|sender_device)$/i.test(k)) x.searchParams.delete(k);
    return `${host}${x.pathname.replace(/\/+$/, "")}${x.searchParams.toString() ? "?" + x.searchParams.toString() : ""}`;
  } catch { return String(u || "").trim(); }
}
const shortUrl = (u) => String(u || "").replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "").slice(0, 70);
// harf kümesiyle kesilir (emoji ortadan bölünüp "�" olmasın; inceleme, 20 Ekim); 6. tur: kelime ortasından değil, son boşlukta (kelime çok
// uzunsa — kesilen metnin %60'ından önceki boşluk — harf kümesinde)
const GRAPH = new Intl.Segmenter("tr", { granularity: "grapheme" });
export const oneLine = (s, n) => {
  const t = String(s || "").replace(/\s+/g, " ").trim(), g = [...GRAPH.segment(t)];
  if (g.length <= n) return t;
  let cut = g.slice(0, n - 1).map((x) => x.segment).join("");
  if (g[n - 1]?.segment !== " ") { const sp = cut.lastIndexOf(" "); if (sp >= Math.floor(cut.length * 0.6)) cut = cut.slice(0, sp); }
  return cut.replace(/[\s,.;:!?…\-–—"'“”]+$/u, "") + "…";
};
// ilk cümle (en çok n harf; kelime ortasından kesilmez)
const firstSentence = (s, n = 110) => { const t = String(s || "").replace(/\s+/g, " ").trim().split(/(?<=[.;!?])\s/)[0].replace(/[.;]$/, ""); return t.length <= n ? t : t.slice(0, n).replace(/\s+\S*$/, "") + "…"; };

// Mesajdaki TÜM linkler (commands.js findLink ile tek tek; findLink'in link saymadığı aday — "instagram.com/hesap" — boşlukla örtülüp geçilir).
// Aday kalıbı commands.js LINK_RE ile aynı tutulur.
const VIDEO_HOSTS = String.raw`(?:[\w-]+\.)*(?:youtube\.com|youtu\.be|youtube-nocookie\.com|instagram\.com|tiktok\.com|x\.com|twitter\.com|facebook\.com|fb\.watch)`;
const CAND_RE = new RegExp(String.raw`https?:\/\/[^\s<>"'’]+|(?<![\w.@\/-])` + VIDEO_HOSTS + String.raw`\/[^\s<>"'’]*`, "i");
const SOCIAL_HOST = new RegExp(String.raw`^https?:\/\/` + VIDEO_HOSTS + String.raw`(?:[\/?#:]|$)`, "i");
// sosyal medya / video sitesi alanı (kodun video saymadığı da: Instagram hikâyesi, Facebook gönderisi, instagram.com/share/reel, Vimeo,
// Dailymotion…). 6. tur, karar 4: haber sayfası linki bu alanlardan HERHANGİ bir linkle aynı mesajdaysa hiçbir zaman kendi başına üretilmez
// (haber linkinden video onaysız yayınlanır; inceleme, 20 Ekim: "<haber> <instagram hikâyesi>" haberi onaysız yayınlıyordu)
const SOCIAL_DOMAINS = String.raw`(?:youtube\.com|youtu\.be|youtube-nocookie\.com|instagram\.com|instagr\.am|ig\.me|tiktok\.com|x\.com|twitter\.com|t\.co|facebook\.com|fb\.com|fb\.watch|fb\.me|vimeo\.com|dailymotion\.com|dai\.ly|threads\.net|threads\.com|twitch\.tv|kick\.com|reddit\.com|redd\.it|snapchat\.com|linkedin\.com|pinterest\.com|pin\.it|t\.me|telegram\.me|rumble\.com|vk\.com|ok\.ru|likee\.video|bilibili\.com)`;
const SOCIAL_ANY = new RegExp(String.raw`^https?:\/\/(?:[\w-]+\.)*` + SOCIAL_DOMAINS + String.raw`(?:[\/?#:]|$)`, "i");
// şemasız yazılmış sosyal medya adresi ("vimeo.com/123", "instagram.com/hesap"): link sayılmasa da haber linkini üretimden çıkarır
const SOCIAL_BARE = new RegExp(String.raw`(?<![\w.@\/-])(?:[\w-]+\.)*` + SOCIAL_DOMAINS + String.raw`\/[^\s<>"'’]*`, "gi");
export function linksOf(text) {
  let s = String(text || ""); const out = [];
  for (let i = 0; i < 40; i++) {
    const lk = findLink(s);
    const m = s.match(CAND_RE); if (!m) break;
    if (lk && lk.raw === m[0]) out.push({ ...lk, index: m.index });
    s = s.slice(0, m.index) + " ".repeat(m[0].length) + s.slice(m.index + m[0].length);
  }
  return out;
}
// açık "tek videoda birleştir" isteği (birden çok video linkiyle): linklerde birden çok videodan tek kurgu yolu yok; yalnız ilk video alınır.
// "ikisinden / hepsini / iki videodan / bunlardan / aynı olayın … bir video/haber" da (5. tur, inceleme, 20 Ekim: "hepsini bir videoda topla",
// "ikisi bir video olsun" iki iş oluyordu). Olumsuzu birleştirme isteği değil ("tek video yapma", "birlikte kullanma", "aynı haberde kullanma";
// TOGETHER_NEG); "ayrı ayrı", "her biri", "tek tek", "farklı/ayrı olay" önce gelir (SEPARATE).
const TOGETHER = /(?:^|[^\p{L}])(?:tek\s+(?:bir\s+)?(?:video|haber|klip|montaj|kurgu)\p{L}*|birleştir\p{L}*|bir\s+arada|aynı\s+(?:haberde|videoda|habere|videoya|montajda|kurguda)|(?:ikisini|üçünü|dördünü|beşini|hepsini|tümünü|videoları|linkleri)\s+(?:birlikte|beraber|bir\s+arada|tek)|(?:birlikte|beraber)\s+(?:kullan|kurgula|yap|haber|anlat|montaj)\p{L}*)/u;
const TOGETHER_ALL = /(?:^|[^\p{L}])(?:ikisi\p{L}*|üçü\p{L}*|dördü\p{L}*|hepsi\p{L}*|tümü\p{L}*|bunlar\p{L}*|şunlar\p{L}*|iki\s+\p{L}+|üç\s+\p{L}+|aynı\s+olay\p{L}*)(?![\p{L}])/u;
const TOGETHER_ONE = /(?:^|[^\p{L}])(?<!her\s)bir\s+(?:video|haber|klip|montaj|kurgu)\p{L}*/u;
const TOGETHER_NEG = /^(?:\s*\p{L}+){0,2}?\s*(?:(?:yap|kullan|birleştir|kurgula|anlat|topla|koy|hazırla|üret|çek|yaz|göster|getir|çevir|dönüştür)m[ae]\p{L}*|olmasın|olmayacak|değil\p{L}*|istemiyorum|istemem|istemiyoruz|gerek\s+yok)(?![\p{L}])/u;
const SEPARATE = /(?:^|[^\p{L}])(?:ayrı\s+ayrı|ayrı\s+(?:bir\s+)?(?:video|haber)\p{L}*|her\s+(?:biri|birini|birinden|link|video)\p{L}*|tek\s+tek|(?:farklı|ayrı|başka)\s+(?:olay|haber|konu)\p{L}*)/u;
function togetherAsk(words) {
  if (SEPARATE.test(words)) return false;
  const m = words.match(TOGETHER);
  if (m) { const end = m.index + m[0].length, last = m[0].trim().split(/\s+/).pop(); return !TOGETHER_NEG.test(last) && !TOGETHER_NEG.test(words.slice(end)); }
  const o = words.match(TOGETHER_ONE);
  return !!o && TOGETHER_ALL.test(words) && !TOGETHER_NEG.test(words.slice(o.index + o[0].length));
}
// Çok linkli mesaj (kullanıcı isteği, 20 Ekim: "3-5 video seçersem sıralasın"): en az iki video linki ya da video linki + haber sayfası linki
// varsa toplu iştir; her video linki için mesaj, diğer linkler atılarak tek linkli mesaj gibi çözülür (parseCommand): ortak metin talimat,
// linke bitişik etiket ("/mizah") o linkin, yayın saati hepsinin. Haber sayfası linki (video/sosyal medya linki olmayan) video linkiyle aynı
// mesajda HİÇBİR ZAMAN kendi başına üretilmez, her videonun talimatına kaynak olarak eklenir (haber linkinden video onaysız yayınlanır, video
// linkinden video onay ister; 4. tur: "bilgiler şu haberlerde: <haber> <haber> <reel> <reel>"; 5. tur, inceleme, 20 Ekim: TEK video linki
// yanında ÖNCE yazılan haber linki — "<haber> <reel>", "kaynak: <haber> <reel>", "son dakika: <haber> <reel>" — HEAD'in yolunda ilk link
// olarak onaysız yayınlanan son dakika videosu oluyor, reel hiç inmiyordu). Yalnız haber linkli ya da tek video linkli (yanında yalnız kanal/
// profil linki olan) mesaj HEAD'in yolu (null). Video sitesinin video olmayan sayfası (kanal, profil, oynatma listesi) atlanır (yanıtta adıyla).
// Açma isteği ("aç", "açar mısın", "oynat"): yalnız açılır (open: açılacak linkler), hiçbir şey üretilmez; eskiden tam mesaj HEAD'in yoluna
// dönüyor ve önce yazılan haber linki üretiliyordu (5. tur). Açık "tek videoda / birlikte / aynı haberde" isteği: linklerden çok videolu tek
// kurgu yok, yalnız ilk video alınır (merged: alınmayanlar).
// bitişik yazılmış linkler ("<haber>,https://…", ";https://", "…https://") ayrı linktir (7. tur, inceleme, 21 Ekim: virgülle bitişik "<haber>,<reel>"
// tek link sanılıp haber videosu oluyor, reel hiç inmiyordu)
export const splitGlued = (text) => String(text || "").replace(/([^\s])(https?:\/\/)/gi, "$1 $2");
export function parseBatch(text) {
  const raw = splitGlued(text), all = linksOf(raw), seen = new Set(), links = [];
  for (const l of all) { const k = normUrl(l.url) + "|" + (l.tag || ""); if (!seen.has(k)) { seen.add(k); links.push(l); } }
  const isVid = (l) => videoLink(l.url)?.kind === "video";
  const social = (l) => !!videoLink(l.url) || SOCIAL_HOST.test(l.url) || SOCIAL_ANY.test(l.url);
  const vids = links.filter(isVid), others = links.filter((l) => !isVid(l)), newsL = others.filter((l) => !social(l)), skipL = others.filter(social);
  // bu link dışındaki bütün linkler atılmış mesaj (keep null: hepsi atılır)
  const strip = (keep) => { let t = raw; for (const o of all.filter((x) => x !== keep).sort((a, b) => b.index - a.index)) t = t.slice(0, o.index) + " " + t.slice(o.index + o.raw.length); return t.replace(/[ \t]{2,}/g, " ").trim(); };
  // 6. tur, karar 4: haber linki + sosyal medya alanından HERHANGİ bir link (video sayılmayan da, şemasız yazılmış da): haber linki üretilmez.
  // 7. tur (inceleme, 21 Ekim: listede olmayan alanlar — streamable, kwai, bsky, fxtwitter, whatsapp kanalı — haber linki sayılıp haber linki
  // ONAYSIZ yayınlanıyordu): kural tersine çevrildi; haber linki YALNIZ mesajdaki tek linkse kendi başına üretilir (HEAD'in yolu), yanında başka
  // herhangi bir link (sosyal medya, video sitesi, başka haber sitesi, bilinmeyen alan, şemasız sosyal medya adresi) varsa hiçbir haber linki
  // üretilmez: video linkleri kuyruğa girer, haber linkleri kaynaktır, video linki yoksa hiçbir şey yapılmaz
  const bare = [...new Set((strip(null).match(SOCIAL_BARE) || []).map((s) => s.replace(/[.,;:!?)\]]+$/, "")))];
  const mixed = newsL.length > 0 && links.length + bare.length >= 2;
  if (!vids.length && !mixed) return null;
  if (vids.length === 1 && !newsL.length) return null; // tek video linki (yanında yalnız kanal/profil linki): HEAD'in yolu
  const words = strip(null).toLocaleLowerCase("tr-TR");
  const together = togetherAsk(words);
  const sources = newsL.map((l) => l.url);
  const unsup = (why) => `bu link türü desteklenmiyor${why ? ` (${firstSentence(why, 70)})` : ""}`;
  const videos = [], open = [], skipped = [...skipL.map((l) => ({ url: l.url, why: unsup(videoLink(l.url)?.reply || "") })), ...bare.map((u) => ({ url: u, why: unsup("") }))];
  for (const l of vids) {
    const c = parseCommand(strip(l));
    if (c.action === "open_url" || c.action === "open_youtube") { open.push(l.url); continue; }
    if (c.action === "social_video") videos.push({ url: c.url, instruction: [c.instruction || "", ...sources].filter(Boolean).join(" "), kind: c.kind || "", publishAt: c.publishAt || null, timeDoubt: !!c.timeDoubt });
    else skipped.push({ url: l.url, why: c.reply || "video linki okunamadı" });
  }
  // açma isteği: video linkleri açılır, haber linki yalnız kendi başına da açma isteğiyse (HEAD'in haber linki kuralı); üretim yok. Video linki
  // yoksa (yalnız desteklenmeyen sosyal medya linki) haber linki kendi başına açma isteğiyse açılır
  if (open.length || !vids.length) { for (const l of newsL) if (parseCommand(strip(l)).action === "open_url") open.push(l.url); }
  if (open.length) return { open, videos: [], news: [], skipped: [], sources, merged: [] };
  if (together && videos.length > 1) return { videos: videos.slice(0, 1), news: [], skipped, sources, merged: videos.slice(1).map((v) => v.url) };
  return { videos, news: [], skipped, sources, merged: [] };
}

// WhatsApp / panel sohbeti kuyruk ve trend komutları (Claude'a gitmez; commands.js kurallarından ÖNCE çözülür, tam mesaj kalıbı):
// "kuyruk", "video kuyruğu" · numaralı iptal (aşağıda strictCommand: "iptal 7", "#7 iptal", "iptal #7", "kuyruk iptal 7 9") · "şu ankini iptal et"
// (hazırlanan ya da üretilen iş) · "kuyruğu temizle" · "2. sırayı iptal et" (sıra yeri: liste + numara sorulur) · "trendler" · "trend 1 3 5" /
// "trend 1,3" / "trend 2-4" (+ "haber yap": haber olarak) · trend otomatiği: "trend" geçen ve aç/kapat/başlat/durdur diyen HER mesaj (aşağıda
// trendRoute; 5 saatlik üretim zamanlayıcısına hiç gitmez). 6. tur: "kuyruktan 7'yi çıkar", "3 numaralı videoyu iptal et" gibi serbest
// söyleyişler iptal etmez (numaralı listeyi ve tam yazımı gösterir; karar 2)
const CANCEL_V = String.raw`(?:iptal(?:\s+et(?:in)?)?|sil(?:in)?|çıkar(?:ın)?|kaldır(?:ın)?)`;
const Q_LIST = /^(?:video\s+)?kuyru(?:k|ğu)(?:\s+(?:göster|durumu|ne\s+durumda))?$|^(?:video\s+)?kuyru(?:kta|ğunda)\s+(?:ne(?:ler)?\s+var|kaç\s+video\s+var)$|^kuyruğa\s+bak$/u;
// sıradaki YER ("2. sıra", "kuyruktaki 2. video"): tutamak değil, liste gösterilip numara sorulur
const Q_CANCEL_POS = [
  new RegExp(String.raw`^(?:video\s+)?kuyruk(?:tan|taki|ta)?\s+\d{1,2}\.\s*(?:(?:videoyu|sırayı|linki|işi|sıradakini)\s+)?${CANCEL_V}$`, "u"),
  new RegExp(String.raw`^\d{1,2}\.\s*sıra(?:yı\s+${CANCEL_V}|daki(?:ni|\s+videoyu)?\s+iptal(?:\s+et(?:in)?)?)$`, "u"), // "2. sıradakini sil/çıkar" yükleme sırası komutudur (commands.js queue_drop)
  new RegExp(String.raw`^(?:(?:video\s+)?kuyruk(?:taki|tan|ta)\s+)?(?:sıradaki|sonraki|ilk|son|sonuncu|ikinci|üçüncü|dördüncü|beşinci)\s+(?:videoyu|linki|işi)\s+${CANCEL_V}$`, "u"),
];
const Q_CANCEL_CUR = new RegExp(String.raw`^(?:şu\s*an(?:ki(?:ni)?|kini)|şimdiki(?:ni)?|hazırlanan(?:ı)?|indirilen(?:i)?)(?:\s+(?:videoyu|video|linki|işi))?\s+(?:iptal(?:\s+et)?|durdur|kes|sil)$`, "u");
const Q_CLEAR = /^(?:video\s+)?kuyruğu(?:nu)?\s+(?:temizle|boşalt|sil|sıfırla|iptal\s+et)$|^kuyruktak(?:ileri|i\s+videoları)\s+(?:sil|iptal\s+et|temizle)$|^(?:video\s+)?kuyruktaki\s+(?:hepsini|tümünü|bütün\s+videoları|tüm\s+videoları)\s+(?:sil|iptal\s+et|temizle|çıkar)$/u;
const Q_CANCEL_ASK = /^(?:video\s+)?kuyruk(?:tan|taki)?\s+(?:iptal(?:\s+et)?|sil|çıkar)$/u;
const T_LIST = /^(?:(?:son|güncel|instagram|insta)\s+)*trend(?:ler(?:i)?|\s+listesi)(?:\s+(?:göster|listele|gönder|at|yolla|neler|ne\s+var|var\s+mı))?$/u;
const T_PICK = /^trend(?:ler(?:den)?)?\s*[:#]?\s*(\d{1,2}(?:\s*(?:,|ve|-|–|\+|ile|\s)\s*\d{1,2})*)(\s+(?:yap|üret|hazırla|sıraya\s+al|haber(?:ini|i)?\s+yap|haber\s+olarak\s+yap|videosunu\s+yap|videosu\s+yap))?$/u;
const T_AUTO = /^(?:instagram\s+)?(?:trend(?:ler(?:den|in)?)?\s+(?:otomatiğini|otomatiği|otomatik(?:\s+üretim(?:ini|i)?)?)|otomatik\s+trend(?:\s+(?:üretimini|üretimi|videolarını|videoları))?|trendlerden\s+otomatik\s+(?:üretimi|video\s+üretimini))\s+(aç|açık|kapat|kapalı|başlat|durdur|etkinleştir|devre\s+dışı\s+bırak|açık\s+mı|kapalı\s+mı|ne\s+durumda)$/u;
// Trend otomatiği (4. tur, inceleme, 20 Ekim: "otomatik kapat trendleri", "trendleri otomatik üretmeyi kapat" gibi doğal söyleyişler 5 saatlik
// üretim zamanlayıcısını — setAutoMode / schedule_off — kapatıyordu): "trend" geçen (trendyol değil) ve aç/kapat/başlat/durdur/etkinleştir/devre
// dışı kökü olan her mesaj buraya gelir; istek biçimi açık ve otomatik/üretim sözü varsa trend otomatiği açılır/kapanır, durum sorusu durumu
// söyler, diğer her şey (olumsuz "kapatma", hem aç hem kapat, otomatik sözü yok: "trendleri kapat", "trend takibini durdur") yalnız ne
// yazılacağını sorar. Linkli mesaj ve "son dakika: …" konusu buraya girmez (video/haber isteğidir).
const TREND_W = /(?:^|[^\p{L}])trend(?!yol)/u;
const T_STEM = /(?:^|[^\p{L}])(?:aç(?!ıkla)|kapa|başlat|durdur|etkinleştir|devre\s*dışı|devreye|çalıştır)/u;
const T_ON = /^(?:aç|açın|açınız|açar|açarmısın|açsana|açsın|açıver|açıverin|açalım|açılsın|açabilir|açabilirsin|açabilirmisin|başlat|başlatın|başlatınız|başlatır|başlatsana|başlatsın|başlatalım|başlatılsın|başlatabilir\p{L}*|etkinleştir|etkinleştirin|etkinleştirsene|etkinleştirilsin|etkinleştirebilir\p{L}*|çalıştır|çalıştırın|çalıştırsana|çalıştırsın|çalıştırılsın|çalıştıralım|devreye)$/u;
const T_OFF = /^(?:kapat|kapatın|kapatınız|kapatır|kapatsana|kapatsın|kapatıver|kapatıverin|kapatalım|kapatılsın|kapatabilir\p{L}*|kapa|kapansın|durdur|durdurun|durdurunuz|durdurur|durdursana|durdursun|durdurulsun|durduralım|durdurabilir\p{L}*|dursun|bırak|bırakın|bıraksın|devre)$/u;
const T_NEG = /^(?:aç|kapat|kapa|başlat|durdur|etkinleştir|çalıştır|bırak)(?:ma|mayın|mayınız|masın|mayalım|madan|mamak|mamalı)$/u;
const T_STATUS = /(?:açık|kapalı|değil)\s+m[ıiuü](?![\p{L}])|ne\s+durumda|durumu\s+ne/u;
// yön belirsiz: koruma/olumsuz sözü ("açık olmasın", "kapalı kalmasın", "trendler kalsın", "devam etsin", "dokunma") ya da birden çok yan
// cümle ("otomatik modu kapat, trendler kalsın"): hiçbir şey değişmez, durum ve komut yazılır (5. tur, inceleme, 20 Ekim: bu söyleyişler trend
// otomatiğini ters yöne çeviriyordu)
const T_KEEP = /(?:^|[^\p{L}])(?:kals[ıi]n|kalmas[ıi]n|olsun|olmas[ıi]n|devam\p{L}*|dokunma\p{L}*|elleme\p{L}*|değil\p{L}*|bırakma\p{L}*|istemiyorum|istemem)(?![\p{L}])/u;
const T_CLAUSE = /[,;:]|(?:^|\s)(?:ama|ve|fakat|ancak|sonra|yalnız|sadece|yoksa|veya)\s/u;
const T_AUTO_W = /otomat|kendiliğinden|(?:^|[^\p{L}])oto(?![\p{L}])|üret/u;
function trendRoute(t) {
  if (t.length > 300 || !TREND_W.test(t) || /^(?:son\s*(?:dakika|dk)|anlık\s+haber)/u.test(t) || /https?:|www\.|[\p{L}\d]\.(?:com|be|tv|net|org|watch)\//u.test(t)) return null;
  const status = T_STATUS.test(t);
  // aç/kapat kökü yoksa da otomatik/zamanlayıcı sözü geçen trend mesajı ("trend otomatik", "trendleri otomatik üretme") zamanlayıcı kuralına gitmesin
  if (!status && !T_STEM.test(t) && !/otomat|zamanlay|periyodik|kendiliğinden/u.test(t)) return null;
  const auto = T_AUTO_W.test(t);
  if (status) return auto ? { kind: "auto", on: null } : { kind: "autoAsk" };
  const tok = t.split(/[^\p{L}]+/u).filter(Boolean);
  const neg = tok.some((w) => T_NEG.test(w)), on = tok.some((w) => T_ON.test(w)), off = tok.some((w) => T_OFF.test(w));
  if (!auto || neg || on === off || T_KEEP.test(t) || T_CLAUSE.test(t)) return { kind: "autoAsk" };
  // mesaj 5 saatlik üretimi de anıyorsa ("otomatik üretimi de trend otomatiğini de kapat"): yanıt ona dokunulmadığını söyler (sched)
  return /(?:^|[^\p{L}])(?:mod\p{L}*|yayın\p{L}*|zamanlay\p{L}*|tam\s+otomatik|5\s*saat\p{L}*)(?![\p{L}])|\s(?:de|da)\s/u.test(t) ? { kind: "auto", on, sched: true } : { kind: "auto", on };
}
// ---- NUMARALI KOMUTLAR (6. tur, karar 2; inceleme, 20 Ekim: "#3 yayınlanmasın", "onay 3 değil 4", "#3 iptal etme", "#3'ü bana at" gibi olumsuz,
// soru ve "bana gönder" biçimleri #3'ü yayınlıyor ya da iptal ediyordu; sezgisel kalıp eklemek yerine riskli davranış kaldırıldı). Mesajın
// TAMAMI (yıldız/alt çizgi, emoji, "lütfen" ve baştaki/sondaki noktalama — soru işareti değil — atılınca) şunlardan biri olmalı: "onay 3", "onay 3 4", "onay #3",
// "#3 onay", "3 onay" (+ insta/youtube/tiktok), "onay hepsi", "hepsini onayla", "iptal 3", "iptal 3 4", "#3 iptal", "iptal #3",
// "kuyruk iptal 3" ("iptal 3": 3 kuyrukta ya da üretimdeyse o iş, onay bekliyorsa onayı); ayrıca "kuyruk", "kuyruğu temizle", "şu ankini iptal
// et" (aşağıda queueCommand). "#<rakam>" geçen ya da onay/iptal sözüyle rakam geçen BAŞKA her mesaj hiçbir şey yapmaz (yayın, iptal, üretim,
// beyin yok): numaralı liste ve tam yazım döner (numberGuard). Olumsuz ("yayınlanmasın", "iptal etme", "değil"), soru ve "bana gönder" böylece
// hiçbir zaman iş görmez.
// emoji (7. tur, inceleme, 21 Ekim: bütün emoji atılınca "onay 7 ❓", "onay 7 ❌", "onay 7 👎", "iptal 7 🤔" tam kalıp olup yayınlıyor ya da
// iptal ediyordu): yalnız olumlu/nötr olanlar (👍 ✅ ✔ ☑ 🙏 👌 🆗 💯 ❤ 🔥 👏 💪 🙂 😊) ve ten rengi, değişken seçici, tuş kapağı işaretleri atılır; başka her emoji
// (soru, olumsuz, gülme, bayrak…) ve tam genişlikte soru işareti "?" olur: mesaj tam kalıp sayılmaz, numaralı liste döner
const EMOJI_MARK = /[\p{Emoji_Modifier}\u{FE0E}\u{FE0F}\u{20E3}]/gu;
const EMOJI_OK = /[👍✅✔☑🙏👌🆗💯❤♥🔥👏💪🙂😊☺]/gu;
const EMOJI_ANY = /[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{200D}？¿‽]+/gu;
export function cmdNorm(text) {
  return String(text || "").toLocaleLowerCase("tr-TR").replace(/ınsta/g, "insta").replace(/(^|[^\p{L}])ıg(?![\p{L}])/gu, "$1ig").replace(/tık(\s?)tok/g, "tik$1tok")
    .replace(EMOJI_MARK, "").replace(EMOJI_OK, " ").replace(EMOJI_ANY, " ? ").replace(/[*_~]/g, "")
    .replace(/(^|\s)l[üu]tfen(?=$|[\s.,!?])/gu, "$1").replace(/\s+/g, " ")
    .replace(/^[\s.,!;:…'"“”‘’()[\]-]+|[\s.,!;:…'"“”‘’()[\]-]+$/gu, "").trim(); // soru işareti atılmaz: soru hiçbir zaman komut değil
}
const S_N = String.raw`#?\s?\d{1,3}`, S_SEP = String.raw`\s*(?:,|\+|&|\s(?:ve|ile)\s|\s)\s*`;
const S_NUMS = `${S_N}(?:${S_SEP}${S_N})*`, S_HNUMS = String.raw`#\s?\d{1,3}` + `(?:${S_SEP}${S_N})*`;
// platform adı yalnız yalın ya da yönelme/bulunma ekiyle ("insta", "instagrama", "instada", "youtube'a", "tiktokta", "reelse"); yokluk eki ("instasız",
// "youtubesuz", "tiktok'suz") ve başka her ek tam kalıp değil (7. tur, inceleme, 21 Ekim: "onay 7 instasız" yalnız Instagram'a yayınlıyordu)
const S_PSUF = String.raw`(?:['’]?(?:da|de|ta|te|a|e|ya|ye))?`;
const S_PW = String.raw`(?:insta(?:gram)?|youtube|tik\s?tok|ig|reels?|yt|shorts|tt)${S_PSUF}`;
const S_PLATS = `((?:\\s+${S_PW}(?:${S_SEP}${S_PW})*)?)`;
const S_OK = "(?:onay|onayla)";
const S_APPROVE = [new RegExp(`^${S_OK}\\s*(${S_NUMS})${S_PLATS}$`, "u"), new RegExp(`^(${S_NUMS})\\s+${S_OK}${S_PLATS}$`, "u")];
const S_ALL = [new RegExp(`^${S_OK}\\s+(?:hepsi|hepsini|tümü|tümünü)${S_PLATS}$`, "u"), new RegExp(`^(?:hepsini|tümünü)\\s+onayla${S_PLATS}$`, "u")];
const S_CANCEL = [new RegExp(`^iptal\\s*(${S_NUMS})$`, "u"), new RegExp(`^(${S_HNUMS})\\s+iptal$`, "u"), new RegExp(`^(?:video\\s+)?kuyruk\\s+iptal\\s+(${S_NUMS})$`, "u")];
const sNums = (s) => [...new Set((String(s).match(/\d{1,3}/g) || []).map(Number))];
// platform adları (yalnız yalın ya da yönelme/bulunma ekli: S_PW ile aynı; "instasız" platform adı değil)
export const platsOf = (s) => {
  const suf = "(?:da|de|ta|te|a|e|ya|ye)?", toks = cmdNorm(s).replace(/tik\s+tok/g, "tiktok").replace(/['’]/g, "").split(/[^\p{L}\p{N}]+/u).filter(Boolean), out = [];
  const has = (re) => toks.some((w) => re.test(w));
  if (has(new RegExp(`^(?:youtube${suf}|yt|shorts)$`, "u"))) out.push("youtube");
  if (has(new RegExp(`^(?:insta(?:gram)?${suf}|ig|reels?${suf})$`, "u"))) out.push("instagram");
  if (has(new RegExp(`^(?:tiktok${suf}|tt)$`, "u"))) out.push("tiktok");
  return out;
};
// ✏️ düzeltme (çizilmiş benzer video; server.js reviseCommand; kullanıcı isteği, 23 Ekim: "önce ben izleyecektim, düzeltmemiz gereken yerler varsa
// yazacaktım"): mesaj "düzelt" ile BAŞLAR — "düzelt 3: 2. sahnede …", "düzelt #3 …", "#3 düzelt …", "3 düzelt: …", "düzelt: …" (numarasız: tek onay
// bekleyen çizilmiş video ya da son 24 saatin çizilmiş videosu). Yalın "düzelt" (düzeltme/düzeltin/düzeltir misin değil: "düzeltme" olumsuz emir de
// olabilir); numara yalnız "#3" biçiminde ya da hemen ardından ayraç/satır sonu/metin sonu gelirse ("düzelt 2. sahnede …" → 2 sahnenin sırasıdır,
// metinde kalır). Düzeltme metni OLDUĞU GİBİ kalır (küçük harfe çevrilmez, emoji atılmaz): Claude'a gider
const S_REV_A = /^\s*(?:[#＃]\s?(\d{1,3})\s+)?d[üu]zelt(?![\p{L}])(?:\s*[#＃]\s?(\d{1,3})(?![\p{L}\p{N}])|\s+(\d{1,3})(?=\s*(?:[:：,;\-–—]|\n|$)))?\s*(?:[:：,;\-–—]+\s*)?(?!\s*[#＃]\s?\d)([\s\S]*)$/iu;
const S_REV_B = /^\s*(\d{1,3})\s+d[üu]zelt(?![\p{L}])\s*(?:[:：,;\-–—]+\s*)?([\s\S]*)$/iu;
export function reviseCommandOf(text) {
  const raw = String(text || "");
  if (raw.length > 4000) return null;
  let m = raw.match(S_REV_A);
  if (m) return { kind: "revise", no: Number(m[1] || m[2] || m[3]) || 0, text: m[4].trim(), raw };
  m = raw.match(S_REV_B);
  if (m) return { kind: "revise", no: Number(m[1]) || 0, text: m[2].trim(), raw };
  return null;
}
// {kind: "approve", nums | all, plats} | {kind: "cancel", nos} | {kind: "revise", no, text} | null (numara 1-999; 0 numara değil)
export function strictCommand(text) {
  const rv = reviseCommandOf(text);
  if (rv) return rv;
  const t = cmdNorm(text);
  if (!t || t.length > 120) return null;
  for (const re of S_APPROVE) { const m = t.match(re); if (m) { const nums = sNums(m[1]); return nums.length && !nums.includes(0) ? { kind: "approve", nums, plats: platsOf(m[2]) } : null; } }
  for (const re of S_ALL) { const m = t.match(re); if (m) return { kind: "approve", all: true, plats: platsOf(m[1]) }; }
  for (const re of S_CANCEL) { const m = t.match(re); if (m) { const nos = sNums(m[1]); return nos.length && !nos.includes(0) ? { kind: "cancel", nos } : null; } }
  return null;
}
// onay/iptal sözü (fiil ve ekleri: "yayınlanmasın", "paylaşma", "iptal etme" de) + rakam ya da "#<rakam>": tam kalıp değilse hiçbir şey yapılmaz.
// Linkli mesaj (yeni video isteği) ve bu sözleri rakamla kullanan, numarayla ilgisi olmayan eski komutlar (Instagram temizliği "… 1000 izlenmenin
// altındakileri sil", "18:30'daki planlı yayını iptal et", "3 dakika sonra sistemi durdur") eski yolundan geçer ("#" geçmiyorsa)
const G_HASH = /[#＃]\s?[\p{Nd}\p{No}]/u;
const G_WORD = /(?:^|[^\p{L}])(?:onay\p{L}*|yay[ıi]nla\p{L}*|yay[ıi]mla\p{L}*|payla[şs]\p{L}*|y[üu]kle\p{L}*|iptal\p{L}*|vazge[çc]\p{L}*|sil(?:in\p{L}*|me\p{L}*|di\p{L}*|ey[ıi]m|el[ıi]m|sene|s[ıi]n)?|kald[ıi]r\p{L}*|[çc][ıi]kar(?:\p{L}{0,4})|durdur\p{L}*|hay[ıi]r)(?![\p{L}])/u;
const G_PASS = new Set(["ig_cleanup", "scheduled", "stopall", "ig_autoclean", "expire", "queue_drop"]); // queue_drop: yükleme sırasından çıkarma/silme ("sıradan çıkar 2"; inceleme, 27 Ekim: numara koruması yutuyordu)
// sıra sayısı sözü de numaradır ("üçüncü videoyu instagramda yayınla": inceleme, 20 Ekim: tek bekleyen başka videoyu yayınlıyordu); "ilk"/"son" değil
const G_ORD = /(?:^|[^\p{L}])(?:birinci|ikinci|üçüncü|ucuncu|dördüncü|dorduncu|beşinci|besinci|altıncı|altinci|yedinci|sekizinci|dokuzuncu|onuncu)(?:si|sı|sü|su)?(?:yi|yı|yü|yu|ni|nı|nü|nu|ye|ya|de|da|den|dan|nin|nın|nün|nun)?(?![\p{L}])/u; // ekli sıra sayısı da: "ikinciyi", "üçüncüsünü"
// platform adı + gönderme fiili de yayın isteğidir ("181 reelse at", "3'ü youtube'a yolla"); platform adı tek başına değil ("Instagram için 30 saniyelik video üret")
const G_PLAT = /(?:^|[^\p{L}])(?:insta\p{L}*|ig|reels?\p{L}*|youtube\p{L}*|yt|shorts?|tiktok\p{L}*|tt)(?![\p{L}])/u;
const G_SEND = /(?:^|[^\p{L}])(?:at|atın|atar|atsana|atalım|atabilir\p{L}*|koy\p{L}*|gönder\p{L}*|yolla\p{L}*)(?![\p{L}])/u;
// NUMARA (7. tur, inceleme, 21 Ekim: "onay iki", "onay sekiz değil", "onay ③", "onay ３" numara sayılmıyor, tek bekleyen başka videoyu
// yayınlıyordu): her yazıdaki rakam (tam genişlik, daire içinde, üst simge), sıra sayısı, "numara/numaralı" sözü ve sayı adı (iki … doksan, on, yüz;
// ekli de: "ikiyi", "üçünü", "dördü"). "bir" (aynı zamanda belirsizlik sözü) yalnız onay/iptal/yayın sözüne bitişikse: "onay bir", "biri iptal";
// "bir video üret ve paylaş" numara değil. Tam kalıp ("onay 3") yalnız 0-9 rakamıyla
const G_DIGIT = /[\p{Nd}\p{No}]/u;
const G_NUMW = new RegExp(String.raw`(?:^|[^\p{L}])(?:(?:iki|üç|uc|dört|dort|dörd|dord|beş|bes|altı|alti|yedi|sekiz|dokuz|yirmi|otuz|kırk|kirk|elli|altmış|altmis|yetmiş|yetmis|seksen|doksan)`
  + String.raw`(?:['’]?(?:y?[ıiuü]|s[ıiuü]|n[ıiuü]|[ıiuü]?n[ıiuü]|s[ıiuü]n[ıiuü]|y?[ae]|[dt][ae]|[dt][ae]n))?|on|yüz|yuz)(?:['’]\p{L}*)?(?![\p{L}])`, "u");
const G_BIR = /(?:onay\p{L}*|iptal\p{L}*|yay[ıi]nla\p{L}*|payla[şs]\p{L}*)\s+bir(?:['’]?\p{L}{0,4})?(?![\p{L}])|(?:^|[^\p{L}])bir(?:['’]?(?:i|ini|ine|inde))?\s+(?:onay\p{L}*|iptal\p{L}*|yay[ıi]nla\p{L}*|payla[şs]\p{L}*)/u;
const G_NUMARA = /(?:^|[^\p{L}])numara\p{L}*/u;
const numIn = (t) => G_DIGIT.test(t) || G_ORD.test(t) || G_NUMARA.test(t) || G_NUMW.test(t) || G_BIR.test(t);
export const hasNumber = (text) => numIn(cmdNorm(text));
// kısa mesajda (en çok 5 kelime) sayıyla onay sözünün başka biçimi ("3 tamam", "okey 3", "3 evet", yazım hatası "onya 3", "o nay 3") ya da belirtme
// ekli sayıyla gönderme sözü ("3'ü at", "3'ü bana gönder", "üçünü yolla"; "2 video üret ve gönder" değil): hiçbir şey yapılmaz (7. tur, inceleme,
// 21 Ekim: beyne gidiyor, en kötü durumda en yeni videoyu yayınlatabiliyordu; karar 2: "bana gönder" iş görmez)
const G_YES = /(?:^|[^\p{L}])(?:evet|tamam\p{L}*|ok|okey|okay|olur|onya|ony|onaay\p{L}*|onayy\p{L}*|onyay\p{L}*|noay|oany|o\s+nay)(?![\p{L}])/u;
const G_ACC = /(?:^|[^\p{L}])(?:[\p{Nd}\p{No}]+|iki|üç|uc|dörd|dord|beş|bes|altı|alti|yedi|sekiz|dokuz|yirmi|otuz|kırk|kirk|elli|bir|birinci|ikinci|üçüncü|ucuncu|dördüncü|dorduncu|beşinci|besinci|altıncı|altinci|yedinci|sekizinci|dokuzuncu|onuncu)(?:s[ıiuü])?['’]?(?:y[ıiuü]|[ıiuü]|[ıiuü]?n[ıiuü])(?![\p{L}])/u;
export function numberGuard(text) {
  const raw = String(text || "");
  if (findLink(raw) || strictCommand(raw)) return false;
  const t = cmdNorm(raw);
  if (G_HASH.test(t)) return true;
  if (!numIn(t)) return false;
  const short = t.split(/\s+/).filter(Boolean).length <= 5 && (G_YES.test(t) || (G_SEND.test(t) && G_ACC.test(t)));
  if (!(G_WORD.test(t) || (G_PLAT.test(t) && G_SEND.test(t)) || short)) return false;
  try { const c = parseCommand(raw); if (G_PASS.has(c.action) && !(c.action === "scheduled" && c.now)) return false; } catch { /* kural yok */ }
  return true;
}
// soru (7. tur, inceleme, 21 Ekim: sondaki "?" atılınca "kuyruğu temizle?" kuyruğu temizliyor, "şu ankini iptal et?" işi iptal ediyordu): soru
// işaretli ya da soru/olumsuz emojili mesaj (cmdNorm: "?") yalnız liste ve durum gösterir; iptal, temizleme, trend seçimi ve trend otomatiğini
// açıp kapatma yerine {kind: "question"} döner (hiçbir şey yapılmaz, tam yazım söylenir)
const Q_ACT = new Set(["cancel", "cancelCurrent", "clear", "pick"]);
export function queueCommand(text) {
  const n = cmdNorm(text), ask = n.includes("?");
  const t = n.replace(/\?/g, " ").replace(/[\s.!…]+$/u, "").replace(/^[\s,]+/, "").replace(/\s+/g, " ").trim();
  if (!t) return null;
  const r = queueCommand0(text, t);
  if (ask && r && (Q_ACT.has(r.kind) || (r.kind === "auto" && r.on != null))) return { kind: "question", was: r };
  return r;
}
function queueCommand0(text, t) {
  const sc = strictCommand(text);
  if (sc?.kind === "cancel") return { kind: "cancel", nos: sc.nos };
  if (t.length <= 80) {
    if (Q_LIST.test(t)) return { kind: "list" };
    for (const re of Q_CANCEL_POS) if (re.test(t)) return { kind: "cancelAsk", pos: true };
    if (Q_CANCEL_CUR.test(t)) return { kind: "cancelCurrent" };
    if (Q_CLEAR.test(t)) return { kind: "clear" };
    if (Q_CANCEL_ASK.test(t)) return { kind: "cancelAsk" };
    if (T_LIST.test(t)) return { kind: "trends" };
    const p = t.match(T_PICK);
    if (p) { // "1 3 5", "1,3", "1 ve 3", "2-4" (aralık en çok 12); "trend 2 haber yap" haber olarak (trend kartındaki "🎬 Haber yap" gibi)
      const nums = [];
      for (const part of p[1].replace(/\s*[-–]\s*/g, "-").split(/\s*(?:,|\+|\s+ve\s+|\s+ile\s+|\s)\s*/u).filter(Boolean)) {
        const r = part.match(/^(\d{1,2})-(\d{1,2})$/);
        if (r) { const a = Number(r[1]), b = Number(r[2]); if (b >= a && b - a < 12) for (let i = a; i <= b; i++) nums.push(i); }
        else if (/^\d{1,2}$/.test(part)) nums.push(Number(part));
      }
      const uniq = [...new Set(nums)].filter((n) => n >= 1);
      if (uniq.length) return { kind: "pick", nums: uniq, news: /haber/u.test(p[2] || "") };
    }
    const a = t.match(T_AUTO);
    if (a) return { kind: "auto", on: /mı$|ne\s+durumda$/u.test(a[1]) ? null : /^(aç|açık|başlat|etkinleştir)$/u.test(a[1]) };
  }
  return trendRoute(t);
}
// panel ANLIK kartı / beyin (server.js prepareAnlik): konu yalnız "(son dakika) videosunu iptal et" gibi iptal sözüyse haber aranmaz (SD_CANCEL)
export const cancelTopic = (text) => SD_CANCEL.test(String(text || "").toLocaleLowerCase("tr-TR").replace(/^\s*(?:son\s*(?:dakika|dk)|anlık\s+haber)\s*[:,-]?\s*/u, "").replace(/[\s.!?…]+$/u, "").trim());
// eşleşmeyen iptal sözü (aşağıda handleText): "Tamam, iptal." yanlış onayı yerine liste
const CANCEL_WORD = /(?:^|[^\p{L}])(?:iptal|vazgeç|boş\s+ver)/u;
// "son dakika videosunu iptal et / durdur / sil": commands.js bunu konusu "videosunu iptal et" olan anlık habere çeviriyordu (haber aranıp
// onaysız yayınlanan video üretilebiliyordu; 5. tur, inceleme, 20 Ekim). Konu yalnız video/haber/üretim adı + iptal/durdurma isteğiyse iptal
// sözüdür: hiçbir şey üretilmez, kuyruk ve onay bekleyenler numaralarıyla yazılır
// olumsuz/durdurma sözü (karar 6): "üretme", "yapmayın", "yayınlamasın", "durdur", "vazgeçtim", "istemiyorum"; konusu video (video, haber,
// link, kuyruk, trend, "bunları"…) ya da mesaj çok kısa. NEG_START: HEAD'in başlatma eylemleri (yeni üretim, zamanlayıcı, son dakika, yeniden
// yayın, özet, yayın…); NEG_KEEP: durdurma/iptal eylemleri olduğu gibi çalışır ("üretimi durdur", "planlı yayını iptal et")
const NEG_STOP = /(?:^|[^\p{L}])(?:(?:üret|yap|hazırla|oluştur|çek|başlat|yayınla|yayinla|paylaş|paylas|gönder|indir|kurgula)m[ae](?:y[ıi]n(?:[ıi]z)?|s[ıi]n(?:[ıi]z|l[ae]r)?|y[ae]l[ıi]m|y[ıi]|m|y[ae]c[ae][ğk]\p{L}*|d[ıi]\p{L}*|d[ae]n|zd[ae]n|ks[ıi]z[ıi]n)?|durdur\p{L}*|vazgeç\p{L}*|vazgec\p{L}*|istemiyor\p{L}*|istemem|istemeyiz|gerek\s+yok|bırak\p{L}*)(?![\p{L}])/u; // "üretmeyelim", "üretmeyi bırak", "yapmayacağız" de; 7. tur: "-madan/-meden" ("videoyu üretmeden önce bana sor", "yapmadan önce haber ver"), "-mazdan", "-maksızın"
const NEG_ABOUT = /video|haber|klip|link|kuyru|trend|(?:^|[^\p{L}])(?:bunlar\p{L}*|bunu|şunlar\p{L}*|şunu|onlar\p{L}*|onu|hepsini|ikisini|üçünü)(?![\p{L}])/u;
const NEG_START = new Set(["generate", "schedule_on", "anlik", "remake", "daily_summary", "weekly_summary", "info", "rest_end", "publish", "peak", "ig_stories", "social_video"]);
const NEG_KEEP = new Set(["stopall", "stop", "scheduled", "ig_autoclean", "ig_cleanup_confirm", "schedule_off"]);
// olumsuz durdurma/kapatma/iptal fiili ("üretimi durdurma", "sistemi durdurmayın", "planlı yayını iptal etme", "otomatik silmeyi kapatma"): NEG_KEEP
// eylemi hiç çalışmaz, hiçbir şey durdurulmaz ya da iptal edilmez (7. tur, inceleme, 21 Ekim: commands.js "üretimi durdurma"yı "sistemi durdur"
// sayıyor, video kuyruğu da boşalıyordu)
const NEG_HALT = /(?:^|[^\p{L}])(?:durdurm[ae]\p{L}*|kapatm[ae]\p{L}*|iptal\s+etm[ae]\p{L}*|iptal\s+edilmesin\p{L}*|sonland[ıi]rm[ae]\p{L}*|bitirm[ae]\p{L}*|kesm[ae](?:y[ıi]n\p{L}*|s[ıi]n\p{L}*|d[ae]n)?)(?![\p{L}])/u;
const SD_CANCEL = /^(?:(?:bu|şu|o|son|yeni|lütfen|hemen|şimdi|şuanki|şu\s+anki)\s+)*(?:video\p{L}*|haber\p{L}*|üretim\p{L}*|kurgu\p{L}*|link\p{L}*|işi|işini)\s+(?:iptal(?:\s+et(?:in|sene|iver|ir\s+misin)?)?|durdur(?:un|sana|ur\s+musun)?|sil(?:in|sene)?|kaldır(?:ın|sana)?|kes(?:in)?|vazgeç(?:elim|tim)?|dursun|bırak)$/u;
// linkli mesajda üretimi engelleyen söz (7. tur, inceleme, 21 Ekim; handleText): linkler atılmış metinde olumsuz/durdurma sözü (NEG_STOP), "#numara"
// ya da numaralı onay/iptal sözü ("<haber linki> #3 iptal", "<haber linki> onay 2"). Yayın saati ("<link> 18:30'da paylaş") engellemez
const URL_ALL = new RegExp(CAND_RE.source, "gi");
const G_OKCANCEL = /(?:^|[^\p{L}])(?:onay\p{L}*|iptal\p{L}*|vazge[çc]\p{L}*|hay[ıi]r)(?![\p{L}])/u;
function linkRefuse(text) {
  const r = splitGlued(text).replace(URL_ALL, " ").replace(SOCIAL_BARE, " "), n = cmdNorm(r);
  if (NEG_STOP.test(r.toLocaleLowerCase("tr-TR"))) return "mesajda olumsuz ya da durdurma sözü var (\"üretme\", \"yapma\", \"paylaşma\", \"istemiyorum\", \"yapmadan\" gibi)";
  if (G_HASH.test(n)) return "linkle birlikte #numara yazılmış (numaralı komut ayrı mesajla yazılır)";
  if (numIn(n) && G_OKCANCEL.test(n)) return "linkle birlikte numaralı onay ya da iptal sözü yazılmış (numaralı komut ayrı mesajla yazılır)";
  return null;
}
// açma isteği ("<link> açar mısın", "<link> <link> oynat"): engellenmez, eskisi gibi açılır
const openAsked = (text) => { try { if (["open_url", "open_youtube"].includes(parseCommand(text).action)) return true; } catch { /* kural yok */ } try { return !!parseBatch(text)?.open?.length; } catch { return false; } };
const AUTO_W = /otomat|zamanlay|5\s*saat/u;
// soru biçimindeki kuyruk/trend komutunun soru işaretsiz tam yazımı
const questionHow = (r) => r.kind === "cancelCurrent" ? "şu ankini iptal et" : r.kind === "clear" ? "kuyruğu temizle" : r.kind === "cancel" ? `iptal ${r.nos.join(" ")}`
  : r.kind === "pick" ? `trend ${r.nums.join(" ")}${r.news ? " haber yap" : ""}` : r.kind === "auto" ? `trend otomatiğini ${r.on ? "aç" : "kapat"}` : "kuyruk";

export function makeVideoQueue({ DATA, app, push, sse, settings, socialVideoNews, socialBusy, anlikQueue, anlikRunning, pipelineAlive, pipelineProc, killTree,
  resting, restInfo, restEnd, restRecheck, waEnabled, onTrend = () => {}, approvals = () => [], openUrl = null, dropApproval = () => null, onCancelVideo = () => null,
  lockPid = () => null, findProduced = () => null, onRecovered = () => {}, heldNos = () => [], notify = () => {} }) {
  const FILE = path.join(DATA, "video_queue.json");
  let items = [], current = null, handed = [], seq = Date.now() % 1e6, kickT = null, noSeq = 0, noAt = 0, busyAt = 0, lists = [], runAt = 0, runSaved = 0;
  // üretilmiş işler (24 saat): numara → {video, at, label, url}. Kuyruk numarası videonun yayın onayı numarasıdır (5. tur, inceleme, 20 Ekim:
  // "#3" ile "onay 3" iki ayrı sayaçtan farklı videoları gösteriyor, "onay 3" kuyruğun 4. videosunu yayınlıyordu): onay numarası da bu sayaçtan
  // (numberFor), kuyruk videosunun onayı kendi numarasını alır; "#3 iptal" üretilmiş videonun onayını ya da planlı yayınını da kaldırır
  let done = {};
  const left = new Map(); // anlık üretiminden yeni çıkan işler (kısa süre): video dosyası sonradan görülürse işle eşlensin
  const cancelledIds = new Set(); // üretimi iptal edilen işler: video dosyası iptalden sonra çıksa da yayınlanmaz, bildirilmez
  const cancelledProcs = new WeakSet();
  const newId = () => "v" + (++seq).toString(36);
  const owner = (it) => it.source !== "trend-auto";
  // iptal: süreç ağacı öldürülür; süreç öldüğü hâlde ağaçtan kaçan bir torun (yt-dlp, ffmpeg) çıktı borusunu açık tutarsa runLines hiç
  // bitmez ve kuyruk takılırdı (4. tur, sandbox'ta görüldü): killTree'nin 4 sn'deki SIGKILL'inden sonra (5 sn) sürecin akışları kapatılır
  const killChild = (c) => { try { killTree(c.pid); } catch { /* kapandı */ } setTimeout(() => { try { c.stdout?.destroy(); c.stderr?.destroy(); } catch { /* yok */ } }, 5000).unref?.(); };
  const everyItem = () => [...(current ? [current] : []), ...handed, ...items];
  const pruneDone = () => { for (const [k, v] of Object.entries(done)) if (Date.now() - Number(v?.at || 0) > NO_RESET_MS) delete done[k]; };
  // NUMARA (6. tur, karar 1: videonun bütün ömrü boyunca TEK numara): kuyruk işinin #numarası, videosu onay isterse onay numarasıdır; kuyruk
  // dışı video onay isteyince bu sayaçtan yeni numara alır (numberFor). Kullanımdaki numara — kuyrukta/hazırlanan/üretimdeki iş, onay bekleyen
  // video, son 30 dakikada üretilmiş (onay mesajı yolda) iş ve son 24 saatte gönderilen son 3 numaralı listede (kuyruk listesi, toplu yanıt,
  // iptal ve numara yardımı) geçen numara — yeniden verilmez; 999'dan sonra en küçük boş numaraya döner (komutlar 1-999 tanır; inceleme, 20 Ekim:
  // 1000'de "onay 1000" tanınmıyordu); kuyrukta ve onayda 1 saat hiçbir şey yokken sayaç 1'den başlar (eskiden 24 saat)
  const liveNos = () => { let ap = []; try { ap = approvals() || []; } catch { /* yok */ } return new Set([...everyItem().map((x) => Number(x.no)), ...ap.map((p) => Number(p.id))].filter((n) => n > 0)); };
  const listNos = () => { lists = lists.filter((l) => Date.now() - Number(l.at || 0) <= NO_RESET_MS).slice(-3); return lists.flatMap((l) => l.nos || []); };
  const noteList = (nos) => { const s = [...new Set((nos || []).map(Number).filter((n) => n > 0))]; if (s.length) { lists = [...lists, { at: Date.now(), nos: s }].slice(-3); save(); } };
  const nextNo = (extra = []) => {
    pruneDone();
    const now = Date.now(), live = liveNos();
    if (live.size) busyAt = now; else if (now - busyAt > IDLE_RESET_MS) noSeq = 0;
    const fresh = Object.entries(done).filter(([, v]) => now - Number(v?.at || 0) < 30 * 60000).map(([k]) => Number(k));
    let held = []; try { held = (heldNos() || []).map(Number); } catch { held = []; } // süresi dolan onayın numarası (24 saat; whatsapp.js): başka videoya verilmez
    const used = new Set([...live, ...listNos(), ...fresh, ...held, ...extra.map(Number)]);
    let n = noSeq + 1; while (n <= NO_MAX && used.has(n)) n++;
    if (n > NO_MAX) { n = 1; while (n <= NO_MAX && used.has(n)) n++; }
    if (n > NO_MAX) n = (noSeq % NO_MAX) + 1; // 999 numaranın hepsi kullanımda (olmaz): döngü
    delete done[n]; // eski videonun eşlemesi yeni işe karışmasın
    noSeq = n; noAt = busyAt = now; return n;
  };
  const save = () => {
    try { const tmp = FILE + ".tmp"; writeFileSync(tmp, JSON.stringify({ seq: noSeq, seqAt: noAt, busyAt, runAt, lists, items, active: [...(current ? [current] : []), ...handed], done }, (k, v) => (k === "ctx" ? undefined : v), 1)); renameSync(tmp, FILE); runSaved = runAt; } catch { /* yazılamadı: bellekte kalır */ }
  };
  const label = (it) => it.account ? `@${it.account}${it.caption ? ` "${oneLine(it.caption, 50)}"` : ""}` : it.caption ? `"${oneLine(it.caption, 60)}"` : shortUrl(it.url);
  const tag = (it) => `#${it.no}`;
  // üretime geçmiş işin adımı: üretiliyor ya da üretimi bekliyor (anlık sırasındaki yeriyle)
  const stepText = (it) => it.step === "sırada üretim" ? `üretimi bekliyor${it.anlikPos > 1 ? ` (önünde ${it.anlikPos - 1} üretim daha)` : " (sıradaki üretim)"}` : it.step ? STEP[it.step] || it.step : null;
  // görüntü sırası: üretiliyor → üretimi bekliyor (anlık sırasıyla) → hazırlanıyor → sırada (yalnız sıralama; tutamak iş numarası)
  function rows() {
    refreshHanded();
    const h = [...handed].sort((a, b) => (a.step === "üretiliyor" ? 0 : 1) - (b.step === "üretiliyor" ? 0 : 1) || (a.anlikPos || 0) - (b.anlikPos || 0));
    return [...h, ...(current ? [current] : []), ...items];
  }
  const pub = (it, pos = null) => ({ id: it.id, no: it.no, url: it.url, label: label(it), source: it.source, sourceText: SRC[it.source] || it.source, mode: it.mode || "haber", kind: it.kind || "",
    state: it.state, step: it.step || null, stepText: stepText(it), at: it.at, startedAt: it.startedAt || null, position: pos,
    publishAt: it.publishAt || null, trend: !!it.trend });
  const view = () => {
    const r = rows(), wait = new Set(items);
    return { active: r.filter((x) => !wait.has(x)).map((x) => pub(x, r.indexOf(x) + 1)), items: r.filter((x) => wait.has(x)).map((x) => pub(x, r.indexOf(x) + 1)),
      caps: { owner: OWNER_MAX, auto: AUTO_MAX, ownerQueued: items.filter(owner).length, autoQueued: items.filter((x) => !owner(x)).length } };
  };
  let lastSig = "";
  const emit = (force = false) => { const v = view(); const sig = JSON.stringify(v); if (!force && sig === lastSig) return; lastSig = sig; try { sse("vqueue", v); } catch { /* panel bağlı değil */ } };
  const changed = () => { save(); emit(true); };
  const posOf = (id, r = rows()) => r.findIndex((x) => x.id === id) + 1;

  // ---- açılış: bekleyenler kalır; yarım kalan (hazırlanan ya da üretime geçmiş) iş NUMARASINI KORUYARAK baştan başlar (6. tur, karar 5;
  // hiçbir şey yayınlanmadı: kuyruk videosu yalnız onayla yayınlanır). İnceleme, 20 Ekim: üretimi sürerken panel yeniden başlayınca iş
  // kayboluyordu (süren üretim sayılıp atlanıyor, yetim üretim ilk çıktı satırında ölüyordu) ya da yetim üretimin videosu yeni numara alıyordu.
  // Panel kapanırken bu işin üretimi (kilitteki pid = işin kaydettiği pid) hâlâ sürüyorsa durdurulur (aynı video iki kez üretilmesin); video
  // panel kapalıyken çıkmışsa (out/'ta meta queue.no aynı, iş başladıktan sonra) iş tamamlanmış sayılır ve onay mesajı aynı numarayla gider
  // (onRecovered). Numaralar korunur (eski kayıtta yoksa yenisi)
  const recovered = [];
  try {
    const d = JSON.parse(readFileSync(FILE, "utf8"));
    noSeq = Number(d?.seq) > 0 ? Math.min(NO_MAX, Number(d.seq)) : 0; noAt = Number(d?.seqAt) > 0 ? Number(d.seqAt) : 0; busyAt = Number(d?.busyAt) > 0 ? Number(d.busyAt) : noAt;
    // panelin son açık görüldüğü an: kuyruğun son meşgul anı ya da kayıttaki busyAt (eski kayıtta runAt yok); prune() da bundan sayar
    runAt = runSaved = Math.max(Number(d?.runAt) > 0 ? Number(d.runAt) : 0, busyAt || 0);
    lists = Array.isArray(d?.lists) ? d.lists.filter((l) => l && Array.isArray(l.nos)).slice(-3) : [];
    if (d?.done && typeof d.done === "object" && !Array.isArray(d.done)) for (const [k, v] of Object.entries(d.done)) if (Number(k) > 0 && v?.video) done[Number(k)] = v;
    pruneDone();
    const ok = (x) => x && typeof x.url === "string" && /^https?:\/\//.test(x.url) && x.id;
    const act = (Array.isArray(d?.active) ? d.active : []).filter(ok), waiting = (Array.isArray(d?.items) ? d.items : []).filter(ok);
    const restart = [];
    for (const x of act) {
      let vid = null; try { vid = x.no > 0 ? findProduced(Number(x.no), Number(x.startedAt) || Number(x.at) || 0) : null; } catch { vid = null; }
      if (vid) {
        done[x.no] = { video: vid, at: Date.now(), label: label(x), url: x.url, source: x.source };
        push(`🎞 video kuyruğu: #${x.no} "${label(x)}" videosu panel kapalıyken çıktı (${vid}); onay mesajı aynı numarayla gönderilecek`);
        recovered.push({ vid, x }); continue;
      }
      let lp = null; try { lp = Number(lockPid()) || null; } catch { lp = null; }
      if (lp && Number(x.pid) === lp) { try { killTree(lp); } catch { /* kapandı */ } push(`🎞 video kuyruğu: #${x.no} "${label(x)}" panel kapanmadan önce üretimdeydi; yarım kalan üretimi durduruldu, iş aynı numarayla baştan başlayacak`); }
      restart.push({ ...x, state: "sırada", step: null, startedAt: null, pid: null, restarted: true, t0: Number(x.startedAt) || Number(x.at) || 0 });
    }
    // yarım kalanlar başladıkları sırayla (7. tur, inceleme, 21 Ekim: dosyada hazırlanan iş üretimdekinden önce yazıldığı için üretimdeki iş
    // yeniden başlayınca hazırlanan işin arkasına düşüyordu)
    restart.sort((a, b) => a.t0 - b.t0);
    // yarım kalan baştan (en önde), bekleyenler kaydedildikleri sırayla (elle değiştirilmiş sıra korunur)
    const now = Date.now(), all = [...restart, ...waiting.map((x) => ({ ...x, state: "sırada", step: null, waited: true }))];
    const seenNo = new Set();
    // bayatlama prune() ile aynı kural: sahibin bekleyen işi ve yarım kalan (panel kapanırken hazırlanan/üretilen) iş panelin son açık
    // görüldüğü andan (runAt; yarım kalan işte başladığı an da) sayılır, yani yalnız panel 6 saatten uzun kapalı kaldıysa atılır (inceleme,
    // 28 Ekim: yeniden başlamada yalnız sıraya giriş anı sayılıyor, üretimdeki iş de atılıyordu)
    items = all.filter((x) => { if (now - (owner(x) || x.restarted ? Math.max(Number(x.at || 0), runAt, Number(x.t0 || 0)) : Number(x.at || 0)) > STALE_MS) { push(`🔗 sıradaki video bayatladı (6 saattir bekliyordu), atlandı${x.no ? ` (#${x.no})` : ""}: ${shortUrl(x.url)}`); onTrend(x, "iptal", "bayatladı (6 saat sırada bekledi)"); if (owner(x)) setTimeout(() => staleNote(x), 30000); return false; } return true; })
      .slice(0, OWNER_MAX + AUTO_MAX + 2);
    for (const x of items) delete x.t0;
    for (const x of items) { if (!(Number(x.no) > 0) || seenNo.has(Number(x.no))) x.no = 0; else { x.no = Number(x.no); seenNo.add(x.no); } }
    for (const x of items) if (!x.no) x.no = nextNo();
    if (items.length) {
      const nRe = items.filter((x) => x.restarted).length;
      push(`🎞 video kuyruğu geri yüklendi: ${items.length} video sırada (${items.map(tag).join(", ")})${nRe ? ` (yarım kalan ${nRe} video baştan başlayacak)` : ""}`);
      for (const x of items) onTrend(x, "sırada");
    }
    save();
  } catch { /* kuyruk dosyası yok */ }
  setTimeout(() => kick(), 15000);
  if (recovered.length) setTimeout(() => { for (const r of recovered) { try { onRecovered(r.vid, pub(r.x)); } catch (e) { push(`🎞 video kuyruğu: #${r.x.no} onay mesajı gönderilemedi: ${e.message}`); } } }, 20000);

  // bayatlama: otomatik trend işi sıraya girdiği andan 6 saat; SAHİBİN işi kuyruğun son meşgul anından (inceleme, 28 Ekim: fotoğraflı benzer
  // video saatler sürer; arkasında bekleyen, sahibe "sırada" denmiş link 6 saatte habersiz atılıyordu). Atılan sahip işi WhatsApp'a yazılır.
  function staleNote(x) { try { notify(`⏹ ${x.no ? `#${x.no} ` : ""}${x.restarted ? "panel 6 saatten uzun kapalı kaldı, yarım kalan video" : "6 saatten uzun sırada bekledi,"} atlandı: ${shortUrl(x.url)} — yeniden istiyorsanız linki tekrar gönderin.`); } catch { /* bildirilemedi */ } }
  function prune() {
    const now = Date.now(), keep = [];
    for (const x of items) {
      const from = owner(x) ? Math.max(Number(x.at || 0), runAt) : Number(x.at || 0);
      if (now - from > STALE_MS) { push(`🔗 sıradaki video bayatladı (6 saattir bekliyordu), atlandı (${tag(x)}): ${shortUrl(x.url)}`); onTrend(x, "iptal", "bayatladı (6 saat sırada bekledi)"); if (owner(x)) staleNote(x); } else keep.push(x);
    }
    if (keep.length !== items.length) { items = keep; changed(); }
  }
  // üretime geçmiş işlerin adımı: anlık sırasında mı, üretiliyor mu; ikisi de değilse üretim bitti (ya da başlatılamadı) → listeden çıkar
  function refreshHanded() {
    if (!handed.length) return;
    const run = anlikRunning();
    let dirty = false;
    const keep = handed.filter((x) => {
      const qi = anlikQueue.findIndex((q) => q.opts?.vq === x.id);
      if (qi >= 0) { x.step = "sırada üretim"; x.anlikPos = qi + 1; return true; }
      // üretim süreci (pipeline.sh) pid'i kaydedilir: panel yeniden başlarsa bu işin yarım üretimi tanınıp durdurulur (karar 5)
      if (run === x.id) { const pid = Number(pipelineProc()?.pid) || null; if (x.step !== "üretiliyor" || (pid && x.pid !== pid)) { x.step = "üretiliyor"; if (pid) x.pid = pid; dirty = true; } return true; }
      left.set(x.id, { it: x, at: Date.now() }); // video dosyası üretim bittikten sonra görülürse de işle eşlensin (produced)
      return false;
    });
    for (const [k, v] of left) if (Date.now() - v.at > 10 * 60000) left.delete(k);
    if (keep.length !== handed.length) { handed = keep; save(); if (!current && !items.length) { try { restRecheck(); } catch { /* yok */ } } } // son video da üretildi: ertelenen dinlenme
    else if (dirty) save();
  }
  setInterval(() => { try { if (current || socialBusy()) { runAt = Date.now(); if (runAt - runSaved > 5 * 60000) save(); } prune(); emit(); if (liveNos().size) busyAt = Date.now(); } catch { /* yok */ } }, 3000);
  // işin üretimi: anlık sırasındaki kaydı çıkarılır, üretimi sürüyorsa yalnız o durdurulur (⏹'nin yöntemi; sıradaki işler sürer)
  function dropProduction(id) {
    let n = 0;
    for (let i = anlikQueue.length - 1; i >= 0; i--) if (anlikQueue[i].opts?.vq === id) { anlikQueue.splice(i, 1); n++; }
    if (anlikRunning() === id) { const pr = pipelineProc(); if (pr?.pid) { cancelledProcs.add(pr); try { killTree(pr.pid); } catch { /* kapandı */ } n++; } }
    return n;
  }

  function kick(delay = 200) { clearTimeout(kickT); kickT = setTimeout(() => { try { work(); } catch (e) { push(`🎞 video kuyruğu: ${e.message}`); } }, delay); }
  function work() {
    if (current || socialBusy()) return;
    prune();
    const it = items.shift();
    if (!it) { save(); emit(); try { restRecheck(); } catch { /* yok */ } return; }
    if (!waEnabled()) { push(`🔗 sıradaki video atlandı (${tag(it)}; videodan haber yapma kapalı): ${shortUrl(it.url)}`); onTrend(it, "iptal", "videodan haber yapma kapalı"); changed(); kick(); return; }
    if (it.source === "trend-auto" && resting()) {
      // otomatik trend: elle "⏸ Tüm sistemi durdur" sürerken uyandırmaz; üretim sonrası dinlenmeyi sondakika.com gibi bitirir
      if (restInfo().reason === "elle durduruldu") { push(`📈 trend otomatik üretilmedi (${tag(it)}): ${label(it)} — sistem elle durduruldu`); onTrend(it, "iptal", "sistem elle durduruldu"); changed(); kick(); return; }
      restEnd(`Instagram'da yeni trend: ${label(it)}`);
    }
    current = it; Object.assign(it, { state: "hazırlanıyor", step: "indiriliyor", startedAt: Date.now() });
    onTrend(it, "hazırlanıyor");
    push(it.waited || it.restarted ? `🔗 sıradaki ${it.source === "trend-auto" ? "otomatik trend videosu" : "paylaşım"} başlıyor (${tag(it)})${it.restarted ? " (panel yeniden başladı, baştan)" : ""}: ${it.url}`
      : `🔗 ${it.source === "trend-auto" ? "otomatik trend videosu" : "paylaşım"} hazırlanıyor (${tag(it)}): ${it.url}`);
    changed();
    const ctx = { id: it.id, no: it.no, src: it.source, url: it.url, live: true, cancelled: false, quiet: it.source === "trend-auto", children: new Set(),
      child(c, args) {
        if (!ctx.live) return;
        ctx.children.add(c); c.on?.("close", () => ctx.children.delete(c));
        const s = (args || []).join(" ");
        if (/social_video\.py/.test(s)) it.step = "indiriliyor"; else if (/wa_video\.py/.test(s)) it.step = "kurgu";
        changed();
        if (ctx.cancelled) setImmediate(() => killChild(c));
      } };
    it.ctx = ctx;
    let p;
    try { p = als.run(ctx, () => socialVideoNews({ url: it.url, instruction: it.instruction || "", publishAt: it.publishAt || null, kind: it.kind || "" })); }
    catch (e) { p = Promise.resolve({ ok: false, error: e.message }); }
    Promise.resolve(p).then((r) => finish(it, ctx, r), (e) => { push(`🔗 paylaşımdan haber hatası (${tag(it)}): ${e.message}`); finish(it, ctx, { ok: false, error: e.message }); });
  }
  function finish(it, ctx, r) {
    ctx.live = false; delete it.ctx; runAt = Date.now(); // work() ardından prune eder: biten iş "meşgul" sayılsın
    if (current === it) current = null;
    if (ctx.cancelled) {
      // iptal, iş startAnlik'e geçerken geldiyse (ör. "N. sırada" bildirimi beklenirken; inceleme, 20 Ekim) iş anlık sırasında ya da
      // üretimde kalmasın
      if (dropProduction(it.id)) push(`⏹ video kuyruğu: iptal edilen videonun (${tag(it)}) üretimi de kaldırıldı: ${label(it)}`);
      left.set(it.id, { it, at: Date.now() }); // üretime geçerken iptal edildiyse video dosyası sonradan çıkabilir (produced: yayınlanmaz)
      onTrend(it, "iptal", "iptal edildi");
    } else if (r?.ok) {
      onTrend(it, "üretildi");
      // kurgu bitti, üretim başladı ya da anlık sırasına girdi: üretim bitene kadar kutuda görünür (iptal edilebilir)
      if (r.queued || anlikRunning() === it.id) { Object.assign(it, { step: r.queued ? "sırada üretim" : "üretiliyor" }); handed.push(it); }
      else left.set(it.id, { it, at: Date.now() });
    } else onTrend(it, "hata", String(r?.error || "üretilemedi").slice(0, 200));
    changed(); kick(500);
  }

  // ---- ekleme. spec: {url, instruction, kind, publishAt, mode, source, account, caption, trend}. Dönüş {ok, id, no, url, label, queued, position,
  // ahead, started, promoted} ya da {ok:false, duplicate|full, id?, no?, position?, error}. Aynı video ikinci kez girmez: aynı adres, aynı tür
  // (haber/fragman) ve aynı talimat; talimatsızda "haber" ile türü Claude'a bırakılan aynı sayılır (inceleme, 20 Ekim: trend kartından "Haber
  // yap" ve WhatsApp'tan "trend 1" aynı gönderiyi iki kez üretiyordu). Sahip, kuyruktaki otomatik işi isterse iş sahibin sırasına alınır.
  function add(spec) {
    const url = String(spec?.url || "").trim();
    if (!/^https?:\/\//i.test(url)) return { ok: false, url, error: "Geçerli bir video linki değil." };
    if (!waEnabled()) return { ok: false, url, error: "Videodan haber yapma kapalı (Ayarlar → 📡 Otomatik içerikler)." };
    const source = ["whatsapp", "panel", "trend-auto"].includes(spec.source) ? spec.source : "panel";
    const key = normUrl(url), ins = String(spec.instruction || ""), kind = String(spec.kind || ""), mode = spec.mode === "fragman" ? "fragman" : "haber";
    const loose = (a) => ["", "haber"].includes(a);
    const same = everyItem().find((x) => normUrl(x.url) === key && (x.mode || "haber") === mode && String(x.instruction || "") === ins
      && (String(x.kind || "") === kind || (!ins && loose(String(x.kind || "")) && loose(kind))));
    const isOwner = source !== "trend-auto";
    const ownerSlot = () => { let i = 0; for (let k = 0; k < items.length; k++) if (owner(items[k])) i = k + 1; return i; }; // son sahip işinin ardı (otomatiklerden önce)
    if (same) {
      const qi = items.indexOf(same);
      if (qi >= 0 && isOwner && !owner(same)) {
        items.splice(qi, 1); Object.assign(same, { source, kind: kind || same.kind, at: Date.now() }); items.splice(ownerSlot(), 0, same);
        push(`🎞 otomatik sıradaki video sahibin sırasına alındı (${tag(same)}): ${label(same)}`); onTrend(same, "sırada");
        changed(); const pos = posOf(same.id); return { ok: true, id: same.id, no: same.no, url, label: label(same), queued: true, promoted: true, position: pos, ahead: pos - 1 };
      }
      return { ok: false, duplicate: true, active: qi < 0, id: same.id, no: same.no, url, label: label(same), position: posOf(same.id),
        error: qi >= 0 ? `Bu link zaten video kuyruğunda (${tag(same)}).` : `Bu video şu an hazırlanıyor (${tag(same)}).` };
    }
    if (isOwner && items.filter(owner).length >= OWNER_MAX) return { ok: false, full: true, url, error: `⏳ Sırada zaten ${OWNER_MAX} video var; bunlar bitince yeniden gönderin (kuyruk: *kuyruk*).` };
    if (!isOwner && items.filter((x) => !owner(x)).length >= AUTO_MAX) return { ok: false, full: true, url, error: `kuyrukta zaten ${AUTO_MAX} otomatik video bekliyor` };
    const it = { id: newId(), no: nextNo(), url, instruction: ins, kind, publishAt: spec.publishAt || null, mode, source,
      account: spec.account || null, caption: spec.caption ? oneLine(spec.caption, 160) : null, trend: !!spec.trend, at: Date.now(), state: "sırada" };
    const idle = !current && !socialBusy() && !items.length;
    items.splice(isOwner ? ownerSlot() : items.length, 0, it);
    if (!idle) it.waited = true;
    onTrend(it, "sırada");
    changed();
    if (idle) work();
    const pos = posOf(it.id);
    if (idle) return { ok: true, id: it.id, no: it.no, url, label: label(it), queued: false, started: current === it, position: pos, ahead: 0 };
    if (isOwner) push(`🔗 ${it.trend ? "trend videosu" : "paylaşım"} sıraya alındı (${tag(it)}; önünde ${pos - 1} video): ${it.url}`);
    kick();
    return { ok: true, id: it.id, no: it.no, url, label: label(it), queued: true, position: pos, ahead: pos - 1 };
  }
  const has = (url) => { const k = normUrl(url); return everyItem().find((x) => normUrl(x.url) === k) || null; };
  const positionOf = (url) => { const a = has(url); if (!a) return null; const p = posOf(a.id); return items.includes(a) ? { queued: true, position: p, no: a.no } : { queued: false, state: a.state, step: a.step, position: p, no: a.no }; };

  // ---- iptal
  function cancel(id, { why = "iptal edildi", log = true, prod = true } = {}) {
    const pos = posOf(id), qi = items.findIndex((x) => x.id === id);
    if (qi >= 0) { const [it] = items.splice(qi, 1); if (log) push(`⏹ video kuyruğundan çıkarıldı (${tag(it)}): ${label(it)}`); onTrend(it, "iptal", why); changed(); return { ok: true, what: "queued", item: pub(it, pos) }; }
    if (current?.id === id) {
      // süreçleri (social_video.py / wa_video.py ve altındakiler) öldürülür; o sırada süreç yoksa sonraki başlatılır başlatılmaz öldürülür,
      // startAnlik iptal edilmiş işi başlatmaz; iş üretime geçmişse (anlık sırasında / üretimde) oradan da kaldırılır; iş socialVideoNews
      // dönünce kutudan çıkar ve sıradaki başlar
      const it = current, ctx = it.ctx, n = ctx?.children.size || 0;
      cancelledIds.add(id);
      if (ctx) { ctx.cancelled = true; ctx.quiet = true; for (const c of ctx.children) killChild(c); }
      const dropped = prod ? dropProduction(id) : 0;
      it.step = "iptal ediliyor"; changed();
      if (log) push(`⏹ video kuyruğu: hazırlanan video iptal edildi (${tag(it)}): ${label(it)}${n ? ` — ${n} süreç kapatıldı` : ""}${dropped ? " (üretimi de kaldırıldı)" : ""}`);
      return { ok: true, what: "current", item: pub(it, pos) };
    }
    refreshHanded();
    const h = handed.find((x) => x.id === id);
    if (h) {
      const wasRunning = anlikRunning() === id;
      cancelledIds.add(id);
      dropProduction(id);
      // video dosyası çıkmışsa (üretim sonunda iptal): planlı yayını, WhatsApp özeti ve onay kaydı kaldırılır (5. tur, inceleme, 20 Ekim:
      // yayın saatli link videosu iptal edildikten sonra o saatte onaysız yayınlanıyordu); dosya sonradan çıkarsa produced aynı işi yapar
      const vr = h.video ? onCancelVideo(h.video) : null;
      push(wasRunning ? `⏹ video kuyruğu: süren üretim durduruldu (${tag(h)}; yalnız bu video, sıradaki işler devam eder): ${label(h)}` : `⏹ video kuyruğu: üretim sırasındaki video çıkarıldı (${tag(h)}): ${label(h)}`);
      handed = handed.filter((x) => x !== h); left.set(id, { it: h, at: Date.now() }); onTrend(h, "iptal", why); changed();
      return { ok: true, what: "handed", item: pub(h, pos), video: h.video || null, removed: vr };
    }
    return { ok: false, error: "Bu video kuyrukta yok (bitmiş ya da çıkarılmış olabilir)." };
  }
  const byNo = (n) => rows().find((x) => x.no === n) || null;
  const removedText = (r) => r ? [r.scheduled ? "planlı yayını kaldırıldı" : "", r.approval ? "onay bekleyen kaydı kaldırıldı" : "", r.digest ? "onay mesajı gönderilmeyecek" : ""].filter(Boolean).join(", ") : "";
  // "kuyruk iptal 7", "#7 iptal", "kuyruk iptal 7 9": yalnız bu numaralı işler (sıradaki yer değil). Üretilmiş iş (numarası videonun onay
  // numarasıdır): onay bekleyen kaydı ve planlı yayını kaldırılır; kuyruk dışı videonun onayı da aynı numarayla (dropApproval)
  function cancelNos(nos) {
    const lines = [], gone = [];
    for (const n of nos) {
      const it = byNo(n);
      if (!it) {
        pruneDone();
        const d = done[n];
        if (d) {
          // adı onay mesajındaki başlıkla (7. tur: link adresi değil)
          let ap = null; try { ap = (approvals() || []).find((p) => Number(p.id) === n || p.video === d.video) || null; } catch { ap = null; }
          const nm = oneLine(ap?.title || ap?.label || d.label, 70);
          const r = onCancelVideo(d.video), rt = removedText(r);
          lines.push(rt ? `⏹ #${n}: video hazırdı (${nm}); yayınlanmayacak — ${rt}.` : `#${n}: video hazırlandı (${nm}); bekleyen onayı ya da planlı yayını yok (yayınlandıysa panelden silinebilir).`);
          continue;
        }
        const a = dropApproval(n);
        if (a?.ok) { lines.push(`⏹ #${n}: ${oneLine(a.title || a.label || a.video, 60)} yayınlanmayacak — onay bekleyen kaydı kaldırıldı.`); continue; }
        gone.push(n); continue;
      }
      const r = cancel(it.id);
      if (!r.ok) { gone.push(n); continue; }
      const rt = removedText(r.removed);
      lines.push(`⏹ #${n} iptal edildi: ${r.item.label}${r.what === "current" ? " (hazırlanıyordu; süreçleri kapatıldı)" : r.what === "handed" ? (r.item.step === "üretiliyor" ? ` (üretiliyordu; yalnız onun üretimi durduruldu${rt ? `; ${rt}` : ""})` : " (üretim sırasındaydı; sıradan çıkarıldı)") : ""}.`);
    }
    if (gone.length) lines.push(`${gone.map((n) => `#${n}`).join(", ")}: kuyrukta yok (bitmiş ya da çıkarılmış olabilir).${rows().length ? `\n${listText()}` : ""}`);
    return lines.join("\n");
  }
  // server.js: üretim sırasında out/'a çıkan video dosyası, onu üreten kuyruk işiyle eşlenir (onay numarası = iş numarası; iptal edilmiş işin
  // videosu yayınlanmaz, bildirilmez)
  function produced(id, mp4) {
    const it = everyItem().find((x) => x.id === id) || left.get(id)?.it;
    if (!it || !mp4) return null;
    if (it.video === mp4 && done[it.no]) return it.no;
    it.video = mp4; done[it.no] = { video: mp4, at: Date.now(), label: label(it), url: it.url, source: it.source };
    push(`🎞 video kuyruğu: ${tag(it)} videosu hazır: ${mp4}`);
    if (cancelledIds.has(id)) { const r = onCancelVideo(mp4); push(`⏹ video kuyruğu: iptal edilen işin (${tag(it)}) videosu iptalden sonra çıktı; yayınlanmayacak${removedText(r) ? ` (${removedText(r)})` : ""}`); }
    save(); return it.no;
  }
  // WhatsApp onay numarası (whatsapp.js): kuyruk videosu kendi iş numarasını (videonun meta'sındaki queue.no — panel yeniden başlasa da —, yoksa
  // üretim eşlemesi), diğer video bu sayaçtan yeni numara alır (iki ayrı sayaç yok; karar 1)
  function numberFor(mp4, used = [], metaNo = 0) {
    pruneDone();
    const want = Number(metaNo) > 0 ? Number(metaNo) : Number(Object.entries(done).find(([, v]) => v.video === mp4)?.[0]) || 0;
    if (want > 0 && want <= NO_MAX && !used.includes(want) && !everyItem().some((x) => x.no === want && x.video !== mp4)) {
      if (done[want]?.video !== mp4) { done[want] = { ...(done[want] || {}), video: mp4, at: Date.now() }; save(); }
      return want;
    }
    const x = nextNo(used); save(); return x;
  }
  // kuyruktan üretilmiş videonun numarası (yayın kapısı: server.js; videonun meta'sı da queue.no taşır), değilse 0
  const ownerNo = (mp4) => { pruneDone(); const n = Number(Object.entries(done).find(([, v]) => v.video === mp4)?.[0]) || 0; if (n) return n; const it = everyItem().find((x) => x.video === mp4) || [...left.values()].find((v) => v.it.video === mp4)?.it; return it?.no || 0; };
  // trendauto.js: gönderinin üretilmiş videosu (numarası, onayı bekliyor mu; 7. tur: "✓ video hazır (#2, onay bekliyor)")
  const doneOf = (url) => {
    pruneDone(); const k = normUrl(url);
    const e = Object.entries(done).filter(([, v]) => v?.url && normUrl(v.url) === k).sort((a, b) => Number(b[1].at || 0) - Number(a[1].at || 0))[0];
    if (!e) return null;
    let ap = []; try { ap = approvals() || []; } catch { ap = []; }
    return { no: Number(e[0]), pending: ap.some((p) => Number(p.id) === Number(e[0])) };
  };
  const sourceOf = (mp4) => { const d = Object.values(done).find((v) => v.video === mp4); return d?.source || everyItem().find((x) => x.video === mp4)?.source || null; };
  // numaralı yayın/iptal isteğinde işin durumu (whatsapp.js: "onay 3" daha üretilmemiş kuyruk işini gösteriyorsa)
  const stateOf = (n) => { const it = byNo(n); if (!it) return null; return items.includes(it) ? "sırada" : it === current ? STEP[it.step] || "hazırlanıyor" : stepText(it); };
  // "şu ankini iptal et": YALNIZ hazırlanan ya da üretilen iş (üretimi bekleyen ya da sıradaki değil); ikisi birden varsa hangisi sorulur
  function cancelCurrent() {
    refreshHanded();
    const cands = [...(current && current.step !== "iptal ediliyor" ? [current] : []), ...handed.filter((x) => x.step === "üretiliyor")];
    if (cands.length === 1) return cancel(cands[0].id);
    if (cands.length > 1) return { ok: false, error: `Şu an iki video var: ${cands.map((x) => `${tag(x)} ${x === current ? STEP[x.step] || "hazırlanıyor" : "üretiliyor"} (${label(x)})`).join(", ")}. Hangisi? ${cands.map((x) => `*${tag(x)} iptal*`).join(" ya da ")}` };
    const wait = handed.filter((x) => x.step === "sırada üretim");
    return { ok: false, error: `Şu an hazırlanan ya da üretilen kuyruk videosu yok.${wait.length ? ` Üretim sırasında bekleyen: ${wait.map((x) => `${tag(x)} (${label(x)}) → *${tag(x)} iptal*`).join(", ")}.` : ""}${pipelineAlive() && !handed.some((x) => x.step === "üretiliyor") ? " Süren üretim video kuyruğundan değil." : ""}` };
  }
  function move(id, dir) {
    const i = items.findIndex((x) => x.id === id), j = i + (dir < 0 ? -1 : 1);
    if (i < 0 || j < 0 || j >= items.length) return { ok: false };
    [items[i], items[j]] = [items[j], items[i]]; changed(); return { ok: true };
  }
  function clear({ why = "kuyruk temizlendi", log = true } = {}) {
    const n = items.length, nos = items.map(tag);
    for (const it of items) onTrend(it, "iptal", why);
    items = []; changed();
    if (n && log) push(`⏹ video kuyruğu temizlendi: sıradaki ${n} video çıkarıldı (${nos.join(", ")})`);
    return n;
  }
  // trend otomatik üretimi kapatılınca bekleyen otomatik işler de çıkar (sahibin işleri kalır); hazırlanan otomatik iş sürer (söylenir)
  // dönüş active: hazırlanan ve üretimdeki/üretimi bekleyen otomatik işler (yanıt her birini kendi "#N iptal" komutuyla yazar; inceleme, 20 Ekim:
  // yanıt yanlış komutu — "şu ankini iptal et" — yazıyor, üretimdeki otomatik videoyu hiç söylemiyordu)
  function dropAuto(why = "otomatik üretim kapatıldı") {
    refreshHanded();
    const out = items.filter((x) => !owner(x));
    if (out.length) { items = items.filter(owner); for (const it of out) onTrend(it, "iptal", why); push(`⏹ video kuyruğu: bekleyen ${out.length} otomatik trend videosu çıkarıldı (${out.map(tag).join(", ")}; ${why})`); changed(); }
    const active = [...(current && !owner(current) && current.step !== "iptal ediliyor" ? [current] : []), ...handed.filter((x) => !owner(x))].map((x) => pub(x, posOf(x.id)));
    return { removed: out.length, current: active[0] || null, active };
  }
  // ⏸/⏹ durdurma: sıradakiler boşalır, hazırlanan iş kesilir (anlık sırası ve süren üretimi stopAll'ın kendisi kapatır). Dönüş sayılar:
  // durdurma yanıtı söyler (inceleme, 20 Ekim: kuyruk sessizce boşalıyordu)
  function stop() {
    refreshHanded();
    const n = items.length, cur = current, h = handed.length;
    clear({ why: "sistem durduruldu", log: false });
    if (cur) cancel(cur.id, { why: "sistem durduruldu", log: false, prod: false }); // üretimi stopAll kapattı
    for (const x of handed) onTrend(x, "iptal", "sistem durduruldu");
    handed = []; changed();
    if (n || cur || h) push(`🔗 video kuyruğu durduruldu: ${[n ? `sıradaki ${n} video iptal edildi` : "", cur ? `hazırlanan video (${tag(cur)}) kesildi` : "", h ? `üretimdeki/üretim sırasındaki ${h} video durduruldu` : ""].filter(Boolean).join(", ")}`);
    return { queued: n, current: !!cur, handed: h, total: n + (cur ? 1 : 0) + h };
  }

  // ---- WhatsApp metinleri (her satır işin numarasıyla; numara iptalin tek tutamağı)
  const rowState = (x) => items.includes(x) ? "⏳ sırada" : x === current ? `▶ ${STEP[x.step] || "hazırlanıyor"}` : `🎬 ${stepText(x)}`;
  const rowLine = (x) => `${tag(x)} ${rowState(x)}: ${label(x)} (${SRC[x.source] || x.source})`;
  function listText() {
    const r = rows();
    if (!r.length) return "🎞 Video kuyruğu boş. Birden çok video linkini tek mesajda ya da arka arkaya gönderebilirsiniz; sırayla hazırlanır.";
    const w = items[0] || r[r.length - 1];
    const tips = [`iptal: *${tag(w)} iptal*`, items.length ? "bekleyenlerin hepsi: *kuyruğu temizle*" : ""].filter(Boolean);
    noteList(r.map((x) => x.no));
    return `🎞 *Video kuyruğu*\n${r.map(rowLine).join("\n")}\n${tips.join(" · ")}`;
  }
  // tanınmayan iptal sözü / sıra yeriyle iptal: hiçbir şey iptal edilmez, kuyruk ve yayın onayı bekleyenler numaralarıyla listelenir
  function cancelHelp(why = "") {
    const r = rows(), ap = (() => { try { return approvals() || []; } catch { return []; } })();
    const out = [why || "Neyi iptal edeyim? Bu mesajla hiçbir şey iptal edilmedi."];
    if (r.length) {
      const w = items[0] || r[r.length - 1];
      out.push(`🎞 *Video kuyruğu*\n${r.map(rowLine).join("\n")}\nKuyruktan çıkarmak için numarasıyla: *${tag(w)} iptal*${current || handed.some((x) => x.step === "üretiliyor") ? " · hazırlanan/üretilen: *şu ankini iptal et*" : ""}${items.length ? " · bekleyenlerin hepsi: *kuyruğu temizle*" : ""}`);
    }
    if (ap.length) {
      const solo = ap.length === 1 && ap[0].delivered && !ap[0].numbered;
      const dl = ap.filter((p) => p.delivered);
      out.push(`📤 *Yayın onayı bekleyen*\n${ap.map((p) => `#${p.id} ${oneLine(p.title || p.label || p.video, 60)}${p.delivered ? "" : " · henüz size ulaşmadı"}`).join("\n")}${dl.length ? `\nYayınlamamak için: ${solo ? "*iptal*" : dl.map((p) => `*iptal ${p.id}*`).join(" · ")}` : ""}`);
    }
    if (!r.length && !ap.length) out.push("Video kuyruğu boş, yayın onayı bekleyen video yok.");
    noteList([...r.map((x) => x.no), ...ap.map((p) => p.id)]);
    return out.join("\n");
  }
  // trend videosu hakkında olumsuz söz ("artık trend videosu üretme", "otomatik video üretmeyi bırak"): trend otomatiğinin durumu ve komutu
  // (trendauto.js autoAsk) + kuyruktaki otomatik videolar kendi "#N iptal" komutuyla; hiçbir şey değişmez (7. tur)
  async function negTrend(trendCmd, src) {
    let head = ""; try { head = trendCmd ? (await trendCmd({ kind: "autoAsk" }, src))?.reply || "" : ""; } catch { head = ""; }
    const autos = rows().filter((x) => !owner(x));
    noteList(autos.map((x) => x.no));
    return [`Bu mesajla hiçbir şey başlatılmadı ya da iptal edilmedi (olumsuz söz). ${head || "Trend otomatiği: kapatmak için *trend otomatiğini kapat*."}`,
      autos.length ? `Kuyruktaki otomatik trend ${autos.length > 1 ? "videoları" : "videosu"}: ${autos.map((x) => `${tag(x)} ${rowState(x)} (${label(x)}) → *${tag(x)} iptal*`).join(" · ")}` : ""].filter(Boolean).join("\n");
  }
  // yayın saatli kuyruk videosu: saat not edilir, video kendiliğinden yayınlanmaz (karar 3; eskiden o saatte onaysız yayınlanırdı)
  // 7. tur: saatli bütün videoların numarası ("o saatte *onay 1 2 3* yazın"; inceleme, 21 Ekim: yalnız ilkinin numarası yazıyordu); onay mesajı yayın
  // saatinden 6 saat sonrasına kadar geçerli (whatsapp.js keepUntil)
  const queueTimeLine = (at, nos) => { const ns = [].concat(nos || []).map(Number).filter((n) => n > 0); return `⏰ Yazdığınız yayın saati (${whenLabel(at)}) kuyruk videosunda kendiliğinden uygulanmaz: video gelince onay mesajı gelir, o saatte *onay ${ns.length ? ns.join(" ") : "<numara>"}* yazın (onay mesajı yayın saatinden 6 saat sonrasına kadar geçerli).`; };
  // numaralı söz tam kalıpta değil (numberGuard; karar 2): hiçbir şey yapılmadı + onay bekleyenler ve kuyruk numaralarıyla + tam yazım
  // src "panel": yayın yalnız WhatsApp'ta onay mesajına ya da panelin yayın düğmesiyle (7. tur, inceleme, 21 Ekim: panel sohbetine "*onay 1* yazın"
  // deniyor, yazılınca "onay yalnız WhatsApp'ta" deniyordu); no: sahibin yazdığı numara (örnek o numarayla)
  function guardText(why = "", { src = "whatsapp", no = 0 } = {}) {
    const r = rows(), ap = (() => { try { return approvals() || []; } catch { return []; } })();
    const out = [why || "Bu mesajla hiçbir şey yapılmadı: numaralı komutlar yalnız tam yazımıyla çalışır (olumsuz, soru ya da ek sözlü numaralı mesaj işlem yapmaz)."];
    if (ap.length) out.push(`📤 *Yayın onayı bekleyen*\n${ap.map((p) => `#${p.id} ${oneLine(p.title || p.label || p.video, 60)}${p.delivered ? "" : " · henüz size ulaşmadı"}`).join("\n")}`);
    if (r.length) out.push(`🎞 *Video kuyruğu*\n${r.map(rowLine).join("\n")}`);
    if (!r.length && !ap.length) out.push("Onay bekleyen video ve kuyrukta iş yok.");
    const a = ap.find((p) => p.delivered)?.id, q = (items[0] || r[r.length - 1])?.no, x = a || q;
    const solo = ap.length === 1 && ap[0].delivered && !ap[0].numbered; // tek bekleyen, mesajı numarasız: numarasız "onay" da olur (HEAD)
    if (src === "panel") out.push(`Yayın: WhatsApp'ta videonun onay mesajına *onay ${no || a || "<numara>"}* yazın ya da panelde video → yayınla · iptal *iptal ${no || x || "<numara>"}*${r.length ? " · liste *kuyruk*" : ""}`);
    else out.push(`Tam yazım: ${a ? `yayın ${solo ? "*onay* ya da " : ""}*onay ${a}* · tek platform *onay ${a} insta* · ${ap.filter((p) => p.delivered).length > 1 ? "hepsi *onay hepsi* · " : ""}` : "yayın *onay <numara>* · "}iptal *iptal ${x || "<numara>"}*${r.length ? " · liste *kuyruk*" : ""}`);
    noteList([...r.map((y) => y.no), ...ap.map((p) => p.id)]);
    return out.join("\n");
  }
  const noText = (ns) => { const s = [...ns].sort((a, b) => a - b); return s.length > 2 && s[s.length - 1] - s[0] === s.length - 1 ? `#${s[0]}-#${s[s.length - 1]}` : s.map((n) => `#${n}`).join(", "); };
  // toplu ekleme yanıtı; sonuçlar add() dönüşleri (trend seçiminde her biri `name`: "trend 3", satır satır adıyla). src "whatsapp": ipucu
  // satırı (iptal komutu); hints false: panel düğmesi (ipucu yok)
  function batchReply(results, { extra = [], src = null, hints = true } = {}) {
    const okR = results.filter((x) => x.ok), qd = okR.filter((x) => x.queued), started = okR.find((x) => !x.queued), fails = results.filter((x) => !x.ok);
    const tipNo = qd.length ? qd[0].no : started?.no;
    const tip = hints && src === "whatsapp" && okR.length ? `Sıra: *kuyruk* · iptal: *#${tipNo} iptal*` : "";
    const why = (x) => firstSentence(String(x.error || "alınamadı").replace(/^⏳\s*/, ""));
    const lines = [];
    if (results.some((x) => x.name)) { // trend seçimi: her numara kendi satırında, gönderiyle (inceleme, 20 Ekim: yanıt hangi gönderinin alındığını söylemiyordu)
      lines.push(!okR.length ? (fails.length && fails.every((x) => x.duplicate) ? (fails.every((x) => x.active) ? "Zaten hazırlanıyor:" : fails.some((x) => x.active) ? "Zaten kuyrukta ya da hazırlanıyor:" : "Zaten kuyrukta:") : "Video sıraya alınamadı:") : okR.length === 1 ? (started ? "🎬 Video alındı, şimdi hazırlanıyor:" : "⏳ Video sıraya alındı:") : started ? `🎬 ${okR.length} video alındı:` : `⏳ ${okR.length} video sıraya alındı:`);
      for (const x of results) {
        const st = x.ok ? (x.queued ? `#${x.no} sırada${x.promoted ? " (zaten kuyruktaydı, öne alındı)" : ""}` : `#${x.no} şimdi hazırlanıyor`)
          : x.duplicate ? (x.active ? `zaten hazırlanıyor (#${x.no})` : `zaten kuyrukta (#${x.no})`) : why(x);
        lines.push(`• ${x.name} → ${st}${x.label ? `: ${x.label}` : ""}`);
      }
      if (tip) lines.push(tip);
    } else {
      const promo = okR.filter((x) => x.promoted).length;
      const head = !okR.length ? (fails.length === 1 ? String(fails[0].error || "Video sıraya alınamadı.") : "Videolar sıraya alınamadı:")
        : (okR.length === 1 ? (started ? `🎬 Video alındı (#${started.no}), şimdi hazırlanıyor.` : `⏳ Video sıraya alındı (#${qd[0].no}; önünde ${qd[0].ahead ?? Math.max(0, (qd[0].position || 1) - 1)} video var${promo ? "; zaten kuyruktaydı, öne alındı" : ""}).`)
          : (started ? `🎬 ${okR.length} video alındı: #${started.no} şimdi hazırlanıyor${qd.length ? `, ${noText(qd.map((x) => x.no))} sırada` : ""}.` : `⏳ ${okR.length} video sıraya alındı: ${noText(qd.map((x) => x.no))}.`)
            + (promo ? ` ${promo} tanesi zaten kuyruktaydı, öne alındı.` : ""));
      lines.push([head, tip].filter(Boolean).join(" "));
      if (results.length > 1) {
        // 6. tur: birden çok linkte her link kendi numarasıyla, mesajdaki sırayla ("link → #8"; inceleme, 20 Ekim: hangi linkin hangi numara
        // olduğu yazmıyordu)
        for (const x of results) lines.push(`• ${shortUrl(x.url)} → ${x.ok ? `#${x.no}${x.queued ? " sırada" : " şimdi hazırlanıyor"}` : x.duplicate ? `${x.active ? "şu an hazırlanıyor" : "zaten kuyrukta"} (#${x.no})` : x.full ? `sığmadı (${firstSentence(String(x.error || "").replace(/^⏳\s*/, ""), 80)})` : `alınamadı: ${why(x)}`}`);
      } else if (okR.length) {
        for (const x of fails.filter((y) => y.duplicate)) lines.push(`⚠️ ${x.active ? "Şu an hazırlanıyor" : "Zaten kuyrukta"}: ${shortUrl(x.url)} (#${x.no})`);
      }
    }
    noteList(results.map((x) => x.no));
    return [...lines, ...extra].filter(Boolean).join("\n");
  }
  function addBatch(specs) { return specs.map((s) => add(s)); }
  // tek linkin (handleCommand social_video) yanıtına numara satırı
  const idLine = (r) => (r?.ok && r.no ? `\n🎞 Kuyrukta #${r.no} · iptal: *#${r.no} iptal*` : "");

  // ---- WhatsApp / panel sohbeti: kuyruk komutları, çok linkli mesaj ve tanınmayan iptal sözü. Eşleşmezse null (eski yol). trendCmd: trend
  // komutları (trendauto.js)
  async function handleText(text, opts = {}, trendCmd = null) {
    const src = opts.source === "whatsapp" ? "whatsapp" : "panel";
    // numaralı onay (karar 2-3) yalnız WhatsApp'ta, onay mesajına yanıt olarak (whatsapp.js bunu handleCommand'dan önce çözer); panel sohbeti,
    // sesli komut ve beynin "command" eylemi hiçbir videoyu onaylayamaz
    const sc = strictCommand(text);
    if (sc?.kind === "approve") return { action: "vqueue", reply: guardText(`Bu mesajla hiçbir şey yayınlanmadı: yayın onayı yalnız WhatsApp'ta, videonun onay mesajına *onay ${sc.nums?.[0] || "<numara>"}* yazarak verilir; panelde videonun yayın düğmesini kullanın.`, { src, no: sc.nums?.[0] || 0 }), payload: {}, heard: text, full: true };
    const qc = queueCommand(text);
    if (qc) {
      let reply = "", full = false;
      if (qc.kind === "list") { reply = listText(); full = true; }
      else if (qc.kind === "cancel") { reply = cancelNos(qc.nos); full = true; }
      else if (qc.kind === "cancelCurrent") { const r = cancelCurrent(); reply = r.ok ? `⏹ İptal edildi (${r.item.no ? `#${r.item.no}` : ""}): ${r.item.label}${items.length ? ` · sıradaki başlıyor (${items.length} video sırada)` : ""}` : r.error; }
      else if (qc.kind === "clear") { const n = clear(), cur = current && current.step !== "iptal ediliyor" ? ` Şu an hazırlanan video (${tag(current)}) sürüyor (iptal: *${tag(current)} iptal*).` : ""; reply = n ? `⏹ Kuyruk temizlendi: sıradaki ${n} video çıkarıldı.${cur}` : `Kuyrukta bekleyen video yok.${cur}`; }
      else if (qc.kind === "cancelAsk") { reply = cancelHelp(qc.pos ? "Sıra yeri değişebildiği için iptal numarayla yapılır; hiçbir şey iptal edilmedi. Listedeki # numarasını yazın:" : "Hangisini? Hiçbir şey iptal edilmedi; numarasını yazın:"); full = true; }
      else if (qc.kind === "question") { reply = cancelHelp(`Soru biçiminde yazıldığı için hiçbir şey yapılmadı. Yapmak için soru işareti olmadan yazın: *${questionHow(qc.was)}*`); full = true; }
      else if (trendCmd) { const r = await trendCmd(qc, src); if (!r) return null; reply = r.reply; full = !!r.full; }
      else return null;
      return { action: "vqueue", reply, payload: {}, heard: text, full };
    }
    const hasLink = !!findLink(text);
    // "#<rakam>" ya da onay/iptal sözü + rakam, tam kalıp değil: hiçbir şey yapılmaz (karar 2; commands.js'in yayın/üretim kurallarına ve beyne gitmez)
    if (!hasLink && numberGuard(text)) return { action: "vqueue", reply: guardText("", { src }), payload: {}, heard: text, full: true };
    // olumsuz durdurma/iptal fiili (NEG_HALT: "üretimi durdurma", "sistemi durdurmayın", "planlı yayını iptal etme"): durdurma/iptal eylemi
    // çalışmaz, kuyruk kalır (7. tur)
    if (!hasLink && NEG_HALT.test(String(text).toLocaleLowerCase("tr-TR"))) {
      let c = null; try { c = parseCommand(text); } catch { c = null; }
      if (c && NEG_KEEP.has(c.action)) {
        const why = "Hiçbir şey durdurulmadı ya da iptal edilmedi: mesajda olumsuz söz var (\"durdurma\", \"kapatma\", \"iptal etme\" gibi).";
        let ap = []; try { ap = approvals() || []; } catch { /* yok */ }
        return { action: "vqueue", reply: rows().length || ap.length ? cancelHelp(`${why} Bir videoyu iptal etmek için numarasıyla yazın:`) : `${why} Durdurmak isterseniz olumsuz söz olmadan yazın (*sistemi durdur*: süren üretimi ve video kuyruğunu da durdurur).`, payload: {}, heard: text, full: true };
      }
    }
    // "iptal/vazgeç" diyen ama hiçbir komuta uymayan mesaj (4. tur, inceleme, 20 Ekim: "sıradaki videoyu iptal et", "indirmeyi iptal et" gibi
    // söyleyişler hiçbir şeyi iptal etmeden "Tamam, iptal." alıyordu): kuyrukta ya da onayda iş varsa numaralı liste ve nasıl iptal edileceği
    // (Instagram temizliğinin "evet sil" onayı bekliyorsa "iptal" ona gider: otherCancel, server.js). "son dakika videosunu iptal et" her
    // durumda (anlık habere gitmesin; SD_CANCEL)
    if (!hasLink && !opts.otherCancel) {
      const lower = String(text).toLocaleLowerCase("tr-TR"), cmd = CANCEL_WORD.test(lower) || /son\s*(?:dakika|dk)|anlık\s+haber/u.test(lower) ? parseCommand(text) : null;
      const sd = cmd?.action === "anlik" && SD_CANCEL.test(String(cmd.topic || "").toLocaleLowerCase("tr-TR").replace(/[\s.!?…]+$/u, "").trim());
      if (sd || (cmd && CANCEL_WORD.test(lower) && ((cmd.action === "none" && /iptal/i.test(cmd.reply || "")) || cmd.action === "brain"))) {
        let ap = []; try { ap = approvals() || []; } catch { /* yok */ }
        if (sd || rows().length || ap.length) return { action: "vqueue", reply: cancelHelp(), payload: {}, heard: text, full: true };
      }
    }
    // olumsuz/durdurma sözü ("bu videoları üretme", "yapma", "istemiyorum", "vazgeçtim", "durdur") videolar hakkında: hiçbir üretim, yayın ya
    // da başlatma yapılmaz (karar 6; inceleme, 20 Ekim: commands.js'in "üret … video" kuralı yeni 5 saatlik üretim başlatıyordu); kuyrukta ya da
    // onayda iş varsa numaralı liste ve iptal yazımı, yoksa HEAD'in yolu (HEAD'in üretim saydığı söz dışında)
    if (!hasLink && NEG_STOP.test(String(text).toLocaleLowerCase("tr-TR"))) {
      const lower = String(text).toLocaleLowerCase("tr-TR"), about = NEG_ABOUT.test(lower) || lower.trim().split(/\s+/).length <= 3;
      if (about) {
        let c = null; try { c = parseCommand(text); } catch { c = { action: "brain" }; }
        const start = NEG_START.has(c.action) && !(c.action === "ig_stories" && c.toggle === false) && !(c.action === "peak" && !c.run && c.on !== true);
        let ap = []; try { ap = approvals() || []; } catch { /* yok */ }
        // trend videosu sözü (7. tur, inceleme, 21 Ekim: "artık trend videosu üretme" yanıtı "sistemi durdur" diyor, trend otomatiğini anmıyordu): trend
        // otomatiğinin durumu ve kapatma komutu + kuyruktaki otomatik videolar numarasıyla
        if (TREND_W.test(lower) && !NEG_KEEP.has(c.action)) return { action: "vqueue", reply: await negTrend(trendCmd, src), payload: {}, heard: text, full: true };
        if ((rows().length || ap.length) && !NEG_KEEP.has(c.action)) return { action: "vqueue", reply: cancelHelp("Bu mesajla hiçbir şey başlatılmadı ya da iptal edilmedi (olumsuz ya da durdurma sözü). Bir videoyu iptal etmek için numarasıyla yazın:"), payload: {}, heard: text, full: true };
        if (start) return { action: "none", reply: `Hiçbir üretim başlatılmadı: mesajda olumsuz ya da durdurma sözü var. Video üretmek için olumsuz söz olmadan yazın: *video üret*${AUTO_W.test(lower) ? " · 5 saatlik otomatik üretimi kapatmak için: *otomatik kapat* · otomatik trend videoları için: *trend otomatiğini kapat*" : ""} · süren üretimi ve video kuyruğunu durdurmak için: *sistemi durdur*.`, payload: {}, heard: text };
      }
    }
    // linkli mesajda olumsuz/durdurma sözü, "#numara" ya da numaralı onay/iptal sözü (7. tur, inceleme, 21 Ekim: "<haber linki> bunu video yapma",
    // "<haber linki> bu haberi üretme, sadece bilgin olsun" haber videosu olup ONAYSIZ yayınlanıyor, "<reel> <reel> bunları üretme" iki video
    // üretiyordu): hiçbir şey üretilmez, kuyruğa alınmaz; açma isteği eskisi gibi açılır
    if (hasLink) {
      const why = linkRefuse(text);
      if (why && !openAsked(text)) return { action: "none", reply: `Hiçbir video yapılmadı: ${why}. Linkten video için linki bu söz olmadan gönderin${/olumsuz/.test(why) ? " (tür için *<link> mizah* ya da *<link> haber yap*)" : ""}.`, payload: {}, heard: text };
    }
    if (!hasLink) return null;
    const b = parseBatch(text);
    if (!b) return null;
    // açma isteği (video linki "açar mısın", "oynat"): yalnız açılır, haber linki üretilmez (5. tur). Panel ANLIK kartı/beyin (noOpen): üretim
    // isteğinde açma sözü varsa hiçbir şey yapılmaz
    if (b.open) {
      if (opts.noOpen || !openUrl) return { action: "none", reply: "Mesajda linki açma isteği var; video üretilmedi. Üretmek için linkleri açma sözü olmadan gönderin.", payload: {}, heard: text };
      let ok = 0, last = null; for (const u of [...new Set(b.open)].slice(0, 4)) { try { const r = await openUrl(u); if (r?.ok) { ok++; last = r.url || u; } } catch { /* açılamadı */ } }
      return { action: "open_url", reply: ok ? "Açıyorum." : "Açamadım.", payload: { url: last }, heard: text };
    }
    if (!b.videos.length) return { action: "none", reply: (b.skipped.length || b.sources.length < 2 ? [`Video linki alınamadı${b.skipped.length ? `: ${b.skipped.map((s) => `${shortUrl(s.url)} — ${firstSentence(s.why)}`).join("; ")}` : "."}`]
      : [`Hiçbir video yapılmadı: mesajda birden çok link var (${b.sources.map(shortUrl).join(", ")}).`]).concat(b.sources.length ? ["📰 Haber linki başka bir linkle aynı mesajda kendi başına üretilmez (haber linkinden video onaysız yayınlanır); haber linkinden video için onu tek başına, ayrı mesajla gönderin."] : []).join("\n"), payload: {}, heard: text };
    if (!waEnabled()) return { action: "none", reply: "Videodan haber yapma kapalı (Ayarlar → 📡 Otomatik içerikler).", payload: {}, heard: text };
    const res = addBatch(b.videos.map((v) => ({ ...v, source: src })));
    const extra = [];
    const when = b.videos.find((v) => v.publishAt);
    // kuyruk videosu planlı yayınla da kendiliğinden yayınlanmaz (karar 3): saat not edilir, onay mesajı gelir
    if (when && res.some((r) => r.ok)) extra.push(queueTimeLine(new Date(when.publishAt), res.filter((r, i) => r.ok && b.videos[i]?.publishAt).map((r) => r.no)));
    if (b.sources.length && res.some((r) => r.ok)) extra.push(`📰 ${b.sources.length} haber linki ayrı video yapılmadı; ${b.videos.length > 1 ? "videoların" : "videonun"} talimatına kaynak olarak eklendi.`);
    if (b.merged.length) extra.push(`ℹ️ Linklerdeki videoları tek videoda birleştiremiyorum; yalnız ilk video alındı. Diğerini ayrı video olarak isterseniz linkini ayrıca gönderin: ${b.merged.map(shortUrl).join(", ")}`);
    push(`🔗 çok linkli mesaj: ${b.videos.length} video linki sırayla kuyruğa alındı (${res.filter((r) => r.ok).map((r) => `#${r.no}`).join(", ") || "hiçbiri"})${b.sources.length ? `; ${b.sources.length} haber linki kaynak olarak talimatta` : ""}${b.merged.length ? `; tek video istendi, ${b.merged.length} video linki alınmadı` : ""}`);
    for (const s of b.skipped) extra.push(`⚠️ Alınmadı: ${shortUrl(s.url)} — ${firstSentence(s.why)}`);
    return { action: "vqueue", reply: batchReply(res, { extra, src }), payload: {}, heard: text };
  }
  // beyin bağlamı: kuyruktaki işler numaralarıyla (Claude da "kuyruk iptal 7"yi aynı numarayla verir)
  const brief = () => rows().map((x) => ({ no: x.no, durum: items.includes(x) ? "sırada" : x === current ? STEP[x.step] || "hazırlanıyor" : stepText(x), video: label(x), kaynak: SRC[x.source] || x.source, iptal: `#${x.no} iptal` }));
  // üretim sonu temizliği (server.js reap) dokunmasın: hazırlanan işin runLines'la kaydedilen süreçleri (torunları reap'te bulunur)
  const ownPids = () => (current?.ctx ? [...current.ctx.children].map((c) => c?.pid).filter((p) => Number(p) > 0) : []);

  // ---- panel API
  if (app) {
    app.get("/api/vqueue", (_req, res) => res.json(view()));
    // seçim sırasıyla: {urls:[…] | items:[{url, mode, account, caption}], mode, source}
    app.post("/api/vqueue", (req, res) => {
      const b = req.body || {}, list = Array.isArray(b.items) ? b.items : (Array.isArray(b.urls) ? b.urls : []).map((url) => ({ url }));
      if (!list.length) return res.json({ ok: false, error: "Video seçilmedi." });
      const out = list.slice(0, OWNER_MAX).map((x) => {
        const url = String(x?.url || "").trim(), lk = findLink(url), vl = lk ? videoLink(lk.url) : null;
        if (!vl || vl.kind !== "video") return { ok: false, url, error: `Video linki değil: ${shortUrl(url)}` };
        const mode = (x.mode || b.mode) === "fragman" ? "fragman" : "haber";
        return add({ url: lk.url, instruction: mode === "fragman" ? "fragman" : "", kind: mode === "fragman" ? "" : (b.kind ?? "haber"), mode, source: "panel", account: x.account, caption: x.caption, trend: !!(x.trend ?? b.trend) });
      });
      // panel düğmesi: WhatsApp komut ipucu yok (inceleme, 20 Ekim)
      res.json({ ok: out.some((r) => r.ok), results: out, reply: batchReply(out, { hints: false }), view: view() });
    });
    app.post("/api/vqueue/cancel", (req, res) => res.json(cancel(String(req.body?.id || ""))));
    app.post("/api/vqueue/move", (req, res) => res.json(move(String(req.body?.id || ""), Number(req.body?.dir) || 1)));
    app.post("/api/vqueue/clear", (_req, res) => res.json({ ok: true, removed: clear() }));
  }

  return {
    add, addBatch, cancel, cancelNos, cancelCurrent, move, clear, dropAuto, stop, kick, view, has, positionOf, handleText, listText, batchReply, emit, idLine, brief, ownPids,
    produced, numberFor, stateOf, ownerNo, sourceOf, doneOf, guardText, noteList, timeLine: queueTimeLine,
    waiting: () => items.length + (current ? 1 : 0),  // sıradaki iş (dinlenme kararı): bekleyen + hazırlanan
    pending: () => items.length + (current ? 1 : 0),   // güncelleme beklesin
    size: () => rows().length,                          // kutudaki tüm işler (üretimdekiler dahil)
    autoQueued: () => items.filter((x) => !owner(x)).length,
    wasCancelled: (proc) => !!proc && cancelledProcs.has(proc),
    current: () => (current ? pub(current, posOf(current.id)) : null),
  };
}
