// Emixhas'ın beyni: bağlamı toplar, claude -p ile düşünür, JSON yanıt döndürür.
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export function makeBrain({ ROOT, OUT, DATA, listVideos, getSchedule, getState, pythonBin }) {
  const MEM = path.join(DATA, "memory.json");
  const readJson = (p, d) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return d; } };
  const memory = () => readJson(MEM, { notes: [] });
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
      memory: memory(),
    };
  }

  function runClaude(prompt, timeoutMs = 120000) {
    return new Promise((resolve, reject) => {
      const child = spawn("claude", ["-p", "--output-format", "text"], { cwd: ROOT, env: process.env });
      let out = "", err = "";
      const t = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("Claude zaman aşımı")); }, timeoutMs);
      child.stdout.on("data", (c) => (out += c));
      child.stderr.on("data", (c) => (err += c));
      child.on("close", (code) => { clearTimeout(t); code === 0 ? resolve(out) : reject(new Error(err || `claude çıkış kodu ${code}`)); });
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
    let raw;
    try { raw = await runClaude(prompt); } catch (e) { return { reply: `Beyin şu an yanıt veremiyor: ${e.message}`, report: "", actions: [], error: true }; }
    try { return parseJson(raw); } catch { return { reply: raw.slice(0, 300), report: "", actions: [] }; }
  }

  function saveReport(mode, md) {
    if (!md) return null;
    const dir = path.join(DATA, "reports"); mkdirSync(dir, { recursive: true });
    const name = `${new Date().toISOString().slice(0, 10)}-${mode}.md`;
    writeFileSync(path.join(dir, name), md);
    return name;
  }

  return { ask, addNote, memory, settings, connections, context, saveReport };
}
