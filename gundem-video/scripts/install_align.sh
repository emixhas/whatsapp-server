#!/usr/bin/env bash
# Altyazı-ses eş zamanlaması (kullanıcı isteği: "altyazı sesle kesinlikle eşit gitsin"). İki parça:
#  1) Metni sese zorla hizalama (MMS, en isabetlisi): ayrı ortam .venv-align (torch/torchaudio 2.8; ses modellerinin torch'una
#     dokunmaz) + model (~1,2 GB, ilk denemede iner).
#  2) Konuşma tanıma (mlx-whisper large-v3-turbo, Apple Silicon): yedek yol ve video sonrası altyazı denetimi (~1,6 GB).
# Kurulmazsa altyazı duraklama çapalarıyla (ffmpeg) eşlenir. Kullanım: bash scripts/install_align.sh
set -e
cd "$(dirname "$0")/.."
PY=".venv/bin/python3"; [ -x "$PY" ] || PY="python3"

echo "▶ 1/2 metin hizalama ortamı (.venv-align)"
echo "  Python: $(python3 --version 2>&1) ($(command -v python3))"
case "$(python3 -c 'import sys;print(sys.version_info[1])' 2>/dev/null)" in
  9|10|11|12|13) ;;
  *) echo "  ! torch 2.8 bu Python sürümünü desteklemiyor olabilir (3.9-3.13 gerekir); kurulamazsa: brew install python@3.12 ve PY_ALIGN=python3.12 bash scripts/install_align.sh";;
esac
ALIGN_PY="${PY_ALIGN:-python3}"
[ -x .venv-align/bin/python ] || "$ALIGN_PY" -m venv .venv-align
echo "  pip güncelleniyor…"
.venv-align/bin/python -m pip install -q --upgrade pip
echo "  torch + torchaudio indiriliyor (~200-300 MB; ilerleme aşağıda, internet hızına göre birkaç dakika)…"
.venv-align/bin/python -m pip install --progress-bar on "torch==2.8.*" "torchaudio==2.8.*" numpy certifi 2>&1 | grep -vE "^(Requirement already satisfied|  Using cached)" || true
.venv-align/bin/python -c "import torch, torchaudio, certifi; print('  ✔ torch', torch.__version__, '· torchaudio', torchaudio.__version__)" || { echo "✖ torch/torchaudio kurulamadı (yukarıdaki hata satırlarını gönderin)"; exit 1; }
echo "  hizalama modeli indiriliyor (~1,2 GB, yalnız ilk sefer) ve deneniyor…"
T="$(mktemp -d)"
say -v Yelda -o "$T/t.wav" --data-format=LEI16@22050 "Fenerbahçe, Galatasaray'ı dört bir yendi." 2>/dev/null || true
if [ -s "$T/t.wav" ]; then
  printf '%s' '[["Fenerbahçe,","Fenerbahçe,"],["Galatasaray’ı","Galatasaray’ı"],["4-1","dört bir"],["yendi.","yendi."]]' > "$T/w.json"
  .venv-align/bin/python scripts/mms_align.py "$T/t.wav" "$T/w.json"
else
  .venv-align/bin/python -c "import sys; sys.path.insert(0, 'scripts'); import mms_align, torchaudio; torchaudio.pipelines.MMS_FA.get_model(); print('model hazır')"
fi
rm -rf "$T"

echo "▶ 2/2 konuşma tanıma (mlx-whisper; model ilk sefer ~1,6 GB iner)"
if "$PY" -m pip install -q --upgrade mlx-whisper; then
  "$PY" - <<'PY'
import mlx_whisper, tempfile, subprocess, os
f = os.path.join(tempfile.gettempdir(), "align_test.wav")
subprocess.run(["say", "-v", "Yelda", "-o", f, "--data-format=LEI16@22050", "Merhaba, bu bir deneme."], check=False)
if os.path.exists(f):
    r = mlx_whisper.transcribe(f, path_or_hf_repo="mlx-community/whisper-large-v3-turbo", language="tr", word_timestamps=True)
    print("  ✔ tanındı:", r.get("text", "").strip())
PY
else
  echo "  ! mlx-whisper kurulamadı (Apple Silicon gerekir); metin hizalama yine çalışır"
fi
rm -f work/.python_with.json
echo "✔ Hazır: log '🔤 altyazı senkronu: metin hizalama …' yazacak"
