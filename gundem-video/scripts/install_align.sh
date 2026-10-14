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
[ -x .venv-align/bin/python ] || python3 -m venv .venv-align
.venv-align/bin/python -m pip install -q --upgrade pip
.venv-align/bin/python -m pip install -q "torch==2.8.*" "torchaudio==2.8.*" numpy certifi || { echo "✖ torch/torchaudio kurulamadı"; exit 1; }
echo "  model indiriliyor ve deneniyor (ilk sefer birkaç dakika sürebilir)"
T="$(mktemp -d)"
say -v Yelda -o "$T/t.wav" --data-format=LEI16@22050 "Fenerbahçe, Galatasaray'ı dört bir yendi." 2>/dev/null || true
if [ -s "$T/t.wav" ]; then
  printf '%s' '[["Fenerbahçe,","Fenerbahçe,"],["Galatasaray’ı","Galatasaray’ı"],["4-1","dört bir"],["yendi.","yendi."]]' > "$T/w.json"
  .venv-align/bin/python scripts/mms_align.py "$T/t.wav" "$T/w.json"
else
  .venv-align/bin/python -c "import sys; sys.path.insert(0, 'scripts'); import mms_align, torchaudio; torchaudio.pipelines.MMS_FA.get_model(); print('model hazır')"
fi
rm -rf "$T"

echo "▶ 2/2 konuşma tanıma (mlx-whisper)"
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
