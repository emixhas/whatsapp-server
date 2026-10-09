import { CalculateMetadataFunction, Composition, staticFile } from "remotion";
import { GundemVideo } from "./GundemVideo";
import { GunlukOzet, WIDE_H, WIDE_W } from "./GunlukOzet";
import { Thumb } from "./Thumb";
import { Still } from "remotion";
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
  <>
  <Still id="Thumb" component={Thumb} width={WIDTH} height={HEIGHT} defaultProps={{ text: "Merkez Bankası faizi sabit tuttu", category: "finans", breaking: false, variant: "A" }} />
  <Still id="ThumbWide" component={Thumb} width={1280} height={720} defaultProps={{ text: "Merkez Bankası faizi sabit tuttu", category: "finans", breaking: false, variant: "A", wide: true }} />
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
  {/* günlük uzun özet: yatay, YouTube (pipeline GUNLUK=1) */}
  <Composition
    id="GunlukOzet"
    component={GunlukOzet}
    fps={FPS}
    width={WIDE_W}
    height={WIDE_H}
    durationInFrames={60 * FPS}
    defaultProps={{ episode: sampleEpisode }}
    calculateMetadata={calculateMetadata}
  />

  </>
);
