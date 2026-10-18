import { AbsoluteFill, Audio, Sequence, staticFile } from "remotion";
import { styleFor } from "./categories";
import { Background } from "./scenes/Background";
import { FullFrame } from "./scenes/FullFrame";
import { Headline } from "./scenes/Headline";
import { Hook } from "./scenes/Hook";
import { Intro } from "./scenes/Intro";
import { Outro } from "./scenes/Outro";
import { Thumb } from "./Thumb";
import { setCaptionLead } from "./captionGroups";
import { Episode, FPS } from "./types";

const WHOOSH_FRAMES = 17; // 0.55 sn

/** Kapak yazısı: render_thumbs.py ile aynı kural (A varyantı kapak vuruşu, B merak başlığı). */
export const coverText = (e: Episode) => {
  const t = e.titles || {}; const first = e.segments.find((s) => s.kind === "haber");
  return (e.titleVariant === "B" ? t.B || t.cover : t.cover) || first?.title || "";
};

export const GundemVideo = ({ episode }: { episode: Episode }) => {
  setCaptionLead(episode.captionLead);
  const haberler = episode.segments.filter((s) => s.kind === "haber");
  const first = haberler[0];
  // müzik yatağı: orijinal sesli bölüm varsa o sırada susar (video kendi sesiyle izlensin); sesli bölümler arası parçalarda çalar
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
    <AbsoluteFill>
      <Background />
      {/* müzik yatağı: formatın yatağı, düşük seviyede, döngülü */}
      {episode.music ? runs.map(([a, b], k) => (
        <Sequence key={`m${k}`} from={Math.round(a * FPS)} durationInFrames={Math.max(1, Math.round((b - a) * FPS))}>
          <Audio src={staticFile(episode.music!)} volume={episode.musicVolume ?? 0.07} loop />
        </Sequence>
      )) : null}
      {episode.segments.map((seg, i) => {
        const from = Math.round(cursor * FPS);
        const dur = Math.max(1, Math.round(seg.duration * FPS));
        cursor += seg.duration;
        const haberIndex = haberler.indexOf(seg);
        const st = styleFor(seg.category);
        const sceneSfx = seg.kind === "hook" ? "sfx/sondakika.wav" : seg.kind === "intro" ? "sfx/sting.wav" : seg.kind === "outro" ? "sfx/chime.wav" : st.sfx;
        const breakingSfx = seg.kind === "haber" && seg.breaking ? "sfx/sondakika.wav" : null;
        const sceneVol = seg.kind === "haber" ? st.sfxVolume : seg.kind === "hook" ? 0.75 : 0.5;
        return (
          <Sequence key={i} from={from} durationInFrames={dur}>
            {/* seslendirme (sesli bölümde yok: videonun kendi sesi çalar) */}
            {seg.kind === "sesli" ? null : <Audio src={staticFile(seg.audio)} />}
            {/* sahne efekti: her sahne başında, sabit eşleme */}
            {seg.kind === "sesli" ? null : <Audio src={staticFile(sceneSfx)} volume={sceneVol} />}
            {breakingSfx ? <Audio src={staticFile(breakingSfx)} volume={0.7} /> : null}
            {/* geçiş: sahneler arası whoosh (ilk sahne hariç) */}
            {i > 0 ? <Sequence from={0} durationInFrames={WHOOSH_FRAMES}><Audio src={staticFile("sfx/whoosh.wav")} volume={0.35} /></Sequence> : null}
            {seg.kind === "hook" ? (
              <Hook title={seg.title ?? ""} narration={seg.narration} category={seg.category} categoryLabel={seg.categoryLabel} breaking={seg.breaking} image={seg.imageTall || seg.image}
                images={seg.imagesTall?.length ? seg.imagesTall : seg.images} video={seg.video} videoDuration={seg.videoDuration} videoStart={seg.videoStart} words={seg.words} durationInFrames={dur} />
            ) : seg.kind === "intro" ? (
              <Intro dateLabel={episode.dateLabel} episodeOfDay={episode.episodeOfDay} timeLabel={episode.timeLabel} formatLabel={episode.formatLabel} dayLabel={episode.dayLabel}
                slotLabel={episode.slotLabel} timeRange={episode.timeRange} scheduleHours={episode.scheduleHours} anlik={episode.anlik || episode.format === "anlik"} words={seg.words} />
            ) : seg.kind === "outro" ? (
              <Outro words={seg.words} />
            ) : seg.kind === "sesli" || seg.fullFrame ? (
              <FullFrame index={seg.displayIndex != null ? seg.displayIndex - 1 : Math.max(0, haberIndex)} total={haberler.length} title={seg.title ?? ""} source={seg.source}
                category={seg.category} categoryLabel={seg.categoryLabel} breaking={seg.breaking} durationInFrames={dur} words={seg.words}
                video={seg.video} videoDuration={seg.videoDuration} sound={seg.kind === "sesli"} />
            ) : (
              <Headline index={seg.displayIndex != null ? seg.displayIndex - 1 : haberIndex} total={haberler.length} title={seg.title ?? ""} narration={seg.narration} source={seg.source} category={seg.category} categoryLabel={seg.categoryLabel} breaking={seg.breaking} durationInFrames={dur} words={seg.words} image={seg.image}
                images={seg.images} video={seg.video} videoDuration={seg.videoDuration} videoStart={seg.videoStart} infoCard={seg.infoCard} />
            )}
          </Sequence>
        );
      })}
      {/* İlk kare = kapak (tek kare, 33 ms). TikTok ve Instagram varsayılan kapağı ilk kareden alır; kapak
          render edilemezse render_thumbs.py da kapağı bu kareden çıkarır. */}
      {episode.titles || first ? (
        <Sequence from={0} durationInFrames={1}>
          <Thumb text={coverText(episode)} category={first?.category} breaking={!!first?.breaking} image={first?.imageTall || first?.image}
            variant={episode.titleVariant || "A"} dayLabel={episode.dayLabel} slotLabel={episode.slotLabel} timeRange={episode.timeRange} />
        </Sequence>
      ) : null}
    </AbsoluteFill>
  );
};
