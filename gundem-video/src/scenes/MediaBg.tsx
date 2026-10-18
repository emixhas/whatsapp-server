import { Img, Loop, OffthreadVideo, Sequence, interpolate, staticFile, useCurrentFrame, useVideoConfig } from "remotion";

type Props = {
  image?: string; images?: string[]; video?: string; videoDuration?: number; videoStart?: number; durationInFrames: number; zoomFrom?: number; zoomTo?: number };

const FADE = 10; // slayt geçişi: çapraz kararma (kare)
// Ken Burns odak yolu (yüzde): yakınlaşma odağı kaydıkça görüntü hafifçe kayar; ölçek ≥ 1 olduğu için kenar açılmaz
const PANS = [
  [[38, 42], [62, 58]],
  [[64, 38], [36, 62]],
  [[50, 68], [50, 32]],
  [[34, 62], [66, 40]],
];
const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;

/**
 * Haber medyası: video varsa sessiz ve döngülü oynar (aynı haberin videosu başka bölümde de oynuyorsa `videoStart`
 * saniyesinden başlar, video bitince baştan döner); yoksa birden çok fotoğraf slayt olur: her biri eşit süre, sırayla
 * yakınlaş/uzaklaş + farklı yöne kayan Ken Burns, aralarında FADE karelik çapraz kararma. Tek fotoğraf yavaşça yakınlaşır.
 */
export const MediaBg = ({ image, images, video, videoDuration, videoStart = 0, durationInFrames, zoomFrom = 1.04, zoomTo = 1.12 }: Props) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const zoom = interpolate(frame, [0, durationInFrames], [zoomFrom, zoomTo]);
  const fill = { position: "absolute" as const, inset: 0, width: "100%", height: "100%", objectFit: "cover" as const };
  if (video) {
    const clip = Math.max(30, Math.floor((videoDuration || 8) * fps) - 2);
    const style = { ...fill, transform: `scale(${1 + (zoom - 1) / 3})` };
    const loop = (
      <Loop durationInFrames={clip} layout="none">
        <OffthreadVideo src={staticFile(video)} muted style={style} />
      </Loop>
    );
    // en az 1 sn görüntü kalmıyorsa baştan oynar
    const skip = Math.round(videoStart * fps);
    if (skip <= 0 || skip > clip - fps) return loop;
    return (
      <>
        <Sequence durationInFrames={clip - skip} layout="none">
          <OffthreadVideo src={staticFile(video)} muted trimBefore={skip} style={style} />
        </Sequence>
        <Sequence from={clip - skip} layout="none">{loop}</Sequence>
      </>
    );
  }
  const list = (images || []).filter(Boolean);
  if (list.length > 1) {
    const per = durationInFrames / list.length;
    const fade = Math.min(FADE, Math.floor(per / 3));
    return (
      <>
        {list.map((src, k) => {
          const a = Math.round(k * per);
          const b = k === list.length - 1 ? durationInFrames : Math.round((k + 1) * per) + fade; // sonraki fotoğraf üstüne binene kadar
          const t = interpolate(frame, [a, b], [0, 1], clamp);
          const [z0, z1] = k % 2 === 0 ? [zoomFrom, zoomTo] : [zoomTo, zoomFrom];
          const [[x0, y0], [x1, y1]] = PANS[k % PANS.length];
          const opacity = frame >= b ? 0 : k === 0 ? 1 : interpolate(frame, [a, a + fade], [0, 1], clamp);
          return (
            <Img key={k} src={staticFile(src)} style={{ ...fill, opacity, transform: `scale(${z0 + (z1 - z0) * t})`,
              transformOrigin: `${x0 + (x1 - x0) * t}% ${y0 + (y1 - y0) * t}%` }} />
          );
        })}
      </>
    );
  }
  const one = list[0] || image;
  if (one) return <Img src={staticFile(one)} style={{ ...fill, transform: `scale(${zoom})` }} />;
  return null;
};
