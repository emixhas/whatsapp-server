#!/usr/bin/env python3
"""Üretim bittikten sonra: ayarlara göre otomatik yayınla ve analizi tazele. pipeline.sh çağırır.

Hangi platformlara yayın: settings.autopublish içinde açık olanlar; ayrıca
  - otomatik üretim (zamanlayıcı) açıksa ya da settings.autoMode (tam otomatik) açıksa bağlı TÜM hesaplar,
  - anlık (son dakika) videoda settings.anlikAutoPublish açıksa (varsayılan) bağlı TÜM hesaplar.
Bağlı hesaplar yayın anında okunur; sonradan bağlanan hesap da otomatik dahil olur.
Hiçbir yere yayınlanmıyorsa nedeni loga açıkça yazılır.
"""
import json
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import ROOT, episode_meta, settings  # noqa: E402

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


def targets(video: str, s: dict) -> tuple[list, str]:
    ap = s.get("autopublish", {}) or {}
    chosen = [p for p in PLATFORMS if ap.get(p)]
    meta = episode_meta(Path(video).name) or {}
    anlik = meta.get("anlik") or meta.get("format") == "anlik"
    conn = connected()
    auto_all = schedule_enabled() or bool(s.get("autoMode"))
    if auto_all:
        extra = [p for p in conn if p not in chosen]
        if extra:
            print(f"🤖 otomatik mod açık: bağlı tüm hesaplarda paylaşılıyor ({', '.join(chosen + extra)})")
        chosen += extra
    if anlik and s.get("anlikAutoPublish", True):
        extra = [p for p in conn if p not in chosen]
        if extra:
            print(f"⚡ anlık haber: bağlı tüm hesaplarda otomatik paylaşılıyor ({', '.join(chosen + extra)})")
        chosen += extra
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


video = sys.argv[1]
s = settings()
plats, kind, why = targets(video, s)
if not plats:
    print(f"📤 otomatik yayın yapılmadı: {why}. WhatsApp'tan \"onay\" yazarak ya da panelden yayınlayabilirsiniz.")
def publish(plat: str) -> bool:
    r = subprocess.run([sys.executable, str(ROOT / "scripts/publish.py"), "--file", video, "--platform", plat], capture_output=True, text=True)
    for line in r.stderr.strip().splitlines():
        if line.startswith(("🌐", "  video", "  geçici", "  !")):
            print(line, flush=True)
    last = r.stdout.strip().splitlines()[-1] if r.stdout.strip() else r.stderr.strip()[-300:]
    try:
        j = json.loads(last)
    except Exception:
        print(f"📤 {plat}: hata {last}", flush=True)
        return False
    print(f"📤 {plat}: " + (("zaten yayında " if j.get("skipped") else "tamam ") + (j.get("url") or j.get("note") or "") if j.get("ok") else "hata " + str(j.get("error"))), flush=True)
    return bool(j.get("ok"))


failed = [p for p in plats if not publish(p)]
if failed:
    # geçici hatalar (Instagram "medya hazır değil", ağ kopması) için 90 sn sonra bir kez daha denenir
    print(f"📤 tekrar denenecek (90 sn sonra): {', '.join(failed)}", flush=True)
    time.sleep(90)
    failed = [p for p in failed if not publish(p)]
    if failed:
        print(f"📤 yayınlanamadı: {', '.join(failed)}. WhatsApp'tan \"onay\" yazarak ya da panelden tekrar deneyebilirsiniz.", flush=True)
subprocess.run([sys.executable, str(ROOT / "scripts/analyze.py")], capture_output=True)
print(json.dumps({"autopublish": plats, "kind": kind}, ensure_ascii=False))
