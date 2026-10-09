import { Img, Loop, OffthreadVideo, interpolate, staticFile, useCurrentFrame, useVideoConfig } from "remotion";

type Props = { image?: string; video?: string; videoDuration?: number; durationInFrames: number; zoomFrom?: number; zoomTo?: number };

/** Haber medyası: video varsa sessiz ve döngülü oynar, yoksa fotoğraf yavaşça yakınlaşır (Ken Burns). */
export const MediaBg = ({ image, video, videoDuration, durationInFrames, zoomFrom = 1.04, zoomTo = 1.12 }: Props) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const zoom = interpolate(frame, [0, durationInFrames], [zoomFrom, zoomTo]);
  const fill = { position: "absolute" as const, inset: 0, width: "100%", height: "100%", objectFit: "cover" as const };
  if (video) {
    const clip = Math.max(30, Math.floor((videoDuration || 8) * fps) - 2);
    return (
      <Loop durationInFrames={clip} layout="none">
        <OffthreadVideo src={staticFile(video)} muted style={{ ...fill, transform: `scale(${1 + (zoom - 1) / 3})` }} />
      </Loop>
    );
  }
  if (image) return <Img src={staticFile(image)} style={{ ...fill, transform: `scale(${zoom})` }} />;
  return null;
};
