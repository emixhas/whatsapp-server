import { useCurrentFrame } from "remotion";
import { BOX } from "./common";

const C = "#FF5C8A";

export const Saglik = () => {
  const frame = useCurrentFrame();
  // EKG: bir vuruş deseni (ses dosyasıyla uyumlu: ~0.75 sn aralık = 22 kare)
  const beat = "l 40 0 l 14 -40 l 14 80 l 14 -140 l 14 160 l 14 -60 l 40 0";
  const d = `M -400 0 ${Array(6).fill(beat).join(" ")}`;
  const scroll = (frame * 9) % 220;
  const pulse = 1 + 0.12 * Math.max(0, Math.sin((frame % 22) / 22 * Math.PI * 2));
  return (
    <svg width={BOX.width} height={BOX.height} viewBox={`0 0 ${BOX.width} ${BOX.height}`}>
      <g transform={`translate(${-scroll} 340)`}>
        <path d={d} fill="none" stroke={C} strokeWidth={10} strokeLinejoin="round" strokeLinecap="round" />
      </g>
      <rect x={0} y={0} width={120} height={BOX.height} fill="url(#fade)" />
      <defs>
        <linearGradient id="fade" x1="0" x2="1"><stop offset="0" stopColor="#0B0F1A" /><stop offset="1" stopColor="#0B0F1A" stopOpacity="0" /></linearGradient>
      </defs>
      {/* kalp */}
      <g transform={`translate(460 150) scale(${pulse})`}>
        <path d="M 0 60 C -90 -10 -70 -90 0 -40 C 70 -90 90 -10 0 60 Z" fill={C} />
      </g>
    </svg>
  );
};
