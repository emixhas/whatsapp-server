// WhatsApp köprüsü (Baileys, WhatsApp Web protokolü). Panelden QR okutulur; yalnızca sahip numarası komut verebilir.
// Video bitince: metin + izleme linkleri + (isteğe bağlı) video dosyası gönderir; "onay" gelince yayınlar.
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import QRCode from "qrcode";

export async function makeWhatsApp({ autoAll = () => false, automode = async () => ({ ok: false, error: "yok" }), statusText = async () => "durum yok", ROOT, settings, push, announce, handleCommand, publishVideo, videoInfo, links }) {
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
    st.status = "connecting"; st.error = null;
    sock.ev.on("creds.update", saveCreds);
    sock.ev.on("connection.update", async (u) => {
      if (u.qr) { st.qr = u.qr; st.qrSvg = await QRCode.toString(u.qr, { type: "svg", margin: 1, color: { dark: "#FFFFFF", light: "#00000000" } }); st.status = "qr"; push("💬 WhatsApp: QR hazır, panelden telefonunuzla okutun"); }
      if (u.connection === "open") { st.status = "connected"; st.qr = st.qrSvg = null; st.retries = 0; st.phone = digits(sock.user?.id?.split(":")[0]); push(`💬 WhatsApp bağlandı: +${st.phone}`); announce("WhatsApp bağlandı."); setTimeout(() => learnOwnerLid(), 3000); }
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
        const text = (m.message.conversation || m.message.extendedTextMessage?.text || m.message.imageMessage?.caption || "").trim();
        if (!owner) {
          if (text && Date.now() - lastIgnoredLog > 60000) {
            lastIgnoredLog = Date.now();
            const who = digits(k.senderPn || k.participantPn || from); const o = ownerDigits();
            push(`💬 WhatsApp: sahip olmayan göndericiden mesaj yok sayıldı (…${who.slice(-4)}${from.endsWith("@lid") && !k.senderPn ? ", numara gizli (LID)" : ""}); sahip numarası ${o ? "…" + o.slice(-4) : "AYARLANMAMIŞ"} — yanlışsa Ayarlar → WhatsApp → sahip numarası`);
            st.lastIgnored = { at: Date.now(), from: "…" + who.slice(-4), lid: !!lid && !k.senderPn };
          }
          continue;
        }
        if (!text) continue;
        st.lastMsgAt = Date.now();
        // yanıt: kendine-mesajsa kendi numaramıza, değilse sahibin telefon numarasına (LID adresine değil)
        const replyTo = selfChat ? `${selfPhone()}@s.whatsapp.net` : (pnCands.find(isOwner) && !String(pnCands.find(isOwner)).endsWith("@lid") ? `${digits(pnCands.find(isOwner))}@s.whatsapp.net` : ownerJid());
        push(`💬 WhatsApp'tan: ${text.slice(0, 80)}`);
        try { await onOwnerMessage(replyTo, text); } catch (e) { push(`✖ WhatsApp komutu: ${e.message}`); try { await send(replyTo, `Hata: ${e.message}`); } catch { /* bağlantı yok */ } }
      }
    });
    return status();
  }

  async function onOwnerMessage(jid, text) {
    const t = text.toLocaleLowerCase("tr-TR").trim();
    if (st.pending && Date.now() - st.pending.at > 6 * 3600 * 1000) { st.pending = null; }  // eski onay isteği düşer
    if (/^(otomatik|tam otomatik)( mod)?u? (aç|başlat|kapat|durdur)/.test(t)) { const on = /(aç|başlat)/.test(t); const r = await automode(on); await send(jid, r.ok ? (on ? `⚡ Tam otomatik mod açık: her ${r.hours} saatte üretim, otomatik yayın → ${r.connected.join(", ") || "bağlı hesap yok"}.` : "⏹ Otomatik üretim ve yayın durduruldu.") : `Olmadı: ${r.error}`); return; }
    if (st.pending && /^(onay|onayla|evet|yayınla|ok|tamam|paylaş)\b/.test(t)) {
      const p = st.pending; st.pending = null;
      await send(jid, `⏳ Yayınlanıyor: ${p.label} → ${p.platforms.join(", ")}`);
      const r = await publishVideo(p.video, p.platforms);
      const lines = Object.entries(r.results || {}).map(([k, v]) => v.ok ? `✅ ${k}: ${v.skipped ? "zaten yayında" : (v.url || v.note || "tamam")}` : `❌ ${k}: ${v.error}`);
      await send(jid, lines.join("\n") || "Yayınlanacak platform yok.");
      return;
    }
    if (st.pending && /^(hayır|iptal|yayınlama|vazgeç|no)\b/.test(t)) { const p = st.pending; st.pending = null; await send(jid, `Tamam, ${p.label} yayınlanmadı.`); return; }
    if (/^(yardım|help|\?)$/.test(t)) { await send(jid, "Komutlar:\n• onay / iptal — bekleyen yayın\n• 60 saniyelik video üret\n• durum — sıradaki üretim, bağlı hesaplar\n• otomatik aç / otomatik kapat — tam otomatik mod\n• rapor / plan\n• son videoyu gönder\n• izlenmeleri güncelle\n• instagram'a yayınla / tiktok'a yayınla\nDiğer her şey Emixhas'ın beynine gider."); return; }
    if (/^(durum|status|ne var ne yok)$/.test(t)) { await send(jid, await statusText()); return; }
    if (/(son videoyu|videoyu) (gönder|yolla|at)/.test(t)) { const v = videoInfo(); if (!v) return send(jid, "Video yok."); await notifyVideo(v.name, { ask: false }); return; }
    const r = await handleCommand(text);
    let reply = r.reply || "Tamam.";
    if (r.report) reply += "\n\n" + r.report.slice(0, 3500);
    if (r.pending?.length) { reply += "\n\n(Bu eylem panelden onay bekliyor.)"; }
    await send(jid, reply);
  }

  const remember = (r) => { if (r?.key?.id) { sentIds.add(r.key.id); if (sentIds.size > 500) sentIds.delete(sentIds.values().next().value); } return r; };
  async function send(jid, text) { if (!sock || st.status !== "connected") throw new Error("WhatsApp bağlı değil"); remember(await sock.sendMessage(jid, { text })); }
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
  function publishLines(summary) {
    const last = {}; const notes = [];
    for (const l of summary || []) {
      const m = l.match(/^📤 (youtube|instagram|tiktok): (.*)$/);
      if (m) { if (!/hesap bağlı değil/.test(m[2])) last[m[1]] = m[2]; continue; }
      if (/^📤 otomatik yayın yapılmadı/.test(l)) notes.push("ℹ️ " + l.replace(/^📤 /, "").replace(/ WhatsApp'tan.*$/, ""));
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
    if (!w.enabled || st.status !== "connected") return { ok: false, error: "WhatsApp bağlı değil" };
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
    const autoPl = L.platforms.filter((pl) => ap[pl] && !already[pl]);      // otomatik yayın açık: onay gerekmez
    const platforms = L.platforms.filter((pl) => !already[pl] && !ap[pl]);  // yalnızca elle yayınlanacaklar için onay
    const autoLine = autoPl.length ? `\n\n🚀 Otomatik yayın: ${autoPl.join(", ")} (onay gerekmez, yüklenince bildirilir)` : "";
    const askLine = (ask && w.requireApproval !== false && platforms.length)
      ? `\n\n✅ Yayınlamak için *onay* yazın → ${platforms.join(", ")}\n❌ Yayınlamamak için *iptal*`
      : (!autoPl.length && !L.platforms.length ? "\n\n(Yayın için bağlı platform yok; panelden hesap bağlayın.)" : "");
    const jid = ownerJid();
    if (summary) { // tek mesaj: video dosyası + kısa özet aynı mesajda (dosya gönderilmezse düz metin)
      const titles = v.segments.filter((s) => s.kind === "haber").slice(0, 5).map((s) => `• ${s.breaking ? "🔴 " : ""}${s.title}`).join("\n");
      const pub = publishLines(summary);
      const pending = (ask && w.requireApproval !== false && platforms.length) ? `\n\n✅ Yayınlamak için *onay* yazın → ${platforms.join(", ")} · ❌ *iptal*` : "";
      const watchLine = `\n\n▶ ${L.tunnel || L.lan}`;
      let msg = `${head}\n\n${titles}${pub.length ? "\n\n📤 *Yayın*\n" + pub.join("\n") : ""}${pending}${watchLine}`;
      if (msg.length > 1000) msg = msg.slice(0, 990) + "…";
      let fileSent = false;
      if (w.sendVideoFile !== false) { try { fileSent = await sendVideo(jid, v.path, msg); } catch (e) { push(`💬 video dosyası gönderilemedi: ${e.message}`); } }
      if (fileSent === false) await send(jid, msg);
      if (pending) st.pending = { video: name, label: v.label, platforms, at: Date.now() };
      push(`💬 WhatsApp'a tek mesaj gönderildi: ${v.label}${fileSent ? " (+video)" : ""}${st.pending ? " · onay bekleniyor" : ""}`);
      return { ok: true, fileSent, awaitingApproval: !!pending };
    }
    const text = `${head}\n\n📝 *Seslendirme metni*\n\n${words}${autoLine}${askLine}`;
    let fileSent = false;
    if (w.sendVideoFile !== false) { try { fileSent = await sendVideo(jid, v.path, head); } catch (e) { push(`💬 video dosyası gönderilemedi: ${e.message}`); } }
    await send(jid, text);
    // Linkler ayrı, önizlemeli mesaj olarak: WhatsApp IP'li yerel adresi düz metin bırakır, önizleme kartı tıklanır.
    await sendLink(jid, L.lan, `▶ ${v.label}`, "Wi-Fi'de izle (Mac ile aynı ağ)", L.thumb);
    if (L.tunnel) await sendLink(jid, L.tunnel, `🌐 ${v.label}`, "Dışarıdan izle (tünel)", L.thumb);
    if (ask && platforms.length && w.requireApproval !== false) st.pending = { video: name, label: v.label, platforms, at: Date.now() };
    push(`💬 WhatsApp'a gönderildi: ${v.label}${fileSent ? " (+dosya)" : ""}${st.pending ? " · onay bekleniyor" : ""}`);
    return { ok: true, fileSent, awaitingApproval: !!st.pending };
  }

  async function stop() { stopping = true; try { sock?.end?.(); } catch { /* yok */ } sock = null; st.status = "disconnected"; stopping = false; return status(); }
  async function logout() { try { await sock?.logout?.(); } catch { /* yok */ } await stop(); rmSync(AUTH_DIR, { recursive: true, force: true }); st.phone = null; return status(); }
  const status = () => ({ lastIgnored: st.lastIgnored || null, selfPhone: selfPhone() ? "…" + selfPhone().slice(-4) : null, status: st.status, qrSvg: st.qrSvg, phone: st.phone, error: st.error, owner: ownerDigits() || null, pending: st.pending ? { video: st.pending.video, platforms: st.pending.platforms } : null, hasSession: existsSync(AUTH_DIR), lastMsgAt: st.lastMsgAt });
  const clearPending = (video) => { if (st.pending && (!video || st.pending.video === video)) st.pending = null; };
  return { start, stop, logout, status, send: (t) => send(ownerJid(), t), notifyVideo, clearPending };
}
