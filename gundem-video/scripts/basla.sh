#!/usr/bin/env bash
# Tek komutla panel + sistem: `npm run basla` (ya da `bash scripts/basla.sh`)
#  - yeni panel zaten açıksa: sistemi dinlenmeden çıkarır (▶ Sistemi başlat ile aynı)
#  - portta eski/yanıt vermeyen bir panel varsa: onu kapatıp yeniden açar
#  - panel servisi kuruluysa (install_panel_service.sh) servisi, değilse paneli bu terminalde açar (Ctrl+C kapatır)
# Her adımı ekrana yazar; panel 40 sn içinde açılmazsa nedenini (log) gösterir.
cd "$(dirname "$0")/.."
PORT="${PANEL_PORT:-3131}"; URL="http://localhost:$PORT"
SERVICE="$HOME/Library/LaunchAgents/com.gundem.panel.plist"
echo "📂 $(pwd) · dal: $(git branch --show-current 2>/dev/null) · sürüm: $(git log -1 --format='%h %cd' --date=format:'%d.%m %H:%M' 2>/dev/null)"
command -v node >/dev/null || { echo "✖ node bulunamadı (brew install node)"; exit 1; }
alive() { curl -sf -m 3 "$URL/api/rest" >/dev/null 2>&1; }          # yalnız güncel panel bu adrese JSON döner
wake() { curl -sf -m 5 -X POST -H 'content-type: application/json' -d '{"on":false}' "$URL/api/rest" >/dev/null 2>&1; }
openui() { open "$URL" 2>/dev/null || true; }
if alive; then
  wake && echo "✔ Panel zaten açık, sistem başlatıldı: $URL" || echo "! Panel açık ama sistem başlatılamadı; panelde ▶ Sistemi başlat'a basın"
  openui; exit 0
fi
PIDS="$(lsof -ti tcp:"$PORT" 2>/dev/null)"
if [ -n "$PIDS" ]; then
  echo "↻ $PORT portunda eski ya da yanıt vermeyen bir panel var (pid $(echo $PIDS | tr '\n' ' ')); kapatılıyor"
  kill $PIDS 2>/dev/null; sleep 2; kill -9 $PIDS 2>/dev/null || true
fi
# durdurulmuş olarak kaydedilen dinlenme kaldırılır: panel çalışır halde açılır
mkdir -p data work && printf '{"on": false, "endedWhy": "terminalden başlatıldı"}\n' > data/rest.json
wait_up() { for _ in $(seq 1 40); do alive && return 0; sleep 1; done; return 1; }
if [ -f "$SERVICE" ]; then
  echo "▶ Panel servisi başlatılıyor (log: work/panel.log)"
  # Yeni macOS'ta "unload"dan sonra "load" sessizce başarısız olabiliyor: önce bootstrap, olmazsa load
  launchctl enable "gui/$(id -u)/com.gundem.panel" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$SERVICE" 2>/dev/null || launchctl load "$SERVICE" 2>/dev/null || true
  launchctl kickstart -k "gui/$(id -u)/com.gundem.panel" 2>/dev/null || true
  launchctl print "gui/$(id -u)/com.gundem.panel" >/dev/null 2>&1 || echo "! panel servisi launchd'ye yüklenemedi"
  if wait_up; then echo "✔ Panel ve sistem çalışıyor: $URL"; openui; exit 0; fi
  echo "✖ Panel servisi 40 sn'de açılmadı. work/panel.log son satırlar:"; tail -25 work/panel.log 2>/dev/null
  echo "→ Bu terminalde doğrudan açmayı deniyorum:"; launchctl unload "$SERVICE" 2>/dev/null || true
fi
echo "▶ Panel bu terminalde açılıyor: $URL"
echo "  ⚠️ Bu pencere AÇIK kalmalı: Ctrl+C ya da pencereyi kapatmak paneli, WhatsApp'ı ve haber takibini kapatır."
echo "  Başka komut (teşhis vb.) için yeni bir Terminal sekmesi açın (Cmd+T)."
( if wait_up; then echo "✔ Panel ve sistem çalışıyor: $URL"; openui; else echo "✖ Panel 40 sn'de açılmadı; yukarıdaki hata satırlarını gönderin."; fi ) &
exec bash scripts/panel.sh
