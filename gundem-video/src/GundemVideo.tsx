import { AbsoluteFill, Audio, Sequence, staticFile } from "remotion";
import { styleFor } from "./categories";
import { Background } from "./scenes/Background";
import { Headline } from "./scenes/Headline";
import { Hook } from "./scenes/Hook";
import { Intro } from "./scenes/Intro";
import { Outro } from "./scenes/Outro";
import { Episode, FPS } from "./types";

const WHOOSH_FRAMES = 17; // 0.55 sn

export const GundemVideo = ({ episode }: { episode: Episode }) => {
  const haberler = episode.segments.filter((s) => s.kind === "haber");
  let cursor = 0;
  return (
    <AbsoluteFill>
      <Background />
      {/* müzik yatağı: formatın yatağı, düşük seviyede, döngülü */}
      {episode.music ? <Audio src={staticFile(episode.music)} volume={episode.musicVolume ?? 0.07} loop /> : null}
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
            {/* seslendirme */}
            <Audio src={staticFile(seg.audio)} />
            {/* sahne efekti: her sahne başında, sabit eşleme */}
            <Audio src={staticFile(sceneSfx)} volume={sceneVol} />
            {breakingSfx ? <Audio src={staticFile(breakingSfx)} volume={0.7} /> : null}
            {/* geçiş: sahneler arası whoosh (ilk sahne hariç) */}
            {i > 0 ? <Sequence from={0} durationInFrames={WHOOSH_FRAMES}><Audio src={staticFile("sfx/whoosh.wav")} volume={0.35} /></Sequence> : null}
            {seg.kind === "hook" ? (
              <Hook title={seg.title ?? ""} narration={seg.narration} category={seg.category} categoryLabel={seg.categoryLabel} breaking={seg.breaking} image={seg.imageTall || seg.image} video={seg.video} videoDuration={seg.videoDuration} words={seg.words} durationInFrames={dur} />
            ) : seg.kind === "intro" ? (
              <Intro dateLabel={episode.dateLabel} episodeOfDay={episode.episodeOfDay} timeLabel={episode.timeLabel} formatLabel={episode.formatLabel} words={seg.words} />
            ) : seg.kind === "outro" ? (
              <Outro words={seg.words} />
            ) : (
              <Headline index={haberIndex} total={haberler.length} title={seg.title ?? ""} narration={seg.narration} source={seg.source} category={seg.category} categoryLabel={seg.categoryLabel} breaking={seg.breaking} durationInFrames={dur} words={seg.words} image={seg.image} video={seg.video} videoDuration={seg.videoDuration} />
            )}
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
};
