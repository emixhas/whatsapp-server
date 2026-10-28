#!/usr/bin/env python3
"""Süresi geçen videoları YouTube'da liste dışı yap (kullanıcı kararı: eski bilgi taşıyan video kanala eksi yazar).

Liste dışı (unlisted) video silinmez: linki olan izler, istatistikleri kalır; ama önerilerde, aramada ve kanal sayfasında
görünmez. Oynatma listelerinden de çıkarılır (herkese açık listede görünmesin). Geri alınabilir (`--restore`).

Ne zaman (`settings.expire` {enabled, piyasaDays 2, alarmDays 2, takvimDays 2, meteoDays 2, newsDays 0}):
  - meta `expiresAt` varsa o an (şablon videolar yazar: piyasa ve zam/rekor yayından 2 gün sonra, takvim olay günü bitince,
    meteoroloji uyarısı bitince),
  - yoksa (eski videolar) türüne göre yayından N gün sonra: piyasa / alarm / takvim / meteo,
  - diğer haberler yalnız `newsDays` > 0 ise o kadar gün sonra (deprem, maç sonucu, derleme ve uzun özetler hariç).
Instagram ve TikTok API'si gönderi gizlemeye izin vermez; yalnız YouTube.

  python3 scripts/expire_videos.py --check        # süresi geçenleri liste dışı yap ("🙈" satırları + JSON)
  python3 scripts/expire_videos.py --dry-run      # yalnız listele
  python3 scripts/expire_videos.py --restore all  # liste dışı yaptıklarımızı yeniden herkese açık yap (ya da video adı)
"""
import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import episode_meta, metrics, now_iso, save_metrics, settings  # noqa: E402

KEEP = ("deprem", "mac", "derleme")  # olgu: eskise de doğru kalır
LONG = ("gunluk", "haftalik")


def cfg() -> dict:
    return {"enabled": True, "piyasaDays": 2, "alarmDays": 2, "takvimDays": 2, "meteoDays": 2, "newsDays": 0, **(settings().get("expire") or {})}


def _dt(s):
    try:
        d = datetime.fromisoformat(str(s).replace("Z", "+00:00"))
        return d if d.tzinfo else d.replace(tzinfo=timezone.utc)
    except Exception:
        return None


def expiry(name: str, yt: dict, c: dict):
    """(zaman, neden) ya da (None, None)."""
    meta = episode_meta(name) or {}
    kind = meta.get("infoKind") or ""
    if meta.get("expiresAt") and _dt(meta["expiresAt"]):
        return _dt(meta["expiresAt"]), {"piyasa": "piyasa kartı eskidi", "alarm": "fiyat bilgisi eskidi", "takvim": "takvim günü geçti",
                                        "meteo": "uyarı süresi bitti"}.get(kind, "süresi doldu")
    pub = _dt(yt.get("publishedAt"))
    if not pub:
        return None, None
    days = {"piyasa": c["piyasaDays"], "alarm": c["alarmDays"], "takvim": c["takvimDays"], "meteo": c["meteoDays"]}.get(kind)
    if days:
        return pub + timedelta(days=float(days)), f"{kind} videosu {days} günlük"
    if float(c.get("newsDays") or 0) > 0 and kind not in KEEP and meta.get("format") not in LONG:
        return pub + timedelta(days=float(c["newsDays"])), f"haber {c['newsDays']} günden eski"
    return None, None


def due() -> list:
    c = cfg()
    now = datetime.now(timezone.utc)
    out = []
    for name, v in metrics()["videos"].items():
        yt = v.get("youtube") or {}
        if not yt.get("id") or yt.get("unlistedAt"):
            continue
        when, why = expiry(name, yt, c)
        if when and now >= when:
            meta = episode_meta(name) or {}
            out.append({"name": name, "id": yt["id"], "why": why, "title": (meta.get("publishTitle") or yt.get("title") or name)[:80]})
    return out


def _playlists_remove(yt, vid: str) -> int:
    from publish import PLAYLIST_FILE
    from common import load_json
    n = 0
    for pid in (load_json(PLAYLIST_FILE, {}) or {}).values():
        try:
            for it in yt.playlistItems().list(part="id", playlistId=pid, videoId=vid, maxResults=5).execute().get("items", []):
                yt.playlistItems().delete(id=it["id"]).execute()
                n += 1
        except Exception:
            continue
    return n


def set_privacy(yt, vid: str, status: str, name: str = "") -> None:
    """Gizlilik değişir, gerisi kalır: part=status güncellemesi bu bölümün bütün değiştirilebilir alanlarını yazar (yazılmayan silinir), bu
    yüzden önce videonun mevcut durumu okunur (inceleme, 28 Ekim: liste dışı yapılan ya da geri açılan yapay zekâ görselli videonun
    "değiştirilmiş ya da yapay içerik" beyanı — containsSyntheticMedia — siliniyordu). Okunamazsa meta'daki aiVisuals'tan."""
    cur = {}
    try:
        items = yt.videos().list(part="status", id=vid).execute().get("items") or []
        cur = (items[0].get("status") or {}) if items else {}
    except Exception:  # okunamadı: eski davranış + yapay içerik beyanı meta'dan
        cur = {"containsSyntheticMedia": True} if (episode_meta(name) or {}).get("aiVisuals") else {}
    keep = {k: cur[k] for k in ("embeddable", "license", "publicStatsViewable", "containsSyntheticMedia") if k in cur}
    yt.videos().update(part="status", body={"id": vid, "status": {**keep, "privacyStatus": status, "selfDeclaredMadeForKids": False}}).execute()


def check(dry: bool = False) -> dict:
    if cfg().get("enabled") is False:
        return {"ok": True, "skipped": "kapalı", "done": []}
    todo = due()
    if dry or not todo:
        return {"ok": True, "due": todo, "done": []}
    from publish import YT_MANAGE, yt_scopes, yt_service
    if not (yt_scopes() & YT_MANAGE):
        return {"ok": False, "error": "YouTube'da video düzenleme izni yok: Ayarlar → YouTube → 🔄 Yeniden bağla", "due": todo}
    yt = yt_service()
    done, failed = [], []
    for it in todo[:20]:  # kota: video başına ~50-150 birim
        try:
            set_privacy(yt, it["id"], "unlisted", it["name"])
            pl = _playlists_remove(yt, it["id"])
            m = metrics()
            m["videos"][it["name"]]["youtube"].update({"unlistedAt": now_iso(), "unlistReason": it["why"]})
            save_metrics(m)
            done.append(it)
            print(f"🙈 YouTube: liste dışı yapıldı {it['name']} — \"{it['title']}\" ({it['why']}{f', {pl} oynatma listesinden çıkarıldı' if pl else ''})", flush=True)
        except Exception as e:
            msg = str(e)
            if "videoNotFound" in msg or "404" in msg:
                m = metrics()
                m["videos"][it["name"]]["youtube"]["unlistedAt"] = now_iso()  # YouTube'da yok: bir daha denenmesin
                save_metrics(m)
            failed.append({**it, "error": msg[:160]})
            print(f"🙈 YouTube: liste dışı yapılamadı {it['name']} — {msg[:120]}", flush=True)
    return {"ok": True, "done": done, "failed": failed, "left": max(0, len(todo) - 20)}


def restore(which: str) -> dict:
    from publish import yt_add_to_playlists, yt_service
    m = metrics()
    names = [n for n, v in m["videos"].items() if (v.get("youtube") or {}).get("unlistedAt") and (which == "all" or n == which)]
    if not names:
        return {"ok": True, "done": []}
    yt = yt_service()
    done = []
    for n in names:
        y = m["videos"][n]["youtube"]
        try:
            set_privacy(yt, y["id"], "public", n)
            yt_add_to_playlists(yt, y["id"], episode_meta(n) or {})
            y.pop("unlistedAt", None)
            y.pop("unlistReason", None)
            done.append(n)
            print(f"🙈 YouTube: yeniden herkese açık {n}", flush=True)
        except Exception as e:
            print(f"🙈 YouTube: herkese açık yapılamadı {n} — {str(e)[:120]}", flush=True)
    save_metrics(m)
    return {"ok": True, "done": done}


if __name__ == "__main__":
    a = sys.argv
    try:
        if "--restore" in a:
            res = restore(a[a.index("--restore") + 1] if len(a) > a.index("--restore") + 1 else "all")
        elif "--list" in a:
            res = {"ok": True, "unlisted": [{"name": n, "why": v["youtube"].get("unlistReason"), "at": v["youtube"]["unlistedAt"]}
                                             for n, v in metrics()["videos"].items() if (v.get("youtube") or {}).get("unlistedAt")]}
        else:
            res = check(dry="--dry-run" in a)
    except Exception as e:
        res = {"ok": False, "error": str(e)[:300]}
    print(json.dumps(res, ensure_ascii=False))
