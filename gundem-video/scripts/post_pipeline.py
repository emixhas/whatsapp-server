#!/usr/bin/env python3
"""Üretim bittikten sonra: ayarlara göre otomatik yayınla ve analizi tazele. pipeline.sh çağırır.

Hangi platformlara yayın: settings.autopublish içinde açık olanlar; ayrıca
  - otomatik üretim (zamanlayıcı) açıksa ya da settings.autoMode (tam otomatik) açıksa bağlı TÜM hesaplar,
  - anlık (son dakika) videoda settings.anlikAutoPublish açıksa (varsayılan) bağlı TÜM hesaplar.
Bağlı hesaplar yayın anında okunur; sonradan bağlanan hesap da otomatik dahil olur.
YouTube kuralı (settings.youtubePolicy, günlük yükleme sınırı yüzünden): anlık/Mynet videosu YouTube'a yalnız
değerliyse (meta "value", scripts/news_value.py) ve günün ek kotası (extraDailyMax) dolmadıysa gider;
otomatik 5 saatlik üretimler her zaman gider. Instagram/TikTok bu kuraldan etkilenmez.
Hiçbir yere yayınlanmıyorsa nedeni loga açıkça yazılır.
"""
import json
import os
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import DATA, ROOT, episode_meta, load_json, save_json, settings  # noqa: E402

PLIST = Path.home() / "Library" / "LaunchAgents" / "com.gundem.video.plist"


def schedule_enabled() -> bool:
    """Otomatik üretim açık mı (panel zamanlayıcısı launchd plist'ini yazar)."""
    return PLIST.exists()

PLATFORMS = ("youtube", "instagram", "tiktok")


def connected() -> list:
    r = subprocess.run([sys.executable, str(ROOT / "scripts/publish.py"), "--status"], capture_output=True, text=True)
    try:
        st = json.loads(r.stdout.strip().splitlines()[-1])
        return [p for p in PLATFORMS if (st.get(p) or {}).get("connected")]
    except Exception:
        return []


YT_EXTRA = DATA / "youtube_extra.json"  # {gün: [anlık videolar]} — YouTube'a giden değerli anlık haberler


def youtube_allowed(video: str, meta: dict, s: dict) -> bool:
    """Anlık videonun YouTube'a gidip gitmeyeceği; kararı loga yazar."""
    pol = s.get("youtubePolicy") or {}
    if not pol.get("onlyValuable", True):
        return True
    if meta.get("remakeOf"):  # kullanıcının elle seçtiği tutan haber: değer kuralına takılmaz
        print(f"⭐ yeniden yayın ({meta['remakeOf']} tuttu) — YouTube'a da gidiyor")
        return True
    if meta.get("trailer") or meta.get("trailerAuto"):  # fragman analizi (takipten ya da sahibin linkinden; kullanıcı isteği, 26 Ekim: "fragmanlar direkt YouTube'a da yüklensin")
        print("🎬 fragman: YouTube'a da gidiyor (değer kuralı ve günlük ek hak aranmaz)")
        return True
    if meta.get("userVideo") or (meta.get("queue") or {}).get("no"):  # sahibin WhatsApp'tan istediği video: açık istek, değer kuralı aranmaz
        print("📲 sizin istediğiniz video: YouTube'a da gidiyor (değer kuralı aranmaz)")
        return True
    v = meta.get("value")
    if not v:  # eski video: değeri şimdi hesapla
        from news_value import score
        text = " ".join(f"{x.get('title', '')} {x.get('narration', '')}" for x in meta.get("segments", []) if x.get("kind") in ("hook", "haber"))
        v = score(text, pol.get("extraKeywords"))
    if not v.get("valuable"):
        print("📤 youtube: atlandı — sıradan haber" + (f" ({v.get('reason')})" if v.get("reasons") or v.get("importance") else "") + "; YouTube'a yalnız otomatik üretimler ve değerli haberler gider (günlük yükleme sınırı)")
        return False
    # EN değerli haber (news_value top: haber düzeyi "en değerli" ile üretilenlerin hepsi): günlük ek hakka sayılmaz, her zaman gider (kullanıcı,
    # 27 Ekim: "çok değerli haberlerin YouTube'a düşmediğini gördüm" — günde 12'ye kadar en değerli haber üretilirken ek hak 3'te kalıyor, dördüncüsünden
    # itibaren atlanıyordu). youtubePolicy.topUnlimited false yapılırsa eski davranış (hepsi ek hakka sayılır).
    if v.get("top") and pol.get("topUnlimited", True) is not False:
        print(f"⭐ en değerli haber: YouTube'a da gidiyor (günlük ek hakka sayılmaz; {v.get('topReason') or v.get('reason')})")
        return True
    day = time.strftime("%Y-%m-%d")
    used = load_json(YT_EXTRA, {})
    today = used.get(day, [])
    name = Path(video).name
    limit = int(pol.get("extraDailyMax", 3))
    if name not in today and len(today) >= limit:
        print(f"📤 youtube: atlandı — değerli haber ama bugünkü ek YouTube hakkı ({limit}) doldu ({v.get('reason')}; en değerli haberler sınıra sayılmaz)")
        return False
    if name not in today:
        today.append(name)
    save_json(YT_EXTRA, {d: x for d, x in used.items() if d >= time.strftime("%Y-%m-%d", time.localtime(time.time() - 7 * 86400))} | {day: today})
    print(f"⭐ değerli haber: YouTube'a da gidiyor ({v.get('reason')}; bugün {len(today)}/{limit})")
    return True


def targets(video: str, s: dict) -> tuple[list, str]:
    ap = s.get("autopublish", {}) or {}
    chosen = [p for p in PLATFORMS if ap.get(p)]
    meta = episode_meta(Path(video).name) or {}
    anlik = meta.get("anlik") or meta.get("format") == "anlik"
    conn = connected()
    wa_auto = bool((s.get("waVideo") or {}).get("autoPublish"))
    owner = bool(meta.get("userVideo") or (meta.get("queue") or {}).get("no"))
    # video kuyruğunun videosu (meta queue) ve WhatsApp'tan gönderilen görüntü/linkle yapılan video: waVideo.autoPublish kapalıysa sahibi önce
    # izlesin, numaralı "onay" ile yayınlansın; AÇIKSA (varsayılan; kullanıcı isteği, 26 Ekim: "WhatsApp'tan istediğim üretimler onay beklemeden
    # direkt yayınlansın") bağlı TÜM hesaplara onaysız (anlık/değer kuralları aranmaz; kare video yine yalnız YouTube)
    if (meta.get("queue") or {}).get("no") and not wa_auto:
        return [], "anlık", f"video kuyruğundan gelen video (#{meta['queue']['no']}) yalnız onayınızla yayınlanır (Ayarlar → WhatsApp videosu → onay beklemeden yayınlansın)"
    if meta.get("userVideo") and not wa_auto:
        return [], "anlık", "gönderdiğiniz görüntü ya da sosyal medya linkiyle yapılan haber önce size gelir, onayınızla yayınlanır"
    if owner and wa_auto:
        extra = [p for p in conn if p not in chosen]
        if extra:
            print(f"📲 sizin istediğiniz video: bağlı tüm hesaplarda onaysız paylaşılıyor ({', '.join(chosen + extra)})")
        chosen += extra
    # 🎬 fragman takibi (kullanıcı isteği, 24 Ekim: kanalda yeni fragman düşünce "yayınlasın"): bağlı TÜM hesaplara, anlık/değer kuralları ve
    # YouTube günlük ek hakkı aranmaz (yayın onayı istenirse userVideo yukarıda yakaladı)
    if meta.get("trailerAuto"):
        extra = [p for p in conn if p not in chosen]
        if extra:
            print(f"🎬 fragman takibi: bağlı tüm hesaplarda otomatik paylaşılıyor ({', '.join(chosen + extra)})")
        chosen += extra
        return [p for p in chosen if p in conn], "anlık", "bağlı yayın hesabı yok (Ayarlar → Yayın hesapları)"
    auto_all = schedule_enabled() or bool(s.get("autoMode"))
    if auto_all:
        extra = [p for p in conn if p not in chosen]
        if extra:
            print(f"🤖 otomatik mod açık: bağlı tüm hesaplarda paylaşılıyor ({', '.join(chosen + extra)})")
        chosen += extra
    # 5 saatlik (düzenli) video: YouTube'a her zaman sorulmadan gider (kullanıcı kararı; youtubePolicy.regularAuto)
    regular = not anlik and meta.get("format") not in ("gunluk", "haftalik")
    if regular and "youtube" in conn and "youtube" not in chosen and (s.get("youtubePolicy") or {}).get("regularAuto", True):
        print("▶ 5 saatlik video: YouTube'a onaysız yükleniyor")
        chosen.append("youtube")
    if anlik and s.get("anlikAutoPublish", True):
        extra = [p for p in conn if p not in chosen]
        if extra:
            print(f"⚡ anlık haber: bağlı tüm hesaplarda otomatik paylaşılıyor ({', '.join(chosen + extra)})")
        chosen += extra
    if anlik and "youtube" in chosen and "youtube" in conn and not youtube_allowed(video, meta, s):
        chosen = [p for p in chosen if p != "youtube"]
    if meta.get("format") in ("gunluk", "haftalik"):  # yatay uzun video: yalnız YouTube (Reels/TikTok dikey kısa video ister)
        cfg = s.get("weeklySummary" if meta.get("format") == "haftalik" else "daily", {}) or {}
        if "youtube" in conn and "youtube" not in chosen and (auto_all or cfg.get("autoPublish", True)):
            chosen.append("youtube")
        dropped = [p for p in chosen if p != "youtube"]
        if dropped:
            print(f"📺 günün özeti yatay uzun video: yalnız YouTube'a gider ({', '.join(dropped)} atlandı)")
        chosen = [p for p in chosen if p == "youtube"]
    if meta.get("kare"):  # kare (1:1) uzun video: yalnız YouTube (Reels dikey 9:16 ve kısa ister, TikTok uzun kare videoyu kabul etmez)
        dropped = [p for p in chosen if p != "youtube"]
        if dropped:
            print(f"⬛ kare uzun video: yalnız YouTube'a gider ({', '.join(dropped)} atlandı)")
        chosen = [p for p in chosen if p == "youtube"]
    off = [p for p in chosen if p not in conn]
    for p in off:
        print(f"📤 {p}: hesap bağlı değil, atlandı (Ayarlar → Yayın hesapları)")
    if not conn:
        why = "bağlı yayın hesabı yok (Ayarlar → Yayın hesapları)"
    elif anlik and not s.get("anlikAutoPublish", True):
        why = "Anlık Haber kartındaki \"otomatik paylaş\" anahtarı kapalı"
    else:
        why = "hiçbir platformda otomatik yayın açık değil (Üretim kartındaki \"otomatik yükle\" anahtarları)"
    return [p for p in chosen if p in conn], ("anlık" if anlik else ""), why


SCHED = DATA / "scheduled_publish.json"  # [{video, at, platforms, created}] — panel zamanı gelince yayınlar


def schedule_at(meta: dict) -> float | None:
    """WhatsApp'ta linkle birlikte yazılan yayın saati (meta publishAt) en az 1 dk ilerideyse epoch, değilse None."""
    from datetime import datetime
    try:
        at = datetime.fromisoformat(str(meta.get("publishAt")).replace("Z", "+00:00")).timestamp()
    except Exception:
        return None
    return at if at > time.time() + 60 else None


video = sys.argv[1]
s = settings()
scheduled = None
_meta = episode_meta(Path(video).name) or {}
_at = None if ((_meta.get("queue") or {}).get("no") and not (s.get("waVideo") or {}).get("autoPublish")) else schedule_at(_meta)  # kuyruk videosu yalnız onaysız yayın ayarı açıkken planlanır
plats, kind, why = ([], "anlık" if _meta.get("anlik") else "", "") if _at else targets(video, s)
if _at:
    # kullanıcının verdiği saat açık yayın talimatıdır: bağlı tüm hesaplar (YouTube değer kuralı ve görüntü onayı aranmaz)
    plan_plats = connected()
    label = time.strftime("%d.%m %H:%M", time.localtime(_at))
    if plan_plats:
        items = [x for x in (load_json(SCHED, []) or []) if x.get("video") != Path(video).name]
        items.append({"video": Path(video).name, "at": _at, "platforms": plan_plats, "created": time.time()})
        save_json(SCHED, items)
        scheduled = _at
        print(f"⏰ planlı yayın: {label} → {', '.join(plan_plats)} (video hazır; o saatte yayınlanacak — iptal için \"planlı yayını iptal et\")", flush=True)
    else:
        print(f"⏰ planlı yayın saati ({label}) verildi ama bağlı yayın hesabı yok (Ayarlar → Yayın hesapları)", flush=True)
    plats = []
elif not plats:
    print(f"📤 otomatik yayın yapılmadı: {why}. WhatsApp'tan \"onay\" yazarak ya da panelden yayınlayabilirsiniz.")
PUBLISH_TIMEOUT = 25 * 60  # tek platform yüklemesi en çok 25 dk (Hostinger + Instagram işleme 6 dk + yayın isteği 3 dk + kurtarma); takılırsa süreç kesilir
FLUSH_TIMEOUT = 40 * 60    # sıradaki videoların yüklenmesi (yalnız otomatik üretimde; sahibin videosunu bekletmez)


def publish(plat: str) -> bool:
    print(f"📤 {plat}: yükleniyor", flush=True)  # sahibin uzun iş bildirimi aşamayı buradan okur (server.js PIPE_STAGES)
    touch_lock()  # yükleme adımının kendi zaman aşımı var; takılma bekçisi canlı adımı öldürmesin
    try:
        r = subprocess.run([sys.executable, str(ROOT / "scripts/publish.py"), "--file", video, "--platform", plat], capture_output=True, text=True, timeout=PUBLISH_TIMEOUT)
    except subprocess.TimeoutExpired:
        # yükleme defteri (publish.py) sayesinde yeniden deneme aynı videoyu ikinci kez yüklemez (konteynerin durumu sorulur)
        print(f"📤 {plat}: hata yükleme {PUBLISH_TIMEOUT // 60} dakikada bitmedi, kesildi", flush=True)
        return False
    for line in r.stderr.strip().splitlines():
        if line.startswith(("🌐", "  video", "  geçici", "  !", "  ▶", "  ♪", "  💬")) and "▶ YouTube kapağı yüklendi" not in line:
            print(line, flush=True)
    last = r.stdout.strip().splitlines()[-1] if r.stdout.strip() else r.stderr.strip()[-300:]
    try:
        j = json.loads(last)
    except Exception:
        print(f"📤 {plat}: hata {last}", flush=True)
        return False
    if j.get("limit"):  # günlük sınır: sıraya alındı, 90 sn sonra denemek boşuna
        print(f"📤 {plat}: sınır doldu — {j.get('error')}", flush=True)
        return True
    if j.get("busy"):  # aynı video başka bir süreçte yükleniyor (publish.py kilidi): yeniden denemek ikinci kopya üretir
        print(f"📤 {plat}: {j.get('error')}", flush=True)
        return True
    print(f"📤 {plat}: " + (("zaten yayında " if j.get("skipped") else "tamam ") + (j.get("url") or j.get("note") or "") if j.get("ok") else "hata " + str(j.get("error"))), flush=True)
    return bool(j.get("ok"))


PREFLUSH_BUDGET = 12 * 60  # otomatik haberden önce sıradaki fragmanların yüklenmesi: bütün platformlar için TOPLAM en çok 12 dk (50 dk'lık takılma bekçisi aşılmasın)
PREFLUSH_PLATS = ("instagram", "tiktok")  # YouTube'da sıradaki fragman günlük kotayı harcamasın: 5 saatlik düzenli video YouTube'a her zaman gitmeli
LOCK_DIR = ROOT / "work" / "pipeline.lock"


def touch_lock() -> None:
    """Takılma bekçisi (server.js: kilit dizini 50 dk eskiyse üretimi öldürür) kilit dizininin mtime'ına bakar; süresi sınırlı yükleme adımlarından
    önce tazelenir ki uzun ama canlı bir yayın adımı takılmış sanılmasın (her adımın kendi zaman aşımı var)."""
    try:
        os.utime(LOCK_DIR, None)
    except Exception:
        pass


def _held(plat: str) -> bool:
    """Platform duraklatılmış mı (publish_hold.json until ilerideyse)."""
    from datetime import datetime, timezone
    try:
        until = datetime.fromisoformat(str(((load_json(DATA / "publish_hold.json", {}) or {}).get(plat) or {}).get("until") or ""))
        return until > datetime.now(timezone.utc)
    except Exception:
        return False


def _pre_lines(text) -> list:
    if isinstance(text, bytes):
        text = text.decode("utf-8", "replace")
    return [l for l in str(text or "").strip().splitlines() if l.startswith("📤") and " sırası: " not in l and not l.startswith("{")]


def preflush_trailers(plats: list, meta: dict) -> list:
    """Fragmanlar haberlerden önce (kullanıcı isteği, 26 Ekim: "Instagram yükleme sırasında önce fragmanlar olsun, fragmanlar yüklendikten sonra
    haberlere geçilsin"): otomatik haber videosu Instagram'a/TikTok'a yüklenmeden önce o platformun sırasında bekleyen fragmanlar yüklenir
    (`publish.py --flush --only-trailers --platform X`; haberler sırada kalır). Sahibin videosu (beklemesin) ve fragmanın kendisi atlar; platform
    duraklatılmışsa yalnız not (bekleme bitince flush zaten fragmanları önce yükler). Toplam süre PREFLUSH_BUDGET; zaman aşımında ya da hatada haber
    yine yüklenir (yüklenen fragmanlar sıradan anında düşer: publish._queue_remove_now). Dönüş: fragmanları yüklenen platformlar."""
    if not plats or meta.get("userVideo") or (meta.get("queue") or {}).get("no") or meta.get("trailer") or meta.get("trailerAuto"):
        return []
    q = load_json(DATA / "publish_queue.json", []) or []
    if not isinstance(q, list) or not q:
        return []
    out, t0 = [], time.time()
    for plat in plats:
        if plat not in PREFLUSH_PLATS:
            continue
        trailers = []
        for x in q:
            if not isinstance(x, dict) or x.get("platform") != plat:
                continue
            m = episode_meta(Path(str(x.get("video") or "")).name) or {}
            if m.get("trailerAuto") or m.get("trailer"):
                trailers.append(x.get("video"))
        if not trailers:
            continue
        if _held(plat):
            print(f"📤 {plat}: sırada {len(trailers)} fragman bekliyor ama platform duraklatılmış; bekleme bitince önce onlar yüklenecek", flush=True)
            continue
        left = int(PREFLUSH_BUDGET - (time.time() - t0))
        if left < 60:
            print(f"📤 {plat}: sırada {len(trailers)} fragman bekliyor ama ön yükleme süresi doldu; sonraki sıra boşaltmasında önce onlar yüklenir", flush=True)
            continue
        print(f"📤 {plat}: sırada bekleyen {len(trailers)} fragman bu haberden önce yükleniyor (fragmanlar haberlerden önce; en çok {left // 60} dk)", flush=True)
        touch_lock()
        try:
            fl = subprocess.run([sys.executable, str(ROOT / "scripts/publish.py"), "--flush", "--only-trailers", "--platform", plat], capture_output=True, text=True, timeout=left)
        except subprocess.TimeoutExpired as e:
            for line in _pre_lines(e.stdout):
                print(line, flush=True)
            print(f"📤 {plat}: fragmanların yüklenmesi {left // 60} dakikada bitmedi, kesildi; haber yükleniyor (yüklenmiş olanlar sıradan düştü)", flush=True)
            continue
        for line in _pre_lines(fl.stdout):
            print(line, flush=True)
        tail = (fl.stdout or "").strip().splitlines()[-1:] or [""]
        if fl.returncode != 0 or not tail[0].startswith("{"):
            print(f"📤 {plat}: fragmanlar yüklenemedi: {(fl.stderr or '').strip()[-200:] or 'yanıt yok'}", flush=True)
            continue
        out.append(plat)
    return out

preflush_trailers(plats, _meta)
failed = [p for p in plats if not publish(p)]


def queue_count() -> int:
    q = load_json(DATA / "publish_queue.json", []) or []
    return len(q) if isinstance(q, list) else 0


def drain_queue(owner: bool) -> set:
    """Sınır yüzünden bekleyen eski videolar (sınır açıldıysa; yeni video önce gider). Sahibin videosunda (WhatsApp videosu/linki, fragman,
    kuyruk videosu — kullanıcı şikâyeti, 24 Ekim: onay bekleyen fragman "yayın adımı"nda 19 dk bekledi: kendi yayını yoktu, sıradaki eski
    videolar yükleniyordu) sıra BURADA boşaltılmaz: tek satır yazılır, panel üretim bitince sıradakileri kendisi yükler (server.js flushAsap);
    sahibin videosu hemen gelir. Otomatik üretimde eskisi gibi burada (en çok FLUSH_TIMEOUT)."""
    n = queue_count()
    if not n:
        return set()
    if owner:
        print(f"📤 sırada {n} video bekliyor; sizin videonuz beklemesin diye sıradakileri panel üretim bitince yükleyecek", flush=True)
        return set()
    try:
        fl = subprocess.run([sys.executable, str(ROOT / "scripts/publish.py"), "--flush"], capture_output=True, text=True, timeout=FLUSH_TIMEOUT)
    except subprocess.TimeoutExpired:
        print(f"📤 sıradaki videoların yüklenmesi {FLUSH_TIMEOUT // 60} dakikada bitmedi, kesildi; kalanlar panelden sürer", flush=True)
        return set()
    out = set()
    for line in fl.stdout.strip().splitlines()[:-1]:
        print(line, flush=True)
        if " sırası: " in line:
            out.add(line.split()[1])
    return out


_meta = episode_meta(Path(video).name) or {}
shown = drain_queue(bool(_meta.get("userVideo") or (_meta.get("queue") or {}).get("no")))
# sıra boş değilse ya da gönderim duraklatıldıysa her üretimde sıranın durumu loga (TikTok taslak sınırı görünür olsun)
qs = subprocess.run([sys.executable, str(ROOT / "scripts/publish.py"), "--queue"], capture_output=True, text=True)
for line in qs.stdout.strip().splitlines()[:-1]:
    if line.split()[1:2] and line.split()[1] not in shown and not line.endswith("sırası: boş"):
        print(line, flush=True)
if failed:
    # geçici hatalar (Instagram "medya hazır değil", ağ kopması) için 90 sn sonra bir kez daha denenir
    print(f"📤 tekrar denenecek (90 sn sonra): {', '.join(failed)}", flush=True)
    time.sleep(90)
    failed = [p for p in failed if not publish(p)]
    if failed:
        print(f"📤 yayınlanamadı: {', '.join(failed)}. WhatsApp'tan \"onay\" yazarak ya da panelden tekrar deneyebilirsiniz.", flush=True)
try:
    subprocess.run([sys.executable, str(ROOT / "scripts/analyze.py")], capture_output=True, timeout=10 * 60)
except subprocess.TimeoutExpired:
    print("📤 analiz adımı 10 dakikada bitmedi, atlandı", flush=True)
print(json.dumps({"autopublish": plats, "kind": kind, **({"scheduled": scheduled} if scheduled else {})}, ensure_ascii=False))
