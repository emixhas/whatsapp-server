import { useCurrentFrame } from "remotion";
import { BOX, useEnter } from "./common";

const buildings = [
  { x: 40, w: 120, h: 260 }, { x: 180, w: 90, h: 380 }, { x: 290, w: 150, h: 300 },
  { x: 460, w: 110, h: 440 }, { x: 590, w: 130, h: 340 }, { x: 740, w: 140, h: 400 },
];

export const Toplum = () => {
  const frame = useCurrentFrame();
  return (
    <svg width={BOX.width} height={BOX.height} viewBox={`0 0 ${BOX.width} ${BOX.height}`}>
      {buildings.map((b, i) => {
        const s = useEnter(i * 4, 15);
        const cols = Math.floor(b.w / 30), rows = Math.floor(b.h / 40);
        return (
          <g key={i} transform={`translate(${b.x} 540) scale(1 ${s}) translate(0 -540)`}>
            <rect x={0} y={540 - b.h} width={b.w} height={b.h} rx={6} fill="#1E2A4A" />
            {Array.from({ length: cols * rows }).map((_, k) => {
              const c = k % cols, r = Math.floor(k / cols);
              const lit = ((k * 7 + i * 13) % 11) < 5 && frame > 20 + ((k * 5) % 40);
              return <rect key={k} x={8 + c * 30} y={548 - b.h + r * 40} width={16} height={22} rx={3} fill={lit ? "#FF8A3D" : "#0B0F1A"} />;
            })}
          </g>
        );
      })}
      <rect x={0} y={540} width={BOX.width} height={14} fill="#2E3F6B" />
      {/* araba */}
      <g transform={`translate(${((frame * 6) % 1100) - 120} 520)`}>
        <rect x={0} y={-30} width={90} height={30} rx={10} fill="#FF8A3D" />
        <circle cx={18} cy={2} r={10} fill="#0B0F1A" /><circle cx={72} cy={2} r={10} fill="#0B0F1A" />
      </g>
    </svg>
  );
};
