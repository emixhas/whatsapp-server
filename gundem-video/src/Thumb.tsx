import { AbsoluteFill, Img, Sequence, staticFile } from "remotion";
import { styleFor } from "./categories";
import { theme } from "./theme";

export type ThumbProps = {
  text: string; category?: string; breaking?: boolean; image?: string; variant?: string; channel?: string;
  /** "9 Ekim Cuma" */ dayLabel?: string;
  /** "1. 5 SAAT" */ slotLabel?: string;
  /** "09:00–14:00" */ timeRange?: string;
};

/** Kapak görseli (1080x1920 still): gün + kaçıncı 5 saat + saat aralığı rozeti, dev başlık, kategori rengi, varsa fotoğraf. */
export const Thumb = ({ text, category, breaking, image, variant = "A", channel = "TÜRKİYE GÜNDEMİ", dayLabel, slotLabel, timeRange }: ThumbProps) => {
  const st = styleFor(category);
  const accent = breaking ? theme.red : st.accent;
  const long = text.length > 26;
  return (
    <AbsoluteFill style={{ background: `linear-gradient(160deg, ${theme.bg} 0%, ${theme.bgAccent} 60%, #050811 100%)`, fontFamily: theme.font, color: theme.white, overflow: "hidden" }}>
      {image ? <Img src={staticFile(image)} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", opacity: 0.6, filter: "saturate(1.15) contrast(1.1)" }} /> : null}
      {!image ? <div style={{ position: "absolute", top: 420, left: 80, width: 920, height: 560, borderRadius: 40, overflow: "hidden", background: theme.card, opacity: 0.9 }}>{/* Still tek karedir; illüstrasyonu giriş animasyonu bitmiş haliyle (40. kare) göster */}<Sequence from={-40} layout="none"><st.Illustration /></Sequence></div> : null}
      {/* alt koyu geçiş: başlık her zaman okunur */}
      <div style={{ position: "absolute", inset: 0, background: "linear-gradient(180deg, rgba(5,8,17,.55) 0%, rgba(5,8,17,.15) 30%, rgba(5,8,17,.35) 50%, rgba(5,8,17,.97) 72%)" }} />
      {/* çapraz vurgu şeridi */}
      <div style={{ position: "absolute", left: -200, top: 300, width: 1500, height: 44, background: accent, opacity: 0.9, transform: "rotate(-8deg)", boxShadow: `0 0 40px ${accent}` }} />
      {/* üst: kanal + kategori */}
      <div style={{ position: "absolute", top: 70, left: 72, right: 72, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ fontSize: 38, fontWeight: 900, letterSpacing: 7, textShadow: "0 4px 20px rgba(0,0,0,.8)" }}>{channel}</div>
        <div style={{ fontSize: 32, fontWeight: 900, letterSpacing: 5, color: "#0B0F1A", background: accent, padding: "10px 24px", borderRadius: 14 }}>{breaking ? "SON DAKİKA" : st.label}</div>
      </div>
      {/* gün · N. 5 saat · saat aralığı rozeti */}
      <div style={{ position: "absolute", top: 150, left: 72, display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 10 }}>
        {dayLabel ? <div style={{ fontSize: 44, fontWeight: 900, letterSpacing: 2, textTransform: "uppercase", textShadow: "0 4px 20px rgba(0,0,0,.9)" }}>{dayLabel}</div> : null}
        {slotLabel ? (
          <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
            <div style={{ fontSize: 60, fontWeight: 900, lineHeight: 1, background: theme.white, color: "#0B0F1A", padding: "12px 26px", borderRadius: 16, letterSpacing: 1, boxShadow: "0 10px 30px rgba(0,0,0,.6)" }}>{slotLabel}</div>
            {timeRange ? <div style={{ fontSize: 46, fontWeight: 800, color: accent, textShadow: "0 4px 20px rgba(0,0,0,.9)", letterSpacing: 2 }}>{timeRange}</div> : null}
          </div>
        ) : null}
      </div>
      {/* dev başlık */}
      <div style={{ position: "absolute", left: 72, right: 72, bottom: 230 }}>
        <div lang="tr" style={{ fontSize: long ? 108 : variant === "B" ? 132 : 124, fontWeight: 900, lineHeight: 0.98, textTransform: "uppercase", textShadow: "0 8px 40px rgba(0,0,0,.95), 0 2px 0 rgba(0,0,0,.6)", textWrap: "balance" as never, letterSpacing: -1 }}>{text}</div>
        <div style={{ marginTop: 30, display: "flex", alignItems: "center", gap: 18 }}>
          <div style={{ width: 300, height: 14, background: accent, borderRadius: 7 }} />
          <div style={{ fontSize: 34, fontWeight: 800, color: theme.muted, letterSpacing: 3 }}>HER 5 SAATTE BİR</div>
        </div>
      </div>
    </AbsoluteFill>
  );
};
