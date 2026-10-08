#!/usr/bin/env bash
# Türkçe doğal ses kurulumu — macOS Apple Silicon. Tek seferlik.
#  1) Trendyol-TTS (VoxCPM2 tabanlı, MIT): 2026'nın en doğal Türkçe açık modeli; MLX ile Mac'te yerel.
#     Python 3.11 ister; bu yüzden ayrı bir sanal ortam (.venv-tr) kurulur. Ağırlık ~4.8 GB.
#  2) EMA Lightning (Apache-2.0, 34 MB): anında ve hatasız yedek, Emixhas'ın konuşma sesi için de ideal.
set -e
cd "$(dirname "$0")/.."
eval "$(/opt/homebrew/bin/brew shellenv)" 2>/dev/null || true

echo "== 1/4 Python 3.11 ve MLX ortamı"
brew list python@3.11 >/dev/null 2>&1 || brew install python@3.11
[ -d .venv-tr ] || /opt/homebrew/bin/python3.11 -m venv .venv-tr
.venv-tr/bin/pip install -U pip wheel >/dev/null
.venv-tr/bin/pip install "huggingface_hub[cli]" soundfile

echo "== 2/4 Trendyol-TTS MLX çalışma zamanı"
mkdir -p vendor models
[ -d vendor/trendyol-tts-mlx ] || git clone --depth 1 https://github.com/emre-koc/trendyol-tts-mlx vendor/trendyol-tts-mlx
.venv-tr/bin/pip install -e vendor/trendyol-tts-mlx
if [ ! -f models/Trendyol-TTS-mlx/config.json ] && [ -z "$(ls models/Trendyol-TTS-mlx 2>/dev/null)" ]; then
  .venv-tr/bin/hf download emrekoc/trendyol-tts-mlx --local-dir models/Trendyol-TTS-mlx
fi

echo "== 3/4 EMA Lightning (ana ortama; yedek ve Emixhas sesi)"
if [ -d .venv ]; then
  .venv/bin/pip install ema-lightning
else
  .venv-tr/bin/pip install ema-lightning
fi

echo "== 4/4 Deneme"
MLX_ARTIFACT_DIR="$PWD/models/Trendyol-TTS-mlx" .venv-tr/bin/trendyol-tts --text "Merhaba, Türkiye Gündemi'nden son dakika haberleriyle buradayız." \
  --out work/trendyol-test.wav --device mps --backend mlx --cfg 2.0 --steps 16 --max-len 4096 --mlx-artifact-dir "$PWD/models/Trendyol-TTS-mlx" \
  && echo "Trendyol sesi: work/trendyol-test.wav (afplay ile dinleyin)" || echo "! Trendyol MLX denemesi başarısız; tts.py EMA/yedek motora düşer"
PY=.venv/bin/python; [ -x "$PY" ] || PY=.venv-tr/bin/python
"$PY" - <<'PYEOF' && echo "EMA sesi: work/ema-test.wav" || echo "! EMA denemesi başarısız"
from ema_lightning import EMA
EMA().say("Merhaba, Türkiye Gündemi'nden son dakika haberleriyle buradayız.", path="work/ema-test.wav")
PYEOF
# Motor seçimini otomatiğe al: Trendyol → EMA → Chatterbox → Yelda → Piper
"$PY" - <<'PYEOF'
import json, pathlib
p = pathlib.Path("data/settings.json"); d = json.loads(p.read_text()) if p.exists() else {}
d["narrationEngine"] = "auto"; d.setdefault("voice", {})["engine"] = "auto"
p.parent.mkdir(exist_ok=True); p.write_text(json.dumps(d, ensure_ascii=False, indent=2))
PYEOF
echo "Kurulum tamam. Video anlatımı ve Emixhas sesi 'Otomatik' yapıldı (Trendyol → EMA → ...). Paneli yeniden başlatın."
