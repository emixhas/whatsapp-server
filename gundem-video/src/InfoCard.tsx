import { AbsoluteFill } from "remotion";
import { fitFontSize, trUpper } from "./fit";
import { MAP_H, MAP_PATH, MAP_W, project } from "./scenes/TurkeyMap";
import { theme } from "./theme";

/**
 * Bilgi kartı (haber fotoğrafı yerine kodla çizilen görsel): deprem haritası, maç skoru, piyasa tablosu, takvim günü.
 * scripts/info_card.py iki boyutta still olarak çizer: "InfoCard" 1840x1120 (haber kartı, ekranda 920x560) ve
 * "InfoCardTall" 1080x1920 (kanca). fetch_images bu kartları haberin görseli yapar; video/fotoğraf aranmaz.
 * Kenarlarda ~%8 boşluk bırakılır: MediaBg fotoğrafı yavaşça yakınlaştırır (Ken Burns), kenarlar kırpılır.
 */
export type InfoCardProps = {
  kind: "quake" | "score" | "market" | "calendar" | "weather" | "ranking";
  tall?: boolean;
  /** üst etiket: "DEPREM", "MAÇ SONUCU", "PİYASALAR", "TAKVİM" */ label?: string;
  /** etiketin yanındaki tarih/saat */ stamp?: string;
  title?: string;
  sub?: string;
  quake?: { mag: number; lat: number; lon: number; place: string; time: string; depth?: number; source?: string };
  score?: { home: string; away: string; hs: number; as: number; league?: string; goals?: { side: "home" | "away"; player: string; minute: string }[]; note?: string };
  rows?: { name: string; value: string; change?: number | null }[];
  date?: { day: string; month: string; weekday?: string };
  weather?: { level: "yellow" | "orange" | "red"; type: string; points: { name: string; lat: number; lon: number }[] };
  /** haftanın en çok izlenenleri: sıra, başlık, izlenme */ ranking?: { title: string; views?: string }[];
};

const YELLOW = "#FFD400";
const GREEN = "#2ECC71";
const stroke = (w: number) => ({ WebkitTextStroke: `${w}px #000`, paintOrder: "stroke fill" as const });
const num = (x: number, d = 1) => x.toLocaleString("tr-TR", { minimumFractionDigits: d, maximumFractionDigits: d });

const Frame = ({ tall, label, stamp, accent, children }: { tall?: boolean; label?: string; stamp?: string; accent: string; children: React.ReactNode }) => (
  <AbsoluteFill style={{ background: `radial-gradient(ellipse at 50% 45%, ${theme.bgAccent} 0%, ${theme.bg} 70%)`, fontFamily: theme.font, color: theme.white }}>
    <AbsoluteFill style={{ background: `radial-gradient(circle at 50% ${tall ? 58 : 50}%, ${accent}33 0%, transparent 55%)` }} />
    {/* ince ızgara: haber stüdyosu ekranı hissi */}
    <AbsoluteFill style={{ backgroundImage: "linear-gradient(rgba(255,255,255,.035) 2px, transparent 2px), linear-gradient(90deg, rgba(255,255,255,.035) 2px, transparent 2px)", backgroundSize: "80px 80px" }} />
    {label ? (
      <div style={{ position: "absolute", top: tall ? 240 : 120, left: tall ? 90 : 150, display: "flex", alignItems: "center", gap: 24 }}>
        <div style={{ background: accent, color: accent === YELLOW ? "#000" : theme.white, fontWeight: 900, fontSize: tall ? 52 : 64, letterSpacing: 4, padding: "10px 28px", transform: "skewX(-8deg)", boxShadow: `0 0 40px ${accent}88` }}>{trUpper(label)}</div>
        {stamp ? <div style={{ fontWeight: 800, fontSize: tall ? 44 : 54, color: YELLOW }}>{stamp}</div> : null}
      </div>
    ) : null}
    {children}
  </AbsoluteFill>
);

const Quake = ({ p }: { p: InfoCardProps }) => {
  const q = p.quake!;
  const tall = !!p.tall;
  const [x, y] = project([q.lon, q.lat]);
  const mapW = tall ? 980 : 1080;
  const k = mapW / MAP_W;
  const color = q.mag >= 6 ? theme.red : q.mag >= 5 ? "#FF6A00" : "#FFB020";
  const mapTop = tall ? 980 : 300;
  const mapLeft = tall ? 50 : 120;
  const cx = Math.max(-40, Math.min(MAP_W + 40, x)), cy = Math.max(-40, Math.min(MAP_H + 40, y));
  return (
    <Frame tall={tall} label={p.label || "DEPREM"} stamp={p.stamp} accent={color}>
      <svg style={{ position: "absolute", left: mapLeft, top: mapTop, overflow: "visible" }} width={mapW} height={MAP_H * k} viewBox={`0 0 ${MAP_W} ${MAP_H}`}>
        <path d={MAP_PATH} fill="#1C2742" stroke="#6F84B8" strokeWidth={3} fillRule="evenodd" />
        {[150, 105, 64].map((r, i) => <circle key={r} cx={cx} cy={cy} r={r} fill="none" stroke={color} strokeWidth={6 - i} opacity={0.25 + i * 0.25} />)}
        <circle cx={cx} cy={cy} r={26} fill={color} stroke="#fff" strokeWidth={6} />
      </svg>
      {/* büyüklük: dev rakam */}
      <div style={{ position: "absolute", ...(tall ? { left: 0, right: 0, top: 1420, textAlign: "center" as const } : { right: 150, top: 300, textAlign: "right" as const }) }}>
        <div style={{ fontSize: tall ? 60 : 64, fontWeight: 800, color: theme.muted, letterSpacing: 3 }}>BÜYÜKLÜK</div>
        <div style={{ fontSize: tall ? 230 : 300, fontWeight: 900, lineHeight: 1, color, ...stroke(8), textShadow: `0 0 60px ${color}aa` }}>{num(q.mag)}</div>
      </div>
      <div style={{ position: "absolute", left: tall ? 70 : 150, right: tall ? 70 : 150, ...(tall ? { top: 1765 } : { bottom: 110 }), display: "flex", justifyContent: tall ? "center" : "space-between", alignItems: "flex-end", gap: 40, flexWrap: "wrap" }}>
        <div style={{ fontSize: fitFontSize({ text: q.place, maxWidth: tall ? 940 : 1100, base: tall ? 76 : 96, min: 44, maxLines: 1 }), fontWeight: 900, ...stroke(3) }}>{trUpper(q.place)}</div>
        {!tall ? <div style={{ fontSize: 60, fontWeight: 800, color: theme.muted }}>{[q.time, q.depth != null ? `derinlik ${num(q.depth)} km` : "", q.source].filter(Boolean).join(" · ")}</div> : null}
      </div>
    </Frame>
  );
};

const Score = ({ p }: { p: InfoCardProps }) => {
  const s = p.score!;
  const tall = !!p.tall;
  const win = s.hs === s.as ? "draw" : s.hs > s.as ? "home" : "away";
  const W = tall ? 1080 : 1840;
  const teamSize = (t: string) => fitFontSize({ text: t, maxWidth: tall ? 440 : 560, base: tall ? 74 : 96, min: 40, maxLines: 2 });
  const team = (t: string, side: "home" | "away") => (
    <div style={{ width: tall ? 440 : 560, textAlign: "center", fontSize: teamSize(t), fontWeight: 900, lineHeight: 1.05, color: win === side ? theme.white : "#C9D1E6", ...stroke(3) }}>{trUpper(t)}</div>
  );
  const goals = (side: "home" | "away") => (s.goals || []).filter((g) => g.side === side).slice(0, 5).map((g, i) => (
    <div key={i} style={{ fontSize: tall ? 40 : 50, fontWeight: 700, color: "#DDE3F2", whiteSpace: "nowrap" }}>⚽ {g.player} {g.minute}</div>
  ));
  if (tall) {
    // dikeyde takımlar alt alta: ad + skor yan yana sığmaz
    const name = (t: string, side: "home" | "away") => (
      <div style={{ fontSize: fitFontSize({ text: t, maxWidth: 900, base: 96, min: 48, maxLines: 1 }), fontWeight: 900, color: win === side ? theme.white : "#C9D1E6", ...stroke(3) }}>{trUpper(t)}</div>
    );
    return (
      <Frame tall label={p.label || "MAÇ SONUCU"} stamp={p.stamp} accent={GREEN}>
        <div style={{ position: "absolute", top: 820, left: 0, right: 0, display: "flex", flexDirection: "column", alignItems: "center", gap: 26 }}>
          {s.league ? <div style={{ fontSize: 44, fontWeight: 800, color: theme.muted, letterSpacing: 3 }}>{trUpper(s.league)}</div> : null}
          {name(s.home, "home")}
          <div style={{ fontSize: 190, fontWeight: 900, lineHeight: 1, background: "rgba(0,0,0,.55)", border: `6px solid ${GREEN}`, borderRadius: 28, padding: "8px 40px", boxShadow: `0 0 60px ${GREEN}66` }}>
            {s.hs}<span style={{ color: YELLOW }}>-</span>{s.as}
          </div>
          {name(s.away, "away")}
          <div style={{ display: "flex", gap: 60, marginTop: 10 }}><div style={{ textAlign: "center" }}>{goals("home")}</div><div style={{ textAlign: "center" }}>{goals("away")}</div></div>
        </div>
        {s.note ? <div style={{ position: "absolute", top: 1730, left: 80, right: 80, textAlign: "center", fontSize: 46, fontWeight: 800, color: YELLOW }}>{s.note}</div> : null}
      </Frame>
    );
  }
  return (
    <Frame tall={tall} label={p.label || "MAÇ SONUCU"} stamp={p.stamp} accent={GREEN}>
      {s.league ? <div style={{ position: "absolute", top: tall ? 860 : 250, left: 0, right: 0, textAlign: "center", fontSize: tall ? 46 : 56, fontWeight: 800, color: theme.muted, letterSpacing: 3 }}>{trUpper(s.league)}</div> : null}
      <div style={{ position: "absolute", top: tall ? 960 : 360, left: 0, width: W, display: "flex", justifyContent: "center", alignItems: "center", gap: tall ? 10 : 40 }}>
        {team(s.home, "home")}
        <div style={{ fontSize: tall ? 170 : 240, fontWeight: 900, lineHeight: 1, background: "rgba(0,0,0,.55)", border: `6px solid ${GREEN}`, borderRadius: 28, padding: tall ? "10px 26px" : "10px 40px", whiteSpace: "nowrap", boxShadow: `0 0 60px ${GREEN}66` }}>
          {s.hs}<span style={{ color: YELLOW }}>-</span>{s.as}
        </div>
        {team(s.away, "away")}
      </div>
      <div style={{ position: "absolute", top: tall ? 1240 : 720, left: 0, width: W, display: "flex", justifyContent: "center", gap: tall ? 60 : 300 }}>
        <div style={{ width: tall ? 460 : 620, textAlign: "center" }}>{goals("home")}</div>
        <div style={{ width: tall ? 460 : 620, textAlign: "center" }}>{goals("away")}</div>
      </div>
      {s.note ? <div style={{ position: "absolute", ...(tall ? { top: 1720 } : { bottom: 100 }), left: 120, right: 120, textAlign: "center", fontSize: tall ? 46 : 56, fontWeight: 800, color: YELLOW }}>{s.note}</div> : null}
    </Frame>
  );
};

const Market = ({ p }: { p: InfoCardProps }) => {
  const tall = !!p.tall;
  const rows = (p.rows || []).slice(0, tall ? 6 : 5);
  const rowH = tall ? 150 : 150;
  return (
    <Frame tall={tall} label={p.label || "PİYASALAR"} stamp={p.stamp} accent={YELLOW}>
      <div style={{ position: "absolute", top: tall ? 900 : 290, left: tall ? 60 : 150, right: tall ? 60 : 150 }}>
        {rows.map((r, i) => {
          const up = (r.change ?? 0) > 0, down = (r.change ?? 0) < 0;
          const c = up ? GREEN : down ? theme.red : theme.muted;
          return (
            <div key={i} style={{ height: rowH - 18, marginBottom: 18, display: "flex", alignItems: "center", justifyContent: "space-between", background: "rgba(255,255,255,.06)", borderLeft: `14px solid ${c}`, borderRadius: 18, padding: "0 36px" }}>
              <div style={{ fontSize: tall ? 54 : 70, fontWeight: 900 }}>{trUpper(r.name)}</div>
              <div style={{ display: "flex", alignItems: "center", gap: tall ? 24 : 50 }}>
                <div style={{ fontSize: tall ? 62 : 82, fontWeight: 900 }}>{r.value}</div>
                {r.change != null ? <div style={{ minWidth: tall ? 210 : 260, textAlign: "right", fontSize: tall ? 46 : 60, fontWeight: 900, color: c }}>{up ? "▲" : down ? "▼" : "■"} %{num(Math.abs(r.change), 2)}</div> : null}
              </div>
            </div>
          );
        })}
      </div>
    </Frame>
  );
};

const Calendar = ({ p }: { p: InfoCardProps }) => {
  const tall = !!p.tall;
  const d = p.date || { day: "", month: "" };
  const title = p.title || "";
  return (
    <Frame tall={tall} label={p.label || "TAKVİM"} stamp={p.stamp} accent={theme.red}>
      <div style={{ position: "absolute", ...(tall ? { top: 920, left: 0, right: 0, display: "flex", justifyContent: "center" } : { top: 280, left: 150 }) }}>
        <div style={{ width: tall ? 440 : 560, borderRadius: 36, overflow: "hidden", background: theme.white, color: "#111", textAlign: "center", boxShadow: "0 30px 80px rgba(0,0,0,.6)" }}>
          <div style={{ background: theme.red, color: theme.white, fontSize: tall ? 60 : 76, fontWeight: 900, padding: "18px 0", letterSpacing: 3 }}>{trUpper(d.month)}</div>
          <div style={{ fontSize: tall ? 220 : 290, fontWeight: 900, lineHeight: 1.05 }}>{d.day}</div>
          {d.weekday ? <div style={{ fontSize: tall ? 50 : 62, fontWeight: 800, color: "#555", paddingBottom: 22 }}>{trUpper(d.weekday)}</div> : null}
        </div>
      </div>
      {!tall ? (
        <div style={{ position: "absolute", top: 300, left: 820, right: 150 }}>
          <div style={{ fontSize: fitFontSize({ text: title, maxWidth: 870, base: 120, min: 56, maxLines: 4 }), fontWeight: 900, lineHeight: 1.08, ...stroke(4) }}>{trUpper(title)}</div>
          {p.sub ? <div style={{ marginTop: 30, fontSize: 56, fontWeight: 700, color: YELLOW }}>{p.sub}</div> : null}
        </div>
      ) : (
        <div style={{ position: "absolute", top: 1560, left: 80, right: 80, textAlign: "center", fontSize: fitFontSize({ text: title, maxWidth: 920, base: 80, min: 44, maxLines: 2 }), fontWeight: 900, ...stroke(3) }}>{trUpper(title)}</div>
      )}
    </Frame>
  );
};

const LEVEL_COLOR = { yellow: "#FFD400", orange: "#FF7A00", red: "#E30A17" };

const Weather = ({ p }: { p: InfoCardProps }) => {
  const w = p.weather!;
  const tall = !!p.tall;
  const color = LEVEL_COLOR[w.level] || LEVEL_COLOR.orange;
  const mapW = tall ? 980 : 1240;
  const k = mapW / MAP_W;
  const names = w.points.map((x) => x.name);
  const list = names.slice(0, tall ? 10 : 12).join(" · ") + (names.length > (tall ? 10 : 12) ? ` +${names.length - (tall ? 10 : 12)}` : "");
  return (
    <Frame tall={tall} label={p.label} stamp={p.stamp} accent={color}>
      <svg style={{ position: "absolute", left: tall ? 50 : 300, top: tall ? 960 : 260, overflow: "visible" }} width={mapW} height={MAP_H * k} viewBox={`0 0 ${MAP_W} ${MAP_H}`}>
        <path d={MAP_PATH} fill="#1C2742" stroke="#6F84B8" strokeWidth={3} fillRule="evenodd" />
        {w.points.map((pt, i) => { const [x, y] = project([pt.lon, pt.lat]); return (
          <g key={i}><circle cx={x} cy={y} r={34} fill={color} opacity={0.28} /><circle cx={x} cy={y} r={15} fill={color} stroke="#fff" strokeWidth={4} /></g>
        ); })}
      </svg>
      <div style={{ position: "absolute", left: tall ? 70 : 150, right: tall ? 70 : 150, ...(tall ? { top: 1460 } : { bottom: 110 }), textAlign: "center" }}>
        <div style={{ fontSize: fitFontSize({ text: list, maxWidth: tall ? 940 : 1540, base: tall ? 54 : 64, min: 34, maxLines: 2, upper: false }), fontWeight: 900, ...stroke(3) }}>{list}</div>
        {p.title ? <div style={{ marginTop: 14, fontSize: tall ? 44 : 52, fontWeight: 800, color: YELLOW }}>{p.title}</div> : null}
      </div>
    </Frame>
  );
};

const Ranking = ({ p }: { p: InfoCardProps }) => {
  const tall = !!p.tall;
  const rows = (p.ranking || []).slice(0, 5);
  return (
    <Frame tall={tall} label={p.label || "HAFTANIN EN ÇOK İZLENENLERİ"} stamp={p.stamp} accent={YELLOW}>
      {/* dikeyde kanca başlığı (≈520-950) altında kalsın */}
      <div style={{ position: "absolute", top: tall ? 1020 : 270, left: tall ? 60 : 150, right: tall ? 60 : 150 }}>
        {rows.map((r, i) => (
          <div key={i} style={{ display: "flex", alignItems: "center", gap: 28, height: tall ? 140 : 150, marginBottom: tall ? 12 : 16, background: "rgba(255,255,255,.06)", borderRadius: 18, padding: "0 30px" }}>
            <div style={{ minWidth: tall ? 90 : 110, fontSize: tall ? 96 : 110, fontWeight: 900, color: i === 0 ? YELLOW : theme.white, ...stroke(3) }}>{i + 1}</div>
            <div style={{ flex: 1, fontSize: fitFontSize({ text: r.title, maxWidth: tall ? 720 : 1200, base: tall ? 46 : 58, min: 30, maxLines: 2, upper: false }), fontWeight: 800, lineHeight: 1.1 }}>{r.title}</div>
            {r.views ? <div style={{ fontSize: tall ? 40 : 50, fontWeight: 900, color: YELLOW, whiteSpace: "nowrap" }}>▶ {r.views}</div> : null}
          </div>
        ))}
      </div>
    </Frame>
  );
};

export const InfoCard = (p: InfoCardProps) => {
  if (p.kind === "weather" && p.weather) return <Weather p={p} />;
  if (p.kind === "ranking") return <Ranking p={p} />;
  if (p.kind === "quake" && p.quake) return <Quake p={p} />;
  if (p.kind === "score" && p.score) return <Score p={p} />;
  if (p.kind === "market") return <Market p={p} />;
  return <Calendar p={p} />;
};
