import { AbsoluteFill, Img, Sequence, staticFile } from "remotion";
import { styleFor } from "./categories";
import { fitFontSize, trUpper } from "./fit";
import { theme } from "./theme";

export type ThumbProps = {
  text: string; category?: string; breaking?: boolean; image?: string; variant?: string; channel?: string;
  /** "9 Ekim Cuma" */ dayLabel?: string;
  /** "1. 5 SAAT" ya da "ANLIK HABER" */ slotLabel?: string;
  /** "09:00–14:00" */ timeRange?: string;
  /** true: 1280x720 YouTube kapağı; false: 1080x1920 dikey kapak */ wide?: boolean;
};

const YELLOW = "#FFD400";

/** Vurgulanacak kelime: rakam içeren ilk kelime (3 ÖLÜ, 250 BAZ PUAN), yoksa en uzun kelime. */
function keyWordIndex(words: string[]): number {
  const num = words.findIndex((w) => /\d/.test(w));
  if (num >= 0) return num;
  let best = 0;
  words.forEach((w, i) => { if (w.length > words[best].length) best = i; });
  return best;
}

/**
 * Kapak: dikkat çekici haber kapağı. Haberin fotoğrafı tam ekran (yoksa büyük illüstrasyon), kalın siyah
 * kontürlü dev başlık, anahtar kelime sarı kutuda, kategori renginde kalın çerçeve, üstte SON DAKİKA bandı,
 * ortada gün / "N. 5 SAAT" / saat aralığı rozetleri. Her şey ortalı. Dikey 1080x1920 ve geniş 1280x720.
 */
export const Thumb = ({ text, category, breaking, image, variant = "A", channel = "TÜRKİYE GÜNDEMİ", dayLabel, slotLabel, timeRange, wide = false }: ThumbProps) => {
  const st = styleFor(category);
  const accent = breaking ? theme.red : st.accent;
  const s = wide ? 0.62 : 1; // rozet ölçeği
  const words = trUpper(text).split(/\s+/).filter(Boolean);
  const key = keyWordIndex(words);
  const len = text.length;
  const base = wide ? (len > 24 ? 92 : 112) : len > 24 ? 150 : variant === "B" ? 176 : 166;
  // sarı kutu ve kontür payı için genişlik biraz dar tutulur
  const size = fitFontSize({ text, maxWidth: wide ? 1080 : 900, base, min: wide ? 52 : 76, maxLines: wide ? 2 : 3 });
  const stroke = Math.max(6, Math.round(size * 0.075));
  const frame = wide ? 10 : 16;
  return (
    <AbsoluteFill style={{ background: theme.bg, fontFamily: theme.font, color: theme.white, overflow: "hidden" }}>
      {/* arka plan: fotoğraf tam ekran, canlı renk; yoksa kategori ışıltısı + büyük illüstrasyon */}
      {image ? (
        <Img src={staticFile(image)} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", filter: "saturate(1.35) contrast(1.18) brightness(1.02)" }} />
      ) : (
        <>
          <AbsoluteFill style={{ background: `radial-gradient(circle at 50% ${wide ? 45 : 42}%, ${accent}55 0%, ${theme.bgAccent} 45%, #04060c 100%)` }} />
          <div style={{ position: "absolute", left: "50%", top: wide ? 90 : 520, width: 920, height: 560, transform: `translateX(-50%) scale(${wide ? 0.95 : 1.15})`, transformOrigin: "top center", opacity: 0.95 }}>
            <Sequence from={-40} layout="none"><st.Illustration /></Sequence>
          </div>
        </>
      )}
      {/* ışık huzmeleri */}
      <AbsoluteFill style={{ background: `repeating-conic-gradient(from 0deg at 50% ${wide ? 60 : 62}%, ${accent}1f 0deg 6deg, transparent 6deg 18deg)`, mixBlendMode: "screen", opacity: image ? 0.35 : 0.55 }} />
      {/* okunurluk: üst ve alt karartma, kenar vinyeti */}
      <AbsoluteFill style={{ background: wide
        ? "linear-gradient(180deg, rgba(4,6,12,.82) 0%, rgba(4,6,12,.15) 30%, rgba(4,6,12,.15) 45%, rgba(4,6,12,.92) 78%)"
        : "linear-gradient(180deg, rgba(4,6,12,.85) 0%, rgba(4,6,12,.2) 26%, rgba(4,6,12,.05) 45%, rgba(4,6,12,.75) 64%, rgba(4,6,12,.96) 84%)" }} />
      <AbsoluteFill style={{ boxShadow: `inset 0 0 ${wide ? 160 : 260}px rgba(0,0,0,.85)` }} />
      {/* alttan kategori renginde parıltı */}
      <AbsoluteFill style={{ background: `radial-gradient(ellipse at 50% 100%, ${accent}66 0%, transparent 55%)`, mixBlendMode: "screen" }} />

      {/* üst blok: kanal, SON DAKİKA bandı, gün, N. 5 SAAT + saat aralığı */}
      <div style={{ position: "absolute", top: wide ? 26 : 70, left: 0, right: 0, display: "flex", flexDirection: "column", alignItems: "center", gap: 14 * s, textAlign: "center" }}>
        <div style={{ fontSize: 40 * s, fontWeight: 900, letterSpacing: 9 * s, textShadow: "0 3px 14px rgba(0,0,0,1)" }}>{channel}</div>
        <div style={{ display: "flex", alignItems: "center", gap: 16 * s, fontSize: 52 * s, fontWeight: 900, letterSpacing: 6 * s, background: accent, color: breaking || accent === theme.red ? theme.white : "#0B0F1A",
          padding: `${10 * s}px ${34 * s}px`, borderRadius: 12, transform: "skewX(-8deg)", boxShadow: `0 0 ${40 * s}px ${accent}cc, 0 10px 30px rgba(0,0,0,.6)` }}>
          <span style={{ width: 22 * s, height: 22 * s, borderRadius: "50%", background: "currentColor", boxShadow: "0 0 12px currentColor" }} />
          {breaking ? "SON DAKİKA" : st.label}
        </div>
        {dayLabel ? <div style={{ fontSize: 50 * s, fontWeight: 900, letterSpacing: 2, textShadow: "0 3px 14px rgba(0,0,0,1)" }}>{trUpper(dayLabel)}</div> : null}
        {slotLabel ? (
          <div style={{ display: "flex", alignItems: "center", gap: 16 * s }}>
            <div style={{ fontSize: 66 * s, fontWeight: 900, lineHeight: 1, background: theme.white, color: "#0B0F1A", padding: `${10 * s}px ${28 * s}px`, borderRadius: 14, boxShadow: "0 10px 30px rgba(0,0,0,.6)" }}>{slotLabel}</div>
            {timeRange ? <div style={{ fontSize: 56 * s, fontWeight: 900, color: YELLOW, textShadow: "0 3px 14px rgba(0,0,0,1), 0 0 2px #000", letterSpacing: 2 }}>{timeRange}</div> : null}
          </div>
        ) : null}
      </div>

      {/* dev başlık: kalın siyah kontür, anahtar kelime sarı kutuda */}
      <div style={{ position: "absolute", left: wide ? 50 : 60, right: wide ? 50 : 60, bottom: wide ? 40 : 150, display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center" }}>
        <div lang="tr" style={{ fontSize: size, fontWeight: 900, lineHeight: 1.04, letterSpacing: -1, maxWidth: wide ? 1160 : undefined }}>
          {words.map((w, i) => i === key ? (
            <span key={i} style={{ display: "inline-block", background: YELLOW, color: "#0B0F1A", padding: "0 0.12em", margin: "0.04em 0.1em", borderRadius: 10, transform: "rotate(-2deg)", boxShadow: "0 12px 30px rgba(0,0,0,.6)" }}>{w}</span>
          ) : (
            <span key={i} style={{ display: "inline-block", margin: "0.04em 0.1em", WebkitTextStroke: `${stroke}px #000`, paintOrder: "stroke fill", textShadow: `0 ${stroke}px ${stroke * 3}px rgba(0,0,0,.9)` }}>{w}</span>
          ))}
        </div>
        <div style={{ marginTop: 22 * s, display: "flex", alignItems: "center", gap: 18 }}>
          <div style={{ width: 120 * s, height: 12 * s, background: accent, borderRadius: 7 }} />
          <div style={{ fontSize: 38 * s, fontWeight: 900, color: theme.white, letterSpacing: 3, textShadow: "0 3px 12px rgba(0,0,0,1)" }}>HER 5 SAATTE BİR</div>
          <div style={{ width: 120 * s, height: 12 * s, background: accent, borderRadius: 7 }} />
        </div>
      </div>

      {/* kategori renginde kalın çerçeve */}
      <AbsoluteFill style={{ border: `${frame}px solid ${accent}`, boxShadow: `inset 0 0 ${frame * 3}px ${accent}`, borderRadius: wide ? 0 : 0 }} />
    </AbsoluteFill>
  );
};
