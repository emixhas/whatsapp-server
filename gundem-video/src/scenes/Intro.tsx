import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { trUpper } from "../fit";
import { theme } from "../theme";
import { InstagramIcon, TikTokIcon, YouTubeIcon } from "./Outro";

type Props = {
  dateLabel: string; episodeOfDay: number; timeLabel: string; formatLabel?: string;
  dayLabel?: string; slotLabel?: string; timeRange?: string; scheduleHours?: number; anlik?: boolean;
  words?: { w: string; s: number; e: number }[];
};

const YELLOW = "#FFD400";
const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;
const FOLLOW = [
  { Icon: YouTubeIcon, label: "ABONE OL", accent: "#FF0000" },
  { Icon: InstagramIcon, label: "TAKİP ET", accent: "#EE2A7B" },
  { Icon: TikTokIcon, label: "TAKİP ET", accent: "#25F4EE" },
];

/**
 * INTRO (kancadan sonra, ~3 sn): "GÜNE BAŞLARKEN · SON 5 SAATİN · TÜRKİYE GÜNDEMİ", ortada gün, tarih, saat ve
 * saat aralığı; altta YouTube / Instagram / TikTok takip et animasyonu (sırayla gelir, dokunma vuruşu).
 * Anlık haberde "SON DAKİKA" ve üretim saati gösterilir.
 */
export const Intro = ({ dateLabel, timeLabel, formatLabel, dayLabel, slotLabel, timeRange, scheduleHours = 5, anlik }: Props) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const sp = (d: number, cfg = { damping: 12, stiffness: 150 }) => spring({ frame: frame - d, fps, config: cfg });
  const pill = sp(0), small = sp(4), big = sp(8, { damping: 10, stiffness: 170 }), line = interpolate(frame, [12, 26], [0, 1], clamp);
  const date = sp(14), follow = (i: number) => sp(20 + i * 4, { damping: 9, stiffness: 160 });
  const label = trUpper(anlik ? "Son Dakika" : formatLabel || "Gündem");
  const day = trUpper(dayLabel || dateLabel || "");
  const year = (dateLabel || "").match(/\d{4}/)?.[0];
  const tap = frame > 34 ? (frame - 34) % 30 : -1; // takip düğmelerine dokunma vuruşu
  return (
    <AbsoluteFill style={{ fontFamily: theme.font, color: theme.white, alignItems: "center", overflow: "hidden" }}>
      {/* arka plan ışıltısı ve dönen huzme */}
      <AbsoluteFill style={{ background: `radial-gradient(circle at 50% 40%, ${theme.red}40 0%, ${theme.bgAccent} 45%, ${theme.bg} 100%)` }} />
      <AbsoluteFill style={{ background: `repeating-conic-gradient(from ${frame * 0.5}deg at 50% 40%, ${theme.red}1c 0deg 5deg, transparent 5deg 16deg)`, mixBlendMode: "screen" }} />

      {/* başlık bloğu */}
      <div style={{ position: "absolute", top: 330, left: 0, right: 0, display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center" }}>
        <div style={{ transform: `scale(${pill}) skewX(-8deg)`, background: theme.red, padding: "14px 38px", borderRadius: 12, fontSize: 52, fontWeight: 900, letterSpacing: 6, boxShadow: `0 0 50px ${theme.red}aa` }}>{label}</div>
        {!anlik ? <div style={{ marginTop: 34, opacity: small, transform: `translateY(${(1 - small) * 30}px)`, fontSize: 64, fontWeight: 800, letterSpacing: 10, color: YELLOW }}>SON {scheduleHours} SAATİN</div> : null}
        <div style={{ marginTop: anlik ? 34 : 30, opacity: Math.min(1, big * 1.3), transform: `scale(${0.6 + 0.4 * big})`, textAlign: "center", lineHeight: 0.95 }}>
          <div style={{ fontSize: 76, fontWeight: 800, letterSpacing: 16, color: theme.muted }}>TÜRKİYE</div>
          <div style={{ fontSize: 168, fontWeight: 900, letterSpacing: -2, textShadow: "0 10px 40px rgba(0,0,0,.7)" }}>GÜNDEMİ</div>
        </div>
        <div style={{ width: 560 * line, height: 10, background: theme.red, borderRadius: 5, marginTop: 30, boxShadow: `0 0 24px ${theme.red}` }} />
      </div>

      {/* ortada gün, tarih, saat */}
      <div style={{ position: "absolute", top: 1010, left: 0, right: 0, display: "flex", flexDirection: "column", alignItems: "center", gap: 18, opacity: Math.min(1, date * 1.3), transform: `translateY(${(1 - date) * 50}px)` }}>
        <div style={{ fontSize: 72, fontWeight: 900, letterSpacing: 2 }}>{day}{year && !day.includes(year) ? ` ${year}` : ""}</div>
        <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
          <div style={{ fontSize: 60, fontWeight: 900, background: theme.white, color: "#0B0F1A", padding: "8px 26px", borderRadius: 14 }}>{anlik ? `SAAT ${timeLabel}` : slotLabel || `SAAT ${timeLabel}`}</div>
          {!anlik && timeRange ? <div style={{ fontSize: 60, fontWeight: 900, color: YELLOW }}>{timeRange}</div> : null}
        </div>
      </div>

      {/* takip et animasyonu */}
      <div style={{ position: "absolute", bottom: 230, left: 0, right: 0, display: "flex", justifyContent: "center", gap: 46 }}>
        {FOLLOW.map((p, i) => {
          const f = follow(i);
          const beat = tap >= 0 && Math.floor(((frame - 34) / 30)) % 3 === i ? Math.sin((Math.min(tap, 10) / 10) * Math.PI) : 0;
          const { Icon } = p;
          return (
            <div key={i} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 12, opacity: Math.min(1, f * 1.4), transform: `translateY(${(1 - f) * 80}px) scale(${1 + 0.1 * beat})` }}>
              <div style={{ position: "relative" }}>
                {beat > 0 ? <div style={{ position: "absolute", inset: -10, borderRadius: "50%", border: `5px solid ${p.accent}`, opacity: 1 - tap / 30, transform: `scale(${1 + tap / 20})` }} /> : null}
                <Icon size={120} />
              </div>
              <div style={{ fontSize: 30, fontWeight: 900, color: "#0B0F1A", background: theme.white, padding: "8px 22px", borderRadius: 999, boxShadow: `0 0 ${20 + 30 * beat}px ${p.accent}` }}>{p.label}</div>
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};
