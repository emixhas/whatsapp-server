#!/usr/bin/env bash
# Tek komutla panel + sistem: `npm run basla`
#  - panel açıksa: sistemi dinlenmeden çıkarır (▶ Sistemi başlat ile aynı)
#  - panel servisi kuruluysa (install_panel_service.sh): servisi başlatır
#  - değilse: paneli bu terminalde açar (Ctrl+C paneli kapatır)
# Her durumda sistem çalışır halde açılır ve tarayıcıda panel açılır.
cd "$(dirname "$0")/.."
PORT="${PANEL_PORT:-3131}"; URL="http://localhost:$PORT"
wake() { curl -s -m 5 -X POST -H 'content-type: application/json' -d '{"on":false}' "$URL/api/rest" >/dev/null; }
if curl -s -m 2 "$URL/api/rest" >/dev/null; then
  wake; echo "✔ Panel zaten açık, sistem başlatıldı: $URL"; open "$URL" 2>/dev/null || true; exit 0
fi
# panel kapalı: durdurulmuş olarak kaydedilen dinlenme kaldırılır, panel çalışır halde açılır
mkdir -p data && printf '{"on": false, "endedWhy": "terminalden başlatıldı"}\n' > data/rest.json
SERVICE="$HOME/Library/LaunchAgents/com.gundem.panel.plist"
if [ -f "$SERVICE" ]; then
  launchctl load "$SERVICE" 2>/dev/null || true
  launchctl kickstart -k "gui/$(id -u)/com.gundem.panel" 2>/dev/null || true
  for _ in $(seq 1 30); do curl -s -m 2 "$URL/api/rest" >/dev/null && break; sleep 1; done
  echo "✔ Panel servisi ve sistem başlatıldı: $URL (log: work/panel.log)"; open "$URL" 2>/dev/null || true; exit 0
fi
echo "▶ Panel açılıyor: $URL  (kapatmak için Ctrl+C)"
( for _ in $(seq 1 30); do curl -s -m 2 "$URL/api/rest" >/dev/null && { open "$URL" 2>/dev/null || true; break; }; sleep 1; done ) &
exec bash scripts/panel.sh
