import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { styleFor } from "../categories";
import { fitFontSize, textWidth, trUpper } from "../fit";
import { theme } from "../theme";
import { Captions } from "./Captions";
import { MediaBg } from "./MediaBg";

type Props = {
  categoryLabel?: string; title: string; narration: string; category?: string; breaking?: boolean; image?: string; video?: string; videoDuration?: number; words?: { w: string; s: number; e: number }[]; durationInFrames: number };

const YELLOW = "#FFD400";
const TICK = "SON DAKİKA   •   ";
const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;

/**
 * KANCA (ilk 3 sn), sinematik giriş:
 *  0-3. kare beyaz flaş, ardından kategori renginde flaş ve ekranın ortasından genişleyen şok dalgası
 *  medya 1.35 kattan bulanıktan netleşerek "punch-in" yakınlaşır, ilk 8 karede kamera sarsıntısı
 *  başlık kelime kelime yukarıdan çarparak iner (büyükten küçüğe, bulanıktan nete), anahtar kelime sarı kutuda
 *  ilk 14 karede ve 32-35. karelerde RGB kayması (kırmızı/camgöbeği hayalet), 18-40. kareler arası ışık süpürmesi
 *  dönen ışık huzmeleri, tarama çizgileri, kenar vinyeti; SON DAKİKA ise altta kayan kırmızı bant.
 */
export const Hook = ({ categoryLabel, title, narration, category, breaking, image, video, videoDuration, words, durationInFrames }: Props) => {
  const frame = useCurrentFrame();
  const { fps, width } = useVideoConfig();
  const st = styleFor(category);
  const accent = breaking ? theme.red : st.accent;
  const label = breaking ? "SON DAKİKA" : categoryLabel || st.label;
  const TICK_W = textWidth(TICK, 56, 900, theme.font, 6); // kayan bandın kesintisiz dönmesi için bir tekrarın genişliği

  // flaşlar ve şok dalgası
  const white = interpolate(frame, [0, 1, 4], [1, 0.95, 0], clamp);
  const flash = interpolate(frame, [2, 4, 14], [0, 0.75, 0], clamp);
  const wave = interpolate(frame, [2, 22], [0, 1], clamp);
  // medya punch-in: büyük ve bulanıktan normale yaylanarak
  const punch = spring({ frame, fps, config: { damping: 14, stiffness: 120 } });
  const mediaScale = 1.35 - 0.35 * punch;
  const mediaBlur = interpolate(frame, [0, 10], [14, 0], clamp);
  const shake = frame < 9 ? Math.sin(frame * 3.1) * (9 - frame) * 1.6 : 0;
  const shakeY = frame < 9 ? Math.cos(frame * 2.3) * (9 - frame) * 1.1 : 0;
  const fadeOut = interpolate(frame, [durationInFrames - 6, durationInFrames], [1, 0], clamp);

  // başlık: kelime kelime çarpma
  const tw = trUpper(title).split(/\s+/).filter(Boolean);
  const keyIdx = Math.max(0, tw.findIndex((w) => /\d/.test(w)) >= 0 ? tw.findIndex((w) => /\d/.test(w)) : tw.length - 1);
  const size = fitFontSize({ text: title, maxWidth: 900, base: title.length > 14 ? 150 : 190, min: 64, maxLines: 3 });
  const stroke = Math.max(5, Math.round(size * 0.06));
  const glitch = frame < 14 ? interpolate(frame, [0, 14], [18, 0]) : frame >= 32 && frame <= 35 ? 12 : 0;
  const sweep = interpolate(frame, [18, 40], [-0.4, 1.4], clamp);
  const underline = spring({ frame: frame - 6 - tw.length * 4, fps, config: { damping: 12 } });
  const labelIn = spring({ frame: frame - 2, fps, config: { damping: 13, stiffness: 160 } });

  const renderTitle = (color?: string) => (
    <div lang="tr" style={{ fontSize: size, fontWeight: 900, lineHeight: 1.0, letterSpacing: -1, display: "flex", flexWrap: "wrap", gap: `0 ${size * 0.22}px` }}>
      {tw.map((w, i) => {
        const p = spring({ frame: frame - 4 - i * 4, fps, config: { damping: 11, stiffness: 190, mass: 0.7 } });
        const isKey = i === keyIdx;
        return (
          <span key={i} style={{
            display: "inline-block", transformOrigin: "50% 60%",
            transform: `translateY(${(1 - p) * -120}px) scale(${2.4 - 1.4 * Math.min(1, p)}) rotate(${isKey ? -2 : 0}deg)`,
            opacity: Math.min(1, p * 1.6), filter: color ? undefined : `blur(${Math.max(0, (1 - p) * 10)}px)`,
            ...(color
              ? { color, opacity: Math.min(1, p * 1.6) * 0.75 }
              : isKey
                ? { background: YELLOW, color: "#0B0F1A", padding: "0 0.12em", borderRadius: 12, boxShadow: `0 0 40px ${YELLOW}88, 0 12px 30px rgba(0,0,0,.6)` }
                : { color: theme.white, WebkitTextStroke: `${stroke}px #000`, paintOrder: "stroke fill", textShadow: `0 ${stroke}px ${stroke * 4}px rgba(0,0,0,.9)` }),
          }}>{w}</span>
        );
      })}
    </div>
  );

  return (
    <AbsoluteFill style={{ fontFamily: theme.font, color: theme.white, opacity: fadeOut, backgroundColor: theme.bg }}>
      {/* sahne (sarsıntılı) */}
      <AbsoluteFill style={{ transform: `translate(${shake}px, ${shakeY}px)` }}>
        {image || video ? (
          <AbsoluteFill style={{ transform: `scale(${mediaScale})`, filter: `blur(${mediaBlur}px) saturate(1.25) contrast(1.12)` }}>
            <MediaBg image={image} video={video} videoDuration={videoDuration} durationInFrames={durationInFrames} zoomFrom={1.0} zoomTo={1.1} />
          </AbsoluteFill>
        ) : (
          <AbsoluteFill style={{ background: `radial-gradient(circle at 50% 38%, ${accent}55 0%, ${theme.bgAccent} 45%, #04060c 100%)` }} />
        )}
        {/* dönen ışık huzmeleri */}
        <AbsoluteFill style={{ background: `repeating-conic-gradient(from ${frame * 0.6}deg at 50% 42%, ${accent}26 0deg 5deg, transparent 5deg 16deg)`, mixBlendMode: "screen", opacity: image || video ? 0.45 : 0.8 }} />
        {/* okunurluk karartması */}
        <AbsoluteFill style={{ background: "linear-gradient(180deg, rgba(4,6,12,.55) 0%, rgba(4,6,12,.25) 25%, rgba(4,6,12,.55) 55%, rgba(4,6,12,.95) 100%)" }} />

        {/* üst etiket: kayarak gelen bant */}
        <div style={{ position: "absolute", top: 110, left: 70, transform: `translateX(${(1 - labelIn) * -700}px) skewX(-8deg)`, display: "flex", alignItems: "center", gap: 16,
          background: accent, color: accent === theme.red || breaking ? theme.white : "#0B0F1A", padding: "14px 30px", borderRadius: 12, boxShadow: `0 0 50px ${accent}aa` }}>
          <div style={{ width: 20, height: 20, borderRadius: 10, background: "currentColor", opacity: 0.55 + 0.45 * Math.abs(Math.sin(frame / 4)) }} />
          <div style={{ fontSize: 44, fontWeight: 900, letterSpacing: 8 }}>{label}</div>
        </div>

        {/* başlık: RGB kayma hayaletleri + asıl yazı + ışık süpürmesi */}
        <div style={{ position: "absolute", left: 70, right: 70, top: 520 }}>
          {glitch > 0 ? (
            <>
              <div style={{ position: "absolute", inset: 0, transform: `translate(${glitch}px, ${-glitch / 3}px)`, mixBlendMode: "screen" }}>{renderTitle("#ff1f3d")}</div>
              <div style={{ position: "absolute", inset: 0, transform: `translate(${-glitch}px, ${glitch / 3}px)`, mixBlendMode: "screen" }}>{renderTitle("#19e6ff")}</div>
            </>
          ) : null}
          <div style={{ position: "relative" }}>{renderTitle()}</div>
          {/* ışık süpürmesi */}
          <div style={{ position: "absolute", inset: "-20px -40px", overflow: "hidden", pointerEvents: "none", mixBlendMode: "overlay" }}>
            <div style={{ position: "absolute", top: 0, bottom: 0, width: 260, left: `${sweep * 100}%`, transform: "skewX(-20deg)", background: "linear-gradient(90deg, transparent, rgba(255,255,255,.55), transparent)", opacity: interpolate(frame, [18, 24, 34, 40], [0, 1, 1, 0], clamp) }} />
          </div>
          <div style={{ marginTop: 34, width: 280 * underline, height: 16, background: accent, borderRadius: 8, boxShadow: `0 0 30px ${accent}` }} />
        </div>
      </AbsoluteFill>

      {/* şok dalgası halkası */}
      <div style={{ position: "absolute", left: width / 2, top: 760, width: 0, height: 0 }}>
        <div style={{ position: "absolute", left: -1400 * wave, top: -1400 * wave, width: 2800 * wave, height: 2800 * wave, borderRadius: "50%",
          border: `${Math.max(2, 40 * (1 - wave))}px solid ${accent}`, opacity: (1 - wave) * 0.9, boxShadow: `0 0 80px ${accent}` }} />
      </div>
      {/* flaşlar */}
      <AbsoluteFill style={{ background: accent, opacity: flash, mixBlendMode: "screen" }} />
      <AbsoluteFill style={{ background: "#fff", opacity: white }} />
      {/* tarama çizgileri ve vinyet */}
      <AbsoluteFill style={{ background: "repeating-linear-gradient(0deg, rgba(0,0,0,.18) 0px, rgba(0,0,0,.18) 2px, transparent 2px, transparent 5px)", opacity: 0.18 }} />
      <AbsoluteFill style={{ boxShadow: "inset 0 0 260px rgba(0,0,0,.9)" }} />

      <Captions words={words} accent={accent} bottom={breaking ? 560 : 500} size={64} />

      {/* SON DAKİKA kayan bant */}
      {breaking ? (
        <div style={{ position: "absolute", left: 0, right: 0, bottom: 300, height: 92, background: theme.red, overflow: "hidden", boxShadow: "0 0 50px rgba(227,10,23,.8)",
          transform: `translateY(${interpolate(frame, [6, 16], [200, 0], clamp)}px)` }}>
          <div style={{ position: "absolute", top: 14, left: -((frame * 9) % TICK_W), whiteSpace: "pre", fontSize: 56, fontWeight: 900, letterSpacing: 6 }}>
            {Array.from({ length: 8 }, () => TICK).join("")}
          </div>
        </div>
      ) : null}
    </AbsoluteFill>
  );
};
