#!/usr/bin/env bash
# Doğal ses motoru (Chatterbox Multilingual) kurulumu — macOS Apple Silicon. Tek seferlik, ~3 GB indirir.
set -e
cd "$(dirname "$0")/.."
source .venv/bin/activate
pip install --upgrade pip
pip install torch torchaudio            # Apple Silicon'da MPS destekli resmi paket
pip install chatterbox-tts
python3 - <<'PY'
import torch; print("MPS:", torch.backends.mps.is_available())
PY
echo "Kurulum tamam. Panelden 'Doğal sesi başlat' deyin; ilk açılışta model (~2 GB) iner."
