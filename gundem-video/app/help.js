// WhatsApp "yardım" / "komutlar" yanıtı: commands.js kurallarının ve whatsapp.js'teki özel komutların listesi.
// Yeni bir kural eklerken buraya da yaz (kullanıcı WhatsApp'tan ne yazabileceğini buradan öğrenir).
export const HELP_TEXT = `📋 *Emixhas komutları*

🧠 Bu kalıpları ezberlemenize gerek yok: ne istediğinizi kendi cümlenizle yazın, Claude anlayıp yapar (soru sorarsanız cevaplar). Aşağıdakiler örnektir.

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
• 🔗 *Instagram/TikTok/X/YouTube paylaşım linki* (+ isterseniz nasıl bir haber istediğiniz) → videoyu indirip aynı şekilde kurgularım; hesap adı kaynak olarak yazılır, olay haber sitelerinde aranıp doğrulanır. Videonun etrafında haber hesabının çerçevesi (logo, başlık bandı) varsa kırpılır; açıklama yoksa videodaki yazılar ve konuşma okunarak haber yazılır. Video baştan sona kendi sesiyle oynar (önce kısa giriş, sonra video, sonra kısa kapanış; en çok 150 sn, daha uzunsa en önemli bölüm). İstemezseniz linkin yanına "sesi kapat" yazın
• 📺 *YouTube haber linkleri* de olur (https:// yazmadan da: youtu.be/…, youtube.com/watch?v=…, /shorts/, /live/): *canlı yayında* yayının son 2 dakikası alınır; *uzun videoda* (haber programı, uzun röportaj; en çok 3 saat) videonun tamamından 40 saniyelik özet haber yapılır (aşağıda 📺). Bölümü siz seçmek için linkin yanına yazın (o bölüm kendi sesiyle haber olur): "<link> 12:30'dan itibaren", "5. dakikadan", "1:02:10'dan", "12:30-16:00 arası", "son 3 dakika" (zaman damgalı link de olur). Kanal ya da oynatma listesi linki olmaz, videonun kendi linkini gönderin. YouTube "bot değilim" doğrulaması isterse panelde Ayarlar → 📡 → "Sosyal medya çerezleri" alanına YouTube'a giriş yaptığınız tarayıcıyı (chrome / safari) yazın
• 😄 *Mizah ya da çok izlenen (viral) video linki*: linkin yanına ya da sonuna türünü yazın → *link/mizah*, *link mizah*, *link #mizah*, *link/trend* (viral, komik da olur; ek talimat için *link mizah, kısa kes*). Son dakika haberi gibi yapılmaz: ekranda *VİRAL* yazar, canlı sosyal medya diliyle anlatılır, video kendi sesiyle oynar; mizah videosunda "mizah" kelimesi girişte ve başlıkta geçmez, videonun sonunda "Bu video mizah amaçlıdır" denir. Tür yazmazsanız videoya bakılıp karar verilir (gerçek bir olaysa haber); haber olarak isterseniz *link/haber*
• 📺 *Uzun YouTube videosu* (haber programı, basın toplantısı, röportaj, canlı yayın kaydı; 10 dakikadan uzun, en çok 3 saat) → videonun tamamını incelerim (baştan sona konuşma dökümü ve kareler), en çarpıcı anlarını seçip HD alırım, 40 saniyelik haber yaparım (gerekirse en çok 8 sn kısa orijinal sesli alıntı). Daha kısa videoda linkin yanına "özetle" yazın; süre için "30 saniyelik özet". Belirli bir bölümü istiyorsanız zamanı yazın ("12:30'dan itibaren") ya da "kendi sesiyle" deyin: o bölüm kendi sesiyle haber olur. Bitince size gelir, *onay* ile yayınlanır
• 🎬 *YouTube fragman linki* (film ya da dizi) → fragmanı kelimelere döküp çekimlerini incelerim, çarpıcı bir kancayla 40 saniyelik "fragmanda ne anlatılıyor" videosu yaparım (fragmanın kendi sesi kullanılmaz; vizyon tarihi, oyuncu gibi bilgiler yalnız fragmanda ya da haber sitelerinde varsa söylenir). Başlıkta fragman/trailer geçiyorsa kendiliğinden tanırım; geçmiyorsa "fragman: <link>" ya da "<link> fragman yap" yazın. Fragmanı haber olarak isterseniz linkin yanına "haber yap" yazın. Bitince size gelir, *onay* ile yayınlanır
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
• sondakika.com'u kontrol et · sondakika takibini aç / kapat — 5 dakikada bir bakılır, düşen her yeni haber onaysız son dakika videosu olur

📤 *Yayın ve hesaplar*
• instagram'a yayınla · tiktok'a yayınla · youtube'a yayınla (son video)
• tiktok sırası · sırada ne var
• kapakları yeniden yükle
• süresi geçenleri liste dışı yap · liste dışı yapılanları geri aç
• günün hikayesini paylaş — en çok izlenenler Instagram hikâyesine · hikaye paylaşımını kapat / otomatik hikayeyi aç
• instagramda son 7 günde 1000 izlenmenin altındakileri sil → önce liste gelir, *evet sil* ile silinir, *iptal* ile vazgeçilir (gün ve izlenme sayısı değiştirilebilir; sona "24 saatten eski" eklenebilir)
• silinecek videolar — otomatik Instagram temizliğinin listesi (5000 izlenme altı, 72 saat sonra) · otomatik silmeyi kapat / aç

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
• güncelle — paneli GitHub'daki son sürüme günceller ve yeniden başlatır (paneldeki ⬇ Güncelle düğmesi gibi); üretim sürüyorsa bitince yapar, açılınca "✅ Güncellendi" yazar · güncelleme var mı — yalnız bakar
• komutlar — bu liste

Bunların dışındaki her mesaj (soru, birden çok istek) Emixhas'ın beynine gider.`;
