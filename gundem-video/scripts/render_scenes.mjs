// Benzer video sahnelerini tek seferde çizer (wa_video.py çağırır): proje bir kez paketlenir, her sahne "SvgScene" bileşeniyle
// sessiz h264 mp4 olur (1080x1920, 30 kare/sn, süre props.seconds).
// Kullanım: node scripts/render_scenes.mjs <jobs.json>
//   jobs: [{ "out": "/mutlak/yol/sahne-1.mp4", "props": { "svg", "count", "seconds", "hold", "palette", "seed" } }] (klip = seconds + hold)
// Her sahne en çok 3 kez denenir (2 tekrar); çıktı yoksa ya da çok küçükse başarısız sayılır. Her sahnenin kendi süre sınırı var
// (max(120 sn, kare × 0,5 sn), denemeler dahil; aşılınca çizim iptal edilir, tekrar denenmez, sıradaki sahneye geçilir; inceleme, 19
// Ekim: iç içe <use>'lu tek bir yavaş sahne bütün işin 20 dakikasını bitirip sonraki sahneleri de yedeğe düşürüyordu). stdout'a yalnız sonuç JSON'u
// {ok, results: {out: "ok" | "hata: …"}}; ilerleme satırları stderr'e. Tarayıcı: PUPPETEER_EXECUTABLE_PATH (sandbox), yoksa Remotion'unki.
// Eşzamanlılık SCENE_CONCURRENCY (varsayılan çekirdeklerin yarısı, en çok 4). Ara dosya (GundemVideo yeniden kodlar): crf 18,
// x264 "veryfast" (medium'un üçte biri işlemci, dosya daha da küçük).
import { bundle } from "@remotion/bundler";
import { makeCancelSignal, openBrowser, renderMedia, selectComposition } from "@remotion/renderer";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
let jobs;
try {
  jobs = JSON.parse(readFileSync(process.argv[2], "utf8"));
  if (!Array.isArray(jobs)) throw new Error("iş listesi dizi değil");
} catch (e) {
  console.log(JSON.stringify({ ok: false, error: "iş dosyası: " + e.message }));
  process.exit(1);
}
const browserExecutable = process.env.PUPPETEER_EXECUTABLE_PATH || null;
const extra = browserExecutable ? { browserExecutable, chromeMode: "chrome-for-testing" } : {};
const concurrency = Math.max(1, Number(process.env.SCENE_CONCURRENCY) || Math.min(4, Math.max(1, Math.floor(os.cpus().length / 2))));
const ok = (f) => existsSync(f) && statSync(f).size > 10000;
// sahnenin süre sınırı, ms (wa_video.scene_budget aynı kural): kare = ceil((seconds + hold) × 30), Root.tsx calculateSvgSceneMetadata gibi
const budgetMs = (props) => Math.max(120, Math.ceil(((Number(props.seconds) || 4) + Math.max(0, Math.min(30, Number(props.hold) || 0))) * 30) * 0.5) * 1000;

const results = {};
let serveUrl;
try {
  serveUrl = await bundle({ entryPoint: path.join(ROOT, "src/index.ts"), publicDir: path.join(ROOT, "public") });
} catch (e) {
  console.log(JSON.stringify({ ok: false, error: "paketleme: " + e.message }));
  process.exit(1);
}
// tarayıcı bir kez açılır (sahne başına açıp kapamak her sahneye birkaç saniye ekliyordu); kapanırsa sonraki denemede yeniden açılır
let browser = null;
const getBrowser = async () => (browser ||= await openBrowser("chrome", { ...extra }));
for (const [k, j] of jobs.entries()) {
  const out = path.resolve(ROOT, String(j.out || ""));
  const props = { ...j.props, seconds: Number(j.props?.seconds) || 4 };
  let err = "", prep = "";
  const t0 = Date.now(), budget = budgetMs(props);
  try {
    mkdirSync(path.dirname(out), { recursive: true });
    rmSync(out, { force: true }); // eski bir denemenin dosyası başka sahneyle karışmasın
  } catch (e) { prep = e.message; } // yazılamayan yol: denemeye gerek yok
  for (let attempt = 1; !prep && attempt <= 3 && !ok(out); attempt++) {
    const left = t0 + budget - Date.now();
    if (left <= 0) { err = `sahne ${Math.round(budget / 1000)} sn'de çizilemedi (süre sınırı)${err ? `; son hata: ${err}` : ""}`; break; }
    // süre dolunca çizim iptal edilir; iptal 10 sn'de sonuç vermezse deneme yine bırakılır (tarayıcı kapatılıp sıradaki sahneye geçilir)
    const { cancelSignal, cancel } = makeCancelSignal();
    let timer = null, late = false;
    const guard = new Promise((_, reject) => {
      timer = setTimeout(() => { late = true; cancel(); timer = setTimeout(() => reject(new Error("iptal edilemedi")), 10000); }, left);
    });
    try {
      await Promise.race([guard, (async () => {
        const puppeteerInstance = await getBrowser();
        const composition = await selectComposition({ serveUrl, id: "SvgScene", inputProps: props, puppeteerInstance, ...extra });
        if (late) throw new Error("süre doldu");
        await renderMedia({ composition, serveUrl, codec: "h264", outputLocation: out, inputProps: props, muted: true, crf: 18, x264Preset: "veryfast",
          imageFormat: "jpeg", jpegQuality: 92, concurrency, overwrite: true, puppeteerInstance, cancelSignal, ...extra });
      })()]);
    } catch (e) {
      err = late ? `sahne ${Math.round(budget / 1000)} sn'de çizilemedi (süre sınırı)` : e.message;
      try { await browser?.close({ silent: true }); } catch { /* zaten kapanmış */ }
      browser = null;
      if (late) { rmSync(out, { force: true }); break; } // yarım dosya kalmasın; aynı sahne yeniden denenmez
    } finally {
      clearTimeout(timer);
    }
  }
  results[j.out] = ok(out) ? "ok" : "hata: " + (prep || err || "çıktı yok").slice(0, 200);
  console.error(`  sahne ${k + 1}/${jobs.length}: ${results[j.out]} (${props.seconds} sn, ${((Date.now() - t0) / 1000).toFixed(1)} sn sürdü)`);
}
try { await browser?.close({ silent: true }); } catch { /* kapanırken hata sonucu değiştirmez */ }
console.log(JSON.stringify({ ok: Object.values(results).every((r) => r === "ok"), results }));
