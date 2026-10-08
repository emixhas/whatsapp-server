#!/usr/bin/env python3
"""İki kapak (A: haberci, B: merak) render eder: <base>-kapakA.jpg, <base>-kapakB.jpg. Seçilen varyant <base>-kapak.jpg.
Kullanım: python3 scripts/render_thumbs.py public/episode.json out/2026-10-08-1
"""
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import ROOT, settings  # noqa: E402

ep = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
base = sys.argv[2]
haber = [x for x in ep["segments"] if x.get("kind") == "haber"]
first = haber[0] if haber else {}
titles = ep.get("titles", {})
for v in ("A", "B"):
    text = titles.get("cover") if v == "A" else titles.get("B", titles.get("cover", ""))
    props = {"text": text or first.get("title", ""), "category": first.get("category"), "breaking": bool(first.get("breaking")),
             "image": first.get("image"), "variant": v, "channel": settings()["channelName"].upper(),
             "dayLabel": ep.get("dayLabel"), "slotLabel": ep.get("slotLabel"), "timeRange": ep.get("timeRange")}
    out = f"{base}-kapak{v}.jpg"
    r = subprocess.run(["npx", "remotion", "still", "src/index.ts", "Thumb", out, "--props", json.dumps(props, ensure_ascii=False), "--log", "error"] + (["--browser-executable", os.environ["PUPPETEER_EXECUTABLE_PATH"], "--chrome-mode=chrome-for-testing"] if os.environ.get("PUPPETEER_EXECUTABLE_PATH") else []),
                       cwd=ROOT, capture_output=True, text=True)
    if r.returncode != 0:
        print(f"  ! kapak {v} hatası: {r.stderr[-300:]}", file=sys.stderr)
chosen = f"{base}-kapak{ep.get('titleVariant', 'A')}.jpg"
if Path(chosen).exists():
    shutil.copy(chosen, f"{base}-kapak.jpg")
print(f"kapaklar hazır (seçilen varyant {ep.get('titleVariant', 'A')}: {ep.get('publishTitle', '')})")
