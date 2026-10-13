import { useCurrentFrame, useVideoConfig } from "remotion";
import { currentGroup, Word } from "../captionGroups";
import { fitFontSize } from "../fit";
import { theme } from "../theme";

/** Yanan altyazı: en çok 3 kelimelik grup; kelimeler söylendikçe eklenir (hafif büyüyerek), konuşulan kelime vurgulu.
 *  Sonraki kelimeler yer tutar ama görünmez: satır söylendikçe kaymaz. */
export const Captions = ({ words, accent, bottom = 300, top, size = 60 }: { words?: Word[]; accent: string; bottom?: number; top?: number; size?: number }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  if (!words || !words.length) return null;
  const t = frame / fps + 0.06; // altyazı sesten bir kare önde: göz okumaya sesle aynı anda başlasın
  const { idx, start, end } = currentGroup(words, t);
  const slice = words.slice(start, end);
  // Grup TEK satırda: sığmazsa yazı küçülür (en az 40 px); kelime asla ortadan bölünmez
  const fs = fitFontSize({ text: slice.map((w) => w.w).join(" "), maxWidth: 940, base: size, min: 40, maxLines: 1, letterSpacing: 1 });
  return (
    <div style={{ position: "absolute", left: 50, right: 50, ...(top !== undefined ? { top } : { bottom }), display: "flex", flexWrap: "wrap", justifyContent: "center", gap: "4px 18px", fontFamily: theme.font, lineHeight: 1.15 }}>
      {slice.map((w, i) => {
        const gi = start + i;
        const active = gi === idx;
        const shown = gi <= idx;
        const pop = shown ? Math.min(1, Math.max(0, (t - w.s) / 0.12)) : 0; // söylenince 0,12 sn'de belirir
        return (
          <span key={gi} lang="tr" style={{
            fontSize: fs, fontWeight: 900, whiteSpace: "nowrap", wordBreak: "keep-all", overflowWrap: "normal", hyphens: "none",
            color: active ? "#0B0F1A" : theme.white, opacity: shown ? 0.35 + 0.65 * pop : 0,
            background: active ? accent : "transparent", padding: active ? "2px 14px" : "2px 0", borderRadius: 14,
            transform: `scale(${(active ? 1.08 : 1) * (0.85 + 0.15 * pop)})`,
            textShadow: active ? "none" : "0 2px 12px rgba(0,0,0,.8)", textTransform: "uppercase", letterSpacing: 1,
          }}>{w.w}</span>
        );
      })}
    </div>
  );
};
