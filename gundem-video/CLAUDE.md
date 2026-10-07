# Türkiye Gündemi — otomatik Shorts üretim hattı

Her 5 saatte bir, 30 saniyelik, dikey (1080x1920) "Türkiye Gündemi" videosu üretir.
Tüm üretim yerel makinede çalışır: Remotion (video), Piper veya macOS `say` (ses), ffmpeg.
Tek dış bağımlılık haber RSS kaynakları ve senaryoyu yazan Claude'dur.

## Akış
1. `scripts/fetch_news.py` → RSS'lerden başlıklar (`work/news.json`)
2. `claude -p` + `prompts/senaryo.md` → 6 segmentlik senaryo JSON (`work/claude_out.json`)
3. `scripts/assemble_script.py` → doğrulama + tarih/bölüm no (`work/script.json`)
4. `scripts/tts.py` → segment başına wav + süre (`public/episode.json`)
5. `npx remotion render` → `out/YYYY-MM-DD-N.mp4` (N = günün kaçıncı videosu)

`pipeline.sh` bu adımları sırayla çalıştırır; launchd 5 saatte bir tetikler.

## Kanal kimliği (değiştirirken tutarlı kal)
- Renkler `src/theme.ts`: koyu lacivert zemin, kırmızı vurgu (#E30A17), beyaz başlık, gri alt metin.
- Ton: resmi, sakin, tarafsız haber dili. Yorum ve sansasyon yok.
- Yapı: intro (kanal adı + tarih + "Günün N. özeti") → 4 haber kartı → outro ("5 saat sonra yeni özet").
- Toplam seslendirme ≤ 90 kelime. Bu sınır `assemble_script.py` ile zorlanır.
- Her haber kartında kaynak adı görünür.

## Kurallar
- Zamanlama sesten gelir: `episode.json` içindeki `duration` değerleri her segmentin gerçek ses
  süresidir. Sahne süresini elle sabitleme.
- Yeni sahne tipi eklerken `src/types.ts` içindeki `Segment.kind` ve `GundemVideo.tsx` eşlemesini
  birlikte güncelle.
- Senaryo kurallarını `prompts/senaryo.md` içinde değiştir, kod içinde değil.
- Önizleme: `npm run studio`. Sessiz hızlı test: `TTS_ENGINE=silent bash pipeline.sh`.
- `out/`, `work/`, `public/audio/`, `voices/*.onnx` git'e girmez.
