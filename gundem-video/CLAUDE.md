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

Senaryo adımı JSON garantisi: `claude_result.py` çıkış kodu 0 = tamam, 2 = kullanım sınırı/oturum (tekrar
denenmez, "HATA: Claude kullanım sınırı…"), 3 = JSON yok/hata (Claude'un yanıtının ilk 300 karakteri loga yazılır);
pipeline 3'te bir kez daha "YALNIZCA JSON" hatırlatmasıyla dener, yine olmazsa durur. `assemble_script.extract_json`
yanıtı ve bozuk/yarım JSON'u ayrıca söyler. (Bash: `set -e`+`pipefail` altında `{ …; [ x ] && …; }` grubu son komut
yanlışsa boru hattını düşürür; `if … fi` kullan.)
`pipeline.sh` bu adımları sırayla çalıştırır; launchd 5 saatte bir tetikler. `DURATION=60 bash pipeline.sh`
süreyi belirler: kelime bütçesi = süre × 2.4, haber sayısı = süre / 8 (2-12 arası). Prompt'taki
`__SURE__`, `__KELIME__`, `__HABER__` yer tutucuları pipeline tarafından doldurulur.
Token: Claude'a `scripts/slim_news.py` ile küçültülmüş set gider (en yeni `NEWS_MAX`=20 haber, 200
karakter özet, link yok). Ölçüm (60 sn): ~45k girdi (çoğu Claude Code'un kendi yükü, önbellekli),
~2k çıktı. Haber setini büyütmek seçimi iyileştirmez, token artırır. Kullanıcı isteğiyle token/maliyet
bilgisi logda ve panelde GÖSTERİLMEZ; `data/usage.json` sessizce tutulur (effort seçimi panelde kalır).
Az token modu (kullanıcı isteği: üretimde Claude en az kullanılsın; `settings.tokenSaver`, varsayılan açık, Ayarlar →
Gelişmiş anahtarı): `pipeline.sh` senaryo effort'unu "low" yapar (`CLAUDE_EFFORT_FIXED=1` env ile elle seçilen korunur),
düzenli videoda Claude'a giden haber sayısı `HABER × 3` (en az 12; `NEWS_MAX` env verilirse o), `slim_news` özetleri 100
karakter, anlıkta `topic_news` en çok 6 ilgili haber / 180 karakter, performans ipucu 300 karakter. Üretim başına tek
Claude çağrısı (geçersiz JSON'da bir tekrar) değişmedi.
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
  bandı (anlıkta SON DAKİKA; fragman analizinde `episode.trailer` → etiket slotLabel: YENİ FRAGMAN, FRAGMAN…),
  "SON 5 SAATİN", TÜRKİYE GÜNDEMİ, ortada gün + yıl, "N. 5 SAAT" + saat aralığı; altta YouTube/Instagram/
  TikTok takip et animasyonu (simgeler `Outro.tsx`'ten). Altyazı gösterilmez (ekrandaki yazı zaten aynı).
- Kapak eksik kalmaz: `render_thumbs.py` işleri `render_thumbs.mjs`e verir (proje bir kez paketlenir, her kapak
  3 kez denenir); yine eksik kalan olursa videonun İLK KARESİNDEN üretilir, çünkü `GundemVideo` 0. karede
  `Thumb` çizer (TikTok `video_cover_timestamp_ms: 0`, Instagram varsayılanı da ilk kare). Silinmiş fotoğraf
  yolu kapağa verilmez. `--missing` kapağı eksik eski videoları tamamlar; panel açılışından 90 sn sonra çalışır.
  Panel listesi ve WhatsApp küçük resmi `-kapak.jpg`den üretilir (`makeThumb`).
- YouTube kapağı (`Thumb.tsx` → `WideThumb`, 1280x720, kullanıcı: "aşırı dikkat çekici"): sağda büyük canlı fotoğraf
  (soldan karanlığa erir), solda en çok 3 satır DEV başlık (beyaz, kalın siyah kontür, anahtar kelime sarı kutuda,
  `fitFontSize` 640 px), üstte eğik kırmızı etiket (GÜNÜN ÖZETİ / HAFTANIN ÖZETİ / SON DAKİKA / kategori) + sarı tarih,
  başlıktan fotoğrafa kırmızı ok, sağ altta diğer haberlerden 2 küçük kare (`images`) ve sarı "+N HABER" rozeti (`count`),
  sol kenarda kırmızı şerit. `render_thumbs` ve `GunlukOzet` 0. kare aynı prop'ları verir. ÖNEMLİ: YouTube özel kapağı
  ancak telefonla doğrulanmış kanalda kabul eder; reddedilirse YouTube videonun ortasından kare seçer (12-13 Ekim yatay
  videolarda görülen buydu). `publish.yt_set_thumb` hatayı Türkçe nedenle loga ("  ! YouTube kapağı yüklenemedi: kanal
  özel kapak iznine sahip değil: youtube.com/verify…") ve metrics `youtube.thumbError`a yazar; başarılı yüklemeden sonra
  `yt_retry_thumbs` reddedilmiş/denenmemiş en çok 3 eski videoyu düzeltir; `publish.py --yt-thumbs`, `POST /api/youtube/thumbs`,
  komut "kapakları yeniden yükle", YouTube kartında "🖼 Kapakları yeniden yükle".
- Dikey kapak (`TallThumb`): haber fotoğrafı tam ekran (dikeyde `imageTall`, canlı renk), yoksa kategori ışıltısı +
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
  girmiş haberleri ve üretilen haber hafızasıyla eşleşenleri (anlık/sosyal medya/şablon videolarının kaynak başlığı, adresi ve
  metni; aşağıda "Üretilen haber hafızası") eler (yeterli yeni haber yoksa `e:1` ile geri ekler), p → c → yenilik sırasıyla en iyi
  `NEWS_MAX`=50 haberi Claude'a verir. `assemble_script.record_used_news()` kullanılanları yazar.
  Prompt p=3 haberleri zorunlu kılar ve kancayı oradan seçtirir. Manşet (kullanıcı kararı: kancaya ve manşetlik
  habere ağırlık): `slim_news` şu an Mynet manşetinde/son dakika sitelerinde olan (`breaking_watch.recent_items` +
  `same_event`), `news_value` ile değerli ya da p=3 (e=1 değil) kümeye `m:1` koyar, sıralama p → m → trend → c;
  `prompts/senaryo.md` kancayı m=1'den seçtirir (m içinde p, sonra c), kanca haberi 1. kart olarak 20-28 kelime anlatılır
  (diğerleri 12-18; fazlası önemsiz haberlerden kısılır), m=1 ve p≥2 kanca haberine "breaking". Anahtar kelimeler `slim_news.PRIORITY`; yanlış pozitifleri (ör. "deprem bölgesi
  konut") önlemek için fiil/bağlam içeren kalıplar kullan.
- Hassas kelime gizleme (kullanıcı isteği: platform denetimi; `scripts/censor.py`, `settings.censor` {enabled true, audio,
  text, words, extra}; panel Ayarlar → Gelişmiş anahtar + "Ek gizlenecek kelimeler"): kökler `DEFAULT_WORDS` (intihar,
  öl+ek kalıbı — ölçü/ölçek değil, silah, cinayet, katil/katle, bıçak, kurşun, tecavüz, istismar, taciz, uyuşturucu, ceset,
  işkence, vahşet, boğ+ek kalıbı — Boğaz değil, tabanca, pompalı, rehin, bomba, terör), Türkçe ekler dahil, `tr_lower`
  uzunluk korur. SES (kullanıcı: "kesilmesin, kelime arkadan duyulsun"): `tts.py` segmenti `censor.pieces()` ile
  [text, word, text…] parçalarına böler, hassas kelime de seslendirilir; `bleep_word` kelimeyi -20 LUFS'a getirip yarıya
  indirir, üstüne aynı uzunlukta yumuşak kenarlı 1 kHz bip (~6 dB üstte) bindirir; `trim_wav` her parçanın baş/son
  sessizliğini kırpıp 70 ms boşluk bırakır (kesik duyulmaz), `join_wavs` birleştirir (log "🔇 N hassas kelime bipleniyor"). YAZI: `mask()` bir harfi
  yıldızlar (int*har, s*lah, ö*üm, c*nayet): `assemble_script` ekrandaki kanca/haber başlıkları, titles A/B/cover ve
  publishTitle; `tts.py` yanan altyazı (`words`); `common.build_caption` başlık + açıklama; hassas hashtag `clean_tags` ile
  atılır (build_caption, caption_tags, meta hashtags). `narration` alanı özgün kalır (seslendirme ve tekrar engeli için).
- Yanan altyazı ses ile eş zamanlı (kullanıcı: "çok önemli"; `scripts/align.py`): 1) konuşma tanıma — mlx-whisper (ya da
  faster-whisper) kuruluysa (`bash scripts/install_align.sh`, model `settings.captions.whisperModel`, varsayılan
  mlx-community/whisper-small-mlx; `captions.whisper: false` kapatır) tanınan kelimeler senaryo kelimeleriyle difflib ile
  eşlenir, eşlenmeyenler komşuların arasına yayılır; 2) duraklama çapası (her zaman) — ffmpeg silencedetect (-38 dB, 0,12 sn)
  ile sesin gerçek başı/sonu ve duraklamalar bulunur, noktalı/virgüllü kelime sonları ±0,7 sn içindeki en yakın duraklamaya
  oturur, aradakiler SÖYLENEN uzunlukla dağılır (`spoken_len`: rakamlar yazıya çevrilerek sayılır — "1.250" ekranda kısa,
  söylenişi uzun; 14 Ekim "altyazı sesle eşit gitmiyor" şikâyetinin ana nedeni buydu). Eşik uyarlanır (`noise_floor`: ortalama
  sesin 17 dB altı) ve duraklamalar SIKIŞTIRMA ÖNCESİ ham seste aranır (`seg-XX.align.wav`, sonra silinir); gürültülü
  sentetik testte en büyük kayma 0,10 sn. mlx-whisper Apple Silicon'da yoksa ilk üretimde bir kez kendiliğinden kurulur
  (`captions.autoInstall: false` kapatır; `work/.align_install.json`). `Captions.tsx` kelimeyi 0,06 sn önde gösterir; bipli segmentte parçaların
  kesin yerleri çapadır. Yöntem segmentte `captionSync`, log "🔤 altyazı senkronu: …"; hiçbiri olmazsa eski `word_timings`.
  0) Metni sese zorla hizalama (kullanıcı isteği, en isabetlisi; `scripts/mms_align.py`, `align.mms_batch/by_mms`): bilinen metin
  torchaudio MMS_FA (Meta, çok dilli, Türkçe) ile sesin karelerine CTC ile oturtulur; Türkçe harfler a-z'ye çevrilir (ç→c, ı→i…),
  kesme işareti atılır, her ekran kelimesinin söylenen biçimi `prep_text` (skor bağlamı cümle düzeyinde: "4-1" → "dört bir").
  Ayrı ortam `.venv-align` (torch/torchaudio 2.8 sabit — 2.9 forced_align'ı kaldırdı; ses modellerinin torch'una dokunmaz),
  model ~1,2 GB torch önbelleğine iner; tüm bipsiz segmentler TEK süreçte (model bir kez yüklenir, varsa MPS, hizalama CPU).
  Kurulum `bash scripts/install_align.sh` (MMS + mlx-whisper, Yelda sesiyle deneme). Yoksa/hata verirse konuşma tanımaya, o da
  yoksa duraklama çapasına düşer; yöntem segmentte `captionSync` ("metin hizalama"). `captions.forcedAlign: false` kapatır.
  Sandbox'ta model inemediği için gerçek ses üzerinde DENENMEDİ; arayüz torchaudio 2.8 kaynağıyla doğrulandı.
  Sertifika (kullanıcının Mac'i, 14 Ekim: "metin hizalama çalışmadı: CERTIFICATE_VERIFY_FAILED"): python.org Python'u ve onun
  `.venv-align`'ı macOS sertifika deposunu görmez, model indirmesi düşer. `mms_align._use_ca()` certifi → SSL_CERT_FILE →
  /etc/ssl/cert.pem sırasıyla varsayılan HTTPS bağlamını kurar; `align.mms_batch` çocuğa SSL_CERT_FILE verir; `common.py` certifi yoksa
  /etc/ssl/cert.pem'e düşer; `install_align.sh` .venv-align'a certifi kurar ve modeli kurulumda indirir. Hata satırında kurulum ipucu.
  Video sonrası denetim (`scripts/caption_qa.py`, pipeline render + json kopyasından sonra): son mp4'ün sesi (müzikli) mlx-whisper
  ile dinlenir, ≥3 harfli kelimeler difflib ile eşlenir, altyazının ekrana geldiği an (s − captionLead) sesteki başlangıçla
  karşılaştırılır: "🔤 altyazı denetimi: N kelime, 150 ms içinde olan yüzde X, ortanca kayma Y ms geç/erken". Sorun (150 ms içinde
  < %70 ya da |ortanca| > 120 ms) → "⚠️" + öneri (sabit kayma: kaydırma ayarını şu kadar değiştir; dağınık: metin hizalamayı kur)
  + WhatsApp sağlık uyarısı (12 saatte bir); `data/caption_qa.json`. `teshis.sh` iki aracın kurulu olup olmadığını ve son satırları yazar.
  Altyazı 3'er kelime, içi siyah dışı sarı, orta boy (kullanıcı kararı, 20 Ekim; 14 Ekim'deki tek büyük kelime + kategori renginde
  kutu kalktı; `src/captionGroups.ts`, `src/scenes/Captions.tsx`): grup en çok 3 kelime, kelime sonu noktalaması ya da 0,6 sn'den uzun
  duraklama erken kapatır; grup ilk kelimesiyle bütün dizilir (söylenmemiş kelime görünmez, yeri ayrılır, yazı kaymaz), her kelime
  söylendiği anda 0,09 sn'de büyüyerek belirir, grup son kelimeden 0,18 sn sonra ya da sonraki grup başlayınca kalkar, uzun duraklamada
  ekran boş. Harf içi siyah, dışa ~0,11 em #FFD400 kontür (arkada kalın kontürlü kopya, önde siyah dolgu), koyu gölge. Punto `fitText`
  (kontür ve kelime arası dahil), gruptan gruba sıçramasın diye en çok 2 satıra sığan en büyüğü (tek satır ancak %5'ten az küçülerek
  sığıyorsa), en az 48 px (yatayda 56); daha uzun grup yükseklik sınırı içinde 3. satıra geçer. İki satıra düşen üç kelimede kırılım
  dengeli (uzun satır en kısa, eşite yakınsa üst satır kısa: TRAFİK / KAZASINDA ÜÇ). Başlığa binmesin diye yerleşime göre yükseklik
  sınırı; Headline/Hook 78 px, FullFrame 76 px (tek satır 1090'da, iki satır başlığa kadar yukarı büyür), Outro 72 px, yatay özette sola
  dayalı 62 px. Altyazı kaydırma `settings.captions.leadSec` (varsayılan 0,06 sn önde; panel Ayarlar → Gelişmiş "🔤 Altyazı
  kaydırma") → tts.py `episode.captionLead` → `setCaptionLead`. Konuşma tanıma modeli varsayılanı mlx-community/whisper-large-v3-turbo
  (Türkçede small'dan isabetli; açılamazsa bir kez small'a düşer); log "🔤 altyazı senkronu" konuşma tanımanın kelimelerin yüzde
  kaçını sesle doğrudan eşlediğini (`captionCoverage`) ya da çalışmadığını ve kurulum komutunu yazar. Ölçüm (espeak-ng Türkçe
  sentetik ses, gerçek kelime başlangıçlarıyla): duraklama çapası ort. 35-40 ms, en kötü 0,14 sn; hece tepesi ve tüm duraklamalara
  dinamik programlama denendi, daha kötü çıktı (patlamalı ünsüzlerin kapanması duraklama sanılıyor) — eklenmedi.
- Shorts haber kartı (`Headline.tsx`, kullanıcı isteği): görsel 220-780, yanan altyazı görselin HEMEN altında (top 812),
  numara + başlık + kaynak onun altında (top 1110).
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
  haftada bir güncellenir. VİDEO ÖNCE (kullanıcı kararı: "önceliğimiz video, video yoksa mecbur kalırsak foto"):
  her kanca/haber için video sırayla aranır: kendi sayfası (`video_from_page`: yt-dlp → sayfadaki mp4/m3u8 → gömülü
  oynatıcı) → aynı olayı veren diğer sitelerin sayfaları (`same_story_pages`: work/news.json'da 4 harflik köklerin
  ≥%35'i uyan, anlıkta work/anlik_pages.json önce) → Bing Haberler araması (`searched_pages`) → YouTube'da en yeni
  videolar (`youtube_search`: `ytsearchdate10:`, başlık kökleri ≥%50 uyan, 5 sn-30 dk; `media.youtubeSearch`, ayrıca
  `allowYoutubeEmbeds` açık olmalı). Ek aramalar `media.videoSearchSeconds` (420) ile sınırlı; kanca, "breaking" ve ilk
  haber her zaman tam aranır. Bulunan kaynak `found_src` ile aynı haberin diğer segmentinde önce denenir (kök uyumu ≥2
  ya da anlık). Log: "🎞 video … (haber sayfası / aynı haber, site / haber araması / YouTube araması)" ya da "📷 video
  bulunamadı, fotoğraf kullanılacak". Fotoğraf her durumda indirilir (kapak, yedek). Remotion `MediaBg.tsx`: video varsa `Loop` + `OffthreadVideo` (sessiz), yoksa Ken Burns
  fotoğraf; kartta "VİDEO:"/"FOTOĞRAF: kaynak" yazısı.
- Video önce, sonra FARKLI fotoğraflar (kullanıcı isteği, 17 Ekim: "kesinlikle öncelik video; video yoksa farklı farklı görseller, tek görsel ile üretmek mantıksız, mecbur kalırsak tek görsel"; `scripts/fetch_images.py`, `src/scenes/MediaBg.tsx`): `main()` üç geçişte çalışır.
  1) Video araması (eski zincir). Bulunan video, aynı haberin sonraki bölümlerinin süresi kadar uzun indirilir (en çok `maxVideoSeconds`). Arama başka bir bölümde zaten oynamış bir kaynağa çıkarsa (found_src, kendi sayfası, diğer site, haber araması ya da YouTube), oynayan saniyeler de indirilir ve `videoStart` verilir (`secs_for`). Böylece aynı görüntü baştan tekrar etmez.
  2) Paylaşım: kendi videosu olmayan bölüm AYNI HABERİN videosunu oynatır. Aynı haber: tek konulu anlıkta tüm bölümler; çoklu son dakikada aynı `item`; diğerlerinde aynı haber sayfası ve ≥2 ortak kök (`same_story`). Birebir aynı görünmesin diye önceki kullanımın bittiği saniyeden başlar (`videoStart`, `video_slot`), video bitince başa sarar. Kanca dikey, kart yatay ise `reframe_video` görüntüyü bölümün boyutuna getirir: dikeyden karta ortadan kırpılır, karttan dikeye bulanık zeminle sığdırılır. Log: "🎞 video (aynı haberin videosu, 8,0 sn'den) …".
  3) Fotoğraf: önce videolu bölüme kapak/yedek için bir fotoğraf. Sonra videosuz bölüme clamp(ceil(süre / 3,5 sn), 1, 4) fotoğraf düşer: önce hiç kullanılmamışlar, bulundukları sırayla; yetmezse en az kullanılanlar. İlk fotoğraf haberin kendi fotoğrafıdır (og:image/twitter:image/RSS, en büyüğü). Thumb/kapak ilk haberin `image`ını kullandığı için ilk haber kancadan önce seçer; kanca sonraki farklı fotoğrafı alır. Ardışık bölümlerin ilk fotoğrafı aynı olmaz (iki komşuya da bakılır).
  - Havuz sırası (`photo_sources`, tembel `iter_photos`): kendi sayfası (og:image, twitter:image, image_src, RSS; sonra JSON-LD "image" — logo/yazar hariç — ve `_BodyImgs`: gövde kabındaki <img> src/data-src/data-original/data-lazy-src/srcset'in en büyüğü, <figure>/galeri, galeri <a href>; ilgili haber/yan sütun/reklam/yorum/menü blokları atlanır, birden çok gövde kabından en çok fotoğraflısı alınır) → aynı haberin diğer bölümlerinin sayfaları → `same_story_pages` → haber araması (`searched`, video ile ortak önbellek).
  - Eleme: `junk_img`. Ek görselde logo, icon, avatar, sprite, banner, ads, reklam, pixel, placeholder, emoji kelimesi yalnız kısa dizin/dosya adında aranır (ölçü parçası hariç ≤2 kelime: "logo.png", "/icons/", "banner_728x90.jpg"). Başlıktan üretilen uzun adlar ("google-pixel-10-tanitildi.jpg") elenmez. Ek görselde 1x1 adresler de elenir. Haberin kendi fotoğrafında kelimeye bakılmaz (eski davranış); orada yalnız reklam alan adı ve svg/gif/ico denetimi yapılır. Ek fotoğraf en az 400x250, kendi fotoğrafı en az 300x200, oran 0,4-3,2. Ek görsel eşiğine takılıp 300x200'ü geçen adres saklanır (`_url_small`); kendi fotoğrafı olarak istenirse yeniden indirilmeden alınır.
  - Kopya tespiti: ffmpeg ile 9x8 gri dHash (tüm kare + ortadaki kare). Tüm kare ≤10 ya da ortadaki kare ≤8 bit fark aynı fotoğraf sayılır; kırpılmış kopya da yakalanır. Dokusu az görselde (beyaz zeminli açıklama/tweet ekran görüntüsü, düz grafik, renk geçişi: belirgin komşu farklarının az olan yöndeki sayısı < 8) ≤2 aranır. Kopyalardan en büyüğü kalır, özeti de onunki olur. Düz renk yer tutucu reddedilir. Pillow gerekmez.
  - Bütçe: ek fotoğraf için video başına `media.imageTries` (40) indirme ve 10 ek sayfa. T0'dan `videoSearchSeconds + imageSearchSeconds` (420 + 120 sn) sonra ek fotoğraf aranmaz. Haberin kendi fotoğrafı eskisi gibi bölüm başına 8 denemeyle ve süre sınırı olmadan alınır (kapak eksik kalmasın).
  - Çıktı: `seg-XX-k.jpg` / `seg-XX-k-tall.jpg` (k = 0..3). `images`/`imagesTall` slayt içindir; `image`/`imageTall`/`imageSize` ilk fotoğraftır; `imageSrc` ilk fotoğrafın, `imageSrcs` hepsinin adresi.
  - Yeniden yayın: `work/remake.json` `of` → `out/<eski>.json` okunur. Eski videonun tüm `imageSrcs` adresleri AVOID'e girer; ayrıca indirilip özetleri çıkarılır ki başka adresteki/boydaki kopyaları da elensin. Önce diğer sitelerin fotoğrafları denenir. Başka fotoğraf yoksa mecburen eskisi kullanılır.
  - Log: "🖼 3 farklı görsel …", "🖼 tek görsel (başka görsel bulunamadı) …", "🖼 kapak fotoğrafı WxH …"; son satır "N haber görseli hazır (X farklı, Y tanesi HD), M haber videosu (K bölümde aynı haberin videosu)". Şablon/bilgi kartı yolu (`cards_for_episode`) ve sesli/fullFrame değişmedi.
  - Remotion `MediaBg`: video + `videoStart` → önce `OffthreadVideo trimBefore` (Remotion 4.0.534; `startFrom` kullanımdan kalktı) ile video sonuna kadar oynar, sonra baştan dönen `Loop` başlar. `images` 2+ ise slayt oynar: her fotoğraf eşit süre, sırayla yakınlaş/uzaklaş, odak noktası kayarak hafif pan (ölçek ≥1, kenar açılmaz), 10 karelik çapraz kararma. Tek fotoğrafta eski Ken Burns. `Hook` `imagesTall || images` alır, `Headline` `images` alır, `GundemVideo` `videoStart`ı iletir. `GunlukOzet` de iki `MediaBg` çağrısında `images` ve `videoStart` iletir (yatay özette slayt ve paylaşılan videonun kaldığı yerden oynaması).
  - Sandbox'ta yerel HTTP sunucusu ve sahte sayfa/fotoğraflarla denendi: video yokken 3-4 farklı görsel, kopyaların tek sayılması, açıklama ekran görüntülerinin ayrı sayılması, tek görsel, adında "pixel" geçen og:image, küçük kendi fotoğrafı, kapağın og:image kalması, anlıkta 3,0/8,0/11,0 sn'den paylaşım (diğer siteye inilen kartta da), çoklu anlıkta dikeyden karta yeniden çerçeveleme, yeniden yayında kopyaların elenmesi, bütçe ve kapalı bağlantı. Kopya eşikleri 124 görsellik sentetik derlemle ayarlandı. Remotion still/kısa render ile slayt geçişi ve videoStart (testsrc sayacı 9 → 10, 11'den başlayıp 0'a sarma) gözle doğrulandı. Gerçek haber sitelerinde DENENMEDİ (ağ yok).
- Bölüm meta: `dayLabel` ("9 Ekim Cuma"), `slotLabel` ("2. 5 SAAT"), `timeRange` ("09:00–14:00"),
  `scheduleHours` (settings.scheduleHours, panel zamanlayıcıyı yazınca güncellenir). Kapak (`Thumb.tsx`,
  illüstrasyon `Sequence from={-40}` ile oturmuş haliyle) ve açıklama (`build_caption`: her haberin başlığı + metni + kaynağı) bunları gösterir.
- Anlık haber (tek konulu son dakika): panel "⚡ ANLIK HABER" kartı → `POST /api/anlik {topic, duration 20-60}`,
  WhatsApp/ses "son dakika: <konu>", "son dakika <konu>", haber linki ya da "anlık haber: <konu>", beyin eylemi `breaking_news`
  (hepsi `prepareAnlik` ile önce haberi bulur, aşağıya bakın).
  Konu `work/anlik_topic.txt`, `ANLIK=1 bash pipeline.sh`: `scripts/topic_news.py` RSS'ten konuya uyan haberleri
  süzer (4 harflik kök eşleşmesi), `prompts/anlik.md` tek konu ve 2-4 segment yazdırır, RSS çekilemezse yalnızca
  editörün bilgisiyle devam eder. `assemble`: ilk haber `breaking`, outro `OUTRO_ANLIK`, `slotLabel` "ANLIK HABER",
  `timeRange` üretim saati, `format` "anlik"; `regular_slot_of_day()` anlık videoları "N. 5 SAAT" sayımına katmaz.
  `build_caption` "🔴 SON DAKİKA:" başlığı kullanır. Başka üretim sürerken istekler sıraya girer (FIFO, 10 sn kontrol).
  Yayın: `settings.anlikAutoPublish` (varsayılan açık, kartta anahtar) → `post_pipeline.py` anlık videoyu
  `autopublish` anahtarlarından bağımsız olarak bağlı TÜM hesaplara onaysız yükler; WhatsApp bildirimi de
  bu platformlar için onay istemez (`videoInfo().anlik`). Yayın yapılmazsa neden loga "📤 otomatik yayın
  yapılmadı: …" olarak yazılır (hesap yok / anahtar kapalı).
- Elle anlık haber önce haberin kendisini bulur (kullanıcı şikâyeti: link atınca "ayrıntılar bulunamadı", kısa konuda
  uydurma): `server.js prepareAnlik()` panel kartı, `/api/anlik`, WhatsApp/sesli komut ve beyin `breaking_news` için ortak.
  Mesajda link varsa (`commands.js`: linkli her mesaj anlık haber; "aç/göster" derse tarayıcıda açar) `news_lookup.py --url`
  sayfayı okur (`mynet_watch.article`: JSON-LD articleBody → itemprop/article/haber-detay gövdesindeki paragraflar → sayfa
  paragrafları; og:site_name ya da alan adı = kaynak; Python reddedilirse curl ile tekrar; meta charset). Kısa konu
  ("son dakika Eşref Tek geri dönüyor" — iki nokta artık şart değil, "X ile haber üret", "X hakkında son dakika videosu yap";
  soru cümleleri tetiklemez) `news_lookup.py --topic`: work/news.json + son dakika siteleri/Mynet + Bing Haberler RSS
  (doğrudan link) + Google Haberler RSS (yalnız başlık) içinde 4 harflik köklerin ≥%60'ı eşleşen, 7 günden yeni haberler;
  en iyi 4 (`--pages N`, en çok 8; otomatik son dakikada 8, aşağıda "Haberin tüm kaynakları") farklı sitenin doğrudan sayfası paralel okunur (aynı siteden ikinci sayfa alınmaz). Ana haber konu metni + kaynak (ANLIK_SOURCE/URL) olur, diğerleri
  `work/anlik_related.json` (topic_news ilgili haberlerin başına koyar), okunan sayfalar `work/anlik_pages.json`
  (assemble kanca + ilk kartı ana haberden, sonraki kartları sırayla diğer sitelerin sayfasından; fotoğraf/video oradan).
  İkisi her `startAnlik` başlangıcında yeniden yazılır. Bulunamazsa ve konu 15 kelimeden kısaysa video ÜRETİLMEZ, link ya da
  ayrıntı istenir; uzunsa yalnız yazılanla üretilir. `prompts/anlik.md` "ayrıntılar bulunamadı" türü cümleleri ve genel
  bilgiyi yasaklar; `emixhas.md` yalnız manşet cümlesi yazılırsa breaking_news kullandırır.
- Şablon videolar (kullanıcı kararı; bilgisi kesin veriden gelen, Claude ÇAĞRILMAYAN videolar; `scripts/info_card.py`):
  Python betiği `work/jobs/<ad>/` içine `claude_out.json` (anlık şemasında şablon senaryo, `make_script`), `cards.json` (kart
  prop'ları) ve `meta.json` (gereken en kısa süre: kelime / 2,4) yazar; panel `startTemplate()` → `startAnlik(başlık, süre,
  {templateDir, info})` → env `TEMPLATE_DIR`, `INFO_KIND` (deprem|mac|piyasa|takvim), `INFO_LABEL` (slotLabel), `INFO_INTRO`,
  `INFO_OUTRO`, `INFO_BREAKING=0` (SON DAKİKA kartı yalnız depremde). `pipeline.sh`: haber taraması atlanır, senaryo kopyalanır
  (Claude bulunamasa da sürer), seslendirmeden sonra `info_card.py --render` kartları `render_thumbs.mjs` ile çizer
  (`InfoCard` 1840x1120 + `InfoCardTall` 1080x1920, `src/InfoCard.tsx`: deprem haritası — `TurkeyMap` MAP_PATH/project —,
  skor tablosu, piyasa tablosu, takvim yaprağı), `fetch_images` her kanca/haber segmentine sırayla kart koyar (video/fotoğraf
  aranmaz, `infoCard: true` → Headline'da karartma, kategori simgesi ve "FOTOĞRAF:" etiketi binmez). Meta `infoKind`; açıklama
  başlığı `common.INFO_HEAD` (🔴 SON DAKİKA DEPREM / ⚽ MAÇ SONUCU / 💰 PİYASALAR / 📅 HATIRLATMA), #sondakika yalnız depremde.
  Dinlenmede uyandırır. Panel Ayarlar → "📡 Otomatik içerikler" (anahtarlar, saatler, şimdi düğmeleri, takvim ek olayları),
  `GET /api/info`, `POST /api/info/:kind/run` (quake|match|market|calendar|weather|alarm|weeklyTop), komutlar "depremleri kontrol et", "piyasa videosu
  üret", "maç sonuçlarını kontrol et", "yarının takvim hatırlatmasını üret" (`info` eylemi). Durum `data/info_last.json`.
  - Deprem (`scripts/quake_watch.py`, `settings.quake` {enabled, minMag 4.5, intervalMin 2, maxAgeMin 45, maxPerDay 6,
    duration 25}): AFAD apiv2 (saat UTC; gelecekte görünürse yerel sayılır), yedek Kandilli lst0.asp (ASCII büyük harf → il/deniz
    adları `PROVINCES` ile Türkçe), aynı deprem 3 dk/60 km içinde tek; Türkiye ve yakını (35-43 K, 25-45,5 D). Senaryo yalnız
    ölçülen veri (yer, saat, büyüklük, derinlik, kaynak) + artçı uyarısı (6+ için güçlü uyarı); bulunma eki `loc()`. 6'dan küçük
    depremde `breaking_watch --mark` (aynı depremin haberi ikinci video olmasın); 6+ depremin hafıza kaydı `open` (gelişmeleri
    engellemez; "Üretilen haber hafızası"). Görülenler `data/quake_seen.json`. İki kaynak da
    düşerse log 6 saatte bir.
  - Maç sonu (`scripts/match_watch.py`, `settings.match` {enabled, leagues [tur.1, uefa.champions, uefa.europa,
    uefa.europa.conf], maxAgeHours 8, intervalMin 10, duration 25}): ESPN scoreboard; Süper Lig'de `standings.cached_top()`
    takımlarından biri, Avrupa'da herhangi bir Türk takımı (`standings.TR_NAMES`), biten ve 8 saatten yeni maç. Skor, golcüler
    (dakika, penaltı, kendi kalesine), Süper Lig'de güncel sıra/puan (standings yeniden çekilir); takım adı ekleri `suffix()`.
    Görülenler `data/match_seen.json`.
  - Sabah piyasa kartı (`scripts/market.py`, `settings.market` {enabled, hour 9, minute 0, duration 35, fuelProvince 34,
    fuelUrl}): Truncgil Finans v4 → today.json → TCMB today.xml (yalnız dolar/euro); akaryakıt Opet il fiyatları (yapı esnek
    taranır: productName benzin/motorin). Değişim kaynakta yoksa `data/market_history.json`daki dünkü değerden; akaryakıtta dünden
    fark ≥ 5 kuruşsa "zam/indirim geldi". Seslendirmede "41 lira 85 kuruştan". Önem 3 (YouTube ek hakkını harcamaz). Saatinden
    sonraki 2 saat içinde günde bir.
  - Takvim (`scripts/calendar_news.py`, `settings.calendar` {enabled, hour 19, minute 0, duration 25, monthly true, extra}):
    bir gün önce "Yarın …": sabit resmi tatiller, 10 Kasım, gelir vergisi (31 Mart), MTV (31 Ocak, 31 Temmuz), her ay memur
    maaşı (15) ve KDV (28; son gün/maaş hafta sonuna denk gelirse atlanır), Ramazan/Kurban Bayramı `RELIGIOUS` (Diyanet takvimi;
    2028 ve sonrası için Diyanet'in ilan ettiği tarihleri EKLE), panelden ek olaylar ("2027-06-19 | YKS | açıklama", "06-19",
    "ay:17"). Üretilenler `data/calendar_done.json`.
  - Meteoroloji (`scripts/weather_watch.py`, `settings.weather` {enabled, minLevel orange, intervalMin 30, duration 25, url}):
    Meteoalarm Türkiye akışı (MGM'nin resmi uyarıları, CAP: areaDesc, awareness_level, awareness_type, onset, expires); il adı
    `CENTERS` (81 il merkezi, harita noktası) ile eşlenir; aynı seviye+türdeki iller tek video, taramada en şiddetli grup; aynı
    uyarı (gün-tür-seviye) bir kez, turuncu → kırmızı yükselirse yeniden. Kart `weather` (il noktaları seviye renginde + il listesi +
    bitiş). Tür başına güvenlik cümlesi (yağış/rüzgar/kar/sıcak). `data/weather_seen.json`. INFO kind `meteo`.
  - Zam ve rekor alarmı (`market.py --alarm`, panel 20 dk'da bir, `settings.market` {alarm, fuelMinDiff 0.10, fuelFrom 7,
    fuelTo 22, recordSteps {usd 1, eur 1, gram 250}}): akaryakıt son görülen fiyattan (`data/fuel_last.json`) ≥10 kuruş farkta
    "Benzine X zam/indirim geldi" (gece yarısı değişir; 07-22 arası bakılır). Rekor: tüm zamanların en yükseği Yahoo Finance aylık
    verisinden bir kez tohumlanır (`data/market_records.json`; altın ons × dolar en yükseği / 31,1035, temkinli); yeni en yüksek bir
    eşiği aşınca ("Dolar ilk kez 42 lirayı aştı") video, varlık başına günde bir. Tohumlanamayan varlıkta (seeded self) 365 gün
    kendi kaydı birikmeden rekor denmez (yanlış "rekor" olmasın). INFO kind `alarm`.
  - Pazar derlemesi (`scripts/weekly_top.py`, `settings.weeklyTop` {enabled, weekday 0, hour 18, minute 0, count 5, duration 60}):
    son 7 günün Shorts videoları (uzun özet, piyasa/takvim/derleme hariç) izlenmeye göre (3. gün değeri), aynı olay bir kez, en çok
    5; her videonun ilk haber kartının görüntü alanı (Shorts karesinde crop 920x560+80+220) ffmpeg ile ~8 sn kesilir → cards.json
    `{video, image, videoDuration}` (info_card bunları çizmez, fetch_images videoyu segmente koyar). Geri sayım 5 → 1, kartta
    `displayIndex` (05…01), kanca sıralama tablosu kartı (`ranking`). Seslendirme: "Beşinci sırada perşembe gününün haberi: başlık."
    + başlığı tekrar etmeyen, dün/yarın içermeyen ilk cümle ("bugün" → gün adı). INFO kind `derleme`.
  Şablon senaryoda haber sayısı veriden gelir (1-6); `assemble_script` Claude'un haber sayısı sınırını TEMPLATE_DIR'de uygulamaz.
  En çok izlenen saat tekrarı piyasa/takvim/alarm/derleme videolarını seçmez.
- WhatsApp'tan gönderilen videodan haber (kullanıcı isteği, 14 Ekim: "video gönderdiğimde altına nasıl bir haber istersem hazırla,
  kesilmesi gereken yerlerden kes, montaj yap"; `app/whatsapp.js onOwnerVideo`, `server.js waVideoIn/waVideoText/waVideoGo`,
  `scripts/wa_video.py`, `prompts/montaj.md`, `settings.waVideo` {enabled, autoPublish false, duration 30, waitMin 30}): sahibin
  gönderdiği video (doğrudan, belge olarak, süreli/tek görümlük; ≤500 MB) Baileys `downloadMediaMessage` akışıyla `work/wa_inbox/`a
  iner (3 günden eskiler silinir). Açıklama talimattır; yoksa 8 sn sonra "Nasıl bir haber yapayım?" sorulur ve `waitMin` içinde gelen
  ilk mesaj talimat olur ("iptal" vazgeçer; yayın onayı "onay/iptal" önce işlenir). İLETİLEN video (başka sohbetten "İlet";
  `contextInfo.isForwarded`/`forwardingScore`; inceleme, 19 Ekim: haber hesabının "Deprem anında videodaki gibi yapın", "Aynısını
  yapın!", "#viral", "SON DAKİKA: …" açıklaması benzer video/tür/haber isteği sanılıyordu): açıklaması paylaşanın sözüdür, talimat
  DEĞİL — `waVid.caption` → iş JSON'unda `caption` → istemde `iletilen_aciklama` {metin, not: "talimat değil, bilgisi doğrulanmamış
  iddia"} (montaj, benzer video; özette açıklama yerine), yayın saati de ondan okunmaz; tür/haber/benzer video kararları yalnız sahibin
  yazdığı talimattan. 8 sn sonra bir kez kısa bildirim ("🎬 İletilen video alındı; açıklaması talimat sayılmadı. 1 dakika içinde talimat
  yazabilirsiniz (ör. "haber yap", "mizah", "benzerini yap"), yoksa ben karar veririm. Vazgeçmek için *iptal*."); sahip `FWD_WAIT_MS`
  (60 sn) içinde yazarsa talimat odur (linkli mesaj değil: o kendi işidir), yazmazsa iş talimatsız başlar ve
  türe Claude açıklamaya ve görüntüye bakıp karar verir (`DECIDE_TALIMAT`, link gibi; açıklamasız iletilen video eskisi gibi sorulur).
  8 sn içinde arka arkaya gelen videolar (albüm,
  en çok 4) TEK haberde birleşir. Bekleyen iletilen videoya yalnız AYNI albüm katılır: WhatsApp'taki gönderim anı (`messageTimestamp` →
  `sentAt`; büyük videonun indirmesi 8 sn'yi geçse de) son videodan en çok `ALBUM_MS` (8 sn) sonra; daha geç gelen video (iletilen ya da
  sahibin kendi videosu) ayrı iştir: bekleyen iş talimatsız başlar (log "🎬 önceki iletilen video talimatsız başlıyor…"), yeni video kendi
  bildirimini ve bekleme süresini alır; "en çok 4 video" reddi yalnız albümün kendi 5. videosuna düşer (inceleme, 19 Ekim: 30 sn arayla
  iletilen iki ayrı haber sessizce tek habere birleşiyor, beşinci ayrı video reddediliyordu). `wa_video.py`: her video için ffprobe, sahne geçişleri (`select gt(scene,0.3)`), konuşma dökümü
  (mlx-whisper kelime zamanları → cümle satırları), kare çizelgesi (8-16 kare, 4 sütun tek jpg) → TEK Claude çağrısı (Read aracı yalnız
  iş klasöründeki çizelgeler için `--tools Read --allowedTools Read`; olmazsa resimsiz bir kez daha): talimat önceliklidir; titrek/
  karanlık/alakasız yerler kesilir; yalnız talimatta yazan ve görüntüde/konuşmada açıkça olan bilgi (uydurma yok); kanca + 1-3 haber,
  her segmente parçalar `clips` [{video, start, end}] ve `cuts` (neyin neden kesildiği), `label` (SON DAKİKA / ÖZEL HABER…). Parçalar
  doğrulanır (sınır, ≥0,8 sn; geçersizse kullanılmamış bölümden seslendirme kadar), ffmpeg ile kesilip birleştirilir (sessiz; kanca
  1080x1920, haber kartı 1280x780; oranı uymayan görüntü KIRPILMAZ, bulanık hali zemin — `fit_filter`, birleştirme için setsar=1),
  her segmente kare (1840x1120 + 1080x1920). İş klasörü `work/jobs/video-<zaman>/` şablon düzeninde (claude_out.json + cards.json
  {video, image, tall, videoDuration}); süre talimattaki "N saniye"den, yoksa `waVideo.duration`. WhatsApp'a "✂️ Kurgu hazır" (kesimler,
  kullanılan saniyeler, seslendirme) → `startAnlik(başlık, süre, {templateDir, info: {kind: "video", label}, userVideo})` (env
  `USER_VIDEO=1` → meta `userVideo`). Yayın varsayılan ONAYLA: `post_pipeline.targets` userVideo'da hedef vermez ("önce size gelir"),
  `notifyVideo` tüm platformları "onay"a koyar; `waVideo.autoPublish` açılırsa normal anlık kuralı. Açıklama başlığı "🔴 <etiket>",
  #sondakika eklenir; en çok izlenen saat tekrarı bu videoları seçmez (görüntü haber aramasıyla yeniden üretilemez). Panel 📡 grubunda
  iki anahtar; yardım listesinde. Sandbox'ta sahte Claude planıyla dikey + yatay iki videodan montaj ve pipeline (sessiz ses) + render
  denendi; gerçek WhatsApp indirmesi ve Claude'un kare okuması Mac'te denenmedi.
  Orijinal sesli bölüm (kullanıcı isteği, 14 Ekim: "videonun orijinal sesini kullanmasını istediğim zaman video kaç saniye ise sussun,
  video izlensin, sonra konuşmaya devam edilsin"): YALNIZ talimat isterse (`wa_video.WANT_SOUND`: orijinal/kendi/videonun sesi, sesi
  kalsın/kullan, sesiyle, konuşması duyulsun, röportajı kullan…). Segment türü `sesli` (`types.ts`): Claude yerleştirir (kanca → giriş
  haberi → sesli → devam haberi; `prompts/montaj.md`), eklemezse konuşması en çok olan videonun tamamı ilk haberden sonra eklenir; istenmeden
  gelen sesli bölüm atılır. Kesim sesle (`cut(audio=…)`: ses yoksa sessizlik, loudnorm -17 LUFS), 1080x1920; altyazı videodaki konuşmanın
  kelimeleri (`WORDS`, konuşma tanıma; parçalara göre kaydırılır) → `soundWords`. `assemble` sesli bölümde boş seslendirmeye izin verir
  (`soundDuration` şart); `tts.py` sentezlemez, klip süresinde sessiz wav (zamanlama sesten), `words` = soundWords (yıldızlı), captionSync
  "orijinal ses"; `fetch_images`/`info_card.render` `sound` bayrağını taşır. Remotion: sesli bölümde seslendirme ve sahne efekti yok,
  `FullFrame` videoyu `volume=1` ile oynatır; müzik yatağı sesli bölümlerde susar (müzik `Sequence` parçaları, sesli olmayan aralıklarda).
  Dikey video (kullanıcı isteği: "dikey ise yeni dikey format, video tam gözüksün, üstünde etrafında bizim süslemeler, kanca olaylarımız"):
  tüm kaynaklar dikeyse (yükseklik > genişlik × 1,15) haber bölümleri de 1080x1920 kesilir ve `fullFrame` → `src/scenes/FullFrame.tsx`:
  video tüm kare (oranı uymayan bulanık zeminle), üst/alt karartma, giriş ışık süpürmesi, kategori renginde kenar çerçevesi + köşe süsleri,
  üstte kategori + sıra ya da SON DAKİKA şeridi (sesli bölümde dalga çubuklu "ORİJİNAL SES" rozeti), altyazı (top 1090), numaralı başlık +
  "VİDEO/GÖRÜNTÜ: kaynak" (top 1260), ilerleme çubuğu. Kanca her zaman `Hook.tsx` (flaş, sarsıntı, punch-in). WhatsApp "Kurgu hazır"
  mesajı dikey düzeni ve sesli saniyeyi yazar. Sandbox'ta sahte planla dikey + sesli montaj, pipeline (sessiz ses) ve render denendi:
  sesli bölümde orijinal ses −19 dB, diğerlerinde yok; altyazı konuşmayla eş zamanlı.
- Sosyal medya linkinden haber (kullanıcı isteği: "Instagram'da viral olmuş haberin linkini göndersem videoyu çekip bizim stilimizde
  haber yap"; `commands.js` `social_video` kuralı — instagram.com/reel|p|tv, tiktok, x/twitter status, youtube shorts/watch/live/embed/
  clip, youtube-nocookie.com/embed, youtu.be, kanalın /@kanal/live sayfası, facebook reel/watch/videos, fb.watch; linkin dışındaki metin
  talimat —, `server.js socialVideoNews` → `runVideoNews`,
  `scripts/social_video.py`): yt-dlp (≤1080p mp4, ≤10 dk `duration <? 600` — süresi bilinmeyen de geçer, ≤300 MB, `--write-info-json`;
  YouTube'da uzun video ve canlı yayın için aşağıdaki "YouTube haber linki")
  `work/wa_inbox/`a indirir; açıklama, hesap (`credit` "Instagram / @hesap"), izlenme/beğeni/tarih okunur. Instagram çoğu zaman
  girişsiz vermez: `secrets/social_cookies.txt` ya da `settings.social.cookiesFromBrowser` (panel 📡 "Sosyal medya çerezleri") →
  `--cookies-from-browser`; giriş hatasında Türkçe yol gösterir. Aynı olay `news_lookup.py --topic` (açıklamanın ilk 10 anlamlı kelimesi)
  ile haber sitelerinde aranır → `related`. Montaj planına `kaynak_paylasim` + `ilgili_haberler` gider (`prompts/montaj.md`: açıklama
  doğrulanmamış iddia, "sosyal medyada paylaşılan görüntülerde…"; haber sitesindeki bilgi esas; videonun tamamı değil seçilmiş kısa
  parçalar). Kaynak VİDEODA YAZMAZ (kullanıcı kararı, 14 Ekim: "video içinde kaynak belirtme, açıklamanın en altına tek bir kere
  'Kaynak' yaz"): `wa_video` segment kaynaklarını boşaltır, prompt seslendirmede hesap/platform adını yasaklar, `assemble` INFO_KIND video'da
  ANLIK_SOURCE'u kartlara yazmaz, `Headline` boş kaynakta "VİDEO: …" etiketini çizmez; `common.build_caption` "Haber kaynağı" satırı yerine
  hashtag'lerden SONRA, en altta tek satır "Kaynak: Instagram / @hesap" (link yok; meta sourceName). Yayın
  onaylı (userVideo). Telif: başkasının görüntüsü; kaynak gösterilir ama platformlar telif bildirimi yapabilir — kullanıcıya söylendi.
  `wa_video.py` konuşma tanıma çalışmazsa (mlx-whisper ilk ihtiyaçta kendiliğinden kurulur; olmadıysa) logda ve "Kurgu hazır"
  mesajında söyler (`plan.speech`).
  Tamamı kendi sesiyle (kullanıcı isteği, 14 Ekim: "indirilen video 1 dakikadan uzun olabilir, mümkünse hepsini orijinal sesiyle
  paylaşsın"; `settings.social` {fullSound true, maxSoundSeconds 150}, panel 📡 "🔊 … baştan sona kendi sesiyle"): sosyal medya videosunda
  talimat `NO_SOUND` (sesi kapat/kısma değil, sessiz, orijinal ses olmasın, yalnız seslendirme, kısa kes) demedikçe montaj girdisine
  `orijinal_ses_tamami` {video_suresi, en_fazla_saniye} gider (`prompts/montaj.md`: kanca → 12-20 kelimelik giriş → TEK sesli bölüm →
  10-20 kelimelik devam), seslendirme hedefi 25 sn. Kod da zorlar (`full_clips`): Claude'un sesli parçaları hedefin %85'inden kısaysa
  baştaki 0,3 sn ve sondaki 0,2 sn dışında videonun tamamı; fazla sesli bölüm atılır. Tüm sesli bölümlerin toplamı `maxSoundSeconds`
  ile sınırlı (`cap_clips`; WhatsApp videosunda da) — kanca/giriş/devam/kapanışla video ~3 dk'yı (YouTube Shorts sınırı) geçmesin; uzun
  videoda Claude en önemli kesintisiz bölümü seçer, seçmezse baştan 150 sn. Sonuç `soundFull`/`sourceSeconds` → "Kurgu hazır" mesajında
  "(videonun tamamı)" ya da "(N sn'lik videonun en önemli bölümü)".
  İlk yorum (kullanıcı isteği, 14 Ekim: "linkten gelen haberde de ilk yorum atsın"): `wa_video.py` planın `firstComment`ini (yoksa genel
  soru) senaryoya yazar (kaynak ilk yorumda da yok, yalnız açıklamada); yayın (otomatik ya da "onay") diğer
  videolar gibi YouTube/Instagram'a ilk yorumu yazar, yazılamazsa `fill_first_comments` sonradan tamamlar. WhatsApp "onay" yanıtı platform
  başına "💬 ilk yorum yazıldı / yazılamadı (neden)" der (`commentNote`); panel `publish` eylemi "  💬" satırlarını loga taşır.
  YouTube haber linki (kullanıcı isteği, 18 Ekim: "attığım youtube haber linklerini de alsın"). Link tanıma (`commands.js findLink/videoLink`,
  `server.js` de kullanır): bilinen video sitelerinde https:// olmadan yazılmış adres de link (youtu.be/…, www.youtube.com/watch?v=…,
  instagram.com/reel/…, tiktok.com/@hesap/video/…, vm.tiktok.com/…, x.com/…/status/…, facebook.com/watch…, fb.watch/…; https:// ile tamamlanır,
  sondaki noktalama, WhatsApp biçim işareti — *kalın*, ~çizili~, _italik_ (sondaki _ yalnız link _ ile başlıyorsa) — ve linke bitişik ek —
  "…'yi haber yap" — atılır; şemasız adres yalnız video, kanal ya da oynatma listesi adresiyse link, TikTok'ta yalnız video yolu
  (/@hesap/video|photo/, /t/, /v/, vm./vt.); "instagram.com/hesap", "tiktok.com/@hesap", "youtube.com/feed/trending" eskisi gibi düz metin.
  Talimatta harf/rakam yoksa — linkin çevresindeki parantez, tırnak, * — talimat boş, varsayılan haber talimatı geçer). YouTube
  kanal (/@kanal, /channel/, /c/, /user/, kanal sekmeleri), oynatma listesi (/playlist) ve diğer YouTube sayfaları (ana sayfa, arama) haber
  sayfası gibi okunmaz, Türkçe yanıt: "Bu bir YouTube kanal linki; haberin video linkini gönderin (videoda Paylaş → Kopyala …)". "son dakika:
  <video linki>" / "anlık haber: <video linki>" de `social_video` (talimat "son dakika …": fragman analizine dönmez; mizah/viral etiketli
  linkte — "son dakika: <link>/trend" — "son dakika" eklenmez, inceleme, 19 Ekim); `server.js prepareAnlik`
  beyin `breaking_news`'i ya da panel kartıyla gelen video linkini (şemasız da) `socialVideoNews`e verir (beklemeden; meşgulse ya da videodan
  haber kapalıysa hata döner; yayın saati ve videodaki konum `parseCommand` ile ayrılır: "youtu.be/… 18:30'da paylaş" → `publishAt`; dönüş
  `{ok, social, title, source}` — `viaLink`/süre yok, panel ANLIK kartı "Haberi okudum … (N sn)" değil "YouTube linki alındı. Video indiriliyor…"
  yazar). Video linkinde açma: "aç/göster" tam kelimesi (eskisi gibi) ya da linkin dışında YALNIZ açma isteği varsa (`OPEN_ONLY`: "oynat",
  "şunu açar mısın", "çalar mısınız lütfen", "açsana") o linki tarayıcıda açar (eskiden linkin harfleri YouTube'da aranıyordu); "haber yap,
  kendi sesiyle oynat", "sesiyle çal", "videonun sesini açın", "12:30'dan oynat" haber talimatıdır (`wa_video.WANT_SOUND`). Videodaki konum
  — YALNIZ YouTube linkinde; `social_video.py` yalnız orada bölüm seçer — ("12:30'dan itibaren", "12:30'daki", "1:02:10", "12:30-16:00 arası",
  "12:30'dan 16:00'ya kadar") `parseWhen`e gitmez, talimatta kalır (eskiden 12:30'a yayın planlanıyordu); eksiz "18:30", "18:30'da paylaş",
  "saat 18:30'dan itibaren paylaş", "18:30'dan sonra/itibaren paylaş|yayınla|gönder|yükle|yayına al|atar mısın" yine yayın saati; Instagram/
  TikTok/X'te "18:30'dan itibaren paylaş" de yayın saati (HEAD gibi). WhatsApp hızlı yolu (`smartWhatsApp`, Claude'a gitmez) https:// / www.
  ile şemasız video linkini de (`findLink`) görür: "youtu.be/… 18:30'da paylaş" Claude'dan geçip `breaking_news` ile yayın saatini kaybetmez.
  `social_video.py` (yalnız YouTube; diğer platformlarda yt-dlp argümanları ve çıktı aynı): önce video inmeden bilgi + altyazı
  (`--skip-download --ignore-errors --ignore-no-formats-error --write-info-json --write-subs --write-auto-subs --sub-langs "tr.*,en.*"
  --sub-format vtt/best`; altyazı inemezse bilgiyle devam). Altyazı seçimi elle tr → elle en → otomatik özgün dil (-orig) → otomatik tr → en;
  `parse_vtt` kayan otomatik altyazıda yalnız kelime zamanlı yeni satırı alır (10 ms'lik geçiş ipuçları atılır), bitiş sonraki satırı geçmez.
  `settings.social` {maxSeconds 600, longWindowSeconds 240, maxLongSeconds 10800, liveSeconds 120} (`social_cfg`; panelde alan yok, bozuk/0 →
  varsayılan). Süre ≤ maxSeconds → eskisi gibi bütün iner (indirme argümanları aynı, önüne yalnız bilgi çağrısı eklenir). Uzun video (19 Ekim'den beri yalnız talimatta/linkte zaman varsa, "kendi sesiyle/tamamı" denmişse ya da uzun video özeti
  kapalıysa; diğer durumda aşağıdaki "Uzun video özeti": videonun tamamı incelenir) (biten
  canlı yayın dahil) → `choose_window` ile en çok 240 sn `--download-sections "*A-B" --force-keyframes-at-cuts` (`--max-filesize` yok):
  1) talimattaki zaman (`time_hint`: aralık, h:mm:ss, mm:ss + -dan/-daki, 24'ten büyük eksiz mm:ss, "5. dakika(dan)", "5'inci dakika", "5
  dakikadan itibaren", "90. saniyeden", "son/ilk N dakika" — 20 sn altı ve "ilk 5 sn'yi kes", "son 10 saniyeyi kullanma" kurgu talimatıdır —,
  "başındaki", "sonundaki", "ortasındaki"; "son dakika" sayısız olduğu için sayılmaz; sonu aşan istek videonun sonunda kısalır) 2) linkteki
  t=/start= (zaman damgalı link) 3) altyazıda başlık (kanal adının kökleri hariç) + talimat (2 kat) 4 harflik kökleri, çok geçen kök az ağırlıklı
  (idf), en az 2 farklı kök ya da bir talimat kökü; bölüm anahtar kelimeli satırla başlar, noktalamalı altyazıda cümle başına (≤20 sn) geri,
  noktalamasızda bir satır önceden; bitiş bütün satırda, noktalamalıysa cümle sonunda 4) yoksa konuşmanın başladığı satır (≤120 sn), altyazı
  yoksa 0; anahtar kelimeli bölüm videonun sonuna denk gelirse (kapanış özeti) başlangıç geriye kayar, bütün pencere iner (18 sn değil).
  Aralık "12:30-16:00", "12:30 ile 16:00" ve "12:30'dan 16:00'ya kadar" (`_RANGE`). YouTube klibi (/clip/, `section_start/end`; bilgideki
  `duration` klibin süresi): `--download-sections` VERİLMEZ — yt-dlp klip aralığını kendisi keser, aralık bir daha verilirse başlangıcı ikinci
  kez kaydırıp (29+29=58 > 39,7) boş dosya indiriyordu —; normal indirme yolu (match-filter klip süresiyle geçer), altyazı (asıl videonun)
  klibin aralığına göre kaydırılır, `window` + `clip: true`, `sourceDuration` yok, not "YouTube klibi (11 sn): asıl videonun 0:29–0:40 arası
  alındı" (WhatsApp'ta bölüm değiştirme örneği yazılmaz). Log "🔗 uzun video (40 dk): 22:56–26:56 arası indiriliyor (altyazıda
  başlıkla en uyumlu bölüm: itfa, kadı, yang)". maxLongSeconds (3 saat) üstü video yalnız zaman verilirse (talimat ya da t=) alınır, yoksa
  Türkçe hata. Canlı yayın (`is_live`): `record_live` yt-dlp -g → HLS listesi okunur (ana listeyse ≤1080p alt liste), sondan liveSeconds + bir
  parça kadar geri `ffmpeg -live_start_index -k -i … -t 120 -c copy` (bir parça fazlası: ffmpeg yeni parçayı beklemeden biter; talimatta "son
  90 saniye" varsa o, en çok maxSeconds), "📡 canlı yayından son 2 dakika alındı" (liste penceresi kısaysa "… kaydedildi"). `is_upcoming` →
  "Yayın henüz başlamadı (planlanan başlangıç 18.10 20:00) …", süresiz `post_live` → "yeni bitti; birkaç dakika sonra yeniden gönderin".
  Çıktıya ek: `social.captions` (bölüme göre kaydırılmış [[başlangıç, bitiş, metin]], en çok 600; bütün inen videoda tamamı), `captionsLang`,
  bölüm/canlıda `duration` (inen parça), `sourceDuration`, `window` {start, end, reason} ya da `live`/`liveSeconds`, `note`. İlerleme satırları
  (🔗/📡) panel loguna; `note` WhatsApp'a tek satır (kısa mesaj modunda da; uzun videoda bölüm değiştirme örneğiyle). `hint()` YouTube'da: bot
  doğrulaması ("Sign in to confirm you're not a bot"), yaş sınırı, üyelere özel, gizli, ülke engeli, HTTP 429, kaldırılmış, başlamamış yayın,
  giriş → YouTube'a giriş yapılmış tarayıcının çerezi (panel 📡 "Sosyal medya çerezleri" = chrome / safari ya da secrets/social_cookies.txt);
  çerez okunamadı (yanlış tarayıcı adı, Safari'de Tam Disk Erişimi) ayrı mesaj; Instagram metni aynı; YouTube dışı 10 dk üstü ("does not pass
  filter") artık Türkçe. `socialVideoNews` talimatı `--instruction` ile verir, zaman aşımı 18 dk (bilgi ≤3 + bölüm ≤12 dk + haber araması).
  `wa_video.py`: tek videolu sosyal işte ses izi varken konuşma tanıma çalışmadıysa ya da boş döndüyse `social.captions` döküm olur (istemde
  `konusma`; log "🎬 konuşma dökümü YouTube altyazısından: N satır (…; konuşma tanıma çalışmadı / konuşma bulamadı)"; fragmanda konuşma dili
  altyazıdan; `plan.speech` true + `speechSource: "youtube"` + `speechOff` → "Kurgu hazır"da "📝 Konuşma YouTube altyazısından okundu (konuşma
  tanıma Mac'te kurulu değil; …)" ya da kuruluysa "(konuşma tanıma konuşma bulamadı)"); orijinal sesli
  bölümün kelime altyazısı (`soundWords`) altyazıdan ÜRETİLMEZ (satır zamanı kaba; kelimeler yine yalnız konuşma tanımadan). Sandbox'ta denendi
  (ağ yok; sahte yt-dlp, sahte Claude, sahte/olmayan konuşma tanıma): 100 mesajlık komut karşılaştırması (50 fark, hepsi istenen: live/embed/
  nocookie/clip/@kanal/live, kanal/liste/sayfa yanıtı, şemasız linkler, videodaki konum, link temizliği, video linkini açma, "son dakika:
  <video>"; diğer 50 aynı), 35 pencere/zaman/ipucu denetimi (40 dk sentetik otomatik altyazıda 23. dakikadaki anahtar kelime → 22:56–26:56;
  "5. dakikadan" → 300 sn; "son 3 dakika" → 37:00–40:00; noktalamalı altyazıda cümle başı), 24 uçtan uca social_video denemesi (sahte HLS ile
  canlı yayında 120,0 ve 90,0 sn, başlamamış/yeni bitmiş yayın, bot hatası, 4 sa 10 dk video, klip; Instagram ve kısa YouTube'da yt-dlp
  argümanları eskisiyle aynı), panel `prepareAnlik`/`socialVideoNews` kaynaktan çıkarılıp stub'larla 10 durum, wa_video'da 7 altyazı durumu ve
  YouTube dışı 8 iş (Instagram, sesi kapalı, WhatsApp, iki video; konuşma tanımalı/tanımasız) HEAD ile: istem, Claude argümanları, log, sonuç ve
  iş klasörü aynı. Gerçek YouTube'da (bot doğrulaması, canlı HLS penceresi, `--download-sections` hızı) DENENMEDİ. İnceleme düzeltmeleri
  (18 Ekim) sandbox'ta yeniden denendi: 158 mesajlık karşılaştırmada HEAD'e göre gerileme yok (ses talimatlı 6 mesaj yine haber, "-dan
  itibaren/sonra … paylaş|yayınla|yükle|yayına al|atar mısın" 7 mesaj yine planlı; kalan farklar istenen), kurulu yt-dlp'nin
  process_ie_result'ıyla klip aralığı (29,0–39,7; eskiden 58,0–39,7) ve match-filter, 16 uçtan uca social_video senaryosu (klip dışındaki 15'i
  önceki kodla aynı), sondaki eşleşmede 237,5 sn'lik pencere, prepareAnlik stub'larla 12 durum (WhatsApp/panel/beyin linkinde publishAt),
  başsız Chromium'da ANLIK kartı (video linki / haber linki).
- Fragman analizi (kullanıcı isteği, 18 Ekim: "bir youtube videosunun linkini göndersem onu analiz edip kelimelere döküp daha sonra
  bunla ilgili çarpıcı bir kancalı giriş ile fragmanda ne anlatıldı gibi bir 40 saniyelik video üretebilir miyiz — amaç bir filmin
  fragmanını analiz edip kullanıcıların aşırı dikkatini çekecek yapıda kurmamız lazım, videodan kareler, fragmanın özet videosu gibi";
  `scripts/social_video.py`, `server.js socialVideoNews/runVideoNews`, `scripts/wa_video.py` fragman modu, `prompts/fragman.md`,
  `settings.trailer` {enabled true, autoDetect true, duration 40, maxSoundSeconds 8}; biçimi denetlenir: nesne değilse varsayılan, `false`
  → kapalı, enabled/autoDetect "false"/0 kapalı, bozuk ya da 0 süre → 40 — `server.js trailerCfg()`, `wa_video.tr_settings()`, panel aynı
  kural; fragman olmayan wa_video işi bu ayarı hiç okumaz): sosyal medya linki yolunun üstüne kurulu.
  Tanıma (yalnız otomatik tanıma ve YALNIZ YouTube linkinde; talimatta fragman İSTENİRSE her platformda her video fragman modu — istek
  biçimi `common.trailer_ask` = `server.js trailerAsk`, `social_video.wants_summary` de: fragman/trailer/teaser (+ analiz…/özet…/video…/
  olarak) ardından ifade sonu, dolgu/süre ("fragman", "fragman:", "fragman 40 saniye"), istek fiili ("fragman yap", "bu fragmanı özetle",
  "fragmanı analiz et", "fragman analizi yap 30 saniye") ya da haber reddi ("fragmanı haber yapma") gelirse; işaret ve satır sonu yalnız
  ardından metnin sonuna kadar işaret/dolgu/süre (`_SIGN_END`: "fragman: <link>" — link talimattan atılır —, "fragman 🎬") ya da virgül/
  noktalı virgül/iki nokta/tire/satır sonundan sonra en çok dört kelime + istek fiili (`_CLAUSE`: "fragman, kısa olsun", "fragman - orijinal
  sesini kullan") gelirse ifade sonudur (inceleme, 19 Ekim: "Gerçek hayattan fragman: Kartal tilkiyi havada yakaladı", "Fragman: Dizi
  yayından kaldırılsın çağrısı" fragman analizine gidiyordu); inceleme, 19 Ekim: linkin
  yanına yapıştırılan "Ünlü oyuncu fragman çekimleri sırasında yaralandı", "Fragmanı izleyen hayranlar çıldırdı", "Fragmana tepki: …"
  haber videosunu fragman analizine gönderiyordu; "fragman parodisi", "Yeni fragman yayınlandı" de artık istek değil):
  `social_video.TRAILER` (fragman + Türkçe ekleri — "fragmantasyon" değil —, trailer, teaser; re.I Türkçe I/ı eşler) YouTube başlığında
  → `social.trailer` (TikTok/X/Facebook haber klibinin açıklamasındaki "abandoned trailer", "fragmanda yoktu" gibi sözler haber videosunu
  fragman moduna ve film adıyla aramaya çevirmesin; orada `trailer` hep false, haber araması açıklama kelimeleriyle). Yanlış pozitif ayıklanır
  (inceleme, 18 Ekim): "tanıtım filmi" sayılmaz (parti, belediye, ürün, üniversite tanıtım filmi film fragmanı değil), römork anlamı
  (`_VEHICLE`: truck and trailer, trailer park, travel trailer, tractor-trailer…) atılır, başlık ayraçlarla (| • · – — :) parçalanır ve
  fragman kelimesinden SONRA, tırnak dışında soru işareti olan parça sayılmaz (`_trailer_part`; "Fragman yayınlandı mı? Bakanlık açıklama
  yaptı", "GTA 6 fragmanı ne zaman çıkacak?" değil; "Bu Şehri Kim Yaktı? | Resmi Fragman", "Who Killed Sara? Season 3 Trailer", "What
  If...? Official Trailer", '… 98. Bölüm 2. Fragman "Ne oldu sana?"' fragman; Türkçe kesme işareti tırnak sayılmaz). Açıklamanın ilk 200 karakterinde yalnız güçlü ifade (`_DESC_TRAILER`: official trailer/teaser,
  teaser trailer, resmi fragman, "85. Bölüm Fragmanı"). `film_name()`
  başlıktan film/dizi adını ayıklar (güçlü ayraçlar | • · ile parçalar, fragman ifadesi + bitişik sıfatlar Official/Final/Resmi/Yeni/Türkçe
  Altyazılı/#2 atılır, ifadeden önce ad varsa o — yoksa sonrası —, platform/stüdyo/kanal adı parçaları, "(2026)" "(Türkçe Altyazılı)"
  parantezleri, 4K/HD, emoji ve hashtag atılır, hayran yapımı işaretleri — Concept/Fan Made/Unofficial/AI/Parody/Hayran Yapımı — fragman
  kelimesinin sıfatı gibi atılır ve yalnız bu işaretten oluşan parça ad sayılmaz ("FAN MADE | Spider-Man 4 Trailer" → Spider-Man 4),
  "200. Bölüm" `social.bolum`a ayrılır, TAMAMI BÜYÜK HARF ad düzeltilir); `social.tags`
  (ilk 15 etiket). Fragmanda haber araması film adıyla: "<film> fragman", bulunamazsa "<film> film" ya da (bölüm/sezon geçiyorsa)
  "<film> dizi" (75 sn sınır): vizyon tarihi/oyuncu doğrulanmış haberden gelsin. `--film "BAŞLIK"` ağsız dener. Fragman olmayan
  paylaşımda hiçbir şey değişmez. Karar (`server.js`, `trailerCfg()`): enabled && talimat açıkça haber istemez (`newsRequest`, yalnız istek
  biçimi — "Sosyal medya video türü"ndeki önce kesinlik kuralı: "haber yap", "haberini hazırlar mısın", "haber olarak paylaş", "haber gibi
  yayınla/göster/çek/at/oku", "haber gibi 40 saniye", "haber gibi" + satır sonu, "son dakika olarak", "haber olarak 30 saniyelik bir video
  yap", "haber olarak özetle/geç/düzenle", "bu video haber olsun"; fragman kelimesinden ÖNCE gelir: "bu
  fragmanı haber gibi yayınla" haber olur; ret, ortaç ve edilgen istek değildir: "haber yapma", "haber gibi olmasın", "haber gibi sunulan",
  "son dakika'yı kaldır", "haber olarak değil fragman olarak paylaş" fragman analizine gider; inceleme, 19 Ekim: dar "haber gibi" fiil
  listesi "haber gibi yayınla/göster/40 saniye" denen fragmanı analize gönderiyordu) && tür etiketi mizah/viral değil && (talimatta
  fragman isteği `trailerAsk` || (autoDetect && social.trailer)); `handleCommand` ilk yanıtı aynı öncelik ve aynı türle
  (`kindOf(cmd)`: "#haber fragman" haber, "link/mizah fragman parodisi" mizah videosu; inceleme, 19 Ekim). Haber isteği tek kalıp: JS
  `newsRequest` ve Python `common.news_request` (`social_video.wants_summary` de) `kind_fold`lu metinde aynı (inceleme, 19 Ekim: eski JS
  `NEWS_ASK` "SON DAKİKA", "HABER HAZIRLA" ve "son dakika degil"i Python'dan farklı okuyordu). Film adı
  (`film`) yalnız başlık fragman diye tanındıysa verilir ("fragman: <Instagram linki>" başlığı "Video by …" film adı sayılmaz; Claude
  adı karelerden okur; `wa_video` da `social.film`i yalnız `social.trailer`da kullanır). Süre `trailerSecs(talimat)` (`SURE_RE`;
  `wa_video.trailer_secs` aynı kural): talimattaki "N saniye/sn" ya da "N dakika/dk" (× 60; "1 dakikalık" → 60), belirtme/çıkma ekli sayı
  süre değildir ("baştaki 15 saniyeyi kullanma", "ilk 5 sn'yi kes", "15 sn'den sonra"; "40 saniyelik", "40 sn'lik", "40 saniyede" süredir),
  20-60, yoksa `trailer.duration`. Log "🎬 fragman analizi: <film> (talimatta istendi / başlıktan tanındı / açıklamadan tanındı; N sn,
  …)"; otomatik tanındıysa WhatsApp'a tek satır "🎬 Bu bir fragman: *ad*. …" (ad yoksa — başlık boş — ad yazılmaz; haber isteniyorsa
  linki "haber yap" ile yeniden gönderin); talimatta
  fragman varsa ilk yanıt "🎬 Başladı: fragman indiriliyor…". Talimatsız link wa_video'ya "fragman yap" olarak gider (varsayılan analiz
  talimatı `TRAILER_TALIMAT`; eskiden "kısa, dikkat çekici" cümlesi en öncelikli talimat oluyordu).
  `commands.js`: "fragman: <link>" ve "<link> fragman yap" `social_video`ya gider; linkli mesajda YouTube açma kuralı yalnız tam kelime
  aç/çal/oynat/başlat ya da kibar/ekli emir biçimi (-ar/-ır/-ın/-sana/-abilir: "açar mısın", "çalar mısın", "oynatır mısın", "açsana",
  "açın") ile çalışır ("amaç", "kaç", "açıkla", "çalışmalarını", "başlattığı" geçen talimat müzik açmaya gidiyordu). `wa_video.py`
  (`job.trailer`, `job.film`): süre `trailer.duration` (talimattaki süre önce gelir, `trailer_secs`; 20-60); `orijinal_ses_tamami`/
  `fullSound` YOK, "sesli" bölüm yalnız talimat açıkça isterse ve fragmanın ses izi varsa (`WANT_SOUND`; girdide `orijinal_ses_istegi`;
  sessiz fragmanda "ORİJİNAL SES" rozetli sessiz bölüm olmasın), toplam en çok `maxSoundSeconds` (8) sn ve kod zorlar: bütçe bitince
  fazla sesli bölüm atılır, bütçeden uzun tek parça ("0-55") baştan (stüdyo logosu) kırpılmaz, o parçanın içinden `sound_window` ile
  bütün-cümle penceresi seçilir (`trailer_sound_clips`) — Claude eklemezse
  `sound_window`: BÜTÜN döküm satırlarından en çok 8 sn'lik pencere (cümle ortasında kesmez; önce sığan, sonra diğer segmentlerin
  parçalarıyla en az çakışan, sonra en çok kelimeli); konuşma dili kendiliğinden algılanır (`align._whisper()` run(path, language=None),
  algılanan dil `align._LAST_LANG`; varsayılan "tr" çağıranlar değişmedi), log "🎬 fragman konuşması: N satır, dil: en", girdide video
  başına `konusma_dili` ve en çok 120 döküm satırı; sahne geçişlerinin TÜMÜ (`info.cuts`, 1000'e kadar) kare seçimine, isteme en çok
  150 eşit aralıklı (eskiden ilk 150: uzun hızlı kesimli fragmanın sonu görünmüyordu); `blacks()` (ffmpeg blackdetect, karenin ortadaki
  %70'i — kararma boyunca köşede duran kanal logosu/yaş rozeti siyahı gizlemesin —, 320 px, pic_th 0.998: yalnız neredeyse tamamen siyah
  kare; siyah zeminli "IN THEATERS DECEMBER 18" ya da ad kartı siyah sayılmaz, karede okunur, bu yüzden siyah zeminli bitiş kartı
  parçalardan kendiliğinden kesilmez — fragman.md yasaklar) siyah bölümler → girdide `siyah_bolumler`, parçalardaki siyah kesilip atılır (`skip_black`: kalan parça ≥0,8 sn, yoksa en uzunu
  ≥0,5 sn; en çok 8); kare çizelgesi çekimlerden
  (`shot_times`: sahne geçişleri arası çekimler, çoğu siyah olan atlanır; çekim 24'ten çoksa 24 hedef zamana en yakın çekimler — tüm
  fragmana yayılır —, azsa her çekime bir kare ve kalanlar en uzun çekimlere; geçiş yoksa eşit aralıklı; en çok 24, 4 sütun). Geçersiz
  parçanın yedeği 0,5 sn'den (stüdyo logosu) değil, ilk %10'dan (en çok 8 sn) sonraki ilk çekimden başlar; aranan geçiş açılışla sınırlı
  (en geç %25 ya da +4 sn, yoksa %10 noktası): seyrek kesimli teaser'da sondaki "coming soon" kartına atlayıp her yedeği aynı kartla
  doldurmasın (`seed`, `clean_clips(start0)`).
  Girdi {talimat (yalnız "fragman yap" gibiyse varsayılan analiz talimatı), videolar, fragman {film, baslik, kanal, aciklama ≤1500,
  yukleme_tarihi, bugun, izlenme, etiketler, bolum}, ilgili_haberler}; Claude kullanım türü "fragman"; resimsiz ikinci denemede "KARELERİ
  GÖREMİYORSUN … kuralını uygula". `prompts/fragman.md` (__SURE__, __KELIME__ montaj.md gibi; şema montaj.md ile aynı): talimat yapı,
  ton, süre ve sahnede önceliklidir ama DOĞRULUK'u geçersiz kılmaz; yalnız fragmanda görülen/duyulan + karede okunan + fragman bilgisi +
  ilgili haberler (kanal stüdyo/dağıtımcı/platform/televizyon değilse başlık ve açıklama doğrulanmış sayılmaz); concept/fan made/parody/
  AI trailer/unofficial → "hayran yapımı, resmi olmayan fragman", label HAYRAN FRAGMANI, tarih/platform/oyuncu yok; film olmayan tanıtım
  (parti, belediye, ürün, oyun) → "tanıtım filmi" dili, label TANITIM FİLMİ, kategori teknoloji/siyaset/genel, #fragman/#film yok, siyasette
  tarafsız; kareler açılamazsa görüntü tarif edilmez (döküm de boşsa 2 segment, ilk %8 ve son %12'den parça yok); müzikteki uydurma
  döküm satırları ("Altyazı M.K.") yok sayılır; tarih/oyuncu/yönetmen yalnız kaynaklarda varsa, yorum "fragmana göre / ipucu veriyor"
  diliyle, uydurma olay örgüsü ve tık tuzağı yok; İngilizce konuşma sadık çevrilir, tek çarpıcı replik "'…' repliği" olarak
  aktarılabilir; yapı kanca (2-4 kelime ≤24 karakter + ≤10 kelime, doğru merak boşluğu, parçaları 3-4 sn, 1-2 parça) → segment sayısı
  süreye göre (30 sn'den kısa 2, 30-45 sn 3-4, uzun 4-5; her biri 12-35 kelime; toplam __KELIME__'nin en az onda dokuzu): ne ve ne
  zaman — film adıyla başlar, "yeni fragman geldi" demez, yalnız doğrulanmış —, fragmanda ne anlatılıyor (hikâye yoksa bunu söyler),
  gözden kaçan detaylar/en çarpıcı sahneler, izleyiciye soru; hızlı kesim 1,2-2,5 sn, segment başına 3-6 parça, toplamı seslendirme
  kadar (kelime / 2,4 + 0,5 sn; şema örneği 4-5 parçalı), logo/yaş kartı/siyah/jenerik/hesap yazısı/"coming soon" kartı yok, film adı
  kartı en çok bir kez; kısa teaser'da (kullanılabilir görüntü < süre) fragmanın yarısından fazlası kullanılmaz, kelime görüntüye göre
  azalır; sesli bölüm varsa seslendirme sesli saniye × 2,4 kelime kısalır; kategori "sinema"; hashtag #fragman + #film/#dizi + ad;
  titles.A ≤55 karakter ve "fragman" kelimesi yok; label YENİ FRAGMAN yalnız yükleme 30 günden yeniyse ("bugun" girdide) / DİZİ
  FRAGMANI / HAYRAN FRAGMANI / TANITIM FİLMİ / FRAGMAN. Senaryo: `trailer_label()` etiketi düzler (Türkçe büyük harf, emoji/noktalama
  atılır, boşluk tekleşir: "🎬 YENİ FRAGMAN!" → YENİ FRAGMAN; ASCII yazım bilinen etikete: YENI FRAGMAN, DIZI FRAGMANI, TANITIM FILMI;
  "Hayran Yapımı Fragman" → HAYRAN FRAGMANI; uzun etiket kelime sınırında ≤30 karakter, plan etiketi kesilmeden verilir), yükleme 30
  günden eskiyse "YENİ" geçen etiket → FRAGMAN ve giriş/kapanışı etiketten seçer (YENİ FRAGMAN, DİZİ FRAGMANI: "Yeni fragman."; HAYRAN
  FRAGMANI: "Hayran yapımı fragman."; TANITIM FİLMİ: "Tanıtım filmi.", kapanış "Takip etmeyi unutma."; diğer: "Fragman analizi.");
  kategori yalnız sinema/teknoloji/siyaset/genel (diğeri ve geçersiz → sinema, tanıtım filminde genel; "asayis" etiketli fragman
  segmenti polis kartı ve #asayiş almasın), `breaking` yok, importanceReason "Fragman analizi", ilk yorum varsayılanı fragman sorusu.
  İş klasörüne `fragman_dokum.txt` ("kelimelere dökme": zaman damgalı döküm,
  dil, satır sayısı + videonun Türkçe seslendirmesi; log "🎬 fragman dökümü …"), meta.json `trailer`/`film`; sonuç `trailer`, `plan.trailer`,
  `plan.film`, `plan.intro`, `plan.outro`, `plan.speechLang`, `plan.transcriptFile`. Fragman olmayan işte wa_video.py'nin akışı, logu,
  Claude argümanları ve iş klasörü aynı (eski/yeni karşılaştırması aşağıda); aynı değişiklikte prompts/montaj.md'ye sinema kategorisi
  satırları eklendi (istem yalnız bu satırlarla farklı) ve CATS "sinema"yı kabul ediyor (eskiden genel'e düşerdi). Panel: `startAnlik`
  info {kind video, label plan || "FRAGMAN", intro `plan.intro`, outro `plan.outro`, breaking false} + `trailer: true` → env `TRAILER=1` →
  assemble meta `trailer` (asayiş zorlaması yok, `sinema_value`) → Remotion intro'da SON DAKİKA yerine etiket (`episode.trailer`) →
  `common.build_caption` başlık "🎬 FRAGMAN: …" ("🔴" değil; etiket plandan; uzun başlık kanal adı ve #Shorts sığacak şekilde kelime
  sınırında kısalır), `trailer_tags`: #fragman eklenir (TANITIM FİLMİ'nde eklenmez), #dizi varsa sinema kategorisinin #film'i atılır
  (fragman.md "#film ya da #dizi"), #sondakika hiç yok (kanal ortak etiketlerinden de
  atılır; `caption_tags` aynı), kapanış satırı fragmana göre (tanıtım filminde genel); "Kaynak: YouTube / @kanal" en alttaki satır aynen;
  YouTube'da "· Son Dakika" listesine girmez. Yayın onaylı (userVideo), en çok izlenen saat tekrarına girmez (infoKind video). "✂️ Fragman kurgusu hazır" (kısa mesaj modu
  kapalıyken) film adını ve konuşma dilini yazar. Panel 📡 grubunda "🎬 Fragman analizi" anahtarı + süre (20-60 sn) + "başlıktan otomatik
  tanı" anahtarı; yardım listesinde. Telif: stüdyoların Content ID sistemi bu videoları talep edebilir, gelirini alabilir ya da bazı
  ülkelerde engelleyebilir; sessiz kısa parçalar + kendi seslendirmemiz riski azaltır ama kaldırmaz (kullanıcıya söylenmeli). Sandbox'ta
  denendi: 24 gerçekçi başlıkla tanıma/ad ayıklama (İngilizce, Türkçe, dizi bölümü, BÜYÜK HARF, fragman olmayanlar) + 20.000 rastgele
  başlıkta hata yok; ffmpeg ile üretilmiş sentetik fragman (45 sn 1920x1080, siyah açılış, sahte stüdyo logosu, ~16 çekim, çekimler arası
  3 kararma, "IN THEATERS DECEMBER 18" kartı, sinüs sesi) + istemi kaydeden sahte Claude + sahte İngilizce konuşma tanıma ile wa_video
  uçtan uca: 16 sahne geçişi, 4 siyah bölüm, 24 çekim karesi (hiçbiri siyahta değil), istem fragman.md + fragman bilgisi, orijinal_ses_tamami
  yok, dil "en", siyahı kesen parça ikiye bölündü, "50 saniye" + "orijinal sesini kullan" talimatında sesli bölüm 7,3 sn (≤8), parçalar ve
  cards.json, fragman_dokum.txt; sahte yt-dlp ve haber aramasıyla social_video ("Aurora fragman" bulunamadı → "Aurora film"); assemble
  TRAILER=1 meta ve build_caption başlığı/etiketleri; sahte bağımlılıklarla panel kararı (6 durum). Fragman olmayan 4 iş (sosyal medya
  tam ses, WhatsApp sesli bölüm; konuşma tanımalı/tanımasız) eski ve yeni wa_video.py ile çalıştırıldı: Claude argümanları, log ve
  iş klasörü bayt bayt aynı (istem montaj.md'nin sinema satırlarıyla farklı). Üç bağımsız inceleme (18 Ekim) sonrası düzeltmeler sandbox'ta yeniden denendi: 35 + 27 başlıkla tanıma
  (römork, soru başlığı, tanıtım filmi, açıklamadaki güçlü ifade; gerçek fragmanlar yine tanınıyor), 17 durumluk yönlendirme ("bu fragmanı
  haber yap" → haber) ve süre, özensiz planda kancanın 5,7 sn'den başlaması (logo değil), siyah zeminli tarih kartlarının siyah
  sayılmaması ve karede görünmesi, 199 geçişli 170 sn fragmanda son %25'e 6 kare (eskiden 1), resimsiz denemede "KARELERİ GÖREMİYORSUN",
  oyun fragmanında (teknoloji) asayiş zorlaması ve #kaza yok, fragman dışında setteki gerçek ölüm asayiş + #kaza, oynatma listesi
  yalnız "· Sinema", başlık sığdırma, tanıtım filminde #fragman yok, pipeline render'ında intro "YENİ FRAGMAN"; fragman olmayan 3 iş
  (sosyal medya, WhatsApp, sesli; konuşma tanımalı/tanımasız) HEAD ve yeni wa_video.py ile: log, Claude argümanları ve iş klasörü aynı,
  istem yalnız montaj.md'nin sinema satırlarıyla farklı. Son inceleme turu (18 Ekim) düzeltmeleri de sandbox'ta denendi: c7fc57e /
  c63076d / düzeltilmiş ağaçta aynı senaryolarla assemble (anlıkta setteki ölüm/yaralı/silahlı saldırı yine asayiş, tek olaylı videoda
  tüm kartlar asayiş, zararsız set kazası ve çoklu anlıktaki ayrı film haberi sinema, sinema dışı girdiler c7fc57e ile aynı), sahte
  yt-dlp ile X/TikTok "trailer/fragman" açıklamalı haber klibi (fragman değil, arama açıklama kelimeleriyle; YouTube fragmanı yine
  tanınıyor), 66 mesajlık komut karşılaştırması (yalnız amaç/kaç/açıkla/çalışmalarını/başlattığı farklı), 10 + 36 + 27 başlık ve
  20.000 rastgele başlık, 25 yönlendirme + 18 süre + 15 ayar biçimi, köşe logolu kararmada 4 siyah bölüm (diğer sentetik videolarda
  sonuç aynı), 15 sn teaser'da yedeğin 1,5 sn'den başlaması, iki sesli bölümde toplam 7,8 sn, "0-55" sesli bölümde 31,8-33,9 bütün
  cümle, sessiz fragmanda sesli bölüm yok, bozuk settings.trailer (true, false, süre "abc"/0, maxSoundSeconds "x") ile fragman olmayan
  iş ve fragman işi; fragman olmayan 18 wa_video işi (sosyal medya, WhatsApp, sesli, çoklu, dikey; konuşma tanımalı/tanımasız) c7fc57e
  ile: log, Claude argümanları ve iş klasörü aynı (sinema planında yalnız kategori genel → sinema), istem yalnız montaj.md'nin sinema
  satırlarıyla farklı. Gerçek YouTube indirmesi, mlx-whisper'ın dil algılaması ve Claude'un kare
  okuması Mac'te DENENMEDİ.
- Sosyal medya video türü: haber / viral / mizah (kullanıcı isteği, 19 Ekim: "bazen mizah, bazen normal sosyal medyada çok izlenen video
  linkleri gönderiyorum, bunları da son dakika diye haber yapıyor; link/mizah yazınca mizah kategorisine göre üretilsin ama direk mizah
  yazmasın, girişte izlenmez, videonun sonunda belirtelim; ya da link/trend"). Eskiden her paylaşım "SON DAKİKA" etiketi, "Son dakika."
  girişi, SON DAKİKA kartı ve #sondakika ile üretiliyordu (panel talimatsız linke "haber olarak anlat" yazıyordu). Etiket: `commands.js
  findLink` linke bitişik "/mizah", "/komik", "/trend", "/viral", "/haber"i (büyük harf "/MIZAH" ve bitişik "#mizah" da) adresten ayırır
  (`tag`; yt-dlp "watch?v=ID/mizah"yı indiremez), `tagKind` onu ya da linkin yanına YALNIZ yazılmış etiketi ("mizah", "#trend", "_viral_")
  ya da başta ayraçla yazılmış etiketi ("mizah, kısa kes", "#trend: sesi kalsın") komutun ayrı `kind` alanına koyar (komik → mizah, viral →
  trend) ve talimattan atar; etiketin yanında yalnız yayın fiili, süre ya da dolgu kelimesi varsa da etiket sayılır ("mizah 18:30'da paylaş",
  "trend 40 saniye" → talimatta "40 saniye" kalır, "bunu mizah olarak paylaş"; `KIND_FILL`) ve `when.js` mutlak saatin hemen ardındaki
  yayın fiilini de atar ("18:30'da paylaş" talimatta "paylaş" bırakmaz; inceleme, 19 Ekim: etiket serbest cümle sanılıp tür Claude'a kalıyordu); `kind` panelde `socialVideoNews({kind})` → social_video.py `--kind` (mizahta haber araması yok, viral/mizahta
  kendiliğinden özet yok) → wa_video işinde `job.kind` (sıra kuyruğu ve panel ANLIK kartı da taşır; mizah/viral etiketli linke "son dakika"
  eklenmez — ANLIK kartında talimattaki açık ifade de etikettir: `kindOf({kind, instruction})`, "<link> mizah videosu" son dakika olmaz;
  inceleme, 19 Ekim). Etiket yoksa serbest metinde yalnız AÇIK etiket (`common.content_kind`, server.js `contentKindOf` aynı kural):
  talimat yalnız etiketse (yanında `KIND_FILL` dolgusu: "mizah 40 saniye", "bunu mizah olarak paylaş"; haber dışındaki etiketin yanında
  "yap"/"olsun" da, `KIND_DO`: "mizah yap", "trend olsun"; "viral olsun" değil: "Paylaşın viral olsun 🙏" kayıp çocuk/yardım çağrısı),
  başta ayraçla etiket (`_KIND_LEAD`, commands.js `tagKind` aynı; ardından yalın başka etiket gelirse seçim açıktır, etiket değil: "haber,
  mizah, viral fark etmez", "haber/mizah sen karar ver"; ikinci etiket ifade başlatırsa — gibi/olarak/video…/istek fiili — baştaki etiket
  geçer: "mizah, haber gibi anlat" mizah; başlık biçimli iki nokta yalnız ardından en çok 4 kelime varsa: "#trend: sesi kalsın" etiket,
  "Trend: Gençler arasında yayılan tehlikeli akım iki can aldı" değil), sonda işaretten ya da satır sonundan sonra yalın etiket (`_KIND_TAIL`:
  "Adam düştü 😂 mizah", "son dakika diil bu, viral", "bu haber değil, mizah"; yalnız kısa metinde — etiket dışında en çok 4 kelime,
  `_TAG_WORDS`, link sayılmaz, "Kadıköy'de" tek kelime —, uzun metinde yalnız zayıf haber biçimini bastırır; inceleme, 19 Ekim: "Selde
  mahsur kalan aile helikopterle kurtarıldı - Viral", "… (Viral)" ciddi altyazı viral video oluyordu), #etiket, açık tür ifadesi ya da açık haber isteği (her
  zaman haber); harfsiz/büyük harf yazım aynı (`kind_fold`). ÖNCE KESİNLİK (inceleme, 19 Ekim: tetik + "bilinen kötü devam yoksa her devam"
  sayan kara liste kalıplar her incelemede yeni yanlış tetik veriyordu: "haber yaparken düşen muhabir 😂 mizah olarak paylaş", "Son dakika
  golüne sevinen taraftar 😂 mizah videosu" haber; "Komik video sanılan görüntüler…", "kavganın viral videosu gündem oldu" mizah/viral;
  "son dakika falan yazma" SON DAKİKA): tetik yalnız ardından AÇIK İSTEK BİÇİMİ gelirse sayılır (beyaz liste; kaçırılan serbest metin isteği
  ucuz — link/mizah, link/trend, link/haber etiketi var, sahip yeniden yazabilir, etiketsiz videoda türü Claude içerikten seçer —, yanlış
  tetik pahalı). İstek biçimi fiil kökünden hemen sonra (Python `_REQ` = JS `REQ_FORM`, dört tanıyıcıda aynı): yap, yapın, yapsana,
  yapalım, yapsın, yapar mısın, yapabilir misin, yapıver, yapmalısın(ız), yapacaksın/yapcan/yapacak mısın, yapacaz/yapcaz/yapıcaz
  ("haber yapcaz bunu"), yapmak/yapmasını istiyorum, yapmak/yapman(ız) lazım/gerek ("haber yapman lazım bunun"; "gerek yok" ret), yapsan iyi olur, -ıp + istek fiili ("çizip paylaş"); edilgen istek (yapılsın, yapılacak, yapılması
  lazım) yalnız "haber + fiil"de ve tür ifadesinde; başka her biçim (yapma, yapan, yaparken, yaptığı, çekimi, yaptı, "yapmak yerine",
  "yapmayı bırak", "yapmak zorunda değil"; üçüncü kişi/biz gereklilik ve soru görüştür: "Medya haber yapmalı", "TRT bunun benzerini
  yapmalı", "üretmeliyiz", "haber yapmalı mı?", "haberi yapılacak mı?", "haber yapılmalı" — inceleme, 19 Ekim) istek değil. İstek fiili
  kökleri `_ASK_V`/`ASK_V` (anlat, yap, hazırla, üret, yaz, paylaş, göster, çek, at, özetle, düzenle…; "geç" — `_GEC` — yalnız istek ekiyle
  ya da ifade sonunda: "haber olarak geç"; "son dakika geç kaldı" sıfat). ALINTI/AMAÇ (inceleme, 19 Ekim: "Herkes haber yap diyor ama bence
  mizah olsun", "haber yap demiştim ama vazgeçtim, mizah olarak yap", "Komik video olsun diye kediyi suya attı", "Haber yapalım derken
  muhabir suya düştü", "Aynısını yapalım derken iki genç yaralandı" haber/mizah/benzer video oluyordu): istek fiilinin ardından (araya
  boşluk, virgül, nokta, tırnak) diye, der/derken/dersen, deyince/deyip/deyerek, denilen, dedi…, demiş…, demiyor…, diyor…, diyen, diyecek,
  diyerek ya da çağrısı/talebi/uyarısı gelirse istek başkasının sözü ya da amaçtır, sayılmaz (`_say(L)` = `sayWords(L)`, üç tanıyıcıda;
  "diyorum/diyoruz" sahibin ısrarıdır: "haber yap diyorum" haber). Haber isteği GÜÇLÜ biçim (her zaman): "haber(i/ini/leri) yap|hazırla|
  üret|çek|yaz"; "haber olsun" yalnız talimatın başında, bu/bu video/şu/bunu/şunu/videoyu (+ da/de) sonra ya da talimatın son sözü olarak
  (ardından yalnız işaret/dolgu/süre: "…ama vazgeçtim, normal haber olsun"; yönelme hâlinden ve kalmasın/duysun/duyulsun/bilsin/görsün/
  öğrensin'den sonra deyimdir: "herkese haber olsun", "Kedim yine dolabın üstünde, duymayan kalmasın haber olsun 😂 mizah videosu" mizah;
  inceleme, 19 Ekim); "haber olarak" + ifade sonu ya da istek fiili (hemen ardından virgülle yeni cümle başlarsa değil: "Güzel bir haber
  olarak, kedimiz Pamuk 5 yavru doğurdu"; virgülden sonra yalnız dolgu/süre, istek ya da ret: "haber olarak, son dakika yazma");
  "haber gibi/şeklinde/formatında/diliyle" + istek fiili ("haber gibi yayınla"; "haber gibi sunulan" değil); araya en çok üç ara kelime ya da
  süre ("haber olarak 30 saniyelik bir video yap", "son dakika olarak kısa bir özet hazırla", "haber gibi bir şey hazırla", "haberini 30
  saniyelik hazırla", "bunun haberini kısa yap", "haberini kısa bir şekilde hazırla", "haber videosu 30 saniyelik hazırla"; inceleme,
  19 Ekim: süre araya girince istek kaçıyor, trailer başlıklı link fragman analizine, "bunun gibi … ama haber olarak 30 saniyelik
  hazırla" benzer videoya gidiyordu); "habere çevir", "haberleştir", "haber haline getir"; "son dakika" (ya da "son dk") + olarak/diye/
  etiket…/haber…/video… + son ya da istek, ya da + istek fiili. ZAYIF biçim (yalnız açık mizah/viral ifadesi — sondaki yalın etiket de —
  yoksa haber; inceleme, 19 Ekim: "Son dakika: gol yiyen kaleci 😂 mizah videosu", "😂 #komik #viral #sondakika" haber, "yalan haber
  gibi 😂 mizah yap", "gerçek bir haber gibi 😂" benzetmesi haber oluyordu; metinde gülme emojisi — `_LAUGH` 😂🤣😹😆😅😁😄😝🤪 — varsa iki "son
  dakika" biçimi sayılmaz: "Son dakika 2 dakika kala otobüse yetişen öğrenci 😂", "SON DAKİKA: Annem tatlıyı yine saklamış 😂"; inceleme,
  19 Ekim): etiket "son dakika" + ifade sonu (`_SD_LABEL`: "son dakika:",
  "🔴 SON DAKİKA |", "#sondakika"); talimatın başında "son dakika" + kesme işaretli özel ad ya da rakam (`_NEWS_START`: "Son dakika
  Kadıköy'de yangın", "Son dakika 4,2 büyüklüğünde deprem"; inceleme, 19 Ekim: ortaç ve bileşik ad — "Son dakika yetişen damat", "Son
  dakika gol yiyen kaleci", "Son dakika tatil fırsatları", "son dakika diil bu" — haber oluyordu; kaçırılan "Son dakika Erdoğan açıkladı"
  ucuz: Claude gerçek olayı zaten haber seçer); talimatın başında (bunu/şunu/videoyu/bu fragmanı +) fiilsiz "haber gibi" + ifade sonu ya da
  rakam (`_NEWS_LIKE`: "haber gibi 40 saniye", "haber gibi\nözetle", "haber gibi 😂"; işaret ve satır sonu fragman isteğindeki gibi
  `_SIGN_END`/`_CLAUSE` ile: "Haber gibi 😂 Minik muhabir sınıfta hava durumunu sundu" değil; cümle içindeki benzetme — "Tıpkı bir haber
  gibi.", "sahte haber gibi, mizah olarak paylaş", "zaten haber gibi, sadece kısalt" — değil). Tür ifadesi (mizah/komik/viral/trend/çok izlenen + (bir)
  video/içerik/şey/olarak/amaçlı/kategori/şekilde/tarzında) yalnız ardından ifade sonu (son, noktalama, emoji), dolgu/süre, istek fiili
  ya da "ama/ve" + istek gelirse (istiyorum/isterim da: "komik bir video istiyorum"); tür kelimesi + istek fiili, "olsun" ya da "istiyorum"
  kendi başına yeter ("mizah yap sesi kalsın", "komik yap 40 saniye sesi açık", "mizahi anlat", "haber istemiyorum mizah istiyorum" mizah;
  "viral olsun" değil); "mizaha çevir" ("habere çevir" gibi) mizah; video adının ilgi/bulunma/araç hâli ("viral videonun sahibi") ve ilgi hâlinden sonraki
  iyelik ("kavganın viral videosu"; "bunun komik videosunu yap" istek fiiliyle sayılır) betimlemedir. Ardından ret (değil — konuşma dilinde
  diil/deil —, yok, gerek yok, gerekmez, yerine, kaldır, alakası/ilgisi yok, -mAnA gerek yok, olumsuz fiil `VERB_NEG` — yazmıycaz,
  yazmayacaz, yazmıcan, yazmasana da —, edilgen kök de; araya en çok üç ad: "son dakika falan yazma", "son dakika ile alakası yok") gelen
  istek sayılmaz, reddedilen kısım atılınca kalan etiket geçer ("haber yapma mizah yap" → mizah). Kalıplar `common.py` ile server.js aynı
  (harf `[^\W\d_]` ↔ `\p{L}` ve işaret sınıfı çevrilince kalıp metni birebir; `VERB_NEG`/`KIND_FILL`/`KIND_DO` commands.js'ten; `_kind_text`:
  ², Ⅻ gibi sayı işaretleri ayraç). Yoksa "" → `prompts/montaj.md` "VİDEO
  TÜRÜ": girdide `video_turu.istenen` null, Claude içeriğe göre "tur" seçer (gerçek olay → haber; ilginç/şaşırtıcı an, akım, hayvan… →
  trend; komik → mizah). Açık etiket Claude'un "tur"unu ezer; tek istisna güvenlik: mizah istenip Claude içerik nedeniyle (mağdur, yaralı,
  çocuk…) "trend" derse trend (log "mizah istendi ama Claude içerik nedeniyle viral (saygılı) anlattı"). "haber" etiketi açık haber isteğidir
  (fragman otomatik tanıması yapılmaz); mizah/viral etiketli videonun başlığı ya da talimatı fragman dese de (parodi; "link/mizah fragman
  parodisi") fragman analizine gitmez. Haber istenip Claude "VİRAL" (ÇOK İZLENEN, SOSYAL MEDYA, MİZAH…) etiketi verirse etiket "GÖRÜNTÜLÜ
  HABER" olur (`VIRAL_LABELS`; log "🎬 video türü: haber — talimatta istendi (Claude trend demişti); VİRAL etiketi GÖRÜNTÜLÜ HABER yapıldı";
  inceleme, 19 Ekim: haber "VİRAL" etiketi, "Viral." girişi ve "🔴 VİRAL:" başlığıyla çıkıyordu). Talimatsız sosyal medya linkinde talimat boş gider
  (`DECIDE_TALIMAT`); WhatsApp videosunda eski varsayılan (haber). Talimat yalnız etiketse ("mizah", "#trend", "viral 18:30";
  `common.kind_only`) montaja türün varsayılan talimatı (`KIND_TALIMAT`) gider. Haber türünde sosyal medya paylaşımı "SON DAKİKA" etiketini
  yalnız yeni (bugün/dün) ve büyük olayda alır, diğerinde "GÖRÜNTÜLÜ HABER" (montaj.md); SON DAKİKA olmayan etiketli video haberinde (WhatsApp
  videosu dahil) giriş "Son dakika." değil etiketin kendisi ("Görüntülü haber.", "Özel haber."), intro'da etiket (`Intro videoLabel`,
  `episode.infoKind` video), SON DAKİKA kartı yok. Haber etiketi `wa_video.news_label` ile düzlenir ("Son Dakika", "SON DAKIKA" → SON DAKİKA;
  GÖRÜNTÜLÜ HABER, ÖZEL HABER…; en çok 30 karakter), `breaking` yalnız SON DAKİKA etiketinde kalır (sosyal medya, WhatsApp videosu ve özet).
  Viral/mizah videosunda haber değeri etiketlerinden (can kaybı, acı olay) de #sondakika gelmez (`hashtags.for_meta`). Fragman ve uzun video özetinde tür yok. trend/mizah (`wa_video.kind_label`):
  etiket VİRAL (ÇOK İZLENEN, SOSYAL MEDYA, GÜNDEM kabul; SON DAKİKA/MİZAH/başka → VİRAL), giriş "Sosyal medyada gündem.", kapanış mizahta "Bu
  video mizah amaçlıdır. Daha fazlası için takip etmeyi unutma.", trendde "Sosyal medyada çok izlenen videolar için takip etmeyi unutma.",
  `breaking` yok, her segmentin kategorisi türün kendisi; istem: haber kalıpları yok, canlı sosyal medya dili, kimseyi aşağılama yok, mağdur/
  çocuk/hasta mizah konusu değil, mizahta "mizah/komik/espri/şaka/güldüren/kahkaha" kancada, ekran başlıklarında, titles'ta ve ilk segmentte
  YOK. Panel `startAnlik(…, {contentKind})` + info {label, intro, outro, breaking: false} → env `CONTENT_KIND` → assemble meta `contentKind`
  → Remotion: intro'da etiket (VİRAL), kancada son dakika sesi yerine kategori sesi, kapanış sloganı "HER 5 SAATTE BİR / SON DAKİKA" yerine
  "SOSYAL MEDYANIN / VİRALLERİ" (`Outro slogan`), mizahta takip düğmelerinin altında "BU VİDEO MİZAH AMAÇLIDIR" rozeti (`Outro note`); `build_caption` başlığı "🔥 VİRAL: …" (mizah yazmaz), #sondakika yok (`calm_tags`), kapanış satırı mizahta "😄 Bu video mizah
  amaçlıdır. Güldüren videolar için takip et, abone ol." (açıklamanın sonunda), trendde "Sosyal medyanın en çok konuşulan videoları…";
  YouTube'da "· Son Dakika" listesine girmez, kategori listesi "· Viral Videolar" / "· Mizah". Yeni kategoriler (`src/categories.ts`):
  trend #FF2D55 (telefon, artan izlenme sayacı, kalpler, yükselen grafik + alev; `sfx/trend.wav` iki pop + yükselen parıltı) ve mizah
  #C6FF00 (zıplayan, göz kırpan gülen yüz, konfeti, yıldız; `sfx/mizah.wav` yay sesi), ikisinin de ekrandaki adı VİRAL; assemble `CATEGORIES`,
  `ASAYIS_MUAF` ("komik kaza" asayiş kartı olmasın), wa_video `CATS`, hashtags (#viral #keşfet / #mizah #komik #viral; mizahta mizah/komik
  etiketleri listenin SONUNA alınır — YouTube açıklamadaki ilk 3 etiketi başlığın üstünde gösterir), oynatma listesi;
  senaryo.md/anlik.md haber istemleri bunları önermez. Mizah videosu haber sitelerinde aranmaz (`social_video.related` atlanır); viral/mizah
  etiketli uzun YouTube videosu kendiliğinden özetlenmez. WhatsApp ilk yanıtı "🎬 Başladı: … mizah videosu (VİRAL etiketiyle; mizah olduğu
  sonda söylenir) hazırlanıyor". Sandbox'ta denendi (sahte Claude): mizah/trend etiketli, etiketsiz (Claude trend/mizah/haber seçti) ve "haber
  yap" + Claude mizah dediği işler (etiket, giriş, kapanış, kategori, breaking, istemde video_turu), assemble + build_caption + caption_tags +
  oynatma listesi (CONTENT_KIND mizah/trend/yok), Remotion kareleri (kanca VİRAL, intro VİRAL / GÖRÜNTÜLÜ HABER, Trend/Mizah çizimleri, kapanış
  sloganı ve mizah rozeti); tür etiketsiz 5 wa_video işi (sosyal medya, WhatsApp, sesli, fragman, "haber yap") eski kodla: kurgu, Claude
  argümanları ve iş klasörü aynı, istem montaj.md'nin yeni bölümleriyle ve girdideki `video_turu` ile farklı (talimatsız sosyal medya
  linkinde talimat artık `DECIDE_TALIMAT`). Gerçek Claude'un tür seçimi DENENMEDİ. İnceleme düzeltmeleri (19 Ekim) sandbox'ta denendi: 34
  talimatlık Python ve 28 talimatlık JS/Python karşılaştırması (fark yok), 12 linkli komut (bitişik/büyük harf/# etiket, saat, "haber yap"
  cümlesi, kanal linki), wa_video'da etiketle mizah + Claude trend (güvenlik düşürmesi), "akımına kapılan… haber yap" (haber), "Son Dakika"
  etiketi (SON DAKİKA + breaking), GÖRÜNTÜLÜ HABER (breaking yok); ilk yorum varsayılanı artık türe göre doğru (eskiden türden önce
  okunduğu için her habere viral sorusu düşüyordu). Ret/betimleme düzeltmeleri (inceleme, 19 Ekim) sandbox'ta denendi: 95 etiketli talimat
  (beklenenle aynı), 26.929 metinlik derlemde (önceki derlemler, benzer video tanıma örnekleri, CLAUDE.md/istem/yardım cümleleri, 20.000
  üretilmiş birleşim, zor karakterler) JS ve Python tür + haber isteği birebir aynı (eski kodda 3 tür ve 429 haber isteği farkı vardı); 251
  talimatlık eski derlemde HEAD'e göre 27 tür farkının hepsi istenen (ret, betimleme, "haber gibi anlat", "haber çek"); 126 komutluk
  derlemde 18 fark (etiketli "son dakika: link" talimatı, ret, "haber gibi"); panel kodu kaynaktan çıkarılıp sahte bağımlılıklarla 14 durum
  (ANLIK kartı, trend radarı, "link/mizah fragman parodisi", "#haber fragman" yanıtı, 🖼/📝/🔎 log satırları ve kısa mod uyarısı).
  JS'de `KIND_WORDS`/`KIND_TAG` prototipsiz nesne ("constructor mizah" JS'de etiket sanılıyordu), commands.js `kfold` şapkalı â/î/û'yu da
  katlar (inceleme, 19 Ekim). Önce kesinlik yeniden tasarımı (inceleme, 19 Ekim) sandbox'ta denendi: 783 satırlık tek etiketli dosya (eski 95
  tür beklentisi — "çok izlenen videolardan biri" artık betimleme —, benzer video örnekleri, incelemelerdeki her örnek cümle, incelemecinin
  354 mesajlık derlemi, 85 gerçek haber altyazısı) Python ve JS'te beklenenle aynı; tür/haber kalıp metni harf ve işaret sınıfı çevrilince,
  benzer video kalıbı doğrudan birebir aynı; 26.929 ve 68.806 metinlik derlemlerde ve 30.000 bulanık metinde Python/JS farkı 0; 340.000
  karaktere kadar uzun girdiler 0,4 sn altında; panel kopyasında 75 durum (31'i önceki ağaçtan bilerek farklı: "haber gibi yayınla/göster/
  40 saniye" fragman analizi değil haber, yanlış benzer video tetikleri haber montajına, "mizah yap"/"komik bir video yap" mizah); 51
  wa_video işi HEAD, önceki ağaç ve yeni ağaçta (sahte Claude; 24'ü her çağrısı başarısız Claude ile yalnız yönlendirme): tam işlerde önceki
  ağaca göre tek fark "haber gibi göster" işinde istemdeki istenen tür (haber), yönlendirme işlerinde yalnız amaçlanan değişiklikler;
  `wants_summary` 12.136 talimat × 8 durumda farkların hepsi tanıyıcı kararından. Üçüncü doğrulama turunun düzeltmeleri (inceleme, 19 Ekim:
  alıntı/amaç sözü, başka videoyu gösteren baş, yönelme deyimi, ses koruma, konuşma dilinde ret, "son dakika" ortaç/özel ad, fiilsiz "haber
  gibi" benzetmesi, "viral olsun" çağrısı, araya süre giren istek, "haber olarak özetle/geç", gereklilik görüşü, fragman isteği beyaz listesi,
  iletilen video) sandbox'ta denendi: etiketli dosya 1.015 satır (her bulgu cümlesi, incelemecilerin sahip mesajı ve haber altyazısı
  örnekleri; "-kabul" kaynaklılar bilinçli kaçırma ya da kalan tetik) ve 40 satırlık fragman isteği dosyası Python ve JS'te beklenenle aynı,
  12 kalıp çifti metin olarak birebir; 26.929 ve 68.806 metinlik derlemde ve 30.000 bulanık metinde Python/JS farkı 0; 340.000 karaktere
  kadar uzun girdiler (17 yeni biçim dahil) en çok ~0,6 sn (JS'te süreç başlatma dahil); incelemecinin 482 haber altyazısında tetik 134 → 87 (kalanlar çoğunlukla
  izleyiciye emir ve etiket: iletilen videoda talimat sayılmaz); panel kopyasında 117 durum (önceki 75'i aynı; 42'si — incelemecilerin 31
  uçtan uca durumu ve 11 yeni — bilerek farklı), iletilen video akışı 9 durum (bildirim, sahibin talimatı, iptal, albüm, açıklamasız, link);
  `wants_summary` 13.280 talimat × 8 durumda 1.271 farkın hepsi tanıyıcı kararından (çoğu fragman isteği beyaz listesi: "fragman" geçen ama
  fragman istemeyen uzun YouTube videosu yine kendiliğinden özetlenir). wa_video
  regresyonu (sahte Claude, önceki ağaç ve yeni ağaç): önceki 51 iş log, iş klasörü, istem ve Claude argümanlarında birebir aynı; bu turun 22
  işinin 19'u bilerek farklı (süre araya giren haber isteğinde istenen tür haber ve VİRAL → GÖRÜNTÜLÜ HABER; "bunun gibi … ama haber olarak
  30 saniyelik hazırla", "Deprem anında videodaki gibi yapın", "dünkü videodaki gibi yap, sesi kalsın", "dünkü videonun aynısını yap",
  "buna da aynısını yap", "aynısını yapalım derken" çizilmiş hikâye değil montaj; alıntı, benzetme, "viral olsun" çağrısı ve konuşma
  dilindeki retle istenen tür düzeldi; iletilen açıklama istemde `iletilen_aciklama`, talimatsızsa `DECIDE_TALIMAT`). DENENMEDİ: gerçek
  WhatsApp'ta iletilen videonun `contextInfo.isForwarded`/`forwardingScore` alanı (Baileys belgesine göre); ilk iletilen videoda logdaki
  "🎬 WhatsApp'tan iletilen video geliyor" satırına bakın.
  Son denetim düzeltmeleri (inceleme, 19 Ekim: cümle içindeki "videodaki gibi", reddedilen ses/görüntü koruması, "haber(ini) + süre +
  fiil", iletilen videoların birleşmesi, "haber olsun" deyimi, "fragman:" + cümle, yapıştırılan altyazı, sahibin kaçan istekleri) sandbox'ta
  denendi: etiketli dosya 1.106 satır (her bulgu cümlesi; üç "-kabul" satırı bilerek düzeldi: iki gülme emojili "SON DAKİKA:" şakası, "bunu
  mizaha çevir") ve 52 satırlık fragman isteği dosyası Python ve JS'te beklenenle aynı, 12 kalıp çifti metin olarak birebir; 26.929 ve
  68.806 metinlik derlemde ve 30.000 bulanık metinde Python/JS farkı 0; 340.000 karaktere kadar uzun girdiler (bu turun 24 yeni biçimi
  dahil) en çok ~0,6 sn (JS'te süreç başlatma dahil) — `_FILLTOK` sayıdan sonraki boşluğu yalnız birimle alır (önceden "1" + 100 boşluk + "1"… 300 karakterde 9 sn
  sürüyordu); panel kopyasında önceki 117 durum aynı, 36 yeni durumun 30'u bilerek farklı (trailer başlıklı link + "haberini 30 saniyelik
  hazırla" fragman analizi değil haber; "Gerçek hayattan fragman: …" fragman değil; "Trend: …"/"… - Viral" uzun altyazısı tür almaz);
  iletilen video akışı 11 durum (30 sn arayla iki iletilen → iki iş; 3 videoluk albüm → tek iş; bildirimden sonra inen albüm videosu → aynı
  iş; 4 videoluk albüm + 20 sn sonra ayrı video → reddedilmez, ayrı iş; pencerede sahibin talimatı ve iptal); wa_video regresyonunda
  (sahte Claude) önceki 73 iş log, iş klasörü, istem ve Claude argümanlarında birebir aynı, bu turun 19 yönlendirme işinin 17'si bilerek
  farklı (benzer video ya da istemde istenen tür). Kalan bilinen durumlar: "görüntüleri kullanmadan sıfırdan çiz bunu" kaçırılır (şey
  adsız "sıfırdan"ın solu beyaz listede değil); "Köpeğin tavşanla saklambacı 😂 aynısını yapalım mı?" soru biçimi hâlâ benzer video sayılır.
- Çerçeve ve ekrandaki yazılar (kullanıcı isteği, 19 Ekim: "Instagram'dan video gönderdiğimde bazı haber ve paylaşım yapanların etrafında
  çerçevesi oluyor ve bazen linkte açıklama olmuyor; videodaki kelimeleri analiz ederek haber üretebilir miyiz"; `scripts/frame_crop.py`,
  `wa_video.build`, `settings.waVideo` {cropFrame true, screenText true}, panel 📡 grubunda iki anahtar). Fragman ve uzun video özeti dışındaki
  her wa_video işinde (sosyal medya linki, WhatsApp videosu): 1) Çerçeve tespiti (`frame_crop.detect`; inceleme, 19 Ekim: ilk sürüm
  hareketli bölgeyi çerçeve sayıyordu ve tripodla çekilmiş gökyüzü/çatı çizgisini, fotoğraf + video bölünmüş ekranı kırpıyordu; ayrıntı
  modülün başındaki açıklamada): kırpma hareketten değil çerçevenin kendi OLUMLU kanıtından çıkar. 48 gri kare (108 px, %3-97; uzun videoda
  ortadaki iki dakika; giriş/"takip et" kartları ayıklanır), sağlam durağanlık (karelerin %85'inde ortancanın ±8 düzeyi içinde). Ortanca karenin
  her satırı/sütunu düz renk, yazı/logo kümesi ya da dokulu (fotoğraf, doğal görüntü) diye sınıflanır; kenardan içeri yürünür: düz zemin, iki yanı
  aynı zeminle çevrili kısa durağan kümeler (logo, hesap adı, başlık) ve tek tek karelerde yazı görülen kısa hareketli şeritler (kayan yazı,
  değişen başlık) bant sayılır; dokuda, uzun hareketli bölgede, yazısız hareketli şeritte (yoldaki arabalar) ya da rengi kayan düz bölgede
  (gökyüzü) durulur. Bantlar YALNIZ karşılıklı ikişer kabul edilir (ikisinde yazı, ya da yazı + aynı zemin, ya da aynı düz renkte, simetrik,
  keskin sınırlı siyah/çerçeve renginde bantlar); tek yandaki gökyüzü/duvar/fotoğraf asla yetmez. İçerik karenin ≥ %12'si, içinde hareket var,
  bölünmüş ekran (bir ucunda düz olmayan durağan görüntü + sınırda tam genişlikte hareket) değil. Sınır üç tam çözünürlüklü anahtar karede
  inceltilir, kırpma birkaç piksel içeriden; dönüş bilgisi (eski etiket ve yeni ffmpeg yan verisi) okunur; hiçbir girdide çökmez (ses, resim,
  bozuk dosya → "video okunamadı"), 200 sn 1080p video ~4 sn. Ölçüm (scratchpad puanlama seti, kırpma +1, doğru kırpmama +1, kaçırma −1,
  yanlış/içerik kesen kırpma −5): 65 geliştirme videosu 60, tasarımcının görmediği 28 video 24, sonradan üretilen 26 yeni zor video 16
  puan; üçünde de yanlış ya da içerik kesen kırpma SIFIR (eski sürüm: −154, 35 ağır hata). Bilerek kaçırılanlar: dokulu (fotoğraf) zeminli
  çerçeve, bulanık hareketli zemin, yalnız üstte bant, iki kez değişen başlık; bazı çerçevelerde başlık paneli kırpıda kalabilir (eksik kırpma).
  Bulunursa içerik dikdörtgeni kırpılmış kopya (`kirp-N.mp4`, crf 17, ses aynen) bütün işin kaynağı olur: kare
  çizelgesi, kesimler, dikey/yatay kararı (çerçeveli 16:9 içerik yatay sayılır: haber kartı + bulanık zemin), sesli bölüm; log "🖼 video 1:
  çerçeve kırpıldı (1080x1920 → 1058x596; bant ust %27, alt %41)…"; meta `videos` özgün dosya. 2) Ekrandaki yazılar (`frame_crop.text_frames`):
  çerçeve kırpıldıysa, paylaşımın açıklaması boş ya da 40 karakterden kısaysa ya da (WhatsApp videosunda) talimat kısa ve konuşma yoksa ÖZGÜN
  (çerçeveli) görüntüden farklı çekimlerden, baştan sona yayılmış büyük kareler (uzun kenar 1280 px; tek videoda 4, az token modunda 3, çok
  videoda 2) girdiye `yazi_kareleri` olarak girer, kırpılan videoda `cerceve` notu; `prompts/montaj.md` "EKRANDAKİ YAZILAR VE ÇERÇEVE": her
  kareyi Read ile aç, başlık/alt yazı/isim bandı/yer-tarih/rakamları oku; açıklama yoksa haberin bilgisi yazılardan ve konuşmadan gelir; yazılar
  paylaşan hesabın sözüdür (iddia diliyle; ilgili haberde doğrulanmışsa haber gibi), hesap adı/logo/"takip et"/reklam bilgi değildir; okunan
  önemli yazılar planın `ekran_yazilari` alanına (en çok 5). Log "📝 video 1: ekrandaki yazılar için 3 büyük kare okunacak (paylaşımın açıklaması
  yok)". 3) Açıklaması boş paylaşımda haber siteleri konuşmadaki anlamlı kelimelerle aranır (`speech_words`, aşağıda; mizahta değil; 75 sn; log "🔎 paylaşımın
  açıklaması yok: haber siteleri konuşmadaki kelimelerle arandı…"). "Kurgu hazır" mesajı (kısa mod kapalıyken) "🖼 Çerçeve kırpıldı" ve "📝 Ekrandaki
  yazılar: …" satırlarını yazar (`plan.frameCropped`, `plan.screenText`). Sandbox'ta sentetik videolarla denendi: çerçeveli (üst logo bandı +
  alt başlık paneli, 3 çekim), yanıp sönen düğmeli tek çekim çerçeve, beyaz kenarlıklı 4:5, siyah şeritli 16:9 → kırpıldı; tam ekran hareketli,
  konuşan kişi benzeri (durağan zemin), durağan gökyüzü + hareketli alt yarı, bulanık zeminli + durağan başlık → kırpılmadı; açıklamasız
  çerçeveli Instagram işi uçtan uca (kırpma, 3 yazı karesi, istem, kesimlerde çerçeve yok); çerçevesiz 6 iş eski kodla aynı (istem montaj.md'nin
  yeni bölümüyle farklı). Gerçek Instagram videolarında ve Claude'un yazı okumasında DENENMEDİ: ilk gerçek işte logdaki 🖼/📝 satırlarına bakın;
  yanlış kırpma görülürse panelden "🖼 çerçeveyi kırp" kapatılabilir.
  İnceleme düzeltmeleri (inceleme, 19 Ekim): açıklama boş/kısa ölçüsü hashtag,
  @hesap ve emoji atılmış metinde (`bare = sv.clean_caption(@hesapsız)`: "#sondakika #haber #gündem #keşfet" ya da "😱 @hesap #viral"
  açıklama yok sayılır; eskiden 40 karakteri geçtiği için ne yazı kareleri ne konuşmadan haber araması yapılıyordu). Konuşmadan haber
  araması `wa_video.speech_words`: dolgu ve selamlama sözleri (`SPEECH_STOP`: arkadaşlar, burada, anda, bakın, gerçekten, değerli,
  hepinizi, selamlıyorum…; `sv.KW_STOP`a ek) atılır, kesme işaretinden sonraki ek atılır (Kepez'deyiz → Kepez), özel adlar önce (kesme
  işaretli, cümle ortasında büyük harfli ya da ardından büyük harfli kelime gelen: "Bolu Dağı"), sonra çok geçen; 4 harflik kök başına bir
  kelime, 5 kelime (news_lookup'ta 3 kök eşleşmesi); eski "dökümün ilk 10 kelimesi" görgü tanığı/bakan açıklaması konuşmasında aynı olayın
  haberini bulamıyordu (sentetik 7 konuşmada eski 3, yeni 7). Ekrandaki yazılar kapalıyken de kırpılan videonun özgün (çerçeveli)
  görüntüsünden çerçevedeki başlık için 2 (çok videoda 1) yazı karesi gider (log "📝 video 1: çerçevedeki başlık için 2 büyük kare okunacak
  (ekrandaki yazılar kapalı; çerçeve kırpıldı)"); `cerceve` notu yazı karesi yoksa ondan söz etmez. Resimsiz ikinci denemede (Read kapalı)
  montaj.md'nin "EKRANDAKİ YAZILAR VE ÇERÇEVE" bölümü `NO_TEXT_RULE` ile değişir ("GÖREMİYORSUN … ekrandaki yazıları tahmin etme,
  ekran_yazilari []"), `yazi_kareleri` girdiden atılır, o denemenin planındaki `ekran_yazilari` "📝 Ekrandaki yazılar" diye gösterilmez;
  ilk denemede yalnız yazı karesi varsa da Read açılır. Panel `runVideoNews` 🖼/📝/🔎 satırlarını da loga taşır (eskiden düşüyordu) ve
  kısa mesaj modunda kırpılan videoda WhatsApp'a tek satır "🖼 Çerçeve kırpıldı: … Yanlışsa panelden "🖼 çerçeveyi kırp" kapatılabilir."
  `wa_video.probe` döndürmeyi ffmpeg 5+ yan verisinden de okur (`stream_side_data=rotation`; eskiden yalnız "rotate" etiketi: dikey çekilip
  yatay saklanan telefon videosu yatay sayılıp haber kartına konuyordu); yan veri bölümünü tanımayan eski ffprobe'da yalnız etiket.
  Sandbox'ta HEAD ile denendi (sahte Claude, sahte haber araması): çerçeveli işte resimsiz ikinci denemenin isteminde yazı kareleri ve "HER
  BİRİNİ Read aracıyla aç" yok, screenText boş (eskiden uydurulabilen yazı gösteriliyordu); çerçevesiz işin resimsiz denemesi bayt bayt
  aynı; hashtag-only ve "😱 @hesap #viral" açıklamada 3 yazı karesi + "Esenyurt binada yangın çıktı itfaiye" araması (eskiden ikisi de
  yok); gerçek açıklamada değişiklik yok; görgü tanığı konuşmasında arama "Kadıköy sahilindeyiz büyük yangın çıktı" (eskiden "Arkadaşlar
  anda Kadıköy…" 10 kelime); ekrandaki yazılar kapalıyken çerçeveli işte 2 yazı karesi; 90° döndürülmüş 1280x720 telefon videosu 720x1280
  ve dikey. Tür etiketsiz/etiketli 15 wa_video işi önceki çalışma ağacıyla aynı, yalnız "haber yap" + Claude trend/VİRAL işinde etiket
  GÖRÜNTÜLÜ HABER (HEAD'e göre ayrıca benzer video özelliğinin "sıfırdan kuruyor, haber yap" işi farklı; bu değişiklikle ilgisi yok).
- Benzer video, sıfırdan üretim (kullanıcı isteği, 19 Ekim: "bir video gönderdiğimde o videoyu izleyip kelimelerini çıkartıp o videodaki
  gibi sıfırdan video üretmesini benzer bir şekilde yapmasını sağlayabilir miyiz"; `scripts/wa_video.py build_recreate`, `scripts/scene_svg.py`,
  `prompts/benzer.md`, `scripts/render_scenes.mjs`, `src/SvgScene.tsx`, `common.recreate_ask/recreate_on`, `server.js RECREATE_ASK`,
  `settings.waVideo.recreate` — varsayılan açık; false, "false", 0 kapalı —, panel 📡 grubunda "🎨 Benzer video (sıfırdan)" anahtarı, yardım
  listesinde). Referans videonun görüntüsü ve sesi KULLANILMAZ: video izlenir, kelimeleri çıkarılır, aynı hikâye/mesaj kendi cümlelerimizle
  yeniden yazılır ve her sahne SVG olarak sıfırdan çizilir. "🔁 yeniden yayınla" (kendi videomuzun yenisi) bundan ayrıdır.
  Tanıma (WhatsApp videosunun açıklaması ya da linkin yanındaki talimat; iletilen videonun açıklaması değil; `_kind_text`/`kindFold`lu
  metin, harfsiz yazım aynı: "sifirdan").
  ÖNCE KESİNLİK (inceleme, 19 Ekim: ara kelimesi serbest, fiili uzakta olabilen "güçlü/zayıf" kalıplar "Esnaf sıfırdan başladı 30 saniyelik
  video yap", "Emekli usta tekneleri sıfırdan yapıp satıyor, haber yap", "Yapay zeka sıfırdan video üretebiliyor", "Togg'un benzerini üretip…"
  haber görüntüsünü atıp çizilmiş hikâye yapıyordu): yalnız BAŞ + yalnız beyaz liste ara kelimeleri (en çok 4: bir/bi, yeni, kısa, uzun,
  türkçe, N saniye(lik)/dakika(lık), biz/sen de, bana, aynı, sıfırdan, yeniden, olarak, (bir/iki/2…) tane (daha): "bunun gibi 2 tane yap",
  şey, lütfen, yarın, bugün,
  şimdi, kendi cümlelerinle, video, içerik, animasyon, hikâye, kıssa, çizim, çizgi film) + İSTEK BİÇİMİNDE fiil (yap/üret/çiz/anlat/hazırla/
  tasarla/oluştur/canlandır, yaptır/çizdir; yukarıdaki istek biçimi listesi + "yapılsın"; -ıp ve -mak yalnız ardından istek fiili ya da
  istiyorum gelirse) ya da şey adı + olsun/istiyorum/talimat sonu ("bunun gibi bir video, 40 saniye"; "Sıfırdan animasyon: gençlerin
  projesi" değil). Baş: benzer(ini/i/lerini), buna/şuna benzer, aynısını, sıfırdan, bunun/şunun gibisini, böylesini, esinlenerek, ilham
  alarak, benzer/buna benzeyen + şey adı + fiil ya da olsun/istiyorum ("benzer bi video yap"; fiilsiz "Benzer bir hikâye 😢" altyazısı
  değil), videodaki gibi, bunun/şunun gibi, bu/şu/aynı/bunun/şunun/videonun/videodaki tarz(ında)/formatta/stilde, videonun/videodakinin
  benzerini/aynısını, benzer (bir) şekilde. BU video (inceleme, 19 Ekim: "dünkü videodaki gibi yap, sesi kalsın", "dünkü videonun aynısını
  yap, haber olarak", "Dünkü haberi beğendim, onun gibi yap" sahibin görüntüsünü ve sesini atıp çizilmiş hikâye yapıyordu): "videodaki/
  videonun/videodakinin" yalnız bu/şu'dan sonra, talimatın başında ("o videodaki gibi yap" da), işaretten ya da satır sonundan sonra
  ("Çocuklar için masal. Videodaki gibi yap", "30 saniye, videonun aynısını yap", "30 saniye\nvideodaki gibi yap") ya da bunu/şunu/lütfen/
  aynen/tıpkı/aynı/tam/hemen/abi/tamam/sen de/siz de'den sonra (`_RC_THIS`; inceleme, 19 Ekim: önceki tur cümle içindeki baş tanınmıyordu);
  başka videoyu gösteren söz ("dünkü/önceki/son/diğer/eski videodaki gibi", "geçen haftaki videonun
  aynısını") ve geri gönderim ("onun gibi", "onun tarzında", "ona benzer", "o tarzda") baş değil. Baş sayılmaz: ilgi hâlinden sonra
  ("Togg'un benzerini", "Ahmet'in videosunun aynısını"; yalnız kelime başından bunun/şunun hariç — "videosunun", "salonun" sonu bunun/
  şunun sayılmaz), yönelme hâlinden sonra "aynısını/benzerini yap" deyimi (`_RC_DAT`: "buna da aynısını yap", "bu videoya da aynısını
  yap": aynı işlemi uygula), şey adı olmadan sola bağlı "sıfırdan" ("Anayasayı sıfırdan yapalım"; talimatın başında ya da bunu/videoyu/
  hikâyeyi/ve/ama/lütfen'den sonra sayılır; işaretten sonra yalnız çiz/anlat/üret/canlandır/tasarla ile: "Yılan ve fareler kıssası,
  sıfırdan anlat" benzer video, "kurgu kötü olmuş, sıfırdan yap" yeniden kurgu isteği, değil). Ardından değil (diil)/
  olmasın/istemiyorum/istemem/istemeyiz/gerek yok/gerekmez/yok ya da alıntı/amaç sözü (diye, dedi, demiş, derken, diyen, deyince,
  diyerek, diyor…: "Aynısını yapalım derken iki genç yaralandı", "Herkes bunun benzerini yap diyor ama sen haber yap") gelirse sayılmaz.
  Ses/görüntü koruma isteği varsa benzer video değil (`RC_KEEP`: "sesi kalsın", "sesini kullan", "orijinal sesle/sesli", "kendi sesiyle",
  "görüntüleri kullan"; sıfırdan çizimde referansın sesi ve görüntüsü kullanılmaz; "sesi kullanma", "kendi sesinle" anlatıcı değil; ardından
  — araya hiç/asla/kesinlikle — ret gelen koruma sözü koruma değil: değil/diil/deil, yerine, yok, gitsin, kapat/kaldır(ın/ılsın), kullan/
  iste/ol + `VERB_NEG` — "orijinal görüntü kullanılmasın, bunun benzerini sıfırdan çiz", "orijinal ses değil, bunun benzerini sıfırdan
  anlat", "bunun benzerini sıfırdan çiz, orijinal ses yerine seslendirme olsun" benzer video; inceleme, 19 Ekim).
  Açık haber isteği (`news_request`) varsa yalnız nesneyi adlandıran baş kazanır (benzerini, aynısını, sıfırdan, gibisini, böylesini,
  esinlenerek, benzer + şey adı: "benzerini yap ama haber gibi anlat" benzer video); "bunun gibi", "bu tarzda", "benzer şekilde" haber
  isteğine yenilir ("bunun gibi bir video yap ama haber olarak (30 saniyelik) hazırla" haber). Python `RECREATE_RE`/`RECREATE_STRONG`/
  `RC_KEEP` ve JS `RECREATE_ASK`/`RECREATE_STRONG`/`RC_KEEP` aynı kalıp metni (`.pattern` = `.source`); `kind_fold` ayrık yazılmış İ'yi
  ("I" + U+0307) JS gibi "i" yapar (tür ve haber isteği eşliği de). Kalan bilinen tetik: linkin yanına yapıştırılan izleyiciye emirli
  altyazı ("Ev hanımları…, siz de aynısını yapın 👇", "Videodaki gibi yapın, kombi faturanız düşsün") ve fiilsiz slogan ("Sıfırdan bir
  animasyon 🎨") sahibin isteğinden metinle ayırt edilemez; WhatsApp'ta iletilen videoda açıklama talimat sayılmadığı için oluşmaz.
  Yönlendirme: `socialVideoNews` indirdikten sonra özet ve fragman kararından ÖNCE (`recreateOn() && recreateAsk`; fragman ya da uzun video
  olsa da benzeri çizilir; haber sitelerinde aranmaz — `social_video.py` ilgili haber aramasını atlar, `wants_summary` false) →
  `runVideoNews({recreate: true, related: []})`; WhatsApp videosunda `runVideoNews0` talimattan karar verir; iş JSON'unda `recreate: true`;
  `wa_video.build` job.recreate ya da (recreate_ask && recreate_on) ve iş fragman/özet değilse `build_recreate`. `commands.js` değişmedi (linkli
  talimat `social_video`ya gider, talimat korunur).
  İzleme: ffprobe, sahne geçişleri, konuşma dökümü (dil kendiliğinden), linkte konuşma tanıma bir şey çıkarmazsa YouTube altyazısı, çekimlere
  hizalı 16 karelik çizelge, konuşması 3 satırdan az videoda ekrandaki yazılar için 4 büyük kare (`frame_crop.text_frames`; screenText
  kapalıysa yok). Hedef süre talimattaki "N saniye/dakika" (20-90), yoksa referansın süresi 30-90'a sıkıştırılır (66,8 sn → 67). TEK Claude
  çağrısı (kullanım türü "benzer", Read aracıyla kareler; olmazsa resimsiz bir kez, "Kareleri GÖREMİYORSUN"). `prompts/benzer.md`: konu,
  mesaj, tarz; hikâyenin özü ve sırası korunur, cümleler kendi (en çok 3-4 kelimelik ortak ifade), başka dildeki konuşma Türkçe yeniden
  anlatılır, haber videosunda bilgi yalnız döküm/kare/açıklamadan, marka/logo/gerçek kişi/telifli karakter yok, şiddet ima edilir; kanca
  (≤24 karakter başlık + ≤10 kelime) + süreye göre 3-6 sahne (12-35 kelime, `title`, `sahne` tarifi, `svg`), toplam ≤ süre × 2,4 − 6 kelime;
  label (HİKÂYE, KISSADAN HİSSE, BİLGİ…), category, palet (3-5 renk), titles, hashtags, firstComment, cuts (neyin korunup neyin değiştiği),
  ekran_yazilari. SVG kuralları: tek satır, tek tırnak, viewBox 0 0 1080 1920, kökün her `<g>`'si sırayla beliren bir adım (4-10), tam sayfa
  zemin yok (kâğıt hazır; geniş alan fill-opacity 0.5-0.85), çizim kâğıda çarpma karışımıyla basılır (açık renk kâğıdı aydınlatamaz: ışık/
  parıltı önce çizilen koyu zeminin üstüne), renkler paletten, ana çizim y 220-1080 (üstte kategori etiketi, altyazı y 1090, başlık y 1260;
  kancada y 520-820 büyük başlık → ana figür altında ya da yanlarında), kenarlardan 60 px içeride, yazı en çok 1-2 küçük etiket, sahne ≤ 8 KB.
  Plan: kanca yoksa ilk sahnenin ilk cümlesi; en çok 6 sahne; `fit_words` (istenen süre ya da 90 sn × 2,4 kelime; önce son sahne dışındaki en
  uzun sahnenin son cümlesi; son sahne başka sahne cümle kaybedebildiği sürece kısalmaz, sonra yalnız ortasından — ilk ve son iki cümlesi hiç:
  ders sondan bir önceki cümle olabilir, inceleme, 19 Ekim: "40 saniye"de ders siliniyordu —; sonra sondan bir önceki sahne, en son ortadaki
  en uzun sahne kelime sınırında kısalır, tek sahnede son iki cümleden önceki kısım); kategori, etiket, başlıklar (A/B/cover metin), etiketler (metin), önem (1-5) ve ilk yorum çizimden ÖNCE
  düzlenir (inceleme, 19 Ekim: liste "category" bütün sahneler çizildikten sonra işi düşürüyordu); `recreate_label` (Türkçe büyük harf,
  ≤20 karakter; SON DAKİKA/ÖZEL HABER/VİRAL/ÖZET → GÜNDEM, HIKAYE → HİKÂYE), giriş/kapanış etiketten ("Kısa bir hikâye.", "Kıssadan
  hisse.", "Kısa bir bilgi."; kapanış "Yeni hikâyeler için takip etmeyi unutma."), kategori CATS dışıysa genel, `breaking` yok,
  importanceReason "Benzer video (sıfırdan)", ilk yorum varsayılanı "Siz bu hikâyeden ne ders çıkardınız? 👇".
  SVG güvenliği (`scene_svg.sanitize` → (svg, grup sayısı); hiçbir girdide hata fırlatmaz): beyaz liste (çizim öğeleri ve öznitelikleri);
  script, foreignObject, image, iframe, style, animate/set ve bilinmeyen öğe çocuklarıyla atılır (`<a>` atılır, çocukları kalır); on*
  öznitelikleri, "#" ile başlamayan href/xlink:href atılır. Dış kaynak yok (inceleme, 19 Ekim: image-set("http…"), CSS kaçışı "\75 rl(",
  kapanmamış "url(http…" ve kökün style'ındaki background-image iki katmandan da geçip Chrome'a resim indirtiyordu): düzgün iç başvurular
  `url(#ad)` çıkarıldıktan sonra url( kalan ya da ters bölü, image-set, image(, cross-fade, element(, src(, attr(, "://", data:, javascript:,
  @import, expression içeren öznitelik/style bildirimi atılır; style'da yalnız görünüm özellikleri (`STYLE_PROPS`: fill, stroke…, opacity,
  font-…, transform; background, mask-image, content, cursor yok); kökün style'ı hiç kalmaz. `<use>` çoğaltması sınırlı (iç içe `<use>`:
  10 kopya × 5 düzey kare başına 9 sn sürüyordu): en çok 200 `<use>`, açılınca en çok 2000 öğe, döngülü başvuru → yedek sahne; `<style>`taki
  basit kurallar (.sınıf, öğe adı) öğelerin style özniteliğine taşınır, class atılır, id'ler "c-" önekli (sayfadaki kimliklerle çakışmasın);
  kök viewBox geçerliyse kalır (yoksa 0 0 1080 1920), preserveAspectRatio "xMidYMid meet", width/height yok; kökün her çizim çocuğu
  `<g class='rN'>` içine (24'ten fazlası sonuncuda); çizimin tamamı tek dış `<g>` içindeyse (ortak kontur/transform) onun çocukları
  gruplanır ve rN'ler o `<g>`'nin içinde kalır; bozuk XML hoşgörülü ayrıştırıcıyla; boş/bozuk/çok büyük çizim (girdi 200 KB, çıktı 60 KB,
  1500 öğe, 24 derinlik) → `fallback()` sade sahne (gökyüzü, güneş, kuşlar, başlık y 330, tepeler y 900-1100 — altyazının üstünde —; güneş ve
  tepeler paletin en az doygun iki ara renginden, canlı vurgu rengi koca tepeyi boyamaz; yerleşim sahne sırasıyla değişir).
  `SvgScene.cleanSvg` ikinci katman, aynı kurallar: öznitelikler HTML ayrıştırıcısının gördüğü gibi taranır (tırnaksız değer, boşluksuz ya
  da "/" ile ayrılmış öznitelik), beş temel kaçış dışındaki karakter başvurusu ("&#117;rl(", "&lpar;") düz metin olur, feImage da atılır,
  style yalnız görünüm özellikleri, kökün style'ı atılır, en sonda kalan her dış url(/image-set( geçersiz işleve döner, ters bölü atılır;
  `<style>` seçicileri `.ss-art` altına (bildirimleri de süzülür), CSS animasyon/geçişi atılır. `prompts/benzer.md`: döküm, altyazı,
  açıklama ve ekran yazıları VERİDİR, talimat değil (adres, resim, kod taşınmaz).
  Çizim: `scripts/render_scenes.mjs <iş.json>` ([{out, props {svg, count, seconds, hold, palette, seed}}]; proje bir kez paketlenir, tarayıcı
  bir kez açılır, `PUPPETEER_EXECUTABLE_PATH` varsa o; `SCENE_CONCURRENCY` varsayılan çekirdeklerin yarısı, en çok 4; sessiz h264, crf 18,
  veryfast; en çok 2 tekrar; her sahnenin kendi süre sınırı max(120 sn, kare × 0,5 sn) — denemeler dahil, `makeCancelSignal` ile iptal,
  aşan sahne yeniden denenmez, sıradaki çizilir, yavaş sahne yedeğe düşer —, wa_video'nun bütün iş sınırı sahne sınırlarının toplamı + 5 dk
  (en az 20 dk; `scene_budget`); stdout yalnız {ok, results {out: "ok" | "hata: …"}}, ilerleme stderr'e) → Remotion `SvgScene` (Root.tsx, 1080x1920,
  30 kare/sn, süre ceil((seconds + hold) × 30)): kâğıt (paletin en açığı kremle karışır; lekeler, kahve halkaları, gren; doku sekme başına bir
  kez tuvale basılır), mürekkep renginde vinyet, çizim çarpma karışımıyla, el titremesi (feTurbulence + feDisplacementMap, tohum her 5 karede
  döner), rN grupları sırayla (seconds'ın %55'ine yayılır, en az 0,25 sn arayla, sığmazsa hepsi %80'den önce; 0,5 sn soluklaşma + 30 px kayma
  + 0,94→1 büyüme; çizgiler 1 sn'de kalemle çizilir, kendi kesik çizgisi olan grup yalnız soluklaşır; seçici `.ss-art .rN`, kök çocuğu
  olmayan rN de canlanır), Ken Burns 1,00→1,06 + tohuma göre ±14 px kayma; Math.random yok. Sahne süresi = kelime / 2,4 + 0,8 + 1,5 (kancada en
  az 4); klibin sonuna %30 (en az 1,5 sn) bekleme (`hold`; çizim tamam, kamera ve titreme sürer): FullFrame/MediaBg kısa klibi `Loop` ile baştan
  başlatır, gerçek ses tahminden yavaşsa çizim boş kâğıttan yeniden başlıyordu. Başarı dosyaya bakılarak; çizilemeyen sahne sade yedekle bir kez
  daha, yine olmazsa kâğıt renginde düz klip; hepsi çizilemezse hata "sahneler çizilemedi". Ölçüm (sandbox, 4 çekirdek, başka işlerin yükü
  altında): 5 sahne (56-72 sn klip) dahil wa_video 5-8 dk; Mac'te ölçülmedi; çizim sınırı 20 dk, panelin wa_video sınırı 50 dk.
  İş klasörü (şablon düzeni): claude_out.json, cards.json (kanca kartı normal video kartı → `Hook.tsx`; sahneler `fullFrame` → `FullFrame.tsx`),
  meta.json `recreate` {sourceSeconds, scenes, palette, konu, mesaj, tarz, fallback}, `benzer_dokum.txt` (referansın zaman damgalı dökümü,
  ekranda okunan yazılar, konu/mesaj/tarz, neler korundu/değişti, yeni seslendirme ve her sahnenin çizimi). Sonuç `recreate`, `plan` {recreate,
  label, intro, outro, scenes, fallbackScenes, transcriptFile, refText (ilk 300 karakter), konu, mesaj, speechLang}.
  Panel/WhatsApp: ilk yanıt "🎨 Başladı: video izleniyor, kelimeleri çıkarılıp benzeri sıfırdan çiziliyor. Bitince video gelecek." (kısa mesaj
  modu; kapalıyken ayrıntılı), 🎨 log satırları anında panele; "🎨 *Sıfırdan üretildi*: N sahne çizildi" + konu, mesaj, "📝 Videodan
  çıkarılan: …" (ilk 200 karakter), neler korundu/değişti, sahneler ve seslendirme (kısa mod kapalıyken); yedek çizime düşen sahne kısa modda
  da tek "⚠️" satırı. `startAnlik(…, {info {kind video, label plan || HİKÂYE, intro, outro, breaking false}, recreate: true})` → süre sınırı 90
  sn (diğerlerinde 60), env `RECREATE=1` → assemble meta `recreated` (asayiş zorlaması yok: "yılan fareleri avladı" polis kartı ve #asayiş
  almaz) → Remotion `episode.recreated`: kancada son dakika sesi yerine kategori sesi, kapanış sloganı "HER GÜN / YENİ BİR VİDEO";
  `build_caption` başlığı "🎨 HİKÂYE: …" (🔴 değil; uzun başlık kanal adı ve #Shorts sığacak şekilde kısalır), #sondakika, #haber (kanalın ortak
  etiketlerinden de) ve haber değeri etiketleri yok, kapanış "Yeni hikâyeler ve kısa anlatımlar için takip et, abone ol.", linkte en alttaki
  satır "Kaynak" değil "İlham alınan video: YouTube / @hesap"; YouTube'da "· Son Dakika" listesine girmez. Yayın onaylı (userVideo), en çok
  izlenen saat tekrarına girmez. Telif: görüntü/ses/metin kopyalanmaz ama hikâye fikri başkasınındır; kanal sahibine söylenmeli.
  Sandbox'ta denendi: 52 olumlu + 44 olumsuz tanıma örneği, 5.096 talimatta Python/JS aynı sonuç; sanitize 114 denetim (zararlı öğe/öznitelik,
  bozuk XML, &nbsp;, entity bombası, 20.000 öğe, 5.000 derinlik, 40 çocuk → 24 grup, tek dış `<g>`); sahte Claude ve sahte çizici ile wa_video
  durumları (bozuk SVG, çizim hatası, kanca yok, uzun seslendirme, bozuk palet, etiketler, iki video, ayar kapalı, Claude hatası/çöp yanıt,
  YouTube altyazılı link + "45 saniye"); recreate olmayan 7 iş (sosyal medya, WhatsApp, sesli, fragman, sesi kapalı, iki video, "haber yap")
  HEAD ile bayt bayt aynı; panel kopyasında 16 yönlendirme durumu; SvgScene'de 6 sahne (zararlı SVG dahil; aynı iş iki kez: ortalama PSNR 49,6
  dB). Uçtan uca (gerçek referans: 66,8 sn 360x640 sepya yılan-fare kıssası, müzikli, konuşmasız): 22 sahne geçişi, 16 kare, 4 yazı karesi,
  hedef 67 sn → sahte Claude'un elle yazılmış 5 sepya SVG sahnesi (yılan ve fareler, yuva, ay evreleri + azalan grafik, balonlu fareler, el
  ele insanlar; biri tek dış `<g>` içinde, ikinci denemede biri bozuk → sade yedek) GERÇEK `render_scenes.mjs` + `SvgScene` ile çizildi →
  `TEMPLATE_DIR=… ANLIK=1 RECREATE=1 INFO_LABEL=HİKÂYE INFO_BREAKING=0 USER_VIDEO=1 TTS_ENGINE=silent bash pipeline.sh` (yayın adımı kapalı
  kopyada) → 1080x1920 mp4; karelerde kancada çizim + "YILAN NEDEN KORKMADI?", intro'da HİKÂYE etiketi, sahnelerde sırayla beliren çizim +
  FullFrame çerçevesi/altyazı/numaralı başlık, kapanışta "HER GÜN / YENİ BİR VİDEO"; build_caption/caption_tags/oynatma listesi yukarıdaki
  gibi. Bu denemede bulunup düzeltilenler: tek dış `<g>`li çizimde (sanitize rN'leri içeriye koyar) eski `.ss-art > svg > .rN` seçicisi hiçbir
  grubu bulmuyordu, çizimin tamamı ilk karede görünüyordu; sessiz seste bile 1. sahnenin bölümü (11,95 sn) klipten (11,88 sn) uzundu ve son
  karelerde boş kâğıt göründü (`hold` eklendi; ikinci denemede bütün klipler bölümlerden uzun, bölüm sonunda çizim tam); sade yedek sahnenin
  tepeleri başlığın altında kalıyor ve paletteki kırmızıyla boyanıyordu; istemde yerleşim (altyazı/başlık/kanca başlığı) ve çarpma karışımı
  notu. DENENMEDİ: gerçek Claude'un videoyu izleyip ürettiği SVG'lerin kalitesi ve kareleri okuması, Mac'te konuşma tanıma (mlx-whisper) ile
  konuşmalı referansın dökümü, gerçek seslendirme hızında sahne/bölüm uyumu, gerçek WhatsApp/YouTube/Instagram indirmesi: ilk gerçek işte
  `benzer_dokum.txt`'ye ve sahnelere bakın; çizimler zayıfsa `prompts/benzer.md` ÇİZİM bölümünü sıkılaştırın.
  İnceleme düzeltmeleri (19 Ekim) sandbox'ta önce/sonra denendi: 127.0.0.1'deki sunucu ve gerçek `render_scenes.mjs` ile temizlenmiş 12 saldırı
  sahnesi 12 dış kaynağı (kök image-set sahneyi kırmızıya boyuyordu), temizlenmemiş 15 sahne (yalnız JS katmanı) 20 kaynağı indiriyordu →
  ikisinde de 0 istek; sanitize 161 denetim (yeni saldırı biçimleri, `<use>` sınırları, iç başvurular), JS katmanı 21 denetim (gerçekçi sahneler
  bayt bayt aynı); 6 gerçekçi sahnenin sanitize çıktısı aynı, eski/yeni çizim PSNR 44-49 dB (gözle aynı: degrade, kırpma, `<use>`, süzgeç,
  yazı); 240 karelik `<use>` bombası 120 sn'de kesildi, ardındaki sahne çizildi; 96 olumlu + 102 olumsuz tanıma örneği (bulgulardaki 19 söyleyiş
  ve 14 haber talimatı dahil) doğru, 43.745 talimatlık derlemde (eski derlemler, 12.000 üretilmiş birleşim, 6.000 zor yazım: büyük/harfsiz,
  ayrık İ, \ufeff, \x85, \u2028…) Python/JS benzer video, tür ve haber isteği birebir aynı (ayrık İ düzeltmesinden önce 28 + 13 fark);
  CLAUDE.md/istem/yardım cümlelerinden yalnız gerçek benzer video örnekleri sayıldı; liste/sözlük kategori ve bozuk başlık/önem çizimden önce
  düzlendi; `fit_words` dersi/soruyu koruyor; panel kopyasında 41 durum (önceki 30 aynı; haber talimatları HEAD gibi); 15 wa_video işi (sosyal
  medya, WhatsApp, sesli, fragman, tür etiketli, çerçeveli, "sıfırdan kuruyor, haber yap"…) HEAD ile iş klasörü, istem ve Claude argümanlarında
  aynı ("sıfırdan kuruyor" işi önceki ağaçta benzer videoya gidiyordu); 4.044 açıklama/etiket varyantı aynı, benzer videoda #haber yok; gerçek
  çizicili uçtan uca "videodaki gibi yap, 40 saniye" işi 6 sahne çizdi. Önce kesinlik tanıması (inceleme, 19 Ekim): etiketli dosyada (tür
  bölümündeki 783 satır) 178 olumlu ve 605 olumsuz benzer video kararı doğru (bulgulardaki 19 söyleyiş, incelemelerdeki bütün yanlış
  tetikler, 85 gerçek haber altyazısı dahil); yönlendirme işlerinde "Esnaf sıfırdan başladı…", "tekneleri sıfırdan yapıp satıyor, haber
  yap", "Togg'un benzerini…", "benzerini yapmanı istemem, haber yap" HEAD gibi haber montajına, "bunun gibisini yap", "buna benzer bi video
  yap", "bundan esinlenerek bir video yap" benzer videoya gidiyor; `fit_words` 5 denetim geçti (ders sondan bir önceki cümleyken son sahne
  değişmiyor; yalnız son sahne kısalabiliyorsa ilk ve son iki cümle kalıyor; önceki kod 4'ünde dersi ya da ilk cümleyi siliyordu).
- Uzun video özeti (kullanıcı isteği, 19 Ekim: "uzun bir YouTube videosu göndersem bunu analiz edip 40 saniyelik habere dökebilir miyiz,
  videodan çarpıcı sahneleri de alarak"; `scripts/social_video.py wants_summary/download_sections`, `scripts/wa_video.py summary_prepare`,
  `prompts/ozet_secim.md` + `prompts/ozet.md`, `settings.longSummary` {enabled true, auto true, duration 40, minSeconds 600, maxSoundSeconds 8,
  maxSeconds 10800}; `common.summary_cfg()` — nesne değilse varsayılan, false → kapalı, bozuk/0 sayı varsayılan (maxSoundSeconds 0 = alıntı
  yok) —, `server.js longSummaryCfg()` ve panel aynı kural). Karar (`wants_summary`): talimatta özet isteği (`SUMMARY_ASK`: özet/özetle,
  analiz, çarpıcı sahne/an, en önemli/çarpıcı yer/an/sahne, öne çıkan; 90 sn üstü her platform, WhatsApp videosu dahil) ya da kendiliğinden
  (yalnız YouTube, `minSeconds`tan — 10 dk — uzun, talimatta kendi ses/tamamı isteği `KEEP_SOUND` yoksa, başlık fragman değilse); talimatta
  fragman geçerse fragman yolu; zaman yazılmışsa ("12:30'dan itibaren", t=) ya da klip/canlı yayında eski yol (bölüm + kendi sesi). Uzun
  YouTube videosu (> social.maxSeconds 600): eski 4 dk'lık bölüm yerine videonun TAMAMI analiz için düşük çözünürlükte iner (`PROXY_FMT`
  ≤360p, H.264 önce, mkv, mp4'e çevrilmez, en çok 25 dk), tüm altyazı `work/wa_inbox/<ad>.captions.json` (`social.captionsFile`; 600 satır
  sınırı yok); `longSummary.maxSeconds` (3 saat) üstü Türkçe hata (zaman yazarak bölüm istenir). `social`: summary, summaryProxy, summaryReason,
  sourceDuration, note. 600 sn'den kısa videoda tamamı HD iner, `summary` işareti eklenir. Panel (`socialVideoNews`): social_video.py 30 dk
  sınırla ve ilerleme satırları anında loga (`runLines`); WhatsApp'a tek satır "🔎 Uzun video (25 dk): tamamı inceleniyor; en çarpıcı anlarıyla
  40 saniyelik haber hazırlanacak. Belirli bir bölümden haber için…"; fragman kararından ÖNCE `runVideoNews({summary, summaryProxy})` →
  wa_video.py 60 dk sınırla (satırlar anında). wa_video.py `summary` (job.summary ya da sosyal olmayan tek videoda `wants_summary`):
  1. aşama (`summary_prepare`, video ≤240 sn ise atlanır): döküm = altyazı (yoksa konuşma tanıma videonun tamamında, dil kendiliğinden), tüm
  sahne geçişleri (`scenes(…, 100000)`), çekimlere hizalı 48 genel kare (16'lık 3 çizelge, `overview_sheets`), dakika başına sahne geçişi
  (`kesim_yogunlugu`), döküm "[12:30] …" paragrafları (≤25 sn; 14.000 kelimeyi aşarsa her paragraf orantılı kısalır) → Claude (`ozet_secim.md`,
  kullanım türü "ozet", Read aracıyla kareler; olmazsa resimsiz bir kez): uygun/neden, video türü, konu, ana haber, kaynaklı önemli bilgiler,
  5-8 an {start, end, tur kanca|olay|alinti|bilgi, onem 1-5, neden, alinti}. `pick_sections`: geçersiz/2 sn'den kısa an atılır, tek an ≤30 sn,
  toplam ≤180 sn (önce kanca, sonra önem), 1 sn pay, 3 sn'den yakın anlar birleşir, en çok 8 bölüm. Bölümler `download_sections` ile HD (tek
  yt-dlp çağrısı, her aralık `--download-sections` + `--force-keyframes-at-cuts`, şablon `<etiket>-%(section_start)d`; yarım inen bölüm yok
  sayılır); inmeyen bölüm analiz kopyasından kesilir (log + WhatsApp "⚠️ N an YouTube'dan HD inmedi…"); tam inen videoda ve WhatsApp videosunda
  kaynaktan kesilir (`summary_cut_local`, yeniden kodlanır). 2. aşama: her an ayrı video (en çok 8; normal işteki 4 sınırı girdide), her birinde
  konuşma tanıma (dil kendiliğinden), yoksa videonun tamamının dökümünden o anın satırları; çekimlere hizalı 8 kare (anı seçilmeyen kısa videoda
  16), blokta `kaynak_zamani`, `an` (tür/neden/alıntı), `konusma_dili` → `ozet.md` (girdide analiz, kaynak_video, ilgili_haberler; konuşmalı
  sesli an varsa `alinti_izni` {en_fazla_saniye 8}): kanca + 2-4 haber segmenti, hızlı kesim (1,5-3 sn), en çok BİR kısa sesli alıntı (Claude
  eklemezse zorlanmaz; bütçeyi aşan tek parçada `trailer_sound_clips`/`sound_window` ile bütün cümle penceresi; talimat "sesi kapat" derse —
  `NO_BITE`; NO_SOUND'daki "özetle" sayılmaz — alıntı yok), kaynak videoda geçmez. Geçersiz parçanın yedeği önce planın hiç kullanmadığı, sonra
  en az kullanılmış an (`clean_clips(spread=…)`). Etiket `summary_label` (ÖZET varsayılan; SON DAKİKA, AÇIKLAMA, RÖPORTAJ, MAÇ ÖZETİ, ÖZEL HABER;
  ASCII yazım düzelir, ≤20 karakter), giriş "Kısa özet." (SON DAKİKA'da "Son dakika."), `breaking` ve SON DAKİKA kartı yalnız SON DAKİKA etiketinde
  (panel `INFO_BREAKING=0`). İş klasörüne `ozet_analiz.txt` (analiz, seçilen anlar uzun videodaki saatleriyle, seslendirme, videonun tamamının
  dökümü), meta.json `summary` {sourceSeconds, sections, konu}; sonuç `summary`, `sourceSeconds`, plan {summary, intro, konu, unsuitable, moments,
  lowres, transcriptSource, analysisFile}. Analiz kopyası, altyazı dosyası ve HD anlar iş bitince silinir (başarısız olsa da; `TRASH`). Panel:
  `startAnlik(…, {summary})` → env `SUMMARY=1` → assemble meta `summary` → Remotion intro'da SON DAKİKA yerine etiket (`episode.summary`,
  `Intro.tsx`), `build_caption` başlığı "📺 ÖZET: …" (SON DAKİKA etiketinde eskisi gibi "🔴"), #sondakika ne eklenir ne kanal ortak etiketlerinden
  gelir (`calm_tags`; `caption_tags` aynı), YouTube'da "· Son Dakika" listesine girmez (`playlist_names`). "Özet kurgusu hazır" mesajı (kısa
  mesaj modu kapalıyken) konuyu ve seçilen anları yazar; habere uygun değilse (`uygun: false`) kısa modda da tek satır uyarı. Yayın onaylı
  (userVideo). Panel 📡 grubunda "📺 Uzun video özeti" anahtarı + süre (20-60) + "… dakikadan uzun YouTube videosunu kendiliğinden özetle"
  anahtarı + dakika (3-60); yardım listesinde. Sandbox'ta denendi (ağ yok): sentetik 25 dk 720p video + düşük çözünürlüklü kopyası, sahte YouTube
  altyazısı, sahte yt-dlp (bilgi/altyazı, analiz kopyası, `--download-sections`), sahte iki aşamalı Claude: an birleştirme/kısaltma/sona taşma,
  5 an HD, alıntı 8 sn bütçede bütün cümle (6,8-10,8 sn), HD hiç inmedi / yarısı indi (analiz kopyasından), altyazı yok + konuşma tanıma yok
  (alıntı yok), bozuk JSON (hata, analiz kopyası silindi), uygun değil uyarısı, 400 sn + "özetle" (yerel kesim), 200 sn (an seçimi yok), zaman
  yazılmış ve "orijinal sesiyle" (eski bölüm yolu), 4 saat (hata), 8 dk talimatsız (eski yol), WhatsApp videosu + "özetle"; panel kopyasında link
  → social_video → wa_video → startAnlik (sahte pipeline: SUMMARY=1, INFO_LABEL ÖZET, INFO_INTRO "Kısa özet.", INFO_BREAKING 0, "30 saniye" →
  DURATION 30), assemble + build_caption + playlist_names. Özet olmayan 6 wa_video işi (sosyal medya tam ses, sesi kapalı, WhatsApp, iki video,
  sesli, fragman) HEAD ile: istem, Claude argümanları, log ve iş klasörü bayt bayt aynı. Gerçek YouTube indirmesi (analiz kopyası boyutu,
  `--download-sections` hızı, bot doğrulaması), uzun videoda konuşma tanıma süresi ve Claude'un 48 kareyi okuması DENENMEDİ.
  İnceleme düzeltmeleri (19 Ekim): fragman başlıklı YouTube linki "analiz et" / "özetle" dense de fragman analizine gider (fragman analizi
  açık ve başlıktan tanıma açıkken, açık haber isteği yoksa; `wants_summary` + server.js savunması: özet yalnız uzun videonun analiz kopyası
  indiyse kalır). Kendi ses isteği olumsuzuyla ayrılır (`keep_sound`: "sesi kapat", "orijinal ses olmasın", "kendi sesini kullanma",
  "videonun sesi gelmesin", "sessiz", "yalnız seslendirme" kendi ses isteği DEĞİL; "ses" sözcüğü bitmeli — "kendi seslendirmenle" değil —;
  "tamamı/baştan sona" yalnız paylaş/oynat/yayınla ile). Talimat Türkçe harfsiz yazımla da tanınır (`_fold`: "ozetle", "carpici sahneler";
  İngilizce summarize/summary/highlights/recap); sıra fragman → açık özet → kendi ses → genel sözler (analiz, en önemli an, öne çıkan) →
  kendiliğinden. Geçersiz sesli parça başka görüntüyle doldurulmaz: özet ve fragmanda geçerli parçası kalmayan sesli bölüm atılır
  (`clean_clips(fallback=False)`), özette tek sesli bölüm kalır; uzun videonun saniyesiyle yazılmış parça anın kendi saniyesine çevrilir
  (`local_clips`), numarası doğru ama saniyesi geçersiz parça önce aynı anın içinden doldurulur. 1. aşama dökümü satır başına zaman
  damgalı ("[12:30.5] …", cümle sonunda ya da en çok 8 sn'de bir; `dokum_lines`), bütçe aşılırsa satırlar EŞİT aralıkla atılır ve girdiye
  `dokum_seyreltildi` yazılır (eskiden 25 sn'lik paragrafların sonu kesiliyordu); alıntı anı döküm satırlarına oturtulur (`quote_span`,
  ±60 sn içinde alıntı kelimelerinin %60'ı, 2 sn pay). 2. aşamada her anın `an` bilgisine bölüm içindeki start/end eklenir (birleşmiş
  bölümde kanca/alıntının yeri). Konuşma dili altyazı yoksa videonun %40'ındaki 30 sn'lik örnekten algılanır (`detect_lang`; ilk 30 sn
  çoğu zaman jenerik/müzik), anlar da o dille (ya da altyazı diliyle) yazıya dökülür. Panel süre aşımında (SIGTERM) analiz kopyası,
  altyazı dosyası, HD bölümler (yarım/reddedilmiş/.part dahil, `TRASH_GLOBS`) ve analiz klasörü silinir (`_stop` → 143, `finally`).
  Özet süresi kaynak videonun uzunluğunu ("45 dakikalık programı özetle") süre saymaz (`summary_secs`: önce saniye, kaynak adını niteleyen
  dakika değil). Paylaşım hazırlanırken WhatsApp'tan gelen yeni link sıraya girer (`socialQueue`, en çok 5, 3 saat; "⏳ Sıraya alındı";
  ⏸ durdurma sırayı boşaltır; güncelleme sıra bitmeden yeniden başlatmaz); eskiden "Başladı" yanıtından sonra sessizce kayboluyordu.
  `runLines` çıktıyı utf8 akışıyla okur (parça sınırında bölünen Türkçe harf � olmasın). Sandbox'ta önce/sonra denendi (sahte yt-dlp,
  iki aşamalı sahte Claude, sahte konuşma tanıma): fragman başlığı + "analiz et/özetle", 22 ses talimatı, harfsiz/İngilizce tetikleyiciler,
  uzun video saniyeli/geçersiz/çift sesli parçalar, 3 saatlik altyazıda seyreltme, alıntı oturtma, dil algılama, SIGTERM temizliği; özet
  olmayan 6 iş eski kodla aynı.
- Planlı yayın (kullanıcı isteği, 14 Ekim: "WhatsApp'tan haber linki gönderdiğimde saatini de yazayım, bunu şu saatte paylaş;
  saat yazmazsam direkt paylaşsın"): `app/when.js parseWhen` Türkçe saat ifadelerini çözer ("18:30'da", "18.30 da", "saat 8'de" —
  dönemsizse bugünün en yakın gelecekteki 08:00/20:00'ı —, "akşam 9", "sabah 9", "öğlen 12", "öğleden sonra 4", "gece 1", "yarın 10:00",
  "20 dakika sonra", "2 saat sonra", "yarım saat sonra"; geçmişte kalan saat yarına; "dolar 12.50" gibi noktalı sayı yalnız ek ya da yayın
  fiiliyle saat sayılır). `commands.js` linkli mesajda (haber linki → `anlik`, sosyal medya → `social_video`) `publishAt` (ISO) ekler;
  WhatsApp videosunun açıklaması/talimatı da çözülür (`waVideoIn/waVideoText`). `startAnlik({publishAt})` → env `PUBLISH_AT` → meta
  `publishAt`. Video HEMEN üretilir; `post_pipeline` saat ≥1 dk ilerideyse yayınlamaz, `targets`'ı hiç çalıştırmaz, bağlı TÜM hesapları
  (kullanıcının açık talimatı: YouTube değer kuralı ve görüntü onayı aranmaz) `data/scheduled_publish.json`a yazar ("⏰ planlı yayın: …"),
  son JSON satırında `scheduled`. Panel dakikada bir: saati gelen → `execAction publish` + WhatsApp "⏰ Planlı yayın yapıldı" (15 dk'dan
  geç ise "gecikmeli"); 12 saatten fazla geciktiyse (Mac kapalı/uykuda) yayınlamaz, sorar. `notifyVideo` planlı videoda onay istemez,
  "⏰ Planlı yayın: bugün 18:30 → …" yazar. Komutlar "planlı yayınlar" / "planlı yayını iptal et" / "planlı yayını şimdi yayınla"
  (`scheduled` eylemi; genel "iptal" kuralından önce), `GET /api/scheduled`. Mac uykudaysa yayın uyanınca yapılır.
- WhatsApp bağlantı bekçisi (kullanıcı isteği: "bağlantım düzenli kontrol edilsin, kopma varsa yeniden bağlansın"): `wa.watchdog()`
  panelden 2 dk'da bir (`whatsapp.enabled`): kopuksa (kullanıcı "durdur" demediyse, oturum varsa) yeniden bağlanır (eski 8 denemelik
  sınır bekçiyle sıfırlanır); 3 dk'dan uzun "bağlanıyor"da soket yenilenir; bağlı görünürken `sock.onWhatsApp` sorgusu (20 sn), 2 kez üst
  üste yanıtsızsa bağlantı yeniden kurulur. Her soket yalnız kendi `connection.update` olaylarını işler (`me !== sock` — eski soketin geç
  kapanma olayı yeni bağlantıyı silmesin). Kopukken `send()` mesajı kuyruğa alır (en çok 30, 12 saat), bağlanınca/başarılı kontrolde
  gönderilir; `notifyVideo` kopukken kısa metin bildirimini kuyruğa koyar. 30 dk'da 5'ten fazla kopma ya da QR beklemesi → sağlık uyarısı.
  `status()` lastOkAt, reconnects, outbox.
- Mynet manşet takibi (`scripts/mynet_watch.py`, `settings.mynet` {enabled, url, count 6, intervalMin 30,
  maxPerDay 3, duration 30}): panel her `intervalMin` dakikada `--check` çalıştırır; manşet bloğu sınıf adına
  bağlı değil (manset/slider/swiper/carousel/headline atası, yoksa görselli ilk haber linkleri; haber linki =
  aynı site + sonu ≥8 haneli sayı). İlk çalıştırma mevcutları "görüldü" sayar (video üretmez). Yeni giren haber →
  `--article` (JSON-LD articleBody → paragraflar → og:description) → `startAnlik(metin, {source: "Mynet", url})`
  → `ANLIK_SOURCE/ANLIK_URL`: prompt kaynağa dayandırır ve KENDİ cümleleriyle yazar, kanca + ilk kart kaynağı
  Mynet, fotoğraf/video o haber sayfasından, açıklamada "Haber kaynağı: Mynet · link". Günlük otomatik sınır
  `maxPerDay` (sıradan manşet 3; değerli `valuableMaxPerDay` 15, son dakika adaylarında da değerli ayrı sınır 15, sıradan 4);
  elle "Video üret" sınırsız ama aynı haber günde bir kez.
  Durum `data/mynet_state.json` (görülenler 7 gün), üretilenler `data/mynet_produced.json`. Panel kartı:
  6 manşet, her biri için "🎬 Video üret", "hepsi için üret", "şimdi kontrol et", aç/kapat.
- Çoklu son dakika takibi (`scripts/breaking_watch.py`, `settings.breaking` {enabled, intervalMin 15, perSource 8,
  minSources 3, maxPerDay 4, duration 30, sources [{name, url}]}): Hürriyet, Sözcü, NTV, AA, Habertürk son dakika
  RSS'leri (adresler ayardan değişir; ulaşılamayan kaynak panelde ❌ ve logda görünür). Yeni haber (ilk taramada
  mevcutlar "görüldü", 3 saatten eski yayın sayılmaz) → aynı olayı veren siteler `same_event()` (5 harflik kökler,
  ≥4 ortak ya da ≥2 ortak + Jaccard ≥ 0.34) ile birleşir, Mynet manşeti de sayıma girer. Aday: değerli (news_value)
  ya da ≥ minSources sitede. Videosu üretilmiş haber aday olmaz ("Üretilen haber hafızası": başlık + özet + adres; --check
  yalnız adres eşleşmesini ve bağlantısız haberi eler — `dups` ile loga "🗞 son dakika: "…" (kaynak) atlandı — bu haber N önce
  üretildi (video)" —, başlık/özet eşleşmesi adayda `dup` kalır), aday sayfası okununca (`mynet_watch --article` dup) gövdeyle
  karar verilir, sayfa okunamazsa --check kararı geçerli; Mynet ve sondakika.com aynı hafızayı kullanır.
  `ANLIK_SOURCE_COUNT` assemble'a gider: 3+ kaynak YouTube için değerli sayılır, açıklamaya "N kaynakta" eklenir.
  Panel kartı "🗞 SON DAKİKA KAYNAKLARI" (kaynak durumu, son haberler, şimdi kontrol et, aç/kapat), `GET /api/breaking`,
  `POST /api/breaking/check`; günlük sayaç `data/breaking_daily.json`. Son haberlerin her birinde ⭐ (değerli),
  "N sitede" ve "🎬 Video üret" düğmesi (`--list` her habere valuable/sources/produced ekler): `POST /api/breaking/produce
  {link, force}` haberi kayıttan bulur (`--item LINK`; başlık/özet istemciden alınmaz), sayfayı okur, otomatik adayla
  aynı `startAnlik` yolu (anlikAutoPublish ile bağlı hesaplara yayın, YouTube değer kuralı geçerli), `--mark` (başlık + `--url`)
  yazar. Elle üretim günlük sınırı tüketmez ve ona takılmaz; haberin videosu varsa (`--list` her habere produced + producedInfo)
  düğme "✓ Üretildi" olur, basılırsa hangi videonun ne zaman üretildiğini yazan `ask()` onayıyla `force` ile yine üretir.
- Ortak tarama (kullanıcı kararı: iki kaynak eşit aralıkla): `watchScan()` her `settings.watchIntervalMin` (varsayılan 5,
  3-60) dakikada önce Mynet'i, hemen ardından son dakika sitelerini tarar; `mynet.intervalMin`/`breaking.intervalMin`
  artık kullanılmaz (cfg'de `watchMin()` döner, kartlarda aynı sayı). Tarama sürerken `flushValuable` 3 sn'de bir bekler,
  böylece iki kaynaktan aynı anda düşen değerli haberler aynı partiye girer.
- Üretilen haber hafızası (kullanıcı isteği, 18 Ekim: "ürettiğimiz haberi tekrar yakalamayalım"; `scripts/news_memory.py`, sarmalayıcılar `breaking_watch.match_produced/already_produced/mark_produced`, `settings.dedup` {enabled true, hours 48 (6-168)}, panel Ayarlar → 📡 Otomatik içerikler "♻️ Üretilen haber hafızası" anahtarı + "N saat içinde tekrar üretmez"): otomatik yakalama (Mynet, son dakika siteleri, sondakika.com, değerli haber toplayıcısı) videosunu ürettiğimiz haberi başka sitede başka sözlerle düşse de üretmez. Kayıt `data/breaking_produced.json` (eski ad; eski {title, at} kayıtları okunur; bozuk `at` 0 sayılır, sonraki yazmada silinir). `assemble_script` HER videoda hikâye başına yazar (düzenli videoda her haber, kanca en benzer haberine katılır; anlık/şablon/sosyal medya/fragman tek kayıt; çoklu anlıkta `item` ile her haber ayrı): {at, video, kind regular|anlik|multi|video|trailer|template|mark, info, remake, title (bizim başlığımız), src (`ANLIK_TITLE` = startAnlik `opts.title`, anlik_items başlıkları, attach_images'in eşlediği RSS haberinin başlığı ve özeti — yalnız eşleşme güçlüyse (`_strong`), paylaşımın başlığı/açıklaması: wa_video iş klasörü meta.json `social`), urls (normalize: ANLIK_URL, anlik_pages, güçlü articleUrl, paylaşım adresi), words (5 harf kök: başlık + seslendirme + kaynak başlık + konu metninin ilk 600 karakteri), anchors/tanchors (özel adlar; t = başlıklardaki), places/tplaces (yer adları), nums/tnums (dikkat çekici sayılar), mk, open}. Yazılmaz: piyasa, takvim, zam/rekor alarmı, Pazar derlemesi, günün/haftanın özeti (özetler; gelişmeleri 48 saat engellemesin). 6+ deprem `open` (engellemez; eski kural). Assemble render'dan ÖNCE yazar; video çıkmadan biten üretimde (render/ses hatası, ⏸/⏹ durdurma) `pipeline.sh` cleanup bu çalıştırmanın kayıtlarını siler (`news_memory.py --drop <ad> --since <başlangıç>`, `VIDEO_OK` ffmpeg'den sonra; log "üretilen haber hafızası: video üretilmediği için bu üretimin kayıtları silindi"). Durdurmada cleanup çalışsın diye `tee` SIGTERM'i yok sayar (eskiden panelin killTree'si tee'yi öldürünce bash'in "Terminated" satırı SIGPIPE ile cleanup'ı keserdi: kilit, `.reserved` ve kayıtlar kalırdı) ve `trap 'STOPPED=1; exit 143' TERM`: durdurma "✖ üretim hata" yazmaz (eskisi gibi). Panelin `--mark başlık [--url adres] [--text metin]` çağrıları kind "mark" (video henüz yok: sıradayken ikinci kez yakalanmasın): başlık + adres + kaynağın metni (konu, ilk 1400 karakter; yalnız başlıklı işaret başka sözlerle yazılmış aynı haberin yarısını kaçırıyor, aynı bakanın başka operasyonunu da tutuyordu). İşaret `MARK_H` (3) saat sayılır (üretim düşse de haber 48 saat kilitlenmesin); assemble aynı haberin işaretini (başlığı videonun kaynak başlıklarından biri ya da adresi videonun adreslerinden biri, son 3 saat) siler, yerine zengin kayıt geçer (viral videonun kendi işareti de böylece devam haberini engellemez). İptal edilen, atlanan ya da başlatılamayan sıradaki işin işaretleri `unmarkQueued` ile silinir (⏸/⏹ `stopAll` tüm sırayı, `sondakikaUnqueue` de bunu kullanır). Saklama max(hours, 48) saat, en çok 800 kayıt; süreç içinde dosya değişmedikçe yeniden okunmaz. Eşleşme (`match` → en yeni kayıt {video, title, kind, reason, at, ago}): a) aynı adres (şema, www./m./amp./mobil., izleme parametreleri — utm_, at_, fbclid, gclid, igsh, si, ref, amp, share, feature, s, t, from, rss, source… — ve # atılır; haberin kimliği olan sorgu kalır: ?id=, WordPress ?p=, HaberID=, Facebook watch/video.php ?v=; baştaki /amp/, sondaki / ve /amp, Google AMP önbelleği *.cdn.ampproject.org/c/s/… asıl adrese; youtu.be/ID, shorts, embed, live → watch?v=ID; Instagram reel/p/tv aynı gönderi; ana sayfa ve video kimliksiz YouTube adresi adres sayılmaz); b) eski `same_event` başlık kuralı (kayıt başlığı ve kaynak başlıklarıyla) + veto + konu farkı yok (iki başlığın ilk içerik sözcüğü karşı haberde hiç geçmiyorsa farklı: "Konut satışları eylülde yüzde 12 arttı" ↔ "Otomobil satışları…"); c) içerik: aday başlık + metnin ilk 600 karakteri; ortak özel ad ya da dikkat çekici sayı ŞART, sonra ≥ `N_COMMON` (3) özel ad dışı ortak kök + başlık kapsaması ≥ `T_COVER` (0,5; özel adlar hariç: aday başlığının ya da kayıt başlıklarından birinin yarısı karşı haberde) ya da ≥3 ortak özel ad + aynı dikkat çekici sayı (maç skoru, deprem büyüklüğü); ikisinde de örtüşme katsayısı ≥ `T_OVERLAP` (0,2). Veto (b ve c): iki başlıkta da karşıda hiç geçmeyen özel ad (Manisa ↔ Malatya, Konyaspor ↔ Kasımpaşa) ya da bir başlıkta karşıda olmayan ad + karşı metinde bunda olmayan ≥2 ad (aynı bakanın iki operasyonu); yer: kaydın başlığındaki yer (bulunma/ayrılma ekli özel ad — Kadıköy'de, Dilovası'nda, Silvan'dan — ya da "Bismil ilçesinde/mahallesinde/köyünde") adayda hiç yok VE adayın başlık ya da girişindeki yer kayıtta hiç yok (il düzeyindeki başlıkta ayırt eden ilçe çoğunlukla yalnız girişte: "Diyarbakır'da silahlı kavga" + "Bismil ilçesinde" ↔ Silvan'daki kayıt; çok sözcüklü adın genel son sözcüğü — Hastanesi'nde, Mahallesi'nde, Havalimanı'nda… `PLACE_STOP` — yer sayılmaz; yer alanı olmayan kayıtta veto yok); iki başlıkta da karşıda olmayan akaryakıt/fatura kalemi (`FUEL`: benzin ↔ motorin, elektrik ↔ doğalgaz; "Benzine 1 lira 25 kuruş zam" ↔ "Motorine 1 lira 25 kuruş zam"); başlıktaki skor / ondalık (deprem ±0,2) / oran / ≥10 sayı / birimli sayı ("5 katlı" ↔ "3 katlı") karşı haberde yok ve karşı başlığınki de bunda yok; saatler 30 dk'dan fazla ayrı; yeni başlıkta kayıtta olmayan durum (`DEV`: tutuklandı, serbest bırakıldı, adli kontrol, taburcu, beraat, iddianame — "Muhittin Böcek tutuklandı" ↔ "Muhittin Böcek'e gözaltı" yeni gelişme, 48 saatlik pencere gözaltı-tutuklama arasını kapsıyor) ya da "artçı, ikinci, yeniden, yine, bir kez daha, bir X daha, bu kez, yeni <deprem/yangın/zam/saldırı…>". Metin hazırlığı: kısaltmalar seslendirmedeki gibi açılır (`assemble_script.expand_abbr`: TCMB → Merkez Bankası, AFAD…), Türkçe küçük harf, kesme işaretinden sonraki ek içerik kökü sayılmaz ("Malatya'daki" → malat; eskiden "daki/deki" ortak kök ve viral `new_info`'da yeni bilgi sayılıyordu), "4,8" = "4.8", "4 bin" = "4.000" = 4000, "22 bin 104" = 22.104, "on sekiz" = 18, "1 lira 25 kuruş" = 1,25, "vefat etti" = "hayatını kaybetti" = "yaşamını yitirdi"; genel haber kökleri (açıkladı, yaralı, ilçe, bakan…) sayılmaz. Özel ad: kesme işaretli ek her zaman; cümle ortasında büyük harf; cümle başında yalnız il/kulüp/sık ad listesi (`GAZ`) ya da ardından büyük harfli sözcük gelen ve metinde küçük harfle geçmeyen ("Kayıp Rojin'in" / "kayıp olan" → sıfat); tamamı büyük harfli başlıkta yalnız kesme işaretli ve listedekiler; ay/gün adları ve unvanlar değil. Yalnız başlık yetmez: genel başlık aynı ildeki başka olayı da tutar ("Konya'da yolcu otobüsü devrildi! Ölü ve yaralılar var" dünkü Ereğli kazasına benzer, bugünkü Cihanbeyli kazası); inceleme derleminde yalnız başlıkla 45 farklı haberin 10'u yanlış eşleşiyor, başlık + girişle 0. Bu yüzden panel otomatik yolda LİSTEDEN (Mynet `--check` başlık + adres, sondakika.com `--check` — HTML'den okunan haberde açıklama boş —, son dakika siteleri `--check` başlık + RSS özeti) yalnız ADRES eşleşmesinde atlar; başlık/özet eşleşmesi `dup` + `dupInfo` olarak kalır (panel rozetleri), haber sayfası okununca gövdeyle (`--article`, `with_dup`) karar verilir. `breaking_watch --check` adres eşleşmesini ve bağlantısız haberi `dups`a ayırır, başlık/özet eşleşmesini adayda `dup` ile bırakır; panel adayın sayfası okunamazsa bu karara uyar. Kalibrasyon (Türkçe derlem: 41 aynı + 41 farklı kalibrasyon, sonradan yazılmış 15+15 ve 10+10 doğrulama çifti; farklı = aynı şehir başka olay, aynı tür başka şehir, aynı takım başka maç, aynı kişi başka açıklama, aynı gün yeni gelişme): (a)+(b)+(c) 66 farklı haberde 0 yanlış eşleşme, 66 aynı haberin 58'i (%88); vetosuz eski başlık kuralı tek başına 24 yanlış eşleşme ve %38. Bağımsız inceleme derlemi (42 aynı + 45 zor farklı, kayıtlar gerçek episode_entries → dosya yolundan; 18 Ekim): başlık + giriş ile 42 aynı haberin 40'ı, yanlış eşleşme 5 → 0 (yer vetosu n06/n27/n32, kalem n14, durum n40; her biri tek başına kapatılınca yalnız kendi yanlışı geri gelir, iki derlemde de aynı haber kaybı yok). Kaçanlar: iki tarafı da yalnız başlık olan farklı sözlerle yazılmış çiftler, çok kısa genel başlıklar ("KPSS sonuçları açıklandı"), lakap ("Kanarya'dan dev transfer"), adayda ilçe adı hiç geçmeyip başka mahalle/semt adı geçen aynı haber (yer vetosu, bilerek: Esenyurt ↔ Kadıköy ile ayırt edilemez). `dedup.enabled: false` → eski davranış: 12 saat, yalnız başlık (b), adres kuralı yok, düzenli 5 saatlik videoların kayıtları sayılmaz (eskiden hafızada yalnız anlık/şablon/sosyal medya videoları ve panelin işaretleri vardı), `slim_news` hafızaya bakmaz; işaretler yine 3 saat. Tüketiciler: `mynet_watch --check` (başlık + adres; dup + dupInfo) ve `--article` (`with_dup`: başlık + açıklama + gövde + adres; sondakika `--article` de kullanır), `sondakika_watch` annotate (başlık + açıklama + adres), `breaking_watch --check` (başlık + özet + adres; elenenler `dups`), `--list/--item` (produced + producedInfo), `--count`, `slim_news` (5 saatlik seçimde used_news'a ek), `viral_watch` (aşağıda), `ig_trends --produced` (panel kartı "✓ Bu haber üretildi"). server.js: `dupCheck` (`news_memory.py --check '[{title, text, url, noMark}]'`; hata olursa engellemez), `dupWhy` → "bu haber 2 saat önce üretildi (2026-10-18-3)" (video yoksa "… önce üretime alındı"). Otomatik yolda Mynet (manşette yalnız adres, sayfa okununca gövdeyle), son dakika siteleri (aday sayfası okununca; sayfa okunamazsa --check kararı), sondakika.com (`--check`'te yalnız adres, sayfa okununca gövdeyle) ve değerli haber toplayıcısı (`flushValuable` üretimden hemen önce; atlanan habere `onStarted({ok:false})`, viral devam haberi `followUp` yeniden denetlenmez; partide aynı haberi başka sözlerle veren ikinci site `news_memory.py --group` ile birleşir: "⭐ aynı olay iki kaynakta: … tek haber sayıldı — içerik benzer (…)", `sourceCount` artar, `onStarted({merged})`; `queueValuable`'ın ikiz denetimi yalnız başlığa bakar) loga "… atlandı — bu haber … önce üretildi (…)" yazıp üretmez. Sıradaki OTOMATİK iş (`opts.auto`; çoklu işte her haber) kuyruktan çıkarken hafızaya yeniden bakar (`noMark`: işaretler — kendisi ve sıradaki diğer işler — sayılmaz; önceki üretimlerin gerçek kayıtları o anda yazılmıştır): beklerken biten 5 saatlik video aynı haberi anlattıysa "⚡ sıradaki "…" atlandı — bu haber N dk önce üretildi (…)", sondakika.com işi `sondakikaUnqueue`, diğerinin işareti silinir; çoklu işte yalnız tekrar olan haber düşer, tek haber kalırsa tek konulu anlık video; denetim sürerken üretim başladıysa iş sırada kalır (`dequeueBusy`). Elle iş, şablon (deprem/maç…), yeniden yayın ve viral devam haberi bakılmaz. Elle istekler (WhatsApp/panel "son dakika: …", haber linki, sosyal medya/YouTube linki, 🎬 Video üret, 🔁 yeniden yayın, en çok izlenen saat tekrarı) ENGELLENMEZ; link/konu araması ve Mynet/sondakika.com elle yollarında loga "not: bu haber … önce üretildi …; elle istendiği için yine üretiliyor"; son dakika kartındaki "✓ Üretildi" `ask()` ile onay ister. Panel kartlarında Mynet "✓ bu haberin videosu var (video)", sondakika.com "videosu var (video, N önce)" (listedeki başlık eşleşmesi: yalnız bilgi, üretimi engellemez). Sınama: sahte RSS/sayfa fikstürleri ve sahte iş klasörleriyle depo kopyasında (gerçek data/ dosyalarına dokunulmadı); iki bağımsız inceleme (18 Ekim) sonrası düzeltmeler sandbox'ta yeniden denendi: iki derlem (yukarıdaki sayılar), 24 adres durumu (hepsi doğru), bozuk/eski dosya ve kapalı ayar (31 denetim), sahte Mynet/sondakika/son dakika sayfalarıyla panelin gerçek kodu (listede başlık eşleşmesinde sayfa okunup başka olay üretildi, aynı haber gövdeyle atlandı, sayfası okunamayan aday --check kararıyla atlandı, kuyruktan çıkarken 5 saatlik videonun haberi atlandı ve yeni haber kendi işaretine takılmadı, işaret silme, partide birleşme), sahte npx ile gerçek `pipeline.sh` (render hatası ve SIGTERM durdurmada kayıtlar silindi, kilit ve `.reserved` temizlendi; video çıkınca kaldı), viral devam süzgeci. Gerçek sitelerde DENENMEDİ.
- sondakika.com takibi (kullanıcı isteği, 17 Ekim: "5 dk'da bir kontrol edelim, düşen haberleri anında son dakika olarak onaysız yayınlayalım"; `scripts/sondakika_watch.py`, `server.js sondakikaCheck/sondakikaProduce`, `settings.sondakika` {enabled true, intervalMin 5, maxPerCheck 3, maxPerDay 40, maxQueue 6, duration 30, maxAgeHours 3, url https://www.sondakika.com/, listUrl …/son-dakika/, rss [/rss/, /rss.xml, /sondakika.xml]}): Sayfa yapısı görülmeden yazıldığı için keşif katmanlı. 1) RSS/Atom: önce son çalışan akış (`source`), sonra `rss` adayları, sonra ana sayfadaki `<link rel="alternate" type="application/rss+xml|atom+xml">` denenir. Aday adres akış yerine HTML "RSS listesi" dönerse içindeki .xml/rss linkleri denenir; alt alan adları da dahildir. Bu linklerin sırası yalnız yol ve sorguya bakar (alan adındaki "sondakika" her adreste geçer): genel akış önce, ekonomi/spor/magazin gibi kategori akışları sona. Akış düzenli ifadeyle okunur; bozuk XML, CDATA, kaçmamış & ve göreli `<link>` desteklenir. Görsel enclosure, media:content, media:thumbnail ya da açıklamadaki img'den alınır; video eki ayrıca okunur. Karakter kümesi sırası başlık → XML bildirimi → meta'dır (windows-1254); 403/429/503 ya da TLS hatasındaki curl yedeği de ham baytı aynı sırayla çözer. 2) Akış yoksa önce son dakika sayfası (ulaşılamazsa sessizce atlanır), sonra ana sayfa okunur: aynı sitede sonu ≥6 haneli kimlikle biten linkler alınır. Haber, göründüğü HER son-dakika/breaking/flash/ticker/latest/news-list bloğunun üyesidir; manşet slider'ında da duran son dakika haberi listeden düşmez. Bloklar sınıf adıyla değil öğe kimliğiyle ayrılır; son dakika, spor ve "en çok okunanlar" kutularındaki aynı "news-list" karışmaz. ≥3 haberli bloklar arasında sıra güçlü ad → daha içteki → sayfada önce gelendir; bitişik "sondakika" sitenin adı olduğu için dış sarmalayıcı güçlü sayılmaz. Uygun blok yoksa sayfa sırası kullanılır. "SON DAKİKA:" öneki başlıktan atılır. Kaynak değişirse (RSS geçici düşüp ana sayfaya geçildi, başka akış adayı çalıştı, ayardan yeni adres girildi): yeni listede yeniliğe bakılan haberlerin ≥%50'si zaten görüldüyse (aynı haberler) ya da kaynak son 3 saatte kullanıldıysa (`bases` {kaynak: son kullanılma}) normal tarama yapılır; geçici RSS hatası böylece haber kaçırmaz. Aksi halde o tarama bu kaynakla ilk tarama sayılır (`sourceChanged`), sel olmasın diye. `--check` çıktısı {ok, first, sourceChanged, method, source, items, new}: ilk taramada hepsi görüldü sayılır, video üretilmez. Listenin tamamı son görülme zamanıyla görüldü sayılır; yenilik her listenin (akışın ya da her sayfanın) kendi ilk 20 haberinde aranır. Aynı partide aynı olayı veren haberler (`same_event`) tek sayılır. Her habere valuable/valueReason, sources (+Sondakika.com) ve dup/dupInfo (üretilen haber hafızası: başlık + açıklama + adres) eklenir. `--article` = `mynet_watch.article` (sayfa bir kez indirilir) + `published` + `video` + `dup`. `published`'da yalnız gün içeren tarih yok sayılır; `<time>` yedeği yalnız saatli değeri ve varsa `<article>` içindekini alır. `dup` üretimden hemen önce gövdeyle yeniden hesaplanır. `mynet_watch._meta` artık tırnaklı değerin içindeki kesme işaretinde kesmez ("Kadıköy'de 3 katlı binada yangın" tam okunur). Etiket deseni `_META_TAG`: tırnaklı değerin içindeki `<`, `>` etiketi bölmez (`content="SON DAKİKA <CANLI> …"` tam okunur), tırnaklı değer yalnız `<meta` geçemez; kaçmamış tırnaklı bozuk etiket (`content="Bakan: "Vergi…">`) eski düz bölmeyle ilk `>`'de biter ve sonraki og:title/og:image etiketlerini yutmaz (html.parser referansıyla 5000 sahte sayfalık karşılaştırmada eski sürümlere göre hiçbir alanda gerileme yok; HTML yorumu içindeki meta her sürümde okunur). `_meta_q` = `mw._meta(..., keys="property|name|itemprop")`. Hata çıktısı {ok:false, error} (çıkış 0), Türkçe ve denenen adreslerle. Durum `data/sondakika_state.json` {seen (son görülme; 7 gündür görünmeyen silinir), lastCheck, method, source, bases, items ≤20}; bozuk ya da yanlış türdeki dosya ilk tarama sayılıp yeniden yazılır. Panel: kendi zamanlayıcısı her dakika bakar ve `intervalMin` dolunca tarar (5 dk garanti); kendi busy bayrağı var. Ortak tarama (Mynet + son dakika siteleri) ile SIRAYLA çalışır: ortak tarama sürüyorsa en çok 2 dk bekler, bu tarama sürerken de ortak tarama başlamaz; aynı olay iki kez üretilmesin diye. Her YENİ haber, değerli olsun olmasın, HEMEN tek konulu anlık video olur. Üretim sonrası dinlenmedeyse `restEnd("sondakika.com'da yeni haber: …")` ile uyandırılır. Elle "⏸ Tüm sistemi durdur" (reason "elle durduruldu") sürerken yalnız değerli haber uyandırır; sıradan haber atlanır. Üretim çağrısı: `startAnlik(başlık + açıklama + gövde ≤1500, duration, {source, url, pages:[{url, source}], sourceCount, auto, title, sondakika: url})`; source og:site_name'dir, boş, uzun ya da genel "Son Dakika" ise "Sondakika.com". Başarıda `breaking_watch --mark` (başlık + `--url` + `--text` konu) çalışır ve günlük sayaca yazılır: `data/sondakika_daily.json` {gün: [{url, title, at, manual}]}. Atlanan ve loglanan durumlar ("🔴 sondakika.com: "…" atlandı — neden"): dup ("bu haber N önce üretildi (video)"; --check'te yalnız aynı adres, başlık/açıklama eşleşmesine sayfa okununca gövdeyle bakılır); günlük `maxPerDay` (elle üretimler sayılmaz); tarama başına `maxPerCheck` (en yeniler); `anlikQueue.length >= maxQueue` (bayatlamasın); yayın zamanı (sayfadaki, yoksa akıştaki) `maxAgeHours`'tan eski; aynı olay şu an üretimde, anlık sırada ya da değerli haber toplayıcısında. Son denetim `anlikBusyWith(başlık, self)` ile başlıkla başlığı karşılaştırır: toplayıcı, kuyruk girdisinde `opts.title`, yoksa konunun ilk cümlesi (`anlikTitles`), yoldaki ve kendi denetimlerini geçmiş (`firm`) haberler (`anlikInflight`, kendi kaydı hariç); çalışan iş `anlikNow`'dan okunur. Diğer siteler okunduktan sonra (allSources) yeniden denetlenir: "aynı olay bu sırada başka kaynaktan üretime alındı". Eskiden kullanılan konunun ilk 200 karakteri ilgisiz haberleri "aynı olay" sayıyordu. Haber durumları (üretildi/sırada/atlandı + neden) `data/sondakika_status.json`'da (son 100). Sıradaki haber "⏳ N. sırada" görünür, "üretildi" değil; kuyruktan başlayınca "üretildi" olur. ⏸/⏹ durdurma sırayı boşaltınca `sondakikaUnqueue` haberi "atlandı: sistem durduruldu" yapar; haber günlük kayıttan ve hafızadaki üretime alınış işaretinden (`breaking_produced.json`, kind "mark") çıkar (video yapılmadı, engellenmez). Yayın onaysızdır: `anlikAutoPublish` ile bağlı tüm hesaplara (YouTube değer kuralı post_pipeline'da). Görüntü önceliği (video → farklı fotoğraflar) `fetch_images`'ta uygulanır; burada haber sayfası `pages` olarak verilir, sayfada video varsa logda "(haber sayfasında video var)" yazar. Log 🔴: "takibi başladı: N haber kaydedildi", "yeni haber: … → video üretiliyor", "kontrol edildi (RSS): N haber, M yeni", "sıradan çıkarıldı". Elle yolda da her sonuç loglanır: "(elle): Haber sayfası okunamadı …", "bugün zaten video üretildi". Sesli bildirim: "Son dakika sitesine yeni haber düştü…". API: `GET /api/sondakika` {cfg, items (+status, produced; sıradaki haber produced sayılmaz), lastCheck, method, source, producedToday, nextCheckIn, scanning}; `POST /api/sondakika/check`; `POST /api/sondakika/produce {url, force}` (elle: sınırlara takılmaz, aynı haber günde bir kez, force ile yine). Panel Ayarlar → 📡 Otomatik içerikler başında kart: anahtar, "her N dakikada", "günde en çok", son kontrol + yöntem (RSS/ana sayfa) + sonraki kontrol + bugün üretilen, son 8 haber (⭐, saat, N sitede, durum ve düğme "🎬 Video üret" / "✓ Üretildi" / devre dışı "⏳ Sırada"; üretim `ask()` ile onaylanır) ve "🔄 Şimdi kontrol et". Komutlar (`sondakika` eylemi; anlık haber ve genel iptal/kapat kurallarından ÖNCE): "sondakika.com'u kontrol et", "sondakika takibini kapat/aç", "sondakika.com takibi açık mı?" (yalnız durum). Kural için site adı ya da tam kelime takip adı (takibi/takibini/takibine/takip/izleyicisi…) ile bir niyet (aç/kapat/kontrol/soru) birlikte gerekir. Kapat/aç fiilleri de tam kelimedir: "kapatıldı" ya da "iptal edildi" takibi kapatmaz. Açık anlık haber biçimi ("son dakika: …", "anlık haber: …") ile "son dakika takibe alınan …", "son dakika izleyicileri …" gibi konular anlık habere gider. Sitenin ana sayfa linki de takip komutudur; habere giden link anlık habere gider, "aç" denirse tarayıcıda açılır. Sandbox'tan siteye erişilemediği için sahte RSS/Atom/HTML fikstürleri, yerel sahte site ve sahte pipeline ile panelin kopyasında uçtan uca denendi (sıra ve durdurma, elle durdurmada uyandırma, ortak taramayla yarış). Gerçek sondakika.com yapısı DENENMEDİ; ilk gerçek taramada logdaki yöntemi kontrol edin.
- Instagram trend radarı (kullanıcı isteği, 18 Ekim: "bazen çok izlenen videolar oluyor, trend; onlara nasıl bir yol izleyebiliriz"; kullanıcı kararları: YALNIZ panelde gösterilir — WhatsApp mesajı yok, otomatik üretim yok —, kaynak Instagram trendleri; `scripts/ig_trends.py --scan|--list`, `server.js igTrendsScan`, `settings.igTrends` {enabled true, intervalMin 60 (15-1440), accounts [cnnturk, haberturk, trthaber, ntv, ahaber, anadoluajansi, onedio, gzt, bpthaber, tv100 — adlar çevrimdışı doğrulanamadı], hashtags [sondakika, gundem], maxAgeHours 48, minRatio 2, minViews 20000, minLikes 2000, top 15, useCookies false}; varsayılanlar `ig_trends.DEFAULTS` ve `server.js IGT_DEFAULTS`'ta aynı tutulur). Yöntem sırası: 1) resmi API YALNIZ Instagram Facebook Girişi ile bağlıysa (`instagram_token.json` `via: facebook` ya da .env IG_USER_ID + IG_ACCESS_TOKEN; `publish.ig_creds` kuralı — Instagram Girişi, yani varsayılan, başka hesapları ve hashtag'leri göstermez): graph.facebook.com Business Discovery (followers_count + son 25 gönderi; `view_count` hoşgörüyle istenir, bilinmeyen alan hatasında bir hafta istenmez — durumda `bdExtra`) ve hashtag araması `ig_hashtag_search` → `top_media` (Meta uygulamasında Instagram Public Content Access gerekir; 7 günde en çok 30 FARKLI hashtag `hashtagUses` ile sayılır, deneme öncesi yazılır; kimlikler `hashtagIds` önbellekte; taramada en çok 10 hashtag). Business Discovery'nin bulamadığı (kişisel) hesap 2. yoldan denenir; token geçersiz/izin yok/istek sınırı (1 saat dinlenir) olursa kalan hesaplar 2. yoldan. 2) girişsiz herkese açık profil: `i.instagram.com/api/v1/users/web_profile_info/?username=` (x-ig-app-id 936619743392459 + masaüstü Chrome UA), savunmacı okuma (edge_followed_by; edge_owner_to_timeline_media + edge_felix_video_timeline, kısa kodla tekilleşir; video_play_count/video_view_count büyüğü; edge_liked_by|edge_media_preview_like, gizli beğeni -1 yok sayılır; açıklama, thumbnail_src/display_url; clips → /reel/, diğeri /p/). 3) çerezli yalnız `useCookies` açıksa (varsayılan KAPALI: kanalın yayın yaptığı hesap kullanılır; panelde açarken `ask()` uyarısı): girişsiz yol engellenince (ya da duraklatılmışken) aynı istek `secrets/social_cookies.txt` ya da `settings.social.cookiesFromBrowser` (yt-dlp `extract_cookies_from_browser`, yalnız instagram.com çerezleri, sessionid şart, X-CSRFToken) ile; çerez ve token hiçbir çıktıya/dosyaya yazılmaz, Graph hata metninden `access_token=` silinir. Nazik: hesaplar arası 2-4 sn rastgele, en çok 20 hesap, ~4 dk bütçe (panel 6 dk'da keser); 401/403/429/"Please wait"/challenge/giriş sayfası → tarama durur, o yol 6 saat duraklar (`data/ig_trends_state.json` pause/pauseWhy; duraklamadayken hiç istek atılmaz), art arda 3 aynı hata → tarama durur. Hesap durumu {ok, error: bulunamadı / gizli hesap / geçersiz kullanıcı adı / taranmadı (Instagram engelledi | duraklatıldı | süre doldu | art arda hata), followers, n, method}. Puan (yalnız video/reels, yaş ≤ maxAgeHours): ölçü izlenme, yoksa beğeni (`metric`); hız = ölçü / max(yaş, 0,5 sa); kat = ölçü / hesabın diğer son videolarının (yaş sınırı yok) aynı ölçüdeki ortancası (3'ten az karşılaştırma → yok); trend = kat ≥ minRatio ve (izlenme ≥ minViews ya da beğeni ≥ minLikes), ya da `fast` = aynı ölçüde en hızlı 3 + aynı alt sınır + yaşa göre düzeltilmiş kat (ölçü/√yaş, hesabın diğer videolarının ortancasına bölünür) ≥ 1,5 (bekçi: düz "en hızlı 3" büyük hesabın sıradan taze videosunu da trend sayıyordu — sahte veride kat 0,8; bekçi yalnız hashtag öğesinde — hesap yok, karşılaştırma yok — aranmaz; aynı ölçüde 3'ten az karşılaştırma videosu olan hesabın öğesi hız kuralıyla trend OLMAZ — inceleme, 18 Ekim: çoğu fotoğraf paylaşan hesabın sıradan 3 reel'i de "hızla yükseliyor" oluyordu; listede hız sırasıyla yine görünür). Notlar: "Resmi API kullanılamıyor: <neden>" yalnız bağlantı yokken; bağlı hesap istek sınırında dinlenirken "Resmi API istek sınırı nedeniyle HH:MM'e kadar dinleniyor" ve hashtag notu "taranmadı: resmi API şu an kullanılamıyor (yukarıdaki uyarıya bakın)" (bağlantı yoksa "yalnız Facebook Girişi ile bağlı hesapta …"). Sıra trend → kat → hız; `data/ig_trends.json` {ok, at, lastTry, method (resmi|web|cerez, birleşik "resmi+web"), accounts, items ≤30 [{account (hashtag öğesinde null), url, shortcode, caption ≤300, thumb, views, likes, comments, metric, ageH, velocity, ratio, trend, fast, takenAt ms, source hesap|#etiket}], errors, notes, error, pausedUntil, pauseReason}; aynı gönderi hashtag'den de gelirse hesap kaydı kalır. Tamamen başarısız taramada {ok:false, error} (çıkış 0, Türkçe), önceki liste ve `at` korunur; hiç istek atılmadıysa (duraklama) son gerçek taramanın hesap durumları da. Yeni trendler `trendSeen` (7 gün) ile `newTrends`. Panel: kendi zamanlayıcısı her dakika bakar, intervalMin dolunca tarar (dinlenmede de — hafif —, süren taramanın üstüne asla: `igtBusy`; son deneme dosyadan okunur, panel yeniden başlayınca hemen taranmaz). Log YALNIZ: elle tarama sonucu ("📈 Instagram trendleri tarandı (herkese açık profil): N hesap, M okundu, K bulunamadı · V video, T trend 🔥" + en çok 3 hata), yeni trendler tek satır ("🔥 Instagram trendi: @hesap "…" 650 B izlenme (hesabın 10,7 katı) · …"; hız kuralıyla gelen "hızla yükseliyor"), otomatik taramada hatalar en çok 6 saatte bir; üretime alınınca "📈 Instagram trendi habere alındı: …". WhatsApp mesajı ve otomatik üretim YOK. API: `GET /api/igtrends` {cfg, at, lastTry, method, accounts, items (ilk `top`, + produced), errors, notes, error, pausedUntil, pauseReason, trailerEnabled, scanning, nextScanIn}; `POST /api/igtrends/scan`; `POST /api/igtrends/produce {url, mode: haber|fragman}` (yalnız instagram.com/reel|p|tv adresi; `waVideo.enabled` kapalıysa — social_video komutuyla aynı kural — ya da başka paylaşım indiriliyorsa reddeder) → `socialVideoNews({url, instruction: fragman ? "fragman" : "", kind: fragman ? "" : "haber"})` arka planda, istek hemen döner (Instagram linkinde fragman kendiliğinden tanınmaz: "🎬 Haber yap" açık haber isteğidir — tür "haber"; inceleme, 19 Ekim: boş talimatla Claude çok izlenen videoyu VİRAL yapabiliyordu —, "fragman" varsayılan fragman analizi); yayın onayı değişmedi (userVideo); `data/ig_trends_done.json` {url: {at, mode, state hazırlanıyor|üretildi|hata, error}} 7 gün; üretim panel sürecinde çalıştığı için açılışta kalan "hazırlanıyor" kaydı "hata" ("panel yeniden başladı, üretim yarım kaldı") yapılır — panel üretim sürerken yeniden başlarsa kart 7 gün devre dışı "⏳ Hazırlanıyor"da kalmasın, "🎬 Haber yap" geri gelsin. `GET /api/igtrends/thumb?u=` kapak vekili (Instagram CDN başka siteye gömülen resmi engelleyebilir: yalnız https cdninstagram.com/fbcdn.net, ≤3 MB resim, `work/ig_thumbs/` 3 gün). Kart "📈 INSTAGRAM TRENDLERİ" ana görünümde "🗞 SON DAKİKA KAYNAKLARI" kartının altında (içerik kaynağı kartları orada): durum satırı (son tarama, yöntem: resmi API / herkese açık profil / çerezli, sonraki tarama, duraklatıldıysa saat ve neden), hesap rozetleri (✅ @hesap · video sayısı / ❌ @hesap — bulunamadı), son tarama hatası + uyarı/not satırları, ilk 6 öğe (+ "Tümünü göster"; liste ızgarası `minmax(0,1fr)` ve açıklama `overflow-wrap:anywhere`: boşluksuz uzun hashtag dizisi satırı kartın dışına taşırmasın — 400 px'te kart 1120 px oluyordu): kapak (no-referrer → vekil → 🎬 yer tutucusu), @hesap ya da #etiket, TREND rozeti, açıklama (140), "1,2 Mn izlenme · 3 sa önce · hesabın 5,4 katı 🔥" (Türkçe B/Mn; hız kuralıyla gelen "⚡ hızla yükseliyor"), "🎬 Haber yap", açıklamada fragman/trailer/teaser geçerse (ve fragman analizi açıksa) "🎬 Fragman yap", "↗ Aç", "✓ Üretildi" / "⏳ Hazırlanıyor" / "❌ son deneme başarısız"; trendin haberi bizde üretildiyse (üretilen haber hafızası: açıklamanın ilk cümlesi başlık, devamı metin, gönderi adresi; `ig_trends.py --produced`, `GET /api/igtrends` her istekte güncel hafızayla `producedNews` {video, at, ago, reason} ekler) yeşil "✓ Bu haber üretildi" (ipucunda video ve ne zaman; "🎬 Haber yap" düğmesi kalır); üretim `ask()` ile onaylanır; katlanır "⚙ Trend ayarları" (anahtar, aralık, hesap listesi + hashtag'ler "kaydet" düğmesiyle — geçersiz ad kaydedilmez —, kat/izlenme/beğeni/yaş/liste sayısı, çerez anahtarı + sarı uyarı metni). Sandbox'ta ağ yok: web_profile_info (eksik alanlar, gizli hesap, 404, user null, 429, 400 "Please wait", giriş sayfası, 500) ve Graph (Business Discovery, bilinmeyen alan, bulunamadı, token/izin/istek sınırı, hashtag search + top_media) fikstürleriyle 117 denetim (puan ve sıra, 429'da duraklama ve sonraki taramada hiç istek atmama, çereze geçiş, çerez/token sızmaması, hashtag sınırı ve önbellek, bozuk ayar/durum dosyası), yerel sahte HTTP sunucusuyla gerçek urllib yolu (başlıklar, bekleme), panel kopyasında uçtan uca (ilk dakikada otomatik tarama, yeniden başlatmada taramama, eşzamanlı tarama engeli, sahte social_video/wa_video/pipeline ile haber → USER_VIDEO=1, fragman → TRAILER=1, indirme hatası → "hata") ve başsız Chromium'da kart (masaüstü + 400 px, ask() akışları, ayar kaydı, duraklama görünümü, JS hatası yok). Gerçek Instagram yanıtları ve varsayılan hesap adları DENENMEDİ: Instagram girişsiz isteği engelleyebilir ya da yapıyı değiştirebilir (kart duraklamayı/hatayı gösterir; Facebook Girişi ile resmi API ya da çerezli okuma seçenek); ilk gerçek taramada hesap rozetlerini ve logu kontrol edin. İnceleme düzeltmeleri (18 Ekim) sandbox'ta yeniden denendi: 103 fikstür denetimi (Business Discovery istek sınırı 4/17/32/613'te ikinci tarama notunda "None" yok, 3 videolu hesapta hız trendi yok, 4 videoluda gerçekten hızlı video yine trend), panel bloğu server.js'ten aynen çıkarılıp iki kez yüklenerek yeniden başlatma (hazırlanıyor → hata, üretildi kaydı aynı, takılı kayıt yoksa dosya yazılmaz, hatadan yeniden üretim), başsız Chromium'da boşluksuz uzun açıklamalı kart (1280 ve 400 px'te taşma yok).
- Haberin tüm kaynakları (kullanıcı kararı, 18 Ekim: "düşen haberlerin tüm sitelerden eksiksiz alınması" = aynı haberi veren tüm sitelerin bilgisi, videosu ve fotoğrafları; `server.js allSources(title, url, source)`, `settings.allSources`, varsayılan açık, `false` kapatır): tek haberli otomatik ve elle son dakika yollarının hepsi (değerli haber toplayıcısında tek haber `flushValuable`, Mynet sıradan manşet `mynetProduce`, son dakika siteleri `breakingCheck` ve `/api/breaking/produce`, sondakika.com `sondakikaProduce`) üretimden önce başlıkla `news_lookup.py --topic … --pages 8` çalıştırır (75 sn sınır): en çok 8 farklı sitenin (alan adı tekrarsız) sayfası okunur. Ana haber sayfası hep ilk sıradadır. Sayfalar `pages` → `work/anlik_pages.json` (en çok 8; assemble sonraki kartları sırayla bu sitelerden alır, `fetch_images` video ve fotoğrafı hepsinde arar), okunan metinler `related` → `work/anlik_related.json` (prompt'a ilgili haber olarak; bilgi eksiksiz olsun). Log: "🔎 aynı haber N sitede (…): bilgi, video ve fotoğraflar hepsinden toplanacak" ya da "🔎 "…" başka sitelerde bulunamadı; yalnız <kaynak> kullanılacak". `sourceCount` (YouTube değer kuralı: 3+ kaynak) DEĞİŞMEZ; okunan sayfa sayısı ona eklenmez. Haber başına en çok 75 sn gecikme ekler. 2-3 haberli çoklu anlık videoda uygulanmaz (her haber kendi sayfasıyla). Yoldaki haber (`anlikInflight`, `inflight(title, fn, {firm, sourceCount})`; kayıt {title, firm, item: {sourceCount}}): üretimine karar verilmiş ama sayfası/diğer siteleri okunan haber ne sırada ne üretimdedir. Bu sürede biten üretim sistemi dinlenmeye alıp otomatik haberi reddettirmesin diye `finishProduction` HER kaydı sıradaki iş sayar; dinlenme yalnız bu yüzden ertelendiyse nedeni `restPending`'de durur ve kayıt çıkınca (`restRecheck`: inflight'ın ve breakingCheck'in finally'si) başka iş (yoldaki, sıradaki, toplayıcıdaki, süren üretim) yoksa dinlenme şimdi başlar; haber sayfası okunamayıp düşerse sistem uyanık kalmaz. `restStart`, `restEnd` ve `startPipeline` `restPending`'i siler. Aynı olay başka kaynaktan ikinci kez başlamasın diye `anlikBusyWith` ve `queueValuable` yalnız kendi denetimlerini (okuma, tekrar, bayat, meşgul) geçmiş kayda (`firm`) yol verir ya da onunla birleşir (birleşen ikiz `item.sourceCount`'u artırır, startAnlik bunu okur); denetimde düşebilecek habere bağlanan olay kaybolmaz. flushValuable ve /api/breaking/produce kaydı baştan firm açar; Mynet sıradan manşet, son dakika siteleri sıradan aday ve sondakika.com allSources'tan hemen önce firm yapar. Kayıt startAnlik'ten hemen sonra, araya await girmeden çıkar; değerli haber toplayıcıya verilmeden önce çıkar (kendisiyle birleşmesin). Mynet sıradan manşet ve son dakika siteleri sıradan aday da artık `anlikBusyWith` ile denetlenir (allSources'tan önce ve sonra). Stub'lı panel kopyasıyla denendi: üretim biterken yoldaki haber, değerli haber yarışı, aynı olayın iki yönden birleşmesi, kendisiyle birleşmeme, sayfası okunamayan yoldaki haber. `fetch_images.same_story_pages` anlıkta `anlik_pages.json`'daki sitelerin HEPSİNİ (en çok 8) döner, ardından work/news.json'dan en uyumlu 4; videosu çıkmayan sayfa o çalışmada yeniden denenmez (`_NO_VIDEO`; kanca ve ilk haber aynı 8 siteyi iki kez yt-dlp ile taramasın).
- Değerli manşet toplayıcı (kullanıcı kararı: değerli manşet beklemeden, sistem dinlenmede olsa da üretilir): Mynet ve
  son dakika taramaları dinlenmede de çalışır (hafif). Otomatik DEĞERLİ haber (`item.valuable` / `c.valuable`) doğrudan
  üretilmez, `queueValuable()` ile 20 sn (`VALUE_BATCH_MS`) biriktirilir; aynı olay iki kaynaktan gelirse `sameEvent()`
  (5 harflik kökler, ≥3 ortak ya da ≥2 ve %50) tek haber sayılır. `flushValuable()`: dinlenmedeyse `restEnd("değerli haber
  düştü…")`, 1 haber → tek konulu `startAnlik`, 2-3 haber → `startAnlikMulti()` tek video (süre 30 + 15/ek haber: 2 → 45 sn,
  3 → 60 sn; fazlası sonraki partiye). Çoklu: `work/anlik_items.json` [{source, url, title, text}] + `ANLIK_MULTI=n`;
  `topic_news` prompt'a `coklu_haberler` koyar, `prompts/anlik.md` "ÇOKLU SON DAKİKA" kuralı her habere segment ve
  `item` numarası yazdırır, pipeline HABER ≥ n (≤ 6), `assemble` her hook/haber segmentine kendi haberinin sayfasını
  (`articleUrl`) ve kaynağını verir (`item` yoksa başlık kelimeleriyle eşler), meta `sources`, açıklamada "Haber
  kaynakları:" listesi, her haber hafızada ayrı kayıt. `flushValuable` üretimden hemen önce hafızaya yeniden bakar ve partide
  aynı haberi başka sözlerle veren siteleri birleştirir (aşağıda "Üretilen haber hafızası"). Kuyrukta `{multi}` girdisi. Dinlenmede SIRADAN manşet/aday üretilmez
  (logda "⏸ … değerli haber gelirse sistem kendiliğinden başlar").
- Günün özeti (yatay uzun video, YouTube): `GUNLUK=1 bash pipeline.sh` → `scripts/daily_news.py` bugünkü videoların
  haberleri (out/<bugün>-N.json) + günün RSS'i, aynı olay birleşir (`same_event`), sıra: değerli/son dakika →
  bugün videoda işlenmiş → kaynak sayısı → RSS önemi; haber sayfası adresleri work/news.json'a eklenir (fotoğraf/video).
  `prompts/gunluk.md` (haber başına 35-55 kelime, `settings.daily.stories` 10 haber, `duration` 240 sn),
  `assemble_script` GUNLUK: intro "Günün özeti…", `OUTRO_GUNLUK`, slotLabel "GÜNÜN ÖZETİ", timeRange 00:00–saat,
  format "gunluk" (5 saatlik sayıma ve sağlık "kaçan üretim" kontrolüne girmez). Remotion `GunlukOzet` (1920x1080,
  `src/GunlukOzet.tsx`): sinematik kanca, intro'da başlık listesi, haberde solda büyük medya + sağda başlık, yanan
  altyazı (Shorts ile aynı 3'er kelimelik grup, sola dayalı), üst bant, altta "SIRADAKİ" kayan bant; 0. kare ThumbWide ×1,5. Yayın: yalnız YouTube
  (`post_pipeline`; Reels/TikTok atlanır), `watch?v=` adresi, açıklamada YouTube bölümleri (00:00 Giriş + her haber),
  #Shorts yok, oynatma listesi "Günün Özeti (uzun)". Panel `settings.daily` {enabled, hour 21, minute 30, duration,
  stories, autoPublish} saatinde başlatır (meşgulse gün bitene kadar her dakika dener, `data/daily_last.json`),
  kart "📺 GÜNÜN ÖZETİ", `POST /api/daily/run`, komut "günün özetini üret".
- Haftanın özeti (yatay, YouTube): `GUNLUK=1 HAFTALIK=1 bash pipeline.sh` → `scripts/weekly_news.py` (son 7 günün
  out/*.json haber segmentleri, `same_event` ile birleşir, en son hali anlatılır; sıra değerli/son dakika → kaç videoda
  işlendi `c` → izlenme `i`; `g` gün adı) + `prompts/haftalik.md` (gün belirtir, gelişen olayı tek haberde toplar).
  `assemble` HAFTALIK: intro/outro haftalık, slotLabel "HAFTANIN ÖZETİ", timeRange `week_range()` ("6–12 Ekim"),
  format "haftalik". `GunlukOzet.tsx` etikete göre yazar (`isWeekly`/`longLabel`), Thumb alt yazısı "HER PAZAR HAFTANIN
  ÖZETİ". Uzun formatlar ("gunluk", "haftalik") her yerde birlikte ele alınır: yalnız YouTube, `watch?v=`, bölümlü
  açıklama, #Shorts yok, oynatma listesi "Haftanın Özeti (uzun)", 5 saatlik sayım/sağlık/analiz saatlerine girmez.
  Panel `settings.weeklySummary` {enabled, weekday 0 pazar, hour 20, minute 30, duration 300, stories 10, autoPublish}
  (`data/weekly_video_last.json`, `nextPlanned` dinlenmeyi o saatte bitirir), Günün Özeti kartında anahtar + saat +
  "Haftanın özetini şimdi üret", `POST /api/weekly-video/run`, komut "haftanın özetini üret".
- Google Trends Türkiye (`scripts/trends.py`, https://trends.google.com/trending/rss?geo=TR, 30 dk önbellek
  `data/trends.json`, ad alanı ht: etiket sonekiyle okunur): her ortak taramada ve pipeline'da yenilenir. `match()`
  aranan ifadenin tüm anlamlı kelimeleri (5 harflik kök) metinde geçmeli. `slim_news` uyan habere `t:1, tr:<ifade>`
  koyar ve p'den sonra öne alır; `prompts/senaryo.md` eşit önemde t=1'i seçtirir; `assemble.topic_hashtags` videoda
  geçen aranan ifadeyi hashtag yapar (en çok 2). Son dakika kartında "📈 Türkiye'de şu an aranan" listesi.
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
  Kendini güncelleme (kullanıcı isteği, 19 Ekim: "WhatsApp'tan güncelle yazayım, panel kendini yeniden güncellesin, güncelle butonuna basmışım
  gibi"; `server.js selfUpdate/updateCheck/restartPanel`): düğme, komut "güncelle" (`commands.js SELF_UPDATE`, YALNIZ tüm mesaj bu kalıpsa:
  güncelle, sistemi/paneli/kendini güncelle, güncelle lütfen, hemen güncelle, güncellemeleri al, son sürüme geç, update, *güncelle*;
  "izlenmeleri güncelle" sync_metrics, "kendini güncelleyebilir mi?" soru → beyin) ve beynin `command` eylemi aynı yol. WhatsApp'ta
  hızlı yol (Claude'a gitmez; `smartWhatsApp`), talimat bekleyen WhatsApp videosunun talimatı sayılmaz. "güncelleme var mı" (`update_check`)
  yalnız `git fetch` + `HEAD..@{u}` sayar, çekmez. Adımlar: git (GIT_TERMINAL_PROMPT=0, LC_ALL=C, 2 dk) `pull --ff-only` → HEAD açılıştaki
  sürümle (`BOOT_COMMIT`) aynıysa "✅ Zaten güncel" → `git diff --name-only BOOT..HEAD`'de package*.json varsa `npm install` → app/*.js
  `node --check` → başarısızsa `git reset --keep BOOT_COMMIT` (yerel değişikliği silmez; diskteki kod çalışan kodla aynı kalır, panel çökerse
  bozuk sürümle açılmasın), yeniden başlatılmaz → `data/update_last.json` {from, to, count, subjects, source, notes, notified} → yeniden başlat
  (panelde 0,8 sn; WhatsApp/beyinde 6 sn, yanıt gidebilsin). Git hataları Türkçe (`gitHint`): elle değiştirilmiş dosya (git stash), aynı adda
  izlenmeyen dosya, ayrışmış dal, izlenen dal yok, GitHub'a ulaşılamadı, giriş reddedildi, zaman aşımı. requirements.txt değiştiyse not.
  Yarım kalacak iş sürerken (`updateBusy`: üretim/kilit, anlık sırası, yoldaki ve toplayıcıdaki son dakika, paylaşım indirme ve video kurgusu
  `videoNewsN`, talimat bekleyen WhatsApp videosu, WhatsApp özeti, şablon/tekrar hazırlığı, elle yayın `pubN`, planlı yayın, hikâye, Instagram
  silme, yorum yanıtı, haber taraması) önce yeni sürüm var mı bakılır: yoksa "Zaten güncel", varsa `updatePending` → "⏳ Yeni sürüm var (N
  değişiklik) ama şu an üretim sürüyor; bitince güncelleyip panel yeniden başlayacak. Beklemeden almak için: *sistemi durdur*"; 15 sn'de bir
  bakılır, iş bitince güncellenir (çekerken üretim başladıysa `restartPending`: yeniden başlatma iş bitince), 3 saatten uzun bekleyen vazgeçilir.
  Açılışta `update_last.json` bildirilmemişse ve 3 saatten yeniyse log + (panel düğmesi dışında, WhatsApp açıksa) WhatsApp: "✅ Güncellendi,
  panel yeni sürümle açıldı (N değişiklik): <son commit konusu>" (+ elle durdurulmuşsa "*sistemi başlat*"); çalışan sürüm beklenenden farklıysa
  "⚠️". `restartPanel`: üst süreç panel.sh ise çıkış 75; elle "node app/server.js" ile açılmışsa panel.sh'ı ayrık başlatıp
  (2 sn sonra, log work/panel.log) çıkar (eskiden panel kapanır, WhatsApp'tan geri açılamazdı); `restart` eylemi ve `/api/restart` de bunu
  kullanır. Bekleyen yayın onayı (`whatsapp.js st.pending`) `data/wa_pending.json`a yazılır, yeniden başlayınca okunur (6 saatten eskisi değil):
  güncelleme/çökme sonrası "onay" kaybolmaz; diskten gelen onay `restored`: gevşek "tamam/evet/ok" (ör. "✅ Güncellendi"ye cevap) eski videoyu
  yayınlamaz, yalnız açık "onay …"/"yayınla"/"paylaş" ya da platform adı. İnceleme düzeltmeleri (19 Ekim): değişen dosyalar `git diff
  --relative` ile proje klasörüne göre (Mac'te git kökü whatsapp-server/, yollar "gundem-video/package.json" geldiği için npm install hiç
  çalışmıyordu; kökteki başka projenin package.json'u artık sayılmaz; diff başarısızsa pull çıktısındaki "package.json |" satırı); `node
  --check` sonrası `missingModules()` app/*.js'teki paket adlarını ayrı süreçte `import.meta.resolve` ile çözer (kod çalıştırmaz), eksik paket
  varsa npm install (yapılmadıysa) ve bir kez daha, yine eksikse geri alınır (yeni bağımlılık paneli ERR_MODULE_NOT_FOUND'la kapatmasın);
  `underLoop` üst süreç 1'i (launchd) döngü saymaz (terminali kapanıp sahipsiz kalan panel 75 ile çıkıp hiç geri gelmiyordu): panel.sh
  `EMIXHAS_LOOP=$$` verir, eski panel.sh için ps; `restartAfterUpdate` zamanlayıcı dolunca işi yeniden denetler (o 6 sn içinde başlayan
  üretim/istek yarıda kalmasın; yeniden başlatma sıradayken ikinci "güncelle" yeniden çekmez); `updateBusy` ek olarak süren elle istekleri
  (`counted`: prepareAnlik, remakeVideo, igCleanupRun, flushValuable — parti valueBatch'ten çıktıktan sonra da), YouTube sırası yüklemesini
  (`flushQ`), WhatsApp'a giden video/indirilen videoyu (`wa.busy()`), WhatsApp kuyruğundaki mesajları (outbox) ve 15 dk'lık Instagram "evet
  sil" onayını sayar; bekleyen (çekilmemiş) güncelleme `data/update_pending.json`a yazılır, panel beklerken yeniden başlarsa açılışta okunur (3
  saat); çekilmiş ama yeniden başlatılamamış güncellemeden 3 saatte vazgeçilmez (yeni kod diskte), bir kez "⚠️ … iş bitince yeniden başlayacak"
  denir; ipucu nedene göre ("sistemi durdur" yalnız üretim/sıra için; talimat bekleyen videoda "talimatı yazın ya da iptal"); talimat bekleyen
  WhatsApp videosu "güncelle", "sistemi durdur/başlat", "durum"u talimat saymaz; git giriş hataları (SSH "Permission denied (publickey)", host
  key) ağ hatasından önce denetlenir; komut yazımları Türkçe harfsiz ("guncelle", "güncelleme var mi"), emoji/dolgu kelimeli ("güncelle 👍",
  "hadi güncelle"), kibar ("günceller misin", "güncelleme yapar mısın") da tanınır, soru işaretli "güncelle?" yalnız bakar. Sandbox'ta (git kökü
  üst klasörde, sahte npm) denendi: yalnız gundem-video/package.json → npm install, yalnız kök package.json → yok, eksik paket import'u → npm
  install + geri alma, requirements.txt notu, bekleyen güncellemenin yeniden başlatmadan sonra iş bitince uygulanması. İLK KEZ: Mac'teki eski kod bu komutu bilmez; bir kez panelde "⬇ Güncelle"ye basılmalı (ya da
  terminalde git pull + yeniden başlatma). Sandbox'ta sahte GitHub (bare repo) + Mac kopyası + panel.sh döngüsünde denendi: güncel, yeni sürüm
  (yeniden başladı, açılış mesajı), "güncelleme var mı", üretim kilidi varken bekleme ve kilit kalkınca güncelleme, elle değiştirilmiş dosya,
  aynı adda dosya, ulaşılamayan uzak depo, bozuk yeni sürümde geri alma (yerel değişiklik korundu); bekleyen onayın diske yazılması.
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
  Spor skoru (kullanıcı isteği): aynı cümlede spor bağlamı (yendi, mağlup, berabere, maç, gol, derbi, set…) varsa "4-1" →
  "dört bir", "2-1'lik" → "iki birlik" (`tr_numbers._scores`); diğer aralıklar "3-5 derece" → "üç ile beş"; "90+3" → "doksan artı üç".
  Seslendirme öncesi `prep_text`: rakamlar yazıya (`scripts/tr_numbers.py`), BÜYÜK HARFLİ kelimeler
  normal yazıma. `speakable` (macOS `say` dahil): parti adları kelime olarak okunur (AK Parti → Ak Parti,
  DEM/İYİ/TİP Parti, HÜDA PAR; harf harf değil), kesmeden sonraki büyük ekler küçülür (PARTİ'YE → Parti'ye,
  PKK'NIN → PKK'nın). PKK/THY gibi gerçek kısaltmalar harf harf kalır. Ekranda yazım değişmez. Okunuş sözlüğü
  `PRONOUNCE` (Mynet → Maynet, PKK → Pekaka, TV → Teve — "tivi" okunmasın; ATV → Ateve, NTV → Enteve, bitişik sayı ayrılır: TV8 → Teve sekiz; `SPOKEN_AS` başka adla söylenenler — Amed SFK → "Amed Spor" (kullanıcı isteği, 17 Ekim; ek yeni ada göre yeniden kurulur: SFK'nın → Spor'un, `_reharmonize`); ekler korunur, büyük harf kısaltmada bitişik ek de: PKKlı → Pekakalı) + `settings.pronunciations` {"Kelime": "Okunuş"}; değiştirince
  `server.js` `PRON_VER`'i artır (konuşma önbelleği anahtarına girer, eski okunuşlu sesler kullanılmaz).
  Harf + rakam kodları (kullanıcı şikâyeti, 19 Ekim: "C4'ü seslendirirken 'cfour' diye seslendiriyor; seslendirmemizin tam profesyonel
  olması lazım"; `voices._codes`, `prep_text` rakam dönüşümünden ÖNCE, `speakable` de): ses modelleri bitişik harf-rakamı İngilizce
  okuyordu ("5G" bile "beşG" gidiyordu). Büyük harf kısmı (en çok 3 harf) Türkçe harf adlarıyla (`LETTER_TR`: ce, te be, iks, ge, ka…),
  rakam ayrı yazıya çevrilir: C4 / C-4 → ce dört, C4'ün → ce dördün, C4lü → ce dörtlü, TB2 → te be iki, T-129 → te yüz yirmi dokuz,
  T10X → te on iks, X5 → iks beş, G20 → ge yirmi, U17 → u on yedi, TRT1 → te re te bir, 5G → beş ge, 4K → dört ka, 3D → üç de;
  savaş uçağı F → "ef" (F-16 → ef on altı), S-300/400/500 → "es"; yerleşik okunuşlar `CODE_SAY` (F1 → Formula bir, H5N1 → ha beş en
  bir, CO2 → karbondioksit, A400M, MP3, COVID-19 → kovid on dokuz); `settings.pronunciations` ({"M4": "em dört"}) hepsinden önce gelir.
  4 harften uzun kelimeli kod ve küçük harfli adlar (iPhone 15, Mi-17) değişmez; yalnız harfli kısaltmalara (CHP, MHP) dokunulmaz.
  Ayrıca rakamdan sonra ünlüyle başlayan ekte ünsüz yumuşar (`tr_numbers.normalize_tr`: 4'ü → dördü, 4'e → dörde, 104'üncü → yüz
  dördüncü; eskiden "dörtü"). Altyazı hizalaması aynı `prep_text`i kullandığı için söylenen uzunluk uyumlu (C4 → 6 harf).
  Web adresleri ve noktalı saat (kullanıcı isteği, 20 Ekim: "haber.com ve sondakika.com'u mantıklı seslendirsin"; `voices._domains`, `prep_text`
  ve `speakable`in başında): alan adı Türkçe okunur — site adı bilinen okunuşuyla (`SITE_SAY`: sondakika → son dakika, haberturk → Habertürk,
  hurriyet → Hürriyet, cnnturk → ce en en türk, aa → a a; harfsiz kısa ad harf harf: trt → te re te; bilinmeyen ad yazıldığı gibi, rakam
  ayrı: haber7 → haber yedi), nokta "nokta", uzantı `TLD_SAY` (com → kom, tr → te re, tv → teve, gov, org, net); https://, www. ve yol
  okunmaz, ek son heceye uyar: sondakika.com'un → son dakika nokta kom'un, haber.com'da → haber nokta kom'da, aa.com.tr'ye → a a nokta kom
  nokta te re'ye; uzantısı bilinmeyen nokta (3.5, A.Ş.) değişmez; tek başına "Sondakika" → son dakika (`PRONOUNCE`);
  `settings.pronunciations`ta tam alan adı ({"sondakika.com": "Son Dakika sitesi"}) önce gelir. Noktalı saat (`tr_numbers.dot_times`;
  eskiden "saat 14.30'da" → "on dört virgül otuzda"): önünde "saat" ya da ardından zaman eki ('da, 'den, 'daki, 'a…) ya da
  itibarıyla/sularında/civarında varsa saat (0-23, dakika iki hane): "on dört otuzda"; "41.85 lira", "4.8 büyüklüğünde", "1.250 kişi"
  değişmez; `align._pairs` komşu kelimedeki bağlamı da görür. 28.428 metinlik derlemde fark yalnız alan adı, "sondakika" ve noktalı
  saatte (sürüm numarası "Node 18.20'de" de saat okunur: haber dilinde ekli noktalı sayı saattir). `PRON_VER` 7. Emixhas'ın konuşması (`speak.py`) `voice.engine` kimliğini ya da auto'da hızlı sırayı
  (ema → chatterbox → yelda → piper) kullanır; `voice.rate` EMA hızına (0.7-1.4) çevrilir.
- Isınma önlemi (kullanıcı isteği, geri alma): `reap()` üretim sürmüyorken bizim başlattığımız ağır süreçleri
  (`HEAVY`: ses modelleri, yt-dlp, kapak çizimi, Remotion ve onun Chrome'u — yalnızca node_modules/.remotion
  kopyası, kullanıcının Chrome'una dokunulmaz) kapatır: her 5 dk'da 10 dk'dan uzun yaşayanlar, üretim bitince
  hepsi. `POST /api/stopall` + panel "⏹ Hepsini durdur" + komut "her şeyi durdur / modelleri kapat" üretimi
  (panel ya da zamanlayıcı kilidi) süreç ağacıyla birlikte, anlık kuyruğu ve tüm ağır süreçleri kapatır.
  `GET /api/procs` çalışanları listeler.
- Dinlenme / "⏸ Tüm sistemi durdur" (kullanıcı isteği, ısınma): başlıkta hep görünen kırmızı düğme, `POST /api/rest {on}`
  (`/api/stopall` ve komut "sistemi/her şeyi durdur" da aynı), "sistemi başlat" komutu/düğmesi ile çıkış. `restStart()`
  üretimi, anlık sırasını ve modelleri kapatır, `data/rest.json` {on, since, reason, until, untilWhat} yazar; `until` =
  `nextPlanned()` (sıradaki launchd slotu ya da bugünkü günün özeti saati). Dinlenmedeyken OTOMATİK hiçbir şey başlamaz:
  sıradan Mynet/son dakika üretimi (`opts.auto` → reddedilir, logda "⏸ … video üretilmedi"; tarama ve değerli haber
  sürer), günün özeti, YouTube sırası, günlük rapor, ses ön ısıtması, eksik kapak (izlenme/abone senkronu sürer). Elle talimat (`startPipeline`/`startAnlik`
  `auto` olmadan: panel, WhatsApp, sesli komut, 🎬 Video üret) `restEnd()` ile uyandırır; `until` gelince ya da launchd
  üretimi başlayınca ya da değerli manşet düşünce (`flushValuable`) kendiliğinden biter. Her üretimin sonu `finishProduction()` (panel çocuğu kapanınca, zamanlayıcı
  üretiminin son JSON satırında; 30 sn tekrar engeli): sırada anlık iş yoksa ve `settings.restAfterProduction` (varsayılan
  açık, Ayarlar → Otomasyon) ise dinlenmeye geçer. Log "⏸ SİSTEM DURDURULDU (neden): …" / "▶ SİSTEM YENİDEN ÇALIŞIYOR:"
  + `STAGE_VOICE` sesli cümleleri; komut yanıtı zaten söylüyorsa `stageMute` aşama cümlesini 3 sn susturur. Panelde sarı
  "SİSTEM DURDURULDU" şeridi (ne zamandan beri, neden, sıradaki planlı iş). caffeinate (uyanık tutma) dinlenmede de sürer.
  Terminal: `npm run basla` (`scripts/basla.sh`: panel açıksa `POST /api/rest {on:false}`; kapalıysa data/rest.json'u
  "çalışıyor" yazar, panel servisi kuruluysa launchctl kickstart, değilse `scripts/panel.sh` ön planda; tarayıcıyı açar),
  `npm run durdur` (dinlenme; `-- panel` ile panel/servis de kapanır, launchd 5 saatlik zamanlayıcı yine çalışır).
  `npm run panel` dinlenme durumunu korur; açılışta hâlâ durduruluysa logda "⏸ sistem durdurulmuş durumda" yazar. Sesli: `tts.py` sentez bitince "🔊 ses modeli sorunsuz başlatıldı" yazar →
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
- WhatsApp tek mesaj (kullanıcı isteği: her adım için ayrı mesaj gelmesin; `settings.whatsapp.digest`, varsayılan açık,
  Ayarlar → Otomasyon anahtarı): aşama satırları WhatsApp'a gitmez; `out/` izleyicisi yeni videoyu `digestPending`e koyar,
  post_pipeline'ın son JSON satırı (`{"autopublish"…}`) gelince `sendDigest()` → `wa.notifyVideo(mp4, {summary})`: video
  dosyası + başlıklar + platform başına son durum (`publishLines`: ✅ link / ⏳ sınır / ⏭ atlandı / ❌ hata; 90 sn tekrarının
  sonucu geçerli) + izleme linki + gerekiyorsa onay TEK mesajda (en çok 1000 karakter; dosya gönderilemezse metin). Yayın
  adımı 20 dk'da bitmezse yine gönderilir. Bu modda `publishFailed` WhatsApp'a ayrıca yazmaz (hata özettedir); üretim hatası
  ve diğer sağlık uyarıları ayrı gider. "son videoyu gönder" eski ayrıntılı biçimi (seslendirme metni) kullanır.
- Aşama bildirimleri (yalnız tek mesaj kapalıyken): `push()` içindeki `notifyStage()` STAGE kalıbına uyan log satırlarını 2,5 sn'de
  toplayıp WhatsApp'a gönderir (`settings.whatsapp.notifyStages`). Hostinger yükleme/silme satırları
  `publish.py` stderr'inden gelir (🌐). Panelde ayar kaydeden her istek sağ altta "Kaydedildi ✓" gösterir.
- Ayarlar sekmesi `<details class="grp">` gruplarıdır: Otomasyon, Yayın hesapları, WhatsApp, Sesler,
  Emixhas ve kanal, Gelişmiş. Eleman kimlikleri değişmedi; yeni bir ayar eklerken uygun gruba koy.
- Sağlık uyarıları (`healthCheck` her 10 dk, `healthAlert(key, text, {everyH})` → log "⚠️ sağlık:", WhatsApp, sesli
  "Dikkat, bir sistem uyarısı var"; tekrar engeli `data/health_alerts.json`): üretim hata ile bitti (panel ya da
  zamanlayıcı; `pipeline.sh` trap'i hata kodunda "✖ üretim hata ile bitti" yazar, son HATA/! satırları mesaja
  girer), zamanlanmış üretim gecikti (son düzenli video aralık + 40 dk'dan eski; uyarıya neden eklenir: `launchctl list
  com.gundem.video` yüklü mü — değilse `launchctl load` ile onarılır —, son çıkış kodu, kilit, launchd logundaki son hata;
  uyarı gittiğinde `settings.health.autoCatchUp` (varsayılan açık) ise kaçan üretim `startPipeline("format")` ile hemen
  telafi edilir: DURATION verilmez, süreyi saate göre format seçer; dinlenmedeyse uyanır), disk < `health.minFreeGb` (5),
  Instagram token ≤ 7 gün, bir yayın bağlantısı koptu (`data/health_conn.json`). Otomatik yayın düştü (`publishFailed`: "📤 yayınlanamadı" →
  platform hata satırları + Instagram son hatası, her seferinde; "📤 otomatik yayın yapılmadı" → ayar nedeni, 12 saatte bir). `settings.health` {enabled,
  whatsapp, minFreeGb}. `GET /api/health`.
- launchd çıkış kodu (`exitText`): `launchctl list` "LastExitStatus" bekleme durumudur (256 → 1 hata, 768 → 3 başka üretim,
  19968 → 78). 78 = EX_CONFIG: launchd işi HİÇ başlatamadı; proje Masaüstünde olduğundan macOS gizlilik koruması (TCC) arka plan
  işinin klasöre erişimini engeller (kullanıcının Mac'inde 14 Ekim'de görüldü; panel Terminal'den açık olduğu için o çalışıyordu).
  Çözüm: Tam Disk Erişimi → /bin/bash ya da projeyi Masaüstü/Belgeler/İndirilenler dışına taşımak. Kaçan üretim uyarısı artık "0 hata"
  geçen başarı satırlarını "son hata" saymaz ve 78'de eski logu göstermez. Slot bekçisi (her dk): zamanlayıcı açıkken üretim saatinden
  6-40 dk sonra hiçbir üretim başlamamışsa (kilit yok, panel üretmiyor, launchd logunda slottan sonra "üretim başladı" yok, slottan
  sonra düzenli video yok) panel o slotu `startPipeline("format")` ile başlatır (slot başına bir kez, `data/panel_slot.json`; log ⏰),
  78 ise günde bir sağlık uyarısı. `teshis.sh` çıkış kodunu çözer ve 78'de klasör/izin önerisini yazar.
- Takılan üretim bekçisi (5 dk'da bir): `work/pipeline.lock` canlı sürece ait ve 50 dk'dan (uzun özetlerde 100 dk) eskiyse
  süreç ağacı kapatılır, kilit silinir, "⚠️ üretim … takılmış" + sağlık uyarısı (yoksa sonraki tüm zamanlanmış üretimler
  "başka üretim sürüyor" diye atlanır). Uyku algılama: dakikalık sayaç 5 dk'dan fazla atladıysa "💤 Mac … uykudaydı"
  log + 45 sn sonra WhatsApp (uykuda launchd, WhatsApp ve tarama çalışmaz; `caffeinate -i -s` kapak kapalıyken ya da
  pilde uykuyu engelleyemez). Teşhis: `npm run teshis` (`scripts/teshis.sh`: panel/dinlenme/WhatsApp/zamanlayıcı
  durumu, launchd işleri, son videolar, kilit, `pmset` uyku/uyanma, son loglar; token/anahtar satırları süzülür).
- Haftalık rapor `scripts/weekly_report.py` (son 7 gün: video sayısı, toplam ve önceki haftaya göre fark, platform
  toplamları ve önde olan, en çok izlenen 5 video + önde olduğu platform + link, en iyi kategori/saat, anlık vs
  düzenli, kurallı öneriler) → `data/reports/hafta-<tarih>.md`. Panel `settings.weeklyReport` {enabled, weekday 1
  (pazartesi), hour 10}'da önce izlenmeleri çeker, metni WhatsApp'a gönderir, özeti seslendirir
  (`data/weekly_report_last.json` tekrarı engeller). Komut: "haftalık rapor", "bu hafta nasıl gitti";
  `POST /api/weekly-report`.
- Arka plan: her dakika kontrol → bağlı hesap varsa `metricsSyncMinutes` (20) aralığıyla kademeli senkron;
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
- Sessiz düğmesi (kullanıcı isteği, 20 Ekim: "paneli sessise alma butonu ekle"): başlıkta "⏸ Tüm sistemi durdur"un yanında 🔊 /
  "🔇 Sessiz" (`.hbtns` ikisini birlikte tutar, iki hâl aynı genişlikte; sığmayan bağlantı çipleri bütün olarak alt satıra iner). Durum
  sunucuda `settings.muted` (varsayılan false, yalnız true sessiz; `POST /api/settings {muted}`, değişince SSE `mute` + log 🔇/🔊; durum yükü
  yeniden yüklemede ve yoklamada düzeltir, ama son değişiklikten — tıklama, kayıt yanıtı, SSE — önce istenmiş yoklama yanıtı yok sayılır:
  `/api/status` ayarı bağlantı denetiminden önce okur, eski yanıt düğmeyi geri çevirmesin), her sekme aynı. Sessizde `speak()` yalnız yazıyı
  gösterir (/api/speak isteği ve tarayıcı sesi yok; "bakıyorum" sesini beklerken sessize alınırsa da), "Bir saniye, bakıyorum." çalmaz,
  `jarvis` (günlük/haftalık rapor) okunmaz; `stageVoice()` hiç çalışmaz (SSE `stage` yok, panel kapalıyken Mac `afplay` yok; log satırı
  kalır). Sessize alınca çalan konuşma, "bakıyorum" sesi, aşama sırası ve çalan `afplay` (`macAbort`) hemen kesilir, açılınca kaçırılan
  okunmaz. "🔊 Sesi test et" (`speak(t, {force:true})`), Sesler önizlemesi ve video oynatıcı yine çalar; dinleme çalışır, yanıt yazıyla.
  `playBlob` durdurulunca da biter (`onpause`): eskiden ■ Dur bekleyen `speak()`i ve aşama sırasını (`stageBusy`) kalıcı kilitliyordu. Yeni
  konuşma (aşama cümlesi çalarken jarvis/sohbet yanıtı) eskisini keser: ses düğümü kopan eski ses donup aynı kilidi yapıyor, sessize alma da
  onu susturamıyordu.
- Üretim: süre kaydırıcısı → `POST /api/generate` → `pipeline.sh` spawn, log SSE ile canlı akar.
- Videolar: `out/*.mp4` + yanındaki `.json` meta. Küçük resimler `work/thumbs/` (ffmpeg). Video araması (kullanıcı isteği):
  `listVideos()` her videoya `search` metni koyar (yayın başlığı, A/B başlık, gün, slot, format, kaynak, hashtag, her
  segmentin başlık + seslendirme + kaynağı; Türkçe küçük harf); panel Videolar sekmesinde arama kutusu (tüm kelimeler
  geçmeli), sıralama (en yeni / en çok izlenen) ve süzgeç (YouTube/Instagram/TikTok'ta, yayınlanmamış, 🔁 yeniden
  yayınlar); sayaç "(eşleşen / toplam)". Süzme tarayıcıda (`shownVideos`/`renderVideos`).
- Paylaşım: QR ile telefona yerel link (aynı Wi-Fi); Finder'da göster; indir; YouTube/Instagram'a yükle.
- Zamanlayıcı: panel launchd plist'ini yazar/siler (`~/Library/LaunchAgents/com.gundem.video.plist`). Kök neden (12 Ekim,
  5 slot kaçtı): yeni macOS'ta `unload` ardından `load` sessizce başarısız olup 0 döndürebiliyor, iş launchd'den düşüyor ama
  plist durduğu için panel zamanlayıcıyı açık sanıyordu. Artık `unloadAgent` (bootout) / `loadAgent` (bootstrap, olmazsa
  `load -w`, `launchctl print gui/UID/…` ile doğrulama, 3 deneme); `ensureScheduleLoaded()` panel açılışında ve her 10 dk
  `healthCheck` başında plist var ama iş yüklü değilse yeniden yükler ("⏰ zamanlayıcı launchd'den düşmüştü…"), olmazsa
  sağlık uyarısı. `basla.sh`/`durdur.sh` panel servisi için de bootstrap/bootout kullanır. Panel launchd'den başlatılmamışsa
  (servis yüklenemedi) basla.sh paneli o terminalde açar: pencere kapanırsa panel de kapanır.
- Yeni sesli komut: `app/commands.js` içine kural, `server.js` içindeki switch'e eylem. Kural
  regex'lerinde kelime sınırı kullan ("niye" ↔ "saniyelik" tuzağı).

## WhatsApp köprüsü (`app/whatsapp.js`, Baileys)
- QR panelden okutulur; oturum `secrets/wa-auth/`. Yalnızca `settings.whatsapp.owner` numarasından
  gelen mesajlar işlenir (0532… → 90532…), gruplar yok sayılır.
- Yeni video (panelden ya da launchd'den; `out/` izlenir) → sahibine: başlıklar + seslendirme metni,
  Wi-Fi linki, tünel açıksa dış link, ayar açıksa video dosyasının kendisi; bağlı platform varsa
  "onay" ister. "onay/evet/yayınla" → bağlı platformlara yayın; "iptal" → yayınlanmaz.
- Kısa mesaj modu (kullanıcı isteği, 14 Ekim: "uzun mesajlar atmasın, aşamaları bildirmesin; sorun varsa, işe başladıysa, başarılıysa
  onu bildirsin"; `settings.whatsapp.brief`, varsayılan açık, panel WhatsApp grubunda ✂️ anahtar): aşama bildirimleri (`notifyStage`)
  hiç gitmez; video haberinde yalnız "🎬 Başladı: …" (link/video alınınca), "❌ …" (indirme/kurgu/üretim hatası) ve video bitince
  `notifyVideo` kısa biçimi: "✅ *Video hazır*: <ilk haber> (N sn)" + "📤 Yayında: …" + yalnız sorunlu platform satırları + tek satır
  onay ("Yayın: *onay* (…) · *onay insta* … · *iptal*"); "✂️ Kurgu hazır", "🔗 Paylaşım indirildi", "inceliyorum" mesajları yalnız logda.
  Haber linki yanıtı "🎬 Başladı: <başlık>. Bitince video gelecek." Beyin WhatsApp'ta en çok 2 kısa cümle (prompt'ta kural), komut
  çalıştırdıysa yalnız komutun yanıtı gider; rapor yalnız "rapor/liste/detay/ayrıntı" istenirse eklenir, yanıt ~700 karakterde kesilir
  ("evet sil" onay listesi kesilmez). İlk yorum başarısı yazılmaz, yalnız sorunu. Sağlık uyarıları, planlı yayın sonucu, viral alarmı
  ve zamanlanmış raporlar (haftalık rapor, yorum özeti) değişmedi.
- Diğer mesajları ÖNCE Claude anlar (kullanıcı isteği, 14 Ekim: "WhatsApp'tan gönderdiğim mesajları Claude alsın, ne demek istediğimi
  anlasın, yapsın"; `server.js smartWhatsApp`, `settings.whatsapp.smart`, panel WhatsApp grubunda 🧠 anahtar): `handleCommand(text,
  {source: "whatsapp"})` → `think(text, "chat", {channel: "whatsapp"})`. Beyin prompt'una `HELP_TEXT` "KOMUT LİSTESİ" olarak girer;
  yeni eylem `{"type":"command","text":"…"}` kural motorundaki herhangi bir komutu çalıştırır (`execAction` → `handleCommand(text,
  {direct: true})`; kural yoksa "Bu komutu tanımadım", beyne geri dönmez), komutun yanıtı/raporu beyin yanıtının altına eklenir.
  Kurallar: soru → eylemsiz cevap (gerekirse yalnız okuma komutu), geri dönüşsüz onay adımı ("evet sil") açıkça yazılmadıkça yok.
  Hızlı yol (Claude'a gitmez): link içeren mesaj (haber/sosyal medya videosu + saat), yayın onayı/iptali ve video talimatı (whatsapp.js
  önce işler), tek kelimelik kesin komutlar (`WA_DIRECT`: yardım, durum, iptal, evet sil…). Claude'a ulaşılamazsa eski kural yolu.
  Claude düşünürken WhatsApp'ta "yazıyor…" görünür (`sendPresenceUpdate`). Yanıt ~10-20 sn sürer.
- Gönderen tanıma (komutlar sessizce kaybolmasın): WhatsApp'ın yeni LID kimliğinde 1'e 1 sohbet `…@lid` gelir; karşı kimlik
  Baileys 7'de `key.remoteJidAlt` (grupta `participantAlt`), 6.7.x'te `senderPn/senderLid/participantPn/participantLid` (ikisi de
  okunur). `isOwner` LID'i telefon sanmaz, cihaz ekini atar (`userOf`: v7'nin LID → numara eşlemesi "905…:0@s.whatsapp.net" döner).
  Sahip: numarası eşleşen, ya da bilinen sahip LID'i (`learnOwnerLid`: bağlanınca v7'de `sock.signalRepository.lidMapping.getLIDForPN`
  — yerel depo, yoksa USync sorgusu; v7'de `onWhatsApp` artık lid vermez —, 6.7.x'te `onWhatsApp().lid`; başarısız sorgu 5 dk
  tekrarlanmaz; numarası eşleşen her mesaj ve v7'nin `lid-mapping.update` olayı da öğretir; numarası gizli gelen LID mesajında v7'nin
  yerel `getPNForLID` eşlemesine bakılır; sahip numarası değişince eski LID'ler unutulur), ya da bağlı numaranın KENDİNE-MESAJ sohbeti
  (fromMe + kendi numara/LID; telefondan "append" gelebilir). Bağlı numaranın başka sohbetlere yazdıkları ve 5 dk'dan eski mesajlar
  işlenmez. Gönderdiğimiz her mesajın kimliği gönderimden ÖNCE ayrılır (`sendRaw`: `generateMessageIDV2` → `messageId`) ve `sentIds` +
  `data/wa_sent.json`'da durur (kendine-mesajda yanıt döngüsü olmasın; panel yeniden başlasa da). Yanıt mesajın GELDİĞİ sohbet adresine
  (`normJid(remoteJid)`: LID sohbetinde LID, numara sohbetinde numara, kendine-mesajda kendi adresimiz; eskiden hep telefon jid'ine —
  aşağıda "Mesaj bekleniyor"). Sahibe kendiliğinden gidenler (`ownerTarget`: video bildirimi, `wa.send` sağlık/rapor mesajları, kuyruk —
  kuyruktaki adres gönderirken seçilir) bilinen LID'ine, yoksa telefon jid'ine; sahip bağlı numaranın kendisiyse kendi LID'ine
  (kendine-mesaj). Sahip olmayan göndericiden gelen mesaj dakikada bir loga "💬 WhatsApp: sahip olmayan göndericiden mesaj yok sayıldı
  (…son 4 hane / numara gizli)" yazar; `status().lastIgnored`.
- "Mesaj bekleniyor" düzeltmesi (kullanıcı şikâyeti, 19 Ekim: "WhatsApp'tan gelen tüm mesajlar 'Mesaj bekleniyor. Bu işlem biraz zaman
  alabilir' görünüyor, kendi numaramdan kendime gelenler de"; komutlar çalışıyordu, yalnız botun gönderdikleri telefonda çözülmüyordu).
  Kök neden (6.7.24 kaynağından; gerçek hesapla doğrulanamadı): 1) `getMessage` verilmemişti: telefon çözemediği mesaj için "yeniden
  gönder" (retry receipt) isteyince Baileys mesajı bulamıyor ("recv retry request, but message not available"), hiç yeniden
  göndermiyordu → telefonda kalıcı "bekleniyor"; 2) 6.7.24 Signal oturum adresini yalnız numara + cihazdan kurar (sunucu atılır), LID ↔
  numara eşlemesi yok: aynı kişi için iki ayrı oturum. Gelen LID mesajı LID oturumuyla çözülüyor, yanıt telefon jid'ine gittiği için eski
  numara oturumuyla şifreleniyordu; retry'deki oturum yenilemesi yalnız isteyen (LID) adrese dokunduğundan sonraki her mesaj da aynı
  biçimde kalıyordu (her mesajın bozuk olmasının nedeni; telefonun oturumlarını LID'e taşıdığı çıkarım). Çözüm:
  Baileys `7.0.0-rc14` (package.json'da tam sürüm — `^6.7.24` hiçbir 7.x ön sürümünü seçmez —, npm `latest`; libsignal artık npm'den,
  kurulum git/GitHub istemez, kaynağı bayt bayt aynı 6.0.0): numara oturumlarını LID'e taşır, her şifrelemede numarayı LID'e çevirir
  (`lid-mapping`, `device-list`, `tctoken`, `identity-key` anahtarları aynı `secrets/wa-auth/` klasörüne; oturum klasörü biçimi aynı,
  yeniden QR gerekmez), kimlik değişiminde ve MAC hatasında oturumu kendiliğinden yeniler. `makeWASocket`: `getMessage` = gönderdiğimiz
  mesajların deposu `data/wa_sent.json` (`sendRaw` → `remember` → `storeSent`; proto `Message.encode` base64 — BufferJSON medya
  anahtarını metne çeviriyor —; yalnız kimlikle aranır, çünkü istek @lid, cihaz jid'i ya da kendine-mesaj adresinden gelir; 7 gün / 500
  mesaj, geçici dosya + rename; v7'nin kendi önbelleği yalnız 5 dk, aynı adres ve yeniden başlatmada boşalır), süreç boyu tek
  `msgRetryCounterCache` (soket yenilenince sayaç sıfırlanıp istek fırtınası olmasın), `maxMsgRetryCount` v7'de 10 (v7 sayacı istek başına
  iki kez artırıyor; 5'te yalnız 2 yeniden gönderim kalıyordu), `makeCacheableSignalKeyStore`, `syncFullHistory: false` (geçmiş
  eşitlemesi kapatılmaz: v7 LID eşlemelerini oradan da öğrenir), sürüm sorgusu 10 sn sınırlı ve başarısızsa `version` hiç verilmez
  (`undefined` varsayılanı eziyordu), `printQRInTerminal` kaldırıldı. Bağlantı: `start` tek uçuş (bekçi + kopma sonrası deneme + düğme
  aynı anda iki canlı soket açıyordu), kurulum sürerken "durdur" gelirse soket açılmaz (`gen`), `stop` bekleyen yeniden denemeyi iptal
  eder (eskiden kopmanın zamanlayıcısı durdurulan bağlantıyı yeniden açıyordu), yerine yenisi kurulmuş eski soketin geç mesaj olayı
  işlenmez, `end()` v7'de async (`endSock`), `creds.update` yazma hatası süreci düşürmez. Video indirme: v7'nin 404/410'da telefondan
  yeniden yükleme denemesi hata kodunu yanlış alandan okuyup hiç çalışmıyor; `onOwnerVideo` kendisi `updateMediaMessage` + ikinci indirme
  yapar. Teşhis (gizli bilgi yok: sayılar): telefonun yeniden gönderme istekleri (`CB:receipt,type:retry`) sayılır, 20 sn sonra loga tek
  satır "💬 WhatsApp: telefon son 30 dk'da N mesajımızı çözemeyip yeniden istedi (en çok K. deneme, LID adresinden); mesajlar kayıtta,
  yeniden şifrelenip gönderiliyor" (kayıtta olmayanı ayrıca söyler); 30 dk'da 2 mesaj 3+ kez ya da 6+ mesaj → 6 saatte bir "⚠️ WhatsApp:
  telefon mesajlarımızı sürekli çözemiyor … panel Ayarlar → WhatsApp → çıkış yap, telefonda Bağlı cihazlar'dan eski oturumu kaldırın,
  yeni QR"; `status()` `retry`, `lib`, `node` (`npm run teshis` yazar). Sürüm değişince ilk bağlanışta bir kez "💬 WhatsApp kütüphanesi
  yenilendi (Baileys 6.x → 7.0.0-rc14): … ilk birkaç mesajda telefon bir kez yeniden gönder isteyebilir" (`data/wa_lib.json`). Geçiş:
  6.7.24'ün LID oturum dosyaları v7'de okunmaz (`<lid>_1.<cihaz>` arar): ilk gelen/giden birkaç mesajda bir yeniden deneme turu beklenir,
  kendiliğinden düzelir; "bekleniyor" sürerse panelden çıkış + yeni QR (kullanıcının kararı). Önceki sürümle gönderilmiş, çözülemeden kalmış
  mesajlar kayıtta olmadığı için geri gelmez. Node: 6.7.24 de 7 de Node 20+ ister (ikisinin `preinstall`'ı 20 altında kurulumu durdurur;
  Node 18.20'de ikisi de `globalThis.crypto` hatasıyla açılmaz; 20.9'da 6.7.24 açılmaz, 7 açılır) → eski sürümü takma adla yedek tutmak
  Node yedeği olmazdı, eklenmedi. Kod 6.7.x ile de çalışır (alan adları, `onWhatsApp` yedeği; geri dönüş `npm i
  @whiskeysockets/baileys@6.7.24`, oturumlar yeniden kurulur); içe aktarma başarısızsa Türkçe hata (`status().error` + log: Node 20 altında
  "Node'u güncelleyin", değilse "npm install"). "⬇ Güncelle"/"güncelle" package.json değiştiği için `npm install` çalıştırır.
  Sınama (sandbox, ağsız; gerçek hesap, eşleşme ve secrets/ YOK): yeni kilit dosyasıyla `npm ci` temiz (yalnız Baileys ve bağımlılıkları
  değişti, axios zinciri çıktı); `app/whatsapp.js` kopyası sahte Baileys soketiyle (gerçek kütüphanenin proto/jid/mesaj üretimi/anahtar
  önbelleği, gerçek `generateWAMessage` ile video dahil) 7 ve 6.7.24 için 47 + 44 denetim: v7 (LID + remoteJidAlt, PN + LID alt, alt
  kimliksiz LID → yerel eşleme ":0" ile) ve v6 (senderPn/senderLid) biçimli sahip mesajları, kendine-mesaj (PN/append ve LID), yabancı LID/
  numara, grup, eski ve çevrimdışı mesaj; yanıt adresi (LID sohbeti → LID, PN → PN, kendine → kendi adresi), yazıyor… aynı adrese, kendi
  yankımız (yeniden başlatmadan sonra da) komut sayılmadı, kuyruk bağlanınca sahibin LID'ine, sahip = bağlı numara → kendi LID'i,
  `lid-mapping.update`; getMessage başka adresten yalnız kimlikle videoyu (medya anahtarı dahil) ve metni bayt bayt döndü, panel yeniden
  başlayınca da; depo sınırı (500, 7 gün) ve bozuk dosya; aynı anda 3 start → tek soket, kopma + bekçi → tek yeni soket, sayaç
  soketler arasında aynı, durdur → bekleyen deneme iptal, kurulum sürerken durdur → soket yok; 410 → `updateMediaMessage` + indirme;
  yeniden gönderme isteği özeti ve uyarısı; loglarda anahtar yok. Gerçek 7.0.0-rc14 ile uygulama: yapılandırma kabul edildi, sürüm
  GitHub'dan geldi, Node 20.9'da açıldı; Node 18.20'de Türkçe "Node 20" hatası; v7'nin libsignal'ıyla `SIGNAL_NOISE` filtresi oturum
  dökümünü (sahte özel anahtar) susturdu. DENENMEDİ: gerçek telefonla "Mesaj bekleniyor"un kalkması, gerçek retry isteklerinin
  biçimi ve 6.7.24 oturum klasörünün v7'ye geçişi; web.whatsapp.com sandbox'tan kapalı (DNS yok, vekil CONNECT 403), QR'a kadar el
  sıkışma da denenemedi. Mac'te ilk deneme: güncelle → panel logunda "WhatsApp kütüphanesi yenilendi" → kendine ve sahibe bir mesaj;
  telefonda "bekleniyor" kalırsa logdaki "yeniden istedi" satırına bakın.
  Doğrulama düzeltmeleri (19 Ekim): kendine-mesaj sohbetinde kendi telefonumuzun "yeniden gönder" isteğinde `recipient` yoktu, v7
  remoteJid'i boş bulup yeniden gönderirken hata veriyordu ("error in sending message again"): `CB:receipt,type:retry` (Baileys'in
  işlediği CB:receipt'ten önce aynı düğümle gelir) recipient/participant yoksa ve gönderen kendi numaramız ya da LID'imizse kendi sohbet
  adresini ekler (gerçek v7 soketi + sahte ağla: düzeltmesiz yeniden gönderim yok, düzeltmeyle var; sahibin ya da grubun isteğine
  dokunulmaz). Durdurduktan hemen sonra başlatma eski kurulumun sözünü almaz (`stop` `starting`i bırakır, her kurulum yalnız kendi kaydını
  siler; "numara değiştir" akışında bağlantı açılmıyordu). Güncelleme: package-lock.json yerelde değişmişse (npm 11 kurulumda yeniden
  yazar) `git pull`dan önce eski hâline döner (kilidi değişen ilk güncelleme çekilemezdi), npm install `--no-save` (kilit yeniden yazılmaz);
  package.json'da tam sürümle sabitlenen paket (`PINNED`: Baileys) kurulu sürümden farklıysa `pinMismatch` → güncellemede npm install
  çalışır; panel açılışında da (20 sn sonra) uyuşmazlık varsa npm install kendiliğinden bir kez denenir, olursa panel iş yokken yeniden
  başlar, olmazsa logda "terminalde npm install" (6 saatte en çok bir deneme, `data/pin_install.json`) — eski güncelleme kodu (git kökü üst
  klasörde, `--relative` yokken) ya da terminalde yalnız `git pull` Baileys'i 6.7'de bırakmasın. Sahte soket denetimleri düzeltmelerden
  sonra yeniden: v7 47/47, 6.7.24 (gerçek 6.7.24 kurulumuyla) 44/44, ek 6/6 (retry adresi 5 durum, durdur → başlat).
- Platform seçerek onay (kullanıcı isteği, 14 Ekim: "onay yazarsam tüm platformlarda, onay insta yazarsam yalnız Instagram'da paylaşsın";
  `whatsapp.js` `pickPlatforms`/`approveLine`): "onay" (onayla/evet/yayınla/paylaş/tamam/ok) bekleyen tüm platformlar; "onay insta",
  "onay youtube tiktok", "insta onay", "instagram'da paylaş", "sadece tiktok" yalnız yazılanlar (insta/ig/reels, youtube/yt/shorts,
  tiktok/tt; Türkçe küçük harfte ı → i ile bakılır). Kalanlar `partial` beklemede kalır (yalnız açık "onay …" yayınlar, "tamam/evet"
  yayınlamaz; "iptal" kalanları bırakır). Onay mesajı "✅ Hepsinde … *onay*" + "▫️ Yalnız birinde: *onay youtube* · *onay insta* …".
  Linkten/WhatsApp görüntüsünden yapılan video (userVideo) "onay iste" ayarı kapalıyken de (tam otomatik mod kapatır) onay sorar —
  kullanıcı şikâyeti: "link atıyorum, haber yapıyor ama ne paylaşıyor ne onay istiyor"; bağlantı kopukken kuyruğa giren bildirimde de.
- Video dosyası 60 MB üstündeyse gönderilmez, link kalır. WhatsApp bağlı değilken bildirim loga düşer.
- libsignal oturum açıp kapatırken oturumun tamamını (özel anahtarlar dahil) `console.info/warn` ile basar; `server.js`
  başındaki `SIGNAL_NOISE` filtresi bu satırları susturur (terminal ve work/panel.log'a gizli anahtar düşmesin). Kaldırma.

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
- Yayın hatası kaybolmaz: `publish.upload()` başarısız yüklemeyi `data/publish_last_error.json` {platform: {at, video,
  error}} dosyasına yazar (Instagram'da `ig_hint` açıklamasıyla), başarılı yükleme siler; `--status` Instagram için
  `lastError` verir, panel Instagram kartında "Son yükleme hatası" olarak gösterir. `publish.py --ig-diagnose`
  (`ig_diagnose`) zinciri adım adım sınar: bağlantı, oturum + hesap türü (BUSINESS/MEDIA_CREATOR olmalı),
  `content_publishing_limit` günlük kotası, Meta'nın videoyu çekebilmesi (son videonun herkese açık adresine
  facebookexternalhit User-Agent ve Range ile istek: HTTP 200/206 + video içerik türü) ve son hata. Panel
  "🩺 Instagram'ı sına" → `POST /api/instagram/diagnose`, adımlar ✅/❌ olarak sohbete ve loga (🩺).
- Sınır sıraları logda (kullanıcı isteği: TikTok sırası görünsün): `publish.py --queue` (`queue_info`/`queue_line`):
  "📤 tiktok sırası: N video bekliyor (adlar) · gönderim HH:MM'e kadar duraklatıldı (neden)"; `--status` tiktok.queue;
  `--flush` sonunda kalan sıralar; `post_pipeline` her yayından sonra boş olmayan/duraklatılmış sırayı yazar; panel
  açılıştan 1 dk sonra ve 2 saatte bir `logQueues()`; komut "tiktok sırası / sırada ne var / bekleyen videolar"
  (`queue` eylemi), `GET /api/queue`; TikTok kartında "⏳ Sıra: …".
- TikTok sınırı: gelen kutusu modunda paylaşılmamış taslak birikince `spam_risk_too_many_pending_share` (doğrudan yayında
  `spam_risk_too_many_posts`) → `TT_LIMIT_REASONS` LimitReached gibi: 3 saat bekleme, video sıraya, Türkçe açıklama
  `TT_LIMIT_TR` ("taslakları paylaşın ya da silin"), log "📤 tiktok: sınır doldu" + sesli uyarı.
- `scripts/sync_metrics.py`: izlenme/beğeni/yorum (YT), plays/reach/shares/saves (IG), TikTok sayaçları. Kademeli takip
  (kullanıcı kararı: haberlerimiz günlük, 3 gün sonra değeri kalmaz; `settings.metricsSync` {freshHours 72, dailyUntilDays 7}):
  ilk 72 saat her senkronda (`metricsSyncMinutes`, varsayılan 20 dk; eski 60 bir kez 20'ye taşındı, Ayarlar → Otomasyon), 72. saati
  geçince bir kez hemen ölçülüp `views72h` saklanır, 3-7 gün günde bir, 7 günden eski video sorgulanmaz (Instagram'da video başına
  istek gittiği için sınır da korunur). `analyze.video_rows` 72 saati geçen videoda `views72h` kullanır: kategori/saat/varyant
  ortalamaları, en iyi videolar, haftalık rapor ve altın saat planı her haberi "3. gün" değeriyle karşılaştırır.
  Sonunda `scripts/followers.py` abone/takipçi sayılarını çeker: YouTube `channels.list(mine)` subscriberCount
  (1000 üstünde yuvarlanır), Instagram `followers_count`, TikTok `user/info` follower_count (`user.info.stats` izni:
  TT_SCOPES'a eklendi, eski bağlantıda yeniden bağlamak ve uygulamada izin açık olmak gerekir). Saatte en çok bir
  kayıt `data/followers.json` (400 gün); `summary()` güncel, bugün (yerel gece yarısından beri), 7 gün, 30 gün
  kazanımı (`partial`: kayıt dönemden yeniyse ilk kayda göre) ve son 14 günün günlük kazanım serisi (kayıt olmayan
  gün `null`; gün başında kayıt yoksa — takibin başladığı gün — o günün ilk kaydına göre, `partial`). Grafikte
  kayıt yok = kesikli çizgi, 0 = ince çizgi, kısmi gün = soluk sütun; altında veri birikimini anlatan not. `analyze.py`
  insights'a `followers` koyar (beyin bağlamı da görür); geçmiş doldurma `backfill()` (6 saatte bir, `--backfill` hemen):
  YouTube Analytics `reports.query` subscribersGained − subscribersLost (`yt-analytics.readonly`, YT_SCOPES'a eklendi →
  eski token'da "Yeniden bağla" + Google Cloud'da YouTube Analytics API etkin; `yt_service(api=("youtubeAnalytics","v2"))`)
  ve Instagram `follower_count` içgörüsü (son 30 gün, end_time bir önceki güne yazılır) → `data/followers.json`
  `history` {platform: {gün: net}}; kaydı olmayan ya da kısmi (bugün hariç) günler buradan dolar (`src: "platform"`,
  ipucunda "platformun kendi geçmiş verisi"), 7/30 gün toplamı tam günler varsa seriden hesaplanır; hatalar
  `historyErrors` → grafik notu. TikTok geçmiş vermez. İzlenme/abone senkronu dinlenmede de sürer (hafif; gün boşluğu
  kalmasın), YouTube sırası ve günlük rapor uyanınca; panel Analitik'in başında "ABONE VE TAKİPÇİ" kartları
  (toplam + platform) ve günlük kazanım sütun grafiği (fareyle platform kırılımı); haftalık rapor 👥 satırları;
  komut "kaç abonemiz var / bugün kaç takipçi kazandık" (`followers` eylemi, 30 dk'da bir canlı çeker).
- En iyi yayın saati (`analyze.best_hours` → insights `bestHours`): düzenli (uzun olmayan) videolarda platform başına
  saat ortalaması (en az 2 video) ve slot kaydırma önerisi: 15+ izlenmeli video, slotların en az n-1'inde (komşu saatle
  yumuşatılmış) veri ve ≥ %15 kazanç şart (verisi olmayan saat "iyi" sayılmaz). Panel Analitik "EN İYİ YAYIN SAATİ" +
  "Saatleri kaydır" → `POST /api/schedule/offset {offset|reset}` → `settings.scheduleOffset`; `slotsFor()` kaydırır,
  zamanlayıcı açıksa plist yeniden yazılır. Haftalık rapor önerisine de girer.
- Yeniden yayın (kullanıcı isteği: tutan haberi hafif değiştirip tekrar yayınla): panelde her video kartında ve video
  penceresinde "🔁 Yeniden yayınla" (onay `ask()`), komut "en çok izlenen / son videoyu yeniden yayınla" (`remake` eylemi),
  `POST /api/videos/:name/remake` → `remakeVideo()`: anlık videoda tüm konu, çok haberlide kanca + ilk (manşet) haber tek
  konulu son dakika videosu olur; haber `news_lookup --topic` ile yeniden aranır (güncel bilgi + başka sayfalar, eski
  sayfalar hariç), `startAnlik(..., {remake})` → `work/remake.json` {of, oldScript, oldTitles, avoid} + `REMAKE=1`,
  `REMAKE_OF`. `topic_news` prompt'a `onceki_senaryo` koyar, `prompts/anlik.md` YENİDEN YAYIN kuralı farklı kanca/başlık/
  kapak/cümle ister (eski ifadeler tekrar edilmez, bilgi aynı). `fetch_images` REMAKE'te `avoid` listesindeki eski haber
  sayfalarını, video ve fotoğraf adreslerini kullanmaz (fotoğrafta önce aynı haberin diğer sayfaları); her segmente
  `videoSrc`/`imageSrc` yazılır ki sonraki yeniden yayın da farklı görsel seçsin. Meta `remakeOf` (listede "🔁 yeniden"
  etiketi), `post_pipeline.youtube_allowed` yeniden yayını değer kuralına takmaz; yayın anlık videoyla aynı (bağlı tüm hesaplar).
- En çok izlenen saatlerde tekrar (kullanıcı isteği: "en çok izlenen 3 saatte günün en çok izlenen haberini sırasıyla farklı
  şekilde, mümkünse farklı görsellerle 30 sn yeniden yayınla"; `scripts/peak_remake.py`, `settings.peakRemake` {enabled true,
  count 3, duration 30, leadMin 20, minViews 10, fixedHours [20], defaultHours [12, 17, 20], fromHour 8, toHour 23, minGapHours 3,
  minVideos 12, minPerHour 2}): `fixedHours` her gün kesin tekrar saatleridir (kullanıcı kararı, 18 Ekim: "tutan haber aynı gün 20:00'da farklı versiyon, kanca ve kapakla tekrar yayınlansın"); plan her zaman onları içerir, kalan saatler veriden ya da varsayılandan sabit saatlere ≥ `minGapHours` uzaklıkta seçilir (`detail[].fixed`). Sabit saat sayısı `count`'u geçerse hepsi kalır (en çok 5); varsayılan ya da veri saatleri boşluk kuralı yüzünden yetmezse izinli saatlerden (veride puana, sonra varsayılana yakınlığa göre) tamamlanır: sabit 18 → 12, 18, 21. Sırayla doldurma yine eksik kalırsa (count 5, sabit 22) kurala uyan en büyük küme aranır (`complete`, en çok C(16,4) deneme): 10, 13, 16, 19, 22. Panel kartında "her gün sabit saat" alanı (`#peakFixed`, virgülle saatler) `peakRemake.fixedHours` yazar ve planı `GET /api/peak?refresh=1` ile yeniler. `--plan` son `windowDays` (7, kullanıcı kararı 14 Ekim; o pencerede 12 video yoksa tüm geçmiş) günün Shorts videolarının yayın saatine göre izlenme ortalaması (komşu saatlerle yumuşatılmış; yalnız kendi
  verisi ≥2 video olan saat aday; 24 saatten genç videolar sayılmaz), sabit saatlerle birlikte en iyi 3 saat aralarında ≥3 saat; veri azsa varsayılan
  saatler. `--pick` son 24 saatin en çok izlenen videosu; son 24 saatte (bu özellikle ya da elle 🔁) yeniden yayınlanmış video/
  aynı olay (`same_event`) atlanır → 1. saatte günün 1 numarası, sonra sıradakiler. Panel (`server.js` peakRemake): saat
  `leadMin` dk önce ile :50 arası, saatte bir kez (`data/peak_remake.json`, bekleyen kayıt çift başlamayı önler); önce izlenmeler
  30 dk'dan eskiyse senkron, sonra `remakeVideo(name, {duration, peakHour})` (eski sayfa/görseller hariç, yeni senaryo),
  dinlenmedeyse uyandırır, `nextPlanned` sıradaki tekrarı bilir. Meta `peakHour` (listede "🕘 HH:00 tekrarı"). Log 🕘. Panel
  Analitik "🕘 EN ÇOK İZLENEN SAATLERDE TEKRAR" (anahtar, saatler, bugün yapılanlar, "Şimdi yap"), `GET /api/peak`,
  `POST /api/peak/run`, komut "en çok izlenen saatler / altın saat tekrarını aç|kapat|şimdi yap" (`peak` eylemi).
- Otomatik ilk yorum (kullanıcı kararı; `settings.firstComment.enabled`, varsayılan açık): senaryo prompt'ları en üst düzeyde
  `firstComment` yazar (habere özel tarafsız soru, ≤110 karakter; can kaybında soru yerine başsağlığı), şablon videolarda ve
  Claude yazmazsa `assemble_script.FIRST_COMMENT`/genel soru; hassas kelime yıldızlanır, meta `firstComment`. `publish.py`
  YouTube yüklemesinden hemen sonra `commentThreads.insert` (`youtube.force-ssl` izni YT_SCOPES'a eklendi → eski bağlantıda
  "Yeniden bağla"; yoksa `commentError`), Instagram'da `/{media}/comments`. Sabitleme API'de yok (YouTube Studio'dan elle);
  TikTok API yorum yazmaya izin vermez. Sonuç metrics `firstComment`/`commentError`, log 💬.
  Kaçan ilk yorum (kullanıcı şikâyeti, 14 Ekim: "ilk yorumu atmadı"; en olası neden YouTube token'ında `force-ssl` izninin olmaması —
  "Yeniden bağla" yapılmamıştı): `publish.py --first-comments` (`fill_first_comments`) her izlenme senkronundan sonra (`retitleCheck`
  ardından `firstCommentCheck`) son 72 saatte yayında olup ilk yorumu olmayan YouTube/Instagram gönderilerine yorumu sonradan yazar
  (en çok 4 deneme, ≥15 dk arayla; izin yokken deneme sayılmaz, izin gelince ilk senkronda yazılır; metrikler taze kayda birleştirilir).
  `firstComment` alanı olmayan eski videoda genel soru. İzin yoksa günde bir sağlık uyarısı (YouTube `yt-comment-scope`, Instagram
  `ig-comment-scope`); `--status` youtube `comments`, panel YouTube kartında "Yorum izni yok / Yorumlar ✔". `post_pipeline` "  💬"
  satırlarını da loga taşır.
- Tutmayan videonun başlığını değiştir (kullanıcı kararı; `publish.py --retitle` → `yt_retitle`, her izlenme senkronundan sonra
  `retitleCheck()`; `settings.retitle` {enabled, afterHours 3, ratio 0.5, minBaseline 5}): YouTube'da yayından 3-9 saat sonraki
  ilk ölçümde izlenme, önceki videoların aynı yaştaki izlenmesinin (`data/views_at_check.json`, son 20) ortancasının yarısının
  altındaysa başlık diğer varyanta (A ↔ B) geçer, bir kez: meta `publishTitle`/`titleVariant`/`retitled`, `build_caption` ile yeni
  başlık, `videos.update` (açıklama, etiket, kategori korunur; "youtube" izni). Log 📉. Instagram/TikTok API başlık değiştirmez.
- İzleyici tutma (`scripts/retention.py`, panel 12 saatte bir, YouTube bağlıysa): YouTube Analytics `audienceWatchRatio`
  (elapsedVideoTimeRatio) + `averageViewPercentage`; yayından 2-28 gün sonraki videolar (9 günden gençler 2 günde bir yeniden),
  `data/retention.json`. Eğri videonun segment süreleriyle bölünür: kanca/intro/her haber sonunda kalan izleyici, kapanışa ulaşan,
  bölüm kayıpları, en çok kayıp. `analyze.py` özeti `insights.retention`a ve ipuçlarını senaryo ipucunun BAŞINA koyar (az token
  modunda 300 karakterde kesilir); kanca kaybı ≥%30, haber kartı başına ≥%15 olursa ipucu; intro kaybı ≥%10 ise panelde not.
  Panel Analitik "👀 İZLEYİCİ NEREDE AYRILIYOR". Log 👀.
- Viral alarmı (`scripts/viral_watch.py`, her izlenme senkronundan sonra `viralCheck()`): 24 saatten genç video, son 20
  eski videonun ortanca toplam izlenmesinin `settings.viral.ratio` (3) katı ve ≥ `minViews` (200) → bir kez (data/viral.json)
  log "🔥 VİRAL", ses, WhatsApp. Video yayınlandıktan SONRA düşmüş, aynı olaya ait (`same_event`, başka il/kişi değil:
  `news_memory.name_conflict`), başlığında videoda anlatılmamış bilgi olan (`new_info`; Mynet manşetindeki ilk haberin zamanı
  yok, tekrarı devam sayılmaz) ve üretilmemiş (hafızaya yalnız başlıkla, viral videonun kendi kayıtları hariç; videonun üretime
  alınış işaretini assemble siler, işaretler 3 saatten sonra sayılmaz) yeni haber varsa
  (`breaking_watch.recent_items`) devam videosu `queueValuable` ile üretilir (`followUp`: toplayıcı içerikle yeniden bakmaz;
  dinlenmeyi bozar); yeni bilgi yoksa üretilmez.
  `POST /api/viral/check`.
- Süresi geçen videolar YouTube'da liste dışı (kullanıcı kararı; `scripts/expire_videos.py`, panel saatte bir `expireCheck`,
  `settings.expire` {enabled, piyasaDays 2, alarmDays 2, takvimDays 2, meteoDays 2, newsDays 0}): şablon senaryo `expiresAt` yazar
  (`info_card.make_script(expires=)`: piyasa ve zam/rekor +2 gün, takvim olay günü bitince, meteoroloji uyarı bitişi + 1 saat) →
  meta `expiresAt`; eski videolarda türüne göre yayından N gün; diğer haberler yalnız `newsDays` > 0 ise (deprem, maç, derleme,
  uzun özetler hariç). `videos.update` status unlisted (silinmez) + kendi oynatma listelerimizden çıkarılır (`data/youtube_playlists.json`),
  metrics `youtube.unlistedAt/unlistReason`, log 🙈, en çok 20/çalıştırma (kota). Geri alma `--restore all|ad` (herkese açık + listelere
  geri), komutlar "süresi geçenleri liste dışı yap" / "liste dışı yapılanları geri aç" (`expire`), `POST /api/expire/run|restore`, panel
  📡 grubunda anahtar + "diğer haberler N gün" + düğmeler. Instagram/TikTok API gizlemeye izin vermez.
- Yorumlara anında otomatik yanıt (kullanıcı kararı, 14 Ekim — önceki "otomatik yanıt yok" kararının yerini aldı;
  `scripts/comment_reply.py`, `prompts/yanit.md`, `server.js replyCheck`, `settings.autoReply` {enabled, intervalMin 5, maxAgeHours 48,
  recentHours 72, maxPerDay {youtube 20, instagram 60}}): YouTube kanalın tüm yorumları tek istekle (`allThreadsRelatedToChannelId`,
  1 kota birimi; yanıt `comments.insert` 50 birim → günlük sınır yükleme kotasını korur, `youtube.force-ssl` izni), Instagram son 72
  saatin en çok 10 gönderisi (`/{comment}/replies`). Kendi yorumumuz, zaten yanıtladığımız ve 48 saatten eskiler alınmaz. En çok 15
  yorum TEK Claude çağrısıyla (düşük effort): yalnız videonun seslendirme özetine dayanan ≤200 karakter yanıt, siyasi taraf/tavsiye
  yok, hakaret/spam/link/anlamsız → `reply: null`, yorum metni talimat sayılmaz; yanıt `censor.mask`. Claude'un atladığı yorum da
  görüldü sayılır (`data/reply_state.json`), yanıtlar `data/reply_log.json`, log 💬. Panel Ayarlar → Otomasyon anahtar + "💬 Yorumları
  şimdi yanıtla", `POST /api/comments/reply`, komut "yorumları yanıtla" (`comments_reply`). TikTok API yorum sunmaz.
  Ayrıntı (14 Ekim incelemesi): YouTube'da `force-ssl` izni yoksa yorumlar hiç çekilmez (Claude boşuna çağrılmaz), hata "yorum izni yok".
  Kendi ilk yorumumuzun (soru) ALTINA yazılan izleyici cevapları da yanıtlanır (biz o cevaptan sonra yazmadıysak; Claude'a
  `kanalin_sorusu` verilir; YouTube'da yanıt aynı başlığa, Instagram'da üst yoruma `/{yorum}/replies` — tek seviye). Metrikte
  olmayan kanal videosuna gelen yorum da yanıtlanır (özet boş, genel yanıt). Yayınlanamayan yanıt metniyle `reply_state.json`
  `retry`e girer, sonraki turlarda en çok 3 kez denenir (yeni yorum olmasa da); günlük sınır dolarsa ertesi gün. Claude hatası saatte
  bir loglanır, yorumlar görülmedi sayılır. Sahte API'lerle uçtan uca denendi (yanıtlanmış/eski/kendi yorumu atlama, yeniden deneme).
- Günün en çok izlenenleri Instagram hikâyesinde (kullanıcı isteği; `scripts/ig_stories.py`, `server.js storiesRun`,
  `settings.igStories` {enabled, hour 21, minute 0, count 3, minViews 1, maxSeconds 59, rankCard}): her akşam saatinden sonraki 3 saat
  içinde (üretim sürmüyorken, dinlenmede de; günde bir, `data/info_last.json` igStories) önce izlenmeler 30 dk'dan eskiyse senkron,
  sonra son 24 saatin Shorts videoları izlenmeye göre (uzun özet ve derleme hariç, `same_event` ile aynı olay bir kez, son 2 günün
  hikâyesindeki video tekrar girmez). Sırayla hikâye: sıralama kartı (`InfoCard` ranking + `story`: kanal adı etiketi, "Bugün en çok
  bunları izlediniz", 1-2-3 + izlenme, "Videolar sıradaki hikâyelerde"; 1080x1920 jpg) ve her video (≤59 sn ise olduğu gibi, uzunsa
  sığan son haber/kanca segmentinin sonunda kesilir, 0,5 sn görüntü/ses kararması). `publish.ig_story_publish` media_type STORIES
  (image_url/video_url → durum yoklama → media_publish; biri düşerse diğerleri sürer). Dış adres `_PublicVideo.ensure_files`: Hostinger
  varsa `videos/stories/` (yayından sonra silinir), yoksa geçici sunucu + cloudflared (yalnız verilen dosyalar sunulur; `ensure` de
  artık aynı açık liste ile çalışır). Dosyalar `work/stories/<gün>/` (3 gün), durum `data/ig_stories.json`, log 📸, özet WhatsApp'a,
  otomatik paylaşım düşerse sağlık uyarısı. API hikâyeye bağlantı/anket çıkartması ekleyemez; hikâye 24 saatte kalkar. Panel
  📡 grubunda anahtar + saat + sayı + "📸 Hikâyeyi şimdi paylaş", `GET /api/stories`, `POST /api/stories/run {force}`, komut "günün
  hikayesini paylaş" / "hikaye paylaşımını kapat" / "otomatik hikayeyi aç" (`ig_stories`; "hikaye atabilir mi?" gibi soru beyne gider).
  Sandbox'ta sahte API ile denendi (kesim süreleri, kart çizimi, tekrar engeli); gerçek Instagram'a gönderilmedi.
- Yorum özeti (`scripts/comments.py` + `prompts/yorumlar.md`, her akşam `settings.comments` {enabled, hour 20}):
  son 7 günde yayınlanan videoların YENİ yorumları (YouTube commentThreads; Instagram /{media}/comments —
  IG_SCOPES'a instagram_business_manage_comments, FB_SCOPES'a instagram_manage_comments eklendi, eski bağlantıda
  yeniden bağlamak gerekir), görülenler `data/comments_state.json`. `brain.complete()` (düşük effort) ile özet →
  WhatsApp + `data/reports/yorumlar-<gün>.md`; yorumlara otomatik yanıt YOK, yazar adları özete girmez. Yeni yorum
  yoksa yalnız log. `POST /api/comments/digest`, komut "yorumları özetle", Ayarlar → Otomasyon anahtar + "şimdi özetle".
- Disk temizliği (kullanıcı isteği, 19 Ekim: "tüm üretilen haberleri ve videoları, normal videolar dahil 2 gün sonra diskten silelim —
  kapaklar da dahil"; `scripts/cleanup.py`, `settings.cleanup` {enabled true, days 2 (1-60)}; eski 30 günlük ayar ya da kapalı temizlik bir kez
  2 güne çekilir — `cleanup.twoDays`): panel SAATTE BİR (her saatin 10. dakikasından sonra, üretim yokken; `data/cleanup_last.json` hour) çalıştırır.
  `days`'ten eski HER video (5 saatlik, anlık, şablon, sosyal medya/WhatsApp, fragman, uzun video özeti, günün/haftanın özeti; yayınlanmış olsun
  olmasın — eski "yayınlanmamışsa 2×days" kuralı kalktı): mp4, -render.mp4, kapaklar (-kapak, -kapakA, -kapakB, -kapakYT) ve paneldeki küçük resim
  (work/thumbs) silinir; json (birkaç KB) KALIR ve `archived` alır (raporlar, analiz, haftanın özeti, yorum yanıtları, izleyici tutma, Instagram
  silme kararı onunla çalışır; `analyze.video_rows` arşivlenmişleri sayar), metrik ve platformdaki video da kalır. Silinmez: yükleme sırasındaki
  (`publish_queue.json`), planlı yayındaki (`scheduled_publish.json`), WhatsApp'ta onay bekleyen (`wa_pending.json`) video ve demo/test (adı
  rakamla başlamayan). Videosu daha önce silinmiş eski kapaklar ve küçük resimler de silinir (genç olan kalır). Ayrıca `days`'ten eski
  work/jobs (iş klasörleri, kurgu parçaları), work/wa_inbox (indirilen/gönderilen kaynak videolar, özetin analiz kopyası), work/stories.
  Pazar derlemesi (`weekly_top.py`) son 7 günün videosundan kestiği için video silinmeden önce derlemenin keseceği bölüm (`save_clip`: ilk
  haber kartının alanı, ~8 sn 1280x780 + kare) `work/derleme_parca/`a ayrılır (yalnız derlemeye girebilecek videoda — uzun özet, piyasa,
  takvim, derleme hariç —, derleme kapalıysa ayrılmaz; 8 gün tutulur); `pick`/`clip` video yoksa bu bölümü kullanır. Panel listesinde
  yalnız son `days` günün videoları görünür (yeniden yayın da onlardan). Log 🧹 "2 günden eski N video kapaklarıyla silindi (+ iş klasörü,
  kaynak video), X GB boşaldı". Ayarlar → Otomasyon: anahtar + gün kutusu + "🧹 Şimdi temizle" (önce `--dry-run` ile ne silineceğini sorar),
  `POST /api/cleanup {dryRun}`. Sandbox'ta sahte out/ ile denendi: yaşlar, korunan üç video, demo, eski arşivin kapakları, genç yetim kapak,
  iş klasörleri, kaynak videolar, hikâye, derleme parçası ve silinmiş videonun parçasından derleme kesiti, ikinci çalıştırma, bozuk ayarlar.
  İnceleme düzeltmeleri (19 Ekim): yüklenen video korunur — panel her yayında (`execAction` publish: elle, WhatsApp "onay", planlı) videoyu
  `data/publishing.json`a yazar (cleanup.py `protected()` okur, 3 saatten eski kayıt sayılmaz), saatlik temizlik yayın sürerken (`pubN`,
  `schedBusy`) başlamaz, planlı yayının kaydı yükleme BİTİNCE silinir (eskiden yüklemeden önce siliniyordu; o sırada çalışan temizlik mp4'ü ve
  kapağı silip Instagram/TikTok yüklemesini düşürüyordu). Derleme parçası yalnız derlemeye girebilecek videoya ayrılır: son 7 günün (meta
  date + timeLabel) ve en az bir platformda yayınlanmış videosu (ilk çalıştırmada yüzlerce gereksiz ffmpeg kesimi olmasın). Arşivlenmiş video
  panelden platformlardan silinebilir: `listVideos({archived})` / `GET /api/videos?archived=1` mp4'ü silinmiş, kaydı duran ve bir platformda
  yayında olan videoları da verir (`archived: true`, sıralama üretim zamanıyla); Videolar sekmesinde "🗄 Diskten silinmiş (platformda duran)"
  süzgeci (diğer süzgeçlerde görünmez), kartta küçük resim yerine "🗄 Diskten silindi" yazısı, pencerede oynatıcı/indirme/paylaşım/yükleme
  yok, yalnız "🗑 Platformlardan sil" (`DELETE /api/videos/:name`; bir platformdan silinemezse kayıt kalır, yeniden denenebilir) ve "🔁 Yeniden
  yayınla" (ikisi de yalnız kaydı kullanır). Sağlık uyarısındaki "son düzenli video N saat önce" artık kayıtların üretim zamanından (arşivlenenler
  dahil; `metaTime`, yoksa mp4 zamanı); eskiden son video silinince zamanlayıcının açılış zamanı yazılıyordu. Panel kopyasında denendi (arşiv
  listesi ve süzgeç, başsız Chromium'da kart ve pencere, kısmi platform silmede kaydın kalması, yayındaki videonun korunması, derleme parçası
  süzgeci, metaTime).
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
  Gündem" / "· Günün Özeti (uzun)") + ilk haberin kategorisi ("· Ekonomi", "· Asayiş ve Kaza"…); fragman analizi (meta `trailer`)
  format listesine girmez, yalnız kategori listesi ("· Sinema"; fragman son dakika haberi değil); yoksa herkese açık
  oluşturulur, kimlikler `data/youtube_playlists.json`. "youtube" kapsamı gerekir: eski token (upload+readonly) dosyadaki
  kapsamlarla okunur ve listesiz yükler, `--status` `playlists:false` verir, sistem kontrolü yeniden bağlamayı önerir.
  `--connect youtube` (`yt_connect`) token geçerli olsa da Google onayını YENİDEN açar (prompt=consent, 10 dk bekler),
  vazgeçilirse eski token kalır; dönen kapsamda liste izni yoksa söyler. `--disconnect youtube` izni geri alır ve token'ı
  siler. Panel: bağlıyken düğme "🔄 Yeniden bağla", yanında "Bağlantıyı kes" (`POST /api/disconnect/youtube`).
- Sil (panel video penceresi "🗑 Sil" → `DELETE /api/videos/:name`, `?local=1` yalnız yerel): önce
  `publish.py --delete-remote` (`delete_remote`): YouTube `videos.delete` ("youtube" izni; yoksa "Yeniden bağla"
  der), Instagram `DELETE /{media-id}` (API reddederse "uygulamadan elle silin" + link), TikTok API silme sunmaz
  (elle; inbox taslağı herkese açık değil), Hostinger kopyası, sınır sırası. Silinen platform kaydı metriklerden
  düşer, silinemeyen kalır (link kaybolmasın). Sonra Mac'teki mp4/json/kapaklar silinir; sonuç sohbete ve loga (🗑).
- Instagram temizliği (kullanıcı isteği: "7 gün içinde Instagram'da 1000 izlenmenin altında olan tümünü sil"; `scripts/ig_cleanup.py`,
  `server.js igCleanupPlan/igCleanupRun`): komut "instagramda son 7 günde 1000 izlenmenin altındakileri sil" (gün, sayı, "bin",
  "24 saatten eski" ayrıştırılır; `ig_cleanup` eylemi) önce izlenmeleri tazeler ve LİSTE gönderir (hiçbir şey silinmez; izlenmesi
  ölçülmemiş video listeye girmez; 1 günden yeniler ⚠️ ile belirtilir); "evet sil" (`ig_cleanup_confirm`, 15 dk geçerli; WhatsApp'ta
  yayın onayı "evet"iyle karışmaz) siler, "iptal" vazgeçer. Silmeden hemen önce güncel izlenme yeniden okunur, sınırı geçen bırakılır.
  Yalnız Instagram gönderisi silinir (`publish.ig_delete`; YouTube/TikTok/Mac kopyası kalır), metriklerden IG kaydı düşer; her
  satır loga "🗑 Instagram: silindi/SİLİNEMEDİ/SİLİNMEDİ …", kayıt `data/ig_cleanup_log.json`, özet WhatsApp'a (komut WhatsApp'tan
  geldiyse yanıtın kendisi). API reddederse link verilir (uygulamadan elle). Panel Instagram kartı "🗑 Düşük izlenenleri sil"
  (`POST /api/instagram/cleanup/plan`, `/run`).
- Otomatik Instagram temizliği (kullanıcı isteği, 17 Ekim: "5000 altında izlenen videoları otomatik silelim, sayıları panelde göreyim,
  değiştireyim, silinmeye adayları da göreyim"; kullanıcı kararları: YALNIZ Instagram, 72 saat bekleme; `settings.igAutoClean` {enabled true,
  maxViews 5000, waitHours 72, maxAgeDays 30, everyHours 3, keep []}): `ig_cleanup.py --auto-plan` → ready (bekleme dolmuş ve sınır altı),
  upcoming (sınır altı, karar saatini bekliyor, `hoursLeft`), kept (🛡 korunan), unknown (izlenme ölçülmemiş → silinmez). `server.js`
  `igAutoRun` her `everyHours`ta (10 dk'lık denetim): izlenmeler 30 dk'dan eskiyse senkron, ready → `--run` (silmeden hemen önce güncel izlenme
  yeniden okunur, sınırı geçen bırakılır); `data/ig_autoclean.json` {armedAt, lastCheck, lastRun, runs}. İLK AÇILIŞTA 2 saat inceleme süresi
  (`armedAt`; WhatsApp'a "2 saat sonra N video silinecek"). WhatsApp'a yalnız sonuç ("🗑 Instagram: N düşük izlenen video silindi") ve
  silinemeyenler. Panel Ayarlar → Yayın hesapları → Instagram kartının altında: anahtar, sınır/bekleme/en eski gün/kontrol aralığı kutuları,
  üç liste (silinecek / karar bekleyen / korunan; her satırda 🛡 Koru ya da Korumayı kaldır), "🔄 İzlenmeleri tazele", "🗑 Silinecekleri şimdi sil"
  (`ask()` onayı). `GET /api/igclean[?sync=1]`, `POST /api/igclean/run`, `POST /api/igclean/keep {name, keep}`; komutlar "silinecek videolar",
  "otomatik silmeyi kapat/aç" (`ig_autoclean`). YouTube/TikTok/Mac kopyası silinmez.
- WhatsApp komut listesi `app/help.js` (`HELP_TEXT`; "yardım", "komutlar"): yeni kural eklerken buraya da yaz. `commands.js` `norm`
  "ınstagram"ı "instagram"a çevirir (Türkçe küçük harfte I → ı; büyük harfle yazılan Instagram komutları tanınmıyordu).
- YouTube API kotası: günde 10.000 birim, bir yükleme ~1.600 → günde en fazla 6 yükleme.
- Günlük yükleme sınırı (YouTube `uploadLimitExceeded` = kanal sınırı, `quotaExceeded` = API kotası):
  `publish.py` platformu 3 saat beklemeye alır (`data/publish_hold.json`), videoyu `data/publish_queue.json`
  sırasına ekler ve `{"limit": true}` döner; post_pipeline 90 sn tekrarını yapmaz ("📤 youtube: sınır doldu —"),
  bekleme süresince yeni videolar API'ye gitmeden sıraya girer. `publish.py --flush` sırayı en yeni haberden
  yükler (24 saatten eski bayat haber atılır); post_pipeline her yayından sonra, panel saatte bir (üretim yokken)
  çağırır. `--status` YouTube için `holdUntil`/`queued` verir. Doğrulanmamış kanalın sınırı düşüktür
  (youtube.com/verify ile telefon doğrulaması sınırı yükseltir).
- YouTube kuralı (kullanıcı kararı, sınır yüzünden; `settings.youtubePolicy` {onlyValuable true, extraDailyMax 3,
  extraKeywords, regularAuto true}): 5 saatlik (düzenli: anlık ve günün özeti olmayan) her video YouTube bağlıysa
  autopublish anahtarı, zamanlayıcı ya da tam otomatik moddan bağımsız olarak onaysız YouTube'a gider (kullanıcı kararı;
  `post_pipeline.targets` "▶ 5 saatlik video" satırı, `whatsapp.js` aynı kuralla "onay" istemez); anlık/Mynet videoları yalnız DEĞERLİYSE
  ve günde en çok `extraDailyMax` tane (`data/youtube_extra.json`). Instagram/TikTok etkilenmez; elle yayın
  (panel, WhatsApp "onay") kurala takılmaz. Değer `scripts/news_value.py`: anahtar kelime grupları (can kaybı,
  kaza/afet, emekli/memur maaşı + asgari ücret, zam/fiyat/vergi, tatil/bayram/idari izin, kamu duyurusu:
  sınav/yasak, güvenlik, para ve destek: sosyal yardım/evde bakım/KYK burs/TOKİ/kredi kartı/dolar-altın rekoru/borsa
  çöküşü, sağlık ve gıda: salgın/zehirlenme/ilaç toplatma/hileli ürün, milli başarı: milli takım ve milli sporcu
  galibiyet/final/madalya, suç ve vahşet: cani/katil/vahşet/dehşet/boğdu/kaynar su/bıçakladı/darp/işkence/kadına-çocuğa
  şiddet/istismar/kaçırıldı/pompalı (kullanıcı kararı: bu tür haber hemen üretilir), kayıp ve arama, kesinti ve ulaşım
  (elektrik/su/doğalgaz kesintisi, yol kapanması, uçuş/sefer iptali, grev), hava ve doğa uyarısı (turuncu/kırmızı kod,
  şiddetli yağış/rüzgar, orman yangını, sağanak), yeni düzenleme (yürürlüğe girdi, ceza, ehliyet/pasaport, başvuru
  tarihi), büyük siyaset (erken seçim, kabine, görevden alma, kayyum, yetkili gözaltısı), dünya ve savaş, iş ve geçim
  (iflas, işten çıkarma, kira/konut/araç fiyatı, indirim), eğitim duyurusu (MEB / Milli Eğitim Bakanlığı geçen her haber dahil),
  destek ve af (kullanıcı kararı: KOSGEB, hibe, devlet desteği, vergi/prim/imar/ceza affı, af yasası, mahkum affı, infaz
  düzenlemesi, yargı paketi, tahliye, borç silme), resmi uyarı (kullanıcı kararı, 14 Ekim: "Vali Gül'den İstanbul için yeni uyarı" türü:
  vali/kaymakam/bakan/AFAD/emniyet/jandarma/belediye/itfaiye/İSKİ… ile uyar/duyur/tedbir/önlem/talimat/çağrı/genelge/acil aynı cümlede;
  "Vali ziyaret etti", "dikkat çeken proje" değerli değil; `prompts/anlik.md` önem 4; hashtag #uyarı), acı olay (kullanıcı kararı: "6 gün sonra doğum günüydü! Kahreden olay",
  "15 yaşındaki Murat'ın hayatı karardı" türü: kahreden, yürek yakan, hayatı karardı, kurtulamadı, "N gün sonra doğum günü",
  "N yaşındaki … öldü/yaralandı/kayboldu", toprağa verildi; SOFT'tan muaf), magazin ve ünlüler (kullanıcı kararı: "Ünlü oyuncu
  yeni dizisini tanıttı" türü de değerli: ünlü/oyuncu/şarkıcı/sanatçı/sunucu, dizi, film, albüm, klip, konser, evlilik/boşanma,
  aşk iddiası, Survivor/MasterChef; `prompts/anlik.md` bunlara en az 3 önem verdirir), Süper Lig ilk 5 (kullanıcı kararı: ilk 5
  takımın maç sonucu, transfer, teknik direktör… haberleri değerli; `scripts/standings.py` ESPN puan durumu `tur.1`, 12 saatlik
  önbellek `data/standings.json`, erişilemezse `settings.sports.topTeams` / büyük kulüpler; `settings.sports.topN` 5; panel ortak
  taramada ve pipeline'da tazeler, liste değişince log "⚽ Süper Lig ilk 5: …"; `news_value.top_team_hit` takım adı ya da lakabı
  (Cimbom, Kanarya, sarı-lacivertli, bordo-mavili…) + futbol bağlamı ister — Beşiktaş/Başakşehir ilçe, Galatasaray Lisesi
  yakalanmasın; SOFT'tan muaf; hashtag takım adı + #futbol); "adli olay" (operasyon/gözaltı/uyuşturucu…)
  ağırlık 2: tek başına yetmez, başka grupla değerli olur. Kullanıcı kararı: değerli haber kaçmasın. SOFT koruması artık
  yalnız sıradan kulüp/spor haberi (futbolcu, teknik direktör, transfer, Süper Lig, maç) için: o kelimeler varsa yalnız
  model 4-5 derse değerli; can kaybı, milli başarı, suç ve vahşet, kayıp ve arama, dünya ve savaş, acı olay, magazin muaf; "burs" ve
  piyasa desenleri Bursa'yı ve sıradan kur haberini yakalamayacak şekilde dar) +
  `prompts/anlik.md`in istediği `importance` 1-5 (4-5 her zaman değerli, 1-2 anahtar kelimeyi geçersiz kılar).
  `assemble_script.news_value()` meta'ya `value` yazar; fragman analizinde (`TRAILER=1`) `sinema_value` olay gruplarını (can kaybı,
  kaza/afet, güvenlik, suç ve vahşet, kayıp ve arama, dünya ve savaş, acı olay, adli olay) gerekçeden ve hashtag'den atar (fragmanın
  konusu gerçek olay değil), tüm hook/haber segmentleri sinemaysa "magazin ve ünlüler" sayar (önem 1-2 değilse değerli); fragman
  dışında sinema etiketli haberde uygulanmaz (setteki gerçek kaza #kaza alır). `post_pipeline.youtube_allowed()` karar verir ("⭐ değerli
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
| sinema    | SİNEMA    | #E040FB     | çarpan klaket, kayan film şeridi, projeksiyon ışığı | sfx/sinema.wav (klaket + projektör) |
| trend     | VİRAL     | #FF2D55     | telefon, artan izlenme sayacı, kalpler, yükselen grafik + alev | sfx/trend.wav (pop + parıltı) |
| mizah     | VİRAL     | #C6FF00     | zıplayan göz kırpan gülen yüz, konfeti, yıldız | sfx/mizah.wav (yay sesi) |
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
  Claude'un seçimine bakılmaksızın `asayis` olur (`ASAYIS_MUAF`: dunya/hava/sinema hariç; sinema: fragman ya da filmin konusu gerçek
  olay değildir). Fragman analizinde (`TRAILER=1`) hiç zorlanmaz; fragman dışında sinema etiketli haber gerçek zarar anlatıyorsa
  (`GERCEK_OLAY`: hayatını kaybet-, can verdi, şehit, öldü — "öldürdü" değil —, ölü, öldürül-, yaralan-, yaralı, gözaltı, tutuklan-,
  kaçırıl-, rehin; ekli ve edilgen biçimler: "oyuncu öldü", "2 yaralı", "yaralanarak", "bıçaklanarak öldürüldü"; etken fiil — "filmde
  katil kurbanını öldürdü", filmin konusu — sayılmaz) yine asayis olur. Tek konulu anlık videoda (`ANLIK=1`, çoklu değil) karar olay
  başınadır (`real_story`): bir sinema kartı gerçek zarar anlatıyorsa aynı olayın diğer sinema kartları da asayiş olur ("Dizi setinde
  yangın: 3 kişi yaralandı" + "İtfaiye yangını söndürdü" ikinci kartta klaketli SİNEMA olmasın). Zararsız set kazası ("dekor devrildi,
  kimse zarar görmedi") ve çoklu son dakikadaki ayrı film haberi sinema kalır. Şehit haberi asla siyaset değildir.
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
- UI'da tarayıcının `confirm()`/`alert()`'i KULLANILMAZ: Chrome "bu sayfanın ek iletişim kutularını engelle" işaretlenince
  confirm sessizce false döner ve yayın/sil düğmeleri hiçbir şey yapmıyor görünür (video penceresi düğmeleri "çalışmıyor" şikâyetinin en olası nedeni). Onay için
  sayfa içi `await ask(metin)` (Enter evet, Esc vazgeç), bildirim için `toast()`. `window` error/unhandledrejection
  dinleyicileri JS hatalarını sohbete ve toast'a yazar.
- Önizleme: `npm run studio`. Sessiz hızlı test: `TTS_ENGINE=silent bash pipeline.sh`.
- `out/`, `work/`, `public/audio/`, `voices/*.onnx` git'e girmez.
