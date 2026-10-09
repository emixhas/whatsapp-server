// Türkiye Gündemi — JARVIS paneli. Tamamen yerel (localhost + aynı Wi-Fi); beyin için claude -p.
// Başlat: npm run panel   → http://localhost:3131
import express from "express";
import { spawn, execFile, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, statSync, unlinkSync, watch, writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import QRCode from "qrcode";
import { parseCommand } from "./commands.js";
import { makeBrain, claudeBin, claudeEnv, claudeError, claudeModelArgs } from "./brain.js";
import { makeWhatsApp } from "./whatsapp.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "out"), WORK = path.join(ROOT, "work"), DATA = path.join(ROOT, "data"), THUMBS = path.join(WORK, "thumbs");
const PORT = Number(process.env.PANEL_PORT || 3131);
for (const d of [OUT, WORK, DATA, THUMBS, path.join(DATA, "reports")]) mkdirSync(d, { recursive: true });
const PY = existsSync(path.join(ROOT, ".venv/bin/python3")) ? path.join(ROOT, ".venv/bin/python3") : "python3";
const ENV = { ...process.env, PATH: `${ROOT}/.venv/bin:${process.env.HOME}/.local/bin:/opt/homebrew/bin:/usr/local/bin:${process.env.PATH}` };
const isMac = process.platform === "darwin";

const app = express();
app.set("trust proxy", true);
// Güvenlik: Cloudflare Tunnel paneli internete açar. Tünelden gelen istekler (cf-connecting-ip başlığı
// veya tünel hostname'i) yalnızca video dosyalarını ve TikTok geri dönüşünü görebilir; panel ve API kapalı.
app.use((req, res, next) => {
  const host = (req.headers.host || "").split(":")[0];
  const viaTunnel = !!req.headers["cf-connecting-ip"] || /\.trycloudflare\.com$/.test(host) || (tunnel.hostname && host === tunnel.hostname);
  if (!viaTunnel) return next();
  if (req.method === "GET" && (req.path.startsWith("/videos/") || req.path.startsWith("/w/") || req.path.startsWith("/v/") || req.path.startsWith("/api/thumb/") || req.path === "/tiktok/callback" || req.path === "/instagram/callback")) return next();
  res.status(403).send("Bu adres yalnızca video dosyalarını sunar.");
});
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(ROOT, "app", "ui")));
app.use("/videos", express.static(OUT, { acceptRanges: true }));
app.use("/previews", express.static(path.join(ROOT, "data", "previews")));

// ---------- yardımcılar
const lanIp = () => { for (const l of Object.values(networkInterfaces())) for (const i of l || []) if (i.family === "IPv4" && !i.internal) return i.address; return "127.0.0.1"; };
const run = (cmd, args, opts = {}) => new Promise((res) => execFile(cmd, args, { cwd: ROOT, env: ENV, maxBuffer: 8e6, ...opts }, (err, stdout, stderr) => res({ ok: !err, stdout, stderr, err })));
const py = async (script, args = []) => { const r = await run(PY, [`scripts/${script}`, ...args]); let json = null; try { json = JSON.parse(r.stdout.trim().split("\n").pop()); } catch { /* düz metin */ } return { ...r, json }; };
const readJson = (p, d) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return d; } };
const writeJson = (p, o) => writeFileSync(p, JSON.stringify(o, null, 2));
const SETTINGS = path.join(DATA, "settings.json");
const defaults = { autopublish: { youtube: false, instagram: false, tiktok: false }, dailyReportHour: 9, metricsSyncMinutes: 60, channelName: "Türkiye Gündemi", hashtags: "#gündem #haber #türkiye #sondakika #shorts",
  assistantName: "Emixhas", wakeWords: ["emixhas", "emiks has", "emiks", "emix", "emixas", "emikhas", "emihas", "e mix has", "emiş has", "emişhas"], fullAuthority: true,
  voice: { engine: "auto", name: "Yelda", rate: 195, piperLength: 0.85, piperNoise: 0.5 }, narrationEngine: "auto", narration: { mode: "single", voice: "auto", voiceA: "vox-kadin", voiceB: "vox-erkek" }, tunnelAutoStart: false, claudeModel: "opus", media: { video: true, maxVideoSeconds: 20, allowYoutubeEmbeds: false }, claudeEffort: { script: "medium", brain: "high" },
  chatterbox: { port: 3139, refVoice: "voices/ref.wav", exaggeration: 0.45, cfg: 0.5 },
  turkishVoice: { python: ".venv-tr/bin/python", trendyolBin: ".venv-tr/bin/trendyol-tts", mlxModel: "models/Trendyol-TTS-mlx", torchModel: "Trendyol/Trendyol-TTS", baseModel: "openbmb/VoxCPM2", backend: "auto", cfg: 2.0, steps: 16, seed: 42, refVoice: "", emaSpeed: 1.0 },
  whatsapp: { enabled: true, owner: "905321308827", notifyOnVideo: true, sendVideoFile: true, requireApproval: true, autoStart: true, notifyStages: true }, scheduleHours: 5 };
const deepMerge = (a, b) => { const o = { ...a }; for (const [k, v] of Object.entries(b || {})) o[k] = v && typeof v === "object" && !Array.isArray(v) ? deepMerge(a[k] || {}, v) : v; return o; };
const settings = () => deepMerge(defaults, readJson(SETTINGS, {}));
const patchSettings = (patch) => { const s = deepMerge(settings(), patch); writeJson(SETTINGS, s); return s; };
const IMPROVEMENTS = path.join(DATA, "improvements.md");
const queueImprovement = (task) => { const head = "# Emixhas geliştirme kuyruğu\n\nBir görevi uygulamak için proje klasöründe Claude Code'u açıp bu dosyadaki ilk açık görevi vermeniz yeterli; uygulanınca [x] işaretleyin.\n\n"; const line = `- [ ] ${new Date().toISOString().slice(0, 16)} ${String(task).trim()}\n`; writeFileSync(IMPROVEMENTS, (existsSync(IMPROVEMENTS) ? readFileSync(IMPROVEMENTS, "utf8") : head) + line); return { ok: true, file: "data/improvements.md" }; };
const label = (v) => (v.date ? `${v.date}, günün ${v.episodeOfDay}. özeti` : v.name.replace(/\.mp4$/, ""));

function listVideos() {
  const metrics = readJson(path.join(DATA, "metrics.json"), { videos: {} }).videos;
  return readdirSync(OUT).filter((f) => f.endsWith(".mp4")).map((f) => {
    const st = statSync(path.join(OUT, f));
    const meta = readJson(path.join(OUT, f.replace(/\.mp4$/, ".json")), null);
    const dur = meta ? meta.segments.reduce((s, x) => s + x.duration, 0) : null;
    const m = metrics[f] || {};
    return { name: f, size: st.size, mtime: st.mtimeMs, duration: dur ? Math.round(dur) : null, targetDuration: meta?.targetDuration ?? null,
      date: meta?.dateLabel ?? null, time: meta?.timeLabel ?? null, episodeOfDay: meta?.episodeOfDay ?? null,
      headlines: meta ? meta.segments.filter((s) => s.kind === "haber").map((s) => ({ title: s.title, category: s.category, breaking: !!s.breaking })) : [],
      youtube: m.youtube || null, instagram: m.instagram || null, tiktok: m.tiktok || null, views: (m.youtube?.views || 0) + (m.instagram?.views || 0) + (m.tiktok?.views || 0) };
  }).sort((a, b) => b.mtime - a.mtime);
}

// ---------- üretim durumu + canlı log (SSE)
const state = { running: false, startedAt: null, duration: null, log: [], exitCode: null, lastVideo: null, busy: null };
const clients = new Set();
const NOISE = /\[mcp-sdk\]|SEP-\d{3,}|ExperimentalWarning|punycode|DeprecationWarning/;
const push = (line) => { if (NOISE.test(line)) return; state.log.push(line); if (state.log.length > 400) state.log.shift(); for (const r of clients) r.write(`data: ${JSON.stringify(line)}\n\n`); notifyStage(line); };
// Aşama bildirimleri: üretim, ses, render, yükleme/silme, yayın satırları WhatsApp'a kısa mesaj olarak gider (settings.whatsapp.notifyStages)
const STAGE = /^(⏰ zamanlayıcı|✔ zamanlayıcı|kapaklar hazır|== .*üretim başladı|-- \d\/4|-- (görseller|kapaklar|yayın ve analiz)|== bitti|\[[^\]]+\] \d+ segment|senaryo hazır|\d+ haber Claude'a gidiyor|✔ üretim|✖ üretim|📤 |🌐 |  ! |!! |  kategori |  🧩|  🛠)/;
let stageQueue = [], stageTimer = null;
function notifyStage(line) {
  try {
    const w = settings().whatsapp || {};
    if (!w.notifyStages || !STAGE.test(line)) return;
    stageQueue.push(line.replace(/^== |^-- /, "").trim());
    clearTimeout(stageTimer);
    stageTimer = setTimeout(async () => { const batch = stageQueue.splice(0); if (!batch.length) return; try { await wa.send("🛠 " + batch.join("\n")); } catch { /* bağlı değil */ } }, 2500);
  } catch { /* ayar okunamadı */ }
}
const announce = (reply, extra = {}) => { for (const r of clients) r.write(`event: jarvis\ndata: ${JSON.stringify({ reply, ...extra })}\n\n`); };

function startPipeline(duration, extraEnv = {}) {
  if (state.running) return { ok: false, error: "Zaten bir üretim sürüyor." };
  const lock = path.join(WORK, "pipeline.lock", "pid");
  if (existsSync(lock)) { try { process.kill(Number(readFileSync(lock, "utf8").trim()), 0); return { ok: false, error: "Zamanlayıcıdan başlamış bir üretim sürüyor; bitince tekrar deneyin." }; } catch { /* eski kilit, pipeline temizler */ } }
  duration = Math.min(180, Math.max(15, Number(duration) || 30));
  Object.assign(state, { running: true, startedAt: Date.now(), duration, log: [], exitCode: null });
  push(extraEnv.ANLIK === "1" ? `⚡ ${duration} saniyelik ANLIK HABER üretimi başlatıldı` : `▶ ${duration} saniyelik üretim başlatıldı`);
  const child = spawn("bash", ["pipeline.sh"], { cwd: ROOT, env: { ...ENV, DURATION: String(duration), ...extraEnv } });
  const onData = (b) => b.toString().split("\n").filter(Boolean).forEach((l) => { push(l); const m = l.match(/== bitti: (out\/\S+\.mp4)/); if (m) state.lastVideo = path.basename(m[1]); });
  child.stdout.on("data", onData); child.stderr.on("data", onData);
  child.on("close", (code) => { state.running = false; state.exitCode = code; push(code === 0 ? "✔ üretim tamamlandı" : `✖ üretim hata ile bitti (kod ${code})`); push(`__done__:${code}`); });
  return { ok: true, duration };
}

// ---------- Anlık haber: editörün yazdığı konuda tek konulu son dakika videosu
// Başka üretim sürüyorsa istek sıraya girer ve o bitince kendiliğinden başlar (zamanlayıcı üretimi dahil).
const anlikQueue = []; // sırayla üretilecek anlık haber istekleri
const pipelineBusy = () => { if (state.running) return true; const lock = path.join(WORK, "pipeline.lock", "pid"); if (!existsSync(lock)) return false; try { process.kill(Number(readFileSync(lock, "utf8").trim()), 0); return true; } catch { return false; } };
function startAnlik(topic, duration) {
  topic = String(topic || "").replace(/\s+/g, " ").trim().slice(0, 1500);
  if (topic.length < 8) return { ok: false, error: "Konuyu biraz daha ayrıntılı yazın (en az birkaç kelime)." };
  duration = Math.min(60, Math.max(20, Number(duration) || 30));
  if (pipelineBusy()) {
    anlikQueue.push({ topic, duration, at: Date.now() });
    push(`⚡ anlık haber sıraya alındı (${anlikQueue.length}. sırada, şu an başka üretim sürüyor): ${topic.slice(0, 80)}`);
    return { ok: true, queued: true, position: anlikQueue.length, duration };
  }
  mkdirSync(WORK, { recursive: true });
  writeFileSync(path.join(WORK, "anlik_topic.txt"), topic + "\n");
  return { ...startPipeline(duration, { ANLIK: "1" }), anlik: true };
}
setInterval(() => { if (anlikQueue.length && !pipelineBusy()) { const q = anlikQueue.shift(); push(`⚡ sıradaki anlık haber başlıyor: ${q.topic.slice(0, 80)}`); startAnlik(q.topic, q.duration); } }, 10000);
app.post("/api/anlik", (req, res) => res.json(startAnlik(req.body?.topic, req.body?.duration)));
app.get("/api/anlik", (_req, res) => res.json({ queue: anlikQueue, running: state.running }));

// ---------- zamanlayıcı (launchd)
const PLIST = path.join(process.env.HOME || "", "Library/LaunchAgents/com.gundem.video.plist");
const SCHED_FILE = path.join(DATA, "schedule.json");
const readSched = () => { try { return JSON.parse(readFileSync(SCHED_FILE, "utf8")); } catch { return {}; } };
// Üretim saatleri sabittir: 24 saat "hours" aralığıyla bölünür (5 → 00,05,10,15,20). Dakika settings.scheduleMinute.
const slotsFor = (hours) => { const out = []; for (let h = 0; h < 24; h += Math.max(1, Math.round(hours))) out.push(h); return out; };
async function getSchedule() {
  const enabled = existsSync(PLIST);
  const sch = readSched();
  let hours = sch.hours || null;
  if (enabled && !hours) { const m = readFileSync(PLIST, "utf8").match(/<integer>(\d+)<\/integer>/); hours = m && Number(m[1]) > 60 ? Number(m[1]) / 3600 : 5; }
  const minute = Number(settings().scheduleMinute) || 0;
  const slots = enabled ? (sch.slots || slotsFor(hours || 5)) : [];
  const vids = listVideos();
  const lastRunAt = vids[0] ? statSync(path.join(OUT, vids[0].name)).mtimeMs : null;
  let nextRunAt = null, nextEpisode = null;
  if (enabled && slots.length) {
    const now = new Date();
    const cands = [];
    for (const dayOff of [0, 1]) for (const h of slots) { const d = new Date(now); d.setDate(d.getDate() + dayOff); d.setHours(h, minute, 0, 0); if (d.getTime() > now.getTime() + (state.running ? 120000 : 0)) cands.push(d.getTime()); }
    nextRunAt = Math.min(...cands);
    const d = new Date(nextRunAt); const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    nextEpisode = vids.filter((v) => v.name.startsWith(key)).length + 1;
  }
  return { enabled, hours, slots, minute, isMac, nextRunAt, nextEpisode, lastRunAt, running: state.running, awake: !!caffeine };
}
async function setSchedule(enabled, hours) {
  if (!isMac) return { ok: false, error: "launchd sadece macOS'ta" };
  if (existsSync(PLIST)) await run("launchctl", ["unload", PLIST]);
  if (!enabled) { if (existsSync(PLIST)) unlinkSync(PLIST); keepAwake(false); return { ok: true }; }
  const minute = Number(settings().scheduleMinute) || 0;
  const slots = slotsFor(hours);
  const cal = slots.map((h) => `    <dict><key>Hour</key><integer>${h}</integer><key>Minute</key><integer>${minute}</integer></dict>`).join("\n");
  writeFileSync(PLIST, readFileSync(path.join(ROOT, "launchd/com.gundem.video.plist"), "utf8").replace(/__PROJE_YOLU__/g, ROOT).replace(/__HOME__/g, process.env.HOME || "").replace("__CALENDAR__", cal));
  patchSettings({ scheduleHours: hours });
  const r = await run("launchctl", ["load", PLIST]);
  if (r.ok) { writeFileSync(SCHED_FILE, JSON.stringify({ loadedAt: Date.now(), hours, slots, minute })); keepAwake(true); push(`⏰ üretim saatleri: her gün ${slots.map((h) => String(h).padStart(2, "0") + ":" + String(minute).padStart(2, "0")).join(", ")}`); }
  return r.ok ? { ok: true, slots } : { ok: false, error: r.stderr || "launchctl load başarısız" };
}

// Zamanlayıcıdan (launchd) çalışan üretimin logunu canlı loga akıt: work/launchd.out.log büyüdükçe yeni satırlar push edilir
const LAUNCHD_LOG = path.join(WORK, "launchd.out.log");
let launchdPos = existsSync(LAUNCHD_LOG) ? statSync(LAUNCHD_LOG).size : 0, launchdBuf = "";
function tailLaunchd() {
  try {
    if (!existsSync(LAUNCHD_LOG)) return;
    const size = statSync(LAUNCHD_LOG).size;
    if (size < launchdPos) launchdPos = 0;  // dosya sıfırlandı
    if (size === launchdPos) return;
    const fd = openSync(LAUNCHD_LOG, "r"); const buf = Buffer.alloc(size - launchdPos); readSync(fd, buf, 0, buf.length, launchdPos); closeSync(fd); launchdPos = size;
    launchdBuf += buf.toString("utf8");
    const lines = launchdBuf.split("\n"); launchdBuf = lines.pop() || "";
    for (const l of lines) { if (!l.trim()) continue; if (/üretim başladı/.test(l) && !state.running) { state.running = true; state.startedAt = Date.now(); state.scheduled = true; push("⏰ zamanlayıcı üretimi başladı"); } push(l); const m = l.match(/== bitti: (out\/\S+\.mp4)/); if (m) state.lastVideo = path.basename(m[1]); if (/^\{"autopublish"/.test(l) || /yayın\/analiz adımı hata/.test(l)) { if (state.scheduled) { state.running = false; state.scheduled = false; push("✔ zamanlayıcı üretimi tamamlandı"); } } }
  } catch { /* okunamadı */ }
}
setInterval(tailLaunchd, 2000);
// ---------- Cloudflare Tunnel (Instagram'ın videoyu çekebilmesi ve TikTok geri dönüşü için)
const ENVFILE = path.join(ROOT, "secrets", ".env");
const readEnv = () => { const o = {}; if (existsSync(ENVFILE)) for (const l of readFileSync(ENVFILE, "utf8").split("\n")) { const m = l.match(/^\s*([A-Z_]+)\s*=\s*(.*)$/); if (m) o[m[1]] = m[2].trim().replace(/^["']|["']$/g, ""); } return o; };
const writeEnvKey = (k, v) => { mkdirSync(path.dirname(ENVFILE), { recursive: true }); let txt = existsSync(ENVFILE) ? readFileSync(ENVFILE, "utf8") : ""; const re = new RegExp(`^${k}=.*$`, "m"); txt = re.test(txt) ? txt.replace(re, `${k}=${v}`) : txt.replace(/\n?$/, "\n") + `${k}=${v}\n`; writeFileSync(ENVFILE, txt); };
const tunnel = { proc: null, url: null, hostname: null, mode: null, log: [], error: null };
function startTunnel() {
  if (tunnel.proc) return { ok: true, url: tunnel.url, mode: tunnel.mode, running: true };
  const env = readEnv();
  const named = env.TUNNEL_NAME && env.TUNNEL_HOSTNAME;
  const args = named ? ["tunnel", "run", "--url", `http://localhost:${PORT}`, env.TUNNEL_NAME] : ["tunnel", "--url", `http://localhost:${PORT}`];
  let child;
  try { child = spawn("cloudflared", args, { env: ENV }); } catch (e) { return { ok: false, error: e.message }; }
  tunnel.proc = child; tunnel.mode = named ? "named" : "quick"; tunnel.error = null; tunnel.log = [];
  const announceCallbacks = () => { push(`◎ Instagram geri dönüş adresi: ${tunnel.url}/instagram/callback`); push(`♪ TikTok geri dönüş adresi: ${tunnel.url}/tiktok/callback`); };
  if (named) { tunnel.hostname = env.TUNNEL_HOSTNAME; tunnel.url = `https://${env.TUNNEL_HOSTNAME}`; writeEnvKey("PUBLIC_BASE_URL", tunnel.url); push(`☁ adlı tünel (kalıcı): ${tunnel.url}`); announceCallbacks(); }
  const onData = (b) => { const t = b.toString(); tunnel.log.push(t.slice(0, 300)); if (tunnel.log.length > 50) tunnel.log.shift();
    const m = t.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/); if (m && !named && tunnel.url !== m[0]) { tunnel.url = m[0]; tunnel.hostname = m[0].replace("https://", ""); writeEnvKey("PUBLIC_BASE_URL", tunnel.url); push(`☁ tünel hazır (geçici adres, her açılışta değişir; kalıcı için: bash scripts/setup_tunnel.sh video.ALANADINIZ.com): ${tunnel.url}`); announceCallbacks(); announce(`Tünel hazır. Dış adres ayarlara yazıldı.`); } };
  child.stdout.on("data", onData); child.stderr.on("data", onData);
  child.on("error", (e) => { tunnel.error = e.code === "ENOENT" ? "cloudflared kurulu değil (brew install cloudflared)" : e.message; tunnel.proc = null; push(`✖ tünel: ${tunnel.error}`); });
  child.on("close", (code) => { tunnel.proc = null; if (code !== 0 && !tunnel.error) tunnel.error = `cloudflared kapandı (kod ${code})`; push(`☁ tünel durdu`); });
  return { ok: true, mode: tunnel.mode, url: tunnel.url, running: true };
}
function stopTunnel() { if (tunnel.proc) tunnel.proc.kill(); tunnel.proc = null; tunnel.url = null; tunnel.hostname = null; return { ok: true }; }
const tunnelStatus = () => ({ running: !!tunnel.proc, url: tunnel.url, mode: tunnel.mode, error: tunnel.error, publicBaseUrl: readEnv().PUBLIC_BASE_URL || null, named: !!(readEnv().TUNNEL_NAME && readEnv().TUNNEL_HOSTNAME), log: tunnel.log.slice(-6) });
app.get("/api/tunnel", (_req, res) => res.json(tunnelStatus()));
app.post("/api/tunnel/start", (_req, res) => res.json(startTunnel()));
app.post("/api/tunnel/stop", (_req, res) => res.json(stopTunnel()));
// TikTok geri dönüşü tünelden geldiğinde publish.py'nin yerel sunucusuna (3137) aktar
app.get("/tiktok/callback", async (req, res) => { try { const r = await fetch("http://127.0.0.1:3137/tiktok/callback?" + new URLSearchParams(req.query).toString()); res.status(r.status).type("html").send(await r.text()); } catch { res.status(503).send("TikTok bağlama işlemi şu an beklemiyor. Panelden 'TikTok'u bağla' deyip tekrar deneyin."); } });
// Instagram geri dönüşü (HTTPS zorunlu) tünelden gelir, publish.py'nin yerel sunucusuna (3138) aktarılır
app.get("/instagram/callback", async (req, res) => { try { const r = await fetch("http://127.0.0.1:3138/instagram/callback?" + new URLSearchParams(req.query).toString()); res.status(r.status).type("html").send(await r.text()); } catch { res.status(503).send("Instagram bağlama işlemi şu an beklemiyor. Panelden 'Instagram'ı bağla' deyip tekrar deneyin."); } });
const waitTunnelUrl = (ms = 25000) => new Promise((resolve) => { const t0 = Date.now(); const tick = () => { if (tunnel.url) return resolve(tunnel.url); if (Date.now() - t0 > ms || (!tunnel.proc && tunnel.error)) return resolve(null); setTimeout(tick, 500); }; tick(); });
if (settings().tunnelAutoStart) setTimeout(() => startTunnel(), 1500);

// ---------- Kaynak izleme: CPU ve RAM (üretim, ses sunucusu, geliştirme sırasında her 10 sn loga)
import { cpus, totalmem, freemem, loadavg } from "node:os";
const res = { cpu: 0, memUsedGb: 0, memTotalGb: +(totalmem() / 1e9).toFixed(1), load: 0, last: null };
let prevCpu = cpus().map((c) => ({ ...c.times }));
function sampleResources() {
  const now = cpus().map((c) => ({ ...c.times })); let idle = 0, total = 0;
  for (let i = 0; i < now.length; i++) { const a = prevCpu[i] || now[i]; for (const k of Object.keys(now[i])) total += now[i][k] - a[k]; idle += now[i].idle - a.idle; }
  prevCpu = now; res.cpu = total ? Math.round((1 - idle / total) * 100) : 0;
  res.memUsedGb = +((totalmem() - freemem()) / 1e9).toFixed(1); res.load = +loadavg()[0].toFixed(1); res.last = Date.now();
  return res;
}
sampleResources();
setInterval(() => { sampleResources(); const busy = state.running || state.improving || (tts.proc && !tts.ready); if (busy) push(`⚙ CPU %${res.cpu} · RAM ${res.memUsedGb}/${res.memTotalGb} GB · yük ${res.load}${state.running ? " · üretim" : ""}${tts.proc && !tts.ready ? " · ses modeli yükleniyor" : ""}`); }, 10000);

// ---------- Doğal ses sunucusu (Chatterbox): sürekli açık tutulmaz; burada yalnızca durum ve kapatma var
const tts = { proc: null, ready: false, device: null, error: null, startedAt: null };
async function ttsHealth() { try { const r = await fetch(`http://127.0.0.1:${settings().chatterbox.port}/health`, { signal: AbortSignal.timeout(1500) }); const j = await r.json(); tts.ready = !!j.ready; tts.device = j.device; if (j.error) tts.error = j.error; return j; } catch { tts.ready = false; return null; } }
function stopTts() {
  if (tts.proc) tts.proc.kill();
  else if (tts.adopted) { try { const pids = String(spawnSync("lsof", ["-ti", `:${settings().chatterbox.port}`]).stdout || "").split(/\s+/).filter(Boolean); for (const pid of pids) { try { process.kill(Number(pid)); } catch { /* yok */ } } } catch { /* lsof yok */ } }
  tts.proc = null; tts.adopted = false; tts.ready = false; return { ok: true };
}
// Türkçe ses motorları durumu (Trendyol MLX kurulu mu, EMA içe aktarılabiliyor mu); EMA kontrolü bir kez yapılır
let emaCache = null;
const turkishVoiceStatus = () => {
  const tv = settings().turkishVoice || {};
  const mlxDir = path.join(ROOT, tv.mlxModel || "models/Trendyol-TTS-mlx");
  const trendyol = existsSync(path.join(ROOT, tv.trendyolBin || ".venv-tr/bin/trendyol-tts")) && existsSync(mlxDir) && readdirSync(mlxDir).length > 0;
  if (emaCache === null) {
    emaCache = [PY, path.join(ROOT, tv.python || ".venv-tr/bin/python")].some((py) => existsSync(py) && spawnSync(py, ["-c", "import ema_lightning"], { timeout: 20000 }).status === 0);
  }
  return { trendyol, ema: emaCache, venv: existsSync(path.join(ROOT, ".venv-tr")) };
};
const ttsStatus = () => ({ running: !!tts.proc || !!tts.adopted, ready: tts.ready, device: tts.device, error: tts.error, refVoice: existsSync(path.join(ROOT, settings().chatterbox.refVoice || "")) ? settings().chatterbox.refVoice : null });
app.get("/api/tts", async (_req, res) => { await ttsHealth(); res.json(ttsStatus()); });
app.post("/api/tts/start", (_req, res) => res.json({ ok: false, error: "Doğal ses (Chatterbox) artık sürekli açık tutulmuyor; yalnızca bu ses seçiliyse üretimde ya da ön dinlemede açılıyor ve iş bitince kapanıyor." }));
app.post("/api/tts/stop", (_req, res) => res.json(stopTts()));
// Model sürekli açık tutulmaz (bilgisayara yük). Panel açılınca önceki oturumdan kalan Chatterbox sunucusu
// varsa ve şu an üretim onu kullanmıyorsa kapatılır; gerektiğinde voices.py iş için açıp kapatır.
setTimeout(async () => { if (pipelineBusy()) return; const alive = await ttsHealth(); if (alive) { tts.adopted = true; stopTts(); push("🎤 açık kalmış doğal ses sunucusu kapatıldı (model artık yalnızca gerektiğinde yükleniyor)"); } }, 3000);
setInterval(() => { if (tts.proc) ttsHealth(); }, 15000);

// ---------- Dosya izleyici: kod/prompt/veri değişiklikleri ve git commit'leri canlı loga düşer
const WATCH_DIRS = ["src", "app", "scripts", "prompts", "launchd"];
const debounce = new Map();
for (const d of WATCH_DIRS) {
  const dir = path.join(ROOT, d); if (!existsSync(dir)) continue;
  try { watch(dir, { recursive: true }, (ev, file) => { if (!file || /(^|\/)(\.|__pycache__|node_modules)/.test(file)) return; const key = `${d}/${file}`; clearTimeout(debounce.get(key)); debounce.set(key, setTimeout(() => { debounce.delete(key); push(`✎ ${ev === "rename" ? "dosya" : "değişti"}: ${key}`); }, 400)); }); } catch { /* izleme desteklenmiyor */ }
}
try { const gitHead = path.join(ROOT, "..", ".git", "logs", "HEAD"); const gitDir = existsSync(gitHead) ? gitHead : path.join(ROOT, ".git", "logs", "HEAD"); if (existsSync(gitDir)) watch(gitDir, () => { clearTimeout(debounce.get("git")); debounce.set("git", setTimeout(async () => { const r = await run("git", ["log", "-1", "--pretty=%h %s"]); if (r.ok) push(`⎇ commit: ${r.stdout.trim()}`); }, 600)); }); } catch { /* yok */ }
try { watch(DATA, (ev, file) => { if (file === "improvements.md") { clearTimeout(debounce.get("imp")); debounce.set("imp", setTimeout(() => push("🛠 geliştirme kuyruğu güncellendi"), 400)); } }); } catch { /* yok */ }

// ---------- tarayıcıda açma (YouTube: yt-dlp ile ilk sonucu bul, yoksa arama sayfası)
const openInBrowser = (url) => run(isMac ? "open" : "xdg-open", [url]);
async function openYouTube(query) {
  const search = "https://www.youtube.com/results?search_query=" + encodeURIComponent(query);
  const r = await run("yt-dlp", ["--no-warnings", "--skip-download", "--print", "%(id)s\t%(title)s", `ytsearch1:${query}`], { timeout: 15000 });
  const line = (r.stdout || "").trim().split("\n")[0] || "";
  const [id, title] = line.split("\t");
  const url = r.ok && id ? `https://www.youtube.com/watch?v=${id}` : search;
  const o = await openInBrowser(url);
  return { ok: o.ok, url, title: r.ok && id ? title : null, viaSearch: !(r.ok && id), error: o.ok ? null : "tarayıcı açılamadı" };
}
const toUrl = (t) => /^https?:\/\//.test(t) ? t : /\.[a-z]{2,}$/i.test(t.replace(/\s/g, "")) ? "https://" + t.replace(/\s/g, "") : "https://www.google.com/search?q=" + encodeURIComponent(t) + "&btnI=1";

// ---------- beyin
const brain = makeBrain({ ROOT, OUT, DATA, listVideos, getSchedule, getState: () => state, pythonBin: PY });
const SAFE = new Set(["generate", "schedule", "note", "sync_metrics", "open_video", "settings", "improvement", "restart", "open_youtube", "open_url", "tunnel", "natural_voice", "whatsapp_send", "connect", "automode", "selftest", "breaking_news"]);
const needsConfirm = (a) => !settings().fullAuthority && !SAFE.has(a.type);
async function execAction(a) {
  switch (a.type) {
    case "generate": return startPipeline(a.duration);
    case "breaking_news": return startAnlik(a.topic, a.duration);
    case "schedule": return setSchedule(!!a.enabled, Number(a.hours) || 5);
    case "note": brain.addNote(a.text); return { ok: true };
    case "sync_metrics": { push("📊 izlenmeler çekiliyor"); const r = await py("sync_metrics.py"); await py("analyze.py"); push(`📊 ${r.ok ? `güncellendi: YT ${r.json?.youtube ?? 0}, IG ${r.json?.instagram ?? 0}, TT ${r.json?.tiktok ?? 0}` : "hata"}`); return { ok: r.ok, ...(r.json || {}) }; }
    case "autopublish": patchSettings({ autopublish: { youtube: !!a.youtube, instagram: !!a.instagram, tiktok: !!a.tiktok } }); return { ok: true };
    case "settings": patchSettings(a.patch || {}); return { ok: true, settings: settings() };
    case "improvement": { const r = queueImprovement(a.task); push(`🛠 geliştirme kuyruğuna eklendi: ${a.task}`); return r; }
    case "restart": setTimeout(() => process.exit(75), 800); return { ok: true, restarting: true };
    case "publish": { const results = {}; for (const p of a.platforms || []) { push(`📤 ${p}: yükleniyor ${a.video}`); const r = await py("publish.py", ["--file", path.basename(a.video), "--platform", p]); for (const l of String(r.stderr || "").split("\n")) if (/^🌐|^  (video|geçici)/.test(l)) push(l.trim()); results[p] = r.json || { ok: false, error: (r.stderr || r.stdout).slice(-300) }; push(`📤 ${p}: ${results[p].ok ? (results[p].skipped ? "zaten yayında" : "tamam " + (results[p].url || results[p].note || "")) : "hata " + results[p].error}`); } await py("analyze.py"); try { wa.clearPending(path.basename(a.video)); } catch { /* yok */ } return { ok: Object.values(results).every((x) => x.ok), results }; }
    case "open_video": return { ok: true };
    case "open_youtube": return openYouTube(String(a.query || ""));
    case "tunnel": return a.enabled === false ? stopTunnel() : startTunnel();
    case "natural_voice": if (a.enabled === false) stopTts(); return { ok: true, note: "Doğal ses (Chatterbox) artık sürekli açık tutulmuyor; yalnızca bu ses seçiliyse üretimde ya da ön dinlemede açılıyor ve iş bitince kapanıyor." };
    case "automode": return setAutoMode(a.enabled !== false);
    case "selftest": return selfTest();
    case "connect": { const plat = ["instagram", "youtube", "tiktok"].includes(a.platform) ? a.platform : "instagram"; const r = await fetch(`http://127.0.0.1:${PORT}/api/connect/${plat}`, { method: "POST" }); return r.json(); }
    case "whatsapp_send": return wa.notifyVideo(a.video || listVideos()[0]?.name, { ask: true });
    case "open_url": { const url = toUrl(String(a.target || a.url || "")); const o = await openInBrowser(url); return { ok: o.ok, url }; }
    default: return { ok: false, error: "bilinmeyen eylem" };
  }
}
async function think(text, mode = "chat") {
  push(`🧠 ${mode === "chat" ? "düşünüyor" : mode === "report" ? "rapor hazırlıyor" : "plan yapıyor"}: ${String(text).slice(0, 80)}`);
  const t0 = Date.now();
  const r = await brain.ask(text, mode);
  push(`🧠 yanıt ${Math.round((Date.now() - t0) / 1000)} sn${r.actions.length ? `, ${r.actions.length} eylem` : ""}${r.error ? " (hata)" : ""}`);
  const done = [], pending = [];
  for (const a of r.actions) { if (needsConfirm(a)) { pending.push(a); push(`⏸ onay bekliyor: ${a.type}`); } else { const res = await execAction(a); push(`⚡ ${a.type}${a.duration ? " " + a.duration + " sn" : ""}${a.platforms ? " → " + a.platforms.join(",") : ""}: ${res?.ok === false ? "hata " + (res.error || "") : "tamam"}`); done.push({ ...a, result: res }); } }
  const reportFile = brain.saveReport(mode === "chat" ? "not" : mode, r.report);
  if (!r.error) brain.addExchange(text, r.reply, [...done, ...pending]);
  return { ...r, done, pending, reportFile };
}

// ---------- WhatsApp köprüsü
const videoInfo = (name) => { const v = name ? listVideos().find((x) => x.name === name) : listVideos()[0]; if (!v) return null; const meta = readJson(path.join(OUT, v.name.replace(/\.mp4$/, ".json")), { segments: [] }); return { ...v, label: label(v), path: path.join(OUT, v.name), segments: meta.segments || [], published: { youtube: !!v.youtube, instagram: !!v.instagram, tiktok: !!v.tiktok } }; };
const waLinks = async (name) => { const conn = await brain.connections(); const platforms = ["youtube", "instagram", "tiktok"].filter((p) => conn[p]?.connected); const base = encodeURIComponent(name.replace(/\.mp4$/, "")); return { lan: `http://${lanIp()}:${PORT}/w/${base}`, tunnel: tunnel.url ? `${tunnel.url}/w/${base}` : null, platforms, thumb: await thumbBuffer(name) }; };
const statusText = async () => {
  const sch = await getSchedule(); const conn = await brain.connections(); const accs = ["youtube", "instagram", "tiktok"].filter((p) => conn[p]?.connected);
  const vids = listVideos(); const ap = settings().autopublish || {};
  const lines = [state.running ? `🎬 Üretim sürüyor (${Math.round((Date.now() - state.startedAt) / 1000)} sn)` : `Şu an üretim yok. Toplam ${vids.length} video.`];
  if (sch.enabled && sch.nextRunAt) { const ms = sch.nextRunAt - Date.now(); const d = new Date(sch.nextRunAt); lines.push(`⏭ Sıradaki: günün ${sch.nextEpisode}. videosu · ${d.toLocaleString("tr-TR", { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" })} · ${Math.max(0, Math.floor(ms / 3.6e6))} sa ${Math.max(0, Math.floor((ms % 3.6e6) / 6e4))} dk kaldı`); } else lines.push("⏸ Otomatik üretim kapalı.");
  lines.push(`📣 Bağlı: ${accs.join(", ") || "hesap yok"} · otomatik yayın: ${Object.keys(ap).filter((k) => ap[k]).join(", ") || "kapalı"} · onay ${settings().whatsapp?.requireApproval === false ? "kapalı" : "açık"}`);
  if (vids[0]) lines.push(`🎞 Son video: ${label(vids[0])}${vids[0].views ? " · ▶ " + vids[0].views : ""}`);
  return lines.join("\n");
};
const wa = await makeWhatsApp({ ROOT, settings, push, announce, handleCommand, videoInfo, links: waLinks, publishVideo: (video, platforms) => execAction({ type: "publish", video, platforms }), automode: (on) => setAutoMode(on), statusText });
app.get("/api/whatsapp", (_req, res) => res.json(wa.status()));
app.post("/api/whatsapp/start", async (_req, res) => res.json(await wa.start()));
app.post("/api/whatsapp/stop", async (_req, res) => res.json(await wa.stop()));
app.post("/api/whatsapp/logout", async (_req, res) => res.json(await wa.logout()));
app.post("/api/whatsapp/test", async (_req, res) => { try { await wa.send("✅ Emixhas test mesajı. Bağlantı çalışıyor."); res.json({ ok: true }); } catch (e) { res.json({ ok: false, error: e.message }); } });
app.post("/api/whatsapp/send-latest", async (req, res) => { const v = listVideos()[0]; if (!v) return res.json({ ok: false, error: "video yok" }); res.json(await wa.notifyVideo(req.body?.name || v.name, { ask: true })); });
if (settings().whatsapp?.enabled && settings().whatsapp?.autoStart) setTimeout(() => wa.start().catch((e) => push(`✖ WhatsApp: ${e.message}`)), 2500);

// Yeni video (panelden veya launchd'den) → WhatsApp bildirimi. out/ klasörü izlenir, bilinen dosyalar atlanır.
const knownVideos = new Set(readdirSync(OUT).filter((f) => f.endsWith(".mp4")));
try { watch(OUT, (ev, file) => { if (!file || !file.endsWith(".json")) return; const mp4 = file.replace(/\.json$/, ".mp4"); setTimeout(async () => { if (knownVideos.has(mp4) || !existsSync(path.join(OUT, mp4))) return; knownVideos.add(mp4); if (settings().whatsapp?.enabled && settings().whatsapp?.notifyOnVideo) { const r = await wa.notifyVideo(mp4, { ask: true }); if (!r.ok) push(`💬 WhatsApp bildirimi gönderilemedi: ${r.error}`); } }, 1500); }); } catch { /* yok */ }

// ---------- API: durum
app.get("/api/status", async (_req, r) => r.json({ ...state, log: state.log.slice(-60), lanUrl: `http://${lanIp()}:${PORT}`, isMac, schedule: await getSchedule(), settings: settings(), connections: await brain.connections(), tunnel: tunnelStatus(), tts: ttsStatus(), turkishVoice: turkishVoiceStatus(), resources: sampleResources(), usage: brain.usageToday(), whatsapp: wa.status() }));
app.get("/api/log", (req, res) => { res.setHeader("Content-Type", "text/event-stream"); res.setHeader("Cache-Control", "no-cache"); res.flushHeaders(); for (const l of state.log.slice(-60)) res.write(`data: ${JSON.stringify(l)}\n\n`); clients.add(res); req.on("close", () => clients.delete(res)); });

// ---------- Telefon için izleme sayfası (kısa link; WhatsApp'tan tıklanır)
const esc = (t) => String(t ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
app.get("/v/:base", (req, res) => res.redirect("/videos/" + encodeURIComponent(path.basename(req.params.base)) + ".mp4"));
app.get("/w/:base", (req, res) => {
  const base = path.basename(req.params.base); const name = base + ".mp4";
  if (!existsSync(path.join(OUT, name))) return res.status(404).send("Video yok");
  const meta = readJson(path.join(OUT, base + ".json"), { segments: [] });
  const haber = (meta.segments || []).filter((x) => x.kind === "haber");
  const title = `${settings().channelName} · ${meta.dateLabel || base}${meta.episodeOfDay ? " · günün " + meta.episodeOfDay + ". özeti" : ""}`;
  res.type("html").send(`<!doctype html><html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>body{margin:0;background:#070A12;color:#E6EBFF;font:16px/1.5 -apple-system,Inter,Helvetica,Arial,sans-serif}main{max-width:520px;margin:0 auto;padding:16px}video{width:100%;border-radius:16px;background:#000;aspect-ratio:9/16}h1{font-size:17px;margin:14px 0 6px}.h{padding:8px 0;border-top:1px solid #1B2440;font-size:14px}.h b{display:block}.t{display:inline-block;font-size:10px;letter-spacing:2px;padding:2px 6px;border-radius:6px;background:#1b2440;color:#8C97BA;margin-right:6px}.t.b{background:#E30A17;color:#fff}a.d{display:block;text-align:center;margin:14px 0;padding:12px;border-radius:12px;background:#E30A17;color:#fff;text-decoration:none;font-weight:700}</style></head>
<body><main><video src="/videos/${encodeURIComponent(name)}" controls autoplay playsinline></video><h1>${esc(title)}</h1>
${haber.map((h, i) => `<div class="h"><span class="t ${h.breaking ? "b" : ""}">${h.breaking ? "SON DAKİKA" : esc((h.category || "genel").toUpperCase())}</span><b>${i + 1}. ${esc(h.title)}</b>${esc(h.narration)}</div>`).join("")}
<a class="d" href="/videos/${encodeURIComponent(name)}" download>⬇ Videoyu indir / paylaş</a></main></body></html>`);
});
async function thumbBuffer(name) { const src = path.join(OUT, name); const dst = path.join(THUMBS, name.replace(/\.mp4$/, ".jpg")); if (!existsSync(dst) && existsSync(src)) await run("ffmpeg", ["-y", "-loglevel", "error", "-ss", "4", "-i", src, "-frames:v" , "1", "-vf", "scale=320:-1", dst]); try { return readFileSync(dst); } catch { return null; } }

// ---------- API: videolar
app.get("/api/videos", (_req, res) => res.json(listVideos()));
app.get("/api/thumb/:name", async (req, res) => { const name = path.basename(req.params.name), src = path.join(OUT, name); if (!existsSync(src)) return res.status(404).end(); const dst = path.join(THUMBS, name.replace(/\.mp4$/, ".jpg")); if (!existsSync(dst)) await run("ffmpeg", ["-y", "-loglevel", "error", "-ss", "4", "-i", src, "-frames:v", "1", "-vf", "scale=360:-1", dst]); res.sendFile(dst); });
app.delete("/api/videos/:name", (req, res) => { const name = path.basename(req.params.name); for (const f of [name, name.replace(/\.mp4$/, ".json")]) { const p = path.join(OUT, f); if (existsSync(p)) unlinkSync(p); } const t = path.join(THUMBS, name.replace(/\.mp4$/, ".jpg")); if (existsSync(t)) unlinkSync(t); res.json({ ok: true }); });
app.post("/api/reveal", async (req, res) => { const p = path.join(OUT, path.basename(req.body.name || "")); if (!existsSync(p) || !isMac) return res.json({ ok: false }); res.json(await run("open", ["-R", p])); });
app.get("/api/qr", async (req, res) => { const url = `http://${lanIp()}:${PORT}` + (req.query.name ? "/videos/" + path.basename(String(req.query.name)) : "/"); res.json({ url, svg: await QRCode.toString(url, { type: "svg", margin: 1, color: { dark: "#FFFFFF", light: "#00000000" } }) }); });

// ---------- API: üretim, zamanlayıcı, ayarlar
app.post("/api/generate", (req, res) => res.json(startPipeline(req.body?.duration)));
// Uyanık tut: zamanlayıcı açıkken macOS 'caffeinate -i -s' ile sistem uykusu engellenir (ekran kapanabilir).
let caffeine = null;
function keepAwake(on) {
  if (!isMac) return;
  if (on && !caffeine) { try { caffeine = spawn("caffeinate", ["-i", "-s"], { stdio: "ignore" }); caffeine.on("close", () => { caffeine = null; }); push("☕ uyanık tutma açık: Mac üretim saatlerini kaçırmasın diye uyumaz (ekran kapanabilir)"); } catch { /* yok */ } }
  if (!on && caffeine) { try { caffeine.kill(); } catch { /* yok */ } caffeine = null; push("☕ uyanık tutma kapandı"); }
}
setTimeout(async () => { try {
  const sch = await getSchedule();
  if (sch.enabled) {
    keepAwake(true);
    // Eski aralık tabanlı plist'i sabit saatlere taşı (bir kez)
    if (!/StartCalendarInterval/.test(readFileSync(PLIST, "utf8"))) { push("⏰ zamanlayıcı sabit saatlere taşınıyor"); await setSchedule(true, sch.hours || 5); }
  }
} catch { /* yok */ } }, 3000);
// ---------- Sistem kontrolü: her açılışta ve istekle; her satır loga, özet sesli + WhatsApp'a
const which = (cmd) => { const r = spawnSync("bash", ["-lc", `command -v ${cmd}`], { env: ENV, encoding: "utf8" }); return r.status === 0 ? r.stdout.trim() : null; };
async function selfTest({ quiet = false } = {}) {
  const rows = []; const add = (ok, what, detail = "") => { rows.push({ ok, what, detail }); push(`🩺 ${ok === true ? "✅" : ok === "warn" ? "⚠️" : "❌"} ${what}${detail ? ": " + detail : ""}`); };
  push("🩺 sistem kontrolü başladı");
  // 1) araçlar
  for (const [cmd, why] of [["ffmpeg", "ses ve video"], ["cloudflared", "yedek tünel (isteğe bağlı)"]]) { const p = which(cmd); add(p ? true : cmd === "cloudflared" ? "warn" : false, `${cmd} (${why})`, p || "bulunamadı"); }
  // Claude (beyin + senaryo): yolu bul, küçük bir istekle oturumun açık olduğunu doğrula
  const cb = claudeBin(ROOT, { fresh: true });
  if (!cb) add(false, "Claude Code (beyin ve senaryo)", claudeError("ENOENT"));
  else {
    const ping = await new Promise((res) => { execFile(cb, ["-p", ...claudeModelArgs(settings()), "--effort", "low", "--output-format", "json"], { cwd: ROOT, env: claudeEnv(cb), timeout: 90000 }, (e, out, err) => { let j = null; try { j = JSON.parse(out); } catch { /* json değil */ } res(!e && j && !j.is_error ? { ok: true } : { ok: false, msg: `${j?.result || ""} ${err || ""} ${e?.message || ""}` }); }).stdin.end("Sadece TAMAM yaz."); });
    add(ping.ok ? true : false, "Claude Code (beyin ve senaryo)", ping.ok ? `yanıt veriyor (model: ${settings().claudeModel ?? "opus"})` : claudeError(ping.msg));
  }
  add(existsSync(PY) ? true : "warn", "Python sanal ortamı", PY);
  // 2) disk ve videolar
  try { const df = spawnSync("df", ["-h", ROOT], { encoding: "utf8" }).stdout.trim().split("\n").pop().split(/\s+/); add(true, "Disk", `boş ${df[3]} (kullanım ${df[4]})`); } catch { /* yok */ }
  const vids = listVideos(); add(vids.length ? true : "warn", "Videolar", vids.length ? `${vids.length} video, son: ${label(vids[0])}` : "henüz video yok");
  // 3) haber kaynakları
  const nf = await runPy(["scripts/fetch_news.py", path.join(WORK, "selftest_news.json")], 60000);
  let nCount = 0; try { nCount = (JSON.parse(readFileSync(path.join(WORK, "selftest_news.json"), "utf8")).items || []).length; } catch { /* yok */ }
  add(nCount >= 20 ? true : nCount > 0 ? "warn" : false, "Haber kaynakları", nCount ? `${nCount} haber çekildi` : (nf.stderr || "haber çekilemedi").slice(-160));
  // 4) hesaplar ve köprü
  const conn = await brain.connections();
  add(conn.youtube?.connected ? true : "warn", "YouTube", conn.youtube?.connected ? "bağlı" : "bağlı değil (Ayarlar → Yayın hesapları)");
  add(conn.instagram?.connected ? true : "warn", "Instagram", conn.instagram?.connected ? `bağlı${conn.instagram.username ? " @" + conn.instagram.username : ""}` : "bağlı değil");
  add(conn.tiktok?.connected ? true : "warn", "TikTok", conn.tiktok?.connected ? `bağlı (${conn.tiktok.mode})` : "bağlı değil");
  const hc = await runPy(["scripts/hostinger.py", "--check"], 30000); let hj = {}; try { hj = JSON.parse(hc.stdout.trim().split("\n").pop()); } catch { /* yok */ }
  add(hj.configured ? (hj.callback ? true : false) : "warn", "Kalıcı köprü (Hostinger)", hj.configured ? (hj.callback ? `${hj.site} erişilebilir` : `${hj.site} geri dönüş adresine ulaşılamadı`) : "ayarlı değil; yayında geçici tünel kullanılır");
  // 5) WhatsApp
  const w = wa.status(); add(w.status === "connected" ? true : "warn", "WhatsApp", w.status === "connected" ? `bağlı +${w.phone}, sahip +${w.owner || settings().whatsapp?.owner}` : w.status);
  // 6) sesler
  const vl = await runPy(["scripts/voices.py", "--list"], 60000); let voicesReady = []; try { voicesReady = JSON.parse(vl.stdout.trim().split("\n").pop()).filter((v) => v.ready).map((v) => v.label); } catch { /* yok */ }
  const narr = settings().narration || {}; add(voicesReady.length ? true : false, "Ses motorları", voicesReady.length ? `hazır: ${voicesReady.join(", ")} · anlatım: ${narr.mode === "alternate" ? narr.voiceA + " + " + narr.voiceB : narr.voice || "auto"}` : "hiçbir ses motoru hazır değil");
  const th = await ttsHealth(); add(th?.ready ? true : "warn", "Chatterbox sunucusu", th?.ready ? `hazır (${th.device})` : "kapalı (yedek motor)");
  // 7) zamanlayıcı ve otomasyon
  const sch = await getSchedule(); const ap = settings().autopublish || {}; const auto = Object.keys(ap).filter((k) => ap[k]);
  add(sch.enabled ? true : "warn", "Zamanlayıcı", sch.enabled ? `her ${sch.hours} saat · sıradaki günün ${sch.nextEpisode}. videosu ${new Date(sch.nextRunAt).toLocaleString("tr-TR", { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" })}${sch.awake ? " · Mac uyanık tutuluyor" : " · ⚠ uyanık tutma kapalı"}` : "kapalı (Ayarlar → Otomasyon)");
  add(auto.length ? true : "warn", "Otomatik yayın", auto.length ? `${auto.join(", ")} · onay ${settings().whatsapp?.requireApproval === false ? "kapalı" : "açık"}` : "kapalı");
  add(settings().whatsapp?.notifyStages !== false ? true : "warn", "Aşama bildirimleri", settings().whatsapp?.notifyStages !== false ? "açık" : "kapalı");
  const fails = rows.filter((r) => r.ok === false), warns = rows.filter((r) => r.ok === "warn");
  const summary = `Sistem kontrolü: ${rows.length - fails.length - warns.length} tamam, ${warns.length} uyarı, ${fails.length} hata.` + (fails.length ? " Hata: " + fails.map((r) => r.what).join(", ") + "." : "") + (warns.length ? " Uyarı: " + warns.map((r) => r.what).join(", ") + "." : "");
  push(`🩺 ${summary}`);
  state.selfTest = { at: Date.now(), rows, summary };
  if (!quiet) { announce(summary); try { await wa.send("🩺 " + summary + "\n" + rows.map((r) => `${r.ok === true ? "✅" : r.ok === "warn" ? "⚠️" : "❌"} ${r.what}${r.detail ? ": " + r.detail : ""}`).join("\n")); } catch { /* bağlı değil */ } }
  return state.selfTest;
}
app.post("/api/selftest", async (_req, res) => res.json(await selfTest()));
// Açılışta: WhatsApp'ın bağlanmasına fırsat ver, sonra tam kontrol
setTimeout(() => selfTest().catch((e) => push(`🩺 kontrol hatası: ${e.message}`)), 12000);
// Tam otomatik mod: 5 saatte bir üretim + bağlı hesaplara otomatik yayın + onay kapalı + aşama bildirimleri
async function setAutoMode(on) {
  const conn = await brain.connections();
  const connected = ["youtube", "instagram", "tiktok"].filter((p) => conn[p]?.connected);
  if (on) {
    const hours = Number(settings().scheduleHours) || 5;
    const sch = await setSchedule(true, hours);
    if (!sch.ok) return { ok: false, error: sch.error };
    patchSettings({ autopublish: { youtube: connected.includes("youtube"), instagram: connected.includes("instagram"), tiktok: connected.includes("tiktok") }, whatsapp: { requireApproval: false, notifyStages: true, notifyOnVideo: true }, scheduleHours: hours });
    push(`⚡ tam otomatik mod: her ${hours} saatte üretim, otomatik yayın → ${connected.join(", ") || "bağlı hesap yok"}, onay kapalı`);
    return { ok: true, connected, hours };
  }
  await setSchedule(false, 5);
  patchSettings({ autopublish: { youtube: false, instagram: false, tiktok: false }, whatsapp: { requireApproval: true } });
  push("⏹ otomatik mod kapatıldı: üretim ve otomatik yayın durdu");
  return { ok: true, connected };
}
app.post("/api/automode", async (req, res) => res.json(await setAutoMode(req.body?.enabled !== false)));
app.get("/api/schedule", async (_req, res) => res.json(await getSchedule()));
app.post("/api/schedule", async (req, res) => res.json(await setSchedule(!!req.body.enabled, Number(req.body.hours) || 5)));
// Ses kataloğu: kurulu sesler ve ön dinleme (scripts/voices.py). Liste 30 sn önbellekli.
let voiceCache = { t: 0, rows: [] };
const runPy = (args, timeoutMs) => new Promise((resolve) => execFile(PY, args, { cwd: ROOT, env: ENV, timeout: timeoutMs, maxBuffer: 4e6 }, (err, stdout, stderr) => resolve({ err, stdout: String(stdout || ""), stderr: String(stderr || "") })));
app.get("/api/voices", async (req, res) => {
  if (req.query.fresh || Date.now() - voiceCache.t > 30000) {
    const r = await runPy(["scripts/voices.py", "--list"], 60000);
    try { voiceCache = { t: Date.now(), rows: JSON.parse(r.stdout.trim().split("\n").pop()) }; } catch { /* eski liste kalır */ }
  }
  const rows = voiceCache.rows.map((v) => ({ ...v, preview: existsSync(path.join(ROOT, "data", "previews", v.id + ".wav")) ? `/previews/${v.id}.wav` : null }));
  res.json({ voices: rows, narration: settings().narration });
});
app.post("/api/voices/preview", async (req, res) => {
  const id = String(req.body.voice || "").replace(/[^a-z0-9çğıöşü_-]/g, "");
  if (!id) return res.status(400).json({ ok: false, error: "ses yok" });
  const out = path.join(ROOT, "data", "previews", id + ".wav");
  if (!req.body.fresh && existsSync(out)) return res.json({ ok: true, url: `/previews/${id}.wav`, cached: true });
  push(`🎤 ön dinleme üretiliyor: ${id}`);
  const args = ["scripts/voices.py", "--preview", id, "--out", out];
  if (req.body.text) args.push("--text", String(req.body.text).slice(0, 300));
  const r = await runPy(args, 600000);
  let j = {};
  try { j = JSON.parse(r.stdout.trim().split("\n").pop()); } catch { j = { ok: false, error: (r.stderr || r.err?.message || "çıktı yok").slice(-300) }; }
  if (!j.ok) { push(`🎤 ön dinleme başarısız (${id}): ${j.error}`); return res.json(j); }
  push(`🎤 ön dinleme hazır: ${id}`);
  res.json({ ok: true, url: `/previews/${id}.wav?t=${Date.now()}` });
});
app.get("/api/settings", (_req, res) => res.json(settings()));
app.post("/api/settings", (req, res) => res.json(patchSettings(req.body)));
app.get("/api/improvements", (_req, res) => res.type("text/markdown").send(existsSync(IMPROVEMENTS) ? readFileSync(IMPROVEMENTS, "utf8") : ""));
app.post("/api/restart", (_req, res) => { res.json({ ok: true }); push("↻ panel yeniden başlatılıyor"); setTimeout(() => process.exit(75), 500); });
// Panelden güncelleme: git pull, bağımlılık değiştiyse npm install, sonra yeniden başlat (terminal gerekmez)
const headCommit = () => spawnSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).stdout?.trim() || "";
const BOOT_COMMIT = headCommit(); // çalışan kodun sürümü; terminalden git pull yapıldıysa HEAD bundan ileride olur
app.post("/api/update", async (_req, res) => {
  push("⬇ güncelleme: git pull");
  const r = await run("git", ["pull", "--ff-only"]);
  const out = (r.stdout || r.stderr || "").trim();
  for (const line of out.split("\n").slice(-8)) push("  " + line);
  if (!r.ok) return res.json({ ok: false, error: out.slice(-300) });
  const changed = /package(-lock)?\.json/.test(out);
  if (changed) { push("⬇ bağımlılıklar güncelleniyor (npm install)"); await run("npm", ["install", "--no-audit", "--no-fund"]); }
  const stale = headCommit() !== BOOT_COMMIT; // yeni kod var ama panel eski sürümü çalıştırıyor
  const pulled = !/Already up to date|Zaten güncel/i.test(out);
  res.json({ ok: true, upToDate: !pulled && !stale, restarting: pulled || stale, summary: out.split("\n").pop() });
  if (pulled || stale) { push(pulled ? "↻ güncelleme alındı, panel yeniden başlatılıyor" : "↻ yeni kod zaten çekilmiş, panel yeniden başlatılıyor"); setTimeout(() => process.exit(75), 800); }
});

// ---------- API: yayın, metrik, analiz, raporlar, hafıza
app.get("/api/connections", async (_req, res) => res.json(await brain.connections()));
app.post("/api/connect/youtube", async (_req, res) => { const r = await py("publish.py", ["--connect", "youtube"]); res.json(r.json || { ok: false, error: (r.stderr || r.stdout).slice(-400) }); });
let igConnect = null; // süren bağlanma denemesi (publish.py --connect instagram)
app.post("/api/connect/instagram", async (_req, res) => {
  // Geri dönüş adresi HTTPS olmalı: Hostinger köprüsü varsa sabit adres kullanılır, yoksa tünel açılır
  const conn = await brain.connections();
  let url;
  if (conn.instagram?.hostinger) { url = conn.instagram.hostingerUrl; }
  else {
    if (!tunnel.url) { const st = startTunnel(); if (!st.ok) return res.json({ ok: false, error: st.error }); push("☁ Instagram bağlantısı için tünel açılıyor"); }
    url = await waitTunnelUrl();
    if (!url) return res.json({ ok: false, error: tunnel.error || "tünel adresi alınamadı; cloudflared kurulu mu?" });
  }
  if (igConnect) { try { igConnect.kill(); } catch { /* yok */ } igConnect = null; }
  // Eski bir deneme (panel yeniden başlamadan önce) :3138'i tutuyorsa kapat
  try { const pids = String(spawnSync("lsof", ["-ti", ":3138"]).stdout || "").split(/\s+/).filter(Boolean); for (const pid of pids) { try { process.kill(Number(pid)); } catch { /* yok */ } } if (pids.length) { push(`◎ eski bağlanma denemesi kapatıldı (${pids.length})`); await new Promise((r) => setTimeout(r, 800)); } } catch { /* lsof yok */ }
  push(`◎ Instagram girişi başlatılıyor; geri dönüş ${url}/instagram/callback${conn.instagram?.hostinger ? "/" : ""} (Meta'da kayıtlı olmalı)`);
  const child = spawn(PY, ["scripts/publish.py", "--connect", "instagram"], { cwd: ROOT, env: ENV });
  igConnect = child;
  let authUrl = null, out = "", err = "";
  const done = new Promise((resolve) => child.on("close", () => resolve()));
  child.stdout.on("data", (b) => { out += b; });
  child.stderr.on("data", (b) => { err += b; const m = String(b).match(/AUTH_URL (\S+)/); if (m) authUrl = m[1]; });
  // Giriş adresi gelir gelmez yanıt ver; tarayıcıyı panel sayfası açar (servis olarak çalışırken de güvenilir)
  for (let i = 0; i < 60 && !authUrl && child.exitCode === null; i++) await new Promise((r) => setTimeout(r, 250));
  if (!authUrl) { await done; igConnect = null; let j = {}; try { j = JSON.parse(out.trim().split("\n").pop()); } catch { j = { ok: false, error: (err || out).trim().slice(-300) || "giriş adresi üretilemedi" }; } push(`◎ Instagram: ${j.ok ? "bağlandı" : j.error}`); return res.json(j); }
  res.json({ ok: true, pending: true, authUrl });
  await done; igConnect = null;
  let j = {}; try { j = JSON.parse(out.trim().split("\n").pop()); } catch { j = { ok: false, error: (err || out).trim().slice(-300) }; }
  if (j.ok) { push(`◎ Instagram bağlandı: @${j.username || "?"}`); announce(`Instagram bağlandı.`); } else push(`◎ Instagram bağlanamadı: ${j.error}`);
});
app.post("/api/hostinger/setup", async (_req, res) => { push("🌐 Hostinger köprüsü kuruluyor"); const r = await runPy(["scripts/hostinger.py", "--setup"], 120000); const lines = (r.stdout + r.stderr).trim().split("\n"); for (const l of lines.slice(-8)) push("  " + l); let j = {}; try { j = JSON.parse(lines.filter((l) => l.startsWith("{")).pop() || "{}"); } catch { /* yok */ } res.json({ ok: !!j.ok, ...j, log: lines.slice(-8).join("\n") }); });
app.post("/api/connect/tiktok", async (_req, res) => { const r = await py("publish.py", ["--connect", "tiktok"]); res.json(r.json || { ok: false, error: (r.stderr || r.stdout).slice(-400) }); });
app.post("/api/publish", async (req, res) => res.json(await execAction({ type: "publish", video: req.body.name, platforms: req.body.platforms || [] })));
app.post("/api/metrics/sync", async (_req, res) => res.json(await execAction({ type: "sync_metrics" })));
app.get("/api/insights", (_req, res) => res.json(readJson(path.join(DATA, "insights.json"), null)));
app.post("/api/analyze", async (_req, res) => { await py("analyze.py"); res.json(readJson(path.join(DATA, "insights.json"), null)); });
app.get("/api/reports", (_req, res) => res.json(readdirSync(path.join(DATA, "reports")).filter((f) => f.endsWith(".md")).sort().reverse()));
app.get("/api/reports/:name", (req, res) => { const p = path.join(DATA, "reports", path.basename(req.params.name)); existsSync(p) ? res.type("text/markdown").send(readFileSync(p, "utf8")) : res.status(404).end(); });
app.get("/api/memory", (_req, res) => res.json(brain.memory()));

// ---------- API: Jarvis (beyin) ve eylem onayı
app.post("/api/ask", async (req, res) => { state.busy = "düşünüyor"; try { res.json(await think(String(req.body?.text || ""), req.body?.mode || "chat")); } finally { state.busy = null; } });
app.post("/api/actions", async (req, res) => { const out = []; for (const a of req.body?.actions || []) out.push({ ...a, result: await execAction(a) }); res.json(out); });

// ---------- API: sesli komut → kural, kural yoksa beyin
async function handleCommand(text) {
  text = String(text || ""); const cmd = parseCommand(text); const videos = listVideos();
  let reply = cmd.reply, action = cmd.action, payload = {}, extra = {};
  switch (cmd.action) {
    case "anlik": { const r = startAnlik(cmd.topic, cmd.duration); reply = !r.ok ? r.error : r.queued ? `Anlık haber ${r.position}. sıraya alındı. Süren üretim bitince başlayacak.` : `Son dakika videosu üretiliyor: ${String(cmd.topic).slice(0, 60)}. Bitince haber vereceğim.`; if (!r.ok) action = "none"; break; }
    case "generate": { const r = startPipeline(cmd.duration); reply = r.ok ? `${r.duration} saniyelik gündem videosu üretiliyor. Bitince haber vereceğim.` : r.error; if (!r.ok) action = "none"; break; }
    case "play_latest": if (!videos.length) { reply = "Henüz üretilmiş video yok."; action = "none"; } else { payload = { name: videos[0].name }; reply = `Son video açılıyor: ${label(videos[0])}.`; } break;
    case "status": reply = await statusText(); break;
    case "selftest": { const r = await selfTest({ quiet: true }); reply = r.summary; break; }
    case "share": if (!videos.length) { reply = "Paylaşacak video yok."; action = "none"; } else { payload = { name: videos[0].name }; reply = "Paylaşım paneli açıldı. Telefonunuzla QR kodu okutun."; } break;
    case "reveal": if (videos[0] && isMac) { await run("open", ["-R", path.join(OUT, videos[0].name)]); reply = "Finder'da gösteriliyor."; } else { reply = "Gösterilecek video yok."; action = "none"; } break;
    case "schedule_on": case "schedule_off": { const r = await setSchedule(cmd.action === "schedule_on", cmd.hours || 5); reply = r.ok ? (cmd.action === "schedule_on" ? `Otomatik üretim açıldı, her ${cmd.hours || 5} saatte bir.` : "Otomatik üretim kapatıldı.") : `Zamanlayıcı ayarlanamadı: ${r.error}`; break; }
    case "sync_metrics": { const r = await execAction({ type: "sync_metrics" }); reply = r.ok ? `İzlenmeler güncellendi: YouTube ${r.youtube ?? 0}, Instagram ${r.instagram ?? 0}, TikTok ${r.tiktok ?? 0} video.` : "İzlenmeler güncellenemedi. Bağlantıları kontrol edin."; break; }
    case "publish": { if (!videos[0]) { reply = "Yayınlanacak video yok."; action = "none"; break; } const plats = cmd.platforms.length ? cmd.platforms : ["youtube", "instagram", "tiktok"]; const act = { type: "publish", video: videos[0].name, platforms: plats };
      if (needsConfirm(act)) { action = "confirm"; payload = { actions: [act] }; reply = `${label(videos[0])} ${plats.join(" ve ")} üzerinde yayınlansın mı? Onaylamak için ekrandaki düğmeye basın.`; }
      else { const r = await execAction(act); reply = r.ok ? `${label(videos[0])} ${plats.join(" ve ")} üzerinde yayınlandı.` : "Yayında sorun oldu: " + Object.values(r.results || {}).map((x) => x.error).filter(Boolean).join("; "); } break; }
    case "voice_speed": { const v = settings().voice; const rate = Math.max(140, Math.min(280, Number(v.rate) + cmd.delta)); patchSettings({ voice: { rate } }); reply = cmd.delta > 0 ? `Tamam, daha hızlı konuşuyorum. Hız ${rate}.` : `Tamam, daha yavaş konuşuyorum. Hız ${rate}.`; break; }
    case "stop": reply = ""; break;
    case "tunnel_on": { const r = startTunnel(); reply = r.ok ? (r.url ? `Tünel açık: ${r.url.replace("https://", "")}.` : "Tünel başlatılıyor, adres gelince söylerim.") : `Tünel başlatılamadı: ${r.error}`; break; }
    case "tunnel_off": stopTunnel(); reply = "Tünel kapatıldı."; break;
    case "whatsapp_on": { const r = await wa.start(); reply = r.status === "connected" ? `WhatsApp zaten bağlı: +${r.phone}.` : "WhatsApp bağlantısı başlatıldı; QR kodu Ayarlar sekmesinde okutun."; break; }
    case "whatsapp_send": { const v = listVideos()[0]; if (!v) { reply = "Gönderilecek video yok."; break; } const r = await wa.notifyVideo(v.name, { ask: true }); reply = r.ok ? "WhatsApp'a gönderildi." : `Gönderilemedi: ${r.error}`; break; }
    case "voice_natural_on": reply = "Doğal ses (Chatterbox) artık sürekli açık tutulmuyor; yalnızca bu ses seçiliyse üretimde ya da ön dinlemede açılıyor ve iş bitince kapanıyor."; break;
    case "voice_natural_off": stopTts(); patchSettings({ voice: { engine: "auto" } }); reply = "Doğal ses kapatıldı, sistem sesine döndüm."; break;
    case "open_youtube": { const r = await openYouTube(cmd.query); reply = r.ok ? (r.title ? `Açıyorum: ${r.title}.` : `YouTube'da "${cmd.query}" araması açıldı.`) : `Açamadım: ${r.error}`; payload = { url: r.url }; break; }
    case "open_url": { const r = await execAction({ type: "open_url", target: cmd.target }); reply = r.ok ? "Açıyorum." : "Açamadım."; payload = { url: r.url }; break; }
    case "report": case "plan": case "brain": { state.busy = "düşünüyor"; try { const r = await think(text, cmd.action === "brain" ? "chat" : cmd.action); reply = r.reply; extra = { report: r.report, reportFile: r.reportFile, done: r.done, pending: r.pending }; action = r.pending.length ? "confirm" : (r.done.find((d) => d.type === "open_video") ? "play_named" : cmd.action); if (r.pending.length) payload = { actions: r.pending }; const ov = r.done.find((d) => d.type === "open_video"); if (ov) payload = { name: ov.video }; } finally { state.busy = null; } break; }
    default: break;
  }
  if (!["report", "plan", "brain", "none", "stop"].includes(cmd.action) && reply) brain.addExchange(text, reply, [{ type: cmd.action }]);
  return { action, reply, payload, heard: text, ...extra };
}
app.post("/api/command", async (req, res) => res.json(await handleCommand(req.body?.text)));

// ---------- Jarvis sesi
app.post("/api/speak", (req, res) => { const text = String(req.body?.text || "").slice(0, 500); const child = spawn(PY, ["scripts/speak.py"], { cwd: ROOT, env: ENV }); const chunks = []; child.stdout.on("data", (c) => chunks.push(c)); child.on("close", (code) => { if (code !== 0 || !chunks.length) return res.status(204).end(); res.setHeader("Content-Type", "audio/wav"); res.send(Buffer.concat(chunks)); }); child.stdin.end(text); });

// ---------- arka plan görevleri: metrik senkronu, günlük rapor
let lastReportDay = null;
setInterval(async () => {
  const s = settings();
  const conn = await brain.connections();
  const anyConnected = conn.youtube?.connected || conn.instagram?.connected || conn.tiktok?.connected;
  const m = readJson(path.join(DATA, "metrics.json"), { lastSync: null });
  const due = !m.lastSync || Date.now() - Date.parse(m.lastSync) > s.metricsSyncMinutes * 60000;
  if (anyConnected && due && !state.running) { await execAction({ type: "sync_metrics" }); push("· izlenmeler güncellendi"); }
  const now = new Date(); const day = now.toISOString().slice(0, 10);
  if (now.getHours() === Number(s.dailyReportHour) && lastReportDay !== day && !state.running) { lastReportDay = day; const r = await think("günlük rapor", "report"); announce(r.reply, { report: r.report, reportFile: r.reportFile }); push(`· günlük rapor hazır: ${r.reportFile}`); }
}, 60000);

app.listen(PORT, "0.0.0.0", () => console.log(`EMIXHAS paneli: http://localhost:${PORT}   (telefon: http://${lanIp()}:${PORT})`));
