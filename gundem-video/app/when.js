// Mesajdaki yayın saatini çözer (kullanıcı isteği: "haber linki gönderdiğimde saatini de yazayım, bunu şu saatte paylaş;
// saat yazmazsam direkt paylaşsın"). Türkçe ifadeler: "18:30'da", "18.30", "saat 6'da", "akşam 8'de", "sabah 9", "öğlen 12",
// "gece 1", "yarın 10:00", "yarın sabah 9", "20 dakika sonra", "2 saat sonra", "yarım saat sonra".
// Gün belirtilmeyen saat geçmişte kaldıysa yarına; dönemsiz "saat 8" bugünün en yakın geleceği (08:00 ya da 20:00) sayılır.
// Dönüş: { at: Date | null, rest: saat ifadesi çıkarılmış metin, label: "bugün 18:30" }.

const DAY = 86400000;
const pad = (n) => String(n).padStart(2, "0");

export function whenLabel(at, now = new Date()) {
  const d0 = new Date(now); d0.setHours(0, 0, 0, 0);
  const diff = Math.floor((new Date(at).setHours(0, 0, 0, 0) - d0) / DAY);
  const day = diff === 0 ? "bugün" : diff === 1 ? "yarın" : new Date(at).toLocaleDateString("tr-TR", { day: "numeric", month: "long" });
  return `${day} ${pad(new Date(at).getHours())}:${pad(new Date(at).getMinutes())}`;
}

export function parseWhen(text, now = new Date()) {
  let t = String(text || "");
  const low = t.toLocaleLowerCase("tr-TR");
  const cut = (m) => { t = (t.slice(0, m.index) + " " + t.slice(m.index + m[0].length)).replace(/\s+/g, " ").trim(); };
  // göreli: "20 dakika sonra", "2 saat sonra", "yarım saat sonra", "bir saat sonra"
  let m = low.match(/(\d{1,3}|bir|yarım)\s*(dakika|dk|saat)\s*sonra(?:\s*(?:paylaş|yayınla|at|gönder)\w*)?/);
  if (m) {
    const n = m[1] === "bir" ? 1 : m[1] === "yarım" ? 0.5 : Number(m[1]);
    const ms = (m[2] === "saat" ? 3600000 : 60000) * n;
    if (ms > 0 && ms <= 7 * DAY) { cut(m); const at = new Date(now.getTime() + ms); return { at, rest: t, label: whenLabel(at, now) }; }
  }
  const dayM = low.match(/(?:^|\s)(yarın|bugün)(?=\s|$)/);
  const dayOff = dayM?.[1] === "yarın" ? 1 : 0;
  // dönem + saat, "saat X", ya da HH:MM / HH.MM
  const per = "(sabah|öğle(?:n|den sonra)?|akşam|gece|ikindi)";
  const sfx = "(?:\\s?['’]?(?:[ıiuü]?n?(?:da|de|ta|te))(?=\\s|$|[.,!?]))?";
  const re = new RegExp(
    `(?:${per}\\s*(?:saat\\s*)?(\\d{1,2})(?:[:.](\\d{2}))?|saat\\s*(\\d{1,2})(?:[:.](\\d{2}))?|(?<![\\d.,])(\\d{1,2})[:.](\\d{2})(?![\\d.,]))${sfx}`);
  m = low.match(re);
  if (!m) return { at: null, rest: t, label: "" };
  const period = m[1] || "";
  let h = Number(m[2] ?? m[4] ?? m[6]);
  const min = Number(m[3] ?? m[5] ?? m[7] ?? 0);
  if (!(h >= 0 && h <= 24 && min >= 0 && min <= 59)) return { at: null, rest: t, label: "" };
  if (h === 24) h = 0;
  const explicitColon = m[6] !== undefined;
  // "12.50" fiyat da olabilir: dönemsiz/"saat"siz noktalı saat yalnız ek ("12.50'de") ya da yayın fiili varsa saat sayılır
  if (explicitColon && !m[0].includes(":") && !/(da|de|ta|te)$/.test(m[0].trim()) && !/(paylaş|yayınla|yayımla|gönder|planla|(^|\s)at(\s|$))/.test(low))
    return { at: null, rest: t, label: "" };
  if (period.startsWith("öğleden") || period === "akşam" || period === "ikindi") { if (h < 12) h += 12; }
  else if (period.startsWith("öğle")) { if (h < 6) h += 12; }
  else if (period === "gece") { if (h >= 7 && h < 12) h += 12; }
  cut(m);
  if (dayM) t = t.replace(new RegExp(`(^|\\s)${dayM[1]}(?=\\s|$)`, "i"), " ").replace(/\s+/g, " ").trim();
  const base = new Date(now); base.setSeconds(0, 0);
  const at = new Date(base); at.setDate(at.getDate() + dayOff); at.setHours(h, min, 0, 0);
  if (!period && !explicitColon && !dayM && h >= 1 && h <= 12) {
    // dönemsiz "saat 8": bugünün en yakın gelecekteki 08:00 ya da 20:00'ı
    const a = new Date(at), b = new Date(at); b.setHours(h === 12 ? 12 : h + 12);
    const cands = [a, b].filter((x) => x > now).sort((x, y) => x - y);
    const pick = cands[0] || (() => { const n = new Date(a); n.setDate(n.getDate() + 1); return n; })();
    return { at: pick, rest: t, label: whenLabel(pick, now) };
  }
  if (period === "gece" && h < 6 && !dayM && at <= now) at.setDate(at.getDate() + 1);  // "gece 1" → bu gece
  if (!dayM && at <= now) at.setDate(at.getDate() + 1);  // geçmişte kalan saat: yarın
  return { at, rest: t, label: whenLabel(at, now) };
}
