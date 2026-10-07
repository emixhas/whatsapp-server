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
pip install piper-tts
mkdir -p voices && cd voices
B=https://huggingface.co/rhasspy/piper-voices/resolve/main/tr/tr_TR/fahrettin/medium
curl -L -o tr_TR-fahrettin-medium.onnx      $B/tr_TR-fahrettin-medium.onnx
curl -L -o tr_TR-fahrettin-medium.onnx.json $B/tr_TR-fahrettin-medium.onnx.json
cd ..

# Seçenek B: hiçbir şey kurmadan macOS'un Yelda sesi
# Sistem Ayarları > Erişilebilirlik > Konuşulan İçerik > Türkçe (Yelda) sesini indir.
# Piper modeli yoksa tts.py otomatik olarak 'say' kullanır.
```

Diğer Türkçe Piper sesleri: `dfki` ve `fettah` (aynı adres yapısı). Değiştirmek için
`PIPER_VOICE=voices/tr_TR-fettah-medium.onnx bash pipeline.sh`.

## İlk test

```bash
mkdir -p work && cp prompts/ornek_senaryo.json work/claude_out.json
TTS_ENGINE=silent SKIP_CLAUDE=1 bash pipeline.sh   # örnek senaryoyla sessiz render
bash pipeline.sh                                   # gerçek üretim
npm run studio                                     # tarayıcıda canlı önizleme
```

Çıktı: `out/2026-10-07-1.mp4` ve yanında `out/2026-10-07-1.json` (senaryo kaydı).

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
