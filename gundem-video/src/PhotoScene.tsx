import { AbsoluteFill, CalculateMetadataFunction, Easing, Img, interpolate, random, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { theme } from "./theme";
import { FPS } from "./types";

/**
 * Benzer videonun GERÇEKÇİ sahnesi (kullanıcı isteği, 27 Ekim: "benzerini sıfırdan yap gönderilerimiz çok basit çizimlerle oluyor; rakipler
 * çok gerçekçi üretiyor"): sahnenin yapay zekâ ile üretilmiş fotoğrafları (scripts/image_gen.py, Mac'te yerel Z-Image-Turbo) sinematik
 * hareketle oynar. Çekimler seslendirme süresine (seconds) eşit bölünür, son çekim bekleme (hold) boyunca sürer; her çekimde tohuma göre
 * yavaş yakınlaşma ya da uzaklaşma + hafif kayma ve dönme, çekimler arası 14 karelik çapraz geçiş; üstünde hafif renk düzeltmesi, gezinen
 * sıcak ışık, vinyet ve film greni. Sağ altta küçük "yapay zekâ ile canlandırıldı" etiketi (badge; boşsa yok): gerçek görüntü sanılmasın.
 * scripts/render_scenes.mjs sessiz mp4'e çizer (SvgScene gibi; FullFrame oynatır).
 * Hareket ölçülü (28 Ekim, "görseller çok çok gerçekçi olsun" isteği; araştırma): ölçek 1,045-1,10 (eskiden 1,04-1,17: en yakında 1080
 * piksellik kareye ~615 özgün piksel düşüyordu), kayma en çok ±15/±20 px, dönme en çok ±0,5°: 1152x2048 kare en yakında bile neredeyse
 * birebir örneklenir. Kenar açılmaz: en kötü anda (tam dönme + tam kayma) gereken ölçek cos θ + (1920/1080) sin θ + 15/540 ≈ 1,043, en
 * küçük ölçek 1,045. Işık, gren ve renk düzeltmesi hafif: fotoğrafın kendi ışığını ve dokusunu bozmasın.
 */
export type PhotoSceneProps = {
  /** public/ altına göre sahnenin fotoğrafları (9:16 jpg: 1152x2048, eski kurulumda 1080x1920) */
  images: string[];
  /** seslendirme süresi, sn: çekimler bu süreye bölünür */
  seconds: number;
  /** sona eklenen bekleme, sn (klip = seconds + hold); son çekim sürer */
  hold?: number;
  /** kamera hareketi ve ışık için sabit tohum (sahne sırası) */
  seed?: number;
  /** köşe etiketi; boş dize etiketsiz */
  badge?: string;
};

const XFADE = 14;

export const calculatePhotoSceneMetadata: CalculateMetadataFunction<PhotoSceneProps> = ({ props }) => ({
  durationInFrames: Math.max(1, Math.ceil(((Number(props.seconds) || 4) + Math.max(0, Math.min(30, Number(props.hold) || 0))) * FPS)),
});

const shotMove = (k: number, seed: number) => {
  const r = (n: string) => random(`ph-${seed}-${k}-${n}`);
  const zoomIn = r("z") < 0.62;
  return { s0: zoomIn ? 1.045 : 1.1, s1: zoomIn ? 1.1 : 1.05, dx: (r("x") - 0.5) * 60, dy: (r("y") - 0.5) * 80, rot: (r("r") - 0.5) * 1.0 };
};

const grain = (n: number) =>
  `url("data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' width='540' height='960'><filter id='g'><feTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2' seed='${n}' stitchTiles='stitch'/><feColorMatrix type='saturate' values='0'/></filter><rect width='540' height='960' filter='url(#g)'/></svg>`)}")`;

export const PhotoScene = ({ images, seconds, seed = 1, badge = "Yapay zekâ ile canlandırıldı" }: PhotoSceneProps) => {
  const frame = useCurrentFrame();
  const { durationInFrames, fps } = useVideoConfig();
  const list = (Array.isArray(images) ? images : []).filter((x) => typeof x === "string" && x);
  const s = Math.abs(Math.round(Number(seed) || 0)) % 997;
  const speak = Math.max(1, Math.min(durationInFrames, Math.round((Number(seconds) || durationInFrames / fps) * fps)));
  const per = Math.max(1, Math.floor(speak / Math.max(1, list.length)));
  const ease = Easing.inOut(Easing.sin);
  const layers = list.map((src, k) => {
    const a = k * per;
    const b = k + 1 < list.length ? (k + 1) * per + XFADE : durationInFrames;
    if (frame < a || frame > b) return null;
    const p = ease(interpolate(frame, [a, Math.max(a + 1, b)], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }));
    const m = shotMove(k, s);
    const sc = m.s0 + (m.s1 - m.s0) * p;
    const op = k === 0 ? 1 : interpolate(frame, [a, a + XFADE], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
    return (
      <AbsoluteFill key={k} style={{ opacity: op }}>
        <Img src={staticFile(src)} style={{ width: "100%", height: "100%", objectFit: "cover",
          transform: `translate(${(m.dx * (p - 0.5)).toFixed(2)}px, ${(m.dy * (p - 0.5)).toFixed(2)}px) scale(${sc.toFixed(4)}) rotate(${(m.rot * p).toFixed(3)}deg)`,
          filter: "contrast(1.04) saturate(1.04) brightness(1.01)" }} />
      </AbsoluteFill>
    );
  });
  const t = frame / fps;
  const lx = 50 + 40 * Math.sin(t * 0.35 + s), ly = 30 + 25 * Math.cos(t * 0.27 + s * 0.7);
  const badgeIn = interpolate(frame, [6, 18], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return (
    <AbsoluteFill style={{ background: "#0b0d12", overflow: "hidden" }}>
      {layers}
      <AbsoluteFill style={{ background: `radial-gradient(circle at ${lx.toFixed(1)}% ${ly.toFixed(1)}%, rgba(255,176,96,.07), rgba(255,176,96,0) 46%)`, mixBlendMode: "screen" }} />
      <AbsoluteFill style={{ background: "radial-gradient(ellipse at 50% 42%, rgba(0,0,0,0) 52%, rgba(0,0,0,.5) 100%)" }} />
      <AbsoluteFill style={{ opacity: 0.06, mixBlendMode: "overlay", backgroundImage: grain(Math.floor(frame / 2) % 40 + s), backgroundSize: "540px 960px" }} />
      {badge ? (
        <div style={{ position: "absolute", right: 34, top: 1232, padding: "8px 18px", borderRadius: 999, background: "rgba(0,0,0,.58)",
          color: "rgba(255,255,255,.92)", fontFamily: theme.font, fontSize: 28, fontWeight: 700, letterSpacing: 0.5, opacity: badgeIn }}>
          🤖 {badge}
        </div>
      ) : null}
    </AbsoluteFill>
  );
};
