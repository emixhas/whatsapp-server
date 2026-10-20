// Yanan altyazı zamanlaması (kullanıcı kararı, 20 Ekim: "alt yazıları 3'er kelime halinde"; her zaman: "sesle kesinlikle eşit").
// Kelimeler en çok GROUP kelimelik gruplara bölünür; kelime sonundaki noktalama (. , ! ? ; : …) ve iki kelime arasında GAP sn'den
// uzun duraklama grubu erken kapatır (yan cümle iki gruba taşmaz, duraklamadan sonra yeni grup başlar). Grup ilk kelimesi
// söylendiğinde belirir ve baştan bütün olarak dizilir (söylenmemiş kelime görünmez ama yerini tutar, yazı kaymaz); her kelime
// tam söylendiği anda görünür olur; grup son kelimesi bittikten LINGER sn sonra ya da sonraki grup başlayınca kalkar. Daha uzun
// duraklamada ekran boş kalır. Kelimenin görünür olduğu an s − LEAD (scripts/caption_qa.py bunu ölçer).
export type Word = { w: string; s: number; e: number };
export const GROUP = 3;
const GAP = 0.6; // kelimeler arasında bundan uzun duraklama grubu kapatır (sn)

let LEAD = 0.06; // altyazı sesten bu kadar önde (panel Ayarlar → altyazı kaydırma; episode.captionLead)
export const setCaptionLead = (v?: number) => { if (typeof v === "number" && Number.isFinite(v)) LEAD = v; };
const LINGER = 0.18; // grubun son kelimesi bittikten sonra ekranda kalma süresi (kısa boşluklarda yanıp sönmesin)

// kelime sonu noktalaması; ardından kapanan tırnak/parantez gelebilir ("geldi." , geldi.", (açıklandı),)
const CLOSE = /[.,!?;:…]["'”’»)\]]*$/;

/** start..end (end hariç) kelime indeksleri; at: her kelimenin görünür olduğu söyleniş anı (kendisinin ve gruptaki öncekilerin en
 *  geç başlangıcı: zaman sırası bozuk gelse de kelimeler soldan sağa açılır, arada boşluk kalmaz); until: grubun kalkacağı an. */
export type Group = { start: number; end: number; at: number[]; until: number };

const cache = new WeakMap<Word[], Group[]>();

/** Kelimelerin grupları (aynı words dizisi için bir kez hesaplanır). */
export function captionGroups(words: Word[]): Group[] {
  const hit = cache.get(words);
  if (hit) return hit;
  const out: Group[] = [];
  let start = 0;
  for (let i = 0; i < words.length; i++) {
    const last = i === words.length - 1;
    if (last || i - start + 1 >= GROUP || CLOSE.test(words[i].w) || words[i + 1].s - words[i].e > GAP) {
      const at: number[] = [];
      let m = -Infinity, until = -Infinity;
      for (let k = start; k <= i; k++) {
        m = Math.max(m, words[k].s);
        at.push(m);
        until = Math.max(until, words[k].s, words[k].e);
      }
      out.push({ start, end: i + 1, at, until: until + LINGER });
      start = i + 1;
    }
  }
  cache.set(words, out);
  return out;
}

/** t (sn, segment başından) anında ekrandaki grup: { key, words, ages } ya da null. ages[k] < 0 → kelime henüz söylenmedi
 *  (görünmez, yeri ayrılır); ≥ 0 → kaç sn önce görünür oldu (büyüme animasyonu için). key: grubun ilk kelimesinin indeksi. */
export function currentGroup(words: Word[] | undefined, t: number): { key: number; words: Word[]; ages: number[] } | null {
  if (!words?.length) return null;
  const tt = t + LEAD;
  let g: Group | null = null;
  for (const x of captionGroups(words)) {
    if (x.at[0] <= tt) g = x;
    else break;
  }
  if (!g || tt > g.until) return null;
  return { key: g.start, words: words.slice(g.start, g.end), ages: g.at.map((a) => tt - a) };
}
