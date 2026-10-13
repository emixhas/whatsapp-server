#!/usr/bin/env bash
# Altyazı-ses eş zamanlaması için konuşma tanıma (isteğe bağlı): mlx-whisper (Apple Silicon, Türkçe).
# Kurulmazsa altyazı yine duraklama çapalarıyla (ffmpeg) eşlenir. Model ilk kullanımda indirilir (~480 MB, small).
# Kullanım: bash scripts/install_align.sh
cd "$(dirname "$0")/.."
PY=".venv/bin/python3"; [ -x "$PY" ] || PY="python3"
echo "▶ mlx-whisper kuruluyor ($PY)"
"$PY" -m pip install --upgrade mlx-whisper || { echo "✖ kurulamadı (Apple Silicon Mac gerekir)"; exit 1; }
rm -f work/.python_with.json
echo "▶ model indiriliyor ve deneniyor"
"$PY" - <<'PY'
import mlx_whisper, tempfile, subprocess, os
f = os.path.join(tempfile.gettempdir(), "align_test.wav")
subprocess.run(["say", "-v", "Yelda", "-o", f, "--data-format=LEI16@22050", "Merhaba, bu bir deneme."], check=False)
if os.path.exists(f):
    r = mlx_whisper.transcribe(f, path_or_hf_repo="mlx-community/whisper-small-mlx", language="tr", word_timestamps=True)
    print("✔ tanındı:", r.get("text", "").strip())
else:
    print("✔ kuruldu (deneme sesi üretilemedi)")
PY
echo "✔ Hazır: bundan sonra altyazılar konuşma tanıma ile sese eşlenir (log: 🔤 altyazı senkronu: konuşma tanıma)"
