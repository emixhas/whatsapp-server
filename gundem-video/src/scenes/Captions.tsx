import { useCurrentFrame, useVideoConfig } from "remotion";
import { theme } from "../theme";

type Word = { w: string; s: number; e: number };
const WINDOW = 4; // ekranda aynı anda görünen kelime sayısı

/** Yanan altyazı: konuşulan kelime vurgulanır, 4 kelimelik pencere kayar. */
export const Captions = ({ words, accent, bottom = 300, size = 60 }: { words?: Word[]; accent: string; bottom?: number; size?: number }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  if (!words || !words.length) return null;
  const t = frame / fps;
  let idx = words.findIndex((w) => t >= w.s && t < w.e);
  if (idx < 0) idx = t >= words[words.length - 1].e ? words.length - 1 : 0;
  const start = Math.floor(idx / WINDOW) * WINDOW;
  const slice = words.slice(start, start + WINDOW);
  return (
    <div style={{ position: "absolute", left: 60, right: 60, bottom, display: "flex", flexWrap: "wrap", justifyContent: "center", gap: "0 18px", fontFamily: theme.font, lineHeight: 1.15 }}>
      {slice.map((w, i) => {
        const gi = start + i;
        const active = gi === idx;
        const done = gi < idx;
        return (
          <span key={gi} lang="tr" style={{
            fontSize: size, fontWeight: 900, color: active ? "#0B0F1A" : done ? theme.white : "rgba(255,255,255,0.55)",
            background: active ? accent : "transparent", padding: active ? "2px 14px" : "2px 0", borderRadius: 14,
            transform: active ? "scale(1.08)" : "scale(1)", transition: "transform .05s",
            textShadow: active ? "none" : "0 2px 12px rgba(0,0,0,.8)", textTransform: "uppercase", letterSpacing: 1,
          }}>{w.w}</span>
        );
      })}
    </div>
  );
};
