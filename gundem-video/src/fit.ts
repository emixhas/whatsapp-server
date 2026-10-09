import { theme } from "./theme";

// Yazı sığdırma: Remotion gerçek bir tarayıcıda çizdiği için metin genişliği canvas ile ölçülür.
// Amaç: hiçbir kelime ekrandan taşmasın, kelime ortadan bölünmesin, başlık en çok N satır olsun.
let ctx: CanvasRenderingContext2D | null = null;
const cache = new Map<string, number>();

/** Türkçe büyük harf: i → İ, ı → I (CSS lang="tr" ile aynı sonuç). */
export const trUpper = (s: string) => s.replace(/i/g, "İ").replace(/ı/g, "I").toUpperCase();

export function textWidth(text: string, size: number, weight = 900, family = theme.font, letterSpacing = 0): number {
  const key = `${weight}|${size}|${family}|${letterSpacing}|${text}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  if (!ctx && typeof document !== "undefined") {
    try { ctx = document.createElement("canvas").getContext("2d"); } catch { ctx = null; }
  }
  let w = text.length * size * 0.74; // ölçüm yoksa güvenli tahmin (kalın büyük harf)
  if (ctx) { ctx.font = `${weight} ${size}px ${family}`; w = ctx.measureText(text).width; }
  w += letterSpacing * text.length;
  cache.set(key, w);
  return w;
}

type FitOpts = { text: string; maxWidth: number; base: number; min: number; maxLines: number; weight?: number; family?: string; upper?: boolean; letterSpacing?: number };

/** Kelimeler bölünmeden maxWidth'e ve en çok maxLines satıra sığan en büyük punto. */
export function fitFontSize({ text, maxWidth, base, min, maxLines, weight = 900, family = theme.font, upper = true, letterSpacing = 0 }: FitOpts): number {
  const t = upper ? trUpper(text) : text;
  const words = t.split(/\s+/).filter(Boolean);
  const limit = maxWidth * 0.95; // gölge, satır dengeleme ve büyüme animasyonu için pay
  for (let size = base; size > min; size -= 2) {
    const space = textWidth(" ", size, weight, family, letterSpacing);
    let lines = 1, cur = 0, ok = true;
    for (const w of words) {
      const ww = textWidth(w, size, weight, family, letterSpacing);
      if (ww > limit) { ok = false; break; }
      if (cur === 0) cur = ww;
      else if (cur + space + ww <= limit) cur += space + ww;
      else { lines++; cur = ww; }
    }
    if (ok && lines <= maxLines) return size;
  }
  return min;
}
