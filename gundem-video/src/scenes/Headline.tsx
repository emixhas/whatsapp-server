import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { theme } from "../theme";

type Props = { index: number; total: number; title: string; narration: string; source?: string; durationInFrames: number };

export const Headline = ({ index, total, title, narration, source, durationInFrames }: Props) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const slide = spring({ frame, fps, config: { damping: 14, stiffness: 110 } });
  const x = interpolate(slide, [0, 1], [120, 0]);
  const textIn = interpolate(frame, [10, 28], [0, 1], { extrapolateRight: "clamp" });
  const fadeOut = interpolate(frame, [durationInFrames - 10, durationInFrames], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const progress = interpolate(frame, [0, durationInFrames], [0, 1], { extrapolateRight: "clamp" });

  return (
    <AbsoluteFill style={{ fontFamily: theme.font, color: theme.white, padding: "0 80px", justifyContent: "center", opacity: fadeOut }}>
      <div style={{ position: "absolute", top: 120, left: 80, right: 80, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ fontSize: 40, fontWeight: 700, letterSpacing: 6, color: theme.muted }}>GÜNDEM</div>
        <div style={{ fontSize: 40, fontWeight: 700, color: theme.red }}>{index + 1} / {total}</div>
      </div>

      <div style={{ transform: `translateX(${x}px)`, opacity: slide }}>
        <div style={{ fontSize: 200, fontWeight: 900, color: theme.red, lineHeight: 0.9, opacity: 0.9 }}>{String(index + 1).padStart(2, "0")}</div>
        <div style={{ fontSize: 88, fontWeight: 800, lineHeight: 1.1, marginTop: 20, textWrap: "balance" as never }}>{title}</div>
        <div style={{ opacity: textIn, marginTop: 36, fontSize: 48, lineHeight: 1.35, color: theme.muted, background: theme.card, padding: "32px 36px", borderRadius: 24 }}>
          {narration}
        </div>
        {source ? <div style={{ opacity: textIn, marginTop: 24, fontSize: 36, color: theme.muted }}>Kaynak: {source}</div> : null}
      </div>

      <div style={{ position: "absolute", bottom: 140, left: 80, right: 80, height: 10, background: theme.card, borderRadius: 5 }}>
        <div style={{ width: `${progress * 100}%`, height: "100%", background: theme.red, borderRadius: 5 }} />
      </div>
    </AbsoluteFill>
  );
};
