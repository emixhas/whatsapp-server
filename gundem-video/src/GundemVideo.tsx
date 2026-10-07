import { AbsoluteFill, Audio, Sequence, staticFile } from "remotion";
import { styleFor } from "./categories";
import { Background } from "./scenes/Background";
import { Headline } from "./scenes/Headline";
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
      {episode.segments.map((seg, i) => {
        const from = Math.round(cursor * FPS);
        const dur = Math.max(1, Math.round(seg.duration * FPS));
        cursor += seg.duration;
        const haberIndex = haberler.indexOf(seg);
        const st = styleFor(seg.category);
        const sceneSfx = seg.kind === "intro" ? "sfx/sting.wav" : seg.kind === "outro" ? "sfx/chime.wav" : st.sfx;
        const sceneVol = seg.kind === "haber" ? st.sfxVolume : 0.5;
        return (
          <Sequence key={i} from={from} durationInFrames={dur}>
            {/* seslendirme */}
            <Audio src={staticFile(seg.audio)} />
            {/* sahne efekti: her sahne başında, sabit eşleme */}
            <Audio src={staticFile(sceneSfx)} volume={sceneVol} />
            {/* geçiş: sahneler arası whoosh (ilk sahne hariç) */}
            {i > 0 ? <Sequence from={0} durationInFrames={WHOOSH_FRAMES}><Audio src={staticFile("sfx/whoosh.wav")} volume={0.35} /></Sequence> : null}
            {seg.kind === "intro" ? (
              <Intro dateLabel={episode.dateLabel} episodeOfDay={episode.episodeOfDay} timeLabel={episode.timeLabel} />
            ) : seg.kind === "outro" ? (
              <Outro />
            ) : (
              <Headline index={haberIndex} total={haberler.length} title={seg.title ?? ""} narration={seg.narration} source={seg.source} category={seg.category} durationInFrames={dur} />
            )}
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
};
