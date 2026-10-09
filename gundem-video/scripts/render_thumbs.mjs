// Kapakları tek seferde render eder: proje bir kez paketlenir, her kapak ayrı karede çizilir.
// Kullanım: node scripts/render_thumbs.mjs work/thumb_jobs.json
//   jobs: [{ "id": "Thumb" | "ThumbWide", "out": "out/....jpg", "props": {...} }]
// Her kapak en çok 3 kez denenir; çıktı dosyası yoksa ya da boşsa başarısız sayılır. Sonuç JSON olarak stdout'a.
import { bundle } from "@remotion/bundler";
import { renderStill, selectComposition } from "@remotion/renderer";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const jobs = JSON.parse(readFileSync(process.argv[2], "utf8"));
const browserExecutable = process.env.PUPPETEER_EXECUTABLE_PATH || null;
const extra = browserExecutable ? { browserExecutable, chromeMode: "chrome-for-testing" } : {};
const ok = (f) => existsSync(f) && statSync(f).size > 10000;

const results = {};
let serveUrl;
try {
  serveUrl = await bundle({ entryPoint: path.join(ROOT, "src/index.ts"), publicDir: path.join(ROOT, "public") });
} catch (e) {
  console.log(JSON.stringify({ ok: false, error: "paketleme: " + e.message }));
  process.exit(1);
}
for (const j of jobs) {
  const out = path.resolve(ROOT, j.out);
  let err = "";
  for (let attempt = 1; attempt <= 3 && !ok(out); attempt++) {
    try {
      const composition = await selectComposition({ serveUrl, id: j.id, inputProps: j.props, ...extra });
      await renderStill({ composition, serveUrl, output: out, inputProps: j.props, imageFormat: "jpeg", jpegQuality: 92, overwrite: true, ...extra });
    } catch (e) { err = e.message; }
  }
  results[j.out] = ok(out) ? "ok" : "hata: " + err.slice(0, 200);
}
console.log(JSON.stringify({ ok: Object.values(results).every((r) => r === "ok"), results }));
