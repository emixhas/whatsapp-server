import { useCurrentFrame } from "remotion";
import { BOX, useEnter } from "./common";

export const Genel = () => {
  const frame = useCurrentFrame();
  const s = useEnter(0, 12);
  const swing = frame < 30 ? 14 * Math.sin(frame / 2.5) * Math.exp(-frame / 14) : 0;
  return (
    <svg width={BOX.width} height={BOX.height} viewBox={`0 0 ${BOX.width} ${BOX.height}`}>
      {/* gazete */}
      <g transform={`translate(300 300) scale(${s})`}>
        <rect x={-240} y={-180} width={480} height={360} rx={20} fill="#E8EEFF" />
        <rect x={-200} y={-140} width={300} height={40} rx={8} fill="#0B0F1A" />
        <rect x={-200} y={-70} width={180} height={160} rx={8} fill="#9AA4BF" />
        {[0, 1, 2, 3, 4].map((k) => <rect key={k} x={10} y={-70 + k * 34} width={190} height={14} rx={7} fill="#9AA4BF" />)}
        {[0, 1].map((k) => <rect key={k} x={-200} y={110 + k * 30} width={400} height={14} rx={7} fill="#9AA4BF" />)}
      </g>
      {/* zil */}
      <g transform={`translate(720 230) rotate(${swing})`}>
        <path d="M -80 60 C -80 -40 -50 -90 0 -90 C 50 -90 80 -40 80 60 L 100 90 L -100 90 Z" fill="#FFFFFF" />
        <circle cx={0} cy={110} r={22} fill="#FFFFFF" />
        <circle cx={60} cy={-70} r={26} fill="#E30A17" />
      </g>
    </svg>
  );
};
