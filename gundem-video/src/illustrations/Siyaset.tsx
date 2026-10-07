import { interpolate, useCurrentFrame } from "remotion";
import { BOX, useEnter } from "./common";

const C = "#E30A17";

export const Siyaset = () => {
  const frame = useCurrentFrame();
  const pod = useEnter(0, 14);
  // tokmak: iki vuruş (ses dosyasıyla aynı zamanlama: 0 ve ~0.22 sn)
  const hit = (start: number) => interpolate(frame, [start, start + 4, start + 10], [-35, 0, -35], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const angle = frame < 10 ? hit(2) : hit(9);
  return (
    <svg width={BOX.width} height={BOX.height} viewBox={`0 0 ${BOX.width} ${BOX.height}`}>
      {/* kürsü */}
      <g transform={`translate(460 560) scale(${pod}) translate(-460 -560)`}>
        <rect x={300} y={330} width={320} height={230} rx={18} fill="#1E2A4A" />
        <rect x={270} y={300} width={380} height={44} rx={12} fill="#2E3F6B" />
        {[0, 1].map((k) => (
          <g key={k}>
            <rect x={400 + k * 90} y={200} width={14} height={110} fill="#9AA4BF" />
            <ellipse cx={407 + k * 90} cy={190} rx={26} ry={34} fill="#9AA4BF" />
          </g>
        ))}
      </g>
      {/* tokmak */}
      <g transform={`translate(760 250) rotate(${angle})`}>
        <rect x={-14} y={0} width={28} height={190} rx={10} fill="#C98A4B" />
        <rect x={-90} y={-70} width={180} height={90} rx={22} fill={C} />
      </g>
      <rect x={640} y={450} width={260} height={28} rx={8} fill="#2E3F6B" />
      {/* bayrak şeridi */}
      <path d={`M 40 80 Q 120 ${40 + 20 * Math.sin(frame / 7)} 200 80 T 360 80`} fill="none" stroke={C} strokeWidth={22} strokeLinecap="round" />
    </svg>
  );
};
