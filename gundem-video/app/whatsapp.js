// WhatsApp köprüsü (Baileys, WhatsApp Web protokolü). Panelden QR okutulur; yalnızca sahip numarası komut verebilir.
// Video bitince: metin + izleme linkleri + (isteğe bağlı) video dosyası gönderir; "onay" gelince yayınlar.
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import QRCode from "qrcode";
import { HELP_TEXT } from "./help.js";
import { whenLabel } from "./when.js";

export async function makeWhatsApp({ handleVideo = null, videoInstruction = null, autoAll = () => false, automode = async () => ({ ok: false, error: "yok" }), statusText = async () => "durum yok", ROOT, settings, push, announce, handleCommand, publishVideo, videoInfo, links }) {
  const AUTH_DIR = path.join(ROOT, "secrets", "wa-auth");
  const st = { status: "disconnected", qr: null, qrSvg: null, phone: null, error: null, pending: null, lastMsgAt: null, retries: 0 };
  let sock = null, stopping = false, baileys = null;

  const digits = (s) => String(s || "").replace(/\D/g, "");
  const ownerDigits = () => { let d = digits(settings().whatsapp?.owner); if (d.startsWith("0")) d = "90" + d.slice(1); return d; };
  const ownerJid = () => `${ownerDigits()}@s.whatsapp.net`;
  const isOwner = (jid) => { if (!jid || String(jid).endsWith("@lid")) return false; const d = digits(jid); const o = ownerDigits(); return !!o && d.length >= 10 && (d === o || d.endsWith(o.slice(-10))); };
  // WhatsApp yeni "LID" kimliği: 1'e 1 sohbette remoteJid "…@lid" gelir, telefon numarası key.senderPn'dedir. Sahibin
  // LID'i ilk eşleşmede öğrenilir (settings.whatsapp.ownerLid değil, bellekte + data'ya yazılmaz; her açılışta yeniden).
  const knownOwnerLids = new Set();
  const lidKey = (j) => digits(String(j || "").split("@")[0].split(":")[0]);
  const sentIds = new Set(); // kendi gönderdiğimiz mesajlar: kendine-mesaj sohbetinde komut sanılmasın (döngü engeli)
  const selfPhone = () => digits(sock?.user?.id?.split(":")[0]);
  const selfLid = () => digits(sock?.user?.lid?.split(":")[0]);
  const isSelfChat = (jid) => { const d = digits(String(jid || "").split("@")[0].split(":")[0]); return !!d && (d === selfPhone() || (!!selfLid() && d === selfLid())); };
  let lastIgnoredLog = 0, ownerLidFor = "";
  async function learnOwnerLid() { // sahibin telefon numarasından LID'i (WhatsApp sorgusu); sahip değişirse yeniden
    const o = ownerDigits(); if (!o || !sock || ownerLidFor === o) return;
    try { const r = await sock.onWhatsApp(ownerJid()); const l = digits(String(r?.[0]?.lid || "").split("@")[0].split(":")[0]); if (l) { knownOwnerLids.add(l); ownerLidFor = o; } } catch { /* sorgu başarısız: senderPn ile öğrenilir */ }
  }

  async function start() {
    if (sock || stopping) return status();
    try { baileys = baileys || await import("@whiskeysockets/baileys"); } catch (e) { st.error = "Baileys yüklü değil: npm install"; return status(); }
    const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = baileys;
    const pino = (await import("pino")).default;
    mkdirSync(AUTH_DIR, { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    let version; try { ({ version } = await fetchLatestBaileysVersion()); } catch { version = undefined; }
    sock = makeWASocket({ auth: state, version, logger: pino({ level: "silent" }), browser: ["Emixhas", "Chrome", "4.0.0"], printQRInTerminal: false, markOnlineOnConnect: false });
    st.status = "connecting"; st.error = null; st.connectingSince = Date.now(); st.userStopped = false;
    sock.ev.on("creds.update", saveCreds);
    const me = sock; // eski soketin geç gelen olayları (bekçi yenisini kurduktan sonra) yeni bağlantıyı bozmasın
    sock.ev.on("connection.update", async (u) => {
      if (me !== sock) return;
      if (u.qr) { st.qr = u.qr; st.qrSvg = await QRCode.toString(u.qr, { type: "svg", margin: 1, color: { dark: "#FFFFFF", light: "#00000000" } }); st.status = "qr"; push("💬 WhatsApp: QR hazır, panelden telefonunuzla okutun"); }
      if (u.connection === "open") {
        st.status = "connected"; st.qr = st.qrSvg = null; st.retries = 0; st.connectingSince = null; st.lastOkAt = Date.now(); st.probeFails = 0;
        st.phone = digits(sock.user?.id?.split(":")[0]); push(`💬 WhatsApp bağlandı: +${st.phone}`); announce("WhatsApp bağlandı.");
        setTimeout(() => learnOwnerLid(), 3000); setTimeout(() => flushOutbox().catch(() => {}), 5000);
      }
      if (u.connection === "close") {
        const code = u.lastDisconnect?.error?.output?.statusCode;
        sock = null; st.status = "disconnected";
        if (code === DisconnectReason.loggedOut) { st.error = "Oturum kapatıldı; yeniden QR gerekir"; rmSync(AUTH_DIR, { recursive: true, force: true }); push("💬 WhatsApp oturumu kapandı (telefondan çıkış yapılmış)"); return; }
        if (!stopping && st.retries++ < 8) { push(`💬 WhatsApp bağlantısı koptu (kod ${code}), yeniden deneniyor`); setTimeout(start, 3000 * st.retries); }
      }
    });
    sock.ev.on("messages.upsert", async ({ messages, type }) => {
      for (const m of messages) {
        if (!m.message || sentIds.has(m.key.id)) continue;
        const from = m.key.remoteJid || ""; const k = m.key;
        if (from.endsWith("@g.us") || from.endsWith("@broadcast") || from.endsWith("@newsletter")) continue; // gruplar, durumlar
        const selfChat = isSelfChat(from);
        // bağlı numaranın başka sohbetlere yazdıkları komut değildir; kendine-mesaj sohbetinde yazılanlar komuttur
        if (k.fromMe && !selfChat) continue;
        // telefondan kendine yazılan mesaj "append" gelebilir; eski geçmiş (5 dk'dan eski) işlenmez
        if (type !== "notify" && !(k.fromMe && selfChat)) continue;
        const ts = Number(m.messageTimestamp || 0) * 1000; if (ts && Date.now() - ts > 5 * 60000) continue;
        const pnCands = [from, k.participant, k.senderPn, k.participantPn].filter(Boolean);
        const lid = [from, k.senderLid, k.participantLid].find((j) => String(j || "").endsWith("@lid"));
        if (lid && !knownOwnerLids.has(lidKey(lid))) await learnOwnerLid();
        let owner = selfChat || pnCands.some(isOwner) || (!!lid && knownOwnerLids.has(lidKey(lid)));
        if (owner && lid && !selfChat) knownOwnerLids.add(lidKey(lid));
        // video: doğrudan, belge olarak ya da süreli/tek görümlük mesaj içinde gelebilir
        const inner = m.message.ephemeralMessage?.message || m.message.viewOnceMessage?.message || m.message.viewOnceMessageV2?.message || m.message.documentWithCaptionMessage?.message || m.message;
        const vm = inner.videoMessage || (String(inner.documentMessage?.mimetype || "").startsWith("video/") ? inner.documentMessage : null);
        const text = (inner.conversation || inner.extendedTextMessage?.text || inner.imageMessage?.caption || vm?.caption || "").trim();
        if (!owner) {
          if (text && Date.now() - lastIgnoredLog > 60000) {
            lastIgnoredLog = Date.now();
            const who = digits(k.senderPn || k.participantPn || from); const o = ownerDigits();
            push(`💬 WhatsApp: sahip olmayan göndericiden mesaj yok sayıldı (…${who.slice(-4)}${from.endsWith("@lid") && !k.senderPn ? ", numara gizli (LID)" : ""}); sahip numarası ${o ? "…" + o.slice(-4) : "AYARLANMAMIŞ"} — yanlışsa Ayarlar → WhatsApp → sahip numarası`);
            st.lastIgnored = { at: Date.now(), from: "…" + who.slice(-4), lid: !!lid && !k.senderPn };
          }
          continue;
        }
        if (!text && !vm) continue;
        st.lastMsgAt = Date.now();
        // yanıt: kendine-mesajsa kendi numaramıza, değilse sahibin telefon numarasına (LID adresine değil)
        const replyTo = selfChat ? `${selfPhone()}@s.whatsapp.net` : (pnCands.find(isOwner) && !String(pnCands.find(isOwner)).endsWith("@lid") ? `${digits(pnCands.find(isOwner))}@s.whatsapp.net` : ownerJid());
        if (vm && handleVideo) { // sahibin gönderdiği video: indir, açıklaması haber talimatıdır (yoksa sorulur)
          try { await onOwnerVideo(replyTo, { ...m, message: inner }, vm, text); } catch (e) { push(`✖ WhatsApp videosu alınamadı: ${e.message}`); try { await send(replyTo, `Video alınamadı: ${e.message}`); } catch { /* bağlantı yok */ } }
          continue;
        }
        if (!text) continue;
        push(`💬 WhatsApp'tan: ${text.slice(0, 80)}`);
        try { await onOwnerMessage(replyTo, text); } catch (e) { push(`✖ WhatsApp komutu: ${e.message}`); try { await send(replyTo, `Hata: ${e.message}`); } catch { /* bağlantı yok */ } }
      }
    });
    return status();
  }

  async function onOwnerVideo(jid, msg, vm, caption) {
    const mb = Number(vm.fileLength || 0) / 1048576;
    if (mb > 500) { await send(jid, `Video çok büyük (${Math.round(mb)} MB); en çok 500 MB gönderin.`); return; }
    const dir = path.join(ROOT, "work", "wa_inbox"); mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${Date.now()}-${String(msg.key.id || "v").replace(/[^\w-]/g, "").slice(0, 24)}.mp4`);
    push(`🎬 WhatsApp'tan video geliyor (${mb ? mb.toFixed(1) + " MB" : "boyut bilinmiyor"}${vm.seconds ? `, ${vm.seconds} sn` : ""})${caption ? `: ${caption.slice(0, 80)}` : ""}`);
    const pino = (await import("pino")).default;
    const stream = await baileys.downloadMediaMessage(msg, "stream", {}, { logger: pino({ level: "silent" }), reuploadRequest: sock.updateMediaMessage });
    await pipeline(stream, createWriteStream(file));
    const r = await handleVideo({ file, caption, seconds: vm.seconds || null });
    if (r) await send(jid, r);
  }

  async function onOwnerMessage(jid, text) {
    const t = text.toLocaleLowerCase("tr-TR").trim();
    if (st.pending && Date.now() - st.pending.at > 6 * 3600 * 1000) { st.pending = null; }  // eski onay isteği düşer
    if (/^(otomatik|tam otomatik)( mod)?u? (aç|başlat|kapat|durdur)/.test(t)) { const on = /(aç|başlat)/.test(t); const r = await automode(on); await send(jid, r.ok ? (on ? `⚡ Tam otomatik mod açık: her ${r.hours} saatte üretim, otomatik yayın → ${r.connected.join(", ") || "bağlı hesap yok"}.` : "⏹ Otomatik üretim ve yayın durduruldu.") : `Olmadı: ${r.error}`); return; }
    // Yayın onayı (kullanıcı isteği: "onay yazarsam tüm platformlarda, onay insta yazarsam yalnız Instagram'da paylaşsın"):
    // "onay" / "onay hepsi" → bekleyen tüm platformlar; "onay insta", "onay youtube tiktok", "insta onay", "sadece instagram" → yalnız
    // yazılanlar, kalanlar beklemede kalır (yalnız açık "onay …" ile yayınlanır; "tamam/evet" artık kalanları yayınlamaz).
    if (st.pending && !/(^|\s)sil/.test(t)) {  // "evet sil" = Instagram temizliği onayı
      const plats = pickPlatforms(t);
      const words = t.split(/\s+/).length;
      const approve = APPROVE.test(t) || (plats.length && words <= 6 && /(onay|yayınla|yayinla|paylaş|paylas|yükle|yukle)/.test(t)) || (plats.length && /^(sadece|yalnız|yalniz)\s/.test(t));
      if (approve && !(st.pending.partial && !plats.length && !/^(onay|onayla|yayınla|yayinla|paylaş|paylas)/.test(t))) {
        const p = st.pending;
        const chosen = plats.length ? p.platforms.filter((pl) => plats.includes(pl)) : p.platforms;
        const missing = plats.filter((pl) => !p.platforms.includes(pl));
        if (!chosen.length) { await send(jid, `${missing.map((pl) => PL[pl]).join(", ")}: bu video için bekleyen yayında yok (hesap bağlı değil ya da zaten yayında). Bekleyen: ${p.platforms.map((pl) => PL[pl]).join(", ")}`); return; }
        const rest = p.platforms.filter((pl) => !chosen.includes(pl));
        st.pending = rest.length ? { ...p, platforms: rest, partial: true, at: Date.now() } : null;
        await send(jid, `⏳ Yayınlanıyor: ${p.label} → ${chosen.map((pl) => PL[pl]).join(", ")}${missing.length ? `\n(${missing.map((pl) => PL[pl]).join(", ")} bekleyen listede yok)` : ""}`);
        const r = await publishVideo(p.video, chosen);
        const lines = Object.entries(r.results || {}).map(([k, v]) => v.ok ? `✅ ${PL[k] || k}: ${v.skipped ? "zaten yayında" : (v.url || v.note || "tamam")}${v.skipped ? "" : commentNote(k, v)}` : `❌ ${PL[k] || k}: ${v.error}`);
        if (rest.length) lines.push(`\n⏸ Beklemede: ${rest.map((pl) => PL[pl]).join(", ")} → ${rest.map((pl) => `*onay ${SHORT[pl]}*`).join(" · ")} · bırakmak için *iptal*`);
        await send(jid, lines.join("\n") || "Yayınlanacak platform yok.");
        return;
      }
    }
    if (st.pending && /^(hayır|iptal|yayınlama|vazgeç|no)(\s|$|[.,!])/.test(t)) { const p = st.pending; st.pending = null; await send(jid, `Tamam, ${p.label}${p.partial ? ` kalan platformlarda (${p.platforms.map((pl) => PL[pl]).join(", ")})` : ""} yayınlanmadı.`); return; }
    // talimatı bekleyen WhatsApp videosu: bu mesaj nasıl bir haber istendiğidir ("iptal" vazgeçer)
    if (videoInstruction) { const vr = await videoInstruction(text); if (vr) { if (typeof vr === "string") await send(jid, vr); return; } }
    if (/^(yardım|help|\?|komutlar|komut listesi|neler yapabilirsin)$/.test(t)) { await send(jid, HELP_TEXT); return; }
    if (/^(durum|status|ne var ne yok)$/.test(t)) { await send(jid, await statusText()); return; }
    if (/(son videoyu|videoyu) (gönder|yolla|at)/.test(t)) { const v = videoInfo(); if (!v) return send(jid, "Video yok."); await notifyVideo(v.name, { ask: false }); return; }
    const r = await handleCommand(text, { source: "whatsapp" });
    let reply = r.reply || "Tamam.";
    if (r.report) reply += "\n\n" + r.report.slice(0, 3500);
    if (r.pending?.length) { reply += "\n\n(Bu eylem panelden onay bekliyor.)"; }
    await send(jid, reply);
  }

  const remember = (r) => { if (r?.key?.id) { sentIds.add(r.key.id); if (sentIds.size > 500) sentIds.delete(sentIds.values().next().value); } return r; };
  // bağlantı koptuğunda gönderilemeyen metin mesajları kaybolmasın: kuyruğa girer (en çok 30, 12 saat), bağlanınca sırayla gider
  const outbox = [];
  async function send(jid, text) {
    if (!sock || st.status !== "connected") {
      if (outbox.length < 30) outbox.push({ jid, text, at: Date.now() });
      push(`💬 WhatsApp bağlı değil; mesaj kuyruğa alındı (${outbox.length} bekliyor), bağlantı gelince gönderilecek`);
      return;
    }
    remember(await sock.sendMessage(jid, { text }));
  }
  async function flushOutbox() {
    const items = outbox.splice(0).filter((x) => Date.now() - x.at < 12 * 3600000);
    if (!items.length) return;
    push(`💬 WhatsApp yeniden bağlandı: kuyruktaki ${items.length} mesaj gönderiliyor`);
    for (const x of items) { try { remember(await sock.sendMessage(x.jid, { text: x.text })); } catch { outbox.push(x); break; } }
  }
  async function sendLink(jid, url, title, description, thumb) {
    try {
      remember(await sock.sendMessage(jid, { text: `${title}\n${url}`, linkPreview: { "canonical-url": url, "matched-text": url, title, description, ...(thumb ? { jpegThumbnail: thumb } : {}) } }));
    } catch (e) { push(`💬 link gönderilemedi (${e.message}); düz metin deneniyor`); await send(jid, `${title}\n${url}`); }
  }
  async function sendVideo(jid, file, caption) {
    const size = statSync(file).size;
    if (size > 60 * 1024 * 1024) { await send(jid, `${caption}\n(Video 60 MB'den büyük, dosya gönderilmedi; linkten izleyin.)`); return null; } // null: metin olarak gitti
    remember(await sock.sendMessage(jid, { video: readFileSync(file), caption, mimetype: "video/mp4" }));
    return true;
  }

  /** Üretim bitince sahibine metin + linkler (+ dosya) gönderir ve onay bekler. */
  // Tek mesaj modunun yayın satırları (post_pipeline "📤 platform: …") → platform başına son durum, kısa
  const PL = { youtube: "YouTube", instagram: "Instagram", tiktok: "TikTok" };
  const SHORT = { youtube: "youtube", instagram: "insta", tiktok: "tiktok" };
  const APPROVE = /^(onay|onayla|evet|yayınla|yayinla|ok|tamam|paylaş|paylas)(\s|$|[.,!])/;
  // mesajdaki platform adları (Türkçe küçük harfte "Insta" → "ınsta" olur; ı → i ile bakılır)
  function pickPlatforms(t) {
    const x = ` ${t.replace(/ı/g, "i").replace(/[^a-zçğöşü0-9]+/g, " ")} `;
    const out = [];
    if (/ (youtube\w*|yutup\w*|yt|shorts) /.test(x)) out.push("youtube");
    if (/ (insta\w*|ig|reels?) /.test(x)) out.push("instagram");
    if (/ (tiktok\w*|tik tok\w*|tt) /.test(x)) out.push("tiktok");
    return out;
  }
  // ilk yorumun sonucu (kullanıcı isteği: "linkten gelen haberde de ilk yorum atsın"): yazıldı mı, yazılamadıysa neden
  const commentNote = (pl, v) => {
    if (pl === "tiktok") return "";  // TikTok API yorum yazmaya izin vermez
    if (v.firstComment) return "\n   💬 ilk yorum yazıldı";
    if (v.commentError) return /izni yok/.test(v.commentError)
      ? `\n   💬 ilk yorum yazılamadı: yorum izni yok → panelde ${PL[pl]} kartında 🔄 Yeniden bağla (izin gelince kendiliğinden yazılır)`
      : `\n   💬 ilk yorum yazılamadı (${String(v.commentError).slice(0, 80)}); 20 dk içinde yeniden denenecek`;
    return "";
  };
  // onay satırı: hepsi için "onay", tek platform için "onay insta" …
  const approveLine = (platforms) => `\n\n✅ Hepsinde yayınlamak için *onay* → ${platforms.map((pl) => PL[pl]).join(", ")}` +
    (platforms.length > 1 ? `\n▫️ Yalnız birinde: ${platforms.map((pl) => `*onay ${SHORT[pl]}*`).join(" · ")}` : "") + "\n❌ Yayınlamamak için *iptal*";
  function publishLines(summary) {
    const last = {}; const notes = [];
    for (const l of summary || []) {
      const m = l.match(/^📤 (youtube|instagram|tiktok): (.*)$/);
      if (m) { if (!/hesap bağlı değil/.test(m[2])) last[m[1]] = m[2]; continue; }
      if (/^📤 otomatik yayın yapılmadı/.test(l)) notes.push("ℹ️ " + l.replace(/^📤 /, "").replace(/\.? WhatsApp'tan "onay".*$/, ""));
    }
    const out = Object.entries(last).map(([pl, r]) => {
      const name = PL[pl];
      if (/^(tamam|zaten yayında)/.test(r)) { const url = (r.match(/https?:\/\/\S+/) || [""])[0]; return `✅ ${name}${/^zaten/.test(r) ? " (zaten yayında)" : ""}${url ? ": " + url : ""}`; }
      if (/^sınır doldu/.test(r)) return `⏳ ${name}: ${r.replace(/^sınır doldu\s*—?\s*/, "sınır doldu, sıraya alındı — ").slice(0, 160)}`;
      if (/^atlandı/.test(r)) return `⏭ ${name}: ${r.replace(/;.*$/, "").slice(0, 120)}`;
      return `❌ ${name}: ${r.replace(/^hata\s*/, "").slice(0, 160)}`;
    });
    return [...out, ...notes];
  }

  async function notifyVideo(name, { ask = true, summary = null } = {}) {
    const w = settings().whatsapp || {};
    if (!w.enabled) return { ok: false, error: "WhatsApp kapalı" };
    if (st.status !== "connected") { // bağlantı kopukken bildirim kaybolmasın: kısa metin kuyruğa girer, bağlanınca gider
      const v0 = videoInfo(name);
      const sched0 = v0?.publishAt && Date.parse(v0.publishAt) > Date.now();
      // linkten/görüntüden yapılan video onaysız yayınlanmaz: bağlantı gelince gidecek mesajda da onay sorulur
      let ask0 = "";
      if (v0 && ask && v0.userVideo && !sched0 && !settings().waVideo?.autoPublish) {
        try { const pl0 = (await links(name)).platforms.filter((pl) => !(v0.published || {})[pl]); if (pl0.length) { ask0 = approveLine(pl0); st.pending = { video: name, label: v0.label, platforms: pl0, at: Date.now() }; } } catch { /* hesap durumu okunamadı */ }
      }
      if (v0) await send(ownerJid(), `🎬 Yeni video hazır — ${v0.label}\n${v0.segments.filter((x) => x.kind === "haber").slice(0, 5).map((x) => `• ${x.title}`).join("\n")}` +
        (sched0 ? `\n⏰ Planlı yayın: ${whenLabel(new Date(v0.publishAt))}` : "") + "\n(WhatsApp bağlantısı koptuğu için video dosyası gönderilemedi; panelden izleyebilirsiniz.)" + ask0);
      return { ok: false, queued: true, error: "WhatsApp bağlı değil; bildirim kuyruğa alındı" };
    }
    const v = videoInfo(name); if (!v) return { ok: false, error: "video bulunamadı" };
    const L = await links(name);
    const head = `🎬 *Yeni video hazır* — ${v.label} (${v.duration ?? "?"} sn)`;
    const words = v.segments.map((s, i) => s.kind === "haber" ? `${i}. ${s.breaking ? "🔴 SON DAKİKA · " : ""}[${(s.category || "genel").toUpperCase()}] *${s.title}*\n${s.narration}` : `_${s.narration}_`).join("\n\n");
    const linkLines = "";
    const already = v.published || {};
    const ap = { ...(settings().autopublish || {}) };
    // anlık (son dakika) video: ayar açıksa bağlı tüm hesaplara onaysız yayınlanır (post_pipeline.py yapar)
    if (v.anlik && settings().anlikAutoPublish !== false) for (const pl of L.platforms) ap[pl] = true;
    // otomatik üretim / tam otomatik açıkken bağlı tüm hesaplar onaysız (post_pipeline.py aynı kuralı uygular)
    if (autoAll()) for (const pl of L.platforms) ap[pl] = true;
    // YouTube günlük sınırı: sıradan anlık haber YouTube'a otomatik gitmez (post_pipeline youtube_allowed); "onay" ile elle gider
    const yp = settings().youtubePolicy || {};
    if (v.anlik && yp.onlyValuable !== false && !v.value?.valuable) ap.youtube = false;
    // 5 saatlik (düzenli) video YouTube'a onaysız gider (post_pipeline aynı kuralı uygular)
    if (!v.anlik && !["gunluk", "haftalik"].includes(v.format) && yp.regularAuto !== false && L.platforms.includes("youtube")) ap.youtube = true;
    // WhatsApp'tan gönderilen görüntüyle yapılan haber: varsayılan onaylı (post_pipeline aynı kuralı uygular)
    if (v.userVideo && !settings().waVideo?.autoPublish) for (const pl of Object.keys(ap)) ap[pl] = false;
    // linkle birlikte saat yazıldıysa (planlı yayın) onay istenmez; panel o saatte yayınlar
    const schedAt = v.publishAt && Date.parse(v.publishAt) > Date.now() + 60000 ? new Date(v.publishAt) : null;
    if (schedAt) for (const pl of Object.keys(ap)) ap[pl] = false;
    const autoPl = L.platforms.filter((pl) => ap[pl] && !already[pl]);      // otomatik yayın açık: onay gerekmez
    const platforms = schedAt ? [] : L.platforms.filter((pl) => !already[pl] && !ap[pl]);  // yalnızca elle yayınlanacaklar için onay
    const schedLine = schedAt ? `\n\n⏰ Planlı yayın: ${whenLabel(schedAt)} → ${L.platforms.join(", ") || "bağlı hesap yok"} (iptal: *planlı yayını iptal et*)` : "";
    const autoLine = autoPl.length ? `\n\n🚀 Otomatik yayın: ${autoPl.join(", ")} (onay gerekmez, yüklenince bildirilir)` : "";
    // Gönderilen görüntü/link videosu (userVideo) hiçbir yerde kendiliğinden yayınlanmaz; "onay iste" ayarı kapalıysa da (tam otomatik
    // mod kapatır) onay sorulur — yoksa ne yayın olur ne onay (kullanıcı şikâyeti, 14 Ekim).
    const needAsk = !!(ask && platforms.length && (w.requireApproval !== false || v.userVideo));
    const askLine = needAsk
      ? approveLine(platforms)
      : (!autoPl.length && !L.platforms.length ? "\n\n(Yayın için bağlı platform yok; panelden hesap bağlayın.)" : "");
    const jid = ownerJid();
    if (summary) { // tek mesaj: video dosyası + kısa özet aynı mesajda (dosya gönderilmezse düz metin)
      const titles = v.segments.filter((s) => s.kind === "haber").slice(0, 5).map((s) => `• ${s.breaking ? "🔴 " : ""}${s.title}`).join("\n");
      const pub = publishLines(summary).filter((l) => !(needAsk && /^ℹ️ otomatik yayın yapılmadı/.test(l)));  // onay satırı zaten anlatıyor
      const pending = needAsk ? approveLine(platforms) : "";
      const watchLine = `\n\n▶ ${L.tunnel || L.lan}`;
      let msg = `${head}\n\n${titles}${pub.length && !schedAt ? "\n\n📤 *Yayın*\n" + pub.join("\n") : ""}${schedLine}${pending}${watchLine}`;
      if (msg.length > 1000) msg = msg.slice(0, 990) + "…";
      let fileSent = false;
      if (w.sendVideoFile !== false) { try { fileSent = await sendVideo(jid, v.path, msg); } catch (e) { push(`💬 video dosyası gönderilemedi: ${e.message}`); } }
      if (fileSent === false) await send(jid, msg);
      if (pending) st.pending = { video: name, label: v.label, platforms, at: Date.now() };
      push(`💬 WhatsApp'a tek mesaj gönderildi: ${v.label}${fileSent ? " (+video)" : ""}${st.pending ? " · onay bekleniyor" : ""}`);
      return { ok: true, fileSent, awaitingApproval: !!pending };
    }
    const text = `${head}\n\n📝 *Seslendirme metni*\n\n${words}${schedLine || autoLine}${schedAt ? "" : askLine}`;
    let fileSent = false;
    if (w.sendVideoFile !== false) { try { fileSent = await sendVideo(jid, v.path, head); } catch (e) { push(`💬 video dosyası gönderilemedi: ${e.message}`); } }
    await send(jid, text);
    // Linkler ayrı, önizlemeli mesaj olarak: WhatsApp IP'li yerel adresi düz metin bırakır, önizleme kartı tıklanır.
    await sendLink(jid, L.lan, `▶ ${v.label}`, "Wi-Fi'de izle (Mac ile aynı ağ)", L.thumb);
    if (L.tunnel) await sendLink(jid, L.tunnel, `🌐 ${v.label}`, "Dışarıdan izle (tünel)", L.thumb);
    if (needAsk) st.pending = { video: name, label: v.label, platforms, at: Date.now() };
    push(`💬 WhatsApp'a gönderildi: ${v.label}${fileSent ? " (+dosya)" : ""}${st.pending ? " · onay bekleniyor" : ""}`);
    return { ok: true, fileSent, awaitingApproval: !!st.pending };
  }

  async function stop() { stopping = true; st.userStopped = true; try { sock?.end?.(); } catch { /* yok */ } sock = null; st.status = "disconnected"; stopping = false; return status(); }

  // Bağlantı bekçisi (kullanıcı isteği: "WhatsApp bağlantım düzenli kontrol edilsin, kopma varsa yeniden bağlansın"). Panel 2 dk'da bir
  // çağırır. Kopuksa (kullanıcı durdurmadıysa ve oturum varsa) yeniden bağlanır; 3 dk'dan uzun "bağlanıyor"da takılırsa soketi yeniler;
  // bağlı görünürken WhatsApp sunucusuna küçük bir sorgu atar (onWhatsApp), iki kez üst üste yanıt gelmezse bağlantıyı yeniden kurar.
  async function watchdog() {
    if (stopping || st.userStopped || !existsSync(AUTH_DIR)) return { ok: true, skipped: true };
    if (st.status === "qr") return { ok: false, needQr: true };
    if (!sock || st.status === "disconnected") {
      st.reconnects = (st.reconnects || 0) + 1; st.retries = 0;
      push(`💬 WhatsApp bekçisi: bağlantı kopuk${st.error ? ` (${st.error})` : ""}, yeniden bağlanılıyor (${st.reconnects}. kez)`);
      sock = null; await start(); return { ok: false, reconnecting: true };
    }
    if (st.status === "connecting") {
      if (Date.now() - (st.connectingSince || Date.now()) > 3 * 60000) {
        push("💬 WhatsApp bekçisi: bağlantı 3 dakikadır kurulamadı, yeniden deneniyor");
        try { sock.end?.(new Error("bekçi: bağlanma takıldı")); } catch { /* yok */ }
        sock = null; st.status = "disconnected"; st.retries = 0; await start();
      }
      return { ok: false, connecting: true };
    }
    try {
      await Promise.race([sock.onWhatsApp(st.phone ? `${st.phone}@s.whatsapp.net` : ownerJid()), new Promise((_, rej) => setTimeout(() => rej(new Error("yanıt yok")), 20000))]);
      st.lastOkAt = Date.now(); st.probeFails = 0;
      if (outbox.length) await flushOutbox();
      return { ok: true };
    } catch (e) {
      st.probeFails = (st.probeFails || 0) + 1;
      if (st.probeFails < 2) return { ok: false, probeFails: st.probeFails };
      push(`💬 WhatsApp bekçisi: bağlı görünüyor ama ${st.probeFails} kontrolde yanıt vermedi (${e.message}); bağlantı yenileniyor`);
      st.reconnects = (st.reconnects || 0) + 1; st.probeFails = 0;
      try { sock.end?.(new Error("bekçi: yanıt yok")); } catch { /* yok */ }
      sock = null; st.status = "disconnected"; st.retries = 0; await start();
      return { ok: false, reconnecting: true };
    }
  }
  async function logout() { try { await sock?.logout?.(); } catch { /* yok */ } await stop(); rmSync(AUTH_DIR, { recursive: true, force: true }); st.phone = null; return status(); }
  const status = () => ({ lastOkAt: st.lastOkAt || null, reconnects: st.reconnects || 0, outbox: outbox.length, lastIgnored: st.lastIgnored || null, selfPhone: selfPhone() ? "…" + selfPhone().slice(-4) : null, status: st.status, qrSvg: st.qrSvg, phone: st.phone, error: st.error, owner: ownerDigits() || null, pending: st.pending ? { video: st.pending.video, platforms: st.pending.platforms } : null, hasSession: existsSync(AUTH_DIR), lastMsgAt: st.lastMsgAt });
  const clearPending = (video) => { if (st.pending && (!video || st.pending.video === video)) st.pending = null; };
  return { start, stop, logout, status, watchdog, send: (t) => send(ownerJid(), t), notifyVideo, clearPending };
}
