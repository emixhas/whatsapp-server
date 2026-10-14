// Türkiye Gündemi — JARVIS paneli. Tamamen yerel (localhost + aynı Wi-Fi); beyin için claude -p.
// Başlat: npm run panel   → http://localhost:3131
import express from "express";
import { spawn, execFile, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, rmSync, statfsSync, statSync, unlinkSync, watch, writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import QRCode from "qrcode";
import { parseCommand } from "./commands.js";
import { parseWhen, whenLabel } from "./when.js";
import { makeBrain, claudeBin, claudeEnv, claudeError, claudeModelArgs, CLAUDE_LEAN, claudeCwd } from "./brain.js";
import { makeWhatsApp } from "./whatsapp.js";

// WhatsApp şifreleme kütüphanesi (libsignal) oturum açılıp kapanırken oturumun TAMAMINI (özel anahtarlar dahil)
// konsola ve work/panel.log'a basıyor. Gizli bilgi loga ve terminale düşmesin diye bu satırlar susturulur.
const SIGNAL_NOISE = /^(Closing session|Opening session|Removing old closed session|Session already (closed|open)|Closing open session|Migrating session|Decrypted message with closed session)/;
for (const k of ["log", "info", "warn"]) { const orig = console[k].bind(console); console[k] = (...a) => { if (typeof a[0] === "string" && SIGNAL_NOISE.test(a[0])) return; if (a.some((x) => x && typeof x === "object" && /^Session(Entry|Record)$/.test(x.constructor?.name || ""))) return; orig(...a); }; }

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
const defaults = { autopublish: { youtube: false, instagram: false, tiktok: false }, dailyReportHour: 9, metricsSyncMinutes: 20, channelName: "Türkiye Gündemi", hashtags: "#gündem #haber #türkiye #sondakika #shorts",
  assistantName: "Emixhas", wakeWords: ["emixhas", "emiks has", "emiks", "emix", "emixas", "emikhas", "emihas", "e mix has", "emiş has", "emişhas"], fullAuthority: true,
  voice: { engine: "auto", name: "Yelda", rate: 195, piperLength: 0.85, piperNoise: 0.5 }, narrationEngine: "auto", narration: { mode: "single", voice: "auto", voiceA: "vox-kadin", voiceB: "vox-erkek", femaleGainDb: 3, maleGainDb: 0 }, tunnelAutoStart: false, claudeModel: "opus", mynet: { enabled: true, url: "https://www.mynet.com/", count: 6, intervalMin: 30, maxPerDay: 3, duration: 30 }, youtubePolicy: { onlyValuable: true, extraDailyMax: 3, extraKeywords: [] }, anlikAutoPublish: true, media: { video: true, maxVideoSeconds: 20, allowYoutubeEmbeds: true }, claudeEffort: { script: "medium", brain: "high", chat: "low" },
  chatterbox: { port: 3139, refVoice: "voices/ref.wav", exaggeration: 0.45, cfg: 0.5 },
  turkishVoice: { python: ".venv-tr/bin/python", trendyolBin: ".venv-tr/bin/trendyol-tts", mlxModel: "models/Trendyol-TTS-mlx", torchModel: "Trendyol/Trendyol-TTS", baseModel: "openbmb/VoxCPM2", backend: "auto", cfg: 2.0, steps: 16, seed: 42, refVoice: "", emaSpeed: 1.0 },
  stageVoice: { enabled: true, macSpeaker: true, quietFrom: 23, quietTo: 8 },
  whatsapp: { enabled: true, owner: "905321308827", notifyOnVideo: true, sendVideoFile: true, requireApproval: true, autoStart: true, notifyStages: true, digest: true }, scheduleHours: 5 };
const deepMerge = (a, b) => { const o = { ...a }; for (const [k, v] of Object.entries(b || {})) o[k] = v && typeof v === "object" && !Array.isArray(v) ? deepMerge(a[k] || {}, v) : v; return o; };
const settings = () => deepMerge(defaults, readJson(SETTINGS, {}));
const patchSettings = (patch) => { const s = deepMerge(settings(), patch); writeJson(SETTINGS, s); return s; };
// Tek seferlik geçiş: YouTube gömmeleri kısa süre varsayılan kapalıydı; kullanıcı kararıyla açık olmalı
// kademeli izlenme takibi (ilk 3 gün sık, sonra günde bir, 7 günden sonra yok): eski varsayılan 60 dk → 20 dk (bir kez)
if (!settings().metricsSyncMigrated) patchSettings({ metricsSyncMinutes: Number(settings().metricsSyncMinutes) === 60 ? 20 : settings().metricsSyncMinutes, metricsSyncMigrated: true });
if (settings().media?.allowYoutubeEmbeds === false && !settings().media?.ytEmbedsMigrated) patchSettings({ media: { allowYoutubeEmbeds: true, ytEmbedsMigrated: true } });
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
      youtube: m.youtube || null, instagram: m.instagram || null, tiktok: m.tiktok || null, remakeOf: meta?.remakeOf || null, peakHour: meta?.peakHour ?? null,
      // panel araması: başlıklar, seslendirme, kaynaklar, tarih, format (küçük harf, Türkçe)
      search: meta ? [meta.publishTitle, meta.titles?.A, meta.titles?.B, meta.dayLabel, meta.slotLabel, meta.formatLabel, meta.sourceName, ...(meta.hashtags || []),
        ...meta.segments.flatMap((x) => [x.title, x.narration, x.source])].filter(Boolean).join(" ").toLocaleLowerCase("tr-TR").slice(0, 4000) : f.toLowerCase(),
      views: (m.youtube?.views || 0) + (m.instagram?.views || 0) + (m.tiktok?.views || 0) };
  }).sort((a, b) => b.mtime - a.mtime);
}

// ---------- üretim durumu + canlı log (SSE)
const state = { running: false, startedAt: null, duration: null, log: [], exitCode: null, lastVideo: null, busy: null };
const clients = new Set();
const NOISE = /\[mcp-sdk\]|SEP-\d{3,}|ExperimentalWarning|punycode|DeprecationWarning/;
const push = (line) => { if (NOISE.test(line)) return; state.log.push(line); if (state.log.length > 400) state.log.shift(); for (const r of clients) r.write(`data: ${JSON.stringify(line)}\n\n`); notifyStage(line); setImmediate(() => { try { stageVoice(line); } catch { /* henüz hazır değil */ } });
  // altyazı denetimi sorun bulduysa (scripts/caption_qa.py) WhatsApp'a da bildir (12 saatte bir)
  if (/^⚠️ 🔤 altyazı denetimi/.test(line)) setImmediate(() => { try { healthAlert("caption-qa", line.replace(/^⚠️ 🔤 /, "Altyazı kayıyor: "), { everyH: 12 }); } catch { /* henüz hazır değil */ } });
  // her üretimin son satırı (post_pipeline.py): zamanlayıcıdan gelen üretimlerde de modeller kapatılıp bildirilir
  if (/^\{"autopublish"/.test(line)) { setTimeout(() => { try { finishProduction("üretim bitti"); } catch { /* yok */ } }, 5000); setTimeout(() => sendDigest("yayın bitti"), 4000); }
  if (/^✖ üretim hata/.test(line)) setTimeout(() => { try { productionFailed(line); } catch { /* yok */ } }, 1500);
  if (/^📤 (yayınlanamadı|otomatik yayın yapılmadı)/.test(line)) setTimeout(() => { try { publishFailed(line); } catch { /* yok */ } }, 1500);
  if (/^✖ üretim hata/.test(line) && digestPending) digestPending = null; }; // hata uyarısı ayrı gider; yarım özet kalmasın
// Aşama bildirimleri: üretim, ses, render, yükleme/silme, yayın satırları WhatsApp'a kısa mesaj olarak gider (settings.whatsapp.notifyStages)
const STAGE = /^(⚡ |🤖 |⏰ zamanlayıcı|✔ zamanlayıcı|kapaklar hazır|== .*üretim başladı|-- \d\/4|-- (görseller|kapaklar|yayın ve analiz)|== bitti|\[[^\]]+\] \d+ segment|senaryo hazır|\d+ haber Claude'a gidiyor|✔ üretim|✖ üretim|📤 |🌐 |  ! |!! |  kategori |  🧩|  🛠)/;
let stageQueue = [], stageTimer = null;
// Tek mesaj modu (settings.whatsapp.digest, varsayılan açık; kullanıcı isteği: her adım için ayrı mesaj gelmesin):
// aşama satırları WhatsApp'a gitmez; video çıkınca beklenir, yayın bitince (post_pipeline'ın son JSON satırı) video
// dosyası + başlıklar + platform sonuçları + linkler + varsa onay TEK mesajda gider (wa.notifyVideo {summary}).
// Yayın adımı hiç bitmezse 20 dk sonra yine gönderilir. Kapalıysa eski davranış: aşamalar + ayrı video mesajları.
const waDigest = () => settings().whatsapp?.digest !== false;
let digestPending = null; // {mp4, at, logFrom}
async function sendDigest(why) {
  const d = digestPending; if (!d) return;
  digestPending = null;
  const summary = state.log.slice(Math.max(0, state.log.length - 200)).filter((l) => /^📤 /.test(l) && !/tekrar denenecek/.test(l));
  try { const r = await wa.notifyVideo(d.mp4, { ask: true, summary }); if (!r.ok) push(`💬 WhatsApp özeti gönderilemedi: ${r.error}`); } catch (e) { push(`💬 WhatsApp özeti gönderilemedi: ${e.message}`); }
  if (why !== "yayın bitti") push(`💬 WhatsApp özeti ${why} gönderildi`);
}
function notifyStage(line) {
  try {
    const w = settings().whatsapp || {};
    if (!w.notifyStages || waDigest() || !STAGE.test(line)) return;
    stageQueue.push(line.replace(/^== |^-- /, "").trim());
    clearTimeout(stageTimer);
    stageTimer = setTimeout(async () => { const batch = stageQueue.splice(0); if (!batch.length) return; try { await wa.send("🛠 " + batch.join("\n")); } catch { /* bağlı değil */ } }, 2500);
  } catch { /* ayar okunamadı */ }
}
const announce = (reply, extra = {}) => { for (const r of clients) r.write(`event: jarvis\ndata: ${JSON.stringify({ reply, ...extra })}\n\n`); };

// ---------- Arka plan süreç temizliği: kullanılmayan model ve yardımcı süreçler kapatılır (ısınma önlemi)
// Üretim sürmüyorsa bizim başlattığımız ağır süreçler (ses modelleri, Remotion'un Chrome'u, yt-dlp, kapak çizimi)
// açık kalmamalı. Her 5 dk'da 10 dk'dan uzun yaşayanlar, üretim bitince hepsi kapatılır; panelde "Hepsini durdur".
let pipelineProc = null;
const HEAVY = [
  [/tts_server\.py/, "Chatterbox ses modeli"], [/voxcpm_tts\.py/, "VoxCPM ses modeli"], [/ema_tts\.py/, "EMA ses modeli"],
  [/trendyol-tts/, "Trendyol ses modeli"], [/yt_dlp/, "yt-dlp video indirme"], [/render_thumbs\.(mjs|py)/, "kapak çizimi"],
  [/fetch_images\.py/, "fotoğraf/video indirme"], [/remotion.*\b(render|still)\b/, "Remotion"], [/@remotion\/compositor|remotion-compositor/, "Remotion derleyici"],
  [/chrome-headless-shell|Chrome Headless|headless_shell/, "Remotion tarayıcısı"], [/speak\.py/, "Emixhas sesi"],
];
const etimeSec = (t) => { const m = String(t).trim().match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/); return m ? (+(m[1] || 0)) * 86400 + (+(m[2] || 0)) * 3600 + (+m[3]) * 60 + (+m[4]) : 0; };
function processTable() {
  const out = spawnSync("ps", ["-axo", "pid=,ppid=,etime=,%cpu=,command="], { encoding: "utf8" }).stdout || "";
  return out.split("\n").map((l) => l.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+([\d.]+)\s+(.*)$/)).filter(Boolean)
    .map((m) => ({ pid: +m[1], ppid: +m[2], age: etimeSec(m[3]), cpu: +m[4], cmd: m[5] }));
}
function heavyProcs() {
  const me = process.pid;
  return processTable().filter((p) => p.pid !== me && !/app\/server\.js/.test(p.cmd)).map((p) => {
    const hit = HEAVY.find(([re]) => re.test(p.cmd));
    if (!hit) return null;
    // Remotion tarayıcısı yalnızca projenin kendi kopyasıysa (node_modules/.remotion); kullanıcının Chrome'una dokunulmaz
    if (hit[1] === "Remotion tarayıcısı" && !p.cmd.includes(ROOT) && !p.cmd.includes("/.remotion/")) return null;
    return { ...p, what: hit[1] };
  }).filter(Boolean);
}
function killTree(pid) {
  const table = processTable(); const kids = (id) => table.filter((p) => p.ppid === id).flatMap((p) => [...kids(p.pid), p.pid]);
  const all = [...kids(pid), pid];
  for (const id of all) { try { process.kill(id, "SIGTERM"); } catch { /* yok */ } }
  setTimeout(() => { for (const id of all) { try { process.kill(id, "SIGKILL"); } catch { /* kapandı */ } } }, 4000);
  return all.length;
}
function reap({ minAgeSec = 600, reason = "boşta", force = false, announceIdle = false } = {}) {
  if (!force && pipelineBusy()) return { ok: true, killed: [] };
  const victims = heavyProcs().filter((p) => p.age >= minAgeSec && !(minAgeSec === 0 && !force && /speak\.py/.test(p.cmd) && p.age < 60));
  for (const p of victims) killTree(p.pid);
  if (victims.length) push(`🧹 ${reason}: ${[...new Set(victims.map((v) => v.what))].join(", ")} kapatıldı (${victims.length} süreç)`);
  else if (announceIdle) push(`🧹 ${reason}: modeller kapalı, arka planda açık süreç kalmadı`);
  return { ok: true, killed: victims.map((v) => ({ pid: v.pid, what: v.what, cpu: v.cpu })) };
}
setInterval(() => { try { reap({ minAgeSec: 600, reason: "kullanılmayan süreç" }); } catch { /* ps yok */ } }, 5 * 60000);
// Hepsini durdur: üretim (panelden ya da zamanlayıcıdan), sıradaki anlık haberler ve tüm ağır süreçler
function stopAll({ quiet = false } = {}) {
  let n = 0;
  if (pipelineProc) { n += killTree(pipelineProc.pid); }
  const lock = path.join(WORK, "pipeline.lock", "pid");
  if (existsSync(lock)) { try { const pid = Number(readFileSync(lock, "utf8").trim()); process.kill(pid, 0); n += killTree(pid); } catch { /* eski kilit */ } }
  anlikQueue.length = 0;
  const r = reap({ minAgeSec: 0, reason: "durduruldu", force: true });
  try { stopTts(); } catch { /* yok */ }
  if (!quiet) push(`⏹ hepsi durduruldu: üretim ${n ? "kapatıldı" : "yoktu"}, ${r.killed.length} arka plan süreci kapatıldı`);
  return { ok: true, pipeline: n > 0, killed: r.killed };
}
// ---------- Dinlenme ("⏸ Sistemi durdur" ve her üretimin sonu): üretim, modeller ve sıradaki anlık haberler kapatılır;
// bir sonraki PLANLI üretime (launchd 5 saatlik slot ya da günün özeti saati) ya da elle verilen talimata kadar otomatik
// hiçbir iş başlamaz: Mynet/son dakika taraması ve üretimi, izlenme senkronu, YouTube sırası, ses ön ısıtması, eksik
// kapak çizimi. Elle talimat (panel düğmeleri, WhatsApp, sesli komut) sistemi uyandırır. Durum data/rest.json'da
// (panel yeniden başlasa da sürer). settings.restAfterProduction (varsayılan açık): her üretimden sonra dinlenmeye geçer.
const REST_FILE = path.join(DATA, "rest.json");
const restInfo = () => readJson(REST_FILE, {});
const resting = () => !!restInfo().on;
const hhmm = (t) => new Date(t).toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" });
async function nextPlanned() {
  const cands = [];
  try { const sch = await getSchedule(); if (sch.nextRunAt) cands.push({ at: sch.nextRunAt, what: "5 saatlik üretim" }); } catch { /* yok */ }
  const d = dailyCfg();
  if (d.enabled && readJson(DAILY_FILE, {}).day !== today()) { const t = new Date(); t.setHours(Number(d.hour), Number(d.minute), 0, 0); if (t.getTime() > Date.now()) cands.push({ at: t.getTime(), what: "günün özeti" }); }
  const w = weeklyCfg();
  if (w.enabled && new Date().getDay() === Number(w.weekday) && readJson(WEEKLY_VIDEO_FILE, {}).day !== today()) { const t = new Date(); t.setHours(Number(w.hour), Number(w.minute), 0, 0); if (t.getTime() > Date.now()) cands.push({ at: t.getTime(), what: "haftanın özeti" }); }
  const pk = peakNext(); if (pk) cands.push(pk);
  try { cands.push(...infoNext()); } catch { /* henüz tanımlı değil */ }
  return cands.sort((a, b) => a.at - b.at)[0] || null;
}
async function restStart({ reason = "elle durduruldu", stop = true } = {}) {
  const r = stop ? stopAll({ quiet: true }) : reap({ minAgeSec: 0, reason, force: false });
  const next = await nextPlanned();
  writeJson(REST_FILE, { on: true, since: Date.now(), reason, until: next?.at || null, untilWhat: next?.what || null });
  const killed = r.killed?.length || 0;
  push(`⏸ SİSTEM DURDURULDU (${reason}): ${r.pipeline ? "süren üretim kapatıldı, " : ""}${killed ? `${killed} arka plan süreci kapatıldı` : "açık model kalmadı"}. ` +
    (next ? `Sıradaki planlı iş ${hhmm(next.at)} (${next.what}); ` : "Zamanlayıcı kapalı; ") + "o zamana kadar ya da siz talimat verene kadar hiçbir şey başlamayacak.");
  return { ok: true, rest: restInfo(), pipeline: !!r.pipeline, killed: r.killed || [] };
}
function restEnd(why) {
  if (!resting()) return false;
  writeJson(REST_FILE, { on: false, endedAt: Date.now(), endedWhy: why });
  push(`▶ SİSTEM YENİDEN ÇALIŞIYOR: ${why}`);
  return true;
}
// Her üretimin sonu (panelden, zamanlayıcıdan, anlık): modeller kapatılır; sırada iş yoksa ve ayar açıksa dinlenmeye geçilir.
let lastFinishAt = 0;
function finishProduction(reason = "üretim bitti") {
  if (Date.now() - lastFinishAt < 30000 || pipelineBusy()) return;
  lastFinishAt = Date.now();
  if (anlikQueue.length) { reap({ minAgeSec: 0, reason }); push(`⏭ sırada ${anlikQueue.length} anlık haber var, sistem durdurulmadı`); return; }
  if (settings().restAfterProduction !== false) restStart({ reason, stop: false }).catch(() => {});
  else reap({ minAgeSec: 0, reason, announceIdle: true });
}
// planlı zaman geldi: dinlenme biter (launchd üretimi zaten kendiliğinden başlar, günün özeti panel başlatır)
setInterval(() => { const r = restInfo(); if (r.on && r.until && Date.now() >= r.until) restEnd(`planlı iş zamanı geldi (${r.untilWhat || "üretim"})`); }, 30000);
app.get("/api/rest", (_req, res) => res.json(restInfo()));
// panel açılışında hâlâ dinlenmedeyse söyle (durum dosyada kalır; npm run basla ya da ▶ Sistemi başlat ile çıkılır)
setTimeout(() => { const r = restInfo(); if (r.on) push(`⏸ sistem durdurulmuş durumda (${r.reason || "elle"}): ${r.until ? `sıradaki planlı iş ${hhmm(r.until)}'de kendiliğinden başlar` : "siz başlatana kadar bekler"}. Hemen başlatmak için ▶ Sistemi başlat ya da terminalde npm run basla.`); }, 4000);
app.post("/api/rest", async (req, res) => res.json(req.body?.on === false ? { ok: true, ended: restEnd("panelden başlatıldı"), rest: restInfo() } : await restStart({ reason: "elle durduruldu" })));
app.post("/api/stopall", async (_req, res) => res.json(await restStart({ reason: "elle durduruldu" })));
app.get("/api/procs", (_req, res) => res.json({ busy: pipelineBusy(), procs: heavyProcs().map(({ pid, what, cpu, age }) => ({ pid, what, cpu, age })) }));

function startPipeline(duration, extraEnv = {}, { auto = false } = {}) {
  if (state.running) return { ok: false, error: "Zaten bir üretim sürüyor." };
  if (resting()) { if (auto) return { ok: false, resting: true, error: "Sistem durduruldu (dinlenmede); otomatik üretim başlamadı." }; restEnd("elle üretim talimatı"); }
  const lock = path.join(WORK, "pipeline.lock", "pid");
  if (existsSync(lock)) { try { process.kill(Number(readFileSync(lock, "utf8").trim()), 0); return { ok: false, error: "Zamanlayıcıdan başlamış bir üretim sürüyor; bitince tekrar deneyin." }; } catch { /* eski kilit, pipeline temizler */ } }
  const formatDuration = duration === "format"; // zamanlanmış üretimin telafisi: süreyi saate göre format seçer (launchd gibi)
  duration = formatDuration ? null : extraEnv.GUNLUK === "1" ? Math.min(600, Math.max(60, Number(duration) || 240)) : Math.min(180, Math.max(15, Number(duration) || 30));
  Object.assign(state, { running: true, startedAt: Date.now(), duration, log: [], exitCode: null });
  push(formatDuration ? "▶ zamanlanmış üretim (formatın süresiyle) başlatıldı" : extraEnv.ANLIK === "1" ? `⚡ ${duration} saniyelik ANLIK HABER üretimi başlatıldı` : extraEnv.HAFTALIK === "1" ? `📺 HAFTANIN ÖZETİ (yatay, ~${Math.round(duration / 60)} dk) üretimi başlatıldı` : extraEnv.GUNLUK === "1" ? `📺 GÜNÜN ÖZETİ (yatay, ~${Math.round(duration / 60)} dk) üretimi başlatıldı` : `▶ ${duration} saniyelik üretim başlatıldı`);
  const child = spawn("bash", ["pipeline.sh"], { cwd: ROOT, env: { ...ENV, ...(formatDuration ? {} : { DURATION: String(duration) }), ...extraEnv } });
  pipelineProc = child;
  const onData = (b) => b.toString().split("\n").filter(Boolean).forEach((l) => { push(l); const m = l.match(/== bitti: (out\/\S+\.mp4)/); if (m) state.lastVideo = path.basename(m[1]); });
  child.stdout.on("data", onData); child.stderr.on("data", onData);
  child.on("close", (code) => { pipelineProc = null; setTimeout(() => finishProduction(code === 0 ? "üretim bitti" : "üretim hata ile bitti"), 3000); state.running = false; state.exitCode = code; if (code === 0) push("✔ üretim tamamlandı"); else if (!state.log.slice(-5).some((l) => /^✖ üretim hata/.test(l))) push(`✖ üretim hata ile bitti (kod ${code})`); push(`__done__:${code}`); });
  return { ok: true, duration };
}

// ---------- Anlık haber: editörün yazdığı konuda tek konulu son dakika videosu
// Başka üretim sürüyorsa istek sıraya girer ve o bitince kendiliğinden başlar (zamanlayıcı üretimi dahil).
const anlikQueue = []; // sırayla üretilecek anlık haber istekleri
const pipelineBusy = () => { if (state.running) return true; const lock = path.join(WORK, "pipeline.lock", "pid"); if (!existsSync(lock)) return false; try { process.kill(Number(readFileSync(lock, "utf8").trim()), 0); return true; } catch { return false; } };
function startAnlik(topic, duration, opts = {}) {
  topic = String(topic || "").replace(/\s+/g, " ").trim().slice(0, 1500);
  if (topic.length < 8) return { ok: false, error: "Konuyu biraz daha ayrıntılı yazın (en az birkaç kelime)." };
  duration = Math.min(60, Math.max(20, Number(duration) || 30));
  if (resting()) { if (opts.auto) { push(`⏸ sistem durduruldu: otomatik anlık haber başlatılmadı (${topic.slice(0, 70)}); elle "🎬 Video üret" ile üretebilirsiniz`); return { ok: false, resting: true, error: "Sistem durduruldu (dinlenmede)." }; } restEnd("elle anlık haber talimatı"); }
  if (pipelineBusy()) {
    anlikQueue.push({ topic, duration, opts, at: Date.now() });
    push(`⚡ anlık haber sıraya alındı (${anlikQueue.length}. sırada, şu an başka üretim sürüyor): ${topic.slice(0, 80)}`);
    return { ok: true, queued: true, position: anlikQueue.length, duration };
  }
  mkdirSync(WORK, { recursive: true });
  writeFileSync(path.join(WORK, "anlik_topic.txt"), topic + "\n");
  // Elle verilen konuda sitelerde bulunan diğer haberler (topic_news ilgili haberlerin başına koyar) ve görüntü sayfaları
  // (assemble her kartı başka sitenin sayfasına bağlar); her başlangıçta yazılır ki önceki işten kalmasın.
  writeJson(path.join(WORK, "anlik_related.json"), Array.isArray(opts.related) ? opts.related.slice(0, 8) : []);
  writeJson(path.join(WORK, "anlik_pages.json"), Array.isArray(opts.pages) ? opts.pages.slice(0, 4) : []);
  writeJson(path.join(WORK, "remake.json"), opts.remake || {}); // yeniden yayın: eski senaryo + kaçınılacak görsel kaynakları
  const env = { ANLIK: "1" };
  if (opts.remake?.of) { env.REMAKE = "1"; env.REMAKE_OF = String(opts.remake.of); }
  if (opts.peakHour != null) env.PEAK_HOUR = String(opts.peakHour);
  // şablon video (deprem/maç/piyasa/takvim): senaryo ve bilgi kartları work/jobs/<ad>/ içinde hazır, Claude çağrılmaz
  if (opts.templateDir) env.TEMPLATE_DIR = String(opts.templateDir);
  if (opts.userVideo) env.USER_VIDEO = "1"; // WhatsApp'tan gönderilen video: yayın onayla (waVideo.autoPublish)
  if (opts.publishAt) env.PUBLISH_AT = String(opts.publishAt); // WhatsApp'ta yazılan yayın saati: video hemen üretilir, o saatte yayınlanır
  if (opts.info) { const i = opts.info; env.INFO_KIND = i.kind || ""; env.INFO_LABEL = i.label || ""; if (i.intro) env.INFO_INTRO = i.intro; if (i.outro) env.INFO_OUTRO = i.outro; if (i.breaking === false) env.INFO_BREAKING = "0"; }
  if (opts.source) env.ANLIK_SOURCE = String(opts.source);
  if (opts.url) env.ANLIK_URL = String(opts.url);
  if (opts.sourceCount) env.ANLIK_SOURCE_COUNT = String(opts.sourceCount);
  return { ...startPipeline(duration, env, { auto: !!opts.auto }), anlik: true };
}
// Aynı anda düşen 2-3 değerli manşet tek videoda: work/anlik_items.json [{source, url, title, text}] + ANLIK_MULTI=n.
// Süre 30 + 15 sn/ek haber (2 → 45, 3 → 60). Prompt her habere segment ayırır, assemble her segmente kendi sayfasını verir.
function startAnlikMulti(items, { auto = true } = {}) {
  items = items.slice(0, 3);
  const duration = Math.min(60, 30 + 15 * (items.length - 1));
  const topic = items.map((it, i) => `${i + 1}) [${it.source}] ${it.title}`).join("\n");
  if (pipelineBusy()) {
    anlikQueue.push({ topic, duration, multi: items, opts: { auto }, at: Date.now() });
    push(`⚡ ${items.length} son dakika haberi tek video için sıraya alındı (${anlikQueue.length}. sırada): ${items.map((x) => x.title.slice(0, 40)).join(" | ")}`);
    return { ok: true, queued: true, position: anlikQueue.length, duration, multi: items.length };
  }
  if (resting()) { if (auto) return { ok: false, resting: true, error: "Sistem durduruldu (dinlenmede)." }; restEnd("elle anlık haber talimatı"); }
  mkdirSync(WORK, { recursive: true });
  writeFileSync(path.join(WORK, "anlik_topic.txt"), items.map((it, i) => `${i + 1}) [${it.source}] ${it.title}. ${String(it.text || "").slice(0, 400)}`).join("\n") + "\n");
  writeJson(path.join(WORK, "anlik_related.json"), []); writeJson(path.join(WORK, "anlik_pages.json"), []); writeJson(path.join(WORK, "remake.json"), {}); // önceki tek konulu işten kalmasın
  writeJson(path.join(WORK, "anlik_items.json"), items.map(({ source, url, title, text }) => ({ source, url, title, text: String(text || "").slice(0, 1500) })));
  push(`⚡ ${items.length} değerli son dakika haberi TEK videoda (${duration} sn): ${items.map((x) => `${x.title.slice(0, 50)} (${x.source})`).join(" | ")}`);
  const env = { ANLIK: "1", ANLIK_MULTI: String(items.length), ANLIK_SOURCE_COUNT: String(Math.max(...items.map((x) => x.sourceCount || 1))) };
  return { ...startPipeline(duration, env, { auto }), anlik: true, multi: items.length };
}
setInterval(() => {
  if (!anlikQueue.length || pipelineBusy()) return;
  const q = anlikQueue.shift();
  if (q.multi) { startAnlikMulti(q.multi, q.opts || {}); return; }
  push(`⚡ sıradaki anlık haber başlıyor: ${q.topic.slice(0, 80)}`); startAnlik(q.topic, q.duration, q.opts || {});
}, 10000);

// ---------- Değerli manşet toplayıcı: Mynet ve son dakika taramalarından gelen DEĞERLİ haberler 20 sn biriktirilir.
// Tek haber → tek konulu anlık video; 2-3 haber → tek birleşik video (startAnlikMulti). Sistem dinlenmedeyse değerli
// haber onu uyandırır (kullanıcı kararı: değerli manşet beklemeden üretilir). Fazlası bir sonraki partiye kalır.
const VALUE_BATCH_MS = 20000;
let valueBatch = [], valueTimer = null;
const eventStems = (t) => new Set(String(t || "").toLocaleLowerCase("tr").match(/[\p{L}\d]{5,}/gu)?.map((w) => w.slice(0, 5)) || []);
const sameEvent = (a, b) => { const x = eventStems(a), y = eventStems(b); let n = 0; for (const w of x) if (y.has(w)) n++; return n >= 3 || (n >= 2 && n / Math.max(1, Math.min(x.size, y.size)) >= 0.5); };
function queueValuable(item) { // {title, text, source, url, sourceCount, duration, onStarted(r)}
  const twin = valueBatch.find((x) => sameEvent(x.title, item.title));
  if (twin) { twin.sourceCount = Math.max(twin.sourceCount || 1, (item.sourceCount || 1) + 1); push(`⭐ aynı olay iki kaynakta: "${item.title.slice(0, 60)}" (${item.source}) tek haber sayıldı`); item.onStarted?.({ ok: true, merged: true }); return; }
  valueBatch.push(item);
  push(`⭐ değerli haber yakalandı: ${item.title.slice(0, 80)} (${item.source}) → ${Math.round(VALUE_BATCH_MS / 1000)} sn içinde düşen diğerleriyle birlikte üretilecek`);
  if (!valueTimer) valueTimer = setTimeout(() => flushValuable().catch((e) => push(`⭐ değerli haber üretimi: ${e.message}`)), VALUE_BATCH_MS);
}
async function flushValuable() {
  valueTimer = null;
  if (watchScanning) { valueTimer = setTimeout(() => flushValuable().catch(() => {}), 3000); return; } // diğer kaynak da taransın
  const items = valueBatch.splice(0, 3);
  if (valueBatch.length) valueTimer = setTimeout(() => flushValuable().catch(() => {}), VALUE_BATCH_MS);
  if (!items.length) return;
  if (resting()) restEnd(`değerli haber düştü: ${items[0].title.slice(0, 60)}${items.length > 1 ? ` ve ${items.length - 1} haber daha` : ""}`);
  const r = items.length === 1
    ? startAnlik([items[0].title, items[0].text].filter(Boolean).join(". ").slice(0, 1500), items[0].duration, { source: items[0].source, url: items[0].url, sourceCount: items[0].sourceCount || 1, auto: true })
    : startAnlikMulti(items);
  for (const it of items) { try { await it.onStarted?.(r); } catch { /* kayıt */ } }
}
// Elle anlık haber (panel kartı, WhatsApp, sesli komut, beyin): Claude bilgi uydurmasın diye önce haberin kendisi bulunur.
// Link verildiyse sayfa okunur (başlık, özet, metin, site adı); kısa konu verildiyse news_lookup.py haberi Bing/Google
// Haberler, son dakika siteleri ve son RSS'te arar, en iyi eşleşen sayfaları okur (fotoğraf/video da oralardan gelir).
// Bulunamazsa ve editör yalnız kısa bir konu yazdıysa video ÜRETİLMEZ, link ya da ayrıntı istenir.
const URL_RE = /https?:\/\/[^\s<>"']+/i;
async function prepareAnlik(input, duration, opts = {}) {
  input = String(input || "").replace(/\s+/g, " ").trim();
  const link = (input.match(URL_RE) || [""])[0].replace(/[).,;!?]+$/, "");
  if (link) {
    push(`🔗 haber linki okunuyor: ${link.slice(0, 120)}`);
    const a = await pyJson(["scripts/news_lookup.py", "--url", link], 90000);
    if (!a?.ok) { push(`🔗 haber sayfası okunamadı: ${a?.error || "yanıt yok"}`); return { ok: false, error: `Haber sayfasını okuyamadım (${a?.error || "yanıt yok"}). Haberi birkaç cümleyle yazarsanız ondan üretirim.` }; }
    push(`🔗 ${a.site}: ${a.title.slice(0, 100)} → son dakika videosu üretiliyor`);
    const topic = [a.title, a.description, a.body].filter(Boolean).join(". ").replace(/\.\s*\./g, ".");
    return { ...startAnlik(topic, duration, { ...opts, source: a.site, url: link, pages: [{ url: link, source: a.site }] }), title: a.title, source: a.site, viaLink: true };
  }
  if (input.length < 8) return { ok: false, error: "Konuyu biraz daha ayrıntılı yazın ya da haberin linkini gönderin." };
  push(`🔎 "${input.slice(0, 90)}" haber sitelerinde aranıyor…`);
  const f = await pyJson(["scripts/news_lookup.py", "--topic", input], 120000);
  if (f?.errors?.length) push(`🔎 arama uyarısı: ${f.errors.join(" · ")}`);
  if (f?.found && f.best) {
    const b = f.best;
    push(`🔎 bulundu: ${b.title.slice(0, 100)} (${b.site}) · ${f.matched} haberde geçiyor, görüntüler ${Math.max(1, (f.pages || []).length)} sayfadan`);
    const topic = [b.title, b.description, b.body].filter(Boolean).join(". ").replace(/\.\s*\./g, ".");
    return { ...startAnlik(topic, duration, { ...opts, source: b.site, url: b.url || undefined, related: f.related || [], pages: f.pages || [] }), title: b.title, source: b.site, found: true, count: f.matched };
  }
  if (input.split(" ").length < 15) {
    push(`🔎 "${input.slice(0, 80)}" için güncel haber bulunamadı; uydurmamak için video üretilmedi`);
    return { ok: false, notFound: true, error: `"${input.slice(0, 80)}" hakkında haber sitelerinde güncel bir haber bulamadım; bilgi uydurmamak için video üretmedim. Haberin linkini gönderin ya da ne olduğunu birkaç cümleyle yazın.` };
  }
  push("🔎 sitelerde bulunamadı; yalnızca yazdığınız bilgiyle üretiliyor (temkinli dil)");
  return startAnlik(input, duration, { ...opts, related: f?.related || [] });
}
// Tutan videoyu yeniden yayınla (kullanıcı isteği): aynı haber, FARKLI senaryo (yeni kanca/başlık/cümleler) ve eski
// videodakinden FARKLI görsellerle. Anlık videoda tüm konu, çok haberli videoda kanca (manşet) haberi tek konulu son dakika
// videosu olur. Haber sitelerde yeniden aranır (güncel bilgi + başka sayfalar); eski haber sayfaları ve eski videonun
// görsel kaynakları work/remake.json "avoid" listesine girer, fetch_images önce başka kaynaklara bakar.
async function remakeVideo(name, opts = {}) {
  name = path.basename(String(name || "")).replace(/\.json$/, "").replace(/\.mp4$/, "") + ".mp4";
  const meta = readJson(path.join(OUT, name.replace(/\.mp4$/, ".json")), null);
  if (!meta?.segments?.length) return { ok: false, error: "Videonun bilgileri bulunamadı." };
  const segs = meta.segments.filter((x) => x.kind === "hook" || x.kind === "haber");
  const firstHaber = segs.find((x) => x.kind === "haber") || segs[0];
  const story = meta.anlik ? segs : segs.filter((x) => x.kind === "hook" || x === firstHaber);
  const title = firstHaber?.title || meta.titles?.A || "";
  const avoid = [...new Set([meta.sourceUrl, ...story.flatMap((x) => [x.articleUrl, x.videoSrc, x.imageSrc])].filter(Boolean))];
  const facts = story.map((x) => [x.title, x.narration].filter(Boolean).join(": ")).join(" ");
  push(`🔁 yeniden yayın hazırlanıyor: ${title.slice(0, 80)} (${name}) — haber sitelerde yeniden aranıyor, farklı görseller seçilecek`);
  const f = await pyJson(["scripts/news_lookup.py", "--topic", title], 120000).catch(() => null);
  const pages = (f?.pages || []).filter((p) => !avoid.includes(p.url));
  const fresh = f?.found && f.best && !avoid.includes(f.best.url) ? [f.best.title, f.best.description, f.best.body].filter(Boolean).join(". ") : "";
  const topic = [facts, fresh].filter(Boolean).join(" ").replace(/\s+/g, " ").slice(0, 1500);
  const source = pages[0]?.source || meta.sourceName || firstHaber?.source || "";
  const r = startAnlik(topic, Math.min(60, Math.max(20, Number(opts.duration || meta.targetDuration) || 30)), {
    source, peakHour: opts.peakHour, url: pages[0]?.url, related: (f?.related || []).filter((x) => x.b !== title), pages,
    remake: { of: name, oldScript: segs.map((x) => ({ kind: x.kind, title: x.title, narration: x.narration })), oldTitles: meta.titles || {}, avoid },
  });
  if (r.ok) push(`🔁 ${name} farklı senaryo ve görsellerle yeniden üretiliyor${r.queued ? ` (${r.position}. sırada)` : ""}; bitince bağlı hesaplarda yayınlanacak`);
  return { ...r, title };
}
app.post("/api/videos/:name/remake", async (req, res) => res.json(await remakeVideo(req.params.name)));

// ---------- Şablon videolar (kullanıcı kararı): deprem (AFAD/Kandilli), maç sonucu (ilk 5 takım, Avrupa'da Türk takımları),
// sabah piyasa kartı, takvim hatırlatması. Bilgi kesin veriden gelir: senaryo şablondan (Claude çağrılmaz), görsel kodla
// çizilen bilgi kartı (scripts/info_card.py, src/InfoCard.tsx). Python betiği work/jobs/<ad>/ hazırlar; startAnlik
// {templateDir, info} ile üretir. Dinlenmedeyse uyandırır (deprem acil; maç değerli; piyasa/takvim planlı iş).
const quakeCfg = () => ({ enabled: true, minMag: 4.5, intervalMin: 2, duration: 25, ...(settings().quake || {}) });
const matchCfg = () => ({ enabled: true, intervalMin: 10, duration: 25, ...(settings().match || {}) });
const marketCfg = () => ({ enabled: true, hour: 9, minute: 0, duration: 35, ...(settings().market || {}) });
const calendarCfg = () => ({ enabled: true, hour: 19, minute: 0, duration: 25, extra: [], ...(settings().calendar || {}) });
const weatherCfg = () => ({ enabled: true, minLevel: "orange", intervalMin: 30, duration: 25, ...(settings().weather || {}) });
const weeklyTopCfg = () => ({ enabled: true, weekday: 0, hour: 18, minute: 0, duration: 60, ...(settings().weeklyTop || {}) });
const INFO = {
  deprem: { kind: "deprem", label: "DEPREM", intro: "Son dakika, deprem." },
  mac: { kind: "mac", label: "MAÇ SONUCU", intro: "Maç sonucu.", outro: "Maç sonuçları için takip etmeyi unutma.", breaking: false },
  piyasa: { kind: "piyasa", label: "PİYASALAR", intro: "Güne piyasalarla başlıyoruz.", outro: "Piyasaları her sabah burada takip edin. Takip etmeyi unutma.", breaking: false },
  takvim: { kind: "takvim", label: "HATIRLATMA", intro: "Takvim hatırlatması.", outro: "Önemli günleri kaçırmamak için takip etmeyi unutma.", breaking: false },
  meteo: { kind: "meteo", label: "METEOROLOJİ UYARISI", intro: "Son dakika, hava durumu uyarısı.", outro: "Hava durumu uyarılarını kaçırmamak için takip etmeyi unutma.", breaking: false },
  alarm: { kind: "alarm", label: "PİYASA ALARMI", intro: "Son dakika, piyasalar.", outro: "Piyasaları anlık takip etmek için takip etmeyi unutma.", breaking: false },
  derleme: { kind: "derleme", label: "HAFTANIN EN ÇOK İZLENENLERİ", intro: "Haftanın en çok izlenenleri.", outro: "Her pazar haftanın en çok izlenenleri burada. Takip etmeyi unutma.", breaking: false },
};
function startTemplate(kind, job, { title, duration, source }) {
  if (resting()) restEnd(`${INFO[kind].label.toLowerCase()} videosu (${String(title || "").slice(0, 60)})`);
  const need = Number(readJson(path.join(ROOT, job, "meta.json"), {}).duration) || 0; // uzun senaryoda süre büyür (kelime sınırı)
  return startAnlik(title, Math.min(60, Math.max(Number(duration) || 25, need)), { templateDir: job, info: INFO[kind], source });
}
const INFO_FILE = path.join(DATA, "info_last.json"); // {quake, match, market:{day}, calendar:{day}}
const infoState = () => readJson(INFO_FILE, {});
const infoMark = (k, v) => { const st = infoState(); st[k] = { ...(st[k] || {}), ...v, at: Date.now() }; writeJson(INFO_FILE, st); };
async function quakeCheck({ manual = false } = {}) {
  infoMark("quake", { checking: true });
  const r = await pyJson(["scripts/quake_watch.py", "--check"], 90000).catch(() => null);
  infoMark("quake", { checking: false, errors: r?.errors || [], found: (r?.events || []).length });
  // iki kaynak da düştüyse 6 saatte bir loga (internet yokken her 2 dakikada satır basılmasın)
  if (r?.errors?.length && (manual || (r.errors.length > 1 && Date.now() - quakeErrAt > 6 * 3600000))) { quakeErrAt = Date.now(); push(`🌍 deprem servisi: ${r.errors.join(" · ")}`); }
  for (const e of r?.events || []) {
    push(`🌍 DEPREM: ${e.title} (${e.source}, derinlik ${String(e.depth).replace(".", ",")} km) → video hazırlanıyor`);
    const res = startTemplate("deprem", e.job, { title: e.title, duration: quakeCfg().duration, source: e.source });
    if (res.ok && e.mag < 6) await pyJson(["scripts/breaking_watch.py", "--mark", e.title]).catch(() => {}); // aynı depremin haberi ikinci video olmasın (büyük depremde gelişmeler serbest)
  }
  return { ok: !!r?.ok, events: r?.events || [], errors: r?.errors || [] };
}
async function matchCheck({ manual = false } = {}) {
  const r = await pyJson(["scripts/match_watch.py", "--check"], 120000).catch(() => null);
  infoMark("match", { errors: r?.errors || [], found: (r?.matches || []).length });
  if (r?.errors?.length && manual) push(`⚽ skor servisi: ${r.errors.join(" · ")}`);
  for (const m of r?.matches || []) {
    push(`⚽ MAÇ BİTTİ: ${m.title} → skor videosu hazırlanıyor`);
    const res = startTemplate("mac", m.job, { title: m.title, duration: matchCfg().duration, source: "Maç sonucu" });
    if (res.ok) await pyJson(["scripts/breaking_watch.py", "--mark", m.title]).catch(() => {});
  }
  return { ok: !!r?.ok, matches: r?.matches || [], errors: r?.errors || [] };
}
async function marketRun({ manual = false } = {}) {
  if (!manual) infoMark("market", { day: today() });
  const r = await pyJson(["scripts/market.py", "--job"], 90000).catch(() => null);
  if (r?.errors?.length) push(`💰 piyasa verisi: ${r.errors.join(" · ")}`);
  if (!r?.ok) { push(`💰 piyasa videosu üretilemedi: ${r?.error || "yanıt yok"}`); return { ok: false, error: r?.error || "Piyasa verisi alınamadı." }; }
  push(`💰 piyasa kartı (${(r.sources || []).join(", ")}): dolar ${r.values?.usd?.price ?? "?"} · euro ${r.values?.eur?.price ?? "?"} · gram altın ${r.values?.gram?.price ?? "?"}`);
  return startTemplate("piyasa", r.job, { title: "Güne piyasalarla başlıyoruz: dolar, euro, altın ve akaryakıt", duration: marketCfg().duration, source: (r.sources || []).join(" · ") });
}
async function calendarRun({ manual = false } = {}) {
  if (!manual) infoMark("calendar", { day: today() });
  const due = await pyJson(["scripts/calendar_news.py", "--due"], 30000).catch(() => null);
  const evs = due?.events || [];
  if (!evs.length) { if (manual) push("📅 yarın için takvim olayı yok"); return { ok: false, error: "Yarın için takvim olayı yok (ya da üretildi)." }; }
  let last = { ok: false };
  for (const e of evs.slice(0, 2)) {
    const j = await pyJson(["scripts/calendar_news.py", "--job", e.key], 30000).catch(() => null);
    if (!j?.ok) continue;
    push(`📅 takvim: yarın ${e.title} → hatırlatma videosu hazırlanıyor`);
    last = startTemplate("takvim", j.job, { title: `Yarın ${e.title}`, duration: calendarCfg().duration, source: "Takvim" });
  }
  return { ...last, events: evs };
}
async function weatherCheck({ manual = false } = {}) {
  const r = await pyJson(["scripts/weather_watch.py", "--check"], 60000).catch(() => null);
  infoMark("weather", { errors: r?.errors || [], found: (r?.warnings || []).length });
  if (r?.errors?.length && manual) push(`🌧 meteoroloji servisi: ${r.errors.join(" · ")}`);
  for (const g of r?.warnings || []) {
    push(`🌧 METEOROLOJİ: ${g.title} — ${g.provinces.slice(0, 8).join(", ")}${g.provinces.length > 8 ? "…" : ""} → video hazırlanıyor`);
    const res = startTemplate("meteo", g.job, { title: g.title, duration: weatherCfg().duration, source: "Meteoroloji Genel Müdürlüğü" });
    if (res.ok) await pyJson(["scripts/breaking_watch.py", "--mark", g.title]).catch(() => {});
  }
  return { ok: !!r?.ok, warnings: r?.warnings || [], errors: r?.errors || [] };
}
async function marketAlarm({ manual = false } = {}) {
  const r = await pyJson(["scripts/market.py", "--alarm"], 90000).catch(() => null);
  infoMark("alarm", { errors: r?.errors || [], found: (r?.jobs || []).length });
  if (r?.errors?.length && manual) push(`💰 piyasa alarmı: ${r.errors.join(" · ")}`);
  for (const job of r?.jobs || []) {
    const title = job.includes("akaryakit") ? "Akaryakıt fiyatları değişti" : "Piyasada rekor";
    push(`💰 PİYASA ALARMI: ${title} → video hazırlanıyor`);
    startTemplate("alarm", job, { title, duration: marketCfg().duration, source: "Piyasa verisi" });
  }
  return { ok: !!r?.ok, jobs: r?.jobs || [], errors: r?.errors || [] };
}
async function weeklyTopRun({ manual = false } = {}) {
  if (!manual) infoMark("weeklyTop", { day: today() });
  const r = await pyJson(["scripts/weekly_top.py", "--job"], 300000).catch(() => null);
  if (!r?.ok) { push(`🏆 Pazar derlemesi yapılmadı: ${r?.error || "yanıt yok"}`); return { ok: false, error: r?.error || "Derleme hazırlanamadı." }; }
  push(`🏆 haftanın en çok izlenenleri: ${r.top.map((x, i) => `${i + 1}. ${x.title.slice(0, 40)} (${x.views})`).join(" · ")} → derleme hazırlanıyor (${r.clips} klip)`);
  return { ...startTemplate("derleme", r.job, { title: "Haftanın en çok izlenen haberleri", duration: weeklyTopCfg().duration, source: "Türkiye Gündemi" }), top: r.top };
}
let quakeAt = 0, matchAt = 0, infoBusy = false, quakeErrAt = 0, weatherAt = 0, alarmAt = 0;
setInterval(async () => {
  if (infoBusy) return; infoBusy = true;
  try {
    const n = new Date(), mins = n.getHours() * 60 + n.getMinutes(), st = infoState();
    const q = quakeCfg(), m = matchCfg(), mk = marketCfg(), cl = calendarCfg();
    if (q.enabled && Date.now() - quakeAt >= Number(q.intervalMin) * 60000) { quakeAt = Date.now(); await quakeCheck(); }
    if (m.enabled && Date.now() - matchAt >= Number(m.intervalMin) * 60000) { matchAt = Date.now(); await matchCheck(); }
    const wc = weatherCfg(), wt = weeklyTopCfg();
    if (wc.enabled && Date.now() - weatherAt >= Number(wc.intervalMin) * 60000) { weatherAt = Date.now(); await weatherCheck(); }
    if (mk.enabled !== false && mk.alarm !== false && Date.now() - alarmAt >= 20 * 60000) { alarmAt = Date.now(); await marketAlarm(); }
    if (wt.enabled && n.getDay() === Number(wt.weekday) && st.weeklyTop?.day !== today() && mins >= wt.hour * 60 + wt.minute && mins < wt.hour * 60 + wt.minute + 180) await weeklyTopRun();
    // piyasa ve takvim: saatinde (2 saat içinde; Mac uyuduysa o gün atlanır), günde bir kez
    if (mk.enabled && st.market?.day !== today() && mins >= mk.hour * 60 + mk.minute && mins < mk.hour * 60 + mk.minute + 120) await marketRun();
    if (cl.enabled && st.calendar?.day !== today() && mins >= cl.hour * 60 + cl.minute && mins < cl.hour * 60 + cl.minute + 120) await calendarRun();
  } catch (e) { push(`📡 otomatik içerik hatası: ${e.message}`); } finally { infoBusy = false; }
}, 60000);
// dinlenmedeyken "sıradaki planlı iş" bilinsin
function infoNext() {
  const out = [], st = infoState();
  for (const [k, c, what] of [["market", marketCfg(), "sabah piyasa kartı"], ["calendar", calendarCfg(), "takvim hatırlatması"], ["weeklyTop", weeklyTopCfg(), "Pazar derlemesi"]]) {
    if (!c.enabled || st[k]?.day === today() || (k === "weeklyTop" && new Date().getDay() !== Number(c.weekday))) continue;
    const t = new Date(); t.setHours(Number(c.hour), Number(c.minute), 0, 0);
    if (t.getTime() > Date.now()) out.push({ at: t.getTime(), what });
  }
  return out;
}
app.get("/api/info", async (_req, res) => {
  const cal = await pyJson(["scripts/calendar_news.py", "--list", "45"], 30000).catch(() => null);
  res.json({ quake: quakeCfg(), match: matchCfg(), market: marketCfg(), calendar: calendarCfg(), weather: weatherCfg(), weeklyTop: weeklyTopCfg(), state: infoState(), upcoming: (cal?.events || []).slice(0, 8) });
});
app.post("/api/info/:kind/run", async (req, res) => {
  const k = req.params.kind;
  if (k === "quake") return res.json(await quakeCheck({ manual: true }));
  if (k === "match") return res.json(await matchCheck({ manual: true }));
  if (k === "market") return res.json(await marketRun({ manual: true }));
  if (k === "calendar") return res.json(await calendarRun({ manual: true }));
  if (k === "weather") return res.json(await weatherCheck({ manual: true }));
  if (k === "alarm") return res.json(await marketAlarm({ manual: true }));
  if (k === "weeklyTop") return res.json(await weeklyTopRun({ manual: true }));
  res.json({ ok: false, error: "bilinmeyen tür" });
});

// ---------- Instagram temizliği (kullanıcı isteği: "7 gün içinde Instagram'da 1000 izlenmenin altında olan tümünü sil"):
// önce liste (hiçbir şey silinmez) + "evet sil" onayı (15 dk geçerli). Silmeden hemen önce güncel izlenme tekrar okunur, bu arada
// sınırı geçen silinmez. Yalnız Instagram gönderisi silinir (YouTube/TikTok/Mac kopyası kalır). Her silme loga (🗑) ve
// data/ig_cleanup_log.json'a; özet WhatsApp'a (komut WhatsApp'tan geldiyse yanıtın kendisi özettir).
let igCleanupPending = null;
const igLine = (x) => `• ${x.title.slice(0, 60)} — ${x.views.toLocaleString("tr-TR")} izlenme, ${x.ageH < 24 ? `${Math.round(x.ageH)} saatlik` : `${Math.round(x.ageH / 24)} günlük`}`;
async function igCleanupPlan({ days = 7, max = 1000, minAgeH = 0 } = {}) {
  const m = readJson(path.join(DATA, "metrics.json"), {});
  if (!m.lastSync || Date.now() - Date.parse(m.lastSync) > 20 * 60000) await execAction({ type: "sync_metrics" }).catch(() => {});
  const r = await pyJson(["scripts/ig_cleanup.py", "--plan", "--days", String(days), "--max", String(max), "--min-age-hours", String(minAgeH)], 60000).catch(() => null);
  if (!r?.ok) return { ok: false, text: `Liste çıkarılamadı: ${r?.error || "yanıt yok"}` };
  const items = r.items || [];
  push(`🗑 Instagram temizliği planı: son ${days} günde ${max.toLocaleString("tr-TR")} izlenmenin altında ${items.length} video${r.unknown?.length ? ` (${r.unknown.length} videonun izlenmesi henüz ölçülmedi, listeye alınmadı)` : ""}`);
  if (!items.length) { igCleanupPending = null; return { ok: true, items, text: `Instagram'da son ${days} günde ${max.toLocaleString("tr-TR")} izlenmenin altında video yok. Hiçbir şey silinmedi.` }; }
  igCleanupPending = { names: items.map((x) => x.name), max, days, at: Date.now() };
  const young = items.filter((x) => x.ageH < 24).length;
  const text = `🗑 Instagram'da son ${days} günde ${max.toLocaleString("tr-TR")} izlenmenin altında *${items.length} video* var:\n` +
    items.slice(0, 25).map(igLine).join("\n") + (items.length > 25 ? `\n… ve ${items.length - 25} video daha` : "") +
    (young ? `\n\n⚠️ ${young} tanesi 1 günden yeni; izlenmesi henüz birikmemiş olabilir.` : "") +
    `\n\nYalnız Instagram'dan kalıcı olarak silinir (YouTube, TikTok ve Mac'teki kopya kalır). Silmek için *evet sil* yazın, vazgeçmek için *iptal* (15 dk geçerli).`;
  return { ok: true, items, unknown: r.unknown, text };
}
async function igCleanupRun({ notify = true } = {}) {
  const p = igCleanupPending;
  if (!p || Date.now() - p.at > 15 * 60000) { igCleanupPending = null; return { ok: false, error: "Bekleyen Instagram silme listesi yok ya da 15 dakikalık onay süresi doldu. Önce listeyi isteyin (ör. \"instagramda son 7 günde 1000 izlenmenin altındakileri sil\")." }; }
  igCleanupPending = null;
  push(`🗑 Instagram temizliği başladı: ${p.names.length} video siliniyor`);
  const r = await py("ig_cleanup.py", ["--run", "--names", p.names.join(","), "--max", String(p.max)]);
  for (const l of String(r.stdout || "").split("\n")) if (l.startsWith("🗑")) push(l);
  const j = r.json || {};
  const del = j.deleted || [], fail = j.failed || [], kept = j.kept || [];
  const text = `🗑 *Instagram temizliği bitti*: ${del.length} video silindi` + (fail.length ? `, ${fail.length} silinemedi` : "") + (kept.length ? `, ${kept.length} bırakıldı` : "") + "." +
    (del.length ? "\n\nSilinenler:\n" + del.slice(0, 30).map((x) => `• ${String(x.title).slice(0, 60)} (${x.views ?? "?"} izlenme)`).join("\n") : "") +
    (fail.length ? "\n\nSilinemeyenler (Instagram uygulamasından elle silin):\n" + fail.slice(0, 15).map((x) => `• ${String(x.title).slice(0, 50)}${x.url ? ` ${x.url}` : ""}`).join("\n") : "") +
    (kept.length ? "\n\nBırakılanlar:\n" + kept.slice(0, 10).map((x) => `• ${x.name}: ${x.why}`).join("\n") : "");
  push(`🗑 Instagram temizliği bitti: ${del.length} silindi, ${fail.length} silinemedi, ${kept.length} bırakıldı`);
  if (notify) { try { await wa.send(text); } catch { push("💬 Instagram temizliği özeti WhatsApp'a gönderilemedi (bağlı değil)"); } }
  return { ok: true, deleted: del, failed: fail, kept, text };
}
app.post("/api/instagram/cleanup/plan", async (req, res) => res.json(await igCleanupPlan({ days: Number(req.body?.days) || 7, max: Number(req.body?.max) || 1000, minAgeH: Number(req.body?.minAgeH) || 0 })));
app.post("/api/instagram/cleanup/run", async (_req, res) => res.json(await igCleanupRun({ notify: true })));

// ---------- En çok izlenen saatlerde tekrar (kullanıcı isteği): izlenmenin en yüksek olduğu 3 saatte (scripts/peak_remake.py
// --plan; az veride 12, 18, 21) son 24 saatin en çok izlenen haberi sırasıyla farklı senaryo ve görsellerle 30 sn yeniden
// yayınlanır. Üretim saatten leadMin (20) dk önce başlar ki video o saatte yayında olsun; pencere saatin 50. dakikasına
// kadar açık (Mac uyuduysa o saat atlanır). Her saatte bir kez (data/peak_remake.json); dinlenmedeyse sistemi uyandırır.
const peakCfg = () => ({ enabled: true, count: 3, leadMin: 20, duration: 30, ...(settings().peakRemake || {}) });
const PEAK_FILE = path.join(DATA, "peak_remake.json");
let peakPlan = { at: 0, hours: [] }, peakBusy = false;
async function peakHours(force = false) {
  if (force || Date.now() - peakPlan.at > 3 * 3600000) {
    const r = await pyJson(["scripts/peak_remake.py", "--plan"], 60000).catch(() => null);
    if (r?.hours) {
      const changed = peakPlan.hours.join(",") !== r.hours.join(",");
      peakPlan = { ...r, at: Date.now() };
      if (changed && peakCfg().enabled) push(`🕘 en çok izlenen saatler (${r.source}): ${r.hours.map((h) => `${String(h).padStart(2, "0")}:00`).join(", ")} — o saatlerde günün en çok izlenen haberi yeniden yayınlanacak`);
    }
  }
  return peakPlan;
}
const peakToday = () => { const st = readJson(PEAK_FILE, {}); return (st.done || []).filter((d) => d.day === today()); };
function peakMark(rec) {
  const st = readJson(PEAK_FILE, {});
  st.done = [...(st.done || []).filter((d) => Date.now() - (d.at || 0) < 7 * 86400000), { day: today(), at: Date.now(), ...rec }];
  writeJson(PEAK_FILE, st);
}
// sıradaki tekrarın başlama anı (dinlenme "sıradaki planlı iş" için)
function peakNext() {
  const c = peakCfg(); if (!c.enabled || !peakPlan.hours?.length) return null;
  const done = new Set(peakToday().map((d) => d.hour));
  const t = peakPlan.hours.filter((h) => !done.has(h)).map((h) => { const d = new Date(); d.setHours(h, 0, 0, 0); return d.getTime() - Number(c.leadMin) * 60000; }).filter((x) => x > Date.now()).sort((a, b) => a - b)[0];
  return t ? { at: t, what: "en çok izlenen saat tekrarı" } : null;
}
async function peakRemake({ hour = null, manual = false } = {}) {
  if (peakBusy) return { ok: false, error: "Tekrar zaten hazırlanıyor." };
  peakBusy = true;
  const hh = hour == null ? "şimdi" : `${String(hour).padStart(2, "0")}:00`;
  try {
    if (!manual) peakMark({ hour, pending: true }); // aynı saat iki kez başlamasın
    const m = readJson(path.join(DATA, "metrics.json"), {});
    if (!m.lastSync || Date.now() - Date.parse(m.lastSync) > 30 * 60000) await execAction({ type: "sync_metrics" }).catch(() => {}); // seçim güncel izlenmeyle
    const p = await pyJson(["scripts/peak_remake.py", "--pick"], 60000);
    const finish = (rec) => { const st = readJson(PEAK_FILE, {}); st.done = (st.done || []).filter((d) => !(d.pending && d.day === today() && d.hour === hour)); writeJson(PEAK_FILE, st); peakMark({ hour: manual ? null : hour, manual, ...rec }); };
    if (!p?.ok) { push(`🕘 en çok izlenen saat (${hh}) tekrarı yapılmadı: ${p?.reason || "seçim yapılamadı"}`); finish({ skipped: true, reason: p?.reason || "" }); return { ok: false, error: p?.reason || "Uygun video bulunamadı." }; }
    if (resting()) restEnd(`en çok izlenen saat tekrarı (${hh})`);
    push(`🕘 en çok izlenen saat (${hh}): günün en çok izlenen haberi "${p.title.slice(0, 80)}" (${p.views.toLocaleString("tr-TR")} izlenme) ${peakCfg().duration} sn, farklı senaryo ve görsellerle yeniden yayınlanıyor`);
    const r = await remakeVideo(p.video, { duration: peakCfg().duration, peakHour: hour });
    finish(r.ok ? { name: p.video, title: p.title, views: p.views } : { skipped: true, reason: r.error || "" });
    return { ...r, title: p.title, views: p.views, video: p.video };
  } finally { peakBusy = false; }
}
setInterval(async () => {
  const c = peakCfg(); if (!c.enabled || peakBusy) return;
  const { hours = [] } = await peakHours();
  const n = new Date(), mins = n.getHours() * 60 + n.getMinutes(), done = new Set(peakToday().map((d) => d.hour));
  const h = hours.find((x) => !done.has(x) && mins >= x * 60 - Number(c.leadMin) && mins <= x * 60 + 50);
  if (h != null) peakRemake({ hour: h }).catch((e) => push(`🕘 en çok izlenen saat tekrarı hatası: ${e.message}`));
}, 60000);
setTimeout(() => { peakHours(true).catch(() => {}); }, 20000);
app.get("/api/peak", async (_req, res) => { const p = await peakHours(); res.json({ cfg: peakCfg(), plan: p, today: peakToday(), next: peakNext() }); });
app.post("/api/peak/run", async (_req, res) => res.json(await peakRemake({ manual: true })));
app.post("/api/anlik", async (req, res) => res.json(await prepareAnlik(req.body?.topic, req.body?.duration)));
app.get("/api/anlik", (_req, res) => res.json({ queue: anlikQueue, running: state.running }));

// ---------- Mynet manşet takibi: her N dakikada manşet alanı (6 haber) kontrol edilir; yeni giren haber için
// kaynak gösterilerek, kendi cümlelerimizle anlık (son dakika) video üretilir. Günlük üst sınır var (YouTube kotası).
const MYNET_DONE = path.join(DATA, "mynet_produced.json");
// Mynet ve son dakika siteleri AYNI aralıkla, AYNI taramada kontrol edilir (settings.watchIntervalMin, varsayılan 10 dk):
// aynı anda düşen değerli haberler tek partide toplanıp birleşik videoya girer (queueValuable).
const watchMin = () => Math.min(60, Math.max(3, Number(settings().watchIntervalMin) || 5)); // değerli haber kaçmasın: 5 dk
const mynetCfg = () => ({ enabled: true, maxPerDay: 3, valuableMaxPerDay: 15, duration: 30, ...(settings().mynet || {}), intervalMin: watchMin() });
const today = () => new Date().toISOString().slice(0, 10);
const mynetDone = () => readJson(MYNET_DONE, {});
const pyJson = async (args, timeout = 60000) => { const r = await run(PY, args, { timeout }); try { return JSON.parse(String(r.stdout || "").trim().split("\n").pop()); } catch { return { ok: false, error: (r.stderr || r.stdout || "yanıt yok").toString().slice(-200) }; } };
// Değerli manşet (ölüm, kaza, asgari ücret, zam…; mynet_watch.py "valuable") önce ve ayrı sınırla üretilir:
// sıradan manşet günde maxPerDay, değerli manşet toplamda valuableMaxPerDay'e kadar. YouTube'a yalnız değerliler gider.
async function mynetProduce(url, { manual = false, item = null } = {}) {
  const done = mynetDone(); const day = today(); const list = done[day] || []; const c = mynetCfg();
  if (list.includes(url)) return { ok: false, error: "Bu haber için bugün zaten video üretildi." };
  const cap = item?.valuable ? Number(c.valuableMaxPerDay) : Number(c.maxPerDay);
  if (!manual && list.length >= cap) { push(`📰 Mynet: günlük sınır (${cap}) doldu, ${item?.valuable ? "değerli" : "sıradan"} manşet atlandı: ${(item?.title || "").slice(0, 70)}`); return { ok: false, error: "günlük sınır doldu" }; }
  if (!manual && item?.dup) { push(`📰 Mynet: "${(item.title || "").slice(0, 70)}" için son 12 saatte zaten video üretildi, atlandı`); return { ok: false, error: "aynı olay zaten üretildi" }; }
  if (!manual && !item?.valuable && resting()) { push(`⏸ sistem durduruldu: sıradan Mynet manşeti için video üretilmedi (${(item?.title || "").slice(0, 70)}); değerli haber gelirse sistem kendiliğinden başlar`); return { ok: false, resting: true, error: "dinlenmede" }; }
  if (item?.valuable) push(`⭐ Mynet: değerli manşet (${item.valueReason}) — video YouTube'a da gidecek`);
  const a = await pyJson(["scripts/mynet_watch.py", "--article", url]);
  if (!a || a.ok === false || !a.title) { push(`📰 Mynet: haber okunamadı (${a?.error || "başlık yok"})`); return { ok: false, error: a?.error || "haber okunamadı" }; }
  const topic = [a.title, a.description, a.body].filter(Boolean).join(". ").replace(/\.\s*\./g, ".").slice(0, 1500);
  const markDone = () => { const d = mynetDone(); d[day] = [...(d[day] || []), url]; for (const k of Object.keys(d)) if (k < new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10)) delete d[k]; writeFileSync(MYNET_DONE, JSON.stringify(d, null, 2)); };
  if (!manual && item?.valuable) { // değerli otomatik manşet: aynı anda düşenlerle birleşebilsin diye toplayıcıya
    queueValuable({ title: a.title, text: [a.description, a.body].filter(Boolean).join(". ").slice(0, 1400), source: "Mynet", url, sourceCount: item?.sources?.length || 1, duration: mynetCfg().duration,
      onStarted: async (r) => { if (r.ok) { if (!r.merged) await pyJson(["scripts/breaking_watch.py", "--mark", a.title]).catch(() => {}); markDone(); } } });
    return { ok: true, batched: true, title: a.title };
  }
  push(`📰 Mynet: yeni manşet: ${a.title.slice(0, 90)} → video üretiliyor`);
  const r = startAnlik(topic, mynetCfg().duration, { source: "Mynet", url, sourceCount: item?.sources?.length || 1, auto: !manual });
  if (r.ok) await pyJson(["scripts/breaking_watch.py", "--mark", a.title]).catch(() => {});
  if (r.ok) { done[day] = [...list, url]; for (const d of Object.keys(done)) if (d < new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10)) delete done[d]; writeFileSync(MYNET_DONE, JSON.stringify(done, null, 2)); }
  return { ...r, title: a.title };
}
let mynetLast = 0;
let lastStandings = "";
async function mynetCheck({ manual = false } = {}) {
  mynetLast = Date.now();
  const r = await pyJson(["scripts/mynet_watch.py", "--check"]);
  if (!r.ok) { push(`📰 Mynet kontrolü başarısız: ${r.error}`); return r; }
  if (!r.items?.length) push("📰 Mynet: manşet alanı bulunamadı (sayfa yapısı değişmiş olabilir)");
  else if (r.first) push(`📰 Mynet manşet takibi başladı: ${r.items.length} haber kaydedildi; bundan sonra yeni girenler için video üretilecek`);
  else if (manual || r.new.length) push(`📰 Mynet kontrol edildi: ${r.items.length} manşet, ${r.new.length} yeni`);
  for (const it of [...(r.new || [])].sort((a, b) => (b.valuable ? 1 : 0) - (a.valuable ? 1 : 0))) await mynetProduce(it.url, { item: it });
  return r;
}
app.get("/api/mynet", (_req, res) => { const st = readJson(path.join(DATA, "mynet_state.json"), {}); res.json({ ...mynetCfg(), items: st.items || [], lastCheck: st.lastCheck || null, producedToday: (mynetDone()[today()] || []), nextCheckIn: mynetCfg().enabled ? Math.max(0, watchLast + watchMin() * 60000 - Date.now()) : null }); });
app.post("/api/mynet/check", async (_req, res) => res.json(await mynetCheck({ manual: true })));
app.post("/api/mynet/produce", async (req, res) => res.json(await mynetProduce(String(req.body?.url || ""), { manual: true })));
app.post("/api/mynet/produce-all", async (_req, res) => { const st = readJson(path.join(DATA, "mynet_state.json"), {}); const out = []; for (const it of st.items || []) out.push(await mynetProduce(it.url, { manual: true })); res.json({ ok: true, results: out }); });

// ---------- çoklu son dakika takibi (scripts/breaking_watch.py): Hürriyet, Sözcü, NTV, AA, Habertürk son dakika akışları.
// Değerli ya da 3+ sitede çıkan YENİ olay → anlık video (kaynak: ilk veren site). Günlük sınır breaking.maxPerDay.
const BREAKING_DONE = path.join(DATA, "breaking_daily.json");
const breakingCfg = () => ({ enabled: true, maxPerDay: 4, valuableMaxPerDay: 15, duration: 30, ...(settings().breaking || {}), intervalMin: watchMin() });
let breakingLast = 0;
async function breakingCheck({ manual = false } = {}) {
  breakingLast = Date.now();
  const r = await pyJson(["scripts/breaking_watch.py", "--check"]);
  if (!r?.ok) { push(`🗞 son dakika takibi başarısız: ${r?.error || "?"}`); return r || { ok: false }; }
  const bad = Object.entries(r.sources || {}).filter(([, v]) => !v.ok).map(([k]) => k);
  if (manual || r.candidates?.length || bad.length) push(`🗞 son dakika kaynakları kontrol edildi: ${r.fresh} yeni haber, ${r.candidates.length} video adayı${bad.length ? ` · ulaşılamayan: ${bad.join(", ")}` : ""}`);
  const done = readJson(BREAKING_DONE, {}); const day = today(); const list = done[day] || [];
  for (const c of r.candidates || []) {
    // sıradan (çok kaynaklı) adaylar günde maxPerDay (4); değerli haberler ayrı ve yüksek sınır (15): değerli haber kaçmasın
    const cap = c.valuable ? Number(breakingCfg().valuableMaxPerDay) : Number(breakingCfg().maxPerDay);
    if (list.length >= cap) { push(`🗞 günlük ${c.valuable ? "değerli " : ""}son dakika sınırı (${cap}) doldu: "${c.title.slice(0, 70)}" atlandı`); continue; }
    const a = c.url ? await pyJson(["scripts/mynet_watch.py", "--article", c.url]) : null;
    const topic = [c.title, a?.ok !== false && a?.description, a?.ok !== false && a?.body || c.summary].filter(Boolean).join(". ").replace(/\.\s*\./g, ".").slice(0, 1500);
    push(`${c.valuable ? "⭐" : "🗞"} son dakika: ${c.title.slice(0, 90)} (${c.sources.join(", ")}; ${c.valueReason}) → video üretiliyor`);
    if (c.valuable) { // değerli: toplayıcıya (aynı anda düşen Mynet/son dakika haberleriyle tek video, dinlenmeyi bozar)
      list.push(c.title);
      queueValuable({ title: c.title, text: [a?.ok !== false && a?.description, (a?.ok !== false && a?.body) || c.summary].filter(Boolean).join(". ").slice(0, 1400), source: c.source, url: c.url, sourceCount: c.count, duration: breakingCfg().duration,
        onStarted: async (r) => { if (r.ok && !r.merged) await pyJson(["scripts/breaking_watch.py", "--mark", c.title]).catch(() => {}); } });
      done[day] = list; writeJson(BREAKING_DONE, Object.fromEntries(Object.entries(done).filter(([d]) => d >= new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10))));
      continue;
    }
    if (resting()) { push(`⏸ sistem durduruldu: "${c.title.slice(0, 70)}" için video üretilmedi (değerli değil; kartta 🎬 Video üret ile elle üretebilirsiniz)`); continue; }
    const res = startAnlik(topic, breakingCfg().duration, { source: c.source, url: c.url, sourceCount: c.count, auto: true });
    if (res.ok) { await pyJson(["scripts/breaking_watch.py", "--mark", c.title]).catch(() => {}); list.push(c.title); done[day] = list; writeJson(BREAKING_DONE, Object.fromEntries(Object.entries(done).filter(([d]) => d >= new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10)))); }
  }
  return r;
}
// Ortak tarama: önce Mynet, hemen ardından son dakika siteleri; tarama sürerken toplayıcı bekler (flushValuable)
let watchScanning = false, watchLast = 0;
async function watchScan() {
  if (watchScanning) return; watchScanning = true; watchLast = Date.now();
  try {
    if (mynetCfg().enabled) await mynetCheck().catch((e) => push(`📰 Mynet: ${e.message}`));
    if (breakingCfg().enabled) await breakingCheck().catch((e) => push(`🗞 son dakika: ${e.message}`));
    await py("trends.py", []).catch(() => {}); // Google Trends Türkiye önbelleği (haber seçimi ve panel)
    // Süper Lig ilk 5 (12 saatlik önbellek; değişince loga): bu takımların futbol haberleri değerli sayılır
    py("standings.py", []).then((r) => { const l = String(r.stdout || "").trim().split("\n").pop(); if (l && l !== lastStandings) { lastStandings = l; push(l); } }).catch(() => {});
  } finally { watchScanning = false; }
}
setInterval(() => { if ((mynetCfg().enabled || breakingCfg().enabled) && Date.now() - watchLast >= watchMin() * 60000) watchScan(); }, 60000);
app.get("/api/breaking", async (_req, res) => { const l = await pyJson(["scripts/breaking_watch.py", "--list"]); res.json({ ...breakingCfg(), ...(l || {}), trends: (readJson(path.join(DATA, "trends.json"), {}).items || []).slice(0, 10), producedToday: readJson(BREAKING_DONE, {})[today()] || [], nextCheckIn: breakingCfg().enabled ? Math.max(0, watchLast + watchMin() * 60000 - Date.now()) : null }); });
app.post("/api/breaking/check", async (_req, res) => res.json(await breakingCheck({ manual: true })));
// Paneldeki "🎬 Video üret": son haberlerden seçilen için otomatik adayla aynı yol (haber sayfası okunur, anlık video,
// bağlı hesaplara anlikAutoPublish kuralıyla yayın). Elle üretim günlük sınıra takılmaz; aynı olay 12 saatte bir kez
// (force ile yine üretilir).
app.post("/api/breaking/produce", async (req, res) => {
  const link = String(req.body?.link || "");
  const f = await pyJson(["scripts/breaking_watch.py", "--item", link]);
  if (!f?.ok) return res.json({ ok: false, error: f?.error || "haber bulunamadı" });
  const c = f.item;
  if (c.produced && !req.body?.force) return res.json({ ok: false, produced: true, error: "Bu olay için son 12 saatte zaten video üretildi." });
  const a = c.link ? await pyJson(["scripts/mynet_watch.py", "--article", c.link]) : null;
  const topic = [c.title, a?.ok !== false && a?.description, (a?.ok !== false && a?.body) || c.summary].filter(Boolean).join(". ").replace(/\.\s*\./g, ".").slice(0, 1500);
  push(`🎬 son dakika (elle): ${c.title.slice(0, 90)} (${(c.sources || [c.source]).join(", ")}) → video üretiliyor`);
  const r = startAnlik(topic, breakingCfg().duration, { source: c.source, url: c.link, sourceCount: (c.sources || []).length || 1 });
  if (r.ok) await pyJson(["scripts/breaking_watch.py", "--mark", c.title]).catch(() => {});
  res.json({ ...r, title: c.title });
});

// ---------- günlük uzun özet (yatay, YouTube): her akşam settings.daily.hour:minute'da GUNLUK=1 pipeline.
// Başka üretim sürüyorsa gün bitene kadar her dakika yeniden denenir; data/daily_last.json günde bir kez üretir.
const dailyCfg = () => ({ enabled: true, hour: 21, minute: 30, duration: 240, stories: 10, autoPublish: true, ...(settings().daily || {}) });
const DAILY_FILE = path.join(DATA, "daily_last.json");
let followersSyncAt = 0; // "kaç abonemiz var" komutu en çok 30 dk'da bir canlı çeker
function startDaily({ manual = false } = {}) {
  const c = dailyCfg();
  if (pipelineBusy()) return { ok: false, error: "Başka bir üretim sürüyor; bitince günün özeti başlar." };
  const r = startPipeline(c.duration, { GUNLUK: "1", GUNLUK_DURATION: String(c.duration) }, { auto: !manual });
  if (r.ok) writeJson(DAILY_FILE, { day: today(), at: Date.now(), manual });
  return r;
}
setInterval(() => {
  const c = dailyCfg(); if (!c.enabled) return;
  const now = new Date();
  if (now.getHours() * 60 + now.getMinutes() < Number(c.hour) * 60 + Number(c.minute)) return;
  if (readJson(DAILY_FILE, {}).day === today() || pipelineBusy() || resting()) return;
  startDaily();
}, 60000);
// ---------- viral alarmı (scripts/viral_watch.py): her izlenme senkronundan sonra. 24 saatten genç video son videoların
// ortancasının settings.viral.ratio (3) katını geçerse WhatsApp + log + ses; konuyla ilgili YENİ haber varsa devam videosu
// değerli haber toplayıcısıyla üretilir (dinlenmedeyse uyandırır).
async function viralCheck() {
  const r = await py("viral_watch.py", []);
  for (const v of r.json?.viral || []) {
    const plat = { youtube: "YouTube", instagram: "Instagram", tiktok: "TikTok" }[v.platform] || "";
    push(`🔥 VİRAL: "${v.title}" ${v.ageHours} saatte ${v.views.toLocaleString("tr-TR")} izlenme (ortalamanın ${v.ratio} katı${plat ? `, en çok ${plat}` : ""})`);
    const follow = v.followUp ? `\n\n➡️ Yeni gelişme var: "${v.followUp.title}" (${v.followUp.source}). Devam videosu üretiliyor.` : "\n\nŞu an konuyla ilgili yeni gelişme yok; gelişme düşerse 🎬 Video üret ile devam videosu yapabilirsiniz.";
    try { await wa.send(`🔥 *Video viral oluyor*\n${v.title}\n${v.ageHours} saatte ${v.views.toLocaleString("tr-TR")} izlenme, normalin ${v.ratio} katı.${v.url ? `\n${v.url}` : ""}${follow}`); } catch { /* WhatsApp bağlı değil */ }
    if (v.followUp) queueValuable({ title: v.followUp.title, text: v.followUp.text, source: v.followUp.source || "Türkiye Gündemi", url: v.followUp.url, sourceCount: 1, duration: 30,
      onStarted: async (res) => { if (res.ok && !res.merged) await pyJson(["scripts/breaking_watch.py", "--mark", v.followUp.title]).catch(() => {}); } });
  }
  return r.json;
}
app.post("/api/viral/check", async (_req, res) => res.json(await viralCheck()));
// tutmayan videonun YouTube başlığını diğer varyanta çevir (publish.py --retitle; 3. saatteki izlenme ortancanın yarısının altındaysa, bir kez)
async function retitleCheck() {
  const r = await py("publish.py", ["--retitle"]);
  for (const l of String(r.stdout || "").split("\n")) if (l.startsWith("📉")) push(l);
  return r.json;
}
// ilk yorumu yükleme anında yazılamamış (izin yok, video işleniyor, ağ) son 72 saatin videolarına yorumu sonradan yaz
async function firstCommentCheck() {
  const r = await py("publish.py", ["--first-comments"]);
  for (const l of String(r.stdout || "").split("\n")) if (l.startsWith("💬")) push(l);
  const igPerm = (r.json?.failed || []).find((x) => x.platform === "instagram" && /permission|izin|\(#10\)|\(#200\)|scope/i.test(x.error || ""));
  if (igPerm) healthAlert("ig-comment-scope", `Instagram'a ilk yorum yazılamıyor (${String(igPerm.error).slice(0, 120)}). Panel → Ayarlar → Yayın hesapları → Instagram'ı yeniden bağlayın ve yorum iznini onaylayın.`, { everyH: 24 }).catch(() => {});
  if (r.json?.needScope) healthAlert("yt-comment-scope", "YouTube'a ilk yorum ve yorum yanıtı yazılamıyor: yorum izni yok. Panel → Ayarlar → Yayın hesapları → YouTube → 🔄 Yeniden bağla, açılan Google sayfasında tüm izinleri onaylayın. İzin gelince eksik ilk yorumlar kendiliğinden yazılır.", { everyH: 24 }).catch(() => {});
  return r.json;
}
// ---------- Slot bekçisi: zamanlayıcı açıkken bir üretim saati geçti ve 6 dk içinde hiçbir üretim başlamadıysa (launchd işi
// başlatamadı — ör. çıkış 78, macOS Masaüstü izni — ya da düştü) panel o slotu kendisi başlatır; 40 dk sonraki "kaçan üretim"
// uyarısını beklemez. Başladı sayılır: kilit var / panel üretiyor / launchd logunda slottan sonra "üretim başladı" / slottan
// sonra düzenli video. Slot başına bir kez (data/panel_slot.json); Mac uykudaysa çalışmaz (uyanınca launchd kendisi telafi eder).
const PANEL_SLOT = path.join(DATA, "panel_slot.json");
setInterval(async () => {
  try {
    if (!isMac || !existsSync(PLIST) || settings().health?.autoCatchUp === false) return;
    const sch = await getSchedule();
    const now = new Date(), minute = Number(sch.minute) || 0;
    const slotAt = (sch.slots || []).map((h) => { const d = new Date(now); d.setHours(h, minute, 0, 0); return d.getTime(); }).filter((t) => t <= now.getTime()).sort((a, b) => b - a)[0];
    if (!slotAt || now.getTime() - slotAt < 6 * 60000 || now.getTime() - slotAt > 40 * 60000) return;
    if (readJson(PANEL_SLOT, {}).slot === slotAt || pipelineBusy() || state.running) return;
    let started = false;
    try {
      const log = readFileSync(LAUNCHD_LOG, "utf8").slice(-20000);
      for (const m of log.matchAll(/== (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) üretim başladı/g)) if (new Date(m[1].replace(" ", "T")).getTime() >= slotAt - 60000) started = true;
    } catch { /* log yok */ }
    if (!started) started = listVideos().some((v) => { const m = readJson(path.join(OUT, v.name.replace(/\.mp4$/, ".json")), {}); return !(m.anlik || ["anlik", "gunluk", "haftalik"].includes(m.format)) && statSync(path.join(OUT, v.name)).mtimeMs >= slotAt; });
    if (started) return;
    writeJson(PANEL_SLOT, { slot: slotAt, at: Date.now() });
    const lc = spawnSync("launchctl", ["list", VIDEO_JOB], { encoding: "utf8" });
    const ex = (lc.stdout?.match(/"LastExitStatus"\s*=\s*(-?\d+)/) || [])[1];
    const why = lc.status !== 0 ? "zamanlayıcı launchd'de yüklü değil" : ex && ex !== "0" ? exitText(ex) : "launchd işi başlamadı";
    push(`⏰ ${hhmm(slotAt)} üretimi başlamadı (${why.slice(0, 160)}); bu slotu panel başlatıyor`);
    if (resting()) restEnd(`${hhmm(slotAt)} zamanlanmış üretimi (launchd başlatamadı)`);
    const r = startPipeline("format");
    if (!r.ok) push(`⏰ panel slotu başlatamadı: ${r.error}`);
    if (Number(ex) === 19968 || (Number(ex) > 255 && Number(ex) >> 8 === 78)) healthAlert("launchd-78", `Zamanlayıcı (launchd) üretimi başlatamıyor: ${exitText(ex)}.\nPanel açık olduğu sürece slotları panel başlatacak; panel kapanırsa üretim durur.`, { everyH: 24 });
  } catch { /* zamanlayıcı okunamadı */ }
}, 60000);
// ---------- Takılan üretim bekçisi: pipeline kilidi (work/pipeline.lock) canlı bir sürece ait ve 50 dk'dan (uzun özetlerde
// 100 dk) eskiyse üretim takılmıştır; süreç ağacı kapatılır, kilit kalkar, sağlık uyarısı gider. Yoksa sonraki tüm
// zamanlanmış üretimler "başka üretim sürüyor" diye atlanır ve sistem saatlerce video üretmez.
setInterval(() => {
  try {
    const lockDir = path.join(WORK, "pipeline.lock"), pidFile = path.join(lockDir, "pid");
    if (!existsSync(pidFile)) return;
    const pid = Number(readFileSync(pidFile, "utf8").trim()); try { process.kill(pid, 0); } catch { return; }
    const ageMin = (Date.now() - statSync(lockDir).mtimeMs) / 60000;
    const long = (state.log.slice(-200).some((l) => /GÜNÜN ÖZETİ|HAFTANIN ÖZETİ|format gunluk|format haftalik/.test(l)));
    if (ageMin < (long ? 100 : 50)) return;
    const n = killTree(pid); if (pipelineProc) { try { killTree(pipelineProc.pid); } catch { /* yok */ } }
    try { rmSync(lockDir, { recursive: true, force: true }); } catch { /* yok */ }
    state.running = false; state.scheduled = false;
    push(`⚠️ üretim ${Math.round(ageMin)} dakikadır bitmedi, takılmış: durduruldu (${n} süreç), kilit kaldırıldı; sıradaki üretim normal başlayacak`);
    healthAlert(`stuck-${Math.floor(Date.now() / 3600000)}`, `Video üretimi ${Math.round(ageMin)} dakikadır bitmemişti (takıldı). Durdurdum; sıradaki üretim normal başlayacak.\nSon log: ${state.log.slice(-3).join(" | ").slice(0, 300)}`, { everyH: 1 });
  } catch { /* ps/stat yok */ }
}, 5 * 60000);

// ---------- Uyku algılama: dakikalık sayaç 5 dk'dan fazla atladıysa Mac uyumuştur (kapak kapalı, pilde ya da uyku
// ayarı). Uykuda zamanlayıcı, WhatsApp ve taramalar çalışmaz; uyanınca log + WhatsApp ile ne kadar uyuduğu söylenir.
let lastTick = Date.now();
setInterval(() => {
  const now = Date.now(), gap = now - lastTick; lastTick = now;
  if (gap < 5 * 60000) return;
  const hm = (t) => new Date(t).toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" });
  const h = gap / 3600000, dur = h >= 1 ? `${h.toFixed(1).replace(".", ",")} saat` : `${Math.round(gap / 60000)} dakika`;
  const msg = `Mac ${dur} uykudaydı (${hm(now - gap)}–${hm(now)}): bu sürede üretim, haber taraması ve WhatsApp çalışmadı. Kapak kapalıyken ya da pildeyken Mac uyur; sürekli çalışması için şarja takılı ve kapağı açık (ya da harici ekranlı) tutun.`;
  push(`💤 ${msg}`);
  setTimeout(() => healthAlert(`sleep-${Math.floor(now / 3600000)}`, msg, { everyH: 1 }).catch(() => {}), 45000); // WhatsApp yeniden bağlansın
}, 60000);

// ---------- yorum özeti (scripts/comments.py + prompts/yorumlar.md): her akşam settings.comments {enabled, hour 20,
// minute 0}; YouTube/Instagram'daki yeni yorumlar Claude ile özetlenir → WhatsApp + data/reports/yorumlar-<gün>.md.
// Yorumlara otomatik yanıt verilmez. Dinlenmede de çalışır (yerel model açmaz).
const commentsCfg = () => ({ enabled: true, hour: 20, minute: 0, ...(settings().comments || {}) });
const COMMENTS_FILE = path.join(DATA, "comments_last.json");
// ---------- Süresi geçen videoları YouTube'da liste dışı yap (kullanıcı kararı; scripts/expire_videos.py): saatte bir.
// Piyasa ve zam/rekor 2 gün, takvim olay günü bitince, meteoroloji uyarı bitince; diğer haberler settings.expire.newsDays (0 = hiç).
// Silinmez, oynatma listelerinden çıkar; "liste dışı yapılanları geri aç" ile geri alınır. Log 🙈.
let expireAt = 0;
async function expireCheck({ manual = false } = {}) {
  const r = await py("expire_videos.py", ["--check"]);
  for (const l of String(r.stdout || "").split("\n")) if (l.startsWith("🙈")) push(l);
  if (r.json?.error && (manual || r.json?.due?.length)) push(`🙈 liste dışı yapma: ${r.json.error}`);
  return r.json || { ok: false, error: "yanıt yok" };
}
async function expireRestore(which = "all") {
  const r = await py("expire_videos.py", ["--restore", which]);
  for (const l of String(r.stdout || "").split("\n")) if (l.startsWith("🙈")) push(l);
  return r.json || { ok: false, error: "yanıt yok" };
}
setInterval(() => { if ((settings().expire?.enabled !== false) && Date.now() - expireAt > 3600000 && !state.running) { expireAt = Date.now(); expireCheck().catch(() => {}); } }, 5 * 60000);
app.post("/api/expire/run", async (_req, res) => res.json(await expireCheck({ manual: true })));
app.post("/api/expire/restore", async (req, res) => res.json(await expireRestore(req.body?.name || "all")));

// ---------- Yorumlara anında otomatik yanıt (kullanıcı kararı; scripts/comment_reply.py, prompts/yanit.md): her
// autoReply.intervalMin (5) dk yeni yorumlar toplanır, TEK Claude çağrısıyla (düşük effort) yanıtlar yazılır, yayınlanır.
// Hakaret/spam/link → yanıt yok (reply null). Günlük sınır: YouTube 20 (kota), Instagram 60. Log 💬, dinlenmede de sürer.
const replyCfg = () => ({ enabled: true, intervalMin: 5, ...(settings().autoReply || {}) });
let replyAt = 0, replyBusy = false, replyErrAt = 0, replyClaudeErrAt = 0;
async function replyCheck({ manual = false } = {}) {
  if (replyBusy) return { ok: false, error: "Yorum yanıtlama zaten sürüyor." };
  replyBusy = true;
  try {
    const f = await pyJson(["scripts/comment_reply.py", "--fetch"], 120000).catch(() => null);
    const errs = Object.entries(f?.errors || {}).map(([k, v]) => `${k}: ${v}`);
    if (errs.length && (manual || Date.now() - replyErrAt > 6 * 3600000)) { replyErrAt = Date.now(); push(`💬 yorum yanıtı: ${errs.join(" · ")}`); }
    const cs = f?.comments || [];
    if (!cs.length && !f?.retry) return { ok: true, replied: 0, errors: errs };
    let items = [];
    if (cs.length) {
      // ilk yorumumuzun (soru) altına yazılan cevaplarda soru da verilir: Claude izleyicinin neye cevap verdiğini bilsin
      const input = cs.map((c) => ({ id: c.id, video_basligi: c.title, video_ozeti: c.context, yorum: c.text, ...(c.ourComment ? { kanalin_sorusu: c.ourComment } : {}) }));
      let arr = [];
      try {
        const txt = await brain.complete(`${readFileSync(path.join(ROOT, "prompts/yanit.md"), "utf8")}\n${JSON.stringify(input)}`);
        arr = JSON.parse((String(txt).match(/\[[\s\S]*\]/) || ["[]"])[0]);
      } catch (e) {
        // Claude kullanım sınırı/oturum: yorumlar görülmedi sayılır, sonraki turda yeniden; log saatte bir
        if (manual || Date.now() - replyClaudeErrAt > 3600000) { replyClaudeErrAt = Date.now(); push(`💬 yorum yanıtı yazılamadı (Claude): ${String(e.message || e).slice(0, 120)} — yorumlar sonraki turda yeniden denenecek`); }
        return { ok: false, error: "yanıt yazılamadı" };
      }
      const byId = Object.fromEntries((Array.isArray(arr) ? arr : []).map((x) => [String(x.id), x.reply]));
      // Claude'un atladığı yorum da "görüldü" sayılır (her turda yeniden token harcanmasın)
      items = cs.map((c) => ({ id: c.id, platform: c.platform, parent: c.parent, video: c.video, text: c.text, reply: byId[c.id] ?? null }));
    }
    const file = path.join(WORK, "replies.json");
    writeJson(file, items);
    const r = await py("comment_reply.py", ["--post", file]);
    for (const l of String(r.stdout || "").split("\n")) if (l.startsWith("💬")) push(l);
    const j = r.json || {};
    if (j.replied || j.skipped) push(`💬 ${cs.length} yeni yorum: ${j.replied || 0} yanıtlandı, ${j.skipped || 0} yanıtsız bırakıldı (hakaret/spam/anlamsız)${j.retry ? `, ${j.retry} yanıt yeniden denenecek` : ""}`);
    return { ok: true, ...j };
  } finally { replyBusy = false; }
}
setInterval(() => { const c = replyCfg(); if (c.enabled && Date.now() - replyAt >= Number(c.intervalMin) * 60000) { replyAt = Date.now(); replyCheck().catch((e) => push(`💬 yorum yanıtı hatası: ${e.message}`)); } }, 60000);
app.post("/api/comments/reply", async (_req, res) => res.json(await replyCheck({ manual: true })));

// ---------- WhatsApp'tan gönderilen videodan haber (kullanıcı isteği: "video gönderdiğimde altına nasıl bir haber istersem hazırla,
// kesilmesi gereken yerlerden kes, montaj yap"; scripts/wa_video.py + prompts/montaj.md). Video(lar) work/wa_inbox/'a iner; açıklama
// talimattır, yoksa sorulur (settings.waVideo.waitMin içinde gelen ilk mesaj talimat, "iptal" vazgeçer). Arka arkaya gelen videolar
// (albüm) 8 sn beklenip TEK haberde birleştirilir. wa_video.py çözümler (konuşma, sahneler, kareler), Claude kurgu planını yazar,
// parçalar kesilir → şablon iş klasörü → startAnlik({templateDir, userVideo}). Yayın varsayılan ONAYLA (waVideo.autoPublish false).
const waVideoCfg = () => ({ enabled: true, autoPublish: false, duration: 30, waitMin: 30, ...(settings().waVideo || {}) });
let waVid = null; // {files, instruction, at, timer, asked}
async function waVideoIn({ file, caption }) {
  const c = waVideoCfg();
  if (!c.enabled) return "WhatsApp'tan gelen videodan haber yapma kapalı (Ayarlar → 📡 Otomatik içerikler).";
  try { const dir = path.dirname(file); for (const f of readdirSync(dir)) { const p = path.join(dir, f); if (Date.now() - statSync(p).mtimeMs > 3 * 86400000) rmSync(p, { force: true }); } } catch { /* temizlik */ }
  if (!waVid || waVid.running || Date.now() - waVid.at > Number(c.waitMin) * 60000) waVid = { files: [], instruction: "", at: Date.now() };
  if (waVid.files.length >= 4) return "En çok 4 video birleştirilebilir; bu video alınmadı.";
  waVid.files.push(file); waVid.at = Date.now();
  if (caption) { const wn = parseWhen(caption); if (wn.at) waVid.publishAt = wn.at.toISOString(); waVid.instruction = `${waVid.instruction} ${caption}`.trim(); }
  push(`🎬 WhatsApp videosu alındı (${waVid.files.length}. video)${caption ? ` · talimat: ${caption.slice(0, 100)}` : ""}`);
  clearTimeout(waVid.timer);
  waVid.timer = setTimeout(() => waVideoGo().catch((e) => push(`🎬 video haberi hatası: ${e.message}`)), 8000); // albümün diğer videoları
  return null;
}
function waVideoText(text) {
  const v = waVid;
  if (!v || !v.files.length || v.instruction || v.running) return null;
  if (Date.now() - v.at > Number(waVideoCfg().waitMin) * 60000) { waVid = null; return null; }
  if (/^(iptal|vazgeç|boş ver|gerek yok)(\s|$|[.!,])/.test(text.toLocaleLowerCase("tr-TR").trim())) { clearTimeout(v.timer); waVid = null; push("🎬 video haberi iptal edildi"); return "Tamam, video ile haber yapmaktan vazgeçtim."; }
  v.instruction = text.trim(); clearTimeout(v.timer);
  { const wn = parseWhen(text); if (wn.at) v.publishAt = wn.at.toISOString(); }
  waVideoGo().catch((e) => push(`🎬 video haberi hatası: ${e.message}`));
  return true; // yanıtı waVideoGo gönderir
}
async function waVideoGo() {
  const v = waVid;
  if (!v || !v.files.length || v.running) return;
  if (!v.instruction) {
    if (!v.asked) { v.asked = true; try { await wa.send(`🎬 ${v.files.length > 1 ? `${v.files.length} video` : "Video"} alındı. Nasıl bir haber yapayım? Kısaca yazın — ne olduğunu, nerede olduğunu, istediğiniz süreyi ve kesilmesini istediğiniz yerleri.\nÖrnek: "Kadıköy'de akşam saatlerinde iş yerinde yangın çıktı, 30 saniye, başındaki titrek kısmı kes"\n(${waVideoCfg().waitMin} dk içinde yazın; vazgeçmek için *iptal*)`); } catch { /* WhatsApp yok */ } }
    return;
  }
  v.running = true; waVid = null;
  return runVideoNews(v);
}
const sendW = async (t) => { try { await wa.send(t); } catch { /* WhatsApp bağlı değil: log yeterli */ } };
// Ortak montaj adımı: WhatsApp videosu ya da sosyal medya linkinden indirilen video {files, instruction, social?, related?}
async function runVideoNews(v) {
  push(`🎬 video haberi hazırlanıyor (${v.files.length} video${v.social ? `, ${v.social.credit}` : ""}): ${v.instruction.slice(0, 120)}`);
  await sendW(`🎬 Videoyu inceliyorum: konuşmayı dinliyor, sahneleri ve kareleri çıkarıyorum, sonra kurguyu yazıp kesimleri yapacağım (1-3 dk).`);
  const jobFile = path.join(WORK, `wa_video_${Date.now()}.json`);
  writeJson(jobFile, { videos: v.files, instruction: v.instruction, social: v.social || null, related: v.related || [] }); // süre talimatta yazmıyorsa settings.waVideo.duration
  const r = await run(PY, ["scripts/wa_video.py", "--job", jobFile], { timeout: 25 * 60000 });
  rmSync(jobFile, { force: true });
  for (const l of String(r.stdout || "").split("\n")) if (/^(🎬|✂️|  !)/.test(l)) push(l.trim());
  let j = null; try { j = JSON.parse(String(r.stdout || "").trim().split("\n").pop()); } catch { /* yanıt yok */ }
  if (!j?.ok) { const err = j?.error || String(r.stderr || "yanıt yok").slice(-200); push(`🎬 video haberi hazırlanamadı: ${err}`); await sendW(`❌ Video haberi hazırlanamadı: ${err}`); return { ok: false, error: err }; }
  const p = j.plan || {};
  const segLines = (p.segments || []).map((s) => `• ${s.kind === "hook" ? "Kanca" : s.kind === "sesli" ? `🔊 Orijinal ses${s.title ? ` (${s.title})` : ""} — seslendirme susar` : s.title}: ${s.clips.map((c) => `${v.files.length > 1 ? `${c.video}. video ` : ""}${c.start.toFixed(1).replace(".", ",")}–${c.end.toFixed(1).replace(".", ",")} sn`).join(", ")}`).join("\n");
  push(`✂️ kurgu: ${String(p.cuts || "").slice(0, 200)}`);
  await sendW(`✂️ *Kurgu hazır* — ${p.titles?.A || p.hook}${j.vertical ? "\n📱 Dikey video: haberler tam ekran dikey düzende" : ""}${j.soundSeconds ? `\n🔊 ${String(j.soundSeconds).replace(".", ",")} sn videonun kendi sesiyle` : ""}\n\n${p.cuts ? `Kesimler: ${p.cuts}\n\n` : ""}Kullanılan bölümler:\n${segLines}${p.speech === false ? "\n\n⚠️ Videodaki konuşma yazıya dökülemedi (konuşma tanıma Mac'te kurulamadı); kurgu yalnız görüntüye göre yapıldı. Kurmak için Mac'te bir kez: bash scripts/install_align.sh" : ""}\n\n🎙 ${String(p.narration || "").slice(0, 600)}\n\nVideo üretiliyor (${j.duration} sn); bitince buraya gelecek${v.publishAt ? ` ve ⏰ ${whenLabel(new Date(v.publishAt))}'de bağlı hesaplarda yayınlanacak (iptal: planlı yayını iptal et)` : waVideoCfg().autoPublish ? " ve bağlı hesaplarda yayınlanacak" : ", yayın için *onay* isteyeceğim"}.`);
  const res = startAnlik(p.titles?.A || p.hook || v.instruction, j.duration, { templateDir: j.job, info: { kind: "video", label: p.label || "SON DAKİKA", intro: "Son dakika." },
    source: v.social?.credit || "Türkiye Gündemi", ...(v.social?.url ? { url: v.social.url } : {}), userVideo: true, ...(v.publishAt ? { publishAt: v.publishAt } : {}) });
  if (!res.ok) await sendW(`❌ Üretim başlatılamadı: ${res.error}`);
  else if (res.queued) await sendW(`⏳ Şu an başka üretim sürüyor; video haberiniz ${res.position}. sırada.`);
  return res;
}

// Sosyal medya paylaşım linki (Instagram/TikTok/X/YouTube/Facebook; kullanıcı isteği: "viral olmuş haberin linkini göndersem
// videoyu çekip bizim stilimizde haber yap"): scripts/social_video.py indirir + paylaşım bilgisi + haber sitelerinde aynı olay;
// sonra runVideoNews (kurgu, kesim, seslendirme). Kaynak hesabı kartlarda ve açıklamada görünür; yayın onaylı (userVideo).
let socialBusy = false;
async function socialVideoNews({ url, instruction = "", publishAt = null }) {
  if (socialBusy) return { ok: false, error: "Bir paylaşım zaten indiriliyor; bitince tekrar gönderin." };
  socialBusy = true;
  try {
    push(`🔗 sosyal medya paylaşımı indiriliyor: ${url}`);
    const r = await run(PY, ["scripts/social_video.py", "--url", url], { timeout: 8 * 60000 });
    let j = null; try { j = JSON.parse(String(r.stdout || "").trim().split("\n").pop()); } catch { /* yanıt yok */ }
    if (!j?.ok) { const err = j?.error || String(r.stderr || "yanıt yok").slice(-200); push(`🔗 paylaşım indirilemedi: ${err}`); await sendW(`❌ Paylaşım indirilemedi: ${err}`); return { ok: false, error: err }; }
    const s = j.social || {};
    const n = (x) => (x == null ? null : Number(x).toLocaleString("tr-TR"));
    push(`🔗 indirildi: ${s.credit}${s.views ? ` · ${n(s.views)} izlenme` : ""}${s.likes ? ` · ${n(s.likes)} beğeni` : ""} · haber sitelerinde ${j.related?.length ? `${j.related.length} ilgili haber bulundu` : "ilgili haber bulunamadı (açıklama iddia olarak aktarılacak)"}`);
    await sendW(`🔗 Paylaşım indirildi: ${s.credit}${s.views ? ` · ${n(s.views)} izlenme` : ""}${s.date ? ` · ${s.date}` : ""}\n${j.related?.length ? `📰 Aynı olay haber sitelerinde de var (${[...new Set(j.related.map((x) => x.site).filter(Boolean))].slice(0, 3).join(", ")}); bilgiler oradan doğrulanacak.` : "📰 Haber sitelerinde bulunamadı; paylaşımdaki bilgiler \"iddia\" olarak aktarılacak."}`);
    return await runVideoNews({ files: [j.file], instruction: instruction || "Bu paylaşımdaki olayı tarafsız bir haber olarak anlat.", social: s, related: j.related || [], publishAt });
  } finally { socialBusy = false; }
}

// ---------- Planlı yayın (kullanıcı isteği: "linki gönderip bunu şu saatte paylaş diyeyim"): post_pipeline saati gelmemiş videoyu
// data/scheduled_publish.json'a yazar; panel dakikada bir bakar, saati gelince bağlı hesaplara yayınlar ve WhatsApp'a yazar.
// Mac uykudaysa uyanınca yayınlar; 12 saatten fazla geciktiyse (haber bayatladı) yayınlamaz, sorar. Log ⏰.
const PUB_SCHED = path.join(DATA, "scheduled_publish.json");
const schedItems = () => readJson(PUB_SCHED, []) || [];
const vidTitle = (name) => { const m = readJson(path.join(OUT, name.replace(/\.mp4$/, ".json")), {}); return m.publishTitle || m.titles?.A || name; };
let schedBusy = false;
async function publishScheduled(item, { late = false } = {}) {
  writeJson(PUB_SCHED, schedItems().filter((x) => x.video !== item.video));
  if (!existsSync(path.join(OUT, item.video))) { push(`⏰ planlı yayın: ${item.video} bulunamadı (silinmiş), atlandı`); return { ok: false }; }
  push(`⏰ planlı yayın zamanı geldi${late ? " (gecikmeli)" : ""}: ${vidTitle(item.video).slice(0, 80)} → ${item.platforms.join(", ")}`);
  const r = await execAction({ type: "publish", video: item.video, platforms: item.platforms });
  const lines = Object.entries(r.results || {}).map(([k, x]) => x.ok ? `✅ ${k}: ${x.skipped ? "zaten yayında" : (x.url || x.note || "tamam")}` : `❌ ${k}: ${String(x.error || "").slice(0, 140)}`);
  await sendW(`⏰ *Planlı yayın yapıldı*${late ? " (Mac uykudaydı, gecikmeli)" : ""}: ${vidTitle(item.video).slice(0, 90)}\n${lines.join("\n")}`);
  return r;
}
setInterval(async () => {
  if (schedBusy) return; schedBusy = true;
  try {
    for (const it of schedItems().filter((x) => x.at * 1000 <= Date.now())) {
      const lateH = (Date.now() - it.at * 1000) / 3600000;
      if (lateH > 12) {
        writeJson(PUB_SCHED, schedItems().filter((x) => x.video !== it.video));
        push(`⏰ planlı yayın ${Math.round(lateH)} saat gecikti (Mac kapalı/uykudaydı), haber bayatlamış olabilir: yayınlanmadı — ${it.video}`);
        await sendW(`⏰ Planlı yayın ${Math.round(lateH)} saat gecikti (Mac kapalı ya da uykudaydı); haber bayatlamış olabileceği için yayınlamadım: ${vidTitle(it.video).slice(0, 80)}. Yine de isterseniz panelden ya da "son videoyu yayınla" ile yayınlayın.`);
        continue;
      }
      await publishScheduled(it, { late: lateH > 0.25 });
    }
  } catch (e) { push(`⏰ planlı yayın hatası: ${e.message}`); } finally { schedBusy = false; }
}, 60000);
async function scheduledCommand({ cancel = false, now = false } = {}) {
  const items = schedItems().sort((a, b) => a.at - b.at);
  if (!items.length) return "Planlı yayın yok.";
  if (cancel) { writeJson(PUB_SCHED, []); push(`⏰ planlı yayınlar iptal edildi (${items.length})`); return `${items.length} planlı yayın iptal edildi; videolar Mac'te duruyor, isterseniz panelden yayınlayabilirsiniz.`; }
  if (now) { for (const it of items) await publishScheduled(it); return `${items.length} planlı yayın şimdi yayınlandı.`; }
  return "⏰ Planlı yayınlar:\n" + items.map((x) => `• ${whenLabel(new Date(x.at * 1000))} — ${vidTitle(x.video).slice(0, 70)} → ${x.platforms.join(", ")}`).join("\n") + "\n(İptal: planlı yayını iptal et · hemen: planlı yayını şimdi yayınla)";
}
app.get("/api/scheduled", (_req, res) => res.json({ items: schedItems() }));

// ---------- Günün en çok izlenenleri Instagram hikâyesinde (kullanıcı isteği; scripts/ig_stories.py): her akşam
// settings.igStories {enabled, hour 21, minute 0, count 3} son 24 saatin en çok izlenen videoları (aynı olay bir kez) +
// sıralama kartı hikâye olarak paylaşılır, özet WhatsApp'a. Saatinden sonraki 3 saat içinde, üretim sürmüyorken, günde bir.
// Hafif iş (bir kart çizimi + ffmpeg kesimi): dinlenmede de çalışır. Log 📸.
const storiesCfg = () => ({ enabled: true, hour: 21, minute: 0, count: 3, ...(settings().igStories || {}) });
let storiesBusy = false, storiesErrDay = "";
async function storiesRun({ manual = false, force = false, notify = true } = {}) {
  if (storiesBusy) return { ok: false, error: "Instagram hikâyesi zaten hazırlanıyor." };
  storiesBusy = true;
  try {
    if (!manual) infoMark("igStories", { day: today() });
    const m = readJson(path.join(DATA, "metrics.json"), {});
    if (!m.lastSync || Date.now() - Date.parse(m.lastSync) > 30 * 60000) await execAction({ type: "sync_metrics" }).catch(() => {});
    push("📸 Instagram hikâyesi hazırlanıyor: günün en çok izlenen haberleri");
    const r = await run(PY, ["scripts/ig_stories.py", "--run", ...(force ? ["--force"] : [])], { timeout: 25 * 60000 });
    for (const l of String(r.stdout || "").split("\n")) if (l.startsWith("📸")) push(l);
    let j = null; try { j = JSON.parse(String(r.stdout || "").trim().split("\n").pop()); } catch { /* yanıt yok */ }
    if (!j?.ok) {
      const err = j?.error || String(r.stderr || "yanıt yok").slice(-200);
      push(`📸 Instagram hikâyesi paylaşılmadı: ${err}`);
      if (!manual && !j?.already && storiesErrDay !== today()) { storiesErrDay = today(); healthAlert(`stories-${today()}`, `Günün Instagram hikâyesi paylaşılamadı: ${err}`, { everyH: 20 }).catch(() => {}); }
      return { ok: false, error: err, already: !!j?.already };
    }
    const top = j.top || [];
    const text = `📸 *Instagram hikâyesi paylaşıldı*: günün en çok izlenen ${top.length} haberi` + (j.failed ? ` (${j.failed} hikâye paylaşılamadı)` : "") + "\n" +
      top.map((x, i) => `${i + 1}. ${String(x.title).slice(0, 70)} — ${Number(x.views).toLocaleString("tr-TR")} izlenme`).join("\n");
    push(`📸 Instagram hikâyesi: ${j.published} hikâye paylaşıldı${j.failed ? `, ${j.failed} paylaşılamadı` : ""}`);
    if (notify) { try { await wa.send(text); } catch { /* WhatsApp bağlı değil: log yeterli */ } }
    return { ...j, text };
  } finally { storiesBusy = false; }
}
setInterval(() => {
  const c = storiesCfg(), n = new Date(), mins = n.getHours() * 60 + n.getMinutes(), start = Number(c.hour) * 60 + Number(c.minute);
  if (!c.enabled || state.running || storiesBusy || infoState().igStories?.day === today() || mins < start || mins >= start + 180) return;
  storiesRun().catch((e) => push(`📸 Instagram hikâyesi hatası: ${e.message}`));
}, 60000);
app.get("/api/stories", async (_req, res) => res.json({ cfg: storiesCfg(), ...(await pyJson(["scripts/ig_stories.py", "--plan"], 60000).catch(() => ({}))) }));
app.post("/api/stories/run", async (req, res) => res.json(await storiesRun({ manual: true, force: !!req.body?.force })));

async function commentsDigest({ manual = false } = {}) {
  writeJson(COMMENTS_FILE, { day: today(), at: Date.now() });
  const r = await py("comments.py", []);
  const list = r.json?.comments || [], errs = Object.entries(r.json?.errors || {});
  const errTxt = errs.map(([k, e]) => `${k === "youtube" ? "YouTube" : "Instagram"}: ${e}`).join("\n");
  if (!list.length) { push(`💬 yorum özeti: yeni yorum yok${errTxt ? ` (${errTxt.replace(/\n/g, " · ")})` : ""}`); return { ok: true, count: 0, text: "Yeni yorum yok.", errors: r.json?.errors }; }
  push(`💬 yorum özeti hazırlanıyor: ${list.length} yeni yorum`);
  const slim = list.slice(-150).map((c) => ({ p: c.platform, v: String(c.title || "").slice(0, 80), y: String(c.text || "").slice(0, 300), b: c.likes || 0 }));
  let text;
  try { text = (await brain.complete(`${readFileSync(path.join(ROOT, "prompts/yorumlar.md"), "utf8")}\n${JSON.stringify(slim)}`)).trim(); }
  catch (e) { push(`💬 yorum özeti yazılamadı: ${claudeError(e.message)}`); return { ok: false, error: claudeError(e.message) }; }
  const msg = `💬 *Günün yorum özeti* (${list.length} yorum)\n\n${text}${errTxt ? `\n\n⚠ ${errTxt}` : ""}`;
  mkdirSync(path.join(DATA, "reports"), { recursive: true });
  writeFileSync(path.join(DATA, "reports", `yorumlar-${today()}.md`), msg + "\n");
  try { await wa.send(msg); push(`💬 yorum özeti WhatsApp'a gönderildi (${list.length} yorum)`); } catch { push(`💬 yorum özeti hazır (WhatsApp bağlı değil): data/reports/yorumlar-${today()}.md`); }
  return { ok: true, count: list.length, text: msg };
}
setInterval(() => { const c = commentsCfg(); const n = new Date(); if (!c.enabled || n.getHours() * 60 + n.getMinutes() < Number(c.hour) * 60 + Number(c.minute) || readJson(COMMENTS_FILE, {}).day === today()) return; commentsDigest().catch((e) => push(`💬 yorum özeti: ${e.message}`)); }, 60000);
app.post("/api/comments/digest", async (_req, res) => res.json(await commentsDigest({ manual: true })));
// ---------- disk temizliği (scripts/cleanup.py): her gece 04:10, settings.cleanup {enabled, days 30}; dinlenmede de (hafif)
const CLEAN_FILE = path.join(DATA, "cleanup_last.json");
async function runCleanup({ manual = false } = {}) {
  const r = await py("cleanup.py", []);
  const j = r.json || {};
  writeJson(CLEAN_FILE, { day: today(), at: Date.now(), deleted: (j.deleted || []).length, freedMb: j.freedMb || 0 });
  if ((j.deleted || []).length) push(`🧹 disk temizliği: ${(j.deleted || []).length} eski videonun Mac'teki kopyası silindi, ${(j.freedMb / 1024).toFixed(1)} GB boşaldı (kayıtlar, kapaklar ve platformdaki videolar duruyor)`);
  else if (manual) push("🧹 disk temizliği: silinecek eski video yok");
  return j;
}
setInterval(() => { const n = new Date(); if (n.getHours() === 4 && n.getMinutes() >= 10 && readJson(CLEAN_FILE, {}).day !== today() && !pipelineBusy() && (settings().cleanup?.enabled !== false)) runCleanup().catch((e) => push(`🧹 disk temizliği: ${e.message}`)); }, 60000);
app.post("/api/cleanup", async (req, res) => res.json(req.body?.dryRun ? (await py("cleanup.py", ["--dry-run"])).json || {} : await runCleanup({ manual: true })));
// ---------- haftanın özeti (yatay, YouTube): settings.weeklySummary {enabled, weekday 0 = pazar, hour 20, minute 30,
// duration 300, stories 10, autoPublish}; GUNLUK=1 + HAFTALIK=1 (aynı GunlukOzet kompozisyonu), data/weekly_video_last.json
const weeklyCfg = () => ({ enabled: true, weekday: 0, hour: 20, minute: 30, duration: 300, stories: 10, autoPublish: true, ...(settings().weeklySummary || {}) });
const WEEKLY_VIDEO_FILE = path.join(DATA, "weekly_video_last.json");
function startWeekly({ manual = false } = {}) {
  const c = weeklyCfg();
  if (pipelineBusy()) return { ok: false, error: "Başka bir üretim sürüyor; bitince haftanın özeti başlar." };
  const r = startPipeline(c.duration, { GUNLUK: "1", HAFTALIK: "1", GUNLUK_DURATION: String(c.duration) }, { auto: !manual });
  if (r.ok) writeJson(WEEKLY_VIDEO_FILE, { day: today(), at: Date.now(), manual });
  return r;
}
setInterval(() => {
  const c = weeklyCfg(); if (!c.enabled) return;
  const now = new Date();
  if (now.getDay() !== Number(c.weekday) || now.getHours() * 60 + now.getMinutes() < Number(c.hour) * 60 + Number(c.minute)) return;
  if (readJson(WEEKLY_VIDEO_FILE, {}).day === today() || pipelineBusy() || resting()) return;
  startWeekly();
}, 60000);
app.get("/api/weekly-video", (_req, res) => res.json({ ...weeklyCfg(), last: readJson(WEEKLY_VIDEO_FILE, {}) }));
app.post("/api/weekly-video/run", (_req, res) => res.json(startWeekly({ manual: true })));
app.get("/api/daily", (_req, res) => res.json({ ...dailyCfg(), last: readJson(DAILY_FILE, {}) }));
app.post("/api/daily/run", (_req, res) => res.json(startDaily({ manual: true })));

// ---------- zamanlayıcı (launchd)
const PLIST = path.join(process.env.HOME || "", "Library/LaunchAgents/com.gundem.video.plist");
const SCHED_FILE = path.join(DATA, "schedule.json");
const readSched = () => { try { return JSON.parse(readFileSync(SCHED_FILE, "utf8")); } catch { return {}; } };
// Üretim saatleri sabittir: 24 saat "hours" aralığıyla bölünür (5 → 00,05,10,15,20). Dakika settings.scheduleMinute.
// settings.scheduleOffset: "en iyi yayın saati" önerisiyle kaydırma (ör. +2 → 02,07,12,17,22)
const slotsFor = (hours) => { const off = Number(settings().scheduleOffset) || 0, out = []; for (let h = 0; h < 24; h += Math.max(1, Math.round(hours))) out.push(((h + off) % 24 + 24) % 24); return out.sort((a, b) => a - b); };
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
// launchd işleri (kök neden, 12 Ekim: zamanlayıcı yeniden yüklenirken launchd'den düşmüş, 5 slot boyunca üretim olmadı):
// yeni macOS'ta "unload" hemen ardından "load" sessizce başarısız olabiliyor ve load yine 0 döndürüyor. Bu yüzden
// bootout/bootstrap kullanılır, her yüklemeden sonra `launchctl print` ile gerçekten yüklendiği doğrulanır, olmazsa
// 3 kez denenir. healthCheck her 10 dk'da ve panel açılışında plist var ama iş yüklü değilse yeniden yükler.
// launchctl list "LastExitStatus" bir bekleme durumudur: 256 → çıkış 1, 768 → 3, 19968 → 78. Okunur Türkçe açıklama.
function exitText(raw) {
  const n = Number(raw);
  if (n < 0) return `son zamanlanmış çalışma ${-n} sinyaliyle durduruldu`;
  const code = n > 255 ? n >> 8 : n;
  const why = {
    1: "üretim hata ile bitti (ayrıntı work/pipeline-*.log)",
    3: "başka üretim sürüyordu, bu slot atlandı",
    78: "launchd işi HİÇ BAŞLATAMADI (EX_CONFIG): proje klasörüne erişemiyor. Proje Masaüstünde olduğu için macOS gizlilik koruması büyük olasılıkla engelliyor. Çözüm: Sistem Ayarları → Gizlilik ve Güvenlik → Tam Disk Erişimi → + → /bin/bash ekleyip açın (Finder'da Cmd+Shift+G ile /bin yazın), sonra panelde zamanlayıcıyı kapatıp açın; ya da projeyi Masaüstü dışına taşıyın. Bu arada slotları panel kendisi başlatıyor",
    126: "pipeline.sh çalıştırılamadı (izin yok)", 127: "komut bulunamadı (PATH)",
  }[code];
  return `son zamanlanmış çalışmanın çıkış kodu ${code}${why ? ` — ${why}` : ""}`;
}
const LA_DOMAIN = `gui/${process.getuid?.() ?? 501}`;
const VIDEO_JOB = "com.gundem.video";
const jobLoaded = (label = VIDEO_JOB) => isMac && spawnSync("launchctl", ["print", `${LA_DOMAIN}/${label}`], { encoding: "utf8" }).status === 0;
async function loadAgent(plist, label = VIDEO_JOB) {
  let err = "";
  for (let i = 0; i < 3; i++) {
    const b = await run("launchctl", ["bootstrap", LA_DOMAIN, plist]);
    if (jobLoaded(label)) return { ok: true };
    const l = await run("launchctl", ["load", "-w", plist]);
    if (jobLoaded(label)) return { ok: true };
    err = String(b.stderr || l.stderr || "").trim().slice(0, 200);
    await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
  }
  return { ok: false, error: err || "launchd işi yüklenemedi" };
}
async function unloadAgent(plist, label = VIDEO_JOB) {
  await run("launchctl", ["bootout", `${LA_DOMAIN}/${label}`]);
  if (jobLoaded(label)) await run("launchctl", ["unload", plist]);
  for (let i = 0; i < 10 && jobLoaded(label); i++) await new Promise((r) => setTimeout(r, 300)); // kapanması sürebilir
}
async function ensureScheduleLoaded(why) {
  if (!isMac || !existsSync(PLIST) || jobLoaded()) return null;
  const r = await loadAgent(PLIST);
  push(r.ok ? `⏰ zamanlayıcı launchd'den düşmüştü (${why}); yeniden yüklendi, planlı üretimler sürecek` : `⏰ zamanlayıcı launchd'de yüklü değil ve yüklenemedi: ${r.error}`);
  if (!r.ok) healthAlert("sched-load", `5 saatlik zamanlayıcı yüklenemedi (${r.error}). Panelde Otomatik üretim anahtarını kapatıp açın.`, { everyH: 6 });
  return r;
}

async function setSchedule(enabled, hours) {
  if (!isMac) return { ok: false, error: "launchd sadece macOS'ta" };
  if (existsSync(PLIST)) await unloadAgent(PLIST);
  if (!enabled) { if (existsSync(PLIST)) unlinkSync(PLIST); keepAwake(false); return { ok: true }; }
  const minute = Number(settings().scheduleMinute) || 0;
  const slots = slotsFor(hours);
  const cal = slots.map((h) => `    <dict><key>Hour</key><integer>${h}</integer><key>Minute</key><integer>${minute}</integer></dict>`).join("\n");
  writeFileSync(PLIST, readFileSync(path.join(ROOT, "launchd/com.gundem.video.plist"), "utf8").replace(/__PROJE_YOLU__/g, ROOT).replace(/__HOME__/g, process.env.HOME || "").replace("__CALENDAR__", cal));
  patchSettings({ scheduleHours: hours });
  const r = await loadAgent(PLIST);
  if (r.ok) { writeFileSync(SCHED_FILE, JSON.stringify({ loadedAt: Date.now(), hours, slots, minute })); keepAwake(true); push(`⏰ üretim saatleri: her gün ${slots.map((h) => String(h).padStart(2, "0") + ":" + String(minute).padStart(2, "0")).join(", ")}`); }
  if (!r.ok) push(`⏰ zamanlayıcı yüklenemedi: ${r.error}`);
  return r.ok ? { ok: true, slots } : { ok: false, error: r.error || "launchctl yükleme başarısız" };
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
    for (const l of lines) { if (!l.trim()) continue; if (/üretim başladı/.test(l) && !state.running) { state.running = true; state.startedAt = Date.now(); state.scheduled = true; push("⏰ zamanlayıcı üretimi başladı"); restEnd("planlı 5 saatlik üretim başladı"); } push(l); const m = l.match(/== bitti: (out\/\S+\.mp4)/); if (m) state.lastVideo = path.basename(m[1]); if (/^\{"autopublish"/.test(l) || /yayın\/analiz adımı hata/.test(l) || /^✖ üretim hata/.test(l)) { if (state.scheduled) { state.running = false; state.scheduled = false; push("✔ zamanlayıcı üretimi tamamlandı"); } } }
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
    case "breaking_news": return prepareAnlik(a.topic, a.duration);
    case "schedule": return setSchedule(!!a.enabled, Number(a.hours) || 5);
    case "note": brain.addNote(a.text); return { ok: true };
    case "sync_metrics": { push("📊 izlenmeler çekiliyor"); const r = await py("sync_metrics.py"); await py("analyze.py"); viralCheck().catch((e) => push(`🔥 viral kontrolü: ${e.message}`)); retitleCheck().catch(() => {}).then(() => firstCommentCheck()).catch(() => {}); push(`📊 ${r.ok ? `güncellendi: YT ${r.json?.youtube ?? 0}, IG ${r.json?.instagram ?? 0}, TT ${r.json?.tiktok ?? 0}` : "hata"}`); return { ok: r.ok, ...(r.json || {}) }; }
    case "autopublish": patchSettings({ autopublish: { youtube: !!a.youtube, instagram: !!a.instagram, tiktok: !!a.tiktok } }); return { ok: true };
    case "settings": patchSettings(a.patch || {}); return { ok: true, settings: settings() };
    case "improvement": { const r = queueImprovement(a.task); push(`🛠 geliştirme kuyruğuna eklendi: ${a.task}`); return r; }
    case "restart": setTimeout(() => process.exit(75), 800); return { ok: true, restarting: true };
    case "publish": { const results = {}; for (const p of a.platforms || []) { push(`📤 ${p}: yükleniyor ${a.video}`); const r = await py("publish.py", ["--file", path.basename(a.video), "--platform", p]); for (const l of String(r.stderr || "").split("\n")) if (/^🌐|^  (video|geçici|!|▶|♪|💬)/.test(l)) push(l.trim()); results[p] = r.json || { ok: false, error: (r.stderr || r.stdout).slice(-300) }; push(`📤 ${p}: ${results[p].ok ? (results[p].skipped ? "zaten yayında" : "tamam " + (results[p].url || results[p].note || "")) : (results[p].limit ? "sınır doldu — " : "hata ") + results[p].error}`); } await py("analyze.py"); try { wa.clearPending(path.basename(a.video)); } catch { /* yok */ } return { ok: Object.values(results).every((x) => x.ok), results }; }
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
const videoInfo = (name) => { const v = name ? listVideos().find((x) => x.name === name) : listVideos()[0]; if (!v) return null; const meta = readJson(path.join(OUT, v.name.replace(/\.mp4$/, ".json")), { segments: [] }); return { ...v, label: label(v), path: path.join(OUT, v.name), segments: meta.segments || [], anlik: !!meta.anlik || meta.format === "anlik", format: meta.format || null, value: meta.value || null, userVideo: !!meta.userVideo, publishAt: meta.publishAt || null, published: { youtube: !!v.youtube, instagram: !!v.instagram, tiktok: !!v.tiktok } }; };
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
const wa = await makeWhatsApp({ handleVideo: (v) => waVideoIn(v), videoInstruction: (t) => waVideoText(t), autoAll: () => existsSync(PLIST) || !!settings().autoMode, ROOT, settings, push, announce, handleCommand, videoInfo, links: waLinks, publishVideo: (video, platforms) => execAction({ type: "publish", video, platforms }), automode: (on) => setAutoMode(on), statusText });
app.get("/api/whatsapp", (_req, res) => res.json(wa.status()));
// WhatsApp bağlantı bekçisi (kullanıcı isteği): 2 dk'da bir; kopuksa yeniden bağlar, takılırsa soketi yeniler. 30 dk'da 5'ten fazla
// yeniden bağlanma ya da QR beklemesi (oturum düştü) → sağlık uyarısı (log + ses; WhatsApp mesajı bağlanınca kuyruktan gider).
let waReconnectTimes = [];
setInterval(async () => {
  if (!settings().whatsapp?.enabled) return;
  try {
    const r = await wa.watchdog();
    if (r.reconnecting) waReconnectTimes = [...waReconnectTimes.filter((t) => Date.now() - t < 30 * 60000), Date.now()];
    if (waReconnectTimes.length > 5) healthAlert("wa-unstable", `WhatsApp bağlantısı son 30 dakikada ${waReconnectTimes.length} kez koptu. İnternet bağlantısını ve telefonda WhatsApp'ın açık olduğunu kontrol edin.`, { everyH: 3 }).catch(() => {});
    if (r.needQr) healthAlert("wa-qr", "WhatsApp oturumu düştü: panelde Ayarlar → WhatsApp'tan QR kodu yeniden okutun.", { everyH: 6 }).catch(() => {});
  } catch (e) { push(`💬 WhatsApp bekçisi hatası: ${e.message}`); }
}, 120000);
app.post("/api/whatsapp/start", async (_req, res) => res.json(await wa.start()));
app.post("/api/whatsapp/stop", async (_req, res) => res.json(await wa.stop()));
app.post("/api/whatsapp/logout", async (_req, res) => res.json(await wa.logout()));
app.post("/api/whatsapp/test", async (_req, res) => { try { await wa.send("✅ Emixhas test mesajı. Bağlantı çalışıyor."); res.json({ ok: true }); } catch (e) { res.json({ ok: false, error: e.message }); } });
app.post("/api/whatsapp/send-latest", async (req, res) => { const v = listVideos()[0]; if (!v) return res.json({ ok: false, error: "video yok" }); res.json(await wa.notifyVideo(req.body?.name || v.name, { ask: true })); });
if (settings().whatsapp?.enabled && settings().whatsapp?.autoStart) setTimeout(() => wa.start().catch((e) => push(`✖ WhatsApp: ${e.message}`)), 2500);

// Yeni video (panelden veya launchd'den) → WhatsApp bildirimi. out/ klasörü izlenir, bilinen dosyalar atlanır.
const knownVideos = new Set(readdirSync(OUT).filter((f) => f.endsWith(".mp4")));
try { watch(OUT, (ev, file) => { if (!file || !file.endsWith(".json")) return; const mp4 = file.replace(/\.json$/, ".mp4"); setTimeout(async () => { if (knownVideos.has(mp4) || !existsSync(path.join(OUT, mp4))) return; knownVideos.add(mp4); if (settings().whatsapp?.enabled && settings().whatsapp?.notifyOnVideo) {
  if (waDigest()) { // tek mesaj: yayın bitince gönderilir (yayın adımı zaten bittiyse hemen)
    if (digestPending && digestPending.mp4 !== mp4) await sendDigest("yeni video çıktığı için");
    digestPending = { mp4, at: Date.now() };
    const since = state.log.slice(-300); const startIdx = since.findLastIndex((l) => /üretim başladı/.test(l));
    if (startIdx >= 0 && since.slice(startIdx).some((l) => /^\{"autopublish"/.test(l))) sendDigest("yayın bitti");
    else setTimeout(() => { if (digestPending?.mp4 === mp4) sendDigest("yayın adımı 20 dk'da bitmediği için"); }, 20 * 60000);
    return;
  }
  const r = await wa.notifyVideo(mp4, { ask: true }); if (!r.ok) push(`💬 WhatsApp bildirimi gönderilemedi: ${r.error}`); } }, 1500); }); } catch { /* yok */ }

// ---------- API: durum
app.get("/api/status", async (_req, r) => r.json({ ...state, log: state.log.slice(-60), lanUrl: `http://${lanIp()}:${PORT}`, isMac, schedule: await getSchedule(), settings: settings(), connections: await brain.connections(), tunnel: tunnelStatus(), tts: ttsStatus(), turkishVoice: turkishVoiceStatus(), resources: sampleResources(), usage: brain.usageToday(), whatsapp: wa.status(), rest: restInfo(), watch: { lastAt: watchLast || null, nextAt: (mynetCfg().enabled || breakingCfg().enabled) ? (watchLast || Date.now()) + watchMin() * 60000 : null, everyMin: watchMin(), scanning: watchScanning } }));
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
// Küçük resim: varsa videonun kapağı (out/<ad>-kapak.jpg), yoksa videonun 4. saniyesi. Kapak yenilenince küçük resim de yenilenir.
async function makeThumb(name, width) {
  const src = path.join(OUT, name); const dst = path.join(THUMBS, name.replace(/\.mp4$/, ".jpg"));
  const cover = path.join(OUT, name.replace(/\.mp4$/, "-kapak.jpg"));
  const stale = existsSync(dst) && existsSync(cover) && statSync(cover).mtimeMs > statSync(dst).mtimeMs;
  if (!existsSync(dst) || stale) {
    if (existsSync(cover)) await run("ffmpeg", ["-y", "-loglevel", "error", "-i", cover, "-vf", `scale=${width}:-1`, dst]);
    else if (existsSync(src)) await run("ffmpeg", ["-y", "-loglevel", "error", "-ss", "4", "-i", src, "-frames:v", "1", "-vf", `scale=${width}:-1`, dst]);
  }
  return dst;
}
async function thumbBuffer(name) { try { return readFileSync(await makeThumb(name, 480)); } catch { return null; } }

// ---------- API: videolar
app.get("/api/videos", (_req, res) => res.json(listVideos()));
app.get("/api/thumb/:name", async (req, res) => { const name = path.basename(req.params.name); if (!existsSync(path.join(OUT, name))) return res.status(404).end(); const dst = await makeThumb(name, 480); if (!existsSync(dst)) return res.status(404).end(); res.sendFile(dst); });
// Sil: önce yüklendiği platformlardan (publish.py --delete-remote), sonra Mac'teki dosyalar. ?local=1 yalnız yerel siler.
app.delete("/api/videos/:name", async (req, res) => { const name = path.basename(req.params.name);
  let remote = {};
  if (req.query.local !== "1") {
    const m = readJson(path.join(DATA, "metrics.json"), { videos: {} }).videos?.[name] || {};
    if (m.youtube?.id || m.instagram?.id || m.tiktok?.publish_id || m.tiktok?.id) {
      push(`🗑 ${name}: platformlardan siliniyor`);
      const r = await py("publish.py", ["--delete-remote", name]);
      remote = r.json?.results || {};
      for (const [p, v] of Object.entries(remote)) push(`🗑 ${p}: ${v.message}${!v.ok && v.url ? ` → ${v.url}` : ""}`);
      if (!r.json) push(`🗑 platformlardan silme hatası: ${(r.stderr || r.stdout || "").slice(-200)}`);
    }
  }
  for (const f of [name, name.replace(/\.mp4$/, ".json"), ...["-kapak.jpg", "-kapakA.jpg", "-kapakB.jpg", "-kapakYT.jpg"].map((x) => name.replace(/\.mp4$/, x))]) { const p = path.join(OUT, f); if (existsSync(p)) unlinkSync(p); } const t = path.join(THUMBS, name.replace(/\.mp4$/, ".jpg")); if (existsSync(t)) unlinkSync(t);
  push(`🗑 ${name}: Mac'ten silindi`); py("analyze.py").catch(() => {}); res.json({ ok: true, remote }); });
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
    else await ensureScheduleLoaded("panel açılışında fark edildi");
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
    const ping = await new Promise((res) => { execFile(cb, ["-p", ...claudeModelArgs(settings()), "--effort", "low", "--output-format", "json", ...CLAUDE_LEAN], { cwd: claudeCwd(), env: claudeEnv(cb), timeout: 90000 }, (e, out, err) => { let j = null; try { j = JSON.parse(out); } catch { /* json değil */ } res(!e && j && !j.is_error ? { ok: true } : { ok: false, msg: `${j?.result || ""} ${err || ""} ${e?.message || ""}` }); }).stdin.end("Sadece TAMAM yaz."); });
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
  add(conn.youtube?.connected ? (conn.youtube.playlists === false ? "warn" : true) : "warn", "YouTube", conn.youtube?.connected ? (conn.youtube.playlists === false ? "bağlı; oynatma listeleri için YouTube'u bir kez yeniden bağlayın (Ayarlar → Yayın hesapları)" : "bağlı") : "bağlı değil (Ayarlar → Yayın hesapları)");
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
    patchSettings({ autoMode: true, autopublish: { youtube: connected.includes("youtube"), instagram: connected.includes("instagram"), tiktok: connected.includes("tiktok") }, whatsapp: { requireApproval: false, notifyStages: true, notifyOnVideo: true }, scheduleHours: hours });
    push(`⚡ tam otomatik mod: her ${hours} saatte üretim, otomatik yayın → ${connected.join(", ") || "bağlı hesap yok"}, onay kapalı`);
    return { ok: true, connected, hours };
  }
  await setSchedule(false, 5);
  patchSettings({ autoMode: false, autopublish: { youtube: false, instagram: false, tiktok: false }, whatsapp: { requireApproval: true } });
  push("⏹ otomatik mod kapatıldı: üretim ve otomatik yayın durdu");
  return { ok: true, connected };
}
app.post("/api/automode", async (req, res) => res.json(await setAutoMode(req.body?.enabled !== false)));
app.get("/api/schedule", async (_req, res) => res.json(await getSchedule()));
// Otomatik üretim anahtarı: açıkken videolar bağlı TÜM hesaplara onaysız yayınlanır (kullanıcı isteği), kapanınca eski hâl
// En iyi yayın saati önerisini uygula (analyze.best_hours → insights.bestHours.suggestion.offset) ya da sıfırla
app.post("/api/schedule/offset", async (req, res) => {
  const off = Math.max(-12, Math.min(12, Math.round(Number(req.body?.offset) || 0)));
  const total = ((Number(settings().scheduleOffset) || 0) + (req.body?.reset ? -(Number(settings().scheduleOffset) || 0) : off));
  patchSettings({ scheduleOffset: ((total % 24) + 24) % 24 > 12 ? ((total % 24) + 24) % 24 - 24 : ((total % 24) + 24) % 24 });
  const sch = await getSchedule();
  const r = sch.enabled ? await setSchedule(true, sch.hours || 5) : { ok: true, slots: slotsFor(sch.hours || Number(settings().scheduleHours) || 5) };
  push(`🕐 yayın saatleri ${req.body?.reset ? "varsayılana döndü" : "en iyi saate göre kaydırıldı"}: ${(r.slots || []).map((h) => String(h).padStart(2, "0") + ":00").join(", ")}`);
  res.json({ ...r, offset: settings().scheduleOffset });
});
app.post("/api/schedule", async (req, res) => {
  const on = !!req.body.enabled; const r = await setSchedule(on, Number(req.body.hours) || 5);
  if (r.ok) { patchSettings({ autoMode: on }); push(on ? "🤖 otomatik üretim açık: videolar bağlı tüm hesaplara onaysız yayınlanacak" : "⏸ otomatik üretim kapalı"); }
  res.json(r);
});
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
// Bağla / yeniden bağla: token geçerli olsa da Google onayı yeniden açılır (yeni kapsamlar için); en çok 10 dk bekler
app.post("/api/connect/youtube", async (_req, res) => { push("▶ YouTube: tarayıcıda Google onayı açılıyor (yeniden bağlama)"); const r = await py("publish.py", ["--connect", "youtube"]); const j = r.json || { ok: false, error: (r.stderr || r.stdout).slice(-400) }; push(`${j.ok ? "✔" : "✖"} YouTube: ${j.message || j.error}`); res.json(j);
  // yeni izinlerle abone geçmişini hemen çek (6 saatlik beklemeyi atla): grafik eksik günleri hemen dolsun
  if (j.ok) py("followers.py", ["--sync", "--backfill"]).then((r) => { const e = r.json?.historyErrors?.youtube; push(e ? `👥 YouTube abone geçmişi alınamadı: ${e}` : "👥 YouTube abone geçmişi çekildi; Analitik grafiği güncellendi"); }).catch(() => {}); });
// YouTube özel kapakları: kanal doğrulanınca (youtube.com/verify) reddedilmiş kapakları yeniden yükle
async function ytThumbs() {
  push("▶ YouTube: kapağı eksik/reddedilmiş videolara kapak yükleniyor");
  const r = await py("publish.py", ["--yt-thumbs"]);
  const j = r.json || { ok: false, error: (r.stderr || r.stdout || "").slice(-300) };
  push(j.ok ? `▶ YouTube kapakları: ${j.done} video güncellendi${j.left ? `, ${j.left} kaldı` : ""}` : `▶ YouTube kapakları yüklenemedi: ${j.error}`);
  return j;
}
app.post("/api/youtube/thumbs", async (_req, res) => res.json(await ytThumbs()));
app.post("/api/disconnect/youtube", async (_req, res) => { const r = await py("publish.py", ["--disconnect", "youtube"]); push("YouTube bağlantısı kesildi"); res.json(r.json || { ok: false, error: (r.stderr || r.stdout).slice(-400) }); });
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
// TikTok/Meta formları için Web sitesi + Kullanım Şartları + Gizlilik sayfaları (public_html/uygulama/)
app.post("/api/hostinger/legal", async (_req, res) => { const r = await runPy(["scripts/hostinger.py", "--legal"], 90000); let j = null; try { j = JSON.parse(String(r.stdout || "").trim().split("\n").pop()); } catch { /* düz metin */ } push(j?.ok ? `🌐 Uygulama sayfaları yüklendi: ${j.site}` : `🌐 Uygulama sayfaları yüklenemedi: ${(r.stderr || r.stdout || "").slice(-200)}`); res.json(j || { ok: false, error: (r.stderr || r.stdout || "").slice(-300) }); });
app.post("/api/hostinger/setup", async (_req, res) => { push("🌐 Hostinger köprüsü kuruluyor"); const r = await runPy(["scripts/hostinger.py", "--setup"], 120000); const lines = (r.stdout + r.stderr).trim().split("\n"); for (const l of lines.slice(-8)) push("  " + l); let j = {}; try { j = JSON.parse(lines.filter((l) => l.startsWith("{")).pop() || "{}"); } catch { /* yok */ } res.json({ ok: !!j.ok, ...j, log: lines.slice(-8).join("\n") }); });
// TikTok uygulama anahtarları panelden secrets/.env'e yazılır (Client key / secret, mod)
app.post("/api/tiktok/keys", (req, res) => {
  const { key, secret, mode } = req.body || {};
  if (key) { if (!/^[A-Za-z0-9]{8,64}$/.test(String(key).trim())) return res.json({ ok: false, error: "Client key biçimi hatalı (harf ve rakam)." }); writeEnvKey("TIKTOK_CLIENT_KEY", String(key).trim()); }
  if (secret) { if (!/^[A-Za-z0-9_-]{8,128}$/.test(String(secret).trim())) return res.json({ ok: false, error: "Client secret biçimi hatalı." }); writeEnvKey("TIKTOK_CLIENT_SECRET", String(secret).trim()); }
  if (mode && ["inbox", "direct"].includes(mode)) writeEnvKey("TIKTOK_MODE", mode);
  push("♪ TikTok uygulama ayarları kaydedildi"); res.json({ ok: true });
});
app.post("/api/instagram/diagnose", async (_req, res) => { push("🩺 Instagram sınanıyor"); const r = await py("publish.py", ["--ig-diagnose"]); const j = r.json || { ok: false, steps: [{ step: "sınama", ok: false, detail: (r.stderr || r.stdout || "").slice(-300) }] }; for (const st of j.steps) push(`🩺 ${st.ok ? "✅" : "❌"} ${st.step}: ${st.detail}`); res.json(j); });
app.post("/api/tiktok/check", async (_req, res) => { const r = await py("publish.py", ["--tt-check"]); const j = r.json || { ok: false, error: (r.stderr || r.stdout).slice(-300) }; for (const it of j.items || []) push(`♪ TikTok ${it.video}: ${it.text}`); if (!j.ok) push(`♪ TikTok durumu sorgulanamadı: ${j.error}`); res.json(j); });
app.post("/api/disconnect/tiktok", async (_req, res) => { const r = await py("publish.py", ["--disconnect", "tiktok"]); push("♪ TikTok bağlantısı kesildi"); res.json(r.json || { ok: false, error: (r.stderr || r.stdout).slice(-400) }); });
app.post("/api/connect/tiktok", async (_req, res) => {
  // gönderilen geri dönüş adresi hemen loga düşsün (TikTok "redirect_uri" derse Login Kit'tekiyle karşılaştırılır)
  try { const st = await py("publish.py", ["--status"]); if (st.json?.tiktok?.redirect) push(`♪ TikTok: gönderilen Redirect URI → ${st.json.tiktok.redirect} (Sandbox → Login Kit → Web'de AYNEN bu olmalı)`); } catch { /* yok */ }
  const r = await py("publish.py", ["--connect", "tiktok"]); const j = r.json || { ok: false, error: (r.stderr || r.stdout).slice(-400) };
  push(`${j.ok ? "✔" : "✖"} TikTok: ${j.ok ? "bağlandı" : j.error}`); res.json(j); });
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
async function handleCommand(text, opts = {}) {
  text = String(text || ""); const cmd = parseCommand(text); const videos = listVideos();
  let reply = cmd.reply, action = cmd.action, payload = {}, extra = {};
  if (igCleanupPending && /(iptal|vazgeç|boş ver|silme)/.test(text.toLocaleLowerCase("tr-TR")) && cmd.action !== "ig_cleanup") { igCleanupPending = null; push("🗑 Instagram temizliği iptal edildi"); }
  switch (cmd.action) {
    case "ig_cleanup": {
      const r = await igCleanupPlan({ days: cmd.days, max: cmd.max, minAgeH: cmd.minAgeH });
      reply = r.text; break;
    }
    case "ig_cleanup_confirm": {
      const r = await igCleanupRun({ notify: opts.source !== "whatsapp" });
      reply = r.text || r.error; break;
    }
    case "stopall": { stageMute = Date.now(); const r = await restStart({ reason: "elle durduruldu" }); reply = `Sistemi durdurdum. ${r.pipeline ? "Süren üretim kapatıldı. " : ""}Bilgisayar ısınmasın diye tüm modeller kapatıldı. ${r.rest.until ? `Sıradaki planlı iş saat ${hhmm(r.rest.until)}; o zamana kadar` : "Siz talimat verene kadar"} hiçbir şey başlamayacak.`; break; }
    case "rest_end": { stageMute = Date.now(); reply = restEnd("elle başlatıldı") ? "Sistem yeniden çalışıyor. Son dakika ve Mynet takibi devam ediyor." : "Sistem zaten çalışıyor."; break; }
    case "anlik": {
      const r = await prepareAnlik(cmd.topic, cmd.duration, cmd.publishAt ? { publishAt: cmd.publishAt } : {});
      const what = r.title ? `"${r.title.slice(0, 90)}" (${r.source}${r.count > 1 ? `, ${r.count} haberde geçiyor` : ""})` : String(cmd.topic).slice(0, 60);
      const when = cmd.publishAt ? whenLabel(new Date(cmd.publishAt)) : "";
      reply = !r.ok ? r.error : `${r.viaLink ? "Haberi okudum" : r.found ? "Haberi buldum" : "Sitelerde bulamadım, yazdığınız bilgiyle üretiyorum"}: ${what}. ${r.queued ? `Son dakika videosu ${r.position}. sıraya alındı; süren üretim bitince başlayacak.` : when ? "Video şimdi hazırlanıyor;" : "Son dakika videosu üretiliyor; fotoğraf ve videolar haber sayfalarından alınacak, bitince yayınlayıp haber vereceğim."}${when ? ` ⏰ ${when}'de yayınlanacak (iptal için: planlı yayını iptal et).` : ""}`;
      if (!r.ok) action = "none"; break;
    }
    case "generate": { const r = startPipeline(cmd.duration); reply = r.ok ? `${r.duration} saniyelik gündem videosu üretiliyor. Bitince haber vereceğim.` : r.error; if (!r.ok) action = "none"; break; }
    case "play_latest": if (!videos.length) { reply = "Henüz üretilmiş video yok."; action = "none"; } else { payload = { name: videos[0].name }; reply = `Son video açılıyor: ${label(videos[0])}.`; } break;
    case "status": reply = await statusText(); break;
    case "selftest": { const r = await selfTest({ quiet: true }); reply = r.summary; break; }
    case "share": if (!videos.length) { reply = "Paylaşacak video yok."; action = "none"; } else { payload = { name: videos[0].name }; reply = "Paylaşım paneli açıldı. Telefonunuzla QR kodu okutun."; } break;
    case "reveal": if (videos[0] && isMac) { await run("open", ["-R", path.join(OUT, videos[0].name)]); reply = "Finder'da gösteriliyor."; } else { reply = "Gösterilecek video yok."; action = "none"; } break;
    case "schedule_on": case "schedule_off": { const r = await setSchedule(cmd.action === "schedule_on", cmd.hours || 5); reply = r.ok ? (cmd.action === "schedule_on" ? `Otomatik üretim açıldı, her ${cmd.hours || 5} saatte bir.` : "Otomatik üretim kapatıldı.") : `Zamanlayıcı ayarlanamadı: ${r.error}`; break; }
    case "remake": {
      const vids = listVideos().filter((v) => !/^demo/.test(v.name));
      const pick = cmd.which === "top" ? [...vids].sort((a, b) => (b.views || 0) - (a.views || 0))[0] : vids[0];
      if (!pick) { reply = "Yeniden yayınlanacak video yok."; action = "none"; break; }
      const r = await remakeVideo(pick.name);
      reply = r.ok ? `${cmd.which === "top" ? "En çok izlenen" : "Son"} video (${r.title.slice(0, 70)}${pick.views ? `, ${pick.views} izlenme` : ""}) farklı senaryo ve görsellerle yeniden üretiliyor; bitince yayınlayacağım.` : r.error;
      if (!r.ok) action = "none"; break;
    }
    case "info": {
      const fn = { quake: quakeCheck, match: matchCheck, market: marketRun, calendar: calendarRun, weather: weatherCheck, alarm: marketAlarm, weeklyTop: weeklyTopRun }[cmd.kind];
      const r = await fn({ manual: true });
      if (cmd.kind === "weather") { reply = r.warnings?.length ? `${r.warnings.map((g) => g.title).join(", ")}: uyarı videosu hazırlanıyor.` : `Şu an yeni turuncu ya da kırmızı kod uyarısı yok.${r.errors?.length ? ` Uyarı: ${r.errors.join(" · ")}` : ""}`; break; }
      if (cmd.kind === "alarm") { reply = r.jobs?.length ? "Fiyat değişimi/rekor var, video hazırlanıyor." : "Akaryakıtta fiyat değişimi ya da dolar/altında yeni rekor yok."; break; }
      if (cmd.kind === "weeklyTop") { reply = r.ok ? `Haftanın en çok izlenenleri derleniyor: ${(r.top || []).map((x, i) => `${i + 1}. ${x.title.slice(0, 40)}`).join(", ")}.` : r.error; break; }
      if (cmd.kind === "quake") reply = r.events?.length ? `${r.events.map((e) => e.title).join(", ")}: deprem videosu hazırlanıyor.` : `Yeni büyük deprem yok (en az ${quakeCfg().minMag}).${r.errors?.length ? ` Uyarı: ${r.errors.join(" · ")}` : ""}`;
      else if (cmd.kind === "match") reply = r.matches?.length ? `${r.matches.map((m) => m.title).join(", ")}: skor videosu hazırlanıyor.` : "Takip ettiğimiz takımlardan yeni biten maç yok.";
      else reply = r.ok ? (cmd.kind === "market" ? "Piyasa videosu hazırlanıyor: dolar, euro, altın ve akaryakıt." : `Yarının hatırlatması hazırlanıyor: ${(r.events || []).map((e) => e.title).join(", ")}.`) : r.error;
      break;
    }
    case "peak": {
      if (cmd.run) { const r = await peakRemake({ manual: true }); reply = r.ok ? `Günün en çok izlenen haberi (${r.title.slice(0, 70)}, ${r.views} izlenme) farklı senaryo ve görsellerle yeniden üretiliyor; bitince yayınlayacağım.` : r.error; break; }
      if (cmd.on != null) { patchSettings({ peakRemake: { enabled: cmd.on } }); }
      const p = await peakHours(true), c = peakCfg(), td = peakToday();
      const hrs = (p.hours || []).map((h) => `${String(h).padStart(2, "0")}:00`).join(", ");
      reply = `En çok izlenen saatlerde tekrar ${c.enabled ? "açık" : "kapalı"}. Saatler (${p.source || "hesaplanıyor"}): ${hrs || "henüz yok"}.` + (td.length ? ` Bugün: ${td.map((d) => `${d.hour == null ? "elle" : String(d.hour).padStart(2, "0") + ":00"} ${d.name ? `"${(d.title || "").slice(0, 40)}"` : `atlandı (${d.reason || "bekliyor"})`}`).join("; ")}.` : "");
      break;
    }
    case "yt_thumbs": { const r = await ytThumbs(); reply = r.ok ? `YouTube kapakları güncellendi: ${r.done} video.` : `Kapaklar yüklenemedi: ${r.error}`; break; }
    case "queue": { const r = await logQueues({ all: true }); reply = r.lines?.length ? r.lines.map((l) => l.replace(/^📤 /, "")).join("\n") : "Sıra bilgisi alınamadı."; break; }
    case "followers": { const r = await pyJson(["scripts/followers.py", ...(Date.now() - followersSyncAt > 30 * 60000 ? ["--sync"] : [])]); if (r?.lastSync) followersSyncAt = Date.now(); reply = r?.text || "Abone bilgisi alınamadı."; break; }
    case "expire": {
      if (cmd.restore) { const r = await expireRestore("all"); reply = r.ok ? (r.done?.length ? `${r.done.length} video yeniden herkese açık yapıldı.` : "Liste dışı yaptığım video yok.") : r.error; break; }
      const r = await expireCheck({ manual: true });
      reply = !r.ok ? r.error : r.done?.length ? `${r.done.length} süresi geçen video YouTube'da liste dışı yapıldı: ${r.done.map((x) => x.title.slice(0, 40)).join(", ")}.` : "Süresi geçen video yok.";
      break;
    }
    case "ig_stories": {
      if (cmd.toggle !== undefined) { patchSettings({ igStories: { enabled: cmd.toggle } }); reply = cmd.toggle ? `Her akşam ${storiesCfg().hour}:${String(storiesCfg().minute).padStart(2, "0")}'de günün en çok izlenenlerini Instagram hikâyesine atacağım.` : "Instagram hikâyesi otomatik paylaşımı kapatıldı."; break; }
      const r = await storiesRun({ manual: true, force: true, notify: opts.source !== "whatsapp" });
      reply = r.ok ? (r.text || "Hikâyeler paylaşıldı.") : `Hikâye paylaşılamadı: ${r.error}`;
      break;
    }
    case "scheduled": { reply = await scheduledCommand(cmd); break; }
    case "social_video": {
      if (waVideoCfg().enabled === false) { reply = "Videodan haber yapma kapalı (Ayarlar → 📡 Otomatik içerikler)."; break; }
      socialVideoNews({ url: cmd.url, instruction: cmd.instruction, publishAt: cmd.publishAt }).catch((e) => push(`🔗 paylaşımdan haber hatası: ${e.message}`));
      reply = "🔗 Paylaşımı indiriyorum; inceleyip kurgusunu çıkaracağım. Her adımda haber vereceğim." + (cmd.publishAt ? ` ⏰ Video ${whenLabel(new Date(cmd.publishAt))}'de yayınlanacak.` : "");
      break;
    }
    case "comments_reply": { const r = await replyCheck({ manual: true }); reply = r.ok ? (r.replied ? `${r.replied} yoruma yanıt verdim.` : "Yanıt bekleyen yeni yorum yok.") : r.error; break; }
    case "comments_digest": { const r = await commentsDigest({ manual: true }); reply = r.ok ? (r.count ? `${r.count} yeni yorumu özetledim, WhatsApp'a gönderdim.` : "Yeni yorum yok.") : r.error; extra = { text: r.text }; break; }
    case "weekly_summary": { const r = startWeekly({ manual: true }); reply = r.ok ? "Haftanın özeti videosu üretiliyor. Yatay, yaklaşık beş dakikalık; bitince YouTube'a yüklenecek." : r.error; break; }
    case "daily_summary": { const r = startDaily({ manual: true }); reply = r.ok ? "Günün özeti videosu üretiliyor. Yatay, yaklaşık dört dakikalık; bitince YouTube'a yüklenecek." : r.error; break; }
    case "weekly_report": { const r = await weeklyReport({ send: true }); reply = r.ok ? r.summary : `Haftalık rapor hazırlanamadı: ${r.error}`; break; }
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
// ---------- Emixhas'ın sesi: üretilen ses diske önbelleklenir (aynı cümle + aynı ses ayarı = anında çalar)
const SPEAK_CACHE = path.join(WORK, "speak-cache");
// PRON_VER: scripts/voices.py okunuş kuralları (PRONOUNCE, parti adları) değişince artır; eski okunuşlu önbellek kullanılmasın
const PRON_VER = 4;
const speakKey = (text) => createHash("sha1").update(JSON.stringify([text, settings().voice || {}, PRON_VER, settings().pronunciations || {}])).digest("hex");
const speakInflight = new Map();
function synthSpeech(text, { low = false } = {}) {
  text = String(text || "").replace(/\s+/g, " ").trim().slice(0, 500);
  if (!text) return Promise.resolve(null);
  const file = path.join(SPEAK_CACHE, speakKey(text) + ".wav");
  if (existsSync(file)) return Promise.resolve(file);
  if (speakInflight.has(file)) return speakInflight.get(file); // aynı cümle zaten üretiliyorsa onu bekle
  const job = new Promise((resolve) => {
    // arka plan ısınması için düşük öncelik (nice): kullanıcının işini yavaşlatmaz, fanı az çalıştırır
    const child = low && isMac ? spawn("nice", ["-n", "15", PY, "scripts/speak.py"], { cwd: ROOT, env: ENV }) : spawn(PY, ["scripts/speak.py"], { cwd: ROOT, env: ENV }); const chunks = [];
    child.stdout.on("data", (c) => chunks.push(c));
    child.on("error", () => resolve(null));
    child.on("close", (code) => {
      speakInflight.delete(file);
      if (code !== 0 || !chunks.length) return resolve(null);
      try {
        mkdirSync(SPEAK_CACHE, { recursive: true }); writeFileSync(file, Buffer.concat(chunks));
        // önbellek en çok 400 dosya: en eskiler silinir
        const all = readdirSync(SPEAK_CACHE).map((f) => ({ f, t: statSync(path.join(SPEAK_CACHE, f)).mtimeMs })).sort((x, y) => y.t - x.t);
        for (const o of all.slice(400)) { try { unlinkSync(path.join(SPEAK_CACHE, o.f)); } catch { /* yok */ } }
      } catch { /* yazılamadı */ }
      resolve(file);
    });
    child.stdin.end(text);
  });
  speakInflight.set(file, job);
  return job;
}
app.post("/api/speak", async (req, res) => { const f = await synthSpeech(req.body?.text); if (!f || !existsSync(f)) return res.status(204).end(); res.setHeader("Content-Type", "audio/wav"); res.sendFile(f); });
// Kapağı eksik eski videolar için panel açıldıktan 90 sn sonra arka planda bir kez kapak üretilir
setTimeout(() => { if (pipelineBusy() || resting()) return; const c = spawn(PY, ["scripts/render_thumbs.py", "--missing"], { cwd: ROOT, env: ENV }); c.stdout.on("data", (b) => b.toString().split("\n").filter(Boolean).forEach((l) => { if (!/kapak eksik video yok/.test(l)) push("🖼 " + l); })); }, 90000);
// ---------- Aşamaların sesli bildirimi: log satırı → kısa Türkçe cümle
// Panel açıksa sayfa sırayla okur (SSE "stage"); panel kapalıysa Mac hoparlöründen çalar (gece sessiz saatleri hariç).
// Cümleler sabittir; panel açılışında önbelleğe hazırlanır, anında çalar.
const STAGE_VOICE = [
  [/^⚡ ANLIK HABER/, "Son dakika videosu üretimi başladı."],
  [/^== .*üretim başladı/, "Video üretimi başladı."],
  [/^-- 1\/4 haberler/, "Haberler toplanıyor."],
  [/^-- 2\/4 senaryo/, "Senaryo yazılıyor."],
  [/^senaryo hazır/, "Senaryo hazırlandı."],
  [/^-- 3\/4 seslendirme/, "Seslendirmeye başlandı."],
  [/^\[[^\]]+\] \d+ segment/, "Seslendirme tamamlandı."],
  [/^-- görseller/, "Haber fotoğrafları ve videoları alınıyor."],
  [/^-- 4\/4 render/, "Video oluşturuluyor."],
  [/^== bitti/, "Video hazır."],
  [/^kapaklar hazır/, "Kapaklar hazırlandı."],
  [/^🌐 Hostinger: yüklendi/, "Video Hostinger'a eklendi."],
  [/^📤 youtube: (tamam|zaten)/, "YouTube'da paylaşıldı."],
  [/^📤 instagram: (tamam|zaten)/, "Instagram'da paylaşıldı."],
  [/^📤 tiktok: (tamam|zaten)/, "TikTok'a gönderildi."],
  [/^📤 youtube: sınır doldu/, "YouTube günlük yükleme sınırı doldu. Video sıraya alındı, sınır açılınca otomatik yüklenecek."],
  [/^📤 youtube: hata/, "YouTube'a yüklenemedi."],
  [/^⭐ değerli haber/, "Değerli haber, YouTube'a da yükleniyor."],
  [/^📤 instagram: hata/, "Instagram'a yüklenemedi."],
  [/^📤 tiktok: sınır doldu/, "TikTok gelen kutusunda paylaşılmamış taslak birikti. Telefondan taslakları paylaşın ya da silin."],
  [/^📤 tiktok: hata/, "TikTok'a yüklenemedi."],
  [/^📤 tekrar denenecek/, "Yüklenemeyen platform birazdan tekrar denenecek."],
  [/^📤 otomatik yayın yapılmadı/, "Otomatik yayın yapılmadı, ayrıntı logda."],
  [/^💬 WhatsApp'a gönderildi/, "Video WhatsApp'tan gönderildi."],
  [/^✖ üretim hata/, "Üretim hata ile bitti."],
  [/^⚠️ sağlık: (?!Video üretimi)/, "Dikkat, bir sistem uyarısı var. Ayrıntıyı WhatsApp'a gönderdim."],
  [/^🔊 ses modeli sorunsuz başlatıldı/, "Ses modeli sorunsuz başlatıldı."],
  [/^📰 Mynet: yeni manşet/, "Mynet manşetine yeni bir haber girdi, video hazırlanıyor."],
  [/^(🧹 |⏹ hepsi durduruldu)/, "Modeller sorunsuz durduruldu. Bilgisayarınız ısınmasın diye kapatıldı."],
  [/^🔥 VİRAL/, "Bir video viral oluyor. Ayrıntıyı WhatsApp'a gönderdim."],
  [/^⏸ SİSTEM DURDURULDU/, "Sistem durduruldu. Bilgisayarınız ısınmasın diye tüm modeller kapatıldı. Bir sonraki planlı üretime ya da sizin talimatınıza kadar hiçbir şey başlamayacak."],
  [/^▶ SİSTEM YENİDEN ÇALIŞIYOR/, "Sistem yeniden çalışıyor."],
];
const STAGE_PHRASES = [...new Set(STAGE_VOICE.map(([, t]) => t))];
let lastStage = { text: "", at: 0 }, macQueue = Promise.resolve();
let stageMute = 0; // komut yanıtı aynı şeyi zaten söylüyorsa (sistemi durdur/başlat) aşama cümlesi 3 sn susar
function stageVoice(line) {
  if (Date.now() - stageMute < 3000 && /^(⏸|▶ SİSTEM)/.test(String(line))) return;
  const cfg = settings().stageVoice || {};
  if (cfg.enabled === false) return;
  const hit = STAGE_VOICE.find(([re]) => re.test(String(line)));
  if (!hit) return;
  const text = hit[1];
  if (text === lastStage.text && Date.now() - lastStage.at < 8000) return; // aynı cümle art arda söylenmez
  if (text === "Video üretimi başladı." && lastStage.text.startsWith("Son dakika") && Date.now() - lastStage.at < 30000) return;
  lastStage = { text, at: Date.now() };
  if (clients.size) { for (const r of clients) r.write(`event: stage\ndata: ${JSON.stringify({ text })}\n\n`); return; }
  if (!isMac || cfg.macSpeaker === false) return;
  const h = new Date().getHours(), qf = Number(cfg.quietFrom ?? 23), qt = Number(cfg.quietTo ?? 8);
  if (qf > qt ? h >= qf || h < qt : h >= qf && h < qt) return; // gece sessiz saatleri
  macQueue = macQueue.then(async () => { const f = await synthSpeech(text); if (f) await run("afplay", [f]); }).catch(() => {});
}
// Sık söylenen kısa cümleler panel açılınca arka planda bir kez hazırlanır (ses ayarı değişince yeniden)
const QUICK_PHRASES = ["Bir saniye, bakıyorum.", "Hemen bakıyorum.", "Tamam.", "Buyur.", "Son dakika videosu üretiliyor.", ...STAGE_PHRASES];
setTimeout(async () => { for (const t of QUICK_PHRASES) { if (pipelineBusy() || resting()) break; await synthSpeech(t, { low: true }); } }, 20000);

// ---------- sağlık uyarıları: üretim hatası, kaçan üretim, disk, yayın bağlantısının süresi → WhatsApp + sesli
// Her uyarı anahtarıyla data/health_alerts.json'a yazılır, aynı uyarı `everyH` saat dolmadan tekrar gönderilmez.
const HEALTH_FILE = path.join(DATA, "health_alerts.json");
async function healthAlert(key, text, { everyH = 12, whatsapp = true } = {}) {
  const seen = readJson(HEALTH_FILE, {});
  if (seen[key] && Date.now() - seen[key] < everyH * 3600000) return false;
  seen[key] = Date.now(); writeJson(HEALTH_FILE, seen);
  push(`⚠️ sağlık: ${text}`);
  if (whatsapp && settings().health?.whatsapp !== false) { try { await wa.send(`⚠️ *Emixhas sağlık uyarısı*\n${text}`); } catch { /* WhatsApp bağlı değil: log + ses yeter */ } }
  return true;
}
const healthClear = (key) => { const seen = readJson(HEALTH_FILE, {}); if (seen[key]) { delete seen[key]; writeJson(HEALTH_FILE, seen); } };
function productionFailed(line) {
  // hatanın nedeni: son satırlardaki HATA / ! satırları
  const why = state.log.slice(-40).filter((l) => /^(HATA|  ! |!! |Error|Traceback)|hata verdi|bulunamadı/.test(l)).slice(-3).join("\n");
  healthAlert(`fail-${Math.floor(Date.now() / 600000)}`, `Video üretimi hata ile bitti.\n${why || line}\nPanel logunda ayrıntı var; sorun sürerse "sistem kontrolü" yazın.`, { everyH: 0.15 });
}
// Otomatik yayın olmadıysa nedeni (hangi platform, asıl hata) WhatsApp'a gider; sessizce yayınlanmamış video kalmasın
function publishFailed(line) {
  const none = /yapılmadı/.test(line); // hiç hedef yok (ayar): 12 saatte bir hatırlatılır, hata ise her seferinde
  const errs = none ? [] : state.log.slice(-60).filter((l) => /^📤 \w+: (hata|hesap bağlı değil)/.test(l)).slice(-3);
  const last = readJson(path.join(DATA, "publish_last_error.json"), {});
  const ig = !none && /instagram/.test(line + errs.join(" ")) && last.instagram ? `\nInstagram son hata: ${String(last.instagram.error).slice(0, 400)}` : "";
  const what = none ? "Video otomatik yayınlanmadı." : "Video otomatik yayınlanamadı.";
  healthAlert(none ? "pub-none" : `pub-${Math.floor(Date.now() / 600000)}`, `${what}\n${line.replace(/^📤 /, "")}${errs.length ? "\n" + errs.join("\n") : ""}${ig}\nPanelden videoyu açıp tekrar yükleyebilir ya da Ayarlar → Instagram → "🩺 Instagram'ı sına" ile nedeni görebilirsiniz.`, { everyH: none ? 12 : 0.15, whatsapp: !(waDigest() && digestPending) }); // tek mesaj modunda hata özete girer
}
async function healthCheck() {
  const s = settings();
  try { if ((await getSchedule()).enabled) await ensureScheduleLoaded("10 dakikalık kontrol"); } catch { /* yok */ }
  if (s.health?.enabled === false) return;
  // 1) kaçan üretim: zamanlayıcı açık, son videodan beri aralık + 40 dk geçti, üretim de sürmüyor
  try {
    const sch = await getSchedule();
    const regular = listVideos().filter((v) => { const m = readJson(path.join(OUT, v.name.replace(/\.mp4$/, ".json")), {}); return !(m.anlik || m.format === "anlik" || m.format === "gunluk" || m.format === "haftalik"); });
    // zamanlayıcı yeni açıldıysa ondan önceki boşluk sayılmaz
    const last = Math.max(regular[0] ? statSync(path.join(OUT, regular[0].name)).mtimeMs : 0, Number(readSched().loadedAt) || 0) || null;
    const gap = (Number(sch.hours) || 5) * 3600000 + 40 * 60000;
    if (sch.enabled && !state.running && last && Date.now() - last > gap) {
      // neden: launchd işi yüklü mü, son çıkış kodu, kilit, son log satırları; yüklü değilse yeniden yüklenir
      const diag = [];
      const lc = spawnSync("launchctl", ["list", "com.gundem.video"], { encoding: "utf8" });
      if (lc.status !== 0) { const r = await ensureScheduleLoaded("kaçan üretim kontrolü"); diag.push(`zamanlayıcı launchd'de yüklü değildi → ${r?.ok ? "yeniden yüklendi" : "YÜKLENEMEDİ"}`); }
      else { const ex = (lc.stdout.match(/"LastExitStatus"\s*=\s*(-?\d+)/) || [])[1]; if (ex && ex !== "0") diag.push(exitText(ex)); }
      const lockPid = path.join(WORK, "pipeline.lock", "pid");
      if (existsSync(lockPid)) diag.push("üretim kilidi duruyor (takılmış üretim olabilir; bekçi 50 dk'da temizler)");
      // "69 haber, 0 hata" gibi başarı satırları hata sayılmaz; launchd işi hiç başlatamadıysa (78) eski log anlamsız
      if (!diag.some((d) => /başlatamadı/.test(d))) try { const tail = readFileSync(LAUNCHD_LOG, "utf8").trim().split("\n").filter((l) => /HATA|✖|!! |hata/.test(l) && !/(^|\D)0 hata/.test(l)).slice(-2); if (tail.length) diag.push("son hata: " + tail.join(" | ").slice(0, 240)); } catch { /* log yok */ }
      const catchUp = !pipelineBusy() && s.health?.autoCatchUp !== false;
      const sent = await healthAlert("missed", `Zamanlanmış üretim gecikti: son düzenli video ${Math.round((Date.now() - last) / 3600000)} saat önce.${diag.length ? "\nNeden: " + diag.join("; ") : "\nMac uykuda kalmış olabilir (kapak kapalı/pilde)."}${catchUp ? "\nKaçan üretimi şimdi kendim başlattım." : ""}`, { everyH: 5 });
      if (sent && catchUp) { if (resting()) restEnd("kaçan zamanlanmış üretim telafi ediliyor"); const r = startPipeline("format"); push(r.ok ? "⏰ kaçan zamanlanmış üretim telafi ediliyor" : `⏰ telafi üretimi başlatılamadı: ${r.error}`); }
    } else healthClear("missed");
  } catch { /* zamanlayıcı okunamadı */ }
  // 2) disk
  try {
    const st = statfsSync(OUT); const freeGb = (st.bavail * st.bsize) / 1e9;
    if (freeGb < (s.health?.minFreeGb ?? 5)) healthAlert("disk", `Disk dolmak üzere: ${freeGb.toFixed(1)} GB boş. Eski videoları panelden silin; disk dolarsa üretim durur.`, { everyH: 12 });
  } catch { /* statfs yok */ }
  // 3) yayın bağlantıları: Instagram token süresi, YouTube/TikTok bağlantısı koptu mu
  try {
    const conn = await brain.connections();
    const dl = conn.instagram?.daysLeft;
    if (conn.instagram?.connected && dl != null && dl <= 7) healthAlert("ig-token", `Instagram bağlantısının süresi ${dl} gün içinde doluyor. Ayarlar → Yayın hesapları → Instagram'ı yeniden bağlayın.`, { everyH: 24 });
    const was = readJson(path.join(DATA, "health_conn.json"), {});
    for (const p of ["youtube", "instagram", "tiktok"]) if (was[p] && !conn[p]?.connected) healthAlert(`lost-${p}`, `${{ youtube: "YouTube", instagram: "Instagram", tiktok: "TikTok" }[p]} bağlantısı koptu; otomatik yayın o platforma gitmiyor. Ayarlar → Yayın hesapları.`, { everyH: 24 });
    writeJson(path.join(DATA, "health_conn.json"), Object.fromEntries(["youtube", "instagram", "tiktok"].map((p) => [p, !!conn[p]?.connected])));
  } catch { /* bağlantılar okunamadı */ }
}
setInterval(() => { healthCheck().catch(() => {}); }, 10 * 60000);
setTimeout(() => { healthCheck().catch(() => {}); }, 120000);
app.get("/api/health", async (_req, res) => { await healthCheck().catch(() => {}); res.json({ alerts: readJson(HEALTH_FILE, {}), log: state.log.filter((l) => l.startsWith("⚠️ sağlık")).slice(-20) }); });

// ---------- haftalık rapor (scripts/weekly_report.py): her pazartesi weeklyReport.hour'da WhatsApp'a + sesli özet
async function weeklyReport({ send = true } = {}) {
  try { const conn = await brain.connections(); if (["youtube", "instagram", "tiktok"].some((p) => conn[p]?.connected)) await execAction({ type: "sync_metrics" }); } catch { /* izlenmeler çekilemedi: eldeki veriyle */ }
  const r = await py("weekly_report.py");
  if (!r.json?.ok) return { ok: false, error: (r.stderr || r.stdout || "").slice(-200) };
  push(`📊 haftalık rapor hazır: ${path.basename(r.json.file)}`);
  if (send) { try { await wa.send(r.json.text); } catch { push("💬 haftalık rapor WhatsApp'a gönderilemedi (bağlı değil)"); } }
  announce(r.json.summary, { report: r.json.text, reportFile: r.json.file });
  return { ok: true, ...r.json };
}
const WEEKLY_FILE = path.join(DATA, "weekly_report_last.json");
setInterval(async () => {
  const s = settings(); const w = { enabled: true, weekday: 1, hour: 10, ...(s.weeklyReport || {}) };
  const now = new Date(); const day = now.toISOString().slice(0, 10);
  if (!w.enabled || now.getDay() !== Number(w.weekday) || now.getHours() !== Number(w.hour) || state.running) return;
  if (readJson(WEEKLY_FILE, {}).day === day) return;
  writeJson(WEEKLY_FILE, { day });
  await weeklyReport({ send: true }).catch((e) => push(`📊 haftalık rapor hatası: ${e.message}`));
}, 5 * 60000);
app.post("/api/weekly-report", async (_req, res) => res.json(await weeklyReport({ send: true })));

// ---------- arka plan görevleri: metrik senkronu, günlük rapor
let lastReportDay = null, lastFlush = 0, retentionTry = 0;
setInterval(async () => {
  const s = settings();
  const rest = resting(); // dinlenmede yalnız hafif izlenme/abone senkronu sürer (grafikte gün boşluğu kalmasın)
  const conn = await brain.connections();
  const anyConnected = conn.youtube?.connected || conn.instagram?.connected || conn.tiktok?.connected;
  const m = readJson(path.join(DATA, "metrics.json"), { lastSync: null });
  const due = !m.lastSync || Date.now() - Date.parse(m.lastSync) > s.metricsSyncMinutes * 60000;
  if (anyConnected && due && !state.running) { await execAction({ type: "sync_metrics" }); push("· izlenmeler güncellendi"); }
  // izleyici tutma (scripts/retention.py): 12 saatte bir, YouTube bağlıysa; izleyicinin ayrıldığı bölüm senaryo ipucuna girer
  if (conn.youtube?.connected && !state.running && Date.now() - (readJson(path.join(DATA, "retention.json"), {}).updatedAt || 0) * 1000 > 12 * 3600000 && Date.now() - retentionTry > 3 * 3600000) {
    retentionTry = Date.now();
    const r = await py("retention.py", ["--sync"]);
    const sm = r.json?.summary;
    if (r.json?.fetched) { await py("analyze.py"); push(`👀 izleyici tutma: ${r.json.fetched} video güncellendi${sm?.videos ? ` · ortalama izlenme %${sm.avgViewPct ?? "?"} · kapanışa ulaşan %${sm.reachOutro ?? "?"}${sm.worst ? ` · en çok kayıp: ${sm.worst}` : ""}` : ""}`); }
    else if (r.json?.errors?.length || r.json?.error) push(`👀 izleyici tutma alınamadı: ${(r.json.errors || [r.json.error]).join(" · ").slice(0, 200)}`);
  }
  // günlük yükleme sınırı yüzünden sıraya alınan videolar: saatte bir, üretim yokken dene
  if (Date.now() - lastQueueLog > 2 * 3600000) { lastQueueLog = Date.now(); logQueues().catch(() => {}); } // TikTok/YouTube sırası 2 saatte bir loga
  if (rest) return; // YouTube sırası ve günlük rapor (Claude) sistem uyanınca
  if (anyConnected && !state.running && Date.now() - lastFlush > 60 * 60000 && existsSync(path.join(DATA, "publish_queue.json")) && readJson(path.join(DATA, "publish_queue.json"), []).length) {
    lastFlush = Date.now();
    const r = await py("publish.py", ["--flush"]);
    for (const l of String(r.stdout || "").trim().split("\n").slice(0, -1)) if (l.startsWith("📤")) push(l);
    if (r.json?.uploaded?.length) await py("analyze.py");
  }
  const now = new Date(); const day = now.toISOString().slice(0, 10);
  if (now.getHours() === Number(s.dailyReportHour) && lastReportDay !== day && !state.running) { lastReportDay = day; const r = await think("günlük rapor", "report"); announce(r.reply, { report: r.report, reportFile: r.reportFile }); push(`· günlük rapor hazır: ${r.reportFile}`); }
}, 60000);

// Sınır sıraları (TikTok taslak sınırı, YouTube günlük sınırı) logda görünür: açılışta, 2 saatte bir, "tiktok sırası" komutu
let lastQueueLog = Date.now() - 2 * 3600000 + 60000; // açılıştan 1 dk sonra ilk kez
async function logQueues({ all = false } = {}) {
  const r = await py("publish.py", ["--queue"]);
  const lines = String(r.stdout || "").trim().split("\n").slice(0, -1).filter((l) => l.startsWith("📤") && (all || !/sırası: boş$/.test(l)));
  for (const l of lines) push(l);
  return { lines, ...(r.json || {}) };
}
app.get("/api/queue", async (_req, res) => res.json(await logQueues({ all: true })));
app.listen(PORT, "0.0.0.0", () => console.log(`EMIXHAS paneli: http://localhost:${PORT}   (telefon: http://${lanIp()}:${PORT})`));
