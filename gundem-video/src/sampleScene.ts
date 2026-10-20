import { SvgSceneProps } from "./SvgScene";

/** Studio önizlemesi için örnek sahne (gerçek sahneleri Claude çizer, scripts/render_scenes.mjs props olarak verir). */
export const sampleScene: SvgSceneProps = {
  seconds: 6,
  count: 4,
  seed: 1,
  palette: ["#F1E3C6", "#5B4230", "#A33A2A", "#C9A97A"],
  svg: `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1080 1920' preserveAspectRatio='xMidYMid meet'>
<g class='r0'><path d='M60 1180 Q540 1150 1020 1185' fill='none' stroke='#5B4230' stroke-width='6' stroke-linecap='round'/><path d='M60 1185 L1020 1185 L1020 1920 L60 1920 Z' fill='#C9A97A' opacity='0.35'/></g>
<g class='r1'><path d='M150 1170 Q140 1080 190 1060 Q260 1040 280 1100 Q300 1150 270 1172' fill='#E9D8B8' stroke='#5B4230' stroke-width='6'/><circle cx='215' cy='1095' r='7' fill='#5B4230'/></g>
<g class='r2'><path d='M420 1172 Q410 1080 460 1060 Q530 1040 550 1100 Q570 1150 540 1172' fill='#E9D8B8' stroke='#5B4230' stroke-width='6'/><circle cx='485' cy='1095' r='7' fill='#5B4230'/></g>
<g class='r3'><path d='M1020 1160 Q860 1100 760 1150 Q700 1180 640 1150' fill='none' stroke='#A33A2A' stroke-width='22' stroke-linecap='round'/><circle cx='655' cy='1148' r='9' fill='#5B4230'/></g>
</svg>`,
};
