#!/usr/bin/env bash
# Gerçekçi görsel motoru (kullanıcı isteği, 27 Ekim: "benzerini sıfırdan yap gönderilerimiz çok basit çizimlerle oluyor; rakipler çok
# gerçekçi üretiyor"; 28 Ekim: "görseller çok çok gerçekçi olsun, süre önemli değil"): benzer videonun sahneleri yapay zekâ ile fotoğraf
# gerçekliğinde üretilir. Tamamen yerel (Mac'te, internetsiz çalışır; yalnız kurulumda indirir), ücretsiz:
#   mflux 0.24.0 (MLX, Apple Silicon) + Z-Image-Turbo (Tongyi-MAI, 6 milyar parametre + Qwen3-4B metin kodlayıcı, Apache-2.0; asıl depo,
#   mflux'un sabitlediği sürüm)
# Kalite düzeyi Mac'in belleğinden (scripts/image_setup.py plan): 30 GB ve üstü tam hassasiyet (bf16), altında 8 bit; deneme görseli
# üretilemezse ya da tepe bellek Mac'in belleğinin %80'ini geçerse (bellek takas eder, bilgisayar yavaşlar) bir alt düzey (q8 → q6 → q4;
# asıl depo bu Mac'te hiç açılamazsa eski kurulumun hazır 4 bit deposu). Boyut 1152x2048 (Z-Image'ın önerdiği en büyük 9:16 boyut); bu
# boyutta olmazsa aynı düzeyde 864x1536. Süre yüzünden kalite düşürülmez (kullanıcı: "süre önemli değil"; görsel başına süre panelde yazar);
# istenirse IMAGE_SLOW_SEC=480 bash scripts/install_image.sh: 1152x2048'de görsel bundan uzun sürerse 864x1536.
# Akış: .venv-image (Python 3.11+; ses ve hizalama ortamlarına dokunmaz) → mflux → asıl depo indirilir (~31 GB, yalnız bir kez) → seçilen
# düzeyde yerel kopya models/image/zimage-<düzey> (8 bit ~11 GB, tam ~20 GB) → üretim ayarlarıyla deneme (sabit kaydırma 3, 8 adım) →
# models/image/READY.json (sürüm 2) → indirme önbelleğindeki Z-Image kopyaları silinir (asıl depo ve eski 4 bit).
# Gereken: Apple Silicon Mac (M1 ve üstü), 16 GB bellek, kurulum sırasında ~47 GB boş disk (bitince ~12 GB kalır; tam hassasiyette ~57 / ~21).
# Kullanım: bash scripts/install_image.sh [--force]   (eski 4 bit kurulum da böyle yükseltilir: panel → 📡 → 📷 → ⬆ Yükselt; yükseltme
# bitene kadar eski kurulum çalışmaya devam eder). Yarıda kalırsa yeniden çalıştırın: inen dosyalar yeniden inmez. Sürüm 2 zaten kuruluysa
# hiçbir şey yapmaz (--force yeniden kurar).
set -e
cd "$(dirname "$0")/.."
# sysctl macOS'ta yalnız /usr/sbin altında: panel servis olarak (launchd) çalışırken PATH'te yok (inceleme, 28 Ekim: panelden kurulum
# "yalnız Apple Silicon" deyip duruyordu, bellek okunamıyordu); sona eklenir, öndeki hiçbir aracı gölgelemez
export PATH="$PATH:/usr/sbin:/sbin"
MFLUX_VERSION="${MFLUX_VERSION:-0.24.0}"
SLOW="${IMAGE_SLOW_SEC:-0}"  # verilirse: 1152x2048'de görsel başına bundan uzun sürerse 864x1536 (varsayılan kapalı: süre için kalite düşmez)
TIER_NAMES="bf16 q8 q6 q4 q4hazir"

if [ "$(uname -s)" != "Darwin" ] || [ "$(sysctl -n hw.optional.arm64 2>/dev/null)" != "1" ]; then
  echo "✖ Bu motor yalnız Apple Silicon (M1/M2/M3/M4) Mac'te çalışır; benzer videolar çizimle üretilmeye devam eder."
  exit 1
fi
# panel Rosetta altında (x86_64) çalışıyorsa betik de öyle başlar: Apple Silicon olarak yeniden başlat (MLX yalnız arm64; inceleme, 28 Ekim)
if [ "$(uname -m)" != "arm64" ]; then
  exec arch -arm64 /bin/bash "$0" "$@"
fi
# kurulum kilidi: panel yeniden başlasa da "kuruluyor" görünsün, ikinci kurulum açılmasın (server.js imageInstalling)
mkdir -p models/image
LOCKF=models/image/.kuruluyor
if [ -f "$LOCKF" ] && kill -0 "$(cat "$LOCKF" 2>/dev/null)" 2>/dev/null; then
  echo "✖ Kurulum zaten sürüyor (süreç $(cat "$LOCKF")); bitmesini bekleyin."
  exit 1
fi
echo $$ > "$LOCKF"
trap 'rm -f "$LOCKF"' EXIT
exec 3>&1  # image_setup.py'nin bekleme satırı ("bir videonun fotoğrafları üretiliyor") komut çıktısı yakalanırken de panelin loguna gitsin
# sürüm 2 zaten kurulu ve model klasörü yerindeyse yeniden indirilmez (asıl depo kurulumdan sonra silindiği için 31 GB yeniden inerdi)
if [ "${1:-}" != "--force" ] && [ -x .venv-image/bin/python ] && .venv-image/bin/python - <<'PY' 2>/dev/null
import json, sys
from pathlib import Path
d = json.loads(Path("models/image/READY.json").read_text(encoding="utf-8"))
sys.exit(0 if int(d.get("version") or 1) >= 2 and Path(str(d.get("model") or "/yok")).is_dir() and d.get("fallback") not in ("disk", "indirme") else 1)
PY
then
  echo "✔ Gerçekçi görsel motoru zaten kurulu (sürüm 2, models/image/READY.json). Yeniden kurmak için: bash scripts/install_image.sh --force"
  exit 0
fi
for T in $TIER_NAMES; do rm -rf "models/image/zimage-$T.yeni"; done  # yarıda kalmış önceki kurulumun kopyaları
echo "▶ 1/4 Python ortamı (.venv-image)"
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
echo "▶ 2/4 mflux $MFLUX_VERSION kuruluyor (MLX, torch, transformers; ~1 GB, internet hızına göre birkaç dakika)…"
.venv-image/bin/python -m pip install --progress-bar on "mflux==$MFLUX_VERSION" certifi 2>&1 | grep -vE "^(Requirement already satisfied|  Using cached)" || true
.venv-image/bin/python -c "import mflux, certifi; print('  ✔ mflux hazır')" || { echo "✖ mflux kurulamadı (yukarıdaki hata satırlarını gönderin)"; exit 1; }
# python.org Python'u macOS sertifika deposunu görmez: model indirmesi certifi ile
export SSL_CERT_FILE="$(.venv-image/bin/python -c 'import certifi; print(certifi.where())')"
export HF_HUB_DISABLE_TELEMETRY=1
# JSON'un son satırından alan (bozuk ya da boş çıktıda boş dize; set -e altında hiç hata vermez)
jget() { .venv-image/bin/python -c '
import json, sys
try:
    v = json.loads((sys.stdin.read().strip().splitlines() or ["{}"])[-1]).get(sys.argv[1])
except Exception:
    v = None
print(" ".join(map(str, v)) if isinstance(v, list) else ("" if v is None else v))' "$1" || true; }
PLAN="$(.venv-image/bin/python scripts/image_setup.py plan)"
RAM="$(echo "$PLAN" | jget ram)"
TIERS="$(echo "$PLAN" | jget tiers)"
CACHED="$(echo "$PLAN" | jget cached)"
FREE="$(df -k . | awk 'NR==2 {print int($4 / 1000000)}')"
CG="${CACHED%.*}"; FREE=$((FREE + ${CG:-0}))  # yarıda kalmış kurulumun indirdiği kısım yeniden inmez
echo "  Bellek: ${RAM} GB; boş disk: ${FREE} GB; denenecek kalite düzeyleri: ${TIERS}"
# disk: asıl depo (~31 GB) + yerel kopya + pay; tam hassasiyete yetmiyorsa 8 bitten, asıl depoya hiç yetmiyorsa hazır 4 bit depodan başlanır
need() { case "$1" in bf16) echo 57 ;; q8) echo 47 ;; q6) echo 45 ;; q4) echo 42 ;; *) echo 16 ;; esac; }
rank() { case "$1" in bf16) echo 0 ;; q8) echo 1 ;; q6) echo 2 ;; q4) echo 3 ;; *) echo 4 ;; esac; }
tname() { case "$1" in bf16) echo "tam hassasiyet" ;; q8) echo "8 bit" ;; q6) echo "6 bit" ;; *) echo "4 bit" ;; esac; }
# şu anki boş disk + indirme önbelleğindeki asıl depo (inen kısım yeniden inmez)
free_now() { local f c; f="$(df -k . | awk 'NR==2 {print int($4 / 1000000)}')"; c="$(.venv-image/bin/python scripts/image_setup.py plan | jget cached)"; c="${c%.*}"; echo $(( ${f:-0} + ${c:-0} )); }
# en yüksek düzey disk ya da indirme yüzünden kurulamamış sürüm 2 (yeniden deneme): yalnız ondan İYİ düzeyler denenir, olmazsa şimdiki kurulum
# olduğu gibi kalır (inceleme, 28 Ekim: her denemede aynı 4 bit model yeniden indirilip kuruluyor, "yükseltildi" deniyordu)
CUR="$(.venv-image/bin/python - <<'PY' 2>/dev/null || true
import json
from pathlib import Path
try:
    d = json.loads(Path("models/image/READY.json").read_text(encoding="utf-8"))
    if int(d.get("version") or 1) >= 2 and Path(str(d.get("model") or "/yok")).is_dir() and d.get("fallback") in ("disk", "indirme"):
        print(d.get("tier") or "")
except Exception:
    pass
PY
)"
# tepe bellek (GB) belleğin %80'i içinde mi (ölçülemediyse kabul)
roomy() { .venv-image/bin/python -c 'import sys; p, r = sys.argv[1], float(sys.argv[2] or 0); sys.exit(0 if p in ("", "None") or r <= 0 or float(p) <= 0.8 * r else 1)' "$1" "$RAM"; }
OK_TIERS=""
for T in $TIERS; do
  if [ -n "$CUR" ] && [ "$(rank "$T")" -ge "$(rank "$CUR")" ]; then continue; fi  # şimdikinden iyi değil
  [ "$FREE" -ge "$(need "$T")" ] && OK_TIERS="$OK_TIERS $T"
done
MAIN_OK=""; for T in $OK_TIERS; do [ "$T" = "q4hazir" ] || MAIN_OK="$MAIN_OK $T"; done
if [ -n "$CUR" ] && [ -z "$MAIN_OK" ]; then
  echo "✖ Boş disk en yüksek kaliteye hâlâ yetmiyor (8 bit için ~$(need q8) GB boş gerekir, ${FREE} GB boş): şimdiki $(tname "$CUR") motor çalışmaya devam ediyor; yer açıp yeniden deneyin."
  exit 1
fi
if [ -z "$OK_TIERS" ]; then
  echo "✖ Yeterli boş disk yok: kurulum sırasında en az $(need q4hazir) GB gerekiyor (en yüksek kalite için $(need q8) GB), ${FREE} GB boş. Yer açıp yeniden çalıştırın."
  exit 1
fi
case "$TIERS" in *q8*) case "$OK_TIERS" in *q8*|*bf16*) ;; *) echo "  ! Boş disk en yüksek kaliteye yetmiyor (8 bit için $(need q8) GB gerekir, ${FREE} GB boş): daha düşük düzey kurulacak" ;; esac ;; esac
case "$TIERS" in *bf16*) case "$OK_TIERS" in *bf16*) ;; *q8*) echo "  ! Boş disk tam hassasiyete yetmiyor ($(need bf16) GB gerekir, ${FREE} GB boş): 8 bit kurulacak" ;; esac ;; esac
mkdir -p work
echo "▶ 3/4 Z-Image-Turbo indiriliyor (asıl depo ~31 GB, yalnız ilk sefer; internet hızına göre 15-90 dk), yerel kopya kaydediliyor ve deneniyor…"
CHOSEN=""; W=1152; H=2048; TEST=""; HUBFAIL=""
for T in $OK_TIERS; do
  # asıl depo açılamadıysa (bellek, indirme) diğer düzeyler de açılamaz; disk dolduysa daha küçük kopya sığabilir (şimdiki boş diskle bakılır)
  if [ "$T" != "q4hazir" ] && [ -n "$HUBFAIL" ] && { [ "$HUBFAIL" != "disk" ] || [ "$(free_now)" -lt "$(need "$T")" ]; }; then continue; fi
  NEW="$PWD/models/image/zimage-$T.yeni"
  echo "  ▷ düzey $T: yerel kopya kaydediliyor…"
  if ! OUT="$(.venv-image/bin/python scripts/image_setup.py save "$T" "$NEW")"; then
    echo "  ! $T kaydedilemedi: $(echo "$OUT" | jget error)"; rm -rf "$NEW"
    if [ "$T" != "q4hazir" ] || [ -z "$HUBFAIL" ]; then HUBFAIL="$(echo "$OUT" | jget stage)"; HUBFAIL="${HUBFAIL:-yukleme}"; fi
    continue
  fi
  echo "  ✔ $T kopyası: $(echo "$OUT" | jget gb) GB, $(echo "$OUT" | jget sec) sn"
  for WH in 1152x2048 864x1536; do
    W="${WH%x*}"; H="${WH#*x}"
    echo "  ▷ düzey $T: ${W}x${H} deneme görseli (sabit kaydırma 3, 8 adım)…"
    if TEST="$(.venv-image/bin/python scripts/image_setup.py test "$NEW" "$W" "$H" 2>&3)"; then
      PK="$(echo "$TEST" | jget peakGB)"
      if roomy "$PK"; then CHOSEN="$T"; break; fi
      echo "  ! ${W}x${H} tepe bellek ${PK} GB, Mac'in belleğinin %80'ini geçiyor (takas eder, bilgisayar yavaşlar)"
    else
      echo "  ! ${W}x${H} deneme görseli üretilemedi: $(echo "$TEST" | jget error)"
    fi
  done
  [ -n "$CHOSEN" ] && break
  echo "  ! $T ile deneme görseli üretilemedi; bir alt düzey deneniyor"
  rm -rf "$NEW"
done
if [ -z "$CHOSEN" ]; then
  KEEP="benzer videolar eskisi gibi üretilmeye devam eder"; [ -n "$CUR" ] && KEEP="şimdiki $(tname "$CUR") motor çalışmaya devam ediyor"
  case "$HUBFAIL" in
    indirme) echo "✖ Model indirilemedi (internet bağlantısını denetleyip yeniden çalıştırın; inen dosyalar yeniden inmez); $KEEP." ;;
    disk) echo "✖ Kurulum sırasında disk doldu: yer açıp yeniden çalıştırın (inen dosyalar yeniden inmez); $KEEP." ;;
    *) echo "✖ Hiçbir kalite düzeyinde deneme görseli üretilemedi (yukarıdaki satırları gönderin); benzer videolar eskisi gibi üretilmeye devam eder." ;;
  esac
  exit 1
fi
GEN="$(echo "$TEST" | jget genSec)"; LOAD="$(echo "$TEST" | jget loadSec)"; PEAK="$(echo "$TEST" | jget peakGB)"; BIG=""
if [ "$W" = "1152" ] && .venv-image/bin/python -c 'import sys; s = float(sys.argv[2] or 0); sys.exit(0 if s > 0 and float(sys.argv[1] or 0) > s else 1)' "$GEN" "$SLOW"; then
  SM="${SLOW%.*}"; echo "  ! 1152x2048'de görsel başına ${GEN} sn ($(( ${SM:-0} / 60 )) dakikadan uzun; video başına saatler sürerdi): 864x1536 deneniyor"
  if T2="$(.venv-image/bin/python scripts/image_setup.py test "$NEW" 864 1536 2>&3)" && roomy "$(echo "$T2" | jget peakGB)"; then
    BIG="$GEN"; TEST="$T2"; W=864; H=1536; GEN="$(echo "$TEST" | jget genSec)"; LOAD="$(echo "$TEST" | jget loadSec)"; PEAK="$(echo "$TEST" | jget peakGB)"
  else
    echo "  ! 864x1536 deneme görseli üretilemedi; 1152x2048 ile devam"
  fi
fi
echo "  ✔ Z-Image-Turbo $CHOSEN: model ${LOAD} sn'de açıldı, ${W}x${H} görsel ${GEN} sn${PEAK:+, tepe bellek $PEAK GB}"
# en yüksek düzey kurulamadı ve hazır 4 bit depoya düşüldüyse nedeni (inceleme, 28 Ekim: yarıda kalan 31 GB indirme ya da yetmeyen disk eski
# 4 bit modeli kalıcı kılıyor, yarım indirme siliniyor, yeniden kurulum "zaten kurulu" diyordu): disk ve indirmede yarım indirme kalır, panel
# "⬆ Yükselt" göstermeye devam eder, yeniden çalıştırınca kaldığı yerden sürer; bellekte (deneme görseli sığmadı) karar kalıcıdır
# 6 ya da 4 bit de, boş disk 8 biti dışarıda bıraktıysa geri düşüştür (inceleme, 28 Ekim: kalıcı sayılıyordu); tam hassasiyet yerine 8 bit değil
# (8 bit tam hassasiyete çok yakın)
FALLBACK=""
case "$TIERS" in *q8*) case "$OK_TIERS" in *q8*|*bf16*) ;; *) [ "$(rank "$CHOSEN")" -ge 2 ] && FALLBACK="disk" ;; esac ;; esac
if [ "$HUBFAIL" = "disk" ] && [ "$(rank "$CHOSEN")" -ge 2 ]; then FALLBACK="disk"; fi
if [ "$CHOSEN" = "q4hazir" ] && [ "$TIERS" != "q4hazir" ]; then
  if [ -n "$FALLBACK" ]; then :
  elif [ "$HUBFAIL" = "indirme" ]; then FALLBACK="indirme"
  else FALLBACK="bellek"; fi
fi
if [ -n "$FALLBACK" ]; then
  case "$FALLBACK" in
    disk) echo "  ! En yüksek kalite için boş disk yetmedi: şimdilik $(tname "$CHOSEN") kuruldu. Yer açıp (8 bit için ~$(need q8) GB boş) panelden ⬆ Yükselt ya da bu betiği yeniden çalıştırın." ;;
    indirme) echo "  ! Asıl model indirilemedi (internet kesildi ya da sunucu yanıt vermedi): şimdilik hazır 4 bit kuruldu. Panelden ⬆ Yükselt ya da bu betiği yeniden çalıştırın; inen dosyalar yeniden inmez." ;;
    *) echo "  ! Asıl model bu Mac'in belleğinde açılamadı: hazır 4 bit kuruldu." ;;
  esac
fi
echo "▶ 4/4 kurulum tamamlanıyor: yerel kopya yerine taşınıyor, indirme önbelleğindeki Z-Image kopyaları ve başka düzeylerin eski kopyaları siliniyor…"
if ! FIN="$(.venv-image/bin/python scripts/image_setup.py finalize "$CHOSEN" "$NEW" "$MFLUX_VERSION" "$RAM" "$GEN" "$LOAD" "$W" "$H" "$BIG" "$PEAK" "$FALLBACK" 2>&3)"; then
  echo "✖ Kurulum tamamlanamadı: $(echo "$FIN" | jget error)"
  exit 1
fi
echo "  ✔ $(echo "$FIN" | jget freed) GB boşaldı"
echo "✔ Hazır: Z-Image-Turbo $CHOSEN (bellek ${RAM} GB), ${W}x${H}, görsel başına ~$(.venv-image/bin/python -c 'import sys; print(round(float(sys.argv[1] or 0)))' "$GEN") sn; deneme: work/image_deneme.png."
echo "  Benzer videolar artık ${FALLBACK:+bu düzeyde }gerçekçi fotoğraflarla üretilir (panel Ayarlar → 📡 → 📷 Gerçekçi görseller; talimatta \"çizgi film\" ya da \"çizim\" denirse çizim)."
