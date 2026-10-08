import { useCurrentFrame } from "remotion";
import { BOX, useEnter } from "./common";

const BLUE = "#3D7BFF";
const RED = "#E30A17";

/** Asayiş: dönen polis tepe lambası + "POLİS" şeridi. Siren sesiyle (sfx/siren.wav) aynı tempoda yanıp söner. */
export const Asayis = () => {
  const frame = useCurrentFrame();
  const pop = useEnter(0, 13);
  const phase = (frame % 24) / 24; // 0.8 sn'de bir tam dönüş
  const left = Math.max(0, Math.cos(phase * Math.PI * 2));
  const right = Math.max(0, -Math.cos(phase * Math.PI * 2));
  return (
    <svg width={BOX.width} height={BOX.height} viewBox={`0 0 ${BOX.width} ${BOX.height}`}>
      {/* ışık huzmeleri */}
      <polygon points="460,250 40,60 40,440" fill={RED} opacity={0.22 * left} />
      <polygon points="460,250 880,60 880,440" fill={BLUE} opacity={0.22 * right} />
      <g transform={`translate(460 300) scale(${pop}) translate(-460 -300)`}>
        {/* tepe lambası gövdesi */}
        <rect x={330} y={330} width={260} height={40} rx={10} fill="#1E2A4A" />
        <rect x={350} y={190} width={110} height={140} rx={18} fill={RED} opacity={0.55 + 0.45 * left} />
        <rect x={460} y={190} width={110} height={140} rx={18} fill={BLUE} opacity={0.55 + 0.45 * right} />
        <rect x={350} y={190} width={220} height={140} rx={18} fill="none" stroke="#FFFFFF" strokeWidth={6} opacity={0.5} />
        <rect x={340} y={170} width={240} height={30} rx={10} fill="#2E3F6B" />
      </g>
      {/* polis şeridi */}
      <g transform={`translate(0 ${6 * Math.sin(frame / 9)}) rotate(-3 460 460)`}>
        <rect x={20} y={430} width={880} height={56} rx={8} fill="#FFFFFF" />
        {Array.from({ length: 9 }, (_, i) => (
          <rect key={i} x={40 + i * 100} y={430} width={50} height={56} fill={BLUE} opacity={0.9} />
        ))}
        <text x={460} y={472} textAnchor="middle" fontFamily="Inter, Arial" fontWeight={900} fontSize={34} fill="#0B0F1A" letterSpacing={6}>POLİS</text>
      </g>
    </svg>
  );
};
