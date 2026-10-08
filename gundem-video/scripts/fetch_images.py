#!/usr/bin/env python3
"""Senaryodaki haber görsellerini indirir (yalnızca RSS'in verdiği URL), ölçekler ve episode.json'a yazar.
Kullanım: python3 scripts/fetch_images.py public/episode.json
"""
import json
import ssl
import subprocess
import sys
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import ROOT  # noqa: E402

try:
    import certifi
    CTX = ssl.create_default_context(cafile=certifi.where())
except ImportError:
    CTX = ssl.create_default_context()

ep_path = Path(sys.argv[1])
ep = json.loads(ep_path.read_text(encoding="utf-8"))
out_dir = ROOT / "public" / "images"
out_dir.mkdir(parents=True, exist_ok=True)
for f in out_dir.glob("seg-*.jpg"):
    f.unlink()
n = 0
for i, seg in enumerate(ep["segments"]):
    url = seg.get("imageUrl")
    if not url:
        continue
    raw = out_dir / f"seg-{i:02d}.raw"
    dst = out_dir / f"seg-{i:02d}.jpg"
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (gundem-video)"})
        with urllib.request.urlopen(req, timeout=20, context=CTX) as r:
            raw.write_bytes(r.read(12 * 1024 * 1024))
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(raw), "-vf",
                        "scale=1840:1120:force_original_aspect_ratio=increase,crop=1840:1120", "-q:v", "3", str(dst)], check=True)
        seg["image"] = f"images/{dst.name}"
        n += 1
    except Exception as e:
        print(f"  ! görsel alınamadı ({url[:60]}): {e}", file=sys.stderr)
    finally:
        raw.unlink(missing_ok=True)
ep_path.write_text(json.dumps(ep, ensure_ascii=False, indent=2), encoding="utf-8")
print(f"{n} haber görseli hazır")
