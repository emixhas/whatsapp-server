// Yanan altyazı grupları (kullanıcı isteği: "alt yazıları uzun tutma, üç kelime üç kelime ekleyerek devam et").
// Kelimeler en çok GROUP kelimelik gruplara bölünür; noktalama (. , ! ? ; :) grubu erken kapatır ki cümle/yan cümle iki
// gruba taşmasın. Ekranda yalnız konuşulan grup görünür; gruptaki kelimeler söylendikçe tek tek eklenir.
export type Word = { w: string; s: number; e: number };
export const GROUP = 3;

const cache = new WeakMap<Word[], number[]>();

/** Her kelimenin grup başlangıç indeksi. */
function starts(words: Word[]): number[] {
  const hit = cache.get(words);
  if (hit) return hit;
  const out: number[] = [];
  let start = 0;
  words.forEach((w, i) => {
    out.push(start);
    if (i - start + 1 >= GROUP || /[.,!?;:…]$/.test(w.w)) start = i + 1;
  });
  cache.set(words, out);
  return out;
}

/** t anında konuşulan kelime ve onun grubu: duraklamada son söylenen kelime ekranda kalır (başa dönmez). */
export function currentGroup(words: Word[], t: number): { idx: number; start: number; end: number } {
  let idx = 0;
  for (let i = 0; i < words.length; i++) {
    if (words[i].s <= t) idx = i;
    else break;
  }
  const st = starts(words);
  const start = st[idx];
  let end = idx + 1;
  while (end < words.length && st[end] === start) end++;
  return { idx, start, end };
}
