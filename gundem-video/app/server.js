// Türkiye Gündemi kontrol paneli — tamamen yerel çalışır (localhost + aynı Wi-Fi).
// Başlat: npm run panel   → http://localhost:3131
import express from "express";
import { spawn, execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import QRCode from "qrcode";
import { parseCommand } from "./commands.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "out");
const WORK = path.join(ROOT, "work");
const THUMBS = path.join(WORK, "thumbs");
const PORT = Number(process.env.PANEL_PORT || 3131);
for (const d of [OUT, WORK, THUMBS]) mkdirSync(d, { recursive: true });

const app = express();
app.use(express.json());
app.use(express.static(path.join(ROOT, "app", "ui")));
app.use("/videos", express.static(OUT, { acceptRanges: true }));

// ---------- yardımcılar
const lanIp = () => {
  for (const list of Object.values(networkInterfaces()))
    for (const i of list || []) if (i.family === "IPv4" && !i.internal) return i.address;
  return "127.0.0.1";
};
const isMac = process.platform === "darwin";
const run = (cmd, args, opts = {}) =>
  new Promise((res) => execFile(cmd, args, { ...opts, maxBuffer: 8e6 }, (err, stdout, stderr) => res({ ok: !err, stdout, stderr, err })));

const label = (v) => (v.date ? `${v.date}, günün ${v.episodeOfDay}. özeti` : v.name.replace(/\.mp4$/, ""));

function listVideos() {
  return readdirSync(OUT)
    .filter((f) => f.endsWith(".mp4"))
    .map((f) => {
      const st = statSync(path.join(OUT, f));
      const metaPath = path.join(OUT, f.replace(/\.mp4$/, ".json"));
      let meta = null;
      try { meta = JSON.parse(readFileSync(metaPath, "utf8")); } catch { /* yok */ }
      const dur = meta ? meta.segments.reduce((s, x) => s + x.duration, 0) : null;
      return {
        name: f,
        size: st.size,
        mtime: st.mtimeMs,
        duration: dur ? Math.round(dur) : null,
        targetDuration: meta?.targetDuration ?? null,
        date: meta?.dateLabel ?? null,
        episodeOfDay: meta?.episodeOfDay ?? null,
        headlines: meta ? meta.segments.filter((s) => s.kind === "haber").map((s) => ({ title: s.title, category: s.category, breaking: !!s.breaking })) : [],
      };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

// ---------- üretim durumu + canlı log (SSE)
const state = { running: false, startedAt: null, duration: null, log: [], exitCode: null };
const clients = new Set();
const push = (line) => {
  state.log.push(line);
  if (state.log.length > 400) state.log.shift();
  for (const res of clients) res.write(`data: ${JSON.stringify(line)}\n\n`);
};

function startPipeline(duration) {
  if (state.running) return { ok: false, error: "Zaten bir üretim sürüyor." };
  duration = Math.min(180, Math.max(15, Number(duration) || 30));
  Object.assign(state, { running: true, startedAt: Date.now(), duration, log: [], exitCode: null });
  push(`▶ ${duration} saniyelik üretim başlatıldı`);
  const child = spawn("bash", ["pipeline.sh"], { cwd: ROOT, env: { ...process.env, DURATION: String(duration) } });
  const onData = (buf) => buf.toString().split("\n").filter(Boolean).forEach(push);
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  child.on("close", (code) => {
    state.running = false;
    state.exitCode = code;
    push(code === 0 ? "✔ üretim tamamlandı" : `✖ üretim hata ile bitti (kod ${code})`);
    push("__done__");
  });
  return { ok: true, duration };
}

app.get("/api/status", (_req, res) => res.json({ ...state, log: state.log.slice(-60), lanUrl: `http://${lanIp()}:${PORT}`, isMac }));
app.get("/api/log", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.flushHeaders();
  for (const l of state.log.slice(-60)) res.write(`data: ${JSON.stringify(l)}\n\n`);
  clients.add(res);
  req.on("close", () => clients.delete(res));
});

// ---------- videolar
app.get("/api/videos", (_req, res) => res.json(listVideos()));
app.get("/api/thumb/:name", async (req, res) => {
  const name = path.basename(req.params.name);
  const src = path.join(OUT, name);
  if (!existsSync(src)) return res.status(404).end();
  const dst = path.join(THUMBS, name.replace(/\.mp4$/, ".jpg"));
  if (!existsSync(dst)) await run("ffmpeg", ["-y", "-loglevel", "error", "-ss", "4", "-i", src, "-frames:v", "1", "-vf", "scale=360:-1", dst]);
  res.sendFile(dst);
});
app.delete("/api/videos/:name", (req, res) => {
  const name = path.basename(req.params.name);
  for (const f of [name, name.replace(/\.mp4$/, ".json")]) { const p = path.join(OUT, f); if (existsSync(p)) unlinkSync(p); }
  const t = path.join(THUMBS, name.replace(/\.mp4$/, ".jpg")); if (existsSync(t)) unlinkSync(t);
  res.json({ ok: true });
});
app.post("/api/reveal", async (req, res) => {
  const p = path.join(OUT, path.basename(req.body.name || ""));
  if (!existsSync(p)) return res.status(404).json({ ok: false });
  if (!isMac) return res.json({ ok: false, error: "Sadece macOS" });
  res.json(await run("open", ["-R", p]));
});
app.get("/api/qr", async (req, res) => {
  const name = req.query.name ? "/videos/" + path.basename(String(req.query.name)) : "/";
  const url = `http://${lanIp()}:${PORT}${name}`;
  res.json({ url, svg: await QRCode.toString(url, { type: "svg", margin: 1, color: { dark: "#FFFFFF", light: "#00000000" } }) });
});

// ---------- üretim
app.post("/api/generate", (req, res) => res.json(startPipeline(req.body?.duration)));

// ---------- sesli komut: metin → eylem
app.post("/api/command", async (req, res) => {
  const text = String(req.body?.text || "");
  const cmd = parseCommand(text);
  const videos = listVideos();
  let reply = cmd.reply, action = cmd.action, payload = {};
  switch (cmd.action) {
    case "generate": {
      const r = startPipeline(cmd.duration);
      reply = r.ok ? `${r.duration} saniyelik gündem videosu üretiliyor. Bitince haber vereceğim.` : r.error;
      if (!r.ok) action = "none";
      break;
    }
    case "play_latest":
      if (!videos.length) { reply = "Henüz üretilmiş video yok."; action = "none"; }
      else { payload = { name: videos[0].name }; reply = `Son video açılıyor: ${label(videos[0])}.`; }
      break;
    case "status":
      reply = state.running
        ? `Üretim sürüyor, ${Math.round((Date.now() - state.startedAt) / 1000)} saniyedir çalışıyor.`
        : `Şu an üretim yok. Toplam ${videos.length} video var.${videos[0] ? " En yenisi: " + label(videos[0]) + "." : ""}`;
      break;
    case "share":
      if (!videos.length) { reply = "Paylaşacak video yok."; action = "none"; }
      else { payload = { name: videos[0].name }; reply = "Paylaşım paneli açıldı. Telefonunuzla QR kodu okutun."; }
      break;
    case "reveal":
      if (videos[0] && isMac) { await run("open", ["-R", path.join(OUT, videos[0].name)]); reply = "Finder'da gösteriliyor."; }
      else { reply = "Gösterilecek video yok."; action = "none"; }
      break;
    case "schedule_on": case "schedule_off": {
      const r = await setSchedule(cmd.action === "schedule_on", cmd.hours || 5);
      reply = r.ok ? (cmd.action === "schedule_on" ? `Otomatik üretim açıldı, her ${cmd.hours || 5} saatte bir.` : "Otomatik üretim kapatıldı.") : `Zamanlayıcı ayarlanamadı: ${r.error}`;
      break;
    }
    default: break;
  }
  res.json({ action, reply, payload, heard: text });
});

// ---------- Jarvis sesi: Piper ile yerel seslendirme
app.post("/api/speak", (req, res) => {
  const text = String(req.body?.text || "").slice(0, 400);
  const py = existsSync(path.join(ROOT, ".venv/bin/python3")) ? path.join(ROOT, ".venv/bin/python3") : "python3";
  const child = spawn(py, ["scripts/speak.py"], { cwd: ROOT, env: { ...process.env, PATH: `${ROOT}/.venv/bin:/opt/homebrew/bin:/usr/local/bin:${process.env.PATH}` } });
  const chunks = [];
  child.stdout.on("data", (c) => chunks.push(c));
  child.on("close", (code) => {
    if (code !== 0 || !chunks.length) return res.status(204).end();
    res.setHeader("Content-Type", "audio/wav");
    res.send(Buffer.concat(chunks));
  });
  child.stdin.end(text);
});

// ---------- zamanlayıcı (launchd)
const PLIST = path.join(process.env.HOME || "", "Library/LaunchAgents/com.gundem.video.plist");
async function setSchedule(enabled, hours) {
  if (!isMac) return { ok: false, error: "launchd sadece macOS'ta" };
  if (existsSync(PLIST)) await run("launchctl", ["unload", PLIST]);
  if (!enabled) { if (existsSync(PLIST)) unlinkSync(PLIST); return { ok: true }; }
  const tpl = readFileSync(path.join(ROOT, "launchd/com.gundem.video.plist"), "utf8")
    .replace(/__PROJE_YOLU__/g, ROOT)
    .replace("<integer>18000</integer>", `<integer>${Math.round(hours * 3600)}</integer>`);
  writeFileSync(PLIST, tpl);
  const r = await run("launchctl", ["load", PLIST]);
  return r.ok ? { ok: true } : { ok: false, error: r.stderr || "launchctl load başarısız" };
}
app.get("/api/schedule", (_req, res) => {
  let hours = null;
  if (existsSync(PLIST)) { const m = readFileSync(PLIST, "utf8").match(/<integer>(\d+)<\/integer>/); hours = m ? Number(m[1]) / 3600 : 5; }
  res.json({ enabled: existsSync(PLIST), hours, isMac });
});
app.post("/api/schedule", async (req, res) => res.json(await setSchedule(!!req.body.enabled, Number(req.body.hours) || 5)));

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Türkiye Gündemi paneli: http://localhost:${PORT}   (telefon: http://${lanIp()}:${PORT})`);
});
