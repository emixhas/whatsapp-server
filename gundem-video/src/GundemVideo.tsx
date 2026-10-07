import { AbsoluteFill, Audio, Sequence, staticFile } from "remotion";
import { Background } from "./scenes/Background";
import { Headline } from "./scenes/Headline";
import { Intro } from "./scenes/Intro";
import { Outro } from "./scenes/Outro";
import { Episode, FPS } from "./types";

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
        return (
          <Sequence key={i} from={from} durationInFrames={dur}>
            <Audio src={staticFile(seg.audio)} />
            {seg.kind === "intro" ? (
              <Intro dateLabel={episode.dateLabel} episodeOfDay={episode.episodeOfDay} timeLabel={episode.timeLabel} />
            ) : seg.kind === "outro" ? (
              <Outro />
            ) : (
              <Headline index={haberIndex} total={haberler.length} title={seg.title ?? ""} narration={seg.narration} source={seg.source} durationInFrames={dur} />
            )}
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
};
