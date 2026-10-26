// WhatsApp köprüsü (Baileys, WhatsApp Web protokolü). Panelden QR okutulur; yalnızca sahip numarası komut verebilir.
// Video bitince: metin + izleme linkleri + (isteğe bağlı) video dosyası gönderir; "onay" gelince yayınlar.
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import QRCode from "qrcode";
import { HELP_TEXT } from "./help.js";
import { findLink } from "./commands.js";
import { strictCommand, numberGuard, hasNumber, cmdNorm } from "./videoqueue.js";
import { whenLabel, atLabel } from "./when.js";

export async function makeWhatsApp({ handleVideo = null, videoInstruction = null, videoWaiting = () => false, autoAll = () => false, automode = async () => ({ ok: false, error: "yok" }), statusText = async () => "durum yok", ROOT, settings, push, announce, handleCommand, publishVideo, videoInfo, links, queue = null }) {
  const AUTH_DIR = path.join(ROOT, "secrets", "wa-auth");
  const st = { status: "disconnected", qr: null, qrSvg: null, phone: null, error: null, pending: null, lastMsgAt: null, retries: 0 };
  // bekleyen yayın onayları diske yazılır: panel yeniden başlayınca ("güncelle", çökme) "onay" kaybolmasın (6 saatten eskisi okunmaz).
  // Birden çok (kullanıcı isteği, 20 Ekim: kuyruktan 3-5 video arka arkaya biter; eskiden her yeni video öncekinin onayını siliyordu):
  // liste [{id, video, label, title, platforms, at, partial, restored, numbered, deliveredAt}]; data/wa_pending.json {seq, seqAt, list} (HEAD'in
  // tek nesnesi ve dizi biçimi de okunur). NUMARA artan sayaçtan, 24 saat içinde tekrar etmez (4. tur, inceleme, 20 Ekim: liste boşalınca 1'e
  // dönen numara eski mesajdaki "onay 1"i yeni videoya bağlıyordu); aynı video yeniden bildirilirse numarası korunur. ULAŞTI (deliveredAt):
  // onay satırlı mesaj (ya da video + açıklaması) WhatsApp'a GERÇEKTEN gönderilince yazılır (bağlantı kopuksa kuyruktaki mesaj gidince);
  // onay komutları yalnız ulaşmış onaylarda iş görür, ulaşmamışı "henüz size ulaşmadı" diye yazar (4. tur, inceleme, 20 Ekim: dosyası
  // gönderilmekte olan videonun onayı "onay hepsi" ile yayınlanıyordu — sahip kendi onay mesajını görmeden hiçbir video yayınlanmaz).
  // numbered: mesajı numaralı mı (gönderilirken başka bekleyen var mıydı ya da kuyruk videosu mu: kuyruk videosunun onay mesajı her zaman
  // numarasını yazar; 6. tur, karar 1). Tek bekleyen, ulaşmış ve mesajı numarasızken numarasız onay/iptal HEAD'deki gibi (headSingle); diğer her
  // durumda numaralı. NUMARALI KOMUT YALNIZ TAM KALIP (6. tur, karar 2; videoqueue.js strictCommand): "onay 2", "onay 2 3", "onay #2", "#2 onay",
  // "2 onay" (+ insta/youtube/tiktok), "onay hepsi", "hepsini onayla", "iptal 2", "#2 iptal" (iptal: kuyruk işi ya da onay; videoqueue.cancelNos);
  // "#<rakam>" ya da onay/iptal sözü + rakam geçen başka her mesaj hiçbir şey yapmaz (numberGuard): numaralı liste + tam yazım.
  const PENDING_FILE = path.join(ROOT, "data", "wa_pending.json");
  let pend = [], seq = 0, seqAt = 0;
  // ÖMÜR (7. tur, inceleme, 21 Ekim: "o saatte *onay N* yazın" denen saatli kuyruk videosunun onayı 6 saatte düşüyor, aynı #N başka videoya
  // verilip o videoyu yayınlatıyordu): onay mesajından 6 saat, saatli kuyruk videosunda yayın saatinden 6 saat sonrasına kadar (keepUntil).
  // Süresi dolan onay 24 saat "süresi doldu" kaydında kalır: numarası başka videoya verilmez (heldNos → videoqueue nextNo), "onay N" süresinin
  // dolduğunu ve panelden yayınlanabileceğini söyler
  const lifeEnd = (p) => Math.max(Number(p.at || 0) + 6 * 3600000, Number(p.keepUntil) || 0);
  let expired = []; // [{id, video, title, at}]
  const resendBoot = []; // açılışta onay mesajı ulaşmamış videolar
  // diskten gelen onay "restored": yeniden başlamadan sonra gevşek "tamam/evet/ok" (örneğin "✅ Güncellendi" mesajına cevap) eski videoyu
  // yayınlamasın; yalnız açık "onay …" / "yayınla" / "paylaş" ya da platform adı
  try {
    const raw = JSON.parse(readFileSync(PENDING_FILE, "utf8")), ids = new Set();
    const legacy = raw && !Array.isArray(raw) && raw.video; // HEAD'in tek nesnesi: mesaj gittikten SONRA yazılırdı (ulaşmış, numarasız)
    const list = legacy ? [{ ...raw, deliveredAt: Number(raw.at) || Date.now(), numbered: false }] : Array.isArray(raw) ? raw : Array.isArray(raw?.list) ? raw.list : [];
    if (raw && !Array.isArray(raw) && !legacy) { seq = Number(raw.seq) > 0 ? Number(raw.seq) : 0; seqAt = Number(raw.seqAt) > 0 ? Number(raw.seqAt) : 0; }
    if (Array.isArray(raw?.expired)) expired = raw.expired.filter((e) => Number(e?.id) > 0 && Date.now() - Number(e.at || 0) < 24 * 3600000).slice(-30);
    for (const p of list) {
      if (p?.video && Number(p.id) > 0 && Date.now() > lifeEnd(p) && !expired.some((e) => e.id === Number(p.id))) expired.push({ id: Number(p.id), video: p.video, title: p.title || p.label || p.video, at: Date.now() });
      if (!p?.video || !Array.isArray(p.platforms) || Date.now() > lifeEnd(p)) continue;
      // onay mesajı gönderilemeden panel kapandı: sahip onay satırını hiç görmedi, onay beklenmez (video panelden yayınlanabilir)
      // (5. tur, inceleme, 20 Ekim: sahip videoyu hiç görmüyordu): bağlantı kurulunca onay mesajı bir kez yeniden gönderilir (resendBoot)
      if (p.deliveredAt === null) { resendBoot.push(p.video); push(`💬 WhatsApp: ${String(p.title || p.label || p.video).slice(0, 60)} videosunun onay mesajı gönderilemeden panel yeniden başladı; bağlantı kurulunca yeniden gönderilecek`); continue; }
      let id = Number(p.id) > 0 && !ids.has(Number(p.id)) ? Number(p.id) : 0; if (!id) id = Math.max(seq, 0, ...ids) + 1;
      ids.add(id); seq = Math.max(seq, id);
      pend.push({ ...p, id, numbered: !!p.numbered, deliveredAt: Number(p.deliveredAt) || Number(p.at) || Date.now(), restored: true });
    }
  } catch { /* yok */ }
  // sayaç liste boşalsa da kalır (24 saat içinde aynı numara verilmesin)
  const savePend = () => { try { writeFileSync(PENDING_FILE, JSON.stringify({ seq, seqAt, list: pend, expired })); } catch { /* yazılamadı: bellekte kalır */ } };
  // ömrü dolan onaylar düşer (süresi dolanlar kaydına), 24 saati dolan kayıt silinir
  function purgeExpired() {
    const now = Date.now(), gone = pend.filter((p) => now > lifeEnd(p)), n0 = expired.length;
    if (gone.length) { pend = pend.filter((p) => !gone.includes(p)); expired = [...expired.filter((e) => !gone.some((p) => p.id === e.id)), ...gone.map((p) => ({ id: p.id, video: p.video, title: p.title || p.label || p.video, at: now }))].slice(-30); }
    expired = expired.filter((e) => now - Number(e.at || 0) < 24 * 3600000);
    if (gone.length || expired.length !== n0) savePend();
  }
  Object.defineProperty(st, "pending", { enumerable: true, get: () => pend[0] || null }); // ilk bekleyen (eski alan)
  // kendi sayacı yalnız video kuyruğu bağlı değilken (eski düzen): 999'dan sonra en küçük boş numara, onay 1 saat boşken 1'den (karar 1)
  const nextNo = () => { const now = Date.now(); if (!pend.length && now - seqAt > 3600000) seq = 0; let n = seq, k = 0; do { n = n >= 999 ? 1 : n + 1; } while (pend.some((p) => p.id === n) && ++k < 999); seq = n; seqAt = now; return n; };
  // onay mesajından ÖNCE kaydedilir (numara ayrılır: aynı anda biten iki video aynı numarayı almasın), ulaştı bilgisi mesaj gidince (markDelivered)
  function setPending(video, { qno = 0, keepUntil = 0, ...fields } = {}) {
    const old = pend.find((p) => p.video === video);
    // numara video kuyruğunun sayacından (queue.number: kuyruk videosu kendi iş numarasını — videonun meta'sındaki queue.no, panel yeniden
    // başlasa da —, diğer video aynı sayaçtan yeni numara alır; "#3" ile "onay 3" aynı video); kuyruk bağlı değilse kendi sayacı
    let id = old ? old.id : 0;
    if (!id) { const used = pend.map((p) => p.id); try { id = Number(queue?.number?.(video, used, qno)) || 0; } catch { id = 0; } if (!id && qno > 0) id = qno; if (!id || used.includes(id)) id = nextNo(); else { seq = Math.max(seq, id); seqAt = Date.now(); } }
    const item = { ...fields, id, video, at: Date.now(), numbered: pend.some((p) => p.video !== video) || qno > 0, ...(qno > 0 ? { queue: true } : {}), ...(keepUntil > 0 ? { keepUntil } : {}), deliveredAt: null };
    expired = expired.filter((e) => e.id !== id && e.video !== video);
    pend = old ? pend.map((p) => (p === old ? item : p)) : [...pend, item]; savePend(); return item;
  }
  const markDelivered = (video) => { const p = pend.find((x) => x.video === video); if (p && !p.deliveredAt) { p.deliveredAt = Date.now(); savePend(); } };
  const replacePending = (p, item) => { pend = pend.map((x) => (x === p ? item : x)); savePend(); };
  const dropPending = (p) => { pend = pend.filter((x) => x !== p); savePend(); };
  const delivered = () => pend.filter((p) => p.deliveredAt);
  // HEAD'in tek onayı: tek bekleyen, mesajı ulaşmış ve numarasız
  const soloHead = () => (pend.length === 1 && pend[0].deliveredAt && !pend[0].numbered ? pend[0] : null);
  const selfPub = new Set(); // onayla yayınlanırken panelin clearPending'i (execAction) kısmi onayın kalanını silmesin
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
        if (resendBoot.length) setTimeout(() => resendUndelivered().catch((e) => push(`💬 onay mesajı yeniden gönderilemedi: ${e.message}`)), 7000);
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
        const tsv = m.messageTimestamp, ts = (tsv && typeof tsv === "object" && typeof tsv.toNumber === "function" ? tsv.toNumber() : Number(tsv || 0)) * 1000;
        if (ts && Date.now() - ts > 5 * 60000) continue;
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
          // iletilen video (başka sohbetten "İlet"): açıklama paylaşanın sözüdür, sahibin talimatı değil (inceleme, 19 Ekim: haber hesabının
          // "aynısını yapın", "#viral", "SON DAKİKA" açıklaması benzer video/tür/haber isteği sanılıyordu); panel bilgi olarak taşır
          const ci = vm.contextInfo || {}, forwarded = !!ci.isForwarded || Number(ci.forwardingScore) > 0;
          try { await onOwnerVideo(replyTo, { ...m, message: inner }, vm, text, forwarded); } catch (e) { push(`✖ WhatsApp videosu alınamadı: ${e.message}`); try { await send(replyTo, `Video alınamadı: ${e.message}`); } catch { /* bağlantı yok */ } }
          continue;
        }
        if (!text) continue;
        push(`💬 WhatsApp'tan: ${text.slice(0, 80)}`);
        try { await onOwnerMessage(replyTo, text, Number.isFinite(ts) && ts > 0 ? ts : 0); } catch (e) { push(`✖ WhatsApp komutu: ${e.message}`); try { await send(replyTo, `Hata: ${e.message}`); } catch { /* bağlantı yok */ } }
      }
    });
    return status();
  }

  // süren gönderim/indirme sayısı (panel güncellemesi bunlar bitmeden yeniden başlatmasın: video ve onay mesajı yarıda kalırdı)
  let sending = 0, downloading = 0;
  const busy = () => sending > 0 || downloading > 0;
  async function onOwnerVideo(...a) { downloading++; try { return await onOwnerVideo0(...a); } finally { downloading--; } }
  async function onOwnerVideo0(jid, msg, vm, caption, forwarded = false) {
    const mb = Number(vm.fileLength || 0) / 1048576;
    if (mb > 500) { await send(jid, `Video çok büyük (${Math.round(mb)} MB); en çok 500 MB gönderin.`); return; }
    const dir = path.join(ROOT, "work", "wa_inbox"); mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${Date.now()}-${String(msg.key.id || "v").replace(/[^\w-]/g, "").slice(0, 24)}.mp4`);
    push(`🎬 WhatsApp'tan ${forwarded ? "iletilen " : ""}video geliyor (${mb ? mb.toFixed(1) + " MB" : "boyut bilinmiyor"}${vm.seconds ? `, ${vm.seconds} sn` : ""})${caption ? `: ${caption.slice(0, 80)}` : ""}`);
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
    // gönderim anı (albüm penceresi indirme süresinden bağımsız ölçülsün: büyük albüm videosu 8 sn'den uzun inebilir)
    const sentAt = Number(msg.messageTimestamp) * 1000;
    const r = await handleVideo({ file, caption, seconds: vm.seconds || null, forwarded, sentAt: Number.isFinite(sentAt) && sentAt > 0 ? sentAt : Date.now() });
    if (r) await send(jid, r);
  }

  // at: mesajın WhatsApp zaman damgası (yazıldığı an, ms; yoksa şimdi). Onay mesajı bu andan SONRA ulaşan video bu mesajla onaylanmaz (7. tur,
  // inceleme, 21 Ekim: telefon çevrimdışıyken yazılıp geç gelen "onay 51", ya da #53'ün mesajı ulaşmadan yazılmış "onay hepsi" onu da yayınlıyordu;
  // WhatsApp saniye yuvarlar: 2 sn pay)
  async function onOwnerMessage(jid, text, at = 0) {
    const t = text.toLocaleLowerCase("tr-TR").trim();
    if (!(at > 0) || at > Date.now()) at = Date.now();
    purgeExpired(); // ömrü dolan onay istekleri düşer (saatli kuyruk videosunda yayın saatinden 6 saat sonra)
    // "trend" geçen mesaj 5 saatlik üretim zamanlayıcısına (tam otomatik mod) hiç gitmez, trend otomatiğine gider (videoqueue.js; 4. tur:
    // "otomatik kapat trendleri" zamanlayıcıyı kapatıyordu)
    // olumsuzu ("otomatik modu kapatma", "açmayın") zamanlayıcıya dokunmaz (7. tur)
    if (!/(?:^|[^\p{L}])trend(?!yol)/u.test(t) && /^(otomatik|tam otomatik)( mod)?u? (aç|başlat|kapat|durdur)(?!m[ae])/.test(t)) { const on = /(aç|başlat)/.test(t); const r = await automode(on); await send(jid, r.ok ? (on ? `⚡ Tam otomatik mod açık: her ${r.hours} saatte üretim, otomatik yayın → ${r.connected.join(", ") || "bağlı hesap yok"}.` : "⏹ Otomatik üretim ve yayın durduruldu.") : `Olmadı: ${r.error}`); return; }
    // Yayın onayı (kullanıcı isteği: "onay yazarsam tüm platformlarda, onay insta yazarsam yalnız Instagram'da paylaşsın"):
    // "onay" / "onay hepsi" → bekleyen tüm platformlar; "onay insta", "onay youtube tiktok", "insta onay", "sadece instagram" → yalnız
    // yazılanlar, kalanlar beklemede kalır (yalnız açık "onay …" ile yayınlanır; "tamam/evet" artık kalanları yayınlamaz).
    // linkli mesaj yeni video isteğidir, yayın onayı ya da iptali değil (inceleme, 20 Ekim: onay beklerken gönderilen "<reel linki> insta'da paylaş"
    // linkteki "instagram" ve "paylaş" yüzünden bekleyen videoyu yayınlıyor, link kayboluyordu)
    const hasLink = !!findLink(text);
    // NUMARALI KOMUTLAR (6. tur, karar 2; inceleme, 20 Ekim: "#3 yayınlanmasın", "onay 3 değil 4", "#3 iptal etme", "#3'ü bana at" #3'ü
    // yayınlıyor ya da onayını düşürüyordu): yalnız mesajın TAMAMI kalıpsa iş görür. "onay 3" / "#3 onay" / "onay hepsi" burada (yalnız size
    // ulaşmış onay mesajlarında); "iptal 3" / "#3 iptal" / "kuyruk iptal 3" kuyruk işini ya da onayı numarasıyla bırakır (handleCommand →
    // videoqueue.cancelNos). "#<rakam>" ya da onay/iptal sözü + rakam geçen başka her mesaj HİÇBİR ŞEY yapmaz (yayın, iptal, komut, beyin yok):
    // numaralı liste + tam yazım. Linkli mesaj yeni video isteğidir (aşağıda)
    const sc = !hasLink ? strictCommand(text) : null;
    if (sc?.kind === "approve") { await approveCmd(jid, sc, at); return; }
    // talimat bekleyen WhatsApp videosu ("Nasıl bir haber yapayım?"): "30 saniye, 18:30'da paylaş" gibi numaralı söz videonun talimatıdır, korumaya
    // girmez; "#numara" ya da onay/iptal sözü geçen mesaj yine korumaya girer (7. tur)
    const instr = !hasLink && !sc && (() => { try { return !!videoWaiting() && !/[#＃]|(?:^|[^\p{L}])(?:onay\p{L}*|iptal\p{L}*)(?![\p{L}])/u.test(t); } catch { return false; } })();
    if (!hasLink && !sc && !instr && numberGuard(text)) { await send(jid, guardReply()); return; }
    if (sc?.kind === "cancel" && !queue?.cancel) { await cancelLocal(jid, sc.nos); return; } // kuyruk bağlı değil (eski düzen): yalnız onaylar
    // numarasız onay/iptal sözü ("onay", "evet", "onay insta", "iptal"): tek bekleyen, ulaşmış ve mesajı numarasızken HEAD'deki gibi
    // (headSingle); diğer her durumda (birden çok bekleyen, mesajı numaralı — kuyruk videosu — ya da henüz ulaşmamış onay) numaralı liste
    const solo = soloHead();
    if (!hasLink && !sc && pend.length) {
      const sil = /(^|\s)sil/.test(t); // "evet sil" = Instagram temizliği onayı (HEAD gibi: yayın onayı değil)
      // numarasız sayılan onay sözü ya da platform adı ("sadece instagram", "insta onay", "insta 2") rakam ya da sıra sayısıyla: numaralı söz, tam kalıp değil
      // (inceleme, 20 Ekim: "sadece instagram, 3 numaralı video için" tek bekleyen başka videoyu yayınlıyordu) → hiçbir şey yapılmaz
      if (!sil && hasNumber(text) && (bareAsks(t) || pickPlatforms(t).length)) { await send(jid, guardReply()); return; }
      // platform dışlama ("onay instasız", "onay insta hariç", "youtube olmasın") ya da soru ("onay ?", "onay ❓", "onay 🤔"; cmdNorm "?"): numarasız
      // da hiçbir şey yayınlamaz, liste döner (7. tur, inceleme, 21 Ekim: "instasız" Instagram sayılıp yalnız Instagram'a yayınlanıyordu)
      if (!sil && (bareAsks(t) || pickPlatforms(t).length) && (PRIV.test(t) || cmdNorm(text).includes("?"))) {
        await send(jid, guardReply(PRIV.test(t) ? "Bu mesajla hiçbir şey yayınlanmadı: platform dışlama (\"instasız\", \"insta hariç\") anlaşılmıyor; yalnız yayınlanacak platformları yazın (ör. *onay youtube*)." : "Bu mesajla hiçbir şey yayınlanmadı: soru ya da soru/olumsuz emojili onay iş görmez.")); return;
      }
      if (solo) { if (await headSingle(jid, t, solo, "", !sil, at)) return; }
      else if (!sil && await bareMulti(jid, t, at)) return;
    }
    // talimatı bekleyen WhatsApp videosu: bu mesaj nasıl bir haber istendiğidir ("iptal" vazgeçer)
    if (videoInstruction && !sc) { const vr = await videoInstruction(text); if (vr) { if (typeof vr === "string") await send(jid, vr); return; } } // "düzelt …" talimat değil
    if (/^(yardım|help|\?|komutlar|komut listesi|neler yapabilirsin)$/.test(t)) { await send(jid, HELP_TEXT); return; }
    if (/^(durum|status|ne var ne yok)$/.test(t)) { await send(jid, await statusText()); return; }
    if (/(son videoyu|videoyu) (gönder|yolla|at)/.test(t)) { const v = videoInfo(); if (!v) return send(jid, "Video yok."); await notifyVideo(v.name, { ask: false, force: true }); return; } // sahip istedi: kendi ürettiği video da gider
    try { await sock?.sendPresenceUpdate?.("composing", jid); } catch { /* "yazıyor…" gösterilemedi */ }  // Claude düşünürken
    const r = await handleCommand(text, { source: "whatsapp" });
    try { await sock?.sendPresenceUpdate?.("paused", jid); } catch { /* yok */ }
    let reply = r.reply || "Tamam.";
    // kısa modda rapor yalnız istenirse (rapor, liste, detay…) eklenir; yanıt en çok ~700 karakter
    if (r.report && (!brief() || /(rapor|liste|detay|ayrıntı|hepsini|tamamını)/.test(t))) reply += "\n\n" + r.report.slice(0, 3500);
    else if (brief() && reply.length > 700 && !/evet sil/.test(reply) && !r.full) reply = reply.slice(0, 690).replace(/\s\S*$/, "") + " …"; // full: kuyruk/trend listesi
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
  // jid null = sahip: adres gönderirken seçilir (beklerken LID'i öğrenilmiş olabilir). Dönüş: gönderildi (true) / kuyruğa girdi (false);
  // onSent mesaj gerçekten gidince çağrılır (onay mesajının "ulaştı" bilgisi: markDelivered)
  const outbox = [];
  async function send(jid, text, onSent = null) {
    if (!sock || st.status !== "connected") {
      if (outbox.length < 30) outbox.push({ jid, text, at: Date.now(), onSent });
      push(`💬 WhatsApp bağlı değil; mesaj kuyruğa alındı (${outbox.length} bekliyor), bağlantı gelince gönderilecek`);
      return false;
    }
    await sendRaw(jid || await ownerTarget(), { text });
    try { onSent?.(); } catch { /* yok */ }
    return true;
  }
  async function flushOutbox() {
    const items = outbox.splice(0).filter((x) => Date.now() - x.at < 12 * 3600000);
    if (!items.length) return;
    push(`💬 WhatsApp yeniden bağlandı: kuyruktaki ${items.length} mesaj gönderiliyor`);
    for (const x of items) { try { await sendRaw(x.jid || await ownerTarget(), { text: x.text }); } catch { outbox.push(x); break; } try { x.onSent?.(); } catch { /* yok */ } }
  }
  async function sendLink(jid, url, title, description, thumb) {
    try {
      await sendRaw(jid, { text: `${title}\n${url}`, linkPreview: { "canonical-url": url, "matched-text": url, title, description, ...(thumb ? { jpegThumbnail: thumb } : {}) } });
    } catch (e) { push(`💬 link gönderilemedi (${e.message}); düz metin deneniyor`); await send(jid, `${title}\n${url}`); }
  }
  // onSent: açıklama (onay satırı) gerçekten gidince (dosya ya da büyük dosyada metin; metin kuyruğa girdiyse kuyruktan gidince)
  async function sendVideo(jid, file, caption, onSent = null) {
    const size = statSync(file).size;
    if (size > 60 * 1024 * 1024) { await send(jid, `${caption}\n(Video 60 MB'den büyük, dosya gönderilmedi; linkten izleyin.)`, onSent); return null; } // null: metin olarak gitti
    await sendRaw(jid, { video: readFileSync(file), caption, mimetype: "video/mp4" });
    try { onSent?.(); } catch { /* yok */ }
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
  // platform adının yokluk eki ya da ardından dışlama sözü (7. tur): "instasız", "instagramsız", "youtube'suz", "tiktok hariç", "insta olmasın"
  const PRIV = /(?:[ıi]nsta|youtube|t[ıi]k\s?tok|reels?|shorts)\p{L}*?['’]?s[ıiuü]z|(?:[ıi]nsta|youtube|t[ıi]k\s?tok|reels?|shorts)[\p{L}'’]*\s+(?:hariç|haric|dışında|disinda|değil|degil|olmasın|olmasin|olmadan|yok)(?![\p{L}])/u;
  // mesajdaki platform adları (Türkçe küçük harfte "Insta" → "ınsta" olur; ı → i ile bakılır)
  function pickPlatforms(t) {
    const x = ` ${t.replace(/https?:\/\/\S+|\S+\.(?:com|be|net|org|tv|watch)\/\S*/gi, " ").replace(/ı/g, "i").replace(/[^a-zçğöşü0-9]+/g, " ")} `; // adres ("instagram.com/reel/…") platform adı değil
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
  // onay satırı: hepsi için "onay", tek platform için "onay insta" …; başka bekleyen varken numaralı ("onay 2", "onay 2 insta", "iptal 2")
  const approveLine = (platforms, id = null) => id ? (brief()
    ? `\n\nYayın: *onay ${id}* (${platforms.map((pl) => PL[pl]).join(", ")})${platforms.length > 1 ? ` · tek platform: ${platforms.map((pl) => `*onay ${id} ${SHORT[pl]}*`).join(" · ")}` : ""} · *iptal ${id}*`
    : `\n\n✅ Hepsinde yayınlamak için *onay ${id}* → ${platforms.map((pl) => PL[pl]).join(", ")}` +
    (platforms.length > 1 ? `\n▫️ Yalnız birinde: ${platforms.map((pl) => `*onay ${id} ${SHORT[pl]}*`).join(" · ")}` : "") + `\n❌ Yayınlamamak için *iptal ${id}*`) : brief()
    ? `\n\nYayın: *onay* (${platforms.map((pl) => PL[pl]).join(", ")})${platforms.length > 1 ? ` · ${platforms.map((pl) => `*onay ${SHORT[pl]}*`).join(" · ")}` : ""} · *iptal*`
    : `\n\n✅ Hepsinde yayınlamak için *onay* → ${platforms.map((pl) => PL[pl]).join(", ")}` +
    (platforms.length > 1 ? `\n▫️ Yalnız birinde: ${platforms.map((pl) => `*onay ${SHORT[pl]}*`).join(" · ")}` : "") + "\n❌ Yayınlamamak için *iptal*";
  // çizilmiş benzer video (meta recreated; kullanıcı isteği, 23 Ekim): sahip izleyip beğenmediği yeri yazar (server.js reviseCommand): yalnız o
  // sahneler yeniden çizilir, eski sürümün onayı kalkar, yeni sürüm gelince yine onay istenir
  const revLine = (v, id = null) => v?.recreated ? `\n✏️ Beğenmediğiniz yer varsa: *düzelt${id ? ` ${id}` : ""}: ne değişsin* (yalnız o sahne yeniden çizilir)` : "";
  const titleOf = (v) => v.segments?.find((s) => s.kind === "haber")?.title || v.label;
  // kuyruk videosu: otomatik trendden üretildiyse onay mesajında söylenir (6. tur: sahip videoyu kendisinin göndermediğini anlasın)
  const autoHint = (v) => (v?.queueSource === "trend-auto" ? "\n🤖 otomatik (trend)" : "");
  // yayın saatli kuyruk videosu (karar 3): saat kendiliğinden uygulanmaz, sahip onayı o saatte verir
  const queueTimeLine = (at, no) => `\n\n⏰ Yazdığınız yayın saati (${whenLabel(new Date(at))}) kuyruk videosunda kendiliğinden uygulanmaz; o saatte *onay ${no}* yazın (bu onay yayın saatinden 6 saat sonrasına kadar geçerli).`;
  // panelin clearPending'i (execAction publish) kendi onay yayınımızda kısmi onayın kalanını silmesin
  async function publishSelf(video, platforms) { selfPub.add(video); try { return await publishVideo(video, platforms); } finally { selfPub.delete(video); } }
  const pendLine = (p) => `#${p.id} ${String(p.title || p.label).slice(0, 70)} → ${p.platforms.map((pl) => PL[pl]).join(", ")}${p.partial ? " (kalanlar)" : ""}${p.deliveredAt ? "" : " · henüz size ulaşmadı"}`;
  const notYetText = (ps) => `${ps.map((p) => `#${p.id}`).join(", ")} ${ps.length > 1 ? "videoların" : "videonun"} onay mesajı henüz size ulaşmadı (gönderiliyor); mesaj gelince onaylayın.`;
  // numaralı liste; komutlar yalnız ulaşmış onaylar için
  const pendList = () => {
    const dl = delivered();
    if (!dl.length) return `⏳ ${notYetText(pend)}\n${pend.map(pendLine).join("\n")}`;
    return `⏳ Onay bekleyen ${pend.length} video var; hangisi?\n${pend.map(pendLine).join("\n")}\nYayın: ${dl.map((p) => `*onay ${p.id}*`).join(" · ")}${dl.length > 1 ? " · hepsi: *onay hepsi*" : ""} · tek platform: *onay ${dl[0].id} insta* · iptal: *iptal ${dl[dl.length - 1].id}*`;
  };
  // tek bekleyen: mesajı numarasızsa numarasız komutlar (sahibin gördüğü mesaj numara göstermedi; 5. tur), liste boşsa yalnız bu söylenir
  const oneLeft = () => (!pend.length ? "Onay bekleyen video yok."
    : pend.length === 1 && pend[0].deliveredAt ? (pend[0].numbered ? `Bekleyen video: ${pendLine(pend[0])} → *onay ${pend[0].id}* · *iptal ${pend[0].id}*`
      : `Bekleyen video: ${String(pend[0].title || pend[0].label).slice(0, 70)} → ${pend[0].platforms.map((pl) => PL[pl]).join(", ")}${pend[0].partial ? " (kalanlar)" : ""} → *onay* · *iptal*`) : pendList());
  const ttl = (p) => p.title || p.label; // numaralı yanıtlarda videonun başlığı (onay mesajındaki gibi; tarih etiketi değil)
  // HEAD'in tek onay yolu (kod ve yanıtlar HEAD'le aynı; note: ulaşmamış diğer onaylar için ek satır, approveOk false: "evet sil" onay değil).
  // Döner: mesaj işlendiyse true.
  // geç ulaşan onay mesajı: sahibin mesajı onay mesajını görmeden yazılmış (at + 2 sn'den sonra ulaştı)
  const lateFor = (p, at) => !!(at && p.deliveredAt && p.deliveredAt > at + 2000);
  const lateText = (ps, numbered = true) => `${numbered ? `${ps.map((p) => `#${p.id}`).join(", ")}: ` : ""}onay mesajı bu mesajınızdan SONRA size ulaştı (mesajınız onu görmeden yazılmış); hiçbir şey yayınlanmadı. Onay mesajını gördüyseniz yeniden yazın: ${numbered ? ps.map((p) => `*onay ${p.id}*`).join(" · ") : "*onay*"}`;
  async function headSingle(jid, t, p, note = "", approveOk = true, at = 0) {
    if (approveOk) {
      const plats = pickPlatforms(t);
      const words = t.split(/\s+/).length;
      const loose = p.restored && !plats.length && /^(evet|ok|tamam)(\s|$|[.,!])/.test(t); // yeniden başlamadan kalan onayda gevşek cevap yayınlamaz
      const approve = !loose && (APPROVE.test(t) || (plats.length && words <= 6 && /(onay|yayınla|yayinla|paylaş|paylas|yükle|yukle)/.test(t)) || (plats.length && /^(sadece|yalnız|yalniz)\s/.test(t)));
      if (approve && !(p.partial && !plats.length && !/^(onay|onayla|yayınla|yayinla|paylaş|paylas)/.test(t))) {
        if (lateFor(p, at)) { await send(jid, lateText([p], !!p.numbered) + note); return true; }
        const chosen = plats.length ? p.platforms.filter((pl) => plats.includes(pl)) : p.platforms;
        const missing = plats.filter((pl) => !p.platforms.includes(pl));
        if (!chosen.length) { await send(jid, `${missing.map((pl) => PL[pl]).join(", ")}: bu video için bekleyen yayında yok (hesap bağlı değil ya da zaten yayında). Bekleyen: ${p.platforms.map((pl) => PL[pl]).join(", ")}${note}`); return true; }
        const rest = p.platforms.filter((pl) => !chosen.includes(pl));
        if (rest.length) replacePending(p, { ...p, platforms: rest, partial: true, at: Date.now() }); else dropPending(p);
        await send(jid, `⏳ Yayınlanıyor: ${p.label} → ${chosen.map((pl) => PL[pl]).join(", ")}${missing.length ? `\n(${missing.map((pl) => PL[pl]).join(", ")} bekleyen listede yok)` : ""}${note}`);
        const r = await publishSelf(p.video, chosen);
        const lines = Object.entries(r.results || {}).map(([k, v]) => v.ok ? `✅ ${PL[k] || k}: ${v.skipped ? "zaten yayında" : (v.url || v.note || "tamam")}${v.skipped ? "" : commentNote(k, v)}` : `❌ ${PL[k] || k}: ${v.error}`);
        if (rest.length) lines.push(`\n⏸ Beklemede: ${rest.map((pl) => PL[pl]).join(", ")} → ${rest.map((pl) => `*onay ${SHORT[pl]}*`).join(" · ")} · bırakmak için *iptal*`);
        await send(jid, lines.join("\n") || "Yayınlanacak platform yok.");
        return true;
      }
    }
    if (/^(hayır|iptal|yayınlama|vazgeç|no)(\s|$|[.,!])/.test(t)) { dropPending(p); await send(jid, `Tamam, ${p.label}${p.partial ? ` kalan platformlarda (${p.platforms.map((pl) => PL[pl]).join(", ")})` : ""} yayınlanmadı.${note}`); return true; }
    return false;
  }
  // Numarasız onay/iptal sözü, HEAD'in tek onayı dışındaki her durumda ("onay", "evet", "onay insta", "iptal", "hayır"): ulaşmış TEK onay varsa ve
  // mesajı numarasızsa HEAD'deki gibi ona (headSingle; ulaşmamışlar için not), yoksa numaralı liste döner (4. tur, inceleme, 20 Ekim: tek kalan
  // videonun mesajı numaralıyken numarasız "onay" onu yayınlıyordu); gevşek "evet/tamam/ok" yalnız diskten gelen/kısmi onaylardaysa eskisi gibi
  // geçer. Döner: işlendiyse true.
  // HEAD'in onay ya da iptal saydığı numarasız söz (onay/evet/yayınla…, platform adıyla kısa onay, "sadece <platform>", iptal/hayır…)
  const bareAsks = (t) => { const plats = pickPlatforms(t), words = t.split(/\s+/).length; return !!(APPROVE.test(t) || (plats.length && words <= 6 && /(onay|yayınla|yayinla|paylaş|paylas|yükle|yukle)/.test(t)) || (plats.length && /^(sadece|yalnız|yalniz)\s/.test(t)) || /^(hayır|iptal|yayınlama|vazgeç|no)(\s|$|[.,!])/.test(t)); };
  async function bareMulti(jid, t, at = 0) {
    const plats = pickPlatforms(t);
    const dl = delivered(), wait = pend.filter((p) => !p.deliveredAt);
    const loose = !plats.length && /^(evet|ok|tamam)(\s|$|[.,!])/.test(t);
    const asks = bareAsks(t);
    if (!asks || (loose && pend.every((p) => p.restored || p.partial))) return false;
    if (dl.length === 1 && !dl[0].numbered) return headSingle(jid, t, dl[0], wait.length ? `\n(${notYetText(wait)})` : "", true, at);
    await send(jid, pend.length > 1 ? pendList() : oneLeft()); return true;
  }
  // Numaralı onay (yalnız tam kalıp, karar 2; videoqueue.strictCommand): "onay 2 [platform]", "onay 2 3", "#2 onay", "onay hepsi [platform]",
  // "hepsini onayla". YALNIZ ulaşmış onaylarda iş görür; ulaşmamış numara ya da "hepsi"nin içindeki ulaşmamış video "henüz size ulaşmadı" diye
  // yazılır (4. tur); numara henüz üretilmemiş kuyruk işiyse "henüz hazır değil" (kuyruk numarası videonun onay numarasıdır).
  async function approveCmd(jid, sc, at = 0) {
    const plats = sc.plats || [];
    const nums = sc.all ? null : sc.nums;
    if (!pend.length && !nums) { await send(jid, "Onay bekleyen video yok."); return; }
    const pool = nums ? pend.filter((p) => nums.includes(p.id)) : [...pend];
    let unknown = nums ? nums.filter((n) => !pend.some((p) => p.id === n)) : [];
    let qNote = "";
    // süresi dolan onay (7. tur): numarası 24 saat kayıtta; panelden yayınlanabilir
    let expNote = "";
    if (unknown.length) {
      const ex = unknown.filter((n) => expired.some((e) => e.id === n));
      if (ex.length) { expNote = ex.map((n) => { const e = expired.find((x) => x.id === n); return `#${n}: ${String(e.title || e.video).slice(0, 60)} — onay süresi doldu (onay mesajı 6 saatten eski); hiçbir şey yayınlanmadı. Yayınlamak için panelde video → yayınla.`; }).join("\n"); unknown = unknown.filter((n) => !ex.includes(n)); }
    }
    if (unknown.length && queue?.state) {
      const inQ = unknown.filter((n) => { try { return !!queue.state(n); } catch { return false; } });
      if (inQ.length) { qNote = inQ.map((n) => `#${n} henüz hazır değil (${queue.state(n)}); video gelince onay mesajındaki komutla yayınlayın.`).join("\n"); unknown = unknown.filter((n) => !inQ.includes(n)); }
    }
    // yalnız sahibin bu mesajı yazdığı anda ulaşmış onay mesajları (at; geç ulaşanlar "sonra ulaştı" notuyla kalır)
    const targets = pool.filter((p) => p.deliveredAt && !lateFor(p, at)), notYet = pool.filter((p) => !p.deliveredAt), late = pool.filter((p) => lateFor(p, at));
    if (!targets.length) { await send(jid, [expNote, qNote, late.length ? lateText(late) : "", notYet.length ? notYetText(notYet) : "", unknown.length ? `${unknown.map((n) => `#${n}`).join(", ")}: onay bekleyen video yok.${qNote || notYet.length || late.length || expNote || !pend.length ? "" : `\n${pend.length > 1 ? pendList() : oneLeft()}`}` : ""].filter(Boolean).join("\n")); return; }
    const note = (unknown.length ? `\n(${unknown.map((n) => `#${n}`).join(", ")}: onay bekleyen video yok)` : "") + (late.length ? `\n(${lateText(late)})` : "") + (notYet.length ? `\n(${notYetText(notYet)})` : "") + (qNote ? `\n${qNote}` : "") + (expNote ? `\n${expNote}` : "");
    const jobs = [], skip = [];
    for (const p of targets) {
      const chosen = plats.length ? p.platforms.filter((pl) => plats.includes(pl)) : p.platforms;
      if (!chosen.length) { skip.push(`#${p.id} ${plats.map((pl) => PL[pl]).join(", ")}: bekleyen yayında yok (bekleyen: ${p.platforms.map((pl) => PL[pl]).join(", ")})`); continue; }
      const rest = p.platforms.filter((pl) => !chosen.includes(pl));
      if (rest.length) replacePending(p, { ...p, platforms: rest, partial: true, at: Date.now() }); else dropPending(p);
      jobs.push({ p, chosen, rest });
    }
    if (!jobs.length) { await send(jid, skip.join("\n") + note); return; }
    const missing = plats.filter((pl) => jobs.every((j) => !j.p.platforms.includes(pl)));
    await send(jid, (jobs.length === 1 ? `⏳ Yayınlanıyor (#${jobs[0].p.id}): ${ttl(jobs[0].p)} → ${jobs[0].chosen.map((pl) => PL[pl]).join(", ")}${missing.length ? `\n(${missing.map((pl) => PL[pl]).join(", ")} bekleyen listede yok)` : ""}`
      : `⏳ ${jobs.length} video yayınlanıyor:\n${jobs.map((j) => `#${j.p.id} ${ttl(j.p)} → ${j.chosen.map((pl) => PL[pl]).join(", ")}`).join("\n")}`) + note);
    const out = [];
    for (const j of jobs) {
      const r = await publishSelf(j.p.video, j.chosen);
      const lines = Object.entries(r.results || {}).map(([k, v]) => v.ok ? `✅ ${PL[k] || k}: ${v.skipped ? "zaten yayında" : (v.url || v.note || "tamam")}${v.skipped ? "" : commentNote(k, v)}` : `❌ ${PL[k] || k}: ${v.error}`);
      if (r.blocked && r.error) lines.push(`❌ ${r.error}`);
      if (j.rest.length) lines.push(`\n⏸ Beklemede: ${j.rest.map((pl) => PL[pl]).join(", ")} → ${j.rest.map((pl) => `*onay ${j.p.id} ${SHORT[pl]}*`).join(" · ")} · bırakmak için *iptal ${j.p.id}*`);
      out.push(jobs.length > 1 ? `#${j.p.id} ${ttl(j.p)}\n${lines.join("\n") || "Yayınlanacak platform yok."}` : lines.join("\n") || "Yayınlanacak platform yok.");
    }
    await send(jid, [...out, ...skip].join("\n\n"));
  }
  // numaralı iptal, video kuyruğu bağlı değilken (eski düzen): yalnız onay bekleyenler
  async function cancelLocal(jid, nos) {
    const hit = pend.filter((p) => nos.includes(p.id)), none = nos.filter((n) => !pend.some((p) => p.id === n));
    for (const p of hit) dropPending(p);
    await send(jid, [hit.length ? `Tamam, ${hit.map((p) => `#${p.id} ${ttl(p)}${p.partial ? ` kalan platformlarda (${p.platforms.map((pl) => PL[pl]).join(", ")})` : ""}`).join(", ")} yayınlanmadı.` : "", none.length ? `${none.map((n) => `#${n}`).join(", ")}: onay bekleyen video yok.` : ""].filter(Boolean).join("\n"));
  }
  // numaralı söz tam kalıpta değil (karar 2): hiçbir şey yapılmadı + numaralı liste + tam yazım (video kuyruğu bağlıysa onun listesiyle)
  function guardReply(why = "") {
    try { if (queue?.guard) return String(queue.guard(why)); } catch { /* aşağıdaki liste */ }
    const dl = delivered(), solo = soloHead();
    return `${why || "Bu mesajla hiçbir şey yapılmadı: numaralı komutlar yalnız tam yazımıyla çalışır."}${pend.length ? `\n${pend.map(pendLine).join("\n")}` : "\nOnay bekleyen video yok."}\nTam yazım: yayın ${solo ? "*onay* ya da " : ""}*onay ${dl[0]?.id || "<numara>"}* · tek platform *onay ${dl[0]?.id || "<numara>"} insta* · iptal *iptal ${dl[0]?.id || "<numara>"}*`;
  }
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
  async function sendOrUnpend(jid, text, video, onSent = null) { try { await send(jid, text, onSent); } catch (e) { const p = video && pend.find((x) => x.video === video); if (p) dropPending(p); throw e; } }
  async function notifyVideo0(name, { ask = true, summary = null, force = false } = {}) {
    const w = settings().whatsapp || {};
    if (!w.enabled) return { ok: false, error: "WhatsApp kapalı" };
    // Yalnız sahibin gönderdiği link/videodan üretilenler (kullanıcı isteği, 23 Ekim: "kendi ürettiği haberleri bana göndermesin; sadece benim
    // gönderdiğim link veya videodaki ürettiklerini göndersin ve onayımı beklesin"; settings.whatsapp.onlyUserVideos, varsayılan açık): 5 saatlik
    // gündem, son dakika, şablon, günün/haftanın özeti ve otomatik trend videoları WhatsApp'a gitmez (panelde dururlar; otomatik yayın kuralları
    // değişmez, onay istenmediği için otomatik olmayan platformlara panelden yüklenir). "son videoyu gönder", panelin "Son videoyu gönder"
    // düğmesi ve beyin isteği (force) yine gönderir
    if (!force && w.onlyUserVideos !== false) {
      const vi = videoInfo(name);
      if (!vi) return { ok: false, error: "video bulunamadı" };
      if (!vi.userVideo || vi.queueSource === "trend-auto") {
        push(`💬 WhatsApp'a gönderilmedi (${vi.label}): ${vi.queueSource === "trend-auto" ? "otomatik trend videosu" : "sistemin kendi ürettiği video"}; yalnız sizin gönderdiğiniz link/videodan üretilenler gider (Ayarlar → WhatsApp → 📨)`);
        return { ok: false, skipped: true, error: "yalnız sahibin gönderdiği videolar WhatsApp'a gider" };
      }
    }
    if (st.status !== "connected") { // bağlantı kopukken bildirim kaybolmasın: kısa metin kuyruğa girer, bağlanınca gider
      const v0 = videoInfo(name);
      const sched0 = v0?.publishAt && Date.parse(v0.publishAt) > Date.now();
      // linkten/görüntüden yapılan video onaysız yayınlanmaz: bağlantı gelince gidecek mesajda da onay sorulur. Kuyruk videosu (karar 3) planlı
      // yayın saati ya da waVideo.autoPublish olsa da her zaman onay ister, mesaj numarasını yazar
      let ask0 = "", it0 = null;
      const q0 = Number(v0?.queueNo) || 0;
      if (v0 && ask && v0.userVideo && !settings().waVideo?.autoPublish && (q0 || !sched0)) { // onaysız yayın ayarı (varsayılan açık) kapalıysa onay sorulur
        try { const pl0 = (await links(name)).platforms.filter((pl) => !(v0.published || {})[pl]); if (pl0.length) { it0 = setPending(name, { label: v0.label, title: titleOf(v0), platforms: pl0, qno: q0, keepUntil: q0 && sched0 ? Date.parse(v0.publishAt) + 6 * 3600000 : 0 }); ask0 = (q0 && sched0 ? queueTimeLine(v0.publishAt, it0.id) : "") + approveLine(pl0, it0.numbered ? it0.id : null) + revLine(v0, it0.numbered ? it0.id : null); } } catch { /* hesap durumu okunamadı */ }
      }
      // onay, kuyruktaki mesaj bağlantı gelince gerçekten gidince ulaşmış sayılır
      if (v0) await send(null, `🎬 Yeni video hazır${q0 ? ` (#${it0?.id || q0})` : ""} — ${v0.label}${autoHint(v0)}\n${v0.segments.filter((x) => x.kind === "haber").slice(0, 5).map((x) => `• ${x.title}`).join("\n")}` +
        (sched0 && !q0 ? `\n⏰ Planlı yayın: ${whenLabel(new Date(v0.publishAt))}` : "") + "\n(WhatsApp bağlantısı koptuğu için video dosyası gönderilemedi; panelden izleyebilirsiniz.)" + ask0, ask0 ? () => markDelivered(name) : null);
      return { ok: false, queued: true, error: "WhatsApp bağlı değil; bildirim kuyruğa alındı" };
    }
    const v = videoInfo(name); if (!v) return { ok: false, error: "video bulunamadı" };
    const L = await links(name);
    const qn = Number(v.queueNo) || 0; // kuyruk videosu (karar 3): onaysız yayın ayarı kapalıyken yalnız numaralı onayla ya da panelden yayınlanır
    const waAuto = !!settings().waVideo?.autoPublish; // WhatsApp'tan istenen üretimler (video, link, fragman, özet, benzer video, kare) onaysız (kullanıcı isteği, 26 Ekim)
    let head = `🎬 *Yeni video hazır* — ${v.label} (${v.duration ?? "?"} sn)`;
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
    if (v.anlik && yp.onlyValuable !== false && !v.value?.valuable && !v.userVideo && !qn && !v.trailer && !v.trailerAuto) ap.youtube = false; // sahibin isteği ve fragman YouTube'a değer kuralı aranmadan gider (post_pipeline aynı)
    // 5 saatlik (düzenli) video YouTube'a onaysız gider (post_pipeline aynı kuralı uygular)
    if (!v.anlik && !["gunluk", "haftalik"].includes(v.format) && yp.regularAuto !== false && L.platforms.includes("youtube")) ap.youtube = true;
    // WhatsApp'tan gönderilen görüntüyle yapılan haber: varsayılan onaylı (post_pipeline aynı kuralı uygular); kuyruk videosu her zaman
    if (!waAuto && (v.userVideo || qn)) for (const pl of Object.keys(ap)) ap[pl] = false;
    if (waAuto && (v.userVideo || qn)) for (const pl of L.platforms) ap[pl] = true; // sahibin isteği: bağlı tüm hesaplara onaysız (post_pipeline aynı kuralı uygular)
    // linkle birlikte saat yazıldıysa (planlı yayın) onay istenmez; panel o saatte yayınlar. Kuyruk videosu planlanmaz (post_pipeline da), onay
    // ister; saat yalnız not edilir (qTime)
    const qTime = qn && !waAuto && v.publishAt && Date.parse(v.publishAt) > Date.now() + 60000 ? v.publishAt : null;
    const schedAt = (!qn || waAuto) && v.publishAt && Date.parse(v.publishAt) > Date.now() + 60000 ? new Date(v.publishAt) : null; // onaysız ayar açıkken kuyruk videosu da planlanır
    if (schedAt) for (const pl of Object.keys(ap)) ap[pl] = false;
    const autoPl = L.platforms.filter((pl) => ap[pl] && !already[pl]);      // otomatik yayın açık: onay gerekmez
    const platforms = schedAt ? [] : L.platforms.filter((pl) => !already[pl] && !ap[pl]);  // yalnızca elle yayınlanacaklar için onay
    const schedLine = schedAt ? `\n\n⏰ Planlı yayın: ${whenLabel(schedAt)} → ${L.platforms.join(", ") || "bağlı hesap yok"} (iptal: *planlı yayını iptal et*)` : "";
    const autoLine = autoPl.length ? `\n\n🚀 Otomatik yayın: ${autoPl.join(", ")} (onay gerekmez, yüklenince bildirilir)` : "";
    // Gönderilen görüntü/link videosu (userVideo) hiçbir yerde kendiliğinden yayınlanmaz; "onay iste" ayarı kapalıysa da (tam otomatik
    // mod kapatır) onay sorulur — yoksa ne yayın olur ne onay (kullanıcı şikâyeti, 14 Ekim).
    const needAsk = !!(ask && platforms.length && (w.requireApproval !== false || v.userVideo || qn));
    // onay kaydı mesajdan önce (numara), ulaştı bilgisi onay satırlı mesaj gidince (onSent); gönderilemezse aşağıda geri alınır
    const item = needAsk ? setPending(name, { label: v.label, title: titleOf(v), platforms, qno: qn, keepUntil: qTime ? Date.parse(qTime) + 6 * 3600000 : 0 }) : null;
    const aid = item?.numbered ? item.id : null, onSent = item ? () => markDelivered(name) : null;
    const vno = item?.id || qn; // videonun numarası (her mesajda; karar 1)
    if (qn) head = `🎬 *Yeni video hazır* (#${vno}) — ${v.label} (${v.duration ?? "?"} sn)${autoHint(v)}`;
    const qLine = qTime && needAsk ? queueTimeLine(qTime, vno) : "";
    const askLine = needAsk
      ? qLine + approveLine(platforms, aid) + revLine(v, aid)
      : (!autoPl.length && !L.platforms.length ? "\n\n(Yayın için bağlı platform yok; panelden hesap bağlayın.)" : "");
    const jid = await ownerTarget();
    if (summary && brief()) { // kısa: ne hazır, nerede yayında, sorun varsa ne, onay gerekiyorsa tek satır
      const first = v.segments.find((s) => s.kind === "haber")?.title || v.label;
      // kuyruk videosu (karar 3) kendiliğinden yayınlanmaz: özetteki "📤" satırları başka videonundur (7. tur: aynı anda onaylanan videonun yayın
      // satırları "📤 Yayında: YouTube, Instagram" diye bu videoya yazılıyordu)
      const pub = qn && !waAuto ? [] : publishLines(summary).filter((l) => !/^ℹ️/.test(l));
      const okPl = pub.filter((l) => l.startsWith("✅")).map((l) => l.replace(/^✅ /, "").replace(/[:\s(].*$/, ""));
      const bad = pub.filter((l) => !l.startsWith("✅")).map((l) => l.slice(0, 90));
      const pending = needAsk ? qLine + approveLine(platforms, aid) + revLine(v, aid) : "";
      const msg = [`✅ *Video hazır*${qn ? ` (#${vno})` : ""}: ${first} (${v.duration ?? "?"} sn)${qn ? autoHint(v) : ""}`, okPl.length && !schedAt ? `📤 Yayında: ${okPl.join(", ")}` : "",
        ...(schedAt ? [] : bad), schedAt ? `⏰ ${atLabel(whenLabel(schedAt))} yayınlanacak` : ""].filter(Boolean).join("\n") + pending;
      let fileSent = false;
      if (w.sendVideoFile !== false) { try { fileSent = await sendVideo(jid, v.path, msg, onSent); } catch (e) { push(`💬 video dosyası gönderilemedi: ${e.message}`); } }
      if (fileSent === false) await sendOrUnpend(jid, msg, needAsk && name, onSent);
      push(`💬 WhatsApp'a kısa bildirim gönderildi: ${v.label}${fileSent ? " (+video)" : ""}${st.pending ? " · onay bekleniyor" : ""}`);
      return { ok: true, fileSent, awaitingApproval: !!pending };
    }
    if (summary) { // tek mesaj: video dosyası + kısa özet aynı mesajda (dosya gönderilmezse düz metin)
      const titles = v.segments.filter((s) => s.kind === "haber").slice(0, 5).map((s) => `• ${s.breaking ? "🔴 " : ""}${s.title}`).join("\n");
      const pub = qn ? [] : publishLines(summary).filter((l) => !(needAsk && /^ℹ️ otomatik yayın yapılmadı/.test(l)));  // onay satırı zaten anlatıyor; kuyruk videosunda yok (yukarıda)
      const pending = needAsk ? qLine + approveLine(platforms, aid) + revLine(v, aid) : "";
      const watchLine = `\n\n▶ ${L.tunnel || L.lan}`;
      let msg = `${head}\n\n${titles}${pub.length && !schedAt ? "\n\n📤 *Yayın*\n" + pub.join("\n") : ""}${schedLine}${pending}${watchLine}`;
      if (msg.length > 1000) msg = msg.slice(0, 990) + "…";
      let fileSent = false;
      if (w.sendVideoFile !== false) { try { fileSent = await sendVideo(jid, v.path, msg, onSent); } catch (e) { push(`💬 video dosyası gönderilemedi: ${e.message}`); } }
      if (fileSent === false) await sendOrUnpend(jid, msg, needAsk && name, onSent);
      push(`💬 WhatsApp'a tek mesaj gönderildi: ${v.label}${fileSent ? " (+video)" : ""}${st.pending ? " · onay bekleniyor" : ""}`);
      return { ok: true, fileSent, awaitingApproval: !!pending };
    }
    const text = `${head}\n\n📝 *Seslendirme metni*\n\n${words}${schedLine || autoLine}${schedAt ? "" : askLine}`;
    let fileSent = false;
    if (w.sendVideoFile !== false) { try { fileSent = await sendVideo(jid, v.path, head); } catch (e) { push(`💬 video dosyası gönderilemedi: ${e.message}`); } }
    await sendOrUnpend(jid, text, needAsk && name, onSent); // onay satırı bu metinde (videonun açıklaması yalnız başlık)
    // Linkler ayrı, önizlemeli mesaj olarak: WhatsApp IP'li yerel adresi düz metin bırakır, önizleme kartı tıklanır.
    await sendLink(jid, L.lan, `▶ ${v.label}`, "Wi-Fi'de izle (Mac ile aynı ağ)", L.thumb);
    if (L.tunnel) await sendLink(jid, L.tunnel, `🌐 ${v.label}`, "Dışarıdan izle (tünel)", L.thumb);
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
  const status = () => ({ lastOkAt: st.lastOkAt || null, reconnects: st.reconnects || 0, outbox: outbox.length, lastIgnored: st.lastIgnored || null, selfPhone: selfPhone() ? "…" + selfPhone().slice(-4) : null, status: st.status, qrSvg: st.qrSvg, phone: st.phone, error: st.error, owner: ownerDigits() || null, pending: st.pending ? { video: st.pending.video, platforms: st.pending.platforms } : null, pendingList: pend.map((p) => ({ id: p.id, video: p.video, label: p.label, title: p.title || null, platforms: p.platforms, partial: !!p.partial, delivered: !!p.deliveredAt, numbered: !!p.numbered, queue: !!p.queue })), hasSession: existsSync(AUTH_DIR), lastMsgAt: st.lastMsgAt, lib: st.lib || null, node: process.versions.node, retry: st.retryInfo || null });
  const clearPending = (video) => { const n = pend.length; pend = pend.filter((p) => video && (p.video !== video || selfPub.has(video))); if (pend.length !== n) savePend(); };
  // video kuyruğu: "#3 iptal" üretilmiş videonun onay kaydını (numarasıyla) ya da iptal edilen kuyruk işinin videosunun onayını kaldırır
  const dropApproval = (id) => { const p = pend.find((x) => x.id === Number(id)); if (!p) return { ok: false }; dropPending(p); push(`💬 onay bekleyen kayıt kaldırıldı (${p.id}): ${String(ttl(p)).slice(0, 60)}`); return { ok: true, id: p.id, video: p.video, label: p.label, title: p.title || null }; };
  const dropApprovalVideo = (video) => { const p = pend.find((x) => x.video === video); return p ? dropApproval(p.id) : { ok: false }; };
  // açılışta onay mesajı ulaşmamış videolar (panel mesaj gönderilirken yeniden başladı): bağlantı kurulunca bir kez yeniden bildirilir
  async function resendUndelivered() {
    for (const name of resendBoot.splice(0)) {
      if (pend.some((p) => p.video === name) || !videoInfo(name)) continue;
      push(`💬 WhatsApp: ${videoInfo(name).label} videosunun onay mesajı yeniden gönderiliyor (panel yeniden başlamadan önce size ulaşmamıştı)`);
      await notifyVideo(name, { ask: true, summary: [] });
    }
  }
  // heldNos: süresi dolan onayların numaraları (24 saat başka videoya verilmez; videoqueue nextNo)
  return { start, stop, logout, status, watchdog, send: (t) => send(null, t), notifyVideo, clearPending, busy, dropApproval, dropApprovalVideo, heldNos: () => { purgeExpired(); return [...pend.map((p) => p.id), ...expired.map((e) => e.id)]; } };
}
