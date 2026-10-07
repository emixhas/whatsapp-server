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
Farklı süre: `DURATION=60 bash pipeline.sh` (15-180 sn).

## Görsel ve ses kimliği
Her haber, Claude'un atadığı kategoriye göre sabit bir animasyonlu illüstrasyon ve ses efektiyle
gelir (ekonomi → grafik ve ₺ paralar + kasa sesi, spor → top ve kale + düdük, hava → yağmur…).
Eşleme `src/categories.ts`, sesler `scripts/make_sfx.py` ile kodla üretilir; indirilen dosya yok.
Tam tablo `CLAUDE.md` içinde.

## EMIXHAS paneli

```bash
pip install -r requirements.txt     # .venv aktifken
npm run panel
```

Tarayıcıda `http://localhost:3131` açın (Safari veya Chrome; konuşma tanıma için mikrofon izni verin).
- Küreye tıklayıp konuşun: "altmış saniyelik video üret", "son videoyu oynat", "paylaş", "durum",
  "zamanlayıcıyı kapat", "her 3 saatte bir otomatik üret", "sesini hızlandır".
- "Sürekli dinle" açıkken "Emixhas" deyince uyanır: "Emixhas, 60 saniyelik video üret" tek seferde
  çalışır; sadece "Emixhas" derseniz "Buyur" der ve 8 saniye komut bekler. Konuşurken sizi dinlemez,
  "dur" deyince susar.
- Ses: macOS'ta en doğal sonuç için Sistem Ayarları → Erişilebilirlik → Konuşulan İçerik → Sistem Sesi
  → Sesleri Yönet → Türkçe → **Yelda (Premium)** indirin. Panel bunu otomatik kullanır; yoksa Piper'a
  döner. Hızı "sesini hızlandır / yavaşlat" ile ya da Ayarlar'dan değiştirin.
- Tarayıcı komutları: "Emixhas, YouTube'dan Sezen Aksu Gülümse'yi aç" ilk sonucu Safari'de açar
  (`pip install yt-dlp` kuruluysa doğrudan videoyu, yoksa arama sayfasını). "sabah.com.tr sitesini aç",
  "google'da dolar kuru ara" da çalışır.
- Emixhas kod değişikliği gerektiren bir istek alırsa (yeni animasyon, intro süresi gibi) görevi
  `data/improvements.md` kuyruğuna yazar. Uygulamak için proje klasöründe Claude Code'u açıp o
  dosyadaki görevi vermeniz yeterli; panel kendi kodunu kendisi değiştirmez.
- Süre kaydırıcısı 15-120 sn; haber sayısı ve kelime bütçesi otomatik ayarlanır.
- Videoya tıklayın: oynat, indir, Finder'da göster, sil, telefona QR ile gönder (aynı Wi-Fi).
- Otomatik üretim anahtarı launchd zamanlayıcısını panelden açıp kapatır.

- Jarvis'e yazın veya söyleyin: "günlük rapor ver", "bu hafta için plan yap", "hangi video en çok
  izlendi", "izmir videosunu aç ve 45 saniyelik yeni bir tane başlat". Kural dışı her şey Claude'a
  gider (token harcar); üret/oynat/durum gibi basit komutlar kural tabanlıdır (token harcamaz).
- Yayınlama ve otomatik yayın gibi geri alınamaz eylemler panelde onay ister.

Panel kapalıyken de launchd üretimi sürer; panel yalnızca kontrol ve izleme içindir.

## YouTube ve Instagram bağlantısı

**YouTube (önerilen ilk adım)**
1. console.cloud.google.com → yeni proje → "YouTube Data API v3" etkinleştir.
2. OAuth izin ekranı: Harici, test kullanıcısı olarak kendi Google hesabınızı ekleyin.
3. Kimlik bilgileri → OAuth istemci kimliği → Masaüstü uygulaması → JSON indir →
   `secrets/youtube_client.json` olarak kaydedin.
4. Panelde "YouTube'u bağla" (veya `python3 scripts/publish.py --connect youtube`). Tarayıcıda
   Google girişi açılır, kanal hesabınızla onaylayın.
5. Videoda "YouTube'a yükle" düğmesi aktif olur. Kota: günde en fazla 6 yükleme.

**Instagram Reels**
1. Instagram hesabı İşletme veya İçerik Üretici olmalı ve bir Facebook Sayfasına bağlı olmalı.
2. developers.facebook.com → uygulama → Instagram Graph API; `instagram_content_publish`,
   `instagram_manage_insights`, `pages_read_engagement` izinleriyle uzun ömürlü token alın.
3. Instagram videoyu yerel diskten almaz, herkese açık bir URL'den çeker. Panelin `/videos/` yolunu
   dışarı açmanın en kolay yolu Cloudflare Tunnel: `brew install cloudflared` →
   `cloudflared tunnel --url http://localhost:3131` → verilen `https://....trycloudflare.com` adresi.
   Kalıcı kullanım için adlandırılmış tünel kurun; geçici adres her başlatmada değişir.
4. `secrets/.env` içine `IG_USER_ID`, `IG_ACCESS_TOKEN`, `PUBLIC_BASE_URL` yazın (örnek:
   `secrets/README.md`).

**TikTok**
1. developers.tiktok.com → Manage apps → uygulama oluştur → ürün olarak **Login Kit** ve
   **Content Posting API** ekleyin; scope'lar: user.info.basic, video.list, video.upload, video.publish.
2. Login Kit → Redirect URI: `http://localhost:3137/tiktok/callback` (TikTok http localhost'u kabul
   etmezse Cloudflare Tunnel adresinizi yazın ve `.env` içinde TIKTOK_REDIRECT_URI'yi aynı yapın).
3. Client key ve secret'ı `secrets/.env` içine yazın (`secrets/README.md`), panelde "TikTok'u bağla".
4. Mod: `TIKTOK_MODE=inbox` (varsayılan) videoyu TikTok gelen kutunuza taslak olarak gönderir; telefonda
   bildirime dokunup yayınlarsınız, uygulama onayı gerekmez. `direct` doğrudan yayınlar ama TikTok
   uygulamanızı denetleyip onaylamadan paylaşımlar yalnızca size görünür. Onay 2-6 hafta sürebilir;
   onaydan sonra `direct`'e geçin.
5. İzlenme/beğeni/paylaşım verisi `video.list` ile çekilir ve analitiğe girer.

Bağlantı yoksa yayınlama ve izlenme senkronu devre dışı kalır; üretim, QR ile telefona gönderme ve
elle yükleme çalışmaya devam eder.

## 5 saatte bir otomatik çalıştırma (panelsiz)

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
