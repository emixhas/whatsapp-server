import { ComponentType } from "react";
import { Finans } from "./illustrations/Finans";
import { Siyaset } from "./illustrations/Siyaset";
import { Spor } from "./illustrations/Spor";
import { Hava } from "./illustrations/Hava";
import { Toplum } from "./illustrations/Toplum";
import { Teknoloji } from "./illustrations/Teknoloji";
import { Saglik } from "./illustrations/Saglik";
import { Dunya } from "./illustrations/Dunya";
import { Genel } from "./illustrations/Genel";
import { Parti } from "./illustrations/Parti";
import { Egitim } from "./illustrations/Egitim";
import { Asayis } from "./illustrations/Asayis";
import { Sinema } from "./illustrations/Sinema";
import { Trend } from "./illustrations/Trend";
import { Mizah } from "./illustrations/Mizah";

export const CATEGORIES = ["finans", "siyaset", "spor", "hava", "toplum", "teknoloji", "saglik", "dunya", "parti", "egitim", "asayis", "sinema", "trend", "mizah", "genel"] as const;
export type Category = (typeof CATEGORIES)[number];

export type CategoryStyle = {
  label: string;
  accent: string;
  sfx: string;          // public/sfx altındaki dosya
  sfxVolume: number;    // seslendirmenin altında kalacak seviye
  Illustration: ComponentType;
};

/** Her kategori için SABİT görsel ve ses. Her videoda aynı eşleme kullanılır. */
export const CATEGORY_STYLES: Record<Category, CategoryStyle> = {
  finans:    { label: "EKONOMİ",   accent: "#F2B705", sfx: "sfx/kasa.wav",     sfxVolume: 0.55, Illustration: Finans },
  siyaset:   { label: "SİYASET",   accent: "#E30A17", sfx: "sfx/tokmak.wav",   sfxVolume: 0.5,  Illustration: Siyaset },
  spor:      { label: "SPOR",      accent: "#2ECC71", sfx: "sfx/duduk.wav",    sfxVolume: 0.35, Illustration: Spor },
  hava:      { label: "HAVA",      accent: "#4FC3F7", sfx: "sfx/yagmur.wav",   sfxVolume: 0.45, Illustration: Hava },
  toplum:    { label: "TOPLUM",    accent: "#FF8A3D", sfx: "sfx/sehir.wav",    sfxVolume: 0.4,  Illustration: Toplum },
  teknoloji: { label: "TEKNOLOJİ", accent: "#8E7CFF", sfx: "sfx/blip.wav",     sfxVolume: 0.45, Illustration: Teknoloji },
  saglik:    { label: "SAĞLIK",    accent: "#FF5C8A", sfx: "sfx/kalp.wav",     sfxVolume: 0.5,  Illustration: Saglik },
  dunya:     { label: "DÜNYA",     accent: "#36D1C4", sfx: "sfx/dunya.wav",    sfxVolume: 0.45, Illustration: Dunya },
  parti:     { label: "SİYASET",   accent: "#E30A17", sfx: "sfx/tokmak.wav",   sfxVolume: 0.5,  Illustration: Parti },
  egitim:    { label: "EĞİTİM",    accent: "#FFB020", sfx: "sfx/okul.wav",     sfxVolume: 0.5,  Illustration: Egitim },
  asayis:    { label: "ASAYİŞ",    accent: "#3D7BFF", sfx: "sfx/siren.wav",    sfxVolume: 0.4,  Illustration: Asayis },
  // film, dizi, fragman, gişe, festival ve ödül törenleri (kullanıcı isteği, 18 Ekim: "bir filmin fragmanını analiz edip … video")
  sinema:    { label: "SİNEMA",    accent: "#E040FB", sfx: "sfx/sinema.wav",   sfxVolume: 0.5,  Illustration: Sinema },
  // sosyal medyada çok izlenen ve mizah videoları (kullanıcı isteği, 19 Ekim: "son dakika diye haber yapıyor; link/mizah yazınca mizah
  // kategorisine göre üretilsin ama direk mizah yazmasın, girişte izlenmez"): ikisinde de ekranda VİRAL yazar; mizah videonun sonunda söylenir
  trend:     { label: "VİRAL",     accent: "#FF2D55", sfx: "sfx/trend.wav",    sfxVolume: 0.5,  Illustration: Trend },
  mizah:     { label: "VİRAL",     accent: "#C6FF00", sfx: "sfx/mizah.wav",    sfxVolume: 0.5,  Illustration: Mizah },
  genel:     { label: "GÜNDEM",    accent: "#FFFFFF", sfx: "sfx/bildirim.wav", sfxVolume: 0.45, Illustration: Genel },
};

export const styleFor = (c?: string): CategoryStyle =>
  CATEGORY_STYLES[(CATEGORIES as readonly string[]).includes(c ?? "") ? (c as Category) : "genel"];
