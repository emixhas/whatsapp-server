export type Segment = {
  /** "intro" | "haber" | "outro" */
  kind: "intro" | "haber" | "outro";
  /** Ekranda görünen kısa başlık (haber için). */
  title?: string;
  /** Seslendirilen metin. */
  narration: string;
  /** Haber kategorisi: src/categories.ts içindeki sabit listeden. */
  category?: string;
  /** Günün en büyük haberi: "SON DAKİKA" manşet muamelesi görür. En fazla bir habere verilir. */
  breaking?: boolean;
  /** Kaynak adı (ör. "AA", "TRT Haber"). */
  source?: string;
  /** Ses dosyası, public/ altına göre. */
  audio: string;
  /** Saniye cinsinden ses süresi (tts.py doldurur). */
  duration: number;
};

export type Episode = {
  date: string;          // "2026-10-07"
  dateLabel: string;     // "7 Ekim 2026"
  episodeOfDay: number;  // günün kaçıncı videosu
  timeLabel: string;     // "14:00"
  segments: Segment[];
};

export const FPS = 30;
export const WIDTH = 1080;
export const HEIGHT = 1920;
