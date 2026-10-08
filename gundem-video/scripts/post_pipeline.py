#!/usr/bin/env python3
"""Üretim bittikten sonra: ayarlara göre otomatik yayınla ve analizi tazele. pipeline.sh çağırır."""
import json
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import ROOT, settings  # noqa: E402

video = sys.argv[1]
s = settings()
for plat, on in s.get("autopublish", {}).items():
    if not on:
        continue
    r = subprocess.run([sys.executable, str(ROOT / "scripts/publish.py"), "--file", video, "--platform", plat], capture_output=True, text=True)
    for line in r.stderr.strip().splitlines():
        if line.startswith(("🌐", "  video", "  geçici", "  !")):
            print(line)
    last = r.stdout.strip().splitlines()[-1] if r.stdout.strip() else r.stderr.strip()[-300:]
    try:
        j = json.loads(last)
        print(f"📤 {plat}: " + ("tamam " + (j.get("url") or j.get("note") or "") if j.get("ok") else "hata " + str(j.get("error"))))
    except Exception:
        print(f"-- yayın {plat}: {last}")
subprocess.run([sys.executable, str(ROOT / "scripts/analyze.py")], capture_output=True)
print(json.dumps({"autopublish": s.get("autopublish", {})}, ensure_ascii=False))
