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

export function parseCommand(raw) {
  const t = norm(raw);
  if (!t) return { action: "none", reply: "Sizi duyamadım." };
  if (/(iptal|boş ver|vazgeç)/.test(t)) return { action: "none", reply: "Tamam, iptal." };
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
  if (/(durum|ne durumda|nasıl gidiyor|bitti mi|kaç video)/.test(t)) return { action: "status", reply: "" };
  if (/(listele|videoları göster|yenile)/.test(t)) return { action: "refresh", reply: "Liste yenilendi." };
  if (/(merhaba|selam|jarvis)/.test(t)) return { action: "none", reply: "Buradayım. Video üret, son videoyu oynat, paylaş veya durum diyebilirsiniz." };
  return { action: "none", reply: "Bunu anlamadım. Örnek: altmış saniyelik video üret." };
}
