import { Episode } from "./types";

/** Studio'da önizleme için örnek veri. Gerçek üretimde public/episode.json kullanılır. */
export const sampleEpisode: Episode = {
  date: "2026-10-07",
  dateLabel: "7 Ekim 2026",
  episodeOfDay: 1,
  timeLabel: "09:00",
  segments: [
    { kind: "hook", title: "FAİZ SABİT", narration: "Merkez Bankası faizi değiştirmedi.", category: "finans", audio: "audio/seg-00.wav", duration: 2.6 },
    { kind: "intro", narration: "Günün özeti, Türkiye gündemi.", audio: "audio/seg-00.wav", duration: 2 },
    { kind: "haber", title: "Merkez Bankası faiz kararını açıkladı", category: "finans", narration: "Merkez Bankası politika faizini beklentiler doğrultusunda sabit tuttu.", source: "AA", audio: "audio/seg-01.wav", duration: 6 },
    { kind: "haber", title: "İstanbul'da ulaşıma yeni düzenleme", category: "toplum", narration: "İstanbul'da toplu taşımada yeni tarife uygulaması başladı.", source: "TRT Haber", audio: "audio/seg-02.wav", duration: 6 },
    { kind: "haber", title: "Meteoroloji'den sağanak uyarısı", category: "hava", narration: "Meteoroloji, Marmara ve Ege için kuvvetli sağanak uyarısı yaptı.", source: "NTV", audio: "audio/seg-03.wav", duration: 6 },
    { kind: "haber", title: "Milli takım hazırlıklara başladı", category: "spor", narration: "A Milli Futbol Takımı, Dünya Kupası elemeleri için kampa girdi.", source: "AA", audio: "audio/seg-04.wav", duration: 6 },
    { kind: "outro", narration: "Beş saat sonra yeni özetle buradayız. Takipte kalın.", audio: "audio/seg-05.wav", duration: 3 },
  ],
};
