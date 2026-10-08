import { AbsoluteFill, Img, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { styleFor } from "../categories";
import { theme } from "../theme";
import { Captions } from "./Captions";

type Props = { title: string; narration: string; category?: string; breaking?: boolean; image?: string; words?: { w: string; s: number; e: number }[]; durationInFrames: number };

/** KANCA: ilk 3 saniye. Dev yazı, kırmızı flaş, varsa tam ekran fotoğraf, kelime kelime altyazı. */
export const Hook = ({ title, narration, category, breaking, image, words, durationInFrames }: Props) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const st = styleFor(category);
  const flash = interpolate(frame, [0, 2, 12], [0.9, 0.9, 0], { extrapolateRight: "clamp" });
  const pop = spring({ frame, fps, config: { damping: 9, stiffness: 180 } });
  const zoom = 1.06 + interpolate(frame, [0, durationInFrames], [0, 0.1]);
  const shake = frame < 8 ? Math.sin(frame * 3.1) * (8 - frame) * 1.2 : 0;
  const fadeOut = interpolate(frame, [durationInFrames - 6, durationInFrames], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const accent = breaking ? theme.red : st.accent;
  return (
    <AbsoluteFill style={{ fontFamily: theme.font, color: theme.white, opacity: fadeOut, transform: `translate(${shake}px,0)` }}>
      {image ? (
        <>
          <Img src={staticFile(image)} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", transform: `scale(${zoom})` }} />
          <AbsoluteFill style={{ background: "linear-gradient(180deg, rgba(7,10,18,.35) 0%, rgba(7,10,18,.55) 50%, rgba(7,10,18,.95) 100%)" }} />
        </>
      ) : (
        <AbsoluteFill style={{ background: `radial-gradient(circle at 50% 35%, ${accent}33 0%, ${theme.bg} 65%)` }} />
      )}
      <AbsoluteFill style={{ background: accent, opacity: flash }} />
      {/* üst etiket */}
      <div style={{ position: "absolute", top: 120, left: 80, display: "flex", gap: 14, alignItems: "center" }}>
        <div style={{ width: 18, height: 18, borderRadius: 9, background: accent, opacity: 0.6 + 0.4 * Math.abs(Math.sin(frame / 4)) }} />
        <div style={{ fontSize: 36, fontWeight: 800, letterSpacing: 8, color: accent }}>{breaking ? "SON DAKİKA" : st.label}</div>
      </div>
      {/* dev başlık */}
      <div style={{ position: "absolute", left: 70, right: 70, top: 560, transform: `scale(${0.85 + 0.15 * pop})`, transformOrigin: "left center" }}>
        <div lang="tr" style={{ fontSize: title.length > 14 ? 150 : 190, fontWeight: 900, lineHeight: 0.95, textTransform: "uppercase", textShadow: "0 10px 40px rgba(0,0,0,.8)", textWrap: "balance" as never }}>{title}</div>
        <div style={{ marginTop: 30, width: 240 * pop, height: 14, background: accent, borderRadius: 7 }} />
      </div>
      <Captions words={words} accent={accent} bottom={500} size={64} />
    </AbsoluteFill>
  );
};
