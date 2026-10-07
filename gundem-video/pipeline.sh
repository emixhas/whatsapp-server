#!/usr/bin/env bash
# Tek komutla bir bölüm üretir: haber çek -> Claude senaryo -> yerel TTS -> Remotion render.
# Kullanım: bash pipeline.sh          (normal)
#           TTS_ENGINE=silent bash pipeline.sh   (sessiz test)
#           SKIP_CLAUDE=1 bash pipeline.sh       (work/claude_out.json hazırsa Claude'u atla)
set -euo pipefail
cd "$(dirname "$0")"
export PATH="$PWD/.venv/bin:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
# .venv varsa onun Python'u (piper orada kurulu), yoksa sistem python3
PY="python3"; [ -x ".venv/bin/python3" ] && PY=".venv/bin/python3"
command -v claude >/dev/null || { echo "HATA: 'claude' komutu bulunamadı. Claude Code kurulu ve PATH'te olmalı."; exit 1; }
command -v ffmpeg >/dev/null || { echo "HATA: ffmpeg bulunamadı (brew install ffmpeg)."; exit 1; }
mkdir -p work out public/audio
LOG="work/pipeline-$(date +%Y%m%d-%H%M%S).log"
exec > >(tee -a "$LOG") 2>&1
echo "== $(date '+%Y-%m-%d %H:%M:%S') üretim başladı"

echo "-- 1/4 haberler"
$PY scripts/fetch_news.py work/news.json

echo "-- 2/4 senaryo (Claude)"
if [ "${SKIP_CLAUDE:-0}" != "1" ]; then
  { cat prompts/senaryo.md; cat work/news.json; } | claude -p --output-format text > work/claude_out.json
fi
$PY scripts/assemble_script.py work/claude_out.json work/script.json

echo "-- 3/4 seslendirme"
$PY scripts/tts.py work/script.json public/episode.json

echo "-- 4/4 render"
DATE=$($PY -c "import json;print(json.load(open('public/episode.json'))['date'])")
N=$($PY -c "import json;print(json.load(open('public/episode.json'))['episodeOfDay'])")
OUT="out/${DATE}-${N}.mp4"
npx remotion render src/index.ts GundemVideo "$OUT" --codec h264 --crf 18 --log error
cp public/episode.json "out/${DATE}-${N}.json"
echo "== bitti: $OUT ($(du -h "$OUT" | cut -f1))"
