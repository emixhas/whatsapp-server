#!/usr/bin/env python3
"""Üretim bittikten sonra: ayarlara göre otomatik yayınla ve analizi tazele. pipeline.sh çağırır.

Hangi platformlara yayın: settings.autopublish içinde açık olanlar. Anlık (son dakika) videoda
settings.anlikAutoPublish açıksa (varsayılan) bağlı TÜM hesaplara da onaysız yayınlanır.
Hiçbir yere yayınlanmıyorsa nedeni loga açıkça yazılır.
"""
import json
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import ROOT, episode_meta, settings  # noqa: E402

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
for plat in plats:
    r = subprocess.run([sys.executable, str(ROOT / "scripts/publish.py"), "--file", video, "--platform", plat], capture_output=True, text=True)
    for line in r.stderr.strip().splitlines():
        if line.startswith(("🌐", "  video", "  geçici", "  !")):
            print(line)
    last = r.stdout.strip().splitlines()[-1] if r.stdout.strip() else r.stderr.strip()[-300:]
    try:
        j = json.loads(last)
        print(f"📤 {plat}: " + (("zaten yayında " if j.get("skipped") else "tamam ") + (j.get("url") or j.get("note") or "") if j.get("ok") else "hata " + str(j.get("error"))))
    except Exception:
        print(f"📤 {plat}: hata {last}")
subprocess.run([sys.executable, str(ROOT / "scripts/analyze.py")], capture_output=True)
print(json.dumps({"autopublish": plats, "kind": kind}, ensure_ascii=False))
