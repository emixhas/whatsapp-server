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
import { parseCommand, findLink, videoLink, useDetectors, VERB_NEG, KIND_FILL, KIND_DO } from "./commands.js";
import { parseWhen, whenLabel, timeNote, doubtNote, atLabel } from "./when.js";
import { makeBrain, claudeBin, claudeEnv, claudeError, claudeModelArgs, CLAUDE_LEAN, claudeCwd } from "./brain.js";
import { makeWhatsApp } from "./whatsapp.js";
import { makeVideoQueue, vqCtx, vqTag, vqWho, queueCommand, normUrl, parseBatch, cancelTopic, strictCommand } from "./videoqueue.js";
import { makeTrendAuto } from "./trendauto.js";
import { AsyncLocalStorage } from "node:async_hooks";
// 🎬 fragman takibi bağlamı: kendiliğinden üretilen fragman analizinin indirme/kurgu adımları bu bağlamda koşar; sendW susar (WhatsApp'a
// yalnız sahibin gönderdiği link/videodan üretilenler gider; onlyUserVideos kuralı), panel logu (push) yine yazar
const twAls = new AsyncLocalStorage();
const twQuiet = () => !!twAls.getStore()?.quiet;

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
// süren elle istekler (link/konu araması, yeniden yayın, Instagram silme, değerli haber partisi, YouTube sırası): güncelleme paneli
// bunlar bitmeden yeniden başlatmasın (yanıtsız kaybolurlardı); sayılan işlevler aşağıda counted() ile sarılır
let reqN = 0, flushQ = false;
const counted = (fn) => async (...a) => { reqN++; try { return await fn(...a); } finally { reqN--; } };
const run = (cmd, args, opts = {}) => new Promise((res) => execFile(cmd, args, { cwd: ROOT, env: ENV, maxBuffer: 8e6, ...opts }, (err, stdout, stderr) => res({ ok: !err, stdout, stderr, err })));
// uzun işlerde (sosyal medya indirme, video kurgusu) ilerleme satırları beklemeden loga düşsün: satır satır okur (sonuç run() ile aynı)
const runLines = (cmd, args, { timeout = 0, onLine = null } = {}) => new Promise((res) => {
  const c = spawn(cmd, args, { cwd: ROOT, env: ENV });
  vqCtx()?.child(c, args); // video kuyruğundaki iş (videoqueue.js): iptal edilirse bu süreç ve altındakiler öldürülür
  c.stdout.setEncoding("utf8"); c.stderr.setEncoding("utf8"); // Türkçe harf/emoji iki parçaya bölünürse � olmasın
  let out = "", err = "", buf = "", killed = false;
  const t = timeout ? setTimeout(() => { killed = true; try { c.kill("SIGTERM"); } catch { /* yok */ } }, timeout) : null;
  c.stdout.on("data", (x) => { out += x; buf += x; const ls = buf.split("\n"); buf = ls.pop(); if (onLine) for (const l of ls) { try { onLine(l); } catch { /* yok */ } } });
  c.stderr.on("data", (x) => { err = (err + x).slice(-20000); });
  c.on("error", (e) => { if (t) clearTimeout(t); res({ ok: false, stdout: out, stderr: err || e.message, err: e }); });
  c.on("close", (code) => { if (t) clearTimeout(t); res({ ok: code === 0 && !killed, stdout: out, stderr: err, err: code === 0 && !killed ? null : { code, killed } }); });
});
const py = async (script, args = []) => { const r = await run(PY, [`scripts/${script}`, ...args]); let json = null; try { json = JSON.parse(r.stdout.trim().split("\n").pop()); } catch { /* düz metin */ } return { ...r, json }; };
const readJson = (p, d) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return d; } };
const writeJson = (p, o) => writeFileSync(p, JSON.stringify(o, null, 2));
const SETTINGS = path.join(DATA, "settings.json");
const defaults = { autopublish: { youtube: false, instagram: false, tiktok: false }, dailyReportHour: 9, metricsSyncMinutes: 20, channelName: "Türkiye Gündemi", hashtags: "#gündem #haber #türkiye #sondakika #shorts",
  assistantName: "Emixhas", wakeWords: ["emixhas", "emiks has", "emiks", "emix", "emixas", "emikhas", "emihas", "e mix has", "emiş has", "emişhas"], fullAuthority: true,
  voice: { engine: "auto", name: "Yelda", rate: 195, piperLength: 0.85, piperNoise: 0.5 }, narrationEngine: "auto", narration: { mode: "single", voice: "auto", voiceA: "vox-kadin", voiceB: "vox-erkek", femaleGainDb: 3, maleGainDb: 0 }, tunnelAutoStart: false, claudeModel: "opus", mynet: { enabled: true, url: "https://www.mynet.com/", count: 6, intervalMin: 30, maxPerDay: 3, duration: 30 }, youtubePolicy: { onlyValuable: true, extraDailyMax: 3, extraKeywords: [] }, newsLevel: "top", autoNews: { maxPerDay: 12 }, anlikAutoPublish: true, media: { video: true, maxVideoSeconds: 20, allowYoutubeEmbeds: true }, claudeEffort: { script: "medium", brain: "high", chat: "low" },
  chatterbox: { port: 3139, refVoice: "voices/ref.wav", exaggeration: 0.45, cfg: 0.5 },
  turkishVoice: { python: ".venv-tr/bin/python", trendyolBin: ".venv-tr/bin/trendyol-tts", mlxModel: "models/Trendyol-TTS-mlx", torchModel: "Trendyol/Trendyol-TTS", baseModel: "openbmb/VoxCPM2", backend: "auto", cfg: 2.0, steps: 16, seed: 42, refVoice: "", emaSpeed: 1.0 },
  stageVoice: { enabled: true, macSpeaker: true, quietFrom: 23, quietTo: 8 }, muted: false,
  whatsapp: { enabled: true, owner: "905321308827", notifyOnVideo: true, sendVideoFile: true, requireApproval: true, autoStart: true, notifyStages: true, digest: true, onlyUserVideos: true }, scheduleHours: 5 };
const deepMerge = (a, b) => { const o = { ...a }; for (const [k, v] of Object.entries(b || {})) o[k] = v && typeof v === "object" && !Array.isArray(v) ? deepMerge(a[k] || {}, v) : v; return o; };
const settings = () => deepMerge(defaults, readJson(SETTINGS, {}));
const patchSettings = (patch) => { const s = deepMerge(settings(), patch); writeJson(SETTINGS, s); return s; };
// Tek seferlik geçiş: YouTube gömmeleri kısa süre varsayılan kapalıydı; kullanıcı kararıyla açık olmalı
// kademeli izlenme takibi (ilk 3 gün sık, sonra günde bir, 7 günden sonra yok): eski varsayılan 60 dk → 20 dk (bir kez)
if (!settings().metricsSyncMigrated) patchSettings({ metricsSyncMinutes: Number(settings().metricsSyncMinutes) === 60 ? 20 : settings().metricsSyncMinutes, metricsSyncMigrated: true });
if (settings().media?.allowYoutubeEmbeds === false && !settings().media?.ytEmbedsMigrated) patchSettings({ media: { allowYoutubeEmbeds: true, ytEmbedsMigrated: true } });
// Tek seferlik geçiş (kullanıcı isteği, 26 Ekim: "WhatsApp'tan üretim istediğim şeyler onay beklemeden direkt yayınlansın"): panelden kapatılmış olsa da bir kez açılır
if (!settings().waVideo?.autoPublishMigrated) patchSettings({ waVideo: { autoPublish: true, autoPublishMigrated: true } });
// Tek seferlik geçiş (kullanıcı isteği, 26 Ekim: "fragman taramalarını 2 saatte bir yapılandıralım"): kayıtlı kısa aralık (eski 3 dk varsayılanı) bir kez 120 dk olur
if (!settings().trailerWatch?.intervalMigrated) patchSettings({ trailerWatch: { ...(Number(settings().trailerWatch?.intervalMin) > 0 && Number(settings().trailerWatch?.intervalMin) < 120 ? { intervalMin: 120 } : {}), intervalMigrated: true } });
// Tek seferlik geçiş (kullanıcı isteği, 19 Ekim: "tüm üretilen haberleri ve videoları 2 gün sonra diskten silelim, kapaklar dahil"):
// eski 30 günlük ayar (ya da kapalı temizlik) 2 güne çekilir; sonra panelden değiştirilebilir
if (!settings().cleanup?.twoDays) patchSettings({ cleanup: { enabled: true, days: 2, twoDays: true } });
const IMPROVEMENTS = path.join(DATA, "improvements.md");
const queueImprovement = (task) => { const head = "# Emixhas geliştirme kuyruğu\n\nBir görevi uygulamak için proje klasöründe Claude Code'u açıp bu dosyadaki ilk açık görevi vermeniz yeterli; uygulanınca [x] işaretleyin.\n\n"; const line = `- [ ] ${new Date().toISOString().slice(0, 16)} ${String(task).trim()}\n`; writeFileSync(IMPROVEMENTS, (existsSync(IMPROVEMENTS) ? readFileSync(IMPROVEMENTS, "utf8") : head) + line); return { ok: true, file: "data/improvements.md" }; };
const label = (v) => (v.date ? `${v.date}, günün ${v.episodeOfDay}. özeti` : v.name.replace(/\.mp4$/, ""));

// meta date + timeLabel → ms (disk temizliği json'u yeniden yazdığı için dosya zamanı üretim zamanı değildir)
const metaTime = (meta) => { const t = Date.parse(`${meta?.date || ""}T${/^\d{1,2}:\d{2}$/.test(meta?.timeLabel || "") ? meta.timeLabel.padStart(5, "0") : "00:00"}:00`); return Number.isFinite(t) ? t : null; };
// archived: disk temizliğinin mp4'ünü sildiği (kaydı duran) ve bir platformda yayında olan videolar da listelenir (archived: true): panelden
// platformlardan silinebilsin ve yeniden yayınlanabilsin (ikisi de yalnız kaydı kullanır)
function listVideos({ archived = false } = {}) {
  const metrics = readJson(path.join(DATA, "metrics.json"), { videos: {} }).videos;
  const files = readdirSync(OUT);
  const mp4s = new Set(files.filter((f) => f.endsWith(".mp4")));
  const gone = archived ? files.filter((f) => /^\d{4}.*\.json$/.test(f) && !mp4s.has(f.replace(/\.json$/, ".mp4"))).map((f) => f.replace(/\.json$/, ".mp4"))
    .filter((f) => { const m = metrics[f] || {}; return m.youtube?.id || m.instagram?.id || m.tiktok?.publish_id || m.tiktok?.id; }) : [];
  return [...mp4s, ...gone].map((f) => {
    const old = !mp4s.has(f);
    const meta = readJson(path.join(OUT, f.replace(/\.mp4$/, ".json")), null);
    if (old && !meta?.archived) return null;
    const st = old ? { size: 0, mtimeMs: metaTime(meta) || 0 } : statSync(path.join(OUT, f));
    const dur = meta ? meta.segments.reduce((s, x) => s + x.duration, 0) : null;
    const m = metrics[f] || {};
    return { name: f, size: st.size, mtime: st.mtimeMs, ...(old ? { archived: true } : {}), duration: dur ? Math.round(dur) : null, targetDuration: meta?.targetDuration ?? null,
      date: meta?.dateLabel ?? null, time: meta?.timeLabel ?? null, episodeOfDay: meta?.episodeOfDay ?? null,
      headlines: meta ? meta.segments.filter((s) => s.kind === "haber").map((s) => ({ title: s.title, category: s.category, breaking: !!s.breaking })) : [],
      youtube: m.youtube || null, instagram: m.instagram || null, tiktok: m.tiktok || null, remakeOf: meta?.remakeOf || null, peakHour: meta?.peakHour ?? null,
      // çizilmiş benzer video (✏️ düzelt): panelde düğme, WhatsApp düzeltme komutunun hedefi; revision düzeltilmiş sürüm numarası
      recreated: !!meta?.recreated, revision: Number(meta?.revision) || 0, revisionOf: meta?.revisionOf || null,
      kare: !!meta?.kare, // ⬛ kare (1:1) uzun video: panelde rozet, yalnız YouTube
      trailerAuto: !!meta?.trailerAuto, // 🎬 fragman takibinden kendiliğinden üretilen fragman analizi: panelde rozet
      // panel araması: başlıklar, seslendirme, kaynaklar, tarih, format (küçük harf, Türkçe)
      search: meta ? [meta.publishTitle, meta.titles?.A, meta.titles?.B, meta.dayLabel, meta.slotLabel, meta.formatLabel, meta.sourceName, ...(meta.hashtags || []),
        ...meta.segments.flatMap((x) => [x.title, x.narration, x.source])].filter(Boolean).join(" ").toLocaleLowerCase("tr-TR").slice(0, 4000) : f.toLowerCase(),
      views: (m.youtube?.views || 0) + (m.instagram?.views || 0) + (m.tiktok?.views || 0) };
  }).filter(Boolean).sort((a, b) => b.mtime - a.mtime);
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
  if (/^📤 sırada \d+ video bekliyor; .*panel/.test(line)) flushAsap = true; // sahibin videosu sırayı beklemedi: sıradakiler üretim bitince (dakikalık kontrol)
  // Instagram geçici engeli ("too many actions"): bekleme başlayınca ve sıradaki videolar yüklenince WhatsApp'a (kullanıcı isteği, 22 Ekim)
  if (/^📤 instagram: sınır doldu|^📤 instagram sırası: .*duraklatıldı/.test(line)) setTimeout(() => { try { igHoldNotify(); } catch { /* yok */ } }, 1500);
  if (/^📤 instagram: (tamam|zaten yayında) .*\(sıradan(?:, fragman)?\)$|^📤 instagram: hata .*\(sıradan, .*\)$|^📤 sıradan çıkarıldı .*→ instagram$/.test(line)) { try { igFlushNote(line); } catch { /* yok */ } }
  if (ownerJobs.size) { try { ownerLine(line); } catch { /* yok */ } } // sahibin uzun işi: aşama ve uyarı (aşağıda ownerJobs)
  if (/^✖ üretim hata/.test(line) && digestPending) digestPending = null; }; // hata uyarısı ayrı gider; yarım özet kalmasın
// Instagram geçici engeli (publish.py IG_THROTTLE_RE → publish_hold.json reason instagram_rate_limit): her yeni bekleme bir kez bildirilir
// (data/ig_hold_notified.json {until}); sıradaki videolar yüklenince (--flush: post_pipeline her yayından sonra, panel bekleme bitince ve
// saatte bir) tek mesaj: yüklenenler linkleriyle, atlananlar nedeniyle
const IG_HOLD_NOTED = path.join(DATA, "ig_hold_notified.json");
function igHoldInfo() { const h = (readJson(path.join(DATA, "publish_hold.json"), {}) || {}).instagram || {}; const until = Date.parse(h.until || ""); return until > Date.now() ? { until, reason: h.reason || "" } : null; }
async function igHoldNotify() {
  const h = igHoldInfo(); if (!h) return;
  const noted = readJson(IG_HOLD_NOTED, {}) || {};
  if (noted.until === h.until) return; // bu bekleme bildirildi
  writeJson(IG_HOLD_NOTED, { until: h.until, at: Date.now() });
  const q = (readJson(path.join(DATA, "publish_queue.json"), []) || []).filter((x) => x.platform === "instagram");
  const hhmm = new Date(h.until).toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" });
  const why = h.reason === "instagram_rate_limit" ? "Instagram çok sık paylaşım yapıldığı için geçici engel koydu (\"too many actions\")" : "Instagram günlük yükleme sınırı doldu";
  const text = `⏳ *Instagram beklemede*: ${why}. Gönderim ${hhmm}'e kadar duraklatıldı; ${q.length ? `${q.length} video sırada` : "video sıraya alındı"}, süre dolunca kendiliğinden yüklenecek. Yüklenince haber vereceğim.`;
  try { await wa.send(text); push(`💬 Instagram beklemesi WhatsApp'a bildirildi (${hhmm}'e kadar, ${q.length} video sırada)`); } catch { push("💬 Instagram beklemesi WhatsApp'a bildirilemedi (bağlı değil)"); }
}
let igFlushLines = [], igFlushTimer = null;
function igFlushNote(line) {
  igFlushLines.push(line);
  clearTimeout(igFlushTimer);
  igFlushTimer = setTimeout(async () => {
    const ls = igFlushLines.splice(0); if (!ls.length) return;
    const ok = ls.filter((l) => /^📤 instagram: (tamam|zaten yayında)/.test(l)).map((l) => "• " + l.replace(/^📤 instagram: (tamam|zaten yayında) ?/, "").replace(/ \(sıradan(?:, fragman)?\)$/, "").trim());
    const bad = ls.filter((l) => !/^📤 instagram: (tamam|zaten yayında)/.test(l)).map((l) => "• " + l.replace(/^📤 (instagram: hata )?/, "").replace(/ → instagram$/, "").replace(/ \(sıradan, (.*)\)$/, " ($1)").trim());
    const head = ok.length ? `✅ *Instagram engeli kalktı*, sıradaki ${ok.length > 1 ? ok.length + " video" : "video"} yüklendi:` : "⚠️ *Instagram sırası*: sıradaki video yüklenemedi:";
    const text = [head, ...ok, ...(bad.length ? [(ok.length ? "Yüklenemeyen:" : ""), ...bad].filter(Boolean) : [])].join("\n");
    try { await wa.send(text); push(`💬 Instagram sıra sonucu WhatsApp'a bildirildi (${ok.length} yüklendi${bad.length ? `, ${bad.length} yüklenemedi` : ""})`); } catch { push("💬 Instagram sıra sonucu WhatsApp'a bildirilemedi (bağlı değil)"); }
  }, 3000);
}
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
  if (vqCancelledVideos.has(d.mp4)) { digestPending = null; push(`⏹ ${d.mp4}: video kuyruğundan iptal edilen işin videosu; WhatsApp'a bildirilmedi`); return; }
  digestPending = null;
  const summary = state.log.slice(Math.max(0, state.log.length - 200)).filter((l) => /^📤 /.test(l) && !/tekrar denenecek/.test(l));
  try { const r = await wa.notifyVideo(d.mp4, { ask: true, summary }); if (!r.ok && !r.skipped) push(`💬 WhatsApp özeti gönderilemedi: ${r.error}`); } catch (e) { push(`💬 WhatsApp özeti gönderilemedi: ${e.message}`); }
  if (why !== "yayın bitti") push(`💬 WhatsApp özeti ${why} gönderildi`);
}
function notifyStage(line) {
  try {
    const w = settings().whatsapp || {};
    if (!w.notifyStages || waDigest() || w.brief !== false || !STAGE.test(line)) return;
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
// video kuyruğunda hazırlanan işin süreç ağacı: runLines'ın kaydettiği süreçler (social_video.py, wa_video.py) ve torunları (yt-dlp, ffmpeg,
// konuşma tanıma, sahne çizimi tarayıcısı); zorlamasız temizlik (reap) bunlara dokunmaz (4. tur, inceleme, 20 Ekim: önceki videonun üretimi
// bitince sıradakinin kurgusundaki tarayıcı kapatılıyordu; eskiden yalnız yt-dlp korunuyordu)
function vqSpare() {
  let roots = []; try { roots = vq.ownPids(); } catch { /* kuyruk henüz kurulmadı */ }
  if (!roots.length) return new Set();
  const table = processTable(), out = new Set(roots), todo = [...roots];
  while (todo.length) { const id = todo.pop(); for (const p of table) if (p.ppid === id && !out.has(p.pid)) { out.add(p.pid); todo.push(p.pid); } }
  return out;
}
function reap({ minAgeSec = 600, reason = "boşta", force = false, announceIdle = false } = {}) {
  if (!force && pipelineBusy()) return { ok: true, killed: [] };
  const spare = force ? new Set() : vqSpare();
  const victims = heavyProcs().filter((p) => p.age >= minAgeSec && !(minAgeSec === 0 && !force && /speak\.py/.test(p.cmd) && p.age < 60)
    && !spare.has(p.pid) && !(!force && socialBusy && /yt_dlp/.test(p.cmd))); // video kuyruğunun süren işi (üretim bitince ya da 10 dk'lık temizlikte) kesilmesin
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
  for (const q of anlikQueue) { if (q.opts?.sondakika) sondakikaUnqueue(q); else unmarkQueued(q); } // sondakika.com haberi "üretildi" görünmesin; işaretler silinir (video yok)
  anlikQueue.length = 0;
  const video = vq.stop(); // video kuyruğu: sıradakiler boşalır, hazırlanan iş (indirme/kurgu süreçleri) kesilir; sayılar durdurma yanıtında
  const r = reap({ minAgeSec: 0, reason: "durduruldu", force: true });
  try { stopTts(); } catch { /* yok */ }
  if (!quiet) push(`⏹ hepsi durduruldu: üretim ${n ? "kapatıldı" : "yoktu"}, ${r.killed.length} arka plan süreci kapatıldı`);
  return { ok: true, pipeline: n > 0, killed: r.killed, video };
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
// Biten üretim yalnız sıradaki ya da yoldaki iş yüzünden dinlenmeye geçmediyse nedeni; o iş üretime ya da toplayıcıya girmeden düşerse
// (sayfa okunamadı, aynı olay, bayat, sıradan çıkarken tekrar) restRecheck dinlenmeyi şimdi başlatır (yoksa sonraki üretim bitene kadar uyanık kalırdı)
let restPending = null;
async function restStart({ reason = "elle durduruldu", stop = true } = {}) {
  restPending = null;
  const r = stop ? stopAll({ quiet: true }) : reap({ minAgeSec: 0, reason, force: false });
  const next = await nextPlanned();
  writeJson(REST_FILE, { on: true, since: Date.now(), reason, until: next?.at || null, untilWhat: next?.what || null });
  const killed = r.killed?.length || 0;
  push(`⏸ SİSTEM DURDURULDU (${reason}): ${r.pipeline ? "süren üretim kapatıldı, " : ""}${killed ? `${killed} arka plan süreci kapatıldı` : "açık model kalmadı"}. ` +
    (next ? `Sıradaki planlı iş ${hhmm(next.at)} (${next.what}); ` : "Zamanlayıcı kapalı; ") + "o zamana kadar ya da siz talimat verene kadar hiçbir şey başlamayacak.");
  return { ok: true, rest: restInfo(), pipeline: !!r.pipeline, killed: r.killed || [], video: r.video || null };
}
function restEnd(why) {
  if (!resting()) return false;
  restPending = null;
  writeJson(REST_FILE, { on: false, endedAt: Date.now(), endedWhy: why });
  push(`▶ SİSTEM YENİDEN ÇALIŞIYOR: ${why}`);
  return true;
}
// Her üretimin sonu (panelden, zamanlayıcıdan, anlık): modeller kapatılır; sırada iş yoksa ve ayar açıksa dinlenmeye geçilir.
let lastFinishAt = 0;
function finishProduction(reason = "üretim bitti") {
  if (Date.now() - lastFinishAt < 30000 || pipelineBusy()) return;
  lastFinishAt = Date.now(); restPending = null;
  if (resting()) { reap({ minAgeSec: 0, reason }); return; } // zaten dinlenmede (⏸ süren üretimi kapattı): dinlenmenin nedeni ("elle durduruldu") ezilmesin
  const waiting = anlikQueue.length + anlikInflight.size + (dequeueBusy ? 1 : 0); // yoldaki haber (sayfası/diğer siteleri okunuyor) ve sıradan çıkıp hafızaya bakılan iş de sıradaki iş sayılır
  const vw = vq.waiting(); // video kuyruğu (sıradaki/indirilen linkler) da sıradaki iş: sistem her videodan sonra dinlenip uyanmasın
  if (waiting || vw) { reap({ minAgeSec: 0, reason }); push(waiting ? `⏭ sırada ${waiting} anlık haber var, sistem durdurulmadı` : `⏭ video kuyruğunda ${vw} video var, sistem durdurulmadı`); restPending = reason; return; }
  if (settings().restAfterProduction !== false) restStart({ reason, stop: false }).catch(() => {});
  else reap({ minAgeSec: 0, reason, announceIdle: true });
}
function restRecheck() { // yoldaki kayıt çıktı ya da sıradan çıkan işin denetimi bitti: başka iş yoksa ertelenen dinlenme kararı yeniden verilir
  if (!restPending || anlikInflight.size || anlikQueue.length || valueBatch.length || dequeueBusy || vq.waiting() || pipelineBusy() || resting()) return;
  const why = restPending; restPending = null; lastFinishAt = 0; finishProduction(why);
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
  duration = formatDuration ? null : extraEnv.GUNLUK === "1" ? Math.min(600, Math.max(60, Number(duration) || 240)) : extraEnv.KARE === "1" ? Math.min(1800, Math.max(20, Number(duration) || 60)) : Math.min(180, Math.max(15, Number(duration) || 30));
  Object.assign(state, { running: true, startedAt: Date.now(), duration, log: [], exitCode: null });
  restPending = null; // dinlenme kararını bu üretimin sonu verir
  push(formatDuration ? "▶ zamanlanmış üretim (formatın süresiyle) başlatıldı" : extraEnv.KARE === "1" ? `⬛ ${Math.round(duration / 60)} dakikalık KARE VİDEO üretimi başlatıldı (videonun tamamı kendi sesiyle, 1080x1080)` : extraEnv.ANLIK === "1" ? `⚡ ${duration} saniyelik ANLIK HABER üretimi başlatıldı` : extraEnv.HAFTALIK === "1" ? `📺 HAFTANIN ÖZETİ (yatay, ~${Math.round(duration / 60)} dk) üretimi başlatıldı` : extraEnv.GUNLUK === "1" ? `📺 GÜNÜN ÖZETİ (yatay, ~${Math.round(duration / 60)} dk) üretimi başlatıldı` : `▶ ${duration} saniyelik üretim başlatıldı`);
  const child = spawn("bash", ["pipeline.sh"], { cwd: ROOT, env: { ...ENV, ...(formatDuration ? {} : { DURATION: String(duration) }), ...extraEnv } });
  pipelineProc = child;
  const onData = (b) => b.toString().split("\n").filter(Boolean).forEach((l) => { push(l); const m = l.match(/== bitti: (out\/\S+\.mp4)/); if (m) { state.lastVideo = path.basename(m[1]); vqProduced(state.lastVideo); twProduced(state.lastVideo); } });
  child.stdout.on("data", onData); child.stderr.on("data", onData);
  child.on("close", (code) => { pipelineProc = null; twPipelineEnd(code); setTimeout(() => finishProduction(code === 0 ? "üretim bitti" : "üretim hata ile bitti"), 3000); state.running = false; state.exitCode = code; if (code === 0) push("✔ üretim tamamlandı"); else if (vq.wasCancelled(child)) push("⏹ üretim durduruldu (video kuyruğundan iptal edildi)"); else if (!state.log.slice(-5).some((l) => /^✖ üretim hata/.test(l))) push(`✖ üretim hata ile bitti (kod ${code})`); push(`__done__:${code}`); });
  return { ok: true, duration };
}

// ---------- Anlık haber: editörün yazdığı konuda tek konulu son dakika videosu
// Başka üretim sürüyorsa istek sıraya girer ve o bitince kendiliğinden başlar (zamanlayıcı üretimi dahil).
const anlikQueue = []; // sırayla üretilecek anlık haber istekleri
// Yoldaki haber: sayfası ya da diğer siteleri okunuyor (allSources en çok 75 sn), henüz ne sırada ne üretimde. Bu sürede biten
// üretim sistemi dinlenmeye almasın diye (finishProduction; yoksa otomatik haber reddedilip kaybolurdu) her kayıt sayılır. Aynı olay
// başka kaynaktan ikinci kez başlamasın diye (anlikBusyWith, queueValuable) yalnız kendi denetimlerini (okuma, tekrar, bayat, meşgul)
// geçmiş kayda (firm) yol verilir ya da onunla birleşilir; denetimde düşebilecek habere bağlanan olay kaybolmasın.
// {title, firm, item: {sourceCount}}: yoldaki aynı olayla birleşen ikiz kaynak sayısını artırır (YouTube değer kuralı: 3+ kaynak).
// startAnlik'ten hemen sonra (araya await girmeden) çıkarılır; çıkınca ertelenen dinlenme yeniden denenir (restRecheck).
const anlikInflight = new Set();
async function inflight(title, fn, { firm = false, sourceCount = 1 } = {}) {
  const tok = { title: String(title || ""), firm, item: { sourceCount } };
  anlikInflight.add(tok);
  try { return await fn(tok); } finally { anlikInflight.delete(tok); restRecheck(); }
}
const pipelineBusy = () => { if (state.running) return true; const lock = path.join(WORK, "pipeline.lock", "pid"); if (!existsSync(lock)) return false; try { process.kill(Number(readFileSync(lock, "utf8").trim()), 0); return true; } catch { return false; } };
// Günlük otomatik haber sınırı (kullanıcı isteği, 26 Ekim: Instagram'ın günlük yayın kotası fragmanlara ve en değerli haberlere kalsın;
// settings.autoNews.maxPerDay, varsayılan 12, 0 = sınırsız): sondakika.com / Mynet / son dakika siteleri / toplayıcıdan gelen otomatik anlık
// haberler sayılır; fragman takibi, şablon videoları (deprem, maç…), sahibin işleri, yeniden yayın ve durdurulup sıraya geri alınan iş sayılmaz
const AUTO_NEWS_DAILY = path.join(DATA, "auto_news_daily.json"); // {day, n}
const autoNewsCap = () => Math.max(0, Number(settings().autoNews?.maxPerDay ?? 12) || 0);
const autoNewsCount = () => { const d = readJson(AUTO_NEWS_DAILY, {}); return d?.day === today() ? Number(d.n) || 0 : 0; };
const autoNewsBump = () => writeJson(AUTO_NEWS_DAILY, { day: today(), n: autoNewsCount() + 1 });
const isAutoNews = (opts) => !!opts?.auto && !opts.trailerAuto && !opts.urgent && !opts.templateDir && !opts.userVideo && !opts.remake?.of && !opts.preempted;
function autoNewsGate(opts, what) {
  if (!isAutoNews(opts)) return null;
  const cap = autoNewsCap();
  if (cap && autoNewsCount() >= cap) { push(`⏭ günlük otomatik haber sınırı (${cap}) doldu: "${String(what || "").slice(0, 70)}" üretilmedi (Instagram kotası fragmanlara ve en değerli haberlere kalsın; Ayarlar → 📡 Otomatik içerikler → günde en çok)`); return { ok: false, capped: true, error: `günlük otomatik haber sınırı (${cap}) doldu` }; }
  autoNewsBump();
  return null;
}
function startAnlik(topic, duration, opts = {}) {
  // video kuyruğundaki iş (videoqueue.js bağlamı): iptal edildiyse başlatılmaz; iş etiketlenir (opts.vq: anlık sırasından çıkarma, yalnız onun üretimini durdurma)
  const vc = vqCtx(); if (vc) { if (vc.cancelled) return { ok: false, error: "video kuyruğundan iptal edildi" }; opts = { ...opts, vq: vc.id, vqNo: vc.no, vqSrc: vc.src }; }
  topic = String(topic || "").replace(/\s+/g, " ").trim().slice(0, 1500);
  if (topic.length < 8) return { ok: false, error: "Konuyu biraz daha ayrıntılı yazın (en az birkaç kelime)." };
  duration = Math.min(opts.kare ? 1800 : opts.recreate ? 90 : 60, Math.max(20, Number(duration) || 30)); // benzer video: referansın süresi (en çok 90 sn); kare uzun video: kaynağın süresi (en çok 30 dk)
  if (resting()) { if (opts.auto) { push(`⏸ sistem durduruldu: otomatik anlık haber başlatılmadı (${topic.slice(0, 70)}); elle "🎬 Video üret" ile üretebilirsiniz`); return { ok: false, resting: true, error: "Sistem durduruldu (dinlenmede)." }; } restEnd("elle anlık haber talimatı"); }
  // video kuyruğunun işi, anlık sırasında bekleyen iş varken (üretim bitip sıranın 10 sn'lik kontrolü gelmeden) öne geçmez, sıranın sonuna girer
  // (7. tur, inceleme, 21 Ekim: 5 linkli mesajda üretim sırası #1 → #4 → #2 → #3 → #5 oluyordu)
  // SAHİBİN İŞİ ÖNCE (kullanıcı isteği, 23 Ekim: "link/video gönderirsem üretimimi derhal yapmalı, sonra haberlere geçmeli"): sahibin işi
  // (userVideo: WhatsApp videosu, link, fragman, özet, benzer video, düzeltme) sıranın başına girer (kendi aralarında geliş sırası), süren
  // üretim OTOMATİK anlık haberse durdurulup sıraya geri alınır (preemptAuto); otomatik iş sahibin işi beklerken başlamaz (ownerWaiting)
  // 🎬 fragman takibi işi (urgent; kullanıcı isteği, 26 Ekim: "fragman tanıtımlarını asla kaçırmayalım"): sahibin işlerinden sonra, bütün
  // otomatik haberlerden önce; süren otomatik haber üretimini durdurur (başka bir fragman işini durdurmaz)
  const owner = !!opts.userVideo, urgent = !owner && !!opts.urgent;
  if (pipelineBusy() || ((owner || urgent || vc || opts.auto) && ownerWaiting())) { // sırada sahip işi varken yeni sahip işi de onun arkasına (FIFO)
    const pre = (owner || urgent) && pipelineBusy() ? preemptAuto(opts.title || topic, { byOwner: owner }) : false;
    // priority (değerli sondakika.com haberi, 20 Ekim): sıradaki sıradan OTOMATİK işlerin önüne; elle verilen, öncelikli ve
    // değerli (toplayıcı: valuable, çoklu) işlerin arkasına; sahibin işleri her zaman en önde (kendi aralarında FIFO)
    const firstAuto = () => { const i = anlikQueue.findIndex((q) => !q.opts?.userVideo); return i < 0 ? anlikQueue.length : i; };
    const firstPlain = () => { const i = anlikQueue.findIndex((q) => !q.opts?.userVideo && !q.opts?.urgent); return i < 0 ? anlikQueue.length : i; };
    const pos = owner ? firstAuto() : urgent ? firstPlain() : !opts.priority ? anlikQueue.length : anlikQueue.reduce((n, q, i) => (!q.opts?.auto || q.opts.priority || q.opts.valuable || q.multi || q.opts.userVideo || q.opts.urgent ? i + 1 : n), 0);
    anlikQueue.splice(pos, 0, { topic, duration, opts, at: Date.now() });
    push(owner ? `⚡ sizin işiniz sıraya alındı (${pos + 1}. sırada; ${pre ? "durdurulan otomatik üretim kapanır kapanmaz" : pipelineBusy() ? "süren üretim bitince hemen" : "sıradaki sahip işinden sonra"} başlayacak): ${topic.slice(0, 80)}`
      : urgent ? `🎬 fragman takibi işi öne alındı (${pos + 1}. sırada; sahibin işlerinden sonra, otomatik haberlerden önce${pre ? "; süren otomatik haber durduruldu, sıraya geri alındı" : pipelineBusy() ? "; süren üretim bitince" : ""}): ${topic.slice(0, 80)}`
      : `⚡ anlık haber sıraya alındı (${pos + 1}. sırada, ${pipelineBusy() ? "şu an başka üretim sürüyor" : "sahibin işi bekliyor"}): ${topic.slice(0, 80)}`);
    return { ok: true, queued: true, position: pos + 1, duration, preempted: pre, owner, urgent };
  }
  { const g = autoNewsGate(opts, opts.title || topic); if (g) return g; } // günlük otomatik haber sınırı (fragman takibi ve sahibin işleri sayılmaz)
  mkdirSync(WORK, { recursive: true });
  writeFileSync(path.join(WORK, "anlik_topic.txt"), topic + "\n");
  // Elle verilen konuda sitelerde bulunan diğer haberler (topic_news ilgili haberlerin başına koyar) ve görüntü sayfaları
  // (assemble her kartı başka sitenin sayfasına bağlar); her başlangıçta yazılır ki önceki işten kalmasın.
  writeJson(path.join(WORK, "anlik_related.json"), Array.isArray(opts.related) ? opts.related.slice(0, 8) : []);
  writeJson(path.join(WORK, "anlik_pages.json"), Array.isArray(opts.pages) ? opts.pages.slice(0, 8) : []);
  writeJson(path.join(WORK, "remake.json"), opts.remake || {}); // yeniden yayın: eski senaryo + kaçınılacak görsel kaynakları
  const env = { ANLIK: "1" };
  if (opts.remake?.of) { env.REMAKE = "1"; env.REMAKE_OF = String(opts.remake.of); }
  if (opts.peakHour != null) env.PEAK_HOUR = String(opts.peakHour);
  // şablon video (deprem/maç/piyasa/takvim): senaryo ve bilgi kartları work/jobs/<ad>/ içinde hazır, Claude çağrılmaz
  if (opts.templateDir) env.TEMPLATE_DIR = String(opts.templateDir);
  if (opts.userVideo) env.USER_VIDEO = "1"; // WhatsApp'tan gönderilen video: yayın onayla (waVideo.autoPublish)
  // video kuyruğunun işi (6. tur, karar 3): meta queue {no, source} → yalnız numaralı onayla ya da panel düğmesiyle yayınlanır (yeniden başlatma
  // ve gönderim hatasından etkilenmez); post_pipeline ne otomatik yayınlar ne planlar
  if (Number(opts.vqNo) > 0) { env.VQ_NO = String(opts.vqNo); if (opts.vqSrc) env.VQ_SRC = String(opts.vqSrc); }
  if (opts.trailer) env.TRAILER = "1"; // fragman analizi: meta trailer → açıklama "🎬 FRAGMAN: …", #sondakika yok, #fragman
  if (opts.trailerAuto) env.TRAILER_AUTO = "1"; // 🎬 fragman takibi (kanaldan düşen yeni fragman): meta trailerAuto → post_pipeline bağlı tüm hesaplara, YouTube değer kuralına takılmaz
  if (opts.recreate) env.RECREATE = "1"; // benzer video (sıfırdan): meta recreated → açıklama "🎨 HİKÂYE: …", #sondakika yok, "İlham alınan video"
  if (opts.kare) env.KARE = "1"; // ⬛ kare (1:1) uzun video: Remotion KareVideo, meta kare → Shorts değil, yalnız YouTube, açıklamada bölümler
  if (opts.revisionOf) { env.REVISION_OF = String(opts.revisionOf); env.REVISION_N = String(Math.max(1, Number(opts.revision) || 1)); } // ✏️ düzeltilmiş sürüm: meta revision/revisionOf
  if (opts.summary) env.SUMMARY = "1"; // uzun video özeti: meta summary → intro ve açıklamada özet etiketi (SON DAKİKA değilse #sondakika yok)
  if (["trend", "mizah"].includes(opts.contentKind)) env.CONTENT_KIND = opts.contentKind; // viral/mizah videosu: meta contentKind
  if (opts.publishAt) env.PUBLISH_AT = String(opts.publishAt); // WhatsApp'ta yazılan yayın saati: video hemen üretilir, o saatte yayınlanır
  if (opts.info) { const i = opts.info; env.INFO_KIND = i.kind || ""; env.INFO_LABEL = i.label || ""; if (i.intro) env.INFO_INTRO = i.intro; if (i.outro) env.INFO_OUTRO = i.outro; if (i.breaking === false) env.INFO_BREAKING = "0"; }
  if (opts.source) env.ANLIK_SOURCE = String(opts.source);
  if (opts.url) env.ANLIK_URL = String(opts.url);
  if (opts.sourceCount) env.ANLIK_SOURCE_COUNT = String(opts.sourceCount);
  if (opts.title) env.ANLIK_TITLE = String(opts.title).slice(0, 300); // kaynağın başlığı: üretilen haber hafızasına (assemble → news_memory)
  const r = startPipeline(duration, env, { auto: !!opts.auto });
  if (r.ok) anlikNow = { titles: anlikTitles({ topic, opts }), at: state.startedAt, vq: opts.vq || null, auto: !!opts.auto, topic, duration, opts };
  return { ...r, anlik: true };
}
// sırada sahibin işi var mı (otomatik iş ve kuyruk işi onun önüne geçmez)
const ownerWaiting = () => anlikQueue.some((q) => q.opts?.userVideo);
// Süren OTOMATİK anlık üretimi (sondakika.com, Mynet, son dakika siteleri, toplayıcı; video kuyruğu ve sahip işleri değil; 5 saatlik gündem,
// günün/haftanın özeti ve şablon videoları da değil: anlikNow yok) sahibin işi için durdurur ve sahip işlerinden sonra üretilmek üzere
// sıraya geri koyar. Boru hattı 143 ile çıkar (pipeline.sh cleanup: kilit, rezerve ad, hafıza kayıtları); hata uyarısı gitmez (preemptedAt)
let preemptedAt = 0;
function preemptAuto(forWhat, { byOwner = true } = {}) {
  if (!state.running || !anlikNow || anlikNow.at !== state.startedAt || !anlikNow.auto || anlikNow.vq || !pipelineProc?.pid) return false;
  if (!byOwner && anlikNow.opts?.urgent) return false; // fragman işi başka bir fragman işini durdurmaz (yalnız sahibin işi durdurur)
  const back = { topic: anlikNow.topic, duration: anlikNow.duration, ...(anlikNow.multi ? { multi: anlikNow.multi } : {}), opts: { ...(anlikNow.opts || {}), preempted: true }, at: Date.now() };
  try { killTree(pipelineProc.pid); } catch { return false; }
  preemptedAt = Date.now();
  const i = anlikQueue.findIndex((q) => !q.opts?.userVideo);
  anlikQueue.splice(i < 0 ? anlikQueue.length : i, 0, back);
  push(`⏭ otomatik üretim durduruldu ("${String(anlikNow.titles?.[0] || "").slice(0, 60)}"): sizin işiniz (${String(forWhat || "").replace(/\s+/g, " ").slice(0, 60)}) önce üretilecek; durdurulan haber sıraya geri alındı, sizinkinden sonra baştan üretilecek`);
  return true;
}
// Sıradaki ya da çalışan anlık işin başlık(lar)ı (aynı olay denetimi için): opts.title, yoksa konu metninin ilk cümlesi.
// Konunun tamamı (başlık + özet + gövde) değil: uzun metinde ilgisiz haberler 3 ortak kök bulup "aynı olay" çıkıyordu.
const anlikTitles = (q) => q.multi ? q.multi.map((x) => x.title) : [q.opts?.title || String(q.topic || "").split(/\.\s|\n/)[0].slice(0, 160)];
let anlikNow = null; // çalışan anlık üretim {titles, at: state.startedAt}; at üretimin başlangıcıyla eşitse hâlâ o iş sürüyor
// Aynı anda düşen 2-3 değerli manşet tek videoda: work/anlik_items.json [{source, url, title, text}] + ANLIK_MULTI=n.
// Süre 30 + 15 sn/ek haber (2 → 45, 3 → 60). Prompt her habere segment ayırır, assemble her segmente kendi sayfasını verir.
function startAnlikMulti(items, { auto = true } = {}) {
  items = items.slice(0, 3);
  const duration = Math.min(60, 30 + 15 * (items.length - 1));
  const topic = items.map((it, i) => `${i + 1}) [${it.source}] ${it.title}`).join("\n");
  if (pipelineBusy() || (auto && ownerWaiting())) { // sahibin işi beklerken otomatik çoklu video da başlamaz
    anlikQueue.push({ topic, duration, multi: items, opts: { auto }, at: Date.now() });
    push(`⚡ ${items.length} son dakika haberi tek video için sıraya alındı (${anlikQueue.length}. sırada): ${items.map((x) => x.title.slice(0, 40)).join(" | ")}`);
    return { ok: true, queued: true, position: anlikQueue.length, duration, multi: items.length };
  }
  if (resting()) { if (auto) return { ok: false, resting: true, error: "Sistem durduruldu (dinlenmede)." }; restEnd("elle anlık haber talimatı"); }
  { const g = autoNewsGate({ auto }, items[0]?.title); if (g) return g; } // günlük otomatik haber sınırı (çoklu video bir sayılır)
  mkdirSync(WORK, { recursive: true });
  writeFileSync(path.join(WORK, "anlik_topic.txt"), items.map((it, i) => `${i + 1}) [${it.source}] ${it.title}. ${String(it.text || "").slice(0, 400)}`).join("\n") + "\n");
  writeJson(path.join(WORK, "anlik_related.json"), []); writeJson(path.join(WORK, "anlik_pages.json"), []); writeJson(path.join(WORK, "remake.json"), {}); // önceki tek konulu işten kalmasın
  writeJson(path.join(WORK, "anlik_items.json"), items.map(({ source, url, title, text }) => ({ source, url, title, text: String(text || "").slice(0, 1500) })));
  push(`⚡ ${items.length} değerli son dakika haberi TEK videoda (${duration} sn): ${items.map((x) => `${x.title.slice(0, 50)} (${x.source})`).join(" | ")}`);
  const env = { ANLIK: "1", ANLIK_MULTI: String(items.length), ANLIK_SOURCE_COUNT: String(Math.max(...items.map((x) => x.sourceCount || 1))) };
  const r = startPipeline(duration, env, { auto });
  if (r.ok) anlikNow = { titles: items.map((x) => x.title), at: state.startedAt, auto: !!auto, topic, duration, multi: items, opts: { auto } };
  return { ...r, anlik: true, multi: items.length };
}
// Kuyruktan çıkan OTOMATİK iş üretilen haber hafızasına yeniden bakar (kullanıcı isteği, 18 Ekim: "ürettiğimiz haberi tekrar
// yakalamayalım"): beklerken biten üretim (ör. 5 saatlik video; assemble'da yazar) aynı haberi anlatmış olabilir. Panelin işaretleri
// (kind "mark": bu işin kendisi ve sıradaki diğer işler) sayılmaz; önceki üretimlerin gerçek kayıtları bu anda yazılmıştır. Viral devam
// haberi kendi kuralıyla denetlendi, bakılmaz; elle istekler engellenmez. Denetim sürerken ikinci tik iş başlatmasın (dequeueBusy).
// Denetim sürerken iş ne sırada ne yoldadır: biten üretim onu sıradaki iş sayar (finishProduction; sayılmazsa sistem dinlenmeye geçip işi —
// değerli sondakika.com haberi dahil — reddettiriyor, iş kayboluyordu); iş düşerse ertelenen dinlenme şimdi başlar (restRecheck).
let dequeueBusy = false;
setInterval(async () => {
  if (dequeueBusy || !anlikQueue.length || pipelineBusy()) return;
  dequeueBusy = true;
  try {
    const q = anlikQueue.shift();
    if (q.multi) {
      let items = q.multi;
      if (q.opts?.auto) {
        const dc = await dupCheck(items.map((x) => (x.followUp ? { title: "" } : { title: x.title, text: x.text, url: x.url, noMark: true })));
        const drop = items.filter((_, i) => dc[i]?.dup);
        for (const it of drop) push(`⚡ sıradaki "${it.title.slice(0, 70)}" (${it.source}) atlandı — ${dupWhy(dc[items.indexOf(it)].match)}`);
        if (drop.length) { unmarkQueued(q, drop.map((x) => x.title)); items = items.filter((_, i) => !dc[i]?.dup); }
        if (!items.length) return;
        if (pipelineBusy()) { anlikQueue.unshift({ ...q, multi: items }); return; } // denetim sürerken başka üretim başladı: sırada kalsın
        if (items.length === 1) { // tek haber kaldı: tek konulu anlık video
          const one = items[0];
          push(`⚡ sıradaki anlık haber başlıyor: ${one.title.slice(0, 80)}`);
          startAnlik([one.title, one.text].filter(Boolean).join(". ").slice(0, 1500), 30, { source: one.source, url: one.url, sourceCount: one.sourceCount || 1, title: one.title, auto: true, followUp: !!one.followUp });
          return;
        }
      }
      startAnlikMulti(items, q.opts || {}); return;
    }
    if (q.opts?.auto && !q.opts.followUp) {
      const title = q.opts.title || anlikTitles(q)[0];
      const [d] = await dupCheck([{ title, text: q.topic, url: q.opts.url, noMark: true }]);
      if (d?.dup) {
        const why = dupWhy(d.match);
        push(`⚡ sıradaki "${String(title).slice(0, 70)}" atlandı — ${why}`);
        if (q.opts.sondakika) sondakikaUnqueue(q, why); else unmarkQueued(q);
        return;
      }
      if (pipelineBusy()) { anlikQueue.unshift(q); return; }
    }
    push(`⚡ sıradaki anlık haber başlıyor: ${q.topic.slice(0, 80)}`); const r = startAnlik(q.topic, q.duration, q.opts || {});
    if (q.opts?.sondakika) { if (r.ok) sondakikaMark(q.opts.sondakika, "üretildi"); else sondakikaUnqueue(q, r.error || "başlatılamadı"); } // panel kartındaki "sırada" durumu
    else if (!r.ok) unmarkQueued(q); // başlatılamadı (ör. dinlenme): video yok, işareti haberi engellemesin
  } finally { dequeueBusy = false; restRecheck(); }
}, 10000);

// ---------- Değerli manşet toplayıcı: Mynet ve son dakika taramalarından gelen DEĞERLİ haberler 20 sn biriktirilir.
// Tek haber → tek konulu anlık video; 2-3 haber → tek birleşik video (startAnlikMulti). Sistem dinlenmedeyse değerli
// haber onu uyandırır (kullanıcı kararı: değerli manşet beklemeden üretilir). Fazlası bir sonraki partiye kalır.
const VALUE_BATCH_MS = 20000;
let valueBatch = [], valueTimer = null;
const eventStems = (t) => new Set(String(t || "").toLocaleLowerCase("tr").match(/[\p{L}\d]{5,}/gu)?.map((w) => w.slice(0, 5)) || []);
const sameEvent = (a, b) => { const x = eventStems(a), y = eventStems(b); let n = 0; for (const w of x) if (y.has(w)) n++; return n >= 3 || (n >= 2 && n / Math.max(1, Math.min(x.size, y.size)) >= 0.5); };
// Haberin TÜM kaynakları (kullanıcı kararı, 18 Ekim: "düşen haberler tüm sitelerden eksiksiz alınsın; önce video, yoksa çoklu
// görsel, yoksa tek görsel"): otomatik son dakikada (Mynet, son dakika siteleri, sondakika.com, değerli haber toplayıcısı) ana
// sayfanın yanında aynı haberi veren diğer siteler de bulunur (news_lookup --topic, en çok 8 farklı site). related → topic_news
// bilgiyi tamamlar (Claude'a ilgili haberler olarak gider), pages → assemble kartları farklı sitelere bağlar, fetch_images video ve
// farklı fotoğrafları bu sayfaların hepsinden arar. Arama 75 sn'de bitmezse yalnız ana sayfayla devam edilir (haber gecikmesin).
// settings.allSources: false kapatır.
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^(www\d?|m|amp|mobil)\./, ""); } catch { return ""; } };
async function allSources(title, url, source) {
  const main = url ? [{ url, source }] : [];
  if (settings().allSources === false || !String(title || "").trim()) return { pages: main, related: [] };
  const f = await pyJson(["scripts/news_lookup.py", "--topic", String(title).slice(0, 160), "--pages", "8"], 75000).catch(() => null);
  if (!f?.ok || !f.found) { push(`🔎 "${String(title).slice(0, 60)}" başka sitelerde bulunamadı; yalnız ${source || "ana kaynak"} kullanılacak`); return { pages: main, related: f?.related || [] }; }
  const seen = new Set(main.map((x) => hostOf(x.url)));
  const pages = [...main, ...(f.pages || []).filter((x) => { const h = hostOf(x.url); if (!x.url || !h || seen.has(h)) return false; seen.add(h); return true; })].slice(0, 8);
  push(`🔎 aynı haber ${pages.length} sitede (${pages.map((x) => x.source).slice(0, 6).join(", ")}${pages.length > 6 ? "…" : ""}): bilgi, video ve fotoğraflar hepsinden toplanacak`);
  return { pages, related: f.related || [] };
}
// Üretilen haber hafızası (kullanıcı isteği, 18 Ekim: "ürettiğimiz haberi tekrar yakalamayalım"; scripts/news_memory.py, settings.dedup
// {enabled, hours 48}): otomatik yakalama videosu üretilmiş haberi (bizim düzenli/anlık/sosyal medya/şablon videolarımız) başka sitede
// başka sözlerle düşse de üretmez; adres, başlık ve içerik (başlık + metin) karşılaştırılır. Elle istekler engellenmez, loga not düşülür.
// dupCheck([{title, text, url, noMark}]) → [{dup, match: {video, title, ago, reason}}]; hata olursa engellemez (haber kaçmasın).
// noMark: panelin üretime alınış işaretleri sayılmaz (kuyruktan çıkan iş: kendi işareti ve sıradaki diğer işlerin işaretleri)
async function dupCheck(items) {
  const q = items.map((x) => ({ title: String(x.title || "").slice(0, 300), text: String(x.text || "").slice(0, 1200), url: String(x.url || ""), ...(x.noMark ? { noMark: true } : {}) }));
  const r = await pyJson(["scripts/news_memory.py", "--check", JSON.stringify(q)], 30000).catch(() => null);
  return r?.ok && Array.isArray(r.results) ? r.results : q.map(() => ({ dup: false, match: null }));
}
// log metni: "bu haber 2 saat önce üretildi (2026-10-18-3)"; video henüz yoksa (panel üretime aldı, sırada/üretimde) "üretime alındı"
const dupWhy = (m) => !m ? "bu haber zaten üretildi" : m.video ? `bu haber ${m.ago} önce üretildi (${m.video})` : `bu haber ${m.ago} önce üretime alındı`;
function queueValuable(item) { // {title, text, source, url, sourceCount, duration, onStarted(r)}
  const twin = valueBatch.find((x) => sameEvent(x.title, item.title));
  if (twin) { twin.sourceCount = Math.max(twin.sourceCount || 1, (item.sourceCount || 1) + 1); push(`⭐ aynı olay iki kaynakta: "${item.title.slice(0, 60)}" (${item.source}) tek haber sayıldı`); item.onStarted?.({ ok: true, merged: true }); return; }
  const fly = [...anlikInflight].find((x) => x.firm && sameEvent(x.title, item.title)); // aynı olayın videosu başlamak üzere (diğer siteleri okunuyor)
  if (fly) { fly.item.sourceCount = Math.max(fly.item.sourceCount || 1, (item.sourceCount || 1) + 1); push(`⭐ aynı olay iki kaynakta: "${item.title.slice(0, 60)}" (${item.source}) zaten üretime alınıyor, tek haber sayıldı`); item.onStarted?.({ ok: true, merged: true }); return; }
  valueBatch.push(item);
  push(`⭐ değerli haber yakalandı: ${item.title.slice(0, 80)} (${item.source}) → ${Math.round(VALUE_BATCH_MS / 1000)} sn içinde düşen diğerleriyle birlikte üretilecek`);
  if (!valueTimer) valueTimer = setTimeout(() => flushValuable().catch((e) => push(`⭐ değerli haber üretimi: ${e.message}`)), VALUE_BATCH_MS);
}
const flushValuable = counted(flushValuable0); // parti valueBatch'ten çıkarıldıktan sonra da (hafıza denetimi, birleştirme) sayılır
async function flushValuable0() {
  valueTimer = null;
  if (watchScanning) { valueTimer = setTimeout(() => flushValuable().catch(() => {}), 3000); return; } // diğer kaynak da taransın
  let items = valueBatch.splice(0, 3);
  if (valueBatch.length) valueTimer = setTimeout(() => flushValuable().catch(() => {}), VALUE_BATCH_MS);
  if (!items.length) return;
  // üretimden hemen önce hafızaya yeniden bakılır (başlık + metin + adres): biriktirme sırasında aynı haberin videosu başka yoldan
  // üretilmiş/üretime alınmış olabilir. Atlanan haberin onStarted'ı {ok:false} alır (günlük kayda ve işarete yazılmaz)
  const dc = await dupCheck(items.map((x) => (x.followUp ? { title: "" } : x))); // viral devam haberi kendi kuralıyla denetlendi
  const skipped = items.filter((_, i) => dc[i]?.dup);
  for (const it of skipped) { push(`⭐ "${it.title.slice(0, 70)}" (${it.source}) atlandı — ${dupWhy(dc[items.indexOf(it)].match)}`); try { await it.onStarted?.({ ok: false, skipped: true, error: "aynı haber zaten üretildi" }); } catch { /* kayıt */ } }
  items = items.filter((_, i) => !dc[i]?.dup);
  if (!items.length) return;
  // aynı haber partide iki siteden başka sözlerle (queueValuable'ın ikiz denetimi yalnız başlığa bakar): hafızanın kuralıyla (başlık +
  // metin + adres, vetolar) birleşir, aynı olay çoklu videoda iki kez anlatılmasın; hata olursa parti olduğu gibi kalır
  if (items.length > 1) {
    const g = await pyJson(["scripts/news_memory.py", "--group", JSON.stringify(items.map((x) => ({ title: x.title, text: String(x.text || "").slice(0, 1400), url: x.url || "" })))], 30000).catch(() => null);
    if (g?.ok && Array.isArray(g.groups) && g.groups.length === items.length) {
      const kept = [];
      for (const [i, it] of items.entries()) {
        const tw = items[g.groups[i]];
        if (g.groups[i] === i || !tw || !kept.includes(tw)) { kept.push(it); continue; }
        tw.sourceCount = Math.max(tw.sourceCount || 1, (it.sourceCount || 1) + 1);
        push(`⭐ aynı olay iki kaynakta: "${it.title.slice(0, 60)}" (${it.source}) tek haber sayıldı — ${g.reasons?.[i] || "içerik benzer"}`);
        try { await it.onStarted?.({ ok: true, merged: true }); } catch { /* kayıt */ }
      }
      items = kept;
    }
  }
  if (resting()) restEnd(`değerli haber düştü: ${items[0].title.slice(0, 60)}${items.length > 1 ? ` ve ${items.length - 1} haber daha` : ""}`);
  const one = items[0];
  const r = items.length === 1 // tek haber: tüm kaynakları (aranırken yolda sayılır)
    ? await inflight(one.title, async (tok) => {
      tok.item = one;
      const src = await allSources(one.title, one.url, one.source);
      return startAnlik([one.title, one.text].filter(Boolean).join(". ").slice(0, 1500), one.duration, { source: one.source, url: one.url, sourceCount: one.sourceCount || 1, pages: src.pages, related: src.related, title: one.title, auto: true, followUp: !!one.followUp, valuable: true }); // valuable: öncelikli işler bunu geçmez
    }, { firm: true })
    : startAnlikMulti(items);
  for (const it of items) { try { await it.onStarted?.(r); } catch { /* kayıt */ } }
}
// Elle anlık haber (panel kartı, WhatsApp, sesli komut, beyin): Claude bilgi uydurmasın diye önce haberin kendisi bulunur.
// Link verildiyse sayfa okunur (başlık, özet, metin, site adı); kısa konu verildiyse news_lookup.py haberi Bing/Google
// Haberler, son dakika siteleri ve son RSS'te arar, en iyi eşleşen sayfaları okur (fotoğraf/video da oralardan gelir).
// Bulunamazsa ve editör yalnız kısa bir konu yazdıysa video ÜRETİLMEZ, link ya da ayrıntı istenir.
const URL_RE = /https?:\/\/[^\s<>"']+/i;
const prepareAnlik = counted(prepareAnlik0);
async function prepareAnlik0(input, duration, opts = {}) {
  // konu yalnız iptal sözüyse ("son dakika videosunu iptal et"; 5. tur, inceleme, 20 Ekim): haber aranmaz, video üretilmez
  if (cancelTopic(input)) return { ok: false, error: "Bu bir iptal sözü; haber aranmadı, video üretilmedi. Kuyruk: *kuyruk*, iptal: *#N iptal*." };
  if (parseBatch(input)) { // birden çok video linki (panel ANLIK kartı, beyin): WhatsApp'taki çok linkli mesaj gibi hepsi sırayla video kuyruğuna
    const vb = await vq.handleText(String(input), { source: "panel", noOpen: true });
    if (vb?.action === "vqueue") return { ok: true, social: true, batch: true, reply: vb.reply, title: "video kuyruğu", source: "video kuyruğu" };
    if (vb) return { ok: false, error: vb.reply };
  }
  input = String(input || "").replace(/\s+/g, " ").trim();
  // YouTube/sosyal medya video linki haber sayfası değildir (kullanıcı isteği, 18 Ekim: "attığım youtube haber linklerini de alsın"):
  // beyin breaking_news'i ya da panel kartı ile gelse de videosu indirilip kurgulanır (socialVideoNews; talimatta "son dakika" kalır,
  // fragman analizine dönmez). https:// olmadan yazılmış "youtu.be/…" de; kanal/oynatma listesi linkine Türkçe yanıt.
  const vlk = findLink(input), vl = vlk ? videoLink(vlk.url) : null;
  if (vl && vl.kind !== "video") return { ok: false, error: vl.reply };
  if (vl) {
    if (waVideoCfg().enabled === false) return { ok: false, error: "Videodan haber yapma kapalı (Ayarlar → 📡 Otomatik içerikler)." };
    // yayın saati ve videodaki konum komut kuralıyla ayrılır ("youtu.be/… 18:30'da paylaş" → publishAt; "12:30'dan itibaren" talimatta kalır;
    // inceleme, 18 Ekim: saat talimatta kalıp videodaki konum sanılıyordu, yayın planlanmıyordu)
    const pc = parseCommand(input);
    const rest = String(pc.action === "social_video" ? pc.instruction || "" : input.replace(vlk.raw, " ")).replace(/\s+/g, " ").trim();
    // mizah/viral etiketli link (link/mizah ya da talimatta açık ifade: "mizah videosu", "#mizah sesi kalsın", "son dakika yazma, viral
    // video"; inceleme, 19 Ekim) son dakika haberi değildir: talimata "son dakika" eklenmez, tür ayrı alanla gider
    const tagged = ["trend", "mizah"].includes(kindOf({ kind: pc.kind, instruction: rest }));
    // talimat "son dakika: …" (etiket biçimi): tür haber, şaka altyazısında talimattan (commands.js "son dakika: <link>" dalı gibi)
    const instruction = tagged || /^son ?dakika(\s|$|:)/i.test(rest) ? rest : rest ? `son dakika: ${rest}` : "son dakika";
    push(`🔗 ${vl.platform} video linki son dakika haberi olarak alındı (haber sayfası gibi okunmaz): ${vl.url.slice(0, 120)}`);
    // video kuyruğuna (videoqueue.js): başka paylaşım hazırlanırken reddedilmez, sırasını bekler
    const vqr = vq.add({ url: vl.url, instruction, publishAt: opts.publishAt || pc.publishAt || null, kind: pc.kind || "", source: "panel" });
    if (!vqr.ok) return { ok: false, error: vqr.error };
    if (vqr.queued) return { ok: true, social: true, queued: true, position: vqr.position, no: vqr.no, ahead: vqr.ahead, title: `${vl.platform} videosu`, source: vl.platform };
    // haber sayfası okunmadı ve süre kurgudan gelir: panel kartı "Haberi okudum … (N sn)" yazmasın (viaLink/duration yok)
    return { ok: true, social: true, no: vqr.no, title: `${vl.platform} videosu indiriliyor`, source: vl.platform };
  }
  const link = (input.match(URL_RE) || [""])[0].replace(/[).,;!?]+$/, "");
  if (link) {
    push(`🔗 haber linki okunuyor: ${link.slice(0, 120)}`);
    const a = await pyJson(["scripts/news_lookup.py", "--url", link], 90000);
    if (!a?.ok) { push(`🔗 haber sayfası okunamadı: ${a?.error || "yanıt yok"}`); return { ok: false, error: `Haber sayfasını okuyamadım (${a?.error || "yanıt yok"}). Haberi birkaç cümleyle yazarsanız ondan üretirim.` }; }
    push(`🔗 ${a.site}: ${a.title.slice(0, 100)} → son dakika videosu üretiliyor`);
    const [d] = await dupCheck([{ title: a.title, text: [a.description, a.body].filter(Boolean).join(" "), url: link }]); // elle istek engellenmez, yalnız not
    if (d?.dup) push(`🔗 not: ${dupWhy(d.match)}; elle istendiği için yine üretiliyor`);
    const topic = [a.title, a.description, a.body].filter(Boolean).join(". ").replace(/\.\s*\./g, ".");
    return { ...startAnlik(topic, duration, { ...opts, source: a.site, url: link, pages: [{ url: link, source: a.site }], title: a.title }), title: a.title, source: a.site, viaLink: true };
  }
  if (input.length < 8) return { ok: false, error: "Konuyu biraz daha ayrıntılı yazın ya da haberin linkini gönderin." };
  push(`🔎 "${input.slice(0, 90)}" haber sitelerinde aranıyor…`);
  const f = await pyJson(["scripts/news_lookup.py", "--topic", input], 120000);
  if (f?.errors?.length) push(`🔎 arama uyarısı: ${f.errors.join(" · ")}`);
  if (f?.found && f.best) {
    const b = f.best;
    push(`🔎 bulundu: ${b.title.slice(0, 100)} (${b.site}) · ${f.matched} haberde geçiyor, görüntüler ${Math.max(1, (f.pages || []).length)} sayfadan`);
    const [d] = await dupCheck([{ title: b.title, text: [b.description, b.body].filter(Boolean).join(" "), url: b.url || "" }]); // elle istek engellenmez, yalnız not
    if (d?.dup) push(`🔎 not: ${dupWhy(d.match)}; elle istendiği için yine üretiliyor`);
    const topic = [b.title, b.description, b.body].filter(Boolean).join(". ").replace(/\.\s*\./g, ".");
    return { ...startAnlik(topic, duration, { ...opts, source: b.site, url: b.url || undefined, related: f.related || [], pages: f.pages || [], title: b.title }), title: b.title, source: b.site, found: true, count: f.matched };
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
const remakeVideo = counted(remakeVideo0);
async function remakeVideo0(name, opts = {}) {
  name = path.basename(String(name || "")).replace(/\.json$/, "").replace(/\.mp4$/, "") + ".mp4";
  const meta = readJson(path.join(OUT, name.replace(/\.mp4$/, ".json")), null);
  if (!meta?.segments?.length) return { ok: false, error: "Videonun bilgileri bulunamadı." };
  const segs = meta.segments.filter((x) => x.kind === "hook" || x.kind === "haber");
  const firstHaber = segs.find((x) => x.kind === "haber") || segs[0];
  const story = meta.anlik ? segs : segs.filter((x) => x.kind === "hook" || x === firstHaber);
  const title = firstHaber?.title || meta.titles?.A || "";
  const avoid = [...new Set([meta.sourceUrl, ...story.flatMap((x) => [x.articleUrl, x.videoSrc, x.imageSrc, ...(x.imageSrcs || [])])].filter(Boolean))]; // çoklu görselin hepsi
  const facts = story.map((x) => [x.title, x.narration].filter(Boolean).join(": ")).join(" ");
  push(`🔁 yeniden yayın hazırlanıyor: ${title.slice(0, 80)} (${name}) — haber sitelerde yeniden aranıyor, farklı görseller seçilecek`);
  const f = await pyJson(["scripts/news_lookup.py", "--topic", title], 120000).catch(() => null);
  const pages = (f?.pages || []).filter((p) => !avoid.includes(p.url));
  const fresh = f?.found && f.best && !avoid.includes(f.best.url) ? [f.best.title, f.best.description, f.best.body].filter(Boolean).join(". ") : "";
  const topic = [facts, fresh].filter(Boolean).join(" ").replace(/\s+/g, " ").slice(0, 1500);
  const source = pages[0]?.source || meta.sourceName || firstHaber?.source || "";
  const r = startAnlik(topic, Math.min(60, Math.max(20, Number(opts.duration || meta.targetDuration) || 30)), {
    source, peakHour: opts.peakHour, url: pages[0]?.url, related: (f?.related || []).filter((x) => x.b !== title), pages, title,
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
// data/ig_cleanup_log.json'a; özet WhatsApp'a (komut WhatsApp'tan geldiyse yanıtın kendisi özettir). Instagram Girişi gönderi
// silmeyi desteklemez (yalnız Facebook Girişi + instagram_manage_contents): ig_cleanup.py bunu data/ig_delete_support.json'a yazar,
// sonra DELETE denemez; liste elle silmek için verilir, elle silinenler doğrulanıp kayıttan düşer. Panel yanıtı en çok 15 link ve
// bütün adımları verir; WhatsApp kısa mesaj modunda (yanıt ~700 karakterde kesilir) en çok 5 link + "tamamı panelde".
let igCleanupPending = null;
const igLine = (x) => `• ${x.title.slice(0, 60)} — ${x.views.toLocaleString("tr-TR")} izlenme, ${x.ageH < 24 ? `${Math.round(x.ageH)} saatlik` : `${Math.round(x.ageH / 24)} günlük`}`;
// hata metnini kelime sınırında kısaltır (yarım kelime ya da yarım kalmış talimat gitmesin)
const igCut = (s, n) => { s = String(s || ""); if (s.length <= n) return s; const c = s.slice(0, n), i = c.lastIndexOf(" "); return (i > n / 2 ? c.slice(0, i) : c).replace(/[\s,;:(]+$/, "") + "…"; };
const igSupport = () => pyJson(["scripts/ig_cleanup.py", "--support"], 20000).catch(() => ({}));
const igWhy = (j) => j?.unsupported ? `Instagram API bu bağlantıyla (${j.via || "Instagram Girişi"}) gönderi silmeye izin vermiyor` : "Instagram API bu gönderileri silemedi";
// otomatik silmeyi açmanın yolu: full = panel (bütün adımlar), değilse WhatsApp için tek kısa satır
const igFix = (j, full) => j?.via === "Facebook Girişi"
  ? "Otomatik silme için Meta uygulamasına instagram_manage_contents iznini ekleyin, .env'e IG_EXTRA_SCOPES=instagram_manage_contents yazın ve Instagram'ı yeniden bağlayın."
  : full ? "Otomatik silme yalnız Instagram, Facebook Girişi ile bağlıyken çalışır: Instagram hesabı bir Facebook Sayfasına bağlı olmalı; Meta uygulamasında Facebook Login ve instagram_manage_contents izni eklenmeli; secrets/.env'de IG_LOGIN=facebook, IG_EXTRA_SCOPES=instagram_manage_contents ve IG_APP_ID/IG_APP_SECRET olarak Meta uygulamasının kimliği ve gizli anahtarı (Instagram uygulama kimliği değil) olmalı; sonra Instagram'ı yeniden bağlayın."
  : "Otomatik silme yalnız Facebook Girişi ile çalışır (IG_LOGIN=facebook, Facebook Sayfası, instagram_manage_contents izni; adımlar panelde).";
const igCounts = (j) => [(j.deleted || []).length || !j.verifyOnly ? `${(j.deleted || []).length} silindi` : "", (j.gone || []).length ? `${j.gone.length} elle silinmiş (kayıttan düştü)` : "",
  (j.manual || []).length ? `${j.manual.length} elle silinmeli` : "", (j.failed || []).length ? `${j.failed.length} silinemedi` : "",
  (j.unknown || []).length ? `${j.unknown.length} doğrulanamadı` : "", (j.kept || []).length ? `${j.kept.length} bırakıldı (izlenmesi arttı)` : ""].filter(Boolean).join(", ") || "değişiklik yok";
// betik satırları loga (elle silinecekler için betiğin özet satırı atlanır: çağıran tek özet yazar); bu bağlantıda ilk "izin yok"
// tespitinde API'nin kısa nedeni bir kez loga (gerçek hata görünsün)
function igRunLog(r) {
  for (const l of String(r.stdout || "").split("\n")) if (l.startsWith("🗑") && !l.endsWith("elle silinmeli — liste panelde")) push(l);
  const j = r.json || {};
  if (j.supportNew && j.reason) push(`🗑 Instagram API'nin silme yanıtı (${j.via}): ${j.reason}`);
  return j;
}
async function igCleanupPlan({ days = 7, max = 1000, minAgeH = 0 } = {}) {
  const m = readJson(path.join(DATA, "metrics.json"), {});
  if (!m.lastSync || Date.now() - Date.parse(m.lastSync) > 20 * 60000) await execAction({ type: "sync_metrics" }).catch(() => {});
  const r = await pyJson(["scripts/ig_cleanup.py", "--plan", "--days", String(days), "--max", String(max), "--min-age-hours", String(minAgeH)], 60000).catch(() => null);
  if (!r?.ok) return { ok: false, text: `Liste çıkarılamadı: ${r?.error || "yanıt yok"}` };
  const items = r.items || [];
  push(`🗑 Instagram temizliği planı: son ${days} günde ${max.toLocaleString("tr-TR")} izlenmenin altında ${items.length} video${r.unknown?.length ? ` (${r.unknown.length} videonun izlenmesi henüz ölçülmedi, listeye alınmadı)` : ""}`);
  if (!items.length) { igCleanupPending = null; return { ok: true, items, text: `Instagram'da son ${days} günde ${max.toLocaleString("tr-TR")} izlenmenin altında video yok. Hiçbir şey silinmedi.` }; }
  const sup = await igSupport();
  igCleanupPending = { names: items.map((x) => x.name), max, days, at: Date.now(), known: !!sup.known };
  const young = items.filter((x) => x.ageH < 24).length;
  const text = `🗑 Instagram'da son ${days} günde ${max.toLocaleString("tr-TR")} izlenmenin altında *${items.length} video* var:\n` +
    items.slice(0, 25).map(igLine).join("\n") + (items.length > 25 ? `\n… ve ${items.length - 25} video daha` : "") +
    (young ? `\n\n⚠️ ${young} tanesi 1 günden yeni; izlenmesi henüz birikmemiş olabilir.` : "") +
    (sup.known ? `\n\n⚠️ ${igWhy({ unsupported: true, via: sup.viaName })}; bu videoları Instagram uygulamasından elle silin. Onaylarsanız hiçbir şey silinmez: elle sildikleriniz kayıttan düşer, kalanların linki verilir. Denetlemek için *evet sil* yazın, vazgeçmek için *iptal* (15 dk geçerli).`
      : `\n\nYalnız Instagram'dan kalıcı olarak silinir (YouTube, TikTok ve Mac'teki kopya kalır). Silmek için *evet sil* yazın, vazgeçmek için *iptal* (15 dk geçerli).`);
  return { ok: true, items, unknown: r.unknown, verifyOnly: !!sup.known, text };
}
// ♻️ Instagram'da ikişer paylaşılmış gönderiler (kullanıcı şikâyeti, 23 Ekim: "ikişerli paylaşılmış haberler instada"): yayın adımı yanıt alamayınca
// (zaman aşımı, bağlantı kopması, bağlantı okuma hatası) 90 sn sonra ya da "onay" ile yeniden deneyip aynı videoyu ikinci kez yüklüyordu;
// publish.py artık yüklemeden önce aynı açıklamalı gönderiyi arar (ig_find_published). Mevcut tekrarlar için: liste → "evet sil" (aynı onay
// mekanizması: igCleanupPending.dups) → her haberin İLK gönderisi kalır, sonrakiler silinir, metrik kaydı kalan gönderiye bağlanır.
async function igDupsPlan({ days = 7 } = {}) {
  const r = await pyJson(["scripts/ig_cleanup.py", "--dups", "--days", String(days)], 90000).catch(() => null);
  if (!r?.ok) return { ok: false, text: `Instagram tekrar listesi çıkarılamadı: ${r?.error || "yanıt yok"}` };
  const groups = r.groups || [];
  push(`♻️ Instagram tekrar taraması: son ${days} günde ${r.scanned || 0} gönderi bakıldı, ${groups.length} haber birden çok kez paylaşılmış (${r.total || 0} fazla kopya)`);
  if (!groups.length) { igCleanupPending = null; return { ok: true, groups, text: `Instagram'da son ${days} günde tekrar paylaşılmış gönderi yok.` }; }
  const sup = await igSupport();
  igCleanupPending = { dups: groups.flatMap((g) => g.dups.map((d) => ({ ...d, keepId: g.keep.id, keepUrl: g.keep.url, title: g.title }))), days, at: Date.now(), known: !!sup.known };
  const text = `♻️ Instagram'da son ${days} günde *${groups.length} haber birden çok kez* paylaşılmış (${r.total} fazla kopya). Her haberin ilk gönderisi kalır, sonrakiler silinir:\n` +
    groups.slice(0, 20).map((g) => `• ${String(g.title).slice(0, 60)} — ${g.dups.length} fazla${g.dups[0]?.url ? ` ${g.dups[0].url}` : ""}`).join("\n") + (groups.length > 20 ? `\n… ve ${groups.length - 20} haber daha` : "") +
    (sup.known ? `\n\n⚠️ ${igWhy({ unsupported: true, via: sup.viaName })}; fazla kopyaları Instagram uygulamasından elle silin (linkler yukarıda). *evet sil* yazarsanız yalnız liste kesinleşir, hiçbir şey silinmez.`
      : `\n\nYalnız Instagram'daki fazla kopya silinir (ilk gönderi, YouTube, TikTok ve Mac'teki kopya kalır). Silmek için *evet sil* yazın, vazgeçmek için *iptal* (15 dk geçerli).`);
  return { ok: true, groups, total: r.total, verifyOnly: !!sup.known, text };
}
async function igDupsRun0(p, { notify = true } = {}) {
  igCleanupPending = null;
  push(`♻️ Instagram tekrar kopyaları ${p.known ? "listeleniyor (API bu bağlantıyla silmiyor; hiçbir şey silinmez)" : "siliniyor"}: ${p.dups.length} gönderi`);
  const r = await py("ig_cleanup.py", ["--dups-run", "--json", JSON.stringify(p.dups)]);
  const j = igRunLog(r);
  if (!j.ok) { const error = `Instagram tekrar silme çalışmadı: ${j.error || String(r.stderr || "yanıt yok").slice(-160)}`; push(`♻️ ${error}`); return { ok: false, error, text: error }; }
  const del = j.deleted || [], fail = j.failed || [], man = j.manual || [];
  const head = `♻️ *Instagram tekrarları*: ${del.length} fazla kopya silindi${man.length ? `, ${man.length} elle silinmeli` : ""}${fail.length ? `, ${fail.length} silinemedi` : ""}.`;
  const text = head +
    (man.length ? `\n\n${igWhy(j)}${j.reason ? ` (${String(j.reason).slice(0, 100)})` : ""}. Instagram uygulamasından elle silin:\n` + man.slice(0, 15).map((x) => `• ${String(x.title).slice(0, 50)}${x.url ? ` ${x.url}` : ""}`).join("\n") + (man.length > 15 ? `\n… ve ${man.length - 15} kopya daha` : "") + (j.unsupported ? `\n${igFix(j, true)}` : "") : "") +
    (fail.length ? "\n\nSilinemeyenler:\n" + fail.slice(0, 10).map((x) => `• ${String(x.title).slice(0, 50)}${x.url ? ` ${x.url}` : ""} — ${igCut(x.message, 160)}`).join("\n") : "");
  const short = head + (man.length ? `\n${igWhy(j)}; elle silinecekler panelde (Ayarlar → Yayın hesapları → Instagram).` : "") + (fail.length ? `\n❌ ${fail.length} silinemedi: ${igCut(fail[0].message, 160)}` : "");
  push(`♻️ Instagram tekrarları bitti: ${del.length} silindi, ${man.length} elle silinmeli, ${fail.length} silinemedi`);
  if (notify) { try { await wa.send(waBrief() ? short : text); } catch { push("💬 Instagram tekrar özeti WhatsApp'a gönderilemedi (bağlı değil)"); } }
  return { ok: true, deleted: del, failed: fail, manual: man, unsupported: !!j.unsupported, via: j.via, text: notify ? text : (waBrief() ? short : text) };
}
app.post("/api/instagram/dups/plan", async (req, res) => res.json(await igDupsPlan({ days: Number(req.body?.days) || 7 })));
const igCleanupRun = counted(igCleanupRun0);
async function igCleanupRun0({ notify = true } = {}) {
  const p = igCleanupPending;
  if (p?.dups && Date.now() - p.at <= 15 * 60000) return await igDupsRun0(p, { notify }); // tekrar kopyaları listesi onaylandı
  if (!p || Date.now() - p.at > 15 * 60000) { igCleanupPending = null; return { ok: false, error: "Bekleyen Instagram silme listesi yok ya da 15 dakikalık onay süresi doldu. Önce listeyi isteyin (ör. \"instagramda son 7 günde 1000 izlenmenin altındakileri sil\")." }; }
  igCleanupPending = null;
  push(`🗑 Instagram temizliği başladı: ${p.names.length} video ${p.known ? "denetleniyor (API bu bağlantıyla silmiyor; hiçbir şey silinmez)" : "siliniyor"}`);
  const r = await py("ig_cleanup.py", ["--run", "--names", p.names.join(","), "--max", String(p.max)]);
  const j = igRunLog(r);
  if (!j.ok) { const error = `Instagram temizliği çalışmadı: ${j.error || String(r.stderr || "yanıt yok").slice(-160)}`; push(`🗑 ${error}`); return { ok: false, error, text: error }; }
  const del = j.deleted || [], fail = j.failed || [], kept = j.kept || [], man = j.manual || [], gone = j.gone || [];
  const head = `🗑 *Instagram temizliği bitti*: ${igCounts(j)}.`;
  // panel (ve kısa mesaj modu kapalıyken WhatsApp): neden + başlıklarıyla en çok 15 link + bütün adımlar
  const text = head +
    (del.length ? "\n\nSilinenler:\n" + del.slice(0, 30).map((x) => `• ${String(x.title).slice(0, 60)} (${x.views ?? "?"} izlenme)`).join("\n") : "") +
    (man.length ? `\n\n${igWhy(j)}${j.reason ? ` (${String(j.reason).slice(0, 100)})` : ""}. Instagram uygulamasından elle silin:\n` +
      man.slice(0, 15).map((x) => `• ${String(x.title).slice(0, 50)}${x.url ? ` ${x.url}` : ""}`).join("\n") + (man.length > 15 ? `\n… ve ${man.length - 15} video daha` : "") + (j.unsupported ? `\n${igFix(j, true)}` : "") : "") +
    (fail.length ? "\n\nSilinemeyenler:\n" + fail.slice(0, 10).map((x) => `• ${String(x.title).slice(0, 50)}${x.url ? ` ${x.url}` : ""} — ${igCut(x.message, 160)}`).join("\n") : "") +
    (kept.length ? "\n\nBırakılanlar:\n" + kept.slice(0, 10).map((x) => `• ${x.name}: ${x.why}`).join("\n") : "");
  // WhatsApp kısa mesaj modu (yanıt ~700 karakterde kesilir): neden tek cümle, en çok 5 link, tamamı panelde; sığmazsa önce silinen
  // başlıkları ve hata ayrıntısı, sonra linkler azalır (lean)
  const linked = man.filter((x) => x.url), tokFail = fail.some((x) => x.token);
  const shortText = (k, lean) => { const shown = Math.min(k, linked.length); return head +
    (del.length && !lean ? `\nSilinenler: ${del.slice(0, 3).map((x) => String(x.title).slice(0, 40)).join(", ")}${del.length > 3 ? ` ve ${del.length - 3} video daha` : ""}.` : "") +
    (man.length ? `\n${igWhy(j)}; Instagram uygulamasından elle silin:` + linked.slice(0, shown).map((x) => `\n• ${x.url}`).join("") +
      `\n${man.length > shown ? `… ve ${man.length - shown} video daha; tamamı` : "Liste"} panelde: Ayarlar → Yayın hesapları → Instagram.${j.unsupported ? `\n${igFix(j)}` : ""}` : "") +
    // geçersiz bağlantıda sabit kısa satır (nedenin ardındaki yeniden bağlama talimatı kesilmesin); diğer hatada kelime sınırında kısalır
    (fail.length ? `\n❌ ${fail.length} silinemedi${tokFail ? ": Instagram bağlantısı geçersiz; panelde Ayarlar → Yayın hesapları → Instagram'ı yeniden bağlayın." : lean ? " (ayrıntı panelde)" : `: ${igCut(fail[0].message, 200)}`}` : ""); };
  let short = shortText(5, false);
  for (let k = 5; k >= 0 && short.length > 690; k--) short = shortText(k, true);
  const waText = waBrief() ? short : text;
  push(`🗑 Instagram temizliği bitti: ${igCounts(j)}${man.length ? ` — ${igWhy(j)}` : ""}`);
  if (notify) { try { await wa.send(waText); } catch { push("💬 Instagram temizliği özeti WhatsApp'a gönderilemedi (bağlı değil)"); } }
  return { ok: true, deleted: del, failed: fail, kept, manual: man, gone, unknown: j.unknown || [], unsupported: !!j.unsupported, verifyOnly: !!j.verifyOnly, via: j.via,
    text: notify ? text : waText };
}
// Otomatik Instagram temizliği (kullanıcı isteği, 17 Ekim: "5000 altında izlenen videoları otomatik silelim; sayıları panelde göreyim,
// değiştireyim, silinmeye adayları da göreyim"; kullanıcı kararı: yalnız Instagram, 72 saat bekleme). settings.igAutoClean
// {enabled, maxViews 5000, waitHours 72, maxAgeDays 30, everyHours 3, keep []}. Her `everyHours` saatte: izlenmeler 30 dk'dan eskiyse
// senkron → ig_cleanup.py --auto-plan → hazır olanlar --run (silmeden hemen önce güncel izlenme yeniden okunur, sınırı geçen bırakılır).
// API bu bağlantıyla silmiyorsa (Instagram Girişi) --run yalnız denetler: elle silinen kayıttan düşer, kalan "elle silinmeli" olur.
// Kayıt data/ig_autoclean.json; log 🗑 (çalışma başına tek özet); WhatsApp'a silinen sayısı, elle silinecekler yalnız listeye
// bildirilmemiş video girince (st.manualNotified, 24 saatte en çok bir kez), geçersiz bağlantı 24 saatte bir. Aynı listeyi yeniden
// denetleyen çalışma mesaj göndermez.
const igAutoCfg = () => ({ enabled: true, maxViews: 5000, waitHours: 72, maxAgeDays: 30, everyHours: 3, keep: [], ...(settings().igAutoClean || {}) });
const IG_AUTO_FILE = path.join(DATA, "ig_autoclean.json");
let igAutoBusy = false;
async function igAutoPlan({ sync = true } = {}) {
  const c = igAutoCfg();
  const m = readJson(path.join(DATA, "metrics.json"), {});
  if (sync && (!m.lastSync || Date.now() - Date.parse(m.lastSync) > 30 * 60000)) await execAction({ type: "sync_metrics" }).catch(() => {});
  return await pyJson(["scripts/ig_cleanup.py", "--auto-plan", "--max", String(Number(c.maxViews) || 5000), "--wait-hours", String(Number(c.waitHours) || 72),
    "--max-age-days", String(Number(c.maxAgeDays) || 30), "--keep", (c.keep || []).join(",")], 60000).catch((e) => ({ ok: false, error: e.message }));
}
async function igAutoRun({ manual = false } = {}) {
  if (igAutoBusy) return { ok: false, error: "Temizlik zaten sürüyor." };
  igAutoBusy = true;
  const st = readJson(IG_AUTO_FILE, {});
  try {
    const c = igAutoCfg();
    const p = await igAutoPlan();
    if (!p?.ok) { push(`🗑 otomatik Instagram temizliği: liste çıkarılamadı (${p?.error || "yanıt yok"})`); return { ok: false, error: p?.error || "liste çıkarılamadı" }; }
    st.lastCheck = Date.now();
    const names = (p.ready || []).map((x) => x.name);
    if (!names.length) { writeJson(IG_AUTO_FILE, st); if (manual) push("🗑 otomatik Instagram temizliği: silinecek video yok"); return { ok: true, deleted: [], failed: [], kept: [], manual: [], gone: [], unknown: [], plan: p }; }
    if (!(await igSupport()).known) push(`🗑 otomatik Instagram temizliği: ${names.length} video ${Number(c.maxViews).toLocaleString("tr-TR")} izlenmenin altında ve ${c.waitHours} saati geçti, siliniyor`);
    const r = await py("ig_cleanup.py", ["--run", "--names", names.join(","), "--max", String(Number(c.maxViews) || 5000)]);
    const j = igRunLog(r);
    if (!j.ok) { writeJson(IG_AUTO_FILE, st); const error = j.error || String(r.stderr || "yanıt yok").slice(-160); push(`🗑 otomatik Instagram temizliği çalışmadı: ${error}`); return { ok: false, error }; }
    const del = j.deleted || [], fail = j.failed || [], kept = j.kept || [], man = j.manual || [], gone = j.gone || [], unk = j.unknown || [];
    st.lastRun = Date.now(); st.runs = [...(st.runs || []).slice(-30), { at: Date.now(), deleted: del.length, failed: fail.length, kept: kept.length, manual: man.length, gone: gone.length, unknown: unk.length }];
    push(`🗑 otomatik Instagram temizliği ${j.verifyOnly ? "denetimi" : "bitti"}: ${igCounts(j)}${man.length ? ` — ${igWhy(j)}; liste panelde` : ""}`);
    const msg = [], told = new Set(st.manualNotified?.names || []), fresh = man.filter((x) => !told.has(x.name));
    if (del.length) msg.push(`🗑 Instagram: ${del.length} düşük izlenen video silindi (${Number(c.maxViews).toLocaleString("tr-TR")} altı, ${c.waitHours} saati geçmiş).`);
    const tellManual = fresh.length > 0 && Date.now() - (st.manualNotified?.at || 0) >= 24 * 3600000;
    if (tellManual) {
      const links = [...fresh, ...man.filter((x) => told.has(x.name))].filter((x) => x.url).slice(0, 5);
      msg.push(`🗑 Instagram: ${man.length} düşük izlenen video elle silinmeli${fresh.length < man.length ? ` (${fresh.length} yeni)` : ""}. ${igWhy(j)}.` +
        links.map((x) => `\n• ${x.url}`).join("") + "\nTamamı panelde: Ayarlar → Yayın hesapları → Instagram; elle sildikleriniz listeden kendiliğinden düşer." +
        `${j.unsupported ? `\n${igFix(j)}` : ""}\nOtomatik silmeyi kapatmak için *otomatik silmeyi kapat* yazın.`);
    }
    const tok = fail.find((x) => x.token), tellTok = !!tok && Date.now() - (st.tokenNotifiedAt || 0) >= 24 * 3600000;
    if (tellTok) msg.push(`⚠️ Instagram temizliği: ${tok.message}`);
    if (msg.length) {
      try {
        await wa.send(msg.join("\n\n"));
        if (tellManual) st.manualNotified = { at: Date.now(), names: [...new Set([...told, ...man.map((x) => x.name)])].slice(-300) };
        if (tellTok) st.tokenNotifiedAt = Date.now();
      } catch { /* WhatsApp bağlı değil: log yeterli, sonraki denetimde yeniden denenir */ }
    }
    writeJson(IG_AUTO_FILE, st);
    return { ok: true, deleted: del, failed: fail, kept, manual: man, gone, unknown: unk, unsupported: !!j.unsupported, verifyOnly: !!j.verifyOnly, via: j.via, plan: p };
  } finally { igAutoBusy = false; }
}
setInterval(() => {
  const c = igAutoCfg(); if (!c.enabled || igAutoBusy) return;
  const st = readJson(IG_AUTO_FILE, {});
  // ilk açılışta hemen silmez: 2 saat inceleme süresi (panelden "🛡 Koru" ile çıkarılabilir), sayı WhatsApp'a bir kez bildirilir
  if (!st.armedAt) {
    st.armedAt = Date.now(); writeJson(IG_AUTO_FILE, st);
    igAutoPlan().then(async (p) => { const k = (p?.ready || []).length; push(`🗑 otomatik Instagram temizliği açıldı: ilk silme 2 saat sonra${k ? ` (${k} video silinecek)` : ""}; panelden koruyabilirsiniz`);
      if (k) { try { await wa.send(`🗑 Otomatik Instagram temizliği açık: 2 saat sonra ${k} video silinecek (${Number(c.maxViews).toLocaleString("tr-TR")} izlenme altı, ${c.waitHours} saati geçmiş). Korumak istediğinizi panelde Ayarlar → Yayın hesapları → Instagram'dan "🛡 Koru" ile çıkarın.`); } catch { /* bağlı değil */ } } }).catch(() => {});
    return;
  }
  if (Date.now() - st.armedAt < 2 * 3600000) return;
  if (Date.now() - (st.lastCheck || 0) < Math.max(1, Number(c.everyHours) || 3) * 3600000) return;
  igAutoRun().catch((e) => push(`🗑 otomatik Instagram temizliği hatası: ${e.message}`));
}, 10 * 60000);
app.get("/api/igclean", async (req, res) => { const [p, support] = await Promise.all([igAutoPlan({ sync: req.query.sync === "1" }), igSupport()]); const st = readJson(IG_AUTO_FILE, {});
  const l = (st.runs || []).slice(-1)[0];
  res.json({ cfg: igAutoCfg(), plan: p, lastRun: st.lastRun || null, lastCheck: st.lastCheck || null, runs: (st.runs || []).slice(-5), busy: igAutoBusy, support,
    fix: igFix({ via: support?.viaName }, true),
    last: l ? { at: l.at, deleted: l.deleted || 0, manual: l.manual || 0, gone: l.gone || 0, failed: l.failed || 0, unknown: l.unknown || 0 } : null }); });
app.post("/api/igclean/run", async (_req, res) => res.json(await igAutoRun({ manual: true })));
app.post("/api/igclean/keep", (req, res) => {
  const name = String(req.body?.name || ""); if (!name) return res.json({ ok: false });
  const keep = new Set(igAutoCfg().keep || []); req.body?.keep === false ? keep.delete(name) : keep.add(name);
  patchSettings({ igAutoClean: { keep: [...keep] } }); push(`🛡 ${name} otomatik Instagram temizliğinden ${req.body?.keep === false ? "çıkarıldı (korunmuyor)" : "korunuyor"}`); res.json({ ok: true, keep: [...keep] });
});
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
app.get("/api/peak", async (req, res) => { const p = await peakHours(req.query.refresh === "1"); res.json({ cfg: { fixedHours: [20], ...peakCfg() }, plan: p, today: peakToday(), next: peakNext() }); });
app.post("/api/peak/run", async (_req, res) => res.json(await peakRemake({ manual: true })));
app.post("/api/anlik", async (req, res) => res.json(await prepareAnlik(req.body?.topic, req.body?.duration)));
app.get("/api/anlik", (_req, res) => res.json({ queue: anlikQueue, running: state.running }));

// ---------- Mynet manşet takibi: her N dakikada manşet alanı (6 haber) kontrol edilir; yeni giren haber için
// kaynak gösterilerek, kendi cümlelerimizle anlık (son dakika) video üretilir. Günlük üst sınır var (YouTube kotası).
const MYNET_DONE = path.join(DATA, "mynet_produced.json");
// Mynet ve son dakika siteleri AYNI aralıkla, AYNI taramada kontrol edilir (settings.watchIntervalMin, varsayılan 10 dk):
// aynı anda düşen değerli haberler tek partide toplanıp birleşik videoya girer (queueValuable).
const watchMin = () => Math.min(60, Math.max(3, Number(settings().watchIntervalMin) || 5)); // değerli haber kaçmasın: 5 dk
const mynetCfg = () => ({ enabled: true, maxPerDay: 3, valuableMaxPerDay: 15, duration: 30, onlyValuable: true, strictValuable: true, ...(settings().mynet || {}), intervalMin: watchMin() });
// Otomatik haber seviyesi (kullanıcı isteği, 23 Ekim: "gereksiz haberleri yapmayalım, denizde yunus balıkları göründü istemiyorum"; sondakika.com'daki
// onlyValuable/strictValuable kuralının aynısı Mynet manşeti ve son dakika siteleri için; varsayılan ⭐⭐ çok değerli): "all" her yeni haber,
// "valuable" news_value değerli, "strong" yalnız çok değerli (ulusal grup/kalıp, ölçek ya da iki değer ailesi). Elle üretim (kart düğmesi) hep geçer
const newsLevel = (c) => { const g = String(settings().newsLevel ?? "top"); return NEWS_LEVELS.includes(g) ? g : (c?.onlyValuable === false ? "all" : c?.strictValuable === false ? "valuable" : "strong"); };
// Otomatik haber düzeyi (kullanıcı isteği, 26 Ekim: "haber paylaşımında daha değerli olanları, en değerli olanları yakalamaya çalışalım";
// settings.newsLevel, varsayılan "top"): tüm otomatik kaynaklar (sondakika.com, Mynet, son dakika siteleri) için tek düzey — "top" ⭐⭐⭐ en
// değerli (news_value top: çok değerli + nedenlerin ağırlığı ≥ 3), "strong" ⭐⭐, "valuable" ⭐, "all" hepsi; başka değer ("source") kaynak
// kartlarındaki eski onlyValuable/strictValuable ayarı. Elle üretim hep geçer.
const NEWS_LEVELS = ["top", "strong", "valuable", "all"];
const levelName = (lvl) => (lvl === "top" ? "⭐⭐⭐ en değerli" : lvl === "strong" ? "⭐⭐ çok değerli" : "⭐ değerli");
const passesLevel = (lvl, it) => lvl === "all" || (lvl === "top" ? !!it?.top : lvl === "strong" ? !!it?.strong : !!it?.valuable);
const levelSkipWhy = (it) => (it?.strong ? `çok değerli ama en değerli değil (${it.strongReason || it.valueReason || ""})` : it?.valuable ? `değerli ama çok değerli değil (${it.valueReason || ""})` : "sıradan haber");
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
  // listede yalnız adres eşleşmesi atlanır: manşette özet yok, genel başlık ("Konya'da yolcu otobüsü devrildi") aynı ildeki başka olayı da
  // tutar; başlık eşleşmesine sayfa okununca (mynetStart) gövdeyle bakılır (kullanıcı isteği, 18 Ekim: "ürettiğimiz haberi tekrar yakalamayalım")
  if (!manual && item?.dup && item.dupInfo?.reason === "aynı haber adresi") { push(`📰 Mynet: "${(item.title || "").slice(0, 70)}" atlandı — ${dupWhy(item.dupInfo)}`); return { ok: false, error: "aynı haber zaten üretildi" }; }
  // yalnız (çok) değerli manşetler (mynet.onlyValuable/strictValuable): sıradan ya da yalnız değerli manşet üretilmez, kartta 🎬 ile elle üretilebilir
  if (!manual && !passesLevel(newsLevel(c), item)) { push(`📰 Mynet: manşet atlandı — ${levelSkipWhy(item)}; yalnız ${levelName(newsLevel(c))} manşetler üretiliyor (kartta elle üretilebilir): "${(item?.title || "").slice(0, 70)}"`); return { ok: false, error: `yalnız ${levelName(newsLevel(c))} manşetler üretiliyor` }; }
  if (!manual && !item?.valuable && resting()) { push(`⏸ sistem durduruldu: sıradan Mynet manşeti için video üretilmedi (${(item?.title || "").slice(0, 70)}); değerli haber gelirse sistem kendiliğinden başlar`); return { ok: false, resting: true, error: "dinlenmede" }; }
  if (item?.valuable) push(`${item.strong ? "⭐⭐" : "⭐"} Mynet: ${item.strong ? "çok değerli" : "değerli"} manşet (${item.strong && item.strongReason ? item.strongReason : item.valueReason}) — video YouTube'a da gidecek`);
  return inflight(item?.title || url, (tok) => mynetStart(url, { manual, item, day, list, done, tok }), { sourceCount: item?.sources?.length || 1 });
}
async function mynetStart(url, { manual, item, day, list, done, tok }) {
  const a = await pyJson(["scripts/mynet_watch.py", "--article", url]);
  if (!a || a.ok === false || !a.title) { push(`📰 Mynet: haber okunamadı (${a?.error || "başlık yok"})`); return { ok: false, error: a?.error || "haber okunamadı" }; }
  tok.title = a.title;
  // sayfa okununca hafızaya başlık + açıklama + gövde + adresle yeniden bakılır (manşet başlığı başka sözlerle yazılmış olabilir)
  if (!manual && a.dup) { push(`📰 Mynet: "${a.title.slice(0, 70)}" atlandı — ${dupWhy(a.dupInfo)}`); return { ok: false, error: "aynı haber zaten üretildi" }; }
  if (manual && a.dup) push(`📰 Mynet (elle): "${a.title.slice(0, 70)}" — ${dupWhy(a.dupInfo)}; elle istendiği için yine üretiliyor`);
  const topic = [a.title, a.description, a.body].filter(Boolean).join(". ").replace(/\.\s*\./g, ".").slice(0, 1500);
  const markDone = () => { const d = mynetDone(); d[day] = [...(d[day] || []), url]; for (const k of Object.keys(d)) if (k < new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10)) delete d[k]; writeFileSync(MYNET_DONE, JSON.stringify(d, null, 2)); };
  if (!manual && item?.valuable) { // değerli otomatik manşet: aynı anda düşenlerle birleşebilsin diye toplayıcıya
    anlikInflight.delete(tok); // artık toplayıcıda (kendi yoldaki kaydıyla "aynı olay" sayılmasın)
    const text = [a.description, a.body].filter(Boolean).join(". ").slice(0, 1400);
    queueValuable({ title: a.title, text, source: "Mynet", url, sourceCount: item?.sources?.length || 1, duration: mynetCfg().duration,
      onStarted: async (r) => { if (r.ok) { if (!r.merged) await pyJson(["scripts/breaking_watch.py", "--mark", a.title, "--url", url, "--text", text]).catch(() => {}); markDone(); } } });
    return { ok: true, batched: true, title: a.title };
  }
  if (!manual && anlikBusyWith(a.title, tok)) { push(`📰 Mynet: "${a.title.slice(0, 70)}" atlandı — aynı olay zaten üretimde ya da sırada`); return { ok: false, error: "aynı olay zaten üretimde ya da sırada" }; }
  tok.firm = true; // kendi denetimleri geçti: bundan sonra aynı olay buna yol verir
  push(`📰 Mynet: yeni manşet: ${a.title.slice(0, 90)} → video üretiliyor`);
  const src = await allSources(a.title, url, "Mynet");
  if (!manual && anlikBusyWith(a.title, tok)) { push(`📰 Mynet: "${a.title.slice(0, 70)}" atlandı — aynı olay bu sırada başka kaynaktan üretime alındı`); return { ok: false, error: "aynı olay zaten üretimde ya da sırada" }; }
  const r = startAnlik(topic, mynetCfg().duration, { source: "Mynet", url, sourceCount: tok.item.sourceCount, pages: src.pages, related: src.related, title: a.title, auto: !manual });
  anlikInflight.delete(tok); // sırada ya da üretimde (araya await girmeden)
  if (r.ok) await pyJson(["scripts/breaking_watch.py", "--mark", a.title, "--url", url, "--text", topic]).catch(() => {}); // işaret metinle: başka sözlerle de tanınsın
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
  for (const it of [...(r.new || [])].sort((a, b) => ((b.strong ? 2 : 0) + (b.valuable ? 1 : 0)) - ((a.strong ? 2 : 0) + (a.valuable ? 1 : 0)))) await mynetProduce(it.url, { item: it });
  return r;
}
app.get("/api/mynet", (_req, res) => { const st = readJson(path.join(DATA, "mynet_state.json"), {}); res.json({ ...mynetCfg(), items: st.items || [], lastCheck: st.lastCheck || null, producedToday: (mynetDone()[today()] || []), nextCheckIn: mynetCfg().enabled ? Math.max(0, watchLast + watchMin() * 60000 - Date.now()) : null }); });
app.post("/api/mynet/check", async (_req, res) => res.json(await mynetCheck({ manual: true })));
app.post("/api/mynet/produce", async (req, res) => res.json(await mynetProduce(String(req.body?.url || ""), { manual: true })));
app.post("/api/mynet/produce-all", async (_req, res) => { const st = readJson(path.join(DATA, "mynet_state.json"), {}); const out = []; for (const it of st.items || []) out.push(await mynetProduce(it.url, { manual: true })); res.json({ ok: true, results: out }); });

// ---------- çoklu son dakika takibi (scripts/breaking_watch.py): Hürriyet, Sözcü, NTV, AA, Habertürk son dakika akışları.
// Değerli ya da 3+ sitede çıkan YENİ olay → anlık video (kaynak: ilk veren site). Günlük sınır breaking.maxPerDay.
const BREAKING_DONE = path.join(DATA, "breaking_daily.json");
const breakingCfg = () => ({ enabled: true, maxPerDay: 4, valuableMaxPerDay: 15, duration: 30, onlyValuable: true, strictValuable: true, ...(settings().breaking || {}), intervalMin: watchMin() });
let breakingLast = 0;
async function breakingCheck({ manual = false } = {}) {
  breakingLast = Date.now();
  const r = await pyJson(["scripts/breaking_watch.py", "--check"]);
  if (!r?.ok) { push(`🗞 son dakika takibi başarısız: ${r?.error || "?"}`); return r || { ok: false }; }
  const bad = Object.entries(r.sources || {}).filter(([, v]) => !v.ok).map(([k]) => k);
  if (manual || r.candidates?.length || bad.length) push(`🗞 son dakika kaynakları kontrol edildi: ${r.fresh} yeni haber, ${r.candidates.length} video adayı${bad.length ? ` · ulaşılamayan: ${bad.join(", ")}` : ""}`);
  for (const d of (r.dups || []).slice(0, 3)) push(`🗞 son dakika: "${String(d.title).slice(0, 70)}" (${d.source}) atlandı — ${dupWhy(d)}`); // videosu üretilmiş haber aday olmadı
  const done = readJson(BREAKING_DONE, {}); const day = today(); const list = done[day] || [];
  const lvl = newsLevel(breakingCfg());
  for (const c of r.candidates || []) {
    // yalnız (çok) değerli haberler (breaking.onlyValuable/strictValuable): 3+ sitede çıkan sıradan olay ya da yalnız değerli haber üretilmez
    if (!passesLevel(lvl, c)) { push(`🗞 son dakika: "${c.title.slice(0, 70)}" atlandı — ${levelSkipWhy(c)}${c.count > 1 ? ` (${c.count} kaynakta)` : ""}; yalnız ${levelName(lvl)} haberler üretiliyor (kartta elle üretilebilir)`); continue; }
    // sıradan (çok kaynaklı) adaylar günde maxPerDay (4); değerli haberler ayrı ve yüksek sınır (15): değerli haber kaçmasın
    const cap = c.valuable ? Number(breakingCfg().valuableMaxPerDay) : Number(breakingCfg().maxPerDay);
    if (list.length >= cap) { push(`🗞 günlük ${c.valuable ? "değerli " : ""}son dakika sınırı (${cap}) doldu: "${c.title.slice(0, 70)}" atlandı`); continue; }
    const tok = { title: c.title, firm: false, item: { sourceCount: c.count || 1 } }; anlikInflight.add(tok); // sayfası ve diğer siteleri okunurken yolda (finishProduction, aynı olay)
    try {
      const a = c.url ? await pyJson(["scripts/mynet_watch.py", "--article", c.url]) : null;
      // sayfa okununca başlık + açıklama + gövde + adresle hafızaya yeniden bakılır (--check yalnız adres eşleşmesini düşürür, başlık +
      // özet eşleşmesi c.dup'ta kalır); sayfa okunamazsa --check'in başlık + özet kararı geçerli
      const read = !!(a && a.ok !== false && a.title);
      if (read ? a.dup : c.dup) { push(`🗞 son dakika: "${c.title.slice(0, 70)}" atlandı — ${dupWhy(read ? a.dupInfo : c.dupInfo)}`); continue; }
      const topic = [c.title, a?.ok !== false && a?.description, a?.ok !== false && a?.body || c.summary].filter(Boolean).join(". ").replace(/\.\s*\./g, ".").slice(0, 1500);
      push(`${c.strong ? "⭐⭐" : c.valuable ? "⭐" : "🗞"} son dakika: ${c.title.slice(0, 90)} (${c.sources.join(", ")}; ${c.strong && c.strongReason ? c.strongReason : c.valueReason}) → video üretiliyor`);
      if (c.valuable) { // değerli: toplayıcıya (aynı anda düşen Mynet/son dakika haberleriyle tek video, dinlenmeyi bozar)
        anlikInflight.delete(tok); // artık toplayıcıda (kendi yoldaki kaydıyla "aynı olay" sayılmasın)
        list.push(c.title);
        const text = [a?.ok !== false && a?.description, (a?.ok !== false && a?.body) || c.summary].filter(Boolean).join(". ").slice(0, 1400);
        queueValuable({ title: c.title, text, source: c.source, url: c.url, sourceCount: c.count, duration: breakingCfg().duration,
          onStarted: async (r) => { if (r.ok && !r.merged) await pyJson(["scripts/breaking_watch.py", "--mark", c.title, ...(c.url ? ["--url", c.url] : []), "--text", text]).catch(() => {}); } });
        done[day] = list; writeJson(BREAKING_DONE, Object.fromEntries(Object.entries(done).filter(([d]) => d >= new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10))));
        continue;
      }
      if (resting()) { push(`⏸ sistem durduruldu: "${c.title.slice(0, 70)}" için video üretilmedi (değerli değil; kartta 🎬 Video üret ile elle üretebilirsiniz)`); continue; }
      if (anlikBusyWith(c.title, tok)) { push(`🗞 son dakika: "${c.title.slice(0, 70)}" atlandı — aynı olay zaten üretimde ya da sırada`); continue; }
      tok.firm = true; // kendi denetimleri geçti
      const src = await allSources(c.title, c.url, c.source);
      if (anlikBusyWith(c.title, tok)) { push(`🗞 son dakika: "${c.title.slice(0, 70)}" atlandı — aynı olay bu sırada başka kaynaktan üretime alındı`); continue; }
      const res = startAnlik(topic, breakingCfg().duration, { source: c.source, url: c.url, sourceCount: tok.item.sourceCount, pages: src.pages, related: src.related, title: c.title, auto: true });
      anlikInflight.delete(tok); // sırada ya da üretimde (araya await girmeden)
      if (res.ok) { await pyJson(["scripts/breaking_watch.py", "--mark", c.title, ...(c.url ? ["--url", c.url] : []), "--text", topic]).catch(() => {}); list.push(c.title); done[day] = list; writeJson(BREAKING_DONE, Object.fromEntries(Object.entries(done).filter(([d]) => d >= new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10)))); }
    } finally { anlikInflight.delete(tok); restRecheck(); }
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
setInterval(() => { if ((mynetCfg().enabled || breakingCfg().enabled) && !sondakikaBusy && Date.now() - watchLast >= watchMin() * 60000) watchScan(); }, 60000); // sondakika.com taraması sürerken bekler
app.get("/api/breaking", async (_req, res) => { const l = await pyJson(["scripts/breaking_watch.py", "--list"]); res.json({ ...breakingCfg(), ...(l || {}), trends: (readJson(path.join(DATA, "trends.json"), {}).items || []).slice(0, 10), producedToday: readJson(BREAKING_DONE, {})[today()] || [], nextCheckIn: breakingCfg().enabled ? Math.max(0, watchLast + watchMin() * 60000 - Date.now()) : null }); });
app.post("/api/breaking/check", async (_req, res) => res.json(await breakingCheck({ manual: true })));
// Paneldeki "🎬 Video üret": son haberlerden seçilen için otomatik adayla aynı yol (haber sayfası okunur, anlık video,
// bağlı hesaplara anlikAutoPublish kuralıyla yayın). Elle üretim günlük sınıra takılmaz; haberin videosu üretilmişse
// (üretilen haber hafızası, settings.dedup.hours) düğme "✓ Üretildi" olur, onaylanırsa force ile yine üretilir.
app.post("/api/breaking/produce", async (req, res) => {
  const link = String(req.body?.link || "");
  const f = await pyJson(["scripts/breaking_watch.py", "--item", link]);
  if (!f?.ok) return res.json({ ok: false, error: f?.error || "haber bulunamadı" });
  const c = f.item;
  if (c.produced && !req.body?.force) return res.json({ ok: false, produced: true, error: `${dupWhy(c.producedInfo).replace(/^b/, "B")}.` });
  if (c.produced) push(`🎬 son dakika (elle): "${c.title.slice(0, 70)}" — ${dupWhy(c.producedInfo)}; onaylandığı için yine üretiliyor`);
  const a = c.link ? await pyJson(["scripts/mynet_watch.py", "--article", c.link]) : null;
  const topic = [c.title, a?.ok !== false && a?.description, (a?.ok !== false && a?.body) || c.summary].filter(Boolean).join(". ").replace(/\.\s*\./g, ".").slice(0, 1500);
  push(`🎬 son dakika (elle): ${c.title.slice(0, 90)} (${(c.sources || [c.source]).join(", ")}) → video üretiliyor`);
  const r = await inflight(c.title, async (tok) => {
    const src = await allSources(c.title, c.link, c.source);
    return startAnlik(topic, breakingCfg().duration, { source: c.source, url: c.link, sourceCount: tok.item.sourceCount, pages: src.pages, related: src.related, title: c.title });
  }, { firm: true, sourceCount: (c.sources || []).length || 1 });
  if (r.ok) await pyJson(["scripts/breaking_watch.py", "--mark", c.title, ...(c.link ? ["--url", c.link] : []), "--text", topic]).catch(() => {});
  res.json({ ...r, title: c.title });
});

// ---------- sondakika.com takibi (kullanıcı isteği, 17 Ekim: "5 dk'da bir kontrol edelim, düşen haberleri anında son dakika olarak
// onaysız yayınlayalım"; scripts/sondakika_watch.py: RSS → son dakika sayfası + ana sayfa). Ortak watchScan'den ayrı kendi
// zamanlayıcısı (her dakika bakılır, intervalMin dolunca tarama: 5 dk garanti) ve kendi busy bayrağı (iki tarama birbirini ezmesin).
// Her YENİ haber, değerli olsun olmasın, hemen tek konulu anlık video olur (üretim sonrası dinlenmedeyse uyandırır; elle "⏸ Tüm sistemi
// durdur" yapıldıysa yalnız değerli haber uyandırır). Atlanır ve loglanır: haberin videosu üretildi (dup: üretilen haber hafızası,
// settings.dedup.hours; --check'te başlık + açıklama + adres, sayfa okununca gövdeyle yeniden), günlük sınır (maxPerDay), tarama
// başına sınır (maxPerCheck), anlık sırası maxQueue'ya ulaştı (birikmiş haber bayatlamasın), yayın zamanı (sayfadaki, yoksa
// akıştaki) maxAgeHours'tan eski, aynı olay şu an üretimde/sırada/toplayıcıda.
// Değerli haber (kullanıcı isteği, 20 Ekim: "haber sınırını kaldır, değerlileri yakala"; settings.sondakika.valuableUnlimited, varsayılan
// açık): --check (başlık + akış açıklaması) ya da sayfa (--article: başlık + açıklama + gövdenin ilk cümlesi) değerli derse günlük,
// tarama başına ve sıra sınırına takılmaz, sayaca girmez (günlük kayıtta valuable), yaş sınırı valuableMaxAgeHours; taramada önce
// değerliler, sırada sıradan otomatik işlerin önüne (startAnlik priority). --check'te sıradan görünen haber sınıra takılacaksa önce
// sayfası okunur (gövdeyle değerli çıkabilir). Tekrar, aynı olay ve elle durdurma kuralları değişmedi. Kapalıysa eski davranış.
// Yalnız değerli haberler (kullanıcı isteği, 22 Ekim: "sondakika.com'daki değerli haberleri seçelim, saçma sapan her haberi basıyoruz ve
// Instagram 'too many actions' hatası veriyor"; settings.sondakika.onlyValuable, varsayılan açık): sıradan görünen haber sınıra takılmasa da
// otomatik üretilmez; önce sayfası okunur (gövdenin ilk cümlesiyle değerli çıkabilir), gövdeyle de sıradansa "sıradan haber; yalnız ⭐ değerli
// haberler üretiliyor" diye atlanır. Elle (kartta 🎬 Video üret) yine üretilir. Kapalıysa eski kural: her yeni haber (günlük sınırla).
// Yalnız ÇOK değerli (kullanıcı kararı, 23 Ekim: "sadece çok değerli, kıymetli haberleri çekelim"; settings.sondakika.strictValuable,
// varsayılan açık, onlyValuable açıkken geçerli): news_value "strong" (ulusal grup, ulusal kalıp, ölçek ya da iki değer ailesi) olmayan
// haber — sıradan da, "değerli ama çok değerli değil" de — otomatik üretilmez; sayfası okunur (ilk cümlesi çok değerli çıkabilir).
// Ortak tarama (Mynet + son dakika siteleri) ile sırayla çalışır: biri sürerken diğeri bekler, aynı olay iki kez üretilmesin.
// Yayın anlikAutoPublish ile bağlı tüm hesaplara onaysız.
const SONDAKIKA_DONE = path.join(DATA, "sondakika_daily.json");     // {gün: [{url, title, at, manual, valuable}]}
const SONDAKIKA_STATUS = path.join(DATA, "sondakika_status.json");  // {url: {state, why, at, valuable, valueReason}} — panelde haberin üretildi/sırada/atlandı durumu
const sondakikaCfg = () => ({ enabled: true, intervalMin: 5, maxPerCheck: 3, maxPerDay: 40, maxQueue: 6, duration: 30, maxAgeHours: 3, valuableUnlimited: true, valuableMaxAgeHours: 12, onlyValuable: true, strictValuable: true, ...(settings().sondakika || {}) });
const sondakikaEvery = () => Math.min(60, Math.max(2, Number(sondakikaCfg().intervalMin) || 5));
const sondakikaDone = () => readJson(SONDAKIKA_DONE, {});
function sondakikaMark(url, state, why = "", extra = {}) {
  // sayfa okununca bulunan değer sonraki yazımlarda kalır (kuyruktan başlayınca, sıradan çıkınca ⭐ kaybolmasın)
  const s = readJson(SONDAKIKA_STATUS, {}), old = s[url] || {};
  s[url] = { ...(old.valuable ? { valuable: true, valueReason: old.valueReason, ...(old.strong ? { strong: true, strongReason: old.strongReason } : {}) } : {}), ...extra, state, why, at: Date.now() };
  writeJson(SONDAKIKA_STATUS, Object.fromEntries(Object.entries(s).sort((a, b) => b[1].at - a[1].at).slice(0, 100)));
}
// Sıradaki iş iptal edildi, atlandı ya da başlatılamadı (video yapılmadı): panelin üretime alırken yazdığı işaretler
// (breaking_produced.json, kind "mark"; başlık + iş sıraya girdikten sonra yazılmış) silinir ki o haber hiçbir kaynaktan engellenmesin
// (kullanıcı isteği, 18 Ekim: "ürettiğimiz haberi tekrar yakalamayalım"; silinmese de MARK_H = 3 saat sonra sayılmaz)
function unmarkQueued(q, titles = anlikTitles(q)) {
  const key = (t) => String(t || "").slice(0, 160);
  const want = new Set(titles.map(key).filter(Boolean)), since = (q.at || 0) - 5000;
  const P = path.join(DATA, "breaking_produced.json"), rows = readJson(P, []);
  if (!want.size || !Array.isArray(rows)) return;
  const keep = rows.filter((p) => !(p && p.kind === "mark" && want.has(key(p.title)) && Number(p.at) * 1000 >= since));
  if (keep.length !== rows.length) writeJson(P, keep);
}
// Sırada beklerken iptal edilen (⏸ durdur / ⏹ hepsini durdur) ya da başlatılamayan haber: video yapılmadı; panelde "atlandı",
// günlük kayıttan ve üretime alınış işaretinden (breaking_produced.json, kind "mark") çıkarılır ki hiçbir kaynaktan engellenmesin
function sondakikaUnqueue(q, why = "sistem durduruldu, sıradaki iş iptal edildi") {
  const url = q.opts.sondakika, title = String(q.opts.title || ""), since = (q.at || 0) - 5000;
  sondakikaMark(url, "atlandı", why);
  const d = sondakikaDone(); for (const k of Object.keys(d)) d[k] = (d[k] || []).filter((x) => !(x.url === url && x.at >= since)); writeJson(SONDAKIKA_DONE, d);
  unmarkQueued(q, [title]);
  push(`🔴 sondakika.com: "${(title || url).slice(0, 70)}" sıradan çıkarıldı — ${why}`);
}
// Aynı olay şu an üretimde, anlık sırada ya da değerli haber toplayıcısında mı (başlık ile başlık): Mynet ya da son dakika siteleri
// aynı olayın videosunu saniyeler önce başlatmış olabilir (işaretleri --check'ten sonra yazılır)
// ya da yolda (kendi denetimlerini geçmiş, sayfası/diğer siteleri okunuyor; `self` kendi kaydı, sayılmaz)
const anlikBusyWith = (t, self = null) => valueBatch.some((x) => sameEvent(x.title, t)) || anlikQueue.some((q) => anlikTitles(q).some((x) => sameEvent(x, t)))
  || [...anlikInflight].some((x) => x !== self && x.firm && sameEvent(x.title, t))
  || (!!anlikNow && state.running && anlikNow.at === state.startedAt && anlikNow.titles.some((x) => sameEvent(x, t)));
let sondakikaBusy = false, sondakikaLast = 0, sondakikaFail = null; // {since, n, last}: art arda başarısız taramalar (log boğulmasın, 30 dk sonra sağlık uyarısı)
// Tek haber: sayfa okunur (başlık + açıklama + gövde, yayın zamanı, sayfada video var mı), anlık video başlar, aynı olay işaretlenir.
// Elle (panel "🎬 Video üret") günlük sınıra ve sıra sınırına takılmaz, sayaca girmez; aynı haber günde bir (force ile yine).
// limit: sondakikaCheck'in tarama başına sınırı ({why, note}); held: değerli habere uygulanmayan sınır ya da elle durdurma;
// peek: sınıra takılan sıradan haberin sayfasına bakılabilir mi (taramanın sayfa okuma bütçesi). Sınıra ya da elle durdurmaya takılıp
// sayfası okunan ama üretilmeyen haberin (sıradan çıktı, okunamadı, tekrar, bayat, aynı olay) sonucu peeked taşır; akıştaki yayın
// zamanı valuableMaxAgeHours'tan eski sıradan haberin sayfası hiç okunmaz (değerli çıksa da bayat).
// yalnız (çok) değerli kuralı: strict'te news_value "strong", değilse "valuable" gerekir; atlama nedeni panelde ve logda
const sondakikaLvl = (l) => (l === true ? "strong" : l === false ? "valuable" : l); // eski çağrı biçimi (strict true/false) da geçer
const sondakikaQual = (x, lvl) => passesLevel(sondakikaLvl(lvl), x);
function sondakikaOnlyHold(x, lvl) {
  lvl = sondakikaLvl(lvl);
  const hand = " (kartta 🎬 Video üret ile elle üretilebilir)", name = levelName(lvl), bare = name.replace(/^⭐+ /, "");
  if (lvl === "top" && x?.strong) return { why: `çok değerli ama en değerli değil (${x.strongReason || x.valueReason || ""}); yalnız ${name} haberler üretiliyor${hand}`, note: `çok değerli ama en değerli değil: yalnız ${bare} haberler üretiliyor` };
  if (lvl !== "valuable" && x?.valuable) return { why: `değerli ama çok değerli değil (${x.valueReason || ""}); yalnız ${name} haberler üretiliyor${hand}`, note: `değerli ama çok değerli değil: yalnız ${bare} haberler üretiliyor` };
  return { why: `sıradan haber; yalnız ${name} haberler üretiliyor${hand}`, note: `sıradan: yalnız ${bare} haberler üretiliyor` };
}
async function sondakikaProduce(url, { manual = false, force = false, item = null, limit = null, peek = true } = {}) {
  url = String(url || "").trim();
  if (!/^https?:\/\//i.test(url)) return { ok: false, error: "Haber adresi yok." };
  const c = sondakikaCfg(), day = today(), list = sondakikaDone()[day] || [];
  const skip = (why, title = item?.title || url, note = why, extra = {}) => { sondakikaMark(url, "atlandı", note, extra); push(`🔴 sondakika.com: "${String(title).slice(0, 70)}" atlandı — ${why}`); return { ok: false, skipped: true, error: why }; };
  const fail = (error) => { push(`🔴 sondakika.com (elle): ${error} — ${url}`); return { ok: false, error }; }; // elle yolda da her sonuç loglanır
  if (list.some((x) => x.url === url) && !force) { push(`🔴 sondakika.com${manual ? " (elle)" : ""}: "${String(item?.title || url).slice(0, 70)}" için bugün zaten video üretildi`); return { ok: false, produced: true, error: "Bu haber için bugün zaten video üretildi." }; }
  const stopWhy = "sistem elle durduruldu, yalnız değerli haber uyandırır (kartta 🎬 Video üret ile elle üretilebilir)";
  let held = null;
  if (!manual) {
    if (item?.dup && item.dupInfo?.reason === "aynı haber adresi") return skip(dupWhy(item.dupInfo)); // başlık/açıklama eşleşmesine sayfa okununca gövdeyle bakılır
    // değerli haber sınırsız (valuableUnlimited): sayaca girmez; --check'te sıradan görünen haber sınıra takılacaksa sayfası okunur,
    // gövdeyle de sıradansa aynı satırla atlanır. Kapalıysa eski kural: sınır her habere, sayfa okunmadan.
    const pubH = item?.published ? (Date.now() - Date.parse(item.published)) / 3600000 : 0;
    const lvl = newsLevel(c), vip = c.valuableUnlimited !== false, only = lvl !== "all", strict = lvl === "strong" || lvl === "top", fresh = !(pubH > Number(c.valuableMaxAgeHours));
    const autoCount = list.filter((x) => !x.manual && !(vip && x.valuable)).length;
    held = limit || (autoCount >= Number(c.maxPerDay) ? { why: `günlük sınır (${c.maxPerDay}) doldu` }
      : anlikQueue.length >= Number(c.maxQueue) ? { why: `anlık sırada ${anlikQueue.length} iş bekliyor (en çok ${c.maxQueue}), haber bayatlamasın diye` } : null);
    // yalnız (çok) değerli haberler (onlyValuable / strictValuable): sıradan — ya da çok değerli olmayan — haber sınıra takılmasa da üretilmez;
    // sayfası okunur, gövdeyle de yetmezse atlanır. Bu kural sınırlardan önce gelir (sınır satırı yerine nedeni yazılır)
    if (only && !sondakikaQual(item, lvl)) held = { ...sondakikaOnlyHold(item, lvl), only: true, strict, lvl };
    // sayfaya bakılır mı: sınıra takılan haberde yalnız değerli sınırsızken (gövdeyle değerli çıkabilir), yalnız-değerli kuralına takılan haberde her zaman
    const look = peek && fresh && (vip || !!held?.only);
    if (held && !(look || (vip && item?.valuable && !held.only))) return skip(held.why, undefined, held.note);
    // elle "⏸ Tüm sistemi durdur" (ısınma) sürerken sıradan haber sistemi uyandırmaz; değerli haber uyandırır (toplayıcıyla aynı kural).
    // Üretim sonrası kendiliğinden dinlenmede her yeni haber uyandırır (kullanıcı "anında" dedi).
    if (!held && resting() && restInfo().reason === "elle durduruldu" && !item?.valuable) {
      if (!look) return skip(stopWhy);
      held = { why: stopWhy, stop: true };
    }
  }
  const res = await inflight(item?.title || url, (tok) => sondakikaStart(url, { manual, item, c, day, skip, fail, tok, held, stopWhy }), { sourceCount: item?.sources?.length || 1 });
  return held && !res.ok ? { ...res, peeked: true } : res; // boşa okuma: taramanın sayfa okuma bütçesinden düşer
}
async function sondakikaStart(url, { manual, item, c, day, skip, fail, tok, held = null, stopWhy }) {
  const a = await pyJson(["scripts/sondakika_watch.py", "--article", url], 60000);
  if (a?.title) tok.title = a.title;
  if (!a || a.ok === false || !a.title) return manual ? fail(`Haber sayfası okunamadı (${a?.error || "başlık yok"}).`) : held && !item?.valuable ? skip(held.why, undefined, held.note) : skip(`haber sayfası okunamadı (${a?.error || "başlık yok"})`);
  // değerli: --check ya da sayfa (başlık + açıklama + gövdenin ilk cümlesi) öyle derse
  const vip = !manual && c.valuableUnlimited !== false, valuable = !!(item?.valuable || a.valuable), strong = !!(item?.strong || a.strong), top = !!(item?.top || a.top);
  const val = valuable ? { valuable: true, valueReason: item?.valuable ? item.valueReason : `${a.valueReason}; haber metninden`,
    ...(strong ? { strong: true, strongReason: item?.strong ? item.strongReason : `${a.strongReason}; haber metninden` } : {}),
    ...(top ? { top: true, topReason: item?.top ? item.topReason : `${a.topReason}; haber metninden` } : {}) } : {};
  // yalnız (çok / en) değerli kuralı: gövdeyle de yetmiyorsa atlanır (gövdeyle değerli çıkıp çok değerli çıkmayan haber nedeniyle)
  if (held?.only && !sondakikaQual({ valuable, strong, top }, held.lvl || held.strict)) { const h = sondakikaOnlyHold({ valuable, strong, top, valueReason: val.valueReason, strongReason: val.strongReason }, held.lvl || held.strict); return skip(h.why, a.title, h.note, val); }
  if (held && !held.only && !valuable) return skip(held.why, a.title, held.note); // sıradan haber: sınır ya da elle durdurma (eski satır)
  if (!manual && a.dup) return skip(dupWhy(a.dupInfo), a.title, undefined, val); // --check'ten bu yana başka kaynak üretmiş olabilir; gövdeyle yeniden bakıldı
  if (manual && a.dup) push(`🔴 sondakika.com (elle): "${a.title.slice(0, 70)}" — ${dupWhy(a.dupInfo)}; elle istendiği için yine üretiliyor`);
  const pub = a.published || item?.published; // sayfada yayın zamanı yoksa akıştaki (RSS pubDate)
  const ageH = pub ? (Date.now() - Date.parse(pub)) / 3600000 : 0;
  if (!manual && ageH > Number(vip && valuable ? c.valuableMaxAgeHours : c.maxAgeHours)) return skip(`haber ${Math.round(ageH)} saat önce yayınlanmış (bayat)`, a.title, undefined, val);
  if (!manual && anlikBusyWith(a.title, tok)) return skip("aynı olay zaten üretimde ya da sırada", a.title, undefined, val);
  tok.firm = true; // kendi denetimleri (okuma, tekrar, bayat, meşgul) geçti: bundan sonra aynı olay buna yol verir
  const topic = [a.title, a.description, a.body].filter(Boolean).join(". ").replace(/\.\s*\./g, ".").slice(0, 1500);
  // kaynak: makalenin site adı (og:site_name); boş, uzun ya da genel "Son Dakika" ise Sondakika.com
  const source = a.site && a.site.length <= 30 && !/^son ?dakika( haber(ler)?i?)?$/i.test(a.site.trim()) ? a.site.trim() : "Sondakika.com";
  // sayfa okunurken elle "⏸ Tüm sistemi durdur" basıldıysa sıradan haber uyandırmaz (sondakikaProduce'daki kural; kapalıyken --check değeri)
  if (!manual && resting() && restInfo().reason === "elle durduruldu" && !(vip ? valuable : item?.valuable)) return skip(stopWhy, a.title, undefined, val);
  if (!manual && resting()) restEnd(`sondakika.com'da yeni haber: ${a.title.slice(0, 60)}`); // kullanıcı "anında" dedi: dinlenme beklenmez
  push(`🔴 sondakika.com${manual ? " (elle)" : ": yeni haber"}: ${a.title.slice(0, 90)}${a.video ? " (haber sayfasında video var)" : ""} → video üretiliyor`);
  // title: aynı olay denetimi başlıkla yapılsın; sondakika: sıradan çıkınca/iptalde panel durumu güncellensin
  const src = await allSources(a.title, url, source); // haberin tüm kaynakları: bilgi + video + farklı fotoğraflar
  if (!manual && anlikBusyWith(a.title, tok)) return skip("aynı olay bu sırada başka kaynaktan üretime alındı", a.title, undefined, val);
  // değerli otomatik haber sırada sıradan otomatik işlerin önüne geçer; bir sınır atlatacakken üretildiyse loga yazılır
  const prio = vip && valuable, over = held && !held.stop ? (held.only ? (item?.valuable ? "başlıkta çok değerli görünmüyordu, metninden çok değerli çıktı" : `başlıkta sıradan görünüyordu, metninden ${held.strict ? "çok " : ""}değerli çıktı`) : held.why) : prio && ageH > Number(c.maxAgeHours) ? `haber ${Math.round(ageH)} saat önce yayınlanmış` : "";
  const star = held?.lvl === "top" && val.top ? `⭐⭐⭐ en değerli haber (${val.topReason})` : held?.strict && val.strong ? `⭐⭐ çok değerli haber (${val.strongReason})` : `⭐ değerli haber (${val.valueReason})`;
  if (prio && over) push(`🔴 sondakika.com: ${star} → sınırsız, öne alındı: "${a.title.slice(0, 70)}" — ${over}`);
  const r = startAnlik(topic, c.duration, { source, url, pages: src.pages, related: src.related, sourceCount: tok.item.sourceCount, auto: !manual, title: a.title, sondakika: url, ...(prio ? { priority: true } : {}) });
  anlikInflight.delete(tok); // sırada ya da üretimde (araya await girmeden)
  if (r.ok) {
    await pyJson(["scripts/breaking_watch.py", "--mark", a.title, "--url", url, "--text", topic]).catch(() => {}); // Mynet/son dakika siteleri aynı haberi tekrar üretmesin
    const d = sondakikaDone(); d[day] = [...(d[day] || []), { url, title: a.title, at: Date.now(), manual, ...(valuable ? { valuable: true } : {}) }];
    const cut = new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10);
    writeJson(SONDAKIKA_DONE, Object.fromEntries(Object.entries(d).filter(([k]) => k >= cut)));
    sondakikaMark(url, r.queued ? "sırada" : "üretildi", r.queued ? `${r.position}. sırada` : "", val);
  } else if (!manual) sondakikaMark(url, "atlandı", r.error || "başlatılamadı", val);
  else fail(`video başlatılamadı (${r.error || "bilinmeyen hata"})`);
  return { ...r, title: a.title, valuable };
}
// Okunamayan site (22 Ekim: bütün adresler zaman aşımı): ilk hata ve elle kontrol tam satırla, sonrakiler kısa satırla (5 dk'da bir uzun
// adres listesi logu boğmasın); 30 dakikadır okunamıyorsa sağlık uyarısı (6 saatte bir). Yeniden okununca tek satır.
function sondakikaFailed(error, manual) {
  const now = Date.now();
  sondakikaFail = sondakikaFail ? { ...sondakikaFail, n: sondakikaFail.n + 1, last: error } : { since: now, n: 1, last: error };
  const mins = Math.round((now - sondakikaFail.since) / 60000);
  if (manual || sondakikaFail.n === 1) push(`🔴 sondakika.com kontrolü başarısız: ${error}`);
  else push(`🔴 sondakika.com hâlâ okunamıyor (${sondakikaFail.n}. deneme, ${mins} dakikadır): ${String(error).replace(/; denenen adresler:.*$/, "").slice(0, 120)}`);
  if (mins >= 30) healthAlert("sondakika-down", `sondakika.com ${mins} dakikadır okunamıyor (${sondakikaFail.n} deneme). Son hata: ${String(error).slice(0, 300)}\nSite yavaş ya da erişim engelli olabilir; tarama her ${sondakikaEvery()} dakikada sürüyor, site yanıt verince kendiliğinden devam eder.`, { everyH: 6 }).catch(() => {});
}
async function sondakikaCheck({ manual = false } = {}) {
  if (sondakikaBusy) return { ok: false, busy: true, error: "sondakika.com taraması zaten sürüyor." };
  sondakikaBusy = true; sondakikaLast = Date.now();
  try {
    // ortak tarama (Mynet + son dakika siteleri) sürüyorsa bitmesi beklenir (en çok 2 dk): aynı olayı iki taraf aynı dakikada
    // üretmesin (onların işaretleri tarama bitince yazılmış olur); ortak tarama da bu tarama sürerken başlamaz
    for (let i = 0; watchScanning && i < 60; i++) await new Promise((ok) => setTimeout(ok, 2000));
    const c = sondakikaCfg();
    const r = await pyJson(["scripts/sondakika_watch.py", "--check"], 150000);
    if (!r?.ok) { sondakikaFailed(r?.error || "yanıt yok", manual); return r || { ok: false, error: "yanıt yok" }; }
    if (sondakikaFail) { push(`🔴 sondakika.com yeniden okunuyor (${sondakikaFail.n} başarısız denemeden, ${Math.round((Date.now() - sondakikaFail.since) / 60000)} dakikadan sonra)`); sondakikaFail = null; }
    const via = r.method === "rss" ? "RSS" : "ana sayfa";
    if (r.first) {
      push(`🔴 sondakika.com takibi ${r.sourceChanged ? `yeni kaynakla (${via}) yeniden ` : ""}başladı: ${r.items.length} haber kaydedildi (${via}); bundan sonra düşen her yeni haber için anında son dakika videosu üretilecek`);
      return { ...r, produced: [] };
    }
    if (manual || r.new.length) push(`🔴 sondakika.com kontrol edildi (${via}): ${r.items.length} haber, ${r.new.length} yeni`);
    const produced = [], vip = c.valuableUnlimited !== false, max = Number(c.maxPerCheck);
    // değerli haberler önce (kendi içinde en yeniden eskiye), sonra sıradanlar; değerli haber tarama başına sınırı tüketmez. Sınıra
    // takılan sıradan haberin sayfasına (gövdeyle değerli mi) üretime dönüşmeyen bu okumaların toplamı 4 dakikayı geçene kadar bakılır;
    // üretimlerin süresi sayılmaz (sel gibi düşen haberde değerliler ve ilk sıradanlar üretilirken bütçe bitmesin). Sonra sayfa okunmadan
    // atlanır (site yavaşken sonraki taramalar beklemesin)
    // değerliler önce (strict'te çok değerliler en önce), sonra sıradanlar; kendi içinde en yeniden eskiye (kararlı sıralama)
    const strict = c.onlyValuable !== false && c.strictValuable !== false, rank = (x) => (strict && x.strong ? 0 : x.valuable ? 1 : 2);
    const news = vip ? [...(r.new || [])].sort((a, b) => rank(a) - rank(b)) : r.new || [];
    let plain = 0, peekMs = 0;
    for (const it of news) { // en yeniden eskiye; sıradan haberde tarama başına en çok maxPerCheck
      const limit = (vip && it.valuable ? produced.length : plain) >= max ? { why: `tarama başına en çok ${c.maxPerCheck} haber`, note: `tarama başına sınır (${c.maxPerCheck})` } : null;
      if (limit && !vip) { sondakikaMark(it.url, "atlandı", limit.note); push(`🔴 sondakika.com: "${String(it.title || it.url).slice(0, 70)}" atlandı — ${limit.why}`); continue; }
      const t1 = Date.now(), res = await sondakikaProduce(it.url, { item: it, limit, peek: peekMs < 4 * 60000 }).catch((e) => ({ ok: false, error: e.message }));
      if (res.peeked) peekMs += Date.now() - t1; // sınıra takılıp sayfası okunan, üretilmeyen haber (sıradan, okunamadı, tekrar, bayat, aynı olay) bütçeden düşer
      if (res.ok) { produced.push(res.title); if (!(vip && res.valuable)) plain++; }
    }
    return { ...r, produced };
  } finally { sondakikaBusy = false; }
}
setInterval(() => { if (sondakikaCfg().enabled !== false && !sondakikaBusy && Date.now() - sondakikaLast >= sondakikaEvery() * 60000 - 5000) sondakikaCheck().catch((e) => push(`🔴 sondakika.com: ${e.message}`)); }, 60000);
app.get("/api/sondakika", (_req, res) => {
  const st = readJson(path.join(DATA, "sondakika_state.json"), {}) || {}, stat = readJson(SONDAKIKA_STATUS, {}), c = sondakikaCfg(), done = sondakikaDone();
  const made = new Set(Object.values(done).flat().map((x) => x.url));
  // sıradaki haberin yeri canlı okunur (öne alınan değerli haber ya da başlayan iş sırayı kaydırır); sayfayla değerli çıkan haber ⭐ alır
  const pos = new Map(anlikQueue.flatMap((q, i) => (q.opts?.sondakika ? [[q.opts.sondakika, i + 1]] : [])));
  const status = (u) => (stat[u]?.state === "sırada" && pos.has(u) ? { ...stat[u], why: `${pos.get(u)}. sırada` } : stat[u] || null);
  const val = (it, s) => ({ ...(!it.valuable && s?.valuable ? { valuable: true, valueReason: s.valueReason || "" } : {}), ...(!it.strong && s?.strong ? { strong: true, strongReason: s.strongReason || "" } : {}) });
  // sırada bekleyen haber "üretildi" sayılmaz (sıradan çıkarılırsa günlük kayıttan da silinir)
  res.json({ cfg: { ...c, intervalMin: sondakikaEvery() }, items: (Array.isArray(st.items) ? st.items : []).map((it) => { const s = status(it.url); return { ...it, ...val(it, s), status: s, produced: made.has(it.url) && s?.state !== "sırada" }; }),
    lastCheck: st.lastCheck || null, method: st.method || null, source: st.source || null, producedToday: done[today()] || [], scanning: sondakikaBusy,
    nextCheckIn: c.enabled !== false ? Math.max(0, sondakikaLast + sondakikaEvery() * 60000 - Date.now()) : null });
});
app.post("/api/sondakika/check", async (_req, res) => res.json(await sondakikaCheck({ manual: true })));
app.post("/api/sondakika/produce", async (req, res) => {
  const url = String(req.body?.url || ""), item = ((readJson(path.join(DATA, "sondakika_state.json"), {}) || {}).items || []).find((x) => x.url === url) || null;
  res.json(await sondakikaProduce(url, { manual: true, force: !!req.body?.force, item }));
});

// ---------- Instagram trend radarı (kullanıcı isteği, 18 Ekim: "bazen çok izlenen videolar oluyor, trend; onlara nasıl bir yol
// izleyebiliriz"; kaynak Instagram trendleri; 20 Ekim'den beri — kullanıcı isteği: "trend videolardan da otomatik üretelim, çok aşırı
// izlenme varsa WhatsApp'tan göndersin" — yeni trend otomatik video kuyruğuna, çok izlenen WhatsApp'a: trendauto.js, aşağıda trendAuto).
// scripts/ig_trends.py: Facebook Girişi varsa resmi API (Business Discovery + hashtag), yoksa herkese açık profil (girişsiz), çerezli
// yalnız settings.igTrends.useCookies açıksa. Kendi zamanlayıcısı her dakika bakar, intervalMin dolunca tarar (hafif: dinlenmede de
// tarar, kendi busy bayrağıyla süren taramanın üstüne asla). Log yalnız: elle tarama sonucu, yeni beliren trendler (tek satır), hatalar
// (otomatik taramada en çok 6 saatte bir). Panel "🎬 Haber yap / Fragman yap" ve seçilenler → video kuyruğu (videoqueue.js; indirme + kurgu;
// yayın onayı aynı, userVideo), durumları data/ig_trends_done.json (sırada → hazırlanıyor → üretildi / hata / iptal; 7 gün).
const IGT_FILE = path.join(DATA, "ig_trends.json");
const IGT_DONE = path.join(DATA, "ig_trends_done.json"); // {url: {at, mode, state: hazırlanıyor|üretildi|hata, error}}
const IGT_THUMBS = path.join(WORK, "ig_thumbs");
// ig_trends.py DEFAULTS ile aynı; hesap adları çevrimdışı doğrulanamadı (bulunamayan hesap kartta "bulunamadı" görünür, liste kartta düzenlenir)
const IGT_DEFAULTS = { enabled: true, intervalMin: 60, accounts: ["cnnturk", "haberturk", "trthaber", "ntv", "ahaber", "anadoluajansi", "onedio", "gzt", "bpthaber", "tv100"],
  hashtags: ["sondakika", "gundem"], maxAgeHours: 48, minRatio: 2, minViews: 20000, minLikes: 2000, top: 15, useCookies: false };
const igTrendsCfg = () => { const raw = settings().igTrends; return { ...IGT_DEFAULTS, ...(raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) }; };
// aralık: kayıtlı değer; yoksa son tarama resmi API ile yapıldıysa 20 dk (istek sınırı geniş), değilse 60 dk (kullanıcı isteği, 20 Ekim: "yeni trend düşerse anında listeme girsin")
const igtEvery = () => Math.min(1440, Math.max(15, Number((settings().igTrends || {}).intervalMin) || (/resmi/.test(String((readJson(IGT_FILE, {}) || {}).method || "")) ? 20 : 60)));
const igtDone = () => { const d = readJson(IGT_DONE, {}); return d && typeof d === "object" && !Array.isArray(d) ? d : {}; };
// üretim bu süreçte (socialVideoNews) çalışır: açılışta kalan "hazırlanıyor" kaydı yarım kalmıştır (panel üretim sürerken yeniden başladı).
// "hata" yapılır ki kart yeniden "🎬 Haber yap" göstersin (inceleme, 18 Ekim: 7 gün boyunca yalnız devre dışı "⏳ Hazırlanıyor" kalıyordu)
{ const d = igtDone(); let n = 0; for (const v of Object.values(d)) if (v?.state === "hazırlanıyor") { v.state = "hata"; v.error = "panel yeniden başladı, üretim yarım kaldı"; n++; } if (n) writeJson(IGT_DONE, d); }
// son deneme dosyadan: panel yeniden başlayınca hemen yeniden taranmaz (Instagram'ı yormamak için)
let igtBusy = false, igtLast = Number((readJson(IGT_FILE, {}) || {}).lastTry) || 0, igtErrAt = 0;
const igtNum = (n) => (n >= 1e6 ? `${(n / 1e6).toLocaleString("tr-TR", { maximumFractionDigits: 1 })} Mn` : n >= 1e4 ? `${Math.round(n / 1e3).toLocaleString("tr-TR")} B` : Number(n || 0).toLocaleString("tr-TR"));
const igtMetric = (it) => (it.metric === "views" ? `${igtNum(it.views)} izlenme` : `${igtNum(it.likes)} beğeni`);
const igtMethod = (m) => String(m || "").split("+").filter(Boolean).map((x) => ({ resmi: "resmi API", web: "herkese açık profil", cerez: "çerezli" }[x] || x)).join(" + ") || "—";
async function igTrendsScan({ manual = false } = {}) {
  if (igtBusy) return { ok: false, busy: true, error: "Instagram trend taraması zaten sürüyor." };
  igtBusy = true; igtLast = Date.now();
  try {
    const r = (await pyJson(["scripts/ig_trends.py", "--scan"], 6 * 60000)) || { ok: false, error: "yanıt yok" };
    const accs = Object.values(r.accounts || {}), nf = accs.filter((a) => a.error === "bulunamadı").length;
    const errs = [...(r.ok ? [] : [r.error || "yanıt yok"]), ...(r.errors || []).filter((e) => e !== r.error)];
    if (manual && r.ok) {
      const tn = (r.items || []).filter((x) => x.trend).length;
      push(`📈 Instagram trendleri tarandı (${igtMethod(r.method)}): ${accs.length} hesap, ${accs.filter((a) => a.ok).length} okundu${nf ? `, ${nf} bulunamadı` : ""} · ${(r.items || []).length} video, ${tn} trend${tn ? " 🔥" : ""}`);
      for (const e of errs.slice(0, 3)) push(`📈 Instagram trendleri: ${e}`);
    } else if (manual) push(`📈 Instagram trend taraması başarısız: ${errs[0]}`);
    else if (errs.length && Date.now() - igtErrAt > 6 * 3600000) { igtErrAt = Date.now(); push(`📈 Instagram trendleri: ${errs[0]}${errs.length > 1 ? ` (+${errs.length - 1} uyarı daha, ayrıntı panelde)` : ""}`); }
    const nt = r.newTrends || []; // yeni beliren trendler tek satır (aynı video 7 gün yeniden yazılmaz: ig_trends_state.json trendSeen)
    const minR = Number(igTrendsCfg().minRatio) || 2; // hızla yükselen taze videonun katı düşük olabilir (0,4): onu "kat" diye yazma
    if (nt.length) push(`🔥 Instagram trendi: ${nt.slice(0, 3).map((it) => `${it.account ? "@" + it.account : it.source} "${String(it.caption || "").slice(0, 50)}" ${igtMetric(it)}${it.ratio >= minR ? ` (hesabın ${it.ratio.toLocaleString("tr-TR", { maximumFractionDigits: 1 })} katı)` : it.fast ? " (hızla yükseliyor)" : ""}`).join(" · ")}${nt.length > 3 ? ` (+${nt.length - 3} daha)` : ""} — panelde 📈 INSTAGRAM TRENDLERİ`);
    try { for (const f of existsSync(IGT_THUMBS) ? readdirSync(IGT_THUMBS) : []) if (Date.now() - statSync(path.join(IGT_THUMBS, f)).mtimeMs > 3 * 864e5) unlinkSync(path.join(IGT_THUMBS, f)); } catch { /* temizlik */ }
    // kapaklar tarama anında diske (kullanıcı şikâyeti, 24 Ekim: "kapak görseller yüklenmiyor": Instagram CDN adresleri imzalı ve süreli, birkaç
    // saat sonra 403 veriyor; kart o adresi yüklemeye çalışınca resim gelmiyordu). Dosya gönderi koduyla saklanır (adres değişse de aynı dosya)
    if (r.ok) { const n = await igtCacheThumbs(r.items || []); if (n && manual) push(`📈 ${n} trend kapağı diske alındı`); }
    await trendAuto.afterScan(r).catch((e) => push(`📈 trend otomatik üretimi: ${e.message}`)); // 🆕, otomatik üretim, çok izlenme uyarısı, kart yenilenir (SSE)
    return r;
  } finally { igtBusy = false; }
}
setInterval(() => { if (igTrendsCfg().enabled !== false && !igtBusy && Date.now() - igtLast >= igtEvery() * 60000 - 5000) igTrendsScan().catch((e) => push(`📈 Instagram trendleri: ${e.message}`)); }, 60000);
// Trend kapağı diskte: work/ig_thumbs/<gönderi kodu>.jpg. Kaynak adres yalnız Instagram CDN'i (cdninstagram.com / fbcdn.net, https), en çok 3 MB,
// 10 sn; aynı anda en çok 6 indirme. Dönen sayı: bu çağrıda indirilen yeni kapak
const igtThumbFile = (sc) => (/^[A-Za-z0-9_-]{3,64}$/.test(String(sc || "")) ? path.join(IGT_THUMBS, `${sc}.jpg`) : null);
const igtCdnUrl = (u) => { try { const x = new URL(String(u || "")); return x.protocol === "https:" && /(^|\.)(cdninstagram\.com|fbcdn\.net)$/.test(x.hostname) ? x : null; } catch { return null; } };
async function igtFetchThumb(u) {
  const r = await fetch(u.href, { headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36" }, signal: AbortSignal.timeout(10000) });
  const buf = Buffer.from(await r.arrayBuffer());
  if (!r.ok || !/^image\//.test(r.headers.get("content-type") || "") || buf.length > 3e6 || buf.length < 100) return null;
  return buf;
}
async function igtCacheThumbs(items) {
  const seen = new Set(); // aynı gönderi listede iki kez geçerse (hesap + hashtag) bir kez indirilir
  const todo = items.filter((it) => it?.thumb && igtThumbFile(it.shortcode) && !existsSync(igtThumbFile(it.shortcode)) && igtCdnUrl(it.thumb) && !seen.has(it.shortcode) && seen.add(it.shortcode));
  if (!todo.length) return 0;
  mkdirSync(IGT_THUMBS, { recursive: true });
  let n = 0, i = 0;
  const worker = async () => { while (i < todo.length) { const it = todo[i++]; try { const buf = await igtFetchThumb(igtCdnUrl(it.thumb)); if (buf) { writeFileSync(igtThumbFile(it.shortcode), buf); n++; } } catch { /* CDN vermedi: kart yer tutucusuyla kalır */ } } };
  await Promise.all(Array.from({ length: Math.min(6, todo.length) }, worker));
  return n;
}
// producedNews: trendin haberi bizde üretildi mi (üretilen haber hafızası; kullanıcı isteği, 18 Ekim: "ürettiğimiz haberi tekrar
// yakalamayalım") — kart "✓ Bu haber üretildi" gösterir, "Haber yap" düğmesi kalır. produced: bu gönderiden üretim kaydı (ig_trends_done)
app.get("/api/igtrends", async (_req, res) => {
  const d = readJson(IGT_FILE, {}) || {}, c = igTrendsCfg(), done = igtDone(), top = Math.min(30, Math.max(1, Number(c.top) || 15)), mk = trendAuto.marker();
  const mem = Array.isArray(d.items) && d.items.length ? ((await pyJson(["scripts/ig_trends.py", "--produced"], 20000).catch(() => null))?.produced || {}) : {};
  res.json({ cfg: { ...c, intervalMin: igtEvery() }, at: d.at || null, lastTry: d.lastTry || null, method: d.method || null, accounts: d.accounts || {},
    items: (Array.isArray(d.items) ? d.items : []).slice(0, top).map((it) => ({ ...it, produced: done[it.url] || null, producedNews: mem[it.url] || null, ...mk(it),
      thumbLocal: igtThumbFile(it.shortcode) && existsSync(igtThumbFile(it.shortcode)) ? `/api/igtrends/thumb?sc=${encodeURIComponent(it.shortcode)}&v=${Math.round(statSync(igtThumbFile(it.shortcode)).mtimeMs / 1000)}` : null })),
    errors: d.errors || [], notes: d.notes || [], error: d.error || null, pausedUntil: d.pausedUntil > Date.now() ? d.pausedUntil : null, pauseReason: d.pauseReason || null,
    trailerEnabled: trailerCfg().enabled !== false, scanning: igtBusy, auto: { ...trendAuto.cfg(), today: trendAuto.todayCount() }, nextScanIn: c.enabled !== false ? Math.max(0, igtLast + igtEvery() * 60000 - Date.now()) : null });
});
app.post("/api/igtrends/scan", async (_req, res) => res.json(await igTrendsScan({ manual: true })));
// Panelden üretim: yalnız Instagram gönderi adresi; indirme + kurgu socialVideoNews'te (yayın önce onaya gelir). Uzun sürer (≤ 8 dk
// indirme + kurgu): istek hemen döner, sonuç ig_trends_done.json'a ("hazırlanıyor" → "üretildi" / "hata") ve loga.
app.post("/api/igtrends/produce", (req, res) => {
  const url = String(req.body?.url || "").trim(), mode = req.body?.mode === "fragman" ? "fragman" : "haber";
  if (!/^https:\/\/www\.instagram\.com\/(reel|p|tv)\/[A-Za-z0-9_-]{5,64}\/?$/.test(url)) return res.json({ ok: false, error: "Geçerli bir Instagram gönderi adresi değil." });
  if (waVideoCfg().enabled === false) return res.json({ ok: false, error: "Videodan haber yapma kapalı (Ayarlar → 📡 Otomatik içerikler)." }); // social_video komutuyla aynı kural
  const it = ((readJson(IGT_FILE, {}) || {}).items || []).find((x) => x.url === url) || {};
  // Instagram linkinde fragman kendiliğinden tanınmaz (yalnız YouTube): "🎬 Haber yap" açık haber isteğidir (tür "haber"; inceleme, 19 Ekim:
  // talimat boş gidince Claude çok izlenen videoyu VİRAL yapabiliyordu), "fragman" fragman analizi (varsayılan analiz talimatı).
  // Video kuyruğuna (kullanıcı isteği, 20 Ekim): başka paylaşım hazırlanırken reddedilmez, sırasını bekler; durum kuyruğun kancasıyla
  // ig_trends_done.json'a (sırada → hazırlanıyor → üretildi / hata / iptal)
  const r = vq.add({ url, instruction: mode === "fragman" ? "fragman" : "", kind: mode === "fragman" ? "" : "haber", mode, source: "panel", account: it.account, caption: it.caption, trend: true });
  if (r.ok) push(`📈 Instagram trendi ${mode === "fragman" ? "fragman analizine" : "habere"} alındı (#${r.no}${r.queued ? `; önünde ${r.ahead} video` : ""}): ${it.account ? "@" + it.account : it.source || "Instagram"} — ${url}`);
  res.json({ ...r, started: !!(r.ok && !r.queued) });
});
// Kapak resmi vekili: Instagram CDN'i başka siteye gömülen resmi engelleyebilir (CORP); kart önce doğrudan dener, olmazsa buradan.
// Yalnız Instagram/Facebook CDN adresleri (https), ≤ 3 MB resim, work/ig_thumbs/ önbelleği (3 gün).
app.get("/api/igtrends/thumb", async (req, res) => {
  // ?sc=<gönderi kodu>: tarama anında diske alınan kapak; ?u=<CDN adresi>: eski yol (adres hâlâ geçerliyse indirir, varsa koda göre saklar)
  const sc = String(req.query.sc || ""), fsc = igtThumbFile(sc);
  if (sc) { if (fsc && existsSync(fsc)) { res.set("Cache-Control", "public, max-age=86400"); return res.type("jpg").sendFile(fsc); } if (!req.query.u) return res.status(404).end(); }
  const u = igtCdnUrl(req.query.u);
  if (!u) return res.status(400).end();
  const f = fsc || path.join(IGT_THUMBS, createHash("sha1").update(u.href).digest("hex") + ".jpg");
  if (existsSync(f)) return res.type("jpg").sendFile(f);
  try {
    const buf = await igtFetchThumb(u);
    if (!buf) return res.status(404).end();
    mkdirSync(IGT_THUMBS, { recursive: true }); writeFileSync(f, buf);
    res.type("jpg").send(buf);
  } catch { res.status(404).end(); }
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
    // followUp: viral_watch hafızaya kendi kuralıyla baktı (yalnız başlık); toplayıcı içerikle yeniden bakmaz, yoksa yeni gelişme viral
    // videonun kendi kaydına benzetilip atlanabilirdi
    if (v.followUp) queueValuable({ title: v.followUp.title, text: v.followUp.text, source: v.followUp.source || "Türkiye Gündemi", url: v.followUp.url, sourceCount: 1, duration: 30, followUp: true,
      onStarted: async (res) => { if (res.ok && !res.merged) await pyJson(["scripts/breaking_watch.py", "--mark", v.followUp.title, ...(v.followUp.url ? ["--url", v.followUp.url] : []), "--text", String(v.followUp.text || "").slice(0, 1400)]).catch(() => {}); } });
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
const waVideoCfg = () => ({ enabled: true, autoPublish: true, duration: 30, waitMin: 30, recreate: true, ...(settings().waVideo || {}) }); // autoPublish varsayılan açık (kullanıcı isteği, 26 Ekim)
// Fragman analizi (kullanıcı isteği, 18 Ekim: "youtube videosunun linkini göndersem analiz edip kelimelere döküp çarpıcı bir kancalı
// giriş ile fragmanda ne anlatıldı gibi 40 saniyelik video"): talimat açıkça haber istemiyorsa ve talimatta fragman/trailer/teaser
// geçerse ya da (autoDetect) YouTube başlığı fragmansa wa_video.py fragman modunda çalışır (prompts/fragman.md). Açık haber isteği
// ("bu fragmanı haber yap") fragman kelimesinden önce gelir: "haber yap" diye yeniden gönderilen link yine fragman olmasın.
// settings.trailer biçimi denetlenir (beyin/elle düzenleme true, false, "false" yazabilir): nesne değilse varsayılan, false → kapalı;
// enabled/autoDetect "false" ya da 0 da kapalı sayılır; bozuk ya da 0 süre → 40 (trailerSecs; wa_video.py tr_settings ile aynı)
const trailerCfg = () => {
  const raw = settings().trailer;
  const t = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : raw === false || raw === "false" ? { enabled: false } : {};
  const off = (v) => v === false || v === 0 || ["false", "0"].includes(String(v).trim().toLowerCase());
  return { duration: 40, maxSoundSeconds: 8, ...t, enabled: !off(t.enabled), autoDetect: !off(t.autoDetect) };
};
// Video türü (kullanıcı isteği, 19 Ekim: "mizah ve sosyal medyada çok izlenen video linklerini de son dakika diye haber yapıyor; link/mizah,
// link/trend"): talimattaki açık etiket (scripts/common.py content_kind ile AYNI kural ve kalıplar: haber > mizah > trend; yoksa "" → Claude
// karar verir): talimat yalnız etiket ("mizah", "#trend"; yanında yalnız yayın fiili, süre ya da dolgu: "mizah 40 saniye", commands.js
// KIND_FILL; mizah/viral yanında "yap"/"olsun": "mizah yap", KIND_DO; "viral olsun" çağrıdır, değil), başta ayraçla etiket ("mizah, kısa kes";
// ardından başka etiket gelirse değil: "haber, mizah, viral fark etmez"), sonda işaretten sonra yalın etiket ("Adam düştü 😂 mizah"), #etiket
// ya da açık ifade ("mizah videosu", "komik bir video", "viral video", "çok izlenen video"); açık haber isteği (newsRequest) hep haber. ÖNCE
// KESİNLİK (inceleme, 19 Ekim: kara liste kalıplar "haber yaparken düşen muhabir", "son dakika golü", "komik video sanılan görüntüler"
// türünü değiştiriyordu): tetik yalnız ardından AÇIK İSTEK BİÇİMİ gelirse sayılır (beyaz liste); kaçırılan istek ucuz (link/mizah, link/haber
// etiketi), yanlış tetik pahalı
const KIND_WORDS = Object.assign(Object.create(null), { mizah: "mizah", mizahi: "mizah", komik: "mizah", trend: "trend", viral: "trend", haber: "haber" });
// aynı işaretin uzun dizisi üçe iner (11. tur; common.py _kind_text aynı kural): kalıplar işaret sayısına bakmaz, 65.536 karakterlik "⟪⟪⟪…" ya da
// "😂😂😂…" dizisinde her kalıbın ilk (yorumlanan) çalışması metin boyu sürüyordu
const kindFold = (x) => String(x || "").toLocaleLowerCase("tr-TR").replace(/[ıöçşüğâîû]/g, (c) => ({ ı: "i", ö: "o", ç: "c", ş: "s", ü: "u", ğ: "g", â: "a", î: "i", û: "u" })[c])
  .replace(/([^\p{L}\p{Nd}\s'’])\1{3,}/gu, "$1$1$1");
const KIND_SIGN = String.raw`[^\p{L}\p{Nd}\s'’]`; // işaret: harf, rakam, boşluk ve kesme işareti dışı (noktalama, tire, emoji, #, ²…)
const KIND_T = String.raw`[^\S\n]*(?:$|\n|${KIND_SIGN})`; // ifade sonu: metin ya da satır sonu, işaret ("son dakika'yı" değil)
// İSTEK BİÇİMİ (common.py _REQ… aynı metin): yap, yapın(ız), yapsana, yapalım, yapsın(lar), yapar mısın(ız)/mıyız, yapabilir misin/miyiz,
// yapabilirsin, yapıver(sene/in/ir misin), yapmalısın(ız), yapacaksın/yapcan/yapıcan, yapacaz/yapcaz/yapıcaz ("haber yapcaz bunu"),
// yapmak/yapmanı/yapmasını istiyorum (isterim, rica ediyorum, sağla…), yapmak/yapması/yapman(ız) lazım (gerekir, gerek, şart: "haber yapman
// lazım bunun"), yapsan iyi olur; -ıp yalnız ardından istek biçiminde fiil gelirse ("çizip paylaş").
// Listede olmayan biçim (yapma, yapan, yaparken, yaptığı, yaptı, yapar, yapımı/çekimi, "yapmak yerine", "yapmayı bırak", "yapmak zorunda
// değil"; üçüncü kişi/biz gereklilik "yapmalı", "üretmeliyiz" görüştür) istek DEĞİL
const REQ_WANT = String.raw`(?:istiyoru[mz]|isterim|isteriz|rica\s+ediyoru[mz]|rica\s+ederi[mz]|sagla(?:yin(?:iz)?|r\s*m[iu]s[iu]n(?:[iu]z)?|yabilir\s*m[iu](?:s[iu]n(?:[iu]z)?|y[iu]z))?)`;
const REQ_NEED = String.raw`(?:lazim|gerekir|gerekiyor|sart|gerek(?![a-z])(?!\s+(?:yok|d(?:egi|ii|ei)l)(?![a-z])))`; // "gerek yok" ret (benzer video kalıbı u bayraksız: [a-z])
const ASK_V = String.raw`(?:anlat|yap|hazirla|uret|sun(?!un(?![a-z]))|yaz|paylas|kurgula|ver|yayinla|yayimla|goster|cek|at|gonder|yukle|isle|seslendir|oku|cevir|donustur|olustur|canlandir|tasarla|ciz|koy(?!un(?![a-z]))|ekle|kullan|tut|ozetle|duzenle)`;
const REQ1 = String.raw`y?[iu]n(?:[iu]z)?|s[ae]n[ae]|y?[ae]l[iu]m|s[iu]n(?:l[ae]r)?|[aeiu]?r\s*m[iu](?:s[iu]n(?:[iu]z)?|y[iu]z)|`
  + String.raw`y?[ae]bilir(?:\s*m[iu](?:s[iu]n(?:[iu]z)?|y[iu]z)|s[iu]n(?:[iu]z)?)|y?[iu]ver(?:s[ae]n[ae]|[iu]n(?:[iu]z)?|[iu]r\s*m[iu]s[iu]n(?:[iu]z)?)?|`
  + String.raw`m[ae]l[iu]s[iu]n(?:[iu]z)?|y?[aeiu]?c[ae](?:ks[iu]n(?:[iu]z)?|n|z|k\s*m[iu]s[iu]n(?:[iu]z)?)|m[ae](?:k|n[iu]|s[iu]n[iu])\s+${REQ_WANT}|m[ae](?:k|s[iu]|n(?:[iu]z)?)\s+${REQ_NEED}|`
  + String.raw`s[ae]n(?:[iu]z)?\s+(?:iyi|guzel|harika|super)\s+olur`;
const REQ_FORM = String.raw`${REQ1}|y?[iu]p\s+(?:(?:bana|bize|hemen|sonra|lutfen|da|de)\s+)?${ASK_V}(?:${REQ1})?`;
// benzer videonun istek biçimi (common.py _REQ_SG/_REQ_PL/_RC_REQ aynı metin; inceleme, 20 Ekim: izleyiciye yazılmış "Videodaki gibi yapmanız
// lazım", "belediyelerin de benzerini yapması lazım", "aynısını yapalım mı?" benzer video sanılıyordu): gereklilik yalnız -mak/-man + lazım,
// "yapalım mı?" soru; REQ_SG tekil/sahip biçimleri (işaretten ve "siz de"den sonra yalnız bunlar: "Ev hanımları dikkat! Videodaki gibi yapın"
// izleyiciye; sahibin kibar sorusu "yapar mısınız", "yapabilir misiniz" de sayılır, 9. tur), REQ_PL çoğul/üçüncü kişi biçimleri
// ("yapabilirsiniz" ifadedir, istek değil: "Bunun benzerini siz de yapabilirsiniz")
const REQ_SG = String.raw`s[ae]n[ae]|y?[ae]l[iu]m(?!\s*m[iu](?![a-z]))|[aeiu]?r\s*m[iu](?:s[iu]n(?:[iu]z)?|y[iu]z)|y?[ae]bilir(?:\s*m[iu](?:s[iu]n(?:[iu]z)?|y[iu]z)|s[iu]n)|`
  + String.raw`y?[iu]ver(?:s[ae]n[ae]|[iu]r\s*m[iu]s[iu]n)?|m[ae]l[iu]s[iu]n|y?[aeiu]?c[ae](?:ks[iu]n|n|z|k\s*m[iu]s[iu]n)|`
  + String.raw`m[ae](?:k|n[iu]|s[iu]n[iu])\s+${REQ_WANT}|m[ae](?:k|n)\s+${REQ_NEED}|s[ae]n\s+(?:iyi|guzel|harika|super)\s+olur`;
const REQ_PL = String.raw`y?[iu]n(?:[iu]z)?|s[iu]n(?:l[ae]r)?|[aeiu]?r\s*m[iu]s[iu]n[iu]z|y?[ae]bilir\s*m[iu]s[iu]n[iu]z|`
  + String.raw`y?[iu]ver(?:[iu]n(?:[iu]z)?|[iu]r\s*m[iu]s[iu]n[iu]z)|m[ae]l[iu]s[iu]n[iu]z|y?[aeiu]?c[ae](?:ks[iu]n[iu]z|k\s*m[iu]s[iu]n[iu]z)|`
  + String.raw`s[ae]n[iu]z\s+(?:iyi|guzel|harika|super)\s+olur`;
const RC_REQ1 = String.raw`${REQ_PL}|${REQ_SG}`;
const RC_REQ = String.raw`${RC_REQ1}|y?[iu]p\s+(?:(?:bana|bize|hemen|sonra|lutfen|da|de)\s+)?${ASK_V}(?:${RC_REQ1})?`;
const RC_REQ_SG = String.raw`${REQ_SG}|y?[iu]p\s+(?:(?:bana|bize|hemen|sonra|lutfen|da|de)\s+)?${ASK_V}(?:${REQ_SG})?`;
// benzer videonun tekil yolu kibar çoğul soruyu ("yapar mısınız", "yapabilir misiniz") almaz (12. tur; common.py _REQ_SG1 aynı metin; inceleme,
// 20 Ekim: "Evde videodaki gibi yapar mısınız #challenge" izleyici sözüne bakılmadan benzer video oluyordu): o biçim çoğul yoldan (RECREATE_PL,
// izleyici sözü yoksa) sayılır; "çizgi filme çevirir misiniz" tekil kolda kalır
const REQ_SG1 = String.raw`s[ae]n[ae]|y?[ae]l[iu]m(?!\s*m[iu](?![a-z]))|[aeiu]?r\s*m[iu](?:s[iu]n|y[iu]z)|y?[ae]bilir(?:\s*m[iu](?:s[iu]n|y[iu]z)|s[iu]n)|`
  + String.raw`y?[iu]ver(?:s[ae]n[ae]|[iu]r\s*m[iu]s[iu]n)?|m[ae]l[iu]s[iu]n|y?[aeiu]?c[ae](?:ks[iu]n|n|z|k\s*m[iu]s[iu]n)|`
  + String.raw`m[ae](?:k|n[iu]|s[iu]n[iu])\s+${REQ_WANT}|m[ae](?:k|n)\s+${REQ_NEED}|s[ae]n\s+(?:iyi|guzel|harika|super)\s+olur`;
const RC_REQ_SG1 = String.raw`${REQ_SG1}|y?[iu]p\s+(?:(?:bana|bize|hemen|sonra|lutfen|da|de)\s+)?${ASK_V}(?:${REQ_SG1})?`;
const PASS_OPT = String.raw`(?:[iu]l|n)s[iu]n(?:l[ae]r)?`; // edilgen istek: yapılsın
// dolgu/süre kelimesi ("haber olarak 30 sn", "18:30'da"); ardından ifade sonu gelirse sayılır. Sayıdan sonraki boşluk yalnız birimle
// birlikte alınır (ölçüm, 19 Ekim: sayının boşluğu yutup yutmaması her sayıda iki yol açıyor, "1" + 100 boşluk + "1"… saniyeler sürüyordu)
const FILLTOK = String.raw`(?:[0-9]+(?:[.,:][0-9]+)*(?:\s*(?:['’]\p{L}+|(?:saniye|sn|dakika|dk)\p{L}*))?|saniye\p{L}*|sn|dakika\p{L}*|dk|lutfen|bunu|sunu|hemen|olarak)(?!\p{L})`;
const TO_END = String.raw`(?:\s+${FILLTOK}){0,4}${KIND_T}`;
// metnin SONUNA kadar yalnız işaret, satır sonu ve (en çok dört) dolgu/süre ("fragman: 40 saniye"); işaretten sonra cümle başlarsa ifade
// sonu değil ("Gerçek hayattan fragman: Kartal tilkiyi havada yakaladı", "Güzel bir haber olarak, kedimiz…"; inceleme, 19 Ekim). Her
// parça tek yoldan eşleşir, uzun girdide geri izleme patlamaz
const SIGN_END = String.raw`(?:[^\S\n]*(?:${KIND_SIGN}|\n))*(?:(?:[^\S\n]+|(?<!\p{L})(?<![0-9]))${FILLTOK}(?:[^\S\n]*(?:${KIND_SIGN}|\n))*){0,4}[^\S\n]*$`;
// işaretten (virgül, iki nokta, tire, nokta, ünlem, emoji…) ya da satır sonundan sonra en çok dört kelime ya da süre (ardından istek fiili
// gelmeli: "fragman, kısa olsun", "haber gibi, özetle"; inceleme, 20 Ekim: "fragman. kısa tut", "fragman 🎬 kısa olsun", "haber gibi! özetle")
const CLAUSE = String.raw`[^\S\n]*(?:${KIND_SIGN}(?:[^\S\n]*${KIND_SIGN})*(?![^\S\n]*${KIND_SIGN})|(?=\n))(?:\s+(?:\p{L}+|${FILLTOK})){0,4}`; // işaret dizisi bütün
// + yapılacak (yalnız talimatın sonunda, ardından yalnız işaret/dolgu/süre ya da işaretten sonra kısa "… olsun/kalsın" cümlesi: "mizah
// videosu yapılacak.", "bundan mizah videosu yapılacak, 40 saniye", "bundan mizah videosu yapılacak, kısa olsun" — 9. tur; "haber yapılacak kadar önemli değil", "Mizah yapılacak bir durum değil", "Viral video çekilecek, herkes meydana" değil; inceleme,
// 20 Ekim), yapılması lazım ("yapılmalı", "yapılacak mı?" değil)
const PASS_FORM = String.raw`(?:[iu]l|n)(?:s[iu]n(?:l[ae]r)?|[ae]c[ae]k(?=${SIGN_END}|${CLAUSE}\s+(?:olsun|kalsin)(?!\p{L})${SIGN_END})|m[ae]s[iu]\s+${REQ_NEED})`;
const ASK_GEC = String.raw`gec(?:${REQ_FORM}|(?=${TO_END}))`; // "haber olarak geç"; "son dakika geç kaldı" (sıfat) değil
const ASK_A = String.raw`(?:${ASK_V}(?:${REQ_FORM})?|${ASK_GEC}|olsun)(?!\p{L})`;
const ASK_A_SG = String.raw`(?:${ASK_V}(?:${REQ_SG})?|${ASK_GEC}|olsun)(?!\p{L})`; // zarf araya girince yalnız tekil/sahip biçimi
const KIND_WANT = String.raw`istiyoru[mz]|isterim|isteriz`; // tür ifadesinden sonra "istiyorum" da istek ("mizah videosu istiyorum")
const ASK_P = String.raw`(?:${ASK_V}(?:${REQ_FORM}|${PASS_FORM})?|${ASK_GEC}|olsun|${KIND_WANT})(?!\p{L})`;
const ASK_P_SG = String.raw`(?:${ASK_V}(?:${REQ_SG}|${PASS_FORM})?|${ASK_GEC}|olsun|${KIND_WANT})(?!\p{L})`;
// alıntı/amaç sözü (common.py _say aynı metin; L harf sınıfı): istekten sonra diye, der/derken, deyince, denilen, dedi…, demiş…, diyor…
// (diyorum değil: sahibin ısrarı), diyen, diyerek, çağrısı/talebi/uyarısı gelirse istek başkasının sözü ya da amaçtır ("Herkes haber yap
// diyor", "haber yap demiştim ama vazgeçtim", "Komik video olsun diye", "aynısını yapalım derken")
const sayWords = (L) => String.raw`[\s,.!?\x22\x27‘’“”«»]+(?:diye|de(?:r|rken|rsen|rler|rsin(?:iz)?|yince|yip|yerek|ni[lr]${L}*|di${L}*|`
  + String.raw`mis${L}*|miyor${L}*)|di(?:yor(?!u[mz](?!${L}))|yen|yecek|yerek)${L}*|cagri${L}*|tale[pb]${L}*|uyari${L}*)(?!${L})`;
const SAY = String.raw`(?!${sayWords(String.raw`\p{L}`)})`;
// ret (araya en çok üç ad): değil (diil, deil), yok, gerek yok, gerekmez, yerine, kaldır, alakası/ilgisi yok, -mAnA/-mAyA gerek yok, olumsuz
// fiil (VERB_NEG, edilgen kök de: "yazılmasın"; konuşma dili "yazmıycaz", "yazmasana"); tür ifadesinden sonraki "haber" araya giren ad
// sayılmaz ("komik video, haber yapmayın" haberi reddeder, mizahı değil)
const REFUSAL_END = String.raw`(?:d(?:egi|ii|ei)l|yok|gerek\s+yok|gerekmez|gerekmiyor|yerine|(?:alaka|ilgi)s[iu]\s+yok|kaldir(?:in(?:iz)?|sana|ir\s*m[iu]s[iu]n(?:[iu]z)?)?|`
  + String.raw`\p{L}+m[ae](?:n[ae]|y[ae])\s+(?:gerek\s+yok|gerekmez|gerekmiyor)|`
  + String.raw`(?:yaz|koy|de|yap|hazirla|uret|paylas|at|ver|cek|anlat|ol|iste|gonder|yukle|yayinla|yayimla|sun|kullan|ekle|cevir|kurgula|goster|gec)(?:[iu]l|[iu]n|n)?${VERB_NEG})(?!\p{L})`;
const REFUSAL_GAP = String.raw`diye|olarak|gibi|seklinde|tarzinda|video|videosu|videosunu|bir|bi|sey|bisey|birsey|falan|filan|hic|ile|kism\p{L}*|ibare\p{L}*|etiket\p{L}*|yazi\p{L}*|basli\p{L}*|band\p{L}*|ifade\p{L}*|kelime\p{L}*`;
const REFUSAL_NEWS = String.raw`\s+(?:(?:${REFUSAL_GAP}|haber|haberi|haberini)\s+){0,3}${REFUSAL_END}`;
const REFUSAL_KIND = String.raw`\s+(?:(?:${REFUSAL_GAP})\s+){0,3}${REFUSAL_END}`;
// ifade ile fiil arasında sayılan kelime ("haberini kısaca hazırla", "haber gibi tarafsız anlat", "haber olarak sade bir dille anlat",
// "haberini ayrıntılı bir şekilde hazırla", "haber olarak tarafsız ve net anlat"; inceleme, 20 Ekim; "bir şekilde" tek ara kelime; "sen" yalnız
// NEWS_SEN'de); en çok üç, biri süreyse dört ("haber olarak 40 saniyelik kısa bir video hazırla"). Zarf (kısaca, net, tarafsız…) araya girerse
// fiil yalnız tekil/sahip istek biçiminde (common.py _GAP_O/_GAP; 9. tur: yapıştırılan "Medya, haberleri tarafsız yapın!" haber isteği değil)
const ASK_GAP_O = String.raw`(?:bir|bi|kisa|uzun|video\p{L}*|ozet\p{L}*|bunu|sunu|bana|lutfen|hemen|olarak|sey|bisey|birsey|sekilde|bicimde)`; // HEAD'in listesi
const ASK_GAP = String.raw`(?:(?:bir|bi)\s+(?:sekilde|bicimde)|bir|bi|kisa|uzun|video\p{L}*|ozet\p{L}*|bunu|sunu|bana|lutfen|hemen|olarak|sey|bisey|birsey|`
  + String.raw`sekilde|bicimde|kisaca|hizlica|detayli|ayrintili|sade|net|tarafsiz|guzelce|biraz|dille|ve)`;
const GAP_TOK = String.raw`(?:${ASK_GAP}|${FILLTOK})\s+`;
const GAP_TOK_O = String.raw`(?:${ASK_GAP_O}|${FILLTOK})\s+`;
const GAP_DUR = String.raw`[0-9]+\s*(?:saniye|sn|dakika|dk)`;
// süre ilk dört sözcükte mi; ikinci kol yalnız süre yokken (common.py _GAP: sonuç aynı, uzun girdide boşa geri izleme yok)
const GAP = String.raw`(?:(?=(?:\S+\s+){0,3}${GAP_DUR})(?:${GAP_TOK}){0,4}|(?!(?:\S+\s+){0,3}${GAP_DUR})(?:${GAP_TOK}){0,3})`;
const GAP_O = String.raw`(?:(?=(?:\S+\s+){0,3}${GAP_DUR})(?:${GAP_TOK_O}){0,4}|(?!(?:\S+\s+){0,3}${GAP_DUR})(?:${GAP_TOK_O}){0,3})`;
// ifadeden sonra istek fiili: araya en çok üç ara kelime ya da süre ("haber olarak 30 saniyelik bir video yap"); fiilden sonra ret ("haber
// gibi yap değil") ve alıntı sayılmaz
const TO_VERB = String.raw`\s+(?!\s)(?:${GAP_O}${ASK_A}|${GAP}${ASK_A_SG})`; // (?!\s): boşluk dizisi geri izlenirken her adım ucuz
const TO_ASK = String.raw`${TO_VERB}(?!${REFUSAL_NEWS})${SAY}`;
// reddedilen istek etiket ve ifade denetiminden önce atılır ("haber değil mizah" → mizah)
const REFUSED_P = String.raw`(?<!\p{L})(?:(?:son\s*dakika|haber(?:i|ini)?)(?!\p{L})${REFUSAL_NEWS}|#?(?:mizah|mizahi|komik|esprili|komedi|trend|viral)(?:\s+(?:(?:bir|bi)\s+)?(?:video|icerik|paylasim)\p{L}*)?(?!\p{L})${REFUSAL_KIND})`;
const REFUSED_RE = new RegExp(REFUSED_P, "gu");
const SD_FOLLOW = String.raw`(?:olarak|diye|seklinde|etiket\p{L}*|band\p{L}*|basli\p{L}*|haber\p{L}*|video\p{L}*)`;
// "duymayan kalmasın, haber olsun", "herkes duysun/bilsin/görsün haber olsun" deyimi (duyuru çağrısı) "haber olsun" isteği değil
const HO_IDIOM = ["kalmasin", "duysun", "duyulsun", "bilsin", "gorsun", "ogrensin"].map((w) => String.raw`(?<!${w}\s)(?<!${w},\s)`).join("");
// açık haber isteği (fragman kararı, video türü, benzer video; common.py NEWS_RE aynı kalıp). GÜÇLÜ biçim: "haber(i/ini/leri) yap|hazırla|
// üret|çek|yaz" istek biçiminde (edilgen istek de: "haberi yapılsın"; araya en çok üç ara kelime ya da süre: "haberini 30 saniyelik hazırla",
// "bunun haberini kısa yap"); "haber olsun" yalnız talimatın başında, bu/bu video/bunu/videoyu'dan sonra ya da talimatın son sözü olarak
// (son söz biçimi HO_END'de, gülme emojisi yoksa; yönelme hâlinden ve kalmasın/duysun/bilsin/görsün'den sonra deyim: "herkese haber olsun", "duymayan kalmasın haber olsun"); "haber
// olarak" + ifade sonu ya da istek fiili (araya en çok üç kelime ya da süre; hemen ardından virgülle yeni cümle başlıyorsa değil: "Güzel bir
// haber olarak, kedimiz…"; virgülden sonra dolgu/süre, istek ya da ret olabilir); "haber gibi|şeklinde|tarzında|formatında|diliyle" + istek
// fiili ("haber gibi yayınla"; "haber gibi sunulan" değil); "habere çevir", "haberleştir", "haber haline getir"; "son dakika" (son dk) +
// olarak/diye/etiket…/haber…/video… + (son ya da istek fiili), + istek fiili. Ardından ret ya da alıntı/amaç sözü gelirse sayılmaz
// "haber(i/ini) + ara kelime + yaz/çek": ad da olabilen bu iki kökte ara kelime varsa fiil istek ekli ya da yalın kök + ifade sonu ("Acı haberi
// bir yaz günü aldık", "Kötü haberi bir çek ile verdiler" ad); yap/hazırla/üret yalın kökü her yerde ("bunun haberini kısa yap ve paylaş";
// inceleme, 20 Ekim); talimatın başında "(bundan) haber istiyorum"
const NEWS_V = String.raw`(?:yap|hazirla|uret|cek|yaz)`;
// ara kelimeli yaz/çek ardından devam da istek (common.py _YC_CONT; 9. tur: "bunun haberini kısa yaz ve paylaş", "haberini kısa çek ve gönder",
// "bunun haberini bi yaz bakalım", "haberini kısa yaz hadi"; "Acı haberi bir yaz günü aldık" yine ad)
const YC_CONT = String.raw`(?=\s+(?:(?:ve|sonra|da|de|ama)\s+(?:\p{L}+\s+){0,2}${ASK_A}|(?:bakalim|hadi|haydi|simdi)${TO_END}))`;
const NEWS_GV = String.raw`(?:(?:yap|hazirla|uret)(?:${REQ_FORM}|${PASS_FORM})?|(?:cek|yaz)(?:${REQ_FORM}|${PASS_FORM}|(?=${TO_END})|${YC_CONT}))`; // ara kelimeden sonra
const NEWS_GV_SG = String.raw`(?:(?:yap|hazirla|uret)(?:${REQ_SG}|${PASS_FORM})?|(?:cek|yaz)(?:${REQ_SG}|${PASS_FORM}|(?=${TO_END})|${YC_CONT}))`; // zarflı ara kelimeden sonra
const GAP1 = String.raw`(?:(?=(?:\S+\s+){0,3}${GAP_DUR})(?:${GAP_TOK}){1,4}|(?!(?:\S+\s+){0,3}${GAP_DUR})(?:${GAP_TOK}){1,3})`;
const GAP1_O = String.raw`(?:(?=(?:\S+\s+){0,3}${GAP_DUR})(?:${GAP_TOK_O}){1,4}|(?!(?:\S+\s+){0,3}${GAP_DUR})(?:${GAP_TOK_O}){1,3})`;
const NEWS_RE = new RegExp(String.raw`(?<!\p{L})(?:son\s*(?:dakika|dk)(?!\p{L}|['’])(?!${REFUSAL_NEWS})(?=\s+${SD_FOLLOW}(?:${TO_END}|${TO_ASK})|${TO_ASK})|`
  + String.raw`haber(?:i|ini|inin|ler|leri|lerini)?\s+(?:videosu(?:nu)?\s+)?(?:${NEWS_V}(?:${REQ_FORM}|${PASS_FORM})?|${GAP1_O}${NEWS_GV}|${GAP1}${NEWS_GV_SG})`
  + String.raw`(?!\p{L})${SAY}|`
  + String.raw`(?:^[^\p{L}\p{Nd}]*|(?:(?:bu|su)(?:\s+video)?|bunu|sunu|videoyu)(?:\s+d[ae])?\s+(?=haber\s+olsun${SIGN_END}))haber\s+olsun(?!\p{L})${SAY}|`
  + String.raw`^[^\p{L}\p{Nd}]*(?:(?:bundan|bunun|bunu|sundan|sunun|bir|bi)\s+){0,2}haber(?:i|ini)?\s+(?:videosu\s+)?istiyorum(?!\p{L})${SAY}|`
  + String.raw`haber\s+olarak(?=(?:\s+${FILLTOK}){1,4}${KIND_T}|[^\S\n]*(?:$|\n|(?![,;])${KIND_SIGN}|[,;](?=${SIGN_END}|${TO_ASK}|\s*${REFUSED_P}))|${TO_ASK})|`
  + String.raw`haber\s+(?:gibi|seklinde|tarzinda|formatinda|diliyle)(?=${TO_ASK})|`
  + String.raw`(?:habere\s+(?:cevir|donustur)|haberlestir|haber\s+haline\s+getir)(?:${REQ_FORM})?(?!\p{L})${SAY})(?!${REFUSAL_NEWS})`, "u");
// talimatın son sözü "haber olsun" yalnız metinde gülme emojisi yoksa (common.py _HO_END; "Kedim ilk kez kar gördü, haber olsun 😹" şaka)
const HO_END = new RegExp(String.raw`(?<!\p{L})(?<![ae]\s)${HO_IDIOM}haber\s+olsun(?=${SIGN_END})`, "u");
// bu/şu/bunu/videoyu + "haber olsun" ardından altyazı sürüyorsa yalnız gülme işareti yoksa (common.py _HO_THIS; 9. tur: "Bu haber olsun 😂 Köpek
// postacıyı kovaladı" şaka; son söz olan "bu video haber olsun 😂" NEWS_RE'de)
const HO_THIS = new RegExp(String.raw`(?<!\p{L})(?:(?:bu|su)(?:\s+video)?|bunu|sunu|videoyu)(?:\s+d[ae])?\s+haber\s+olsun(?!\p{L})${SAY}(?!${REFUSAL_NEWS})`, "u");
// "haberini sen hazırla" (ara kelime "sen") de yalnız metinde gülme işareti yoksa (common.py _NEWS_SEN; "Haberini sen yap, tıklanmayı biz
// alalım 😂" şaka; inceleme, 20 Ekim)
const NEWS_SEN = new RegExp(String.raw`(?<!\p{L})haber(?:i|ini|inin|ler|leri|lerini)?\s+(?:videosu(?:nu)?\s+)?(?:${GAP_TOK}){0,2}sen\s+(?:${GAP_TOK}){0,2}`
  + String.raw`${NEWS_GV}(?!\p{L})${SAY}(?!${REFUSAL_NEWS})`, "u");
// ZAYIF biçim (yalnız açık mizah/viral ifadesi yoksa haber): etiket "son dakika" + ifade sonu ("son dakika:", "#sondakika"); talimatın başında
// "son dakika" + kesme işaretli özel ad ya da rakam ("Son dakika Kadıköy'de yangın"; "Son dakika golüne sevinen", "Son dakika yetişen damat"
// değil); talimatın başında (bunu/videoyu/bu fragmanı +) fiilsiz "haber gibi" + ifade sonu ya da rakam ("haber gibi 40 saniye"; "Tıpkı bir
// haber gibi.", "sahte haber gibi, mizah olarak paylaş" değil; işaret ve satır sonu yalnız ardından işaret/dolgu/süre ya da kısa istek cümlesi
// gelirse: "Haber gibi 😂 Minik muhabir sınıfta hava durumunu sundu" değil); metinde gülme emojisi varsa iki "son dakika" biçimi sayılmaz
// (şaka altyazısı: "Son dakika 2 dakika kala otobüse yetişen öğrenci 😂", "SON DAKİKA: Annem tatlıyı yine saklamış 😂"; inceleme, 19 Ekim)
// gülme işareti (common.py _LAUGH aynı kalıp): gülen/utanan/dil çıkaran emojiler ve yazıyla gülme (haha, ahah, jsjs, sjsj, kdkd, ksks, xd, :d;
// inceleme, 20 Ekim: "Son dakika: Kedim yine kanepeyi parçaladı 🙈", "… ahahaha", "… ülke şokta 💀" haber oluyordu)
const LAUGH = new RegExp(String.raw`[😂🤣😹😆😅😁😄😝🤪🙈🤭😜😛😀😃🙃💀]|(?<!\p{L})(?:a?(?:ha){2,}h?|ah(?:ah)+|(?:js){2,}j?|(?:sj){2,}s?|(?:kd){2,}k?|(?:ks){2,}k?|xd+|:d+)(?!\p{L})`, "u");
const SD_LABEL = new RegExp(String.raw`(?<!\p{L})son\s*dakika(?!\p{L}|['’])(?!${REFUSAL_NEWS})(?=${KIND_T})`, "u");
const NEWS_START = new RegExp(String.raw`^[^\p{L}\p{Nd}]*son\s*dakika\s+(?=\p{L}+['’]|[0-9])`, "u");
const NEWS_LIKE = new RegExp(String.raw`^[^\p{L}\p{Nd}]*(?:(?:(?:bu|su)\s+)?(?:bunu|sunu|videoyu|fragmani)\s+)?haber\s+(?:gibi|seklinde|tarzinda|formatinda|diliyle)`
  + String.raw`(?=[^\S\n]*[0-9]|${SIGN_END}|${CLAUSE}\s+${ASK_A}(?!${REFUSAL_NEWS})${SAY})`, "u");
// tür ifadesi: mizah/mizahi/komik/viral/trend/çok izlenen + ((bir) video…/içerik…/paylaşım… | olarak | amaçlı | kategori… | şekilde/biçimde/
// dille) yalnız ardından ifade sonu, dolgu/süre, istek/yayın fiili (edilgen istek de: "yapılsın", "yapılacak"), "ama/ve" + istek gelirse;
// ya da tür kelimesi + "yap…"/"olsun" ("mizah yap sesi kalsın"; "viral olsun" değil); ardından alıntı/amaç sözü gelirse değil ("Komik video
// olsun diye"); video adının ilgi/bulunma/araç hâli olayı anlatır ("viral videonun sahibi", "videodaki"); ilgi hâlinden sonra ("kavganın
// viral videosu") yalnız fiille
const KIND_NOUN = String.raw`(?:video|icerik|paylasim)(?!\p{L}*?(?:[iu]n|[dt][ae](?:ki)?|l[ae])(?!\p{L}))\p{L}*`;
const KIND_WORD_RX = String.raw`\p{L}+(?:['’]\p{L}+)*(?!\p{L}|['’]\p{L})`; // kelime (kesme işaretli ek aynı kelime: "Kadıköy'de")
const KIND_VERB = String.raw`\s+(?!\s)(?:(?:ama|ve|ancak)\s+)?(?:${GAP_O}${ASK_P}|${GAP}${ASK_P_SG})(?!${REFUSAL_KIND})${SAY}`;
// ciddi olay sözlü metinde ifade sonu (KIND_END_S, common.py _KIND_END_S aynı kural): metin sonu (araya dolgu/süre) ya da işaret/satır sonundan
// sonra metnin kalanında en çok 4 kelime (link, süre ve dolgu sayılmaz) ve aralarında cümle sonu -DI geçmiş zaman yok ("komik video, kısa kes";
// "Viral video: Selde araçlar sürüklendi" değil). Daha uzun kalan metin phraseKinds'te (KIND_SIGNHEAD_RE): sahibin istek/kurgu fiili ya da
// -DI'sız şimdiki zamanla anlatım varsa tür sayılır (inceleme, 20 Ekim: "komik video, 30 saniye, başındaki titrek kısmı kes", "komik video:
// adam merdivenden kayıyor…" tür; "Komik video, acı son: Balkondan düşen genç hayatını kaybetti" değil)
const FILL_W = String.raw`(?:saniye\p{L}*|sn|dakika\p{L}*|dk|lutfen|bunu|sunu|hemen|olarak)(?!\p{L})`; // kelime sayısına girmeyen dolgu
const FEW_SEP = String.raw`(?:(?!\p{L})[\s\S]|(?:https?:|www\.)\S*(?!\S)|(?<!\p{L})${FILL_W}|(?<=[0-9]['’])\p{L}+(?!\p{L}))*`; // sayının eki kelime değil ("14'te"; 11. tur)
// cümle sonu -DI geçmiş zaman (haber dili: düştü, kaybetti, kurtarıldı; -DI ile biten yaygın adlar değil)
const PAST_W = String.raw`(?!(?:kedi|kendi|simdi|hindi|hadi|haydi|ordu|alti|ustu|arti|ortu|yedi|parodi|komedi|trajedi|melodi|parti|kutu|adi|tadi|kaydi|yurdu|`
  + String.raw`saati|sirketi|devleti|milleti|goruntu|marti|pati|bati|kati|cati|seti)(?!\p{L}))\p{L}{2,}[dt][iu](?:[mnkz]|l[ae]r|n[iu]z)?(?!\p{L})(?=[^\S\n]*(?:$|\n|${KIND_SIGN}))`;
// (beşinci kelime aranır, bulununca hemen biter: uzun girdide her ifadede geri izleme yok)
const FEW_W = String.raw`${FEW_SEP}(?!${FILL_W}|https?:|www\.)(?<![0-9]['’])`; // kelimeye kadar (link bölünmez, dolgu kelime değil)
const KIND_END_S = String.raw`(?:\s+${FILLTOK}){0,4}[^\S\n]*(?:$|(?=\n|${KIND_SIGN})(?!(?:${FEW_W}${KIND_WORD_RX}){5})(?!(?:${FEW_W}${KIND_WORD_RX}){0,3}${FEW_W}${PAST_W}))`;
// ÖNCE HEAD (common.py _KIND_FOLLOW; 15. tur, inceleme, 21 Ekim: 9.-14. turun "işaretten sonra en çok 4 kelime ya da -DI/şimdiki zamanla en
// çok 8 kelime" kuralı HEAD'in "komik video, teşekkürler abi, iyi akşamlar, kolay gelsin", "Komik video: düğünde gelini görünce bayılan damat
// 😂" türünü düşürüyordu): ciddi olay sözü (SERIOUS, OLU) yoksa ya da gülme işareti varsa HEAD'in kuralı — tür ifadesinden sonra işaret,
// satır sonu ya da metin sonu (araya dolgu/süre) yeter, kalan metin ne olursa olsun —; ciddi olay sözü varken 8. turun kuralı (KIND_END_S):
// "Komik video, acı son: Balkondan düşen genç hayatını kaybetti" tür almaz
const KIND_FOLLOW = String.raw`${TO_END}|${KIND_VERB}`;
const KIND_FOLLOW_S = String.raw`${KIND_END_S}|${KIND_VERB}`;
// ciddi olay sözü (kindFold'lu; "öldü" harfsiz yazımda "oldu"dan ayrılmaz: OLU tr-TR küçük harfli asıl metinde; common.py _SERIOUS/_OLU)
const SERIOUS = new RegExp(String.raw`(?<!\p{L})(?:hayatini\s+kaybet|yasamini\s+yitir|can\s+verdi|vefat|sehit|oldurul|olu(?:ler\p{L}*)?(?!\p{L})|yaralan|yarali|`
  + String.raw`gozalti|tutuklan|kaza(?!n)|deprem|yangin|sel(?:de|den|e|i|in|ler)?(?!\p{L})|saldir|cinayet|intihar|patlama|enkaz|`
  + String.raw`kurtarilamadi|istifa|bogul|katliam|bicakla|silahli|kursun|teror|bombal|taciz|istismar|darp|kaybol|kacirildi|felaket|`
  + String.raw`carpt|carpis|gercek(?!\p{L}))`, "u");
const OLU = /(?<![a-zçğıöşüâîû])öl(?:dü|dür|ü|müş|en)/;
const olu = (x) => OLU.test(String(x || "").toLocaleLowerCase("tr-TR"));
// esprili/komedi de mizah ("esprili bi video yap", "bunu komedi videosu yap"; yalın etiket değil)
const KIND_WORD = String.raw`(mizah|mizahi|komik|esprili|komedi|viral|trend|cok\s+izlenen)`;
const PHRASE_KIND = Object.assign(Object.create(null), KIND_WORDS, { esprili: "mizah", komedi: "mizah" });
const KIND_REST = String.raw`\s+(?:(?:bir|bi)\s+)?(?:${KIND_NOUN}|sey|bisey|birsey|olarak|amacli|kategori\p{L}*|sekilde|bicimde|dille|tarz(?:i|da|inda))(?!\p{L})`
  + String.raw`(?!${REFUSAL_KIND})`;
const KIND_DOV = String.raw`\s+(?:${ASK_V}(?:${REQ_FORM}|${PASS_FORM})?|${ASK_GEC}|(?<!viral\s)olsun|${KIND_WANT})(?!\p{L})(?!${REFUSAL_KIND})${SAY}`;
// "mizaha çevir" ("habere çevir" gibi; inceleme, 19 Ekim): 4. grup. Fiilsiz ifade üstünlük sıfatından sonra betimleme ("Haftanın en çok izlenen
// videosu: …", "en komik video 😂"; inceleme, 20 Ekim)
const kindPhraseRe = (follow) => new RegExp(String.raw`(?<!\p{L})(?:(?<![iu]n\s)(?<!(?<!\p{L})en\s)${KIND_WORD}(?:${KIND_REST}(?=${follow})|${KIND_DOV})|${KIND_WORD}${KIND_REST}(?=${KIND_VERB})|`
  + String.raw`(mizah)a\s+(?:cevir|donustur)(?:${REQ_FORM})?(?!\p{L})(?!${REFUSAL_KIND})${SAY})`, "gu");
const KIND_PHRASE_RE = kindPhraseRe(KIND_FOLLOW), KIND_PHRASE_S = kindPhraseRe(KIND_FOLLOW_S);
// #etiket yalnız kısa metinde, metnin tek etiketiyse ya da gülme işaretiyle mizah/viral etiketiyse tür (common.py _KIND_HASH; 9. tur: uzun
// altyazının sonundaki etiket dizisi tür değil); #mizah ve #haber birlikte + gülme işareti → mizah
const KIND_HASH = new RegExp(String.raw`(?<!\p{L})#(mizah|mizahi|komik|trend|viral|haber)(?!\p{L})(?!${REFUSAL_KIND})`, "gu");
const HASHTAG = /(?<!\p{L})#\p{L}/gu;
// işaret ya da satır sonuyla biten tür ifadesi: kalan metne phraseKinds bakar (metin başına bir kez: son istek fiili, son şimdiki zaman, son -DI
// geçmiş zaman yeri). Sahibin istek/kurgu fiili tekil/sahip biçiminde (REQ_SG; yayın fiilleri ve "yorum yaz" sayılmaz) ya da "kalsın"
const KIND_SIGNHEAD_RE = new RegExp(String.raw`(?<!\p{L})(?<![iu]n\s)(?<!(?<!\p{L})en\s)${KIND_WORD}${KIND_REST}(?:\s+${FILLTOK}){0,4}[^\S\n]*(?=\n|${KIND_SIGN})`, "gu");
const OWN_V = String.raw`(?:anlat|yap|hazirla|uret|sun(?!un(?![a-z]))|yaz|kurgula|ver|goster|cek|at|isle|seslendir|oku|cevir|donustur|olustur|canlandir|`
  + String.raw`tasarla|ciz|koy(?!un(?![a-z]))|ekle|kullan|tut|ozetle|duzenle|kes|kisalt|al|yavaslat|hizlandir|sil|kirp|cikar)`;
const KIND_ASK_RE = new RegExp(String.raw`(?<!\p{L})(?<!yorum\s)(?:${OWN_V}(?:${REQ_SG})?(?!\p{L})(?!${REFUSAL_KIND})${SAY}|kalsin(?!\p{L}))`, "gu");
const KIND_PROG_RE = new RegExp(String.raw`(?<!\p{L})\p{L}+[iu]yor(?:[iu]m|[iu]z|sun(?:uz)?|l[ae]r)?(?!\p{L})`, "gu");
const KIND_PAST_RE = new RegExp(String.raw`(?<!\p{L})${PAST_W}`, "gu");
// kalan metinde saat de sahibin isteğidir (14. tur; common.py _KIND_SCHED aynı metin; inceleme, 21 Ekim: WhatsApp videosunun açıklamasında
// "mizah videosu, 2 saat sonra yayınlarsan iyi olur", "komik video! 1 saat sonra paylaş sağ ol", "komik video, 21:30 sularında post et sağ ol"
// HEAD'de türdü, işaretten sonra en çok 4 kelime kuralına takılıyordu): saat (18:30, 9'da, akşam 9, 2 saat sonra) varsa ve ardından -DI
// geçmiş zaman yoksa tür
const KIND_SCHED_RE = new RegExp(String.raw`(?<![0-9.,:])[0-9]{1,2}(?::[0-9]{2}(?![0-9])|(?:[.:][0-9]{2})?['’](?:d[ae]|t[ae])(?!\p{L}))|(?<!\p{L})(?:(?:saat|sabah|ogle(?:n|den\s+sonra)?|aksam|gece|ikindi)\s+(?:saat\s+)?[0-9]{1,2}(?![0-9])|(?:[0-9]{1,3}|bir|yarim)\s*(?:dakika|dk|saat)\s+sonra(?!\p{L}))`, "gu");
// sonda işaretten (ya da satır sonundan) sonra yalın etiket ("Adam düştü 😂 mizah", "son dakika diil bu, viral"); tür olarak yalnız kısa
// metinde (etiketin dışında en çok TAG_WORDS kelime; inceleme, 19 Ekim: "Selde mahsur kalan aile helikopterle kurtarıldı - Viral" viral oluyordu)
const KIND_TAIL = new RegExp(String.raw`(?:${KIND_SIGN}|\n)[^\S\n]*#?(mizah|mizahi|komik|trend|viral|haber)(?:[^\S\n]*${KIND_SIGN})*\s*$`, "u");
const TAG_WORDS = 4;
const TAG_URL = /https?:\/\/\S*|www\.\S*/gu; // kelime sayısında link sayılmaz
// başta ayraçla etiket ("mizah, kısa kes"); ardından yalın başka etiket gelirse seçim açık ("haber/mizah sen karar ver"), etiket değil;
// ikinci etiket ifadenin başıysa ("mizah, haber gibi anlat") baştaki etiket geçer. Başlık biçimli iki nokta yalnız kısa metinde (ardından en
// çok 4 kelime: "#trend: sesi kalsın"; "Trend: Gençler arasında yayılan tehlikeli akım iki can aldı" değil; inceleme, 19 Ekim)
const KIND_LEAD = new RegExp(String.raw`^\s*#?(mizah|mizahi|komik|trend|viral|haber)\s*(?:[,;\-–/]|:(?=(?:(?:(?!\p{L})[\s\S])*${KIND_WORD_RX}){0,4}(?:(?!\p{L})[\s\S])*$))`
  + String.raw`(?!\s*#?(?:mizah|mizahi|komik|trend|viral|haber)(?!\p{L})(?!\s+(?:gibi|seklinde|tarzinda|formatinda|diliyle|olarak|amacli|olsun|(?:video|icerik|paylasim|${ASK_V})\p{L}*)(?!\p{L})))`, "u");
// sondaki etiket tür olarak yalnız kısa metinde; zayıf haber biçimini (anyLen: newsOf) her uzunlukta bastırır ("son dakika: …, mizah")
const phraseKinds = (s, anyLen = false, ser = false) => {
  const laugh = LAUGH.test(s), grave = (ser || SERIOUS.test(s)) && !laugh, rx = grave ? KIND_PHRASE_S : KIND_PHRASE_RE;
  const ks = new Set([...s.matchAll(rx)].map((m) => PHRASE_KIND[m[1] || m[2] || m[3]] || "trend"));
  const short = anyLen || (s.replace(TAG_URL, " ").match(new RegExp(KIND_WORD_RX, "gu")) || []).length <= TAG_WORDS + 1;
  const hk = new Set([...s.matchAll(KIND_HASH)].map((m) => KIND_WORDS[m[1]]));
  // ciddi olay sözü yoksa (ya da gülme varsa) #haber'siz mizah/viral hashtag'i HEAD gibi her uzunlukta tür (15. tur; common.py aynı kural:
  // "#mizah #komik Kedim yine masadan kaçtı", "Bu dans herkesi salladı #viral #trend"); #haber'li ya da ciddi uzun metin 9. turun kuralıyla
  if (hk.size && (short || (s.match(HASHTAG) || []).length === 1 || (laugh && [...hk].some((k) => k !== "haber")) || (!grave && !hk.has("haber")))) {
    for (const k of hk) if (!(k === "haber" && hk.has("mizah") && laugh)) ks.add(k);
  }
  const heads = [...s.matchAll(KIND_SIGNHEAD_RE)].filter((m) => !ks.has(PHRASE_KIND[m[1]] || "trend")); // türü zaten bulunan atlanır
  if (heads.length) { // işaretle biten tür ifadesi: kalanında sahibin isteği ya da -DI'sız şimdiki zamanla anlatım
    const last = (re) => { let p = -1; for (const m of s.matchAll(re)) p = m.index; return p; };
    const ask = last(KIND_ASK_RE), prog = last(KIND_PROG_RE), past = last(KIND_PAST_RE);
    let sched = -1; for (const m of s.matchAll(KIND_SCHED_RE)) sched = m.index + m[0].length; // saatin sonu (baş, saatin rakamını dolgu diye alabilir)
    for (const m of heads) { const e = m.index + m[0].length; if (ask >= e || ((prog >= e || sched >= e) && past < e)) ks.add(PHRASE_KIND[m[1]] || "trend"); }
  }
  const tail = s.match(KIND_TAIL);
  if (tail && short) ks.add(KIND_WORDS[tail[1]]);
  return ks;
};
// başta "Son dakika haberi:" / "SON DAKİKA HABERİ!" etiketi (ardından işaret ya da satır sonu) "son dakika:" gibi zayıf biçimdir (11. tur; common.py
// _SD_HABER aynı metin; inceleme, 20 Ekim: "Son dakika haberi: Kardeşim son dilim pizzayı yedi 😂" haber oluyordu): gülme işareti ya da açık
// #mizah/#komik/tür ifadesi karar verir; sahibin "son dakika haberi yap" isteği güçlü biçim kalır. Önünde emoji ve hashtag olabilir (13. tur;
// inceleme, 20 Ekim: "#mizah Son dakika haberi: …" güçlü biçim sayılıp haber oluyordu; en çok 8 hashtag: uzun dizide tarama kısa kalsın)
const SD_HABER = new RegExp(String.raw`^(?:[^\p{L}\p{Nd}]*#(?:\p{L}|[0-9])+){0,8}[^\p{L}\p{Nd}]*son\s*(?:dakika|dk)\s+haber(?:i|leri)?(?=[^\S\n]*(?:\n|${KIND_SIGN}))`, "u");
const newsOf = (t, ser = false) => {
  const lbl = SD_HABER.test(t);
  return NEWS_RE.test(lbl ? t.replace(SD_HABER, " ") : t) || ((HO_END.test(t) || HO_THIS.test(t) || NEWS_SEN.test(t)) && !LAUGH.test(t))
    || ((((SD_LABEL.test(t) || NEWS_START.test(t) || lbl) && !LAUGH.test(t)) || NEWS_LIKE.test(t)) && !["mizah", "trend"].some((k) => phraseKinds(t.replace(REFUSED_RE, " "), true, ser).has(k)));
};
const newsRequest = (text) => newsOf(kindFold(text), olu(text));
// yalnız etiket + dolgu ("mizah 40 saniye"; haber dışındaki etiketin yanında "yap"/"olsun" da: "mizah yap"; "viral olsun" değil;
// commands.js tagKind aynı kural)
const tagWords = (t) => {
  const words = t.match(/\p{L}+/gu) || [], soft = !words.includes("haber") && !(words.includes("viral") && words.includes("olsun"));
  return words.every((w) => KIND_WORDS[w] || KIND_FILL.test(w) || (soft && KIND_DO.test(w))) ? words.filter((w) => KIND_WORDS[w]) : [];
};
const contentKindOf = (instruction) => {
  const t = kindFold(instruction), s = t.replace(REFUSED_RE, " "), ser = olu(instruction); // s: reddedilen istekler atılmış
  const pick = (ks) => (ks.has("haber") ? "haber" : ks.has("mizah") ? "mizah" : ks.has("trend") ? "trend" : "");
  const tags = tagWords(s);
  if (tags.length) { const ks = new Set(tags.map((w) => KIND_WORDS[w])); if (ks.has("mizah") && LAUGH.test(t)) ks.delete("haber"); return pick(ks); } // "😂 #komik #haber" (9. tur)
  const lead = t.match(KIND_LEAD); // "Haber: Kedi itfaiyeyi alarma geçirdi 😂" baştaki etiket değil (9. tur)
  if (lead && !(lead[1] === "haber" && lead[0].includes(":") && LAUGH.test(t))) return KIND_WORDS[lead[1]];
  if (newsOf(t, ser)) return "haber";
  return pick(phraseKinds(s, false, ser));
};
// fragman isteği (common.py TRAILER_ASK / trailer_ask aynı kural): fragman/trailer/teaser (+ analiz…/özet…/video…/olarak) yalnız ardından ifade
// sonu, dolgu/süre ("fragman", "fragman:", "fragman 40 saniye"), istek fiili ("fragman yap", "bu fragmanı özetle", "fragmanı analiz et") ya da
// haber reddi ("fragmanı haber yapma") gelirse; linkin yanındaki "fragman çekimleri sırasında yaralandı", "Fragmanı izleyen hayranlar",
// "Fragmana tepki" haber videosunu fragman analizine göndermesin (inceleme, 19 Ekim). JS'de \b Türkçe harfte çalışmaz: harf sınıfı
const TR_WORD = String.raw`(?:fragman(?:[iae]\p{L}*|l[ae]r\p{L}*|d[ae]\p{L}*)?|trailer(?:s|i\p{L}*)?|teaser(?:s|i\p{L}*)?)`;
const TR_VERB = String.raw`(?:\s+(?:${ASK_GAP}|${FILLTOK})){0,3}\s+(?:${ASK_V}(?:${REQ_FORM})?|${ASK_GEC}|(?:incele|yorumla)(?:${REQ_FORM})?|analiz\s+e[td](?:${REQ_FORM})?)`
  + String.raw`(?!\p{L})(?!${REFUSAL_KIND})${SAY}`;
// işaret ve satır sonu yalnız ardından metnin sonuna kadar işaret, dolgu ya da süre gelirse ifade sonu (SIGN_END; "Gerçek hayattan fragman:
// Kartal tilkiyi havada yakaladı" fragman değil, "fragman: <link>" fragman); virgül, noktalı virgül, iki nokta, tire ya da satır sonundan
// sonra en çok dört kelimelik istek cümlesi de olur (CLAUSE: "fragman, kısa olsun"; inceleme, 19 Ekim)
// işaretten sonra yalnız sahibin istek biçimi (tekil emir, -sana, -ır mısın, olsun, kalsın, analiz et; REQ_SG) ve cümlede izleyiciye çağrı sözü
// yok (common.py _TR_VIEW/_CLAUSE_O/_TR_ASKV; inceleme, 20 Ekim: "Gerçek hayattan fragman 😱 hemen paylaşın", "Hayatın fragmanı 💔 beğen
// paylaş", "Bu gol fragman ⚽ izle paylaş" fragman değil); "bu fragman çok iyi, analiz et" (değerlendirme sözü + istek) istek
// (9. tur: bütün kelime; "fragman, yorumla", "fragman, takipçilere kısa anlat", "izlenme rekorunu da anlat" sahibin isteği)
// (10. tur: "yorumlara/yorumlarda/yorumunuzu", "beğendiyseniz" de; common.py _TR_VIEW aynı)
const TR_VIEW = String.raw`(?:izle(?:yin(?:iz)?)?|begen(?:in(?:iz)?|diyseniz)?|kaydet|kaydedin(?:iz)?|takip|abone|yorum(?:lar)?(?:[ae]|d[ae]|[iu]|[iu]n[iu]z[iu]?)?|`
  + String.raw`paylasin(?:iz)?|herkes)(?!\p{L})`;
const CLAUSE_O = String.raw`[^\S\n]*(?:${KIND_SIGN}(?:[^\S\n]*${KIND_SIGN})*(?![^\S\n]*${KIND_SIGN})|(?=\n))(?:\s+(?!${TR_VIEW})(?:\p{L}+|${FILLTOK})){0,4}`;
const TR_ASKV = String.raw`\s+(?!${TR_VIEW})(?:${ASK_V}(?:${REQ_SG})?|${ASK_GEC}|olsun|kalsin|(?:incele|yorumla)(?:${REQ_SG})?|analiz\s+e[td](?:${REQ_SG})?)(?!\p{L})`
  + String.raw`(?!${REFUSAL_KIND})${SAY}`;
const TR_EVAL = String.raw`(?:\s+(?:cok|baya|bayagi|gayet|cidden|asiri))?\s+(?:iyi|guzel|harika|super|efsane|mukemmel|muthis|sahane|basarili|etkileyici)`
  + String.raw`(?:\s+olmus)?(?![a-z])`;
// talimatın başındaki fragman sözü + işaretten sonra sahibin çoğul isteği de (common.py _TR_ASKV_PL; 9. tur: "fragman, analiz edin")
const TR_ASKV_PL = String.raw`\s+(?!${TR_VIEW})(?:${ASK_V}|incele|yorumla|analiz\s+e[td])(?:${REQ_PL})(?!\p{L})(?!${REFUSAL_KIND})${SAY}`;
const TRAILER_ASK = new RegExp(String.raw`^[^\p{L}\p{Nd}]*${TR_WORD}(?!\p{L})(?:\s+(?:analiz\p{L}*|ozet\p{L}*|video\p{L}*|olarak))?(?=${CLAUSE_O}${TR_ASKV_PL})|`
  + String.raw`(?<!\p{L})${TR_WORD}(?!\p{L})(?:\s+(?:analiz\p{L}*|ozet\p{L}*|video\p{L}*|olarak))?`
  + String.raw`(?=${SIGN_END}|${TR_VERB}|(?:${TR_EVAL})?${CLAUSE_O}${TR_ASKV}|[^\S\n]*[,;]?\s+(?:haber\p{L}*|son\s*dakika)${REFUSAL_NEWS})`, "u");
// metnin sonundaki #etiket dizisi, önünde 4'ten çok kelime varsa atılır (common.py _hash_tail; 9. tur: "Ünlü oyuncu sette kaza geçirdi 😱
// #magazin #dizi #fragman" fragman isteği değil)
const hashTail = (t) => {
  const toks = [...t.matchAll(/\S+/g)];
  let k = toks.length;
  while (k && toks[k - 1][0].startsWith("#")) k--;
  if (k > 0 && k < toks.length && (t.slice(0, toks[k].index).replace(TAG_URL, " ").match(new RegExp(KIND_WORD_RX, "gu")) || []).length > 4) return t.slice(0, toks[k].index);
  return t;
};
// fragman sözü yoksa kalıp ve sondaki etiket ayıklaması hiç çalışmaz (yalnız hız; common.py _TR_HINT aynı metin)
const TR_HINT = /fragman|trailer|teaser/;
const trailerAsk = (instruction) => { const t = kindFold(instruction); return TR_HINT.test(t) && TRAILER_ASK.test(hashTail(t)); };
const kindOf = (v) => (["haber", "trend", "mizah"].includes(v?.kind) ? v.kind : contentKindOf(v?.instruction));
// açma dışı istek fiilli tür ifadesi (commands.js linkte açma istisnası E1; açma fiilleri "x" yapılmış metinde): "mizah yap", "mizah olarak
// paylaş", "komik video yap", "mizah olsun"; fiilsiz betimleme ("şunu aç, çok komik bir video 😂") ve "mizah göster" sayılmaz
const KIND_ASK_PHRASE = new RegExp(kindPhraseRe(KIND_VERB).source, "u");
const kindAsk = (text) => KIND_ASK_PHRASE.test(kindFold(text).replace(REFUSED_RE, " "));
// uzun video özeti (kullanıcı isteği, 19 Ekim): settings.longSummary (scripts/common.py summary_cfg ile aynı kural)
const longSummaryCfg = () => {
  const raw = settings().longSummary;
  const t = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : raw === false || raw === "false" ? { enabled: false } : {};
  const off = (v) => v === false || v === 0 || ["false", "0"].includes(String(v).trim().toLowerCase());
  const num = (v, d, zero = false) => { const x = Number(v); return Number.isFinite(x) && (x > 0 || (zero && x === 0)) ? x : d; };
  return { ...t, enabled: !off(t.enabled ?? true), auto: !off(t.auto ?? true), duration: num(t.duration, 40), minSeconds: num(t.minSeconds, 600), maxSoundSeconds: num(t.maxSoundSeconds, 8, true), maxSeconds: num(t.maxSeconds, 10800) };
};
// Benzer video, sıfırdan (kullanıcı isteği, 19 Ekim: "bir video gönderdiğimde o videoyu izleyip kelimelerini çıkartıp o videodaki gibi sıfırdan
// video üretmesini benzer bir şekilde yapmasını sağlayabilir miyiz"): video izlenir, kelimeleri çıkarılır, aynı hikâye kendi cümlelerimizle
// yeniden yazılıp sahneler sıfırdan çizilir (wa_video.py build_recreate); "🔁 yeniden yayınla" değildir. scripts/common.py recreate_ask ile
// AYNI kalıp metni ve kural (kindFold'lu metinde). ÖNCE KESİNLİK (inceleme, 19 Ekim: serbest ara kelimeli, fiili uzakta olabilen kalıplar
// "Esnaf sıfırdan başladı 30 saniyelik video yap", "tekneleri sıfırdan yapıp satıyor, haber yap" haber görüntüsünü atıp çizilmiş hikâye
// yapıyordu): yalnız BAŞ (benzerini, buna benzer, aynısını, sıfırdan, gibisini, böylesini, esinlenerek, ilham alarak, benzer + şey adı + fiil,
// bunun gibi, videodaki gibi, bu tarzda/formatta/stilde, benzer şekilde) + yalnız beyaz liste ara kelimeleri (bir, kısa, N saniyelik, türkçe,
// biz de, bana, yeniden, bir tane daha, yarın, video, hikâye…) + İSTEK BİÇİMİNDE fiil (yap/üret/çiz/anlat/hazırla/tasarla/oluştur/canlandır;
// REQ_FORM + "yapılsın") ya da şey adı + olsun/istiyorum/talimat sonu. "videodaki/videonun" yalnız BU video (bu/şu'dan sonra, talimatın başında,
// işaretten ya da satır sonundan sonra, bunu/lütfen/aynen/tıpkı/abi/tamam/sen de'den sonra; "dünkü videodaki gibi", "önceki videonun aynısını",
// "onun gibi" başka videodur); "Togg'un benzerini"
// (ilgi hâli), "buna da aynısını yap" (yönelme hâli deyimi) ve şey adı olmadan sola bağlı "Anayasayı sıfırdan yapalım", "kurgu kötü olmuş,
// sıfırdan yap" baş değil; ardından değil/olmasın/istemem/gerek yok/yok ya da alıntı/amaç sözü (diye/dedi/derken/diyen/deyince) gelirse
// sayılmaz; ses/görüntü koruma isteği ("sesi kalsın", "orijinal sesle"; ardından ret gelmezse) varsa değil (RC_KEEP). Açık haber isteği (newsRequest) varsa yalnız
// nesneyi adlandıran baş (RECREATE_STRONG) kazanır: "bunun gibi", "bu tarzda", "benzer şekilde" haber isteğine yenilir. settings.waVideo.recreate
// kapalıysa hiç sayılmaz (recreateOn)
const RC_STEM = String.raw`(?:(?:yap|uret|ciz|anlat)(?:t[iu]r|d[iu]r)?|(?:hazirla|tasarla|olustur|canlandir)t?)`;
const RC_NUM = String.raw`(?:[0-9]+(?:[.,][0-9]+)?|(?:bir|iki|uc|dort|bes|alti|yedi|sekiz|dokuz|on|yirmi|otuz|kirk|elli|altmis|yetmis|seksen|doksan|yuz)`
  + String.raw`(?:\s+(?:bir|iki|uc|dort|bes|alti|yedi|sekiz|dokuz|on))?)`;
// "siz de" ara kelime (13. tur: HEAD'in kabulü; sahibin çoğul isteği "Bunun benzerini siz de yapın" benzer video); yalın "daha" HEAD gibi ara
// kelime değil (14. tur; inceleme, 21 Ekim: alıntılanan izleyici sorusu ""Bunun gibi bir video daha yapar mısınız?" sorusuna cevap" benzer
// video oluyordu; "bir tane daha" kalır)
const RC_FILL = String.raw`(?:bir|bi|yeni|kisa|uzun|turkce|ingilizce|${RC_NUM}\s*(?:saniye|sn|dakika|dk)(?:lik|\s*['’]\s*l[iu]k)?|(?:biz|sen|siz)(?:\s+d[ae])?|`
  + String.raw`bana|bize|(?:benim|bizim)\s+icin|ayni|sifirdan|yeniden|tekrar|tarzda|sekilde|olarak|(?:${RC_NUM}\s+)?tane(?:\s+daha)?|sey|bisey|birsey|`
  + String.raw`lutfen|hemen|`
  + String.raw`yarin|bugun|simdi|kendi\s+(?:cumle|soz)[a-z]*)(?![a-z])`;
const RC_THING = String.raw`(?:video(?:su|lar|lari)?|icerik|animasyon(?:la|lu)?|hikaye(?:yi)?|kissa(?:yi)?|cizim|cizgi\s+film(?:i|le|\s+gibi)?)(?![a-z])`;
const RC_GAP = String.raw`(?:\s+(?:${RC_FILL}|${RC_THING})){0,4}`;
const RC_GAP_T = String.raw`(?:\s+${RC_FILL}){0,3}\s+${RC_THING}(?:\s+${RC_FILL}){0,2}`;
const RC_WANT = String.raw`\s+(?:olsun|istiyoru[mz]|isterim|isteriz)(?![a-z])`;
const RC_END = String.raw`(?:${RC_WANT}|[^a-z0-9:]*$|\s*[,.;:!?…]+\s*(?:${RC_FILL}|${RC_THING})`
  + String.raw`(?:\s+(?:${RC_FILL}|${RC_THING})){0,3}[^a-z0-9:]*$)`; // iki nokta açıklama başlatır, son değil ("Sıfırdan animasyon: …")
const RC_GEN = String.raw`(?:(?<![iu]n\s)|(?<=(?<![a-z])bunun\s)|(?<=(?<![a-z])sunun\s))`; // ilgi hâli yalnız bunun/şunun (kelime başından)
const RC_DAT = String.raw`(?<![ae]\sd[ae]\s)(?<!(?<![a-z])(?:buna|suna|bana|sana|bize|size)\s)(?<!(?<![a-z])ona\s)`; // "buna da aynısını yap" deyimi değil
const RC_LEFT = String.raw`(?:^[^a-z0-9]*|(?:bunu|sunu|onu|bunlari|videoyu|videolari|hikayeyi|kissayi|icerigi|animasyonu|hepsini|tamamen|`
  + String.raw`lutfen|ve|ama|sonra|yeniden)(?:\s+d[ae])?\s+)`; // şey adsız "sıfırdan"ın solu
// "videodaki/videonun" BU video: bu/şu'dan sonra, talimatın başında, dolgu sözünden sonra ("abi/tamam/sen de videodaki gibi yap"; inceleme,
// 19 Ekim); işaretten ya da satır sonundan sonra ve tıpkı/aynen/hemen (da/de)/siz de'den sonra (RC_THIS_H) — tekil ve çoğul istekte HEAD'in
// yerleri (13. tur: 12. turun "evde/sizde videodaki gibi yap" tekil eki kalktı) ("Çocuklar için masal. Videodaki gibi yap", "tıpkı videodaki gibi yap")
const RC_THIS = String.raw`(?:(?:bu|su)\s+|(?:^[^a-z0-9]*|(?<=[^a-z0-9\s][^\S\n])|`
  + String.raw`(?:(?:bunu|sunu|lutfen|ayni|tam|abi|tamam)(?:\s+d[ae])?|sen\s+d[ae])\s+)(?:o\s+)?)`;
const RC_THIS_H = String.raw`(?:(?<=[^a-z0-9\s]|\n)[^\S\n]*|(?:(?:tipki|aynen|hemen)(?:\s+d[ae])?|siz\s+d[ae])\s+)(?:o\s+)?`;
const RC_TARZ = String.raw`\s+(?:tarz(?:i|da|inda|iyla)?|format(?:i|ta|inda)|stil(?:i|de|inde))(?![a-z])`;
// çoğul istek ardından yalnız üretim bilgisi (süre, kısa/uzun, dil) gelirse tekil yolda da sahibin isteği ("tıpkı videodaki gibi yapın, 40 saniye")
const RC_PROD = String.raw`(?:${RC_NUM}\s*(?:saniye|sn|dakika|dk)(?:lik|\s*['’]\s*l[iu]k)?|kisa|uzun|turkce|ingilizce)(?![a-z])`;
const RC_PRODEND = String.raw`(?=[^a-z0-9:]*(?:${RC_FILL}[^a-z0-9:]*){0,2}${RC_PROD}[^a-z0-9:]*(?:${RC_FILL}[^a-z0-9:]*){0,2}$)`;
// benzer video başları (common.py _rc_heads aynı metin): sg → yalnız tekil/sahip istek biçimi (RC_REQ_SG1: yap, yapsana, yapar mısın, yapalım…;
// edilgen "yapılsın" da; çoğul istek yalnız ardından üretim bilgisiyle, RC_PRODEND); değilse çoğul/kibar istek de (yapın, hazırlayın, yapar
// mısınız; HEAD'in kabul ettiği her yerde)
// metnin başındaki selamlama, nezaket ve hitap sözü (16. tur; common.py _RC_COURT aynı metin)
const RC_COURT = String.raw`(?:lutfen|selam(?:lar)?|merhaba(?:lar)?|gunaydin|iyi\s+(?:aksamlar|gunler|geceler|calismalar)|kolay\s+gelsin|tesekkur(?:ler|\s+ederim)?|tsk(?:ler)?|sag\s*ol(?:un)?|saol(?:un)?|eyvallah|abi|abla|kanka|kanki|hocam|reis|usta|kardes(?:im)?|canim|dostum|emixhas|jarvis|tamam)(?![a-z])`;
const rcHeads = (sg) => {
  const v = sg ? String.raw`${RC_STEM}(?:(?:${RC_REQ_SG1}|${PASS_OPT})?(?![a-z])|(?:${REQ_PL})(?![a-z])${RC_PRODEND})` : String.raw`${RC_STEM}(?:${RC_REQ}|${PASS_OPT})?(?![a-z])`;
  const doo = String.raw`(?:${RC_GAP}\s+${v}|${RC_GAP_T}${RC_END})`, doT = String.raw`${RC_GAP_T}(?:\s+${v}|${RC_END})`, doW = String.raw`${RC_GAP_T}(?:\s+${v}|${RC_WANT})`;
  const th = String.raw`(?:${RC_THIS}|${RC_THIS_H})`;
  // işaretten sonra şey adsız "sıfırdan" yalnız çizim/anlatım fiiliyle ("kıssası, sıfırdan anlat"; "kurgu kötü olmuş, sıfırdan yap" değil)
  let strong = String.raw`${RC_LEFT}sifirdan(?![a-z])${doo}|sifirdan(?![a-z])${doT}|`
    + String.raw`(?<=[^a-z0-9\s])\s*sifirdan(?![a-z])${RC_GAP}\s+(?:(?:uret|ciz|anlat)(?:t[iu]r|d[iu]r)?|canlandir|tasarla)(?:${sg ? RC_REQ_SG1 : RC_REQ}|${PASS_OPT})?(?![a-z])|`
    + String.raw`${RC_GEN}(?:${RC_DAT}(?:benzer(?:ini|i|lerini)|aynisini)|(?:buna|suna)\s+benzer)(?![a-z])${doo}|`
    + String.raw`${th}(?:videonun|videodakinin)\s+(?:benzer(?:ini|i|lerini)|aynisini)(?![a-z])${doo}|`
    + String.raw`(?:(?:bunun|sunun)\s+gibisin(?:i|den)|boylesini|esinlenerek|ilham\s+alarak)(?![a-z])${doo}|`
    + String.raw`${RC_GEN}(?:benzer|(?:buna|suna)\s+benzeyen)(?![a-z])${doW}`;
  // "çizgi filme/animasyona çevir" yalnız tekil ("bunu animasyona çevir"; izleyiciye "Hayatınızı çizgi filme çevirin" değil), yalnız talimatın
  // başında ya da bu videoyu gösteren nesneden sonra (bunu, şunu, onu, bunları, videoyu, videoları, hikayeyi, kıssayı, içeriği; araya en çok
  // iki dolgu: "bu hikayeyi 45 saniyelik çizgi filme çevir") ve izleyici çağrısından (sen de/siz de) sonra değil (14.-15. tur; common.py aynı
  // metin; inceleme, 21 Ekim: uygulama/filtre reklamı "Fotoğrafını çizgi filme çevir", "Sen de çizgi filme çevir, filtre linki profilde",
  // "Hemen çizgi filme çevir, uygulama linki bio'da", "Yeni filtre: Çizgi filme çevir…" HEAD'de benzer video değildi); 16. tur: metnin başındaki
  // selamlama/nezaket/hitap sözünden sonra da (RC_COURT, ardından en çok iki dolgu; sen/siz değil) 14. turun kararı: "lütfen çizgi filme çevir",
  // "selam, çizgi filme çevir", "Tamam, çizgi filme çevir", "kolay gelsin, animasyona çevir" (15. turda benzer video değildi)
  if (sg) strong += String.raw`|(?:^[^a-z0-9]*(?:${RC_COURT}[^a-z0-9]*)+(?:(?!(?:sen|siz)(?![a-z]))${RC_FILL}\s+){0,2}|^[^a-z0-9]*|(?=(?:bunu|sunu|onu|bunlari|videoyu|videolari|hikayeyi|kissayi|icerigi)(?![a-z]))(?<!(?<![a-z])(?:sen|siz)\sd[ae]\s)(?<!(?<![a-z])(?:sende|sizde)\s)(?<!(?<![a-z])(?:sen|siz)\sd[ae]\s(?:bu|su)\s)`
    + String.raw`(?:bunu|sunu|onu|bunlari|videoyu|videolari|hikayeyi|kissayi|icerigi)(?:\s+d[ae])?\s+(?:(?!(?:sen|siz)(?![a-z]))${RC_FILL}\s+){0,2})`
    + String.raw`(?:cizgi\s+film|animasyon)[ae]\s+(?:cevir|donustur)(?:${RC_REQ_SG}|${PASS_OPT})?(?![a-z])`;
  const weak = String.raw`(?:${th}videodaki|bunun|sunun)\s+gibi(?![a-z])${doo}|(?:bu|su|ayni|bunun|sunun|${th}(?:videonun|videodaki))${RC_TARZ}${doo}|`
    + String.raw`benzer\s+(?:(?:bir|bi)\s+)?sekilde(?![a-z])${doo}`;
  return [strong, weak];
};
const [RC_S1, RC_W1] = rcHeads(true), [RC_S2, RC_W2] = rcHeads(false);
const RC_NOT = String.raw`(?!${sayWords("[a-z]")})(?!\s+(?:d(?:egi|ii|ei)l|olmasin|istemiyoru[mz]|istemem|istemeyiz|istemez|gerek\s+yok|gerekmez|gerekmiyor|`
  + String.raw`yok)(?![a-z]))`;
const RECREATE_ASK = new RegExp(String.raw`(?<![a-z])(?:${RC_S1}|${RC_W1})${RC_NOT}`); // tekil/sahip biçimi her yerde
const RECREATE_STRONG = new RegExp(String.raw`(?<![a-z])(?:${RC_S1})${RC_NOT}`);
const RECREATE_PL = new RegExp(String.raw`(?<![a-z])(?:${RC_S2}|${RC_W2})${RC_NOT}`); // çoğul/kibar da
const RECREATE_PL_STRONG = new RegExp(String.raw`(?<![a-z])(?:${RC_S2})${RC_NOT}`);
// ÇOĞUL/KİBAR İSTEK (13. tur; inceleme, 20 Ekim: 11.-12. turun izleyici sözü istisnası — siz de, etiketleyin, -abilirsiniz, çekiliş… —
// sahibin "bunun benzerini yapın, başlığı değiştirebilirsiniz", "… kaynağı etiketleyin" isteğini düşürüyordu): HEAD'in kabul ettiği her
// yerde, istisnasız benzer video (çıktı her zaman onay ister; yapıştırılan izleyici altyazısı benzer videoya gidebilir, sahip onaylamaz)
// orijinal sesi, müziği, şarkıyı, efektleri ya da görüntüyü koruma isteği sıfırdan çizimle çelişir (common.py RC_KEEP aynı metin; "şarkısı
// kalsın", "efektler kalsın", "orijinal şarkıyla"): "sesi kalsın", "orijinal sesle",
// "görüntüleri kullan"; araya da/de ve nitelik (aynen, aynı, olduğu gibi, orijinal, hiç), wa_video.WANT_SOUND biçimleri ve olumsuz bozma fiili
// (inceleme, 20 Ekim: "sesi olduğu gibi kalsın", "sesine dokunma", "sesi gitmesin", "ses kesilmesin", "müziği kalsın", "orijinal müzikle",
// "görüntüleri değiştirme" sesi atıp çiziyordu); anlatıcı sesi koruma değil ("kadın sesiyle anlat", "sesi olsun"); ardından (araya hiç/asla/
// kesinlikle) ret gelirse koruma değil: değil/diil/deil ("değil mi" soru ekidir, korur), yerine, yok ("yok olmasın" korur), gitsin, kapat/
// kaldır (ın/ılsın), kullan/iste/ol + olumsuz ek (inceleme, 19 Ekim: "orijinal görüntü kullanılmasın, bunun benzerini sıfırdan çiz")
const RC_KEEP_NEG = VERB_NEG.replaceAll(String.raw`\p{L}`, "[a-z]"); // u bayraksız kalıpta [a-z] (common.py _RC_KEEP_NEG aynı metin)
const RC_USE = String.raw`kullan(?:in|sana|ilsin)?`;
const RC_QUAL = String.raw`(?:\s+(?:d[ae]|aynen|ayni|oldugu\s+gibi|orijinal|tamamen|hic))?`;
const RC_SPARE = String.raw`(?:dokun|sil|kes|kis|kapat|degistir|kaldir|boz|git)(?:il|in|n)?m[ae](?:yin(?:iz)?|sin|d[ae]n|s[ae]n[ae])?`; // bozma fiili, olumsuz
const RC_KEEP = new RegExp(String.raw`(?<![a-z])(?!(?:muzik|efekt(?:ler)?|ses\s+efekt(?:i|ler|leri)?)\s+(?:kullan(?:in|sana|ilsin)?|ekle(?:yin|sene)?|acik|olsun)(?![a-z]))(?:(?:ses(?:i|ini|ine|ler|leri|lerini|lerine)?(?:\s+efekt[a-z]*)?|muzi(?:k|gi|gini|ge|gine|kler|kleri|klerini)|sarki(?:si(?:ni|na|yla)?|ya|yi|lar(?:i|ini|a)?)?|(?<!ses\s)efekt(?:ler)?(?:i|ini|e|ine)?)${RC_QUAL}`
  + String.raw`\s+(?:kalsin|koru|${RC_USE}|acik|ac(?:in|sana|ilsin)?|duy(?:ul)?s[iu]n|duyalim|verilsin|${RC_SPARE})|`
  + String.raw`(?:orijinal|gercek|asil|dogal|kendi|videonun)\s+(?:ses(?:i|iyle|le|ini|li|leri|lerini)?|muzi(?:k|kle|kli|gi|gini|giyle)|sarki(?:si|sini|siyla|yla|la|li)?|efekt[a-z]*)|`
  + String.raw`sesli\s+(?:${RC_USE}|ver(?:in|ilsin)?|olsun|bolum[a-z]*)|`
  + String.raw`(?:konusma|roportaj)[a-z]*${RC_QUAL}\s+(?:duyulsun|${RC_USE}|ver(?:in|ilsin)?|kalsin|${RC_SPARE})|`
  + String.raw`goruntu(?:ler)?(?:i|ini|yu|nu|ye|leri|lerini|lere)?${RC_QUAL}\s+(?:kalsin|koru|kullan(?:in|sana)?|${RC_SPARE})|`
  + String.raw`(?:orijinal|kendi)\s+goruntu[a-z]*)(?![a-z])`
  + String.raw`(?!\s+(?:(?:hic|asla|kesinlikle)\s+)?(?:d(?:egi|ii|ei)l(?!\s*m[iu](?![a-z]))|yerine|yok(?!\s+olmasin)|gitsin|`
  + String.raw`(?:kullan|iste|ol)(?:il|in|n)?${RC_KEEP_NEG}|(?:kapat|kaldir)(?:in(?:iz)?|sana|ilsin|sin)?(?![a-z])))`);
// benzer video başlarının her biri bu sözlerden birini içerir: yoksa kalıplar hiç taranmaz (yalnız hız; common.py _RC_HINT aynı metin)
const RC_HINT = /sifirdan|benze|aynisi|gibi|boylesi|esinlen|ilham|tarz|format|stil|cizgi\s+film|animasyon/;
const recreateAsk = (instruction) => {
  const t = kindFold(instruction);
  if (!RC_HINT.test(t) || RC_KEEP.test(t) || !(RECREATE_ASK.test(t) || RECREATE_PL.test(t))) return false;
  return RECREATE_STRONG.test(t) || RECREATE_PL_STRONG.test(t) || !newsOf(t, olu(instruction));
};
// tanıyıcı kalıpları açılışta derlenir (11. tur, ölçüm, 20 Ekim): V8 1000 karakterden kısa iki baytlık metinde (emoji, ’) kalıbı önce bayt
// koduna derliyor, büyük Unicode kalıplarında bu saniyeler sürüyor (ilk emojili WhatsApp mesajı ~2-3 sn bekliyordu); uzun metinle bir kez
// makine koduna derlenir (açılışta ~1 sn), sonraki her çağrı derlenmiş kodu kullanır
for (const r of [REFUSED_RE, NEWS_RE, HO_END, HO_THIS, NEWS_SEN, LAUGH, SD_LABEL, NEWS_START, NEWS_LIKE, SD_HABER, SERIOUS, KIND_HASH, KIND_SIGNHEAD_RE,
  KIND_ASK_RE, KIND_PROG_RE, KIND_PAST_RE, KIND_SCHED_RE, KIND_TAIL, KIND_LEAD, KIND_PHRASE_RE, KIND_PHRASE_S, KIND_ASK_PHRASE, TRAILER_ASK, RECREATE_ASK,
  RECREATE_STRONG, RECREATE_PL, RECREATE_PL_STRONG, RC_KEEP]) for (const w of ["⟪ a ".repeat(300), "a, ".repeat(400)]) { r.lastIndex = 0; r.test(w); r.lastIndex = 0; }
const recreateOn = () => { const v = waVideoCfg().recreate; return !(v === false || v === 0 || ["false", "0"].includes(String(v).trim().toLowerCase())); };
// ⬛ Kare (1:1) uzun video (kullanıcı isteği, 23 Ekim: "bazen 10 dakikalık kare video linki gönderebilirim; link kare video yazarsam gönderdiğim video kaç
// dakika ise ortalama o dakikalarda bir kare video üretmeli"): talimat kare uzun video istiyor mu — common.py KARE_ASK/kare_ask ile aynı kural
// (katlanmış metin). "kare video", "kare format", "kare olsun", "kare yap", "uzun kare video", "1:1"; "kareler", "kareyi kes" değil.
// Ayar settings.kare {enabled true, maxSeconds 1800} (common.kare_cfg aynı kural).
const KARE_ASK = /(?<![\p{L}\p{N}_])(?:kare|square)(?:\s+(?:uzun|format(?:ta|inda)?|bir))?\s*(?:video\w*|format\w*|olsun|yap\w*|haber\w*|olarak)(?![\p{L}\p{N}_])|(?<![\p{L}\p{N}_])uzun\s+kare(?:\s+video\w*)?(?![\p{L}\p{N}_])|(?<![\d.,:])1\s*[:x]\s*1(?![\d.,:])/iu;
const kareAsk = (t) => KARE_ASK.test(kindFold(String(t || "")));
const kareCfg = () => {
  const raw = settings().kare, off = (v) => v === false || v === 0 || ["false", "0"].includes(String(v).trim().toLowerCase());
  const k = raw && typeof raw === "object" ? raw : {};
  const mx = Number(k.maxSeconds);
  return { ...k, enabled: raw != null && typeof raw !== "object" ? !off(raw) : !off(k.enabled ?? true), maxSeconds: Number.isFinite(mx) && mx > 0 ? mx : 1800 };
};
const kareOn = () => kareCfg().enabled;
// "özet reels" (kullanıcı isteği, 23 Ekim: "link özet reels yazarsam o kare videodan svg özet reels üretmeli"): uzun (10 dakikalık) videonun
// çizilmiş sahnelerle özeti = benzer video yolu (build_recreate: döküm + kareler → Claude özet planı → SVG sahneler), hedef 60 sn (talimatta
// "N saniye" varsa o). Biçimler: "özet reels", "reels özet", "svg özet", "özet reel", "özet shorts"
const reelsAsk = (t) => /(?:^|[^\p{L}])(?:özet|ozet)\s*(?:reels?|rils|shorts?)(?![\p{L}])|(?:^|[^\p{L}])(?:reels?|rils)\s*(?:özet|ozet)(?![\p{L}])|(?:^|[^\p{L}])svg\s*(?:özet|ozet|reels?)(?![\p{L}])/iu.test(String(t || ""));
const reelsInstruction = (t) => `${String(t || "").trim()}. Bu uzun videonun ÖZETİ: ana fikri ve en önemli 3-5 noktayı sırayla, çizilmiş sahnelerle anlat${trailerSecs(String(t || "")) ? "" : "; 60 saniye"}.`;
// linkte açma istisnası (commands.js openAsk E1) bu tanıyıcılarla üretim isteğine bakar
useDetectors({ newsRequest, recreateAsk, trailerAsk, kindAsk });
// fragman süresi (wa_video.py SURE_RE/trailer_secs ile aynı kural, 20-60): talimattaki "N saniye/sn" ya da "N dakika/dk" (× 60); yoksa
// trailer.duration. Belirtme/çıkma ekli sayı süre değildir ("baştaki 15 saniyeyi kullanma", "ilk 5 sn'yi kes", "15 sn'den sonra");
// "40 saniyelik", "40 sn'lik", "40 saniyede", "1 dakikalık" süredir. Yanıt ve log söz verilen süreyi doğru yazsın
const SURE_RE = /(?:(\d{2,3})\s*(?:saniye(?:lik|de|ye)?|sn)|(\d{1,2})\s*(?:dakika(?:l[ıi]k|da|ya)?|dk))(?![\p{L}\p{N}_]|['’](?:y[ıi]|d[ae]n|t[ae]n))/u;
const trailerSecs = (instruction) => { const m = String(instruction || "").toLocaleLowerCase("tr-TR").match(SURE_RE); return Math.min(60, Math.max(20, m ? (m[1] ? Number(m[1]) : Number(m[2]) * 60) : Math.trunc(Number(trailerCfg().duration)) || 40)); };
let waVid = null; // {files, instruction, caption, fwd, at, sentAt, timer, asked, fwdAsked, fwdGo}
// sahibin "Nasıl bir haber yapayım?" yanıtını bekleyen eski işler (sonradan ayrı iş açan video gelince beklemede kalır): yanıt önce bunlara,
// en eskisinden (inceleme, 20 Ekim: sahibin soru sorulan videosu, ardından iletilen video gelince talimatsız başlıyordu; söz verilen
// waitMin dakika bitmeden sahibin yanıtı iletilen videoya gidiyordu)
let waAsks = [];
// iletilen video (whatsapp.js forwarded; inceleme, 19 Ekim): açıklaması paylaşanın sözüdür, sahibin talimatı değil ("aynısını yapın",
// "#viral", "SON DAKİKA: …" benzer video/tür/haber isteği sanılıyordu). Açıklama `caption` olarak taşınır (wa_video istemde bilgi:
// iletilen_aciklama); tür, haber ve benzer video kararları yalnız sahibin yazdığı talimattan. Sahip FWD_WAIT_MS içinde talimat yazabilir
// (waVideoText), yazmazsa iş talimatsız başlar: türe açıklamaya ve görüntüye bakıp Claude karar verir (DECIDE_TALIMAT). Bekleyen iletilen
// videoya yalnız aynı albümün videoları katılır: WhatsApp'taki gönderim anı (sentAt; indirme süresinden bağımsız) son videodan en çok
// ALBUM_MS sonra. Daha geç gelen video ayrı iştir: açıklamalı iletilen bekleyen iş talimatsız başlar, yeni video kendi bekleme penceresini
// açar (inceleme, 19 Ekim: 30 sn arayla iletilen iki ayrı haber tek habere birleşiyor, beşinci ayrı video "en çok 4 video" diye
// reddediliyordu). Kural iletilen video olan her talimatsız işte (açıklamasız iletilen video, sahibin yanıt bekleyen videosuna gelen iletilen
// video da): iletilen video sahibin soru sorulan işine katılmaz, açıklamasız iki iletilen video 30 sn arayla iki iştir; soru sorulan
// (açıklamasız) iş başlamaz, yanıtını waitMin boyunca bekler (waAsks) ve sahibin ilk yanıtı ona gider; sahibin kendi videoları eskisi gibi
// birleşir (inceleme, 20 Ekim). Talimat albüm penceresinde yazılırsa iş pencere dolunca başlar (albümün geç inen videosu da katılır);
// bildirimden sonra albüm penceresinde inen sahibin açıklamalı videosu işi talimatıyla ALBUM_MS sonra başlatır
const FWD_WAIT_MS = 60000, ALBUM_MS = 8000;
// WhatsApp ilk yanıtındaki yayın saati eki (10. tur; link: handleCommand social_video/anlik, video: runVideoNews0): alınan saat " ⏰ … yayınlanacak.";
// alınan saati sıkı kural almazdı (doubt: yapıştırılan altyazıdaki olay saati olabilir) → tek satır doubtNote ("… olayın saatiyse video gelince
// *planlı yayını şimdi yayınla* ya da *planlı yayını iptal et* yazın"); açık yazılmış saat alınmadıysa tek satır timeNote (sahibin WhatsApp
// videosunda link yok: videoyu "14:30'da paylaş" açıklamasıyla gönderin; 12. tur)
const timeTail = (c, video = false) => c.publishAt ? (c.timeDoubt ? `\n${doubtNote(whenLabel(new Date(c.publishAt)))}` : ` ⏰ ${atLabel(whenLabel(new Date(c.publishAt)))} yayınlanacak.`)
  : c.ignoredTime ? `\n${timeNote(c.ignoredTime, video)}` : "";
// bekleyen iş: yanıtı beklenen (süresi dolmamış) ya da talimatı gelmiş ama henüz başlamamış (albüm penceresi) iş; talimatlı iş hiç düşmez (9. tur,
// inceleme, 20 Ekim: soru sorulan videoya yanıt albüm penceresinde gelince, ardından inen iletilen video o işi listeden düşürüyor, iş hiç
// başlamıyordu)
const waLive = (v) => !!v && !v.running && (!!v.instruction || Date.now() - v.at <= Number(waVideoCfg().waitMin) * 60000);
const waAlbum = (v) => { clearTimeout(v.timer); v.timer = setTimeout(() => { if (v === waVid || waAsks.includes(v) || (v.instruction && !v.running)) waVideoGo(v).catch((e) => push(`🎬 video haberi hatası: ${e.message}`)); }, ALBUM_MS); };
const waFwd = (v) => { clearTimeout(v.timer); v.timer = setTimeout(() => { if (waVid !== v) return; v.fwdGo = true; waVideoGo(v).catch((e) => push(`🎬 video haberi hatası: ${e.message}`)); }, FWD_WAIT_MS); };
async function waVideoIn({ file, caption, forwarded = false, sentAt = 0 }) {
  const c = waVideoCfg();
  if (!c.enabled) return "WhatsApp'tan gelen videodan haber yapma kapalı (Ayarlar → 📡 Otomatik içerikler).";
  try { const dir = path.dirname(file); for (const f of readdirSync(dir)) { const p = path.join(dir, f); if (Date.now() - statSync(p).mtimeMs > 3 * 86400000) rmSync(p, { force: true }); } } catch { /* temizlik */ }
  const sent = Number(sentAt) > 0 ? Number(sentAt) : Date.now();
  const stale = (v) => Date.now() - v.at > Number(c.waitMin) * 60000;
  waAsks = waAsks.filter(waLive);
  // sahibin kendi videosu yanıtını bekleyen kendi işine katılır (bekleyen iş iletilen videonunsa; sahibin videoları eskisi gibi birleşir)
  const own = !forwarded && !(waVid && !waVid.running && !stale(waVid) && !waVid.fwd) ? waAsks.find((x) => !x.fwd) : null;
  if (!own && waVid && !waVid.running && !stale(waVid) && (waVid.fwd || forwarded) && (waVid.instruction ? Math.abs(sent - waVid.sentAt) > ALBUM_MS
    : Math.abs(sent - waVid.sentAt) > ALBUM_MS || (forwarded && !waVid.fwd && waVid.asked))) {
    const prev = waVid;
    if (!prev.instruction && !prev.caption) { // soru sorulan (ya da sorulacak) iş beklemede kalır, yanıt önce ona gider
      waAsks.push(prev); waVid = null;
      push(`🎬 yeni ${forwarded ? "iletilen " : ""}video ayrı iş: önceki video${prev.files.length > 1 ? `lar (${prev.files.length})` : ""} yanıtınızı bekliyor (ilk yazdığınız ona gider)`);
    } else { // açıklamalı iletilen iş talimatsız, talimatı albüm penceresinde yazılmış iş talimatıyla hemen başlar
      clearTimeout(prev.timer); if (!prev.instruction) prev.fwdGo = true;
      if (!prev.instruction) push(`🎬 önceki iletilen video${prev.files.length > 1 ? `lar (${prev.files.length})` : ""} talimatsız başlıyor: yeni video ayrı iş (albüm yalnız ${ALBUM_MS / 1000} sn içinde birleşir)`);
      waVideoGo(prev).catch((e) => push(`🎬 video haberi hatası: ${e.message}`)); // waVid'i hemen boşaltır
    }
  }
  if (!own && (!waVid || waVid.running || stale(waVid))) waVid = { files: [], instruction: "", caption: "", at: Date.now(), sentAt: sent };
  const v = own || waVid;
  if (v.files.length >= 4) return "En çok 4 video birleştirilebilir; bu video alınmadı.";
  v.files.push(file); v.at = Date.now(); v.sentAt = sent; if (forwarded) v.fwd = true;
  if (caption && forwarded) v.caption = `${v.caption}\n${caption}`.trim(); // yayın saati de iletilen açıklamadan okunmaz
  else if (caption) { const wn = parseWhen(caption); if (wn.at) { v.publishAt = wn.at.toISOString(); v.timeDoubt = !!wn.doubt; } else if (wn.ignored) v.timeNote ||= wn.ignored; v.instruction = `${v.instruction} ${caption}`.trim(); }
  push(`🎬 WhatsApp videosu alındı (${v.files.length}. video)${caption ? (forwarded ? ` · iletilen açıklama (talimat sayılmaz): ${caption.slice(0, 100)}` : ` · talimat: ${caption.slice(0, 100)}`) : ""}`);
  if (v.fwdAsked && !v.instruction) return null; // albümün geç inen videosu: bildirim gitti, sahibin talimatı bekleniyor (süre yenilenmez)
  waAlbum(v); // albümün diğer videoları
  return null;
}
function waVideoText(text) {
  waAsks = waAsks.filter(waLive);
  // yanıt önce soru sorulan (talimatsız) eski işe; talimatı gelmiş ama başlamamış iş varken yeni videonun albüm penceresine yazılan söz o
  // işin ekidir, yeni videonun talimatı değil — yeni video sorulunca/bildirilince talimat ona gider (9. tur)
  const v = waAsks.find((x) => !x.instruction) || (waVid && (waVid.asked || waVid.fwdAsked || !waAsks.some((x) => x.instruction && !x.running)) ? waVid : null);
  if (!v || !v.files.length || v.instruction || v.running) return null;
  if (Date.now() - v.at > Number(waVideoCfg().waitMin) * 60000) { waVid = null; return null; }
  // kontrol komutları videonun talimatı değil ("güncelle", "sistemi durdur", "sistemi başlat", "durum")
  if (["self_update", "update_check", "stopall", "rest_end", "status"].includes(parseCommand(text).action) || queueCommand(text)) return null; // "kuyruk", "trend 1 3" de
  if (v.caption && findLink(text)) return null; // iletilen videoyu beklerken gelen link kendi işidir (yeni bekleme penceresi eskiden yoktu)
  if (/^(iptal|vazgeç|boş ver|gerek yok)(\s|$|[.!,])/.test(text.toLocaleLowerCase("tr-TR").trim())) {
    clearTimeout(v.timer); if (v === waVid) waVid = null; waAsks = waAsks.filter((x) => x !== v);
    push("🎬 video haberi iptal edildi"); return "Tamam, video ile haber yapmaktan vazgeçtim.";
  }
  v.instruction = text.trim();
  { const wn = parseWhen(text); if (wn.at) { v.publishAt = wn.at.toISOString(); v.timeDoubt = !!wn.doubt; } else if (wn.ignored) v.timeNote ||= wn.ignored; }
  // bekleyen iletilen videoya sahibin talimatı için yeniden tam süre (yanıt önceki videoya gitti)
  if (v !== waVid && waVid?.fwdAsked && !waVid.instruction && !waVid.running) waFwd(waVid);
  if (!v.asked && !v.fwdAsked) return true; // albüm penceresi sürüyor: iş pencere dolunca talimatıyla başlar (geç inen video da katılır)
  clearTimeout(v.timer);
  waVideoGo(v).catch((e) => push(`🎬 video haberi hatası: ${e.message}`));
  return true; // yanıtı waVideoGo gönderir
}
async function waVideoGo(v = waVid) {
  if (!v || !v.files.length || v.running) return;
  const prior = waAsks.some((x) => x !== v && !x.instruction) ? " Önceki videonuz da yanıtınızı bekliyor: ilk yazdığınız ona gider, bu video için ondan sonra yazın." : "";
  if (!v.instruction && v.caption && !v.fwdGo) { // iletilen video: bir kez kısaca bildir, sahibin talimatını FWD_WAIT_MS bekle
    if (!v.fwdAsked) {
      v.fwdAsked = true;
      try { await wa.send(`🎬 İletilen ${v.files.length > 1 ? `${v.files.length} video` : "video"} alındı; açıklaması talimat sayılmadı. ${Math.round(FWD_WAIT_MS / 60000)} dakika içinde talimat yazabilirsiniz (ör. "haber yap", "mizah", "benzerini yap"), yoksa ben karar veririm. Vazgeçmek için *iptal*.${prior}`); } catch { /* WhatsApp yok */ }
    }
    if (waVid !== v || v.running || v.instruction) return; // bildirim gönderilirken talimat geldi (waVideoText işi başlattı)
    waFwd(v);
    return;
  }
  if (!v.instruction && !v.caption && !v.fwdGo) { // fwdGo: yeni (iletilen) video ayrı iş açtı, bu iş talimatsız (varsayılan haber) başlar
    if (!v.asked) { v.asked = true; try { await wa.send(`🎬 ${v.files.length > 1 ? `${v.files.length} video` : "Video"} alındı. Nasıl bir haber yapayım? Kısaca yazın — ne olduğunu, nerede olduğunu, istediğiniz süreyi ve kesilmesini istediğiniz yerleri.\nÖrnek: "Kadıköy'de akşam saatlerinde iş yerinde yangın çıktı, 30 saniye, başındaki titrek kısmı kes"\n(${waVideoCfg().waitMin} dk içinde yazın; vazgeçmek için *iptal*)${prior}`); } catch { /* WhatsApp yok */ } }
    return;
  }
  v.running = true; if (waVid === v) waVid = null; waAsks = waAsks.filter((x) => x !== v);
  return runVideoNews(v);
}
// video kuyruğunun otomatik trend işi ve iptal edilen iş WhatsApp'a yazmaz (başlama/kurgu/hata mesajı yok; bitince normal video mesajı gelir)
const sendW = async (t) => { if (vqCtx()?.quiet || twQuiet()) return; try { await wa.send(t); } catch { /* WhatsApp bağlı değil: log yeterli */ } };
// kısa mesaj modu (kullanıcı isteği, 14 Ekim): WhatsApp'a yalnız "başladı", "sorun", "başarılı" gider; ara aşamalar yalnız logda
const waBrief = () => settings().whatsapp?.brief !== false;
// ⏳ Sahibin uzun süren işi (kullanıcı isteği, 23 Ekim: "üretim uzun sürüyorsa ne aşamada olduğunu bana bildirmeli, bir sorun var mı yok mu
// bildirmeli"): runVideoNews0 işi kaydeder; wa_video satırları (OWNER_STAGES) ve sahibin işi üretimdeyken pipeline satırları (PIPE_STAGES,
// ownerLine; anlikNow.opts.ownerJob) aşamayı, ⚠️/! satırları son uyarıyı günceller. 4 dakikayı geçen işte her 4 dakikada WhatsApp'a tek
// satır (kısa mesaj modunda da): geçen süre, aşama (kaç dakikadır), son uyarı ya da "sorun yok". Video hazır (✔) ya da hata (✖, wa_video
// hatası) olunca kayıt silinir; 3 saati geçen kayıt unutulmuş sayılır
const ownerJobs = new Map(); let ownerSeq = 0;
// Bildirim sıklığı (kullanıcı şikâyeti, 27 Ekim: sırada bekleyen 5 iş × 4 dakikada bir "Hâlâ sürüyor" mesaj seli): süren iş (indirme/inceleme ya da
// üretimde) ilk 3 notu 4 dk'da bir, sonra 10 dk'da bir alır; üretim SIRASINDA bekleyen işler tek tek yazmaz, hepsi için 30 dk'da bir tek toplu
// özet gider (canlı sıra konumu, süren üretim); sıradan iptal edilen iş 2 dk içinde unutulur. Aynı adlı işler kuyruk numarasıyla ayrılır (#7).
const OWNER_NOTE_MS = 4 * 60000, OWNER_NOTE_SLOW_MS = 10 * 60000, OWNER_WAIT_NOTE_MS = 30 * 60000;
let ownerWaitNote = 0;
function ownerJobStart(label) { const id = ++ownerSeq; let tag = ""; try { tag = vqTag(); } catch { /* kuyruk dışı */ } ownerJobs.set(id, { id, label: (String(label || "video").replace(/\s+/g, " ").slice(0, 70) + tag).trim(), startedAt: Date.now(), stage: "başladı", stageAt: Date.now(), lastNote: Date.now(), notes: 0, seenQueuedAt: 0, warn: "" }); return id; }
function ownerJobStage(id, stage) { const j = ownerJobs.get(id); if (j && stage && stage !== j.stage) { j.stage = stage; j.stageAt = Date.now(); } }
function ownerJobWarn(id, line) { const j = ownerJobs.get(id); if (j) j.warn = String(line).replace(/^\s*(?:!!|!|⚠️)\s*/, "").slice(0, 160); }
function ownerJobEnd(id) { ownerJobs.delete(id); }
const OWNER_STAGES = [
  [/^🔗 sosyal medya paylaşımı indiriliyor|^🔗 uzun video|^📡 canlı/, () => "video indiriliyor"],
  [/^🔗 indirildi/, () => "video indirildi; inceleme başlıyor"],
  [/^(?:🎬|🎨) video \d+:|^🎬 konuşma|^🖼 video|^📝 |^⬛ kare video:|^⬛ video 1|^⬛ konuşma/, () => "video inceleniyor (konuşma dökümü, kareler, ekrandaki yazılar)"],
  [/^⬛ Claude/, () => "Claude kanca, giriş, bölüm başlıkları ve kapanışı yazıyor (1-4 dk)"],
  [/^⬛ videonun tamamı/, () => "videonun tamamı kare (1080x1080) kesiliyor (ffmpeg; uzun videoda birkaç dakika)"],
  [/^🎨 Claude videoyu inceliyor|^🎬 Claude|^✏️ Claude|kurgu planı/, () => "Claude senaryoyu ve sahneleri yazıyor (1-4 dk)"],
  [/^🎨 (\d+) sahne çiziliyor/, (m) => `sahneler çiziliyor (${m[1]} sahne, Remotion; sahne başına 1-3 dk)`],
  [/^🎨 (kanca|\d+\. sahne): (.{0,40})/, (m) => `sahne çizildi: ${m[1]} — ${m[2].split(" — ")[0]}`],
  [/^♻️ /, () => "değişmeyen sahneler önceki sürümden alındı, değişenler çiziliyor"],
  [/^(?:✂️ kurgu|🎨 neler korundu|🎨 sıfırdan üretildi|✏️ düzeltildi)/, () => "kurgu hazır; seslendirme ve video üretimine geçiliyor"],
];
const PIPE_STAGES = [
  [/^-- 3\/4 seslendirme/, () => "seslendirme (ses modeli)"], [/^-- görseller/, () => "sahneler ve görseller yerleştiriliyor"],
  [/^🔤 altyazı senkronu/, () => "altyazı sesle eşleniyor"], [/^-- 4\/4 render/, () => "video çiziliyor (Remotion render; süreye göre 2-10 dk)"],
  [/^-- kapaklar/, () => "kapaklar çiziliyor"], [/^== bitti/, () => "video hazır; yayın adımı ve onay mesajı"], [/^-- yayın ve analiz/, () => "yayın adımı"],
  // yayın adımının içi (post_pipeline / publish.py satırları): sahip hangi platformun beklediğini görsün
  [/^📤 (youtube|instagram|tiktok): yükleniyor/, (m) => `${{ youtube: "YouTube", instagram: "Instagram", tiktok: "TikTok" }[m[1]]}'a yükleniyor${m[1] === "instagram" ? " (video dış sunucuya gider, Instagram işler: 2-8 dk)" : ""}`],
  [/^🌐 Hostinger: yüklendi/, () => "Instagram videoyu işliyor (2-6 dk)"],
  [/^📤 (youtube|instagram|tiktok): (tamam|zaten yayında|hata|sınır doldu)/, (m) => `${{ youtube: "YouTube", instagram: "Instagram", tiktok: "TikTok" }[m[1]]} yayını: ${m[2] === "tamam" ? "tamamlandı" : m[2]}`],
  [/^📤 tekrar denenecek/, () => "yayın 90 sn sonra yeniden denenecek"],
  [/^📤 sırada \d+ video bekliyor/, () => "yayın adımı bitiyor; sıradaki eski videolar panele bırakıldı (sizin videonuz beklemiyor)"],
];
function ownerStageOf(line, table) { for (const [re, fn] of table) { const m = line.match(re); if (m) return fn(m, line); } return null; }
function ownerLine(line) {
  const run = state.running && anlikNow && anlikNow.at === state.startedAt ? anlikNow.opts?.ownerJob : null; // sahibin işi üretimde
  if (!run || !ownerJobs.has(run)) return;
  const st = ownerStageOf(line, PIPE_STAGES); if (st) ownerJobStage(run, st);
  if (/^(?:  ! |!! |⚠️ |HATA)/.test(line)) ownerJobWarn(run, line);
  if (/^(?:✔ üretim|✖ üretim)/.test(line)) ownerJobEnd(run); // hazır ya da hata: bildirimi zaten gidiyor
}
const ownerRunningId = () => (state.running && anlikNow && anlikNow.at === state.startedAt ? anlikNow.opts?.ownerJob : null) || null;
const ownerQueuePos = (id) => { const i = anlikQueue.findIndex((q) => q?.opts?.ownerJob === id); return i < 0 ? 0 : i + 1; };
function ownerTick(now = Date.now()) {
  const out = [], runId = ownerRunningId(), waiting = [];
  for (const j of [...ownerJobs.values()]) {
    if (now - j.startedAt > 3 * 3600000) { ownerJobs.delete(j.id); continue; }
    const pos = ownerQueuePos(j.id), running = runId === j.id;
    if (!running && pos) { // üretim sırasında bekliyor: tek tek mesaj yok, toplu özet; konum canlı (sıra değişir: sizin diğer işleriniz, acil fragman)
      const st = `üretim sırasında (${pos}. sırada; süren üretim bitince başlayacak)`; if (j.stage !== st) j.stage = st;
      j.seenQueuedAt = now; waiting.push({ j, pos }); continue;
    }
    if (!running && j.seenQueuedAt) { if (now - j.seenQueuedAt > 2 * 60000) ownerJobs.delete(j.id); continue; } // sıradaydı, artık ne sırada ne üretimde: iptal edildi (kuyruk iptali) ya da başka yoldan bitti
    if (running && /^üretim sırasında/.test(j.stage)) { j.stage = "üretim başladı (senaryo, seslendirme ve kurgu)"; j.stageAt = now; }
    const every = j.notes < 3 ? OWNER_NOTE_MS : OWNER_NOTE_SLOW_MS;
    if (now - j.startedAt < OWNER_NOTE_MS || now - j.lastNote < every) continue;
    j.lastNote = now; j.notes = (j.notes || 0) + 1;
    const min = Math.round((now - j.startedAt) / 60000), sMin = Math.round((now - j.stageAt) / 60000), runMin = running ? Math.round((now - state.startedAt) / 60000) : null;
    out.push(`⏳ *Hâlâ sürüyor* (${min} dk${runMin != null && runMin !== min ? `; üretimde ${runMin} dk` : ""}): ${j.label}\nAşama: ${j.stage}${sMin >= 2 ? ` (${sMin} dk'dır)` : ""}\n${j.warn ? `⚠️ Son uyarı: ${j.warn}` : "Sorun yok; bitince video gelecek."}${j.notes === 3 ? "\nBundan sonra 10 dakikada bir yazarım." : ""}`);
  }
  if (waiting.length && now - ownerWaitNote >= OWNER_WAIT_NOTE_MS && waiting.some(({ j }) => now - j.startedAt >= OWNER_NOTE_MS)) {
    ownerWaitNote = now; waiting.sort((a, b) => a.pos - b.pos);
    const runMin = state.running ? Math.round((now - state.startedAt) / 60000) : null, runJob = runId ? ownerJobs.get(runId) : null;
    const cur = state.running ? `Süren üretim: ${String(anlikNow?.topic || "video").slice(0, 60)} (${runMin} dk${runJob ? `; ${runJob.stage}` : ""})${runMin >= 45 ? " — uzun sürdü; takıldıysa panelin bekçisi durdurur, sıra devam eder" : ""}` : "Şu an üretim yok; sıradaki video birazdan başlar.";
    out.push(`⏳ *Sırada bekleyen videolarınız* (${waiting.length}):\n${waiting.map(({ j, pos }) => `${pos}) ${j.label} — ${Math.round((now - j.startedAt) / 60000)} dk`).join("\n")}\n${cur}\nHer video hazır olunca ayrıca gelir; bu özet 30 dakikada bir. Vazgeçmek için *kuyruk* yazıp *iptal <numara>*.`);
  }
  return out;
}
setInterval(() => { for (const t of ownerTick()) { try { wa.send(t).catch(() => {}); } catch { /* WhatsApp henüz kurulmadı */ } } }, 60000);
// Ortak montaj adımı: WhatsApp videosu ya da sosyal medya linkinden indirilen video {files, instruction, social?, related?}
async function runVideoNews(v) { videoNewsN++; try { return await runVideoNews0(v); } finally { videoNewsN--; } } // güncelleme beklesin
async function runVideoNews0(v) {
  // benzer video (sıfırdan): link yolu socialVideoNews'te karar verir (v.recreate); WhatsApp videosunda talimattan
  // ✏️ çizilmiş benzer videonun düzeltme turu (reviseVideo): kaynak video yok, önceki sürümün plan.json'u + sahibin düzeltme metni
  const rv = v.revise && typeof v.revise === "object" ? v.revise : null;
  if (rv) v.recreate = true;
  if (v.recreate === undefined) { v.recreate = !v.social && !v.trailer && !v.summary && recreateOn() && (recreateAsk(v.instruction) || reelsAsk(v.instruction)); if (v.recreate && reelsAsk(v.instruction)) v.instruction = reelsInstruction(v.instruction); } // WhatsApp videosunda "özet reels"
  const rc = !!v.recreate;
  // ⬛ kare (1:1) uzun video: link yolu socialVideoNews'te karar verir (v.kare); WhatsApp videosunda talimattan ("kare video")
  if (v.kare === undefined) v.kare = !v.social && !v.trailer && !v.summary && !rc && kareOn() && kareAsk(v.instruction);
  const kr = !!v.kare;
  // 🎬 fragman takibi (kanaldan düşen yeni fragman, trailerWatchScan → twKick): kendiliğinden iş — WhatsApp sessiz (sendW twQuiet), sahibin
  // uzun iş bildirimi yok, yayın otomatik (trailerWatch.autoPublish; kapalıysa onaya gelir), sahibin işleri yine önde (startAnlik auto + priority)
  const auto = !!v.trailerAuto;
  // sahibin kendi videosu / yanıtı: yayın saati satırı (timeTail; linkte handleCommand yanıtı söyler)
  const tl = v.social || rv ? "" : timeTail({ publishAt: v.publishAt, timeDoubt: v.timeDoubt, ignoredTime: v.timeNote }, true);
  push(`${rv ? "✏️" : kr ? "⬛" : "🎬"} ${rv ? `düzeltme (${rv.of}, ${rv.revision}. sürüm)` : rc ? "benzer video (sıfırdan)" : kr ? `kare uzun video (${v.social?.duration ? `${Math.round(Number(v.social.duration) / 60)} dk, ` : ""}videonun tamamı kendi sesiyle)` : v.trailer ? (auto ? "fragman analizi (fragman takibi: kanalda yeni fragman)" : "fragman analizi") : v.summary ? "uzun video özeti" : kindOf(v) === "mizah" ? "mizah videosu" : kindOf(v) === "trend" ? "viral video" : "video haberi"} hazırlanıyor (${rv ? "önceki sürümün planı" : `${v.files.length} video`}${v.social ? `, ${v.social.credit}` : ""}): ${String(v.instruction || (v.caption ? "(talimat yok; iletilen açıklama bilgi olarak)" : "(talimat yok)")).slice(0, 120)}`);
  if (rv) { if (v.src === "panel") await sendW(`✏️ Panelden düzeltme (${rv.revision}. sürüm): "${String(rv.instruction).slice(0, 120)}" — değişen sahneler yeniden çiziliyor, kalanlar korunuyor. Bitince video gelecek; eski sürüm yayınlanmayacak.`); }
  else if (!waBrief()) await sendW((kr ? `⬛ Videoyu inceliyorum: konuşmasını kelimelere döküyor, karelerine bakıyorum; sonra çarpıcı bir kanca, kısa giriş, bölüm başlıkları ve kapanış yazıp videonun TAMAMINI kendi sesiyle kare (1:1) uzun video yapacağım${v.social?.duration ? ` (kaynak ${Math.round(Number(v.social.duration) / 60)} dk; hazırlık 5-20 dk)` : " (hazırlık 5-20 dk)"}.`
    : rc ? `🎨 Videoyu izliyorum: konuşmasını ve ekrandaki yazıları kelimelere döküyor, karelerine ve sahne geçişlerine bakıyorum; sonra aynı hikâyeyi kendi cümlelerimizle yeniden yazıp sahneleri sıfırdan çizeceğim (orijinal görüntü kullanılmaz; 3-10 dk).`
    : v.trailer ? `🎬 Fragmanı inceliyorum: konuşmayı kelimelere döküyor, çekimlerden kareler çıkarıyorum; sonra çarpıcı bir kancayla "fragmanda ne anlatılıyor" kurgusunu yazıp kesimleri yapacağım (1-3 dk).`
    : v.summary ? `🎬 Videonun tamamını inceliyorum: konuşmasını baştan sona okuyup kareleri çıkarıyorum, en çarpıcı anları seçip HD indireceğim, sonra kurguyu yazacağım (uzun videoda 10-20 dk).`
    : `🎬 Videoyu inceliyorum: konuşmayı dinliyor, sahneleri ve kareleri çıkarıyorum, sonra kurguyu yazıp kesimleri yapacağım (1-3 dk).`) + tl);
  else if (!v.social) await sendW((kr ? "⬛ Başladı: videonuz kare (1:1) uzun video olarak hazırlanıyor (tamamı kendi sesiyle). Bitince video gelecek." : rc ? "🎨 Başladı: video izleniyor, kelimeleri çıkarılıp benzeri sıfırdan çiziliyor. Bitince video gelecek." : "🎬 Başladı: videonuzdan haber hazırlanıyor. Bitince video gelecek.") + tl);
  // sahibin uzun işi (ownerJobs): otomatik trend kuyruğu işi (quiet) değil
  const oj = vqCtx()?.quiet || auto ? 0 : ownerJobStart(rv ? `düzeltme (${rv.revision}. sürüm)` : v.social?.title || v.instruction || (v.files.length > 1 ? `${v.files.length} video` : "videonuz"));
  const jobFile = path.join(WORK, `wa_video_${Date.now()}.json`);
  // süre talimatta yazmıyorsa settings.waVideo.duration (fragmanda settings.trailer.duration)
  writeJson(jobFile, { videos: v.files, instruction: v.instruction, social: v.social || null, related: v.related || [], ...(v.trailer ? { trailer: true, film: v.film || "", ...(Number(v.maxSoundSeconds) > 0 ? { maxSoundSeconds: Number(v.maxSoundSeconds) } : {}), ...(Array.isArray(v.promoPrevious) && v.promoPrevious.length ? { promoPrevious: v.promoPrevious.slice(-6) } : {}) } : {}), // fragman takibi: orijinal sesli anların toplamı (trailerWatch.soundSeconds), aynı bölümün önceki tanıtımları
    ...(["haber", "trend", "mizah"].includes(v.kind) ? { kind: v.kind } : {}),
    ...(v.summary ? { summary: true, summaryProxy: !!v.summaryProxy } : {}), ...(rc ? { recreate: true } : {}), ...(kr ? { kare: true } : {}), ...(v.caption ? { caption: v.caption } : {}),
    ...(rv ? { revise: { job: rv.job, instruction: rv.instruction, of: rv.of, revision: rv.revision } } : {}) });
  // özet: videonun tamamının analizi + iki Claude çağrısı + HD anlar (en çok 60 dk); benzer video: Claude + sahnelerin çizimi (en çok 50 dk);
  // satırlar anında loga (çerçeve 🖼, ekrandaki yazılar 📝, açıklamasız paylaşımın haber araması 🔎 dahil; inceleme, 19 Ekim: yanlış
  // kırpma logda hiç görünmüyordu)
  // kare: 10 dakikalık videonun dökümü (konuşma tanıma) + tamamının 1080x1080 kesimi uzun sürer (en çok 45 dk)
  const r = await runLines(PY, ["scripts/wa_video.py", "--job", jobFile], { timeout: (v.summary ? 60 : rc ? 50 : kr ? 45 : 25) * 60000, onLine: (l) => { if (/^(🎬|🎨|⬛|✂️|🔗|⚠️|🔊|📱|🖼|📝|🔎|  !)/.test(l)) push(l.trim()); if (oj) { const st = ownerStageOf(l.trim(), OWNER_STAGES); if (st) ownerJobStage(oj, st); if (/^(?:  ! |⚠️)/.test(l.trim())) ownerJobWarn(oj, l.trim()); } } });
  rmSync(jobFile, { force: true });
  let j = null; try { j = JSON.parse(String(r.stdout || "").trim().split("\n").pop()); } catch { /* yanıt yok */ }
  if (!j?.ok) {
    const err = j?.error || String(r.stderr || "yanıt yok").slice(-200);
    if (oj) ownerJobEnd(oj);
    if (rv) { push(`✏️ düzeltme yapılamadı (${rv.of}): ${err}`); await sendW(`❌ Düzeltme yapılamadı (${rv.of}): ${err}\nEski sürüm duruyor (onayı değişmedi); yeniden *düzelt* yazabilir ya da panelden yayınlayabilirsiniz.`); return { ok: false, error: err }; }
    push(vqCtx()?.cancelled ? `🎬 video haberi hazırlanmadı${vqTag()}: video kuyruğundan iptal edildi` : `🎬 video haberi hazırlanamadı${vqTag()}: ${err}`); await sendW(`❌ Video haberi hazırlanamadı${vqWho()}: ${err}`); return { ok: false, error: err };
  }
  const p = j.plan || {};
  // özette parçalar seçilen anlardan (1. an, 2. an…): anın uzun videodaki yeri + parçanın saniyeleri
  const hm = (t) => { t = Math.round(t); return t >= 3600 ? `${Math.floor(t / 3600)}:${String(Math.floor(t % 3600 / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}` : `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`; };
  const at = (c) => { if (!p.summary) return `${v.files.length > 1 ? `${c.video}. video ` : ""}${c.start.toFixed(1).replace(".", ",")}–${c.end.toFixed(1).replace(".", ",")} sn`;
    const o = p.moments?.[c.video - 1]?.[0] || 0; return `${hm(o + c.start)}–${hm(o + c.end)}`; };
  const segLines = (p.segments || []).map((s) => `• ${s.kind === "hook" ? "Kanca" : s.kind === "sesli" ? `🔊 Orijinal ses${s.title ? ` (${s.title})` : ""} — seslendirme susar` : s.title}: ${(s.clips || []).map(at).join(", ")}`).join("\n");
  push(`${rc ? "🎨 neler korundu, neler değişti" : "✂️ kurgu"}: ${String(p.cuts || "").slice(0, 200)}`);
  if (rv) {
    // düzeltme: kaç sahne korundu (önceki sürümden kopyalandı), kaç sahne yeniden çizildi, Claude'un değişiklik özeti; yedek çizime düşen sahne tek satır
    push(`✏️ düzeltildi (${j.revision}. sürüm): ${p.changedScenes} sahne yeniden çizildi, ${p.reusedScenes} sahne korundu${p.paletteChanged ? " (palet değişti: hepsi yeniden)" : ""}${p.changes ? ` — ${String(p.changes).slice(0, 200)}` : ""}`);
    if (p.fallbackScenes) await sendW(`⚠️ ${p.fallbackScenes} sahnenin çizimi kullanılamadı; yerine sade bir sahne kondu (video yine hazırlanıyor).`);
    await sendW(`✏️ *Düzeltme uygulandı* (${j.revision}. sürüm): ${p.changedScenes} sahne yeniden çizildi, ${p.reusedScenes} sahne korundu.${p.changes ? `\n${String(p.changes).slice(0, 300)}` : ""}\nVideo üretiliyor (${j.duration} sn); bitince buraya gelecek, yayın için *onay* isteyeceğim. Eski sürüm (${rv.of}) yayınlanmayacak.`);
  } else if (rc) {
    // benzer video: kaç sahne çizildi, videodan çıkarılan kelimeler (ilk 200 karakter); yedek çizime düşen sahne kısa modda da tek satır (sorun)
    push(`🎨 sıfırdan üretildi: ${p.scenes} sahne çizildi${p.fallbackScenes ? ` (${p.fallbackScenes} sahne sade yedek çizimle)` : ""}${p.konu ? ` · konu: ${String(p.konu).slice(0, 120)}` : ""}`);
    if (p.hookType) push(`🎣 kanca kalıbı: ${p.hookLabel || p.hookType}${p.hookPromise ? ` — ${String(p.hookPromise).slice(0, 120)}` : ""}${p.hookAnswer ? ` (cevap: ${p.hookAnswer})` : ""}`);
    if (p.fallbackScenes) await sendW(`⚠️ ${p.fallbackScenes} sahnenin çizimi kullanılamadı; yerine sade bir sahne kondu (video yine hazırlanıyor).`);
    const ref = String(p.refText || "").trim();
    if (!waBrief()) await sendW(`🎨 *Sıfırdan üretildi*: ${p.scenes} sahne çizildi — ${p.titles?.A || p.hook}${p.konu ? `\n🔎 Konu: ${String(p.konu).slice(0, 160)}` : ""}${p.mesaj ? `\n💡 Mesaj: ${String(p.mesaj).slice(0, 160)}` : ""}${p.hookType ? `\n🎣 Kanca: ${p.hookLabel || p.hookType}${p.hookPromise ? ` — ${String(p.hookPromise).slice(0, 120)}` : ""}` : ""}\n📝 Videodan çıkarılan: ${ref ? `"${ref.slice(0, 200)}${ref.length > 200 ? "…" : ""}"` : "konuşma ya da yazı bulunamadı; hikâye görüntüden çıkarıldı"}${p.speech === false ? " (konuşma tanıma Mac'te kurulu değil: bash scripts/install_align.sh)" : ""}\n\n${p.cuts ? `Neler korundu, neler değişti: ${p.cuts}\n\n` : ""}Sahneler:\n${(p.segments || []).map((s) => `• ${s.kind === "hook" ? "Kanca" : s.title}: ${s.sahne || "çizim"}${s.fallback ? " (sade yedek çizim)" : ""}`).join("\n")}\n\n🎙 ${String(p.narration || "").slice(0, 600)}\n\nVideo üretiliyor (${j.duration} sn); bitince buraya gelecek${v.publishAt ? ` ve ⏰ ${atLabel(whenLabel(new Date(v.publishAt)))} bağlı hesaplarda yayınlanacak (iptal: planlı yayını iptal et)` : waVideoCfg().autoPublish ? " ve bağlı hesaplarda yayınlanacak" : ", yayın için *onay* isteyeceğim"}.`);
  }
  // özette sorun olabilecek iki durum kısa mesaj modunda da tek satır (kullanıcı kuralı: sorun varsa bildir)
  if (kr) {
    // kare: kaynak süresi, bölümler, baş/son kesimi; dosya 60 MB'yi aşarsa WhatsApp yalnız bağlantı gönderir (whatsapp.sendVideo)
    const mins = (x) => `${Math.floor(x / 60)}:${String(Math.round(x % 60)).padStart(2, "0")}`;
    const chap = (p.chapters || []).map((c) => `• ${mins(c.t)} ${c.title}`).join("\n");
    push(`⬛ kare video planı: ${p.chapters?.length || 0} bölüm, kaynak ${mins(j.sourceSeconds || 0)} → video ≈ ${mins(j.duration)}${p.trim?.some(Boolean) ? ` (baştan ${p.trim[0]} sn, sondan ${p.trim[1]} sn kesildi)` : ""}`);
    if (!waBrief()) await sendW(`⬛ *Kare video kurgusu hazır* — ${p.titles?.A || p.hook}\n⏱ Kaynak ${mins(j.sourceSeconds || 0)} → video ≈ ${mins(j.duration)} (tamamı kendi sesiyle, 1080x1080)${p.trim?.some(Boolean) ? `\n✂️ Baştan ${p.trim[0]} sn, sondan ${p.trim[1]} sn kesildi` : ""}${chap ? `\n\n📑 Bölümler:\n${chap}` : ""}${p.screenText?.length ? `\n📝 Ekrandaki yazılar: ${p.screenText.slice(0, 3).map((x) => `"${x}"`).join(" · ")}` : ""}${p.speech === false ? "\n\n⚠️ Videodaki konuşma yazıya dökülemedi (konuşma tanıma Mac'te kurulu değil): bölüm başlıkları karelerden, kelime altyazısı yok. Kurmak için Mac'te bir kez: bash scripts/install_align.sh" : ""}\n\n🎙 ${String(p.narration || "").slice(0, 500)}\n\nVideo üretiliyor (${mins(j.duration)}; uzun videoda çizim 10-30 dk sürer); bitince buraya gelecek (dosya 60 MB'yi aşarsa yalnız panel bağlantısı)${waVideoCfg().autoPublish ? " ve YouTube'a yayınlanacak" : ", yayın için *onay* isteyeceğim"} (yalnız YouTube; Reels ve TikTok uzun kare videoyu almaz).`);
    else await sendW(`⬛ Kare video kurgusu hazır: ${p.titles?.A || p.hook} — ${p.chapters?.length || 0} bölüm, ≈ ${mins(j.duration)}. Üretiliyor; yalnız YouTube'a${waVideoCfg().autoPublish ? "" : ", onayla"}.`);
  }
  if (p.summary && p.unsuitable) await sendW(`⚠️ Video habere pek uygun görünmüyor (${String(p.unsuitable).slice(0, 140)}); yine de en iyi anlarıyla hazırladım.`);
  if (p.summary && p.lowres) await sendW(`⚠️ ${p.lowres} an YouTube'dan HD inmedi; o anlar düşük çözünürlüklü kopyadan kesildi (görüntü bulanık olabilir).`);
  if (!rc && !kr && !waBrief()) await sendW(`✂️ *${v.trailer ? "Fragman kurgusu hazır" : p.summary ? "Özet kurgusu hazır" : p.contentKind === "mizah" ? "Kurgu hazır (mizah: sonda belirtilecek)" : p.contentKind === "trend" ? "Kurgu hazır (viral video)" : "Kurgu hazır"}* — ${p.titles?.A || p.hook}${v.trailer && p.film ? `\n🎬 ${p.film}${p.speechLang ? ` · konuşma dili: ${p.speechLang}` : ""}` : ""}${p.summary && p.konu ? `\n🔎 ${hm(p.sourceSeconds || 0)} videonun konusu: ${String(p.konu).slice(0, 200)}${p.moments?.length > 1 ? `\n🎞 Seçilen anlar: ${p.moments.map((m) => `${hm(m[0])}–${hm(m[1])}`).join(", ")}` : ""}` : ""}${p.frameCropped?.length ? `\n🖼 Çerçeve kırpıldı (logo ve başlık bandı videoda görünmeyecek)${v.files.length > 1 ? `: ${p.frameCropped.join(", ")}. video` : ""}` : ""}${p.screenText?.length ? `\n📝 Ekrandaki yazılar: ${p.screenText.slice(0, 3).map((x) => `"${x}"`).join(" · ")}` : ""}${j.vertical ? "\n📱 Dikey video: haberler tam ekran dikey düzende" : ""}${j.soundSeconds ? `\n🔊 ${String(j.soundSeconds).replace(".", ",")} sn videonun kendi sesiyle${j.soundFull ? (j.soundSeconds >= j.sourceSeconds - 2.5 ? " (videonun tamamı)" : ` (${Math.round(j.sourceSeconds)} sn'lik videonun en önemli bölümü; tamamı ~3 dk sınırını aşıyordu)`) : ""}` : ""}\n\n${p.cuts ? `Kesimler: ${p.cuts}\n\n` : ""}Kullanılan bölümler:\n${segLines}${p.speech === false ? "\n\n⚠️ Videodaki konuşma yazıya dökülemedi (konuşma tanıma Mac'te kurulamadı); kurgu yalnız görüntüye göre yapıldı. Kurmak için Mac'te bir kez: bash scripts/install_align.sh" : p.speechSource === "youtube" ? `\n\n📝 Konuşma YouTube altyazısından okundu (${p.speechOff === false ? "konuşma tanıma konuşma bulamadı" : "konuşma tanıma Mac'te kurulu değil; kurmak için bir kez: bash scripts/install_align.sh"})` : ""}\n\n🎙 ${String(p.narration || "").slice(0, 600)}\n\nVideo üretiliyor (${j.duration} sn); bitince buraya gelecek${v.publishAt ? ` ve ⏰ ${atLabel(whenLabel(new Date(v.publishAt)))} bağlı hesaplarda yayınlanacak (iptal: planlı yayını iptal et)` : waVideoCfg().autoPublish ? " ve bağlı hesaplarda yayınlanacak" : ", yayın için *onay* isteyeceğim"}.`);
  // kısa mesaj modunda da tek satır: kırpma yanlış olabilir (gerçek videolarda denenmedi), sahip görsün ve gerekirse kapatsın
  if (!rc && waBrief() && p.frameCropped?.length) await sendW(`🖼 Çerçeve kırpıldı${v.files.length > 1 ? ` (${p.frameCropped.join(", ")}. video)` : ""}: logo ve başlık bandı videoda görünmeyecek. Yanlışsa panelden "🖼 çerçeveyi kırp" kapatılabilir.`);
  // fragman: etiket plandan (FRAGMAN / YENİ FRAGMAN / HAYRAN FRAGMANI / TANITIM FİLMİ), giriş ve kapanış etikete göre wa_video.py'den
  // ("Yeni fragman." yalnız yeni fragmanda; eski fragmana "yeni" denmez), SON DAKİKA kartı yok; yine onaylı (userVideo), en çok izlenen
  // saat tekrarına girmez (infoKind video)
  // benzer video (sıfırdan): son dakika değil; etiket, giriş ve kapanış plandan (HİKÂYE: "Kısa bir hikâye."), SON DAKİKA kartı yok
  // kare uzun video: etiket plandan (RÖPORTAJ, AÇIKLAMA, VİDEO…); SON DAKİKA değilse SON DAKİKA kartı yok, kapanış uzun videoya göre
  const kl = String(p.label || "VİDEO");
  const info = kr ? (kindFold(kl).replace(/[^a-z]/g, "") === "sondakika" ? { kind: "video", label: "SON DAKİKA", intro: "Son dakika." }
      : { kind: "video", label: kl, intro: `${kl.charAt(0)}${kl.slice(1).toLocaleLowerCase("tr-TR")}.`, outro: "Videonun tamamı buydu. Yeni videolar için takip etmeyi unutma.", breaking: false })
    : rc ? { kind: "video", label: p.label || "HİKÂYE", intro: p.intro || "Kısa bir hikâye.", outro: p.outro || "Takip etmeyi unutma.", breaking: false }
    : v.trailer ? { kind: "video", label: p.label || "FRAGMAN", intro: p.intro || "Fragman analizi.", outro: p.outro || "Yeni fragmanları kaçırmamak için takip etmeyi unutma.", breaking: false }
    // özet: etiket plandan (ÖZET, AÇIKLAMA, RÖPORTAJ…); SON DAKİKA kartı ve "Son dakika." yalnız SON DAKİKA etiketinde
    : p.summary ? { kind: "video", label: p.label || "ÖZET", intro: p.intro || "Kısa özet.", ...(p.label === "SON DAKİKA" ? {} : { breaking: false }) }
    // viral/mizah: son dakika değil (SON DAKİKA kartı ve "Son dakika." yok); mizah olduğu yalnız kapanışta söylenir
    : p.contentKind ? { kind: "video", label: p.label || "VİRAL", intro: p.intro || "Sosyal medyada gündem.", outro: p.outro || "Takip etmeyi unutma.", breaking: false }
    : !p.label || kindFold(p.label).replace(/[^a-z]/g, "") === "sondakika" ? { kind: "video", label: "SON DAKİKA", intro: "Son dakika." }
    : { kind: "video", label: p.label, intro: `${p.label.charAt(0)}${p.label.slice(1).toLocaleLowerCase("tr-TR")}.`, breaking: false }; // GÖRÜNTÜLÜ HABER, ÖZEL HABER: "Son dakika." denmez
  const res = startAnlik(p.titles?.A || p.hook || v.instruction, j.duration, { templateDir: j.job, info,
    source: v.social?.credit || "Türkiye Gündemi", ...(v.social?.url ? { url: v.social.url } : {}), userVideo: !auto || !trailerWatchCfg().autoPublish,
    ...(auto ? { trailerAuto: true, priority: true, urgent: true, ...(trailerWatchCfg().autoPublish ? { auto: true } : {}), ...(v.twId ? { twId: String(v.twId) } : {}) } : {}), // fragman takibi: otomatik + acil (sahibin işlerinden sonra, bütün otomatik haberlerden önce; süren otomatik haberi durdurur); yayın onaylıysa sahibin işi gibi
    ...(v.publishAt ? { publishAt: v.publishAt } : {}), ...(v.trailer ? { trailer: true } : {}), ...(p.summary ? { summary: true } : {}), ...(p.contentKind ? { contentKind: p.contentKind } : {}), ...(rc ? { recreate: true } : {}),
    ...(rv ? { revisionOf: rv.of, revision: rv.revision } : {}), ...(kr ? { kare: true } : {}), ...(oj ? { ownerJob: oj } : {}) });
  if (!res.ok) { if (oj) ownerJobEnd(oj); await sendW(`❌ Üretim başlatılamadı: ${res.error}`); }
  else if (res.queued) {
    if (oj) ownerJobStage(oj, res.preempted ? "üretim sırasında (durdurulan otomatik üretim kapanınca hemen başlayacak)" : `üretim sırasında (${res.position}. sırada; süren üretim bitince başlayacak)`);
    if (res.preempted) await sendW("⏭ Süren otomatik haber üretimi durduruldu; sizin videonuz şimdi üretime giriyor (durdurulan haber sizinkinden sonra yeniden üretilecek).");
    else if (!vqCtx()) await sendW(res.position > 1 ? `⏳ Şu an başka üretim sürüyor; videonuz ${res.position}. sırada (önünüzde yalnız sizin diğer işleriniz var).` : "⏳ Şu an süren üretim (gündem/özet/şablon videosu) bitince videonuz hemen başlayacak."); // kuyruk işinin sırası *kuyruk*ta
  }
  if (rv && res.ok) retireOldVersion(rv.of); // yeni sürüm üretime girdi: eski sürüm yayınlanmaz (onay kaydı ve planlı yayını kalkar)
  return res;
}
// ✏️ Düzeltme turu (kullanıcı isteği, 23 Ekim: "önce ben izleyecektim, düzeltmemiz gereken yerler varsa yazacaktım, düzenleyecektik, tekrar devam
// edecektik, bu sistemin eksiksiz çalışmasını istiyorum"): çizilmiş benzer video (meta recreated) gelince sahip izler, beğenmediği yeri yazar
// ("düzelt 3: 2. sahnede yılan kırmızı olsun"; panelde ✏️ Düzelt) → önceki sürümün iş klasöründeki plan.json ile wa_video.py revise_recreate:
// Claude yalnız istenen yerleri değiştirir, değişmeyen sahneler önceki sürümden kopyalanır, değişenler çizilir → yeni video, yine onay ister.
// Eski sürümün onayı ve planlı yayını yeni sürüm üretime girince kalkar (retireOldVersion). İstediği kadar tekrarlanır (zincir: her sürümün kendi
// plan.json'u var); iş klasörü disk temizliğiyle silinmişse (2 gün) düzeltilemez, video yeniden gönderilir
function reviseCheck(name) {
  name = path.basename(String(name || "")).replace(/\.json$/, "").replace(/\.mp4$/, "") + ".mp4";
  const meta = readJson(path.join(OUT, name.replace(/\.mp4$/, ".json")), null);
  if (!meta?.segments?.length) return { ok: false, error: "Videonun bilgileri bulunamadı." };
  if (!meta.recreated) return { ok: false, error: "Bu video sıfırdan çizilmiş (benzer) video değil; düzeltme yalnız çizilmiş videolarda çalışır. Diğer videolar için \"🔁 yeniden yayınla\" ya da yeni talimatla yeniden gönderme var." };
  const jd = String(meta.jobDir || "");
  if (!jd || !existsSync(path.join(ROOT, jd, "plan.json"))) return { ok: false, error: "Bu videonun çizim planı bulunamadı (iş klasörü disk temizliğinde silinmiş olabilir: 2 günden eski videolar düzeltilemez). Videoyu ya da linki \"benzerini yap\" ile yeniden gönderin." };
  return { ok: true, name, meta, jobDir: jd, revision: (Number(meta.revision) || 0) + 1 };
}
function reviseVideo(name, instruction, { src = "panel" } = {}) {
  const c = reviseCheck(name);
  if (!c.ok) return c;
  instruction = String(instruction || "").replace(/\s+/g, " ").trim();
  if (instruction.length < 3) return { ok: false, error: "Ne değişsin? Kısaca yazın (ör. \"2. sahnede yılan kırmızı olsun, son cümleyi kısalt\")." };
  const m = c.meta;
  const social = m.sourceName && m.sourceName !== "Türkiye Gündemi" ? { credit: String(m.sourceName), ...(m.sourceUrl ? { url: String(m.sourceUrl) } : {}) } : null;
  push(`✏️ düzeltme isteği (${c.name} → ${c.revision}. sürüm, ${src}): ${instruction.slice(0, 160)}`);
  const run = runVideoNews({ files: [], instruction, social, related: [], recreate: true, src, revise: { job: c.jobDir, instruction, of: c.name, revision: c.revision } })
    .catch((e) => { push(`✏️ düzeltme çalıştırılamadı: ${e.message}`); return { ok: false, error: e.message }; });
  return { ok: true, name: c.name, revision: c.revision, run };
}
// eski sürüm yayınlanmaz: WhatsApp onay kaydı ve planlı yayın kalkar (video panelde durur, elle yayınlanabilir)
function retireOldVersion(mp4) {
  const all = readJson(path.join(DATA, "scheduled_publish.json"), []) || [], keep = all.filter((x) => x?.video !== mp4);
  if (keep.length !== all.length) writeJson(path.join(DATA, "scheduled_publish.json"), keep);
  if (digestPending?.mp4 === mp4) digestPending = null;
  let approval = false; try { approval = !!wa.dropApprovalVideo(mp4)?.ok; } catch { /* WhatsApp yok */ }
  push(`✏️ eski sürüm (${mp4}) yayınlanmayacak${approval ? "; onay kaydı kaldırıldı" : ""}${all.length !== keep.length ? "; planlı yayını kaldırıldı" : ""} (panelde duruyor, elle yayınlanabilir)`);
  return { approval, scheduled: all.length - keep.length };
}
// "düzelt N: …" hedefi: N onay numarası → o video; numarasız → tek onay bekleyen çizilmiş video, yoksa son 24 saatin en yeni çizilmiş videosu
function reviseTarget(no, pend, vids) {
  const isRc = (name) => !!vids.find((x) => x.name === name)?.recreated;
  if (no) {
    const p = pend.find((x) => Number(x.id) === Number(no));
    if (!p) return { ok: false, error: `#${no}: onay bekleyen video yok. Düzeltme için videonun onay mesajındaki numarayı yazın (*düzelt N: ne değişsin*).${pend.length ? `\nOnay bekleyenler: ${pend.map((x) => `#${x.id} ${String(x.title || x.label || x.video).slice(0, 50)}${isRc(x.video) ? " ✏️" : ""}`).join(" · ")}` : ""}` };
    if (!isRc(p.video)) return { ok: false, error: `#${no} (${String(p.title || p.label || p.video).slice(0, 60)}) sıfırdan çizilmiş (benzer) video değil; düzeltme yalnız çizilmiş videolarda çalışır.` };
    return { ok: true, name: p.video, no: Number(no) };
  }
  const cands = pend.filter((x) => isRc(x.video));
  if (cands.length === 1) return { ok: true, name: cands[0].video, no: Number(cands[0].id) || 0 };
  if (cands.length > 1) return { ok: false, error: `Hangisi? Onay bekleyen ${cands.length} çizilmiş video var; numarasıyla yazın (*düzelt N: ne değişsin*):\n${cands.map((x) => `#${x.id} ${String(x.title || x.label || x.video).slice(0, 60)}`).join("\n")}` };
  const v = vids.find((x) => x.recreated && !x.archived && Date.now() - Number(x.mtime || 0) < 24 * 3600000);
  if (v) return { ok: true, name: v.name, no: 0 };
  return { ok: false, error: "Düzeltilecek çizilmiş (benzer) video bulunamadı: onay bekleyen yok, son 24 saatte sıfırdan çizilmiş video üretilmedi." };
}
async function reviseCommand(sc, opts = {}) {
  const pend = (() => { try { return wa.status().pendingList || []; } catch { return []; } })();
  const out = (reply) => ({ action: "revise", reply, payload: {}, heard: sc.raw || "", full: true });
  const t = reviseTarget(sc.no, pend, listVideos());
  if (!t.ok) return out(t.error);
  if (!sc.text) return out(`Ne değişsin? *düzelt${t.no ? ` ${t.no}` : ""}: …* biçiminde yazın (ör. "düzelt${t.no ? ` ${t.no}` : ""}: 2. sahnede yılan kırmızı olsun, son cümleyi kısalt"). Hedef: ${t.name}.`);
  const r = reviseVideo(t.name, sc.text, { src: opts.source === "whatsapp" ? "whatsapp" : "panel" });
  if (!r.ok) return out(`❌ Düzeltme yapılamadı: ${r.error}`);
  return out(`✏️ Düzeltme alındı${t.no ? ` (#${t.no})` : ""} → ${r.revision}. sürüm: "${sc.text.slice(0, 160)}"\nDeğişen sahneler yeniden çiziliyor, kalanlar korunuyor (3-10 dk). Yeni sürüm gelince *onay* isteyeceğim; eski sürüm yayınlanmayacak.`);
}
app.post("/api/videos/:name/revise", (req, res) => { const r = reviseVideo(req.params.name, req.body?.instruction, { src: "panel" }); const { run, ...o } = r; res.json(o); });

// Sosyal medya paylaşım linki (Instagram/TikTok/X/YouTube/Facebook; kullanıcı isteği: "viral olmuş haberin linkini göndersem
// videoyu çekip bizim stilimizde haber yap"): scripts/social_video.py indirir + paylaşım bilgisi + haber sitelerinde aynı olay;
// sonra runVideoNews (kurgu, kesim, seslendirme). Kaynak hesabı kartlarda ve açıklamada görünür; yayın onaylı (userVideo).
let socialBusy = false;
// paylaşım hazırlanırken gelen linkler video kuyruğunda bekler (videoqueue.js, aşağıda vq; socialVideoNews'i yalnız kuyruk çağırır)
// auto: 🎬 fragman takibi (twKick) — {twId, maxSoundSeconds}: her durumda fragman yolu (özet/haber kararı yok), WhatsApp sessiz (twAls)
async function socialVideoNews({ url, instruction = "", publishAt = null, kind = "", auto = null }) {
  kind = kindOf({ kind, instruction }); // linke bitişik etiket (commands.js) ya da talimattaki açık etiket
  if (socialBusy) return { ok: false, error: "Bir paylaşım zaten indiriliyor; bitince tekrar gönderin." };
  socialBusy = true;
  try {
    push(`🔗 sosyal medya paylaşımı indiriliyor: ${url}`);
    // talimat social_video.py'ye de gider: uzun YouTube videosunda bölüm seçimi ("12:30'dan itibaren", başlık + talimat kelimeleri);
    // süre: bilgi + altyazı (≤3 dk) + bölüm indirme (≤12 dk) + haber araması
    // uzun video özetinde videonun tamamı (≤3 saat, düşük çözünürlük) iner: en çok 30 dk; ilerleme satırları anında loga
    // ⬛ kare (1:1) uzun video ("link kare video"): social_video.py videonun tamamını indirir (bölüm seçimi ve özet kararı yok; en çok settings.kare.maxSeconds)
    const kare = kareOn() && kareAsk(instruction) && !(recreateOn() && (recreateAsk(instruction) || reelsAsk(instruction)));
    if (kare) push(`⬛ kare video istendi: videonun tamamı indirilecek (en çok ${Math.round(kareCfg().maxSeconds / 60)} dk)`);
    const r = await runLines(PY, ["scripts/social_video.py", "--url", url, ...(instruction ? ["--instruction", instruction] : []), ...(kind ? ["--kind", kind] : []), ...(kare ? ["--kare"] : [])], { timeout: 30 * 60000, onLine: (l) => { if (/^(🔗|📡|⬛)/.test(l)) push(l.trim()); } });
    const outLines = String(r.stdout || "").trim().split("\n");
    let j = null; try { j = JSON.parse(outLines.pop()); } catch { /* yanıt yok */ }
    if (!j?.ok) { const err = j?.error || String(r.stderr || "yanıt yok").slice(-200); push(vqCtx()?.cancelled ? `🔗 paylaşım indirilmedi${vqTag()}: video kuyruğundan iptal edildi` : `🔗 paylaşım indirilemedi${vqTag()}: ${err}`); await sendW(`❌ Paylaşım indirilemedi${vqWho()}: ${err}`); return { ok: false, error: err }; }
    const s = j.social || {};
    const n = (x) => (x == null ? null : Number(x).toLocaleString("tr-TR"));
    // benzer video (sıfırdan): fragman ve özet kararından ÖNCE (referans fragman ya da uzun video olsa da benzeri çizilir); haber aranmaz
    const reels = recreateOn() && reelsAsk(instruction);
    const rc = recreateOn() && (recreateAsk(instruction) || reels);
    if (reels) { instruction = reelsInstruction(instruction); push(`🎨 özet reels: ${Math.round((Number(s.duration) || 0) / 60)} dakikalık video çizilmiş sahnelerle özetlenecek (hedef ${trailerSecs(instruction) || 60} sn)`); }
    push(`🔗 indirildi: ${s.credit}${s.views ? ` · ${n(s.views)} izlenme` : ""}${s.likes ? ` · ${n(s.likes)} beğeni` : ""} · ${rc ? "benzer video (sıfırdan): haber sitelerinde aranmadı" : kind === "mizah" ? "mizah videosu: haber sitelerinde aranmadı" : `haber sitelerinde ${j.related?.length ? `${j.related.length} ilgili haber bulundu` : "ilgili haber bulunamadı (açıklama iddia olarak aktarılacak)"}`}`);
    // canlı yayın / uzun videonun yalnız bir bölümü alındıysa kullanıcı bilsin (kısa mesaj modunda da tek satır; bölümü değiştirme yolu)
    const note = String(s.note || ""), Note = note.charAt(0).toLocaleUpperCase("tr-TR") + note.slice(1);
    if (note && s.live) await sendW(`📡 ${Note}.`);
    else if (note && s.kare) await sendW(`⬛ ${Note}.`);
    else if (note && s.summary) await sendW(`🔎 ${Note}.${s.summaryProxy ? ` Belirli bir bölümden haber için linkin yanına zamanı yazın: "12:30'dan itibaren".` : ""}`);
    else if (note && s.window) await sendW(`🔗 ${Note}.${s.clip ? "" : ` Başka bölüm için linkin yanına zamanı yazın: "12:30'dan itibaren", "5. dakikadan", "son 3 dakika".`}`);
    if (rc) {
      push(`🎨 benzer video (sıfırdan): ${s.title ? `"${String(s.title).slice(0, 80)}" ` : ""}izlenip kelimeleri çıkarılacak, hikâyesi kendi cümlelerimizle yeniden yazılıp sahneleri çizilecek`);
      return await runVideoNews({ files: [j.file], instruction, social: s, related: [], publishAt, recreate: true });
    }
    if (kare) {
      push(`⬛ kare uzun video: ${s.title ? `"${String(s.title).slice(0, 80)}" ` : ""}${s.duration ? `(${Math.round(Number(s.duration) / 60)} dk) ` : ""}tamamı kendi sesiyle 1080x1080; kanca, giriş, bölüm başlıkları ve kapanış yazılacak`);
      return await runVideoNews({ files: [j.file], instruction, social: s, related: j.related || [], publishAt, kare: true, kind });
    }
    // fragman mı: talimat açıkça haber istemiyorsa ve talimatta fragman/trailer/teaser geçiyorsa ya da başlık fragmansa (autoDetect)
    const tc = trailerCfg();
    // "haber" etiketi açık haber isteğidir; mizah/viral etiketli video (parodi fragman) ne başlığından ne talimattaki "fragman"dan
    // fragman sayılır ("link/mizah fragman parodisi"; inceleme, 19 Ekim)
    const news = newsRequest(instruction) || kind === "haber";
    const asked = !news && !["trend", "mizah"].includes(kind) && trailerAsk(instruction);
    const trailer = !!auto || (tc.enabled !== false && !news && (asked || (tc.autoDetect !== false && !!s.trailer && !["trend", "mizah"].includes(kind))));
    // uzun video özeti (kullanıcı isteği, 19 Ekim: "uzun bir YouTube videosu göndersem analiz edip 40 saniyelik habere dökebilir miyiz,
    // çarpıcı sahneleri de alarak"): social_video.py karar verdi (uzun video ya da talimatta özet). Fragman ("analiz et", "özetle" denmiş
    // fragman linki) özet değil fragman analizidir; yalnız videonun tamamı düşük çözünürlükte indiyse (uzun video) özet yolu kalır
    if (s.summary && !auto && (!trailer || s.summaryProxy)) {
      push(`🎬 uzun video özeti: ${s.title ? `"${String(s.title).slice(0, 80)}" ` : ""}(${s.summaryReason || "özet"}; ${j.related?.length ? `haber sitelerinde ${j.related.length} ilgili haber` : "haber sitelerinde bilgi bulunamadı"})`);
      return await runVideoNews({ files: [j.file], instruction, social: s, related: j.related || [], publishAt, summary: true, summaryProxy: !!s.summaryProxy, kind });
    }
    if (trailer) {
      // başlıktan ayıklanan ad yalnız başlık fragman diye tanındıysa film adıdır ("fragman: <link>" ile istenen Instagram videosunda
      // başlık "Video by …" olabilir); tanınmadıysa Claude adı karelerden ve açıklamadan okur
      // ad yoksa (başlık boş, fragman açıklamadan tanındı) "fragman" ad diye yazılmaz
      const film = (s.trailer && s.film) || s.title || "";
      const secs = trailerSecs(instruction);
      push(`🎬 fragman analizi: ${film || "(ad yok)"} (${asked ? "talimatta istendi" : s.title ? "başlıktan tanındı" : "açıklamadan tanındı"}; ${secs} sn, ${j.related?.length ? `haber sitelerinde ${j.related.length} ilgili haber` : "haber sitelerinde bilgi bulunamadı, yalnız fragman ve açıklaması kullanılacak"})`);
      if (!asked) await sendW(`🎬 Bu bir fragman${film ? `: *${film}*` : ""}. ${secs} saniyelik fragman analizi hazırlanıyor (haber olarak isterseniz linki "haber yap" diye yeniden gönderin).`);
      // talimat yoksa "fragman yap": wa_video.py bunu varsayılan analiz talimatına (TRAILER_TALIMAT) çevirir
      return await runVideoNews({ files: [j.file], instruction: instruction || "fragman yap", social: s, related: j.related || [], publishAt, trailer: true, film: s.trailer ? (s.film || "") : "",
        ...(auto ? { trailerAuto: true, twId: auto.twId || "", maxSoundSeconds: Number(auto.maxSoundSeconds) || 0, promoPrevious: Array.isArray(auto.previous) ? auto.previous : [] } : {}) });
    }
    if (!waBrief()) await sendW(`🔗 Paylaşım indirildi: ${s.credit}${s.views ? ` · ${n(s.views)} izlenme` : ""}${s.date ? ` · ${s.date}` : ""}\n${j.related?.length ? `📰 Aynı olay haber sitelerinde de var (${[...new Set(j.related.map((x) => x.site).filter(Boolean))].slice(0, 3).join(", ")}); bilgiler oradan doğrulanacak.` : kind === "mizah" ? "😄 Mizah videosu: haber sitelerinde aranmadı." : "📰 Haber sitelerinde bulunamadı; paylaşımdaki bilgiler \"iddia\" olarak aktarılacak."}`);
    // talimat yoksa boş gider: wa_video.py türe (haber / viral / mizah) içeriğe bakarak karar verir (eskiden "haber olarak anlat" yazılıp
    // her paylaşım son dakika haberi oluyordu; kullanıcı isteği, 19 Ekim)
    return await runVideoNews({ files: [j.file], instruction, social: s, related: j.related || [], publishAt, kind });
  } finally { socialBusy = false; vq.kick(); }
}
// ---------- Video kuyruğu (videoqueue.js) ve trendlerden otomatik üretim + çok izlenme uyarısı (trendauto.js); kullanıcı isteği, 20 Ekim:
// "trend videolardan da otomatik üretelim … 3-5 video seçersem sıralasın, kuyruktan devam etsin". Panel kutusu SSE "vqueue" ile canlı.
const sse = (ev, d) => { const s = `event: ${ev}\ndata: ${JSON.stringify(d)}\n\n`; for (const c of clients) c.write(s); };
// kuyruk işi bir trend gönderisiyse (trend kartı, otomatik, "trend 1 3" ya da listede olan link) kartın durumu: sırada → hazırlanıyor →
// üretildi / hata / iptal (data/ig_trends_done.json, 7 gün)
function igtMarkDone(url, st, extra = {}) {
  const d = igtDone(); d[url] = { ...(d[url] || {}), at: Date.now(), state: st, ...extra };
  if (!["hata", "iptal"].includes(st)) delete d[url].error;
  writeJson(IGT_DONE, Object.fromEntries(Object.entries(d).filter(([, v]) => Date.now() - (v?.at || 0) < 7 * 864e5)));
}
const igtUrlOf = (u) => { const k = normUrl(u); return ((readJson(IGT_FILE, {}) || {}).items || []).find((x) => normUrl(x.url) === k)?.url || null; };
const vq = makeVideoQueue({ DATA, app, push, sse, settings, socialVideoNews, socialBusy: () => socialBusy, anlikQueue,
  anlikRunning: () => (state.running && anlikNow && anlikNow.at === state.startedAt ? anlikNow.vq || null : null), pipelineAlive: () => pipelineBusy(),
  pipelineProc: () => pipelineProc, killTree, resting, restInfo, restEnd, restRecheck, waEnabled: () => waVideoCfg().enabled !== false,
  approvals: () => wa.status().pendingList || [], // tanınmayan iptal sözünün yanıtında yayın onayı bekleyenler (numaralarıyla)
  openUrl: (u) => execAction({ type: "open_url", target: u }), // video linki + haber linki + "açar mısın": yalnız açılır (5. tur)
  dropApproval: (n) => wa.dropApproval(n), onCancelVideo: (mp4) => cancelProducedVideo(mp4), // "#3 iptal": üretilmiş videonun onayı/planlı yayını
  // yeniden başlatma (karar 5): kilitteki üretim pid'i; panel kapalıyken çıkan kuyruk videosu (meta queue.no, iş başladıktan sonra) ve onay mesajı
  lockPid: () => { try { const pid = Number(readFileSync(path.join(WORK, "pipeline.lock", "pid"), "utf8").trim()); process.kill(pid, 0); return pid; } catch { return null; } },
  heldNos: () => { try { return wa.heldNos?.() || []; } catch { return []; } }, // bekleyen ve süresi dolan (24 saat) onayların numaraları başka videoya verilmez (7. tur)
  findProduced: (no, since) => { for (const f of readdirSync(OUT).filter((x) => x.endsWith(".json"))) { try { const p = path.join(OUT, f); if (statSync(p).mtimeMs < since - 1000) continue; const m = JSON.parse(readFileSync(p, "utf8")); if (Number(m?.queue?.no) === no && existsSync(p.replace(/\.json$/, ".mp4"))) return f.replace(/\.json$/, ".mp4"); } catch { /* bozuk */ } } return null; },
  onRecovered: (mp4) => { if (settings().whatsapp?.enabled) wa.notifyVideo(mp4, { ask: true, summary: [] }).catch((e) => push(`💬 kuyruk videosunun onay mesajı gönderilemedi: ${e.message}`)); },
  onTrend: (it, st, err) => { const u = it.trend ? it.url : igtUrlOf(it.url); if (u) igtMarkDone(u, st, { mode: it.mode || "haber", auto: it.source === "trend-auto", ...(err ? { error: err } : {}) }); } });
const trendAuto = makeTrendAuto({ DATA, push, settings, patchSettings, igtFile: IGT_FILE, igtDone, vq, dupCheck, dupWhy, resting, restInfo, restEnd,
  waEnabled: () => waVideoCfg().enabled !== false, sendWA: (t) => sendW(t), sse, minRatio: () => Number(igTrendsCfg().minRatio) || 2 });
// Kuyruk işinin videosu: üretim sürerken out/'a çıkan dosya o işle eşlenir (vq.produced: onay numarası = iş numarası). İşi iptal edilen video
// (5. tur, inceleme, 20 Ekim: yayın saatli link videosu üretim sonunda iptal edilince o saatte onaysız yayınlanıyordu): planlı yayını, WhatsApp
// özeti ve onay kaydı kaldırılır; panelde durur, yalnız panelden elle yayınlanabilir (vqCancelledVideos, 24 saat)
const vqCancelledVideos = new Map();
function vqProduced(mp4) { try { const id = state.running && anlikNow && anlikNow.at === state.startedAt ? anlikNow.vq : null; if (id) vq.produced(id, path.basename(mp4)); } catch { /* kuyruk işi değil */ } }
function cancelProducedVideo(mp4) {
  mp4 = path.basename(String(mp4 || "")); if (!mp4) return null;
  for (const [k, t] of vqCancelledVideos) if (Date.now() - t > 24 * 3600000) vqCancelledVideos.delete(k);
  vqCancelledVideos.set(mp4, Date.now());
  const all = readJson(path.join(DATA, "scheduled_publish.json"), []) || [], keep = all.filter((x) => x?.video !== mp4);
  if (keep.length !== all.length) writeJson(path.join(DATA, "scheduled_publish.json"), keep);
  const digest = digestPending?.mp4 === mp4; if (digest) digestPending = null;
  let approval = false; try { approval = !!wa.dropApprovalVideo(mp4)?.ok; } catch { /* WhatsApp yok */ }
  push(`⏹ video kuyruğundan iptal edilen işin videosu (${mp4}) yayınlanmayacak${all.length !== keep.length ? "; planlı yayını kaldırıldı" : ""}${approval ? "; onay kaydı kaldırıldı" : ""}${digest ? "; WhatsApp özeti gönderilmeyecek" : ""} (panelden elle yayınlanabilir)`);
  return { scheduled: all.length - keep.length, approval, digest };
}
// Kuyruk videosu (6. tur, karar 3; video kuyruğundan üretilen userVideo, otomatik trend dahil): YALNIZ sahibin kendisine ulaşmış onay mesajına
// numaralı ya da numarasız onayı (via: approval; whatsapp.js yalnız ulaşmış onayda çağırır) ya da panelin yayın düğmesiyle (via: panel)
// yayınlanır. Doğal dil, sesli komut, beyin ("son videoyu yayınla", "hepsini yayınla") ve planlı yayın (via: scheduled) ASLA yayınlamaz. Sahiplik
// videonun meta'sında (queue.no; assemble_script VQ_NO ile yazar), yedek olarak kuyruğun üretim eşlemesinde ve süren kuyruk üretiminde: panel
// yeniden başlasa da onay mesajı gönderilemese de açık kalmaz (5. turun "onay mesajı ulaştı mı" kapısı yeniden başlatma, gönderim hatası ve kısa
// aralıklarda açık kalıyordu; kaldırıldı). Diğer videolar HEAD'deki gibi
function queueNoOf(video) {
  const v = path.basename(String(video || "")); if (!v) return 0;
  const m = readJson(path.join(OUT, v.replace(/\.mp4$/, ".json")), null);
  const n = Number(m?.queue?.no) || 0; if (n) return n;
  try { const k = vq.ownerNo(v); if (k) return k; } catch { /* kuyruk yok */ }
  // üretimi süren kuyruk işinin videosu (meta henüz yazılmadı): üretim başladıktan sonra çıkan dosya
  try { if (state.running && anlikNow?.vq && anlikNow.at === state.startedAt && statSync(path.join(OUT, v)).mtimeMs >= state.startedAt - 1000) return -1; } catch { /* dosya yok */ }
  return 0;
}
// kuyruk videosunun yayın saati (karar 3): kendiliğinden uygulanmaz, yanıt bunu söyler
function vqTimeTail(c, no) { return c.publishAt ? `\n${vq.timeLine(new Date(c.publishAt), no)}` : ""; }
function queueGate(video) {
  if (waVideoCfg().autoPublish) return null; // onaysız yayın ayarı açık: kuyruk videosu da planlı yayınla, "son videoyu yayınla" ile ve sesli komutla yayınlanır
  const v = path.basename(String(video || ""));
  if (vqCancelledVideos.has(v)) return "Bu video video kuyruğundan iptal edildi; yayınlanmadı (isterseniz panelden yayınlayın).";
  const n = queueNoOf(v);
  return n ? `Bu video video kuyruğundan${n > 0 ? ` (#${n})` : ""}: yalnız size gelen onay mesajına *onay${n > 0 ? ` ${n}` : " <numara>"}* yazarak ya da panelden (video → yayınla) yayınlanır.` : null;
}
// açılış: kuyruğu kaybolmuş "sırada" kaydı (kuyruk dosyası silinmiş) kartta sonsuza dek "⏳ Sırada" kalmasın
{ const d = igtDone(); let n = 0; for (const [u, v] of Object.entries(d)) if (v?.state === "sırada" && !vq.has(u)) { v.state = "hata"; v.error = "panel yeniden başladı, sıradan düştü"; n++; } if (n) writeJson(IGT_DONE, d); }
// ---------- 🎬 Fragman takibi (kullanıcı isteği, 24 Ekim: "yayınlanan YouTube kanallarının fragmanlarını panele gireyim, kanalları tarasın, en son
// yayınladığı fragmanı kaydetsin, yeni fragman düşerse anında fragmandan sahneler koyarak, çarpıcı yerlerinin orijinallerini de koyarak kancalı bir
// yapıyla yayınlasın"): settings.trailerWatch {enabled, intervalMin 10, channels [], maxAgeHours 24, maxPerDay 4, autoPublish true, notify false,
// onlyTrailers true, soundSeconds 10, duration 0 (0 = fragman analizi süresi)}. scripts/trailer_watch.py kanal RSS akışlarını okur (ilk taramada
// kanalın son fragmanı yalnız KAYDEDİLİR); sonraki taramalarda yeni fragman → sıra (data/trailer_watch_done.json) → twKick: socialVideoNews fragman
// yolu (talimat "fragman yap; en çarpıcı anların orijinal sesini kullan": kanca + fragmandan hızlı kesilmiş sahneler + en çok soundSeconds sn
// orijinal sesli çarpıcı an) → startAnlik otomatik + öncelikli (sahibin işleri yine önde; sondakika gibi dinlenmeyi bitirir) → meta trailerAuto →
// post_pipeline bağlı TÜM hesaplara (YouTube değer kuralına takılmaz). WhatsApp sessiz (onlyUserVideos; notify açıksa başlarken tek satır);
// autoPublish kapalıysa video sahibin işi gibi onaya gelir. Günde en çok maxPerDay; fazlası "atlandı".
const TW_STATE = path.join(DATA, "trailer_watch.json"); // trailer_watch.py: {channels: {key: {input, channelId, name, lastVideoId, lastTitle, lastPublished, lastTs, lastUrl, error, first}}, seen, lastScan}
const TW_DONE = path.join(DATA, "trailer_watch_done.json"); // {videoId: {at, state: sırada|hazırlanıyor|üretimde|üretildi|hata|atlandı, title, channel, url, day, video, error}}
// kullanıcı isteği, 26 Ekim ("fragman takibini sıkıştıralım, tanıtımları asla kaçırmayalım, onaysız yayınlayalım"): 3 dakikada bir tarama, günlük sınır yok
// (0), ilk taramada son 12 saatin fragmanları da üretilir (firstFreshHours), RSS'in yanında kanalın videolar sayfası da okunur (pageScan)
// kullanıcı isteği, 26 Ekim (ikinci): tarama 2 saatte bir (120 dk), 10 gündür fragman gelmeyen kanalda uyarı (staleDays: dizi bitmiş olabilir, kanal kaldırılır)
const TW_DEFAULTS = { enabled: true, intervalMin: 120, channels: [], maxAgeHours: 24, maxPerDay: 0, autoPublish: true, notify: false, onlyTrailers: true, soundSeconds: 10, duration: 0, firstFreshHours: 12, pageScan: true, staleDays: 10 };
const trailerWatchCfg = () => {
  const raw = settings().trailerWatch, c = { ...TW_DEFAULTS, ...(raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) };
  const off = (v) => v === false || v === 0 || ["false", "0"].includes(String(v).trim().toLowerCase());
  c.enabled = !off(c.enabled); c.autoPublish = !off(c.autoPublish); c.notify = c.notify === true || ["true", "1"].includes(String(c.notify)); c.onlyTrailers = !off(c.onlyTrailers);
  c.channels = Array.isArray(c.channels) ? [...new Set(c.channels.map((x) => String(x).trim()).filter(Boolean))] : [];
  // duraklatılan kanallar (kullanıcı isteği, 27 Ekim: "sezon arası" düğmesi: kart kalır, taranmaz, tek tıkla geri açılır); listede olmayan kayıt düşer
  c.paused = Array.isArray(c.paused) ? [...new Set(c.paused.map((x) => String(x).trim()).filter((x) => x && c.channels.some((y) => twKey(y) === twKey(x))))] : [];
  c.active = c.channels.filter((x) => !c.paused.some((p) => twKey(p) === twKey(x)));
  for (const k of ["intervalMin", "maxAgeHours"]) c[k] = Number(c[k]) > 0 ? Number(c[k]) : TW_DEFAULTS[k];
  c.intervalMin = Math.min(1440, Math.max(2, c.intervalMin));
  c.maxPerDay = Number.isFinite(Number(c.maxPerDay)) && Number(c.maxPerDay) >= 0 ? Math.min(50, Math.round(Number(c.maxPerDay))) : TW_DEFAULTS.maxPerDay; // 0 = sınırsız
  c.firstFreshHours = Number.isFinite(Number(c.firstFreshHours)) && Number(c.firstFreshHours) >= 0 ? Math.min(72, Number(c.firstFreshHours)) : TW_DEFAULTS.firstFreshHours;
  c.pageScan = !off(c.pageScan);
  c.staleDays = Number(c.staleDays) > 0 ? Math.min(90, Math.round(Number(c.staleDays))) : TW_DEFAULTS.staleDays;
  c.soundSeconds = Number(c.soundSeconds) >= 0 && Number.isFinite(Number(c.soundSeconds)) ? Math.min(30, Number(c.soundSeconds)) : TW_DEFAULTS.soundSeconds; // 0 = orijinal ses yok
  c.duration = Number(c.duration) > 0 ? Math.min(60, Math.max(20, Number(c.duration))) : 0;
  return c;
};
// 10 gündür fragman gelmeyen kanallar (kullanıcı isteği, 26 Ekim: "10 gün fragman gelmezse uyarı çıksın, dizinin finallendiğini anlayıp kendim
// kaldırayım"): kayıtlı son fragmanın yayın zamanından (hiç fragman yoksa kanalın eklenme anından) staleDays geçtiyse; panel kartında rozet,
// logda günde bir satır, WhatsApp'a kanal başına bir kez (data/trailer_watch_stale.json)
const TW_STALE = path.join(DATA, "trailer_watch_stale.json"); // {key: {loggedDay, notifiedAt}}
// Hazır kanal listesi (kullanıcı isteği, 27 Ekim: "Show TV, ATV, Kanal D, Star, NOW, TRT, Netflix Türkiye, Disney+, Exxen, Gain, BluTV gibi
// yayıncıları tek tıkla ekleme"): YouTube tanıtıcıları (@handle) buradan doğrulanamadı; kanal ilk taramada çözülür, çözülemeyen kart hata
// gösterir ve ✏️ ile düzenlenir. Grup: yayıncı / platform / yapım şirketi (dizi fragmanları çoğu zaman yapımcının kanalına da düşer)
const TW_PRESETS = [
  { name: "Show TV", input: "@showtv", group: "yayıncı" }, { name: "Kanal D", input: "@kanald", group: "yayıncı" }, { name: "ATV", input: "@atv", group: "yayıncı" },
  { name: "Star TV", input: "@startv", group: "yayıncı" }, { name: "NOW (eski FOX)", input: "@nowtv", group: "yayıncı" }, { name: "TRT 1", input: "@trt1", group: "yayıncı" },
  { name: "Netflix Türkiye", input: "@NetflixTurkiye", group: "platform" }, { name: "Disney+ Türkiye", input: "@DisneyPlusTR", group: "platform" },
  { name: "Exxen", input: "@exxen", group: "platform" }, { name: "Gain", input: "@gain", group: "platform" }, { name: "BluTV", input: "@blutv", group: "platform" },
  { name: "Ay Yapım", input: "@ayyapim", group: "yapım" }, { name: "OGM Pictures", input: "@ogmpictures", group: "yapım" }, { name: "Tims&B", input: "@timsb", group: "yapım" },
  { name: "MF Yapım", input: "@mfyapim", group: "yapım" }, { name: "Gold Film", input: "@goldfilm", group: "yapım" }, { name: "Medyapım", input: "@medyapim", group: "yapım" },
];
function twStaleList(c = trailerWatchCfg(), st = readJson(TW_STATE, {}) || {}) {
  const out = [];
  for (const inp of c.active) { // duraklatılan kanal uyarı almaz
    const key = twKey(inp), ch = (st.channels || {})[key] || {};
    const last = Number(ch.lastTs) > 0 ? Number(ch.lastTs) * 1000 : Date.parse(ch.addedAt || "") || 0;
    if (!last) continue;
    const days = (Date.now() - last) / 864e5;
    if (days >= c.staleDays) out.push({ key, input: inp, name: ch.name || inp, days: Math.floor(days), lastTitle: ch.lastTitle || "", never: !(Number(ch.lastTs) > 0) });
  }
  return out;
}
async function twStaleCheck() {
  const list = twStaleList(), d = readJson(TW_STALE, {}) || {};
  let changed = false;
  for (const x of list) {
    const rec = d[x.key] || {};
    if (rec.loggedDay !== today()) { push(`⚠️ fragman takibi: ${x.name} kanalından ${x.days} gündür fragman gelmedi${x.never ? " (hiç fragman bulunmadı)" : ""}; dizi bitmiş olabilir — boşuna taranmasın diye kanalı panelden kaldırabilirsiniz`); rec.loggedDay = today(); changed = true; }
    if (!rec.notifiedAt) { await sendW(`⚠️ Fragman takibi: *${x.name}* kanalından ${x.days} gündür fragman gelmedi; dizi bitmiş olabilir. Kaldırmak için: fragman kanalı çıkar ${x.input}`); rec.notifiedAt = Date.now(); changed = true; }
    d[x.key] = rec;
  }
  for (const k of Object.keys(d)) if (!list.some((x) => x.key === k)) { delete d[k]; changed = true; } // fragman gelince ya da kanal kaldırılınca uyarı sıfırlanır
  if (changed) writeJson(TW_STALE, d);
}
// kanal anahtarı (trailer_watch.channel_key ile aynı): "@handle" küçük harf | UC… kimliği | "c/Ad"
const twKey = (inp) => { const t = String(inp || "").trim(); if (/^UC[\w-]{20,}$/.test(t)) return t; const m = t.match(/youtube\.com\/(?:channel\/(UC[\w-]{20,})|@([^/?#\s]+)|(?:c|user)\/([^/?#\s]+))/i); if (m) return m[1] || (m[2] ? `@${m[2].toLowerCase()}` : `c/${m[3]}`); return `@${t.replace(/^@/, "").toLowerCase()}`; };
const twDone = () => { const d = readJson(TW_DONE, {}); return d && typeof d === "object" && !Array.isArray(d) ? d : {}; };
function twMark(id, st, extra = {}) {
  const d = twDone(); d[id] = { ...(d[id] || {}), ...extra, at: Date.now(), state: st }; if (st !== "hata" && st !== "atlandı") delete d[id].error;
  writeJson(TW_DONE, Object.fromEntries(Object.entries(d).filter(([, v]) => Date.now() - (v?.at || 0) < 30 * 864e5))); // 30 gün
}
const twToday = () => Object.values(twDone()).filter((v) => v.day === today() && ["hazırlanıyor", "üretimde", "üretildi", "hata"].includes(v.state)).length; // bugün üretime giren (günlük sınır)
let twPending = Object.entries(twDone()).filter(([, v]) => v?.state === "sırada").sort((a, b) => (a[1].at || 0) - (b[1].at || 0)).map(([videoId, v]) => ({ videoId, title: v.title, channel: v.channel, url: v.url })); // yeniden başlatmada sıradakiler kalır
let twBusy = false, twRunning = null, twLast = Date.parse((readJson(TW_STATE, {}) || {}).lastScan || "") || 0, twErrAt = 0;
async function trailerWatchScan({ manual = false } = {}) {
  if (twBusy) return { ok: false, busy: true, error: "Fragman kanalları taraması zaten sürüyor." };
  const c = trailerWatchCfg();
  if (!c.channels.length) { if (manual) push("🎬 fragman takibi: kanal listesi boş (Ayarlar → 🎬 Fragman takibi ya da \"fragman kanalı ekle @kanal\")"); return { ok: false, error: "Kanal listesi boş; önce kanal ekleyin." }; }
  if (!c.active.length) { if (manual) push("🎬 fragman takibi: bütün kanallar duraklatılmış (sezon arası); taranacak kanal yok"); return { ok: false, error: "Bütün kanallar duraklatılmış (sezon arası)." }; }
  twBusy = true; twLast = Date.now();
  try {
    const r = (await pyJson(["scripts/trailer_watch.py", "--scan"], 4 * 60000)) || { ok: false, error: "yanıt yok" };
    const chans = Object.values(r.channels || {}), firsts = chans.filter((x) => x.first).length, errs = [...(r.ok ? [] : [r.error || "yanıt yok"]), ...(r.errors || [])];
    const nn = (r.new || []).length;
    if (manual && r.ok) { push(`🎬 fragman kanalları tarandı: ${chans.length} kanal, ${chans.filter((x) => x.lastVideoId).length} kanalın son fragmanı kayıtlı${firsts ? ` (${firsts} kanal ilk kez: son fragmanı kaydedildi, üretilmedi)` : ""} · ${nn} yeni fragman`); for (const e of errs.slice(0, 3)) push(`🎬 fragman takibi: ${e}`); }
    else if (manual) push(`🎬 fragman kanalları taraması başarısız: ${errs[0]}`);
    else if (!r.ok) { if (Date.now() - twErrAt > 6 * 3600000) { twErrAt = Date.now(); push(`🎬 fragman takibi: ${errs[0]}`); } }
    else { if (firsts) push(`🎬 fragman takibi: ${firsts} kanalın son fragmanı kaydedildi (ilk tarama; üretilmez), bundan sonra düşen yeni fragmanlar üretilir`); if (errs.length && Date.now() - twErrAt > 6 * 3600000) { twErrAt = Date.now(); push(`🎬 fragman takibi: ${errs[0]}${errs.length > 1 ? ` (+${errs.length - 1} kanal daha, ayrıntı panelde)` : ""}`); } }
    const done = twDone();
    for (const n of r.new || []) {
      if (!n?.videoId || !n.url || done[n.videoId] || twPending.some((p) => p.videoId === n.videoId)) continue;
      // tanıtım türü (social_video.promo_info: "16. BÖLÜM 2. FRAGMAN", "16. BÖLÜM TANITIMI", "ÖN GÖSTERİM"…) ve aynı bölümün önceki tanıtımları (kurguya bağ cümlesi için)
      const item = { videoId: n.videoId, title: String(n.title || "").slice(0, 200), channel: String(n.channel || "").slice(0, 80), key: String(n.key || ""), url: n.url, published: n.published || null,
        promoLabel: String(n.promo?.label || "").slice(0, 30), previous: Array.isArray(n.previous) ? n.previous.slice(-6).map((x) => ({ title: String(x.title || "").slice(0, 120), published: String(x.published || "").slice(0, 10), label: String(x.label || "").slice(0, 30) })) : [] };
      if (!c.enabled) { twMark(n.videoId, "atlandı", { ...item, error: "fragman takibi kapalı" }); continue; }
      if (c.maxPerDay > 0 && twToday() + twPending.length >= c.maxPerDay) { twMark(n.videoId, "atlandı", { ...item, error: `günlük sınır (${c.maxPerDay}) doldu` }); push(`🎬 yeni fragman atlandı (günlük ${c.maxPerDay} sınırı doldu): ${item.channel} — ${item.title.slice(0, 70)}`); continue; }
      twPending.push(item); twMark(n.videoId, "sırada", item);
      push(`🎬 YENİ FRAGMAN: ${item.channel} — ${item.title.slice(0, 80)}${item.promoLabel ? ` (${item.promoLabel}${item.previous.length ? `; aynı bölümün ${item.previous.length} önceki tanıtımı var` : ""})` : ""} → fragman analizi sıraya alındı`);
    }
    sse("trailerwatch", { new: nn });
    twKick().catch((e) => push(`🎬 fragman takibi: ${e.message}`));
    if (r.ok) twStaleCheck().catch(() => {});
    return r;
  } finally { twBusy = false; }
}
// sıradaki fragmanı üretime ver: aynı anda tek fragman; link indirilirken (socialBusy) bekler (socialVideoNews bitince vq.kick gibi dakikalık kontrol)
async function twKick() {
  if (twRunning || !twPending.length || socialBusy) return;
  const c = trailerWatchCfg();
  if (!c.enabled) return;
  const it = twPending.shift(); twRunning = it;
  twMark(it.videoId, "hazırlanıyor", { day: today() });
  push(`🎬 fragman takibi: "${String(it.title).slice(0, 70)}" (${it.channel}) fragman analizi hazırlanıyor${c.autoPublish ? " — bitince bağlı hesaplarda yayınlanacak" : " — bitince onayınıza gelecek"}`);
  if (c.notify) await sendW(`🎬 Yeni fragman: *${String(it.title).slice(0, 80)}* (${it.channel}). Fragman analizi hazırlanıyor; ${c.autoPublish ? "bitince bağlı hesaplarda yayınlanacak." : "bitince onayınıza gelecek."}`);
  if (resting()) restEnd(`yeni fragman düştü: ${String(it.title).slice(0, 60)}`); // kullanıcı "anında" dedi: dinlenme beklenmez (sondakika gibi)
  try {
    const instruction = (c.soundSeconds > 0 ? "fragman yap; en çarpıcı anların orijinal sesini kullan" : "fragman yap") + (c.duration ? `; ${c.duration} saniye` : "");
    const r = await twAls.run({ quiet: true, twId: it.videoId }, () => socialVideoNews({ url: it.url, instruction, auto: { twId: it.videoId, maxSoundSeconds: c.soundSeconds, previous: it.previous || [] } }));
    if (r?.ok) twMark(it.videoId, "üretimde", { queued: !!r.queued });
    else twMark(it.videoId, "hata", { error: String(r?.error || "yanıt yok").slice(0, 200) });
  } catch (e) { twMark(it.videoId, "hata", { error: String(e?.message || e).slice(0, 200) }); push(`🎬 fragman takibi hatası: ${e?.message || e}`); }
  finally { twRunning = null; sse("trailerwatch", {}); }
}
// üretim bitti: anlık işin opts.twId'si fragman takibininse kayıt üretildi/hata (143: sahibin işi için durduruldu, sıraya geri alındı — hata değil)
const twJobId = () => (anlikNow && anlikNow.at === state.startedAt ? String(anlikNow.opts?.twId || "") : "");
function twProduced(name) { const id = twJobId(); if (id) { twMark(id, "üretildi", { video: name }); sse("trailerwatch", {}); } }
function twPipelineEnd(code) { const id = twJobId(); if (id && code !== 0 && code !== 143 && twDone()[id]?.state !== "üretildi") { twMark(id, "hata", { error: `üretim hata ile bitti (kod ${code})` }); sse("trailerwatch", {}); } }
function twStatusText() {
  const c = trailerWatchCfg(), st = readJson(TW_STATE, {}) || {}, chans = Object.values(st.channels || {});
  const every = c.intervalMin % 60 === 0 ? `${c.intervalMin / 60} saatte bir` : `${c.intervalMin} dk'da bir`;
  const head = `🎬 Fragman takibi ${c.enabled ? "açık" : "KAPALI"} · ${c.channels.length} kanal${c.paused.length ? ` (${c.paused.length} duraklatıldı)` : ""} · ${every} · bugün ${twToday()}${c.maxPerDay ? `/${c.maxPerDay}` : ""}${twPending.length ? ` · sırada ${twPending.length}` : ""}${twRunning ? ` · hazırlanıyor: ${String(twRunning.title).slice(0, 50)}` : ""}${c.autoPublish ? " · yayın otomatik" : " · yayın onaylı"}`;
  const staleBy = new Map(twStaleList(c, st).map((x) => [x.key, x])), staleOf = (x) => staleBy.get(twKey(x.input || ""));
  const lines = chans.slice(0, 10).map((x) => `• ${x.name || x.input}: ${x.paused ? "⏸ duraklatıldı (sezon arası; devam: fragman kanalı devam " + x.input + ")" : x.error ? `⚠️ ${x.error}` : x.lastTitle ? `son fragman "${String(x.lastTitle).slice(0, 50)}"${x.lastPublished ? ` (${String(x.lastPublished).slice(0, 16).replace("T", " ")})` : ""}${x.first ? " — ilk tarama, kaydedildi" : ""}` : "fragman bulunamadı"}${staleOf(x) ? ` ⚠️ ${staleOf(x).days} gündür fragman yok (dizi bitmiş olabilir: fragman kanalı çıkar ${x.input})` : ""}`);
  const recent = Object.entries(twDone()).map(([id, v]) => ({ id, ...v })).filter((v) => v.state !== "sırada").sort((a, b) => (b.at || 0) - (a.at || 0)).slice(0, 3)
    .map((v) => `• ${v.channel ? `${v.channel}: ` : ""}${String(v.title || v.id).slice(0, 50)}${v.promoLabel ? ` [${v.promoLabel}]` : ""} — ${v.state}${v.error ? ` (${v.error})` : ""}`);
  return head + (lines.length ? `\n${lines.join("\n")}` : "\nKanal ekleyin: fragman kanalı ekle @NetflixTurkiye (ya da panelden)") + (recent.length ? `\nSon fragmanlar:\n${recent.join("\n")}` : "");
}
setInterval(() => {
  const c = trailerWatchCfg();
  if (c.enabled && c.active.length && !twBusy && Date.now() - twLast >= c.intervalMin * 60000 - 5000) trailerWatchScan().catch((e) => push(`🎬 fragman takibi: ${e.message}`));
  else if (twPending.length) twKick().catch((e) => push(`🎬 fragman takibi: ${e.message}`));
}, 60000);
app.get("/api/trailerwatch", (_req, res) => {
  const st = readJson(TW_STATE, {}) || {}, c = trailerWatchCfg();
  const done = Object.entries(twDone()).map(([videoId, v]) => ({ videoId, ...v })).sort((a, b) => (b.at || 0) - (a.at || 0));
  const stale = twStaleList(c, st);
  // kanal kartları (ayar listesi sırasıyla): durum kaydı + son üretim + uyarı
  const list = c.channels.map((inp) => { const key = twKey(inp), ch = (st.channels || {})[key] || {}; const sl = stale.find((x) => x.key === key);
    const lp = done.find((v) => (v.key ? v.key === key : v.channel && v.channel === ch.name) && ["üretimde", "üretildi", "hazırlanıyor"].includes(v.state));
    return { input: inp, key, name: ch.name || "", channelId: ch.channelId || "", lastTitle: ch.lastTitle || "", lastUrl: ch.lastUrl || "", lastPublished: ch.lastPublished || "", lastChecked: ch.lastChecked || "", addedAt: ch.addedAt || "",
      paused: c.paused.some((p) => twKey(p) === key),
      videos: ch.videos ?? null, trailers: ch.trailers ?? null, error: ch.error || "", first: !!ch.first, stale: !!sl, days: sl?.days ?? null, never: !!sl?.never, lastProduced: lp ? { at: lp.at, title: lp.title, promoLabel: lp.promoLabel || "", state: lp.state } : null }; });
  res.json({ cfg: c, channels: st.channels || {}, list, stale, lastScan: st.lastScan || null, scanning: twBusy, running: twRunning, pending: twPending, today: twToday(),
    presets: TW_PRESETS.map((p) => ({ ...p, added: c.channels.some((x) => twKey(x) === twKey(p.input)) })),
    done: done.slice(0, 20),
    nextScanIn: c.enabled && c.active.length ? Math.max(0, twLast + c.intervalMin * 60000 - Date.now()) : null });
});
app.post("/api/trailerwatch/scan", async (_req, res) => res.json(await trailerWatchScan({ manual: true })));
// kanalı duraklat / devam ettir (sezon arası): settings.trailerWatch.paused
function twSetPaused(input, paused) {
  const c = trailerWatchCfg(), inp = c.channels.find((x) => twKey(x) === twKey(String(input || ""))) || "";
  if (!inp) return { ok: false, error: "Bu kanal fragman takibinde değil." };
  const list = c.paused.filter((p) => twKey(p) !== twKey(inp)); if (paused) list.push(inp);
  patchSettings({ trailerWatch: { paused: list } });
  push(paused ? `⏸ fragman takibi: ${inp} duraklatıldı (sezon arası; taranmaz, kart kalır)` : `▶ fragman takibi: ${inp} yeniden taranıyor`);
  sse("trailerwatch", {});
  if (!paused) trailerWatchScan().catch(() => {});
  return { ok: true, input: inp, paused: !!paused, pausedCount: list.length };
}
app.post("/api/trailerwatch/pause", (req, res) => res.json(twSetPaused(req.body?.input, req.body?.paused !== false)));
app.post("/api/igtrends/auto", (req, res) => res.json({ ok: true, reply: trendAuto.setAuto(req.body?.on !== false), auto: { ...trendAuto.cfg(), today: trendAuto.todayCount() } }));

// ---------- Planlı yayın (kullanıcı isteği: "linki gönderip bunu şu saatte paylaş diyeyim"): post_pipeline saati gelmemiş videoyu
// data/scheduled_publish.json'a yazar; panel dakikada bir bakar, saati gelince bağlı hesaplara yayınlar ve WhatsApp'a yazar.
// Mac uykudaysa uyanınca yayınlar; 12 saatten fazla geciktiyse (haber bayatladı) yayınlamaz, sorar. Log ⏰.
const PUB_SCHED = path.join(DATA, "scheduled_publish.json");
const schedItems = () => readJson(PUB_SCHED, []) || [];
const vidTitle = (name) => { const m = readJson(path.join(OUT, name.replace(/\.mp4$/, ".json")), {}); return m.publishTitle || m.titles?.A || name; };
let schedBusy = false;
async function publishScheduled(item, { late = false } = {}) {
  if (vqCancelledVideos.has(item.video)) { writeJson(PUB_SCHED, schedItems().filter((x) => x.video !== item.video)); push(`⏰ planlı yayın: ${item.video} video kuyruğundan iptal edilmişti, yayınlanmadı`); return { ok: false }; }
  { const qn = queueNoOf(item.video); if (qn) { writeJson(PUB_SCHED, schedItems().filter((x) => x.video !== item.video)); push(`⏰ planlı yayın: ${item.video} video kuyruğundan${qn > 0 ? ` (#${qn})` : ""}; kuyruk videosu planlı yayınla yayınlanmaz, yalnız onayla (karar 3)`); return { ok: false }; } }
  if (!existsSync(path.join(OUT, item.video))) { writeJson(PUB_SCHED, schedItems().filter((x) => x.video !== item.video)); push(`⏰ planlı yayın: ${item.video} bulunamadı (silinmiş), atlandı`); return { ok: false }; }
  push(`⏰ planlı yayın zamanı geldi${late ? " (gecikmeli)" : ""}: ${vidTitle(item.video).slice(0, 80)} → ${item.platforms.join(", ")}`);
  // kayıt yükleme bitince silinir: o sürede saatlik disk temizliği (cleanup.py protected) videoyu ve kapağını silmesin; ikinci kez
  // yayınlanmasın diye dakikalık döngü schedBusy ile bekler
  let r;
  try { r = await execAction({ type: "publish", video: item.video, platforms: item.platforms, via: "scheduled" }); } finally { writeJson(PUB_SCHED, schedItems().filter((x) => x.video !== item.video)); }
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
// ---------- disk temizliği (scripts/cleanup.py; kullanıcı isteği, 19 Ekim: "tüm üretilen haberleri ve videoları, normal videolar dahil 2
// gün sonra diskten silelim, kapaklar dahil"): saatte bir (her saatin 10. dakikasından sonra, üretim yokken), settings.cleanup {enabled,
// days 2}; dinlenmede de (hafif). Video, kapaklar, küçük resim, iş klasörü, kaynak video silinir; kayıt (json) ve platformdaki video kalır.
const CLEAN_FILE = path.join(DATA, "cleanup_last.json");
let cleanBusy = false;
async function runCleanup({ manual = false } = {}) {
  if (cleanBusy) return { deleted: [], freedMb: 0, busy: true };
  cleanBusy = true;
  try {
    const r = await py("cleanup.py", []);
    const j = r.json || {};
    const n = new Date();
    writeJson(CLEAN_FILE, { day: today(), hour: `${today()} ${n.getHours()}`, at: Date.now(), deleted: (j.deleted || []).length, freedMb: j.freedMb || 0, other: j.other || {} });
    const o = j.other || {}, extra = [o.isKlasoru && `${o.isKlasoru} iş klasörü`, o.kaynakVideo && `${o.kaynakVideo} kaynak video`, o.hikaye && `${o.hikaye} hikâye klasörü`].filter(Boolean);
    const gb = (Number(j.freedMb || 0) / 1024).toFixed(1);
    if ((j.deleted || []).length) push(`🧹 disk temizliği: ${j.days || 2} günden eski ${(j.deleted || []).length} video kapaklarıyla silindi${extra.length ? ` (+ ${extra.join(", ")})` : ""}, ${gb} GB boşaldı; kayıtlar ve platformdaki videolar duruyor`);
    else if (extra.length || o.kapak) push(`🧹 disk temizliği: ${[...(o.kapak ? [`${o.kapak} eski kapak`] : []), ...extra].join(", ")} silindi, ${gb} GB boşaldı`);
    else if (manual) push("🧹 disk temizliği: silinecek eski dosya yok");
    if (r.stderr && /! derleme parçası/.test(r.stderr)) push(`🧹 ${String(r.stderr).split("\n").find((l) => /! derleme parçası/.test(l)).trim()}`);
    return j;
  } finally { cleanBusy = false; }
}
setInterval(() => {
  const n = new Date();
  if (n.getMinutes() >= 10 && readJson(CLEAN_FILE, {}).hour !== `${today()} ${n.getHours()}` && !pipelineBusy() && !pubN && !schedBusy && settings().cleanup?.enabled !== false)
    runCleanup().catch((e) => push(`🧹 disk temizliği: ${e.message}`));
}, 60000);
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
// beyin bağlamına video kuyruğu ve yayın onayı bekleyenler kendi numaralarıyla (Claude da "kuyruk iptal 7"yi aynı numarayla verir; 4. tur)
const brain = makeBrain({ ROOT, OUT, DATA, listVideos, getSchedule, getState: () => state, pythonBin: PY,
  extraContext: () => { const o = {}; try { o.videoKuyrugu = vq.brief(); } catch { /* yok */ } try { o.yayinOnayi = (wa.status().pendingList || []).map((p) => ({ no: p.id, video: p.title || p.label || p.video, ulasti: p.delivered })); } catch { /* yok */ } return o; } });
const SAFE = new Set(["command", "generate", "schedule", "note", "sync_metrics", "open_video", "settings", "improvement", "restart", "open_youtube", "open_url", "tunnel", "natural_voice", "whatsapp_send", "connect", "automode", "selftest", "breaking_news"]);
const needsConfirm = (a) => !settings().fullAuthority && !SAFE.has(a.type);
// elle yayın sürerken (WhatsApp "onay", panel) güncelleme paneli yeniden başlatmasın: süren yayın sayılır
// yayınlanan video data/publishing.json'da (cleanup.py protected() okur): yükleme sürerken saatlik disk temizliği mp4'ü ve kapağı silmesin
const PUBLISHING = path.join(DATA, "publishing.json");
const publishingMark = (video, on) => { try { const l = (readJson(PUBLISHING, []) || []).filter((x) => x?.video !== video && Date.now() - (x?.at || 0) < 3 * 3600000); writeJson(PUBLISHING, on ? [...l, { video, at: Date.now() }] : l); } catch { /* yazılamadı */ } };
async function execAction(a) {
  if (a?.type !== "publish") return execAction0(a);
  pubN++; if (a.video) publishingMark(a.video, true);
  try { return await execAction0(a); } finally { pubN--; if (a.video) publishingMark(a.video, false); }
}
async function execAction0(a) {
  switch (a.type) {
    case "generate": return startPipeline(a.duration);
    case "breaking_news": return prepareAnlik(a.topic, a.duration);
    case "schedule": return setSchedule(!!a.enabled, Number(a.hours) || 5);
    case "note": brain.addNote(a.text); return { ok: true };
    case "sync_metrics": { push("📊 izlenmeler çekiliyor"); const r = await py("sync_metrics.py"); await py("analyze.py"); viralCheck().catch((e) => push(`🔥 viral kontrolü: ${e.message}`)); retitleCheck().catch(() => {}).then(() => firstCommentCheck()).catch(() => {}); push(`📊 ${r.ok ? `güncellendi: YT ${r.json?.youtube ?? 0}, IG ${r.json?.instagram ?? 0}, TT ${r.json?.tiktok ?? 0}` : "hata"}`); return { ok: r.ok, ...(r.json || {}) }; }
    case "autopublish": patchSettings({ autopublish: { youtube: !!a.youtube, instagram: !!a.instagram, tiktok: !!a.tiktok } }); return { ok: true };
    case "settings": patchSettings(a.patch || {}); return { ok: true, settings: settings() };
    case "improvement": { const r = queueImprovement(a.task); push(`🛠 geliştirme kuyruğuna eklendi: ${a.task}`); return r; }
    case "restart": restartPanel(800); return { ok: true, restarting: true };
    case "publish": { if (a.via !== "panel" && a.via !== "approval") { const why = queueGate(a.video); if (why) { push(`📤 yayın yapılmadı (${path.basename(String(a.video || ""))}): ${why}`); return { ok: false, blocked: true, error: why, results: {} }; } } const results = {}; for (const p of a.platforms || []) { push(`📤 ${p}: yükleniyor ${a.video}`); const r = await py("publish.py", ["--file", path.basename(a.video), "--platform", p]); for (const l of String(r.stderr || "").split("\n")) if (/^🌐|^  (video|geçici|!|▶|♪|💬)/.test(l)) push(l.trim()); results[p] = r.json || { ok: false, error: (r.stderr || r.stdout).slice(-300) }; push(`📤 ${p}: ${results[p].ok ? (results[p].skipped ? "zaten yayında" : "tamam " + (results[p].url || results[p].note || "")) : (results[p].limit ? "sınır doldu — " : "hata ") + results[p].error}`); } await py("analyze.py"); try { wa.clearPending(path.basename(a.video)); } catch { /* yok */ } return { ok: Object.values(results).every((x) => x.ok), results }; }
    case "command": { const r = await handleCommand(String(a.text || ""), { source: "brain", direct: true }); return { ok: !/tanımadım/.test(r.reply || ""), reply: r.reply, report: r.report }; }
    case "open_video": return { ok: true };
    case "open_youtube": return openYouTube(String(a.query || ""));
    case "tunnel": return a.enabled === false ? stopTunnel() : startTunnel();
    case "natural_voice": if (a.enabled === false) stopTts(); return { ok: true, note: "Doğal ses (Chatterbox) artık sürekli açık tutulmuyor; yalnızca bu ses seçiliyse üretimde ya da ön dinlemede açılıyor ve iş bitince kapanıyor." };
    case "automode": return setAutoMode(a.enabled !== false);
    case "selftest": return selfTest();
    case "connect": { const plat = ["instagram", "youtube", "tiktok"].includes(a.platform) ? a.platform : "instagram"; const r = await fetch(`http://127.0.0.1:${PORT}/api/connect/${plat}`, { method: "POST" }); return r.json(); }
    case "whatsapp_send": return wa.notifyVideo(a.video || listVideos()[0]?.name, { ask: true, force: true }); // sahip istedi: kendi ürettiği video da gider
    case "open_url": { const url = toUrl(String(a.target || a.url || "")); const o = await openInBrowser(url); return { ok: o.ok, url }; }
    default: return { ok: false, error: "bilinmeyen eylem" };
  }
}
async function think(text, mode = "chat", opts = {}) {
  push(`🧠 ${mode === "chat" ? "düşünüyor" : mode === "report" ? "rapor hazırlıyor" : "plan yapıyor"}: ${String(text).slice(0, 80)}`);
  const t0 = Date.now();
  const r = await brain.ask(text, mode, opts);
  push(`🧠 yanıt ${Math.round((Date.now() - t0) / 1000)} sn${r.actions.length ? `, ${r.actions.length} eylem` : ""}${r.error ? " (hata)" : ""}`);
  const done = [], pending = [];
  // beynin (Claude çıktısının) eylemi "via" taşıyamaz (6. tur: Claude'un yazdığı via: "panel"/"approval" kuyruk videosunun yayın kapısını atlıyordu)
  for (const a0 of r.actions) { const a = { ...a0, via: undefined }; if (needsConfirm(a)) { pending.push(a); push(`⏸ onay bekliyor: ${a.type}`); } else { const res = await execAction(a); push(`⚡ ${a.type}${a.duration ? " " + a.duration + " sn" : ""}${a.platforms ? " → " + a.platforms.join(",") : ""}: ${res?.ok === false ? "hata " + (res.error || "") : "tamam"}`); done.push({ ...a, result: res }); } }
  const reportFile = brain.saveReport(mode === "chat" ? "not" : mode, r.report);
  if (!r.error) brain.addExchange(text, r.reply, [...done, ...pending]);
  return { ...r, done, pending, reportFile };
}

// ---------- WhatsApp köprüsü
const videoInfo = (name) => { const v = name ? listVideos().find((x) => x.name === name) : listVideos()[0]; if (!v) return null; const meta = readJson(path.join(OUT, v.name.replace(/\.mp4$/, ".json")), { segments: [] }); return { ...v, label: label(v), path: path.join(OUT, v.name), segments: meta.segments || [], anlik: !!meta.anlik || meta.format === "anlik", format: meta.format || null, value: meta.value || null, userVideo: !!meta.userVideo, trailer: !!meta.trailer, publishAt: meta.publishAt || null, published: { youtube: !!v.youtube, instagram: !!v.instagram, tiktok: !!v.tiktok },
  recreated: !!meta.recreated, jobDir: meta.jobDir || null, revision: Number(meta.revision) || 0, revisionOf: meta.revisionOf || null, // ✏️ düzelt
  kare: !!meta.kare,
  queueNo: (() => { const n = queueNoOf(v.name); return n > 0 ? n : 0; })(), queueSource: meta.queue?.source || (() => { try { return vq.sourceOf(v.name); } catch { return null; } })() }; };
// kare (1:1) uzun video yalnız YouTube'a gider (post_pipeline.targets aynı kural): WhatsApp onayı da yalnız YouTube'u sorar
const waLinks = async (name) => { const conn = await brain.connections(); const kare = !!readJson(path.join(OUT, String(name).replace(/\.mp4$/, "") + ".json"), null)?.kare; const platforms = ["youtube", "instagram", "tiktok"].filter((p) => conn[p]?.connected && (!kare || p === "youtube")); const base = encodeURIComponent(name.replace(/\.mp4$/, "")); return { lan: `http://${lanIp()}:${PORT}/w/${base}`, tunnel: tunnel.url ? `${tunnel.url}/w/${base}` : null, platforms, thumb: await thumbBuffer(name) }; };
const statusText = async () => {
  const sch = await getSchedule(); const conn = await brain.connections(); const accs = ["youtube", "instagram", "tiktok"].filter((p) => conn[p]?.connected);
  const vids = listVideos(); const ap = settings().autopublish || {};
  const lines = [state.running ? `🎬 Üretim sürüyor (${Math.round((Date.now() - state.startedAt) / 1000)} sn)` : `Şu an üretim yok. Toplam ${vids.length} video.`];
  if (sch.enabled && sch.nextRunAt) { const ms = sch.nextRunAt - Date.now(); const d = new Date(sch.nextRunAt); lines.push(`⏭ Sıradaki: günün ${sch.nextEpisode}. videosu · ${d.toLocaleString("tr-TR", { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" })} · ${Math.max(0, Math.floor(ms / 3.6e6))} sa ${Math.max(0, Math.floor((ms % 3.6e6) / 6e4))} dk kaldı`); } else lines.push("⏸ Otomatik üretim kapalı.");
  lines.push(`📣 Bağlı: ${accs.join(", ") || "hesap yok"} · otomatik yayın: ${Object.keys(ap).filter((k) => ap[k]).join(", ") || "kapalı"} · onay ${settings().whatsapp?.requireApproval === false ? "kapalı" : "açık"}`);
  if (vids[0]) lines.push(`🎞 Son video: ${label(vids[0])}${vids[0].views ? " · ▶ " + vids[0].views : ""}`);
  return lines.join("\n");
};
const wa = await makeWhatsApp({ handleVideo: (v) => waVideoIn(v), videoInstruction: (t) => waVideoText(t),
  // talimat bekleyen WhatsApp videosu var mı ("30 saniye, 18:30'da paylaş" talimatı numaralı söz korumasına girmesin; 7. tur)
  videoWaiting: () => [waVid, ...waAsks].some((v) => v?.files?.length && !v.instruction && !v.running && Date.now() - v.at < Number(waVideoCfg().waitMin) * 60000), autoAll: () => existsSync(PLIST) || !!settings().autoMode, ROOT, settings, push, announce, handleCommand, videoInfo, links: waLinks, publishVideo: (video, platforms) => execAction({ type: "publish", video, platforms, via: "approval" }), automode: (on) => setAutoMode(on), statusText,
  // video kuyruğu (5. tur): kuyruk komutu onay sayılmaz, onay numarası kuyruk numarasıdır, numaralı söz kuyruk işini gösteriyorsa durumu/iptali
  queue: { cmd: (t) => !!queueCommand(t), number: (video, used, metaNo) => vq.numberFor(video, used, metaNo), state: (n) => vq.stateOf(n), cancel: (nos) => vq.cancelNos(nos), guard: (why) => vq.guardText(why || "") } });
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
app.post("/api/whatsapp/send-latest", async (req, res) => { const v = listVideos()[0]; if (!v) return res.json({ ok: false, error: "video yok" }); res.json(await wa.notifyVideo(req.body?.name || v.name, { ask: true, force: true })); }); // panel düğmesi: kendi ürettiği video da gider
if (settings().whatsapp?.enabled && settings().whatsapp?.autoStart) setTimeout(() => wa.start().catch((e) => push(`✖ WhatsApp: ${e.message}`)), 2500);

// Yeni video (panelden veya launchd'den) → WhatsApp bildirimi. out/ klasörü izlenir, bilinen dosyalar atlanır.
const knownVideos = new Set(readdirSync(OUT).filter((f) => f.endsWith(".mp4")));
try { watch(OUT, (ev, file) => { if (!file || !file.endsWith(".json")) return; const mp4 = file.replace(/\.json$/, ".mp4"); if (!knownVideos.has(mp4)) vqProduced(mp4); setTimeout(async () => { if (knownVideos.has(mp4) || !existsSync(path.join(OUT, mp4))) return; knownVideos.add(mp4); if (vqCancelledVideos.has(mp4)) { push(`⏹ ${mp4}: video kuyruğundan iptal edilen işin videosu; WhatsApp'a bildirilmedi`); return; } if (settings().whatsapp?.enabled && settings().whatsapp?.notifyOnVideo) {
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
app.get("/api/videos", (req, res) => res.json(listVideos({ archived: req.query.archived === "1" })));
app.get("/api/thumb/:name", async (req, res) => { const name = path.basename(req.params.name); if (!existsSync(path.join(OUT, name))) return res.status(404).end(); const dst = await makeThumb(name, 480); if (!existsSync(dst)) return res.status(404).end(); res.sendFile(dst); });
// Sil: önce yüklendiği platformlardan (publish.py --delete-remote), sonra Mac'teki dosyalar. ?local=1 yalnız yerel siler.
// Video silme (panel 🗑, yükleme sırası kartı 🗑, WhatsApp "sıradan sil N"): platformlardaki kopyalar (local değilse), Mac'teki dosyalar ve
// yükleme sırasındaki kayıtları (kullanıcı isteği, 26 Ekim: değeri geçmiş haber silinince sırada kalmasın)
async function deleteVideo(name, { local = false } = {}) {
  let remote = {};
  if (!local) {
    const m = readJson(path.join(DATA, "metrics.json"), { videos: {} }).videos?.[name] || {};
    if (m.youtube?.id || m.instagram?.id || m.tiktok?.publish_id || m.tiktok?.id) {
      push(`🗑 ${name}: platformlardan siliniyor`);
      const r = await py("publish.py", ["--delete-remote", name]);
      remote = r.json?.results || {};
      for (const [p, v] of Object.entries(remote)) push(`🗑 ${p}: ${v.message}${!v.ok && v.url ? ` → ${v.url}` : ""}`);
      if (!r.json) push(`🗑 platformlardan silme hatası: ${(r.stderr || r.stdout || "").slice(-200)}`);
    }
  }
  // diskten zaten silinmiş (arşivlenmiş) videoda bir platformdan silinemediyse kayıt kalır: panelde yine görünsün, yeniden denenebilsin
  const keepMeta = !existsSync(path.join(OUT, name)) && Object.values(remote).some((v) => !v.ok);
  for (const f of [name, ...(keepMeta ? [] : [name.replace(/\.mp4$/, ".json")]), ...["-kapak.jpg", "-kapakA.jpg", "-kapakB.jpg", "-kapakYT.jpg"].map((x) => name.replace(/\.mp4$/, x))]) { const p = path.join(OUT, f); if (existsSync(p)) unlinkSync(p); } const t = path.join(THUMBS, name.replace(/\.mp4$/, ".jpg")); if (existsSync(t)) unlinkSync(t);
  const uq = await py("publish.py", ["--unqueue", "--file", name]).catch(() => null), unqueued = uq?.json?.platforms || [];
  if (unqueued.length) push(`📤 ${name}: yükleme sırasından çıkarıldı (${unqueued.map((p) => PLAT_TR[p] || p).join(", ")})`);
  push(`🗑 ${name}: Mac'ten silindi`); py("analyze.py").catch(() => {}); return { ok: true, remote, unqueued };
}
app.delete("/api/videos/:name", async (req, res) => res.json(await deleteVideo(path.basename(req.params.name), { local: req.query.local === "1" })));
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
// muted (başlıktaki 🔊/🔇 düğmesi) yalnız true/false saklanır; değişince açık sekmelere SSE "mute" (muteChanged)
app.post("/api/settings", (req, res) => {
  const body = req.body || {}, was = settings().muted === true;
  if ("muted" in body) body.muted = body.muted === true;
  const s = patchSettings(body);
  if ("muted" in body && s.muted !== was) muteChanged(s.muted);
  res.json(s);
});
app.get("/api/improvements", (_req, res) => res.type("text/markdown").send(existsSync(IMPROVEMENTS) ? readFileSync(IMPROVEMENTS, "utf8") : ""));
app.post("/api/restart", (_req, res) => { res.json({ ok: true }); push("↻ panel yeniden başlatılıyor"); restartPanel(500); });
// Panel yeniden başlatma: panel.sh döngüsünde (npm run panel, launchd servisi, basla.sh) 75 ile çıkmak yeniden açar (üst süreç panel.sh:
// panel.sh EMIXHAS_LOOP=$$ verir, eski panel.sh için ps). Elle "node app/server.js" ile açılmışsa — ya da terminal kapanıp süreç
// launchd'ye (pid 1) sahipsiz kaldıysa — döngü yok: önce panel.sh ayrık başlatılır (2 sn sonra, port boşalınca; log work/panel.log),
// sonra çıkılır; yoksa panel kapanır ve WhatsApp'tan geri açılamazdı. Projenin hiçbir başlatıcısı node'u launchd altında doğrudan çalıştırmaz.
const underLoop = () => {
  if (process.env.EMIXHAS_LOOP && process.env.EMIXHAS_LOOP === String(process.ppid)) return true;
  try { return /panel\.sh/.test(spawnSync("ps", ["-o", "command=", "-p", String(process.ppid)], { encoding: "utf8" }).stdout || ""); } catch { return false; }
};
function restartPanel(delay = 800) {
  setTimeout(() => {
    if (underLoop()) process.exit(75);
    try {
      const log = openSync(path.join(WORK, "panel.log"), "a");
      spawn("/bin/bash", ["-c", "sleep 2; exec bash scripts/panel.sh"], { cwd: ROOT, env: process.env, detached: true, stdio: ["ignore", log, log] }).unref();
      console.log("↻ panel döngü dışında açılmıştı; yeni panel arka planda başlatıldı (log: work/panel.log)");
      process.exit(0);
    } catch (e) { push(`✖ panel yeniden başlatılamadı: ${e.message}`); }
  }, delay);
}
// Kendini güncelleme (kullanıcı isteği, 19 Ekim: "WhatsApp'tan güncelle yazayım, panel kendini yeniden güncellesin, güncelle butonuna
// basmışım gibi"): panel düğmesi (POST /api/update), komut "güncelle" (WhatsApp hızlı yolu, panel sohbeti, beynin command eylemi) aynı yol:
// git pull --ff-only → package*.json değiştiyse npm install → app/*.js sözdizimi denetimi → yeniden başlatma. Yarım kalacak iş sürerken
// (üretim, sıradaki video, indirilen paylaşım, yayın…) çekmez: yeni sürüm varsa iş bitince kendiliğinden günceller (en çok 3 saat bekler).
// Yeniden açılınca data/update_last.json okunur, sonuç loga ve (panel düğmesi dışında) WhatsApp'a yazılır.
const GIT_ENV = { ...ENV, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" }; // parola istemi beklemesin; hata metni İngilizce (çeviri için)
const git = (args, timeout = 120000) => run("git", args, { env: GIT_ENV, timeout });
const headCommit = () => spawnSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).stdout?.trim() || "";
const BOOT_COMMIT = headCommit(); // çalışan kodun sürümü; terminalden git pull yapıldıysa HEAD bundan ileride olur
const UPDATE_FILE = path.join(DATA, "update_last.json");
let updateRun = false, updatePending = null, restartPending = null; // bekleyen güncelleme / yeniden başlatma {at, source}
let videoNewsN = 0, pubN = 0; // süren video haberi kurgusu ve elle yayın
// Türkçe neden: git'in İngilizce hata metninden
function gitHint(r) {
  const o = `${r.stderr || ""}\n${r.stdout || ""}`;
  const files = (re) => { const m = o.match(re); return m ? m[1].split("\n").map((x) => x.trim()).filter(Boolean).slice(0, 4).join(", ") : ""; };
  if (/untracked working tree files would be (overwritten|removed)/.test(o)) { const f = files(/would be (?:overwritten|removed) by merge:\n([\s\S]*?)\n(?:Please|Aborting)/); return `Mac'te güncellemeyle gelen dosyalarla aynı adda dosyalar var${f ? ` (${f})` : ""}; taşıyın ya da silin, sonra yeniden güncelleyin.`; }
  if (/would be overwritten by merge|Please commit your changes or stash them/.test(o)) { const f = files(/overwritten by merge:\n([\s\S]*?)\n(?:Please|Aborting)/); return `Mac'te elle değiştirilmiş dosya var${f ? ` (${f})` : ""}; güncelleme bunların üstüne yazamaz. Terminalde: git stash, sonra yeniden güncelle.`; }
  if (/Not possible to fast-forward|diverg|non-fast-forward/i.test(o)) return "Mac'teki kod ile GitHub'daki kod ayrışmış (Mac'te ayrı değişiklik yapılmış); kendiliğinden birleştirilmez, terminalde bakılmalı.";
  if (/no tracking information|no upstream configured|does not point to a branch|HEAD detached|not currently on a branch/i.test(o)) return "Mac'teki kod bir GitHub dalını izlemiyor; terminalde bir kez: git branch --set-upstream-to=origin/<dal>.";
  // giriş hatası önce: SSH'de "Permission denied (publickey)" ardından git her aktarım hatasına "Could not read from remote" ekler
  if (/Authentication failed|could not read Username|could not read Password|Permission denied|Host key verification failed|terminal prompts disabled|Repository not found|passphrase/i.test(o)) return "GitHub girişi reddedildi (Mac'te git oturumu ya da SSH anahtarı; panel arka planda çalışırken parola soramaz).";
  if (/Could not resolve host|unable to access|Failed to connect|Connection timed out|Operation timed out|Network is unreachable|Connection refused|Connection reset/i.test(o)) return "GitHub'a ulaşılamadı (internet bağlantısı?).";
  if (/Could not read from remote/i.test(o)) return "GitHub'a ulaşılamadı ya da giriş reddedildi (internet bağlantısı ya da Mac'teki git oturumu).";
  if (r.err?.killed || r.err?.signal) return "git 2 dakikada yanıt vermedi (internet yavaş?).";
  if (/not a git repository/i.test(o)) return "Proje klasörü bir git deposu değil; panelden güncellenemez.";
  return o.trim().split("\n").filter(Boolean).slice(-2).join(" ").slice(0, 200) || "git hatası";
}
// yeniden başlatma yarım bırakacak iş varsa nedeni (yoksa "")
function updateBusy() {
  if (pipelineBusy()) return "üretim sürüyor";
  if (anlikQueue.length) return `${anlikQueue.length} video sırada`;
  if (anlikInflight.size || valueBatch.length || dequeueBusy) return "son dakika haberi hazırlanıyor";
  if (socialBusy || videoNewsN || vq.pending()) return "video haberi hazırlanıyor";
  if ([waVid, ...waAsks].some((v) => v?.files?.length && !v.running && Date.now() - v.at < Number(waVideoCfg().waitMin) * 60000)) return "gönderdiğiniz video talimat bekliyor";
  if (digestPending) return "video WhatsApp'a gönderiliyor";
  if (infoBusy || peakBusy) return "otomatik içerik hazırlanıyor";
  if (pubN || schedBusy || storiesBusy || igAutoBusy || replyBusy) return "yayın işlemi sürüyor";
  if (watchScanning || sondakikaBusy) return "haber taraması sürüyor";
  if (reqN || flushQ) return "bir istek işleniyor";
  if (wa.busy?.()) return "WhatsApp'a video gönderiliyor";
  if ((wa.status?.().outbox || 0) > 0) return "WhatsApp mesajları gönderilmeyi bekliyor";
  if (igCleanupPending && Date.now() - Number(igCleanupPending.at || 0) < 15 * 60000) return "Instagram silme onayı bekliyor";
  return "";
}
// bekleyen (henüz çekilmemiş) güncelleme diske yazılır: beklerken panel yeniden başlarsa söz verilen güncelleme kaybolmasın (3 saat)
const UPDATE_PENDING = path.join(DATA, "update_pending.json");
const setUpdatePending = (v) => { updatePending = v; try { if (v) writeJson(UPDATE_PENDING, v); else rmSync(UPDATE_PENDING, { force: true }); } catch { /* yazılamadı */ } };
{ const u = readJson(UPDATE_PENDING, null); if (u && Date.now() - Number(u.at || 0) < 3 * 3600000) updatePending = { at: Number(u.at), source: u.source || "panel" }; else if (u) setUpdatePending(null); }
// güncellemeden sonra yeniden başlatma: zamanlayıcı dolunca iş yeniden denetlenir (bu arada başlayan üretim/istek yarıda kalmasın)
let restartAt = 0;
function restartAfterUpdate(delay, source) {
  restartAt = Date.now() + delay;
  setTimeout(() => {
    const b = updateBusy();
    if (b) { restartAt = 0; restartPending = { at: Date.now(), source }; push(`↻ ${b}; güncellenen panel iş bitince yeniden başlatılacak`); return; }
    restartPanel(0);
  }, delay);
}
const commitsSince = async (from, to) => { if (!from || !to || from === to) return []; const r = await git(["log", "--no-merges", "--format=%s", `${from}..${to}`]); return r.ok ? String(r.stdout).split("\n").filter(Boolean) : []; };
const subjectOf = (c) => spawnSync("git", ["log", "-1", "--format=%s", c || "HEAD"], { cwd: ROOT, encoding: "utf8" }).stdout?.trim() || "";
// "güncelleme var mı": yalnız bakar (fetch), çekmez
async function updateCheck() {
  const f = await git(["fetch", "--quiet"]);
  if (!f.ok) return { ok: false, error: gitHint(f) };
  const c = await git(["rev-list", "--count", "HEAD..@{u}"]);
  if (!c.ok) return { ok: false, error: gitHint(c) };
  const n = Number(String(c.stdout).trim()) || 0, stale = headCommit() !== BOOT_COMMIT;
  const subjects = n ? await commitsSince("HEAD", "@{u}") : stale ? await commitsSince(BOOT_COMMIT, "HEAD") : [];
  return { ok: true, count: n, stale, subjects, current: subjectOf(BOOT_COMMIT) };
}
// app/*.js'te adı geçen paketlerden çözülemeyenler (node_modules'ta yok): ayrı süreçte import.meta.resolve, kod çalıştırılmaz
const RESOLVE_JS = `import { readdirSync, readFileSync } from "node:fs";
const bad = new Set();
for (const f of readdirSync("app").filter((x) => x.endsWith(".js"))) {
  for (const m of readFileSync("app/" + f, "utf8").matchAll(/(?:\\bfrom\\s*|\\bimport\\s*\\(\\s*|\\bimport\\s+)["']([^"'./][^"']*)["']/g)) {
    if (m[1].startsWith("node:")) continue;
    try { import.meta.resolve(m[1]); } catch { bad.add(m[1]); }
  }
}
console.log(JSON.stringify([...bad]));`;
// package.json'da tam sürümle sabitlenen paket kurulu sürümden farklı mı (eski güncelleme kodu npm install'ı atladıysa ya da terminalde
// yalnız git pull yapıldıysa Baileys 6.7 kalır, telefonda "Mesaj bekleniyor" sürer; inceleme, 19 Ekim)
const PINNED = ["@whiskeysockets/baileys"];
function pinMismatch() {
  const want = readJson(path.join(ROOT, "package.json"), {}).dependencies || {};
  return PINNED.map((p) => ({ p, want: want[p], have: readJson(path.join(ROOT, "node_modules", ...p.split("/"), "package.json"), {}).version || null }))
    .filter((x) => /^\d+\.\d+\.\d+/.test(String(x.want || "")) && x.have !== x.want);
}
function missingModules() {
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", RESOLVE_JS], { cwd: ROOT, encoding: "utf8", timeout: 30000 });
  try { return JSON.parse(String(r.stdout || "").trim().split("\n").pop() || "[]"); } catch { return []; } // denetim çalışmazsa engellemez
}
async function selfUpdate({ source = "panel" } = {}) {
  if (updateRun) return { ok: false, error: "Güncelleme zaten sürüyor." };
  if (restartAt && Date.now() < restartAt + 5000) return { ok: true, restarting: true, again: true }; // yeniden başlatma zaten sırada
  if (restartPending) return { ok: true, waitRestart: true, busy: updateBusy() || "iş bitiyor" };
  updateRun = true;
  try {
    const busy = updateBusy();
    if (busy) { // önce yeni sürüm var mı bak; varsa iş bitince güncelle (çekilen yeni kod süren üretimle karışmasın)
      const c = await updateCheck();
      if (!c.ok) return c;
      if (!c.count && !c.stale) return { ok: true, upToDate: true, current: c.current };
      if (!updatePending) push(`⬇ güncelleme: yeni sürüm var (${c.count || c.subjects.length} değişiklik) ama ${busy}; iş bitince alınacak`);
      setUpdatePending({ at: updatePending?.at || Date.now(), source });
      return { ok: true, deferred: true, busy, count: c.count || c.subjects.length, subjects: c.subjects };
    }
    setUpdatePending(null);
    // package-lock.json üretilen dosyadır: npm 11 kurulumda yeniden yazar, yerelde değişmiş kilit "git pull"u durdurur (inceleme, 19 Ekim;
    // kilidi değişen ilk güncelleme). Yalnız bu dosyadaki yerel değişiklik bırakılır, node_modules etkilenmez
    if (!(await git(["diff", "--quiet", "--", "package-lock.json"])).ok) { push("⬇ package-lock.json yerelde değişmiş (npm yeniden yazmış); güncelleme için eski hâline döndürülüyor"); await git(["checkout", "--", "package-lock.json"]); }
    push("⬇ güncelleme: git pull");
    const r = await git(["pull", "--ff-only"]);
    const out = `${r.stdout || ""}${r.stderr ? "\n" + r.stderr : ""}`.trim();
    for (const line of out.split("\n").filter(Boolean).slice(-8)) push("  " + line);
    if (!r.ok) { const error = gitHint(r); push(`✖ güncelleme alınamadı: ${error}`); return { ok: false, error }; }
    const head = headCommit();
    if (!head || head === BOOT_COMMIT) return { ok: true, upToDate: true, current: subjectOf(BOOT_COMMIT), summary: out.split("\n").pop() };
    const subjects = await commitsSince(BOOT_COMMIT, head);
    // değişen dosyalar proje klasörüne göre (--relative): Mac'te git deposunun kökü proje klasörünün bir üstü (whatsapp-server/), yollar
    // "gundem-video/package.json" geliyordu ve npm install hiç çalışmıyordu (inceleme, 19 Ekim); kökteki başka projenin package.json'u sayılmaz
    const dr = BOOT_COMMIT ? await git(["diff", "--relative", "--name-only", BOOT_COMMIT, head]) : { ok: false };
    const changed = dr.ok ? String(dr.stdout || "").split("\n").filter(Boolean) : [];
    const notes = [];
    // yeni sürüm kullanılamıyorsa dosyalar çalışan sürüme geri döner (diskteki kod çalışan kodla aynı kalsın: panel çökerse ya da Mac
    // yeniden açılırsa bozuk sürümle açılmasın); --keep yerel değişikliği silmez, çakışırsa geri almaz
    const rollback = async (why) => { const k = BOOT_COMMIT ? await git(["reset", "--keep", BOOT_COMMIT]) : { ok: false }; const error = `${why} ${k.ok ? "Değişiklik geri alındı; panel eski sürümle çalışmaya devam ediyor." : "Panel yeniden başlatılmadı (eski sürüm çalışıyor) ama yeni dosyalar diskte; panel kapanırsa açılamayabilir, terminalde bakılmalı."}`; push(`✖ güncelleme: ${error}`); return { ok: false, error }; };
    let installed = false;
    const npmInstall = async () => {
      installed = true;
      push("⬇ bağımlılıklar güncelleniyor (npm install)");
      const n = await run("npm", ["install", "--no-save", "--no-audit", "--no-fund"], { timeout: 10 * 60000 }); // --no-save: kilit yeniden yazılmasın
      return n.ok ? "" : String(n.stderr || n.err?.message || "").trim().split("\n").filter(Boolean).slice(-2).join(" ").slice(0, 200);
    };
    if (changed.some((f) => /^package(-lock)?\.json$/.test(f)) || (!dr.ok && /(^|\s)package(-lock)?\.json\s*\|/m.test(out))) {
      const e = await npmInstall();
      if (e) return rollback(`npm install başarısız (${e}).`);
    }
    if (changed.includes("requirements.txt")) notes.push("Python paketleri değişti (requirements.txt); gerekirse Mac'te bir kez: pip install -r requirements.txt");
    // yeni kodda sözdizimi hatası varsa yeniden başlatma: panel açılamaz, WhatsApp'tan da geri getirilemezdi
    for (const f of readdirSync(path.join(ROOT, "app")).filter((x) => x.endsWith(".js"))) {
      const c = spawnSync(process.execPath, ["--check", path.join("app", f)], { cwd: ROOT, encoding: "utf8", timeout: 30000 });
      if (c.status !== 0) return rollback(`Yeni sürümde hata var (app/${f}: ${String(c.stderr || "").split("\n").find((l) => /Error/.test(l)) || "sözdizimi"}).`);
    }
    // --check eksik paketi yakalamaz (yeni bağımlılık: panel ERR_MODULE_NOT_FOUND ile açılmazdı): app/*.js'teki paket adları çözülür;
    // eksik varsa npm install (henüz yapılmadıysa) ve bir kez daha; yine eksikse geri alınır
    let missing = missingModules();
    if ((missing.length || pinMismatch().length) && !installed) { const e = await npmInstall(); if (e) return rollback(`npm install başarısız (${e}).`); missing = missingModules(); }
    if (missing.length) return rollback(`Yeni sürümün ihtiyaç duyduğu paketler kurulamadı (${missing.slice(0, 3).join(", ")}).`);
    writeJson(UPDATE_FILE, { at: Date.now(), from: BOOT_COMMIT, to: head, count: subjects.length, subjects: subjects.slice(0, 5), source, notes, notified: false });
    for (const n of notes) push(`⬇ not: ${n}`);
    const again = updateBusy(); // çekilirken üretim başladıysa yeniden başlatma iş bitince
    if (again) { restartPending = { at: Date.now(), source }; push(`↻ güncelleme alındı (${subjects.length} değişiklik); ${again}, bitince panel yeniden başlatılacak`); return { ok: true, waitRestart: true, busy: again, count: subjects.length, subjects, notes }; }
    push(`↻ güncelleme alındı (${subjects.length} değişiklik), panel yeniden başlatılıyor`);
    restartAfterUpdate(source === "panel" ? 800 : 6000, source); // WhatsApp yanıtı gidebilsin; o arada iş başlarsa beklenir
    return { ok: true, restarting: true, count: subjects.length, subjects, notes, summary: out.split("\n").pop() };
  } finally { updateRun = false; }
}
app.post("/api/update", async (_req, res) => res.json(await selfUpdate({ source: "panel" })));
// açılışta sabit sürümlü paket kurulu sürümle uyuşmuyorsa (terminalde yalnız git pull, eski güncelleme kodu npm install'ı atladı) npm install
// kendiliğinden bir kez denenir, olursa panel iş yokken yeniden başlar (WhatsApp yeni kütüphaneyle açılsın); 6 saatte en çok bir deneme
const PIN_FILE = path.join(DATA, "pin_install.json");
setTimeout(async () => {
  const m = pinMismatch();
  if (!m.length) return;
  const what = m.map((x) => `${x.p} kurulu ${x.have || "yok"}, gereken ${x.want}`).join("; ");
  if (Date.now() - (readJson(PIN_FILE, {}).at || 0) < 6 * 3600000) { push(`⚠️ paket sürümü uyuşmuyor (${what}); terminalde gundem-video klasöründe: npm install`); return; }
  writeJson(PIN_FILE, { at: Date.now(), what });
  push(`⬇ ${what}: npm install çalıştırılıyor (WhatsApp mesajları telefonda "Mesaj bekleniyor" kalmasın)`);
  const n = await run("npm", ["install", "--no-save", "--no-audit", "--no-fund"], { timeout: 10 * 60000 });
  if (!n.ok || pinMismatch().length) { push(`✖ npm install olmadı (${String(n.stderr || n.err?.message || "").trim().split("\n").slice(-2).join(" ").slice(0, 200)}); terminalde gundem-video klasöründe: npm install`); return; }
  push("✅ paketler kuruldu; panel iş yokken yeniden başlatılıyor");
  restartAfterUpdate(3000, "paket");
}, 20000);
const updateText = (r) => {
  const last = (r.subjects || [])[0] ? `: ${String(r.subjects[0]).slice(0, 110)}` : "";
  if (!r.ok) return `❌ Güncellenemedi: ${r.error}`;
  if (r.upToDate) return `✅ Zaten güncel${r.current ? ` (son sürüm: ${String(r.current).slice(0, 90)})` : ""}.`;
  // ipucu nedene göre: "sistemi durdur" yalnız üretim/sıra için (talimat bekleyen videoda bu yazı videonun talimatı sanılırdı)
  const vqn = vq.size(), hint = /üretim sürüyor|video sırada|son dakika haberi/.test(r.busy || "") ? ` Beklemeden almak için: *sistemi durdur*${vqn ? ` (video kuyruğundaki ${vqn} video da iptal edilir)` : ""}`
    : /talimat bekliyor/.test(r.busy || "") ? " Videonun talimatını yazın ya da *iptal* yazın; sonra güncellenir." : "";
  if (r.deferred) return `⏳ Yeni sürüm var (${r.count} değişiklik) ama şu an ${r.busy}; bitince güncelleyip panel yeniden başlayacak.${hint}`;
  if (r.restarting && r.again) return "↻ Güncelleme alındı, panel zaten yeniden başlıyor.";
  if (r.waitRestart) return `⬇ Güncelleme alındı${r.count ? ` (${r.count} değişiklik)` : ""}; ${r.busy}, bitince panel yeniden başlayacak.`;
  return `⬇ Güncelleme alındı (${r.count} değişiklik)${last}. Panel yeniden başlıyor; açılınca haber vereceğim.`;
};
// bekleyen güncelleme ve yeniden başlatma: iş bitince (15 sn'de bir bakılır); 3 saatten uzun beklerse vazgeçilir
setInterval(async () => {
  if (updateRun) return;
  const p = restartPending || updatePending;
  if (!p) return;
  const busy = updateBusy();
  if (busy && Date.now() - p.at > 3 * 3600000) {
    if (restartPending) { // yeni kod diskte: vazgeçilmez (eski kodla yeni dosyalar karışık kalmasın), iş bitince yeniden başlar; bir kez söylenir
      if (!restartPending.told) { restartPending.told = true; const t = `⚠️ Güncelleme indirildi ama 3 saattir yeniden başlatılamadı (${busy}); iş bitince panel yeniden başlayacak.`; push(t); if (p.source !== "panel") sendW(t); }
      return;
    }
    setUpdatePending(null);
    const t = `⚠️ Güncelleme 3 saattir bekliyordu (${busy}); yapılmadı. Tekrar *güncelle* yazın.`;
    push(t); if (p.source !== "panel") sendW(t);
    return;
  }
  if (busy) return;
  if (restartPending) { const src = restartPending.source; restartPending = null; push("↻ iş bitti, güncellenen panel yeniden başlatılıyor"); restartAfterUpdate(800, src); return; }
  const r = await selfUpdate({ source: p.source }).catch((e) => ({ ok: false, error: e.message }));
  if (!r.restarting && !r.deferred && !r.waitRestart && p.source !== "panel") sendW(updateText(r)); // yeniden başlarsa sonuç açılışta gider
}, 15000);
// açılış: güncellemeyle yeniden başladıysak sonucu bildir
setTimeout(() => {
  const u = readJson(UPDATE_FILE, null);
  if (!u || u.notified || Date.now() - Number(u.at || 0) > 3 * 3600000) return;
  writeJson(UPDATE_FILE, { ...u, notified: true });
  const ok = BOOT_COMMIT === u.to;
  const subj = (u.subjects || [])[0] ? `: ${String(u.subjects[0]).slice(0, 110)}` : "";
  const stopped = resting() && restInfo().reason === "elle durduruldu" ? "\n⏸ Sistem durdurulmuş durumda; başlatmak için: *sistemi başlat*" : "";
  const t = ok ? `✅ Güncellendi, panel yeni sürümle açıldı (${u.count} değişiklik)${subj}${(u.notes || []).length ? `\n${u.notes.join("\n")}` : ""}${stopped}`
    : `⚠️ Panel yeniden başladı ama beklenen sürüm yüklenmedi (beklenen ${String(u.to).slice(0, 7)}, çalışan ${BOOT_COMMIT.slice(0, 7) || "?"}); tekrar *güncelle* yazın.`;
  push(t.split("\n")[0]);
  if (u.source !== "panel" && settings().whatsapp?.enabled) sendW(t); // bağlantı henüz kurulmadıysa kuyruğa girer, bağlanınca gider
}, 8000);

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
app.post("/api/publish", async (req, res) => res.json(await execAction({ type: "publish", video: req.body.name, platforms: req.body.platforms || [], via: "panel" })));
app.post("/api/metrics/sync", async (_req, res) => res.json(await execAction({ type: "sync_metrics" })));
app.get("/api/insights", (_req, res) => res.json(readJson(path.join(DATA, "insights.json"), null)));
app.post("/api/analyze", async (_req, res) => { await py("analyze.py"); res.json(readJson(path.join(DATA, "insights.json"), null)); });
app.get("/api/reports", (_req, res) => res.json(readdirSync(path.join(DATA, "reports")).filter((f) => f.endsWith(".md")).sort().reverse()));
app.get("/api/reports/:name", (req, res) => { const p = path.join(DATA, "reports", path.basename(req.params.name)); existsSync(p) ? res.type("text/markdown").send(readFileSync(p, "utf8")) : res.status(404).end(); });
app.get("/api/memory", (_req, res) => res.json(brain.memory()));

// ---------- API: Jarvis (beyin) ve eylem onayı
app.post("/api/ask", async (req, res) => { state.busy = "düşünüyor"; try { res.json(await think(String(req.body?.text || ""), req.body?.mode || "chat")); } finally { state.busy = null; } });
// panelde onaylanan beyin/komut eylemi (karar 3): kuyruk videosunu yayınlamaz (yalnız video penceresinin yayınla düğmesi, /api/publish); diğer videolar HEAD gibi
app.post("/api/actions", async (req, res) => { const out = []; for (const a of req.body?.actions || []) out.push({ ...a, result: await execAction({ ...a, via: undefined }) }); res.json(out); });

// ---------- API: sesli komut → kural, kural yoksa beyin
// WhatsApp mesajını önce Claude anlar (kullanıcı isteği, 14 Ekim: "WhatsApp'tan gönderdiğim mesajları Claude alsın, ne demek istediğimi
// anlasın, yapsın"): beyin yanıtlar ve gerekirse kural komutlarını "command" eylemiyle çalıştırır. Link (haber/sosyal medya videosu),
// kısa kesin komutlar (yardım, durum, iptal, evet sil) ve Claude'a ulaşılamazsa eski kural yolu. `settings.whatsapp.smart: false` kapatır.
const WA_DIRECT = /^(yardım|komutlar|durum|status|iptal|vazgeç|hayır|evet sil|sil|dur|sus|tamam|teşekkürler|sağ ol)$/;
// beynin breaking_news ile video kuyruğuna verdiği link: yanıta iş numarası (iptalin tutamağı; 4. tur — Claude yanıtı eylemden önce yazar)
const brainQueueIds = (done) => (done || []).map((d) => (d.type === "breaking_news" && d.result?.ok && (d.result.no || d.result.batch) ? (d.result.batch ? "\n" + d.result.reply : vq.idLine(d.result))
  : d.type === "publish" && d.result?.blocked ? `\n⚠️ ${d.result.error}` : "")).join("");
async function smartWhatsApp(text) {
  const t = text.toLocaleLowerCase("tr-TR").replace(/[.!?]+$/, "").trim();
  // şemasız video linki de ("youtu.be/… 18:30'da paylaş") hızlı yol: Claude'dan geçince breaking_news yayın saatini kaybediyordu (inceleme, 18 Ekim)
  if (settings().whatsapp?.smart === false || !t || /https?:\/\/|www\./i.test(text) || findLink(text) || WA_DIRECT.test(t)) return null;
  if (["self_update", "update_check"].includes(parseCommand(text).action)) return null; // "güncelle": Claude'a gitmeden, butona basmış gibi
  push(`💬 WhatsApp mesajı Claude'a soruluyor: ${text.slice(0, 80)}`);
  const r = await think(text, "chat", { channel: "whatsapp" });
  if (r.error) { push("💬 Claude'a ulaşılamadı; mesaj kurallarla işleniyor"); return null; }
  const outs = r.done.filter((d) => d.type === "command").map((d) => [d.result?.reply, d.result?.report].filter(Boolean).join("\n\n")).filter(Boolean);
  const reply = ((waBrief() && outs.length ? outs : [r.reply, ...outs]).filter(Boolean).join("\n\n") || r.reply || "Tamam.") + brainQueueIds(r.done);
  return { action: "brain", reply, report: r.report, pending: r.pending, done: r.done };
}
async function handleCommand(text, opts = {}) {
  text = String(text || "");
  // ✏️ düzeltme (çizilmiş benzer video): "düzelt 3: 2. sahnede …", "#3 düzelt …", "düzelt: …" — kuyruk, kurallar ve beyinden önce (videoqueue.strictCommand)
  { const sc = strictCommand(text); if (sc?.kind === "revise") { const r = await reviseCommand(sc, opts); if (!opts.direct) brain.addExchange(text, r.reply, [{ type: "revise" }]); return r; } }
  // video kuyruğu ve trend komutları ("kuyruk", "kuyruk iptal 2", "şu ankini iptal et", "kuyruğu temizle", "trendler", "trend 1 3",
  // "trend otomatiğini kapat") ve çok linkli mesaj (her link sırayla kuyruğa): Claude'a gitmez, kurallardan önce (eşleşmezse eski yol)
  // otherCancel: Instagram temizliğinin "evet sil" onayı bekliyorsa "iptal/vazgeç" ona gider (aşağıda igCleanupPending; kuyruk listesi dönmez)
  { const vr = await vq.handleText(text, { ...opts, otherCancel: !!igCleanupPending }, trendAuto.command); if (vr) { if (!opts.direct && vr.reply) brain.addExchange(text, vr.reply, [{ type: "vqueue" }]); return vr; } }
  if (opts.source === "whatsapp" && !opts.direct) { const sm = await smartWhatsApp(text).catch((e) => { push(`💬 Claude yorumu başarısız: ${e.message}`); return null; }); if (sm) return sm; }
  const cmd = parseCommand(text); const videos = listVideos();
  if (opts.direct && cmd.action === "brain") return { action: "none", reply: `Bu komutu tanımadım: "${text.slice(0, 80)}"` };
  let reply = cmd.reply, action = cmd.action, payload = {}, extra = {};
  if (igCleanupPending && /(iptal|vazgeç|boş ver|silme)/.test(text.toLocaleLowerCase("tr-TR")) && cmd.action !== "ig_cleanup") { igCleanupPending = null; push("🗑 Instagram temizliği iptal edildi"); }
  switch (cmd.action) {
    case "ig_autoclean": {
      if (cmd.on != null) { patchSettings({ igAutoClean: { enabled: cmd.on } }); reply = cmd.on ? "🗑 Otomatik Instagram temizliği açık." : "⏸ Otomatik Instagram temizliği kapatıldı; hiçbir şey silinmeyecek."; break; }
      const c = igAutoCfg(); const p = await igAutoPlan();
      if (!p?.ok) { reply = `Liste çıkarılamadı: ${p?.error || "yanıt yok"}`; break; }
      const nn = (x) => Number(x || 0).toLocaleString("tr-TR");
      reply = `🗑 Otomatik silme ${c.enabled === false ? "KAPALI" : "açık"} (${nn(c.maxViews)} izlenme altı, ${c.waitHours} saat sonra): ${p.ready.length} silinecek, ${p.upcoming.length} karar bekliyor, ${p.kept.length} korunuyor.` +
        (p.ready.length ? "\n" + p.ready.slice(0, 8).map((x) => `• ${String(x.title).slice(0, 55)} (${nn(x.views)})`).join("\n") : "") + "\nSınırları ve listeyi panelde Ayarlar → Yayın hesapları → Instagram'da değiştirebilirsiniz.";
      break;
    }
    case "ig_cleanup": {
      const r = await igCleanupPlan({ days: cmd.days, max: cmd.max, minAgeH: cmd.minAgeH });
      reply = r.text; break;
    }
    case "ig_cleanup_confirm": {
      const r = await igCleanupRun({ notify: opts.source !== "whatsapp" });
      reply = r.text || r.error; break;
    }
    case "ig_dups": { const r = await igDupsPlan({ days: cmd.days }); reply = r.text; break; }
    case "trailer_watch": { // 🎬 fragman takibi: durum / aç-kapat / şimdi tara / kanal ekle-çıkar
      const c = trailerWatchCfg();
      if (cmd.on != null) {
        patchSettings({ trailerWatch: { enabled: cmd.on } });
        reply = cmd.on ? `🎬 Fragman takibi açık: ${c.channels.length} kanal ${c.intervalMin} dakikada bir taranır; yeni fragman düşünce fragman analizi üretilir${c.autoPublish ? " ve bağlı hesaplarda yayınlanır" : ", onayınıza gelir"}.${c.channels.length ? "" : " Kanal ekleyin: fragman kanalı ekle @NetflixTurkiye"}`
          : "⏸ Fragman takibi kapatıldı: kanallar taranmaz, bekleyen fragmanlar üretilmez (kayıtlı son fragmanlar durur).";
        if (cmd.on) twKick().catch(() => {});
        break;
      }
      if (cmd.pause || cmd.resume) { // "fragman kanalı duraklat @X" / "fragman kanalı devam @X" (sezon arası)
        const r = twSetPaused(String(cmd.pause || cmd.resume), !!cmd.pause);
        reply = !r.ok ? `🎬 ${r.error} Kanallar: ${c.channels.join(", ") || "—"}` : cmd.pause ? `⏸ ${r.input} duraklatıldı (sezon arası): kart kalır, taranmaz, uyarı almaz. Devam: fragman kanalı devam ${r.input}` : `▶ ${r.input} yeniden taranıyor.`;
        break;
      }
      if (cmd.add || cmd.remove) {
        const key = String(cmd.add || cmd.remove).trim(), list = c.channels.filter((x) => twKey(x) !== twKey(key));
        if (cmd.add && list.length !== c.channels.length) { reply = `🎬 ${key} zaten fragman takibinde (${c.channels.length} kanal).`; break; }
        if (cmd.remove && list.length === c.channels.length) { reply = `🎬 ${key} listede yok. Kanallar: ${c.channels.join(", ") || "—"}`; break; }
        if (cmd.add) list.push(key);
        patchSettings({ trailerWatch: { channels: list } });
        reply = cmd.add ? `🎬 ${key} fragman takibine eklendi (${list.length} kanal). İlk taramada son ${c.firstFreshHours} saatin fragmanları üretilir, eskileri yalnız kaydedilir; sonra düşen her yeni fragman üretilir${c.autoPublish ? " ve yayınlanır" : ", onayınıza gelir"}.`
          : `🎬 ${key} fragman takibinden çıkarıldı (${list.length} kanal).`;
        if (cmd.add) trailerWatchScan().catch(() => {}); // arka planda: kanalın son fragmanı hemen kaydedilsin
        break;
      }
      if (cmd.scan) {
        const r = await trailerWatchScan({ manual: true }), nn = (r.new || []).length;
        reply = !r.ok ? `❌ Tarama yapılamadı: ${r.error}` : `🎬 ${Object.keys(r.channels || {}).length} kanal tarandı, ${nn} yeni fragman${nn ? `:\n${r.new.slice(0, 5).map((n) => `• ${n.channel}: ${String(n.title).slice(0, 60)}`).join("\n")}` : "."}${r.errors?.length ? `\n⚠️ ${r.errors.slice(0, 2).join("; ")}` : ""}`;
        break;
      }
      reply = twStatusText(); break;
    }
    case "self_update": { const r = await selfUpdate({ source: opts.source || "panel" }); reply = updateText(r); extra = { restarting: !!r.restarting }; break; }
    case "update_check": {
      const r = await updateCheck();
      reply = !r.ok ? `❌ Güncelleme denetlenemedi: ${r.error}` : r.count ? `🆕 Yeni sürüm var (${r.count} değişiklik): ${String(r.subjects[0] || "").slice(0, 110)}. Almak için: *güncelle*`
        : r.stale ? "🆕 Yeni sürüm indirilmiş ama panel eski sürümle çalışıyor. Yeniden başlatmak için: *güncelle*" : `✅ Güncel${r.current ? ` (son sürüm: ${String(r.current).slice(0, 90)})` : ""}.`;
      break;
    }
    case "stopall": { stageMute = Date.now(); const r = await restStart({ reason: "elle durduruldu" }); reply = `Sistemi durdurdum. ${r.pipeline ? "Süren üretim kapatıldı. " : ""}Bilgisayar ısınmasın diye tüm modeller kapatıldı. ${r.rest.until ? `Sıradaki planlı iş saat ${hhmm(r.rest.until)}; o zamana kadar` : "Siz talimat verene kadar"} hiçbir şey başlamayacak.${r.video?.total ? ` Video kuyruğundaki ${r.video.total} video da iptal edildi; yeniden istemek için linkleri tekrar gönderin.` : ""}`; break; }
    case "rest_end": { stageMute = Date.now(); reply = restEnd("elle başlatıldı") ? "Sistem yeniden çalışıyor. Son dakika ve Mynet takibi devam ediyor." : "Sistem zaten çalışıyor."; break; }
    case "sondakika": { // sondakika.com takibi: "sondakika.com'u kontrol et", "sondakika takibini kapat/aç"
      if (cmd.on != null) {
        patchSettings({ sondakika: { enabled: cmd.on } }); push(`🔴 sondakika.com takibi ${cmd.on ? "açıldı" : "kapatıldı"}`);
        reply = cmd.on ? `sondakika.com takibi açık: her ${sondakikaEvery()} dakikada bir bakıyorum; düşen her yeni haber için onaysız son dakika videosu üretip bağlı hesaplarda yayınlıyorum.` : "sondakika.com takibi kapatıldı; yeni haberler için video üretilmeyecek.";
        break;
      }
      if (!cmd.check) {
        const st = readJson(path.join(DATA, "sondakika_state.json"), {}) || {}, c = sondakikaCfg();
        reply = `sondakika.com takibi ${c.enabled === false ? "kapalı" : `açık, her ${sondakikaEvery()} dakikada bir`}. ${st.lastCheck ? `Son kontrol ${hhmm(st.lastCheck)} (${st.method === "rss" ? "RSS" : "ana sayfa"})` : "Henüz kontrol edilmedi"}; bugün ${(sondakikaDone()[today()] || []).length} video.`;
        break;
      }
      const r = await sondakikaCheck({ manual: true });
      reply = r.busy ? "sondakika.com taraması zaten sürüyor; sonuç birazdan logda." : !r.ok ? `sondakika.com kontrol edilemedi: ${r.error}`
        : r.first ? `sondakika.com takibi başladı: ${r.items.length} haber kaydedildi; bundan sonra düşen yeni haberler için video üreteceğim.`
        : r.new.length ? `sondakika.com'da ${r.new.length} yeni haber var${r.produced.length ? `; ${r.produced.length} tanesi için son dakika videosu üretiliyor: ${r.produced.map((t) => t.slice(0, 50)).join(" · ")}` : "; video üretilmedi (nedenler logda)"}.`
        : `sondakika.com kontrol edildi (${r.method === "rss" ? "RSS" : "ana sayfa"}): ${r.items.length} haber, yeni haber yok.`;
      if (r.ok && sondakikaCfg().enabled === false) reply += " Otomatik takip kapalı; açmak için: sondakika takibini aç.";
      break;
    }
    case "anlik": {
      const r = await prepareAnlik(cmd.topic, cmd.duration, cmd.publishAt ? { publishAt: cmd.publishAt } : {});
      const what = r.title ? `"${r.title.slice(0, 90)}" (${r.source}${r.count > 1 ? `, ${r.count} haberde geçiyor` : ""})` : String(cmd.topic).slice(0, 60);
      const when = cmd.publishAt ? whenLabel(new Date(cmd.publishAt)) : "", dbt = !!(when && cmd.timeDoubt);
      reply = !r.ok ? r.error : `${r.social ? "Video linki alındı" : r.viaLink ? "Haberi okudum" : r.found ? "Haberi buldum" : "Sitelerde bulamadım, yazdığınız bilgiyle üretiyorum"}: ${what}. ${r.queued ? `Son dakika videosu ${r.position}. sıraya alındı; süren üretim bitince başlayacak.` : when ? `Video şimdi hazırlanıyor${dbt ? "." : ";"}` : "Son dakika videosu üretiliyor; fotoğraf ve videolar haber sayfalarından alınacak, bitince yayınlayıp haber vereceğim."}${when && !dbt ? ` ⏰ ${atLabel(when)} yayınlanacak (iptal için: planlı yayını iptal et).` : ""}`;
      if (r.ok && waBrief() && ["whatsapp", "brain"].includes(opts.source)) reply = `🎬 Başladı: ${r.title ? r.title.slice(0, 80) : "son dakika videosu"}${r.queued ? ` (${r.position}. sırada)` : ""}. Bitince video gelecek.${when && !dbt ? ` ⏰ ${atLabel(when)} yayınlanacak.` : ""}`;
      // şüpheli yayın saati ya da alınmayan açık yazılmış saat: tek kısa satır (10. tur; timeTail)
      if (r.ok && (dbt || !cmd.publishAt)) reply += timeTail(cmd);
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
    case "queue": { const q = await queueState(); reply = queueReport(q) || "Sıra bilgisi alınamadı."; break; }
    case "queue_drop": { // "sıradan çıkar 2" (yalnız o platformun sırasından; video Mac'te kalır), "sıradan çıkar 2026-10-24-3" (her platformdan), "sıradan sil 2" (video da Mac'ten silinir; platformlarda yayınlanmış kopyalar durur)
      const q = await queueState();
      if (!q.instagram && !q.youtube && !q.tiktok) { reply = "Sıra bilgisi alınamadı (publish.py yanıt vermedi); hiçbir şey çıkarılmadı."; break; }
      if (cmd.mixed) { reply = "Çıkarmak mı, silmek mi? Tek fiil yazın: *sıradan çıkar 2* (video Mac'te kalır) ya da *sıradan sil 2*."; break; }
      if ((cmd.nums || []).length > 1) { reply = `Tek seferde tek video: *sıradan ${cmd.del ? "sil" : "çıkar"} ${cmd.nums[0]}* yazın, sonra diğerini.`; break; }
      const list = queueList(q);
      if (!list.length) { reply = "Yükleme sırası boş; çıkarılacak video yok."; break; }
      const nm = String(cmd.name || "").replace(/\.mp4$/, ""), platOk = (x) => !cmd.platform || x.platform === cmd.platform;
      let it = null;
      if (cmd.n) {
        // numara son listeden: sıra kendiliğinden değişebildiğinden (yükleme, yeni haber en yeni önce) listede görülen numara esastır
        const rep = lastQueueReport && Date.now() - lastQueueReport.at < QREPORT_TTL ? lastQueueReport.map[cmd.n] : null;
        if (rep) {
          const live = list.find((x) => x.video === rep.video && x.platform === rep.platform) || null, repName = rep.title ? rep.title.slice(0, 60) : String(rep.video).replace(/\.mp4$/, "");
          if (!live) { reply = `${cmd.n} numaradaki video (${repName}) artık sırada değil (yüklendi ya da çıkarıldı); hiçbir şey yapılmadı. Güncel liste için *yükleme sırası* yazın.`; break; }
          if (!platOk(live)) { reply = `${cmd.n} numaradaki video (${repName}) ${PLAT_TR[cmd.platform]} sırasında değil, ${PLAT_TR[live.platform]} sırasında; hiçbir şey yapılmadı.`; break; }
          it = live;
        } else if (cmd.del) { reply = "Silmek için önce *yükleme sırası* yazıp numarayı görün (liste 30 dakika geçerli) ya da adıyla silin: *sıradan sil 2026-10-24-3*."; break; }
        else it = list.find((x) => x.n === Number(cmd.n) && platOk(x)) || null;
      } else if (nm) it = list.find((x) => String(x.video).replace(/\.mp4$/, "") === nm && platOk(x)) || null;
      if (!it) { reply = `Sırada ${cmd.n ? `${cmd.n} numaralı` : nm ? `"${nm}" adlı` : "böyle bir"} video yok${cmd.platform ? ` (${PLAT_TR[cmd.platform]})` : ""}. Liste için *yükleme sırası* yazın.`; break; }
      const label = it.title ? `${it.title.slice(0, 60)} (${String(it.video).replace(/\.mp4$/, "")})` : String(it.video).replace(/\.mp4$/, "");
      if (cmd.del) {
        const r = await deleteVideo(it.video, { local: true });
        const ps = (r.unqueued || []).map((p) => PLAT_TR[p] || p);
        reply = `🗑 ${label} Mac'ten silindi${ps.length ? `, ${ps.join(", ")} sırasından çıkarıldı` : ""}. Platformlarda yayınlanmış kopyası varsa duruyor (panelden silebilirsiniz).`;
      } else {
        const plat = cmd.platform || (cmd.n ? it.platform : "");
        const r = await py("publish.py", ["--unqueue", "--file", it.video, ...(plat ? ["--platform", plat] : [])]);
        const ps = (r.json?.platforms || []).map((p) => PLAT_TR[p] || p);
        if (r.json?.ok) push(`📤 ${it.video}: ${ps.join(", ")} sırasından WhatsApp'tan çıkarıldı (yüklenmeyecek)`);
        reply = r.json?.ok ? `✖ ${label} ${ps.join(", ")} sırasından çıkarıldı; yüklenmeyecek (video Mac'te duruyor, panelden elle yüklenebilir).` : `Çıkarılamadı: ${r.json?.error || "hata"}`;
      }
      break;
    }
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
      // video kuyruğu (videoqueue.js): boşsa hemen başlar, değilse sırasını bekler (sahibin işleri otomatik trend işlerinden önce)
      const vqr = vq.add({ url: cmd.url, instruction: cmd.instruction, publishAt: cmd.publishAt, kind: cmd.kind || "", source: opts.source === "whatsapp" ? "whatsapp" : "panel" });
      if (!vqr.ok) { reply = vqr.error; break; }
      if (vqr.queued) {
        reply = `⏳ Sıraya alındı (#${vqr.no}; önünde ${vqr.ahead} video var): ${vqr.ahead > 1 ? "önündeki videolar" : "önündeki video"} bitince bu link başlayacak (uzun videoda her biri 10-20 dk sürebilir). Sıra: *kuyruk* · iptal: *#${vqr.no} iptal*`
          + (cmd.publishAt ? vqTimeTail(cmd, vqr.no) : timeTail(cmd));
        break;
      }
      // talimatta fragman geçiyorsa (açık haber isteği ve tür etiketi yoksa; socialVideoNews ile aynı öncelik ve aynı tür: "#haber
      // fragman" haber, "link/mizah fragman parodisi" mizah) yanıt fragman analizi der (başlıktan tanınan fragmanı socialVideoNews ayrıca
      // bildirir); süre talimattaki "N saniye"den
      const fr = trailerCfg().enabled !== false && trailerAsk(cmd.instruction || "") && !newsRequest(cmd.instruction || "") && !kindOf(cmd);
      const frSecs = trailerSecs(cmd.instruction);
      // benzer video (sıfırdan) fragman ve türden önce (socialVideoNews ile aynı öncelik)
      const rcAsk = recreateOn() && recreateAsk(cmd.instruction || "");
      reply = (rcAsk ? (waBrief() ? "🎨 Başladı: video izleniyor, kelimeleri çıkarılıp benzeri sıfırdan çiziliyor. Bitince video gelecek."
        : "🎨 Videoyu indiriyorum; izleyip kelimelerini çıkaracağım, aynı hikâyeyi kendi cümlelerimizle yeniden yazıp sahnelerini sıfırdan çizeceğim (orijinal görüntü kullanılmaz). Her adımda haber vereceğim.")
        : fr ? (waBrief() ? `🎬 Başladı: fragman indiriliyor; kelimelere dökülüp ${frSecs} saniyelik fragman analizi hazırlanıyor. Bitince video gelecek.` : `🎬 Fragmanı indiriyorum; konuşmasını kelimelere döküp çekimlerini inceleyeceğim, çarpıcı bir kancayla ${frSecs} saniyelik "fragmanda ne anlatılıyor" videosu hazırlayacağım. Her adımda haber vereceğim.`)
        : waBrief() ? `🎬 Başladı: paylaşım indiriliyor, ${{ mizah: "mizah videosu (VİRAL etiketiyle; mizah olduğu sonda söylenir)", trend: "viral video" }[kindOf(cmd)] || "video"} hazırlanıyor. Bitince video gelecek.`
        : "🔗 Paylaşımı indiriyorum; inceleyip kurgusunu çıkaracağım. Her adımda haber vereceğim.") + (cmd.publishAt ? vqTimeTail(cmd, vqr.no) : timeTail(cmd));
      reply += vq.idLine(vqr); // kuyruk numarası: iptalin tutamağı (4. tur)
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
      else { const r = await execAction(act); reply = r.blocked ? r.error : r.ok ? `${label(videos[0])} ${plats.join(" ve ")} üzerinde yayınlandı.` : "Yayında sorun oldu: " + Object.values(r.results || {}).map((x) => x.error).filter(Boolean).join("; "); } break; }
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
    case "report": case "plan": case "brain": { state.busy = "düşünüyor"; try { const r = await think(text, cmd.action === "brain" ? "chat" : cmd.action); const qi = brainQueueIds(r.done); reply = qi ? (r.reply || "") + qi : r.reply; extra = { report: r.report, reportFile: r.reportFile, done: r.done, pending: r.pending }; action = r.pending.length ? "confirm" : (r.done.find((d) => d.type === "open_video") ? "play_named" : cmd.action); if (r.pending.length) payload = { actions: r.pending }; const ov = r.done.find((d) => d.type === "open_video"); if (ov) payload = { name: ov.video }; } finally { state.busy = null; } break; }
    default: break;
  }
  if (!["report", "plan", "brain", "none", "stop"].includes(cmd.action) && reply && !opts.direct) brain.addExchange(text, reply, [{ type: cmd.action }]);
  return { action, reply, payload, heard: text, ...extra };
}
app.post("/api/command", async (req, res) => res.json(await handleCommand(req.body?.text)));

// ---------- Jarvis sesi
// ---------- Emixhas'ın sesi: üretilen ses diske önbelleklenir (aynı cümle + aynı ses ayarı = anında çalar)
const SPEAK_CACHE = path.join(WORK, "speak-cache");
// PRON_VER: scripts/voices.py okunuş kuralları (PRONOUNCE, parti adları) değişince artır; eski okunuşlu önbellek kullanılmasın
const PRON_VER = 8;
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
  [/^📤 instagram: sınır doldu/, "Instagram geçici engel koydu. Video sıraya alındı, bekleme bitince otomatik yüklenecek."],
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
  [/^🔴 sondakika\.com: yeni haber/, "Son dakika sitesine yeni haber düştü, video hazırlanıyor."],
  [/^(🧹 |⏹ hepsi durduruldu)/, "Modeller sorunsuz durduruldu. Bilgisayarınız ısınmasın diye kapatıldı."],
  [/^🔥 VİRAL/, "Bir video viral oluyor. Ayrıntıyı WhatsApp'a gönderdim."],
  [/^⏸ SİSTEM DURDURULDU/, "Sistem durduruldu. Bilgisayarınız ısınmasın diye tüm modeller kapatıldı. Bir sonraki planlı üretime ya da sizin talimatınıza kadar hiçbir şey başlamayacak."],
  [/^▶ SİSTEM YENİDEN ÇALIŞIYOR/, "Sistem yeniden çalışıyor."],
];
const STAGE_PHRASES = [...new Set(STAGE_VOICE.map(([, t]) => t))];
let lastStage = { text: "", at: 0 }, macQueue = Promise.resolve();
// Sessiz (kullanıcı isteği, 20 Ekim: "paneli sessise alma butonu ekle"; başlıktaki 🔊/🔇 düğmesi, settings.muted): aşama cümleleri ne
// panele ("stage" olayı) ne Mac hoparlörüne gider, ses açılınca kaçırılanlar okunmaz. Açık sekmeler SSE "mute" olayıyla aynı duruma geçer
// (çalan sesi keserler); sessize alınırken çalmakta olan Mac sesi (afplay) de kesilir. Sık cümlelerin ön hazırlığı (QUICK_PHRASES) sürer.
let macAbort = new AbortController();
function muteChanged(on) {
  for (const r of clients) r.write(`event: mute\ndata: ${JSON.stringify({ muted: on })}\n\n`);
  if (on) { macAbort.abort(); macAbort = new AbortController(); }
  push(on ? "🔇 panel sessize alındı: yanıtlar ve aşama duyuruları yalnız yazıyla, Mac hoparlörü de susar" : "🔊 panel sesi açıldı");
}
let stageMute = 0; // komut yanıtı aynı şeyi zaten söylüyorsa (sistemi durdur/başlat) aşama cümlesi 3 sn susar
function stageVoice(line) {
  if (Date.now() - stageMute < 3000 && /^(⏸|▶ SİSTEM)/.test(String(line))) return;
  const all = settings(), cfg = all.stageVoice || {};
  if (cfg.enabled === false || all.muted === true) return; // sessiz: ne panele ne Mac hoparlörüne
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
  macQueue = macQueue.then(async () => { const f = await synthSpeech(text); if (f && settings().muted !== true) await run("afplay", [f], { signal: macAbort.signal }); }).catch(() => {});
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
  if (Date.now() - preemptedAt < 90000) { push("⏭ durdurulan otomatik üretim (sahibin işi öne alındı): hata uyarısı gönderilmedi"); return; }
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
    // son düzenli video: kayıtların üretim zamanı (disk temizliği 2 günden eski mp4'ü siler, kayıt kalır; mp4 zamanı yedek)
    let lastRegular = 0;
    for (const f of readdirSync(OUT).filter((x) => /^\d{4}.*\.json$/.test(x))) {
      const m = readJson(path.join(OUT, f), {});
      if (m.anlik || ["anlik", "gunluk", "haftalik"].includes(m.format)) continue;
      let t = metaTime(m);
      if (!t) { try { t = statSync(path.join(OUT, f.replace(/\.json$/, ".mp4"))).mtimeMs; } catch { t = 0; } }
      if (t > lastRegular) lastRegular = t;
    }
    // zamanlayıcı yeni açıldıysa ondan önceki boşluk sayılmaz
    const last = Math.max(lastRegular, Number(readSched().loadedAt) || 0) || null;
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
let flushAsap = false; // post_pipeline sahibin videosunda sırayı boşaltmadı ("📤 sırada N video bekliyor; … panel … yükleyecek"): üretim biter bitmez burada yüklenir
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
  // bekleme (publish_hold.json) son flush'tan sonra bittiyse saati ve dinlenmeyi beklemeden dene: sıradaki video engel kalkar kalkmaz
  // yüklensin (yükleme hafif, model açmaz)
  const holdEnded = Object.values(readJson(path.join(DATA, "publish_hold.json"), {}) || {}).some((h) => { const u = Date.parse(h?.until || ""); return u && u <= Date.now() && u > lastFlush; });
  if (rest && !holdEnded && !flushAsap) return; // YouTube sırası ve günlük rapor (Claude) sistem uyanınca (yükleme hafif: bekleme bitince ve sahibin işi sırayı bıraktığında dinlenmede de)
  if (anyConnected && !state.running && (Date.now() - lastFlush > 60 * 60000 || holdEnded || flushAsap) && existsSync(path.join(DATA, "publish_queue.json")) && readJson(path.join(DATA, "publish_queue.json"), []).length) {
    lastFlush = Date.now(); flushAsap = false;
    flushQ = true; // sıradaki videolar yükleniyor: güncelleme yeniden başlatmayı bekler
    const r = await py("publish.py", ["--flush"]).finally(() => { flushQ = false; });
    for (const l of String(r.stdout || "").trim().split("\n").slice(0, -1)) if (l.startsWith("📤")) push(l);
    if (r.json?.uploaded?.length) await py("analyze.py");
  }
  if (rest) return; // günlük rapor (Claude) sistem uyanınca
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
app.get("/api/queue", async (_req, res) => res.json(await queueState()));
// Yayın sırası (kullanıcı isteği, 23 Ekim: "Instagram için sıraya alınan videoları görebilelim: hangi video hangi aşamada, yüklendi mi, sorun var mı,
// sıra akıyor mu"): publish.py --queue (platform başına bekleyenler, deneme/son hata, duraklatma, son olaylar) + panelin bildiği son/sonraki
// deneme zamanı. Sonraki deneme: bekleme bitişi (dakikalık döngü, dinlenmede de), yoksa saatlik tur ya da süren üretimin sonu.
const PLAT_TR = { instagram: "Instagram", youtube: "YouTube", tiktok: "TikTok" };
const QEV_TR = { queued: "⏳ sıraya alındı", uploaded: "✅ yüklendi", failed: "❌ yüklenemedi", dropped: "⏭ sıradan çıkarıldı", held: "⏸ engel sürüyor", hold: "⏸ bekleme başladı", removed: "✖ elle çıkarıldı" };
async function queueState() {
  const r = await py("publish.py", ["--queue"]), j = r.json || {};
  const now = Date.now(), waits = [];
  for (const p of Object.keys(PLAT_TR)) {
    const i = j[p]; if (!i?.count) continue;
    const hold = Date.parse(i.holdUntil || ""); // bekleme bitince dakikalık döngü hemen dener; yoksa saatlik tur (üretim yokken)
    waits.push(hold > now ? hold + 60000 : Math.max(now + 60000, (lastFlush || 0) + 60 * 60000));
  }
  return { ...j, ok: j.ok !== false, lastFlush: lastFlush ? new Date(lastFlush).toISOString() : null, flushing: flushQ, resting: resting(), running: state.running,
    nextFlush: waits.length ? new Date(Math.min(...waits)).toISOString() : null };
}
const hhmmOf = (t) => { const d = new Date(t); return Number.isNaN(d.getTime()) ? "?" : d.toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" }); };
// Yükleme sırası listesi (kullanıcı isteği, 26 Ekim: "sırada ne var, ne yüklenecek göreyim; değeri geçmiş haberi sıradan çıkarayım"): publish.py
// --queue zaten yüklenecek sırayla verir (fragman → sahibin videosu → haber, en yeni önce); burada platform sırasıyla tek numara dizisi
// (1..N) verilir, "sıradan çıkar 2" / "sıradan sil 2" o numarayı kullanır. Numara her çağrıda güncel sıradan hesaplanır.
const QKIND_ICON = { fragman: "🎬", sahip: "📲", haber: "📰" }, QKIND_TR = { fragman: "fragman", sahip: "sizin videonuz", haber: "haber" };
const sinceText = (h) => h == null ? "" : h < 1 ? `${Math.max(1, Math.round(h * 60))} dakikadır` : h < 48 ? `${Math.round(h)} saattir` : `${Math.floor(h / 24)} gündür`;
function queueList(q) {
  const out = [];
  for (const p of Object.keys(PLAT_TR)) for (const it of (q[p]?.items || [])) out.push({ ...it, n: out.length + 1, platform: p });
  return out;
}
// son "yükleme sırası" listesi (inceleme, 27 Ekim: sıra kendiliğinden değişir — yükleme, yeni haber en yeni önce —, "sıradan sil 2" listede görülen
// 2'yi silmeli): numara → video; 30 dk geçerli, silme için şart (yoksa ad istenir)
let lastQueueReport = null;
const QREPORT_TTL = 30 * 60000;
function queueReport(q) {
  const out = [], name = (v) => String(v || "").replace(/\.mp4$/, ""), list = queueList(q);
  lastQueueReport = { at: Date.now(), map: Object.fromEntries(list.map((x) => [x.n, { video: x.video, platform: x.platform, title: x.title || "" }])) };
  for (const p of Object.keys(PLAT_TR)) {
    const i = q[p]; if (!i) continue;
    const hold = Date.parse(i.holdUntil || "") > Date.now();
    if (!i.count && !hold) { out.push(`📤 ${PLAT_TR[p]} sırası: boş`); continue; }
    out.push(`📤 *${PLAT_TR[p]} sırası*: ${i.count ? `${i.count} video bekliyor` : "boş"}${hold ? ` · ⏸ ${hhmmOf(i.holdUntil)}'e kadar duraklatıldı (${i.holdReason || i.reason})` : i.count ? (q.flushing ? " · ⬆ yükleniyor" : " · akıyor, sıradaki denemede yüklenecek") : ""}`);
    for (const it of list.filter((x) => x.platform === p)) {
      const title = String(it.title || "").trim();
      out.push(`${it.n}. ${QKIND_ICON[it.kind] || "📰"} ${title ? `${title.slice(0, 70)} (${name(it.video)})` : name(it.video)} — ${it.ageHours != null ? `${sinceText(it.ageHours)} sırada` : `${hhmmOf(it.at)}'ten beri sırada`}${it.value?.top ? " · ⭐ en değerli" : it.value?.valuable ? " · ⭐ değerli" : ""}${it.tries ? `, ${it.tries} deneme` : ""}${it.lastError ? `, son: ${String(it.lastError).slice(0, 80)}` : ""}${it.staleHint ? " · ⚠️ değeri geçmiş olabilir" : ""}`);
    }
    const ev = (i.events || []).slice(0, 4);
    if (ev.length) out.push("Son: " + ev.map((e) => `${hhmmOf(e.at)} ${QEV_TR[e.event] || e.event} ${name(e.video)}${e.event === "uploaded" && e.url ? " " + e.url : ""}`.trim()).join(" · "));
  }
  if (list.length) out.push("Sıra: önce 🎬 fragmanlar, sonra 📲 sizin videolarınız, sonra 📰 haberler (en yeni önce). Çıkarmak için *sıradan çıkar 2* (video Mac'te kalır) ya da *sıradan sil 2* (video da silinir).");
  if (q.flushing) out.push("⬆ Şu an yükleniyor.");
  else if (q.nextFlush) out.push(`Sonraki deneme: ${hhmmOf(q.nextFlush)}${q.running ? " (üretim bitince)" : q.resting ? " (sistem dinlenmede; bekleme bitince yine denenir)" : ""}`);
  return out.join("\n");
}
async function flushNow() {
  if (flushQ) return { ok: false, error: "Sıra zaten yükleniyor." };
  const q = readJson(path.join(DATA, "publish_queue.json"), []) || [];
  if (!q.length) return { ok: true, uploaded: [], queued: 0, error: "Sırada bekleyen video yok." };
  lastFlush = Date.now(); flushQ = true;
  try {
    const r = await py("publish.py", ["--flush"]);
    for (const l of String(r.stdout || "").trim().split("\n").slice(0, -1)) if (l.startsWith("📤")) push(l);
    if (r.json?.uploaded?.length) await py("analyze.py");
    const holds = readJson(path.join(DATA, "publish_hold.json"), {}) || {}, held = Object.entries(holds).filter(([p, h]) => Date.parse(h?.until || "") > Date.now() && q.some((x) => x.platform === p)).map(([p, h]) => `${PLAT_TR[p] || p} beklemesi ${hhmmOf(h.until)}'e kadar sürüyor`);
    return { ok: true, ...(r.json || {}), ...(!r.json?.uploaded?.length && held.length ? { error: held.join("; ") + "; o saatte kendiliğinden yüklenecek." } : {}) };
  } finally { flushQ = false; }
}
app.post("/api/queue/flush", async (_req, res) => { try { res.json(await flushNow()); } catch (e) { res.json({ ok: false, error: e.message }); } });
app.post("/api/queue/drop", async (req, res) => { // platform verilmezse her platformun sırasından
  const video = path.basename(String(req.body?.video || "")), plat = String(req.body?.platform || "");
  if (!video || (plat && !PLAT_TR[plat])) return res.json({ ok: false, error: "video gerekir (platform isteğe bağlı)" });
  const r = await py("publish.py", ["--unqueue", "--file", video, ...(plat ? ["--platform", plat] : [])]);
  if (r.json?.ok) push(`📤 ${video}: ${(r.json.platforms || [plat]).map((p) => PLAT_TR[p] || p).join(", ")} sırasından elle çıkarıldı (yüklenmeyecek; panelden elle yüklenebilir)`);
  res.json(r.json || { ok: false, error: (r.stderr || r.stdout || "").slice(-200) });
});
app.listen(PORT, "0.0.0.0", () => console.log(`EMIXHAS paneli: http://localhost:${PORT}   (telefon: http://${lanIp()}:${PORT})`));
