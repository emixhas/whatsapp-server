import { AbsoluteFill, Img, Sequence, staticFile } from "remotion";
import { styleFor } from "./categories";
import { fitFontSize } from "./fit";
import { theme } from "./theme";

export type ThumbProps = {
  text: string; category?: string; breaking?: boolean; image?: string; variant?: string; channel?: string;
  /** "9 Ekim Cuma" */ dayLabel?: string;
  /** "1. 5 SAAT" */ slotLabel?: string;
  /** "09:00–14:00" */ timeRange?: string;
  /** true: 1280x720 YouTube kapağı; false: 1080x1920 dikey kapak */ wide?: boolean;
};

/** Kapak görseli: her şey ortalı, büyük yazı. Dikey (Shorts/Reels/TikTok) ve geniş (YouTube 16:9) düzen. */
export const Thumb = ({ text, category, breaking, image, variant = "A", channel = "TÜRKİYE GÜNDEMİ", dayLabel, slotLabel, timeRange, wide = false }: ThumbProps) => {
  const st = styleFor(category);
  const accent = breaking ? theme.red : st.accent;
  const len = text.length;
  // Başlık boyutu: metin uzunluğuna göre, dikeyde 118–150, genişte 72–96
  const baseSize = wide ? (len > 34 ? 78 : len > 24 ? 90 : 104) : len > 34 ? 126 : len > 24 ? 140 : variant === "B" ? 160 : 150;
  // Uzun kelime kapaktan taşmasın: dikeyde 960 px ve 3 satır, genişte 1100 px ve 2 satır
  const headSize = fitFontSize({ text, maxWidth: wide ? 1100 : 960, base: baseSize, min: wide ? 52 : 72, maxLines: wide ? 2 : 3 });
  const s = wide ? 0.62 : 1; // rozet ölçeği
  return (
    <AbsoluteFill style={{ background: `linear-gradient(160deg, ${theme.bg} 0%, ${theme.bgAccent} 60%, #050811 100%)`, fontFamily: theme.font, color: theme.white, overflow: "hidden", alignItems: "center" }}>
      {image ? <Img src={staticFile(image)} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", opacity: 0.55, filter: "saturate(1.15) contrast(1.1)" }} /> : null}
      {!image && !wide ? <div style={{ position: "absolute", top: 600, left: 80, width: 920, height: 560, borderRadius: 40, overflow: "hidden", background: theme.card, opacity: 0.9 }}><Sequence from={-40} layout="none"><st.Illustration /></Sequence></div> : null}
      {!image && wide ? <div style={{ position: "absolute", left: 180, top: 90, width: 920, height: 560, borderRadius: 40, overflow: "hidden", background: theme.card, opacity: 0.5 }}><Sequence from={-40} layout="none"><st.Illustration /></Sequence></div> : null}
      <div style={{ position: "absolute", inset: 0, background: wide ? "linear-gradient(180deg, rgba(5,8,17,.9) 0%, rgba(5,8,17,.55) 40%, rgba(5,8,17,.55) 55%, rgba(5,8,17,.97) 80%)" : "linear-gradient(180deg, rgba(5,8,17,.6) 0%, rgba(5,8,17,.2) 30%, rgba(5,8,17,.4) 50%, rgba(5,8,17,.97) 70%)" }} />
      {/* çapraz vurgu şeridi */}
      <div style={{ position: "absolute", left: -300, top: wide ? 110 : 430, width: 2000, height: wide ? 26 : 44, background: accent, opacity: 0.9, transform: "rotate(-7deg)", boxShadow: `0 0 40px ${accent}` }} />
      {/* üst blok: kanal, gün, rozet + saat aralığı — hepsi ortalı */}
      <div style={{ position: "absolute", top: wide ? 36 : 90, left: 0, right: 0, display: "flex", flexDirection: "column", alignItems: "center", gap: 14 * s, textAlign: "center" }}>
        <div style={{ fontSize: 44 * s, fontWeight: 900, letterSpacing: 8, textShadow: "0 4px 20px rgba(0,0,0,.9)" }}>{channel}</div>
        <div style={{ fontSize: 36 * s, fontWeight: 900, letterSpacing: 5, color: "#0B0F1A", background: accent, padding: `${10 * s}px ${28 * s}px`, borderRadius: 14 }}>{breaking ? "SON DAKİKA" : st.label}</div>
        {dayLabel ? <div style={{ fontSize: 54 * s, fontWeight: 900, letterSpacing: 2, textTransform: "uppercase", textShadow: "0 4px 20px rgba(0,0,0,.9)", marginTop: 6 * s }}>{dayLabel}</div> : null}
        {slotLabel ? (
          <div style={{ display: "flex", alignItems: "center", gap: 18 * s }}>
            <div style={{ fontSize: 74 * s, fontWeight: 900, lineHeight: 1, background: theme.white, color: "#0B0F1A", padding: `${12 * s}px ${30 * s}px`, borderRadius: 18, boxShadow: "0 10px 30px rgba(0,0,0,.6)" }}>{slotLabel}</div>
            {timeRange ? <div style={{ fontSize: 58 * s, fontWeight: 900, color: accent, textShadow: "0 4px 20px rgba(0,0,0,.9)", letterSpacing: 2 }}>{timeRange}</div> : null}
          </div>
        ) : null}
      </div>
      {/* dev başlık: ortalı */}
      <div style={{ position: "absolute", left: wide ? 40 : 60, right: wide ? 40 : 60, bottom: wide ? 36 : 150, display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center" }}>
        <div lang="tr" style={{ fontSize: headSize, fontWeight: 900, lineHeight: 0.98, textTransform: "uppercase", textShadow: "0 8px 40px rgba(0,0,0,.95), 0 2px 0 rgba(0,0,0,.6)", textWrap: "balance" as never, letterSpacing: -1, maxWidth: wide ? 1100 : undefined }}>{text}</div>
        <div style={{ marginTop: 26 * s, display: "flex", alignItems: "center", gap: 18 }}>
          <div style={{ width: 120 * s, height: 12 * s, background: accent, borderRadius: 7 }} />
          <div style={{ fontSize: 38 * s, fontWeight: 800, color: theme.muted, letterSpacing: 3 }}>HER 5 SAATTE BİR</div>
          <div style={{ width: 120 * s, height: 12 * s, background: accent, borderRadius: 7 }} />
        </div>
      </div>
    </AbsoluteFill>
  );
};
