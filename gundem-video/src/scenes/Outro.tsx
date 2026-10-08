import { AbsoluteFill, Audio, Sequence, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { theme } from "../theme";
import { Captions } from "./Captions";
import { TurkeyMap } from "./TurkeyMap";

type Word = { w: string; s: number; e: number };

/** Platform simgeleri: kodla çizilir, dış dosya yok. */
const YouTubeIcon = ({ size }: { size: number }) => (
  <svg width={size} height={size} viewBox="0 0 100 100">
    <rect x="6" y="22" width="88" height="56" rx="18" fill="#FF0000" />
    <polygon points="42,38 42,62 64,50" fill="#fff" />
  </svg>
);
const InstagramIcon = ({ size }: { size: number }) => (
  <svg width={size} height={size} viewBox="0 0 100 100">
    <defs>
      <linearGradient id="ig" x1="0" y1="1" x2="1" y2="0">
        <stop offset="0" stopColor="#F9CE34" /><stop offset="0.5" stopColor="#EE2A7B" /><stop offset="1" stopColor="#6228D7" />
      </linearGradient>
    </defs>
    <rect x="12" y="12" width="76" height="76" rx="22" fill="url(#ig)" />
    <circle cx="50" cy="50" r="17" fill="none" stroke="#fff" strokeWidth="7" />
    <circle cx="71" cy="29" r="5" fill="#fff" />
  </svg>
);
const TikTokIcon = ({ size }: { size: number }) => {
  const note = "M54 14 h12 c1 10 8 17 18 18 v12 c-7 0 -13 -2 -18 -6 v30 a21 21 0 1 1 -21 -21 h3 v12 h-3 a9 9 0 1 0 9 9 z";
  return (
    <svg width={size} height={size} viewBox="0 0 100 100">
      <rect x="6" y="6" width="88" height="88" rx="22" fill="#000" />
      <path d={note} fill="#25F4EE" transform="translate(-3 -3)" />
      <path d={note} fill="#FE2C55" transform="translate(3 3)" />
      <path d={note} fill="#fff" />
    </svg>
  );
};

const PLATFORMS = [
  { key: "youtube", label: "ABONE OL", name: "YouTube", Icon: YouTubeIcon, accent: "#FF0000" },
  { key: "instagram", label: "TAKİP ET", name: "Instagram", Icon: InstagramIcon, accent: "#EE2A7B" },
  { key: "tiktok", label: "TAKİP ET", name: "TikTok", Icon: TikTokIcon, accent: "#25F4EE" },
];

const Platform = ({ p, delay }: { p: (typeof PLATFORMS)[number]; delay: number }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const f = frame - delay;
  const inS = spring({ frame: f, fps, config: { damping: 10, stiffness: 150 } });
  // dokunma vuruşu: 1,5 sn'de bir hafif büyüme + halka dalgası
  const beat = f > 25 ? (f - 25) % 45 : -1;
  const pulse = beat >= 0 ? 1 + 0.06 * Math.max(0, Math.sin((Math.min(beat, 12) / 12) * Math.PI)) : 1;
  const ring = beat >= 0 ? interpolate(beat, [0, 30], [0, 1], { extrapolateRight: "clamp" }) : 0;
  const { Icon } = p;
  return (
    <div style={{ position: "relative", display: "flex", flexDirection: "column", alignItems: "center", gap: 14, opacity: Math.min(1, inS * 1.4), transform: `translateY(${(1 - inS) * 60}px) scale(${pulse})` }}>
      {ring > 0 ? <div style={{ position: "absolute", top: 0, left: "50%", width: 160, height: 160, marginLeft: -80, borderRadius: "50%", border: `4px solid ${p.accent}`, transform: `scale(${0.8 + ring * 0.9})`, opacity: (1 - ring) * 0.8 }} /> : null}
      <Icon size={160} />
      <div style={{ fontSize: 26, color: theme.muted, fontWeight: 700, letterSpacing: 2 }}>{p.name.toUpperCase()}</div>
      <div style={{ fontSize: 34, fontWeight: 900, color: "#0B0F1A", background: "#fff", padding: "10px 26px", borderRadius: 999, letterSpacing: 1, boxShadow: `0 0 24px ${p.accent}66` }}>{p.label}</div>
    </div>
  );
};

export const Outro = ({ words }: { words?: Word[] }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const label = interpolate(frame, [0, 14], [0, 1], { extrapolateRight: "clamp" });
  const line1 = spring({ frame: frame - 38, fps, config: { damping: 13, stiffness: 110 } });
  const line2 = spring({ frame: frame - 48, fps, config: { damping: 11, stiffness: 130 } });
  const line3 = interpolate(frame, [62, 78], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const glow = interpolate(frame, [10, 60], [0, 1], { extrapolateRight: "clamp" });
  const delays = [70, 80, 90];
  return (
    <AbsoluteFill style={{ fontFamily: theme.font, color: theme.white, textAlign: "center", overflow: "hidden" }}>
      {/* harita arkasında kırmızı ışık */}
      <div style={{ position: "absolute", left: 540 - 560, top: 470 - 380, width: 1120, height: 760, borderRadius: "50%", background: "radial-gradient(circle, rgba(227,10,23,0.45) 0%, rgba(227,10,23,0) 65%)", opacity: glow }} />
      {/* ses: giriş platformlarında kısa vuruş */}
      {delays.map((d) => (
        <Sequence key={d} from={d} durationInFrames={20}><Audio src={staticFile("sfx/blip.wav")} volume={0.35} /></Sequence>
      ))}
      <div style={{ position: "absolute", top: 130, left: 0, right: 0, opacity: label, fontSize: 34, fontWeight: 800, letterSpacing: 10, color: theme.muted }}>TÜRKİYE GÜNDEMİ</div>
      <div style={{ position: "absolute", top: 230, left: 0, right: 0, display: "flex", justifyContent: "center" }}>
        <TurkeyMap width={940} />
      </div>
      <div style={{ position: "absolute", top: 700, left: 60, right: 60 }}>
        <div style={{ fontSize: 66, fontWeight: 900, lineHeight: 1.05, opacity: Math.min(1, line1 * 1.3), transform: `translateY(${(1 - line1) * 40}px)` }}>HER 5 SAATTE BİR</div>
        <div style={{ display: "inline-block", marginTop: 18, fontSize: 108, fontWeight: 900, lineHeight: 1, background: theme.red, color: theme.white, padding: "10px 36px", borderRadius: 18, transform: `scale(${line2}) rotate(-2deg)`, boxShadow: "0 12px 40px rgba(227,10,23,0.5)" }}>SON DAKİKA</div>
        <div style={{ marginTop: 22, fontSize: 44, fontWeight: 700, color: theme.muted, opacity: line3 }}>Kaçırmamak için takip etmeyi unutma</div>
      </div>
      <div style={{ position: "absolute", top: 985, left: 0, right: 0, display: "flex", justifyContent: "center", gap: 80 }}>
        {PLATFORMS.map((p, i) => <Platform key={p.key} p={p} delay={delays[i]} />)}
      </div>
      <Captions words={words} accent={theme.red} bottom={340} size={54} />
    </AbsoluteFill>
  );
};
