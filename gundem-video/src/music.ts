import { Episode } from "./types";

/**
 * Arka plan müziğinin kare kare yüksekliği (kullanıcı isteği, 27 Ekim: "arkalara belgesel, son dakika haber gibileri için çok az duyulacak
 * şekilde müzik ekleyelim"). Konuşma sırasında episode.musicVolume (konuşmanın ~20 dB altı), konuşma aralarında (cümle arası, kelime
 * yokken) episode.musicGapVolume (~6 dB açık). Kısılma hızlı (~0,1 sn: konuşma hep önde), açılma yavaş (~0,6 sn: pompalama yok); 0,35 sn'den
 * kısa kelime araları konuşma sayılır. Konuşma anları segmentlerin kelime zamanlarından (yoksa segmentin tamamı); sesli bölümde müzik
 * zaten susar (GundemVideo runs). Eski bölümlerde (musicGapVolume yok) sabit musicVolume.
 */
export function musicLevels(ep: Episode, fps: number): Float32Array {
  const total = Math.ceil(ep.segments.reduce((a, s) => a + (s.duration || 0), 0) * fps) + fps * 2;
  const speech = ep.musicVolume ?? 0.07;
  const gap = ep.musicGapVolume ?? speech;
  const on = new Uint8Array(total);
  let t = 0;
  for (const s of ep.segments) {
    const start = t;
    t += s.duration || 0;
    if (s.kind === "sesli") continue;
    const words = s.words && s.words.length ? s.words : [{ w: "", s: 0, e: Math.max(0, (s.duration || 0) - 0.15) }];
    for (const w of words) {
      const a = Math.max(0, Math.floor((start + w.s - 0.08) * fps));
      const b = Math.min(total, Math.ceil((start + w.e + 0.12) * fps));
      for (let f = a; f < b; f++) on[f] = 1;
    }
  }
  const close = Math.round(0.35 * fps); // kısa kelime araları: müzik açılıp kapanmasın
  for (let f = 0, last = -1; f < total; f++) {
    if (on[f]) {
      if (last >= 0 && f - last - 1 > 0 && f - last - 1 <= close) for (let k = last + 1; k < f; k++) on[k] = 1;
      last = f;
    }
  }
  const out = new Float32Array(total);
  let v = on[0] ? speech : gap;
  for (let f = 0; f < total; f++) {
    const target = on[f] ? speech : gap;
    v += (target - v) * (target < v ? 0.35 : 0.055);
    out[f] = v;
  }
  return out;
}

/** f. karedeki müzik seviyesi (dizinin dışında son değer). */
export const levelAt = (lv: Float32Array, f: number) => lv[Math.max(0, Math.min(lv.length - 1, Math.round(f)))] ?? 0;
