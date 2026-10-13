// WhatsApp "yardım" / "komutlar" yanıtı: commands.js kurallarının ve whatsapp.js'teki özel komutların listesi.
// Yeni bir kural eklerken buraya da yaz (kullanıcı WhatsApp'tan ne yazabileceğini buradan öğrenir).
export const HELP_TEXT = `📋 *Emixhas komutları*

✅ *Yayın onayı*
• onay / evet — bekleyen videoyu yayınla
• iptal — yayınlama

🎬 *Video üret*
• video üret · 60 saniyelik video üret
• son dakika: <konu> · son dakika <konu>
• <haber linki> — linkteki haberden video (linkle birlikte "aç" yazarsanız tarayıcıda açar)
• <konu> hakkında son dakika videosu yap
• günün özetini üret · haftanın özetini üret
• en çok izlenen videoyu yeniden yayınla · son videoyu yeniden yayınla

📡 *Otomatik içerikler*
• depremleri kontrol et
• maç sonuçlarını kontrol et
• piyasa videosu üret
• zam alarmı kontrol et
• meteoroloji uyarılarını kontrol et
• yarının takvim hatırlatmasını üret
• haftanın en çok izlenenlerini üret
• en çok izlenen saatler · altın saat tekrarını aç / kapat / şimdi yap

📤 *Yayın ve hesaplar*
• instagram'a yayınla · tiktok'a yayınla · youtube'a yayınla (son video)
• tiktok sırası · sırada ne var
• kapakları yeniden yükle
• süresi geçenleri liste dışı yap · liste dışı yapılanları geri aç
• günün hikayesini paylaş — en çok izlenenler Instagram hikâyesine · hikaye paylaşımını kapat / otomatik hikayeyi aç
• instagramda son 7 günde 1000 izlenmenin altındakileri sil → önce liste gelir, *evet sil* ile silinir, *iptal* ile vazgeçilir (gün ve izlenme sayısı değiştirilebilir; sona "24 saatten eski" eklenebilir)

📊 *Bilgi ve rapor*
• durum
• son videoyu gönder
• izlenmeleri güncelle
• kaç abonemiz var · bugün kaç takipçi kazandık
• yorumları özetle · yorumları yanıtla
• haftalık rapor · bu hafta nasıl gitti
• rapor · plan
• sistem kontrol

⚙️ *Sistem*
• otomatik aç / otomatik kapat — tam otomatik mod
• zamanlayıcıyı aç / zamanlayıcıyı kapat
• sistemi durdur · sistemi başlat
• tünel aç / tünel kapat
• komutlar — bu liste

Bunların dışındaki her mesaj (soru, birden çok istek) Emixhas'ın beynine gider.`;
