export type Segment = {
  /** "intro" | "haber" | "outro" */
  kind: "hook" | "intro" | "haber" | "outro";
  /** Ekranda görünen kısa başlık (haber için). */
  title?: string;
  /** Seslendirilen metin. */
  narration: string;
  /** Haber kategorisi: src/categories.ts içindeki sabit listeden. */
  category?: string;
  /** Claude'un önerdiği yeni kategori etiketi (ör. "KÜLTÜR"): sabit listede yoksa kartta bu yazılır, görsel/ses en yakın kategoriden gelir. */
  categoryLabel?: string;
  /** Günün en büyük haberi: "SON DAKİKA" manşet muamelesi görür. En fazla bir habere verilir. */
  breaking?: boolean;
  /** Kaynak adı (ör. "AA", "TRT Haber"). */
  source?: string;
  /** Ses dosyası, public/ altına göre. */
  audio: string;
  /** Saniye cinsinden ses süresi (tts.py doldurur). */
  duration: number;
  /** Kelime zamanları, segment başına göre saniye (tts.py doldurur). */
  words?: { w: string; s: number; e: number }[];
  /** Haber görseli (public/ altına göre), varsa: 1840x1120 kart. */
  image?: string;
  /** 1080x1920 dikey sürüm: fotoğrafın tamamı keskin, arkası bulanık (kanca ve dikey kapak). */
  imageTall?: string;
  /** Haber videosu (public/ altına göre, sessiz); varsa fotoğrafın yerine oynar. */
  video?: string;
  /** Video klibinin saniye cinsinden süresi (döngü için). */
  videoDuration?: number;
};

export type Episode = {
  date: string;          // "2026-10-07"
  dateLabel: string;     // "7 Ekim 2026"
  episodeOfDay: number;  // günün kaçıncı videosu
  timeLabel: string;     // "14:00"
  /** Format: sabah | ogle | aksam | ozel */
  format?: string;
  formatLabel?: string;  // "Güne Başlarken"
  music?: string;        // public/ altına göre müzik yatağı
  musicVolume?: number;
  titleVariant?: "A" | "B";
  titles?: { A?: string; B?: string; cover?: string };
  dayLabel?: string;     // "9 Ekim Cuma"
  slotLabel?: string;    // "2. 5 SAAT" ya da "ANLIK HABER"
  timeRange?: string;    // "09:00–14:00"
  scheduleHours?: number;
  anlik?: boolean;
  segments: Segment[];
};

export const FPS = 30;
export const WIDTH = 1080;
export const HEIGHT = 1920;
