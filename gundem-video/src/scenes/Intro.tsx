import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { theme } from "../theme";

type Props = { dateLabel: string; episodeOfDay: number; timeLabel: string };

export const Intro = ({ dateLabel, episodeOfDay, timeLabel }: Props) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const pop = spring({ frame, fps, config: { damping: 12, stiffness: 120 } });
  const line = interpolate(frame, [8, 30], [0, 1], { extrapolateRight: "clamp" });
  const sub = interpolate(frame, [18, 36], [0, 1], { extrapolateRight: "clamp" });

  return (
    <AbsoluteFill style={{ justifyContent: "center", alignItems: "center", fontFamily: theme.font, color: theme.white }}>
      <div style={{ transform: `scale(${pop})`, textAlign: "center" }}>
        <div style={{ fontSize: 56, letterSpacing: 14, color: theme.muted, fontWeight: 600 }}>TÜRKİYE</div>
        <div style={{ fontSize: 150, fontWeight: 900, lineHeight: 1, marginTop: 10 }}>GÜNDEMİ</div>
      </div>
      <div style={{ width: 520 * line, height: 8, background: theme.red, marginTop: 40, borderRadius: 4 }} />
      <div style={{ opacity: sub, marginTop: 40, textAlign: "center" }}>
        <div style={{ fontSize: 48, fontWeight: 700 }}>{dateLabel} · {timeLabel}</div>
        <div style={{ fontSize: 40, color: theme.muted, marginTop: 12 }}>Günün {episodeOfDay}. özeti</div>
      </div>
    </AbsoluteFill>
  );
};
