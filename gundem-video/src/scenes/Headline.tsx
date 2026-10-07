import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { styleFor } from "../categories";
import { theme } from "../theme";

type Props = { index: number; total: number; title: string; narration: string; source?: string; category?: string; durationInFrames: number };

export const Headline = ({ index, total, title, narration, source, category, durationInFrames }: Props) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const st = styleFor(category);
  const slide = spring({ frame, fps, config: { damping: 14, stiffness: 110 } });
  const x = interpolate(slide, [0, 1], [120, 0]);
  const textIn = interpolate(frame, [10, 28], [0, 1], { extrapolateRight: "clamp" });
  const fadeOut = interpolate(frame, [durationInFrames - 8, durationInFrames], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const progress = interpolate(frame, [0, durationInFrames], [0, 1], { extrapolateRight: "clamp" });
  const illuIn = spring({ frame, fps, config: { damping: 16, stiffness: 90 } });

  return (
    <AbsoluteFill style={{ fontFamily: theme.font, color: theme.white, opacity: fadeOut }}>
      {/* üst şerit */}
      <div style={{ position: "absolute", top: 110, left: 80, right: 80, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ fontSize: 38, fontWeight: 800, letterSpacing: 6, color: st.accent, background: `${st.accent}22`, padding: "10px 26px", borderRadius: 14 }}>{st.label}</div>
        <div style={{ fontSize: 40, fontWeight: 700, color: theme.muted }}>{index + 1} / {total}</div>
      </div>

      {/* animasyonlu illüstrasyon alanı */}
      <div style={{ position: "absolute", top: 220, left: 80, width: 920, height: 560, borderRadius: 32, background: theme.card, overflow: "hidden", transform: `scale(${0.9 + 0.1 * illuIn})`, opacity: illuIn }}>
        <st.Illustration />
      </div>

      {/* metin bloğu */}
      <div style={{ position: "absolute", top: 830, left: 80, right: 80, transform: `translateX(${x}px)`, opacity: slide }}>
        <div style={{ display: "flex", alignItems: "flex-end", gap: 28 }}>
          <div style={{ fontSize: 150, fontWeight: 900, color: st.accent, lineHeight: 0.85 }}>{String(index + 1).padStart(2, "0")}</div>
          <div style={{ fontSize: 76, fontWeight: 800, lineHeight: 1.08, paddingBottom: 6 }}>{title}</div>
        </div>
        <div style={{ opacity: textIn, marginTop: 36, fontSize: 46, lineHeight: 1.35, color: "#D7DDEE", background: theme.card, padding: "30px 36px", borderRadius: 24, borderLeft: `10px solid ${st.accent}` }}>
          {narration}
        </div>
        {source ? <div style={{ opacity: textIn, marginTop: 22, fontSize: 34, color: theme.muted }}>Kaynak: {source}</div> : null}
      </div>

      <div style={{ position: "absolute", bottom: 130, left: 80, right: 80, height: 10, background: theme.card, borderRadius: 5 }}>
        <div style={{ width: `${progress * 100}%`, height: "100%", background: st.accent, borderRadius: 5 }} />
      </div>
    </AbsoluteFill>
  );
};
