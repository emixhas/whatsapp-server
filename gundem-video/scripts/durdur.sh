#!/usr/bin/env bash
# Tek komutla sistemi durdur: `npm run durdur` (paneldeki ⏸ Tüm sistemi durdur ile aynı; panel açık kalır).
# Paneli de kapatmak için: `npm run durdur -- panel`
cd "$(dirname "$0")/.."
PORT="${PANEL_PORT:-3131}"; URL="http://localhost:$PORT"
if curl -sf -m 2 "$URL/api/rest" >/dev/null; then
  curl -s -m 30 -X POST -H 'content-type: application/json' -d '{"on":true}' "$URL/api/rest" | python3 -c 'import json,sys
d=json.load(sys.stdin); r=d.get("rest") or {}
import time; u=r.get("until")
print("⏸ Sistem durduruldu: %d arka plan süreci kapatıldı. %s" % (len(d.get("killed") or []), ("Sıradaki planlı iş " + time.strftime("%H:%M", time.localtime(u/1000)) + ".") if u else "Siz başlatana kadar bekler."))'
else
  echo "Panel kapalı; durdurulacak bir şey yok."
fi
if [ "$1" = "panel" ]; then
  SERVICE="$HOME/Library/LaunchAgents/com.gundem.panel.plist"
  if [ -f "$SERVICE" ]; then launchctl unload "$SERVICE" 2>/dev/null && echo "■ Panel servisi kapatıldı (yeniden: npm run basla)"; fi
  pkill -f "node app/server.js" 2>/dev/null && echo "■ Panel kapatıldı" || true
  [ -f "$HOME/Library/LaunchAgents/com.gundem.video.plist" ] && echo "Not: 5 saatlik zamanlayıcı açık; planlı üretim panel kapalıyken de çalışır (kapatmak için panelde zamanlayıcıyı kapatın)."
fi
