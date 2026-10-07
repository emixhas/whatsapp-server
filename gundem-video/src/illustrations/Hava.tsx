import { useCurrentFrame } from "remotion";
import { BOX, useEnter, useWobble } from "./common";

export const Hava = () => {
  const frame = useCurrentFrame();
  const s = useEnter(0, 12);
  const drift = useWobble(0.05) * 14;
  return (
    <svg width={BOX.width} height={BOX.height} viewBox={`0 0 ${BOX.width} ${BOX.height}`}>
      {/* güneş */}
      <g transform={`translate(700 160) rotate(${frame * 0.6})`}>
        {Array.from({ length: 12 }).map((_, k) => <rect key={k} x={-6} y={-130} width={12} height={40} rx={6} fill="#F2B705" transform={`rotate(${k * 30})`} />)}
        <circle r={70} fill="#F2B705" />
      </g>
      {/* bulut */}
      <g transform={`translate(${360 + drift} 230) scale(${s})`}>
        <ellipse cx={0} cy={0} rx={220} ry={110} fill="#E8EEFF" />
        <circle cx={-110} cy={-30} r={100} fill="#E8EEFF" />
        <circle cx={40} cy={-70} r={120} fill="#E8EEFF" />
        <circle cx={160} cy={-20} r={90} fill="#E8EEFF" />
      </g>
      {/* yağmur */}
      {Array.from({ length: 14 }).map((_, k) => {
        const speed = 11 + (k % 4);
        const y = 330 + ((frame * speed + k * 37) % 230);
        const x = 180 + k * 32 + ((k % 3) - 1) * 10;
        const op = 1 - (y - 330) / 230;
        return <rect key={k} x={x} y={y} width={8} height={34} rx={4} fill="#4FC3F7" opacity={op} />;
      })}
    </svg>
  );
};
