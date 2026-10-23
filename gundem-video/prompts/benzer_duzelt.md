
DÜZELTME TURU. Kanal sahibi önceki sürümü İZLEDİ ve değişiklik istedi: "duzeltme" alanı. Elinde önceki plan var ("onceki_plan": konu, mesaj,
tarz, palet, etiket, başlıklar ve sahneler — her sahnenin başlığı, seslendirmesi, tarifi ve çizimi) ve referansın özeti ("referans_ozeti":
konuşma dökümü, ekranda okunan yazılar, paylaşım bilgisi). Referans video yeniden izlenmez; "referans_videolar" varsa kareler yalnız
hatırlatma içindir. Önceki plan doğru kabul edilir: hikâye zaten anlaşılmıştır, görevin yalnız istenen değişikliği uygulamak.

DÜZELTME KURALLARI
- YALNIZ istenen yerleri değiştir. Sahibin değinmediği sahnenin "title", "narration", "sahne" ve "svg" alanlarını önceki plandan KARAKTERİ
  KARAKTERİNE kopyala: svg'yi yeniden yazma, "iyileştirme", kısaltma. Aynı svg aynı çizim demektir ve o sahne yeniden ÇİZİLMEZ (önceki
  çizim kullanılır); değişen svg sahnenin baştan çizilmesi demektir. Konu, mesaj, tarz, palet, etiket, kategori, başlıklar, etiketler, ilk
  yorum da istenmedikçe aynı kalır.
- Sahne sayımı: "1. sahne", "2. sahne" = onceki_plan.segments içinde kind "haber" olan sahnelerin sırası (kanca "hook" sayılmaz; "kanca",
  "giriş", "ilk cümle" denirse hook); "son sahne" sonuncu haber sahnesi. Sahip sahneyi başlığıyla ya da içindeki bir sözle de gösterebilir.
- İstek bir sahneyi SİLMEK, EKLEMEK ya da yerini değiştirmekse sırayı buna göre kur; kalan sahneler yine birebir kopya.
- Seslendirmesi değişen sahnede kelime kuralları (kanca en çok 10, sahne 12-35 kelime) ve toplam kelime sınırı (__KELIME__) geçerlidir.
  "kısalt", "uzat", "daha sade anlat" gibi istekler yalnız gösterilen sahneye uygulanır; sahne gösterilmemişse tüm seslendirmeye.
- Çizimi değişen sahnede bütün ÇİZİM kurallarına uy; aynı karakter diğer sahnelerdekiyle aynı biçimde ve renkte kalsın (palet değişmedikçe).
- Paleti yalnız sahip isterse değiştir; palet değişince bütün sahneler yeniden çizilir (sahip bunu istemiştir, sorun değil).
- Önceki plandaki açık bir hata (uydurma bilgi, yanlış çeviri, yazım yanlışı) sahip söylemeden de düzeltilebilir; bunu "degisiklikler"de söyle.
- Önceki sahnede "svg" boşsa ("fallback": true) o sahnenin çizimi kullanılamamıştı (bozuk SVG): sahip istemese de yeniden çiz.
- Sahibin isteği kurallara aykırıysa (marka, gerçek kişi, telifli karakter, uydurma bilgi, kopya cümle) uygulanabilir en yakın hâlini yap ve
  "degisiklikler"de neden tam uygulanmadığını bir cümleyle söyle.
- "degisiklikler": 1-3 cümle Türkçe: ne değişti, hangi sahnelerde (ör. "2. sahnede yılan kırmızı çizildi ve seslendirme kısaldı; diğer
  sahneler aynı"). "cuts" önceki plandaki gibi kalır (referanstan neyin korunduğu).

ÇIKTI: aynı şema (tam JSON; değişmeyen sahneler dahil TÜM sahneler) + ek alan "degisiklikler".
