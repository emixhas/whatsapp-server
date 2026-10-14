import { AbsoluteFill, Loop, OffthreadVideo, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { styleFor } from "../categories";
import { Captions } from "./Captions";
import { fitFontSize, textWidth } from "../fit";
import { theme } from "../theme";

/**
 * Dikey tam ekran haber (kullanıcı isteği: WhatsApp'tan gönderilen dikey video "tam gözüksün, üstünde etrafında bizim süslemeler
 * olsun"). Video 1080x1920 tüm kareyi kaplar (wa_video.py oranı uymayanı kırpmadan bulanık zeminle sığdırır); üstte kategori/sıra
 * ya da SON DAKİKA şeridi, kenarlarda kategori renginde çerçeve ve köşe süsleri, altta altyazı + numaralı başlık + kaynak + ilerleme.
 * `sound`: orijinal sesli bölüm (kullanıcı isteği: "video kaç saniye ise sussun, video izlensin, sonra konuşmaya devam edilsin") —
 * videonun kendi sesi çalar, seslendirme yoktur, üstte "ORİJİNAL SES" rozeti, altyazı videodaki konuşmadan.
 */
type Props = {
  categoryLabel?: string; index: number; total: number; title: string; source?: string; category?: string; breaking?: boolean;
  durationInFrames: number; words?: { w: string; s: number; e: number }[]; video?: string; videoDuration?: number; sound?: boolean;
};

const stroke = { WebkitTextStroke: "3px #000", paintOrder: "stroke fill" as const, textShadow: "0 4px 18px rgba(0,0,0,.6)" };

export const FullFrame = ({ categoryLabel, index, total, title, source, category, breaking, durationInFrames, words, video, videoDuration, sound }: Props) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const st = styleFor(category);
  const accent = sound ? theme.red : st.accent;
  const enter = spring({ frame, fps, config: { damping: 15, stiffness: 120 } });
  const slide = spring({ frame: frame - 6, fps, config: { damping: 14, stiffness: 110 } });
  const fadeOut = interpolate(frame, [durationInFrames - 6, durationInFrames], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const progress = interpolate(frame, [0, durationInFrames], [0, 1], { extrapolateRight: "clamp" });
  const pulse = 0.7 + 0.3 * Math.abs(Math.sin(frame / 7));
  const flash = breaking ? interpolate(frame, [0, 3, 16], [0, 0.5, 0], { extrapolateRight: "clamp" }) : 0;
  const sweep = interpolate(frame, [4, 26], [-40, 140], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const num = String(index + 1).padStart(2, "0");
  const clip = Math.max(30, Math.floor((videoDuration || 8) * fps) - 2);
  const fill = { position: "absolute" as const, inset: 0, width: "100%", height: "100%", objectFit: "cover" as const };
  const corner = (pos: React.CSSProperties, rot: number) => (
    <div style={{ position: "absolute", width: 90, height: 90, ...pos, borderTop: `8px solid ${accent}`, borderLeft: `8px solid ${accent}`,
      transform: `rotate(${rot}deg) scale(${0.6 + 0.4 * enter})`, opacity: enter, filter: `drop-shadow(0 0 12px ${accent})` }} />
  );
  return (
    <AbsoluteFill style={{ fontFamily: theme.font, color: theme.white, opacity: fadeOut, background: "#000" }}>
      {video ? (
        sound ? <OffthreadVideo src={staticFile(video)} volume={1} style={fill} /> : (
          <Loop durationInFrames={clip} layout="none">
            <OffthreadVideo src={staticFile(video)} muted style={fill} />
          </Loop>
        )
      ) : null}
      {/* okunurluk: üst ve alt karartma, video ortada temiz kalır */}
      <AbsoluteFill style={{ background: "linear-gradient(180deg, rgba(5,8,16,.82) 0%, rgba(5,8,16,0) 22%, rgba(5,8,16,0) 52%, rgba(5,8,16,.9) 84%)" }} />
      {breaking ? <AbsoluteFill style={{ background: theme.red, opacity: flash }} /> : null}
      {/* giriş ışık süpürmesi */}
      <AbsoluteFill style={{ background: `linear-gradient(105deg, transparent ${sweep - 18}%, rgba(255,255,255,.18) ${sweep}%, transparent ${sweep + 18}%)` }} />
      {/* kenar çerçevesi + köşe süsleri (kanal kimliği) */}
      <AbsoluteFill style={{ border: `6px solid ${accent}`, opacity: 0.55 * enter, boxShadow: `inset 0 0 40px ${accent}55` }} />
      {corner({ top: 26, left: 26 }, 0)}
      {corner({ top: 26, right: 26 }, 90)}
      {corner({ bottom: 26, right: 26 }, 180)}
      {corner({ bottom: 26, left: 26 }, 270)}

      {/* üst şerit: SON DAKİKA ya da ORİJİNAL SES rozeti; kategori + sıra */}
      {breaking && !sound ? (
        <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 86, background: theme.red, opacity: 0.85 + 0.15 * pulse,
          display: "flex", alignItems: "center", justifyContent: "center", gap: 22, transform: `translateY(${(enter - 1) * 86}px)` }}>
          <div style={{ width: 22, height: 22, borderRadius: 11, background: theme.white, opacity: pulse }} />
          <div style={{ fontSize: 44, fontWeight: 900, letterSpacing: 12 }}>SON DAKİKA</div>
          <div style={{ width: 22, height: 22, borderRadius: 11, background: theme.white, opacity: pulse }} />
        </div>
      ) : null}
      <div style={{ position: "absolute", top: 120, left: 70, right: 70, display: "flex", justifyContent: "space-between", alignItems: "center", opacity: enter }}>
        {sound ? (
          <div style={{ display: "flex", alignItems: "center", gap: 16, background: theme.red, padding: "12px 28px", borderRadius: 14, boxShadow: `0 0 ${24 * pulse}px ${theme.red}` }}>
            <div style={{ display: "flex", alignItems: "flex-end", gap: 5, height: 34 }}>
              {[0, 1, 2, 3].map((k) => <div key={k} style={{ width: 7, borderRadius: 3, background: theme.white, height: 10 + 22 * Math.abs(Math.sin(frame / 4 + k * 1.3)) }} />)}
            </div>
            <div style={{ fontSize: 38, fontWeight: 900, letterSpacing: 5 }}>ORİJİNAL SES</div>
          </div>
        ) : (
          <div style={{ fontSize: 38, fontWeight: 800, letterSpacing: 6, color: theme.white, background: `${st.accent}cc`, padding: "10px 26px", borderRadius: 14 }}>{categoryLabel || st.label}</div>
        )}
        {sound ? null : <div style={{ fontSize: 40, fontWeight: 800, ...stroke }}>{index + 1} / {total}</div>}
      </div>

      {/* yanan altyazı: seslendirme ya da videodaki konuşma */}
      <Captions words={words} accent={accent} top={1090} size={64} />

      {/* başlık bloğu: altta, Shorts arayüzünün üstünde */}
      <div style={{ position: "absolute", top: 1260, left: 70, right: 70, transform: `translateX(${interpolate(slide, [0, 1], [120, 0])}px)`, opacity: slide }}>
        {sound ? (
          title ? <div lang="tr" style={{ fontSize: fitFontSize({ text: title, maxWidth: 940, base: 64, min: 40, maxLines: 2, upper: false }), fontWeight: 900, lineHeight: 1.08, ...stroke }}>{title}</div> : null
        ) : (
          <div style={{ display: "flex", alignItems: "flex-end", gap: 26 }}>
            <div style={{ fontSize: 140, fontWeight: 900, color: st.accent, lineHeight: 0.85, ...stroke }}>{num}</div>
            <div lang="tr" style={{ fontSize: fitFontSize({ text: title, maxWidth: 940 - 26 - textWidth(num, 140), base: breaking ? 80 : 72, min: 44, maxLines: 3, upper: false }),
              fontWeight: 900, lineHeight: 1.06, paddingBottom: 6, overflowWrap: "normal", wordBreak: "keep-all", ...stroke }}>{title}</div>
          </div>
        )}
        {source ? <div style={{ marginTop: 16, fontSize: 30, fontWeight: 700, color: "rgba(255,255,255,.85)", ...stroke, WebkitTextStroke: "2px #000" }}>{sound ? "GÖRÜNTÜ" : "VİDEO"}: {source}</div> : null}
      </div>

      <div style={{ position: "absolute", bottom: 130, left: 70, right: 70, height: 10, background: "rgba(255,255,255,.18)", borderRadius: 5 }}>
        <div style={{ width: `${progress * 100}%`, height: "100%", background: accent, borderRadius: 5 }} />
      </div>
    </AbsoluteFill>
  );
};
