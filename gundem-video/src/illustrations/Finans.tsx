import { interpolate, useCurrentFrame } from "remotion";
import { BOX, useEnter, useWobble } from "./common";

const C = "#F2B705";

export const Finans = () => {
  const frame = useCurrentFrame();
  const chart = useEnter(6, 16);
  const pts = [40, 120, 90, 200, 170, 260, 320, 300, 420];
  const path = pts.map((y, i) => `${i === 0 ? "M" : "L"} ${80 + i * 100} ${480 - y}`).join(" ");
  const len = 1100;
  return (
    <svg width={BOX.width} height={BOX.height} viewBox={`0 0 ${BOX.width} ${BOX.height}`}>
      {/* grafik çizgisi */}
      <path d={path} fill="none" stroke={C} strokeWidth={14} strokeLinecap="round" strokeLinejoin="round"
        strokeDasharray={len} strokeDashoffset={len * (1 - chart)} />
      {/* yükselen paralar */}
      {[0, 1, 2, 3, 4].map((k) => {
        const s = useEnter(10 + k * 6);
        const bob = useWobble(0.1, k) * 6;
        const x = 120 + k * 180;
        const y = 470 - k * 55 + bob;
        return (
          <g key={k} transform={`translate(${x} ${y}) scale(${s})`}>
            <ellipse cx={0} cy={0} rx={48} ry={48} fill={C} />
            <ellipse cx={0} cy={0} rx={34} ry={34} fill="none" stroke="#0B0F1A" strokeWidth={5} />
            <text x={0} y={14} textAnchor="middle" fontSize={40} fontWeight={900} fill="#0B0F1A" fontFamily="Arial">₺</text>
          </g>
        );
      })}
      {/* kasa darbesi: kısa parlama */}
      <circle cx={860} cy={70} r={40} fill={C} opacity={interpolate(frame, [4, 10, 24], [0, 0.9, 0], { extrapolateRight: "clamp" })} />
    </svg>
  );
};
