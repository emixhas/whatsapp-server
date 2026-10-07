import { interpolate, useCurrentFrame } from "remotion";
import { BOX, useEnter } from "./common";

const C = "#FFB020";

/** Okul binası, sallanan zil ve yanıp sönen uyarı üçgeni. */
export const Egitim = () => {
  const frame = useCurrentFrame();
  const s = useEnter(0, 14);
  const swing = 16 * Math.sin(frame / 2.4) * Math.exp(-((frame % 60)) / 30);
  const warn = interpolate(frame % 24, [0, 6, 12, 24], [0.2, 1, 1, 0.2]);
  const shake = frame > 20 && frame < 32 ? Math.sin(frame * 3) * 4 : 0;
  return (
    <svg width={BOX.width} height={BOX.height} viewBox={`0 0 ${BOX.width} ${BOX.height}`}>
      <g transform={`translate(${shake} 0)`}>
        {/* okul */}
        <g transform={`translate(400 540) scale(${s}) translate(-400 -540)`}>
          <rect x={120} y={260} width={560} height={280} rx={12} fill="#1E2A4A" />
          <polygon points="400,150 80,270 720,270" fill="#2E3F6B" />
          <rect x={360} y={420} width={80} height={120} rx={8} fill={C} />
          {[0, 1, 2, 3].map((k) => <rect key={k} x={160 + k * 140} y={300} width={70} height={80} rx={6} fill="#4FC3F7" opacity={0.8} />)}
          {/* bayrak direği */}
          <rect x={740} y={240} width={8} height={300} fill="#9AA4BF" />
          <path d={`M 748 250 Q 790 ${240 + 10 * Math.sin(frame / 5)} 830 250 L 830 300 Q 790 ${290 + 10 * Math.sin(frame / 5 + 1)} 748 300 Z`} fill="#E30A17" />
        </g>
        {/* zil */}
        <g transform={`translate(400 110) rotate(${swing})`}>
          <path d="M -46 36 C -46 -22 -28 -52 0 -52 C 28 -52 46 -22 46 36 L 58 54 L -58 54 Z" fill={C} />
          <circle cx={0} cy={66} r={14} fill={C} />
        </g>
        {/* uyarı üçgeni */}
        <g transform="translate(800 120)" opacity={warn}>
          <polygon points="0,-70 72,56 -72,56" fill={C} />
          <rect x={-9} y={-30} width={18} height={50} rx={6} fill="#0B0F1A" />
          <circle cx={0} cy={36} r={10} fill="#0B0F1A" />
        </g>
      </g>
    </svg>
  );
};
