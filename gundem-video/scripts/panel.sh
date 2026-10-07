#!/usr/bin/env bash
# Paneli çalıştırır; çıkış kodu 75 ise (kendini geliştirme / yeniden başlat) tekrar başlatır.
cd "$(dirname "$0")/.."
export PATH="$PWD/.venv/bin:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
while true; do
  node app/server.js
  code=$?
  [ "$code" -eq 75 ] || exit "$code"
  echo "↻ panel yeniden başlatılıyor..."; sleep 1
done
