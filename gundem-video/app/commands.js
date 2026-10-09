// Türkçe sesli komutları kural tabanlı çözer. LLM yok, token yok.
const NUM = { "on beş": 15, onbeş: 15, yirmi: 20, otuz: 30, "kırk beş": 45, kırkbeş: 45, kırk: 40, elli: 50, altmış: 60, yetmiş: 70, seksen: 80, doksan: 90, yüz: 100, "yüz yirmi": 120, "bir dakika": 60, "iki dakika": 120, "bir buçuk dakika": 90 };

const norm = (s) => s.toLocaleLowerCase("tr-TR").replace(/[.,!?']/g, " ").replace(/\s+/g, " ").trim();

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
  if (/^(dur|sus|tamam dur|yeter|kes|sessiz ol|teşekkürler|sağ ol)$/.test(t)) return { action: "stop", reply: "" };
  if (/(iptal|boş ver|vazgeç)/.test(t)) return { action: "none", reply: "Tamam, iptal." };
  if (/(yayınla|paylaş).*(youtube|instagram|tiktok|tik tok)/.test(t) || /(youtube|instagram|tiktok|tik tok).*(yayınla|paylaş|yükle)/.test(t))
    return { action: "publish", platforms: ["youtube", "instagram", "tiktok"].filter((p) => t.replace("tik tok", "tiktok").includes(p)), reply: "" };
  // Uzun veya bileşik cümleler (iki istek, soru, gerekçe) hızlı kurallara değil beyne gider.
  const words = t.split(" ").length;
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
  if (/(son|en yeni|sonuncu).*(oynat|aç|göster|izle)/.test(t) || /(oynat|izle)/.test(t)) return { action: "play_latest", reply: "" };
  if (/finder/.test(t)) return { action: "reveal", reply: "" };
  if (/(paylaş|gönder|telefon)/.test(t)) return { action: "share", reply: "" };
  if (/\b(sistem kontrol|kontrol et|kendini test et|test yap|sistem testi|her şey yolunda mı)\b/.test(t)) return { action: "selftest", reply: "" };
  if (/(durum|ne durumda|nasıl gidiyor|bitti mi|kaç video)/.test(t)) return { action: "status", reply: "" };
  if (/(rapor|özet ver|nasıl gitti|performans)/.test(t)) return { action: "report", reply: "" };
  if (/(plan|strateji|ne yapalım|öneri)/.test(t)) return { action: "plan", reply: "" };
  if (/(izlenme|istatistik|metrik).*(güncelle|çek|yenile|tazele)/.test(t) || /(güncelle|tazele).*(izlenme|istatistik)/.test(t)) return { action: "sync_metrics", reply: "" };
  if (/(listele|videoları göster|yenile)/.test(t)) return { action: "refresh", reply: "Liste yenilendi." };
  if (/(merhaba|selam|jarvis)/.test(t)) return { action: "none", reply: "Buradayım. Video üret, son videoyu oynat, paylaş veya durum diyebilirsiniz." };
  return { action: "brain", reply: "" };  // kural yok → Jarvis'in beyni düşünsün
}
