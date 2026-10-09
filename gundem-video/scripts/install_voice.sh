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
rm -f work/.python_with.json   # ses motoru kontrol önbelleği: yeni kurulum hemen görünsün
echo "Kurulum tamam. Ayarlar → SESLER'den Chatterbox'ı seçin; model yalnızca üretimde yüklenir (ilk seferde ~2 GB iner)."
