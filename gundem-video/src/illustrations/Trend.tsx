import { interpolate, useCurrentFrame } from "remotion";
import { BOX, useEnter } from "./common";

const C = "#FF2D55";

/** Viral / çok izlenen sosyal medya videosu (kullanıcı isteği, 19 Ekim: "sosyal medyada çok izlenen videolar son dakika diye
 *  üretilmesin"): oynatılan telefon, hızla artan izlenme sayacı, telefondan yükselen kalpler, sağda yükselen grafik ve ucunda alev.
 *  sfx/trend.wav'daki iki "pop" sayaç ve ilk kalple aynı anda. */
export const Trend = () => {
  const frame = useCurrentFrame();
  const pop = useEnter(0, 12);
  const pulse = 1 + 0.06 * Math.sin(frame / 5);
  const count = Math.round(interpolate(frame, [4, 70], [0, 1250000], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: (t) => 1 - (1 - t) ** 3 }));
  const label = count >= 1e6 ? `${(count / 1e6).toFixed(1).replace(".", ",")} Mn` : count >= 1e3 ? `${Math.round(count / 1e3)} B` : String(count);
  const draw = interpolate(frame, [8, 50], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const pts = [[600, 470], [650, 430], [690, 446], [740, 360], [780, 380], [830, 250], [870, 170]];
  const len = pts.slice(1).reduce((a, p, i) => a + Math.hypot(p[0] - pts[i][0], p[1] - pts[i][1]), 0);
  const tip = pts[pts.length - 1];
  return (
    <svg width={BOX.width} height={BOX.height} viewBox={`0 0 ${BOX.width} ${BOX.height}`}>
      <defs>
        <linearGradient id="trend-screen" x1="0" x2="1" y1="0" y2="1">
          <stop offset="0" stopColor={C} stopOpacity="0.85" />
          <stop offset="1" stopColor="#7C1BFF" stopOpacity="0.85" />
        </linearGradient>
      </defs>
      {/* yükselen grafik + alev */}
      <polyline points={pts.map((p) => p.join(",")).join(" ")} fill="none" stroke={C} strokeWidth={14} strokeLinecap="round" strokeLinejoin="round"
        strokeDasharray={len} strokeDashoffset={len * (1 - draw)} />
      <g transform={`translate(${tip[0]} ${tip[1] - 6}) scale(${draw * (1 + 0.12 * Math.sin(frame / 3))})`} opacity={draw}>
        <path d="M0,-58 C26,-30 34,-6 22,18 C14,34 -14,34 -22,18 C-32,-2 -16,-16 -10,-34 C-4,-20 4,-18 0,-58 Z" fill="#FFB020" />
        <path d="M0,-22 C12,-8 14,4 8,16 C4,24 -8,24 -10,16 C-14,6 -6,-4 0,-22 Z" fill="#FFF3B0" />
      </g>
      {/* telefon */}
      <g transform={`translate(400 280) scale(${pop}) translate(-400 -280)`}>
        <rect x={280} y={40} width={240} height={470} rx={36} fill="#1E2A4A" stroke="#9AA4BF" strokeWidth={6} />
        <rect x={298} y={78} width={204} height={380} rx={18} fill="url(#trend-screen)" />
        <rect x={370} y={56} width={60} height={10} rx={5} fill="#0B0F1A" />
        <g transform={`translate(400 268) scale(${pulse})`}>
          <circle r={58} fill="#FFFFFF" opacity={0.92} />
          <polygon points="-18,-30 -18,30 34,0" fill={C} />
        </g>
        {/* izlenme sayacı */}
        <g transform="translate(400 420)">
          <rect x={-92} y={-26} width={184} height={50} rx={25} fill="#0B0F1A" opacity={0.75} />
          <ellipse cx={-62} cy={0} rx={18} ry={11} fill="none" stroke="#FFFFFF" strokeWidth={4} />
          <circle cx={-62} cy={0} r={5} fill="#FFFFFF" />
          <text x={18} y={11} textAnchor="middle" fontFamily="Inter, Arial" fontWeight={900} fontSize={30} fill="#FFFFFF">{label}</text>
        </g>
      </g>
      {/* telefondan yükselen kalpler */}
      {Array.from({ length: 7 }, (_, k) => {
        const t = ((frame - 6 - k * 9) % 60) / 60;
        if (frame < 6 + k * 9 || t < 0) return null;
        const x = 470 + 40 * Math.sin(k * 1.7 + t * 5) + k * 6;
        const y = 380 - t * 330;
        const s = 0.6 + 0.5 * Math.sin(Math.PI * Math.min(1, t * 1.4));
        return (
          <path key={k} transform={`translate(${x} ${y}) scale(${s})`} opacity={1 - t}
            d="M0,10 C-18,-4 -26,-14 -20,-24 C-14,-34 -2,-30 0,-20 C2,-30 14,-34 20,-24 C26,-14 18,-4 0,10 Z" fill={k % 3 === 2 ? "#FFFFFF" : C} />
        );
      })}
    </svg>
  );
};
