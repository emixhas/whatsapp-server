import { spring, useCurrentFrame, useVideoConfig } from "remotion";

/** Sahneye girişte 0→1 yay animasyonu; delay kare cinsinden. */
export const useEnter = (delay = 0, damping = 12) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return spring({ frame: frame - delay, fps, config: { damping, stiffness: 110 } });
};

/** Sürekli hafif salınım (-1..1). */
export const useWobble = (speed = 0.08, phase = 0) => Math.sin(useCurrentFrame() * speed + phase);

export const BOX = { width: 920, height: 560 };
