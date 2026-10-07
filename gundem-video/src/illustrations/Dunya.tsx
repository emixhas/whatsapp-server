import { useCurrentFrame } from "remotion";
import { BOX, useEnter } from "./common";

const C = "#36D1C4";

export const Dunya = () => {
  const frame = useCurrentFrame();
  const s = useEnter(0, 14);
  const R = 200;
  return (
    <svg width={BOX.width} height={BOX.height} viewBox={`0 0 ${BOX.width} ${BOX.height}`}>
      <g transform={`translate(460 290) scale(${s})`}>
        <circle r={R} fill="#12304A" stroke={C} strokeWidth={8} />
        <clipPath id="globe"><circle r={R} /></clipPath>
        <g clipPath="url(#globe)">
          {/* dönen meridyenler */}
          {[0, 1, 2, 3, 4, 5].map((k) => {
            const ang = ((frame * 1.2 + k * 30) % 180) - 90;
            const rx = Math.abs(Math.cos((ang * Math.PI) / 180)) * R;
            return <ellipse key={k} cx={0} cy={0} rx={Math.max(2, rx)} ry={R} fill="none" stroke={C} strokeWidth={3} opacity={0.5} />;
          })}
          {[-120, -60, 0, 60, 120].map((y) => <line key={y} x1={-R} y1={y} x2={R} y2={y} stroke={C} strokeWidth={3} opacity={0.35} />)}
          {/* kıta lekeleri */}
          {[[-80, -60, 90], [60, -20, 70], [-20, 90, 60]].map(([x, y, r], i) => {
            const px = ((x + frame * 2.4 + R) % (2 * R)) - R;
            return <ellipse key={i} cx={px} cy={y} rx={r} ry={r * 0.6} fill={C} opacity={0.45} />;
          })}
        </g>
        {/* yörünge */}
        <ellipse rx={R + 90} ry={70} fill="none" stroke="#FFFFFF" strokeWidth={3} opacity={0.4} />
        <circle cx={(R + 90) * Math.cos(frame / 12)} cy={70 * Math.sin(frame / 12)} r={14} fill="#FFFFFF" />
      </g>
    </svg>
  );
};
