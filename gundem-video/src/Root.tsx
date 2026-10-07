import { CalculateMetadataFunction, Composition, staticFile } from "remotion";
import { GundemVideo } from "./GundemVideo";
import { Episode, FPS, HEIGHT, WIDTH } from "./types";
import { sampleEpisode } from "./sampleEpisode";

type Props = { episode: Episode };

const calculateMetadata: CalculateMetadataFunction<Props> = async ({ props }) => {
  let episode = props.episode;
  try {
    const res = await fetch(staticFile("episode.json"));
    if (res.ok) episode = (await res.json()) as Episode;
  } catch {
    // public/episode.json yoksa örnek bölüm kullanılır (studio için).
  }
  const total = episode.segments.reduce((s, x) => s + x.duration, 0);
  return {
    props: { episode },
    durationInFrames: Math.max(FPS, Math.ceil(total * FPS)),
  };
};

export const Root = () => (
  <Composition
    id="GundemVideo"
    component={GundemVideo}
    fps={FPS}
    width={WIDTH}
    height={HEIGHT}
    durationInFrames={30 * FPS}
    defaultProps={{ episode: sampleEpisode }}
    calculateMetadata={calculateMetadata}
  />
);
