import { useCurrentFrame, useVideoConfig } from "remotion";
import { currentWord, Word } from "../captionGroups";
import { fitFontSize } from "../fit";
import { theme } from "../theme";

/** Yanan altyazı: TEK ve BÜYÜK kelime (kullanıcı kararı), söylendiği anda belirir (0,1 sn'de büyüyerek), bitince kalkar.
 *  Kategori renginde kutu, koyu yazı; uzun kelimede punto küçülür, kelime asla bölünmez. */
export const Captions = ({ words, accent, bottom = 300, top, size = 60 }: { words?: Word[]; accent: string; bottom?: number; top?: number; size?: number }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const cur = currentWord(words, frame / fps);
  if (!cur) return null;
  const fs = fitFontSize({ text: cur.word.w, maxWidth: 940, base: Math.round(size * 1.7), min: 48, maxLines: 1, letterSpacing: 1 });
  const pop = Math.min(1, Math.max(0, cur.age / 0.1));
  return (
    <div style={{ position: "absolute", left: 40, right: 40, ...(top !== undefined ? { top } : { bottom }), display: "flex", justifyContent: "center", fontFamily: theme.font }}>
      <span key={cur.idx} lang="tr" style={{
        fontSize: fs, fontWeight: 900, lineHeight: 1.1, whiteSpace: "nowrap", wordBreak: "keep-all", hyphens: "none",
        color: "#0B0F1A", background: accent, padding: "4px 26px", borderRadius: 18, textTransform: "uppercase", letterSpacing: 1,
        transform: `scale(${0.82 + 0.18 * pop})`, opacity: 0.4 + 0.6 * pop, boxShadow: "0 10px 30px rgba(0,0,0,.45)",
      }}>{cur.word.w}</span>
    </div>
  );
};
