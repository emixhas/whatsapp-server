// Instagram trendlerinden otomatik üretim ve çok izlenme uyarısı (kullanıcı isteği, 20 Ekim: "trend videolardan da otomatik üretelim, yeni
// düşerse hemen onu da üretelim, buton olsun iptal de edebilelim; yeni trend düşerse anında listeme girsin; çok aşırı bir izlenme varsa
// WhatsApp'tan göndersin, ben ona tekrar linki atar üretirim" — 18 Ekim'deki "yalnız panelde, otomatik üretim yok, WhatsApp yok" kararının
// yerine). Her taramadan sonra (server.js igTrendsScan → afterScan):
// 1) 🆕: listede ilk kez görülen gönderiler (kart rozeti); SSE "igtrends" kartı yeniler.
// 2) otomatik üretim (settings.igTrends.autoProduce, varsayılan açık): İLK KEZ trend olan video, autoMaxAgeHours'tan (24) genç, listedeki
//    sırayla (kat, hız), taramada en çok autoPerScan (2), günde en çok autoMaxPerDay (6; data/ig_trends_auto.json; sahibin seçtikleri
//    sayılmaz) → video kuyruğuna "trend-auto" (türüne Claude karar verir). Geriye dönük üretim yok: güncellemeden ya da anahtar açıldıktan
//    sonraki ilk tarama listedekileri görüldü sayar. Atlananlar tek satır ("📈 trend otomatik üretilmedi: @hesap "…" — neden").
// 3) WhatsApp uyarısı (settings.igTrends.alert): izlenme ≥ views ya da kat ≥ ratio ve izlenme ≥ ratioMinViews olan gönderi bir kez (dosyada),
//    taramada tek kısa mesaj (en çok 3, numaralı), günde en çok maxPerDay gönderi.
// Numaralar: uyarıda ve "trendler"de gösterilen her gönderi 24 saat AYNI numarayı taşır (yeni gönderi en küçük boş numarayı alır; son
// gösterilişinden 24 saat geçerli): eski bir uyarıya "trend 1" yazmak sonraki mesajın 1'ini seçmesin (inceleme, 20 Ekim). Kayıt yalnız 24
// saati dolunca düşer (4. tur: 80 kayıtlık sınır 24 saati dolmamış numarayı boşaltıp başka gönderiye veriyordu); aynı gönderi bir listede
// iki kez yazılmaz. "trend 1 3" bu numaralarla seçer, yanıt seçilen gönderileri adıyla ve kuyruk numarasıyla (#7) yazar. 6. tur: liste ve uyarı
// satırları "T1)" (trend numarası; seçim *trend 1*), kuyruk numarası ayrı ve "#" ile ("⏳ sırada (#7)"): inceleme, 20 Ekim: "1)" ile "(#2)" karışıyordu.
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { normUrl, oneLine } from "./videoqueue.js";

export const AUTO_DEFAULTS = { autoProduce: true, autoMaxPerDay: 6, autoMaxAgeHours: 24, autoPerScan: 2,
  alert: { enabled: true, views: 1000000, ratio: 10, ratioMinViews: 100000, maxPerDay: 5 } };
const WEEK = 7 * 864e5, LIST_MS = 24 * 3600000;
const num = (v, d, lo, hi) => { const n = Number(v); return Math.min(hi, Math.max(lo, Number.isFinite(n) && v !== "" && v != null ? n : d)); };
export const trNum = (n) => (n >= 1e6 ? `${(n / 1e6).toLocaleString("tr-TR", { maximumFractionDigits: 1 })} Mn` : n >= 1e4 ? `${Math.round(n / 1e3).toLocaleString("tr-TR")} B` : Number(n || 0).toLocaleString("tr-TR"));
const ago = (ms, now = Date.now()) => { const h = (now - ms) / 36e5; return h < 1 ? `${Math.max(1, Math.round(h * 60))} dk önce` : h < 48 ? `${Math.round(h)} sa önce` : `${Math.round(h / 24)} gün önce`; };
const dayKey = (t = Date.now()) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };

export function makeTrendAuto({ DATA, push, settings, patchSettings, igtFile, igtDone, vq, dupCheck, dupWhy, resting, restInfo, restEnd, waEnabled, sendWA, sse, minRatio = () => 2 }) {
  const AUTO_FILE = path.join(DATA, "ig_trends_auto.json"), ALERT_FILE = path.join(DATA, "ig_trends_alert.json");
  const read = (p) => { try { const d = JSON.parse(readFileSync(p, "utf8")); return d && typeof d === "object" && !Array.isArray(d) ? d : null; } catch { return null; } };
  const write = (p, o) => { try { const tmp = p + ".tmp"; writeFileSync(tmp, JSON.stringify(o)); renameSync(tmp, p); } catch { /* yazılamadı */ } };
  const obj = (x) => (x && typeof x === "object" && !Array.isArray(x) ? x : {});
  function cfg() {
    const raw = obj(settings().igTrends), al = obj(raw.alert), d = AUTO_DEFAULTS, a = d.alert;
    return { autoProduce: raw.autoProduce !== false, autoMaxPerDay: num(raw.autoMaxPerDay, d.autoMaxPerDay, 0, 50), autoMaxAgeHours: num(raw.autoMaxAgeHours, d.autoMaxAgeHours, 1, 168),
      autoPerScan: num(raw.autoPerScan, d.autoPerScan, 0, 10),
      alert: { enabled: al.enabled !== false, views: num(al.views, a.views, 1000, 1e10), ratio: num(al.ratio, a.ratio, 1, 1000), ratioMinViews: num(al.ratioMinViews, a.ratioMinViews, 0, 1e10), maxPerDay: num(al.maxPerDay, a.maxPerDay, 0, 50) } };
  }
  const autoState = () => { const s = read(AUTO_FILE); return { fresh: !s, armed: !!s?.armed, seen: obj(s?.seen), first: obj(s?.first), newUrls: Array.isArray(s?.newUrls) ? s.newUrls : [], lastScanAt: s?.lastScanAt || null, days: obj(s?.days) }; };
  // ilk çalışma bayrağı (primed) yalnız alertCheck'te yazılır: "trendler" dosyayı önce yazsa da güncellemeden önceki çok izlenenler
  // bildirilmiş sayılır (inceleme, 20 Ekim)
  const alertState = () => { const s = read(ALERT_FILE); return { fresh: !(s?.primed || Object.keys(obj(s?.alerted)).length), primed: !!s?.primed, alerted: obj(s?.alerted), days: obj(s?.days), reg: Array.isArray(s?.reg) ? s.reg.filter((x) => x && x.url && Number(x.n) > 0) : [] }; };
  const saveAuto = (s) => { const { fresh, ...rest } = s; write(AUTO_FILE, rest); };
  const saveAlert = (s) => { const { fresh, ...rest } = s; if (!rest.primed) delete rest.primed; write(ALERT_FILE, rest); };
  // numaralı gönderi kaydı: 24 saattir gösterilmeyen düşer (yalnız böyle: canlı numara başka gönderiye verilmez); gönderi zaten kayıtlıysa
  // numarası korunur (gösterilme anı yenilenir), yeni gönderi en küçük boş numarayı alır
  const regLive = (st) => (st.reg = st.reg.filter((x) => Date.now() - Number(x.at || 0) <= LIST_MS));
  function regNum(st, it) {
    const live = regLive(st), k = normUrl(it.url), f = live.find((x) => normUrl(x.url) === k);
    if (f) { Object.assign(f, pick(it), { n: f.n, at: Date.now() }); return f.n; }
    let n = 1; const used = new Set(live.map((x) => Number(x.n))); while (used.has(n)) n++; // en küçük boş numara (24 saati dolan numara yeniden kullanılır)
    live.push({ ...pick(it), n, at: Date.now() }); st.reg = live; return n;
  }
  const who = (it) => (it.account ? `@${it.account}` : it.source || "Instagram");
  const cap = (it, n = 60) => oneLine(String(it.caption || "").replace(/\n+/g, " "), n);
  const autoToday = (s) => (Array.isArray(s.days[dayKey()]) ? s.days[dayKey()].length : 0);

  // kart: 🆕 (son taramada ilk kez görüldü) + kuyruktaki yeri; durum dosyası istek başına bir kez okunur
  function marker() {
    const fresh = new Set(autoState().newUrls);
    return (it) => ({ isNew: fresh.has(it.url), inQueue: vq.positionOf(it.url) || null });
  }

  async function afterScan(r) {
    try {
      if (!r?.ok || !Array.isArray(r.items)) return;
      const now = Date.now(), items = r.items.filter((x) => x && x.url), c = cfg(), st = autoState();
      // 1) 🆕 rozeti: listede ilk kez görülenler (ilk işlemede rozet yok)
      for (const [k, t] of Object.entries(st.first)) if (now - Number(t) > WEEK) delete st.first[k];
      st.newUrls = st.fresh ? [] : items.filter((x) => !st.first[x.url]).map((x) => x.url);
      for (const x of items) st.first[x.url] ||= now;
      for (const [k, t] of Object.entries(st.seen)) if (now - Number(t) > WEEK) delete st.seen[k];
      const trends = items.filter((x) => x.trend);
      const fresh = trends.filter((x) => !st.seen[x.url]);
      for (const x of trends) st.seen[x.url] ||= now;
      st.lastScanAt = r.at || now;
      const cut = dayKey(now - WEEK);
      for (const k of Object.keys(st.days)) if (k < cut) delete st.days[k];
      // 2) otomatik üretim
      const queued = [];
      if (!c.autoProduce) st.armed = false; // kapalıyken görülenler işaretlenir; açıldıktan sonraki ilk tarama yine yalnız işaretler
      else if (!st.armed) {
        st.armed = true;
        push(`📈 trend otomatik üretimi devrede: listedeki ${trends.length} trend görüldü sayıldı (geriye dönük üretilmez); bundan sonra yeni düşen trend videolar kendiliğinden sıraya alınır`);
      } else if (fresh.length) {
        const skip = (it, why) => push(`📈 trend otomatik üretilmedi: ${who(it)} "${cap(it, 50)}" — ${why}`);
        const done = igtDone(), cands = [];
        for (const it of fresh) {
          const ageH = it.takenAt ? (now - Number(it.takenAt)) / 36e5 : Number(it.ageH) || 0;
          if (!waEnabled()) skip(it, "videodan haber yapma kapalı (Ayarlar → 📡 Otomatik içerikler)");
          else if (resting() && restInfo().reason === "elle durduruldu") skip(it, "sistem elle durduruldu (⏸)");
          else if (ageH > c.autoMaxAgeHours) skip(it, `${Math.round(ageH)} saat önce paylaşılmış (en çok ${c.autoMaxAgeHours} saat)`);
          else if (done[it.url] || Object.keys(done).some((u) => normUrl(u) === normUrl(it.url))) skip(it, `bu gönderiden daha önce video hazırlandı (${(done[it.url] || {}).state || "kayıtlı"})`);
          else if (vq.has(it.url)) skip(it, "zaten video kuyruğunda");
          else cands.push(it);
        }
        let n = 0;
        const dc = cands.length ? await dupCheck(cands.map((it) => { const t = String(it.caption || "").replace(/[#@][\w.]+/g, " ").replace(/\s+/g, " ").trim(); const head = t.split(/(?<=[.!?])\s|\s[|•–—]\s/)[0].slice(0, 160); return { title: head, text: t.slice(head.length), url: it.url }; })).catch(() => []) : [];
        for (const [i, it] of cands.entries()) {
          if (dc[i]?.dup) { skip(it, dupWhy(dc[i].match)); continue; }
          if (n >= c.autoPerScan) { skip(it, `tarama başına en çok ${c.autoPerScan} video`); continue; }
          if (autoToday(st) >= c.autoMaxPerDay) { skip(it, `günlük sınır (${c.autoMaxPerDay}) doldu`); continue; }
          const r2 = vq.add({ url: it.url, instruction: "", kind: "", mode: "haber", source: "trend-auto", account: it.account, caption: it.caption, trend: true });
          if (!r2.ok) { skip(it, r2.error); continue; }
          n++; queued.push(it.url);
          (st.days[dayKey()] ||= []).push({ url: it.url, at: now });
          const ratio = it.ratio >= minRatio() ? ` (hesabın ${Number(it.ratio).toLocaleString("tr-TR", { maximumFractionDigits: 1 })} katı)` : it.fast ? " (hızla yükseliyor)" : "";
          push(`🤖 Instagram trendi otomatik sıraya alındı (#${r2.no}${r2.queued ? `; önünde ${r2.ahead} video` : ""}): ${who(it)} "${cap(it, 50)}" ${it.metric === "views" ? `${trNum(it.views)} izlenme` : `${trNum(it.likes)} beğeni`}${ratio}`);
          if (resting() && restInfo().reason !== "elle durduruldu") restEnd(`Instagram'da yeni trend: ${who(it)} "${cap(it, 40)}"`);
        }
      }
      saveAuto(st);
      // 3) WhatsApp uyarısı
      await alertCheck(items, c, queued).catch((e) => push(`🔥 çok izlenme uyarısı: ${e.message}`));
    } finally { try { sse("igtrends", { at: r?.at || Date.now(), ok: !!r?.ok }); } catch { /* panel bağlı değil */ } }
  }

  // satır: 1) @hesap "başlık" — 2,3 Mn izlenme · hesabın 12 katı · 3 sa önce
  const line = (it, n, now) => {
    const m = it.views != null ? `${trNum(it.views)} izlenme` : `${trNum(it.likes)} beğeni`;
    const k = it.ratio >= minRatio() ? ` · hesabın ${Number(it.ratio).toLocaleString("tr-TR", { maximumFractionDigits: 1 })} katı` : "";
    return `T${n}) ${who(it)}${cap(it) ? ` "${cap(it)}"` : ""} — ${m}${k}${it.takenAt ? ` · ${ago(it.takenAt, now)}` : ""}`;
  };
  // kuyruktaki / üretilmiş gönderinin durumu (uyarı ve liste satırında; yoksa "")
  const status = (it, done) => {
    const q = vq.positionOf(it.url);
    if (q) return q.queued ? (vq.has(it.url)?.source === "trend-auto" ? `🤖 otomatik sıraya alındı (#${q.no})` : `⏳ sırada (#${q.no})`) : `⏳ hazırlanıyor (#${q.no})`;
    const d = done[it.url];
    // 7. tur (inceleme, 21 Ekim: "✓ video hazırlandı" satırı videonun numarasını yazmıyordu): kuyruğun üretim eşlemesinden numara ve onay durumu
    if (d?.state === "üretildi") { let x = null; try { x = vq.doneOf?.(it.url) || null; } catch { x = null; } return x ? `✓ video hazır (#${x.no}${x.pending ? ", onay bekliyor" : ""})` : "✓ video hazırlandı"; }
    return "";
  };
  const howTo = (nums, link = true) => (nums.length ? `Üretmek için: *trend ${nums[0]}*${nums.length > 1 ? ` (birkaçı: *trend ${nums.slice(0, 2).join(" ")}*)` : ""}${link ? " ya da linki gönderin." : ""}` : "");
  async function alertCheck(items, c, justQueued = []) {
    const a = c.alert, st = alertState(), now = Date.now();
    for (const [k, t] of Object.entries(st.alerted)) if (now - Number(t) > 60 * 864e5) delete st.alerted[k];
    const cut = dayKey(now - WEEK);
    for (const k of Object.keys(st.days)) if (k < cut) delete st.days[k];
    const seenU = new Set();
    const hot = items.filter((it) => it.views != null && (it.views >= a.views || (it.ratio != null && it.ratio >= a.ratio && it.views >= a.ratioMinViews)) && !st.alerted[normUrl(it.url)] && !seenU.has(normUrl(it.url)) && seenU.add(normUrl(it.url)))
      .sort((x, y) => y.views - x.views);
    if (st.fresh) { // ilk çalışmada listedekiler bildirilmiş sayılır (güncellemeden sonra eski gönderiler için mesaj yağmasın)
      for (const it of hot) st.alerted[normUrl(it.url)] = now;
      st.primed = true; saveAlert(st); return;
    }
    st.primed = true;
    if (!hot.length || !a.enabled || settings().whatsapp?.enabled === false) { if (hot.length && !a.enabled) { /* kapalı: işaretlenmez, açılınca bildirilir */ } saveAlert(st); return; }
    // taramada en çok 3 (kalanlar sonraki taramada); günlük sınır dolduysa kalanlar bir daha bildirilmez (geç uyarı işe yaramaz)
    const left = Math.max(0, a.maxPerDay - (Number(st.days[dayKey()]) || 0));
    const send = hot.slice(0, Math.min(3, left));
    if (left - send.length <= 0) for (const it of hot.slice(send.length)) { st.alerted[normUrl(it.url)] = now; push(`🔥 çok izlenen trend WhatsApp'a bildirilmedi: ${who(it)} "${cap(it, 40)}" — günlük sınır (${a.maxPerDay}) doldu`); }
    if (!send.length) { saveAlert(st); return; }
    const done = igtDone(), act = [], nums = send.map((it) => regNum(st, it));
    const lines = send.map((it, i) => { const s = status(it, done); if (!s) act.push(nums[i]); return `${line(it, nums[i], now)}${s ? ` · ${s}` : ""}\n${it.url}`; });
    const msg = `🔥 Çok izleniyor:\n${lines.join("\n")}${act.length ? `\n${howTo(act)}` : ""}`;
    for (const it of send) st.alerted[normUrl(it.url)] = now;
    st.days[dayKey()] = (Number(st.days[dayKey()]) || 0) + send.length;
    saveAlert(st);
    await sendWA(msg);
    push(`🔥 çok izlenen trend WhatsApp'a bildirildi: ${send.map((it) => who(it)).join(", ")}${justQueued.length ? ` (${send.filter((it) => justQueued.includes(it.url)).length} tanesi otomatik sırada)` : ""}`);
  }
  const pick = (it) => ({ url: it.url, account: it.account || null, source: it.source || null, caption: cap(it, 160), views: it.views ?? null, likes: it.likes ?? null, ratio: it.ratio ?? null, takenAt: it.takenAt || null, metric: it.metric || null });

  // WhatsApp: "trendler" (numaralı en çok 10), "trend 1 3", "trend otomatiğini aç/kapat"
  function trendsText() {
    const d = read(igtFile) || {}, seenU = new Set(), now = Date.now(), c = cfg();
    // aynı gönderi (reel/p/tv, paylaşım eki) listede bir kez: iki satır aynı numarayı yazmasın
    const items = (Array.isArray(d.items) ? d.items : []).filter((x) => x?.url && !seenU.has(normUrl(x.url)) && seenU.add(normUrl(x.url))).slice(0, 10);
    if (!items.length) return { reply: `📈 Henüz trend listesi yok${d.lastTry ? ` (son deneme ${new Date(d.lastTry).toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" })}${d.error ? `: ${oneLine(d.error, 80)}` : ""})` : ""}. Panelde 📈 INSTAGRAM TRENDLERİ → 🔄 Şimdi tara.` };
    const done = igtDone(), act = [], st = alertState(), nums = items.map((it) => regNum(st, it)); saveAlert(st);
    // satırlar numara sırasıyla (5. tur, inceleme, 20 Ekim: uyarıların ayırdığı numaralarla puan sırası "1) 3) 4) 5) 2)" diye karışıyordu)
    const order = items.map((it, i) => i).sort((a, b) => nums[a] - nums[b]);
    const lines = order.map((i) => { const it = items[i], s = status(it, done); if (!s) act.push(nums[i]); return `${line(it, nums[i], now).replace(/^(T\d+\)) /, `$1 ${it.trend ? "🔥 " : ""}`)}${s ? ` · ${s}` : ""}\n${it.url}`; });
    const at = d.at ? new Date(d.at).toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" }) : "—";
    return { reply: `📈 *Instagram trendleri* (son tarama ${at} · otomatik üretim ${c.autoProduce ? "açık" : "kapalı"})\n${lines.join("\n")}${act.length ? `\n${howTo(act, false)}` : ""}`, full: true };
  }
  // "trend 1 3" (news: "trend 2 haber yap" → haber olarak, trend kartının "🎬 Haber yap"ı gibi; yoksa türüne Claude karar verir)
  function pickFromList(nums, source = "whatsapp", { news = false } = {}) {
    const live = regLive(alertState());
    if (!live.length) return { reply: "Son trend listesi yok ya da 24 saatten eski; güncel liste için *trendler* yazın." };
    const unknown = [], specs = [], names = [];
    for (const n of nums) { const it = live.find((x) => Number(x.n) === n); if (!it) unknown.push(n); else { specs.push({ url: it.url, instruction: "", kind: news ? "haber" : "", mode: "haber", source, account: it.account, caption: it.caption, trend: true }); names.push(`trend ${n}`); } }
    const unk = unknown.length ? `${unknown.join(", ")}: son trend listelerinde yok (numaralar son gösterilişten 24 saat geçerli); güncel liste için *trendler* yazın.` : "";
    if (!specs.length) return { reply: unk };
    const res = vq.addBatch(specs).map((r, i) => ({ ...r, name: names[i] }));
    push(`📈 ${source === "whatsapp" ? "WhatsApp'tan" : "panelden"} trend seçildi: ${names.join(", ")}${news ? " (haber olarak)" : ""}`);
    return { reply: vq.batchReply(res, { src: source, extra: unk ? [unk] : [] }), full: true }; // satır satır gönderiler: kısa mesaj modunda kesilmez
  }
  // açma yalnız kapalıdan açığa geçişte yeniden kurar (sonraki tarama listedekileri görüldü sayar); zaten açıkken dokunulmaz (inceleme, 20 Ekim:
  // "aç" yeniden yazılınca sonraki taramanın yeni trendleri üretilmeden görüldü sayılıyordu). Kapatma kuyrukta bekleyen otomatik işleri de çıkarır.
  function setAuto(on) {
    const c0 = cfg();
    if (on && c0.autoProduce) return `🤖 Trend otomatik üretimi zaten açık (bugün ${autoToday(autoState())}/${c0.autoMaxPerDay} video): yeni düşen trend videolar kendiliğinden sıraya alınır. Kapatmak için: *trend otomatiğini kapat*`;
    patchSettings({ igTrends: { autoProduce: !!on } });
    let d = { removed: 0, current: null };
    if (on) { const st = autoState(); st.armed = false; saveAuto(st); } else d = vq.dropAuto("trend otomatik üretimi kapatıldı");
    push(`📈 trend otomatik üretimi ${on ? "açıldı (sonraki taramada listedekiler görüldü sayılır, sonra yeni düşenler üretilir)" : c0.autoProduce ? "kapatıldı" : "zaten kapalıydı"}${d.removed ? `; kuyrukta bekleyen ${d.removed} otomatik video çıkarıldı` : ""}`);
    try { sse("igtrends", { at: Date.now(), auto: !!on }); } catch { /* yok */ }
    const c = cfg();
    return on ? `🤖 Trend otomatik üretimi açık: yeni düşen trend videolar kendiliğinden sıraya alınır (taramada en çok ${c.autoPerScan}, günde en çok ${c.autoMaxPerDay}; yayın yine onayınıza gelir). Kapatmak için: *trend otomatiğini kapat*`
      : `⏸ Trend otomatik üretimi ${c0.autoProduce ? "kapatıldı" : "zaten kapalı"}; trendler yine listede görünür, seçtiklerinizi *trend 1 3* ile üretebilirsiniz.`
        + (d.removed ? ` Kuyrukta bekleyen ${d.removed} otomatik video da çıkarıldı.` : "")
        + ((d.active || []).length ? ` Süren otomatik ${d.active.length > 1 ? "videolar" : "video"}: ${d.active.map((a) => `#${a.no} ${["üretiliyor", "sırada üretim"].includes(a.step) ? a.stepText : "hazırlanıyor"} (${a.label}) → iptal: *#${a.no} iptal*`).join(" · ")}.` : "");
  }
  // videoqueue.handleText'in trend komutları. autoAsk: "trend" geçen ama ne istendiği açık olmayan aç/kapat mesajı ("trendleri kapat",
  // "trend otomatiğini kapatma"): hiçbir şey değişmez, durum ve komut yazılır (5 saatlik üretim zamanlayıcısına dokunulmaz)
  async function command(qc, source) {
    if (qc.kind === "trends") return trendsText();
    if (qc.kind === "autoAsk") { const c = cfg(); return { reply: `🤖 Trend videolarının otomatik üretimi şu an ${c.autoProduce ? "açık" : "kapalı"}; hiçbir şey değiştirmedim. ${c.autoProduce ? "Kapatmak için: *trend otomatiğini kapat*" : "Açmak için: *trend otomatiğini aç*"}. Trend listesi: *trendler*, seçip üretmek: *trend 1 3*. (Bu mesaj 5 saatlik üretim zamanlayıcısına dokunmadı; onun için *otomatik aç* / *otomatik kapat*.)` }; }
    if (qc.kind === "pick") return pickFromList(qc.nums, source, { news: !!qc.news });
    if (qc.kind === "auto") {
      if (qc.on == null) { const c = cfg(), s = autoState(); return { reply: `🤖 Trend otomatik üretimi ${c.autoProduce ? "açık" : "kapalı"}: bugün ${autoToday(s)}/${c.autoMaxPerDay} video, taramada en çok ${c.autoPerScan}, ${c.autoMaxAgeHours} saatten genç trendler. ${c.autoProduce ? "Kapatmak için: *trend otomatiğini kapat*" : "Açmak için: *trend otomatiğini aç*"}` }; }
      return { reply: setAuto(qc.on) + (qc.sched ? ` (5 saatlik üretim zamanlayıcısına dokunmadım; onun için *otomatik ${qc.on ? "aç" : "kapat"}* yazın.)` : "") };
    }
    return null;
  }
  const todayCount = () => autoToday(autoState());
  return { cfg, afterScan, marker, command, setAuto, trendsText, pickFromList, todayCount, alertCheck };
}
