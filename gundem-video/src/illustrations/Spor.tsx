import { interpolate, useCurrentFrame } from "remotion";
import { BOX } from "./common";

export const Spor = () => {
  const frame = useCurrentFrame();
  const t = Math.min(frame, 70) / 70;
  const x = interpolate(t, [0, 1], [120, 800]);
  const y = 470 - 380 * Math.sin(Math.PI * t) ;
  const rot = frame * 9;
  const squash = frame < 3 || (frame > 67 && frame < 73) ? 0.8 : 1;
  return (
    <svg width={BOX.width} height={BOX.height} viewBox={`0 0 ${BOX.width} ${BOX.height}`}>
      <rect x={40} y={500} width={840} height={16} rx={8} fill="#2ECC71" opacity={0.6} />
      {/* kale */}
      <path d="M 760 500 V 300 H 900 V 500" fill="none" stroke="#FFFFFF" strokeWidth={10} />
      {[0, 1, 2, 3].map((k) => <line key={k} x1={760 + k * 40} y1={300} x2={760 + k * 40} y2={500} stroke="#FFFFFF" strokeWidth={2} opacity={0.4} />)}
      {/* iz */}
      <path d={`M 120 470 Q 460 ${470 - 760} 800 470`} fill="none" stroke="#2ECC71" strokeWidth={6} strokeDasharray="14 18" opacity={0.5} />
      {/* top */}
      <g transform={`translate(${x} ${y}) rotate(${rot}) scale(1 ${squash})`}>
        <circle r={54} fill="#FFFFFF" />
        {[0, 72, 144, 216, 288].map((a) => (
          <polygon key={a} points="0,-22 20,-7 12,18 -12,18 -20,-7" fill="#0B0F1A"
            transform={`rotate(${a}) translate(0 -30) scale(0.7)`} />
        ))}
      </g>
    </svg>
  );
};
