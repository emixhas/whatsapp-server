import { AbsoluteFill, Audio, Sequence, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { styleFor } from "./categories";
import { fitFontSize, trUpper } from "./fit";
import { Background } from "./scenes/Background";
import { MediaBg } from "./scenes/MediaBg";
import { InstagramIcon, TikTokIcon, YouTubeIcon } from "./scenes/Outro";
import { TurkeyMap } from "./scenes/TurkeyMap";
import { theme } from "./theme";
import { Thumb } from "./Thumb";
import { Episode, FPS, Segment } from "./types";

/** Günlük uzun özet (YouTube, 1920x1080): günün en önemli haberleri, her biri solda büyük medya, sağda başlık
 *  ve yanan altyazı; altta sıradaki haberlerin kayan bandı. Dikey GundemVideo ile aynı episode.json'u okur. */
export const WIDE_W = 1920;
export const WIDE_H = 1080;
const WHOOSH = 17;
type Word = { w: string; s: number; e: number };

/** Geniş altyazı: 7 kelimelik pencere, konuşulan kelime kategori renginde. */
const WideCaptions = ({ words, accent }: { words?: Word[]; accent: string }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  if (!words?.length) return null;
  const t = frame / fps;
  let idx = words.findIndex((w) => t >= w.s && t < w.e);
  if (idx < 0) idx = t >= words[words.length - 1].e ? words.length - 1 : 0;
  const N = 7, start = Math.floor(idx / N) * N;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 14px", lineHeight: 1.2 }}>
      {words.slice(start, start + N).map((w, i) => {
        const gi = start + i, active = gi === idx;
        return (
          <span key={gi} lang="tr" style={{ fontSize: 40, fontWeight: 800, whiteSpace: "nowrap", color: active ? "#0B0F1A" : gi < idx ? theme.white : "rgba(255,255,255,.55)",
            background: active ? accent : "transparent", padding: active ? "0 10px" : 0, borderRadius: 10 }}>{w.w}</span>
        );
      })}
    </div>
  );
};

/** Kategori illüstrasyonları 920x560 kutuya çizilir; bulunduğu alanın ortasına yerleştirir. */
const Centered = ({ children, scale = 1, opacity = 1 }: { children: React.ReactNode; scale?: number; opacity?: number }) => (
  <div style={{ position: "absolute", left: "50%", top: "50%", width: 920, height: 560, opacity, transform: `translate(-50%, -50%) scale(${scale})` }}>{children}</div>
);

const TopBar = ({ e, label }: { e: Episode; label: string }) => (
  <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 78, display: "flex", alignItems: "center", gap: 22, padding: "0 48px", background: "rgba(11,15,26,.85)", borderBottom: `4px solid ${theme.red}`, fontFamily: theme.font, color: theme.white }}>
    <div style={{ background: theme.red, padding: "6px 18px", borderRadius: 8, fontSize: 30, fontWeight: 900, letterSpacing: 4 }}>{label}</div>
    <div style={{ fontSize: 30, fontWeight: 800, letterSpacing: 3 }}>TÜRKİYE GÜNDEMİ</div>
    <div style={{ marginLeft: "auto", fontSize: 28, color: theme.muted, fontWeight: 700 }}>{e.dayLabel || e.dateLabel}</div>
  </div>
);

/** Alt kayan bant: sıradaki başlıklar. */
const Ticker = ({ items }: { items: string[] }) => {
  const frame = useCurrentFrame();
  if (!items.length) return null;
  const text = items.map((t) => `●  ${t}`).join("     ");
  const w = text.length * 17 + 400;
  const x = -((frame * 3) % w);
  return (
    <div style={{ position: "absolute", bottom: 0, left: 0, right: 0, height: 64, background: "rgba(11,15,26,.92)", borderTop: `3px solid ${theme.red}`, overflow: "hidden", fontFamily: theme.font }}>
      <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: 210, zIndex: 2, background: theme.red, color: theme.white, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 24, fontWeight: 900, letterSpacing: 3 }}>SIRADAKİ</div>
      <div style={{ position: "absolute", left: 230 + x, top: 14, whiteSpace: "nowrap", fontSize: 28, fontWeight: 700, color: theme.white }}>{text}     {text}</div>
    </div>
  );
};

const WideHook = ({ seg, e, dur }: { seg: Segment; e: Episode; dur: number }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const st = styleFor(seg.category);
  const pop = spring({ frame: frame - 4, fps, config: { damping: 10, stiffness: 140 } });
  const flash = interpolate(frame, [0, 3, 14], [1, 0.6, 0], { extrapolateRight: "clamp" });
  const size = fitFontSize({ text: seg.title || "", maxWidth: 1600, base: 170, min: 80, maxLines: 2 });
  return (
    <AbsoluteFill style={{ fontFamily: theme.font, color: theme.white }}>
      {seg.image || seg.video ? <MediaBg image={seg.image} video={seg.video} videoDuration={seg.videoDuration} durationInFrames={dur} zoomFrom={1.2} zoomTo={1.05} /> : <Centered scale={1.7} opacity={0.4}><st.Illustration /></Centered>}
      <AbsoluteFill style={{ background: "radial-gradient(ellipse at center, rgba(11,15,26,.35) 0%, rgba(11,15,26,.9) 80%)" }} />
      <AbsoluteFill style={{ background: "#fff", opacity: flash }} />
      <div style={{ position: "absolute", top: 200, left: 0, right: 0, textAlign: "center" }}>
        <div style={{ display: "inline-block", background: theme.red, padding: "10px 34px", borderRadius: 12, fontSize: 46, fontWeight: 900, letterSpacing: 10 }}>GÜNÜN ÖZETİ</div>
        <div style={{ marginTop: 18, fontSize: 40, fontWeight: 700, color: theme.muted }}>{e.dayLabel || e.dateLabel}</div>
      </div>
      <div lang="tr" style={{ position: "absolute", top: 470, left: 160, right: 160, textAlign: "center", fontSize: size, fontWeight: 900, lineHeight: 1.02, transform: `scale(${0.6 + 0.4 * pop})`, textShadow: "0 8px 30px rgba(0,0,0,.8)", WebkitTextStroke: "3px #000" }}>{trUpper(seg.title || "")}</div>
    </AbsoluteFill>
  );
};

const WideIntro = ({ e, titles }: { e: Episode; titles: string[] }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return (
    <AbsoluteFill style={{ fontFamily: theme.font, color: theme.white }}>
      <div style={{ position: "absolute", left: 90, top: 170, width: 900 }}>
        <div style={{ fontSize: 34, fontWeight: 800, letterSpacing: 8, color: theme.muted }}>TÜRKİYE GÜNDEMİ</div>
        <div style={{ fontSize: 110, fontWeight: 900, lineHeight: 1, marginTop: 10 }}>GÜNÜN<br /><span style={{ color: theme.red }}>ÖZETİ</span></div>
        <div style={{ fontSize: 44, fontWeight: 700, marginTop: 24 }}>{e.dayLabel || e.dateLabel}</div>
        <div style={{ fontSize: 32, color: theme.muted, marginTop: 8 }}>Bugünün en önemli {titles.length} haberi</div>
      </div>
      <div style={{ position: "absolute", right: 90, top: 150, width: 760, display: "grid", gap: 14 }}>
        {titles.slice(0, 8).map((t, i) => {
          const s = spring({ frame: frame - 6 - i * 5, fps, config: { damping: 14, stiffness: 120 } });
          return (
            <div key={i} style={{ display: "flex", gap: 16, alignItems: "center", opacity: s, transform: `translateX(${(1 - s) * 80}px)`, background: theme.card, borderRadius: 14, padding: "12px 18px" }}>
              <div style={{ fontSize: 34, fontWeight: 900, color: theme.red, width: 52 }}>{String(i + 1).padStart(2, "0")}</div>
              <div lang="tr" style={{ fontSize: 30, fontWeight: 700, lineHeight: 1.15, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{t}</div>
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};

const WideNews = ({ seg, index, total, dur }: { seg: Segment; index: number; total: number; dur: number }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const st = styleFor(seg.category);
  const inn = spring({ frame, fps, config: { damping: 15, stiffness: 110 } });
  const fade = interpolate(frame, [dur - 8, dur], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const progress = interpolate(frame, [0, dur], [0, 1], { extrapolateRight: "clamp" });
  const tSize = fitFontSize({ text: seg.title || "", maxWidth: 700, base: 68, min: 40, maxLines: 4, upper: false });
  return (
    <AbsoluteFill style={{ fontFamily: theme.font, color: theme.white, opacity: fade }}>
      {/* medya: sol, büyük */}
      <div style={{ position: "absolute", left: 48, top: 110, width: 1060, height: 840, borderRadius: 26, overflow: "hidden", background: theme.card, transform: `scale(${0.94 + 0.06 * inn})`, opacity: inn }}>
        {seg.image || seg.video ? (
          <>
            <MediaBg image={seg.image} video={seg.video} videoDuration={seg.videoDuration} durationInFrames={dur} />
            <div style={{ position: "absolute", inset: 0, background: "linear-gradient(180deg, rgba(11,15,26,0) 60%, rgba(11,15,26,.8) 100%)" }} />
            <div style={{ position: "absolute", left: 24, bottom: 18, fontSize: 24, color: "rgba(255,255,255,.8)", letterSpacing: 2 }}>{seg.video ? "VİDEO" : "FOTOĞRAF"}: {(seg.source || "KAYNAK").toUpperCase()}</div>
          </>
        ) : <Centered scale={1.1}><st.Illustration /></Centered>}
        {seg.breaking ? <div style={{ position: "absolute", top: 20, left: 20, background: theme.red, padding: "8px 20px", borderRadius: 10, fontSize: 30, fontWeight: 900, letterSpacing: 6 }}>SON DAKİKA</div> : null}
      </div>
      {/* metin: sağ */}
      <div style={{ position: "absolute", left: 1150, top: 110, width: 720, height: 840, display: "flex", flexDirection: "column", transform: `translateX(${(1 - inn) * 60}px)` }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ fontSize: 30, fontWeight: 800, letterSpacing: 5, color: st.accent, background: `${st.accent}22`, padding: "8px 20px", borderRadius: 12 }}>{seg.categoryLabel || st.label}</div>
          <div style={{ fontSize: 34, fontWeight: 800, color: theme.muted }}>{index + 1} / {total}</div>
        </div>
        <div lang="tr" style={{ marginTop: 30, fontSize: tSize, fontWeight: 900, lineHeight: 1.07, wordBreak: "keep-all" }}>{seg.title}</div>
        <div style={{ width: 120, height: 8, background: st.accent, borderRadius: 4, margin: "28px 0" }} />
        <WideCaptions words={seg.words} accent={st.accent} />
        <div style={{ marginTop: "auto", fontSize: 26, color: theme.muted }}>{seg.source ? `Kaynak: ${seg.source}` : ""}</div>
        <div style={{ marginTop: 14, height: 8, background: theme.card, borderRadius: 4 }}><div style={{ width: `${progress * 100}%`, height: "100%", background: st.accent, borderRadius: 4 }} /></div>
      </div>
    </AbsoluteFill>
  );
};

const WideOutro = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = spring({ frame: frame - 10, fps, config: { damping: 12, stiffness: 120 } });
  const icons = [YouTubeIcon, InstagramIcon, TikTokIcon];
  return (
    <AbsoluteFill style={{ fontFamily: theme.font, color: theme.white, alignItems: "center" }}>
      <div style={{ position: "absolute", top: 90, display: "flex", justifyContent: "center", width: "100%" }}><TurkeyMap width={820} /></div>
      <div style={{ position: "absolute", top: 560, width: "100%", textAlign: "center" }}>
        <div style={{ fontSize: 64, fontWeight: 900 }}>HER 5 SAATTE BİR GÜNDEM · HER AKŞAM GÜNÜN ÖZETİ</div>
        <div style={{ display: "inline-block", marginTop: 26, background: theme.red, padding: "12px 44px", borderRadius: 16, fontSize: 70, fontWeight: 900, transform: `scale(${s}) rotate(-2deg)` }}>ABONE OL</div>
        <div style={{ marginTop: 40, display: "flex", justifyContent: "center", gap: 70 }}>
          {icons.map((I, i) => <div key={i} style={{ opacity: interpolate(frame, [30 + i * 8, 44 + i * 8], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }) }}><I size={110} /></div>)}
        </div>
      </div>
    </AbsoluteFill>
  );
};

export const GunlukOzet = ({ episode }: { episode: Episode }) => {
  const haberler = episode.segments.filter((s) => s.kind === "haber");
  const first = haberler[0];
  let cursor = 0;
  return (
    <AbsoluteFill style={{ width: WIDE_W, height: WIDE_H }}>
      <Background />
      {episode.music ? <Audio src={staticFile(episode.music)} volume={(episode.musicVolume ?? 0.07) * 0.8} loop /> : null}
      {episode.segments.map((seg, i) => {
        const from = Math.round(cursor * FPS);
        const dur = Math.max(1, Math.round(seg.duration * FPS));
        cursor += seg.duration;
        const hi = haberler.indexOf(seg);
        const st = styleFor(seg.category);
        const sfx = seg.kind === "hook" ? "sfx/sondakika.wav" : seg.kind === "intro" ? "sfx/sting.wav" : seg.kind === "outro" ? "sfx/chime.wav" : st.sfx;
        const next = haberler.slice(hi + 1).map((h) => h.title || "").filter(Boolean);
        return (
          <Sequence key={i} from={from} durationInFrames={dur}>
            <Audio src={staticFile(seg.audio)} />
            <Audio src={staticFile(sfx)} volume={seg.kind === "haber" ? st.sfxVolume * 0.8 : 0.5} />
            {i > 0 ? <Sequence from={0} durationInFrames={WHOOSH}><Audio src={staticFile("sfx/whoosh.wav")} volume={0.3} /></Sequence> : null}
            {seg.kind === "hook" ? <WideHook seg={seg} e={episode} dur={dur} />
              : seg.kind === "intro" ? <WideIntro e={episode} titles={haberler.map((h) => h.title || "")} />
              : seg.kind === "outro" ? <WideOutro />
              : <WideNews seg={seg} index={hi} total={haberler.length} dur={dur} />}
            {seg.kind === "haber" ? <><TopBar e={episode} label="GÜNÜN ÖZETİ" /><Ticker items={next} /></> : null}
          </Sequence>
        );
      })}
      {episode.titles || first ? (
        <Sequence from={0} durationInFrames={1}>
          {/* ThumbWide 1280x720 için çizilir; 1920x1080'e 1,5 kat büyütülür */}
          <div style={{ position: "absolute", left: 0, top: 0, width: 1280, height: 720, transform: "scale(1.5)", transformOrigin: "top left" }}>
            <Thumb wide text={episode.titles?.cover || first?.title || ""} category={first?.category} breaking={false} image={first?.image}
              variant="A" dayLabel={episode.dayLabel} slotLabel="GÜNÜN ÖZETİ" timeRange={episode.timeRange} />
          </div>
        </Sequence>
      ) : null}
    </AbsoluteFill>
  );
};
