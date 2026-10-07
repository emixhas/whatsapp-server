import { useCurrentFrame } from "remotion";
import { BOX, useEnter } from "./common";

const nodes = [[120, 120], [340, 80], [560, 160], [800, 100], [200, 320], [460, 300], [700, 340], [360, 480], [640, 480]];
const edges = [[0, 1], [1, 2], [2, 3], [0, 4], [1, 5], [2, 5], [3, 6], [4, 7], [5, 7], [5, 8], [6, 8]];
const C = "#8E7CFF";

export const Teknoloji = () => {
  const frame = useCurrentFrame();
  return (
    <svg width={BOX.width} height={BOX.height} viewBox={`0 0 ${BOX.width} ${BOX.height}`}>
      {edges.map(([a, b], i) => {
        const on = frame > 6 + i * 3;
        return <line key={i} x1={nodes[a][0]} y1={nodes[a][1]} x2={nodes[b][0]} y2={nodes[b][1]} stroke={C} strokeWidth={6} opacity={on ? 0.8 : 0.15} />;
      })}
      {nodes.map(([x, y], i) => {
        const s = useEnter(i * 3, 10);
        const pulse = 1 + 0.15 * Math.sin((frame - i * 5) / 4);
        return (
          <g key={i} transform={`translate(${x} ${y}) scale(${s * pulse})`}>
            <circle r={30} fill={C} opacity={0.25} />
            <circle r={16} fill={C} />
          </g>
        );
      })}
      {/* dolaşan veri paketi */}
      {(() => {
        const e = edges[Math.floor(frame / 12) % edges.length];
        const t = (frame % 12) / 12;
        const x = nodes[e[0]][0] + (nodes[e[1]][0] - nodes[e[0]][0]) * t;
        const y = nodes[e[0]][1] + (nodes[e[1]][1] - nodes[e[0]][1]) * t;
        return <circle cx={x} cy={y} r={12} fill="#FFFFFF" />;
      })()}
    </svg>
  );
};
