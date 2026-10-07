# Türkiye Gündemi — 30 saniyelik otomatik gündem videosu

Her 5 saatte bir, tamamen yerel olarak üretilen dikey (Shorts) haber özeti.
Video: Remotion. Ses: Piper TTS (veya macOS'un kendi Türkçe sesi). Senaryo: Claude Code.

## Kurulum (macOS, Apple Silicon)

```bash
brew install node ffmpeg python@3.12
npm install -g @anthropic-ai/claude-code   # zaten kuruluysa atla
npm install

# Seslendirme — Seçenek A: Piper (önerilen, daha doğal)
python3 -m venv .venv && source .venv/bin/activate
pip install piper-tts certifi
export SSL_CERT_FILE=$(python3 -c "import certifi; print(certifi.where())")
python3 -m piper.download_voices tr_TR-dfki-medium --download-dir voices
ls -la voices   # .onnx dosyası ~60 MB olmalı

# Seçenek B: hiçbir şey kurmadan macOS'un Yelda sesi
# Sistem Ayarları > Erişilebilirlik > Konuşulan İçerik > Türkçe (Yelda) sesini indir.
# Piper modeli yoksa tts.py otomatik olarak 'say' kullanır.
```

Piper deposunda şu an tek Türkçe ses var: `tr_TR-dfki-medium`. Başka bir .onnx modeliniz varsa
`PIPER_VOICE=voices/baska-model.onnx bash pipeline.sh` ile kullanın.

## İlk test

```bash
mkdir -p work && cp prompts/ornek_senaryo.json work/claude_out.json
TTS_ENGINE=silent SKIP_CLAUDE=1 bash pipeline.sh   # örnek senaryoyla sessiz render
bash pipeline.sh                                   # gerçek üretim
npm run studio                                     # tarayıcıda canlı önizleme
```

Çıktı: `out/2026-10-07-1.mp4` ve yanında `out/2026-10-07-1.json` (senaryo kaydı).

## Görsel ve ses kimliği
Her haber, Claude'un atadığı kategoriye göre sabit bir animasyonlu illüstrasyon ve ses efektiyle
gelir (ekonomi → grafik ve ₺ paralar + kasa sesi, spor → top ve kale + düdük, hava → yağmur…).
Eşleme `src/categories.ts`, sesler `scripts/make_sfx.py` ile kodla üretilir; indirilen dosya yok.
Tam tablo `CLAUDE.md` içinde.

## 5 saatte bir otomatik çalıştırma

```bash
sed "s|__PROJE_YOLU__|$(pwd)|g" launchd/com.gundem.video.plist > ~/Library/LaunchAgents/com.gundem.video.plist
launchctl load ~/Library/LaunchAgents/com.gundem.video.plist
# durdurmak için: launchctl unload ~/Library/LaunchAgents/com.gundem.video.plist
```

Loglar `work/` altında. Mac uyku modundaysa kaçan çalışma uyanınca bir kez telafi edilir.
Mac kapalıyken üretim olmaz; kesintisiz üretim için Mac'in uyumasını kapatın veya bir Mac mini kullanın.

## YouTube'a yükleme
Bu proje bilinçli olarak yükleme yapmaz; üretim tamamen yerel kalır. Yükleme için üç yol:
1. `out/` klasöründen elle yükleme.
2. Metricool gibi bağlı bir planlama aracına bırakma.
3. YouTube Data API ile otomatik yükleme (Google OAuth gerektirir, dış bağımlılık).

## Sorumluluk notu
Haber başlıkları kamuya açık RSS kaynaklarından alınır ve her kartta kaynak adı gösterilir.
Senaryo kaynakta olmayan bilgi eklememek üzere yazdırılır; yine de yayınlamadan önce ilk
videoları gözden geçirin. Otomatik yayın kararı size aittir.
