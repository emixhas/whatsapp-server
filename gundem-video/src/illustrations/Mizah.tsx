import { useCurrentFrame } from "remotion";
import { BOX, useEnter } from "./common";

const C = "#C6FF00";

/** Mizah videosu (kullanıcı isteği, 19 Ekim: "link/mizah yazınca mizah kategorisine göre üretilsin ama direk mizah yazmasın, girişte
 *  izlenmez"): yazı yok; yay gibi zıplayan, göz kırpan gülen yüz, etrafında konfeti ve dönen yıldızlar. sfx/mizah.wav'daki yay sesiyle
 *  ilk zıplama aynı anda. */
export const Mizah = () => {
  const frame = useCurrentFrame();
  const pop = useEnter(0, 9);
  const P = 30;
  const p = frame % P;
  const hop = Math.abs(Math.sin((Math.PI * p) / P)) * 46;                 // zıplama
  const squash = p < 3 || p > P - 3 ? 1.12 : 1;                          // yere değince yayvanlaşır
  const wink = (frame % 45) > 36 ? 0.15 : 1;                             // sağ göz kırpar
  const tilt = 7 * Math.sin(frame / 8);
  return (
    <svg width={BOX.width} height={BOX.height} viewBox={`0 0 ${BOX.width} ${BOX.height}`}>
      {/* konfeti */}
      {Array.from({ length: 22 }, (_, k) => {
        const t = ((frame * 0.012 + k * 0.047) % 1);
        const x = 80 + ((k * 97) % 760) + 18 * Math.sin(frame / 10 + k);
        const y = -20 + t * 600;
        const colors = [C, "#FF2D55", "#36D1C4", "#FFB020", "#FFFFFF"];
        return <rect key={k} x={x} y={y} width={14} height={7} rx={2} fill={colors[k % colors.length]} transform={`rotate(${frame * 6 + k * 40} ${x + 7} ${y + 3})`} opacity={0.85} />;
      })}
      {/* dönen yıldızlar */}
      {[[230, 150, 1], [690, 130, -1], [720, 400, 1], [200, 410, -1]].map(([x, y, d], i) => (
        <g key={i} transform={`translate(${x} ${y}) rotate(${frame * 4 * d}) scale(${0.8 + 0.25 * Math.sin(frame / 6 + i)})`}>
          <polygon points="0,-26 7,-8 26,-8 11,4 17,24 0,12 -17,24 -11,4 -26,-8 -7,-8" fill={i % 2 ? "#FFFFFF" : C} />
        </g>
      ))}
      {/* gölge */}
      <ellipse cx={460} cy={518} rx={120 - hop} ry={16} fill="#000000" opacity={0.3} />
      {/* yüz */}
      <g transform={`translate(460 ${300 - hop}) rotate(${tilt}) scale(${pop * squash} ${pop / squash})`}>
        <circle r={150} fill={C} />
        <circle r={150} fill="none" stroke="#0B0F1A" strokeWidth={8} opacity={0.25} />
        <ellipse cx={-52} cy={-40} rx={18} ry={26} fill="#0B0F1A" />
        <ellipse cx={52} cy={-40} rx={18} ry={26 * wink} fill="#0B0F1A" />
        <path d="M-88,20 Q0,120 88,20 Q0,70 -88,20 Z" fill="#0B0F1A" />
        <path d="M-50,58 Q0,92 50,58 Q0,74 -50,58 Z" fill="#FF2D55" />
        <circle cx={-96} cy={18} r={18} fill="#FF2D55" opacity={0.35} />
        <circle cx={96} cy={18} r={18} fill="#FF2D55" opacity={0.35} />
      </g>
    </svg>
  );
};
