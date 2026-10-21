// Yanan altyazı zamanlaması (kullanıcı kararı, 20 Ekim: "alt yazıları 3'er kelime halinde"; 21 Ekim: "kelimeler önceden gelsin,
// sadece renklensin"; her zaman: "sesle kesinlikle eşit"). Kelimeler en çok GROUP kelimelik gruplara bölünür; kelime sonundaki
// noktalama (. , ! ? ; : …) ve iki kelime arasında GAP sn'den uzun duraklama grubu erken kapatır (yan cümle iki gruba taşmaz,
// duraklamadan sonra yeni grup başlar). Grubun BÜTÜN kelimeleri önceden gelir: grup ilk kelimesinden en çok EARLY sn önce (önceki
// grup kalkmadan değil) bütün olarak belirir; her kelime tam söylendiği anda renklenir (söylenmemiş kelime siyah/sarı kontürlü, söylenen
// sarı dolgulu kalır); grup son kelimesi bittikten LINGER sn sonra ya da sonraki grup gelince kalkar. Daha uzun duraklamada ekran boş
// kalır. Kelimenin renklendiği an s − LEAD (scripts/caption_qa.py bunu ölçer).
export type Word = { w: string; s: number; e: number };
export const GROUP = 3;
const GAP = 0.6; // kelimeler arasında bundan uzun duraklama grubu kapatır (sn)
const EARLY = 0.5; // grup ilk kelimesinden en çok bu kadar önce gelir (sn)

let LEAD = 0.06; // altyazı sesten bu kadar önde (panel Ayarlar → altyazı kaydırma; episode.captionLead)
export const setCaptionLead = (v?: number) => { if (typeof v === "number" && Number.isFinite(v)) LEAD = v; };
const LINGER = 0.18; // grubun son kelimesi bittikten sonra ekranda kalma süresi (kısa boşluklarda yanıp sönmesin)

// kelime sonu noktalaması; ardından kapanan tırnak/parantez gelebilir ("geldi." , geldi.", (açıklandı),)
const CLOSE = /[.,!?;:…]["'”’»)\]]*$/;

/** start..end (end hariç) kelime indeksleri; from: grubun bütün kelimeleriyle ekrana geldiği an (ilk kelimeden en çok EARLY sn önce,
 *  önceki grup kalkmadan değil); at: her kelimenin renklendiği söyleniş anı (kendisinin ve gruptaki öncekilerin en geç başlangıcı:
 *  zaman sırası bozuk gelse de kelimeler soldan sağa renklenir, arada renksiz kelime kalmaz); until: grubun kalkacağı an. */
export type Group = { start: number; end: number; from: number; at: number[]; until: number };

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
      // en çok EARLY sn erken, önceki grup kalkmadan değil; ama kendi ilk kelimesi söylenince her durumda (önceki grup
      // hâlâ LINGER'daysa onu iter)
      const prev = out[out.length - 1];
      const from = Math.min(at[0], Math.max(at[0] - EARLY, prev ? prev.until : -Infinity));
      out.push({ start, end: i + 1, from, at, until: until + LINGER });
      start = i + 1;
    }
  }
  cache.set(words, out);
  return out;
}

/** t (sn, segment başından) anında ekrandaki grup: { key, words, ages } ya da null. Grubun bütün kelimeleri görünür;
 *  ages[k] < 0 → kelime henüz söylenmedi (siyah dolgu, sarı kontür); ≥ 0 → kaç sn önce renklendi (sarı dolgu; kısa büyüme
 *  animasyonu için). key: grubun ilk kelimesinin indeksi. */
export function currentGroup(words: Word[] | undefined, t: number): { key: number; words: Word[]; ages: number[] } | null {
  if (!words?.length) return null;
  const tt = t + LEAD;
  let g: Group | null = null;
  for (const x of captionGroups(words)) {
    if (x.from <= tt) g = x;
    else break;
  }
  if (!g || tt > g.until) return null;
  return { key: g.start, words: words.slice(g.start, g.end), ages: g.at.map((a) => tt - a) };
}
