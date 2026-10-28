import { Fragment, useMemo } from "react";
import { useCurrentFrame, useVideoConfig } from "remotion";
import { currentGroup, Word } from "../captionGroups";
import { fitText, textWidth, trUpper } from "../fit";
import { theme } from "../theme";

// Yanan altyazının görünümü (kullanıcı kararı, 20 Ekim: "3'er kelime halinde, orta büyüklükte"; 21 Ekim: "kelimeler önceden
// gelsin, sadece renklensin"; 28 Ekim: "yazı beyaz gelsin, seslendirilen kelime sarı olsun; çok profesyonel ve oturaklı olmalı";
// 27 Ekim'deki "tüm cümle sarı, söylenen beyaz" bunun tersiydi): grubun bütün kelimeleri baştan BEYAZ görünür — harfin içi beyaz,
// harflerin DIŞINA siyah kontür (~0,11 em) —; o an seslendirilen kelime SARI olur, sıradaki kelime söylenince yeniden beyaza döner
// (sarı vurgu kelimeden kelimeye geçer; son söylenen kelime grup kalkana kadar sarı kalır). Renk değişimi FADE sn'lik yumuşak
// geçiş; büyüme, zıplama, kayma yok: punto ve yerleşim grup boyunca sabit. Arkada yumuşak koyu gölge (açık renkli görüntüde beyaz ve
// sarı da seçilsin); kutu yok, büyük harf (lang="tr": i → İ), kelime asla bölünmez. Kontür iki katmanla çizilir: arkada kalın kontür
// -webkit-text-stroke, önde aynı yerde dolgu; böylece kontürün içe düşen yarısı dolgunun altında kalır (paint-order desteğine bağlı değil).
export const CAPTION_FILL = "#FFFFFF"; // kelimenin içi (beyaz)
export const CAPTION_ACTIVE = "#FFD400"; // o an seslendirilen kelimenin içi (sarı)
export const CAPTION_OUTLINE = "#000"; // her kelimenin dış kontürü (siyah)
const OUTLINE = 0.11; // dış kontür (em)
const GAP = 0.45; // kelime arası (em): yan yana iki kelimenin kontürleri birbirine değmesin
const LH = 1.2; // satır yüksekliği (em): alt satırın İ noktası, Ğ şapkası üst satırın Ş çengeline, kontürüne değmesin
const FADE = 0.06; // beyaz ↔ sarı geçişi (sn; 30 karede ~2 kare): sert sıçrama değil, yine de kelimeyle aynı anda
const FLOOR = 40; // hiçbir düzen sığmazsa başlığa binmektense bu puntoya kadar küçülür
const ONE = 0.95; // tek satır ancak çok satırlı puntonun en çok %5 altında sığıyorsa: kısa grup komşusundan küçük çıkmasın

export type CaptionFit = { width: number; base: number; min?: number; maxLines?: number; maxHeight?: number };

/** Grubun puntosu ve satır sayısı. Punto gruptan gruba sıçramasın diye en çok maxLines satıra sığan en büyük punto (base'den
 *  min'e); min'de de sığmazsa min'in altına inmeden önce yükseklik payı içinde bir satır fazlası (FLOOR'a kadar: çok uzun üç kelime
 *  iki satırda 40 px olacağına üç satırda büyük kalır). Tek satır yalnız bu puntonun en çok %5 altında sığıyorsa seçilir. Ölçüm
 *  kelime arasını ve dış kontürü sayar; maxHeight (px) bloğun yerleşim payıdır (başlığa, banda binmesin). lines tarayıcının satır
 *  sayısından az olmaz (ölçüm genişliğin %95'iyle yapılır). */
export function captionFit(text: string, { width, base, min = 48, maxLines = 2, maxHeight }: CaptionFit): { size: number; lines: number } {
  const o = { text, maxWidth: width, base, gap: GAP, pad: 2 * OUTLINE, lineHeight: LH, maxHeight, letterSpacing: 1 };
  for (const f of [{ min, maxLines }, { min: FLOOR, maxLines: maxLines + 1 }]) {
    const r = fitText({ ...o, ...f });
    if (!r.ok) continue;
    if (r.lines > 1) {
      const one = fitText({ ...o, min: Math.max(FLOOR, Math.ceil(r.size * ONE)), maxLines: 1 });
      if (one.ok) return { size: one.size, lines: 1 };
    }
    return { size: r.size, lines: r.lines };
  }
  return { size: FLOOR, lines: maxLines + 1 };
}

export const captionSize = (text: string, fit: CaptionFit) => captionFit(text, fit).size;

/** Bloğun görünen yüksekliği (px): satırlar + üstte ve altta dış kontür. */
export const captionHeight = (fs: number, lines: number) => (lines * LH + 2 * OUTLINE) * fs;

/** Ekrandaki grubu, puntosunu ve satır sayısını verir (grup yoksa null); punto grup boyunca sabit, yazı kaymaz. */
export function useCaption(words: Word[] | undefined, fit: CaptionFit) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const cur = currentGroup(words, frame / fps);
  const text = cur ? cur.words.map((w) => w.w).join(" ") : "";
  const f = useMemo(() => (text ? captionFit(text, fit) : { size: 0, lines: 0 }), [text, fit.width, fit.base, fit.min, fit.maxLines, fit.maxHeight]);
  return cur ? { ...cur, fs: f.size, lines: f.lines } : null;
}

/** İki satıra düşen üç kelimede kırılım (k. kelimeden önce; yoksa -1): iki satırın uzunu en kısa olsun (açgözlü "TRAFİK KAZASINDA /
 *  ÜÇ" yerine "TRAFİK / KAZASINDA ÜÇ"); neredeyse eşitse üst satır kısa. Açgözlü kırılım sığdığı için bu da sığar. */
function lineBreak(words: string[], fs: number, lines: number): number {
  if (lines !== 2 || words.length !== 3) return -1;
  const [a, b, c] = words.map((w) => textWidth(trUpper(w), fs, 900, theme.font, 1));
  const gap = GAP * fs;
  return Math.max(a, b + gap + c) <= Math.max(a + gap + b, c) * 1.04 ? 1 : 2;
}

/** a rengiyle b rengi (#RRGGBB) arası, t ∈ [0, 1]. */
function mix(a: string, b: string, t: number): string {
  const ch = (c: string, i: number) => parseInt(c.slice(1 + 2 * i, 3 + 2 * i), 16);
  return "#" + [0, 1, 2].map((i) => Math.round(ch(a, i) + (ch(b, i) - ch(a, i)) * t).toString(16).padStart(2, "0")).join("");
}

/** Grubu çizer (konumsuz): bütün kelimeler baştan görünür (beyaz dolgu, siyah kontür); o an seslendirilen kelime sarı dolgulu
 *  olur, sıradaki kelime söylenince yeniden beyaza döner (son kelime grup kalkana kadar sarı). Geçiş FADE sn; boy, yer sabit.
 *  align: Shorts'ta ortalı, yatay özette sola dayalı. */
export const CaptionText = ({ cap, align = "center" }: { cap: NonNullable<ReturnType<typeof useCaption>>; align?: "center" | "left" }) => {
  const { fs } = cap;
  const ow = Math.max(3, Math.round(fs * OUTLINE));
  const br = lineBreak(cap.words.map((w) => w.w), fs, cap.lines);
  // k. kelimenin sarıya dönüşü (0 → 1, söylendiği andan FADE sn içinde); sarılık = kendi dönüşü − sonraki kelimenin dönüşü
  const rise = (k: number) => (k < cap.ages.length ? Math.min(1, Math.max(0, cap.ages[k] / FADE)) : 0);
  return (
    <div key={cap.key} lang="tr" style={{
      display: "flex", flexWrap: "wrap", justifyContent: align === "left" ? "flex-start" : "center", columnGap: Math.round(fs * GAP), rowGap: 0,
      fontFamily: theme.font, fontSize: fs, fontWeight: 900, lineHeight: LH, letterSpacing: 1, textTransform: "uppercase",
      // kontür harfin dışına taşar: satır kenarlarda da blok genişliği içinde kalsın
      width: "100%", boxSizing: "border-box", padding: `0 ${ow}px`,
      filter: "drop-shadow(0 0 2px rgba(0,0,0,.85)) drop-shadow(0 6px 14px rgba(0,0,0,.6))",
    }}>
      {cap.words.map((w, k) => {
        const glow = Math.max(0, rise(k) - rise(k + 1)); // 0 beyaz … 1 sarı (o an seslendirilen kelime)
        const fill = glow <= 0 ? CAPTION_FILL : glow >= 1 ? CAPTION_ACTIVE : mix(CAPTION_FILL, CAPTION_ACTIVE, glow);
        const outline = CAPTION_OUTLINE;
        return (
          <Fragment key={k}>
            {/* satır kırılımı: tam genişlikte, yüksekliksiz öğe sonraki kelimeyi alt satıra iter */}
            {k === br ? <span data-br style={{ flexBasis: "100%", height: 0 }} /> : null}
            <span data-active={glow >= 0.5 ? 1 : 0} style={{
              position: "relative", display: "inline-block", whiteSpace: "nowrap", wordBreak: "keep-all", hyphens: "none",
            }}>
              <span aria-hidden style={{ position: "absolute", left: 0, top: 0, color: outline, WebkitTextStroke: `${2 * ow}px ${outline}` }}>{w.w}</span>
              <span style={{ position: "relative", color: fill }}>{w.w}</span>
            </span>
          </Fragment>
        );
      })}
    </div>
  );
};

type Props = {
  words?: Word[];
  /** eski API: kategori renginde kutu 20 Ekim'de kaldırıldı, renk artık kullanılmıyor */
  accent?: string;
  bottom?: number; top?: number;
  /** temel punto (px; "orta büyüklük", Shorts'ta 72-80) */
  size?: number;
  /** blok genişliği (px), ortalı */
  width?: number;
  maxLines?: number;
  /** bloğun en çok yüksekliği (px): altındaki/üstündeki başlığa, banda binmesin; uzun grup önce küçülür */
  maxHeight?: number;
  /** top ile: bloğun alt kenarının geçemeyeceği y (px); tek satır top'ta durur, daha yüksek blok yukarı kayar */
  limit?: number;
};

/** Yanan altyazı (Headline, FullFrame, Hook, Outro): en çok 3 kelimelik grup, kelimeler söylendikçe görünür (captionGroups.ts).
 *  top verilirse blok aşağı (limit de verilirse limit'e değince yukarı), bottom verilirse yukarı doğru büyür. */
export const Captions = ({ words, bottom = 300, top, size = 76, width = 940, maxLines = 2, maxHeight, limit }: Props) => {
  const cap = useCaption(words, { width, base: size, maxLines, maxHeight });
  if (!cap) return null;
  const y = top !== undefined && limit !== undefined ? Math.min(top, Math.round(limit - captionHeight(cap.fs, cap.lines))) : top;
  return (
    <div style={{ position: "absolute", left: 0, right: 0, ...(y !== undefined ? { top: y } : { bottom }), display: "flex", justifyContent: "center" }}>
      <div style={{ width }}><CaptionText cap={cap} /></div>
    </div>
  );
};
