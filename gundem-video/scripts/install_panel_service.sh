#!/usr/bin/env bash
# Paneli arka plan servisi yapar: Mac açılınca başlar, çökerse yeniden açılır, terminal gerekmez.
#   bash scripts/install_panel_service.sh          kur / güncelle
#   bash scripts/install_panel_service.sh remove   kaldır
# Log: work/panel.log. Güncelleme ve yeniden başlatma panelin başlığındaki düğmelerle yapılır.
set -e
cd "$(dirname "$0")/.."
ROOT="$PWD"; PLIST="$HOME/Library/LaunchAgents/com.gundem.panel.plist"
if [ "$1" = "remove" ]; then launchctl unload "$PLIST" 2>/dev/null || true; rm -f "$PLIST"; echo "Panel servisi kaldırıldı."; exit 0; fi
mkdir -p "$HOME/Library/LaunchAgents" work
launchctl unload "$PLIST" 2>/dev/null || true
cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.gundem.panel</string>
  <key>ProgramArguments</key><array><string>/bin/bash</string><string>$ROOT/scripts/panel.sh</string></array>
  <key>WorkingDirectory</key><string>$ROOT</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$ROOT/work/panel.log</string>
  <key>StandardErrorPath</key><string>$ROOT/work/panel.log</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>$ROOT/.venv/bin:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string><key>HOME</key><string>$HOME</string></dict>
</dict></plist>
PL
launchctl load "$PLIST"
echo "Panel servisi kuruldu: http://localhost:3131 (log: work/panel.log). Terminali kapatabilirsiniz."
echo "Terminalden 'npm run panel' ile ayrıca çalıştırmayın; iki panel aynı portu paylaşamaz."
