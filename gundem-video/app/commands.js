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

export function parseCommand(raw) {
  const t = norm(raw);
  if (!t) return { action: "none", reply: "Sizi duyamadım." };
  // "youtube'dan X'i aç", "X şarkısını çal", "git youtube'da X'i oynat"
  if (/(youtube|yutub|yutup|şarkı|parça|müzik|klib)/.test(t) && /(aç|çal|oynat|başlat)/.test(t)) {
    const q = extractQuery(t);
    if (q.length > 1) return { action: "open_youtube", query: q, reply: "" };
    return { action: "none", reply: "Hangi şarkıyı açayım?" };
  }
  const rawl = raw.toLocaleLowerCase("tr-TR").replace(/[’']/g, "'").trim();
  if (/^(.+?)\s*(sitesini|sayfasını|adresini)\s*aç$/.test(rawl)) return { action: "open_url", target: rawl.replace(/\s*(sitesini|sayfasını|adresini)\s*aç$/, "").trim(), reply: "" };
  if (/^(google ?da|googleda|internette)\s+(.+?)\s+(ara|arat)$/.test(t)) return { action: "open_url", target: "https://www.google.com/search?q=" + encodeURIComponent(t.replace(/^(google ?da|googleda|internette)\s+/, "").replace(/\s+(ara|arat)$/, "")), reply: "" };
  // Anlık haber: "son dakika: <konu>" / "anlık haber: <konu>" → o konuda tek konulu son dakika videosu.
  // İki nokta (ya da tire) zorunlu: "son dakika haberleri neler" gibi sorular tetiklemesin.
  const an = String(raw).trim().match(/^(?:emixhas[,\s]*)?(?:son ?dakika|anl[ıi]k haber)(?: videosu)?(?: (?:üret|yap|hazırla|çek))?\s*[:\-–]\s*([\s\S]{8,})$/i);
  if (an) return { action: "anlik", topic: an[1].trim(), duration: 30, reply: "" };
  // Haber linki → sayfa okunur, ondan son dakika videosu ("aç" denirse tarayıcıda açılır)
  const link = String(raw).match(/https?:\/\/[^\s<>"']+/i);
  if (link) {
    if (/(^|\s)(aç|göster)(\s|$)/.test(t)) return { action: "open_url", target: link[0], reply: "" };
    return { action: "anlik", topic: String(raw).trim(), duration: extractSeconds(t) || 30, reply: "" };
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
  if (/(iptal|boş ver|vazgeç)/.test(t)) return { action: "none", reply: "Tamam, iptal." };
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
