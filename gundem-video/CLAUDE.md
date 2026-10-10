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
~2k çıktı. Haber setini büyütmek seçimi iyileştirmez, token artırır. Kullanıcı isteğiyle token/maliyet
bilgisi logda ve panelde GÖSTERİLMEZ; `data/usage.json` sessizce tutulur (effort seçimi panelde kalır).
Effort: `settings.claudeEffort` {script: "medium", brain: "high"} → `claude -p --effort`. Ölçüm: medium
2,3k çıktı, high ~4k, xhigh 2-3k (değişken); haber/kategori seçimi üçünde aynı. Her çağrı
`--output-format json` ile çalışır; `scripts/claude_result.py` (pipeline) ve `brain.js` kullanımı
loga (🧮) ve `data/usage.json`a (gün/toplam/tür) yazar. Panel Ayarlar'da gösterir.
Kaynak: `server.js` her 10 sn CPU/RAM örnekler; üretim, ses modeli yükleme veya geliştirme
sürerken loga (⚙) yazar, başlıkta rozet olarak durur.

## Video özellikleri
- KANCA (ilk 3 sn): her video `hook` segmentiyle açılır: günün en çarpıcı haberinin tek cümlesi
  (≤ 8-10 kelime), 2-4 kelimelik dev ekran başlığı, kırmızı/kategori flaşı, varsa tam ekran fotoğraf,
  `sfx/sondakika.wav`. Sonra kısa intro (kanal kimliği, ≤ 5 kelime), sonra haberler. Claude kanca
  vermezse `assemble_script` ilk haberin ilk cümlesinden üretir. `Hook.tsx` sinematik giriş: beyaz flaş →
  kategori flaşı + şok dalgası halkası, medya 1.35x bulanıktan netleşerek punch-in, 9 kare sarsıntı, başlık
  kelime kelime çarparak iner (anahtar kelime: rakamlı kelime, yoksa son kelime, sarı kutuda; diğerleri siyah
  kontürlü), ilk 14 karede ve 32-35'te RGB kayması, 18-40 arası ışık süpürmesi, dönen huzmeler, tarama
  çizgisi, vinyet; SON DAKİKA'da altta kayan kırmızı bant (`TICK_W` ile kesintisiz döngü).
- Intro (`Intro.tsx`, kancadan sonra): sabit cümle `assemble_script.intro_text()` → "<Format adı küçük harfle>,
  son <scheduleHours> saatin Türkiye gündemi." (anlıkta "Son dakika."), kelime bütçesine sayılmaz. Ekranda format
  bandı, "SON 5 SAATİN", TÜRKİYE GÜNDEMİ, ortada gün + yıl, "N. 5 SAAT" + saat aralığı; altta YouTube/Instagram/
  TikTok takip et animasyonu (simgeler `Outro.tsx`'ten). Altyazı gösterilmez (ekrandaki yazı zaten aynı).
- Kapak eksik kalmaz: `render_thumbs.py` işleri `render_thumbs.mjs`e verir (proje bir kez paketlenir, her kapak
  3 kez denenir); yine eksik kalan olursa videonun İLK KARESİNDEN üretilir, çünkü `GundemVideo` 0. karede
  `Thumb` çizer (TikTok `video_cover_timestamp_ms: 0`, Instagram varsayılanı da ilk kare). Silinmiş fotoğraf
  yolu kapağa verilmez. `--missing` kapağı eksik eski videoları tamamlar; panel açılışından 90 sn sonra çalışır.
  Panel listesi ve WhatsApp küçük resmi `-kapak.jpg`den üretilir (`makeThumb`).
- Kapak (`Thumb.tsx`): haber fotoğrafı tam ekran (dikeyde `imageTall`, canlı renk), yoksa kategori ışıltısı +
  büyük illüstrasyon; ışık huzmeleri, vinyet, kategori renginde kalın çerçeve; eğik SON DAKİKA/kategori bandı,
  gün, "N. 5 SAAT" + sarı saat aralığı; dev başlık siyah kontürlü, anahtar kelime (rakamlı ya da en uzun) sarı
  kutuda. Her şey ortalı.
- Yazı sığdırma (`src/fit.ts`): kanca başlığı, haber kartı başlığı ve kapak başlığı sabit puntoyla DEĞİL,
  `fitFontSize()` ile çizilir: metin tarayıcıda ölçülür, hiçbir kelime taşmayacak ve en çok 3 satır (geniş
  kapakta 2) olacak en büyük punto seçilir. `assemble_script.short_title()` başlığı kelime ortasından kesmez
  (en çok 4 kelime / 32 karakter), `tr_upper()` Türkçe büyük harf yapar (i → İ). Prompt kanca başlığını
  ≤ 24 karakter ve anlamı tam ister.
- Haber seçimi: `fetch_news` kaynak başına 25 (≈100), `slim_news` önem puanlar (3 sert haber: can
  kaybı/saldırı/savaş/afet/büyük kaza; 2 önemli karar; 1 diğer), aynı olayı veren kaynakları kümeler
  (`c` = kaynak sayısı, "en çok konuşulan" ölçüsü), `data/used_news.json` içindeki son 48 saatte videoya
  girmiş haberleri eler (yeterli yeni haber yoksa `e:1` ile geri ekler), p → c → yenilik sırasıyla en iyi
  `NEWS_MAX`=50 haberi Claude'a verir. `assemble_script.record_used_news()` kullanılanları yazar.
  Prompt p=3 haberleri zorunlu kılar ve kancayı oradan seçtirir. Anahtar kelimeler `slim_news.PRIORITY`; yanlış pozitifleri (ör. "deprem bölgesi
  konut") önlemek için fiil/bağlam içeren kalıplar kullan.
- Yanan altyazı: `tts.py` `word_timings()` segment süresini karakter ağırlığıyla kelimelere dağıtır
  (noktalama duraklama payı); `Captions.tsx` 4 kelimelik pencere, konuşulan kelime vurgulu, `lang="tr"`.
- Formatlar `settings.formats` {sabah 05-11 45 sn "Güne Başlarken", ogle 11-17 30 sn "Son Dakika",
  aksam 17-05 90 sn "Günün Özeti"}; `FORMAT`/`DURATION` env verilmezse saat seçer. Prompt'a
  `__FORMAT_ADI__`, `__FORMAT_INTRO__`, `__FORMAT_TON__` gider; intro'da format etiketi görünür.
- Müzik: `scripts/make_music.py` üç yatağı sentezler (`public/music/*.mp3`), `settings.musicVolume`
  (0.07) ile döngülü çalar. Telifli dosya kullanma; yatakları betikten yeniden üret.
- Haber medyası (tam boy fotoğraf, HD, video): `assemble_script.attach_images()` her haberi başlık benzerliğiyle
  (Jaccard ≥ 0.08) `work/news.json` kaydına eşler, `articleUrl` (haber sayfası) ve varsa `imageUrl` (RSS
  küçük görseli) yazar. `fetch_images.py`: sayfadaki og:image/twitter:image (yayıncının tam boy fotoğrafı)
  + RSS görseli; her adres için `hd_variants()` (BBC ichef 1024, AA thumbs_b_c, WordPress -WxH eki, ?w=1920)
  önce denenir, en büyük gerçek fotoğraf seçilir (1600 px bulununca durur). Çıktı `seg-XX.jpg` 1840x1120
  (oran yakınsa kırpılır, değilse fotoğrafın tamamı keskin + aynı fotoğrafın bulanık zemini) ve
  `seg-XX-tall.jpg` 1080x1920 (kanca ve dikey kapak, hep bulanık zemin; dikey kırpıp büyütme YOK, bulanıklık
  yapıyordu). Video: önce yt-dlp (haber sayfasındaki gömülü oynatıcı, ≤1080p, yalnızca ilk N sn), olmazsa
  og:video/<video>/JSON-LD adresi ffmpeg ile; sessiz, kart 1280x780, kanca 1080x1920 → `vid-XX.mp4`,
  `videoDuration`. Sayfaya gömülü YouTube/Dailymotion/Vimeo oynatıcıları da yt-dlp ile alınır (kullanıcı
  kararı: kısa klip, sorun görmüyor; `settings.media.allowYoutubeEmbeds`, varsayılan açık, panelde anahtar).
  YouTube için yt-dlp `--js-runtimes node:<yol>` (Node, Remotion için zaten kurulu) ve yt-dlp-ejs bileşeni
  (`yt-dlp[default]`, yoksa `--remote-components ejs:github`) kullanır. `settings.media` {video,
  maxVideoSeconds 20, allowYoutubeEmbeds}; panel Gelişmiş'te iki anahtar. `yt-dlp[default]` pipeline'da
  haftada bir güncellenir. Remotion `MediaBg.tsx`: video varsa `Loop` + `OffthreadVideo` (sessiz), yoksa Ken Burns
  fotoğraf; kartta "VİDEO:"/"FOTOĞRAF: kaynak" yazısı.
- Bölüm meta: `dayLabel` ("9 Ekim Cuma"), `slotLabel` ("2. 5 SAAT"), `timeRange` ("09:00–14:00"),
  `scheduleHours` (settings.scheduleHours, panel zamanlayıcıyı yazınca güncellenir). Kapak (`Thumb.tsx`,
  illüstrasyon `Sequence from={-40}` ile oturmuş haliyle) ve açıklama (`build_caption`: her haberin başlığı + metni + kaynağı) bunları gösterir.
- Anlık haber (tek konulu son dakika): panel "⚡ ANLIK HABER" kartı → `POST /api/anlik {topic, duration 20-60}`,
  WhatsApp/ses "son dakika: <konu>" ya da "anlık haber: <konu>" (iki nokta zorunlu), beyin eylemi `breaking_news`.
  Konu `work/anlik_topic.txt`, `ANLIK=1 bash pipeline.sh`: `scripts/topic_news.py` RSS'ten konuya uyan haberleri
  süzer (4 harflik kök eşleşmesi), `prompts/anlik.md` tek konu ve 2-4 segment yazdırır, RSS çekilemezse yalnızca
  editörün bilgisiyle devam eder. `assemble`: ilk haber `breaking`, outro `OUTRO_ANLIK`, `slotLabel` "ANLIK HABER",
  `timeRange` üretim saati, `format` "anlik"; `regular_slot_of_day()` anlık videoları "N. 5 SAAT" sayımına katmaz.
  `build_caption` "🔴 SON DAKİKA:" başlığı kullanır. Başka üretim sürerken istekler sıraya girer (FIFO, 10 sn kontrol).
  Yayın: `settings.anlikAutoPublish` (varsayılan açık, kartta anahtar) → `post_pipeline.py` anlık videoyu
  `autopublish` anahtarlarından bağımsız olarak bağlı TÜM hesaplara onaysız yükler; WhatsApp bildirimi de
  bu platformlar için onay istemez (`videoInfo().anlik`). Yayın yapılmazsa neden loga "📤 otomatik yayın
  yapılmadı: …" olarak yazılır (hesap yok / anahtar kapalı).
- Mynet manşet takibi (`scripts/mynet_watch.py`, `settings.mynet` {enabled, url, count 6, intervalMin 30,
  maxPerDay 3, duration 30}): panel her `intervalMin` dakikada `--check` çalıştırır; manşet bloğu sınıf adına
  bağlı değil (manset/slider/swiper/carousel/headline atası, yoksa görselli ilk haber linkleri; haber linki =
  aynı site + sonu ≥8 haneli sayı). İlk çalıştırma mevcutları "görüldü" sayar (video üretmez). Yeni giren haber →
  `--article` (JSON-LD articleBody → paragraflar → og:description) → `startAnlik(metin, {source: "Mynet", url})`
  → `ANLIK_SOURCE/ANLIK_URL`: prompt kaynağa dayandırır ve KENDİ cümleleriyle yazar, kanca + ilk kart kaynağı
  Mynet, fotoğraf/video o haber sayfasından, açıklamada "Haber kaynağı: Mynet · link". Günlük otomatik sınır
  `maxPerDay` (YouTube kotası günde ~6 yükleme); elle "Video üret" sınırsız ama aynı haber günde bir kez.
  Durum `data/mynet_state.json` (görülenler 7 gün), üretilenler `data/mynet_produced.json`. Panel kartı:
  6 manşet, her biri için "🎬 Video üret", "hepsi için üret", "şimdi kontrol et", aç/kapat.
- Çoklu son dakika takibi (`scripts/breaking_watch.py`, `settings.breaking` {enabled, intervalMin 15, perSource 8,
  minSources 3, maxPerDay 4, duration 30, sources [{name, url}]}): Hürriyet, Sözcü, NTV, AA, Habertürk son dakika
  RSS'leri (adresler ayardan değişir; ulaşılamayan kaynak panelde ❌ ve logda görünür). Yeni haber (ilk taramada
  mevcutlar "görüldü", 3 saatten eski yayın sayılmaz) → aynı olayı veren siteler `same_event()` (5 harflik kökler,
  ≥4 ortak ya da ≥2 ortak + Jaccard ≥ 0.34) ile birleşir, Mynet manşeti de sayıma girer. Aday: değerli (news_value)
  ya da ≥ minSources sitede. `data/breaking_produced.json` (assemble_script her anlık üretimde, panel üretime
  alırken `--mark` yazar) son 12 saatte aynı olayın ikinci videosunu engeller; Mynet `dup` ile aynı kuralı kullanır.
  `ANLIK_SOURCE_COUNT` assemble'a gider: 3+ kaynak YouTube için değerli sayılır, açıklamaya "N kaynakta" eklenir.
  Panel kartı "🗞 SON DAKİKA KAYNAKLARI" (kaynak durumu, son haberler, şimdi kontrol et, aç/kapat), `GET /api/breaking`,
  `POST /api/breaking/check`; günlük sayaç `data/breaking_daily.json`.
- Günün özeti (yatay uzun video, YouTube): `GUNLUK=1 bash pipeline.sh` → `scripts/daily_news.py` bugünkü videoların
  haberleri (out/<bugün>-N.json) + günün RSS'i, aynı olay birleşir (`same_event`), sıra: değerli/son dakika →
  bugün videoda işlenmiş → kaynak sayısı → RSS önemi; haber sayfası adresleri work/news.json'a eklenir (fotoğraf/video).
  `prompts/gunluk.md` (haber başına 35-55 kelime, `settings.daily.stories` 10 haber, `duration` 240 sn),
  `assemble_script` GUNLUK: intro "Günün özeti…", `OUTRO_GUNLUK`, slotLabel "GÜNÜN ÖZETİ", timeRange 00:00–saat,
  format "gunluk" (5 saatlik sayıma ve sağlık "kaçan üretim" kontrolüne girmez). Remotion `GunlukOzet` (1920x1080,
  `src/GunlukOzet.tsx`): sinematik kanca, intro'da başlık listesi, haberde solda büyük medya + sağda başlık, yanan
  altyazı (7 kelime), üst bant, altta "SIRADAKİ" kayan bant; 0. kare ThumbWide ×1,5. Yayın: yalnız YouTube
  (`post_pipeline`; Reels/TikTok atlanır), `watch?v=` adresi, açıklamada YouTube bölümleri (00:00 Giriş + her haber),
  #Shorts yok, oynatma listesi "Günün Özeti (uzun)". Panel `settings.daily` {enabled, hour 21, minute 30, duration,
  stories, autoPublish} saatinde başlatır (meşgulse gün bitene kadar her dakika dener, `data/daily_last.json`),
  kart "📺 GÜNÜN ÖZETİ", `POST /api/daily/run`, komut "günün özetini üret".
- Kategori öğrenme: prompt uygun kategori yoksa `categorySuggestion` yazdırır; `assemble` sayar
  (`data/category_suggestions.json`), 3 tekrarda geliştirme kuyruğuna görev yazar; `analyze` insights'a koyar.
- A/B başlık ve kapak: prompt `titles {A: haberci, B: merak, cover}` üretir; `assemble` bölüm
  numarasına göre dönüşümlü varyant seçer (`titleVariant`, `publishTitle`); `render_thumbs.py`
  `Thumb` still'ini A ve B olarak render eder (`out/<ad>-kapakA/B.jpg`, seçilen `-kapak.jpg`) ve
  `ThumbWide` (1280x720) ile `-kapakYT.jpg` üretir; kapakta her şey ortalı, gün/"N. 5 saat"/saat
  aralığı rozetleri var; `publish.py` YouTube'a `-kapakYT.jpg` (yoksa `-kapak.jpg`) yükler ve varyantı metriklere yazar; `analyze.py` varyant ve format
  ortalamalarını çıkarır, ipucuna ekler.
- Sohbet hafızası: `brain.addExchange()` her komut/yanıtı `data/memory.json` `exchanges` içine yazar;
  bağlama son 36 saatin konuşmaları `recentConversation` olarak girer.

## EMIXHAS paneli (`npm run panel` → http://localhost:3131)
`app/server.js` (Express) + `app/ui/index.html` + `app/brain.js` + `app/commands.js`.
- Sesli/yazılı komut: önce `commands.js` kuralları (hızlı, token yok: üret, oynat, durum, paylaş,
  zamanlayıcı, izlenme güncelle, yayınla). Kural yoksa veya cümle bileşikse → beyin.
- Beyin (`brain.js`): bağlam (videolar+metrikler, insights, bağlantılar, zamanlayıcı, ayarlar, son
  log, hafıza) + `prompts/emixhas.md` → `claude -p` → JSON {reply, report, actions}. Modlar: chat,
  report (günlük rapor), plan (7 günlük plan). Raporlar `data/reports/`, hafıza `data/memory.json`.
  `claude` yolu `scripts/find_claude.sh` ile bulunur (CLAUDE_BIN env/secrets/.env → PATH → bilinen kurulum
  yerleri, nvm dahil → kullanıcının giriş kabuğu); launchd servisi kabuk ayarlarını yüklemediği için gerekli.
  `pipeline.sh` de aynı betiği kullanır. `claudeError()` hataları Türkçe açıklamaya çevirir (bulunamadı,
  oturum kapalı, sınır, zaman aşımı, internet). Sistem kontrolü küçük bir istekle oturumu doğrular.
  Yalın çağrı (`CLAUDE_LEAN` + `claudeCwd()`): `--tools "" --strict-mcp-config --disable-slash-commands
  --no-session-persistence`, çalışma klasörü proje DIŞINDA (`$TMPDIR/emixhas-claude`) ki proje CLAUDE.md'si her
  çağrıda okunmasın; beyin, senaryo (pipeline.sh) ve sistem kontrolü böyle çalışır. Ölçüm: girdi 52.500 → 2.600
  token, beyin yanıtı ~11 sn. `--bare` KULLANMA (OAuth girişini okumaz).
  Model `settings.claudeModel` (varsayılan "opus" takma adı; "sonnet", "haiku" ya da boş = Claude Code
  varsayılanı) beyin, senaryo ve sistem kontrolünde `--model` olarak geçer; panel Ayarlar → Gelişmiş.
- Eylemler: generate/schedule/note/sync_metrics/open_video/settings/improvement/restart doğrudan
  çalışır. publish/autopublish: `settings.fullAuthority` true ise doğrudan (varsayılan), false ise
  `pending` döner ve UI onay ister (`POST /api/actions`).
- Kendini geliştirme: Emixhas kodu kendisi DEĞİŞTİRMEZ. `improvement` eylemi görevi
  `data/improvements.md` kuyruğuna yazar; kullanıcı Claude Code ile uygular. Bu bilinçli bir sınır:
  panelden tetiklenen izinsiz kod düzenleme ajanı kurulmaz. Ayarla çözülebilen şey `settings` ile.
- Dinleme yalnızca tek tıktır: küreye tıklayınca 10 sn bir komut dinlenir, sonra mikrofon akışı tamamen
  kapatılır. "Sürekli dinle" kullanıcı isteğiyle KALDIRILDI (boşuna yük); geri ekleme. `settings.wakeWords`
  yalnızca söylenen cümleden "Emixhas" kelimesini ayıklamak için kalır. "dur/sus/yeter" konuşmayı keser.
- Ses: `settings.voice` {engine auto|ema|trendyol|chatterbox|say|piper, name Yelda, rate kelime/dk, piperLength, piperNoise}.
  auto: EMA Lightning kuruluysa o, yoksa Chatterbox/Yelda/Piper. "sesini hızlandır/yavaşlat" kuralı
  rate'i ±25 değiştirir; beyin de `settings` eylemiyle değiştirebilir. Video anlatımı
  `settings.narrationEngine` (auto|trendyol|ema|chatterbox|say|piper).
- `scripts/panel.sh` paneli döngüde çalıştırır; çıkış kodu 75 = yeniden başlat (`restart` eylemi).
  `scripts/install_panel_service.sh` paneli launchd servisi yapar (KeepAlive, log work/panel.log).
  `POST /api/update`: `git pull --ff-only` (+ npm install gerekirse) ve yeniden başlat; UI "⬇ Güncelle".
  `scripts/setup_tunnel.sh HOST` kalıcı Cloudflare adlı tüneli kurar (login, create, route dns, .env).
  Tünel hazır olunca log Instagram/TikTok geri dönüş adreslerini tam haliyle yazar.
- Canlı log (`push()` → SSE): üretim adımları, beyin (🧠 düşünüyor / ⚡ eylem / ⏸ onay), yayın (📤),
  metrik (📊), tünel (☁), doğal ses (🎤), kod değişiklikleri (✎ fs.watch: src/app/scripts/prompts),
  git commit (⎇), geliştirme kuyruğu (🛠). UI sağ sütunda sayfayla birlikte kayar; satır öneki rengi belirler.
  Yeni bir işlem eklerken `push()` ile logla, sessiz çalışan şey olmasın.
- Ses kataloğu `scripts/voices.py` (tek doğru kaynak): trendyol (MLX CLI `.venv-tr/bin/trendyol-tts`, artifact
  `models/Trendyol-TTS-mlx`), vox-kadin / vox-erkek (VoxCPM2 tabanı `models/VoxCPM2`, ses tasarımı
  "instruct" ön eki, PyTorch/MPS `scripts/voxcpm_tts.py`), klon-<ad> (`voices/klon/*.wav` referansı,
  VoxCPM2), ema (`scripts/ema_tts.py`), chatterbox, yelda, piper, auto (= trendyol → ema → chatterbox →
  yelda → piper). `available()` kurulu mu söyler; `synthesize(jobs)` aynı motordakileri toplu üretir.
  Seçim `settings.narration` {mode single|alternate, voice, voiceA, voiceB}; `assign()` dönüşümlü modda
  segment sırasıyla A/B (kanca A, intro B, 1. haber A…). `tts.py` bir ses çökerse onu `_disabled`e
  alıp o segmentleri auto ile yeniden üretir (loga "! ses … başarısız"). Panel Ayarlar → SESLER:
  `GET /api/voices` (liste+hazırlık), `POST /api/voices/preview {voice}` → `data/previews/<id>.wav`
  (`/previews/` statik). Kurulum `scripts/install_turkish_voice.sh` (Python 3.11 `.venv-tr`,
  vendor/trendyol-tts-mlx, Trendyol MLX ~4.8 GB + VoxCPM2 tabanı ~4.6 GB + EMA 34 MB).
  Seslendirme öncesi `prep_text`: rakamlar yazıya (`scripts/tr_numbers.py`), BÜYÜK HARFLİ kelimeler
  normal yazıma. `speakable` (macOS `say` dahil): parti adları kelime olarak okunur (AK Parti → Ak Parti,
  DEM/İYİ/TİP Parti, HÜDA PAR; harf harf değil), kesmeden sonraki büyük ekler küçülür (PARTİ'YE → Parti'ye,
  PKK'NIN → PKK'nın). PKK/THY gibi gerçek kısaltmalar harf harf kalır. Ekranda yazım değişmez. Emixhas'ın konuşması (`speak.py`) `voice.engine` kimliğini ya da auto'da hızlı sırayı
  (ema → chatterbox → yelda → piper) kullanır; `voice.rate` EMA hızına (0.7-1.4) çevrilir.
- Isınma önlemi (kullanıcı isteği, geri alma): `reap()` üretim sürmüyorken bizim başlattığımız ağır süreçleri
  (`HEAVY`: ses modelleri, yt-dlp, kapak çizimi, Remotion ve onun Chrome'u — yalnızca node_modules/.remotion
  kopyası, kullanıcının Chrome'una dokunulmaz) kapatır: her 5 dk'da 10 dk'dan uzun yaşayanlar, üretim bitince
  hepsi. `POST /api/stopall` + panel "⏹ Hepsini durdur" + komut "her şeyi durdur / modelleri kapat" üretimi
  (panel ya da zamanlayıcı kilidi) süreç ağacıyla birlikte, anlık kuyruğu ve tüm ağır süreçleri kapatır.
  `GET /api/procs` çalışanları listeler. Sesli: `tts.py` sentez bitince "🔊 ses modeli sorunsuz başlatıldı" yazar →
  "Ses modeli sorunsuz başlatıldı."; her üretimin sonunda (panel çocuğu kapanınca ya da zamanlayıcı üretiminde
  post_pipeline'ın son JSON satırında) `reap({announceIdle})` 🧹 satırı yazar ve "Modeller sorunsuz durduruldu.
  Bilgisayarınız ısınmasın diye kapatıldı." söylenir; "Hepsini durdur" da aynı cümleyi söyler. Panel küresi boştayken saniyede 1 kare çizer; ses ön ısıtması `nice`.
- Modeller sürekli açık TUTULMAZ (kullanıcı isteği): her ses modeli yalnızca üretimde ya da ön dinlemede
  yüklenir, iş bitince süreç kapanır. Doğal ses: `scripts/tts_server.py` Chatterbox Multilingual (MIT,
  Türkçe, klonlama) modelini :3139'da sunar ama panel onu başlatmaz; `natural_tts.on_demand()` sunucuyu
  yalnızca o iş için açar, hazır olmasını bekler (en çok 15 dk), iş bitince kapatır. Panel açılışında
  önceki oturumdan kalan sunucu (üretim kullanmıyorsa) kapatılır. `speak.py` (Emixhas'ın kısa yanıtları)
  Chatterbox'ı yalnızca zaten açıksa kullanır, ağır model açmaz. Kurulum `scripts/install_voice.sh`
  (torch+chatterbox-tts, ~3 GB). Ayarlar `settings.chatterbox` {refVoice, exaggeration, cfg}. Çıktıya duyulmayan PerTh filigranı eklenir (model özelliği).
  Klon sesi için yalnızca kullanıcının kendi sesi veya izinli bir kayıt kullanılır.
- Tam otomatik mod `setAutoMode()` (`POST /api/automode`, eylem `automode`, WhatsApp "otomatik aç/kapat"):
  zamanlayıcı (scheduleHours) + bağlı platformlara autopublish + onay kapalı + notifyStages. Zamanlayıcı
  `data/schedule.json` {loadedAt, hours} yazar; `getSchedule()` sıradaki üretim zamanını ve günün kaçıncı
  videosu olacağını hesaplar, UI "Üretim" kartında saniyelik geri sayım gösterir.
- Sesli aşama bildirimi: `push()` → `stageVoice()` log satırını `STAGE_VOICE` tablosuyla kısa Türkçe cümleye çevirir
  (üretim başladı, haberler toplanıyor, senaryo yazılıyor/hazırlandı, seslendirmeye başlandı/tamamlandı,
  fotoğraf ve videolar, video oluşturuluyor, video hazır, kapaklar, Hostinger'a eklendi, YouTube/Instagram/TikTok
  paylaşıldı ya da yüklenemedi, WhatsApp'tan gönderildi, hata). Panel açıksa SSE `stage` olayı; sayfa kuyrukla
  sırayla okur, Emixhas konuşurken/dinlerken bekler. Panel kapalıysa Mac'te `afplay` (sessiz saatler
  `stageVoice.quietFrom/quietTo`, varsayılan 23-08). Cümleler sabit; `QUICK_PHRASES` ile açılışta önbelleğe girer.
  Ayarlar → WhatsApp grubunda iki anahtar (`stageVoice.enabled`, `stageVoice.macSpeaker`).
- Aşama bildirimleri: `push()` içindeki `notifyStage()` STAGE kalıbına uyan log satırlarını 2,5 sn'de
  toplayıp WhatsApp'a gönderir (`settings.whatsapp.notifyStages`). Hostinger yükleme/silme satırları
  `publish.py` stderr'inden gelir (🌐). Panelde ayar kaydeden her istek sağ altta "Kaydedildi ✓" gösterir.
- Ayarlar sekmesi `<details class="grp">` gruplarıdır: Otomasyon, Yayın hesapları, WhatsApp, Sesler,
  Emixhas ve kanal, Gelişmiş. Eleman kimlikleri değişmedi; yeni bir ayar eklerken uygun gruba koy.
- Sağlık uyarıları (`healthCheck` her 10 dk, `healthAlert(key, text, {everyH})` → log "⚠️ sağlık:", WhatsApp, sesli
  "Dikkat, bir sistem uyarısı var"; tekrar engeli `data/health_alerts.json`): üretim hata ile bitti (panel ya da
  zamanlayıcı; `pipeline.sh` trap'i hata kodunda "✖ üretim hata ile bitti" yazar, son HATA/! satırları mesaja
  girer), zamanlanmış üretim gecikti (son düzenli video aralık + 40 dk'dan eski), disk < `health.minFreeGb` (5),
  Instagram token ≤ 7 gün, bir yayın bağlantısı koptu (`data/health_conn.json`). `settings.health` {enabled,
  whatsapp, minFreeGb}. `GET /api/health`.
- Haftalık rapor `scripts/weekly_report.py` (son 7 gün: video sayısı, toplam ve önceki haftaya göre fark, platform
  toplamları ve önde olan, en çok izlenen 5 video + önde olduğu platform + link, en iyi kategori/saat, anlık vs
  düzenli, kurallı öneriler) → `data/reports/hafta-<tarih>.md`. Panel `settings.weeklyReport` {enabled, weekday 1
  (pazartesi), hour 10}'da önce izlenmeleri çeker, metni WhatsApp'a gönderir, özeti seslendirir
  (`data/weekly_report_last.json` tekrarı engeller). Komut: "haftalık rapor", "bu hafta nasıl gitti";
  `POST /api/weekly-report`.
- Arka plan: her dakika kontrol → bağlı hesap varsa `metricsSyncMinutes` aralığıyla senkron;
  `dailyReportHour`'da günlük rapor üretilip SSE `jarvis` olayıyla panele seslendirilir.
- Küre: canvas, mikrofon ve Emixhas sesi için Web Audio analyser; renk = durum (hazır cyan,
  dinliyor yeşil, düşünüyor amber, konuşuyor pembe, üretiyor kırmızı). Boştayken saniyede ~12 kare,
  sekme gizliyken çizilmez (CPU tasarrufu).
- Hızlı yanıt: `/api/speak` sesi `work/speak-cache/` altına önbellekler (anahtar: metin + `settings.voice`, en
  çok 400 dosya), aynı anda gelen aynı cümle tek kez üretilir; panel açılışında sık cümleler (`QUICK_PHRASES`)
  arka planda hazırlanır. UI `speak()` yanıtı cümlelere böler, ilk cümle hazır olunca çalar, o çalarken
  sıradakini ister. Beyin 1,2 sn'den uzun düşünürse önbellekteki "Bir saniye, bakıyorum." hemen çalar.
  `voices.python_with()` içe aktarma kontrolünü `work/.python_with.json`a yazar (kurulu: 24 saat, değil:
  10 dk; kurulum betikleri siler) ki her yanıtta torch yüklemesi tekrarlanmasın. Sohbet `claudeEffort.chat`
  (varsayılan low) ile düşünür; rapor ve plan `brain` (high). Prompt sesli yanıtı ≤ 2 kısa cümle ister.
- Yanıtlar `scripts/speak.py` ile seslendirilir (EMA ya da Yelda; yoksa tarayıcı sesi).
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
  Instagram Reels. Instagram: "Instagram API with Instagram Login" (Facebook sayfası gerekmez):
  `--connect instagram` tarayıcıda girişi açar, geri dönüş HTTPS zorunlu olduğu için tünel üzerinden
  `/instagram/callback` → yerel :3138'e gelir (panel `POST /api/connect/instagram` tüneli açıp bekler);
  kısa kod → 60 günlük token `secrets/instagram_token.json`, `ig_creds()` 15 günün altında kalınca
  yeniler. `IG_LOGIN=facebook` ise Facebook Login (`fb_finish`): kullanıcı token'ı → `/me/accounts` → Instagram'a
  bağlı Sayfanın süresiz Sayfa token'ı + IG hesap kimliği, `via: facebook`, graph.facebook.com, yenileme yok.
  Eski `.env` IG_USER_ID/IG_ACCESS_TOKEN yolu da çalışır. Video
  `PUBLIC_BASE_URL/videos/<ad>` adresinden çekilir; adres yoksa/erişilemiyorsa `_PublicVideo` yayın
  süresince `out/` için geçici HTTP sunucu + `cloudflared` hızlı tüneli açar ve kapatır (launchd ile
  panel kapalıyken de otomatik yayın). Meta uygulaması Geliştirme modundayken hesap Instagram Testers
  listesinde olmalı. Sonuç `data/metrics.json` → `videos.<ad>.<platform>`.
- TikTok (`tt_*` fonksiyonları): Login Kit OAuth, Content Posting API FILE_UPLOAD. Geri dönüş `tt_redirect()`:
  TikTok web girişi HTTPS ister (localhost kabul etmez) → Hostinger köprüsü varsa `https://site/tiktok/callback/`
  (kod `hostinger.poll_code` ile yoklanır; eski `.env`deki localhost değeri o zaman yok sayılır), yoksa
  `TIKTOK_REDIRECT_URI`/yerel :3137. İzinler `tt_scopes()` (user.info.basic, user.info.stats, video.list,
  video.upload; video.publish yalnız `TIKTOK_MODE=direct`; `TIKTOK_SCOPES` ile elle). Hata mesajı eksik izin/adres
  için ne yazılacağını söyler. Panel TikTok kartı: adım adım kurulum, Login Kit'e yazılacak adres (kopyala), Client
  key/secret ve mod alanları (`POST /api/tiktok/keys` → secrets/.env), bağlıyken "Yeniden bağla" ve "Bağlantıyı kes"
  (`--disconnect tiktok`, `/v2/oauth/revoke/`). TikTok uygulama formu Web sitesi / Terms of Service / Privacy Policy
  adresi ister: `hostinger.py --legal` (ve `--setup`) `public_html/uygulama/` altına üç sade TR+EN sayfa yükler
  (index, kosullar.html, gizlilik.html; iletişim `CONTACT_EMAIL`), panel kartında adresler + "Sayfaları oluştur"
  (`POST /api/hostinger/legal`). İnceleme (App review) gerekmez: Sandbox + Target users ile çalışılır. `TIKTOK_MODE=inbox` → gelen kutusu taslağı (onaysız uygulamada çalışır);
  `direct` → doğrudan yayın (privacy creator_info'dan; onaysız uygulamada SELF_ONLY). Inbox videosu profile değil
  TikTok uygulamasının Gelen kutusu bildirimlerine düşer. `tt_upload` durumu 5 dk yoklar ve loga "  ♪ TikTok durumu"
  yazar; işlem bitmediyse "hâlâ işliyor" der. `--tt-check` (`tt_check`) son 5 gönderimin durumunu TikTok'tan sorar
  (`TT_STATUS_TR`), panel "📨 Son gönderimleri kontrol et" (`POST /api/tiktok/check`). Token 24 saat,
  refresh otomatik. Metrikler `/v2/video/list/` (view/like/comment/share).
- `scripts/sync_metrics.py`: izlenme/beğeni/yorum (YT), plays/reach/shares/saves (IG), TikTok sayaçları.
  Sonunda `scripts/followers.py` abone/takipçi sayılarını çeker: YouTube `channels.list(mine)` subscriberCount
  (1000 üstünde yuvarlanır), Instagram `followers_count`, TikTok `user/info` follower_count (`user.info.stats` izni:
  TT_SCOPES'a eklendi, eski bağlantıda yeniden bağlamak ve uygulamada izin açık olmak gerekir). Saatte en çok bir
  kayıt `data/followers.json` (400 gün); `summary()` güncel, bugün (yerel gece yarısından beri), 7 gün, 30 gün
  kazanımı (`partial`: kayıt dönemden yeniyse ilk kayda göre) ve son 14 günün günlük kazanım serisi (kayıt olmayan
  gün `null`; gün başında kayıt yoksa — takibin başladığı gün — o günün ilk kaydına göre, `partial`). Grafikte
  kayıt yok = kesikli çizgi, 0 = ince çizgi, kısmi gün = soluk sütun; altında veri birikimini anlatan not. `analyze.py`
  insights'a `followers` koyar (beyin bağlamı da görür); panel Analitik'in başında "ABONE VE TAKİPÇİ" kartları
  (toplam + platform) ve günlük kazanım sütun grafiği (fareyle platform kırılımı); haftalık rapor 👥 satırları;
  komut "kaç abonemiz var / bugün kaç takipçi kazandık" (`followers` eylemi, 30 dk'da bir canlı çeker).
- `scripts/analyze.py`: kategori/süre/saat ortalamaları, en iyi 10 (her biri için `bestPlatform`), platform analizi
  `byPlatform` {youtube|instagram|tiktok: total, videos, avg, best, top3} ve `leadingPlatform`, manşet etkisi → `data/insights.json`
  ve `data/prompt_hint.txt`. Pipeline bu ipucunu `__IPUCU__` olarak senaryo prompt'una verir:
  öğrenme döngüsü budur. İpucu kurallarla çelişirse kurallar kazanır (prompt'ta yazılı).
- `scripts/post_pipeline.py`: üretim sonunda otomatik yayın + analiz (launchd ile panel kapalıyken de çalışır).
  Hedef: `autopublish` anahtarları ∪ (otomatik üretim açıksa — launchd plist var — ya da `settings.autoMode`
  açıksa bağlı TÜM hesaplar) ∪ (anlık videoda `anlikAutoPublish` ise bağlı tüm hesaplar). Bağlı hesaplar yayın
  anında `publish.py --status` ile okunur (sonradan bağlanan da dahil). Başarısız platform 90 sn sonra bir kez
  daha denenir. Yayın yoksa nedeni "📤 otomatik yayın yapılmadı: …" ile yazılır. Panelde "Otomatik üretim"
  anahtarı `autoMode`u da açar/kapatır; WhatsApp bildirimi aynı kuralla onay istemez (`autoAll`).
- Başlık/açıklama `scripts/common.py: build_caption` üretir (ilk haber başlığı + kanal adı + #Shorts).
  Hashtag `scripts/hashtags.py`: senaryonun konuya özel `hashtags` (3-5, prompt yazar, `assemble_script.topic_hashtags`
  temizler) + haber değeri grubu (#zam, #emekli, #tatil…) + kategori (#ekonomi, #asayiş…) + `settings.hashtags`, en
  çok 12 (YouTube 15 üstünü yok sayar); açıklamanın sonuna, YouTube `tags` alanına (`caption_tags`) ve TikTok başlığına.
- YouTube oynatma listeleri (`publish.yt_add_to_playlists`): format listesi ("<kanal> · Son Dakika" / "· Her 5 Saatte
  Gündem" / "· Günün Özeti (uzun)") + ilk haberin kategorisi ("· Ekonomi", "· Asayiş ve Kaza"…); yoksa herkese açık
  oluşturulur, kimlikler `data/youtube_playlists.json`. "youtube" kapsamı gerekir: eski token (upload+readonly) dosyadaki
  kapsamlarla okunur ve listesiz yükler, `--status` `playlists:false` verir, sistem kontrolü yeniden bağlamayı önerir.
  `--connect youtube` (`yt_connect`) token geçerli olsa da Google onayını YENİDEN açar (prompt=consent, 10 dk bekler),
  vazgeçilirse eski token kalır; dönen kapsamda liste izni yoksa söyler. `--disconnect youtube` izni geri alır ve token'ı
  siler. Panel: bağlıyken düğme "🔄 Yeniden bağla", yanında "Bağlantıyı kes" (`POST /api/disconnect/youtube`).
- YouTube API kotası: günde 10.000 birim, bir yükleme ~1.600 → günde en fazla 6 yükleme.
- Günlük yükleme sınırı (YouTube `uploadLimitExceeded` = kanal sınırı, `quotaExceeded` = API kotası):
  `publish.py` platformu 3 saat beklemeye alır (`data/publish_hold.json`), videoyu `data/publish_queue.json`
  sırasına ekler ve `{"limit": true}` döner; post_pipeline 90 sn tekrarını yapmaz ("📤 youtube: sınır doldu —"),
  bekleme süresince yeni videolar API'ye gitmeden sıraya girer. `publish.py --flush` sırayı en yeni haberden
  yükler (24 saatten eski bayat haber atılır); post_pipeline her yayından sonra, panel saatte bir (üretim yokken)
  çağırır. `--status` YouTube için `holdUntil`/`queued` verir. Doğrulanmamış kanalın sınırı düşüktür
  (youtube.com/verify ile telefon doğrulaması sınırı yükseltir).
- YouTube kuralı (kullanıcı kararı, sınır yüzünden; `settings.youtubePolicy` {onlyValuable true, extraDailyMax 3,
  extraKeywords}): otomatik 5 saatlik üretimler YouTube'a HER ZAMAN gider; anlık/Mynet videoları yalnız DEĞERLİYSE
  ve günde en çok `extraDailyMax` tane (`data/youtube_extra.json`). Instagram/TikTok etkilenmez; elle yayın
  (panel, WhatsApp "onay") kurala takılmaz. Değer `scripts/news_value.py`: anahtar kelime grupları (can kaybı,
  kaza/afet, emekli/memur maaşı + asgari ücret, zam/fiyat/vergi, tatil/bayram/idari izin, kamu duyurusu:
  sınav/yasak, güvenlik; magazin/spor kelimesi varsa yalnız model 4-5 derse) +
  `prompts/anlik.md`in istediği `importance` 1-5 (4-5 her zaman değerli, 1-2 anahtar kelimeyi geçersiz kılar).
  `assemble_script.news_value()` meta'ya `value` yazar; `post_pipeline.youtube_allowed()` karar verir ("⭐ değerli
  haber" / "📤 youtube: atlandı —"). WhatsApp bildirimi sıradan anlık haberde YouTube'u "onay" listesine koyar.
  Mynet: `mynet_watch.py` her manşet başlığını puanlar (`valuable`, `valueReason`); panel yeni manşetlerde
  değerliyi önce üretir, sıradan manşet günde `mynet.maxPerDay` (3), değerli dahil toplam `valuableMaxPerDay` (6).
  Panelde Anlık kartında anahtar + günlük sayı, Mynet kartında ⭐ rozeti.

## Kanal kimliği (değiştirirken tutarlı kal)
- Renkler `src/theme.ts`: koyu lacivert zemin, kırmızı vurgu (#E30A17), beyaz başlık, gri alt metin.
- Ton: resmi, sakin, tarafsız haber dili. Yorum ve sansasyon yok.
- Yapı: kanca (≤3 sn) → intro (kanal kimliği, ≤2 sn) → N haber kartı (30 sn'de 4) → outro (~7 sn).
- Outro sabittir: `src/scenes/Outro.tsx` + `src/scenes/TurkeyMap.tsx` (bayrak desenli, kodla çizilmiş Türkiye haritası,
  "HER 5 SAATTE BİR / SON DAKİKA" kancası, YouTube·Instagram·TikTok takip animasyonu). Kapanış cümlesi
  `scripts/assemble_script.py` içindeki `OUTRO_TEXT` ile her videoda aynıdır; kelime bütçesine sayılmaz.
- Toplam seslendirme ≤ süre × 2.4 kelime. Bu sınır `assemble_script.py` ile zorlanır.
- Her haber kartında kaynak adı görünür.

## Kategori sistemi (SABİT, her videoda aynı)
Claude senaryoda her habere `category` atar; görsel ve ses bu eşlemeden gelir, haber başına
değişmez. Eşleme `src/categories.ts` içindedir ve tek doğru kaynak odur:

| category  | etiket    | vurgu rengi | illüstrasyon (kodla çizilir)        | ses efekti (kodla sentezlenir) |
|-----------|-----------|-------------|-------------------------------------|--------------------------------|
| finans    | EKONOMİ   | #F2B705     | yükselen grafik + ₺ paralar         | sfx/kasa.wav (ka-ching)        |
| siyaset   | SİYASET   | #E30A17     | kürsü + vuran tokmak                | sfx/tokmak.wav                 |
| asayis    | ASAYİŞ    | #3D7BFF     | dönen polis tepe lambası + şerit    | sfx/siren.wav                  |
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
- `assemble_script.py: ASAYIS` kalıbında "kaza(?!n)": "kazandı/kazanç" asayiş sayılmaz.
- `assemble_script.py: ASAYIS` kalıbı (şehit, saldırı, terör, kaza, yangın, cinayet…) geçen yurt içi haber
  Claude'un seçimine bakılmaksızın `asayis` olur (dunya/hava hariç). Şehit haberi asla siyaset değildir.
- Ses efektleri harici dosya değildir: `python3 scripts/make_sfx.py` hepsini yeniden üretir.
  Bir sesi değiştirmek için o betikteki parametreleri değiştir, dışarıdan dosya ekleme.

## Ses ayarları (ölçülerek belirlendi)
- Piper `length_scale` 0.82 ≈ 150 kelime/dk. 1.0 fazla yavaştı (~120). Değiştirmek için
  `PIPER_LENGTH_SCALE=0.78 bash pipeline.sh` gibi; 0.75'in altı anlaşılırlığı bozar.
- Segment sonu sessizliği 0.15 sn + Piper cümle boşluğu 0.12 sn.
- Seslendirme seviyesi (`tts.add_pause`): her segment POLISH sonrası `loudnorm=I=-18` ile eşit yüksekliğe
  getirilir, sonra kadın sesi `settings.narration.femaleGainDb` (varsayılan +3 dB), erkek sesi `maleGainDb` (0)
  kadar yükseltilir, `alimiter` bozulmayı önler. Cinsiyeti belirsiz motorlar kadın sayılır (tek erkek ses
  vox-erkek). Panel Ayarlar → Sesler'de iki kaydırıcı (0-8 dB). Son MP4 loudnorm'u toplamı -14 LUFS'a çeker;
  bu kazanç seslendirmeyi müziğe ve efektlere göre öne çıkarır.
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
- Panel sekmesi günlerce açık kalır; bellek sızıntısına dikkat (gece "Hay aksi" çökmesi buydu): `playBlob` her
  cümlede blob adresini `revokeObjectURL` ile bırakır, `attachAnalyser` düğümleri `audioNodes`ta tutar ve
  `detachAnalyser()` (çalma bitince, `endSpeaking`, dinleme bitince) koparır; sohbet en çok 200, log 600 satır.
  Güvenlik ağı: 03-06 arası 12 saatten uzun açık ve boştaysa ya da JS belleği 600 MB'ı geçerse sayfa kendini yeniler.
  Yeni ses/DOM kodu eklerken oluşturduğunu bırak.
- Önizleme: `npm run studio`. Sessiz hızlı test: `TTS_ENGINE=silent bash pipeline.sh`.
- `out/`, `work/`, `public/audio/`, `voices/*.onnx` git'e girmez.
