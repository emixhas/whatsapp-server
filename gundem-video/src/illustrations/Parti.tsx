import { interpolate, useCurrentFrame } from "remotion";
import { BOX, useEnter } from "./common";

const LEFT = "#9AA4BF", RIGHT = "#E30A17";

/** Parti değişimi / transfer: silüet sol kürsüden sağ kürsüye yürür. Parti renkleri kullanılmaz. */
export const Parti = () => {
  const frame = useCurrentFrame();
  const podL = useEnter(0, 14), podR = useEnter(6, 14);
  const walk = interpolate(frame, [14, 60], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const x = 230 + walk * 460;
  const step = Math.sin(frame / 2.2) * (walk > 0 && walk < 1 ? 1 : 0);
  const arrow = interpolate(frame, [10, 40], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const glow = interpolate(frame, [58, 66, 90], [0, 1, 0.5], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return (
    <svg width={BOX.width} height={BOX.height} viewBox={`0 0 ${BOX.width} ${BOX.height}`}>
      {/* sağ kürsü parlaması */}
      <circle cx={700} cy={300} r={260} fill={RIGHT} opacity={glow * 0.25} />
      {/* kürsüler */}
      <g transform={`translate(180 520) scale(${podL}) translate(-180 -520)`}>
        <rect x={60} y={360} width={240} height={160} rx={16} fill={LEFT} opacity={0.5} />
        <rect x={40} y={340} width={280} height={36} rx={10} fill={LEFT} />
      </g>
      <g transform={`translate(740 520) scale(${podR}) translate(-740 -520)`}>
        <rect x={620} y={360} width={240} height={160} rx={16} fill={RIGHT} opacity={0.6} />
        <rect x={600} y={340} width={280} height={36} rx={10} fill={RIGHT} />
      </g>
      {/* ok */}
      <g opacity={arrow}>
        <path d={`M 300 170 Q 460 60 ${300 + 300 * arrow} ${170 - 0 * arrow}`} fill="none" stroke="#FFFFFF" strokeWidth={10} strokeDasharray="22 16" strokeLinecap="round" />
        <polygon points="0,-22 36,0 0,22" fill="#FFFFFF" transform={`translate(${300 + 300 * arrow} 170)`} />
      </g>
      {/* yürüyen silüet */}
      <g transform={`translate(${x} 330)`}>
        <circle cx={0} cy={-120} r={38} fill="#FFFFFF" />
        <rect x={-34} y={-78} width={68} height={120} rx={22} fill="#FFFFFF" />
        <rect x={-44} y={-70} width={18} height={90} rx={9} fill="#FFFFFF" transform={`rotate(${-18 * step} -35 -70)`} />
        <rect x={26} y={-70} width={18} height={90} rx={9} fill="#FFFFFF" transform={`rotate(${18 * step} 35 -70)`} />
        <rect x={-28} y={40} width={22} height={90} rx={10} fill="#FFFFFF" transform={`rotate(${22 * step} -17 40)`} />
        <rect x={6} y={40} width={22} height={90} rx={10} fill="#FFFFFF" transform={`rotate(${-22 * step} 17 40)`} />
        {/* rozet: renk geçişi */}
        <circle cx={0} cy={-40} r={14} fill={walk < 0.5 ? LEFT : RIGHT} />
      </g>
      {/* konfeti (varışta) */}
      {Array.from({ length: 16 }).map((_, k) => {
        const t = Math.max(0, frame - 58 - (k % 4) * 2);
        const px = 700 + Math.sin(k * 1.7) * 160;
        const py = 120 + t * (6 + (k % 3) * 2) + Math.sin(t / 3 + k) * 8;
        return <rect key={k} x={px} y={py} width={12} height={20} rx={3} fill={k % 2 ? RIGHT : "#FFFFFF"} opacity={t > 0 && py < 560 ? 0.9 : 0} transform={`rotate(${t * 9 + k * 20} ${px} ${py})`} />;
      })}
    </svg>
  );
};
