"""Ortak yardımcılar: veri dosyaları, .env, zaman."""
import json
import math
import os
import re
import ssl
import unicodedata
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
SECRETS = ROOT / "secrets"

# python.org Python'u macOS sertifika deposunu görmez; certifi varsa tüm urllib çağrıları onu kullansın
# (Instagram/TikTok/YouTube API'leri ve RSS). Bu modülü içe aktaran her betik için geçerli.
try:
    import certifi
    _ctx = ssl.create_default_context(cafile=certifi.where())
    urllib.request.install_opener(urllib.request.build_opener(urllib.request.HTTPSHandler(context=_ctx)))
    os.environ.setdefault("SSL_CERT_FILE", certifi.where())
except Exception:
    if os.path.exists("/etc/ssl/cert.pem"):  # certifi yoksa macOS'un kendi sertifika deposu
        os.environ.setdefault("SSL_CERT_FILE", "/etc/ssl/cert.pem")
OUT = ROOT / "out"
DATA.mkdir(exist_ok=True)


def load_json(path: Path, default):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except Exception:
        return default


def save_json(path: Path, obj):
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    tmp = Path(str(path) + ".tmp")
    tmp.write_text(json.dumps(obj, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(path)


def load_env():
    env = {}
    p = SECRETS / ".env"
    if p.exists():
        for line in p.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                env[k.strip()] = v.strip().strip('"').strip("'")
    env.update({k: v for k, v in os.environ.items() if k.startswith(("IG_", "TIKTOK_")) or k == "PUBLIC_BASE_URL"})
    return env


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def metrics():
    return load_json(DATA / "metrics.json", {"videos": {}})


def save_metrics(m):
    save_json(DATA / "metrics.json", m)


def _deep_merge(a, b):
    out = dict(a)
    for k, v in (b or {}).items():
        out[k] = _deep_merge(a.get(k, {}), v) if isinstance(v, dict) and isinstance(a.get(k), dict) else v
    return out


def settings():
    return _deep_merge(_DEFAULTS, load_json(DATA / "settings.json", {}))


_DEFAULTS = ({
        "autopublish": {"youtube": False, "instagram": False, "tiktok": False},
        "dailyReportHour": 9,
        "metricsSyncMinutes": 20,
        "channelName": "Türkiye Gündemi",
        "hashtags": "#gündem #haber #türkiye #sondakika #shorts",
        "assistantName": "Emixhas",
        "wakeWords": ["emixhas", "emiks has", "emiks", "emix", "emixas", "emikhas", "emihas", "e mix has", "emiş has", "emişhas"],
        "fullAuthority": True,
        "voice": {"engine": "auto", "name": "Yelda", "rate": 195, "piperLength": 0.85, "piperNoise": 0.5},
        "narrationEngine": "auto",
        # Video anlatım sesi: single → voice; alternate → kanca/1./3. haber voiceA, intro/2./4. haber voiceB (scripts/voices.py)
        "narration": {"mode": "single", "voice": "auto", "voiceA": "vox-kadin", "voiceB": "vox-erkek", "femaleGainDb": 3, "maleGainDb": 0},
        "claudeModel": "opus",
        # Anlık (son dakika) video bitince bağlı tüm hesaplarda onaysız paylaşılsın
        "anlikAutoPublish": True,
        # YouTube günlük yükleme sınırı: otomatik (5 saatlik) üretimler her zaman; anlık/Mynet videoları yalnız
        # değerliyse (scripts/news_value.py) ve günde en çok extraDailyMax tane. Elle yayın bu kurala takılmaz.
        "youtubePolicy": {"regularAuto": True, "onlyValuable": True, "extraDailyMax": 3, "extraKeywords": []},
        # Mynet manşet takibi (scripts/mynet_watch.py, panel her intervalMin dakikada kontrol eder)
        "mynet": {"enabled": True, "url": "https://www.mynet.com/", "count": 6, "intervalMin": 30, "maxPerDay": 3, "duration": 30},
        # Haber medyası: tam boy fotoğraf her zaman; video (yt-dlp, haber sayfasından) açılıp kapatılabilir
        "media": {"video": True, "maxVideoSeconds": 20, "allowYoutubeEmbeds": True},
        "claudeEffort": {"script": "medium", "brain": "high", "chat": "low"},
        "formats": {
            "sabah": {"hours": [5, 11], "duration": 45, "label": "Güne Başlarken", "intro": "Güne başlarken Türkiye gündemi.", "tone": "sakin, bilgilendirici, günün ajandasını kuran"},
            "ogle": {"hours": [11, 17], "duration": 30, "label": "Son Dakika", "intro": "Son dakika, Türkiye gündemi.", "tone": "hızlı, net, en yeni gelişmeler öncelikli"},
            "aksam": {"hours": [17, 29], "duration": 90, "label": "Günün Özeti", "intro": "Günün özeti, Türkiye gündemi.", "tone": "toparlayıcı, günün en önemli olaylarını sıralayan"},
        },
        "musicVolume": 0.07,
        "scheduleHours": 5,
        "chatterbox": {"port": 3139, "refVoice": "voices/ref.wav", "exaggeration": 0.4, "cfg": 0.55, "autoStart": False},
        # Türkçe doğal ses: Trendyol-TTS (VoxCPM2 tabanlı, MIT) + EMA Lightning (Apache-2.0). Kurulum: scripts/install_turkish_voice.sh
        "turkishVoice": {"python": ".venv-tr/bin/python", "trendyolBin": ".venv-tr/bin/trendyol-tts", "mlxModel": "models/Trendyol-TTS-mlx",
                         "torchModel": "Trendyol/Trendyol-TTS", "baseModel": "openbmb/VoxCPM2", "backend": "auto", "cfg": 2.0, "steps": 16, "seed": 42, "refVoice": "", "emaSpeed": 1.0},
    })


def pick_format(hour: int | None = None):
    """Saate göre format: sabah 05-11, öğle 11-17, akşam 17-05."""
    from datetime import datetime
    h = datetime.now().hour if hour is None else hour
    for key, f in settings()["formats"].items():
        lo, hi = f["hours"]
        if lo <= h < hi or lo <= h + 24 < hi:
            return key, f
    return "aksam", settings()["formats"]["aksam"]


# Uzun video özeti (kullanıcı isteği, 19 Ekim: "uzun bir YouTube videosu göndersem bunu analiz edip 40 saniyelik habere dökebilir
# miyiz, videodan çarpıcı sahneleri de alarak"): settings.longSummary. Nesne değilse varsayılan (false → kapalı); sayı alanı bozuk ya
# da 0 → varsayılan (maxSoundSeconds 0 = orijinal ses yok). server.js longSummaryCfg() ve panel aynı kural.
SUMMARY_DEFAULTS = {"enabled": True, "auto": True, "duration": 40, "minSeconds": 600, "maxSoundSeconds": 8, "maxSeconds": 3 * 3600}
# süre (server.js SURE_RE ve wa_video.SURE_RE ile aynı kural): "40 saniyelik", "40 sn", "1 dakikalık"; ekli sayı ("ilk 15 saniyeyi kes") değil
SURE_RE = re.compile(r"(?:(\d{2,3})\s*(?:saniye(?:lik|de|ye)?|sn)|(\d{1,2})\s*(?:dakika(?:l[ıi]k|da|ya)?|dk))(?!\w|['’](?:y[ıi]|d[ae]n|t[ae]n))")


def _off(v) -> bool:
    return v is False or v == 0 or str(v).strip().lower() in ("false", "0")


def summary_cfg() -> dict:
    raw = settings().get("longSummary")
    s = raw if isinstance(raw, dict) else {"enabled": False} if raw is not None and _off(raw) else {}

    def num(k: str) -> float:
        try:
            x = float(s.get(k))
        except (TypeError, ValueError):
            return float(SUMMARY_DEFAULTS[k])
        return x if math.isfinite(x) and (x > 0 or (k == "maxSoundSeconds" and x == 0)) else float(SUMMARY_DEFAULTS[k])
    return {**s, "enabled": not _off(s.get("enabled", True)), "auto": not _off(s.get("auto", True)),
            **{k: num(k) for k in ("duration", "minSeconds", "maxSoundSeconds", "maxSeconds")}}


# "45 dakikalık programı 40 saniyede özetle": kaynak videonun uzunluğu özetin süresi değildir
_SOURCE_NOUN = re.compile(r"\s*(?:bir\s+)?(?:video|program|konuşma|röportaj|açıklama|yayın|kayıt|belgesel|maç|toplantı|oturum|bülten|sohbet|tartışma|film|dizi|bölüm)")


def summary_secs(instruction: str) -> int:
    """Özet videosunun süresi: talimattaki "N saniye" (önce), yoksa "N dakika" (kaynak videoyu niteleyen "45 dakikalık program" değil),
    yoksa longSummary.duration (40); 20-60 sn."""
    t = str(instruction or "").replace("I", "ı").replace("İ", "i").lower()
    found = list(SURE_RE.finditer(t))
    sec = next((m for m in found if m.group(1)), None)
    mins = [m for m in found if m.group(2) and not _SOURCE_NOUN.match(t, m.end())]
    n = int(sec.group(1)) if sec else int(mins[-1].group(2)) * 60 if mins else int(summary_cfg()["duration"])
    return max(20, min(60, n))


# Video türü (kullanıcı isteği, 19 Ekim: "bazen mizah, bazen normal sosyal medyada çok izlenen video linkleri gönderiyorum, bunları da son
# dakika diye haber yapıyor; link/mizah yazınca mizah kategorisine göre üretilsin, link/trend"). Tür yalnız AÇIK etiketten: linke bitişik
# etiket (commands.js → job.kind, buraya hiç gelmez), talimatın yalnız etiketten oluşması ("mizah", "#trend", "viral"; yanında yalnız yayın
# fiili, süre ya da dolgu kelimesi: "mizah 40 saniye", "bunu mizah olarak paylaş" — commands.js KIND_FILL; mizah/komik/viral/trend yanında
# "yap"/"olsun" da: "mizah yap", "trend olsun" — KIND_DO; "viral olsun" çağrıdır, değil), başta ayraçla etiket ("mizah, kısa kes"; ardından
# başka etiket gelirse seçim açık bırakılmıştır: "haber, mizah, viral fark etmez"), sonda işaretten sonra yalın etiket ("Adam düştü 😂 mizah"),
# #etiket ya da açık ifade ("mizah videosu", "mizah olarak", "komik bir video", "viral video", "çok izlenen video"). Açık haber isteği
# (news_request) hep haber. Etiket yoksa "" (kurgu planında Claude karar verir). Harfsiz/büyük harf yazım aynı ("MIZAH", "_mizah_").
# server.js contentKindOf / newsRequest aynı kural.
# ÖNCE KESİNLİK (inceleme, 19 Ekim): eski kalıplar kara listeydi (tetik kelime + bilinen kötü devam yoksa her devam sayılıyordu) ve her
# incelemede yeni yanlış tetik çıkıyordu ("haber yaparken düşen muhabir", "son dakika golü" haber; "komik video sanılan görüntüler",
# "kavganın viral videosu" mizah/viral). Artık tetik yalnız ardından AÇIK İSTEK BİÇİMİ gelirse sayılır (beyaz liste). Kaçırılan serbest metin
# isteği ucuzdur (link/mizah, link/trend, link/haber etiketi var, sahip yeniden yazabilir; etiketsiz videoda türü Claude içerikten seçer);
# yanlış tetik pahalıdır (mizah videosu haber olur, ret SON DAKİKA üretir).
KIND_WORDS = {"mizah": "mizah", "mizahi": "mizah", "komik": "mizah", "trend": "trend", "viral": "trend", "haber": "haber"}
_KL = r"[^\W\d_]"  # harf (rakam ve _ ayraç: "_mizah_")
_KS = r"(?:[^\w\s'’]|_)"  # işaret: harf, rakam, boşluk ve kesme işareti dışı her karakter (noktalama, tire, emoji, #, ²…; server.js KIND_SIGN)
_T = rf"[^\S\n]*(?:$|\n|{_KS})"  # ifade sonu: metin ya da satır sonu, işaret ("mizah videosu 😂", "son dakika:"; "son dakika'yı" değil)
# olumsuz fiil eki (kind_fold'lu metinde, fiil kökünden hemen sonra; commands.js VERB_NEG aynı kalıp; yalnız ret ve dolguda kullanılır):
# yapma, yapmayın(ız), yapmasın, yapmasana, yapmadan, yapmaz, yapmam(alı), yapmayan, yapmayız, yapmayacak (konuşma dilinde yapmayacaz/
# yapmayacam/yapmayacan), yapmayalım, yapmıyor, yapmıcaz/yapmıycaz/yapmıcan
VERB_NEG = rf"m(?:[ae](?:yin(?:iz)?|sin|s[ae]n[ae]|d[ae]n|z|m(?:[ae]li)?|y[ae]n|y[iu]z|y[ae]c[ae][kgmnz]{_KL}*|y[ae]lim)?(?!{_KL})|[iu](?:yor|y?c[ae][kgmnz]){_KL}*)"
# etiketin yanında sayılan dolgu (commands.js KIND_FILL aynı): süre birimi, lütfen/olarak/bunu/şunu, yayın fiili (olumsuzu değil); haber
# dışındaki etiketin yanında "yap"/"olsun" da (KIND_DO: "mizah yap", "trend olsun"; "haber yap" zaten haber isteği; "viral olsun" değil)
_KIND_FILL = re.compile(rf"saniye|saniyelik|sn|dakika|dakikalik|dk|lutfen|olarak|bunu|sunu|at|atar|misin|"
                        rf"(?:paylas|yayinla|yayimla|gonder|yukle)(?!{VERB_NEG}){_KL}*")
_KIND_DO = re.compile(r"yap(?:in(?:iz)?|sana|alim|sin|ar|abilir)?|olsun")
# İSTEK BİÇİMİ (fiil kökünden hemen sonra; haber isteği, tür ifadesi, fragman isteği ve benzer video aynı liste, server.js REQ_FORM aynı
# metin): yap, yapın(ız), yapsana, yapalım, yapsın(lar), yapar mısın(ız)/mıyız, yapabilir misin/miyiz, yapabilirsin, yapıver(sene/in/ir
# misin), yapmalısın(ız), yapacaksın/yapcan/yapıcan, yapacaz/yapcaz/yapıcaz (konuşma dilinde "yapacağız": "haber yapcaz bunu"),
# yapmak/yapmanı/yapmasını istiyorum (isterim, rica ediyorum, sağla(yın/r mısın/yabilir miyiz)), yapmak/yapması/yapman(ız) lazım (gerekir,
# gerek, şart: "haber yapman lazım bunun"), yapsan iyi olur;
# -ıp yalnız ardından (en çok bir ara kelimeyle) istek biçiminde fiil gelirse ("çizip paylaş", "yapıp bana gönder"). Listede olmayan her
# biçim istek DEĞİL: olumsuz (yapma), ortaç (yapan, yaparken, yaptığı), geçmiş (yaptı), geniş zaman (yapar), ad (yapımı, çekimi), "yapmak
# yerine", "yapmayı bırak", "yapmaktansa", "yapmak zorunda değil", "yapmamız gerekmiyor"; üçüncü kişi/biz gereklilik görüştür, istek değil
# (inceleme, 19 Ekim: "Medya haber yapmalı", "TRT bunun benzerini yapmalı", "Hoca: bu tarzda içerik üretmeliyiz", "haber yapmalı mı?")
_WANT = (r"(?:istiyoru[mz]|isterim|isteriz|rica\s+ediyoru[mz]|rica\s+ederi[mz]|"
         r"sagla(?:yin(?:iz)?|r\s*m[iu]s[iu]n(?:[iu]z)?|yabilir\s*m[iu](?:s[iu]n(?:[iu]z)?|y[iu]z))?)")
_NEED = r"(?:lazim|gerekir|gerekiyor|sart|gerek(?![a-z])(?!\s+(?:yok|d(?:egi|ii|ei)l)(?![a-z])))"  # "gerek yok" ret
_ASK_V = (r"(?:anlat|yap|hazirla|uret|sun(?!un(?![a-z]))|yaz|paylas|kurgula|ver|yayinla|yayimla|goster|cek|at|gonder|yukle|isle|seslendir|"
          r"oku|cevir|donustur|olustur|canlandir|tasarla|ciz|koy(?!un(?![a-z]))|ekle|kullan|tut|ozetle|duzenle)")  # istek/yayın fiili kökleri ("koyun", "şunun" ad)
_REQ1 = (r"y?[iu]n(?:[iu]z)?|s[ae]n[ae]|y?[ae]l[iu]m|s[iu]n(?:l[ae]r)?|[aeiu]?r\s*m[iu](?:s[iu]n(?:[iu]z)?|y[iu]z)|"
         r"y?[ae]bilir(?:\s*m[iu](?:s[iu]n(?:[iu]z)?|y[iu]z)|s[iu]n(?:[iu]z)?)|y?[iu]ver(?:s[ae]n[ae]|[iu]n(?:[iu]z)?|[iu]r\s*m[iu]s[iu]n(?:[iu]z)?)?|"
         r"m[ae]l[iu]s[iu]n(?:[iu]z)?|y?[aeiu]?c[ae](?:ks[iu]n(?:[iu]z)?|n|z|k\s*m[iu]s[iu]n(?:[iu]z)?)|"
         rf"m[ae](?:k|n[iu]|s[iu]n[iu])\s+{_WANT}|m[ae](?:k|s[iu]|n(?:[iu]z)?)\s+{_NEED}|"
         r"s[ae]n(?:[iu]z)?\s+(?:iyi|guzel|harika|super)\s+olur")
_REQ = rf"{_REQ1}|y?[iu]p\s+(?:(?:bana|bize|hemen|sonra|lutfen|da|de)\s+)?{_ASK_V}(?:{_REQ1})?"
_PASS_OPT = r"(?:[iu]l|n)s[iu]n(?:l[ae]r)?"  # edilgen istek: yapılsın, hazırlansın
# + yapılacak, yapılması lazım; "yapılmalı" görüş, "yapılacak mı?" soru, istek değil
_PASS = rf"(?:[iu]l|n)(?:s[iu]n(?:l[ae]r)?|[ae]c[ae]k(?!\s*m[iu](?![a-z]))|m[ae]s[iu]\s+{_NEED})"
# dolgu/süre kelimesi ("mizah videosu 40 saniye", "haber olarak 30 sn", "18:30'da"); ardından ifade sonu gelirse sayılır. Sayıdan sonraki
# boşluk yalnız birimle birlikte alınır (ölçüm, 19 Ekim: "1" + 100 boşluk + "1"… sayının boşluğu yutup yutmaması her sayıda iki yol
# açıyordu; 300 karakterlik metin 9 sn sürüyordu)
_FILLTOK = (rf"(?:[0-9]+(?:[.,:][0-9]+)*(?:\s*(?:['’]{_KL}+|(?:saniye|sn|dakika|dk){_KL}*))?|saniye{_KL}*|sn|dakika{_KL}*|dk|lutfen|bunu|sunu|"
            rf"hemen|olarak)(?!{_KL})")
_TO_END = rf"(?:\s+{_FILLTOK}){{0,4}}{_T}"
# metnin SONUNA kadar yalnız işaret, satır sonu ve (en çok dört) dolgu/süre: "fragman: 40 saniye", "fragman 🎬"; işaretten sonra cümle
# başlarsa ifade sonu değil ("Gerçek hayattan fragman: Kartal tilkiyi havada yakaladı", "Güzel bir haber olarak, kedimiz…"; inceleme,
# 19 Ekim). Her parça tek yoldan eşleşir (işaret tek tek, dolgu önünde boşluk ya da işaret), uzun girdide geri izleme patlamaz
_SIGN_END = (rf"(?:[^\S\n]*(?:{_KS}|\n))*(?:(?:[^\S\n]+|(?<!{_KL})(?<![0-9])){_FILLTOK}(?:[^\S\n]*(?:{_KS}|\n))*){{0,4}}[^\S\n]*$")
# virgül, noktalı virgül, iki nokta, tire ya da satır sonundan sonra en çok dört kelime (ardından istek fiili gelmeli: "fragman, kısa olsun",
# "fragman - orijinal sesini kullan", "haber gibi, özetle", "haber gibi\nözetle")
_CLAUSE = rf"[^\S\n]*(?:[,;:\-–]|(?=\n))(?:\s+{_KL}+){{0,4}}"
# "geç" (koy, yaz: "haber olarak geç") yalnız istek ekiyle ya da ifade sonunda; "son dakika geç kaldı" (sıfat) istek değil
_GEC = rf"gec(?:{_REQ}|(?={_TO_END}))"
_ASK_A = rf"(?:{_ASK_V}(?:{_REQ})?|{_GEC}|olsun)(?!{_KL})"  # etken istek ("haber gibi anlat", "haber olarak paylaş", "son dakika olsun")
# etken ya da edilgen istek ("komik video yapılsın", "mizah videosu yapılacak") ya da istiyorum ("mizah videosu istiyorum")
_KIND_WANT = r"istiyoru[mz]|isterim|isteriz"
_ASK_P = rf"(?:{_ASK_V}(?:{_REQ}|{_PASS})?|{_GEC}|olsun|{_KIND_WANT})(?!{_KL})"


def _say(L: str) -> str:
    """Alıntı/amaç sözü (L: harf sınıfı; server.js sayWords aynı metin): istek biçiminin ardından (araya boşluk, virgül, nokta, tırnak)
    diye, der/derken/dersen, deyince/deyip/deyerek, denir/denilen, dedi…, demiş…, demiyor…, diyor… (diyorum/diyoruz değil: sahibin kendi
    ısrarı, "haber yap diyorum"), diyen, diyecek, diyerek ya da çağrısı/talebi/uyarısı gelirse istek başkasının sözüdür ya da amaçtır
    ("Herkes haber yap diyor", "haber yap demiştim ama vazgeçtim", "Komik video olsun diye kediyi suya attı", '"Haber yapın" dedi',
    "aynısını yapalım derken", "tarafsız haber yapın çağrısı"); sahibin isteği sayılmaz."""
    return (rf"[\s,.!?\x22\x27‘’“”«»]+(?:diye|de(?:r|rken|rsen|rler|rsin(?:iz)?|yince|yip|yerek|ni[lr]{L}*|di{L}*|"
            rf"mis{L}*|miyor{L}*)|di(?:yor(?!u[mz](?!{L}))|yen|yecek|yerek){L}*|cagri{L}*|tale[pb]{L}*|uyari{L}*)(?!{L})")


_SAY = rf"(?!{_say(_KL)})"
# ret (haber isteğinin ya da tür ifadesinin ardından, araya en çok üç ad: "son dakika diye bir şey yazma", "son dakika falan koyma",
# "son dakika kısmını kaldır", "son dakika ile alakası yok"): değil (diil, deil), yok, gerek yok, gerekmez, yerine, kaldır, alakası/ilgisi
# yok, -mAnA/-mAyA gerek yok ("yazmana gerek yok"), olumsuz fiil (edilgen kök de: "yazılmasın"; konuşma dili: "yazmıycaz", "yazmasana");
# tür ifadesinden sonraki "haber" araya giren ad sayılmaz ("komik video, haber yapmayın" haberi reddeder, mizahı değil)
_REFUSAL_END = (rf"(?:d(?:egi|ii|ei)l|yok|gerek\s+yok|gerekmez|gerekmiyor|yerine|(?:alaka|ilgi)s[iu]\s+yok|"
                rf"kaldir(?:in(?:iz)?|sana|ir\s*m[iu]s[iu]n(?:[iu]z)?)?|"
                rf"{_KL}+m[ae](?:n[ae]|y[ae])\s+(?:gerek\s+yok|gerekmez|gerekmiyor)|"
                rf"(?:yaz|koy|de|yap|hazirla|uret|paylas|at|ver|cek|anlat|ol|iste|gonder|yukle|yayinla|yayimla|sun|kullan|ekle|cevir|kurgula|"
                rf"goster|gec)(?:[iu]l|[iu]n|n)?{VERB_NEG})(?!{_KL})")
_REFUSAL_GAP = (rf"diye|olarak|gibi|seklinde|tarzinda|video|videosu|videosunu|bir|bi|sey|bisey|birsey|falan|filan|hic|ile|kism{_KL}*|"
                rf"ibare{_KL}*|etiket{_KL}*|yazi{_KL}*|basli{_KL}*|band{_KL}*|ifade{_KL}*|kelime{_KL}*")
_REFUSAL_NEWS = rf"\s+(?:(?:{_REFUSAL_GAP}|haber|haberi|haberini)\s+){{0,3}}{_REFUSAL_END}"
_REFUSAL_KIND = rf"\s+(?:(?:{_REFUSAL_GAP})\s+){{0,3}}{_REFUSAL_END}"
_ASK_GAP = rf"(?:bir|bi|kisa|uzun|video{_KL}*|ozet{_KL}*|bunu|sunu|bana|lutfen|hemen|olarak|sey|bisey|birsey|sekilde|bicimde)"  # ifade ile fiil arasında sayılan kelime
# ifadeden sonra istek fiili: araya en çok üç ara kelime ya da süre ("haber olarak 30 saniyelik bir video yap", "son dakika olarak kısa bir
# video hazırla"; inceleme, 19 Ekim: süre araya girince haber isteği kaçıyordu); fiilden sonra ret ("haber gibi yap değil") ve alıntı sayılmaz
_TO_VERB = rf"\s+(?:(?:{_ASK_GAP}|{_FILLTOK})\s+){{0,3}}{_ASK_A}"
_TO_ASK = rf"{_TO_VERB}(?!{_REFUSAL_NEWS}){_SAY}"
# reddedilen istek ("son dakika yazma", "haber değil", "mizah videosu yapmayın") etiket ve ifade denetiminden önce atılır: kalan "mizah"
# etikettir ("son dakika diye yapma mizah", "haber değil mizah" → mizah)
_REFUSED_P = (rf"(?<!{_KL})(?:(?:son\s*dakika|haber(?:i|ini)?)(?!{_KL}){_REFUSAL_NEWS}|"
              rf"#?(?:mizah|mizahi|komik|trend|viral)(?:\s+(?:(?:bir|bi)\s+)?(?:video|icerik|paylasim){_KL}*)?(?!{_KL}){_REFUSAL_KIND})")
_REFUSED = re.compile(_REFUSED_P)
# açık haber isteği (fragman kararı, video türü, benzer video, özet; server.js NEWS_RE aynı kalıp). GÜÇLÜ biçim (her zaman haber):
# - "haber(i/ini/leri) yap|hazırla|üret|çek|yaz" (+ "haber videosu yap") istek biçiminde, edilgen istek de ("haberi yapılsın/yapılacak/yapılması
#   lazım"); araya en çok üç ara kelime ya da süre girebilir ("haberini 30 saniyelik hazırla", "bunun haberini kısa yap", "haberini kısa bir
#   şekilde hazırla", "haber videosu 30 saniyelik hazırla"; inceleme, 19 Ekim: trailer başlıklı link fragman analizine gidiyordu);
#   "haber yaparken/yapan/yaptığı", "haber çekimi", "haber yapmak yerine" değil
# - "haber olsun" yalnız videoyu gösterirken: talimatın başında ("haber olsun ama kısa") ya da bu/bu video/şu/bunu/şunu/videoyu (+ da/de)
#   sonra ("bu video haber olsun abi") ya da talimatın son sözü olarak (ardından yalnız işaret/dolgu/süre: "…ama vazgeçtim, normal haber
#   olsun"); yönelme hâlinden ("herkese haber olsun") ve kalmasın/duysun/bilsin/görsün/öğrensin'den sonra deyimdir, istek değil ("duymayan
#   kalmasın haber olsun 😂", "herkes duysun, haber olsun"; inceleme, 19 Ekim)
# - "haber olarak" + ifade sonu ya da (araya en çok üç kelime ya da süre) etken istek fiili; hemen ardından virgül/noktalı virgül yeni cümle
#   başlatıyorsa değil ("Güzel bir haber olarak, kedimiz Pamuk 5 yavru doğurdu"; virgülden sonra yalnız dolgu/süre, istek fiili ya da ret:
#   "haber olarak, 30 saniye", "haber olarak, kısa hazırla", "haber olarak, son dakika yazma"); "haber gibi/şeklinde/tarzında/formatında/diliyle"
#   + istek fiili ("haber gibi yayınla/göster/çek/at/oku", "haber gibi kısa bir video yap"); edilgen/ortaç istek değil ("haber gibi sunulan",
#   "haber gibi yapılmış", "haber olarak verilen")
# - "habere çevir", "haberleştir", "haber haline getir"
# - "son dakika" (ya da "son dk") + olarak/diye/şeklinde/etiket…/bant…/başlık…/haber…/video… + (son ya da istek fiili), ya da doğrudan istek
#   fiili ("son dakika olsun", "son dakika olarak 30 saniyelik video hazırla"); "son dakika diye haber yapıyor" istek değil
# - hepsinde ardından ret ("son dakika yok", "son dakika falan yazma", "haber olarak değil") ya da alıntı/amaç sözü ("haber yap dedi",
#   "haber yapsın diye", "son dakika olsun diye") gelirse sayılmaz
_SD_FOLLOW = rf"(?:olarak|diye|seklinde|etiket{_KL}*|band{_KL}*|basli{_KL}*|haber{_KL}*|video{_KL}*)"  # "son dakika" + etiket sözü
# "duymayan kalmasın, haber olsun", "herkes duysun/bilsin/görsün haber olsun" deyimi (duyuru çağrısı) "haber olsun" isteği değil
_HO_IDIOM = "".join(rf"(?<!{w}\s)(?<!{w},\s)" for w in ("kalmasin", "duysun", "duyulsun", "bilsin", "gorsun", "ogrensin"))
NEWS_RE = re.compile(
    rf"(?<!{_KL})(?:son\s*(?:dakika|dk)(?!{_KL}|['’])(?!{_REFUSAL_NEWS})(?=\s+{_SD_FOLLOW}(?:{_TO_END}|{_TO_ASK})|{_TO_ASK})|"
    rf"haber(?:i|ini|inin|ler|leri|lerini)?\s+(?:videosu(?:nu)?\s+)?(?:(?:{_ASK_GAP}|{_FILLTOK})\s+){{0,3}}(?:yap|hazirla|uret|cek|yaz)"
    rf"(?:{_REQ}|{_PASS})?(?!{_KL}){_SAY}|"
    rf"(?:^(?:[^\w]|_)*|(?:(?:bu|su)(?:\s+video)?|bunu|sunu|videoyu)(?:\s+d[ae])?\s+)haber\s+olsun(?!{_KL}){_SAY}|"
    rf"(?<![ae]\s){_HO_IDIOM}haber\s+olsun(?={_SIGN_END})|"
    rf"haber\s+olarak(?=(?:\s+{_FILLTOK}){{1,4}}{_T}|[^\S\n]*(?:$|\n|(?![,;]){_KS}|[,;](?={_SIGN_END}|{_TO_ASK}|\s*{_REFUSED_P}))|{_TO_ASK})|"
    rf"haber\s+(?:gibi|seklinde|tarzinda|formatinda|diliyle)(?={_TO_ASK})|"
    rf"(?:habere\s+(?:cevir|donustur)|haberlestir|haber\s+haline\s+getir)(?:{_REQ})?(?!{_KL}){_SAY})(?!{_REFUSAL_NEWS})")
# ZAYIF biçim (yalnız talimatta açık mizah/viral ifadesi yoksa haber; inceleme, 19 Ekim: "Son dakika: gol yiyen kaleci 😂 mizah videosu",
# "😂 #komik #viral #sondakika" mizahtı; "yalan haber gibi 😂 mizah yap", "gerçek bir haber gibi 😂" benzetmesi haber oluyordu):
# - etiket "son dakika" + ifade sonu ("son dakika:", "🔴 SON DAKİKA |", "#sondakika", "Kadıköy'de yangın, son dakika")
# - talimatın başında "son dakika" + kesme işaretli özel ad ya da rakam ("Son dakika Kadıköy'de yangın", "Son dakika 4,2 büyüklüğünde
#   deprem"); başka kelime sayılmaz: "Son dakika golüne sevinen", "Son dakika yetişen damat", "Son dakika gol yiyen kaleci", "Son dakika
#   tatil fırsatları", "son dakika diil bu" (kaçırılan "Son dakika Erdoğan açıkladı" ucuz: Claude gerçek olayı zaten haber seçer)
# - talimatın başında (bunu/şunu/videoyu/bu fragmanı + ) fiilsiz "haber gibi/şeklinde…" + ifade sonu ya da rakam ("haber gibi 40 saniye",
#   "haber gibi\nözetle"); cümle içindeki fiilsiz benzetme ("Tıpkı bir haber gibi.", "sahte haber gibi, mizah olarak paylaş") değil; işaret ve
#   satır sonu fragman isteğindeki gibi yalnız ardından işaret/dolgu/süre ya da kısa istek cümlesi gelirse ("Haber gibi 😂 Minik muhabir
#   sınıfta hava durumunu sundu" altyazısı değil; inceleme, 19 Ekim)
# - metinde gülme emojisi varsa iki "son dakika" biçimi sayılmaz (yapıştırılan şaka altyazısı: "Son dakika 2 dakika kala otobüse yetişen
#   öğrenci 😂", "SON DAKİKA: Annem tatlıyı yine saklamış 😂"; inceleme, 19 Ekim); talimatın başındaki "haber gibi 😂" sayılır
_LAUGH = re.compile("[😂🤣😹😆😅😁😄😝🤪]")
_SD_LABEL = re.compile(rf"(?<!{_KL})son\s*dakika(?!{_KL}|['’])(?!{_REFUSAL_NEWS})(?={_T})")
_NEWS_START = re.compile(rf"^(?:[^\w]|_)*son\s*dakika\s+(?={_KL}+['’]|[0-9])")
_NEWS_LIKE = re.compile(rf"^(?:[^\w]|_)*(?:(?:(?:bu|su)\s+)?(?:bunu|sunu|videoyu|fragmani)\s+)?haber\s+(?:gibi|seklinde|tarzinda|formatinda|diliyle)"
                        rf"(?=[^\S\n]*[0-9]|{_SIGN_END}|{_CLAUSE}\s+{_ASK_A}(?!{_REFUSAL_NEWS}){_SAY})")
# tür ifadesi: mizah/mizahi/komik/viral/trend/çok izlenen + ((bir) video…/içerik…/paylaşım… | olarak | amaçlı | kategori… | şekilde/biçimde/
# dille) yalnız ardından şunlar gelirse: ifade sonu (son, noktalama, emoji), dolgu/süre ("mizah videosu 40 saniye", "lütfen"), istek ya da
# yayın fiili istek biçiminde (edilgen istek de: "yapılsın", "yapılacak", "yapılması lazım"), "ama/ve" + istek; ya da tür kelimesi + "yap…"/
# "olsun" (istek fiili ifadenin içinde: "mizah yap sesi kalsın", "komik yap 40 saniye"; "viral olsun" değil: "Paylaşın viral olsun 🙏" kayıp
# çocuk çağrısı). Ardından alıntı/amaç sözü gelirse sayılmaz ("Komik video olsun diye", "Mizah videosu çekelim derken").
# video adının ilgi, bulunma ve araç hâli olayı anlatır ("viral videonun sahibi", "videodaki", "viral videoyla ünlenen"; "mizah videolarından"
# kalır). İlgi hâlindeki kelimeden sonra ("kavganın viral videosu", "Ahmet'in komik videosu") yalnız istek fiiliyle ("bunun komik videosunu yap").
_NOUN = rf"(?:video|icerik|paylasim)(?!{_KL}*?(?:[iu]n|[dt][ae](?:ki)?|l[ae])(?!{_KL})){_KL}*"
_KIND_VERB = rf"\s+(?:(?:ama|ve|ancak)\s+)?(?:(?:{_ASK_GAP}|{_FILLTOK})\s+){{0,3}}{_ASK_P}(?!{_REFUSAL_KIND}){_SAY}"
_KIND_FOLLOW = rf"{_TO_END}|{_KIND_VERB}"
_KIND_WORD = r"(mizah|mizahi|komik|viral|trend|cok\s+izlenen)"
_KIND_REST = (rf"\s+(?:(?:bir|bi)\s+)?(?:{_NOUN}|sey|bisey|birsey|olarak|amacli|kategori{_KL}*|sekilde|bicimde|dille|tarz(?:i|da|inda))(?!{_KL})"
              rf"(?!{_REFUSAL_KIND})")
_KIND_DOV = rf"\s+(?:{_ASK_V}(?:{_REQ}|{_PASS})?|{_GEC}|(?<!viral\s)olsun|{_KIND_WANT})(?!{_KL})(?!{_REFUSAL_KIND}){_SAY}"
# "mizaha çevir" ("habere çevir" gibi; inceleme, 19 Ekim): 4. grup
_KIND_PHRASE = re.compile(rf"(?<!{_KL})(?:#(mizah|mizahi|komik|trend|viral|haber)(?!{_KL})(?!{_REFUSAL_KIND})|"
                          rf"(?<![iu]n\s){_KIND_WORD}(?:{_KIND_REST}(?={_KIND_FOLLOW})|{_KIND_DOV})|{_KIND_WORD}{_KIND_REST}(?={_KIND_VERB})|"
                          rf"(mizah)a\s+(?:cevir|donustur)(?:{_REQ})?(?!{_KL})(?!{_REFUSAL_KIND}){_SAY})")
# sonda işaretten (ya da satır sonundan) sonra yalın etiket: "Adam düştü 😂 mizah", "son dakika diil bu, viral", "bu haber değil, mizah";
# yalnız kısa metinde (etiketin dışında en çok 4 kelime, _TAG_WORDS; inceleme, 19 Ekim: "Selde mahsur kalan aile helikopterle kurtarıldı -
# Viral", "Ünlü şefin skandalı ortaya çıktı… (Viral)" gibi uzun ciddi altyazı viral video oluyordu)
_KIND_TAIL = re.compile(rf"(?:{_KS}|\n)[^\S\n]*#?(mizah|mizahi|komik|trend|viral|haber)(?:[^\S\n]*{_KS})*\s*$")
_TAG_WORDS = 4
_URL = re.compile(r"https?://\S*|www\.\S*")  # kelime sayısında link sayılmaz
_WORD = rf"{_KL}+(?:['’]{_KL}+)*(?!{_KL}|['’]{_KL})"  # kelime (kesme işaretli ek aynı kelime: "Kadıköy'de")
# başta ayraçla etiket ("mizah, kısa kes"); ardından yalın başka etiket gelirse seçim açık bırakılmıştır ("haber, mizah, viral fark etmez sen
# seç", "haber/mizah sen karar ver"), etiket değil; ikinci etiket bir ifadenin başıysa ("mizah, haber gibi anlat", "mizah, komik video yapma")
# baştaki etiket geçer. Başlık biçimli iki nokta yalnız kısa metinde (ardından en çok 4 kelime: "#trend: sesi kalsın"; inceleme, 19 Ekim:
# "Trend: Gençler arasında yayılan tehlikeli akım iki can aldı" viral video oluyordu); virgül, noktalı virgül, tire, eğik çizgi her zaman
_KIND_LEAD = re.compile(rf"^\s*#?(mizah|mizahi|komik|trend|viral|haber)\s*(?:[,;\-–/]|:(?=(?:(?:(?!{_KL})[\s\S])*{_WORD}){{0,4}}(?:(?!{_KL})[\s\S])*$))"
                        rf"(?!\s*#?(?:mizah|mizahi|komik|trend|viral|haber)(?!{_KL})"
                        rf"(?!\s+(?:gibi|seklinde|tarzinda|formatinda|diliyle|olarak|amacli|olsun|(?:video|icerik|paylasim|{_ASK_V}){_KL}*)(?!{_KL})))")


# ayrık yazılmış İ ("I" + U+0307 birleşen üst nokta; NFD metin, macOS dosya adı): JS toLocaleLowerCase("tr-TR") aradaki birleşen işaretlerin
# sınıfı 0 ya da 230 değilse noktayı atıp "i" yapar (Unicode SpecialCasing After_I); Python lower() noktayı bırakıyordu (kelime bölünüyordu)
_DOT_I = re.compile("I([̀-ͯ᪰-᫿᷀-᷿⃐-⃿︠-︯]*?)̇")


def kind_fold(t: str) -> str:
    """Türkçe küçük harf + harfsiz yazım (ı→i, ş→s…): "MİZAH", "MIZAH", "mızah" aynı (server.js kindFold ile aynı sonuç)."""
    t = _DOT_I.sub(lambda m: "i" + m.group(1) if all(unicodedata.combining(c) not in (0, 230) for c in m.group(1)) else m.group(0), str(t or ""))
    return t.replace("I", "ı").replace("İ", "i").lower().translate(str.maketrans("ıöçşüğâîû", "iocsugaiu"))


def _kind_text(t: str) -> str:
    """kind_fold + JS'nin karakter sınıfları (server.js ile birebir aynı sonuç): Python'un harf sınıfına giren harf olmayan sayı işaretleri
    (², ₂, Ⅻ) ve yalnız Python'un boşluk saydığı denetim karakterleri ayraç, yalnız JS'nin boşluk saydığı U+FEFF boşluk."""
    return "".join("\0" if c in "\x1c\x1d\x1e\x1f\x85" or (c.isnumeric() and not c.isdecimal() and not c.isalpha()) else " " if c == "﻿"
                   else c for c in kind_fold(t))


def news_request(text: str) -> bool:
    """Talimat açıkça haber istiyor mu (yalnız istek biçimi: "haber yap", "haberini hazırlar mısın", "haber olarak paylaş", "haber gibi
    anlat", "habere çevir", "son dakika", "son dakika olarak"; ret, alıntı ve betimleme değil: "haber yapma", "haber yap dedi", "haber
    yaparken", "son dakika yok", "son dakika golü"). server.js newsRequest aynı kural."""
    return _news(_kind_text(text))


def _news(t: str) -> bool:
    """news_request, _kind_text'li metinde (content_kind ve recreate_ask de bunu kullanır): güçlü biçim (NEWS_RE) her zaman, zayıf biçim
    (etiket "son dakika", başta "Son dakika Kadıköy'de…", başta fiilsiz "haber gibi") yalnız açık mizah/viral ifadesi yoksa."""
    if NEWS_RE.search(t):
        return True
    return bool((((_SD_LABEL.search(t) or _NEWS_START.search(t)) and not _LAUGH.search(t)) or _NEWS_LIKE.search(t))
                and not {"mizah", "trend"} & _phrase_kinds(_REFUSED.sub(" ", t), True))


def _phrase_kinds(s: str, any_len: bool = False) -> set:
    """Reddedilenleri atılmış metindeki açık tür ifadelerinin ve sondaki yalın etiketin türleri (#haber → haber, çok izlenen → trend). Sondaki
    etiket tür olarak yalnız kısa metinde sayılır; zayıf haber biçimini (any_len: _news) her uzunlukta bastırır ("son dakika: …, mizah")."""
    ks = {KIND_WORDS.get(x, "trend") for g in _KIND_PHRASE.findall(s) for x in g if x}
    tail = _KIND_TAIL.search(s)
    short = any_len or len(re.findall(_WORD, _URL.sub(" ", s))) <= _TAG_WORDS + 1
    return ks | {KIND_WORDS[tail.group(1)]} if tail and short else ks


def _tag_words(t: str) -> list:
    """Katlanmış metin yalnız etiket + dolgudan oluşuyorsa etiket kelimeleri, değilse [] (haber dışındaki etiketin yanında "yap"/"olsun" da
    dolgu: "mizah yap", "trend olsun"; "viral olsun" çağrıdır, etiket değil; commands.js tagKind ve server.js tagWords aynı kural)."""
    words = re.findall(_KL + "+", t)
    soft = "haber" not in words and not ("viral" in words and "olsun" in words)
    ok = all(w in KIND_WORDS or _KIND_FILL.fullmatch(w) or (soft and _KIND_DO.fullmatch(w)) for w in words)
    return [w for w in words if w in KIND_WORDS] if ok else []


def kind_only(instruction: str) -> bool:
    """Talimat yalnız tür etiketinden mi oluşuyor ("mizah", "#trend", "viral 18:30", "mizah 40 saniye", "bunu mizah olarak paylaş", "mizah
    yap")? O zaman montaja türün varsayılan talimatı gider."""
    return bool(_tag_words(_kind_text(instruction)))


def content_kind(instruction: str) -> str:
    t = _kind_text(instruction)
    s = _REFUSED.sub(" ", t)  # reddedilen istekler atılmış metin: kalan etiket ve ifade sayılır
    tags = _tag_words(s)
    if tags:
        ks = {KIND_WORDS[w] for w in tags}
        return "haber" if "haber" in ks else "mizah" if "mizah" in ks else "trend"
    lead = _KIND_LEAD.match(t)  # başta ayraçla etiket: "mizah, kısa kes"
    if lead:
        return KIND_WORDS[lead.group(1)]
    if _news(t):
        return "haber"
    ks = _phrase_kinds(s)
    return "haber" if "haber" in ks else "mizah" if "mizah" in ks else "trend" if "trend" in ks else ""


# Fragman isteği (talimatta "fragman", "trailer", "teaser"; server.js TRAILER_ASK aynı kalıp, social_video.wants_summary de). ÖNCE KESİNLİK
# (inceleme, 19 Ekim: linkin yanına yapıştırılan "Ünlü oyuncu fragman çekimleri sırasında yaralandı", "Fragmanı izleyen hayranlar
# çıldırdı", "Fragmana tepki: …" haber videosunu fragman analizine gönderiyordu): fragman kelimesi (+ analiz…/özet…/video…/olarak) yalnız
# ardından ifade sonu, dolgu/süre ("fragman", "fragman:", "fragman 40 saniye"), istek fiili (araya en çok üç kelime: "fragman yap", "bu
# fragmanı özetle", "fragmanı analiz et", "fragman analizi yap 30 saniye") ya da haber reddi ("fragmanı haber yapma") gelirse sayılır.
# İşaret ve satır sonu yalnız ardından metnin sonuna kadar işaret, dolgu ya da süre gelirse ifade sonudur (_SIGN_END; inceleme, 19 Ekim:
# "Gerçek hayattan fragman: Kartal tilkiyi havada yakaladı" fragman analizine gidiyordu; "fragman: <link>" yine fragman); virgül, noktalı
# virgül, iki nokta, tire ya da satır sonundan sonra en çok dört kelimelik istek cümlesi de olur (_CLAUSE: "fragman, kısa olsun", "fragman,
# haber gibi bir şey hazırla").
_TR_WORD = rf"(?:fragman(?:[iae]{_KL}*|l[ae]r{_KL}*|d[ae]{_KL}*)?|trailer(?:s|i{_KL}*)?|teaser(?:s|i{_KL}*)?)"
_TR_VERB = (rf"(?:\s+(?:{_ASK_GAP}|{_FILLTOK})){{0,3}}\s+(?:{_ASK_V}(?:{_REQ})?|{_GEC}|(?:incele|yorumla)(?:{_REQ})?|analiz\s+e[td](?:{_REQ})?)"
            rf"(?!{_KL})(?!{_REFUSAL_KIND}){_SAY}")
_TR_ASKV = (rf"\s+(?:{_ASK_V}(?:{_REQ})?|{_GEC}|olsun|(?:incele|yorumla)(?:{_REQ})?|analiz\s+e[td](?:{_REQ})?)(?!{_KL})(?!{_REFUSAL_KIND}){_SAY}")
TRAILER_ASK = re.compile(rf"(?<!{_KL}){_TR_WORD}(?!{_KL})(?:\s+(?:analiz{_KL}*|ozet{_KL}*|video{_KL}*|olarak))?"
                         rf"(?={_SIGN_END}|{_TR_VERB}|{_CLAUSE}{_TR_ASKV}|"
                         rf"[^\S\n]*[,;]?\s+(?:haber{_KL}*|son\s*dakika){_REFUSAL_NEWS})")


def trailer_ask(instruction: str) -> bool:
    """Talimat fragman analizi istiyor mu (yalnız istek biçimi; server.js trailerAsk aynı kural)."""
    return bool(TRAILER_ASK.search(_kind_text(instruction)))


# Benzer video, sıfırdan (kullanıcı isteği, 19 Ekim: "bir video gönderdiğimde o videoyu izleyip kelimelerini çıkartıp o videodaki gibi
# sıfırdan video üretmesini benzer bir şekilde yapmasını sağlayabilir miyiz"): talimat referans videonun benzerinin SIFIRDAN üretilmesini
# istiyor mu. Kendi videomuzun yeniden yayını ("🔁 yeniden yayınla") değildir. Türkçe harfsiz yazım aynı (_kind_text: "sifirdan").
# ÖNCE KESİNLİK (inceleme, 19 Ekim: ara kelimesi serbest, fiili uzakta olabilen "güçlü/zayıf" kalıplar "Esnaf sıfırdan başladı 30 saniyelik
# video yap", "Emekli usta tekneleri sıfırdan yapıp satıyor, haber yap", "Yapay zeka sıfırdan video üretebiliyor" haber görüntüsünü atıp
# çizilmiş hikâye yapıyordu): yalnız BAŞ + yalnız beyaz liste ara kelimeleri + İSTEK BİÇİMİNDE fiil sayılır.
# - Baş: benzer(ini/i/lerini), buna/şuna benzer, aynısını, sıfırdan, bunun/şunun gibisini, böylesini, esinlenerek, ilham alarak; yalın
#   "benzer" ve "buna benzeyen" yalnız arada şey adı ve ardından fiil ya da olsun/istiyorum ile ("benzer bir video yap"; "Benzer bir hikâye
#   😢" altyazısı değil); videodaki gibi, bunun/şunun gibi, bu/şu/aynı/bunun/şunun/videonun/videodaki tarz(ı/da/ında/ıyla)/format(ı/ta)/
#   stil(i/de), videonun/videodakinin benzerini/aynısını, benzer (bir) şekilde.
# - BU video: "videodaki/videonun/videodakinin" yalnız bu/şu'dan sonra, talimatın başında (o da olabilir: "o videodaki gibi yap") ya da
#   bunu/şunu/lütfen/aynen/tıpkı/aynı/tam/hemen/abi/tamam/sen de/siz de'den ya da işaretten/satır sonundan sonra ("Çocuklar için masal.
#   Videodaki gibi yap", "30 saniye, videonun aynısını yap", "abi videodaki gibi yap"; inceleme, 19 Ekim: cümle içinde tanınmıyordu); başka
#   videoyu gösteren söz ("dünkü/önceki/son/diğer/eski videodaki gibi", "geçen haftaki videonun aynısını", "bizim dünkü videonun benzerini")
#   ve geri gönderim ("onun gibi", "onun tarzında", "ona benzer", "o tarzda") baş değil (inceleme, 19 Ekim: sahibin görüntüsü ve sesi atılıp
#   çizilmiş hikâye yapılıyordu).
# - "Togg'un benzerini", "X'in aynısını", "videosunun aynısını" (ilgi hâli; yalnız bunun/şunun hariç) baş değil; yönelme hâlinden sonra
#   "aynısını/benzerini yap" deyimdir ("buna da aynısını yap", "bu videoya da aynısını yap": aynı işlemi uygula), baş değil; arada şey adı
#   olmayan "sıfırdan" yalnız talimatın başında ya da bunu/şunu/onu/videoyu/hikâyeyi/hepsini/tamamen/lütfen/ve/ama/sonra/yeniden'den sonra,
#   işaretten sonra yalnız çiz/anlat/üret/canlandır/tasarla ile ("Yılan ve fareler kıssası, sıfırdan anlat"; "Anayasayı sıfırdan yapalım"
#   alıntısı, "kurgu kötü olmuş, sıfırdan yap" yeniden kurgu isteği değil; "aynı mesajı veren sıfırdan bir video yap" şey adıyla sayılır).
# - Ara kelime (en çok 4, beyaz liste): bir, bi, yeni, kısa, uzun, türkçe, ingilizce, N saniye/saniyelik/sn/dakika/dakikalık, biz/sen/siz
#   (de), bana, bize, benim/bizim için, aynı, sıfırdan, yeniden, tekrar, tarzda, şekilde, olarak, (bir/iki/2…) tane (daha), şey/bişey, lütfen,
#   hemen, yarın, bugün, şimdi, kendi cümle…/söz…, şey adları video(su/lar), içerik, animasyon, hikâye, kıssa, çizim, çizgi film.
# - Fiil: yap/üret/çiz/anlat (yaptır, çizdir, ürettir), hazırla/tasarla/oluştur/canlandır (hazırlat) İSTEK BİÇİMİNDE (yukarıdaki liste +
#   edilgen istek "yapılsın"); fiilsiz biçim yalnız arada şey adı varsa ve ardından olsun/istiyorum ya da talimat sonu (araya yalnız
#   noktalama ve beyaz liste kelimesi: "bunun gibi bir video, 40 saniye"; "Sıfırdan animasyon: gençlerin projesi" değil).
# - Ardından değil/olmasın/istemiyorum/istemem/istemeyiz/gerek yok/gerekmez/yok ya da alıntı/amaç sözü (diye, dedi, derken, diyen, deyince,
#   diyerek…: "Aynısını yapalım derken iki genç yaralandı", "Herkes bunun benzerini yap diyor") gelirse sayılmaz.
# - Talimat orijinal sesi ya da görüntüyü korumayı istiyorsa ("sesi kalsın", "orijinal sesle", "görüntüleri kullan") benzer video değil:
#   sıfırdan çizilen videoda referansın sesi ve görüntüsü kullanılmaz. Ardından ret gelen koruma sözü koruma değildir ("orijinal ses değil",
#   "orijinal görüntü kullanılmasın", "kendi görüntüsünü kullanma", "orijinal ses yerine seslendirme"; inceleme, 19 Ekim).
# Açık haber isteği (news_request) varsa yalnız nesneyi adlandıran baş kazanır (benzerini, aynısını, sıfırdan, gibisini, böylesini,
# esinlenerek, ilham alarak, benzer + şey adı: "benzerini yap ama haber gibi anlat" benzer video); "bunun gibi", "bu tarzda", "benzer
# şekilde" haber isteğine yenilir ("bunun gibi bir video yap ama haber olarak hazırla" haber). server.js RECREATE_ASK / RECREATE_STRONG /
# RC_KEEP aynı kalıp metni (`.pattern` = `.source`).
_RC_STEM = r"(?:(?:yap|uret|ciz|anlat)(?:t[iu]r|d[iu]r)?|(?:hazirla|tasarla|olustur|canlandir)t?)"
_RC_VERB = rf"{_RC_STEM}(?:{_REQ}|{_PASS_OPT})?(?![a-z])"
_RC_NUM = (r"(?:[0-9]+(?:[.,][0-9]+)?|(?:bir|iki|uc|dort|bes|alti|yedi|sekiz|dokuz|on|yirmi|otuz|kirk|elli|altmis|yetmis|seksen|doksan|yuz)"
           r"(?:\s+(?:bir|iki|uc|dort|bes|alti|yedi|sekiz|dokuz|on))?)")
_RC_FILL = (rf"(?:bir|bi|yeni|kisa|uzun|turkce|ingilizce|{_RC_NUM}\s*(?:saniye|sn|dakika|dk)(?:lik|\s*['’]\s*l[iu]k)?|(?:biz|sen|siz)(?:\s+d[ae])?|"
            rf"bana|bize|(?:benim|bizim)\s+icin|ayni|sifirdan|yeniden|tekrar|tarzda|sekilde|olarak|(?:{_RC_NUM}\s+)?tane(?:\s+daha)?|sey|bisey|birsey|"
            r"lutfen|hemen|"
            r"yarin|bugun|simdi|kendi\s+(?:cumle|soz)[a-z]*)(?![a-z])")
_RC_THING = r"(?:video(?:su|lar|lari)?|icerik|animasyon|hikaye(?:yi)?|kissa(?:yi)?|cizim|cizgi\s+filmi?)(?![a-z])"
_RC_GAP = rf"(?:\s+(?:{_RC_FILL}|{_RC_THING})){{0,4}}"
_RC_GAP_T = rf"(?:\s+{_RC_FILL}){{0,3}}\s+{_RC_THING}(?:\s+{_RC_FILL}){{0,2}}"
_RC_WANT = r"\s+(?:olsun|istiyoru[mz]|isterim|isteriz)(?![a-z])"
_RC_END = (rf"(?:{_RC_WANT}|[^a-z0-9:]*$|\s*[,.;:!?…]+\s*(?:{_RC_FILL}|{_RC_THING})"
           rf"(?:\s+(?:{_RC_FILL}|{_RC_THING})){{0,3}}[^a-z0-9:]*$)")  # iki nokta açıklama başlatır, son değil ("Sıfırdan animasyon: …")
_RC_DO = rf"(?:{_RC_GAP}\s+{_RC_VERB}|{_RC_GAP_T}{_RC_END})"
_RC_DO_T = rf"{_RC_GAP_T}(?:\s+{_RC_VERB}|{_RC_END})"
_RC_DO_W = rf"{_RC_GAP_T}(?:\s+{_RC_VERB}|{_RC_WANT})"  # yalın "benzer" + şey adı: fiil ya da olsun/istiyorum
_RC_GEN = r"(?:(?<![iu]n\s)|(?<=(?<![a-z])bunun\s)|(?<=(?<![a-z])sunun\s))"  # ilgi hâli yalnız bunun/şunun (kelime başından)
_RC_DAT = r"(?<![ae]\sd[ae]\s)(?<!(?<![a-z])(?:buna|suna|bana|sana|bize|size)\s)(?<!(?<![a-z])ona\s)"  # "buna da aynısını yap" deyimi değil
_RC_LEFT = (r"(?:^[^a-z0-9]*|(?:bunu|sunu|onu|bunlari|videoyu|videolari|hikayeyi|kissayi|icerigi|animasyonu|hepsini|tamamen|"
            r"lutfen|ve|ama|sonra|yeniden)(?:\s+d[ae])?\s+)")  # şey adsız "sıfırdan"ın solu
# "videodaki/videonun" BU video: bu/şu'dan sonra, talimatın başında, işaretten ya da satır sonundan sonra, dolgu sözünden sonra
_RC_THIS = (r"(?:(?:bu|su)\s+|(?:^[^a-z0-9]*|(?<=[^a-z0-9\s]|\n)[^\S\n]*|"
            r"(?:(?:bunu|sunu|lutfen|aynen|tipki|ayni|tam|hemen|abi|tamam)(?:\s+d[ae])?|(?:sen|siz)\s+d[ae])\s+)(?:o\s+)?)")
# işaretten sonra şey adsız "sıfırdan" yalnız çizim/anlatım fiiliyle ("Yılan ve fareler kıssası, sıfırdan anlat"); "yap/hazırla" orada
# yeniden kurgu isteği olabilir ("kurgu kötü olmuş, sıfırdan yap")
_RC_DRAW = rf"(?:(?:uret|ciz|anlat)(?:t[iu]r|d[iu]r)?|canlandir|tasarla)(?:{_REQ}|{_PASS_OPT})?(?![a-z])"
_RC_STRONG = (rf"{_RC_LEFT}sifirdan(?![a-z]){_RC_DO}|(?<=[^a-z0-9\s])\s*sifirdan(?![a-z]){_RC_GAP}\s+{_RC_DRAW}|sifirdan(?![a-z]){_RC_DO_T}|"
              rf"{_RC_GEN}(?:{_RC_DAT}(?:benzer(?:ini|i|lerini)|aynisini)|(?:buna|suna)\s+benzer)(?![a-z]){_RC_DO}|"
              rf"{_RC_THIS}(?:videonun|videodakinin)\s+(?:benzer(?:ini|i|lerini)|aynisini)(?![a-z]){_RC_DO}|"
              rf"(?:(?:bunun|sunun)\s+gibisini|boylesini|esinlenerek|ilham\s+alarak)(?![a-z]){_RC_DO}|"
              rf"{_RC_GEN}(?:benzer|(?:buna|suna)\s+benzeyen)(?![a-z]){_RC_DO_W}")
_RC_WEAK = (rf"(?:{_RC_THIS}videodaki|bunun|sunun)\s+gibi(?![a-z]){_RC_DO}|"
            rf"(?:bu|su|ayni|bunun|sunun|{_RC_THIS}(?:videonun|videodaki))\s+(?:tarz(?:i|da|inda|iyla)?|format(?:i|ta|inda)|stil(?:i|de|inde))"
            rf"(?![a-z]){_RC_DO}|"
            rf"benzer\s+(?:(?:bir|bi)\s+)?sekilde(?![a-z]){_RC_DO}")
_RC_NOT = (rf"(?!{_say('[a-z]')})(?!\s+(?:d(?:egi|ii|ei)l|olmasin|istemiyoru[mz]|istemem|istemeyiz|istemez|gerek\s+yok|gerekmez|gerekmiyor|"
           r"yok)(?![a-z]))")
RECREATE_RE = re.compile(rf"(?<![a-z])(?:{_RC_STRONG}|{_RC_WEAK}){_RC_NOT}")
RECREATE_STRONG = re.compile(rf"(?<![a-z])(?:{_RC_STRONG}){_RC_NOT}")
# orijinal sesi ya da görüntüyü koruma isteği (sıfırdan çizimle çelişir): "sesi kalsın", "sesini kullan", "orijinal sesle", "kendi sesiyle",
# "görüntüleri kullan", "orijinal görüntü"; "sesi kullanma", "kendi sesinle" (anlatıcı) değil. Ardından (araya hiç/asla/kesinlikle) ret
# gelirse koruma değil: değil (diil/deil), yerine, yok, gitsin, kapat(ın/ılsın), kaldır(ın/ılsın), kullan/iste/ol + olumsuz ek (VERB_NEG:
# kullanma, kullanmadan, kullanılmasın, istemiyorum, olmasın, olmaz)
_RC_KEEP_NEG = VERB_NEG.replace(_KL, "[a-z]")  # benzer video kalıbı harfsiz katlanmış metinde [a-z] ile (server.js aynı metin)
RC_KEEP = re.compile(r"(?<![a-z])(?:ses(?:i|ini)?\s+(?:kalsin|koru|kullan(?:in|sana)?|acik|kapatma|kisma)|"
                     r"(?:orijinal|gercek|asil|dogal|kendi)\s+ses(?:i|iyle|le|ini|li)?|"
                     r"goruntu(?:ler)?(?:i|ini|yu|nu|leri|lerini)?\s+(?:kalsin|koru|kullan(?:in|sana)?)|(?:orijinal|kendi)\s+goruntu[a-z]*)(?![a-z])"
                     rf"(?!\s+(?:(?:hic|asla|kesinlikle)\s+)?(?:d(?:egi|ii|ei)l|yerine|yok|gitsin|(?:kullan|iste|ol)(?:il|in|n)?{_RC_KEEP_NEG}|"
                     r"(?:kapat|kaldir)(?:in(?:iz)?|sana|ilsin|sin)?(?![a-z])))")


def recreate_ask(instruction: str) -> bool:
    """Talimat benzer videoyu sıfırdan istiyor mu (açık haber isteği varsa yalnız nesneyi adlandıran baş; ses/görüntü koruma isteği varsa
    değil); server.js recreateAsk aynı kural."""
    t = _kind_text(instruction)
    if RC_KEEP.search(t):
        return False
    return bool(RECREATE_STRONG.search(t) or (RECREATE_RE.search(t) and not _news(t)))


def recreate_on() -> bool:
    """settings.waVideo.recreate (varsayılan açık; false, "false", 0 kapalı; server.js aynı kural)."""
    w = settings().get("waVideo")
    return not _off((w if isinstance(w, dict) else {}).get("recreate", True))


def episode_meta(video_name: str):
    return load_json(OUT / video_name.replace(".mp4", ".json"), None)


INFO_HEAD = {"deprem": "🔴 SON DAKİKA DEPREM", "mac": "⚽ MAÇ SONUCU", "piyasa": "💰 PİYASALAR", "takvim": "📅 HATIRLATMA",
             "meteo": "🌧 METEOROLOJİ UYARISI", "alarm": "🔴 SON DAKİKA PİYASA", "derleme": "🏆 HAFTANIN EN ÇOK İZLENENLERİ"}


def trailer_tags(meta: dict, base: str) -> list:
    """Fragman analizi (kullanıcı isteği, 18 Ekim: "bir filmin fragmanını analiz edip…"): #fragman eklenir, #sondakika hiç olmaz
    (kanalın ortak etiketlerinde olsa da; fragman son dakika haberi değil). Film olmayan tanıtım filminde (etiket TANITIM FİLMİ:
    parti, belediye, ürün tanıtımı) #fragman da eklenmez. Dizi fragmanında (#dizi) sinema kategorisinin #film etiketi atılır
    (fragman.md: "#film ya da #dizi")."""
    from hashtags import for_meta
    promo = meta.get("slotLabel") == "TANITIM FİLMİ"
    tags = [t for t in for_meta(meta, base, [] if promo else ["#fragman"]) if t != "#sondakika" and not (promo and t == "#fragman")]
    return [t for t in tags if t != "#film"] if "#dizi" in tags else tags


def calm_tags(base) -> str:
    """Kanalın ortak etiketleri, #sondakika olmadan (uzun video özeti son dakika haberi değil; fragmandaki trailer_tags gibi)."""
    return " ".join(t for t in (base if isinstance(base, str) else " ".join(base or [])).split() if t.lower().replace("ı", "i") != "#sondakika")


def build_caption(video_name: str, max_len: int = 2000):
    """Yayın başlığı ve açıklaması senaryo meta'sından üretilir: gün, kaçıncı 5 saat, saat aralığı ve
    her haberin başlığı + seslendirme metni + kaynağı (açıklamada tam haber ayrıntısı)."""
    meta = episode_meta(video_name) or {}
    s = settings()
    haber = [x for x in meta.get("segments", []) if x.get("kind") == "haber"]
    first = meta.get("publishTitle") or (haber[0]["title"] if haber else "Günün özeti")
    day = meta.get("dayLabel") or meta.get("dateLabel", "")
    slot = meta.get("slotLabel") or (f"{meta.get('episodeOfDay', '')}. 5 saat" if meta.get("episodeOfDay") else "")
    rng = meta.get("timeRange") or ""
    stamp = " · ".join(x for x in (day, slot.title() if slot else "", rng) if x)
    anlik = meta.get("anlik") or meta.get("format") == "anlik"
    if meta.get("format") == "haftalik":  # haftanın özeti (yatay, YouTube): günlükle aynı bölümlü açıklama
        title = f"Haftanın Özeti {rng}: {first} | {s['channelName']}"
        lines = [f"📺 HAFTANIN ÖZETİ · {s['channelName']} · {rng}", f"Bu haftanın en önemli {len(haber)} haberi tek videoda.", ""]
    if meta.get("format") == "gunluk":  # günlük uzun özet (yatay, YouTube; Shorts değil)
        title = f"Günün Özeti {day}: {first} | {s['channelName']}"
        lines = [f"📺 GÜNÜN ÖZETİ · {s['channelName']} · {day}", f"Bugünün en önemli {len(haber)} haberi tek videoda.", ""]
    if meta.get("format") in ("gunluk", "haftalik"):
        # YouTube bölümleri: açıklamada 00:00 ile başlayan zaman damgaları videoyu bölümlere ayırır
        t, chapters = 0.0, []
        for seg in meta.get("segments", []):
            if seg.get("kind") == "haber":
                chapters.append(f"{int(t // 60):02d}:{int(t % 60):02d} {seg.get('title', '')}")
            t += float(seg.get("duration") or 0)
        if chapters:
            lines += ["00:00 Giriş", *chapters, ""]
    elif anlik:  # tek konulu son dakika videosu (şablon videoda kendi etiketi: ⚽ MAÇ SONUCU, 💰 PİYASALAR, 📅 HATIRLATMA)
        head = INFO_HEAD.get(meta.get("infoKind") or "", "🔴 SON DAKİKA")
        if meta.get("infoKind") == "video" and meta.get("slotLabel"):  # WhatsApp görüntüsü: etiket kurgu planından (ÖZEL HABER…)
            head = f"🔴 {meta['slotLabel']}"
        if meta.get("summary") and meta.get("slotLabel") != "SON DAKİKA":  # uzun video özeti: son dakika değil → "📺 ÖZET: …"
            head = f"📺 {meta.get('slotLabel') or 'ÖZET'}"
        if meta.get("contentKind") in ("trend", "mizah"):  # viral/mizah videosu: son dakika değil → "🔥 VİRAL: …" (mizah başlıkta yazmaz)
            head = f"🔥 {meta.get('slotLabel') or 'VİRAL'}"
        if meta.get("recreated"):  # benzer video (sıfırdan çizilmiş): son dakika değil → "🎨 HİKÂYE: …" (etiket plandan)
            head = f"🎨 {meta.get('slotLabel') or 'HİKÂYE'}"
        if meta.get("trailer"):  # fragman analizi: son dakika değil → "🎬 FRAGMAN: …" (etiket kurgu planından: YENİ FRAGMAN…)
            head = f"🎬 {meta.get('slotLabel') or 'FRAGMAN'}"
        if meta.get("trailer") or meta.get("recreated"):
            room = 100 - len(f"{head}:  | {s['channelName']} #Shorts")  # uzun başlık kanal adını ve #Shorts'u kesmesin
            if len(first) > room:
                first = first[:room].rsplit(" ", 1)[0].rstrip(" ,;:-–") or first[:room]
        title = f"{head}: {first} | {s['channelName']} #Shorts"
        lines = [f"{head} · {s['channelName']} · {day} · {rng}", ""]
    else:
        title = f"{first} | {s['channelName']} {day} {slot.lower()} #Shorts".strip()
        lines = [f"{s['channelName']} · {stamp}", f"Son {meta.get('scheduleHours', 5)} saatin en önemli {len(haber)} haberi.", ""]
    for i, h in enumerate(haber, 1):
        head = h["title"] if anlik else f"{i}. {h['title']}" if meta.get("format") in ("gunluk", "haftalik") else f"{'🔴 SON DAKİKA · ' if h.get('breaking') else ''}{i}. {h['title']}"
        lines.append(head)
        if h.get("narration"):
            lines.append(h["narration"].strip())
        if h.get("source"):
            lines.append(f"Kaynak: {h['source']}")
        lines.append("")
    # sosyal medya linkinden video: kaynak videoda ve haber metinlerinde yok, açıklamanın EN ALTINDA tek satır (kullanıcı kararı, 14 Ekim)
    social_src = meta.get("sourceName") if meta.get("infoKind") == "video" and meta.get("sourceUrl") and meta.get("sourceName") else None
    if meta.get("sources"):  # çoklu son dakika: her haberin kaynağı
        lines += ["Haber kaynakları:"] + [f"• {x.get('name') or 'kaynak'} · {x.get('url')}" for x in meta["sources"] if x.get("url")] + [""]
    elif meta.get("sourceUrl") and not social_src:
        lines += [f"Haber kaynağı: {meta.get('sourceName') or 'kaynak'} · {meta['sourceUrl']}", ""]
    from hashtags import for_meta
    # uzun video özeti, viral ve mizah videosu, benzer video (sıfırdan) son dakika haberi değil: #sondakika yok
    calm = (meta.get("summary") and meta.get("slotLabel") != "SON DAKİKA") or meta.get("contentKind") in ("trend", "mizah") or meta.get("recreated")
    tags = trailer_tags(meta, s["hashtags"]) if meta.get("trailer") else for_meta(meta, calm_tags(s["hashtags"]) if calm else s["hashtags"],
                                                                                   ["#sondakika"] if anlik and not calm and meta.get("infoKind") in (None, "", "deprem", "meteo", "alarm", "video") else [])
    # mizah videosu: mizah olduğu açıklamanın SONUNDA söylenir (kullanıcı isteği, 19 Ekim: "girişte yazarsa izlenmez, sonunda belirtelim")
    lines += ["Yeni hikâyeler ve kısa anlatımlar için takip et, abone ol." if meta.get("recreated")
              else "😄 Bu video mizah amaçlıdır. Güldüren videolar için takip et, abone ol." if meta.get("contentKind") == "mizah"
              else "Sosyal medyanın en çok konuşulan videoları için takip et, abone ol." if meta.get("contentKind") == "trend"
              else "Gelişmeleri takip etmeye devam ediyoruz. Takip et, abone ol." if meta.get("trailer") and meta.get("slotLabel") == "TANITIM FİLMİ"
              else "Yeni fragmanlar ve film, dizi haberleri için takip et, abone ol." if meta.get("trailer")
              else "Gelişmeleri takip etmeye devam ediyoruz. Takip et, abone ol." if anlik
              else "Her beş saatte bir kısa haberlerle, her akşam günün özetiyle, her pazar haftanın özetiyle buradayız. Abone ol." if meta.get("format") == "haftalik"
              else "Her beş saatte bir kısa haberlerle, her akşam günün özetiyle buradayız. Abone ol." if meta.get("format") == "gunluk"
              else "Her beş saatte bir son dakika haberleriyle buradayız. Takip et, abone ol.", ""]
    try:  # hassas kelimeler açıklamada ve başlıkta yıldızlı (int*har, s*lah), hassas hashtag atılır (censor.py)
        import censor
        title, lines, tags = censor.mask(title), [censor.mask(x) for x in lines], censor.clean_tags(tags)
    except Exception:
        pass
    # benzer video: referans kaynak değil, ilham (görüntüsü kullanılmadı; kullanıcı isteği, 19 Ekim: "o videodaki gibi sıfırdan")
    tail = "\n" + " ".join(tags) + (f"\n\n{'İlham alınan video' if meta.get('recreated') else 'Kaynak'}: {social_src}" if social_src else "")
    return title[:100], "\n".join(lines)[:max(0, max_len - len(tail))] + tail


def caption_tags(video_name: str) -> list:
    """build_caption'ın kullandığı hashtag listesi (YouTube tags, TikTok başlığı için)."""
    from hashtags import for_meta
    meta = episode_meta(video_name) or {}
    s = settings()
    anlik = meta.get("anlik") or meta.get("format") == "anlik"
    calm = (meta.get("summary") and meta.get("slotLabel") != "SON DAKİKA") or meta.get("contentKind") in ("trend", "mizah") or meta.get("recreated")
    tags = trailer_tags(meta, s["hashtags"]) if meta.get("trailer") else for_meta(meta, calm_tags(s["hashtags"]) if calm else s["hashtags"], ["#sondakika"] if anlik and not calm else [])
    try:
        import censor
        return censor.clean_tags(tags)
    except Exception:
        return tags
