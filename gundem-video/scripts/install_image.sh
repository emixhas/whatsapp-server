#!/usr/bin/env bash
# Gerçekçi görsel motoru (kullanıcı isteği, 27 Ekim: "benzerini sıfırdan yap gönderilerimiz çok basit çizimlerle oluyor; rakipler çok
# gerçekçi üretiyor"): benzer videonun sahneleri yapay zekâ ile fotoğraf gerçekliğinde üretilir. Tamamen yerel (Mac'te, internetsiz çalışır;
# yalnız kurulumda indirir), ücretsiz, Apache-2.0 lisanslı:
#   mflux (MLX, Apple Silicon) + Z-Image-Turbo (Tongyi-MAI, 6 milyar parametre, 4 bit önceden nicemlenmiş: filipstrand/Z-Image-Turbo-mflux-4bit)
# Ayrı ortam .venv-image (Python 3.11+; ses ve hizalama ortamlarına dokunmaz), model Hugging Face önbelleğine (~6 GB) iner.
# Gereken: Apple Silicon Mac (M1 ve üstü), 16 GB bellek önerilir, ~8 GB boş disk. Kullanım: bash scripts/install_image.sh
# Bittiğinde models/image/READY.json yazılır; panel ve wa_video bu dosyayla motoru hazır sayar.
set -e
cd "$(dirname "$0")/.."
MFLUX_VERSION="${MFLUX_VERSION:-0.24.0}"
MODEL="${IMAGE_MODEL:-filipstrand/Z-Image-Turbo-mflux-4bit}"

if [ "$(uname -s)" != "Darwin" ] || [ "$(uname -m)" != "arm64" ]; then
  echo "✖ Bu motor yalnız Apple Silicon (M1/M2/M3/M4) Mac'te çalışır; benzer videolar çizimle üretilmeye devam eder."
  exit 1
fi
echo "▶ 1/3 Python ortamı (.venv-image)"
PYX=""
for c in "${PY_IMAGE:-}" python3.13 python3.12 python3.11 /opt/homebrew/bin/python3 /usr/local/bin/python3 python3; do
  [ -n "$c" ] || continue
  if command -v "$c" >/dev/null 2>&1 && "$c" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)' 2>/dev/null; then PYX="$c"; break; fi
done
if [ -z "$PYX" ]; then
  echo "✖ Python 3.11 ya da üstü bulunamadı. python.org'dan Python 3.12 kurun (ya da: brew install python@3.12), sonra yeniden çalıştırın."
  exit 1
fi
echo "  Python: $($PYX --version 2>&1) ($(command -v "$PYX"))"
[ -x .venv-image/bin/python ] || "$PYX" -m venv .venv-image
.venv-image/bin/python -m pip install -q --upgrade pip
echo "▶ 2/3 mflux $MFLUX_VERSION kuruluyor (MLX, torch, transformers; ~1 GB, internet hızına göre birkaç dakika)…"
.venv-image/bin/python -m pip install --progress-bar on "mflux==$MFLUX_VERSION" certifi 2>&1 | grep -vE "^(Requirement already satisfied|  Using cached)" || true
.venv-image/bin/python -c "import mflux, certifi; print('  ✔ mflux hazır')" || { echo "✖ mflux kurulamadı (yukarıdaki hata satırlarını gönderin)"; exit 1; }
# python.org Python'u macOS sertifika deposunu görmez: model indirmesi certifi ile
export SSL_CERT_FILE="$(.venv-image/bin/python -c 'import certifi; print(certifi.where())')"
echo "▶ 3/3 model indiriliyor: $MODEL (~6 GB, yalnız ilk sefer) ve deneniyor…"
.venv-image/bin/python -c "from huggingface_hub import snapshot_download; p = snapshot_download('$MODEL'); print('  ✔ model:', p)"
mkdir -p models/image work
T="$(mktemp -d)"
cat > "$T/spec.json" <<JSON
{"model": "$MODEL", "steps": 9, "jobs": [{"prompt": "photorealistic documentary photograph of an old fisherman mending a net on a wooden boat at dawn in Istanbul, soft golden light, 35mm, shallow depth of field", "seed": 7, "w": 512, "h": 896, "out": "$T/deneme.png"}]}
JSON
START=$(date +%s)
if ! .venv-image/bin/python scripts/zimage_run.py "$T/spec.json" > "$T/out.json" 2> "$T/err.txt" || [ ! -s "$T/deneme.png" ]; then
  echo "✖ deneme görseli üretilemedi:"; cat "$T/out.json"; tail -5 "$T/err.txt"; rm -rf "$T"; exit 1
fi
SEC=$(( $(date +%s) - START ))
# ilerleme satırlarından: model yükleme süresi ve tek görselin süresi (bütçe görsel başına süreyle hesaplanır)
read -r IMG LOAD < <(.venv-image/bin/python -c 'import json, sys
img, load = "", ""
for line in open(sys.argv[1], encoding="utf-8", errors="replace"):
    try:
        d = json.loads(line)
    except ValueError:
        continue
    if isinstance(d, dict) and "sec" in d:
        img = d["sec"]
    if isinstance(d, dict) and "load" in d:
        load = d["load"]
print(img or sys.argv[2], load or 0)' "$T/err.txt" "$SEC")
cp "$T/deneme.png" work/image_deneme.png
rm -rf "$T"
printf '{"model": "%s", "mflux": "%s", "at": %s, "testSec": %s, "loadSec": %s}\n' "$MODEL" "$MFLUX_VERSION" "$(date +%s)" "$IMG" "$LOAD" > models/image/READY.json
echo "✔ Hazır (model ${LOAD} sn'de yüklendi, deneme görseli ${IMG} sn; work/image_deneme.png). Benzer videolar artık gerçekçi görsellerle üretilir"
echo "  (panel Ayarlar → 📡 → 📷 Gerçekçi görseller anahtarı; talimatta \"çizgi film\", \"animasyon\", \"çizim\" denirse yine çizim)."
