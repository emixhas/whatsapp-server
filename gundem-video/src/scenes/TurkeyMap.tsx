import { interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";

/**
 * Kodla çizilmiş Türkiye haritası, Türk bayrağı deseniyle dolu (dış dosya yok).
 * Kıyı çizgisi enlem/boylam noktalarından üretilir, Catmull-Rom ile yumuşatılır.
 * Animasyon: dış çizgi çizilir → kırmızı dolgu açılır → ay ve yıldız yaylanarak gelir →
 * üzerinde sürekli ışık süpürmesi ve hafif salınım.
 */

// [boylam, enlem] — saat yönünde, Trakya'nın kuzeybatısından başlar
const OUTLINE: [number, number][] = [
  [26.35, 41.72], [27.3, 42.05], [28.05, 41.98], [28.6, 41.55], [29.1, 41.22], [29.9, 41.15],
  [30.9, 41.1], [31.8, 41.45], [32.4, 41.78], [33.4, 42.0], [34.2, 41.95], [35.1, 42.05],
  [35.6, 41.65], [36.3, 41.3], [37.0, 41.1], [37.9, 41.0], [38.9, 40.95], [39.7, 41.0],
  [40.5, 41.05], [41.5, 41.52], [42.5, 41.45], [43.45, 41.1], [43.75, 40.6], [44.3, 40.05],
  [44.8, 39.65], [44.45, 39.2], [44.2, 38.4], [44.5, 37.8], [44.2, 37.1], [43.3, 37.15],
  [42.4, 37.1], [41.3, 37.05], [40.3, 36.85], [39.0, 36.7], [38.0, 36.75], [37.1, 36.65],
  [36.6, 36.55], [36.3, 36.0], [36.05, 35.8], [35.85, 36.15], [36.1, 36.55], [35.6, 36.55],
  [34.9, 36.75], [34.0, 36.4], [33.4, 36.15], [32.8, 36.0], [32.0, 36.5], [31.0, 36.85],
  [30.5, 36.65], [29.6, 36.2], [29.0, 36.65], [28.3, 36.75], [27.35, 36.7], [27.5, 36.95],
  [27.3, 37.5], [27.2, 37.95], [26.85, 38.3], [26.3, 38.35], [26.8, 38.75], [26.65, 39.25],
  [26.95, 39.6], [26.1, 39.5], [26.3, 40.05], [26.6, 40.45], [26.1, 40.65], [26.3, 41.2],
];

// Marmara Denizi (iç su, boşluk olarak kesilir)
const MARMARA: [number, number][] = [
  [26.85, 40.55], [27.6, 40.5], [28.5, 40.45], [29.3, 40.5], [29.9, 40.7], [29.4, 40.85],
  [28.6, 41.0], [27.7, 40.95], [27.0, 40.75],
];

const project = ([lon, lat]: [number, number]): [number, number] => [(lon - 25.8) * 52, (42.3 - lat) * 66];

/** Kapalı Catmull-Rom eğrisi → SVG path */
function smoothPath(src: [number, number][]): string {
  const p = src.map(project);
  const n = p.length;
  let d = `M ${p[0][0].toFixed(1)} ${p[0][1].toFixed(1)}`;
  for (let i = 0; i < n; i++) {
    const p0 = p[(i - 1 + n) % n], p1 = p[i], p2 = p[(i + 1) % n], p3 = p[(i + 2) % n];
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += ` C ${c1[0].toFixed(1)} ${c1[1].toFixed(1)}, ${c2[0].toFixed(1)} ${c2[1].toFixed(1)}, ${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`;
  }
  return d + " Z";
}

const MAP_PATH = smoothPath(OUTLINE) + " " + smoothPath(MARMARA);
export const MAP_W = 1000;
export const MAP_H = 440;

const starPoints = (cx: number, cy: number, r: number) => {
  const pts: string[] = [];
  for (let i = 0; i < 10; i++) {
    const rad = i % 2 === 0 ? r : r * 0.382;
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    pts.push(`${(cx + rad * Math.cos(a)).toFixed(1)},${(cy + rad * Math.sin(a)).toFixed(1)}`);
  }
  return pts.join(" ");
};

export const TurkeyMap = ({ width = 940, delay = 0 }: { width?: number; delay?: number }) => {
  const frame = Math.max(0, useCurrentFrame() - delay);
  const { fps } = useVideoConfig();
  const draw = interpolate(frame, [0, 42], [0, 1], { extrapolateRight: "clamp" });
  const fill = interpolate(frame, [18, 48], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const scaleIn = spring({ frame, fps, config: { damping: 14, stiffness: 90 }, from: 0.86, to: 1 });
  const moon = spring({ frame: frame - 30, fps, config: { damping: 11, stiffness: 120 } });
  const star = spring({ frame: frame - 40, fps, config: { damping: 9, stiffness: 140 } });
  const strokeFade = interpolate(frame, [48, 70], [1, 0.35], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  // ışık süpürmesi: haritanın üzerinden 3 saniyede bir geçer
  const sweep = ((frame % 90) / 90) * 1.6 - 0.3;
  const floatY = Math.sin(frame / 22) * 6;
  const scale = width / MAP_W;
  // Ay-yıldız: bayraktaki gibi haritanın batı-orta kısmında
  const cx = 360, cy = 215, R = 92;
  return (
    <div style={{ width, height: MAP_H * scale, transform: `translateY(${floatY}px) scale(${scaleIn})`, filter: "drop-shadow(0 0 28px rgba(227,10,23,0.55)) drop-shadow(0 18px 30px rgba(0,0,0,0.6))" }}>
      <svg width={width} height={MAP_H * scale} viewBox={`0 0 ${MAP_W} ${MAP_H}`}>
        <defs>
          <clipPath id="tr-clip"><path d={MAP_PATH} clipRule="evenodd" /></clipPath>
          <linearGradient id="tr-red" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#F2192A" />
            <stop offset="0.55" stopColor="#E30A17" />
            <stop offset="1" stopColor="#A40711" />
          </linearGradient>
          <linearGradient id="tr-shine" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stopColor="#fff" stopOpacity="0" />
            <stop offset="0.5" stopColor="#fff" stopOpacity="0.34" />
            <stop offset="1" stopColor="#fff" stopOpacity="0" />
          </linearGradient>
          <radialGradient id="tr-vignette" cx="0.5" cy="0.5" r="0.7">
            <stop offset="0" stopColor="#fff" stopOpacity="0.12" />
            <stop offset="1" stopColor="#000" stopOpacity="0.25" />
          </radialGradient>
        </defs>
        <g clipPath="url(#tr-clip)" opacity={fill}>
          <rect width={MAP_W} height={MAP_H} fill="url(#tr-red)" />
          <rect width={MAP_W} height={MAP_H} fill="url(#tr-vignette)" />
          {/* ince doku: yatay bayrak kumaşı çizgileri */}
          {Array.from({ length: 22 }, (_, i) => (
            <rect key={i} x={0} y={i * 20} width={MAP_W} height={1.2} fill="#fff" opacity={0.05} />
          ))}
          {/* ay: beyaz daire + kırmızı daire kesiti */}
          <g transform={`translate(${cx} ${cy}) scale(${moon}) translate(${-cx} ${-cy})`}>
            <circle cx={cx} cy={cy} r={R} fill="#fff" />
            <circle cx={cx + R * 0.27} cy={cy} r={R * 0.8} fill="url(#tr-red)" />
          </g>
          <g transform={`translate(${cx + R * 1.05} ${cy}) scale(${star}) rotate(${interpolate(star, [0, 1], [-90, 0])}) translate(${-(cx + R * 1.05)} ${-cy})`}>
            <polygon points={starPoints(cx + R * 1.05, cy, R * 0.44)} fill="#fff" />
          </g>
          {/* ışık süpürmesi */}
          <rect x={sweep * MAP_W} y={-80} width={260} height={MAP_H + 160} fill="url(#tr-shine)" transform={`skewX(-18)`} />
        </g>
        {/* dış çizgi: önce çizilir, sonra sönükleşir */}
        <path d={MAP_PATH} fill="none" stroke="#fff" strokeWidth={5} strokeLinejoin="round" pathLength={1} strokeDasharray={1} strokeDashoffset={1 - draw} opacity={strokeFade} />
      </svg>
    </div>
  );
};
