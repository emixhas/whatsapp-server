import { interpolate, useCurrentFrame } from "remotion";
import { BOX, useEnter } from "./common";

const C = "#E040FB";
const P = 45;     // klaket 1,5 sn'de bir çarpar
const SNAP = 6;   // ilk çarpma 0,2 sn'de: sfx/sinema.wav'daki tak sesiyle aynı kare
const OPEN = 25;  // açık klaket kolunun açısı (daha fazlasında uç kutudan taşar)

/** Klaket kolunun açısı: yavaş açılır, bekler, 3 karede hızlanarak kapanır, çarpınca hafif seker. */
const armAngle = (p: number) => {
  if (p >= P - 3) return -OPEN * (1 - ((p - (P - 3)) / 3) ** 2);
  if (p < 10) return -5 * Math.abs(Math.sin(p * 0.9)) * Math.exp(-p / 2.5);
  return -OPEN * (1 - (1 - (p - 10) / (P - 13)) ** 3);
};

/** Çizgili klaket şeridi: beyaz zemin, vurgu renginde eğik şeritler (kol ile alt çıta zıt yönde, kapanınca ok gibi birleşir). */
const Stripes = ({ y, slant, id }: { y: number; slant: number; id: string }) => (
  <>
    <defs><clipPath id={id}><rect x={170} y={y} width={380} height={36} rx={6} /></clipPath></defs>
    <g clipPath={`url(#${id})`}>
      <rect x={170} y={y} width={380} height={36} fill="#FFFFFF" />
      {Array.from({ length: 8 }, (_, i) => {
        const x = 150 + i * 56;
        return <polygon key={i} points={`${x},${y} ${x + 28},${y} ${x + 28 + slant},${y + 36} ${x + slant},${y + 36}`} fill={C} />;
      })}
    </g>
  </>
);

/** Sinema: çarpan klaket, kayan film şeridi, titreyen projeksiyon ışığı (kullanıcı isteği, 18 Ekim: "bir filmin fragmanını
 *  analiz edip kullanıcıların aşırı dikkatini çekecek bir yapıda kurmamız lazım"). Klaket sfx/sinema.wav'daki tak sesiyle çarpar. */
export const Sinema = () => {
  const frame = useCurrentFrame();
  const pop = useEnter(0, 13);
  const p = (((frame - SNAP) % P) + P) % P; // son çarpmadan beri geçen kare
  const angle = armAngle(p);
  const hit = p < 9 ? 1 - p / 9 : 0;
  const punch = 1 + 0.05 * Math.exp(-p / 3);
  const shake = p < 8 ? Math.sin(p * 2.5) * (8 - p) * 0.8 : 0;
  // projektör ilk çarpmayla yanar, sonra film ışığı gibi titrer
  const beam = interpolate(frame, [SNAP, SNAP + 6], [0.25, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })
    * (0.8 + 0.12 * Math.sin(frame * 1.7) + 0.08 * Math.sin(frame * 4.3));
  const scroll = (frame * 5) % 110;
  return (
    <svg width={BOX.width} height={BOX.height} viewBox={`0 0 ${BOX.width} ${BOX.height}`}>
      <defs>
        <linearGradient id="sinema-beam" x1="1" x2="0" y1="0" y2="0.3">
          <stop offset="0" stopColor="#FFFFFF" stopOpacity="0.55" />
          <stop offset="0.45" stopColor={C} stopOpacity="0.22" />
          <stop offset="1" stopColor={C} stopOpacity="0" />
        </linearGradient>
      </defs>
      {/* projeksiyon ışığı + içinde süzülen toz */}
      <polygon points="650,128 650,156 -20,500 -20,60" fill="url(#sinema-beam)" opacity={beam} />
      {Array.from({ length: 12 }, (_, k) => {
        const t = (frame * 0.006 + k * 0.083) % 1;
        const spread = ((k * 7) % 11) / 5 - 1;
        const x = 650 - t * 640;
        const y = 142 + t * 120 + spread * t * 170 + 6 * Math.sin(frame / 9 + k);
        return <circle key={k} cx={x} cy={y} r={2.5 + (k % 3)} fill="#FFFFFF" opacity={beam * Math.min(1, t * 6) * (1 - t) * 0.8} />;
      })}

      {/* projektör: dönen iki makara + gövde + mercek */}
      {[735, 835].map((cx, i) => (
        <g key={cx} transform={`translate(${cx} 58) rotate(${frame * (i ? 7 : 9)})`}>
          <circle r={44} fill="#1E2A4A" stroke="#9AA4BF" strokeWidth={6} />
          {[0, 120, 240].map((a) => <circle key={a} r={11} cx={24 * Math.cos((a * Math.PI) / 180)} cy={24 * Math.sin((a * Math.PI) / 180)} fill="#0B0F1A" />)}
          <circle r={8} fill={C} />
        </g>
      ))}
      <rect x={700} y={96} width={170} height={92} rx={16} fill="#2E3F6B" />
      <rect x={724} y={120} width={96} height={12} rx={6} fill="#1E2A4A" />
      <rect x={724} y={146} width={64} height={12} rx={6} fill="#1E2A4A" />
      <rect x={662} y={120} width={44} height={44} rx={8} fill="#1E2A4A" />
      <circle cx={662} cy={142} r={18} fill="#FFFFFF" opacity={0.5 + 0.5 * beam} />

      {/* kayan film şeridi */}
      <g transform="rotate(-4 460 505)">
        <rect x={-60} y={468} width={1040} height={76} fill="#2E3F6B" />
        <g transform={`translate(${-scroll} 0)`}>
          {Array.from({ length: 12 }, (_, k) => (
            <g key={k}>
              <rect x={-110 + k * 110 + 9} y={486} width={92} height={40} rx={5} fill={C} opacity={k % 2 ? 0.75 : 0.45} />
              {[0, 1, 2, 3].map((h) => (
                <g key={h}>
                  <rect x={-110 + k * 110 + 6 + h * 27} y={473} width={14} height={8} rx={2} fill="#0B0F1A" />
                  <rect x={-110 + k * 110 + 6 + h * 27} y={531} width={14} height={8} rx={2} fill="#0B0F1A" />
                </g>
              ))}
            </g>
          ))}
        </g>
      </g>

      {/* klaket (biraz sağda: projektörle arası dengeli dursun) */}
      <g transform={`translate(${40 + shake} 6) translate(360 330) scale(${pop * punch}) translate(-360 -330)`}>
        {/* tahta: sahne / çekim / rulo + tebeşir satırları */}
        <rect x={170} y={232} width={380} height={200} rx={14} fill="#1E2A4A" />
        <g stroke="#9AA4BF" strokeWidth={3} opacity={0.7}>
          <line x1={170} y1={300} x2={550} y2={300} />
          <line x1={170} y1={366} x2={550} y2={366} />
          <line x1={297} y1={232} x2={297} y2={300} />
          <line x1={424} y1={232} x2={424} y2={300} />
        </g>
        {[["SAHNE", "12"], ["ÇEKİM", "3"], ["RULO", "A"]].map(([label, value], i) => (
          <g key={label}>
            <text x={233 + i * 127} y={254} textAnchor="middle" fontFamily="Inter, Arial" fontWeight={800} fontSize={17} fill="#9AA4BF" letterSpacing={2}>{label}</text>
            <text x={233 + i * 127} y={290} textAnchor="middle" fontFamily="Inter, Arial" fontWeight={900} fontSize={34} fill="#FFFFFF">{value}</text>
          </g>
        ))}
        <rect x={196} y={322} width={210} height={14} rx={7} fill="#9AA4BF" opacity={0.6} />
        <rect x={196} y={344} width={140} height={10} rx={5} fill="#9AA4BF" opacity={0.4} />
        <rect x={196} y={388} width={300} height={14} rx={7} fill="#9AA4BF" opacity={0.6} />
        <rect x={196} y={410} width={180} height={10} rx={5} fill="#9AA4BF" opacity={0.4} />
        {/* alt çıta (sabit) */}
        <Stripes y={196} slant={-20} id="sinema-bar" />
        {/* kol: menteşe çevresinde döner */}
        <g transform={`rotate(${angle} 178 196)`}>
          <g transform="translate(0 -36)"><Stripes y={196} slant={20} id="sinema-arm" /></g>
        </g>
        <circle cx={178} cy={196} r={13} fill={C} />
        <circle cx={178} cy={196} r={5} fill="#0B0F1A" />
        {/* çarpma anı: kolun ucunda kıvılcım çizgileri */}
        {hit > 0 ? (
          <g transform="translate(562 192)" opacity={hit}>
            {[-70, -35, 0, 35].map((a) => (
              <line key={a} x1={20 + (1 - hit) * 16} y1={0} x2={52 + (1 - hit) * 30} y2={0} stroke="#FFFFFF" strokeWidth={8} strokeLinecap="round" transform={`rotate(${a})`} />
            ))}
          </g>
        ) : null}
      </g>
    </svg>
  );
};
