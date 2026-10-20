import { useLayoutEffect, useMemo, useRef } from "react";
import { AbsoluteFill, CalculateMetadataFunction, Easing, continueRender, delayRender, interpolate, random, useCurrentFrame, useVideoConfig } from "remotion";
import { FPS } from "./types";

/**
 * Benzer video sahnesi (kullanıcı isteği, 19 Ekim: "bir video gönderdiğimde o videoyu izleyip kelimelerini çıkartıp o videodaki gibi
 * sıfırdan video üretmesini"): Claude'un çizdiği sahne SVG'si (`prompts/benzer.md`; Python tarafı `scene_svg` ile temizler, kök
 * viewBox 0 0 1080 1920, her çizim adımı `<g class="rN">`; çizim tek dış `<g>` içindeyse gruplar onun içinde) eski kâğıt üzerinde el çizimi gibi canlanır. `scripts/render_scenes.mjs`
 * sahneyi sessiz mp4'e çizer, wa_video bu klibi haber/kanca bölümünün videosu yapar.
 * - Kâğıt: paletin en açık rengi sıcak kremle karıştırılır (koyu palet de kâğıt olur), ince gren + iri lekeler (feTurbulence),
 *   tohumdan gelen kahve lekeleri; doku sekme başına bir kez tuvale basılır ve kamerayla oynamaz (hız ve dosya boyutu için).
 *   Kenarlarda mürekkep rengiyle vinyet.
 * - Çizim: el titremesi süzgeci (feTurbulence + feDisplacementMap; tohum her 5 karede üç değer arasında döner, çizgi "kaynar"),
 *   kâğıda çarpma (multiply) karışımıyla basılmış mürekkep görünümü: açık renk kâğıdı aydınlatamaz, ışık/vurgu koyu zemin üstünde çizilmeli.
 * - Ortaya çıkış: rN grubu sırayla belirir (yarım saniyede soluklaşarak, aşağıdan kayarak, hafif büyüyerek); çizgileri aynı anda
 *   1 saniyede kalemle çiziliyormuş gibi uzar (uzunluk tarayıcıda ölçülür; kendi kesik çizgisi olan grup yalnız soluklaşır).
 *   Gruplar sahnenin ilk %55'ine yayılır (en az 0,25 sn arayla; sahne kısaysa hepsi %80'inden önce gelir).
 * - Kamera: sahne boyunca 1,00 → 1,06 yavaş yakınlaşma (Ken Burns), tohuma göre hafif sağa/sola kayma.
 * Rastgele değer yok (Math.random kullanılmaz): her kare kare numarası ve tohumla belirlenir, render tekrarlanınca aynı çıkar.
 */
export type SvgSceneProps = {
  /** temizlenmiş sahne SVG'si (kök viewBox 0 0 1080 1920, üst düzey gruplar class="r0".."rN") */
  svg: string;
  /** üst düzey grup sayısı (scene_svg döndürür); SVG'de daha çok rN varsa en büyüğü esas alınır */
  count?: number;
  /** sahne süresi, sn (seslendirme kelimesi / 2,4 + 0,8 + 1,5; kancada en az 4): gruplar bu sürenin içinde belirir */
  seconds: number;
  /** çizim bittikten sonra eklenen bekleme, sn (klip = seconds + hold): gerçek seslendirme 2,4 kelime/sn tahmininden yavaşsa
   *  (Chatterbox, "say", uzun açılımlar) FullFrame/MediaBg klibi baştan döndürüp boş kâğıdı göstermesin; kamera ve titreme sürer */
  hold?: number;
  /** sahnenin renkleri (3-5 hex); en açığı kâğıt, en koyusu mürekkep */
  palette?: string[];
  /** titreme, leke ve kamera yönü için sabit tohum (sahne sırası) */
  seed?: number;
};

const REVEAL = 0.5;    // grup başına soluklaşarak gelme süresi, sn
const DRAW = 1.0;      // çizgilerin kalemle uzama süresi, sn (uzunluğundan bağımsız)
const MAX_GROUPS = 32;
const PAPER = "#F2E4C8"; // sıcak krem (kâğıt)
const INK = "#3B2A1E";   // koyu sepya (mürekkep)
const DEFAULT_PALETTE = ["#F1E3C6", "#5B4230", "#A33A2A"];

type Rgb = [number, number, number];
const hexRgb = (h: string): Rgb | null => {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec((h || "").trim());
  if (!m) return null;
  const s = m[1].length === 3 ? m[1].split("").map((c) => c + c).join("") : m[1];
  return [0, 2, 4].map((i) => parseInt(s.slice(i, i + 2), 16)) as Rgb;
};
const rgbHex = (c: Rgb) => "#" + c.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("");
const mix = (a: Rgb, b: Rgb, t: number): Rgb => [0, 1, 2].map((i) => a[i] + (b[i] - a[i]) * t) as Rgb;
const lum = (c: Rgb) => (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255;
const rgba = (c: Rgb, a: number) => `rgba(${c.map(Math.round).join(",")},${a})`;

/** Paletten kâğıt ve mürekkep: sıradan bağımsız (en açık / en koyu); kâğıt her zaman sıcak ve açık, mürekkep her zaman koyu. */
export const paperInk = (palette?: string[]) => {
  const cols = (palette || []).map(hexRgb).filter((c): c is Rgb => !!c);
  const list = cols.length ? cols : DEFAULT_PALETTE.map((h) => hexRgb(h)!);
  const light = list.reduce((a, b) => (lum(b) > lum(a) ? b : a));
  const dark = list.reduce((a, b) => (lum(b) < lum(a) ? b : a));
  const paper = mix(light, hexRgb(PAPER)!, lum(light) >= 0.6 ? 0.35 : lum(light) >= 0.45 ? 0.7 : 0.88); // açık renk yoksa krem, paletten hafif ton
  const ink = lum(dark) > 0.35 ? mix(dark, hexRgb(INK)!, 0.6) : dark;
  return { paper, ink };
};

// dış kaynak getirebilen CSS (scripts/scene_svg.py BAD_VALUE ile aynı; inceleme, 19 Ekim: image-set("http…"), "\75 rl(" kaçışı ve
// kapanmamış "url(http…" iki katmandan da geçip tarayıcıya resim indirtiyordu): düzgün iç başvuru url(#ad) çıkarıldıktan sonra url( kalan,
// ters bölü, image-set, image(, cross-fade, element(, src(, attr( ya da "://" içeren değer atılır
const BAD_VALUE = /javascript:|vbscript:|data:|expression\s*\(|@import|behaviou?r\s*:|-moz-binding|<|>|\\|image-set|image\s*\(|cross-fade|element\s*\(|src\s*\(|attr\s*\(|:\/\//i;
const INNER = /url\(\s*(['"]?)#[^\s'"()\\<>]+\1\s*\)/gi;
const badValue = (v: string) => { const rest = v.replace(INNER, " "); return BAD_VALUE.test(v) || BAD_VALUE.test(rest) || /url\s*\(/i.test(rest); };
// style'da yalnız görünüm özellikleri (scene_svg STYLE_PROPS; background*, mask-image, content, animasyon/geçiş yok)
const STYLE_PROPS = new Set(["fill", "fill-opacity", "fill-rule", "stroke", "stroke-width", "stroke-opacity", "stroke-linecap", "stroke-linejoin",
  "stroke-dasharray", "stroke-dashoffset", "stroke-miterlimit", "opacity", "color", "clip-path", "clip-rule", "mask", "filter", "stop-color",
  "stop-opacity", "flood-color", "flood-opacity", "lighting-color", "font-size", "font-weight", "font-style", "font-family", "font-variant",
  "text-anchor", "dominant-baseline", "letter-spacing", "word-spacing", "text-decoration", "visibility", "display", "paint-order",
  "vector-effect", "mix-blend-mode", "isolation", "transform", "transform-origin", "transform-box", "shape-rendering", "color-interpolation-filters"]);
const cleanDecl = (css: string) => css.split(";").map((d) => {
  const i = d.indexOf(":");
  const k = d.slice(0, i).trim().toLowerCase(), v = d.slice(i + 1).trim();
  return i > 0 && STYLE_PROPS.has(k) && v && v.length <= 200 && !badValue(v) ? `${k}:${v}` : "";
}).filter(Boolean).join(";");
// öznitelik değerinin çözülmüşü (scene_svg yalnız bu beş kaçışı yazar; diğer karakter başvuruları önceden etkisiz kılınır)
const decode = (v: string) => v.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const encode = (v: string) => v.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** SVG içindeki <style> sayfanın tamamına uygulanır: seçiciler `.ss-art` altına alınır (kâğıt katmanını boyamasın), @-kuralları
 *  atılır, bildirimlerde yalnız görünüm özellikleri kalır (CSS animasyonu/geçişi de gider: duvar saatiyle oynar, karelerle değil). */
const scopeCss = (css: string) => {
  let c = css.replace(/<!\[CDATA\[|\]\]>/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  for (let k = 0; k < 3; k++) c = c.replace(/@[\w-]+[^{};]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, "");
  c = c.replace(/@[^;{]*;/g, "");
  return c.replace(/([^{}]+)\{([^{}]*)\}/g, (_, sel: string, body: string) =>
    sel.split(",").map((x) => x.trim()).filter(Boolean).map((x) => `.ss-art ${x.replace(/^(?:html|body|:root)\b\s*/i, "")}`).join(",") + `{${cleanDecl(body)}}`);
};

/** İkinci güvenlik katmanı (asıl temizlik Python'da, aynı kurallar): betik, dış kaynak, olay özniteliği ve saatle oynayan animasyon
 *  tarayıcıya ulaşmasın. Öznitelikler HTML ayrıştırıcısının gördüğü gibi taranır (tırnaksız değer, boşluksuz ya da "/" ile ayrılmış
 *  öznitelik dahil); beş temel kaçış dışındaki karakter başvurusu (&#117;rl(, &lpar;) düz metin olur; kökün style'ı atılır; en sonda
 *  kalan her dış url(, image-set( vb. ve ters bölü etkisiz kılınır. */
export const cleanSvg = (svg: string) => {
  let s = String(svg || "");
  const i = s.search(/<svg[\s>]/i);
  if (i < 0) return "";
  s = s.slice(i);
  const end = s.toLowerCase().lastIndexOf("</svg>");
  if (end >= 0) s = s.slice(0, end + 6);
  s = s.replace(/<!--[\s\S]*?-->/g, "");
  for (const tag of ["script", "foreignObject", "iframe", "image", "feImage", "audio", "video", "object", "embed", "animate", "animateTransform", "animateMotion", "set"]) {
    s = s.replace(new RegExp(`<${tag}\\b[^>]*?/>|<${tag}\\b[\\s\\S]*?</${tag}\\s*>|<${tag}\\b[^>]*>`, "gi"), "");
  }
  s = s.replace(/&(?!(?:amp|lt|gt|quot|#39);)/g, "&amp;");
  s = s.replace(/^(<svg\b)((?:[^>"']|"[^"]*"|'[^']*')*>)/i, (_, a: string, rest: string) =>
    a + rest.replace(/(?<=[\s/"'])style\s*=\s*("[^"]*"|'[^']*'|[^\s>]*)/gi, ""));
  s = s.replace(/(?<=[\s/"'])([^\s/>"'=]+)(\s*=\s*)("[^"]*"|'[^']*'|[^\s>]*)/g, (all: string, name: string, eq: string, raw: string) => {
    const n = name.toLowerCase();
    const v = decode(/^["']/.test(raw) ? raw.slice(1, -1) : raw);
    if (n.startsWith("on") || ["src", "srcset", "xml:base", "action", "formaction", "background", "poster"].includes(n)) return "";
    if (n === "xmlns" || n.startsWith("xmlns:")) return all; // ad alanı bildirimi hiçbir şey indirmez
    if (n === "href" || n.endsWith(":href")) return v.trim().startsWith("#") && !badValue(v) ? all : "";
    if (n === "style") { const c = cleanDecl(v); return c ? `${name}${eq}"${encode(c)}"` : ""; }
    return badValue(v) ? "" : all;
  });
  s = s.replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style\s*>)/gi, (_, a: string, css: string, b: string) => a + scopeCss(css) + b);
  // son ağ: taramadan kaçan her yerde dış url( ve resim işlevleri geçersiz işleve döner, ters bölü (CSS kaçışı) atılır
  s = s.replace(/url\s*\((?!\s*(['"]|&quot;|&#39;)?#[^\s'"()\\<>&]+\1\s*\))/gi, "none(").replace(/(?:-webkit-)?image-set\s*\(|image\s*\(|cross-fade\s*\(|element\s*\(|src\s*\(|attr\s*\(/gi, "none(");
  return s.replace(/\\/g, "");
};

/** SVG'deki en büyük rN + 1 (count eksik ya da yanlış gelirse). */
const groupsIn = (svg: string) => {
  let n = 0;
  for (const m of svg.matchAll(/class\s*=\s*["'][^"']*\br(\d+)\b/g)) n = Math.max(n, Number(m[1]) + 1);
  return n;
};

/** Grupların başlama saniyeleri: sahnenin %55'ine eşit yayılır, en az 0,25 sn arayla; sığmazsa son grup %80'den önce başlar. */
export const revealStarts = (count: number, seconds: number) => {
  if (count <= 0) return [];
  let gap = (0.55 * seconds) / count;
  if (gap < 0.25) gap = count > 1 ? Math.min(0.25, Math.max(0.05, (0.8 * seconds - REVEAL) / (count - 1))) : 0;
  return Array.from({ length: count }, (_, n) => n * gap);
};

const ease = Easing.out(Easing.cubic);
const pen = Easing.inOut(Easing.sin);
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

export const calculateSvgSceneMetadata: CalculateMetadataFunction<SvgSceneProps> = ({ props }) => ({
  durationInFrames: Math.max(1, Math.ceil(((Number(props.seconds) || 4) + Math.max(0, Math.min(30, Number(props.hold) || 0))) * FPS)),
});

/** Kâğıt dokusu SVG'si: zemin rengi, tohumdan lekeler ve kahve halkaları, iri dalgalanma + ince gren (feTurbulence). */
const paperSvg = (paper: Rgb, ink: Rgb, seed: number) => {
  const inkHex = rgbHex(ink);
  let defs = "", body = `<rect width='1080' height='1920' fill='${rgbHex(paper)}'/>`;
  for (let i = 0; i < 6; i++) {
    const x = random(`p${seed}-x${i}`) * 1080, y = random(`p${seed}-y${i}`) * 1920;
    const r = 160 + random(`p${seed}-r${i}`) * 260, a = 0.04 + random(`p${seed}-a${i}`) * 0.06;
    defs += `<radialGradient id='b${i}'><stop offset='0' stop-color='${inkHex}' stop-opacity='${a.toFixed(3)}'/>` +
      `<stop offset='0.45' stop-color='${inkHex}' stop-opacity='${(a / 2).toFixed(3)}'/><stop offset='0.7' stop-color='${inkHex}' stop-opacity='0'/></radialGradient>`;
    body += `<circle cx='${x.toFixed(0)}' cy='${y.toFixed(0)}' r='${r.toFixed(0)}' fill='url(#b${i})'/>`;
  }
  for (let i = 0; i < 2; i++) {
    const x = 120 + random(`k${seed}-x${i}`) * 840, y = 200 + random(`k${seed}-y${i}`) * 1520, r = 70 + random(`k${seed}-r${i}`) * 70;
    body += `<circle cx='${x.toFixed(0)}' cy='${y.toFixed(0)}' r='${r.toFixed(0)}' fill='none' stroke='${inkHex}' stroke-opacity='0.05' stroke-width='5'/>` +
      `<circle cx='${x.toFixed(0)}' cy='${y.toFixed(0)}' r='${(r - 8).toFixed(0)}' fill='none' stroke='${inkHex}' stroke-opacity='0.025' stroke-width='12'/>`;
  }
  const tint = `0 0 0 0 ${(ink[0] / 255).toFixed(3)}  0 0 0 0 ${(ink[1] / 255).toFixed(3)}  0 0 0 0 ${(ink[2] / 255).toFixed(3)}`;
  // iri dalgalanma: eski kâğıdın düzensiz tonu; ince gren: lif dokusu
  defs += `<filter id='m' x='0' y='0' width='100%' height='100%' color-interpolation-filters='sRGB'>` +
    `<feTurbulence type='fractalNoise' baseFrequency='0.0035 0.0028' numOctaves='4' seed='${seed + 3}'/>` +
    `<feColorMatrix type='matrix' values='${tint}  0 0 0 -0.9 0.62'/></filter>` +
    `<filter id='g' x='0' y='0' width='100%' height='100%' color-interpolation-filters='sRGB'>` +
    `<feTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' seed='${seed + 11}' stitchTiles='stitch'/>` +
    `<feColorMatrix type='matrix' values='${tint}  0 0 0 -0.55 0.36'/></filter>`;
  body += `<rect width='1080' height='1920' filter='url(#m)' opacity='0.32'/><rect width='1080' height='1920' filter='url(#g)' opacity='0.55'/>`;
  return `<svg xmlns='http://www.w3.org/2000/svg' width='1080' height='1920' viewBox='0 0 1080 1920'><defs>${defs}</defs>${body}</svg>`;
};

/** Kâğıt: doku sekme başına BİR KEZ tuvale basılır. Satır içi SVG süzgeci her karede yeniden hesaplanıyordu (3 sn'lik boş sahne
 *  20 sn'de çiziliyordu); tuval katmanı değişmez, kamera ile de oynamaz (grenin her karede kayması mp4'ü 6 kat büyütüyordu). */
const Paper = ({ paper, ink, seed }: { paper: Rgb; ink: Rgb; seed: number }) => {
  const ref = useRef<HTMLCanvasElement>(null);
  const src = useMemo(() => "data:image/svg+xml;charset=utf-8," + encodeURIComponent(paperSvg(paper, ink, seed)), [rgbHex(paper), rgbHex(ink), seed]);
  useLayoutEffect(() => {
    const handle = delayRender("SvgScene kâğıt dokusu");
    let done = false;
    const finish = () => { if (!done) { done = true; continueRender(handle); } };
    const img = new Image();
    img.onload = () => {
      const ctx = ref.current?.getContext("2d");
      if (ctx) { ctx.clearRect(0, 0, 1080, 1920); ctx.drawImage(img, 0, 0, 1080, 1920); }
      finish();
    };
    img.onerror = finish; // doku çizilemezse düz kâğıt rengi kalır (zemin AbsoluteFill'de)
    img.src = src;
    return finish;
  }, [src]);
  return <canvas ref={ref} width={1080} height={1920} style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }} />;
};

/** Kalemle çizim için her çizginin gerçek uzunluğu (bir kez ölçülür). Kendi kesik çizgisi olan bir çizgi içeren grup yalnız
 *  soluklaşarak gelir: desenli üst çizgi (yılan pulları) alttaki gövde çizilmeden önce havada asılı görünüyordu. */
const GEOM = "path,line,polyline,polygon,circle,ellipse,rect";
const measureStrokes = (root: HTMLElement | null) => {
  const svg = root?.querySelector(":scope > svg");
  if (!svg) return;
  // rN grupları kökün çocuğu ya da (scene_svg tek dış <g>'nin içine indiyse) o <g>'nin çocuğu: hepsi aranır
  for (const top of Array.from(svg.querySelectorAll("[class]"))) {
    if (!/(^|\s)r\d+(\s|$)/.test(top.getAttribute("class") || "")) continue;
    const els = [...(top.matches(GEOM) ? [top] : []), ...Array.from(top.querySelectorAll(GEOM))] as SVGGeometryElement[];
    const dashed = (el: Element) => { const d = getComputedStyle(el).strokeDasharray; return !!d && d !== "none"; };
    if (els.some(dashed)) continue;
    for (const el of els) {
      if (el.hasAttribute("data-ss-len")) continue;
      let len = Number(el.getAttribute("pathLength")) || 0;
      if (!len) { try { len = el.getTotalLength(); } catch { len = 0; } }
      if (!(len > 0)) continue;
      el.setAttribute("data-ss-len", "");
      el.style.setProperty("--ss-len", `${(len + 2).toFixed(1)}px`);
    }
  }
};

export const SvgScene = ({ svg, count, seconds, palette, seed = 1 }: SvgSceneProps) => {
  const frame = useCurrentFrame();
  const { durationInFrames, fps } = useVideoConfig();
  const t = frame / fps;
  const dur = Math.max(0.5, Number(seconds) || durationInFrames / fps);
  const s = Math.abs(Math.round(Number(seed) || 0)) % 997;
  const { paper, ink } = paperInk(palette);
  const markup = useMemo(() => cleanSvg(svg), [svg]);
  const artRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => measureStrokes(artRef.current), [markup]);
  const n = Math.min(MAX_GROUPS, Math.max(Math.round(Number(count) || 0), groupsIn(markup)));
  const starts = revealStarts(n, dur);

  // grup başına o karenin görünümü: bitmiş grup için kural yazılmaz (SVG'nin kendi hâli kalır)
  const rules: string[] = [];
  starts.forEach((st, i) => {
    const p = ease(clamp01((t - st) / REVEAL));
    const q = pen(clamp01((t - st) / DRAW));
    const g = `.ss-art .r${i}`; // kökün çocuğu olmayabilir (tek dış <g>: ortak kontur/transform); sınıfı yalnız scene_svg'nin grupları taşır
    if (p < 1) {
      rules.push(`${g}{opacity:${p.toFixed(3)};translate:0 ${((1 - p) * 30).toFixed(1)}px;scale:${(0.94 + 0.06 * p).toFixed(4)};` +
        `transform-box:fill-box;transform-origin:50% 60%}`);
    }
    if (q < 1) {
      // kalemle çizim: ölçülen her çizgi (measureStrokes) DRAW süresinde baştan sona uzar
      rules.push(`${g} [data-ss-len],${g}[data-ss-len]{stroke-dasharray:var(--ss-len) var(--ss-len);stroke-dashoffset:calc(var(--ss-len) * ${(1 - q).toFixed(4)})}`);
    }
  });

  // kamera: yavaş yakınlaşma + tohuma göre hafif yatay kayma
  const zoom = interpolate(frame, [0, durationInFrames], [1, 1.06], { extrapolateRight: "clamp" });
  const dx = interpolate(frame, [0, durationInFrames], [0, s % 2 ? 14 : -14], { extrapolateRight: "clamp" });
  // el titremesi: tohum her 5 karede üç değer arasında döner (saniyede 6 kez "kaynayan" çizgi)
  const boil = Math.floor(frame / 5) % 3;
  const wob = `ss-wob-${s}`;

  return (
    <AbsoluteFill style={{ background: rgbHex(paper), overflow: "hidden" }}>
      <style>{`.ss-art > svg{width:100%;height:100%;display:block;overflow:visible}${rules.join("")}`}</style>
      <svg width={0} height={0} style={{ position: "absolute" }} aria-hidden>
        <defs>
          <filter id={wob} x="0" y="0" width="1" height="1" filterUnits="objectBoundingBox" colorInterpolationFilters="sRGB">
            <feTurbulence type="fractalNoise" baseFrequency="0.012 0.014" numOctaves={2} seed={s * 3 + boil} result="n" />
            <feDisplacementMap in="SourceGraphic" in2="n" scale={7} xChannelSelector="R" yChannelSelector="G" />
          </filter>
        </defs>
      </svg>
      <Paper paper={paper} ink={ink} seed={s} />
      <AbsoluteFill style={{ transform: `translateX(${dx}px) scale(${zoom})`, transformOrigin: "50% 45%", willChange: "transform" }}>
        {markup ? (
          <AbsoluteFill ref={artRef} className="ss-art" style={{ filter: `url(#${wob})`, mixBlendMode: "multiply" }}
            dangerouslySetInnerHTML={{ __html: markup }} />
        ) : null}
      </AbsoluteFill>
      {/* vinyet: kenarlar mürekkep rengine koyulaşır (kamera ile oynamaz) */}
      <AbsoluteFill style={{ background: `radial-gradient(ellipse 75% 62% at 50% 46%, ${rgba(ink, 0)} 55%, ${rgba(ink, 0.22)} 82%, ${rgba(ink, 0.5)} 100%)` }} />
    </AbsoluteFill>
  );
};
