#!/usr/bin/env bash
# Paneli çalıştırır; çıkış kodu 75 ise (kendini geliştirme / yeniden başlat) tekrar başlatır.
cd "$(dirname "$0")/.."
export PATH="$PWD/.venv/bin:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
command -v node >/dev/null || { echo "✖ node bulunamadı (PATH: $PATH). Servisi yeniden kurun: bash scripts/install_panel_service.sh"; exit 1; }
# panel bu döngüde çalıştığını bilsin (üst süreç bu kabuk): "güncelle"/"yeniden başlat" 75 ile çıkar, döngü yeniden açar
export EMIXHAS_LOOP=$$
while true; do
  node app/server.js
  code=$?
  [ "$code" -eq 75 ] || exit "$code"
  echo "↻ panel yeniden başlatılıyor..."; sleep 1
done
