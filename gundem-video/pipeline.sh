#!/usr/bin/env bash
# Tek komutla bir bölüm üretir: haber çek -> Claude senaryo -> yerel TTS -> Remotion render.
# Kullanım: bash pipeline.sh          (normal)
#           TTS_ENGINE=silent bash pipeline.sh   (sessiz test)
#           SKIP_CLAUDE=1 bash pipeline.sh       (work/claude_out.json hazırsa Claude'u atla)
set -euo pipefail
cd "$(dirname "$0")"
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
mkdir -p work out public/audio
LOG="work/pipeline-$(date +%Y%m%d-%H%M%S).log"
exec > >(tee -a "$LOG") 2>&1
echo "== $(date '+%Y-%m-%d %H:%M:%S') üretim başladı"

echo "-- 1/4 haberler"
python3 scripts/fetch_news.py work/news.json

echo "-- 2/4 senaryo (Claude)"
if [ "${SKIP_CLAUDE:-0}" != "1" ]; then
  { cat prompts/senaryo.md; cat work/news.json; } | claude -p --output-format text > work/claude_out.json
fi
python3 scripts/assemble_script.py work/claude_out.json work/script.json

echo "-- 3/4 seslendirme"
python3 scripts/tts.py work/script.json public/episode.json

echo "-- 4/4 render"
DATE=$(python3 -c "import json;print(json.load(open('public/episode.json'))['date'])")
N=$(python3 -c "import json;print(json.load(open('public/episode.json'))['episodeOfDay'])")
OUT="out/${DATE}-${N}.mp4"
npx remotion render src/index.ts GundemVideo "$OUT" --codec h264 --crf 18 --log error
cp public/episode.json "out/${DATE}-${N}.json"
echo "== bitti: $OUT ($(du -h "$OUT" | cut -f1))"
