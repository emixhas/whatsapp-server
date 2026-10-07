import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { theme } from "../theme";

export const Background = () => {
  const frame = useCurrentFrame();
  const drift = interpolate(frame, [0, 900], [0, -120]);
  return (
    <AbsoluteFill style={{ background: `linear-gradient(180deg, ${theme.bg} 0%, ${theme.bgAccent} 100%)` }}>
      <div
        style={{
          position: "absolute",
          width: 1400,
          height: 1400,
          borderRadius: "50%",
          left: -500,
          top: 300 + drift,
          background: `radial-gradient(circle, ${theme.red}33 0%, transparent 60%)`,
        }}
      />
      <div
        style={{
          position: "absolute",
          width: 1000,
          height: 1000,
          borderRadius: "50%",
          right: -400,
          top: -200 - drift / 2,
          background: `radial-gradient(circle, #2E4B9A44 0%, transparent 60%)`,
        }}
      />
    </AbsoluteFill>
  );
};
