import { AbsoluteFill, Img, staticFile } from "remotion";
import { styleFor } from "./categories";
import { theme } from "./theme";

export type ThumbProps = { text: string; category?: string; breaking?: boolean; image?: string; variant?: string; channel?: string };

/** Kapak görseli (1080x1920 still): büyük başlık, kategori rengi, varsa haber fotoğrafı. */
export const Thumb = ({ text, category, breaking, image, variant = "A", channel = "TÜRKİYE GÜNDEMİ" }: ThumbProps) => {
  const st = styleFor(category);
  return (
    <AbsoluteFill style={{ background: `linear-gradient(180deg, ${theme.bg} 0%, ${theme.bgAccent} 100%)`, fontFamily: theme.font, color: theme.white }}>
      {image ? <Img src={staticFile(image)} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", opacity: 0.55 }} /> : null}
      <div style={{ position: "absolute", inset: 0, background: "linear-gradient(180deg, rgba(11,15,26,.2) 0%, rgba(11,15,26,.3) 40%, rgba(11,15,26,.95) 75%)" }} />
      {!image ? <div style={{ position: "absolute", top: 260, left: 80, width: 920, height: 560, borderRadius: 40, overflow: "hidden", background: theme.card }}><st.Illustration /></div> : null}
      <div style={{ position: "absolute", top: 90, left: 80, right: 80, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ fontSize: 40, fontWeight: 900, letterSpacing: 6 }}>{channel}</div>
        <div style={{ fontSize: 34, fontWeight: 800, letterSpacing: 5, color: st.accent, background: `${st.accent}22`, padding: "10px 24px", borderRadius: 14 }}>{st.label}</div>
      </div>
      {breaking ? <div style={{ position: "absolute", top: 180, left: 80, background: theme.red, padding: "10px 28px", borderRadius: 12, fontSize: 40, fontWeight: 900, letterSpacing: 8 }}>SON DAKİKA</div> : null}
      <div style={{ position: "absolute", left: 80, right: 80, bottom: 260 }}>
        <div lang="tr" style={{ fontSize: variant === "B" ? 118 : 104, fontWeight: 900, lineHeight: 1.02, textTransform: "uppercase", textShadow: "0 6px 30px rgba(0,0,0,.8)", textWrap: "balance" as never }}>{text}</div>
        <div style={{ marginTop: 34, width: 260, height: 12, background: st.accent, borderRadius: 6 }} />
      </div>
    </AbsoluteFill>
  );
};
