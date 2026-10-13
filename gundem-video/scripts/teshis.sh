#!/usr/bin/env bash
# Sistem teşhisi: `npm run teshis` — üretim ve WhatsApp neden durdu? Gizli bilgi yazmaz (token/anahtar satırları süzülür).
cd "$(dirname "$0")/.."
PORT="${PANEL_PORT:-3131}"; URL="http://localhost:$PORT"
clean() { grep -viE "privkey|buffer|token|secret|password|rootkey|basekey|chainkey|access_token|client_secret" | cut -c1-220; }
echo "=== Türkiye Gündemi teşhis · $(date '+%d.%m %H:%M') · sürüm $(git log -1 --format='%h %cd' --date=format:'%d.%m %H:%M' 2>/dev/null)"
echo; echo "--- 1) Panel"
if S=$(curl -sf -m 5 "$URL/api/status"); then
  python3 - "$S" <<'PY'
import json, sys, time
s = json.loads(sys.argv[1]); t = lambda ms: time.strftime("%d.%m %H:%M", time.localtime(ms / 1000)) if ms else "-"
r = s.get("rest") or {}; w = s.get("whatsapp") or {}; sch = s.get("schedule") or {}
print("✅ panel açık · üretim sürüyor:", "evet" if s.get("running") else "hayır")
print("   dinlenme:", f"AÇIK ({r.get('reason')}, {t(r.get('since'))}'den beri, sıradaki planlı {t(r.get('until'))})" if r.get("on") else "kapalı (sistem çalışıyor)")
print("   WhatsApp:", w.get("status"), f"· hata: {w.get('error')}" if w.get("error") else "", "· oturum dosyası", "var" if w.get("hasSession") else "YOK (QR okutulmalı)",
      "· son mesaj", t(w.get("lastMsgAt")) if isinstance(w.get("lastMsgAt"), (int, float)) else w.get("lastMsgAt") or "-")
print("   zamanlayıcı:", "açık" if sch.get("enabled") else "KAPALI", "· sıradaki üretim", t(sch.get("nextRunAt")), "· saatler", sch.get("slots"))
PY
else
  echo "❌ panel YANIT VERMİYOR ($URL). Panel kapalı ya da çökmüş: 'npm run basla' ile açın."
fi
echo; echo "--- altyazı hizalama"
if [ -x .venv-align/bin/python ] && .venv-align/bin/python -c "import torchaudio" 2>/dev/null; then echo "✅ metin hizalama (MMS) kurulu"; else echo "❌ metin hizalama kurulu değil: bash scripts/install_align.sh"; fi
PYA=".venv/bin/python3"; [ -x "$PYA" ] || PYA=python3
if "$PYA" -c "import mlx_whisper" 2>/dev/null; then echo "✅ konuşma tanıma (mlx-whisper) kurulu"; else echo "❌ konuşma tanıma kurulu değil (altyazı denetimi çalışmaz): bash scripts/install_align.sh"; fi
grep -h "altyazı senkronu\|altyazı denetimi" work/pipeline-*.log 2>/dev/null | tail -4 | cut -c1-200
echo; echo "--- 2) launchd (zamanlayıcı ve panel servisi)"
launchctl list 2>/dev/null | grep -i gundem || echo "launchd'de gundem işi yok (zamanlayıcı kapalı?)"
ls "$HOME/Library/LaunchAgents/" 2>/dev/null | grep -i gundem
for J in com.gundem.video com.gundem.panel; do
  if launchctl print "gui/$(id -u)/$J" >/dev/null 2>&1; then
    echo "$J: $(launchctl print "gui/$(id -u)/$J" 2>/dev/null | grep -E '^\s*(state|runs|last exit code|last exit reason) =' | sed 's/^[[:space:]]*//' | tr '\n' ' ')"
  else echo "$J: launchd'de YÜKLÜ DEĞİL"; fi
done
LE=$(launchctl list com.gundem.video 2>/dev/null | grep -oE '"LastExitStatus" = -?[0-9]+' | grep -oE -- '-?[0-9]+$')
if [ -n "$LE" ] && [ "$LE" != "0" ]; then
  CODE=$LE; [ "$LE" -gt 255 ] && CODE=$(( LE >> 8 ))
  echo "zamanlayıcının son çıkış kodu: $CODE (ham $LE)"
  if [ "$CODE" = "78" ]; then
    echo "  ❌ 78 = launchd işi HİÇ BAŞLATAMADI. Proje klasörü: $PWD"
    case "$PWD" in "$HOME/Desktop"*|"$HOME/Documents"*|"$HOME/Downloads"*) echo "  → Proje Masaüstü/Belgeler/İndirilenler'de: macOS gizlilik koruması arka plan işini engelliyor. Sistem Ayarları → Gizlilik ve Güvenlik → Tam Disk Erişimi → + → /bin/bash (Cmd+Shift+G: /bin), sonra zamanlayıcıyı kapat/aç; ya da projeyi bu klasörlerin dışına taşı.";; esac
  fi
fi
PL="$HOME/Library/LaunchAgents/com.gundem.video.plist"
[ -f "$PL" ] && echo "üretim saatleri (plist): $(grep -oE '<key>Hour</key><integer>[0-9]+' "$PL" | grep -oE '[0-9]+$' | tr '\n' ' ')"
echo "zamanlayıcının başlattığı son üretimler:"; grep -E "üretim başladı|bu çalıştırma atlandı|✖ üretim" work/launchd.out.log 2>/dev/null | tail -8 | cut -c1-120 || echo "  yok"
echo "zamanlayıcı hata logu (son 8):"; tail -8 work/launchd.err.log 2>/dev/null | clean || echo "  yok"
echo "tüm üretim logları (son 8, panel + zamanlayıcı):"; ls -t work/pipeline-*.log 2>/dev/null | head -8 | sed 's/^/  /' 
echo; echo "--- 3) Son videolar"
ls -lt out/*.mp4 2>/dev/null | head -3 | awk '{print $6, $7, $8, $9}'
echo; echo "--- 4) Üretim kilidi"
if [ -d work/pipeline.lock ]; then P=$(cat work/pipeline.lock/pid 2>/dev/null); if kill -0 "$P" 2>/dev/null; then echo "⚠️ kilit var, süreç ($P) ÇALIŞIYOR, başlama: $(stat -f '%Sm' work/pipeline.lock 2>/dev/null || stat -c '%y' work/pipeline.lock)"; ps -o pid,etime,command -p "$P" | cut -c1-160; else echo "eski kilit var (süreç yok) — sonraki üretim temizler"; fi; else echo "kilit yok (takılı üretim yok)"; fi
echo; echo "--- 5) Uyku / uyanma (son 10)"
pmset -g log 2>/dev/null | grep -E "^[0-9-]+ [0-9:]+ [+-][0-9]{4} (Sleep|Wake|DarkWake)[[:space:]]" | grep -v "Maintenance" | tail -10 | cut -c1-140 || echo "pmset yok"
pmset -g 2>/dev/null | grep -E "^ (sleep|disksleep|displaysleep|lidwake|powernap)" | head -5
pmset -g batt 2>/dev/null | head -2
echo; echo "--- 6) Zamanlayıcı üretim logu (son 20)"
tail -40 work/launchd.out.log 2>/dev/null | clean | tail -20 || echo "yok"
echo; echo "--- 7) Panel logu (son 20)"
tail -60 work/panel.log 2>/dev/null | clean | tail -20 || echo "yok (panel terminalde çalışıyorsa log terminalde)"
echo; echo "--- 8) Disk"
df -h . | tail -1
echo; echo "Bu çıktının tamamını kopyalayıp gönderin (gizli anahtar içermez)."
