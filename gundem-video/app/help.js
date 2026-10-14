// WhatsApp "yardım" / "komutlar" yanıtı: commands.js kurallarının ve whatsapp.js'teki özel komutların listesi.
// Yeni bir kural eklerken buraya da yaz (kullanıcı WhatsApp'tan ne yazabileceğini buradan öğrenir).
export const HELP_TEXT = `📋 *Emixhas komutları*

✅ *Yayın onayı*
• onay / evet — bekleyen videoyu yayınla
• onay insta / onay youtube / onay tiktok — yalnız o platformda yayınla (ör. *onay insta youtube*); diğerleri beklemede kalır, sonra *onay tiktok* ya da *iptal*
• iptal — yayınlama

🎬 *Video üret*
• video üret · 60 saniyelik video üret
• son dakika: <konu> · son dakika <konu>
• <haber linki> — linkteki haberden video (linkle birlikte "aç" yazarsanız tarayıcıda açar)
• <konu> hakkında son dakika videosu yap
• günün özetini üret · haftanın özetini üret
• en çok izlenen videoyu yeniden yayınla · son videoyu yeniden yayınla
• ⏰ Linkin yanına saat yazın, video hemen hazırlanır ve o saatte yayınlanır: "18:30'da paylaş", "akşam 9'da", "yarın sabah 9", "2 saat sonra". Saat yazmazsanız hemen yayınlanır
• planlı yayınlar · planlı yayını iptal et · planlı yayını şimdi yayınla
• 🔗 *Instagram/TikTok/X/YouTube paylaşım linki* (+ isterseniz nasıl bir haber istediğiniz) → videoyu indirip aynı şekilde kurgularım; hesap adı kaynak olarak yazılır, olay haber sitelerinde aranıp doğrulanır. Video baştan sona kendi sesiyle oynar (önce kısa giriş, sonra video, sonra kısa kapanış; en çok 150 sn, daha uzunsa en önemli bölüm). İstemezseniz linkin yanına "sesi kapat" yazın
• 📹 *video gönderin* + açıklamaya nasıl bir haber istediğinizi yazın (ör. "Kadıköy'de yangın, 30 saniye, baştaki titrek kısmı kes") → kurgulanır, gereksiz yerler kesilir, seslendirilir; açıklama yoksa sorarım. Birden çok videoyu arka arkaya gönderirseniz tek haberde birleştiririm (en çok 4). Bitince size gelir, *onay* yazınca yayınlanır. Talimata "orijinal sesini kullan" yazarsanız o bölümde seslendirme susar, video kendi sesiyle oynar; dikey videoda haberler tam ekran dikey düzende olur.

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
