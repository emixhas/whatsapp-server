// Yanan altyazı zamanlaması (kullanıcı kararı: "kelimeler tek ve büyük, tek tek gitsin, sesle kesinlikle eşit").
// Ekranda yalnız o an söylenen kelime görünür: kelime başladığında belirir, bitince (en çok LINGER sn sonra) kalkar;
// sonraki kelime daha erken başlarsa hemen onunla değişir. Duraklamada ekran boş kalır (söylenmeyen kelime gösterilmez).
export type Word = { w: string; s: number; e: number };

let LEAD = 0.06; // altyazı sesten bu kadar önde (panel Ayarlar → altyazı kaydırma; episode.captionLead)
export const setCaptionLead = (v?: number) => { if (typeof v === "number" && Number.isFinite(v)) LEAD = v; };
const LINGER = 0.18; // kelime bittikten sonra ekranda kalma süresi (kısa boşluklarda yanıp sönmesin)

/** t (sn, segment başından) anında gösterilecek kelime: { idx, word, age } ya da null. */
export function currentWord(words: Word[] | undefined, t: number): { idx: number; word: Word; age: number } | null {
  if (!words?.length) return null;
  const tt = t + LEAD;
  let idx = -1;
  for (let i = 0; i < words.length; i++) {
    if (words[i].s <= tt) idx = i;
    else break;
  }
  if (idx < 0) return null;
  const w = words[idx];
  if (tt > w.e + LINGER) return null;
  return { idx, word: w, age: tt - w.s };
}
