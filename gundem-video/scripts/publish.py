#!/usr/bin/env python3
"""Videoyu YouTube Shorts ve/veya Instagram Reels olarak yayınlar; sonucu data/metrics.json'a yazar.

  python3 scripts/publish.py --connect youtube                 # ilk bağlantı (tarayıcıda Google girişi)
  python3 scripts/publish.py --connect instagram               # Instagram girişi (tünel açıkken; HTTPS geri dönüş)
  python3 scripts/publish.py --file out/2026-10-07-1.mp4 --platform youtube
  python3 scripts/publish.py --file out/2026-10-07-1.mp4 --platform instagram
  python3 scripts/publish.py --status                          # bağlantı durumu (JSON)
  python3 scripts/publish.py --flush                           # sınır yüzünden sıraya alınanları yüklemeyi dene

Günlük yükleme sınırı (YouTube uploadLimitExceeded/quotaExceeded) dolunca platform LIMIT_HOURS süre
beklemeye alınır (data/publish_hold.json), video sıraya eklenir; panel saatte bir --flush çağırır,
sınır açılınca sıradakiler en yeniden eskiye yüklenir. QUEUE_MAX_HOURS'ten eski haberler bayatladığı için atılır.
"""
import argparse
import hashlib
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from datetime import datetime, timedelta, timezone

from common import DATA, OUT, SECRETS, build_caption, caption_tags, episode_meta, load_env, load_json, metrics, now_iso, save_json, save_metrics
import hostinger

HOLD_FILE = DATA / "publish_hold.json"    # {"youtube": {"until": iso, "reason": "..."}}
QUEUE_FILE = DATA / "publish_queue.json"  # [{"video": ad, "platform": p, "at": iso}]
LIMIT_HOURS = 3        # sınır dolunca bu kadar saat sonra yeniden denenir
QUEUE_MAX_HOURS = 24   # daha eski sıradaki haber videoları yüklenmez (bayat haber)
# Sıra düzeni (kullanıcı isteği, 26 Ekim: "Instagram yükleme sırasında önce fragmanlar, fragmanlar yüklendikten sonra haberlere geçilsin; sırada ne var
# göreyim; değeri geçmiş haberi sıradan çıkarayım, silebileyim"): fragman (fragman takibi ya da sahibin fragman analizi) → sahip (WhatsApp'tan istenen
# video) → haber; her kümede en yeni önce. Fragman sırada bir hafta, sahibin videosu 3 gün bekler (haber 24 saat); 6 saattir bekleyen haber panelde ve
# WhatsApp yanıtında "değeri geçmiş olabilir" uyarısı alır, çıkarma kararı sahibin.
QUEUE_KIND_RANK = {"fragman": 0, "sahip": 1, "haber": 2}
QUEUE_MAX_HOURS_BY_KIND = {"fragman": 7 * 24, "sahip": 72, "haber": QUEUE_MAX_HOURS}
QUEUE_STALE_HINT_HOURS = 6
QUEUE_MAX_TRIES = 3    # sınır dışı hatada (bozuk dosya, API hatası) sıradaki video bu kadar denemeden sonra çıkarılır
QUEUE_LOG = DATA / "publish_queue_log.json"  # son 100 sıra olayı: {at, event queued|uploaded|failed|dropped|held|hold|removed, video, platform, detail, url}
# Yükleme defteri (kullanıcı şikâyeti, 24 Ekim: "halen daha çift paylaşım var"): her yüklemenin adımı video + platform başına diske yazılır
# (started → container (Instagram konteyner kimliği) → publishing (yayın isteği gönderildi) → done (kimlik) | failed). metrics.json'daki kayıt
# eşzamanlı bir yazım yüzünden kaybolsa da (sync_metrics, cleanup), süreç yayın isteğinden sonra ölse de, Instagram'ın gönderi listesi geç
# gelse de yeniden denemede aynı video ikinci kez yüklenmez: defterdeki konteynerin durumu sorulur (PUBLISHED → yayınlanmış, FINISHED →
# aynı konteyner yayınlanır, yeni konteyner açılmaz). 7 günden eski kayıtlar düşer.
LEDGER_FILE = DATA / "upload_ledger.json"  # {video: {platform: {state, at, startedAt, attempt, cid, id, url, publishedAt, owner, unresolved}}}
LOCK_DIR = DATA.parent / "work" / "publish_locks"  # <video>.<platform>.lock {pid, at}: aynı video aynı anda iki süreçte yüklenmez
                                             # (kullanıcı isteği, 23 Ekim: "sıraya alınan videoları görebilelim: hangi aşamada, yüklendi mi, sorun var mı, sıra akıyor mu")
LIMIT_REASONS = ("uploadLimitExceeded", "quotaExceeded", "dailyLimitExceeded", "rateLimitExceeded")
# TikTok gelen kutusu (inbox) modu: paylaşılmamış taslak sayısı TikTok'un sınırını aşınca (24 saatte birkaç bekleyen
# gönderim) "spam_risk_too_many_pending_share"; doğrudan yayında da "spam_risk_too_many_posts". İkisi de sınır sayılır.
TT_LIMIT_REASONS = ("spam_risk_too_many_pending_share", "spam_risk_too_many_posts", "spam_risk_user_banned_from_posting", "rate_limit_exceeded")
TT_LIMIT_TR = {
    "spam_risk_too_many_pending_share": "TikTok gelen kutunuzda paylaşılmamış çok taslak birikti (TikTok onaysız uygulamada 24 saatte yalnızca "
                                        "birkaç bekleyen taslağa izin verir). TikTok uygulaması → Gelen kutusu / bildirimlerdeki taslakları "
                                        "paylaşın ya da silin",
    "spam_risk_too_many_posts": "TikTok bugünkü gönderi sınırı doldu",
    "spam_risk_user_banned_from_posting": "TikTok bu hesabın API ile gönderimini geçici olarak durdurdu",
    "rate_limit_exceeded": "TikTok çok sık istek nedeniyle geçici olarak sınırladı",
}


# Instagram geçici engeli ("User is performing too many actions", istek sınırı): günlük sınır gibi 3 saat duraklatılır, video sıraya
# (kullanıcı şikâyeti, 22 Ekim: sondakika.com'dan art arda üretilen videolar Instagram HTTP 400 "too many actions" veriyordu)
IG_LIMIT_TR = {"instagram_rate_limit": "Instagram çok sık paylaşım yapıldığı için geçici engel koydu (\"too many actions\")"}


class LimitReached(RuntimeError):
    """Platformun günlük yükleme/kota sınırı doldu; kısa sürede tekrar denemek boşuna."""


def _parse(ts):
    try:
        return datetime.fromisoformat(ts)
    except Exception:
        return None


def hold_until(plat):
    h = (load_json(HOLD_FILE, {}) or {}).get(plat) or {}
    until = _parse(h.get("until", ""))
    return until if until and until > datetime.now(timezone.utc) else None


def _age_h(ts) -> float:
    """ISO zamandan bu yana geçen saat (okunamazsa çok büyük: eski sayılır)."""
    t = _parse(str(ts or ""))
    if not t:
        return 1e9
    if t.tzinfo is None:
        t = t.replace(tzinfo=timezone.utc)
    return (datetime.now(timezone.utc) - t).total_seconds() / 3600


def ledger_get(video: str, plat: str) -> dict:
    d = load_json(LEDGER_FILE, {}) or {}
    e = (d.get(video) or {}).get(plat) if isinstance(d, dict) and isinstance(d.get(video), dict) else None
    return dict(e) if isinstance(e, dict) else {}


def ledger_set(video: str, plat: str, **fields) -> dict:
    """Defter kaydını günceller (None değerler yazılmaz; False yazılır); 7 günden eski kayıtlar düşer."""
    d = load_json(LEDGER_FILE, {}) or {}
    d = d if isinstance(d, dict) else {}
    for v in list(d):
        ents = d.get(v) if isinstance(d.get(v), dict) else {}
        ents = {pl: e for pl, e in ents.items() if isinstance(e, dict) and _age_h(e.get("at")) < 7 * 24}
        if ents:
            d[v] = ents
        else:
            d.pop(v, None)
    e = {**ledger_get(video, plat), **{k: val for k, val in fields.items() if val is not None}, "at": now_iso()}
    d.setdefault(video, {})[plat] = e
    save_json(LEDGER_FILE, d)
    return e


def _pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except Exception:
        return False


def upload_lock(video: str, plat: str):
    """Aynı video + platform için aynı anda tek yükleme: kilit dosyası {pid, at}. Sahibi yaşayan ve 2 saatten yeni kilit → None (çağıran
    "busy" döner, yeniden denemez); ölü ya da eski kilit silinir. Dönen yol bitince silinir."""
    LOCK_DIR.mkdir(parents=True, exist_ok=True)
    p = LOCK_DIR / f"{video}.{plat}.lock"
    if p.exists():
        try:
            cur = json.loads(p.read_text(encoding="utf-8"))
        except Exception:
            cur = {}
        pid = int(cur.get("pid") or 0) if isinstance(cur, dict) else 0
        try:
            fresh = (time.time() - p.stat().st_mtime) < 2 * 3600
        except Exception:
            fresh = False
        if pid and pid != os.getpid() and fresh and _pid_alive(pid):
            return None
        try:
            p.unlink()
        except Exception:
            pass
    try:
        fd = os.open(p, os.O_CREAT | os.O_EXCL | os.O_WRONLY)  # iki süreç aynı anda kilit yazamasın
    except FileExistsError:
        return None
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        fh.write(json.dumps({"pid": os.getpid(), "at": now_iso()}))
    return p


def qlog(event, video, plat, detail="", url=""):
    """Sıra olayı (panel "Yayın sırası" kutusu ve "instagram sırası" komutu için); son 100 olay tutulur."""
    log = load_json(QUEUE_LOG, []) or []
    log = log if isinstance(log, list) else []
    log.append({"at": now_iso(), "event": event, "video": str(video or ""), "platform": plat, "detail": str(detail or "")[:300], **({"url": url} if url else {})})
    save_json(QUEUE_LOG, log[-100:])


def set_hold(plat, reason):
    holds = load_json(HOLD_FILE, {}) or {}
    until = datetime.now(timezone.utc) + timedelta(hours=LIMIT_HOURS)
    holds[plat] = {"until": until.isoformat(), "reason": reason, "since": now_iso()}
    save_json(HOLD_FILE, holds)
    qlog("hold", "", plat, f"{hold_reason_tr(plat, reason)} · {local_hhmm(until)}'e kadar")
    return until


def hold_reason_tr(plat, reason):
    return (TT_LIMIT_TR.get(reason) if plat == "tiktok" else IG_LIMIT_TR.get(reason) if plat == "instagram" else None) or (PLAT_NAME.get(plat, plat) + " günlük yükleme sınırı dolu" if reason in ("limit", "uploadLimitExceeded", "quotaExceeded", "") else str(reason))


def clear_hold(plat):
    holds = load_json(HOLD_FILE, {}) or {}
    if holds.pop(plat, None) is not None:
        save_json(HOLD_FILE, holds)


def enqueue(video, plat):
    q = load_json(QUEUE_FILE, []) or []
    if not any(x.get("video") == video and x.get("platform") == plat for x in q):
        q.append({"video": video, "platform": plat, "at": now_iso()})
        save_json(QUEUE_FILE, q)
        qlog("queued", video, plat, "sınır/engel yüzünden sıraya alındı")


def unqueue(video, plat=None) -> bool:
    """Elle sıradan çıkar (panel "✖", WhatsApp "sıradan çıkar N"); platform verilmezse her platformun sırasından. Video yüklenmez, panelden elle yüklenebilir."""
    return bool(unqueue_all(video, plat))


def unqueue_all(video, plat=None) -> list:
    """Videoyu sıradan çıkarır (platform verilmezse hepsinden); çıkarıldığı platformların listesi."""
    q = load_json(QUEUE_FILE, []) or []
    gone = [x for x in q if x.get("video") == video and (plat is None or x.get("platform") == plat)]
    if not gone:
        return []
    save_json(QUEUE_FILE, [x for x in q if x not in gone])
    for x in gone:
        qlog("removed", video, x.get("platform"), "elle sıradan çıkarıldı")
    return [x.get("platform") for x in gone]


def queue_kind(name, meta=None) -> str:
    """Sıradaki videonun türü: fragman (fragman takibi ya da sahibin fragman analizi) > sahip (WhatsApp'tan istenen video, kuyruk videosu) > haber."""
    if isinstance(meta, dict):
        m = meta
    else:
        m = (episode_meta(Path(str(name or "")).name) or {}) if name else {}
    if m.get("trailerAuto") or m.get("trailer"):
        return "fragman"
    if m.get("userVideo") or (m.get("queue") or {}).get("no"):
        return "sahip"
    return "haber"


def queue_title(meta) -> str:
    """Sıra satırındaki başlık: yayın başlığı, yoksa A başlığı, yoksa ilk haber başlığı."""
    m = meta if isinstance(meta, dict) else {}
    titles = m.get("titles") if isinstance(m.get("titles"), dict) else {}
    t = m.get("publishTitle") or titles.get("A") or ""
    if not t:
        h = (m.get("headlines") or [{}])[0] if isinstance(m.get("headlines"), list) and m.get("headlines") else {}
        t = (h.get("title") if isinstance(h, dict) else "") or m.get("title") or ""
    if not t:  # gerçek bölüm meta'sı: ilk haber bölümünün başlığı (common.build_caption gibi)
        segs = [x for x in (m.get("segments") or []) if isinstance(x, dict) and x.get("kind") == "haber" and x.get("title")]
        t = segs[0]["title"] if segs else ""
    return str(t or "").strip()[:110]


def queue_max_hours(kind: str) -> int:
    return int(QUEUE_MAX_HOURS_BY_KIND.get(kind, QUEUE_MAX_HOURS))


def queue_info(plat: str) -> dict:
    """Bir platformun sınır sırası: bekleyen videolar YÜKLENECEKLERİ SIRAYLA (flush_order: fragman → sahip → haber, en yeni önce; her birinde
    sıra numarası, tür, başlık, sıraya giriş zamanı ve kaç saattir beklediği, haber değeri, deneme sayısı, son hata, "değeri geçmiş olabilir"
    uyarısı), duraklatma bitişi ve nedeni (Türkçe holdReason), son 15 sıra olayı (en yeniden eskiye)."""
    q = [x for x in flush_order(load_json(QUEUE_FILE, []) or []) if x.get("platform") == plat]
    until = hold_until(plat)
    reason = ((load_json(HOLD_FILE, {}) or {}).get(plat) or {}).get("reason", "") if until else ""
    events = [e for e in reversed(load_json(QUEUE_LOG, []) or []) if isinstance(e, dict) and e.get("platform") == plat][:15]
    now = datetime.now(timezone.utc)
    items = []
    for i, x in enumerate(q, 1):
        name = str(x.get("video") or "")
        meta = episode_meta(Path(name).name) or {} if name else {}
        kind = queue_kind(name, meta)
        at = _parse(x.get("at", ""))
        age_h = round((now - at).total_seconds() / 3600, 1) if at else None
        v = meta.get("value") if isinstance(meta.get("value"), dict) else None
        items.append({"pos": i, "video": name, "kind": kind, "title": queue_title(meta), "at": x.get("at"), "ageHours": age_h,
                      "staleHint": bool(kind == "haber" and age_h is not None and age_h >= QUEUE_STALE_HINT_HOURS), "dropAfterHours": queue_max_hours(kind),
                      "value": ({"valuable": bool(v.get("valuable")), "top": bool(v.get("top")), "reason": str(v.get("reason") or "")[:80]} if v else None),
                      "label": str(meta.get("slotLabel") or meta.get("infoLabel") or meta.get("label") or "")[:30],  # assemble_script: slotLabel (YENİ FRAGMAN, ANLIK HABER…)
                      "tries": int(x.get("tries") or 0), "lastTry": x.get("lastTry"), "lastError": x.get("lastError") or ""})
    return {"count": len(q), "videos": [x.get("video") for x in q], "items": items,
            "order": "önce fragmanlar, sonra sizin videolarınız, sonra haberler (en yeni önce)", "staleHintHours": QUEUE_STALE_HINT_HOURS,
            "holdUntil": until.isoformat() if until else None, "reason": reason, "holdReason": hold_reason_tr(plat, reason) if until else "",
            "events": events}


def queue_line(plat: str) -> str:
    """Loga yazılan tek satır: "📤 tiktok sırası: 3 video bekliyor (…) · gönderim 15:20'ye kadar duraklatıldı (…)"."""
    qi = queue_info(plat)
    if not qi["count"] and not qi["holdUntil"]:
        return f"📤 {plat} sırası: boş"
    names = ", ".join(Path(v).stem for v in qi["videos"][:4]) + (" …" if qi["count"] > 4 else "")  # yüklenecek sırayla ilk dördü
    why = (TT_LIMIT_TR.get(qi["reason"]) or qi["reason"]) if plat == "tiktok" else (IG_LIMIT_TR.get(qi["reason"]) or qi["reason"]) if plat == "instagram" else qi["reason"]
    hold = f" · gönderim {local_hhmm(_parse(qi['holdUntil']))}'e kadar duraklatıldı ({str(why).split(" (")[0][:80]})" if qi["holdUntil"] else " · duraklatma yok, sıradaki gönderimde yüklenecek"
    return f"📤 {plat} sırası: {qi['count']} video bekliyor" + (f" ({names})" if qi["count"] else "") + hold


def local_hhmm(dt):
    return dt.astimezone().strftime("%H:%M")

# "youtube" kapsamı oynatma listesi yönetimi için; eski bağlantılar (yalnız upload+readonly) yeniden bağlanana kadar
# listesiz yükler. Token dosyadaki kendi kapsamlarıyla okunur (yeni kapsamla yenilemek invalid_scope verir).
YT_SCOPES = ["https://www.googleapis.com/auth/youtube.upload", "https://www.googleapis.com/auth/youtube.readonly",
             "https://www.googleapis.com/auth/youtube", "https://www.googleapis.com/auth/yt-analytics.readonly",
             "https://www.googleapis.com/auth/youtube.force-ssl"]
YT_COMMENT = "https://www.googleapis.com/auth/youtube.force-ssl"  # ilk yorum (commentThreads.insert yalnız bu izinle)
YT_ANALYTICS = "https://www.googleapis.com/auth/yt-analytics.readonly"  # günlük abone kazanımı geçmişi (followers.py)
YT_MANAGE = {"https://www.googleapis.com/auth/youtube", "https://www.googleapis.com/auth/youtube.force-ssl"}
PLAYLIST_FILE = DATA / "youtube_playlists.json"  # {liste adı: playlistId}
# kategori → liste adı (kanal adı önek olarak eklenir); format listeleri: anlık → Son Dakika, düzenli → 5 saatlik özet
PLAYLIST_BY_CATEGORY = {"finans": "Ekonomi", "siyaset": "Siyaset", "parti": "Siyaset", "asayis": "Asayiş ve Kaza",
                        "hava": "Hava ve Afet", "egitim": "Eğitim", "saglik": "Sağlık", "dunya": "Dünya",
                        "spor": "Spor", "teknoloji": "Teknoloji", "toplum": "Toplum", "sinema": "Sinema", "trend": "Viral Videolar", "mizah": "Mizah"}


# ---------------- YouTube
def yt_connect():
    """Panelden "YouTube'u bağla / yeniden bağla": token geçerli olsa bile tarayıcıda Google onayını YENİDEN açar
    (prompt=consent), böylece sonradan eklenen kapsamlar (oynatma listesi) da verilir. Kullanıcı vazgeçerse eski
    token korunur. Dönen kapsamlarda liste izni yoksa (onay ekranında işaret kaldırıldıysa) bunu söyler."""
    from google_auth_oauthlib.flow import InstalledAppFlow
    client = SECRETS / "youtube_client.json"
    if not client.exists():
        raise RuntimeError(f"{client} yok. Google Cloud'dan OAuth istemci dosyasını buraya koyun.")
    creds = InstalledAppFlow.from_client_secrets_file(str(client), YT_SCOPES).run_local_server(
        port=0, prompt="consent", access_type="offline", timeout_seconds=600,
        success_message="YouTube bağlandı. Bu sekmeyi kapatıp panele dönebilirsiniz.")
    (SECRETS / "youtube_token.json").write_text(creds.to_json())
    return bool(set(creds.scopes or []) & YT_MANAGE)


def yt_disconnect():
    """Bağlantıyı kes: Google'da izni geri al (olmazsa sessiz geç) ve token dosyasını sil."""
    token = SECRETS / "youtube_token.json"
    if not token.exists():
        return False
    try:
        tok = json.loads(token.read_text())
        t = tok.get("refresh_token") or tok.get("token")
        if t:
            urllib.request.urlopen(urllib.request.Request("https://oauth2.googleapis.com/revoke?" + urllib.parse.urlencode({"token": t}),
                                                          method="POST", headers={"Content-Type": "application/x-www-form-urlencoded"}), timeout=15)
    except Exception as e:
        print(f"  ! Google izni geri alınamadı (token yine de silindi): {e}", file=sys.stderr)
    token.unlink()
    return True


def yt_service(interactive=False, api=("youtube", "v3")):
    try:
        from google.auth.transport.requests import Request
        from google.oauth2.credentials import Credentials
        from googleapiclient.discovery import build
    except ImportError:
        sys.exit("Eksik paket: pip install google-api-python-client google-auth-oauthlib")
    client = SECRETS / "youtube_client.json"
    token = SECRETS / "youtube_token.json"
    creds = Credentials.from_authorized_user_file(str(token)) if token.exists() else None
    if creds and creds.expired and creds.refresh_token:
        creds.refresh(Request())
        token.write_text(creds.to_json())
    if not creds or not creds.valid:
        if not interactive:
            raise RuntimeError("YouTube bağlı değil. Önce: python3 scripts/publish.py --connect youtube")
        if not client.exists():
            raise RuntimeError(f"{client} yok. Google Cloud'dan OAuth istemci dosyasını buraya koyun.")
        from google_auth_oauthlib.flow import InstalledAppFlow
        creds = InstalledAppFlow.from_client_secrets_file(str(client), YT_SCOPES).run_local_server(port=0)
        token.write_text(creds.to_json())
    if api[0] == "youtubeAnalytics" and YT_ANALYTICS not in set(creds.scopes or json.loads(token.read_text()).get("scopes") or []):
        raise RuntimeError("YouTube abone geçmişi için izin yok: Ayarlar → YouTube → 🔄 Yeniden bağla (Google Cloud'da "
                           "\"YouTube Analytics API\" da etkin olmalı)")
    return build(api[0], api[1], credentials=creds, cache_discovery=False)


def yt_upload(path: Path):
    from googleapiclient.http import MediaFileUpload
    yt = yt_service()
    title, desc = build_caption(path.name, max_len=4900)
    from hashtags import youtube_tags
    meta = episode_meta(path.name) or {}
    body = {"snippet": {"title": title, "description": desc, "categoryId": "25", "defaultLanguage": "tr",
                        "tags": youtube_tags(caption_tags(path.name))},
            "status": {"privacyStatus": "public", "selfDeclaredMadeForKids": False}}
    if meta.get("aiVisuals"):  # gerçekçi yapay zekâ fotoğrafları: YouTube'un "değiştirilmiş ya da yapay içerik" beyanı (izleyiciye etiket)
        body["status"]["containsSyntheticMedia"] = True

    def send(b):
        req = yt.videos().insert(part="snippet,status", body=b, media_body=MediaFileUpload(str(path), chunksize=-1, resumable=True))
        resp = None
        while resp is None:
            _, resp = req.next_chunk()
        return resp
    try:
        try:
            resp = send(body)
        except Exception as e:  # alanı tanımayan eski API sürümü: beyan olmadan bir kez (açıklamadaki satır yine durur)
            if "containsSyntheticMedia" not in body["status"] or not any(x in str(e) for x in ("containsSyntheticMedia", "Unknown name", "invalidArgument")):
                raise
            print(f"  ! YouTube yapay içerik beyanını kabul etmedi ({str(e)[:120]}); beyansız yükleniyor (açıklamada yine yazıyor)", file=sys.stderr, flush=True)
            body["status"].pop("containsSyntheticMedia", None)
            resp = send(body)
    except Exception as e:  # günlük sınır: okunur mesaj, kısa aralıkla yeniden deneme yok
        reason = next((r for r in LIMIT_REASONS if r in str(e)), None)
        if reason:
            raise LimitReached(reason) from e
        raise
    vid = resp["id"]
    url = f"https://youtube.com/watch?v={vid}" if meta.get("format") in ("gunluk", "haftalik") or meta.get("kare") else f"https://youtube.com/shorts/{vid}"  # kare uzun video Shorts değil
    rec = {"id": vid, "url": url, "publishedAt": now_iso(), "title": title, "titleVariant": meta.get("titleVariant"), "playlists": []}
    try:  # video yüklendi: kapak, oynatma listesi ve ilk yorum adımındaki hata yeniden yüklemeye (ikinci kopya) yol açmasın
        thumb_err = yt_set_thumb(yt, vid, path)
        if not thumb_err:  # kapak izni çalışıyor: önceden kapağı reddedilmiş videoları da düzelt (en çok 3)
            yt_retry_thumbs(yt, limit=3)
        rec["playlists"] = yt_add_to_playlists(yt, vid, meta)
        rec.update(yt_first_comment(yt, vid, meta))
        rec.update({"thumbError": thumb_err} if thumb_err else {"thumbSet": True})
    except Exception as e:
        print(f"  ! YouTube yükleme sonrası adım hata verdi ({str(e)[:120]}); video yüklendi: {url}", file=sys.stderr, flush=True)
        rec["postError"] = str(e)[:160]
    return rec


def first_comment_text(meta: dict) -> str:
    """Kanal adına ilk yorum (kullanıcı kararı; senaryo "firstComment" yazar, assemble yedeği). settings.firstComment.enabled."""
    from common import settings
    if (settings().get("firstComment") or {}).get("enabled") is False:
        return ""
    # alanı olmayan (özellikten önce üretilmiş ya da senaryosu yazmamış) videoda genel soru: hiçbir video yorumsuz kalmasın
    return str(meta.get("firstComment") or "").strip() or "Siz bu konuda ne düşünüyorsunuz? Yorumlarda buluşalım 👇"


def yt_scopes() -> set:
    try:
        return set(json.loads((SECRETS / "youtube_token.json").read_text()).get("scopes") or [])
    except Exception:
        return set()


def yt_first_comment(yt, vid: str, meta: dict) -> dict:
    """Yüklemeden hemen sonra ilk yorum. Sabitleme API'de yok (YouTube Studio'dan elle). Hata yüklemeyi bozmaz."""
    text = first_comment_text(meta)
    if not text:
        return {}
    if YT_COMMENT not in yt_scopes():
        print("  ! YouTube ilk yorum yazılamadı: yorum izni yok (Ayarlar → YouTube → 🔄 Yeniden bağla)", file=sys.stderr)
        return {"commentError": "yorum izni yok: yeniden bağla"}
    try:
        r = yt.commentThreads().insert(part="snippet", body={"snippet": {"videoId": vid, "topLevelComment": {"snippet": {"textOriginal": text}}}}).execute()
        print(f"  💬 YouTube ilk yorum: {text[:80]}", file=sys.stderr)
        return {"firstComment": r.get("id")}
    except Exception as e:
        print(f"  ! YouTube ilk yorum yazılamadı: {str(e)[:160]}", file=sys.stderr)
        return {"commentError": str(e)[:160]}


def fill_first_comments(max_n: int = 6, max_age_h: float = 72) -> dict:
    """Yayında ilk yorumu olmayan videolara yorumu sonradan yazar (kullanıcı şikâyeti: "ilk yorumu atmadı"). Yükleme anında
    yazılamayan (izin yok, video henüz işleniyor, ağ) her YouTube/Instagram gönderisi için son 72 saatte en çok 4 deneme,
    denemeler arası ≥15 dk. İzlenme senkronundan sonra panel çağırır (`--first-comments`). Sonuç metrics firstComment/commentError."""
    if (settings_get("firstComment") or {}).get("enabled") is False:
        return {"ok": True, "done": [], "failed": [], "note": "ilk yorum kapalı"}
    m = metrics()
    todo = []
    for name, v in m["videos"].items():
        for plat in ("youtube", "instagram"):
            e = v.get(plat) or {}
            if not e.get("id") or e.get("firstComment") or e.get("commentTries", 0) >= 4 or time.time() - e.get("commentTriedAt", 0) < 900:
                continue
            try:
                age = (datetime.now(timezone.utc) - datetime.fromisoformat(str(e.get("publishedAt")).replace("Z", "+00:00"))).total_seconds() / 3600
            except Exception:
                continue
            if 0.05 <= age <= max_age_h:  # yüklemenin kendisi 3 dk içinde zaten dener
                todo.append((age, name, plat))
    todo.sort()
    done, failed, need_scope = [], [], False
    yt = creds = None
    for _, name, plat in todo[:max_n]:
        e = m["videos"][name][plat]
        text = first_comment_text(episode_meta(name) or {})
        if plat == "youtube" and YT_COMMENT not in yt_scopes():  # deneme sayılmaz: izin gelince ilk senkronda yazılır
            need_scope = True
            e["commentError"] = "yorum izni yok: yeniden bağla"
            continue
        e["commentTriedAt"], e["commentTries"] = time.time(), e.get("commentTries", 0) + 1
        try:
            if plat == "youtube":
                yt = yt or yt_service()
                cid = yt.commentThreads().insert(part="snippet", body={"snippet": {"videoId": e["id"], "topLevelComment": {"snippet": {"textOriginal": text}}}}).execute().get("id")
            else:
                creds = creds or ig_creds()
                cid = ig_call("POST", f"{e['id']}/comments", {"message": text}, creds).get("id")
            e["firstComment"] = cid
            e.pop("commentError", None)
            done.append({"video": name, "platform": plat})
            print(f"💬 ilk yorum ({plat}, sonradan): {name} — {text[:80]}", flush=True)
        except Exception as ex:
            e["commentError"] = str(ex)[:160]
            failed.append({"video": name, "platform": plat, "error": str(ex)[:160]})
            print(f"💬 ilk yorum yazılamadı ({plat}): {name} — {str(ex)[:140]}", flush=True)
    if todo:  # yorum yazılırken başka süreç (yayın, senkron) metrikleri yazmış olabilir: yalnız yorum alanları taze kayda işlenir
        fresh = metrics()
        for _, name, plat in todo[:max_n]:
            src, dst = m["videos"][name][plat], (fresh["videos"].get(name) or {}).get(plat)
            if dst is not None:
                for k in ("firstComment", "commentError", "commentTries", "commentTriedAt"):
                    if k in src:
                        dst[k] = src[k]
                    else:
                        dst.pop(k, None)
        save_metrics(fresh)
    return {"ok": True, "done": done, "failed": failed, "needScope": need_scope, "pending": len(todo)}


def settings_get(key: str):
    from common import settings
    return settings().get(key)


VIEWS_AT = DATA / "views_at_check.json"  # başlık kontrolü: {video: {views, ageH, at}} (ortanca bundan)


def yt_retitle() -> dict:
    """Tutmayan videonun YouTube başlığını değiştir (kullanıcı kararı): yayından `afterHours` (3) saat sonraki ilk
    izlenme senkronunda video, önceki videoların aynı yaştaki izlenmesinin ortancasının `ratio` (0,5) katının altındaysa
    başlık diğer varyanta (A ↔ B) geçer; bir kez. Ortanca için en az `minBaseline` (5) kayıt gerekir. Instagram ve TikTok
    API'si başlık/açıklama değiştirmeye izin vermez. settings.retitle {enabled, afterHours, ratio, minBaseline}."""
    import statistics
    from common import settings
    c = {"enabled": True, "afterHours": 3, "ratio": 0.5, "minBaseline": 5, **(settings().get("retitle") or {})}
    if c.get("enabled") is False:
        return {"ok": True, "changed": [], "skipped": "kapalı"}
    m = metrics()
    rec = load_json(VIEWS_AT, {}) or {}
    now = datetime.now(timezone.utc)
    changed, yt = [], None
    for name, v in list(m["videos"].items()):
        y = v.get("youtube") or {}
        pub = _parse(y.get("publishedAt", "")) if y.get("id") else None
        if not pub or name in rec or y.get("views") is None:
            continue
        age = (now - pub).total_seconds() / 3600
        if age < float(c["afterHours"]):
            continue
        meta = episode_meta(name) or {}
        late = age > float(c["afterHours"]) + 6 or meta.get("format") in ("gunluk", "haftalik") or meta.get("kare")  # uzun video Shorts ölçüsüyle karşılaştırılmaz
        base = [x["views"] for x in rec.values() if not x.get("skip") and x.get("views") is not None][-20:]
        rec[name] = {"views": y["views"], "ageH": round(age, 1), "at": time.time(), **({"skip": True} if late else {})}
        if late or len(base) < int(c["minBaseline"]):
            continue
        med = statistics.median(base)
        if y["views"] >= med * float(c["ratio"]):
            continue
        titles = meta.get("titles") or {}
        cur = meta.get("titleVariant") or "A"
        other = "B" if cur == "A" else "A"
        new = str(titles.get(other) or "").strip()
        if not new or new == meta.get("publishTitle"):
            continue
        try:
            if not (yt_scopes() & YT_MANAGE):
                raise RuntimeError("başlık değiştirme izni yok (Ayarlar → YouTube → 🔄 Yeniden bağla)")
            yt = yt or yt_service()
            meta_path = OUT / name.replace(".mp4", ".json")
            old_title = y.get("title") or meta.get("publishTitle") or ""
            meta.update({"publishTitle": new, "titleVariant": other,
                         "retitled": {"from": cur, "to": other, "views": y["views"], "median": med, "at": now_iso()}})
            meta_path.write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
            title, _ = build_caption(name, max_len=4900)
            sn = yt.videos().list(part="snippet", id=y["id"]).execute()["items"][0]["snippet"]
            body = {"id": y["id"], "snippet": {"title": title, "description": sn.get("description", ""), "categoryId": sn.get("categoryId", "25"),
                                               "tags": sn.get("tags") or [], "defaultLanguage": sn.get("defaultLanguage", "tr")}}
            yt.videos().update(part="snippet", body=body).execute()
            mm = metrics()
            mm["videos"].setdefault(name, {}).setdefault("youtube", {}).update({"title": title, "retitled": {"from": old_title, "at": now_iso()}})
            save_metrics(mm)
            print(f"📉 YouTube başlığı değiştirildi: {name} ({y['views']} izlenme, ortanca {int(med)}) → \"{title[:70]}\"", flush=True)
            changed.append(name)
        except Exception as e:
            print(f"📉 YouTube başlığı değiştirilemedi ({name}): {str(e)[:160]}", flush=True)
    save_json(VIEWS_AT, dict(list(rec.items())[-300:]))
    return {"ok": True, "changed": changed}


def yt_thumb_hint(e) -> str:
    msg = str(e)
    if re.search(r"(403|forbidden|permission|custom video thumbnails|not authorized)", msg, re.I):
        return ("kanal özel kapak iznine sahip değil: youtube.com/verify adresinden kanalı telefonla doğrulayın "
                "(doğrulanana kadar YouTube videonun ortasından rastgele kare seçer); sonra panelde 'kapakları yeniden yükle'")
    if re.search(r"(429|rateLimit|quota)", msg, re.I):
        return "YouTube kota/sıklık sınırı; bir sonraki yüklemede yeniden denenecek"
    return msg[:200]


def yt_set_thumb(yt, vid: str, path: Path):
    """Videoya kendi kapağımızı (-kapakYT.jpg, yoksa dikey) koyar; hata varsa Türkçe nedeni döner (yayın yine tamam)."""
    thumb = path.with_name(path.stem + "-kapakYT.jpg")  # 16:9 YouTube kapağı; yoksa dikey
    if not thumb.exists():
        thumb = path.with_name(path.stem + "-kapak.jpg")
    if not thumb.exists():
        return "kapak dosyası yok"
    try:
        yt.thumbnails().set(videoId=vid, media_body=MediaFileUpload(str(thumb))).execute()
        print(f"  ▶ YouTube kapağı yüklendi ({thumb.name})", file=sys.stderr)
        return None
    except Exception as e:
        hint = yt_thumb_hint(e)
        print(f"  ! YouTube kapağı yüklenemedi: {hint}", file=sys.stderr)
        return hint


def yt_retry_thumbs(yt=None, limit: int = 50) -> dict:
    """Kapağı reddedilmiş (thumbError) ya da hiç denenmemiş YouTube videolarına kapağı yeniden yükler."""
    m = metrics()
    todo = [(name, v["youtube"]) for name, v in m["videos"].items()
            if (v.get("youtube") or {}).get("id") and not v["youtube"].get("thumbSet") and (OUT / name).exists()]
    todo.sort(key=lambda x: x[1].get("publishedAt") or "", reverse=True)
    if not todo:
        return {"ok": True, "done": 0, "left": 0}
    yt = yt or yt_service()
    done, err = 0, None
    for name, rec in todo[:limit]:
        e = yt_set_thumb(yt, rec["id"], OUT / name)
        if e:
            err = e
            rec["thumbError"] = e
            if "özel kapak izni" in e or "kota" in e:
                break  # aynı neden hepsini etkiler
        else:
            rec.pop("thumbError", None)
            rec["thumbSet"] = True
            done += 1
    save_metrics(m)
    return {"ok": err is None, "done": done, "left": len(todo) - done, "error": err}


def playlist_names(meta: dict) -> list:
    """Videonun gireceği listeler: format (Son Dakika / Her 5 Saatte Gündem / Günlük Özet) + ilk haberin kategorisi. Fragman analizi
    (kullanıcı isteği, 18 Ekim; meta trailer) format listesine girmez: fragman son dakika haberi değil, yalnız kategori listesi (· Sinema)."""
    from common import settings
    ch = settings().get("channelName", "Türkiye Gündemi")
    fmt = meta.get("format")
    # uzun video özeti ve viral/mizah videosu son dakika değil: yalnız kategori listesi
    # benzer video (sıfırdan çizilmiş hikâye) de son dakika değil
    calm = (meta.get("summary") and meta.get("slotLabel") != "SON DAKİKA") or meta.get("contentKind") in ("trend", "mizah") or meta.get("recreated")
    # kare uzun video: Son Dakika listesine girmez (kategori listesi yine eklenir)
    names = [] if meta.get("trailer") or calm or (meta.get("kare") and meta.get("slotLabel") != "SON DAKİKA") else [
             f"{ch} · Son Dakika" if (meta.get("anlik") or fmt == "anlik")
             else f"{ch} · Günün Özeti (uzun)" if fmt == "gunluk"
             else f"{ch} · Haftanın Özeti (uzun)" if fmt == "haftalik"
             else f"{ch} · Her 5 Saatte Gündem"]
    first = next((x for x in meta.get("segments", []) if x.get("kind") in ("haber", "hook") and x.get("category")), {})
    cat = PLAYLIST_BY_CATEGORY.get(first.get("category"))
    if cat:
        names.append(f"{ch} · {cat}")
    # dizi başına liste (kullanıcı isteği, 27 Ekim: "aynı dizinin fragman analizleri YouTube'da kendiliğinden bir listede toplansın"): fragman
    # analizinde dizi/film adı (meta film; fragman takibi ve sahibin linki aynı yoldan) varsa "<dizi> · Fragmanlar"; ad yoksa yalnız kategori listesi
    film = series_name(meta.get("film")) if meta.get("trailer") else ""
    if film:
        names.append(f"{film} · Fragmanlar")
    return names


def series_name(film) -> str:
    """Liste adı için dizi/film adı: boşluklar tekleşir, sondaki noktalama atılır, en çok 80 karakter (YouTube liste adı sınırı 150)."""
    t = re.sub(r"\s+", " ", str(film or "")).strip(" \t-–—·|:;,.!?")
    return t[:80].strip()


def yt_find_playlist(yt, name: str):
    """Kanalda aynı adlı liste var mı (büyük/küçük harf farkı sayılmaz, Türkçe I/İ dahil; dizi listeleri çoğalınca 50'den fazla liste olur: sayfalar gezilir)."""
    fold = lambda t: str(t or "").replace("I", "ı").replace("İ", "i").lower()
    want, token = fold(name), None
    for _ in range(20):
        page = yt.playlists().list(part="snippet", mine=True, maxResults=50, **({"pageToken": token} if token else {})).execute()
        pid = next((x["id"] for x in page.get("items", []) if fold(x["snippet"]["title"]) == want), None)
        if pid or not page.get("nextPageToken"):
            return pid
        token = page["nextPageToken"]
    return None


def yt_add_to_playlists(yt, vid: str, meta: dict) -> list:
    """Yükleneni listelere ekler (yoksa herkese açık liste oluşturur). Hata yayını bozmaz."""
    creds = getattr(yt._http, "credentials", None)
    if creds is not None and not (set(creds.scopes or []) & YT_MANAGE):
        print("  ! oynatma listesi: YouTube bağlantısında liste izni yok; Ayarlar → Yayın hesapları → YouTube'u yeniden bağlayın", file=sys.stderr)
        return []
    ids = load_json(PLAYLIST_FILE, {}) or {}
    added = []
    for name in playlist_names(meta):
        try:
            pid = ids.get(name)
            if not pid:  # önce kanalda aynı adla var mı bak, yoksa oluştur
                pid = yt_find_playlist(yt, name)
                if not pid:
                    desc = f"{name} — bu dizinin ve filmin fragman analizleri; otomatik güncellenir." if name.endswith(" · Fragmanlar") else f"{name} — otomatik güncellenen haber listesi."
                    pid = yt.playlists().insert(part="snippet,status", body={
                        "snippet": {"title": name, "description": desc, "defaultLanguage": "tr"},
                        "status": {"privacyStatus": "public"}}).execute()["id"]
                ids[name] = pid
                save_json(PLAYLIST_FILE, ids)
            yt.playlistItems().insert(part="snippet", body={"snippet": {"playlistId": pid, "resourceId": {"kind": "youtube#video", "videoId": vid}}}).execute()
            added.append(name)
            print(f"  ▶ oynatma listesi: {name}", file=sys.stderr)
        except Exception as e:
            if "playlistNotFound" in str(e):
                ids.pop(name, None)
                save_json(PLAYLIST_FILE, ids)
            print(f"  ! oynatma listesi eklenemedi ({name}): {str(e)[:160]}", file=sys.stderr)
    return added


# ---------------- Instagram (Instagram API with Instagram Login; eski Facebook Graph token'ı da desteklenir)
IG_TOKEN_FILE = SECRETS / "instagram_token.json"
IG_SCOPES = "instagram_business_basic,instagram_business_content_publish,instagram_business_manage_insights,instagram_business_manage_comments"
IG_API = "https://graph.instagram.com/v21.0"
FB_API = "https://graph.facebook.com/v21.0"
IG_CALLBACK_PORT = 3138
# Facebook Login yolu izinleri. Her biri Meta uygulamasında Kullanım senaryosu → "Permissions and features" listesinde
# "Add" ile eklenmiş olmalı; eklenmemiş izin "Invalid Scopes" hatası verir. İş portföyüne bağlı sayfalar için
# .env'de IG_EXTRA_SCOPES=business_management eklenebilir. Gönderi silme (Instagram temizliği, panel "🗑 Sil") yalnız bu yolda
# ve instagram_manage_contents izniyle çalışır: Meta uygulamasında izni ekleyip .env'e IG_EXTRA_SCOPES=instagram_manage_contents
# yazın (ikisi birlikte virgülle) ve yeniden bağlanın; varsayılan listede yok çünkü eklenmemiş izin bağlanmayı bozar.
FB_SCOPES = "instagram_basic,instagram_content_publish,instagram_manage_insights,instagram_manage_comments,pages_show_list,pages_read_engagement"


def fb_finish(env, redirect, code):
    """Facebook Login yolu: kod → kısa kullanıcı token'ı → uzun ömürlü → Sayfa token'ı (süresi dolmaz) +
    sayfaya bağlı Instagram profesyonel hesabının kimliği."""
    q = urllib.parse.urlencode({"client_id": env["IG_APP_ID"], "client_secret": env["IG_APP_SECRET"], "redirect_uri": redirect, "code": code})
    short = ig_http(f"{FB_API}/oauth/access_token?{q}")
    q = urllib.parse.urlencode({"grant_type": "fb_exchange_token", "client_id": env["IG_APP_ID"], "client_secret": env["IG_APP_SECRET"], "fb_exchange_token": short["access_token"]})
    long_tok = ig_http(f"{FB_API}/oauth/access_token?{q}")
    user_token = long_tok.get("access_token", short["access_token"])
    pages = ig_http(f"{FB_API}/me/accounts?" + urllib.parse.urlencode({"fields": "id,name,access_token,instagram_business_account{id,username}", "limit": "50", "access_token": user_token})).get("data", [])
    page = next((p for p in pages if p.get("instagram_business_account")), None)
    if not page:
        names = ", ".join(p.get("name", "?") for p in pages)
        if not pages:
            raise RuntimeError("Facebook uygulamaya hiçbir Sayfa için izin vermedi. Tekrar bağlanırken giriş ekranında 'Türkiye Gündemi' sayfasını "
                               "işaretleyin (Hesapları düzenle → sayfayı seç). Sayfa bir İş portföyündeyse: Meta uygulamasında business_management iznini "
                               "ekleyip .env'e IG_EXTRA_SCOPES=business_management yazın ve yeniden bağlanın.")
        raise RuntimeError(f"Sayfalar bulundu ({names}) ama hiçbirine Instagram hesabı bağlı değil. Facebook → Sayfa → Ayarlar → Bağlı hesaplar → Instagram → Hesabı bağla; sonra tekrar deneyin.")
    ig = page["instagram_business_account"]
    tok = {"access_token": page["access_token"], "expires_in": 0, "obtained_at": time.time(), "via": "facebook",
           "user_id": str(ig["id"]), "username": ig.get("username"), "page_id": page["id"], "page_name": page.get("name")}
    IG_TOKEN_FILE.write_text(json.dumps(tok, indent=2))
    return tok


def ig_http(url, data=None, timeout=60):
    req = urllib.request.Request(url, data=data, method="POST" if data is not None else "GET")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        txt = e.read().decode("utf-8", "replace")
        try:
            msg = json.loads(txt).get("error", {}).get("message") or txt
        except Exception:
            msg = txt
        raise RuntimeError(f"Instagram HTTP {e.code}: {msg[:300]}")


def ig_creds():
    """(kullanıcı id, token, API kökü). Önce panelden bağlanan hesap (instagram_token.json, Instagram Login),
    yoksa secrets/.env içindeki IG_USER_ID + IG_ACCESS_TOKEN (Facebook Graph). Token süresi 15 günün
    altına indiyse sessizce yenilenir (60 güne uzar)."""
    if IG_TOKEN_FILE.exists():
        tok = json.loads(IG_TOKEN_FILE.read_text())
        if tok.get("via") == "facebook":  # Sayfa token'ı: süresi dolmaz, graph.facebook.com
            return tok.get("user_id") or "me", tok["access_token"], FB_API
        env = load_env()
        age = time.time() - tok.get("obtained_at", 0)
        left = tok.get("obtained_at", 0) + tok.get("expires_in", 0) - time.time()
        if age > 86400 and left < 15 * 86400:
            try:
                q = urllib.parse.urlencode({"grant_type": "ig_refresh_token", "access_token": tok["access_token"]})
                new = ig_http(f"https://graph.instagram.com/refresh_access_token?{q}")
                tok.update({"access_token": new["access_token"], "expires_in": new.get("expires_in", 5184000), "obtained_at": time.time()})
                IG_TOKEN_FILE.write_text(json.dumps(tok, indent=2))
            except Exception as e:
                print(f"  ! instagram token yenilenemedi: {e}", file=sys.stderr)
        return tok.get("user_id") or "me", tok["access_token"], IG_API
    env = load_env()
    if env.get("IG_USER_ID") and env.get("IG_ACCESS_TOKEN"):
        return env["IG_USER_ID"], env["IG_ACCESS_TOKEN"], FB_API
    raise RuntimeError("Instagram bağlı değil. Panelde 'Instagram'ı bağla' deyin (IG_APP_ID ve IG_APP_SECRET gerekir, bkz. secrets/README.md)")


def ig_call(method, path, params, creds, timeout=60):
    uid, token, base = creds
    params = dict(params, access_token=token)
    url = f"{base}/{path}"
    if method == "GET":
        return ig_http(url + "?" + urllib.parse.urlencode(params), timeout=timeout)
    return ig_http(url, urllib.parse.urlencode(params).encode(), timeout=timeout)


def _norm_caption(s) -> str:
    return re.sub(r"\s+", " ", str(s or "")).strip()


def ig_recent_media(creds, limit: int = 25, pages: int = 1, until=None) -> list:
    """Hesabın en yeni gönderileri [{id, caption, timestamp, permalink, media_type}] (Instagram Girişi /me/media, Facebook Girişi
    /{hesap}/media; en yeniden eskiye, sayfa başına `limit`, en çok `pages` sayfa; `until` (zaman) verilirse ondan eski gönderiye
    gelince durur); okunamazsa []."""
    uid, token, base = creds
    owner = "me" if base == IG_API else uid
    out, after = [], None
    for _ in range(max(1, pages)):
        q = {"fields": "id,caption,timestamp,permalink,media_type", "limit": limit, "access_token": token, **({"after": after} if after else {})}
        st, body = _graph("GET", f"{base}/{owner}/media?" + urllib.parse.urlencode(q))
        data = None if graph_error(st, body) else body.get("data")
        if not isinstance(data, list):
            break
        out += [x for x in data if isinstance(x, dict) and x.get("id")]
        after = ((body.get("paging") or {}).get("cursors") or {}).get("after")
        if not after or len(data) < limit:
            break
        if until is not None:
            ts = [_ts(x.get("timestamp")) for x in data if isinstance(x, dict)]
            ts = [t for t in ts if t]
            if ts and min(ts) < until:
                break
    return out


def ig_find_published(creds, caption: str, max_age_h: float = 6.0, since=None) -> dict | None:
    """Aynı açıklamayla yüklenmiş gönderi (boşlukları sadeleştirilmiş açıklama birebir aynı ya da ilk 150 karakteri aynı ve uzunluk ±5):
    yayın isteği başarılı olup yanıtı kaybolduysa (zaman aşımı, bağlantı kopması, sonraki adımın hatası) yeniden denemede ikinci kopya
    yüklenmesin (kullanıcı şikâyeti, 23 Ekim: Instagram'da ikişer paylaşılmış haberler). Pencere: `since` (zaman; videonun üretim anı —
    sınır sırasında bir gün bekleyen video da bulunur) ya da son `max_age_h` saat; liste o zamana kadar sayfalanır (en çok 8 sayfa × 50).
    {id, url, publishedAt} ya da None."""
    want = _norm_caption(caption)
    if len(want) < 20:
        return None
    now = datetime.now(timezone.utc)
    if since is not None and since.tzinfo is None:
        since = since.replace(tzinfo=timezone.utc)
    cutoff = since if since is not None else now - timedelta(hours=max_age_h)
    for m in ig_recent_media(creds, limit=50, pages=8, until=cutoff):
        c = _norm_caption(m.get("caption"))
        if not c or not (c == want or (c[:150] == want[:150] and abs(len(c) - len(want)) <= 5)):
            continue
        ts = _ts(m.get("timestamp"))
        if ts and ts < cutoff:
            continue
        return {"id": str(m["id"]), "url": m.get("permalink"), "publishedAt": m.get("timestamp") or now_iso()}
    return None


def ig_resolve_unresolved(creds) -> int:
    """Kimliği çözülememiş Instagram kayıtları (unresolved: yayın yanıtı kaybolmuş, konteyner PUBLISHED ama gönderi listede henüz yoktu):
    aynı açıklamalı gönderi aranır, bulununca kimlik ve bağlantı yazılır (metrics + defter). Dönen: tamamlanan kayıt sayısı."""
    m = metrics()
    fixed = {}
    for name, v in list((m.get("videos") or {}).items()):
        ig = v.get("instagram") if isinstance(v, dict) else None
        if not (isinstance(ig, dict) and ig.get("unresolved") and not ig.get("id")) or _age_h(ig.get("publishedAt")) > 72:
            continue
        try:
            _, cap = build_caption(name, max_len=2200)
        except Exception:
            continue
        since = (_ts(ig.get("publishedAt")) or datetime.now(timezone.utc)) - timedelta(hours=1)
        f = ig_find_published(creds, cap, since=since)
        if f:
            fixed[name] = {"id": f["id"], "url": f.get("url"), "publishedAt": f.get("publishedAt") or ig.get("publishedAt")}
    if fixed:
        m = metrics()  # taze oku: bu arada yazılan kayıtlar kaybolmasın
        for name, f in fixed.items():
            ig = m["videos"].setdefault(name, {}).setdefault("instagram", {})
            ig.update(f); ig.pop("unresolved", None)
            ledger_set(name, "instagram", id=f["id"], url=f.get("url"), unresolved=False)
            print(f"  ! Instagram: {name} gönderisinin kimliği tamamlandı ({f.get('url') or f['id']})", file=sys.stderr, flush=True)
        save_metrics(m)
    return len(fixed)


def url_reachable(url, timeout=12):
    try:
        req = urllib.request.Request(url, method="HEAD")
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status == 200
    except Exception:
        return False


class _PublicVideo:
    """Yayın anında dış adres yoksa (panel kapalı, tünel kapalı) out/ klasörünü geçici bir sunucu +
    Cloudflare hızlı tüneliyle açar; yayın bitince kapatır. Böylece launchd üretimi de Instagram'a gider.
    `ensure_files` out/ dışındaki dosyaları da (Instagram hikâyesi: work/stories/) aynı yolla açar."""

    def __init__(self):
        self.proc = None
        self.srv = None
        self.base = None
        self.remote = None
        self.extra = []
        self.files = {}  # geçici sunucunun verdiği dosyalar: /videos/<ad> → yol

    def ensure(self, name: str) -> str:
        env = load_env()
        if hostinger.configured():  # kalıcı köprü: dosyayı web alanına yükle, Instagram oradan çeksin
            print(f"🌐 Hostinger: yükleniyor {name}", file=sys.stderr, flush=True)
            url = hostinger.upload(OUT / name, f"videos/{name}")
            self.remote = f"videos/{name}"
            for _ in range(10):
                if url_reachable(url):
                    break
                time.sleep(2)
            else:
                raise RuntimeError(f"Yüklenen video dış adresten okunamadı: {url} (HOSTINGER_SITE_URL / HOSTINGER_ROOT ayarlarını kontrol edin)")
            print(f"🌐 Hostinger: yüklendi {url}", file=sys.stderr, flush=True)
            return hostinger.site_url()
        base = (env.get("PUBLIC_BASE_URL") or "").rstrip("/")
        if base and url_reachable(f"{base}/videos/{urllib.parse.quote(name)}"):
            return base
        self.files[name] = OUT / name
        return self._tunnel(name)

    def ensure_files(self, paths: list) -> dict:
        """Her dosya için herkese açık adres {ad: url}. Hostinger varsa videos/stories/ altına yüklenir (close() siler),
        yoksa geçici sunucu + tünel. Adlar benzersiz olmalı (ör. hikaye-20261014-1.mp4)."""
        paths = [Path(x) for x in paths]
        if hostinger.configured():
            out = {}
            for p in paths:
                rel = f"videos/stories/{p.name}"
                print(f"🌐 Hostinger: yükleniyor {p.name}", file=sys.stderr, flush=True)
                out[p.name] = hostinger.upload(p, rel)
                self.extra.append(rel)
            for url in out.values():
                for _ in range(10):
                    if url_reachable(url):
                        break
                    time.sleep(2)
                else:
                    raise RuntimeError(f"Yüklenen dosya dış adresten okunamadı: {url}")
            return out
        for p in paths:
            self.files[p.name] = p
        base = self.base or self._tunnel(paths[0].name)
        return {p.name: f"{base}/videos/{urllib.parse.quote(p.name)}" for p in paths}

    def _tunnel(self, probe: str) -> str:
        import http.server
        import shutil
        import subprocess
        import threading
        if self.base:
            return self.base
        if not shutil.which("cloudflared"):
            raise RuntimeError("Dış adres yok ve cloudflared kurulu değil (brew install cloudflared); panelde tüneli açın")
        files = self.files

        class H(http.server.SimpleHTTPRequestHandler):
            def translate_path(self, path):  # /videos/<ad> → yalnız açıkça verilen dosyalar; başka yol yok
                p = urllib.parse.unquote(urllib.parse.urlparse(path).path)
                name = p[len("/videos/"):] if p.startswith("/videos/") else ""
                f = files.get(name) if name and "/" not in name else None
                return str(f) if f else str(OUT / "__yok__")

            def log_message(self, *a):
                pass

        self.srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H)
        port = self.srv.server_address[1]
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()
        self.proc = subprocess.Popen(["cloudflared", "tunnel", "--url", f"http://localhost:{port}"], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        import re
        deadline = time.time() + 60
        url = None
        while time.time() < deadline and not url:
            line = self.proc.stdout.readline()
            m = re.search(r"https://[a-z0-9-]+\.trycloudflare\.com", line or "")
            if m:
                url = m.group(0)
        if not url:
            self.close()
            raise RuntimeError("Geçici tünel açılamadı (cloudflared adres vermedi)")
        threading.Thread(target=lambda: [None for _ in iter(self.proc.stdout.readline, "")], daemon=True).start()
        for _ in range(20):  # DNS yayılması birkaç saniye sürer
            if url_reachable(f"{url}/videos/{urllib.parse.quote(probe)}"):
                break
            time.sleep(3)
        self.base = url
        print(f"  geçici dış adres: {url}", file=sys.stderr)
        return url

    def close(self):
        if (load_env().get("HOSTINGER_KEEP") or "0") != "1":
            for rel in self.extra:
                hostinger.delete(rel)
            self.extra = []
        if self.remote and (load_env().get("HOSTINGER_KEEP") or "0") != "1":
            hostinger.delete(self.remote)  # yayın bitti, web alanında yer kaplamasın
            print(f"🌐 Hostinger: silindi {self.remote}", file=sys.stderr, flush=True)
            self.remote = None
        if self.proc:
            self.proc.terminate()
            self.proc = None
        if self.srv:
            self.srv.shutdown()
            self.srv = None
        self.base = None


def ig_upload(path: Path):
    creds = ig_creds()
    uid = creds[0]
    name = path.name
    _, caption = build_caption(name, max_len=2200)
    own = {"owner": str(uid)} if uid and str(uid) != "me" else {}
    try:  # önceki yüklemelerin eksik kalmış kimlikleri (gönderi listesi geç geldiyse) tamamlanır
        ig_resolve_unresolved(creds)
    except Exception:
        pass
    led = ledger_get(name, "instagram")
    # arama penceresi: videonun üretim anı ya da ilk yükleme denemesi (hangisi önceyse) − 15 dk
    try:
        mtime = datetime.fromtimestamp(path.stat().st_mtime, timezone.utc)
    except Exception:
        mtime = None
    started = _ts(led.get("startedAt")) if led.get("startedAt") else None
    since = min([t for t in (mtime, started) if t], default=None)
    since = since - timedelta(minutes=15) if since else None
    # 1) yükleme defteri (kullanıcı şikâyeti, 24 Ekim: "halen daha çift paylaşım var"): önceki deneme konteyner açmış ya da yayın isteği
    # göndermişse Instagram'a konteynerin durumu sorulur. PUBLISHED → yayınlanmış: gönderi aranır, bulunamazsa bile YENİDEN YÜKLENMEZ
    # (kimlik sonra tamamlanır); FINISHED / IN_PROGRESS → aynı konteyner yayınlanır (video yeniden yüklenmez); yayın isteği gönderilmiş
    # ama durum okunamıyorsa hata (ikinci kopya olmasın: sonraki denemede yeniden bakılır); ERROR / EXPIRED → yeni konteyner
    reuse_cid = None
    if led.get("cid") and led.get("state") in ("container", "publishing") and _age_h(led.get("at")) < 24:
        cid0 = str(led["cid"])
        try:
            st0 = ig_call("GET", cid0, {"fields": "status_code,status"}, creds)
        except Exception as e:
            st0 = {"error": str(e)[:120]}
        code0 = st0.get("status_code")
        if code0 == "PUBLISHED":
            print(f"  ! Instagram: önceki denemenin konteyneri yayınlanmış ({cid0}); video yeniden yüklenmedi, gönderi aranıyor", file=sys.stderr, flush=True)
            found = None
            for k in range(6):
                found = ig_find_published(creds, caption, since=since)
                if found or k == 5:
                    break
                time.sleep(10)
            if found:
                ledger_set(name, "instagram", state="done", id=found["id"], url=found.get("url"), publishedAt=found.get("publishedAt"))
                return {**found, "recovered": True, **own}
            print("  ! Instagram: gönderi listede henüz görünmüyor; kimlik sonraki yüklemede tamamlanacak (yeniden yüklenmedi)", file=sys.stderr, flush=True)
            res = {"id": None, "url": None, "publishedAt": now_iso(), "recovered": True, "unresolved": True, "cid": cid0, **own}
            ledger_set(name, "instagram", state="done", unresolved=True, publishedAt=res["publishedAt"])
            return res
        if led.get("state") == "publishing" and code0 not in ("FINISHED", "IN_PROGRESS", "ERROR", "EXPIRED"):
            raise RuntimeError(f"Instagram: önceki yayın isteğinin sonucu doğrulanamadı (konteyner {cid0}, durum {code0 or st0.get('error') or 'bilinmiyor'}); "
                               "ikinci kopya olmasın diye yeniden yüklenmedi, sonraki denemede yeniden bakılır")
        if code0 in ("FINISHED", "IN_PROGRESS"):
            reuse_cid = cid0
            print(f"  ! Instagram: önceki denemenin konteyneri kullanılıyor ({cid0}, {code0}); video yeniden yüklenmiyor", file=sys.stderr, flush=True)
    # 2) aynı açıklamalı gönderi (kullanıcı şikâyeti, 23 Ekim): yayın isteği başarılı olup yanıtı kaybolduysa ya da kayıt silindiyse
    # videonun üretim anından bu yana aynı açıklamayla yüklenmiş gönderi vardır: o gönderi kayda geçer, ikinci kopya yüklenmez
    dup = ig_find_published(creds, caption, since=since)
    if dup:
        print(f"  ! Instagram: aynı açıklamayla gönderi zaten var ({dup.get('url') or dup['id']}); yeniden yüklenmedi, kayda geçti", file=sys.stderr, flush=True)
        ledger_set(name, "instagram", state="done", id=dup["id"], url=dup.get("url"), publishedAt=dup.get("publishedAt"))
        return {**dup, "recovered": True, **own}
    pub_srv = _PublicVideo()
    recovered = False
    ledger_set(name, "instagram", state="started", startedAt=led.get("startedAt") or now_iso(), attempt=int(led.get("attempt") or 0) + 1, cid=reuse_cid)
    try:
        if reuse_cid:
            cid = reuse_cid
        else:
            base = pub_srv.ensure(name)
            video_url = base + "/videos/" + urllib.parse.quote(name)
            # kapak: Hostinger varsa kendi kapağımız (-kapak.jpg) cover_url ile; dış adresten okunduğu doğrulanır (okunamazsa Instagram konteyneri
            # düşürebiliyor ya da kapaksız bırakıyordu). Hostinger yoksa ya da kapak verilemezse thumb_offset 0: videonun İLK KARESİ zaten kapaktır
            # (GundemVideo 0. karede Thumb çizer), Instagram o kareyi kapak yapar
            params = {"media_type": "REELS", "video_url": video_url, "caption": caption, "share_to_feed": "true", "thumb_offset": "0"}
            cover = path.with_name(path.stem + "-kapak.jpg")
            if cover.exists() and hostinger.configured():
                try:
                    cover_url = hostinger.upload(cover, f"videos/{cover.name}")
                    pub_srv.extra.append(f"videos/{cover.name}")
                    for _ in range(8):
                        if url_reachable(cover_url):
                            params["cover_url"] = cover_url
                            params.pop("thumb_offset", None)
                            break
                        time.sleep(2)
                    if "cover_url" in params:
                        print(f"🌐 Hostinger: kapak yüklendi {cover.name}", file=sys.stderr, flush=True)
                    else:
                        print(f"  ! kapak dış adresten okunamadı ({cover_url}); Instagram kapağı videonun ilk karesinden alacak", file=sys.stderr, flush=True)
                except Exception as e:
                    print(f"  ! kapak yüklenemedi ({str(e)[:120]}); Instagram kapağı videonun ilk karesinden alacak", file=sys.stderr, flush=True)
            elif not cover.exists():
                print("  ! kapak dosyası yok (-kapak.jpg); Instagram kapağı videonun ilk karesinden alacak", file=sys.stderr, flush=True)
            c = ig_call("POST", f"{uid}/media", params, creds)
            cid = c["id"]
            ledger_set(name, "instagram", state="container", cid=cid)  # konteyner açıldı: yeniden denemede yeni konteyner değil bu kullanılır
        for _ in range(72):  # Instagram videoyu çekip işler; 6 dk'ya kadar bekle
            st = ig_call("GET", cid, {"fields": "status_code,status"}, creds)
            if st.get("status_code") == "FINISHED":
                break
            if st.get("status_code") == "ERROR":
                ledger_set(name, "instagram", state="failed")
                raise RuntimeError(f"Instagram işleme hatası: {st}")
            time.sleep(5)
        else:
            raise RuntimeError("Instagram işleme zaman aşımı")  # defter "container": yeniden denemede aynı konteyner beklenir
        ledger_set(name, "instagram", state="publishing", cid=cid)  # yayın isteği gidiyor: yanıt kaybolursa yeniden denemede konteynerin durumu sorulur
        try:
            pub = ig_call("POST", f"{uid}/media_publish", {"creation_id": cid}, creds, timeout=180)
        except Exception as e:
            # yayın isteği yanıtsız kaldı (zaman aşımı, bağlantı kopması): Instagram yayınlamış olabilir. Konteynerin durumuna ve hesabın son
            # gönderilerine bakılır; gönderi bulunursa o kayda geçer (ikinci kopya yok). Konteyner PUBLISHED ama gönderi listede yoksa yine
            # yayınlanmış sayılır (kimlik sonra tamamlanır). Konteyner hâlâ FINISHED ise istek Instagram'a ulaşmamıştır: bir kez daha
            # yayınlanır. Durum okunamıyorsa hata (defter "publishing": yeniden denemede konteynerin durumu sorulur)
            print(f"  ! Instagram yayın isteği yanıtsız kaldı ({str(e)[:120]}); yayınlanıp yayınlanmadığı denetleniyor", file=sys.stderr, flush=True)
            found, st = None, {}
            for k in range(6):
                time.sleep(10)
                found = ig_find_published(creds, caption, since=since)
                if found:
                    break
                try:
                    st = ig_call("GET", cid, {"fields": "status_code,status"}, creds)
                except Exception:
                    st = {}
                if st.get("status_code") == "FINISHED" and k >= 2:
                    break
            if found:
                pub, recovered = {"id": found["id"]}, True
                print(f"  ! Instagram: gönderi yayınlanmış ({found.get('url') or found['id']}); kayda geçti", file=sys.stderr, flush=True)
            elif st.get("status_code") == "PUBLISHED":
                print("  ! Instagram: konteyner yayınlanmış ama gönderi listede henüz yok; kimlik sonraki yüklemede tamamlanacak (yeniden yüklenmedi)", file=sys.stderr, flush=True)
                pub, recovered = {"id": None, "unresolved": True}, True
            elif st.get("status_code") == "FINISHED":
                print("  ! Instagram: yayın isteği ulaşmamış (konteyner hâlâ hazır); bir kez daha yayınlanıyor", file=sys.stderr, flush=True)
                pub = ig_call("POST", f"{uid}/media_publish", {"creation_id": cid}, creds, timeout=180)
            else:
                raise RuntimeError(f"Instagram yayın isteği yanıtsız kaldı ({str(e)[:120]}); konteyner durumu {st.get('status_code') or 'bilinmiyor'} — "
                                   "yayınlanmış olabilir, yeniden denemede konteynerin durumuna ve aynı açıklamalı gönderiye bakılır") from e
    finally:
        pub_srv.close()
    mid = pub.get("id")
    if not mid:  # yayınlanmış, kimlik henüz yok (ig_resolve_unresolved sonraki yüklemede tamamlar)
        res = {"id": None, "url": None, "publishedAt": now_iso(), "recovered": True, "unresolved": True, "cid": cid, **own}
        ledger_set(name, "instagram", state="done", unresolved=True, publishedAt=res["publishedAt"])
        return res
    ledger_set(name, "instagram", state="done", id=str(mid))  # yayın tamam: bundan sonraki her deneme (kayıt kaybolsa da) atlanır
    try:  # gönderi yayında: bağlantı okunamazsa yayın yine tamamdır (hata yeniden yüklemeye yol açmasın)
        info = ig_call("GET", mid, {"fields": "permalink"}, creds)
    except Exception as e:
        print(f"  ! Instagram gönderi bağlantısı okunamadı ({str(e)[:100]}); yayın tamam", file=sys.stderr, flush=True)
        info = {}
    fc = {}
    text = first_comment_text(episode_meta(name) or {})
    if text:  # ilk yorum (instagram_business_manage_comments izni; eski bağlantıda yeniden bağlamak gerekebilir)
        try:
            fc = {"firstComment": ig_call("POST", f"{mid}/comments", {"message": text}, creds).get("id")}
            print(f"  💬 Instagram ilk yorum: {text[:80]}", file=sys.stderr)
        except Exception as e:
            fc = {"commentError": str(e)[:160]}
            print(f"  ! Instagram ilk yorum yazılamadı: {str(e)[:160]}", file=sys.stderr)
    # owner: yükleyen Instagram hesabının kimliği (silme denetiminde "hesap bizim mi" sorusu buna bakar; ig_exists)
    return {"id": mid, "url": info.get("permalink"), "publishedAt": now_iso(), **own, **fc, **({"recovered": True} if recovered else {})}


def ig_story_publish(paths: list) -> list:
    """Instagram hikâyeleri (media_type STORIES; iş/üretici hesabı): dosyalar sırayla, .jpg görüntü, .mp4 video (≤60 sn, 9:16).
    API hikâyeye bağlantı, anket ya da etiket çıkartması eklemez. Biri düşerse diğerleri sürer. [{file, ok, id | error}]"""
    creds = ig_creds()
    uid = creds[0]
    paths = [Path(x) for x in paths]
    pub, res = _PublicVideo(), []
    try:
        urls = pub.ensure_files(paths)
        for p in paths:
            try:
                key = "image_url" if p.suffix.lower() in (".jpg", ".jpeg") else "video_url"
                cid = ig_call("POST", f"{uid}/media", {"media_type": "STORIES", key: urls[p.name]}, creds)["id"]
                for _ in range(72):
                    st = ig_call("GET", cid, {"fields": "status_code,status"}, creds)
                    if st.get("status_code") == "FINISHED":
                        break
                    if st.get("status_code") == "ERROR":
                        raise RuntimeError(f"Instagram işleme hatası: {st.get('status') or st}")
                    time.sleep(5)
                else:
                    raise RuntimeError("Instagram işleme zaman aşımı")
                mid = ig_call("POST", f"{uid}/media_publish", {"creation_id": cid}, creds)["id"]
                res.append({"file": p.name, "ok": True, "id": mid})
            except Exception as e:
                res.append({"file": p.name, "ok": False, "error": str(e)[:200]})
    finally:
        pub.close()
    return res


LAST_ERR = DATA / "publish_last_error.json"  # {platform: {at, video, error}} — panel kartında gösterilir


def ig_diagnose() -> list:
    """Instagram yayın zincirini adım adım sınar: bağlantı → hesap türü → yayın kotası → videonun dış adresi
    (Meta'nın tarayıcısı gibi) → son hata. Her adım {step, ok, detail}."""
    steps = []

    def add(step, ok, detail=""):
        steps.append({"step": step, "ok": ok, "detail": detail})
        return ok
    try:
        creds = ig_creds()
    except Exception as e:
        add("Instagram bağlantısı", False, str(e)); return steps
    uid = creds[0]
    add("Instagram bağlantısı", True, "token var")
    try:
        # Facebook girişinde (graph.facebook.com) ve bazı hesap düğümlerinde account_type alanı yoktur ("nonexisting
        # field"); o zaman yalnız kullanıcı adı sorulur. Facebook Sayfasına bağlı hesap zaten profesyoneldir.
        try:
            me = ig_call("GET", uid, {"fields": "username" if creds[2] == FB_API else "username,account_type"}, creds)
        except Exception as e:
            if "nonexisting field" not in str(e):
                raise
            me = ig_call("GET", uid, {"fields": "username"}, creds)
        at = (me.get("account_type") or "").upper()
        add("Oturum geçerli", True, f"@{me.get('username')}")
        if at and at not in ("BUSINESS", "MEDIA_CREATOR"):
            add("Hesap türü", False, f"{at}: Reels yayını için Profesyonel hesap (İşletme ya da İçerik üretici) gerekir — Instagram → Ayarlar → Hesap türü")
        else:
            add("Hesap türü", True, at or "bilinmiyor (Facebook bağlantısı)")
    except Exception as e:
        add("Oturum geçerli", False, str(e) + ig_hint(str(e))); return steps
    try:
        lim = ig_call("GET", f"{uid}/content_publishing_limit", {"fields": "quota_usage,config"}, creds).get("data", [{}])[0]
        used, total = lim.get("quota_usage", 0), (lim.get("config") or {}).get("quota_total", 50)
        add("Günlük yayın hakkı", used < total, f"{used}/{total} kullanıldı")
    except Exception as e:
        add("Günlük yayın hakkı", True, f"sorgulanamadı ({str(e)[:80]}) — yayını engellemez")
    vids = sorted(OUT.glob("*.mp4"), key=lambda p: p.stat().st_mtime, reverse=True)
    if vids:
        pub = _PublicVideo()
        try:
            base = pub.ensure(vids[0].name)
            url = base + "/videos/" + urllib.parse.quote(vids[0].name)
            # Meta videoyu kendi tarayıcısıyla (facebookexternalhit) çeker; güvenlik duvarı onu engelliyorsa yayın düşer
            req = urllib.request.Request(url, headers={"User-Agent": "facebookexternalhit/1.1", "Range": "bytes=0-1023"})
            try:
                with urllib.request.urlopen(req, timeout=20) as r:
                    ctype, code = r.headers.get("Content-Type", ""), r.status
                ok = code in (200, 206) and "video" in ctype
                add("Video dış adresten açılıyor (Meta gibi)", ok, f"{url} → HTTP {code}, {ctype or 'türü yok'}"
                    + ("" if ok else " — Content-Type video/mp4 olmalı; Hostinger güvenlik/bot korumasını videos/ için kapatın"))
            except urllib.error.HTTPError as e:
                add("Video dış adresten açılıyor (Meta gibi)", False, f"{url} → HTTP {e.code}: Hostinger Meta'nın tarayıcısını engelliyor olabilir (hPanel → Güvenlik / bot koruması)")
        except Exception as e:
            add("Video dış adrese yükleniyor", False, str(e))
        finally:
            pub.close()
    else:
        add("Video dış adresten açılıyor", True, "denenecek video yok")
    last = (load_json(LAST_ERR, {}) or {}).get("instagram")
    if last:
        add("Son yayın hatası", False, f"{last.get('at', '')[:16]} · {last.get('video')}: {last.get('error')}")
    return steps


def ig_hint(msg: str) -> str:
    """Instagram hatalarına ne yapılacağını ekler (panel sohbetinde görünür)."""
    m = msg.lower()
    if "bağlı değil" in m:
        return ""
    if "media" in m and ("url" in m or "download" in m or "fetch" in m or "2207026" in m or "2207003" in m):
        return " → Instagram videoyu adresinden çekemedi: Ayarlar → Hostinger köprüsü → \"Köprüyü kur / sına\" ile videos/ adresinin açıldığını doğrulayın."
    if "session has expired" in m or "access token" in m or "oauth" in m or "190" in m:
        return " → Instagram bağlantısının süresi dolmuş: Ayarlar → Instagram'ı yeniden bağlayın."
    if "permission" in m or "not authorized" in m or "(#10)" in m or "(#200)" in m:
        return " → İzin yok: Meta uygulamasında instagram_business_content_publish izni ve hesabın Instagram Testers'ta kabul edilmiş olması gerekir; sonra yeniden bağlayın."
    if "aspect ratio" in m or "duration" in m or "2207" in m:
        return " → Instagram video biçimini kabul etmedi (Reels: dikey 9:16, 3-90 sn)."
    if "zaman aşımı" in m:
        return " → Instagram işlemeyi 6 dakikada bitirmedi; bir süre sonra tekrar deneyin (çoğu zaman ikinci deneme geçer)."
    return ""


def ig_connect():
    """Tarayıcıda Instagram girişi (Instagram API with Instagram Login). Geri dönüş HTTPS olmak zorunda;
    panel tüneli /instagram/callback'i yerel :3138'e aktarır. Kısa ömürlü kod → 60 günlük token."""
    import http.server
    import secrets as _secrets
    import threading
    import webbrowser
    env = load_env()
    for k in ("IG_APP_ID", "IG_APP_SECRET"):
        if not env.get(k):
            raise RuntimeError(f"secrets/.env içinde {k} eksik (bkz. secrets/README.md)")
    use_host = hostinger.configured() and not env.get("IG_REDIRECT_URI")
    if use_host:
        redirect = hostinger.site_url() + "/instagram/callback/"  # sabit adres, Meta'ya bir kez yazılır
    else:
        redirect = env.get("IG_REDIRECT_URI") or ((env.get("PUBLIC_BASE_URL") or "").rstrip("/") + "/instagram/callback")
    if not redirect.startswith("https://"):
        raise RuntimeError("Instagram geri dönüş adresi HTTPS olmalı: Hostinger köprüsünü kurun (scripts/hostinger.py --setup) ya da tüneli başlatın")
    state = _secrets.token_urlsafe(16)
    got = {}

    class H(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            got.update({k: v[0] for k, v in q.items()})
            self.send_response(200); self.send_header("Content-Type", "text/html; charset=utf-8"); self.end_headers()
            self.wfile.write("<h2>Instagram bağlandı. Bu pencereyi kapatıp panele dönebilirsiniz.</h2>".encode())

        def log_message(self, *a):
            pass

    srv = None
    if not use_host:
        http.server.HTTPServer.allow_reuse_address = True
        try:
            srv = http.server.HTTPServer(("127.0.0.1", IG_CALLBACK_PORT), H)
        except OSError as e:
            raise RuntimeError(f"Geri dönüş portu {IG_CALLBACK_PORT} açılamadı ({e}); önceki bağlanma denemesi hâlâ sürüyor olabilir, 1 dk bekleyip tekrar deneyin")
        threading.Thread(target=srv.serve_forever, daemon=True).start()
    via = (env.get("IG_LOGIN") or "instagram").lower()  # instagram: Instagram Login (sayfa gerekmez) | facebook: Facebook Login (Facebook Sayfası + bağlı Instagram)
    if via == "facebook":
        # auth_type=rerequest: daha önce atlanan sayfa/izin seçimini yeniden sorar
        params = {"client_id": env["IG_APP_ID"], "redirect_uri": redirect, "response_type": "code", "state": state, "auth_type": "rerequest"}
        if env.get("IG_CONFIG_ID"):  # Facebook Login for Business "Configuration" kimliği: izinler yapılandırmadan gelir
            params["config_id"] = env["IG_CONFIG_ID"]
        else:
            params["scope"] = ",".join(x for x in (FB_SCOPES + "," + (env.get("IG_EXTRA_SCOPES") or "")).split(",") if x)
        url = "https://www.facebook.com/v21.0/dialog/oauth?" + urllib.parse.urlencode(params)
    else:
        url = "https://www.instagram.com/oauth/authorize?" + urllib.parse.urlencode({
            "client_id": env["IG_APP_ID"], "redirect_uri": redirect, "response_type": "code", "scope": IG_SCOPES, "state": state, "force_reauth": "true"})
    print(f"AUTH_URL {url}", file=sys.stderr, flush=True)
    try:
        webbrowser.open(url)
    except Exception:
        pass
    if use_host:
        got.update(hostinger.poll_code(redirect, state, 300))
    else:
        for _ in range(600):  # 5 dk
            if "code" in got or "error" in got:
                break
            time.sleep(0.5)
        srv.shutdown()
    if got.get("error"):
        raise RuntimeError(f"Instagram reddetti: {got.get('error_description') or got.get('error_reason') or got['error']}")
    if got.get("state") != state or "code" not in got:
        raise RuntimeError("Instagram geri dönüşü alınamadı (redirect URI uygulamada aynen kayıtlı mı?)")
    code = got["code"].split("#")[0]
    if via == "facebook":
        return fb_finish(env, redirect, code)
    form = urllib.parse.urlencode({"client_id": env["IG_APP_ID"], "client_secret": env["IG_APP_SECRET"], "grant_type": "authorization_code",
                                   "redirect_uri": redirect, "code": code}).encode()
    short = ig_http("https://api.instagram.com/oauth/access_token", form)
    if "access_token" not in short:
        raise RuntimeError(f"Instagram token alınamadı: {short}")
    q = urllib.parse.urlencode({"grant_type": "ig_exchange_token", "client_secret": env["IG_APP_SECRET"], "access_token": short["access_token"]})
    long_tok = ig_http(f"https://graph.instagram.com/access_token?{q}")
    token = long_tok.get("access_token", short["access_token"])
    me = ig_http(f"{IG_API}/me?" + urllib.parse.urlencode({"fields": "user_id,username,account_type", "access_token": token}))
    tok = {"access_token": token, "expires_in": long_tok.get("expires_in", 5184000), "obtained_at": time.time(),
           "user_id": str(me.get("user_id") or short.get("user_id") or "me"), "username": me.get("username"), "account_type": me.get("account_type"),
           "permissions": short.get("permissions")}
    IG_TOKEN_FILE.write_text(json.dumps(tok, indent=2))
    return tok


# ---------------- TikTok (Content Posting API + Login Kit)
TT_AUTH = "https://www.tiktok.com/v2/auth/authorize/"
TT_API = "https://open.tiktokapis.com/v2"
# İzinler tt_scopes()'ta: user.info.stats takipçi sayısı (scripts/followers.py), video.publish yalnız doğrudan yayında
TT_TOKEN_FILE = SECRETS / "tiktok_token.json"


def tt_http(method, url, data=None, headers=None, raw=False):
    body = data if raw else (json.dumps(data).encode() if data is not None else None)
    req = urllib.request.Request(url, data=body, method=method, headers=headers or {})
    if not raw and data is not None:
        req.add_header("Content-Type", "application/json; charset=UTF-8")
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            txt = r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        txt = e.read().decode("utf-8", "replace")
        raise RuntimeError(f"TikTok HTTP {e.code}: {txt[:400]}")
    return json.loads(txt) if txt.strip().startswith("{") else {}


def tt_token_request(env, form):
    data = urllib.parse.urlencode({"client_key": env["TIKTOK_CLIENT_KEY"], "client_secret": env["TIKTOK_CLIENT_SECRET"], **form}).encode()
    req = urllib.request.Request(f"{TT_API}/oauth/token/", data=data, method="POST",
                                 headers={"Content-Type": "application/x-www-form-urlencoded"})
    with urllib.request.urlopen(req, timeout=60) as r:
        tok = json.loads(r.read())
    if "access_token" not in tok:
        raise RuntimeError(f"TikTok token alınamadı: {tok}")
    tok["obtained_at"] = time.time()
    TT_TOKEN_FILE.write_text(json.dumps(tok, indent=2))
    return tok


def tt_access_token():
    env = load_env()
    for k in ("TIKTOK_CLIENT_KEY", "TIKTOK_CLIENT_SECRET"):
        if not env.get(k):
            raise RuntimeError(f"secrets/.env içinde {k} eksik (bkz. secrets/README.md)")
    if not TT_TOKEN_FILE.exists():
        raise RuntimeError("TikTok bağlı değil. Önce: python3 scripts/publish.py --connect tiktok")
    tok = json.loads(TT_TOKEN_FILE.read_text())
    if time.time() - tok.get("obtained_at", 0) > tok.get("expires_in", 86400) - 300:
        tok = tt_token_request(env, {"grant_type": "refresh_token", "refresh_token": tok["refresh_token"]})
    return tok["access_token"]


def tt_scopes(env=None) -> str:
    """İstenen izinler: TIKTOK_SCOPES ile elle verilebilir. video.publish yalnız doğrudan yayında istenir (gelen kutusu
    modunda gereksiz ve uygulamada açık değilse girişi bozar); user.info.stats takipçi sayısı içindir."""
    env = env or load_env()
    if env.get("TIKTOK_SCOPES"):
        return env["TIKTOK_SCOPES"]
    sc = ["user.info.basic", "user.info.stats", "video.list", "video.upload"]
    if (env.get("TIKTOK_MODE") or "inbox").lower() == "direct":
        sc.append("video.publish")
    return ",".join(sc)


def tt_redirect(env=None) -> str:
    """Geri dönüş adresi. TikTok web girişi HTTPS ister (localhost kabul etmez): TIKTOK_REDIRECT_URI verilmemişse
    Hostinger köprüsü (https://site/tiktok/callback/), o da yoksa yerel adres (yalnız masaüstü uygulamada çalışır)."""
    env = env or load_env()
    custom = env.get("TIKTOK_REDIRECT_URI", "")
    # eski talimattaki localhost adresi Hostinger varken yok sayılır (TikTok web girişi onu kabul etmez)
    if custom and not (hostinger.configured() and "localhost" in custom):
        return custom
    if hostinger.configured():
        return hostinger.site_url() + "/tiktok/callback/"
    return "http://localhost:3137/tiktok/callback"


def tt_disconnect():
    env = load_env()
    if not TT_TOKEN_FILE.exists():
        return False
    try:
        tok = json.loads(TT_TOKEN_FILE.read_text())
        form = urllib.parse.urlencode({"client_key": env.get("TIKTOK_CLIENT_KEY", ""), "client_secret": env.get("TIKTOK_CLIENT_SECRET", ""),
                                       "token": tok.get("access_token", "")}).encode()
        urllib.request.urlopen(urllib.request.Request(f"{TT_API}/oauth/revoke/", data=form, headers={"Content-Type": "application/x-www-form-urlencoded"}), timeout=15)
    except Exception as e:
        print(f"  ! TikTok izni geri alınamadı (token yine de silindi): {e}", file=sys.stderr)
    TT_TOKEN_FILE.unlink()
    return True


def tt_connect():
    """Tarayıcıda TikTok girişi. Geri dönüş Hostinger köprüsündeyse kod oradan yoklanır, yerel adresse yerel sunucu yakalar."""
    import http.server
    import secrets as _secrets
    import threading
    import webbrowser
    env = load_env()
    for k in ("TIKTOK_CLIENT_KEY", "TIKTOK_CLIENT_SECRET"):
        if not env.get(k):
            raise RuntimeError(f"secrets/.env içinde {k} eksik (bkz. secrets/README.md)")
    redirect = tt_redirect(env)
    use_host = hostinger.configured() and redirect.startswith(hostinger.site_url() + "/tiktok/callback")
    state = _secrets.token_urlsafe(16)
    got = {}

    class H(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            got.update({k: v[0] for k, v in q.items()})
            self.send_response(200); self.send_header("Content-Type", "text/html; charset=utf-8"); self.end_headers()
            self.wfile.write("<h2>TikTok bağlandı. Bu pencereyi kapatabilirsiniz.</h2>".encode())
        def log_message(self, *a):  # sessiz
            pass

    srv = None
    if not use_host:
        port = int(urllib.parse.urlparse(redirect).port or 3137)
        srv = http.server.HTTPServer(("0.0.0.0", port), H)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
    url = TT_AUTH + "?" + urllib.parse.urlencode({"client_key": env["TIKTOK_CLIENT_KEY"], "scope": tt_scopes(env), "response_type": "code",
                                                  "redirect_uri": redirect, "state": state})
    print(f"Tarayıcıda açılıyor: {url}", file=sys.stderr)
    print(f"TT_REDIRECT {redirect}", file=sys.stderr, flush=True)  # panel loga yazar (Login Kit'teki adresle karşılaştırma)
    webbrowser.open(url)
    if use_host:
        got.update(hostinger.poll_code(redirect, state, 300))
    else:
        for _ in range(600):  # 5 dk bekle
            if "code" in got or "error" in got:
                break
            time.sleep(0.5)
        srv.shutdown()
    if got.get("error"):
        err = got.get("error_description") or got["error"]
        hint = ""
        if "sandbox" in str(err).lower():
            hint = " — giriş yapılan TikTok hesabı Sandbox → Target users listesinde değil: oraya ekleyin (aynı hesapla giriş yapın)"
        elif "scope" in str(err).lower():
            hint = f" — uygulamada şu izinler açık olmalı: {tt_scopes(env)} (developers.tiktok.com → uygulama → Scopes)"
        elif "redirect" in str(err).lower() or "redirect_uri" in str(got):
            hint = f" — Login Kit → Redirect URI olarak AYNEN şunu yazın: {redirect}"
        raise RuntimeError(f"TikTok reddetti: {err}{hint}")
    if got.get("state") != state or "code" not in got:
        raise RuntimeError("TikTok geri dönüşü alınamadı (5 dk içinde onay gelmedi). TikTok sayfasında hata kodu gördüyseniz: "
                           "non_sandbox_target → hesabınızı Sandbox → Target users'a ekleyin; redirect_uri → Login Kit → Redirect URI "
                           f"AYNEN şu olmalı: {redirect}; scope → Scopes'ta şunlar açık olmalı: {tt_scopes(env)}")
    tt_token_request(env, {"grant_type": "authorization_code", "code": got["code"], "redirect_uri": redirect})


def tt_upload(path: Path):
    """mode=inbox: TikTok gelen kutusuna taslak (onaysız uygulamada da çalışır, telefondan yayınlanır).
    mode=direct: doğrudan yayın (uygulama TikTok denetiminden geçmişse herkese açık, geçmemişse yalnızca-ben)."""
    env = load_env()
    mode = (env.get("TIKTOK_MODE") or "inbox").lower()
    token = tt_access_token()
    H = {"Authorization": f"Bearer {token}"}
    size = path.stat().st_size
    chunk = size if size <= 64 * 1024 * 1024 else 10 * 1024 * 1024
    total = -(-size // chunk)
    source = {"source": "FILE_UPLOAD", "video_size": size, "chunk_size": chunk, "total_chunk_count": total}
    title, _ = build_caption(path.name, max_len=150)
    title = title.replace(" #Shorts", "")
    for t in caption_tags(path.name):  # TikTok'ta hashtag başlığın içinde olur
        if len(title) + len(t) + 1 > 150:
            break
        title += " " + t
    if mode == "direct":
        info = tt_http("POST", f"{TT_API}/post/publish/creator_info/query/", {}, H).get("data", {})
        opts = info.get("privacy_level_options") or ["SELF_ONLY"]
        privacy = "PUBLIC_TO_EVERYONE" if "PUBLIC_TO_EVERYONE" in opts else opts[0]
        post = {"title": title[:150], "privacy_level": privacy, "disable_duet": False, "disable_comment": False, "disable_stitch": False,
                "video_cover_timestamp_ms": 0}  # videonun ilk karesi = kapak
        if (episode_meta(path.name) or {}).get("aiVisuals"):  # gerçekçi yapay zekâ fotoğrafları: TikTok'un "yapay zekâ ile üretildi" etiketi
            post["is_aigc"] = True
        try:
            init = tt_http("POST", f"{TT_API}/post/publish/video/init/", {"post_info": post, "source_info": source}, H)
        except RuntimeError as e:  # alanı tanımayan uygulama sürümü: etiketsiz bir kez (açıklamadaki satır yine durur)
            if not post.pop("is_aigc", None) or "invalid_param" not in str(e):
                raise
            print(f"  ! TikTok yapay zekâ etiketini kabul etmedi ({str(e)[:120]}); etiketsiz yükleniyor", file=sys.stderr, flush=True)
            init = tt_http("POST", f"{TT_API}/post/publish/video/init/", {"post_info": post, "source_info": source}, H)
        if post.get("is_aigc") and init.get("error", {}).get("code") in ("invalid_params", "invalid_param"):
            print(f"  ! TikTok yapay zekâ etiketini kabul etmedi ({init['error']}); etiketsiz yükleniyor", file=sys.stderr, flush=True)
            post.pop("is_aigc", None)
            init = tt_http("POST", f"{TT_API}/post/publish/video/init/", {"post_info": post, "source_info": source}, H)
    else:
        privacy = None
        try:
            init = tt_http("POST", f"{TT_API}/post/publish/inbox/video/init/", {"source_info": source}, H)
        except RuntimeError as e:
            reason = next((r for r in TT_LIMIT_REASONS if r in str(e)), None)
            if reason:
                raise LimitReached(reason) from e
            raise
    code = init.get("error", {}).get("code")
    if code in TT_LIMIT_REASONS:
        raise LimitReached(code)
    if code not in (None, "ok"):
        raise RuntimeError(f"TikTok init hatası: {init['error']}")
    data = init["data"]
    publish_id, upload_url = data["publish_id"], data["upload_url"]
    with open(path, "rb") as f:
        for i in range(total):
            start = i * chunk
            blob = f.read(chunk)
            end = start + len(blob) - 1
            tt_http("PUT", upload_url, blob, {"Content-Type": "video/mp4", "Content-Length": str(len(blob)),
                                             "Content-Range": f"bytes {start}-{end}/{size}"}, raw=True)
    status = None
    for _ in range(60):
        st = tt_http("POST", f"{TT_API}/post/publish/status/fetch/", {"publish_id": publish_id}, H).get("data", {})
        status = st.get("status")
        if status in ("PUBLISH_COMPLETE", "SEND_TO_USER_INBOX", "FAILED"):
            break
        time.sleep(5)
    if status == "FAILED":
        raise RuntimeError(f"TikTok işleme hatası: {st.get('fail_reason')}")
    print(f"  ♪ TikTok durumu: {status} — {TT_STATUS_TR.get(status, status)}", file=sys.stderr)
    post_ids = st.get("publicaly_available_post_id") or []
    return {"id": post_ids[0] if post_ids else publish_id, "publish_id": publish_id, "mode": mode, "privacy": privacy,
            "status": status, "url": f"https://www.tiktok.com/@me/video/{post_ids[0]}" if post_ids else None,
            "publishedAt": now_iso(), "title": title,
            "note": (TT_STATUS_TR.get(status) or f"TikTok hâlâ işliyor (durum: {status}); panelden 'Son gönderimleri kontrol et'")
                    if mode != "direct" else None}


# TikTok gönderim durumları (post/publish/status/fetch)
TT_STATUS_TR = {
    "PROCESSING_UPLOAD": "TikTok videoyu alıyor/işliyor (birkaç dakika sürebilir)",
    "PROCESSING_DOWNLOAD": "TikTok videoyu indiriyor/işliyor",
    "SEND_TO_USER_INBOX": "gelen kutusuna gönderildi: TikTok uygulaması → Gelen kutusu → bildirime dokunup yayınlayın",
    "PUBLISH_COMPLETE": "yayınlandı",
    "FAILED": "başarısız",
}


def tt_check(limit=5) -> list:
    """Son TikTok gönderimlerinin durumunu TikTok'tan sorar, metriklere yazar."""
    token = tt_access_token()
    H = {"Authorization": f"Bearer {token}"}
    m = metrics()
    items = [(n, v["tiktok"]) for n, v in m["videos"].items() if (v.get("tiktok") or {}).get("publish_id")]
    items.sort(key=lambda x: x[1].get("publishedAt", ""), reverse=True)
    out = []
    for name, t in items[:limit]:
        try:
            st = tt_http("POST", f"{TT_API}/post/publish/status/fetch/", {"publish_id": t["publish_id"]}, H)
            d, err = st.get("data", {}), st.get("error", {})
            status = d.get("status") or (err.get("code") if err.get("code") not in (None, "ok") else "?")
            t["status"] = status
            if d.get("fail_reason"):
                t["failReason"] = d["fail_reason"]
            out.append({"video": name, "status": status, "text": TT_STATUS_TR.get(status, status) + (f" ({d['fail_reason']})" if d.get("fail_reason") else ""),
                        "at": t.get("publishedAt")})
        except Exception as e:
            out.append({"video": name, "status": "?", "text": f"sorgulanamadı: {str(e)[:150]}", "at": t.get("publishedAt")})
    save_metrics(m)
    return out


# ---------------- platformlardan silme (panel "Sil", Instagram temizliği)
# Meta gönderi silmeyi (DELETE /{media-id}) yalnız "Instagram API with Facebook Login" için belgeliyor (graph.facebook.com,
# instagram_manage_contents izni). Instagram Login (graph.instagram.com, instagram_business_* izinleri) silmeyi desteklemez: API
# reddeder, gönderi Instagram uygulamasından elle silinir. DELETE hata metnine tek başına güvenilmez: Meta'nın genel yanıtı
# "Unsupported delete request. Object with ID … does not exist, cannot be loaded due to missing permissions, or does not support
# this operation" (kod 100, alt kod 33) var olan gönderide de gelir; gönderinin gerçekten olup olmadığı ig_exists ile sınanır.
IG_VIA_TR = {"instagram": "Instagram Girişi", "facebook": "Facebook Girişi", "env": "Facebook Girişi"}
IG_TOKEN_CODES = {190, 102, 463, 467}                              # token süresi dolmuş ya da geçersiz: yeniden bağlanmak gerekir
IG_RETRY_CODES = {1, 2, 4, 17, 32, 341, 368, 613, 80001, 80002}    # geçici hata, istek sınırı, geçici engel (368)
IG_RETRY_STATUS = {408, 409, 425, 429}                             # bunlar, 5xx ve ağ hatası: sonra yeniden denenir
IG_RETRY_RE = re.compile(r"temporar|try again|too fast|too many|please wait|rate limit|request limit", re.I)
IG_DENY_CODES = {3, 10, 100}                                       # yetenek/izin yok, desteklenmeyen istek (200-299 izin kodları da)
IG_DENY_RE = re.compile(r"permission|not supported|unsupported|does not support|not allowed|capability|cannot be loaded", re.I)
IG_MISSING_RE = re.compile(r"does not exist|not available|not found", re.I)
IG_THROTTLE_CODES = {4, 17, 32, 341, 368, 613, 80001, 80002}       # istek sınırı / geçici engel: o çalışmada başka istek atılmaz
IG_THROTTLE_RE = re.compile(r"temporar\w* block|limit reached|rate limit|request limit|too many|too fast|please wait", re.I)
IG_LATER = "daha sonra yeniden deneyin ya da Instagram uygulamasından elle silin"
IG_ACCOUNT_PAGES = 6  # kontrol listesi en çok 6 sayfa (300 gönderi) okunur; süreçte bir kez, yalnız gerektikçe uzatılır
_IG_CTL = {}  # bu süreçteki kontrol çağrısı (API kökü + token → hesabın gönderi listesi ya da None): her gönderide yeniden sorulmaz


def _graph(method: str, url: str, timeout=30):
    """Graph isteği; HTTP hatası istisna olmaz: (HTTP durumu, gövde sözlüğü). Ağ hatasında durum None. 2xx dışındaki her yanıtta
    gövdede error olur; JSON olmayan gövde (vekil/giriş sayfası, boş 3xx) raw işaretlidir: Graph'ın kendi yanıtı sayılmaz."""
    try:
        with urllib.request.urlopen(urllib.request.Request(url, method=method), timeout=timeout) as r:
            st, txt = r.status, r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        st, txt = e.code, e.read().decode("utf-8", "replace")
    except Exception as e:
        return None, {"error": {"message": f"bağlantı hatası: {str(e)[:160]}", "raw": True}}
    ok = 200 <= st < 300
    try:
        body = json.loads(txt) if txt.strip() else {}
    except Exception:
        body = None
    if body is True and ok:  # eski Graph sürümleri DELETE'e düz true döner
        body = {"success": True}
    if not isinstance(body, dict):
        body = {} if ok else {"error": {"message": re.sub(r"\s+", " ", txt).strip()[:200] or f"HTTP {st}", "raw": True}}
    elif not ok and not isinstance(body.get("error"), dict):
        body = {**body, "error": {"message": str(body.get("error") or re.sub(r"\s+", " ", txt).strip()[:200] or f"HTTP {st}"), "raw": True}}
    return st, body


def graph_error(st, body: dict) -> dict | None:
    """Graph yanıtındaki hata → {status, code, subcode, message, transient, raw}; yalnız 2xx ve hatasız yanıtta None."""
    e = body.get("error")
    if st is not None and 200 <= st < 300 and not e and body.get("success") is not False:
        return None
    e = e if isinstance(e, dict) else {"message": str(e or "işlem başarısız")}

    def num(x):
        try:
            return int(x)
        except (TypeError, ValueError):
            return None
    return {"status": st, "code": num(e.get("code")), "subcode": num(e.get("error_subcode")),
            "message": str(e.get("message") or "")[:240], "transient": bool(e.get("is_transient")), "raw": bool(e.get("raw"))}


def graph_reason(err: dict | None) -> str:
    """Kısa neden: "HTTP 400, kod 10: Application does not have permission for this action"."""
    if not err:
        return ""
    head = ", ".join(x for x in (f"HTTP {err['status']}" if err.get("status") else "",
                                 f"kod {err['code']}" + (f"/{err['subcode']}" if err.get("subcode") else "") if err.get("code") is not None else "") if x)
    return (head + ": " if head else "") + (err.get("message") or "")[:160]


def _token_err(err) -> bool:
    return err.get("code") in IG_TOKEN_CODES


def _retry_err(err) -> bool:
    st = err.get("status")
    return bool(st is None or st in IG_RETRY_STATUS or st >= 500 or err.get("code") in IG_RETRY_CODES or err.get("transient")
                or IG_RETRY_RE.search(err.get("message") or ""))


def _throttle_err(err) -> bool:
    """İstek sınırı ya da geçici engel (HTTP 429, kod 4/17/32/341/368/613/80001/80002, "temporarily blocked", "limit reached"…):
    aynı hesabın bütçesi yüklemelerle ortak, sınırlanmışken başka istek atılmaz."""
    return bool(err.get("status") == 429 or err.get("code") in IG_THROTTLE_CODES or IG_THROTTLE_RE.search(err.get("message") or ""))


def ig_halt(err) -> str | None:
    """Hesabın tamamını etkileyen hata: "token" (bağlantı geçersiz), "throttled" (istek sınırı/geçici engel), "offline" (ağ hatası).
    ig_cleanup.run bu durumda çalışmayı durdurur, kalan videoları denemeden "silinemedi" sayar (ağ hatasında ancak art arda ikincisinde)."""
    if not err:
        return None
    if _token_err(err):
        return "token"
    if _throttle_err(err):
        return "throttled"
    return "offline" if err.get("status") is None else None


def _deny_err(err) -> bool:
    """API bu isteğe izin vermiyor/desteklemiyor: yalnız Graph'ın kendi JSON hatası (vekil sayfası değil) ve yalnız izin/destek kodu
    (3, 10, 100, 200-299) ya da izin/destek sözü. Graph hemen her hatayı HTTP 400 ile verir: durum kodu tek başına "izin yok" değildir
    (sınıflanamayan kod — ör. 2500 — retry)."""
    c = err.get("code")
    return not err.get("raw") and (c in IG_DENY_CODES or (c is not None and 200 <= c < 300)
                                   or bool(IG_DENY_RE.search(err.get("message") or "")))


def _missing_err(err) -> bool:
    """Graph'ın "nesne yok" yanıtı (kod 100, alt kod 33 ya da "does not exist"); çıplak 404 ve HTML sayılmaz."""
    return not err.get("raw") and err.get("code") == 100 and (err.get("subcode") == 33 or bool(IG_MISSING_RE.search(err.get("message") or "")))


def _ig_page(creds, acc: dict | None) -> dict | None:
    """Kontrol listesinin bir sayfası (50 gönderi, en yeniden): acc None ise ilk sayfa (okunamazsa None), değilse acc["after"]
    imleciyle sonraki sayfa acc'ye eklenir (okunamazsa ya da yeni kimlik gelmezse liste orada biter)."""
    uid, token, base = creds
    owner = "me" if base == IG_API else uid
    q = {"fields": "id", "limit": 50, "access_token": token, **({"after": acc["after"]} if acc else {})}
    st, body = _graph("GET", f"{base}/{owner}/media?" + urllib.parse.urlencode(q))
    data = None if graph_error(st, body) else body.get("data")
    if not isinstance(data, list):
        if acc:
            acc["after"] = None
        return acc
    ids = {str(x["id"]) for x in data if isinstance(x, dict) and x.get("id")}
    acc = acc or {"media": set(), "pages": 0, "after": None}
    new = ids - acc["media"]
    acc["media"] |= ids
    acc["pages"] += 1
    pg = body.get("paging") if isinstance(body.get("paging"), dict) else {}
    cur = (pg.get("cursors") or {}).get("after") if isinstance(pg.get("cursors"), dict) else None
    acc["after"] = str(cur) if pg.get("next") and cur and new else None
    return acc


def _ig_account(creds, need=None) -> dict | None:
    """Kontrol çağrısı: bu token'la hesabın gönderi listesi (Instagram Login `/me/media`, Facebook Login `/{hesap}/media`; süreçte
    bir kez okunur). need(kimlikler) verilirse ve sağlanmıyorsa liste sonraki sayfalarla uzatılır (en çok IG_ACCOUNT_PAGES sayfa,
    süreç boyunca ortak). {media: kimlikler, pages, after} ya da None (ilk sayfa okunamadı)."""
    key = (creds[2], creds[1])
    if key not in _IG_CTL:
        _IG_CTL[key] = _ig_page(creds, None)
    acc = _IG_CTL[key]
    while acc and need and not need(acc["media"]) and acc.get("after") and acc["pages"] < IG_ACCOUNT_PAGES:
        _ig_page(creds, acc)
    return acc


def _ts(v):
    """ISO zaman → saat dilimli datetime (dilimsiz UTC sayılır) ya da None."""
    try:
        d = datetime.fromisoformat(str(v).replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)


def _ig_records() -> dict:
    """Metriklerdeki Instagram kayıtlarımız: {kimlik: {owner (yükleyen hesap; eski kayıtta None), at (yayın anı)}}."""
    out = {}
    for v in (metrics().get("videos") or {}).values():
        g = v.get("instagram") if isinstance(v, dict) else None
        if isinstance(g, dict) and g.get("id"):
            out[str(g["id"])] = {"owner": str(g["owner"]) if g.get("owner") else None, "at": _ts(g.get("publishedAt"))}
    return out


def ig_conn() -> dict:
    """Bağlantı kimliği (ağ çağrısı yok): via instagram|facebook|env, tokenAt (token alınma anı; .env yolunda token'ın kısa özeti),
    name (Instagram Girişi / Facebook Girişi). Silme desteği kaydı bağlantı değişince geçersiz olur (ig_cleanup.py)."""
    if IG_TOKEN_FILE.exists():
        tok = load_json(IG_TOKEN_FILE, {}) or {}
        via = "facebook" if tok.get("via") == "facebook" else "instagram"
        return {"via": via, "tokenAt": tok.get("obtained_at"), "name": IG_VIA_TR[via]}
    env = load_env()
    if env.get("IG_USER_ID") and env.get("IG_ACCESS_TOKEN"):
        return {"via": "env", "tokenAt": "env:" + hashlib.sha256(env["IG_ACCESS_TOKEN"].encode()).hexdigest()[:12], "name": IG_VIA_TR["env"]}
    return {"via": None, "tokenAt": None, "name": None}


def ig_exists(ig: dict, creds=None, why: dict | None = None) -> bool | None:
    """Gönderi Instagram'da hâlâ var mı: True / False / None (bilinmiyor). GET /{id}?fields=id: kimlikli 2xx → True. Graph'ın
    "yok" yanıtı (kod 100 + alt kod 33 ya da "does not exist") başka hesabın gönderisinde de gelir; yalnız kontrol çağrısı (aynı
    token'la hesabın gönderi listesi) token'ın gönderiyi YÜKLEYEN hesaba ait olduğunu gösterirse False (gönderi listedeyse True):
    listede aynı hesabın yüklediği başka kaydımız olmalı — kayıtta yükleyen hesap (owner) varsa aynı owner'lı kayıt, owner'sız eski
    kayıtta bu gönderiden önce (ya da aynı anda) yayınlanmış kayıt (hesap değişince listede yalnız sonraki yüklemeler olur; tek bir
    yeni yükleme eski hesabın gönderilerini "yok" yaptırmasın). Liste gerektikçe sonraki sayfalarla uzar (_ig_account). Token, izin,
    ağ sorunu, çıplak 404/HTML, başka hesap, okunamayan liste ve başka her yanıt None; None hiçbir zaman "silinmiş" sayılmaz.
    why sözlüğü verilirse GET'in Graph hatası why["err"]e yazılır (istek sınırı/bağlantı sorununu görmek için)."""
    try:
        uid, token, base = creds or ig_creds()
    except Exception:
        return None
    tid = str(ig["id"])
    st, body = _graph("GET", f"{base}/{tid}?" + urllib.parse.urlencode({"fields": "id", "access_token": token}))
    err = graph_error(st, body)
    if why is not None:
        why["err"] = err
    if not err:
        return True if body.get("id") else None
    if _token_err(err) or not _missing_err(err):
        return None
    rec = _ig_records()
    mine = rec.get(tid) or {}
    owner = str(ig.get("owner") or "") or mine.get("owner")
    at = _ts(ig.get("publishedAt")) or mine.get("at")

    def need(media):  # gönderi listede ya da hesabın bizim (bu gönderiyi yükleyen) hesap olduğuna kanıt var
        if tid in media:
            return True
        for r in media:
            m = rec.get(r)
            if r == tid or not m:
                continue
            if owner and m["owner"] == owner:
                return True
            if not owner and at is not None and m["at"] is not None and m["at"] <= at:
                return True
        return False
    acc = _ig_account((uid, token, base), need)
    if not acc:
        return None
    if tid in acc["media"]:
        return True
    return False if need(acc["media"]) else None


def ig_delete(ig: dict) -> dict:
    """Instagram gönderisini siler: DELETE /{media-id}. Sonuç {ok, message, url, via, reason, detail} ve durum bayrakları:
    gone (zaten yok, doğrulandı), manual + unsupported (API bu bağlantıyla silmeye izin vermiyor: uygulamadan elle silinmeli),
    token (bağlantı geçersiz: yeniden bağlanmalı), retry (geçici hata, sınıflanamayan hata ya da durum doğrulanamadı); halt
    (ig_halt: token / throttled / offline — hesabın tamamını etkiler, çağıran o çalışmada başka istek atmaz).
    Başarı yalnız 2xx + {"success": true}; başka 2xx/3xx silindi sayılmaz. DELETE hata metnine tek başına güvenilmez; "yok" yalnız
    ig_exists doğrularsa ok sayılır (kayıt metriklerden düşer)."""
    url = ig.get("url")
    try:
        creds = ig_creds()
    except Exception as e:
        return {"ok": False, "message": f"Instagram silinemedi: {str(e)[:160]}", "url": url}
    uid, token, base = creds
    via = IG_VIA_TR["instagram" if base == IG_API else "facebook"]
    st, body = _graph("DELETE", f"{base}/{ig['id']}?" + urllib.parse.urlencode({"access_token": token}))
    err = graph_error(st, body)
    if not err and body.get("success") is True:
        return {"ok": True, "message": "Instagram'dan silindi", "via": via}
    if not err:  # 2xx ama başarı bildirilmedi: silindiği söylenemez, gönderiye bakılır
        err = {"status": st, "code": None, "subcode": None, "message": "silme yanıtında başarı bilgisi yok", "transient": False, "raw": True}
    reason = graph_reason(err)
    fail = {"ok": False, "url": url, "via": via, "reason": reason, "detail": json.dumps(body, ensure_ascii=False)[:300]}
    if _token_err(err):
        return {**fail, "token": True, "halt": "token", "haltReason": reason, "message": f"Instagram bağlantısı geçersiz ya da süresi dolmuş ({reason[:90]}); panelde "
                "Ayarlar → Yayın hesapları → Instagram'ı yeniden bağlayın, sonra tekrar deneyin"}
    if _retry_err(err):
        h = ig_halt(err)
        return {**fail, "retry": True, **({"halt": h, "haltReason": reason} if h else {}),
                "message": (f"Instagram şu an istekleri sınırlıyor ({reason[:90]}); daha sonra yeniden deneyin" if h == "throttled"
                            else f"Instagram şu an yanıt vermedi ({reason[:90]}); {IG_LATER}")}
    why = {}
    exists = ig_exists(ig, creds, why)
    if exists is False:
        return {"ok": True, "gone": True, "message": "Instagram'da zaten yok", "via": via, "detail": fail["detail"]}
    if exists is None:
        h = ig_halt(why.get("err"))
        return {**fail, "retry": True, **({"halt": h, "haltReason": graph_reason(why["err"])} if h else {}),
                "message": f"Instagram silinemedi ({reason[:90]}) ve gönderinin durumu doğrulanamadı; {IG_LATER}"}
    if _deny_err(err):
        return {**fail, "manual": True, "unsupported": True,
                "message": f"Instagram API bu bağlantıyla ({via}) gönderi silmeye izin vermiyor; Instagram uygulamasından elle silin ({reason[:90]})"}
    return {**fail, "retry": True, "message": f"Instagram silinemedi ({reason[:90]}); {IG_LATER}"}


def ig_check_known(ig: dict, sup: dict) -> dict:
    """API bu bağlantıyla silmiyor diye biliniyorken (ig_cleanup.support known) DELETE yerine yalnız gönderiye bakar: yok → ok + gone
    (elle silinmiş), var → manual + unsupported, bilinmiyor → retry. Sonuç ig_delete ile aynı biçimde."""
    via = sup.get("viaName") or "Instagram Girişi"
    reason = sup.get("reason") or ""
    ex = ig_exists(ig)
    if ex is False:
        return {"ok": True, "gone": True, "message": "Instagram'da yok (elle silinmiş)", "via": via}
    base = {"ok": False, "url": ig.get("url"), "via": via, "reason": reason}
    if ex:
        return {**base, "manual": True, "unsupported": True, "message": f"Instagram API bu bağlantıyla ({via}) gönderi silmeye izin vermiyor; "
                f"Instagram uygulamasından elle silin{f' ({reason[:90]})' if reason else ''}"}
    return {**base, "retry": True, "message": f"Instagram'daki durumu doğrulanamadı; {IG_LATER}"}


def delete_remote(name: str) -> dict:
    """Videoyu yüklendiği platformlardan kaldırır. Sonuç {platform: {ok, message}}; silinenler metriklerden düşülür.
    YouTube: videos.delete ("youtube" izni gerekir). Instagram: ig_delete (Instagram Girişi silmeyi desteklemez: manual + link;
    "yok" yalnız doğrulanınca ok; desteklemediği biliniyorsa DELETE yerine ig_check_known). TikTok: Content Posting API silme sunmaz;
    gelen kutusu taslağı herkese açık değildir, yayınlandıysa uygulamadan silinir."""
    m = metrics()
    entry = m["videos"].get(name, {})
    out = {}
    yt = entry.get("youtube") or {}
    if yt.get("id"):
        try:
            yt_service().videos().delete(id=yt["id"]).execute()
            out["youtube"] = {"ok": True, "message": "YouTube'dan silindi"}
        except Exception as e:
            msg = str(e)
            if "404" in msg or "videoNotFound" in msg:
                out["youtube"] = {"ok": True, "message": "YouTube'da zaten yok"}
            elif "insufficient" in msg.lower() or "403" in msg:
                out["youtube"] = {"ok": False, "message": "YouTube silme izni yok: Ayarlar → YouTube → 🔄 Yeniden bağla, sonra tekrar silin", "url": yt.get("url")}
            else:
                out["youtube"] = {"ok": False, "message": f"YouTube silinemedi: {msg[:160]}", "url": yt.get("url")}
    ig = entry.get("instagram") or {}
    if ig.get("id"):
        try:
            import ig_cleanup
            sup = ig_cleanup.support()
        except Exception:
            ig_cleanup, sup = None, {}
        if sup.get("known"):  # API bu bağlantıyla silmiyor: DELETE denenmez, kayıt (7 günlük süre) uzamaz
            out["instagram"] = ig_check_known(ig, sup)
        else:
            out["instagram"] = ig_delete(ig)
            try:  # otomatik temizlik de bilsin: API bu bağlantıyla silmiyorsa boşuna DELETE denemez (ig_cleanup.py); bu bağlantıyla
                if ig_cleanup:  # silme çalışıyorsa tek gönderinin reddi bağlantıyı "desteklemiyor" yapmaz (settle → per_post)
                    out["instagram"] = ig_cleanup.settle(out["instagram"])[0]
            except Exception:
                pass
    tt = entry.get("tiktok") or {}
    if tt.get("publish_id") or tt.get("id"):
        out["tiktok"] = {"ok": False, "manual": True, "url": tt.get("url"),
                         "message": "TikTok API silmeye izin vermiyor: yayınladıysanız TikTok uygulamasından silin (gelen kutusu taslağı herkese açık değil)"}
    try:  # web alanında kalmış kopya
        if hostinger.configured():
            hostinger.delete(f"videos/{name}")
    except Exception:
        pass
    # silinenleri metriklerden düş; silinemeyen platform kaydı kalsın (link kaybolmasın)
    m = metrics()
    e2 = m["videos"].get(name, {})
    for p, r in out.items():
        if r.get("ok"):
            e2.pop(p, None)
    if name in m["videos"] and not any(k in e2 for k in ("youtube", "instagram", "tiktok")):
        m["videos"].pop(name, None)
    save_metrics(m)
    q = [x for x in (load_json(QUEUE_FILE, []) or []) if x.get("video") != name]  # sınır sırasında bekliyorsa çıkar
    save_json(QUEUE_FILE, q)
    return out


# ---------------- durum
def ig_status(env):
    import shutil
    st = {"lastError": (load_json(LAST_ERR, {}) or {}).get("instagram"), "connected": False, "appKeys": bool(env.get("IG_APP_ID") and env.get("IG_APP_SECRET")), "publicUrl": bool(env.get("PUBLIC_BASE_URL")), "login": (env.get("IG_LOGIN") or "instagram").lower(),
          "hostinger": hostinger.configured(), "hostingerUrl": hostinger.site_url() if hostinger.configured() else None,
          "cloudflared": bool(shutil.which("cloudflared")), "username": None, "daysLeft": None, "via": None}
    if IG_TOKEN_FILE.exists():
        try:
            tok = json.loads(IG_TOKEN_FILE.read_text())
            st.update({"connected": True, "via": tok.get("via") or "instagram_login", "username": tok.get("username"), "pageName": tok.get("page_name"),
                       "daysLeft": None if tok.get("via") == "facebook" else max(0, int((tok.get("obtained_at", 0) + tok.get("expires_in", 0) - time.time()) / 86400))})
        except Exception:
            pass
    elif env.get("IG_USER_ID") and env.get("IG_ACCESS_TOKEN"):
        st.update({"connected": True, "via": "env"})
    return st


def status():
    env = load_env()
    yt_ok = (SECRETS / "youtube_token.json").exists()
    return {
        "youtube": {"connected": yt_ok, "clientFile": (SECRETS / "youtube_client.json").exists(),
                    "holdUntil": (hold_until("youtube") or None) and hold_until("youtube").isoformat(),
                    "playlists": bool(set(load_json(SECRETS / "youtube_token.json", {}).get("scopes") or []) & YT_MANAGE),
                    "comments": YT_COMMENT in yt_scopes(),  # ilk yorum ve yorum yanıtı (youtube.force-ssl)
                    "queued": sum(1 for x in (load_json(QUEUE_FILE, []) or []) if x.get("platform") == "youtube")},
        "instagram": {**ig_status(env), "queue": queue_info("instagram")},
        "tiktok": {"queue": queue_info("tiktok"), "connected": TT_TOKEN_FILE.exists(), "appKeys": bool(env.get("TIKTOK_CLIENT_KEY") and env.get("TIKTOK_CLIENT_SECRET")),
                   "mode": (env.get("TIKTOK_MODE") or "inbox").lower(), "redirect": tt_redirect(env), "scopes": tt_scopes(env),
                   "https": tt_redirect(env).startswith("https://")},
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--file")
    ap.add_argument("--platform", choices=["youtube", "instagram", "tiktok"])
    ap.add_argument("--connect", choices=["youtube", "tiktok", "instagram"])
    ap.add_argument("--disconnect", choices=["youtube", "tiktok"])
    ap.add_argument("--status", action="store_true")
    ap.add_argument("--tt-check", action="store_true", help="son TikTok gönderimlerinin durumunu sor")
    ap.add_argument("--ig-diagnose", action="store_true", help="Instagram yayın zincirini sına")
    ap.add_argument("--delete-remote", help="videoyu yüklendiği platformlardan sil (dosya adı)")
    ap.add_argument("--flush", action="store_true")
    ap.add_argument("--yt-thumbs", action="store_true", help="YouTube'da kapağı reddedilmiş/eksik videolara kapağı yeniden yükle")
    ap.add_argument("--queue", action="store_true", help="sınır sıraları (Instagram, TikTok, YouTube): bekleyen videolar, duraklatma, son olaylar")
    ap.add_argument("--unqueue", action="store_true", help="--file ile videoyu sıradan çıkar (yüklenmez); --platform verilirse yalnız o platformun sırasından")
    ap.add_argument("--only-trailers", action="store_true", help="--flush ile yalnız sıradaki fragmanları yükle (haberler sırada kalır); --platform ile tek platform")
    ap.add_argument("--retitle", action="store_true", help="tutmayan videonun YouTube başlığını diğer varyanta çevir")
    ap.add_argument("--first-comments", action="store_true", help="ilk yorumu yazılamamış son videolara yorumu yaz")
    a = ap.parse_args()
    if a.first_comments:
        print(json.dumps(fill_first_comments(), ensure_ascii=False)); return
    if a.retitle:
        print(json.dumps(yt_retitle(), ensure_ascii=False)); return
    if a.status:
        print(json.dumps(status(), ensure_ascii=False)); return
    if a.ig_diagnose:
        steps = ig_diagnose()
        print(json.dumps({"ok": all(x["ok"] for x in steps), "steps": steps}, ensure_ascii=False)); return
    if a.delete_remote:
        print(json.dumps({"ok": True, "results": delete_remote(Path(a.delete_remote).name)}, ensure_ascii=False)); return
    if a.tt_check:
        try:
            print(json.dumps({"ok": True, "items": tt_check()}, ensure_ascii=False))
        except Exception as e:
            print(json.dumps({"ok": False, "error": str(e)[:300]}, ensure_ascii=False))
        return
    if a.flush:
        print(json.dumps(flush(only="fragman" if a.only_trailers else None, plat_only=a.platform), ensure_ascii=False)); return
    if a.yt_thumbs:
        print(json.dumps(yt_retry_thumbs(), ensure_ascii=False)); return
    if a.queue:
        for plat in ("instagram", "tiktok", "youtube"):
            print(queue_line(plat))
        print(json.dumps({"ok": True, "instagram": queue_info("instagram"), "tiktok": queue_info("tiktok"), "youtube": queue_info("youtube")}, ensure_ascii=False)); return
    if a.unqueue:
        if not a.file:
            print(json.dumps({"ok": False, "error": "--unqueue için --file gerekir"}, ensure_ascii=False)); return
        plats = unqueue_all(Path(a.file).name, a.platform)
        print(json.dumps({"ok": bool(plats), "platforms": plats, "error": None if plats else "sırada böyle bir video yok"}, ensure_ascii=False)); return
    if a.disconnect == "tiktok":
        print(json.dumps({"ok": True, "removed": tt_disconnect(), "message": "TikTok bağlantısı kesildi"}, ensure_ascii=False)); return
    if a.disconnect == "youtube":
        print(json.dumps({"ok": True, "removed": yt_disconnect(), "message": "YouTube bağlantısı kesildi"}, ensure_ascii=False)); return
    if a.connect == "youtube":
        try:
            lists = yt_connect()
        except Exception as e:  # paneli okunur bir mesajla bilgilendir
            print(json.dumps({"ok": False, "error": str(e)}, ensure_ascii=False)); sys.exit(1)
        msg = "YouTube bağlandı; oynatma listesi izni verildi" if lists else \
            "YouTube bağlandı ama oynatma listesi izni verilmedi (Google onay ekranında 'YouTube hesabınızı yönetme' işaretli olmalı); yükleme yine çalışır"
        print(json.dumps({"ok": True, "playlists": lists, "message": msg}, ensure_ascii=False)); return
    if a.connect == "instagram":
        try:
            tok = ig_connect()
        except Exception as e:
            print(json.dumps({"ok": False, "error": str(e)}, ensure_ascii=False)); sys.exit(1)
        print(json.dumps({"ok": True, "message": f"Instagram bağlandı: @{tok.get('username') or '?'}", "username": tok.get("username")}, ensure_ascii=False)); return
    if a.connect == "tiktok":
        try:
            tt_connect()
        except Exception as e:
            print(json.dumps({"ok": False, "error": str(e)}, ensure_ascii=False)); sys.exit(1)
        print(json.dumps({"ok": True, "message": "TikTok bağlandı"}, ensure_ascii=False)); return
    if not (a.file and a.platform):
        ap.error("--file ve --platform gerekli")
    path = Path(a.file) if Path(a.file).is_absolute() else OUT / Path(a.file).name
    if not path.exists():
        sys.exit(f"Dosya yok: {path}")
    res = upload(path, a.platform)
    print(json.dumps(res, ensure_ascii=False))
    if not res.get("ok"):
        sys.exit(1)


PLAT_NAME = {"youtube": "YouTube", "instagram": "Instagram", "tiktok": "TikTok"}


def upload(path: Path, plat: str) -> dict:
    """Tek yükleme; sınır doluysa sıraya alır ({"ok": False, "limit": True, "queued": True}). Aynı video aynı platforma ikinci kez
    yüklenmez: metrics kaydı, yükleme defteri (metrics kaybolsa da) ve süreç kilidi (aynı anda iki süreç) — kullanıcı şikâyeti, 23-24 Ekim."""
    m = metrics()
    entry = m["videos"].setdefault(path.name, {})
    if entry.get(plat, {}).get("id"):
        return {"ok": True, "skipped": True, "message": f"{plat} için zaten yayınlanmış", **entry[plat]}
    led = ledger_get(path.name, plat)
    if led.get("state") == "done" and (led.get("id") or led.get("unresolved")):  # yüklenmiş ama metrics kaydı kaybolmuş (eşzamanlı yazım): kayıt onarılır
        res = {k: led[k] for k in ("id", "url", "publishedAt", "owner", "unresolved", "cid") if led.get(k) is not None}
        m["videos"].setdefault(path.name, {})[plat] = {**(entry.get(plat) or {}), **res}
        save_metrics(m)
        print(f"  ! {PLAT_NAME[plat]}: bu video daha önce yüklenmiş (yükleme defteri); kayıt onarıldı, yeniden yüklenmedi", file=sys.stderr, flush=True)
        return {"ok": True, "skipped": True, "recovered": True, **res}
    until = hold_until(plat)
    if until:
        enqueue(path.name, plat)
        reason = ((load_json(HOLD_FILE, {}) or {}).get(plat) or {}).get("reason", "")
        why = IG_LIMIT_TR.get(reason) if plat == "instagram" else None
        return {"ok": False, "limit": True, "queued": True,
                "error": f"{why or PLAT_NAME[plat] + ' günlük yükleme sınırı dolu'}; video sıraya alındı, {local_hhmm(until)} sonrası otomatik yüklenecek"}
    lock = upload_lock(path.name, plat)
    if lock is None:  # aynı video şu anda başka bir süreçte yükleniyor: yeniden denemek ikinci kopya üretir
        return {"ok": False, "busy": True, "error": f"{PLAT_NAME[plat]}: bu video şu anda başka bir süreçte yükleniyor; ikinci kopya olmasın diye yeniden yüklenmedi"}
    try:
        try:
            res = {"youtube": yt_upload, "instagram": ig_upload, "tiktok": tt_upload}[plat](path)
        except LimitReached as e:
            until = set_hold(plat, str(e))
            enqueue(path.name, plat)
            why = TT_LIMIT_TR.get(str(e)) if plat == "tiktok" else None
            return {"ok": False, "limit": True, "queued": True,
                    "error": (f"{why}. TikTok gönderimi {local_hhmm(until)}'e kadar duraklatıldı, video sıraya alındı (taslaklar azalınca otomatik gönderilir)"
                              if why else f"{PLAT_NAME[plat]} günlük yükleme sınırı doldu ({e}); video sıraya alındı, {local_hhmm(until)} sonrası otomatik yüklenecek")}
        except Exception as e:  # hatayı JSON olarak döndür, panel okur
            msg = str(e)
            tt_reason = next((r for r in TT_LIMIT_REASONS if r in msg), None) if plat == "tiktok" else None
            if tt_reason:  # doğrudan yayın modunda da aynı sınır: duraklat ve sıraya al
                until = set_hold(plat, tt_reason)
                enqueue(path.name, plat)
                return {"ok": False, "limit": True, "queued": True,
                        "error": f"{TT_LIMIT_TR[tt_reason]}. TikTok gönderimi {local_hhmm(until)}'e kadar duraklatıldı, video sıraya alındı"}
            if plat == "instagram" and IG_THROTTLE_RE.search(msg):  # "User is performing too many actions" / istek sınırı: duraklat, sıraya al
                until = set_hold(plat, "instagram_rate_limit")
                enqueue(path.name, plat)
                return {"ok": False, "limit": True, "queued": True,
                        "error": f"{IG_LIMIT_TR['instagram_rate_limit']}. Instagram gönderimi {local_hhmm(until)}'e kadar duraklatıldı, video sıraya alındı"}
            err = msg + (ig_hint(msg) if plat == "instagram" else "")
            last = load_json(LAST_ERR, {}) or {}
            last[plat] = {"at": now_iso(), "video": path.name, "error": err[:500]}
            save_json(LAST_ERR, last)
            return {"ok": False, "error": err}
        # yayın tamam: önce defter (metrics.json'u eşzamanlı yazan başka süreç kaydı ezse de yeniden yükleme olmaz), sonra metrics
        ledger_set(path.name, plat, state="done", id=res.get("id"), url=res.get("url"), publishedAt=res.get("publishedAt"), owner=res.get("owner"),
                   unresolved=res.get("unresolved"), cid=res.get("cid"))
        clear_hold(plat)
        last = load_json(LAST_ERR, {}) or {}
        if last.pop(plat, None) is not None:
            save_json(LAST_ERR, last)
        m = metrics()
        m["videos"].setdefault(path.name, {})[plat] = res
        save_metrics(m)
        return {"ok": True, **res}
    finally:
        try:
            lock.unlink()
        except Exception:
            pass


def flush_order(q: list) -> list:
    """Yükleme sırası (kullanıcı isteği, 26 Ekim: "Instagram'da önce fragmanlar yüklensin, fragmanlar yüklendikten sonra haberlere geçilsin"):
    1) fragmanlar (fragman takibi + sahibin fragman analizi; fragmanlar asla kaçmasın), 2) sahibin WhatsApp'tan istediği videolar, 3) haberler;
    her kümede en yeni önce. Kararlı sıralama: aynı türde giriş zamanı belirler."""
    def rank(it):
        try:
            return QUEUE_KIND_RANK.get(queue_kind(it.get("video")), 2)
        except Exception:
            return 2
    out = sorted(q, key=lambda x: x.get("at", ""), reverse=True)
    out.sort(key=rank)
    return out


def _queue_remove_now(name: str, plat: str) -> None:
    """Yüklenen ya da düşen kaydı HEMEN diskten çıkarır (inceleme, 27 Ekim: flush süreci zaman aşımında öldürülürse yüklenmiş video sırada kalıyordu)."""
    cur = load_json(QUEUE_FILE, []) or []
    save_json(QUEUE_FILE, [x for x in cur if not (isinstance(x, dict) and x.get("video") == name and x.get("platform") == plat)])


def flush(only: str | None = None, plat_only: str | None = None) -> dict:
    """Sıradaki (sınır yüzünden bekleyen) videoları yükler: önce fragmanlar, sonra sahibin videoları, sonra en yeni haber önce (flush_order).
    only="fragman": yalnız fragmanlar yüklenir, diğerleri sırada kalır (post_pipeline otomatik haberden önce çağırır); plat_only: yalnız o platform."""
    q = load_json(QUEUE_FILE, []) or []
    if not q:
        return {"ok": True, "queued": 0}
    now = datetime.now(timezone.utc)
    done, keep = [], []
    for it in flush_order(q):
        plat, name = it.get("platform"), it.get("video", "")
        kind = queue_kind(name)
        if (only and kind != only) or (plat_only and plat != plat_only):
            keep.append(it); continue
        at = _parse(it.get("at", "")) or now
        path = OUT / Path(name).name
        max_h = queue_max_hours(kind)
        if not path.exists() or now - at > timedelta(hours=max_h):
            why = "silinmiş" if not path.exists() else f"{max_h} saatten eski, bayat"
            print(f"📤 sıradan çıkarıldı (eski ya da silinmiş): {name} → {plat}", flush=True)
            qlog("dropped", name, plat, why); _queue_remove_now(name, plat)
            continue
        if hold_until(plat):
            keep.append(it); continue
        res = upload(path, plat)
        tries = int(it.get("tries") or 0) + 1
        if res.get("ok"):
            done.append(f"{plat}:{name}"); _queue_remove_now(name, plat)
            print(f"📤 {plat}: " + ("zaten yayında " if res.get("skipped") else "tamam ") + f"{res.get('url') or ''} (sıradan{', fragman' if kind == 'fragman' else ''})", flush=True)
            qlog("uploaded", name, plat, "sıradan yüklendi" + (f" ({tries}. denemede)" if tries > 1 else ""), res.get("url") or "")
        elif res.get("limit"):  # bekleme yeniden başladı (engel sürüyor): video sırada kalır
            keep.append({**it, "tries": tries, "lastTry": now_iso(), "lastError": res.get("error") or ""})
            qlog("held", name, plat, res.get("error") or "")
        elif tries >= QUEUE_MAX_TRIES:  # sınır dışı hata (bozuk dosya, API hatası): birkaç denemeden sonra çıkarılır
            print(f"📤 {plat}: hata {res.get('error')} (sıradan, {tries}. denemede çıkarıldı)", flush=True)
            qlog("dropped", name, plat, f"{tries} deneme başarısız: {res.get('error') or ''}"); _queue_remove_now(name, plat)
        else:
            print(f"📤 {plat}: hata {res.get('error')} (sıradan, {tries}. deneme; yeniden denenecek)", flush=True)
            keep.append({**it, "tries": tries, "lastTry": now_iso(), "lastError": res.get("error") or ""})
            qlog("failed", name, plat, res.get("error") or "")
    # diskteki güncel sıra esastır: bu arada başka bir üretimin eklediklerini koru, sahibin çıkardıklarını (panel ✖, "sıradan çıkar", silme)
    # geri yazma (inceleme, 27 Ekim: fragmanlar yüklenirken çıkarılan haber sıraya geri geliyordu); bizim kayıtlarımız yalnız tries/lastError günceller
    cur = [x for x in (load_json(QUEUE_FILE, []) or []) if isinstance(x, dict)]
    cur_keys = {(x.get("video"), x.get("platform")) for x in cur}
    seen = {(x.get("video"), x.get("platform")) for x in q}
    kept = [x for x in keep if (x.get("video"), x.get("platform")) in cur_keys]
    added = [x for x in cur if (x.get("video"), x.get("platform")) not in seen]
    save_json(QUEUE_FILE, kept + added)
    for plat in sorted({x.get("platform") for x in kept + added if x.get("platform")}):
        print(queue_line(plat), flush=True)
    return {"ok": True, "uploaded": done, "queued": len(kept)}


if __name__ == "__main__":
    main()
