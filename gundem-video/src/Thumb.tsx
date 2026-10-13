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
  /** geniş kapak: diğer haberlerin fotoğrafları (köşede küçük kareler) */ images?: string[];
  /** geniş kapak: videodaki haber sayısı ("+9 HABER") */ count?: number;
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
export const Thumb = (props: ThumbProps) => {
  if (props.wide) return <WideThumb {...props} />;
  return <TallThumb {...props} />;
};

/**
 * YouTube (1280x720) kapağı — kullanıcı isteği: "aşırı dikkat çekici". Haber kanallarının tıklanan kapak dili:
 * sağda büyük, canlı haber fotoğrafı; solda 2-3 satırlık DEV başlık (beyaz, kalın siyah kontür; anahtar kelime sarı
 * kutuda), üstte eğik kırmızı etiket (GÜNÜN ÖZETİ / SON DAKİKA) + tarih, başlıktan fotoğrafa uzanan kırmızı ok,
 * sağ altta diğer haberlerden iki küçük kare ve "+N HABER" rozeti. Az ama iri öğe: küçük ekranda da okunur.
 */
const WideThumb = ({ text, category, breaking, image, dayLabel, slotLabel, images = [], count }: ThumbProps) => {
  const st = styleFor(category);
  const words = trUpper(text).split(/\s+/).filter(Boolean);
  const key = keyWordIndex(words);
  const size = fitFontSize({ text, maxWidth: 640, base: 132, min: 64, maxLines: 3 });
  const stroke = Math.max(7, Math.round(size * 0.09));
  const label = slotLabel === "GÜNÜN ÖZETİ" || slotLabel === "HAFTANIN ÖZETİ" ? slotLabel : breaking ? "SON DAKİKA" : slotLabel === "ANLIK HABER" ? "SON DAKİKA" : st.label;
  const extra = images.filter(Boolean).slice(0, 2);
  const more = count && count > 1 ? count - 1 : 0;
  return (
    <AbsoluteFill style={{ background: "#07090f", fontFamily: theme.font, color: theme.white, overflow: "hidden" }}>
      {/* sağda büyük fotoğraf, canlı renk, sola doğru karanlığa erir */}
      {image ? (
        <Img src={staticFile(image)} style={{ position: "absolute", right: 0, top: 0, width: 860, height: 720, objectFit: "cover", filter: "saturate(1.45) contrast(1.22) brightness(1.06)" }} />
      ) : (
        <AbsoluteFill style={{ background: `radial-gradient(circle at 72% 45%, ${st.accent}88 0%, #1a0306 45%, #07090f 100%)` }} />
      )}
      <AbsoluteFill style={{ background: "linear-gradient(90deg, #07090f 0%, #07090f 34%, rgba(7,9,15,.88) 46%, rgba(7,9,15,.25) 62%, rgba(7,9,15,0) 75%)" }} />
      <AbsoluteFill style={{ background: "linear-gradient(180deg, rgba(0,0,0,.35) 0%, transparent 25%, transparent 70%, rgba(0,0,0,.55) 100%)" }} />
      {/* soldan kırmızı enerji ışıması */}
      <AbsoluteFill style={{ background: `radial-gradient(ellipse at 0% 100%, ${theme.red}99 0%, transparent 50%)`, mixBlendMode: "screen" }} />

      {/* etiket + tarih */}
      <div style={{ position: "absolute", left: 44, top: 38, display: "flex", alignItems: "center", gap: 18 }}>
        <div style={{ background: theme.red, color: theme.white, fontSize: 40, fontWeight: 900, letterSpacing: 3, padding: "8px 22px", transform: "skewX(-10deg)", boxShadow: `0 0 34px ${theme.red}, 0 8px 22px rgba(0,0,0,.7)` }}>{label}</div>
        {dayLabel ? <div style={{ fontSize: 34, fontWeight: 900, color: YELLOW, textShadow: "0 3px 12px #000, 0 0 2px #000" }}>{trUpper(dayLabel)}</div> : null}
      </div>

      {/* dev başlık */}
      <div lang="tr" style={{ position: "absolute", left: 40, top: 130, width: 680, bottom: 70, display: "flex", flexDirection: "column", justifyContent: "center" }}>
        <div style={{ fontSize: size, fontWeight: 900, lineHeight: 1.0, letterSpacing: -1.5 }}>
          {words.map((w, i) => i === key ? (
            <span key={i} style={{ display: "inline-block", background: YELLOW, color: "#0B0F1A", padding: "0 0.1em", margin: "0.03em 0.08em", borderRadius: 8, transform: "rotate(-2.5deg)", boxShadow: "0 10px 26px rgba(0,0,0,.7)" }}>{w}</span>
          ) : (
            <span key={i} style={{ display: "inline-block", margin: "0.03em 0.08em", WebkitTextStroke: `${stroke}px #000`, paintOrder: "stroke fill", textShadow: `0 ${stroke}px ${stroke * 2}px rgba(0,0,0,.95)` }}>{w}</span>
          ))}
        </div>
      </div>

      {/* başlıktan fotoğrafa kırmızı ok */}
      <svg width="190" height="120" viewBox="0 0 190 120" style={{ position: "absolute", left: 700, top: 250, filter: `drop-shadow(0 0 14px ${theme.red}) drop-shadow(0 6px 10px rgba(0,0,0,.8))` }}>
        <path d="M6 70 C 60 30, 110 28, 150 48" stroke={theme.red} strokeWidth="16" fill="none" strokeLinecap="round" />
        <path d="M128 18 L 184 54 L 122 82 Z" fill={theme.red} />
      </svg>

      {/* diğer haberlerden küçük kareler + "+N HABER" */}
      {extra.length || more ? (
        <div style={{ position: "absolute", right: 30, bottom: 28, display: "flex", alignItems: "flex-end", gap: 14 }}>
          {extra.map((src, i) => (
            <Img key={i} src={staticFile(src)} style={{ width: 190, height: 120, objectFit: "cover", border: "6px solid #fff", borderRadius: 6, transform: `rotate(${i ? 3 : -3}deg)`, boxShadow: "0 10px 26px rgba(0,0,0,.75)", filter: "saturate(1.3) contrast(1.1)" }} />
          ))}
          {more ? (
            <div style={{ width: 130, height: 130, borderRadius: "50%", background: YELLOW, color: "#0B0F1A", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", fontWeight: 900, boxShadow: "0 0 30px rgba(255,212,0,.7), 0 10px 24px rgba(0,0,0,.7)", border: "5px solid #0B0F1A", transform: "rotate(-8deg)" }}>
              <div style={{ fontSize: 52, lineHeight: 1 }}>+{more}</div>
              <div style={{ fontSize: 22, letterSpacing: 1 }}>HABER</div>
            </div>
          ) : null}
        </div>
      ) : null}

      {/* sol kenarda kalın kırmızı şerit + ince çerçeve */}
      <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: 14, background: theme.red, boxShadow: `0 0 30px ${theme.red}` }} />
      <AbsoluteFill style={{ border: `6px solid ${theme.red}`, boxShadow: `inset 0 0 40px ${theme.red}66` }} />
    </AbsoluteFill>
  );
};

const TallThumb = ({ text, category, breaking, image, variant = "A", channel = "TÜRKİYE GÜNDEMİ", dayLabel, slotLabel, timeRange, wide = false }: ThumbProps) => {
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
        <div style={{ fontSize: 40 * s, fontWeight: 900, letterSpacing: 9 * s, textShadow: "0 3px 14px rgba(0,0,0,1)" }}>{trUpper(channel)}</div>
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
          <div style={{ fontSize: 38 * s, fontWeight: 900, color: theme.white, letterSpacing: 3, textShadow: "0 3px 12px rgba(0,0,0,1)" }}>{slotLabel === "GÜNÜN ÖZETİ" ? "HER AKŞAM GÜNÜN ÖZETİ" : slotLabel === "HAFTANIN ÖZETİ" ? "HER PAZAR HAFTANIN ÖZETİ" : "HER 5 SAATTE BİR"}</div>
          <div style={{ width: 120 * s, height: 12 * s, background: accent, borderRadius: 7 }} />
        </div>
      </div>

      {/* kategori renginde kalın çerçeve */}
      <AbsoluteFill style={{ border: `${frame}px solid ${accent}`, boxShadow: `inset 0 0 ${frame * 3}px ${accent}`, borderRadius: wide ? 0 : 0 }} />
    </AbsoluteFill>
  );
};
