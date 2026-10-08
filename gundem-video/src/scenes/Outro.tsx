import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { theme } from "../theme";

import { Captions } from "./Captions";

export const Outro = ({ words }: { words?: { w: string; s: number; e: number }[] }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const pop = spring({ frame, fps, config: { damping: 12 } });
  const sub = interpolate(frame, [12, 30], [0, 1], { extrapolateRight: "clamp" });
  return (
    <AbsoluteFill style={{ justifyContent: "center", alignItems: "center", fontFamily: theme.font, color: theme.white, textAlign: "center" }}>
      <div style={{ transform: `scale(${pop})`, fontSize: 96, fontWeight: 900, lineHeight: 1.1 }}>5 saat sonra<br />yeni özet</div>
      <div style={{ opacity: sub, marginTop: 40, fontSize: 48, color: theme.muted }}>Abone ol · Takipte kal</div>
      <Captions words={words} accent={theme.red} bottom={520} size={54} />
    </AbsoluteFill>
  );
};
