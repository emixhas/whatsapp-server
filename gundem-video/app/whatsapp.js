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
  const isOwner = (jid) => { const d = digits(jid); const o = ownerDigits(); return !!o && (d === o || d.endsWith(o.slice(-10))); };

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
      if (u.connection === "open") { st.status = "connected"; st.qr = st.qrSvg = null; st.retries = 0; st.phone = digits(sock.user?.id?.split(":")[0]); push(`💬 WhatsApp bağlandı: +${st.phone}`); announce("WhatsApp bağlandı."); }
      if (u.connection === "close") {
        const code = u.lastDisconnect?.error?.output?.statusCode;
        sock = null; st.status = "disconnected";
        if (code === DisconnectReason.loggedOut) { st.error = "Oturum kapatıldı; yeniden QR gerekir"; rmSync(AUTH_DIR, { recursive: true, force: true }); push("💬 WhatsApp oturumu kapandı (telefondan çıkış yapılmış)"); return; }
        if (!stopping && st.retries++ < 8) { push(`💬 WhatsApp bağlantısı koptu (kod ${code}), yeniden deneniyor`); setTimeout(start, 3000 * st.retries); }
      }
    });
    sock.ev.on("messages.upsert", async ({ messages, type }) => {
      if (type !== "notify") return;
      for (const m of messages) {
        if (!m.message || m.key.fromMe) continue;
        const from = m.key.remoteJid || ""; const participant = m.key.participant || "";
        if (from.endsWith("@g.us")) continue;                       // gruplar yok sayılır
        if (!isOwner(from) && !isOwner(participant)) continue;      // yalnızca sahip
        const text = (m.message.conversation || m.message.extendedTextMessage?.text || m.message.imageMessage?.caption || "").trim();
        if (!text) continue;
        st.lastMsgAt = Date.now();
        push(`💬 WhatsApp'tan: ${text.slice(0, 80)}`);
        try { await onOwnerMessage(from, text); } catch (e) { push(`✖ WhatsApp komutu: ${e.message}`); await send(from, `Hata: ${e.message}`); }
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

  async function send(jid, text) { if (!sock || st.status !== "connected") throw new Error("WhatsApp bağlı değil"); await sock.sendMessage(jid, { text }); }
  async function sendLink(jid, url, title, description, thumb) {
    try {
      await sock.sendMessage(jid, { text: `${title}\n${url}`, linkPreview: { "canonical-url": url, "matched-text": url, title, description, ...(thumb ? { jpegThumbnail: thumb } : {}) } });
    } catch (e) { push(`💬 link gönderilemedi (${e.message}); düz metin deneniyor`); await send(jid, `${title}\n${url}`); }
  }
  async function sendVideo(jid, file, caption) {
    const size = statSync(file).size;
    if (size > 60 * 1024 * 1024) { await send(jid, `${caption}\n(Video 60 MB'den büyük, dosya gönderilmedi; linkten izleyin.)`); return false; }
    await sock.sendMessage(jid, { video: readFileSync(file), caption, mimetype: "video/mp4" });
    return true;
  }

  /** Üretim bitince sahibine metin + linkler (+ dosya) gönderir ve onay bekler. */
  async function notifyVideo(name, { ask = true } = {}) {
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
    const autoPl = L.platforms.filter((pl) => ap[pl] && !already[pl]);      // otomatik yayın açık: onay gerekmez
    const platforms = L.platforms.filter((pl) => !already[pl] && !ap[pl]);  // yalnızca elle yayınlanacaklar için onay
    const autoLine = autoPl.length ? `\n\n🚀 Otomatik yayın: ${autoPl.join(", ")} (onay gerekmez, yüklenince bildirilir)` : "";
    const askLine = (ask && w.requireApproval !== false && platforms.length)
      ? `\n\n✅ Yayınlamak için *onay* yazın → ${platforms.join(", ")}\n❌ Yayınlamamak için *iptal*`
      : (!autoPl.length && !L.platforms.length ? "\n\n(Yayın için bağlı platform yok; panelden hesap bağlayın.)" : "");
    const text = `${head}\n\n📝 *Seslendirme metni*\n\n${words}${autoLine}${askLine}`;
    const jid = ownerJid();
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
  const status = () => ({ status: st.status, qrSvg: st.qrSvg, phone: st.phone, error: st.error, owner: ownerDigits() || null, pending: st.pending ? { video: st.pending.video, platforms: st.pending.platforms } : null, hasSession: existsSync(AUTH_DIR), lastMsgAt: st.lastMsgAt });
  const clearPending = (video) => { if (st.pending && (!video || st.pending.video === video)) st.pending = null; };
  return { start, stop, logout, status, send: (t) => send(ownerJid(), t), notifyVideo, clearPending };
}
