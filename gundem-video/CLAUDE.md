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
  bandı, "SON 5 SAATİN", TÜRKİYE GÜNDEMİ, ortada gün + yıl, "N. 5 SAAT" + saat aralığı; altta YouTube/Instagram/
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
  girmiş haberleri eler (yeterli yeni haber yoksa `e:1` ile geri ekler), p → c → yenilik sırasıyla en iyi
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
  (`captions.autoInstall: false` kapatır; `work/.align_install.json`). `Captions.tsx` vurguyu 0,06 sn önde gösterir; bipli segmentte parçaların
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
  Altyazı TEK ve BÜYÜK kelime (kullanıcı kararı, 14 Ekim; önceki 3 kelimelik grup kaldırıldı; `src/captionGroups.ts currentWord`):
  ekranda yalnız o an söylenen kelime, söylendiği anda belirir (0,1 sn'de büyür), bittikten 0,18 sn sonra kalkar; duraklamada ekran
  boş (söylenmeyen kelime gösterilmez). Kategori renginde kutu, Shorts'ta `size × 1,7` punto (`fitFontSize` tek satır, en az 48 px),
  yatayda 76 px. Altyazı kaydırma `settings.captions.leadSec` (varsayılan 0,06 sn önde; panel Ayarlar → Gelişmiş "🔤 Altyazı
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
  en iyi 4 doğrudan sayfa paralel okunur. Ana haber konu metni + kaynak (ANLIK_SOURCE/URL) olur, diğerleri
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
    depremde `breaking_watch --mark` (aynı depremin haberi ikinci video olmasın). Görülenler `data/quake_seen.json`. İki kaynak da
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
  ilk mesaj talimat olur ("iptal" vazgeçer; yayın onayı "onay/iptal" önce işlenir). 8 sn içinde arka arkaya gelen videolar (albüm,
  en çok 4) TEK haberde birleşir. `wa_video.py`: her video için ffprobe, sahne geçişleri (`select gt(scene,0.3)`), konuşma dökümü
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
  haber yap"; `commands.js` `social_video` kuralı — instagram.com/reel|p|tv, tiktok, x/twitter status, youtube shorts/watch/youtu.be,
  facebook reel/watch/videos, fb.watch; linkin dışındaki metin talimat —, `server.js socialVideoNews` → `runVideoNews`,
  `scripts/social_video.py`): yt-dlp (≤1080p mp4, ≤10 dk `duration <? 600` — süresi bilinmeyen de geçer, ≤300 MB, `--write-info-json`)
  `work/wa_inbox/`a indirir; açıklama, hesap (`credit` "Instagram / @hesap"), izlenme/beğeni/tarih okunur. Instagram çoğu zaman
  girişsiz vermez: `secrets/social_cookies.txt` ya da `settings.social.cookiesFromBrowser` (panel 📡 "Sosyal medya çerezleri") →
  `--cookies-from-browser`; giriş hatasında Türkçe yol gösterir. Aynı olay `news_lookup.py --topic` (açıklamanın ilk 10 anlamlı kelimesi)
  ile haber sitelerinde aranır → `related`. Montaj planına `kaynak_paylasim` + `ilgili_haberler` gider (`prompts/montaj.md`: açıklama
  doğrulanmamış iddia, "sosyal medyada paylaşılan görüntülerde…"; haber sitesindeki bilgi esas; videonun tamamı değil seçilmiş kısa
  parçalar). Her kartın kaynağı `credit` (zorla), ANLIK_SOURCE/URL ile açıklamada "Haber kaynağı: Instagram / @hesap · link". Yayın
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
  soru) senaryoya yazar, sosyal medya görüntüsünde altına "📹 Görüntü: Instagram / @hesap" eklenir; yayın (otomatik ya da "onay") diğer
  videolar gibi YouTube/Instagram'a ilk yorumu yazar, yazılamazsa `fill_first_comments` sonradan tamamlar. WhatsApp "onay" yanıtı platform
  başına "💬 ilk yorum yazıldı / yazılamadı (neden)" der (`commentNote`); panel `publish` eylemi "  💬" satırlarını loga taşır.
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
  ya da ≥ minSources sitede. `data/breaking_produced.json` (assemble_script her anlık üretimde, panel üretime
  alırken `--mark` yazar) son 12 saatte aynı olayın ikinci videosunu engeller; Mynet `dup` ile aynı kuralı kullanır.
  `ANLIK_SOURCE_COUNT` assemble'a gider: 3+ kaynak YouTube için değerli sayılır, açıklamaya "N kaynakta" eklenir.
  Panel kartı "🗞 SON DAKİKA KAYNAKLARI" (kaynak durumu, son haberler, şimdi kontrol et, aç/kapat), `GET /api/breaking`,
  `POST /api/breaking/check`; günlük sayaç `data/breaking_daily.json`. Son haberlerin her birinde ⭐ (değerli),
  "N sitede" ve "🎬 Video üret" düğmesi (`--list` her habere valuable/sources/produced ekler): `POST /api/breaking/produce
  {link, force}` haberi kayıttan bulur (`--item LINK`; başlık/özet istemciden alınmaz), sayfayı okur, otomatik adayla
  aynı `startAnlik` yolu (anlikAutoPublish ile bağlı hesaplara yayın, YouTube değer kuralı geçerli), `--mark` yazar.
  Elle üretim günlük sınırı tüketmez ve ona takılmaz; aynı olay 12 saat içinde üretildiyse düğme "✓ Üretildi" olur,
  basılırsa onay sorup `force` ile yine üretir.
- Ortak tarama (kullanıcı kararı: iki kaynak eşit aralıkla): `watchScan()` her `settings.watchIntervalMin` (varsayılan 5,
  3-60) dakikada önce Mynet'i, hemen ardından son dakika sitelerini tarar; `mynet.intervalMin`/`breaking.intervalMin`
  artık kullanılmaz (cfg'de `watchMin()` döner, kartlarda aynı sayı). Tarama sürerken `flushValuable` 3 sn'de bir bekler,
  böylece iki kaynaktan aynı anda düşen değerli haberler aynı partiye girer.
- Değerli manşet toplayıcı (kullanıcı kararı: değerli manşet beklemeden, sistem dinlenmede olsa da üretilir): Mynet ve
  son dakika taramaları dinlenmede de çalışır (hafif). Otomatik DEĞERLİ haber (`item.valuable` / `c.valuable`) doğrudan
  üretilmez, `queueValuable()` ile 20 sn (`VALUE_BATCH_MS`) biriktirilir; aynı olay iki kaynaktan gelirse `sameEvent()`
  (5 harflik kökler, ≥3 ortak ya da ≥2 ve %50) tek haber sayılır. `flushValuable()`: dinlenmedeyse `restEnd("değerli haber
  düştü…")`, 1 haber → tek konulu `startAnlik`, 2-3 haber → `startAnlikMulti()` tek video (süre 30 + 15/ek haber: 2 → 45 sn,
  3 → 60 sn; fazlası sonraki partiye). Çoklu: `work/anlik_items.json` [{source, url, title, text}] + `ANLIK_MULTI=n`;
  `topic_news` prompt'a `coklu_haberler` koyar, `prompts/anlik.md` "ÇOKLU SON DAKİKA" kuralı her habere segment ve
  `item` numarası yazdırır, pipeline HABER ≥ n (≤ 6), `assemble` her hook/haber segmentine kendi haberinin sayfasını
  (`articleUrl`) ve kaynağını verir (`item` yoksa başlık kelimeleriyle eşler), meta `sources`, açıklamada "Haber
  kaynakları:" listesi, her haber `mark_produced`. Kuyrukta `{multi}` girdisi. Dinlenmede SIRADAN manşet/aday üretilmez
  (logda "⏸ … değerli haber gelirse sistem kendiliğinden başlar").
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
  `PRONOUNCE` (Mynet → Maynet, PKK → Pekaka, TV → Teve — "tivi" okunmasın; ATV → Ateve, NTV → Enteve, bitişik sayı ayrılır: TV8 → Teve sekiz; ekler korunur, büyük harf kısaltmada bitişik ek de: PKKlı → Pekakalı) + `settings.pronunciations` {"Kelime": "Okunuş"}; değiştirince
  `server.js` `PRON_VER`'i artır (konuşma önbelleği anahtarına girer, eski okunuşlu sesler kullanılmaz). Emixhas'ın konuşması (`speak.py`) `voice.engine` kimliğini ya da auto'da hızlı sırayı
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
- Diğer mesajları ÖNCE Claude anlar (kullanıcı isteği, 14 Ekim: "WhatsApp'tan gönderdiğim mesajları Claude alsın, ne demek istediğimi
  anlasın, yapsın"; `server.js smartWhatsApp`, `settings.whatsapp.smart`, panel WhatsApp grubunda 🧠 anahtar): `handleCommand(text,
  {source: "whatsapp"})` → `think(text, "chat", {channel: "whatsapp"})`. Beyin prompt'una `HELP_TEXT` "KOMUT LİSTESİ" olarak girer;
  yeni eylem `{"type":"command","text":"…"}` kural motorundaki herhangi bir komutu çalıştırır (`execAction` → `handleCommand(text,
  {direct: true})`; kural yoksa "Bu komutu tanımadım", beyne geri dönmez), komutun yanıtı/raporu beyin yanıtının altına eklenir.
  Kurallar: soru → eylemsiz cevap (gerekirse yalnız okuma komutu), geri dönüşsüz onay adımı ("evet sil") açıkça yazılmadıkça yok.
  Hızlı yol (Claude'a gitmez): link içeren mesaj (haber/sosyal medya videosu + saat), yayın onayı/iptali ve video talimatı (whatsapp.js
  önce işler), tek kelimelik kesin komutlar (`WA_DIRECT`: yardım, durum, iptal, evet sil…). Claude'a ulaşılamazsa eski kural yolu.
  Claude düşünürken WhatsApp'ta "yazıyor…" görünür (`sendPresenceUpdate`). Yanıt ~10-20 sn sürer.
- Gönderen tanıma (komutlar sessizce kaybolmasın): WhatsApp'ın yeni LID kimliğinde 1'e 1 sohbet `…@lid` gelir, numara
  `key.senderPn`'dedir; `isOwner` LID'i telefon sanmaz. Sahip: senderPn/participantPn/remoteJid telefonu eşleşen,
  ya da bilinen sahip LID'i (`learnOwnerLid`: bağlanınca `sock.onWhatsApp(ownerJid)` ile öğrenilir, senderPn ile
  eşleşince de eklenir), ya da bağlı numaranın KENDİNE-MESAJ sohbeti (fromMe + kendi numara/LID; telefondan "append"
  gelebilir). Bağlı numaranın başka sohbetlere yazdıkları ve 5 dk'dan eski mesajlar işlenmez. Gönderdiğimiz her mesajın
  kimliği `sentIds`te (kendine-mesajda yanıt döngüsü olmasın). Yanıt her zaman telefon jid'ine (LID'e değil). Sahip
  olmayan göndericiden gelen mesaj dakikada bir loga "💬 WhatsApp: sahip olmayan göndericiden mesaj yok sayıldı (…son 4
  hane / numara gizli)" yazar; `status().lastIgnored`.
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
  count 3, duration 30, leadMin 20, minViews 10, defaultHours [12, 18, 21], fromHour 8, toHour 23, minGapHours 3, minVideos 12,
  minPerHour 2}): `--plan` son `windowDays` (7, kullanıcı kararı 14 Ekim; o pencerede 12 video yoksa tüm geçmiş) günün Shorts videolarının yayın saatine göre izlenme ortalaması (komşu saatlerle yumuşatılmış; yalnız kendi
  verisi ≥2 video olan saat aday; 24 saatten genç videolar sayılmaz), en iyi 3 saat aralarında ≥3 saat; veri azsa varsayılan
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
  log "🔥 VİRAL", ses, WhatsApp. Video yayınlandıktan SONRA düşmüş, aynı olaya ait, üretilmemiş yeni haber varsa
  (`breaking_watch.recent_items`) devam videosu `queueValuable` ile üretilir (dinlenmeyi bozar); yeni bilgi yoksa üretilmez.
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
- Disk temizliği (`scripts/cleanup.py`, her gece 04:10, `settings.cleanup` {enabled, days 30}): `days`'ten eski ve en az
  bir platformda yayınlanmış (yayınlanmamışsa 2×days) videonun yalnız mp4'ü silinir; json'a `archived` yazılır, kapak,
  metrik ve platformdaki video kalır. Demo/test (adı rakamla başlamayan) ve YouTube sırasındaki videolar silinmez.
  `analyze.video_rows` arşivlenmiş videoları da sayar (panel listesinde mp4 olmadığı için görünmezler). Ayarlar →
  Otomasyon anahtar + "🧹 Şimdi temizle" (önce `--dry-run` ile ne silineceğini sorar), `POST /api/cleanup {dryRun}`.
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
- UI'da tarayıcının `confirm()`/`alert()`'i KULLANILMAZ: Chrome "bu sayfanın ek iletişim kutularını engelle" işaretlenince
  confirm sessizce false döner ve yayın/sil düğmeleri hiçbir şey yapmıyor görünür (video penceresi düğmeleri "çalışmıyor" şikâyetinin en olası nedeni). Onay için
  sayfa içi `await ask(metin)` (Enter evet, Esc vazgeç), bildirim için `toast()`. `window` error/unhandledrejection
  dinleyicileri JS hatalarını sohbete ve toast'a yazar.
- Önizleme: `npm run studio`. Sessiz hızlı test: `TTS_ENGINE=silent bash pipeline.sh`.
- `out/`, `work/`, `public/audio/`, `voices/*.onnx` git'e girmez.
