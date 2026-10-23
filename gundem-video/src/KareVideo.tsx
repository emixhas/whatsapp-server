import { AbsoluteFill, Audio, Loop, OffthreadVideo, Sequence, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { styleFor } from "./categories";
import { Captions } from "./scenes/Captions";
import { InstagramIcon, TikTokIcon, YouTubeIcon } from "./scenes/Outro";
import { TurkeyMap } from "./scenes/TurkeyMap";
import { fitFontSize, trUpper } from "./fit";
import { theme } from "./theme";
import { setCaptionLead } from "./captionGroups";
import { Episode, FPS, Segment } from "./types";

/**
 * KARE (1:1) UZUN VİDEO, 1080x1080 (kullanıcı isteği, 23 Ekim: "bazen 10 dakikalık kare video linki gönderebilirim; link kare video yazarsam
 * gönderdiğim video kaç dakika ise ortalama o dakikalarda bir kare video üretmeli"). Yapı: kanca (kısa, çarpıcı) → intro (kanal kimliği)
 * → giriş haberi (seslendirme, video sessiz oynar) → "sesli" bölüm: videonun TAMAMI kendi sesiyle, altta bölüm başlıkları (chapters; her
 * bölümün başında 5 sn büyük alt bant, sonra küçük sürekli etiket + bölüm çentikli ilerleme çubuğu) ve videodaki konuşmanın kelime altyazısı
 * → kapanış haberi → kapanış (kanal). Dikey düzenin sahneleri 1080x1920 için yazıldığından burada kareye göre sade, küçük ölçekli sürümleri
 * çizilir; altyazı aynı stil (Captions), daha küçük punto. Müzik yatağı sesli bölümde susar.
 */
export const KARE = 1080;
const YELLOW = "#FFD400";
const WHOOSH_FRAMES = 17;
const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;
const stroke = { WebkitTextStroke: "3px #000", paintOrder: "stroke fill" as const, textShadow: "0 4px 18px rgba(0,0,0,.6)" };
const fill = { position: "absolute" as const, inset: 0, width: "100%", height: "100%", objectFit: "cover" as const };
type Word = { w: string; s: number; e: number };
const FOLLOW = [
  { Icon: YouTubeIcon, label: "ABONE OL", accent: "#FF0000" },
  { Icon: InstagramIcon, label: "TAKİP ET", accent: "#EE2A7B" },
  { Icon: TikTokIcon, label: "TAKİP ET", accent: "#25F4EE" },
];

/** videonun kendisi: sesli bölümde kendi sesiyle baştan sona, diğerlerinde sessiz döngü; video yoksa kategori ışıltısı */
const Media = ({ video, videoDuration, sound, accent, scale = 1 }: { video?: string; videoDuration?: number; sound?: boolean; accent: string; scale?: number }) => {
  const { fps } = useVideoConfig();
  const clip = Math.max(30, Math.floor((videoDuration || 8) * fps) - 2);
  const style = { ...fill, transform: `scale(${scale})` };
  if (!video) return <AbsoluteFill style={{ background: `radial-gradient(circle at 50% 40%, ${accent}55 0%, ${theme.bgAccent} 45%, #04060c 100%)` }} />;
  if (sound) return <OffthreadVideo src={staticFile(video)} volume={1} style={style} />;
  return (
    <Loop durationInFrames={clip} layout="none">
      <OffthreadVideo src={staticFile(video)} muted style={style} />
    </Loop>
  );
};

/** kanca: beyaz flaş, kategori flaşı, görüntü punch-in, etiket bandı, kelime kelime çarpan başlık (anahtar kelime sarı kutuda), altyazı */
const KareHook = ({ seg, durationInFrames }: { seg: Segment; durationInFrames: number }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const st = styleFor(seg.category);
  const accent = seg.breaking ? theme.red : st.accent;
  const label = seg.breaking ? "SON DAKİKA" : seg.categoryLabel || st.label;
  const white = interpolate(frame, [0, 1, 4], [1, 0.95, 0], clamp);
  const flash = interpolate(frame, [2, 4, 14], [0, 0.7, 0], clamp);
  const punch = spring({ frame, fps, config: { damping: 14, stiffness: 120 } });
  const blur = interpolate(frame, [0, 10], [12, 0], clamp);
  const shake = frame < 9 ? Math.sin(frame * 3.1) * (9 - frame) * 1.4 : 0;
  const fadeOut = interpolate(frame, [durationInFrames - 6, durationInFrames], [1, 0], clamp);
  const labelIn = spring({ frame: frame - 2, fps, config: { damping: 13, stiffness: 160 } });
  const tw = trUpper(seg.title || "").split(/\s+/).filter(Boolean);
  const keyIdx = Math.max(0, tw.findIndex((w) => /\d/.test(w)) >= 0 ? tw.findIndex((w) => /\d/.test(w)) : tw.length - 1);
  const size = fitFontSize({ text: seg.title || "", maxWidth: 940, base: (seg.title || "").length > 14 ? 104 : 128, min: 52, maxLines: 3 });
  const sw = Math.max(4, Math.round(size * 0.06));
  const underline = spring({ frame: frame - 6 - tw.length * 4, fps, config: { damping: 12 } });
  return (
    <AbsoluteFill style={{ fontFamily: theme.font, color: theme.white, opacity: fadeOut, backgroundColor: theme.bg }}>
      <AbsoluteFill style={{ transform: `translate(${shake}px, 0)` }}>
        <AbsoluteFill style={{ transform: `scale(${1.25 - 0.25 * punch})`, filter: `blur(${blur}px) saturate(1.2) contrast(1.1)` }}>
          <Media video={seg.video} videoDuration={seg.videoDuration} accent={accent} />
        </AbsoluteFill>
        <AbsoluteFill style={{ background: `repeating-conic-gradient(from ${frame * 0.6}deg at 50% 42%, ${accent}22 0deg 5deg, transparent 5deg 16deg)`, mixBlendMode: "screen", opacity: 0.4 }} />
        <AbsoluteFill style={{ background: "linear-gradient(180deg, rgba(4,6,12,.55) 0%, rgba(4,6,12,.2) 28%, rgba(4,6,12,.55) 60%, rgba(4,6,12,.95) 100%)" }} />
        <div style={{ position: "absolute", top: 54, left: 54, transform: `translateX(${(1 - labelIn) * -600}px) skewX(-8deg)`, display: "flex", alignItems: "center", gap: 12,
          background: accent, color: accent === theme.red ? theme.white : "#0B0F1A", padding: "10px 22px", borderRadius: 10, boxShadow: `0 0 40px ${accent}aa` }}>
          <div style={{ width: 14, height: 14, borderRadius: 7, background: "currentColor", opacity: 0.55 + 0.45 * Math.abs(Math.sin(frame / 4)) }} />
          <div style={{ fontSize: 32, fontWeight: 900, letterSpacing: 6 }}>{label}</div>
        </div>
        <div style={{ position: "absolute", left: 70, right: 70, top: 300 }}>
          <div lang="tr" style={{ fontSize: size, fontWeight: 900, lineHeight: 1.0, letterSpacing: -1, display: "flex", flexWrap: "wrap", gap: `0 ${size * 0.22}px` }}>
            {tw.map((w, i) => {
              const p = spring({ frame: frame - 4 - i * 4, fps, config: { damping: 11, stiffness: 190, mass: 0.7 } });
              const isKey = i === keyIdx;
              return (
                <span key={i} style={{ display: "inline-block", transformOrigin: "50% 60%", transform: `translateY(${(1 - p) * -90}px) scale(${2 - Math.min(1, p)}) rotate(${isKey ? -2 : 0}deg)`,
                  opacity: Math.min(1, p * 1.6), filter: `blur(${Math.max(0, (1 - p) * 8)}px)`,
                  ...(isKey ? { background: YELLOW, color: "#0B0F1A", padding: "0 0.12em", borderRadius: 10, boxShadow: `0 0 30px ${YELLOW}88, 0 10px 24px rgba(0,0,0,.6)` }
                    : { color: theme.white, WebkitTextStroke: `${sw}px #000`, paintOrder: "stroke fill", textShadow: `0 ${sw}px ${sw * 4}px rgba(0,0,0,.9)` }) }}>{w}</span>
              );
            })}
          </div>
          <div style={{ marginTop: 22, width: 220 * underline, height: 12, background: accent, borderRadius: 6, boxShadow: `0 0 24px ${accent}` }} />
        </div>
      </AbsoluteFill>
      <AbsoluteFill style={{ background: accent, opacity: flash, mixBlendMode: "screen" }} />
      <AbsoluteFill style={{ background: "#fff", opacity: white }} />
      <AbsoluteFill style={{ boxShadow: "inset 0 0 180px rgba(0,0,0,.85)" }} />
      <Captions words={seg.words} bottom={70} size={52} width={940} maxHeight={170} />
    </AbsoluteFill>
  );
};

/** intro: etiket, TÜRKİYE GÜNDEMİ, gün; altta takip düğmeleri (kareye sığacak ölçekte) */
const KareIntro = ({ episode }: { episode: Episode }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const sp = (d: number, cfg = { damping: 12, stiffness: 150 }) => spring({ frame: frame - d, fps, config: cfg });
  const pill = sp(0), big = sp(8, { damping: 10, stiffness: 170 }), line = interpolate(frame, [12, 26], [0, 1], clamp), date = sp(14);
  const label = trUpper(episode.infoKind === "video" && episode.slotLabel ? episode.slotLabel : episode.anlik ? "Son Dakika" : episode.formatLabel || "Gündem");
  const day = trUpper(episode.dayLabel || episode.dateLabel || "");
  const year = (episode.dateLabel || "").match(/\d{4}/)?.[0];
  return (
    <AbsoluteFill style={{ fontFamily: theme.font, color: theme.white, alignItems: "center", overflow: "hidden" }}>
      <AbsoluteFill style={{ background: `radial-gradient(circle at 50% 40%, ${theme.red}40 0%, ${theme.bgAccent} 45%, ${theme.bg} 100%)` }} />
      <AbsoluteFill style={{ background: `repeating-conic-gradient(from ${frame * 0.5}deg at 50% 40%, ${theme.red}1c 0deg 5deg, transparent 5deg 16deg)`, mixBlendMode: "screen" }} />
      <div style={{ position: "absolute", top: 150, left: 0, right: 0, display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center" }}>
        <div style={{ transform: `scale(${pill}) skewX(-8deg)`, background: theme.red, padding: "10px 28px", borderRadius: 10, fontSize: 38, fontWeight: 900, letterSpacing: 5, boxShadow: `0 0 40px ${theme.red}aa` }}>{label}</div>
        <div style={{ marginTop: 26, opacity: Math.min(1, big * 1.3), transform: `scale(${0.6 + 0.4 * big})`, lineHeight: 0.95 }}>
          <div style={{ fontSize: 54, fontWeight: 800, letterSpacing: 12, color: theme.muted }}>TÜRKİYE</div>
          <div style={{ fontSize: 124, fontWeight: 900, letterSpacing: -2, textShadow: "0 10px 40px rgba(0,0,0,.7)" }}>GÜNDEMİ</div>
        </div>
        <div style={{ width: 420 * line, height: 8, background: theme.red, borderRadius: 4, marginTop: 22, boxShadow: `0 0 20px ${theme.red}` }} />
        <div style={{ marginTop: 34, fontSize: 48, fontWeight: 900, letterSpacing: 2, opacity: Math.min(1, date * 1.3), transform: `translateY(${(1 - date) * 40}px)` }}>{day}{year && !day.includes(year) ? ` ${year}` : ""}</div>
      </div>
      <div style={{ position: "absolute", bottom: 90, left: 0, right: 0, display: "flex", justifyContent: "center", gap: 40 }}>
        {FOLLOW.map((p, i) => {
          const f = sp(20 + i * 4, { damping: 9, stiffness: 160 });
          const { Icon } = p;
          return (
            <div key={i} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10, opacity: Math.min(1, f * 1.4), transform: `translateY(${(1 - f) * 60}px)` }}>
              <Icon size={84} />
              <div style={{ fontSize: 22, fontWeight: 900, color: "#0B0F1A", background: theme.white, padding: "6px 16px", borderRadius: 999, boxShadow: `0 0 16px ${p.accent}` }}>{p.label}</div>
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};

/** giriş / kapanış: video sessiz oynar, üstte kategori bandı, altta altyazı + başlık + ilerleme */
const KareCard = ({ seg, durationInFrames }: { seg: Segment; durationInFrames: number }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const st = styleFor(seg.category);
  const accent = seg.breaking ? theme.red : st.accent;
  const enter = spring({ frame, fps, config: { damping: 15, stiffness: 120 } });
  const slide = spring({ frame: frame - 6, fps, config: { damping: 14, stiffness: 110 } });
  const fadeOut = interpolate(frame, [durationInFrames - 6, durationInFrames], [1, 0], clamp);
  const progress = interpolate(frame, [0, durationInFrames], [0, 1], { extrapolateRight: "clamp" });
  const sweep = interpolate(frame, [4, 26], [-40, 140], clamp);
  return (
    <AbsoluteFill style={{ fontFamily: theme.font, color: theme.white, opacity: fadeOut, background: "#000" }}>
      <Media video={seg.video} videoDuration={seg.videoDuration} accent={accent} scale={1 + 0.04 * progress} />
      <AbsoluteFill style={{ background: "linear-gradient(180deg, rgba(5,8,16,.6) 0%, rgba(5,8,16,0) 18%, rgba(5,8,16,0) 58%, rgba(5,8,16,.86) 78%, rgba(5,8,16,.94) 100%)" }} />
      <AbsoluteFill style={{ background: `linear-gradient(105deg, transparent ${sweep - 18}%, rgba(255,255,255,.16) ${sweep}%, transparent ${sweep + 18}%)` }} />
      <AbsoluteFill style={{ border: `5px solid ${accent}`, opacity: 0.5 * enter, boxShadow: `inset 0 0 30px ${accent}55` }} />
      <div style={{ position: "absolute", top: 46, left: 50, opacity: enter, fontSize: 28, fontWeight: 800, letterSpacing: 5, background: `${accent}cc`, padding: "8px 20px", borderRadius: 10 }}>
        {seg.breaking ? "SON DAKİKA" : seg.categoryLabel || st.label}
      </div>
      <Captions words={seg.words} top={690} limit={870} size={46} width={940} maxHeight={180} />
      <div style={{ position: "absolute", top: 884, left: 56, right: 56, transform: `translateX(${interpolate(slide, [0, 1], [90, 0])}px)`, opacity: slide }}>
        <div lang="tr" style={{ fontSize: fitFontSize({ text: seg.title || "", maxWidth: 968, base: 54, min: 32, maxLines: 2, upper: false }), fontWeight: 900, lineHeight: 1.06, overflowWrap: "normal", wordBreak: "keep-all", ...stroke }}>{seg.title}</div>
        {seg.source ? <div style={{ marginTop: 8, fontSize: 22, fontWeight: 700, color: "rgba(255,255,255,.85)", ...stroke, WebkitTextStroke: "2px #000" }}>VİDEO: {seg.source}</div> : null}
      </div>
      <div style={{ position: "absolute", bottom: 26, left: 56, right: 56, height: 8, background: "rgba(255,255,255,.18)", borderRadius: 4 }}>
        <div style={{ width: `${progress * 100}%`, height: "100%", background: accent, borderRadius: 4 }} />
      </div>
    </AbsoluteFill>
  );
};

/** sesli bölüm: videonun tamamı kendi sesiyle; bölüm başlıkları (başında 5 sn büyük alt bant, sonra küçük etiket), çentikli ilerleme, altyazı */
const KareFull = ({ seg, durationInFrames }: { seg: Segment; durationInFrames: number }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const st = styleFor(seg.category);
  const accent = st.accent;
  const t = frame / fps;
  const total = Math.max(1, seg.duration || durationInFrames / fps);
  const chapters = (seg.chapters || []).filter((c) => typeof c.t === "number" && c.title).sort((a, b) => a.t - b.t);
  const idx = chapters.reduce((k, c, i) => (c.t <= t + 0.001 ? i : k), -1);
  const cur = idx >= 0 ? chapters[idx] : null;
  const since = cur ? t - cur.t : 99;
  const bannerIn = spring({ frame: Math.round(since * fps), fps, config: { damping: 14, stiffness: 120 } });
  const bannerOut = interpolate(since, [4.4, 5.0], [1, 0], clamp);
  const banner = cur && since < 5 ? Math.min(bannerIn, bannerOut) : 0;
  const small = cur && since >= 4.6 ? interpolate(since, [4.6, 5.2], [0, 1], clamp) : 0;
  const fadeIn = interpolate(frame, [0, 8], [0, 1], clamp);
  const fadeOut = interpolate(frame, [durationInFrames - 6, durationInFrames], [1, 0], clamp);
  const progress = Math.min(1, t / total);
  return (
    <AbsoluteFill style={{ fontFamily: theme.font, color: theme.white, opacity: Math.min(fadeIn, fadeOut), background: "#000" }}>
      <Media video={seg.video} videoDuration={seg.videoDuration} sound accent={accent} />
      {/* alt karartma yalnız bant ve altyazı bölgesinde; görüntü üstte temiz */}
      <AbsoluteFill style={{ background: "linear-gradient(180deg, rgba(5,8,16,0) 0%, rgba(5,8,16,0) 70%, rgba(5,8,16,.55) 88%, rgba(5,8,16,.8) 100%)" }} />
      {/* kanal işareti (küçük, sağ üst) */}
      <div style={{ position: "absolute", top: 34, right: 44, fontSize: 20, fontWeight: 800, letterSpacing: 4, color: "rgba(255,255,255,.72)", ...stroke, WebkitTextStroke: "1.5px #000" }}>TÜRKİYE GÜNDEMİ</div>
      {/* videodaki konuşmanın kelime altyazısı (küçük) */}
      <Captions words={seg.words} bottom={126} size={44} width={960} maxHeight={150} />
      {/* bölüm bandı (bölüm başında 5 sn) */}
      {cur && banner > 0 ? (
        <div style={{ position: "absolute", left: 0, bottom: 300, transform: `translateX(${(1 - banner) * -700}px)`, opacity: banner, display: "flex", alignItems: "stretch" }}>
          <div style={{ width: 16, background: accent, boxShadow: `0 0 24px ${accent}` }} />
          <div style={{ background: "rgba(5,8,16,.86)", padding: "14px 30px 16px 22px", borderRadius: "0 16px 16px 0", maxWidth: 820 }}>
            <div style={{ fontSize: 22, fontWeight: 800, letterSpacing: 4, color: accent }}>BÖLÜM {idx + 1} / {chapters.length}</div>
            <div lang="tr" style={{ fontSize: fitFontSize({ text: cur.title, maxWidth: 760, base: 44, min: 30, maxLines: 2, upper: false }), fontWeight: 900, lineHeight: 1.1 }}>{cur.title}</div>
          </div>
        </div>
      ) : null}
      {/* sürekli küçük bölüm etiketi + çentikli ilerleme çubuğu */}
      {cur ? (
        <div style={{ position: "absolute", left: 56, bottom: 52, fontSize: 24, fontWeight: 800, color: "rgba(255,255,255,.85)", opacity: small, ...stroke, WebkitTextStroke: "1.5px #000" }}>
          <span style={{ color: accent }}>{idx + 1}/{chapters.length}</span> · {cur.title}
        </div>
      ) : null}
      <div style={{ position: "absolute", bottom: 26, left: 56, right: 56, height: 8, background: "rgba(255,255,255,.22)", borderRadius: 4 }}>
        <div style={{ width: `${progress * 100}%`, height: "100%", background: accent, borderRadius: 4 }} />
        {chapters.slice(1).map((c, i) => <div key={i} style={{ position: "absolute", left: `${(c.t / total) * 100}%`, top: -3, width: 3, height: 14, background: "rgba(255,255,255,.9)", borderRadius: 2 }} />)}
      </div>
    </AbsoluteFill>
  );
};

/** kapanış: harita, slogan, takip düğmeleri (kare ölçeği) */
const KareOutro = ({ words }: { words?: Word[] }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const label = interpolate(frame, [0, 14], [0, 1], clamp);
  const line1 = spring({ frame: frame - 30, fps, config: { damping: 13, stiffness: 110 } });
  const line2 = spring({ frame: frame - 40, fps, config: { damping: 11, stiffness: 130 } });
  const delays = [56, 64, 72];
  return (
    <AbsoluteFill style={{ fontFamily: theme.font, color: theme.white, textAlign: "center", overflow: "hidden", background: `linear-gradient(180deg, ${theme.bg} 0%, ${theme.bgAccent} 100%)` }}>
      <div style={{ position: "absolute", left: 540 - 420, top: 60, width: 840, height: 520, borderRadius: "50%", background: "radial-gradient(circle, rgba(227,10,23,0.4) 0%, rgba(227,10,23,0) 65%)" }} />
      {delays.map((d) => <Sequence key={d} from={d} durationInFrames={20}><Audio src={staticFile("sfx/blip.wav")} volume={0.35} /></Sequence>)}
      <div style={{ position: "absolute", top: 54, left: 0, right: 0, opacity: label, fontSize: 26, fontWeight: 800, letterSpacing: 8, color: theme.muted }}>TÜRKİYE GÜNDEMİ</div>
      <div style={{ position: "absolute", top: 110, left: 0, right: 0, display: "flex", justifyContent: "center" }}><TurkeyMap width={560} /></div>
      <div style={{ position: "absolute", top: 400, left: 60, right: 60 }}>
        <div style={{ fontSize: 44, fontWeight: 900, lineHeight: 1.05, opacity: Math.min(1, line1 * 1.3), transform: `translateY(${(1 - line1) * 30}px)` }}>HER GÜN</div>
        <div style={{ display: "inline-block", marginTop: 12, fontSize: 72, fontWeight: 900, lineHeight: 1, background: theme.red, color: theme.white, padding: "8px 28px", borderRadius: 14, transform: `scale(${line2}) rotate(-2deg)`, boxShadow: "0 10px 30px rgba(227,10,23,0.5)" }}>YENİ VİDEO</div>
      </div>
      <div style={{ position: "absolute", top: 640, left: 0, right: 0, display: "flex", justifyContent: "center", gap: 56 }}>
        {FOLLOW.map((p, i) => {
          const f = spring({ frame: frame - delays[i], fps, config: { damping: 10, stiffness: 150 } });
          const { Icon } = p;
          return (
            <div key={i} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10, opacity: Math.min(1, f * 1.4), transform: `translateY(${(1 - f) * 50}px)` }}>
              <Icon size={110} />
              <div style={{ fontSize: 26, fontWeight: 900, color: "#0B0F1A", background: "#fff", padding: "8px 20px", borderRadius: 999, boxShadow: `0 0 20px ${p.accent}66` }}>{p.label}</div>
            </div>
          );
        })}
      </div>
      <Captions words={words} bottom={40} size={44} width={940} maxHeight={130} />
    </AbsoluteFill>
  );
};

export const KareVideo = ({ episode }: { episode: Episode }) => {
  setCaptionLead(episode.captionLead);
  // müzik yatağı: sesli bölümde susar (video kendi sesiyle izlensin)
  const runs: [number, number][] = [];
  { let t = 0, start: number | null = 0;
    for (const s of episode.segments) {
      if (s.kind === "sesli") { if (start !== null && t > start) runs.push([start, t]); start = null; }
      else if (start === null) start = t;
      t += s.duration;
    }
    if (start !== null && t > start) runs.push([start, t]); }
  let cursor = 0;
  return (
    <AbsoluteFill style={{ background: theme.bg }}>
      {episode.music ? runs.map(([a, b], k) => (
        <Sequence key={`m${k}`} from={Math.round(a * FPS)} durationInFrames={Math.max(1, Math.round((b - a) * FPS))}>
          <Audio src={staticFile(episode.music!)} volume={episode.musicVolume ?? 0.07} loop />
        </Sequence>
      )) : null}
      {episode.segments.map((seg, i) => {
        const from = Math.round(cursor * FPS);
        const dur = Math.max(1, Math.round(seg.duration * FPS));
        cursor += seg.duration;
        const st = styleFor(seg.category);
        const sceneSfx = seg.kind === "hook" ? (seg.breaking ? "sfx/sondakika.wav" : st.sfx) : seg.kind === "intro" ? "sfx/sting.wav" : seg.kind === "outro" ? "sfx/chime.wav" : st.sfx;
        const sceneVol = seg.kind === "haber" ? st.sfxVolume : seg.kind === "hook" ? 0.75 : 0.5;
        return (
          <Sequence key={i} from={from} durationInFrames={dur}>
            {seg.kind === "sesli" ? null : <Audio src={staticFile(seg.audio)} />}
            {seg.kind === "sesli" ? null : <Audio src={staticFile(sceneSfx)} volume={sceneVol} />}
            {i > 0 ? <Sequence from={0} durationInFrames={WHOOSH_FRAMES}><Audio src={staticFile("sfx/whoosh.wav")} volume={0.35} /></Sequence> : null}
            {seg.kind === "hook" ? <KareHook seg={seg} durationInFrames={dur} />
              : seg.kind === "intro" ? <KareIntro episode={episode} />
              : seg.kind === "outro" ? <KareOutro words={seg.words} />
              : seg.kind === "sesli" ? <KareFull seg={seg} durationInFrames={dur} />
              : <KareCard seg={seg} durationInFrames={dur} />}
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
};
