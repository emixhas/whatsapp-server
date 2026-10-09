#!/usr/bin/env bash
# Tek komutla bir bölüm üretir: haber çek -> Claude senaryo -> yerel TTS -> Remotion render.
# Kullanım: bash pipeline.sh          (normal, 30 sn)
#           DURATION=60 bash pipeline.sh         (60 saniyelik video)
#           TTS_ENGINE=silent bash pipeline.sh   (sessiz test)
#           SKIP_CLAUDE=1 bash pipeline.sh       (work/claude_out.json hazırsa Claude'u atla)
set -euo pipefail
cd "$(dirname "$0")"
export PATH="$PWD/.venv/bin:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
# .venv varsa onun Python'u (piper orada kurulu), yoksa sistem python3
PY="python3"; [ -x ".venv/bin/python3" ] && PY=".venv/bin/python3"
# Arka plan servisi kullanıcının kabuk ayarlarını yüklemez; Claude Code bilinen kurulum yerlerinde aranır
CLAUDE="$(bash scripts/find_claude.sh)" || { echo "HATA: 'claude' komutu bulunamadı. Terminalde 'which claude' çıktısını secrets/.env içine CLAUDE_BIN=... olarak yazın."; exit 1; }
export PATH="$(dirname "$CLAUDE"):$PATH"
command -v ffmpeg >/dev/null || { echo "HATA: ffmpeg bulunamadı (brew install ffmpeg)."; exit 1; }
# Format: FORMAT=sabah|ogle|aksam|ozel. Verilmezse saate göre seçilir; DURATION verilmezse formatın süresi.
FMT_JSON=$($PY -c "import json,sys;sys.path.insert(0,'scripts');from common import pick_format,settings;k,f=pick_format();import os;k=os.environ.get('FORMAT') or k;f=settings()['formats'].get(k) or {'duration':30,'label':'Gündem','intro':'Türkiye gündemi, günün özeti.','tone':'tarafsız'};print(json.dumps({'key':k,**f},ensure_ascii=False))")
FORMAT="${FORMAT:-$(echo "$FMT_JSON" | $PY -c "import json,sys;print(json.load(sys.stdin)['key'])")}"
FORMAT_LABEL=$(echo "$FMT_JSON" | $PY -c "import json,sys;print(json.load(sys.stdin)['label'])")
FORMAT_INTRO=$(echo "$FMT_JSON" | $PY -c "import json,sys;print(json.load(sys.stdin)['intro'])")
FORMAT_TONE=$(echo "$FMT_JSON" | $PY -c "import json,sys;print(json.load(sys.stdin)['tone'])")
DURATION="${DURATION:-$(echo "$FMT_JSON" | $PY -c "import json,sys;print(json.load(sys.stdin)['duration'])")}"
export FORMAT FORMAT_LABEL
WORDS=$(( DURATION * 24 / 10 ))          # ~150 kelime/dk temposunda sığan kelime
HABER=$(( DURATION / 8 )); [ "$HABER" -lt 2 ] && HABER=2; [ "$HABER" -gt 12 ] && HABER=12
export DURATION WORDS HABER
# Senaryo için "medium" yeterli (ölçüldü: aynı 7 haber/kategori, çıktı tokenı high'ın yarısı).
# Claude modeli: settings.claudeModel ("opus" varsayılan; boşsa Claude Code'un kendi varsayılanı)
CLAUDE_MODEL="${CLAUDE_MODEL-$($PY -c "import json;print(json.load(open('data/settings.json')).get('claudeModel','opus') or '')" 2>/dev/null || echo opus)}"
MODEL_ARGS=(); [ -n "$CLAUDE_MODEL" ] && MODEL_ARGS=(--model "$CLAUDE_MODEL")
CLAUDE_EFFORT="${CLAUDE_EFFORT:-$($PY -c "import json;e=json.load(open('data/settings.json')).get('claudeEffort','medium');print(e.get('script','medium') if isinstance(e,dict) else e)" 2>/dev/null || echo medium)}"
export CLAUDE_EFFORT
mkdir -p work out public/audio
# Tek seferde tek üretim: launchd ve panel çakışmasın. mkdir atomik olduğu için kilit olarak kullanılır.
LOCK="work/pipeline.lock"
if ! mkdir "$LOCK" 2>/dev/null; then
  if [ -f "$LOCK/pid" ] && kill -0 "$(cat "$LOCK/pid")" 2>/dev/null; then
    echo "!! başka bir üretim sürüyor (pid $(cat "$LOCK/pid")); bu çalıştırma atlandı"; exit 3
  fi
  echo "!! eski kilit bulundu, temizleniyor"; rm -rf "$LOCK"; mkdir "$LOCK"
fi
echo $$ > "$LOCK/pid"
RESERVED=""
cleanup() { rm -rf "$LOCK"; [ -n "$RESERVED" ] && rm -f "$RESERVED"; }
trap cleanup EXIT
LOG="work/pipeline-$(date +%Y%m%d-%H%M%S).log"
exec > >(tee -a "$LOG") 2>&1
echo "== $(date '+%Y-%m-%d %H:%M:%S') üretim başladı (format ${FORMAT} · ${FORMAT_LABEL}, hedef ${DURATION} sn, ${HABER} haber, ≤${WORDS} kelime)"

echo "-- 1/4 haberler"
$PY scripts/fetch_news.py work/news.json

echo "-- 2/4 senaryo (Claude)"
if [ "${SKIP_CLAUDE:-0}" != "1" ]; then
  HINT="Henüz performans verisi yok."; [ -f data/prompt_hint.txt ] && HINT=$(tr '\n' ' ' < data/prompt_hint.txt | sed 's/[&/\]/\\&/g')
  # Claude'a yalnızca gerekli alanlar gider: en yeni NEWS_MAX haber, kısa özet, link yok (token tasarrufu)
  $PY scripts/slim_news.py work/news.json work/news_prompt.json "${NEWS_MAX:-50}"
  { sed -e "s/__SURE__/$DURATION/g" -e "s/__KELIME__/$WORDS/g" -e "s/__HABER__/$HABER/g" -e "s|__IPUCU__|$HINT|g" -e "s|__FORMAT_ADI__|$FORMAT_LABEL|g" -e "s|__FORMAT_INTRO__|$FORMAT_INTRO|g" -e "s|__FORMAT_TON__|$FORMAT_TONE|g" prompts/senaryo.md; cat work/news_prompt.json; } \
    | "$CLAUDE" -p ${MODEL_ARGS[@]+"${MODEL_ARGS[@]}"} --effort "${CLAUDE_EFFORT:-medium}" --output-format json > work/claude_raw.json 2> work/claude_stderr.log || { echo "  ! senaryo adımı hata verdi (Claude):"; tail -n 5 work/claude_stderr.log; $PY -c "import json;print('  ',json.load(open('work/claude_raw.json')).get('result',''))" 2>/dev/null; echo "  Claude oturumu kapalıysa terminalde 'claude' yazıp /login yapın."; exit 1; }
  $PY scripts/claude_result.py work/claude_raw.json work/claude_out.json senaryo
fi
$PY scripts/assemble_script.py work/claude_out.json work/script.json
# Bölüm adını hemen rezerve et: aynı anda başlayan ikinci üretim aynı numarayı alamaz
RESERVED="out/$($PY -c "import json;d=json.load(open('work/script.json'));print(d['date']+'-'+str(d['episodeOfDay']))").reserved"
touch "$RESERVED"

echo "-- 3/4 seslendirme"
$PY scripts/tts.py work/script.json public/episode.json

echo "-- görseller"
$PY scripts/fetch_images.py public/episode.json || echo "  ! görsel adımı atlandı"

echo "-- 4/4 render"
DATE=$($PY -c "import json;print(json.load(open('public/episode.json'))['date'])")
N=$($PY -c "import json;print(json.load(open('public/episode.json'))['episodeOfDay'])")
OUT="out/${DATE}-${N}.mp4"
if [ -f "$OUT" ]; then echo "!! $OUT zaten var, üzerine yazılmıyor"; N=$(( $(ls out/${DATE}-*.mp4 2>/dev/null | wc -l) + 1 )); OUT="out/${DATE}-${N}.mp4"; $PY -c "import json;p='public/episode.json';d=json.load(open(p));d['episodeOfDay']=$N;json.dump(d,open(p,'w'),ensure_ascii=False,indent=2)"; fi
npx remotion render src/index.ts GundemVideo "work/render.mp4" --codec h264 --crf 18 --log error
# Ses seviyesini YouTube standardına getir (-14 LUFS, tepe -1 dB); görüntüye dokunmaz
ffmpeg -y -loglevel error -i work/render.mp4 -c:v copy -af "loudnorm=I=-14:TP=-1:LRA=7" -c:a aac -b:a 192k "$OUT"
rm -f work/render.mp4
cp public/episode.json "out/${DATE}-${N}.json"
echo "-- kapaklar"
$PY scripts/render_thumbs.py public/episode.json "out/${DATE}-${N}" || echo "  ! kapak adımı atlandı"
echo "== bitti: $OUT ($(du -h "$OUT" | cut -f1))"
echo "-- yayın ve analiz"
$PY scripts/post_pipeline.py "$OUT" || echo "  ! yayın/analiz adımı hata verdi (video hazır)"
