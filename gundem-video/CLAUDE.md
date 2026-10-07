# Türkiye Gündemi — otomatik Shorts üretim hattı

Her 5 saatte bir (veya panelden istendiğinde), 15-180 saniyelik, dikey (1080x1920) "Türkiye Gündemi"
videosu üretir. Varsayılan 30 sn.
Tüm üretim yerel makinede çalışır: Remotion (video), Piper veya macOS `say` (ses), ffmpeg.
Tek dış bağımlılık haber RSS kaynakları ve senaryoyu yazan Claude'dur.

## Akış
1. `scripts/fetch_news.py` → RSS'lerden başlıklar (`work/news.json`)
2. `claude -p` + `prompts/senaryo.md` → 6 segmentlik senaryo JSON (`work/claude_out.json`)
3. `scripts/assemble_script.py` → doğrulama + tarih/bölüm no (`work/script.json`)
4. `scripts/tts.py` → segment başına wav + süre (`public/episode.json`)
5. `npx remotion render` → `out/YYYY-MM-DD-N.mp4` (N = günün kaçıncı videosu)

`pipeline.sh` bu adımları sırayla çalıştırır; launchd 5 saatte bir tetikler. `DURATION=60 bash pipeline.sh`
süreyi belirler: kelime bütçesi = süre × 2.4, haber sayısı = süre / 8 (2-12 arası). Prompt'taki
`__SURE__`, `__KELIME__`, `__HABER__` yer tutucuları pipeline tarafından doldurulur.
Token: Claude'a `scripts/slim_news.py` ile küçültülmüş set gider (en yeni `NEWS_MAX`=20 haber, 200
karakter özet, link yok). Ölçüm (60 sn): ~45k girdi (çoğu Claude Code'un kendi yükü, önbellekli),
~2k çıktı, ≈0,11 $ API karşılığı. Haber setini büyütmek seçimi iyileştirmez, token artırır.
Effort: `settings.claudeEffort` {script: "medium", brain: "high"} → `claude -p --effort`. Ölçüm: medium
2,3k çıktı, high ~4k, xhigh 2-3k (değişken); haber/kategori seçimi üçünde aynı. Her çağrı
`--output-format json` ile çalışır; `scripts/claude_result.py` (pipeline) ve `brain.js` kullanımı
loga (🧮) ve `data/usage.json`a (gün/toplam/tür) yazar. Panel Ayarlar'da gösterir.
Kaynak: `server.js` her 10 sn CPU/RAM örnekler; üretim, ses modeli yükleme veya geliştirme
sürerken loga (⚙) yazar, başlıkta rozet olarak durur.

## EMIXHAS paneli (`npm run panel` → http://localhost:3131)
`app/server.js` (Express) + `app/ui/index.html` + `app/brain.js` + `app/commands.js`.
- Sesli/yazılı komut: önce `commands.js` kuralları (hızlı, token yok: üret, oynat, durum, paylaş,
  zamanlayıcı, izlenme güncelle, yayınla). Kural yoksa veya cümle bileşikse → beyin.
- Beyin (`brain.js`): bağlam (videolar+metrikler, insights, bağlantılar, zamanlayıcı, ayarlar, son
  log, hafıza) + `prompts/emixhas.md` → `claude -p` → JSON {reply, report, actions}. Modlar: chat,
  report (günlük rapor), plan (7 günlük plan). Raporlar `data/reports/`, hafıza `data/memory.json`.
- Eylemler: generate/schedule/note/sync_metrics/open_video/settings/improvement/restart doğrudan
  çalışır. publish/autopublish: `settings.fullAuthority` true ise doğrudan (varsayılan), false ise
  `pending` döner ve UI onay ister (`POST /api/actions`).
- Kendini geliştirme: Emixhas kodu kendisi DEĞİŞTİRMEZ. `improvement` eylemi görevi
  `data/improvements.md` kuyruğuna yazar; kullanıcı Claude Code ile uygular. Bu bilinçli bir sınır:
  panelden tetiklenen izinsiz kod düzenleme ajanı kurulmaz. Ayarla çözülebilen şey `settings` ile.
- Uyandırma: `settings.assistantName` ("Emixhas") ve `settings.wakeWords` (tanıma varyantları).
  UI "Sürekli dinle" açıkken yalnızca uyandırma sözcüğü geçen cümleyi işler; sözcük tek başına
  söylenirse 8 sn dinleme penceresi açar ("Buyur."). Konuşurken mikrofon kapatılır (kendini duymaz).
  "dur/sus/yeter" konuşmayı keser.
- Ses: `settings.voice` {engine auto|say|piper, name Yelda, rate kelime/dk, piperLength, piperNoise}.
  auto: macOS'ta Yelda varsa `say` (daha doğal), yoksa Piper. "sesini hızlandır/yavaşlat" kuralı
  rate'i ±25 değiştirir; beyin de `settings` eylemiyle değiştirebilir. Video anlatımı
  `settings.narrationEngine` (piper|say).
- `scripts/panel.sh` paneli döngüde çalıştırır; çıkış kodu 75 = yeniden başlat (`restart` eylemi).
- Canlı log (`push()` → SSE): üretim adımları, beyin (🧠 düşünüyor / ⚡ eylem / ⏸ onay), yayın (📤),
  metrik (📊), tünel (☁), doğal ses (🎤), kod değişiklikleri (✎ fs.watch: src/app/scripts/prompts),
  git commit (⎇), geliştirme kuyruğu (🛠). UI sağ sütunda yapışkan; satır öneki rengi belirler.
  Yeni bir işlem eklerken `push()` ile logla, sessiz çalışan şey olmasın.
- Doğal ses: `scripts/tts_server.py` Chatterbox Multilingual (MIT, Türkçe, klonlama) modelini bir kez
  yükler, :3139'da HTTP sunar. `scripts/natural_tts.py` istemci; `tts.py`/`speak.py` motor
  "chatterbox" seçiliyse buraya gider, sunucu hazır değilse Yelda/Piper'a düşer (loga yazar).
  Kurulum `scripts/install_voice.sh` (torch+chatterbox-tts, ~3 GB). Ayarlar `settings.chatterbox`
  {refVoice, exaggeration, cfg, autoStart}. Çıktıya duyulmayan PerTh filigranı eklenir (model özelliği).
  Klon sesi için yalnızca kullanıcının kendi sesi veya izinli bir kayıt kullanılır.
- Arka plan: her dakika kontrol → bağlı hesap varsa `metricsSyncMinutes` aralığıyla senkron;
  `dailyReportHour`'da günlük rapor üretilip SSE `jarvis` olayıyla panele seslendirilir.
- Küre: canvas, mikrofon ve Emixhas sesi için Web Audio analyser; renk = durum (hazır cyan,
  dinliyor yeşil, düşünüyor amber, konuşuyor pembe, üretiyor kırmızı).
- Yanıtlar `scripts/speak.py` ile Piper'dan seslendirilir (yoksa tarayıcı sesi).
- Üretim: süre kaydırıcısı → `POST /api/generate` → `pipeline.sh` spawn, log SSE ile canlı akar.
- Videolar: `out/*.mp4` + yanındaki `.json` meta. Küçük resimler `work/thumbs/` (ffmpeg).
- Paylaşım: QR ile telefona yerel link (aynı Wi-Fi); Finder'da göster; indir; YouTube/Instagram'a yükle.
- Zamanlayıcı: panel launchd plist'ini yazar/siler (`~/Library/LaunchAgents/com.gundem.video.plist`).
- Yeni sesli komut: `app/commands.js` içine kural, `server.js` içindeki switch'e eylem. Kural
  regex'lerinde kelime sınırı kullan ("niye" ↔ "saniyelik" tuzağı).

## WhatsApp köprüsü (`app/whatsapp.js`, Baileys)
- QR panelden okutulur; oturum `secrets/wa-auth/`. Yalnızca `settings.whatsapp.owner` numarasından
  gelen mesajlar işlenir (0532… → 90532…), gruplar yok sayılır.
- Yeni video (panelden ya da launchd'den; `out/` izlenir) → sahibine: başlıklar + seslendirme metni,
  Wi-Fi linki, tünel açıksa dış link, ayar açıksa video dosyasının kendisi; bağlı platform varsa
  "onay" ister. "onay/evet/yayınla" → bağlı platformlara yayın; "iptal" → yayınlanmaz.
- Diğer mesajlar `handleCommand()` üzerinden aynı kural+beyin yoluna gider; yanıt düz metin döner.
- Video dosyası 60 MB üstündeyse gönderilmez, link kalır. WhatsApp bağlı değilken bildirim loga düşer.

## Yayın ve analitik
- `scripts/publish.py`: YouTube (Data API v3, OAuth; `secrets/youtube_client.json` → token) ve
  Instagram Reels (Graph API; videoyu `PUBLIC_BASE_URL/videos/<ad>` adresinden çeker, bu yüzden
  herkese açık bir URL/tünel şart). Sonuç `data/metrics.json` → `videos.<ad>.<platform>`.
- TikTok (`tt_*` fonksiyonları): Login Kit OAuth (yerel geri dönüş sunucusu :3137), Content Posting API
  FILE_UPLOAD. `TIKTOK_MODE=inbox` → gelen kutusu taslağı (onaysız uygulamada çalışır);
  `direct` → doğrudan yayın (privacy creator_info'dan; onaysız uygulamada SELF_ONLY). Token 24 saat,
  refresh otomatik. Metrikler `/v2/video/list/` (view/like/comment/share).
- `scripts/sync_metrics.py`: izlenme/beğeni/yorum (YT), plays/reach/shares/saves (IG), TikTok sayaçları.
- `scripts/analyze.py`: kategori/süre/saat ortalamaları, en iyi 5, manşet etkisi → `data/insights.json`
  ve `data/prompt_hint.txt`. Pipeline bu ipucunu `__IPUCU__` olarak senaryo prompt'una verir:
  öğrenme döngüsü budur. İpucu kurallarla çelişirse kurallar kazanır (prompt'ta yazılı).
- `scripts/post_pipeline.py`: üretim sonunda ayarlardaki otomatik yayın + analiz. launchd ile
  panel kapalıyken de çalışır.
- Başlık/açıklama `scripts/common.py: build_caption` üretir (ilk haber başlığı + kanal adı + #Shorts).
- YouTube API kotası: günde 10.000 birim, bir yükleme ~1.600 → günde en fazla 6 yükleme.

## Kanal kimliği (değiştirirken tutarlı kal)
- Renkler `src/theme.ts`: koyu lacivert zemin, kırmızı vurgu (#E30A17), beyaz başlık, gri alt metin.
- Ton: resmi, sakin, tarafsız haber dili. Yorum ve sansasyon yok.
- Yapı: intro (kanal adı + tarih + "Günün N. özeti") → N haber kartı (30 sn'de 4) → outro.
- Toplam seslendirme ≤ süre × 2.4 kelime. Bu sınır `assemble_script.py` ile zorlanır.
- Her haber kartında kaynak adı görünür.

## Kategori sistemi (SABİT, her videoda aynı)
Claude senaryoda her habere `category` atar; görsel ve ses bu eşlemeden gelir, haber başına
değişmez. Eşleme `src/categories.ts` içindedir ve tek doğru kaynak odur:

| category  | etiket    | vurgu rengi | illüstrasyon (kodla çizilir)        | ses efekti (kodla sentezlenir) |
|-----------|-----------|-------------|-------------------------------------|--------------------------------|
| finans    | EKONOMİ   | #F2B705     | yükselen grafik + ₺ paralar         | sfx/kasa.wav (ka-ching)        |
| siyaset   | SİYASET   | #E30A17     | kürsü + vuran tokmak                | sfx/tokmak.wav                 |
| spor      | SPOR      | #2ECC71     | kaleye giden top                    | sfx/duduk.wav                  |
| hava      | HAVA      | #4FC3F7     | güneş, bulut, yağmur                | sfx/yagmur.wav                 |
| toplum    | TOPLUM    | #FF8A3D     | yanan pencereli şehir + araba       | sfx/sehir.wav                  |
| teknoloji | TEKNOLOJİ | #8E7CFF     | ağ düğümleri + dolaşan paket        | sfx/blip.wav                   |
| saglik    | SAĞLIK    | #FF5C8A     | EKG çizgisi + atan kalp             | sfx/kalp.wav                   |
| dunya     | DÜNYA     | #36D1C4     | dönen küre + uydu                   | sfx/dunya.wav                  |
| parti     | SİYASET   | #E30A17     | kürsüden kürsüye yürüyen silüet, konfeti | sfx/tokmak.wav            |
| egitim    | EĞİTİM    | #FFB020     | okul, sallanan zil, uyarı üçgeni    | sfx/okul.wav                   |
| genel     | GÜNDEM    | #FFFFFF     | gazete + zil                        | sfx/bildirim.wav               |

`parti`: parti değişimi, istifa, transfer, atama haberleri. Parti renkleri veya logoları
kullanılmaz; sol kürsü gri, sağ kürsü kanal kırmızısı. `siyaset`: diğer tüm siyaset haberleri.

## SON DAKİKA manşeti
Claude, günün açık ara en büyük haberine `"breaking": true` verir (en fazla bir habere,
`assemble_script.py` fazlasını siler). Bu kart: kırmızı flaş, kısa sarsıntı, üstte nabız gibi
atan "SON DAKİKA" şeridi, daha büyük başlık ve `sfx/sondakika.wav`. Sıradan günlerde hiçbir
habere verilmez; her videoda manşet olması etkisini öldürür.

Sabit sahne sesleri: intro → `sfx/sting.wav`, outro → `sfx/chime.wav`, her sahne geçişi →
`sfx/whoosh.wav`. Ses efektleri seslendirmenin altında kalır (`sfxVolume`, 0.35-0.55).

- Yeni kategori eklemek için: `CATEGORIES` listesine ekle, `src/illustrations/` altına bileşen yaz,
  `scripts/make_sfx.py` içinde sesi sentezle ve çalıştır, `prompts/senaryo.md` listesini ve
  `scripts/assemble_script.py` içindeki `CATEGORIES` kümesini güncelle. Beşi birlikte değişir.
- Bilinmeyen kategori `genel`e düşer; bu durum logda uyarı olarak görünür.
- Ses efektleri harici dosya değildir: `python3 scripts/make_sfx.py` hepsini yeniden üretir.
  Bir sesi değiştirmek için o betikteki parametreleri değiştir, dışarıdan dosya ekleme.

## Ses ayarları (ölçülerek belirlendi)
- Piper `length_scale` 0.82 ≈ 150 kelime/dk. 1.0 fazla yavaştı (~120). Değiştirmek için
  `PIPER_LENGTH_SCALE=0.78 bash pipeline.sh` gibi; 0.75'in altı anlaşılırlığı bozar.
- Segment sonu sessizliği 0.15 sn + Piper cümle boşluğu 0.12 sn.
- Son MP4 ffmpeg loudnorm ile -14 LUFS'a getirilir (YouTube hedefi). Remotion çıktısı ~-17.6 idi.

## Kurallar
- Zamanlama sesten gelir: `episode.json` içindeki `duration` değerleri her segmentin gerçek ses
  süresidir. Sahne süresini elle sabitleme.
- Yeni sahne tipi eklerken `src/types.ts` içindeki `Segment.kind` ve `GundemVideo.tsx` eşlemesini
  birlikte güncelle.
- Senaryo kurallarını `prompts/senaryo.md` içinde değiştir, kod içinde değil.
- Kısaltma yok: prompt açık yazdırır (AKP → AK Parti, TCMB → Merkez Bankası…); `assemble_script.py`
  `expand_abbr()` güvenlik ağıdır ve Türkçe ek uyumunu düzeltir (TBMM'de → Meclis'te, ABD'den →
  Amerika'dan, MEB'in → Milli Eğitim Bakanlığı'nın). Yeni kısaltma eklerken `ABBR` listesine yaz;
  tamlama olmayan çok kelimeli açılımları `NOT_POSSESSIVE` kümesine ekle.
- UI ses katmanı (`index.html` "SES KATMANI"): durum makinesi idle→listening→thinking→speaking.
  AudioContext kullanıcı hareketiyle açılır; askıdaysa ses doğrudan oynatılır (sessiz kalma hatası).
  Konuşma için zaman aşımı (8 sn + 90 ms/karakter), düşünme için 150 sn; "paused" bayrağı her bitişte
  sıfırlanır. Küreye tıklama konuşmayı keser ve dinlemeye geçer. Teşhis satırı: mikrofon/ses/tanıma.
- Önizleme: `npm run studio`. Sessiz hızlı test: `TTS_ENGINE=silent bash pipeline.sh`.
- `out/`, `work/`, `public/audio/`, `voices/*.onnx` git'e girmez.
