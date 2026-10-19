// WhatsApp köprüsü (Baileys, WhatsApp Web protokolü). Panelden QR okutulur; yalnızca sahip numarası komut verebilir.
// Video bitince: metin + izleme linkleri + (isteğe bağlı) video dosyası gönderir; "onay" gelince yayınlar.
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import QRCode from "qrcode";
import { HELP_TEXT } from "./help.js";
import { whenLabel } from "./when.js";

export async function makeWhatsApp({ handleVideo = null, videoInstruction = null, autoAll = () => false, automode = async () => ({ ok: false, error: "yok" }), statusText = async () => "durum yok", ROOT, settings, push, announce, handleCommand, publishVideo, videoInfo, links }) {
  const AUTH_DIR = path.join(ROOT, "secrets", "wa-auth");
  const st = { status: "disconnected", qr: null, qrSvg: null, phone: null, error: null, pending: null, lastMsgAt: null, retries: 0 };
  // bekleyen yayın onayı diske yazılır: panel yeniden başlayınca ("güncelle", çökme) "onay" kaybolmasın (6 saatten eskisi okunmaz)
  const PENDING_FILE = path.join(ROOT, "data", "wa_pending.json");
  let pendingVal = null;
  // diskten gelen onay "restored": yeniden başlamadan sonra gevşek "tamam/evet/ok" (örneğin "✅ Güncellendi" mesajına cevap) eski videoyu
  // yayınlamasın; yalnız açık "onay …" / "yayınla" / "paylaş" ya da platform adı
  try { const p = JSON.parse(readFileSync(PENDING_FILE, "utf8")); if (p?.video && Array.isArray(p.platforms) && Date.now() - Number(p.at || 0) < 6 * 3600000) pendingVal = { ...p, restored: true }; } catch { /* yok */ }
  Object.defineProperty(st, "pending", { enumerable: true, get: () => pendingVal, set: (v) => {
    pendingVal = v || null;
    try { if (pendingVal) writeFileSync(PENDING_FILE, JSON.stringify(pendingVal)); else rmSync(PENDING_FILE, { force: true }); } catch { /* yazılamadı: bellekte kalır */ }
  } });
  let sock = null, stopping = false, baileys = null, starting = null, retryStart = null, gen = 0;

  const digits = (s) => String(s || "").replace(/\D/g, "");
  const userOf = (j) => digits(String(j || "").split("@")[0].split(":")[0]); // jid'in kullanıcı kısmı (":cihaz" ve sunucu atılır)
  const isLid = (j) => String(j || "").endsWith("@lid");
  const ownerDigits = () => { let d = digits(settings().whatsapp?.owner); if (d.startsWith("0")) d = "90" + d.slice(1); return d; };
  const ownerJid = () => `${ownerDigits()}@s.whatsapp.net`;
  // v7'nin LID → numara eşlemesi "905…:0@s.whatsapp.net" döner: cihaz eki numaraya karışmasın (userOf)
  const isOwner = (jid) => { if (!jid || isLid(jid)) return false; const d = userOf(jid); const o = ownerDigits(); return !!o && d.length >= 10 && (d === o || d.endsWith(o.slice(-10))); };
  // WhatsApp yeni "LID" kimliği: 1'e 1 sohbette remoteJid "…@lid" gelir; karşı kimlik Baileys 7'de key.remoteJidAlt'ta (grupta
  // participantAlt), 6.7.x'te senderPn/senderLid/participantPn/participantLid'de. Sahibin LID'i ilk eşleşmede öğrenilir (bellekte;
  // v7 eşlemeyi ayrıca kendi oturum deposuna yazar). Sahip numarası değişirse eski LID'ler unutulur.
  const knownOwnerLids = new Set();
  const sentIds = new Set(); // kendi gönderdiğimiz mesajlar: kendine-mesaj sohbetinde komut sanılmasın (döngü engeli)
  const selfPhone = () => userOf(sock?.user?.id);
  const selfLid = () => userOf(sock?.user?.lid);
  const isSelfChat = (jid) => { const d = userOf(jid); return !!d && (d === selfPhone() || (!!selfLid() && d === selfLid())); };
  const normJid = (j) => { try { return baileys?.jidNormalizedUser?.(j) || j; } catch { return j; } };
  const lidMap = () => sock?.signalRepository?.lidMapping; // yalnız Baileys 7
  const timeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("zaman aşımı")), ms))]);
  let lastIgnoredLog = 0, ownerLidFor = "", ownerLid = "", lidTriedAt = 0, learning = null;
  const setOwnerLid = (l) => { const o = ownerDigits(); if (!l || !o) return; if (ownerLidFor && ownerLidFor !== o) knownOwnerLids.clear(); knownOwnerLids.add(l); ownerLid = l; ownerLidFor = o; };
  // sahibin LID'i: v7'de Baileys'in eşleme deposundan (yoksa WhatsApp'a USync sorgusu, sonuç depoya yazılır; onWhatsApp artık lid
  // vermiyor), 6.7.x'te onWhatsApp'ın lid alanından. Başarısız sorgu 5 dk tekrarlanmaz (yabancı LID mesajları sorgu yağdırmasın).
  async function learnOwnerLid() {
    const o = ownerDigits(); if (!o || !sock || ownerLidFor === o) return;
    if (ownerLidFor && ownerLidFor !== o) { knownOwnerLids.clear(); ownerLid = ""; ownerLidFor = ""; } // sahip değişti: eski sahibin LID'i komut veremesin
    if (learning) return learning;
    if (Date.now() - lidTriedAt < 5 * 60000) return;
    lidTriedAt = Date.now();
    learning = (async () => {
      try {
        const m = lidMap();
        const r = m?.getLIDForPN ? await timeout(m.getLIDForPN(ownerJid()), 15000) : (await timeout(sock.onWhatsApp(ownerJid()), 15000))?.[0]?.lid;
        if (isLid(r) || (r && !m)) setOwnerLid(userOf(r));
      } catch { /* sorgu başarısız: gelen mesajın karşı kimliğiyle öğrenilir */ } finally { learning = null; }
    })();
    return learning;
  }
  async function pnForLid(lid) { // v7: LID → numara, yalnız yerel depo (ağ yok); numarası gizli gelen sahip mesajı kaybolmasın
    try { const pn = await lidMap()?.getPNForLID?.(normJid(lid)); return pn ? `${userOf(pn)}@s.whatsapp.net` : null; } catch { return null; }
  }
  const selfJid = () => selfLid() ? `${selfLid()}@lid` : `${selfPhone()}@s.whatsapp.net`;
  // Sahibe kendiliğinden giden mesajların adresi (video bildirimi, sağlık uyarısı, kuyruk): bilinen LID'i, yoksa telefon jid'i (v7
  // numarayı eşlemeyle aynı LID oturumuna çevirir). Sahip bağlı numaranın kendisiyse kendine-mesaj sohbeti.
  async function ownerTarget() {
    const o = ownerDigits();
    if (o && sock && selfPhone() && isOwner(`${selfPhone()}@s.whatsapp.net`)) return selfJid();
    await learnOwnerLid();
    return ownerLid && ownerLidFor === o ? `${ownerLid}@lid` : ownerJid();
  }

  // Gönderdiğimiz mesajların kendisi (kullanıcı şikâyeti, 19 Ekim: botun her mesajı telefonda "Mesaj bekleniyor. Bu işlem biraz zaman
  // alabilir"). Telefon bir mesajı çözemeyince "yeniden gönder" (retry) ister; Baileys mesajı getMessage ile bulup yeniden şifreler.
  // getMessage yoktu → mesaj hiç yeniden gönderilmiyor, telefonda kalıcı "bekleniyor" kalıyordu. Kimlikle aranır (istek @lid, cihaz
  // jid'i ya da kendine-mesaj adresinden gelebilir), proto base64 (BufferJSON medya anahtarını bozuyor), 7 gün / 500 mesaj, diske
  // yazılır: telefon saatler sonra çevrimiçi olsa ya da panel arada yeniden başlasa ("güncelle") da yeniden gönderilebilsin.
  const SENT_FILE = path.join(ROOT, "data", "wa_sent.json");
  let sentStore = {};
  try { const j = JSON.parse(readFileSync(SENT_FILE, "utf8")); if (j && typeof j === "object" && !Array.isArray(j)) sentStore = j; } catch { /* yok ya da bozuk: boş başlar */ }
  const isOurs = (id) => !!id && (sentIds.has(id) || !!sentStore[id]);
  function storeSent(r) {
    const id = r?.key?.id; if (!id || !r.message || !baileys?.proto?.Message) return;
    try { sentStore[id] = { at: Date.now(), m: Buffer.from(baileys.proto.Message.encode(r.message).finish()).toString("base64") }; } catch { return; }
    const cut = Date.now() - 7 * 86400000;
    const ids = Object.keys(sentStore).filter((x) => Number(sentStore[x]?.at) > cut).sort((a, b) => sentStore[a].at - sentStore[b].at);
    sentStore = Object.fromEntries(ids.slice(-500).map((x) => [x, sentStore[x]]));
    try { const tmp = SENT_FILE + ".tmp"; writeFileSync(tmp, JSON.stringify(sentStore)); renameSync(tmp, SENT_FILE); } catch { /* yazılamadı: bellekte kalır */ }
  }
  function sentGet(id) {
    const e = id && sentStore[id]; if (!e?.m || !baileys?.proto?.Message) return undefined;
    try { return baileys.proto.Message.decode(Buffer.from(e.m, "base64")); } catch { return undefined; }
  }
  // yeniden gönderme sayacı süreç boyunca tek (soket yenilense de sayılır; Baileys'in kendi sayacı her yeni sokette sıfırlanıyordu), 1 saat
  const retryCounts = new Map();
  const msgRetryCounterCache = {
    get: (k) => { const e = retryCounts.get(k); if (!e) return undefined; if (Date.now() > e.exp) { retryCounts.delete(k); return undefined; } return e.v; },
    set: (k, v) => { retryCounts.set(k, { v, exp: Date.now() + 3600000 }); if (retryCounts.size > 2000) retryCounts.delete(retryCounts.keys().next().value); return true; },
    del: (k) => retryCounts.delete(k), flushAll: () => retryCounts.clear(),
  };
  // Telefonun yeniden gönderme istekleri (teşhis + kendini onarma bildirimi; gizli bilgi yok: kimliğin son 4 hanesi ve sayılar). Baileys
  // isteği kendisi karşılar (7: oturumu yeniler, mesajı yeniden şifreler). Biz sayarız: tek tük istek normal (sürüm geçişinden sonraki
  // ilk mesajlar), sürekli tekrarlanıyorsa loga açık uyarı ve çözüm.
  const retries = new Map(); // id → {first, last, n (telefonun deneme sayısı), lid, miss (getMessage bulamadı)}
  let retryTimer = null, retryWarnAt = 0;
  function onRetryReceipt(node) {
    try {
      const a = node?.attrs || {}; const c = Array.isArray(node?.content) ? node.content : [];
      const n = Number(c.find((x) => x?.tag === "retry")?.attrs?.count) || 1;
      const items = Array.isArray(c[0]?.content) ? c[0].content.filter((x) => x?.tag === "item").map((x) => x.attrs?.id) : [];
      for (const id of [a.id, ...items].filter(Boolean)) {
        const e = retries.get(id) || { first: Date.now(), n: 0, lid: false, miss: false };
        e.last = Date.now(); e.n = Math.max(e.n, n); e.lid = e.lid || isLid(a.from); retries.set(id, e);
      }
      for (const [id, e] of retries) if (Date.now() - e.last > 6 * 3600000) retries.delete(id);
      clearTimeout(retryTimer); retryTimer = setTimeout(retryReport, 20000); // Baileys yeniden göndersin, sonra tek satır
    } catch { /* teşhis: gönderimi etkilemez */ }
  }
  function retryReport() {
    const now = Date.now(), recent = [...retries.entries()].filter(([, e]) => now - e.last < 30 * 60000);
    if (!recent.length) return;
    const miss = recent.filter(([, e]) => e.miss), hard = recent.filter(([, e]) => e.n >= 3), maxN = Math.max(...recent.map(([, e]) => e.n));
    st.retryInfo = { at: now, messages: recent.length, maxTry: maxN, missing: miss.length, lid: recent.some(([, e]) => e.lid) };
    push(`💬 WhatsApp: telefon son 30 dk'da ${recent.length} mesajımızı çözemeyip yeniden istedi (en çok ${maxN}. deneme${recent.some(([, e]) => e.lid) ? ", LID adresinden" : ""}); ` +
      (miss.length ? `${miss.length} tanesi kayıtta yok (7 günden eski ya da bu sürümden önce gönderilmiş), telefonda "Mesaj bekleniyor" kalabilir` : "mesajlar kayıtta, yeniden şifrelenip gönderiliyor"));
    if ((hard.length >= 2 || recent.length >= 6) && now - retryWarnAt > 6 * 3600000) {
      retryWarnAt = now;
      push(`⚠️ WhatsApp: telefon mesajlarımızı sürekli çözemiyor (${recent.length} mesaj, ${hard.length} tanesi 3+ kez). Baileys oturumu kendiliğinden yeniliyor; telefonda hâlâ "Mesaj bekleniyor" görünüyorsa: panel Ayarlar → WhatsApp → çıkış yap, telefonda Ayarlar → Bağlı cihazlar'dan eski "Emixhas" oturumunu kaldırın, yeni QR'ı okutun.`);
    }
  }
  // kütüphane sürümü (sürüm değişince bağlanınca tek satır bilgi; teşhis ve panel durumu için)
  const LIB_FILE = path.join(ROOT, "data", "wa_lib.json");
  const libVersion = () => { try { return JSON.parse(readFileSync(path.join(ROOT, "node_modules", "@whiskeysockets", "baileys", "package.json"), "utf8")).version || null; } catch { return null; } };
  function noteLib() {
    const v = st.lib; if (!v) return; let old = null;
    try { old = JSON.parse(readFileSync(LIB_FILE, "utf8"))?.version || null; } catch { /* ilk kez */ }
    if (old === v) return;
    try { writeFileSync(LIB_FILE, JSON.stringify({ version: v, at: Date.now() })); } catch { /* yazılamadı */ }
    if (/^7\./.test(v) && (!old || /^6\./.test(old))) push(`💬 WhatsApp kütüphanesi yenilendi (Baileys ${old || "6.x"} → ${v}): şifreleme oturumları WhatsApp'ın yeni LID kimliğine taşınıyor. İlk birkaç mesajda telefon bir kez "yeniden gönder" isteyebilir, panel kendiliğinden karşılar. Telefonda "Mesaj bekleniyor" sürerse: Ayarlar → WhatsApp → çıkış yap, yeni QR okutun.`);
  }

  // Tek seferde tek bağlantı kurulur (bekçi, kopma sonrası yeniden deneme ve panel düğmesi aynı anda çağırınca iki canlı soket aynı
  // oturum klasörüne yazıyordu: 440 "başka oturum" kopmaları ve oturum bozulması)
  async function start() {
    if (sock || stopping) return status();
    // durdurmadan sonra gelen başlatma eski (durdurulmuş) kurulumun sözünü almasın: her kurulum yalnız kendi kaydını siler
    if (!starting) { const p = start0().finally(() => { if (starting === p) starting = null; }); starting = p; }
    return starting;
  }
  async function start0() {
    const g = gen; // bu kurulum sürerken "durdur" gelirse soket açılmaz
    try { baileys = baileys || await import("@whiskeysockets/baileys"); }
    catch (e) {
      const node = process.versions.node, major = Number(node.split(".")[0]);
      const err = major < 20 ? `WhatsApp kütüphanesi Node 20 ya da üstünü ister, bu bilgisayarda Node ${node} var: Node'u güncelleyin (nodejs.org ya da "brew upgrade node"), sonra gundem-video klasöründe npm install`
        : `WhatsApp kütüphanesi (Baileys) yüklenemedi (${String(e?.message || e).slice(0, 120)}): gundem-video klasöründe npm install`;
      if (st.error !== err) push(`✖ ${err}`);
      st.error = err; return status();
    }
    const { default: makeWASocket, useMultiFileAuthState, makeCacheableSignalKeyStore, DisconnectReason, fetchLatestBaileysVersion } = baileys;
    const v7 = !!baileys.isPnUser; // 7.x (6.7.x'te isJidUser vardı)
    st.lib = libVersion() || (v7 ? "7.x" : "6.x");
    const pino = (await import("pino")).default;
    const logger = pino({ level: "silent" });
    mkdirSync(AUTH_DIR, { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    // sürüm sorgusu hata atmaz ama ağ takılırsa bekletebilir; olmazsa paketteki sürüm (version: undefined varsayılanı ezerdi)
    let version; try { ({ version } = await timeout(fetchLatestBaileysVersion(), 10000)); } catch { /* paketteki sürüm */ }
    if (sock || stopping || g !== gen) return status(); // beklerken başka yol bağlandı ya da durduruldu
    sock = makeWASocket({
      // anahtarlar bellekte önbellekli (her şifrelemede diskten JSON okunmasın; v7'de anahtar başına kilit)
      auth: { creds: state.creds, keys: makeCacheableSignalKeyStore ? makeCacheableSignalKeyStore(state.keys, logger) : state.keys },
      ...(Array.isArray(version) ? { version } : {}), logger, browser: ["Emixhas", "Chrome", "4.0.0"], markOnlineOnConnect: false,
      // geçmiş: tam geçmiş istenmez; v7'de geçmiş eşitlemesi kapatılmaz (LID ↔ numara eşlemeleri oradan gelir)
      syncFullHistory: false,
      getMessage: async (key) => { const m = sentGet(key?.id); const e = retries.get(key?.id); if (e && !m) e.miss = true; return m; },
      msgRetryCounterCache,
      maxMsgRetryCount: v7 ? 10 : 5, // v7 her istekte sayacı iki kez artırıyor: 5'te yalnız 2 yeniden gönderim kalıyordu
    });
    st.status = "connecting"; st.error = null; st.connectingSince = Date.now(); st.userStopped = false;
    sock.ev.on("creds.update", () => saveCreds().catch((e) => { if (existsSync(AUTH_DIR)) push(`✖ WhatsApp oturum dosyası yazılamadı: ${e.code || e.message}`); }));
    const me = sock; // eski soketin geç gelen olayları (bekçi yenisini kurduktan sonra) yeni bağlantıyı bozmasın
    // kendine-mesaj sohbetinde kendi telefonumuzun "yeniden gönder" isteğinde `recipient` yok: Baileys remoteJid'i boş bulup yeniden
    // gönderirken hata veriyordu (inceleme, 19 Ekim). Bu olay Baileys'in işlediği CB:receipt'ten ÖNCE aynı düğümle gelir: adres eklenir
    try { sock.ws?.on?.("CB:receipt,type:retry", (n) => {
      try { const a = n?.attrs; if (a && !a.recipient && !a.participant && a.from && isSelfChat(a.from)) a.recipient = baileys.jidNormalizedUser(a.from); } catch { /* adres eklenemedi */ }
      if (me === sock) onRetryReceipt(n);
    }); } catch { /* teşhis yok */ }
    sock.ev.on("lid-mapping.update", ({ lid, pn } = {}) => { if (me === sock && isLid(lid) && isOwner(pn)) setOwnerLid(userOf(lid)); }); // yalnız v7
    sock.ev.on("connection.update", async (u) => {
      if (me !== sock) return;
      if (u.qr) { st.qr = u.qr; st.qrSvg = await QRCode.toString(u.qr, { type: "svg", margin: 1, color: { dark: "#FFFFFF", light: "#00000000" } }); st.status = "qr"; push("💬 WhatsApp: QR hazır, panelden telefonunuzla okutun"); }
      if (u.connection === "open") {
        st.status = "connected"; st.qr = st.qrSvg = null; st.retries = 0; st.connectingSince = null; st.lastOkAt = Date.now(); st.probeFails = 0;
        st.phone = selfPhone(); push(`💬 WhatsApp bağlandı: +${st.phone}`); announce("WhatsApp bağlandı."); noteLib();
        setTimeout(() => learnOwnerLid(), 3000); setTimeout(() => flushOutbox().catch(() => {}), 5000);
      }
      if (u.connection === "close") {
        const code = u.lastDisconnect?.error?.output?.statusCode;
        sock = null; st.status = "disconnected";
        if (code === DisconnectReason.loggedOut) { st.error = "Oturum kapatıldı; yeniden QR gerekir"; rmSync(AUTH_DIR, { recursive: true, force: true }); push("💬 WhatsApp oturumu kapandı (telefondan çıkış yapılmış)"); return; }
        if (!stopping && st.retries++ < 8) { push(`💬 WhatsApp bağlantısı koptu (kod ${code}), yeniden deneniyor`); clearTimeout(retryStart); retryStart = setTimeout(() => { if (!st.userStopped) start().catch((e) => push(`✖ WhatsApp: ${e.message}`)); }, 3000 * st.retries); }
      }
    });
    sock.ev.on("messages.upsert", async ({ messages, type }) => {
      if (sock && me !== sock) return; // yerine yenisi kurulmuş eski soketin geç olayı: iki soket aynı komutu iki kez işlemesin
      for (const m of messages) {
        if (!m.message || isOurs(m.key.id)) continue;
        const from = m.key.remoteJid || ""; const k = m.key;
        if (from.endsWith("@g.us") || from.endsWith("@broadcast") || from.endsWith("@newsletter")) continue; // gruplar, durumlar
        const selfChat = isSelfChat(from);
        // bağlı numaranın başka sohbetlere yazdıkları komut değildir; kendine-mesaj sohbetinde yazılanlar komuttur
        if (k.fromMe && !selfChat) continue;
        // telefondan kendine yazılan mesaj "append" gelebilir; eski geçmiş (5 dk'dan eski) işlenmez
        if (type !== "notify" && !(k.fromMe && selfChat)) continue;
        const ts = Number(m.messageTimestamp || 0) * 1000; if (ts && Date.now() - ts > 5 * 60000) continue;
        const ids = [from, k.participant, k.remoteJidAlt, k.participantAlt, k.senderPn, k.participantPn, k.senderLid, k.participantLid].filter(Boolean);
        const pnCands = ids.filter((j) => !isLid(j));
        const lid = ids.find(isLid);
        if (lid && !knownOwnerLids.has(userOf(lid))) await learnOwnerLid();
        // numarası gizli LID mesajı (karşı kimlik gelmedi): v7'nin yerel eşleme deposuna bakılır
        if (lid && !pnCands.length && !knownOwnerLids.has(userOf(lid))) { const pn = await pnForLid(lid); if (pn) pnCands.push(pn); }
        let owner = selfChat || pnCands.some(isOwner) || (!!lid && knownOwnerLids.has(userOf(lid)));
        if (owner && lid && !selfChat) setOwnerLid(userOf(lid));
        // video: doğrudan, belge olarak ya da süreli/tek görümlük mesaj içinde gelebilir
        const inner = m.message.ephemeralMessage?.message || m.message.viewOnceMessage?.message || m.message.viewOnceMessageV2?.message || m.message.documentWithCaptionMessage?.message || m.message;
        const vm = inner.videoMessage || (String(inner.documentMessage?.mimetype || "").startsWith("video/") ? inner.documentMessage : null);
        const text = (inner.conversation || inner.extendedTextMessage?.text || inner.imageMessage?.caption || vm?.caption || "").trim();
        if (!owner) {
          if (text && Date.now() - lastIgnoredLog > 60000) {
            lastIgnoredLog = Date.now();
            const hidden = !pnCands.length; const who = userOf(pnCands[0] || from); const o = ownerDigits();
            push(`💬 WhatsApp: sahip olmayan göndericiden mesaj yok sayıldı (…${who.slice(-4)}${hidden ? ", numara gizli (LID)" : ""}); sahip numarası ${o ? "…" + o.slice(-4) : "AYARLANMAMIŞ"} — yanlışsa Ayarlar → WhatsApp → sahip numarası`);
            st.lastIgnored = { at: Date.now(), from: "…" + who.slice(-4), lid: !!lid && hidden };
          }
          continue;
        }
        if (!text && !vm) continue;
        st.lastMsgAt = Date.now();
        // yanıt: mesajın geldiği sohbetin adresine (WhatsApp'ın kendi adreslemesi; LID sohbetinde LID, kendine-mesajda kendi adresimiz).
        // Eskiden hep telefon jid'ine yazılıyordu: 6.7.x numara ve LID için iki ayrı şifreleme oturumu tuttuğundan telefon numara
        // oturumuyla şifrelenen yanıtı çözemiyordu ("Mesaj bekleniyor", 19 Ekim). v7 numarayı da aynı LID oturumuna çevirir.
        const replyTo = normJid(from) || await ownerTarget();
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

  // süren gönderim/indirme sayısı (panel güncellemesi bunlar bitmeden yeniden başlatmasın: video ve onay mesajı yarıda kalırdı)
  let sending = 0, downloading = 0;
  const busy = () => sending > 0 || downloading > 0;
  async function onOwnerVideo(...a) { downloading++; try { return await onOwnerVideo0(...a); } finally { downloading--; } }
  async function onOwnerVideo0(jid, msg, vm, caption) {
    const mb = Number(vm.fileLength || 0) / 1048576;
    if (mb > 500) { await send(jid, `Video çok büyük (${Math.round(mb)} MB); en çok 500 MB gönderin.`); return; }
    const dir = path.join(ROOT, "work", "wa_inbox"); mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${Date.now()}-${String(msg.key.id || "v").replace(/[^\w-]/g, "").slice(0, 24)}.mp4`);
    push(`🎬 WhatsApp'tan video geliyor (${mb ? mb.toFixed(1) + " MB" : "boyut bilinmiyor"}${vm.seconds ? `, ${vm.seconds} sn` : ""})${caption ? `: ${caption.slice(0, 80)}` : ""}`);
    const pino = (await import("pino")).default;
    const s0 = sock, dl = () => baileys.downloadMediaMessage(msg, "stream", {}, { logger: pino({ level: "silent" }), reuploadRequest: s0.updateMediaMessage });
    let stream;
    try { stream = await dl(); }
    catch (e) { // adres eskimiş (404/410): telefondan yeniden yükleme istenir. v7'nin kendi denemesi hata kodunu yanlış alandan okuyor, hiç çalışmıyor
      const code = e?.output?.statusCode ?? e?.response?.status ?? e?.status;
      if (![404, 410].includes(code) || !s0?.updateMediaMessage) throw e;
      push("🎬 WhatsApp videosunun indirme adresi eskimiş; telefondan yeniden yükleme isteniyor");
      await s0.updateMediaMessage(msg); stream = await dl();
    }
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
      const loose = st.pending.restored && !plats.length && /^(evet|ok|tamam)(\s|$|[.,!])/.test(t); // yeniden başlamadan kalan onayda gevşek cevap yayınlamaz
      const approve = !loose && (APPROVE.test(t) || (plats.length && words <= 6 && /(onay|yayınla|yayinla|paylaş|paylas|yükle|yukle)/.test(t)) || (plats.length && /^(sadece|yalnız|yalniz)\s/.test(t)));
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
    try { await sock?.sendPresenceUpdate?.("composing", jid); } catch { /* "yazıyor…" gösterilemedi */ }  // Claude düşünürken
    const r = await handleCommand(text, { source: "whatsapp" });
    try { await sock?.sendPresenceUpdate?.("paused", jid); } catch { /* yok */ }
    let reply = r.reply || "Tamam.";
    // kısa modda rapor yalnız istenirse (rapor, liste, detay…) eklenir; yanıt en çok ~700 karakter
    if (r.report && (!brief() || /(rapor|liste|detay|ayrıntı|hepsini|tamamını)/.test(t))) reply += "\n\n" + r.report.slice(0, 3500);
    else if (brief() && reply.length > 700 && !/evet sil/.test(reply)) reply = reply.slice(0, 690).replace(/\s\S*$/, "") + " …";
    if (r.pending?.length) { reply += "\n\n(Bu eylem panelden onay bekliyor.)"; }
    await send(jid, reply);
  }

  const addSent = (id) => { if (id) { sentIds.add(id); if (sentIds.size > 500) sentIds.delete(sentIds.values().next().value); } };
  const remember = (r) => { addSent(r?.key?.id); storeSent(r); return r; };
  // tek gönderim kapısı: kimlik gönderimden ÖNCE ayrılır (kendine-mesajda kendi yankımız komut sanılmasın), mesaj yeniden gönderme
  // deposuna yazılır (getMessage)
  async function sendRaw(jid, content) {
    let id = null; try { id = baileys.generateMessageIDV2?.(sock.user?.id) || null; } catch { /* Baileys kendi üretir */ }
    addSent(id);
    return remember(await sock.sendMessage(jid, content, id ? { messageId: id } : {}));
  }
  // bağlantı koptuğunda gönderilemeyen metin mesajları kaybolmasın: kuyruğa girer (en çok 30, 12 saat), bağlanınca sırayla gider.
  // jid null = sahip: adres gönderirken seçilir (beklerken LID'i öğrenilmiş olabilir)
  const outbox = [];
  async function send(jid, text) {
    if (!sock || st.status !== "connected") {
      if (outbox.length < 30) outbox.push({ jid, text, at: Date.now() });
      push(`💬 WhatsApp bağlı değil; mesaj kuyruğa alındı (${outbox.length} bekliyor), bağlantı gelince gönderilecek`);
      return;
    }
    await sendRaw(jid || await ownerTarget(), { text });
  }
  async function flushOutbox() {
    const items = outbox.splice(0).filter((x) => Date.now() - x.at < 12 * 3600000);
    if (!items.length) return;
    push(`💬 WhatsApp yeniden bağlandı: kuyruktaki ${items.length} mesaj gönderiliyor`);
    for (const x of items) { try { await sendRaw(x.jid || await ownerTarget(), { text: x.text }); } catch { outbox.push(x); break; } }
  }
  async function sendLink(jid, url, title, description, thumb) {
    try {
      await sendRaw(jid, { text: `${title}\n${url}`, linkPreview: { "canonical-url": url, "matched-text": url, title, description, ...(thumb ? { jpegThumbnail: thumb } : {}) } });
    } catch (e) { push(`💬 link gönderilemedi (${e.message}); düz metin deneniyor`); await send(jid, `${title}\n${url}`); }
  }
  async function sendVideo(jid, file, caption) {
    const size = statSync(file).size;
    if (size > 60 * 1024 * 1024) { await send(jid, `${caption}\n(Video 60 MB'den büyük, dosya gönderilmedi; linkten izleyin.)`); return null; } // null: metin olarak gitti
    await sendRaw(jid, { video: readFileSync(file), caption, mimetype: "video/mp4" });
    return true;
  }

  /** Üretim bitince sahibine metin + linkler (+ dosya) gönderir ve onay bekler. */
  // Tek mesaj modunun yayın satırları (post_pipeline "📤 platform: …") → platform başına son durum, kısa
  const PL = { youtube: "YouTube", instagram: "Instagram", tiktok: "TikTok" };
  const SHORT = { youtube: "youtube", instagram: "insta", tiktok: "tiktok" };
  // kısa mesaj modu (kullanıcı isteği, 14 Ekim: "uzun mesajlar atmasın, aşamaları bildirmesin; sorun varsa, işe başladıysa, başarılıysa
  // onu bildirsin"): settings.whatsapp.brief (varsayılan açık)
  const brief = () => settings().whatsapp?.brief !== false;
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
    if (v.firstComment) return brief() ? "" : "\n   💬 ilk yorum yazıldı";
    if (v.commentError) return /izni yok/.test(v.commentError)
      ? `\n   💬 ilk yorum yazılamadı: yorum izni yok → panelde ${PL[pl]} kartında 🔄 Yeniden bağla (izin gelince kendiliğinden yazılır)`
      : `\n   💬 ilk yorum yazılamadı (${String(v.commentError).slice(0, 80)}); 20 dk içinde yeniden denenecek`;
    return "";
  };
  // onay satırı: hepsi için "onay", tek platform için "onay insta" …
  const approveLine = (platforms) => brief()
    ? `\n\nYayın: *onay* (${platforms.map((pl) => PL[pl]).join(", ")})${platforms.length > 1 ? ` · ${platforms.map((pl) => `*onay ${SHORT[pl]}*`).join(" · ")}` : ""} · *iptal*`
    : `\n\n✅ Hepsinde yayınlamak için *onay* → ${platforms.map((pl) => PL[pl]).join(", ")}` +
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

  async function notifyVideo(...a) { sending++; try { return await notifyVideo0(...a); } finally { sending--; } }
  async function notifyVideo0(name, { ask = true, summary = null } = {}) {
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
      if (v0) await send(null, `🎬 Yeni video hazır — ${v0.label}\n${v0.segments.filter((x) => x.kind === "haber").slice(0, 5).map((x) => `• ${x.title}`).join("\n")}` +
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
    const jid = await ownerTarget();
    if (summary && brief()) { // kısa: ne hazır, nerede yayında, sorun varsa ne, onay gerekiyorsa tek satır
      const first = v.segments.find((s) => s.kind === "haber")?.title || v.label;
      const pub = publishLines(summary).filter((l) => !/^ℹ️/.test(l));
      const okPl = pub.filter((l) => l.startsWith("✅")).map((l) => l.replace(/^✅ /, "").replace(/[:\s(].*$/, ""));
      const bad = pub.filter((l) => !l.startsWith("✅")).map((l) => l.slice(0, 90));
      const pending = needAsk ? approveLine(platforms) : "";
      const msg = [`✅ *Video hazır*: ${first} (${v.duration ?? "?"} sn)`, okPl.length && !schedAt ? `📤 Yayında: ${okPl.join(", ")}` : "",
        ...(schedAt ? [] : bad), schedAt ? `⏰ ${whenLabel(schedAt)}'de yayınlanacak` : ""].filter(Boolean).join("\n") + pending;
      let fileSent = false;
      if (w.sendVideoFile !== false) { try { fileSent = await sendVideo(jid, v.path, msg); } catch (e) { push(`💬 video dosyası gönderilemedi: ${e.message}`); } }
      if (fileSent === false) await send(jid, msg);
      if (pending) st.pending = { video: name, label: v.label, platforms, at: Date.now() };
      push(`💬 WhatsApp'a kısa bildirim gönderildi: ${v.label}${fileSent ? " (+video)" : ""}${st.pending ? " · onay bekleniyor" : ""}`);
      return { ok: true, fileSent, awaitingApproval: !!pending };
    }
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

  // v7'de end() async (kapanma olayı sonra gelir; o sırada sock başka/boş olduğundan me !== sock ile yok sayılır)
  const endSock = (s, err) => { try { const p = s?.end?.(err); p?.catch?.(() => {}); } catch { /* yok */ } };
  // bekleyen yeniden deneme de iptal (eskiden "durdur"dan sonra kopmanın zamanlayıcısı bağlantıyı yeniden açıyordu)
  async function stop() { stopping = true; st.userStopped = true; gen++; starting = null; clearTimeout(retryStart); endSock(sock); sock = null; st.status = "disconnected"; stopping = false; return status(); }

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
        endSock(sock, new Error("bekçi: bağlanma takıldı"));
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
      endSock(sock, new Error("bekçi: yanıt yok"));
      sock = null; st.status = "disconnected"; st.retries = 0; await start();
      return { ok: false, reconnecting: true };
    }
  }
  async function logout() { try { await sock?.logout?.(); } catch { /* yok */ } await stop(); rmSync(AUTH_DIR, { recursive: true, force: true }); st.phone = null; return status(); }
  const status = () => ({ lastOkAt: st.lastOkAt || null, reconnects: st.reconnects || 0, outbox: outbox.length, lastIgnored: st.lastIgnored || null, selfPhone: selfPhone() ? "…" + selfPhone().slice(-4) : null, status: st.status, qrSvg: st.qrSvg, phone: st.phone, error: st.error, owner: ownerDigits() || null, pending: st.pending ? { video: st.pending.video, platforms: st.pending.platforms } : null, hasSession: existsSync(AUTH_DIR), lastMsgAt: st.lastMsgAt, lib: st.lib || null, node: process.versions.node, retry: st.retryInfo || null });
  const clearPending = (video) => { if (st.pending && (!video || st.pending.video === video)) st.pending = null; };
  return { start, stop, logout, status, watchdog, send: (t) => send(null, t), notifyVideo, clearPending, busy };
}
