// Emixhas'ın beyni: bağlamı toplar, claude -p ile düşünür, JSON yanıt döndürür.
import { execFile, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

// Claude Code komutunun tam yolu. Arka plan servisi kullanıcının kabuk ayarlarını yüklemediği için
// scripts/find_claude.sh bilinen kurulum yerlerini ve kullanıcının kabuğunu dener. Bulunan yol saklanır.
let claudeCache = null;
export function claudeBin(ROOT, { fresh = false } = {}) {
  if (claudeCache && !fresh && existsSync(claudeCache)) return claudeCache;
  const r = spawnSync("bash", [path.join(ROOT, "scripts/find_claude.sh")], { encoding: "utf8", timeout: 40000, env: process.env });
  claudeCache = r.status === 0 ? r.stdout.trim().split("\n").pop() : null;
  return claudeCache;
}
// claude bir node betiği olabilir (npm/nvm kurulumu); kendi klasörü PATH'e eklenir ki "node" bulunsun.
export const claudeEnv = (bin) => ({ ...process.env, PATH: `${path.dirname(bin)}:${process.env.PATH || ""}` });
// Hata metnini kullanıcıya anlaşılır Türkçe açıklamaya çevirir.
export function claudeError(msg) {
  const m = String(msg || "");
  if (/ENOENT|bulunamadı/i.test(m)) return "Claude Code bulunamadı. Terminalde 'which claude' çıktısını secrets/.env içine CLAUDE_BIN=... olarak yazın.";
  if (/log ?in|not logged|authenticat|api key|unauthori|401|oauth|credential/i.test(m)) return "Claude oturumu açık değil. Terminalde 'claude' yazıp /login ile giriş yapın, sonra paneli yeniden başlatın.";
  if (/rate limit|usage limit|429|overloaded|529/i.test(m)) return "Claude kullanım sınırına ulaşıldı ya da servis yoğun. Biraz sonra tekrar deneyin.";
  if (/zaman aşımı|timed? ?out/i.test(m)) return "Claude zamanında yanıt vermedi. Ayarlar → Gelişmiş bölümünde beyin seviyesini 'medium' yapmayı deneyin.";
  if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|network|fetch failed|getaddrinfo/i.test(m)) return "İnternet bağlantısı yok ya da Claude sunucusuna ulaşılamıyor.";
  return m.split("\n").filter(Boolean).slice(-2).join(" ").slice(0, 300);
}

export function makeBrain({ ROOT, OUT, DATA, listVideos, getSchedule, getState, pythonBin }) {
  const MEM = path.join(DATA, "memory.json");
  const readJson = (p, d) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return d; } };
  const memory = () => readJson(MEM, { notes: [] });
  const addExchange = (user, reply, actions) => { const m = memory(); (m.exchanges ||= []).push({ at: new Date().toISOString(), user: String(user).slice(0, 200), reply: String(reply).slice(0, 240), actions: (actions || []).map((a) => a.type) }); m.exchanges = m.exchanges.slice(-40); mkdirSync(DATA, { recursive: true }); writeFileSync(MEM, JSON.stringify(m, null, 2)); };
  const recentExchanges = () => { const m = memory(); const now = Date.now(); return (m.exchanges || []).filter((e) => now - Date.parse(e.at) < 36 * 3600e3).slice(-12).map((e) => ({ ne_zaman: new Date(e.at).toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" }), siz: e.user, ben: e.reply, eylem: e.actions })); };
  const addNote = (text) => { const m = memory(); m.notes.push({ at: new Date().toISOString(), text: String(text).slice(0, 400) }); m.notes = m.notes.slice(-40); mkdirSync(DATA, { recursive: true }); writeFileSync(MEM, JSON.stringify(m, null, 2)); };
  const settings = () => readJson(path.join(DATA, "settings.json"), { autopublish: { youtube: false, instagram: false }, dailyReportHour: 9 });
  const connections = () => new Promise((res) => execFile(pythonBin, ["scripts/publish.py", "--status"], { cwd: ROOT }, (e, out) => { try { res(JSON.parse(out)); } catch { res({ youtube: { connected: false }, instagram: { connected: false } }); } }));

  async function context() {
    const insights = readJson(path.join(DATA, "insights.json"), null);
    // Bağlam küçük tutulur (token): son 15 video, gerekli alanlar, boş metrikler atılır
    const metrics = readJson(path.join(DATA, "metrics.json"), { videos: {} });
    const videos = listVideos().slice(0, 15).map((v) => {
      const m = metrics.videos[v.name] || {};
      const o = { name: v.name, date: v.date, time: v.time, n: v.episodeOfDay, dur: v.duration, target: v.targetDuration, headlines: v.headlines.slice(0, 4).map((h) => (h.breaking ? "★" : "") + (h.category || "") + ": " + h.title) };
      for (const p of ["youtube", "instagram", "tiktok"]) if (m[p]) o[p] = { views: m[p].views ?? null, likes: m[p].likes ?? null, url: m[p].url ?? null };
      return o;
    });
    return {
      now: new Date().toLocaleString("tr-TR"),
      videos,
      insights: insights ? { ...insights, rows: undefined, top: (insights.top || []).slice(0, 5) } : null,
      connections: await connections(),
      schedule: await getSchedule(),
      settings: settings(),
      recentLog: getState().log.slice(-12),
      memory: { notes: memory().notes || [] },
      recentConversation: recentExchanges(),
    };
  }

  const USAGE = path.join(DATA, "usage.json");
  function recordUsage(kind, u) {
    const d = readJson(USAGE, { days: {}, total: { calls: 0, input: 0, output: 0, cost: 0 } });
    const day = (d.days[new Date().toISOString().slice(0, 10)] ||= { calls: 0, input: 0, output: 0, cost: 0, byKind: {} });
    const k = (day.byKind[kind] ||= { calls: 0, input: 0, output: 0, cost: 0 });
    for (const b of [day, d.total, k]) { b.calls++; b.input += u.input; b.output += u.output; b.cost = Math.round((b.cost + u.cost) * 10000) / 10000; }
    writeFileSync(USAGE, JSON.stringify(d, null, 2));
  }
  const usageToday = () => { const d = readJson(USAGE, { days: {}, total: {} }); return { today: d.days[new Date().toISOString().slice(0, 10)] || null, total: d.total || null }; };

  function runClaude(prompt, mode, timeoutMs = mode === "chat" ? 180000 : 300000) {
    return new Promise((resolve, reject) => {
      const e = settings().claudeEffort; const effort = (e && typeof e === "object" ? e.brain : e) || "high";
      const bin = claudeBin(ROOT);
      if (!bin) return reject(new Error("Claude Code bulunamadı"));
      const child = spawn(bin, ["-p", "--effort", effort, "--output-format", "json"], { cwd: ROOT, env: claudeEnv(bin) });
      let out = "", err = "";
      const t = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("Claude zaman aşımı")); }, timeoutMs);
      child.on("error", (er) => { clearTimeout(t); claudeCache = null; reject(er); });
      child.stdin.on("error", () => { /* süreç erken kapandı; hata close/error ile gelir */ });
      child.stdout.on("data", (c) => (out += c));
      child.stderr.on("data", (c) => (err += c));
      child.on("close", (code) => { clearTimeout(t); if (code !== 0) { let msg = err; try { const j = JSON.parse(out); if (j.is_error || j.result) msg = `${j.result || ""} ${err}`; } catch { /* json değil */ } return reject(new Error(msg.trim() || out.trim() || `claude çıkış kodu ${code}`)); }
        let j0 = null; try { j0 = JSON.parse(out); } catch { /* json değil */ } if (j0?.is_error) return reject(new Error(String(j0.result || "Claude hata döndürdü")));
        try { const j = JSON.parse(out); const u = j.usage || {}; const usage = { input: (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0), output: u.output_tokens || 0, thinking: u.output_tokens_details?.thinking_tokens || 0, cost: Number(j.total_cost_usd || 0), effort };
          recordUsage(mode, usage); resolve({ text: j.result || "", usage }); } catch { resolve({ text: out, usage: null }); } });
      child.stdin.end(prompt);
    });
  }

  const parseJson = (text) => {
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) throw new Error("JSON yok");
    const j = JSON.parse(m[0]);
    return { reply: String(j.reply || ""), report: String(j.report || ""), actions: Array.isArray(j.actions) ? j.actions : [] };
  };

  /** mode: chat | report | plan */
  async function ask(userText, mode = "chat") {
    const system = readFileSync(path.join(ROOT, "prompts/emixhas.md"), "utf8");
    const ctx = await context();
    const task = mode === "report"
      ? "GÖREV: Günlük performans raporu hazırla. Son 24 saat ve toplam; en iyi/en kötü video; kategori ve saat gözlemleri; yarın için 3 somut öneri. report alanına Markdown yaz, reply'da 2 cümleyle özetle."
      : mode === "plan"
        ? "GÖREV: Önümüzdeki 7 gün için içerik planı yap: günde kaç video, hangi süreler, hangi saatler, kategori ağırlıkları, denenecek 2 hipotez ve nasıl ölçüleceği. Veriye dayan; veri yoksa makul başlangıç planı kur ve bunu söyle. report alanına Markdown, reply'da özet. Planı note eylemiyle hafızana da kısa yaz."
        : `KULLANICI DEDİ Kİ: ${userText}`;
    const prompt = `${system}\n\nBAĞLAM:\n${JSON.stringify(ctx)}\n\n${task}\n\nSadece JSON döndür.`;
    let r;
    try { r = await runClaude(prompt, mode); } catch (e) { console.error("[beyin]", e.message); return { reply: `Beyne bağlanılamadı: ${claudeError(e.message)}`, report: "", actions: [], error: true }; }
    try { return { ...parseJson(r.text), usage: r.usage }; } catch { return { reply: r.text.slice(0, 300), report: "", actions: [], usage: r.usage }; }
  }

  function saveReport(mode, md) {
    if (!md) return null;
    const dir = path.join(DATA, "reports"); mkdirSync(dir, { recursive: true });
    const name = `${new Date().toISOString().slice(0, 10)}-${mode}.md`;
    writeFileSync(path.join(dir, name), md);
    return name;
  }

  return { ask, addNote, addExchange, memory, settings, connections, context, saveReport, usageToday };
}
