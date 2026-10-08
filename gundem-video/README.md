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

### Seçenek C (önerilen): Türkçe doğal ses — Trendyol-TTS + EMA Lightning

```bash
bash scripts/install_turkish_voice.sh   # bir kez, ~5 GB; Python 3.11 ortamı (.venv-tr) kurar
afplay work/trendyol-test.wav           # deneme sesini dinle
```

- **Trendyol-TTS**: VoxCPM2 tabanlı Türkçe model (MIT). 2026 Türkçe ölçümlerinde (Freya-TR-Eval) kelime hata
  oranı yüzde 1'in altında, doğallık puanı ElevenLabs v4'ün üstünde. Apple Silicon'da MLX ile yerel çalışır;
  60 saniyelik video için birkaç dakika üretim. Klon sesi için `settings.turkishVoice.refVoice` (PyTorch yolu).
- **EMA Lightning**: 8.6 milyon parametre, 34 MB, Apache-2.0; CPU'da gerçek zamanın 6 katı hızlı, hata oranı
  yüzde 0.9. Emixhas'ın anlık konuşması ve Trendyol çalışmazsa video için yedek.
- Rakamlar seslendirmeden önce otomatik yazıya çevrilir (`scripts/tr_numbers.py`): "3 kişi" → "üç kişi",
  "yüzde 46", "iki bin yirmi altıda", "on dörtte".
- Panel → Ayarlar → **SESLER**: her sesi ▶ ile dinleyin, tek ses ya da "kadın + erkek dönüşümlü" seçin
  (1. haber kadın, 2. haber erkek…). Kadın/erkek spiker sesleri VoxCPM2 tabanından ses tasarımıyla gelir;
  kendi klonunuz için `voices/klon/ad.wav` koyun. Otomatik sıra: Trendyol → EMA → Chatterbox → Yelda → Piper.

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
- Video anlatımı varsayılan olarak **Otomatik**: doğal ses sunucusu hazırsa Chatterbox, değilse Mac'in
  Yelda sesi, o da yoksa Piper. Her anlatım yayın kalitesi işlemeden geçer (EQ, kompresyon).
- **Doğal ses (ElevenLabs'e en yakın yerel seçenek):** Chatterbox Multilingual, MIT lisanslı, Türkçe
  destekli, 5-10 sn örnekle ses klonlar, Apple Silicon'da çalışır. Kurulum bir kez:
  `bash scripts/install_voice.sh` (~3 GB). Sonra panelde Ayarlar → "Doğal sesi başlat" (ilk açılışta
  model iner, canlı logda görünür), "Video anlatımı: Doğal ses" seçin. Kendi sesinizi kullanmak için
  temiz bir 5-10 saniyelik kaydı `voices/ref.wav` olarak koyun. Hız: 30 sn anlatım M5 Pro'da
  yaklaşık yarım dakika ile bir dakika arası sürer; Emixhas'ın kısa yanıtları 2-4 sn.
- Canlı log sağ üstte sabit durur: üretim adımları, beynin düşünmesi ve eylemleri, yayın, tünel, ses
  motoru ve Claude Code ile yaptığınız kod değişiklikleri (dosya ve commit) anlık akar.
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

## WhatsApp'tan kontrol ve onay

Ayarlar → WhatsApp → "WhatsApp'ı bağla": telefonda WhatsApp → Bağlı Cihazlar → Cihaz Bağla → QR'ı
okutun. Sahip numarası ayarlarda (varsayılan 0532 130 88 27). Bundan sonra:
- Her video bitince WhatsApp'a başlıklar, seslendirme metni, izleme linkleri ve video dosyası gelir.
- "onay" yazınca bağlı platformlara (YouTube, Instagram, TikTok) yayınlanır; "iptal" yazınca yayınlanmaz.
- "60 saniyelik video üret", "durum", "rapor", "son videoyu gönder" gibi komutlar WhatsApp'tan da çalışır.
Wi-Fi linki aynı ağda açılır; dışarıdayken izlemek için tünel açık olmalı (link otomatik eklenir) ya da
gönderilen video dosyasını doğrudan WhatsApp'ta oynatın.

## YouTube ve Instagram bağlantısı

**YouTube (önerilen ilk adım)**
1. console.cloud.google.com → yeni proje → "YouTube Data API v3" etkinleştir.
2. OAuth izin ekranı: Harici, test kullanıcısı olarak kendi Google hesabınızı ekleyin.
3. Kimlik bilgileri → OAuth istemci kimliği → Masaüstü uygulaması → JSON indir →
   `secrets/youtube_client.json` olarak kaydedin.
4. Panelde "YouTube'u bağla" (veya `python3 scripts/publish.py --connect youtube`). Tarayıcıda
   Google girişi açılır, kanal hesabınızla onaylayın.
5. Videoda "YouTube'a yükle" düğmesi aktif olur. Kota: günde en fazla 6 yükleme.

**Instagram Reels (panelden tek tıkla, Facebook sayfası gerekmez)**
1. Instagram hesabı Profesyonel olmalı (İşletme ya da İçerik üretici): Instagram → Ayarlar → Hesap türü.
2. developers.facebook.com → Uygulama oluştur → ürün olarak **Instagram** → "Instagram ile API kurulumu"
   (Instagram Login). Instagram app ID ve app secret değerlerini `secrets/.env` içine `IG_APP_ID` ve
   `IG_APP_SECRET` olarak yazın.
3. Aynı sayfada "OAuth redirect URIs" alanına `https://<tünel-adresi>/instagram/callback` ekleyin. Panel
   tüneli açınca adresi Ayarlar → Instagram bölümünde gösterir. Hızlı tünelin adresi her açılışta
   değişir; kalıcı adres için aşağıdaki adlı tüneli kurun (önerilir).
4. Uygulama Geliştirme modundayken yalnızca test kullanıcıları giriş yapabilir: Uygulama rolleri →
   Instagram Testers → kendi hesabınızı ekleyin; Instagram → Ayarlar → Uygulamalar ve web siteleri →
   Test davetleri'nden kabul edin. (Yayına almak için Meta'nın uygulama incelemesi gerekir; kendi
   hesabınız için test modu yeterlidir.)
5. Panelde "Instagram'ı bağla": tünel açılır, tarayıcıda Instagram girişi gelir, izinleri onaylayın.
   Token 60 gün geçerlidir ve kendiliğinden yenilenir (`secrets/instagram_token.json`).
6. Ayarlar → "Üretince Instagram'a otomatik yükle" anahtarını açın. Her üretimden sonra video Reels
   olarak paylaşılır. Panel ya da tünel kapalıysa `publish.py` yayın anında geçici bir Cloudflare
   tüneli açıp kapatır; `cloudflared` kurulu olması yeter. İzlenme, erişim, beğeni ve paylaşım verisi
   analitiğe girer.

*Facebook girişi yolu (uygulamanızda yalnızca "API setup with Facebook login" varsa):* `secrets/.env` içine
`IG_LOGIN=facebook` yazın. Bir Facebook Sayfası oluşturup Instagram profesyonel hesabınızı ona bağlayın
(Instagram → Ayarlar → İşletme araçları → Facebook'a bağlan). Uygulama ayarları → Temel'deki Uygulama
kimliği ve gizli anahtarı `IG_APP_ID` / `IG_APP_SECRET` olarak yazın; Facebook Login ayarlarında
"Valid OAuth Redirect URIs" alanına `https://<tünel>/instagram/callback` ekleyin. "Instagram'ı bağla"
Facebook girişi açar; alınan Sayfa token'ı süresizdir, yenileme gerekmez.

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

**Cloudflare Tunnel**

```bash
brew install cloudflared
```

*Hızlı tünel (hesap gerekmez):* Panelde Bağlantılar → "Tüneli başlat" ya da "Emixhas, tüneli aç".
Panel `https://....trycloudflare.com` adresini yakalar, `secrets/.env` içine PUBLIC_BASE_URL olarak
yazar. Adres her başlatmada değişir; "Panel açılınca otomatik başlat" açıksa her seferinde güncellenir.
Instagram yayını için bu yeterlidir, çünkü adres yayın anında okunur.

*Adlı tünel (kalıcı adres; Cloudflare hesabı ve Cloudflare'de yönetilen bir alan adı gerekir):*

```bash
cloudflared tunnel login                      # tarayıcıda Cloudflare girişi, alan adını seçin
cloudflared tunnel create gundem
cloudflared tunnel route dns gundem video.ALANADINIZ.com
```

Sonra `secrets/.env` içine `TUNNEL_NAME=gundem` ve `TUNNEL_HOSTNAME=video.ALANADINIZ.com` yazın; panel
bundan sonra bu kalıcı adresi kullanır. TikTok redirect URI olarak da
`https://video.ALANADINIZ.com/tiktok/callback` verebilirsiniz (panel bunu TikTok bağlama sürecine aktarır).

*Güvenlik:* Tünel üzerinden gelen istekler yalnızca `/videos/` dosyalarını ve TikTok geri dönüşünü görür;
panel, API ve ayarlar dışarıya kapalıdır. Yine de tünel adresini herkese açık yerlerde paylaşmayın.

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
