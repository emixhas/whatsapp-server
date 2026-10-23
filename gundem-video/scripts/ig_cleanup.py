#!/usr/bin/env python3
"""Instagram temizliği (kullanıcı isteği: "7 gün içinde Instagram'da 1000 izlenmenin altında olan tümünü sil").

  python3 scripts/ig_cleanup.py --plan --days 7 --max 1000 [--min-age-hours 0]
      silinecekleri listeler (hiçbir şey silmez): son `days` gün içinde Instagram'a yüklenmiş, izlenmesi `max`'ın altında,
      en az `min-age-hours` saatlik videolar. İzlenmesi hiç ölçülmemiş video listeye girmez (bilinmeyen = silinmez).
  python3 scripts/ig_cleanup.py --auto-plan --max 5000 --wait-hours 72 --max-age-days 30 [--keep a.mp4,b.mp4]
      otomatik temizliğin listesi: ready (silinecek), upcoming (karar saatini bekleyen), kept (korunan); hiçbir şey silmez.
  python3 scripts/ig_cleanup.py --run --names a.mp4,b.mp4 --max 1000
      yalnız verilen videoları siler; silmeden hemen önce Instagram'dan güncel izlenmeyi tekrar okur, bu arada `max`'ı
      geçen video silinmez. Yalnız Instagram gönderisi silinir (YouTube, TikTok ve Mac'teki kopya kalır); metriklerden
      Instagram kaydı düşer. Her silme `data/ig_cleanup_log.json`a yazılır ve stdout'a "🗑 …" satırı olarak basılır.
  python3 scripts/ig_cleanup.py --support
      silme desteği kaydı (data/ig_delete_support.json) ve geçerli mi (known) — JSON.
  python3 scripts/ig_cleanup.py --dups --days 7            aynı açıklamayla ikişer yüklenmiş gönderiler (hiçbir şey silmez)
  python3 scripts/ig_cleanup.py --dups-run --json '[…]'    fazla kopyaları siler (her haberin ilk gönderisi kalır; metrik kaydı ona bağlanır)

Instagram Girişi (graph.instagram.com) gönderi silmeyi desteklemez (Meta yalnız Facebook Girişi + instagram_manage_contents için
belgeliyor). İlk "izin yok" yanıtı data/ig_delete_support.json'a yazılır {unsupported, at, via, tokenAt, reason}; aynı bağlantıda
(via + tokenAt) en çok SUPPORT_DAYS gün boyunca DELETE denenmez, yalnız gönderi hâlâ var mı diye bakılır: elle silinmişse
Instagram kaydı metriklerden düşer, duruyorsa "elle silinmeli" listesine girer. Süre dolunca ya da bağlantı değişince bir kez
gerçek DELETE yeniden denenir.
"""
import json
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import DATA, episode_meta, load_json, metrics, now_iso, save_json, save_metrics  # noqa: E402

LOG = DATA / "ig_cleanup_log.json"
SUPPORT = DATA / "ig_delete_support.json"  # {unsupported, at, via, tokenAt, reason, detail}
SUPPORT_DAYS = 7


def _age_h(ts: str) -> float | None:
    try:
        return (datetime.now(timezone.utc) - datetime.fromisoformat(str(ts).replace("Z", "+00:00"))).total_seconds() / 3600
    except Exception:
        return None


def title_of(name: str) -> str:
    meta = episode_meta(name) or {}
    first = next((s.get("title") for s in meta.get("segments") or [] if s.get("kind") == "haber"), "")
    return meta.get("publishTitle") or first or name


def plan(days: float, max_views: int, min_age_h: float = 0) -> dict:
    out, unknown = [], []
    for name, v in metrics()["videos"].items():
        ig = v.get("instagram") or {}
        if not ig.get("id"):
            continue
        age = _age_h(ig.get("publishedAt", ""))
        if age is None or age > days * 24 or age < min_age_h:
            continue
        if ig.get("views") is None:
            unknown.append(name)
            continue
        if int(ig["views"]) < max_views:
            out.append({"name": name, "title": title_of(name)[:90], "views": int(ig["views"]), "ageH": round(age, 1), "url": ig.get("url")})
    out.sort(key=lambda x: x["views"])
    return {"ok": True, "items": out, "unknown": unknown, "days": days, "max": max_views, "minAgeH": min_age_h}


def auto_plan(max_views: int, wait_h: float, max_age_d: float, keep: list) -> dict:
    """Otomatik temizlik (kullanıcı isteği, 17 Ekim: "5000 altında izlenen videoları otomatik silelim, sayıları panelde göreyim,
    değiştireyim, silinmeye adayları da göreyim"): yalnız Instagram. ready = `wait_h` saati geçmiş ve izlenmesi `max_views` altında
    (silinecek), upcoming = henüz `wait_h` dolmamış ama şu an altında (karar saati gelince yeniden bakılır), kept = korumaya alınanlar.
    `max_age_d` günden eski gönderilere bakılmaz; izlenmesi ölçülmemiş gönderi silinmez."""
    ready, upcoming, kept, unknown = [], [], [], []
    keep = set(keep or [])
    for name, v in metrics()["videos"].items():
        ig = v.get("instagram") or {}
        if not ig.get("id"):
            continue
        age = _age_h(ig.get("publishedAt", ""))
        if age is None or age > max_age_d * 24:
            continue
        if ig.get("views") is None:
            unknown.append(name)
            continue
        views = int(ig["views"])
        item = {"name": name, "title": title_of(name)[:90], "views": views, "ageH": round(age, 1), "url": ig.get("url")}
        if name in keep:
            kept.append(item)
        elif views < max_views:
            (ready if age >= wait_h else upcoming).append({**item, **({} if age >= wait_h else {"hoursLeft": round(wait_h - age, 1)})})
    ready.sort(key=lambda x: x["views"])
    upcoming.sort(key=lambda x: x.get("hoursLeft", 0))
    return {"ok": True, "ready": ready, "upcoming": upcoming, "kept": kept, "unknown": unknown,
            "max": max_views, "waitHours": wait_h, "maxAgeDays": max_age_d}


def fresh_views(ig: dict, why: dict | None = None) -> int | None:
    """Silmeden hemen önce güncel izlenme (Instagram içgörüsü: views, olmazsa plays). why verilirse son Graph hatası why["err"]e
    yazılır; hesabı etkileyen hatada (bağlantı geçersiz, istek sınırı, ağ) ikinci ölçü denenmez."""
    import urllib.parse
    from publish import _graph, graph_error, ig_creds, ig_halt
    uid, token, base = ig_creds()
    for metric in ("views", "plays"):
        st, body = _graph("GET", f"{base}/{ig['id']}/insights?" + urllib.parse.urlencode({"metric": metric, "access_token": token}), timeout=60)
        err = graph_error(st, body)
        if err:
            if why is not None:
                why["err"] = err
            if ig_halt(err):
                return None
            continue
        try:
            data = body.get("data") or []
            return int((data[0].get("values") or [{}])[0].get("value", 0)) if data else None
        except Exception:
            continue
    return None


def support() -> dict:
    """Silme desteği kaydı + known (API bu bağlantıyla silmeye izin vermiyor diye bilinir): yalnız aynı bağlantıda (via + tokenAt)
    ve en çok SUPPORT_DAYS gün geçerli; sonra bir kez gerçek DELETE yeniden denenir (izin eklenmiş ya da Meta açmış olabilir)."""
    from publish import IG_VIA_TR, ig_conn
    s = load_json(SUPPORT, {})
    s = s if isinstance(s, dict) else {}  # bozuk/yanlış türdeki dosya kayıt yok sayılır (sonraki tespitte yeniden yazılır)
    conn = ig_conn()
    same = bool(s) and s.get("via") == conn.get("via") and s.get("tokenAt") == conn.get("tokenAt")
    age = _age_h(s.get("at", ""))
    valid = age is not None and 0 <= age <= SUPPORT_DAYS * 24  # gelecek tarihli kayıt (saat kayması) geçersiz: bir kez yeniden denenir
    retry_at = None
    if s.get("unsupported") and valid:
        retry_at = (datetime.fromisoformat(str(s["at"]).replace("Z", "+00:00")) + timedelta(days=SUPPORT_DAYS)).isoformat()
    return {**s, "viaName": IG_VIA_TR.get(str(s.get("via") or "")) or conn.get("name"), "sameConnection": same, "retryAt": retry_at,
            "known": bool(s.get("unsupported")) and same and valid,
            "deleteWorks": s.get("unsupported") is False and same and valid}  # bu bağlantıyla son SUPPORT_DAYS günde gerçek silme görüldü


def note_support(r: dict) -> bool:
    """ig_delete sonucunu kayda geçirir: unsupported → {unsupported: True, …}; gerçek silme → {unsupported: False, …}.
    Bu bağlantı için ilk "izin yok" tespitiyse True (neden bir kez loga yazılsın diye)."""
    from publish import ig_conn
    conn = ig_conn()
    if r.get("unsupported"):
        prev = support()
        save_json(SUPPORT, {"unsupported": True, "at": now_iso(), "via": conn.get("via"), "tokenAt": conn.get("tokenAt"),
                            "reason": r.get("reason"), "detail": r.get("detail")})
        return not (prev.get("unsupported") and prev.get("sameConnection"))
    if r.get("ok") and not r.get("gone"):
        save_json(SUPPORT, {"unsupported": False, "at": now_iso(), "via": conn.get("via"), "tokenAt": conn.get("tokenAt")})
    return False


def per_post(r: dict) -> dict:
    """Bu bağlantıyla silme çalışıyorken gelen "izin yok": bağlantının değil yalnız bu gönderinin sorunu (ör. başka girişle yüklenmiş
    gönderi). Kayda geçmez, çalışma denetime dönmez; gönderi elle silinecekler listesine girer."""
    why = f" ({str(r.get('reason'))[:90]})" if r.get("reason") else ""
    return {**r, "unsupported": False, "perPost": True,
            "message": f"Instagram API bu gönderiyi silmeye izin vermedi (bu bağlantıyla başka gönderiler silinebiliyor); Instagram uygulamasından elle silin{why}"}


def settle(r: dict, works: bool = False) -> tuple:
    """ig_delete sonucunu bağlantı kaydıyla birleştirir → (sonuç, bu bağlantıda ilk "izin yok" tespiti mi). Bu bağlantıyla gerçek silme
    görüldüyse (works: bu çalışmada; ya da kayıt son SUPPORT_DAYS günde unsupported: false) "izin yok" yalnız o gönderinindir (per_post):
    unsupported: true yazılmaz. Değilse note_support (ilk "izin yok" ya da başarılı silme kayda geçer)."""
    if r.get("unsupported") and (works or support().get("deleteWorks")):
        return per_post(r), False
    return r, note_support(r)


def run(names: list, max_views: int) -> dict:
    """Verilen videoları Instagram'dan siler. API bu bağlantıyla silmiyorsa (support known) DELETE ve izlenme sorgusu yapılmaz:
    yalnız gönderi hâlâ var mı bakılır (False → elle silinmiş, kayıt düşer; True → manual; None → unknown, kayıt kalır).
    İlk "izin yok" yanıtından sonra kalan videolar da aynı yoldan geçer (o çalışmada başka DELETE yok); bu bağlantıyla silme
    çalışıyorsa (bu çalışmada ya da son SUPPORT_DAYS günde gerçek silme) "izin yok" yalnız o gönderinindir (per_post: elle silinecek,
    çalışma sürer). Tek tek reddedilmiş gönderiler sona alınır (bağlantının yeniden denenen DELETE'i onlara düşmesin). Hesabın
    tamamını etkileyen hatada (bağlantı geçersiz, istek sınırı/geçici engel; ağ hatası ancak art arda iki videoda; publish.ig_halt)
    çalışma durur: kalan videolar denenmeden "silinemedi" sayılır (notTried), stdout'a tek satır. Kayıt dosyasına yalnız durum değişikliği yazılır (silindi, elle silinmiş,
    ilk kez elle silinmeli, yeni hata); stdout'a silinen/düşen/gerçek hata satırları ve elle silinmesi gerekenler için TEK özet satırı."""
    from publish import graph_reason, ig_conn, ig_delete, ig_exists, ig_halt
    sup = support()
    known = unsupported = bool(sup.get("known"))
    works = bool(sup.get("deleteWorks"))
    conn = ig_conn()
    via = sup.get("viaName") if known else conn.get("name")
    reason = sup.get("reason") if known else None
    sup_new = False
    done, kept, failed, manual, gone, unknown = [], [], [], [], [], []
    log = load_json(LOG, [])
    log = [x for x in log if isinstance(x, dict)] if isinstance(log, list) else []
    last = {x.get("video"): x for x in log}
    refused = {x.get("video") for x in log if x.get("deny") == "post" and x.get("via") == conn.get("via") and x.get("tokenAt") == conn.get("tokenAt")}
    if not known and refused:
        names = [n for n in names if n not in refused] + [n for n in names if n in refused]
    halt = None  # (tür, mesaj, kalan videoların başladığı sıra)
    offline = 0  # art arda ağ hatası alan video sayısı (tek kopukluk çalışmayı durdurmaz, ikincisi durdurur)
    relink = "Instagram bağlantısı geçersiz ya da süresi dolmuş; panelde Ayarlar → Yayın hesapları → Instagram'ı yeniden bağlayın"

    def note(rec):
        p = last.get(rec["video"])
        if p and p.get("state") == rec["state"] and p.get("deny") == rec.get("deny") and p.get("tokenAt") == rec.get("tokenAt") \
                and (rec["state"] == "manual" or p.get("message") == rec.get("message")):
            return
        log.append(rec)
        last[rec["video"]] = rec

    def drop(name):
        m = metrics()
        m["videos"].get(name, {}).pop("instagram", None)
        save_metrics(m)

    def stop(kind, why, at):
        nonlocal halt
        msg = {"token": relink, "throttled": f"Instagram şu an istekleri sınırlıyor ({str(why or '')[:90]}); daha sonra yeniden deneyin",
               "offline": f"Instagram'a ulaşılamadı ({str(why or '')[:90]}); daha sonra yeniden deneyin"}[kind]
        halt = (kind, msg, at)

    for i, name in enumerate(names):
        ig = (metrics()["videos"].get(name) or {}).get("instagram") or {}
        if not ig.get("id"):
            kept.append({"name": name, "why": "Instagram'da kaydı yok"})
            continue
        title = title_of(name)[:80]
        item = {"name": name, "title": title, "views": ig.get("views"), "url": ig.get("url")}
        if known:  # API silmiyor: yalnız gönderi hâlâ duruyor mu
            why = {}
            ex = ig_exists(ig, why=why)
            h = ig_halt(why.get("err")) if ex is None else None
            if h in ("token", "throttled"):
                stop(h, graph_reason(why["err"]), i)
                break
            if ex is False:
                drop(name)
                gone.append(item)
                note({"at": now_iso(), "video": name, "title": title, "views": item["views"], "url": item["url"], "ok": True, "state": "gone", "message": "elle silindiği görüldü"})
                print(f"🗑 Instagram: elle silindiği görüldü {name} — \"{title}\"", flush=True)
            elif ex:
                manual.append(item)
                note({"at": now_iso(), "video": name, "title": title, "views": item["views"], "url": item["url"], "ok": False, "state": "manual", "message": "elle silinmeli"})
            else:
                unknown.append(item)
            offline = offline + 1 if h == "offline" else 0
            if offline >= 2:
                stop("offline", graph_reason(why["err"]), i + 1)
                break
            time.sleep(0.2)
            continue
        why = {}
        views = fresh_views(ig, why)
        h = ig_halt(why.get("err"))
        if h in ("token", "throttled"):  # içgörü sorgusu bile reddedildi: silme denenmez
            stop(h, graph_reason(why["err"]), i)
            break
        if views is None:
            views = ig.get("views")
        if views is not None and int(views) >= max_views:
            kept.append({"name": name, "why": f"izlenmesi {views} oldu, silinmedi"})
            print(f"🗑 Instagram: SİLİNMEDİ {name} — izlenmesi {views} ({max_views} sınırını geçti)", flush=True)
            continue
        item["views"] = views
        r = ig_delete(ig)
        rec = {"at": now_iso(), "video": name, "title": title, "views": views, "url": ig.get("url"), "ok": bool(r.get("ok")), "message": r.get("message")}
        if r.get("ok"):
            drop(name)
            if r.get("gone"):
                gone.append(item)
                note({**rec, "state": "gone"})
                print(f"🗑 Instagram: zaten yok {name} — \"{title}\" (kayıt düşürüldü)", flush=True)
            else:
                done.append(rec)
                note({**rec, "state": "deleted"})
                note_support(r)
                works = True
                print(f"🗑 Instagram: silindi {name} — \"{title}\" ({views} izlenme)", flush=True)
        elif r.get("manual"):
            first = False
            if r.get("unsupported"):
                r, first = settle(r, works)
            manual.append(item)
            post = {"deny": "post", "via": conn.get("via"), "tokenAt": conn.get("tokenAt")} if r.get("perPost") else {}
            note({**rec, "message": r.get("message"), "state": "manual", "reason": r.get("reason"), **post})
            if r.get("unsupported"):  # bu bağlantıda silme yok: kaydet, kalanlarda DELETE deneme
                sup_new = first or sup_new
                known, unsupported, via, reason = True, True, r.get("via") or via, r.get("reason")
            elif r.get("perPost"):
                reason = reason or r.get("reason")
        else:
            failed.append({**rec, "token": bool(r.get("token")), "retry": bool(r.get("retry"))})
            note({**rec, "state": "failed"})
            print(f"🗑 Instagram: SİLİNEMEDİ {name} — {r.get('message')}{' · ' + ig.get('url') if ig.get('url') else ''}", flush=True)
            if r.get("halt") in ("token", "throttled"):
                stop(r["halt"], r.get("haltReason"), i + 1)
                break
        offline = offline + 1 if r.get("halt") == "offline" else 0
        if offline >= 2:
            stop("offline", r.get("haltReason"), i + 1)
            break
        time.sleep(1)
    if halt:  # hesabın tamamını etkileyen hata: kalanlar denenmedi (aynı hata tekrar tekrar alınmasın, istek bütçesi yanmasın)
        kind, msg, at = halt
        rest = 0
        for name in names[at:]:
            ig = (metrics()["videos"].get(name) or {}).get("instagram") or {}
            if not ig.get("id"):
                kept.append({"name": name, "why": "Instagram'da kaydı yok"})
                continue
            rest += 1
            failed.append({"at": now_iso(), "video": name, "title": title_of(name)[:80], "views": ig.get("views"), "url": ig.get("url"), "ok": False,
                           "message": msg, "token": kind == "token", "retry": kind != "token", "notTried": True})
        if rest:
            print(f"🗑 Instagram: {msg}; {rest} video bu çalışmada denenmedi", flush=True)
    if manual:
        why = f"API bu bağlantıyla silmeye izin vermiyor ({via})" if unsupported else "API ile silinemedi"
        print(f"🗑 Instagram: {why}; {len(manual)} video elle silinmeli — liste panelde", flush=True)
    save_json(LOG, log[-500:])
    return {"ok": True, "deleted": done, "kept": kept, "failed": failed, "manual": manual, "gone": gone, "unknown": unknown,
            "unsupported": unsupported, "via": via, "reason": reason, "supportNew": sup_new, "verifyOnly": bool(sup.get("known")),
            **({"halt": halt[0]} if halt else {})}


def dups(days: float = 7) -> dict:
    """Instagram'da aynı açıklamayla birden çok gönderi (yayın adımının yinelenmesi; kullanıcı şikâyeti, 23 Ekim: "ikişerli paylaşılmış
    haberler"): hesabın son 200 gönderisi okunur (video/Reels), açıklaması aynı olanlar gruplanır; her grupta EN ESKİ kalır, sonrakiler
    silinecek listeye. Hiçbir şey silmez. {ok, groups: [{title, keep{id,url,at}, dups[{id,url,at}]}], ids, total, scanned}."""
    from publish import _norm_caption, _ts, ig_creds, ig_recent_media
    creds = ig_creds()
    items = ig_recent_media(creds, limit=50, pages=4)
    now = datetime.now(timezone.utc)
    groups: dict = {}
    for m in items:
        ts = _ts(m.get("timestamp"))
        if not ts or now - ts > timedelta(days=days) or m.get("media_type") not in (None, "VIDEO", "REELS"):
            continue
        key = _norm_caption(m.get("caption"))
        if len(key) < 20:
            continue
        groups.setdefault(key, []).append({"id": str(m["id"]), "url": m.get("permalink"), "at": m.get("timestamp")})
    out, ids = [], []
    for key, g in groups.items():
        if len(g) < 2:
            continue
        g.sort(key=lambda x: (x["at"] or "", int(x["id"]) if x["id"].isdigit() else 0))  # en eski kalır; aynı anda en küçük kimlik (ilk yüklenen)
        out.append({"title": key[:80], "keep": g[0], "dups": g[1:]})
        ids += [x["id"] for x in g[1:]]
    out.sort(key=lambda x: x["keep"]["at"] or "", reverse=True)
    return {"ok": True, "groups": out, "ids": ids, "total": len(ids), "scanned": len(items)}


def dups_run(items: list) -> dict:
    """Verilen fazla kopyaları siler: [{id, url, keepId, keepUrl, title}]. Metriklerde Instagram kaydı silinen kopyayı gösteren video kalan
    gönderiye bağlanır. İlk "izin yok" yanıtından sonra DELETE denenmez (elle silinecekler listesi); bağlantı/istek sınırı hatasında durur.
    Sonuç run() ile aynı biçimde: {ok, deleted, failed, manual, via, unsupported, reason}."""
    from publish import ig_conn, ig_creds, ig_delete
    sup = support()
    known = bool(sup.get("known"))
    conn = ig_conn()
    try:
        uid = str(ig_creds()[0])
    except Exception:
        uid = ""
    owner = uid if uid and uid != "me" else None
    via = sup.get("viaName") if known else conn.get("name")
    reason = sup.get("reason") if known else None
    done, failed, manual, unsupported = [], [], [], known
    log = load_json(LOG, [])
    log = [x for x in log if isinstance(x, dict)] if isinstance(log, list) else []
    halt = None
    for it in items:
        mid = str(it.get("id") or "")
        if not mid:
            continue
        title = str(it.get("title") or "")[:80]
        item = {"id": mid, "url": it.get("url"), "title": title, "keepId": it.get("keepId")}
        if halt:
            failed.append({**item, "message": halt, "notTried": True})
            continue
        if known:  # API bu bağlantıyla silmiyor: liste elle silinmek için
            manual.append(item)
            continue
        r = ig_delete({"id": mid, "url": it.get("url"), **({"owner": owner} if owner else {})})
        rec = {"at": now_iso(), "video": f"instagram:{mid}", "title": title, "url": it.get("url"), "ok": bool(r.get("ok")), "message": r.get("message"), "dup": True}
        if r.get("ok"):
            done.append(item)
            log.append({**rec, "state": "gone" if r.get("gone") else "deleted"})
            note_support(r)
            print(f"🗑 Instagram: tekrar kopya silindi — \"{title}\"{' · ' + str(it.get('url')) if it.get('url') else ''}", flush=True)
            # metriklerdeki kayıt silinen kopyayı gösteriyorsa kalan gönderiye bağlanır (izlenme, silme ve ilk yorum doğru gönderide)
            if it.get("keepId"):
                m = metrics()
                for name, v in (m.get("videos") or {}).items():
                    g = v.get("instagram") if isinstance(v, dict) else None
                    if isinstance(g, dict) and str(g.get("id")) == mid:
                        g.update({"id": str(it["keepId"]), **({"url": it["keepUrl"]} if it.get("keepUrl") else {})})
                        print(f"🗑 Instagram: {name} kaydı kalan gönderiye bağlandı", flush=True)
                save_metrics(m)
        elif r.get("manual"):
            manual.append(item)
            log.append({**rec, "state": "manual", "reason": r.get("reason")})
            if r.get("unsupported"):
                note_support(r)
                known, unsupported, via, reason = True, True, r.get("via") or via, r.get("reason")
        else:
            failed.append({**item, "message": r.get("message"), "token": bool(r.get("token")), "retry": bool(r.get("retry"))})
            log.append({**rec, "state": "failed"})
            print(f"🗑 Instagram: tekrar kopya SİLİNEMEDİ — {r.get('message')}", flush=True)
            if r.get("halt") in ("token", "throttled"):
                halt = r.get("message")
        time.sleep(1)
    if manual:
        print(f"🗑 Instagram: {len(manual)} tekrar kopya elle silinmeli — liste panelde", flush=True)
    save_json(LOG, log[-100:])
    return {"ok": True, "deleted": done, "failed": failed, "manual": manual, "via": via, "unsupported": unsupported, "reason": reason}


if __name__ == "__main__":
    a = sys.argv

    def arg(k, d):
        return a[a.index(k) + 1] if k in a and len(a) > a.index(k) + 1 else d
    try:
        if "--support" in a:
            res = {"ok": True, **support()}
        elif "--auto-plan" in a:
            res = auto_plan(int(arg("--max", 5000)), float(arg("--wait-hours", 72)), float(arg("--max-age-days", 30)),
                            [x for x in arg("--keep", "").split(",") if x])
        elif "--run" in a:
            res = run([x for x in arg("--names", "").split(",") if x], int(arg("--max", 1000)))
        elif "--dups-run" in a:  # fazla kopyalar: --json '[{"id","url","keepId","keepUrl","title"}]'
            res = dups_run(json.loads(arg("--json", "[]")))
        elif "--dups" in a:
            res = dups(float(arg("--days", 7)))
        else:
            res = plan(float(arg("--days", 7)), int(arg("--max", 1000)), float(arg("--min-age-hours", 0)))
    except Exception as e:
        res = {"ok": False, "error": str(e)[:300]}
    print(json.dumps(res, ensure_ascii=False))
