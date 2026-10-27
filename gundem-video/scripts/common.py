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


def merge_fresh_publish(m: dict) -> dict:
    """Uzun süren bir metrik güncellemesi (sync_metrics: dakikalarca API okur) kaydederken bu arada başka sürecin (publish.py) yazdığı
    yayın kayıtları kaybolmasın: diskteki güncel dosyada olup bellekteki kopyada olmayan platform kayıtları (kimlikli) ve yeni videolar
    alınır. Kayıt silen işlemler (ig_cleanup) bunu kullanmaz."""
    fresh = load_json(DATA / "metrics.json", {}) or {}
    vids = m.get("videos") if isinstance(m, dict) else None
    if not isinstance(vids, dict) or not isinstance(fresh.get("videos"), dict):
        return m
    has = lambda e: isinstance(e, dict) and bool(e.get("id") or e.get("publish_id") or e.get("unresolved"))  # noqa: E731
    for name, v in fresh["videos"].items():
        if not isinstance(v, dict):
            continue
        mine = vids.get(name)
        if mine is None:
            vids[name] = v
            continue
        if not isinstance(mine, dict):
            continue
        for plat in ("youtube", "instagram", "tiktok"):
            if has(v.get(plat)) and not has(mine.get(plat)):
                mine[plat] = v[plat]
    return m


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
        "narration": {"mode": "single", "voice": "auto", "voiceA": "vox-kadin", "voiceB": "vox-erkek", "femaleGainDb": 3, "maleGainDb": 0,
                      "maleSpeed": 1.07, "femaleSpeed": 1.0},
        # Son videonun ses yüksekliği (LUFS; pipeline.sh loudnorm) ve seslendirme yoğunluğu (tts.VOICE_MAX). Kullanıcı isteği, 27 Ekim
        # ("kadın ve erkeğin ses seviyesini artıralım"): -14'ten -12'ye; seslendirme sıkıştırılmadan -14'e bile ulaşılamıyordu (tepe sınırı).
        # YouTube -14'e kendisi kısar; Instagram ve TikTok olduğu gibi çalar. -16…-9 arası.
        "audio": {"masterLufs": -12, "voiceCompress": True},
        "claudeModel": "opus",
        # Anlık (son dakika) video bitince bağlı tüm hesaplarda onaysız paylaşılsın
        "anlikAutoPublish": True,
        # YouTube günlük yükleme sınırı: otomatik (5 saatlik) üretimler her zaman; anlık/Mynet videoları yalnız
        # değerliyse (scripts/news_value.py) ve günde en çok extraDailyMax tane. Elle yayın bu kurala takılmaz.
        "youtubePolicy": {"regularAuto": True, "onlyValuable": True, "extraDailyMax": 3, "extraKeywords": [], "topUnlimited": True},
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
# etiketin yanında sayılan dolgu (commands.js KIND_FILL aynı): süre birimi, lütfen/olarak/bunu/şunu, yayın fiili (olumsuzu değil), teşekkür ve
# selamlama (12. tur: "mizah olarak teşekkürler"), hitap (14. tur: "abi mizah"); haber dışındaki etiketin yanında "yap"/"olsun" da (KIND_DO:
# "mizah yap", "trend olsun"; "haber yap" zaten haber isteği; "viral olsun" değil)
_KIND_FILL = re.compile(rf"saniye|saniyelik|sn|dakika|dakikalik|dk|lutfen|olarak|bunu|sunu|at|atar|misin|"
                        r"tesekkur(?:ler)?|tsk(?:ler)?|sagol(?:un)?|saol(?:un)?|eyvallah|selam(?:lar)?|merhaba|gunaydin|abi|abla|kanka|hocam|reis|usta|emixhas|"
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
# benzer videonun istek biçimi (inceleme, 20 Ekim: izleyiciye yazılmış "İlk yardım: Videodaki gibi yapmanız lazım", "diğer belediyelerin de
# benzerini yapması lazım", "Köpeğin tavşanla saklambacı 😂 aynısını yapalım mı?" benzer video sanılıyordu): gereklilik yalnız -mak/-man +
# lazım ("benzerini yapman lazım"; -ması/-manız lazım değil), "yapalım mı?" soru. _REQ_SG tekil/sahip biçimleri: işaretten ya da satır
# sonundan sonra ve "siz de"den sonra yalnız bunlar ("Ev hanımları dikkat! Videodaki gibi yapın", "Deprem anında siz de videodaki gibi
# yapın" çoğul emri izleyiciye; "30 saniye, videodaki gibi yap" sahibin isteği; sahibin kibar sorusu "yapar mısınız", "yapabilir misiniz"
# de sayılır, 9. tur); _REQ_PL çoğul/üçüncü kişi biçimleri ("yapabilirsiniz" ifadedir, istek değil: "Bunun benzerini siz de
# yapabilirsiniz"; inceleme, 20 Ekim)
_REQ_SG = (r"s[ae]n[ae]|y?[ae]l[iu]m(?!\s*m[iu](?![a-z]))|[aeiu]?r\s*m[iu](?:s[iu]n(?:[iu]z)?|y[iu]z)|y?[ae]bilir(?:\s*m[iu](?:s[iu]n(?:[iu]z)?|y[iu]z)|s[iu]n)|"
           r"y?[iu]ver(?:s[ae]n[ae]|[iu]r\s*m[iu]s[iu]n)?|m[ae]l[iu]s[iu]n|y?[aeiu]?c[ae](?:ks[iu]n|n|z|k\s*m[iu]s[iu]n)|"
           rf"m[ae](?:k|n[iu]|s[iu]n[iu])\s+{_WANT}|m[ae](?:k|n)\s+{_NEED}|s[ae]n\s+(?:iyi|guzel|harika|super)\s+olur")
_REQ_PL = (r"y?[iu]n(?:[iu]z)?|s[iu]n(?:l[ae]r)?|[aeiu]?r\s*m[iu]s[iu]n[iu]z|y?[ae]bilir\s*m[iu]s[iu]n[iu]z|"
           r"y?[iu]ver(?:[iu]n(?:[iu]z)?|[iu]r\s*m[iu]s[iu]n[iu]z)|m[ae]l[iu]s[iu]n[iu]z|y?[aeiu]?c[ae](?:ks[iu]n[iu]z|k\s*m[iu]s[iu]n[iu]z)|"
           r"s[ae]n[iu]z\s+(?:iyi|guzel|harika|super)\s+olur")
_RC_REQ1 = rf"{_REQ_PL}|{_REQ_SG}"
_RC_REQ = rf"{_RC_REQ1}|y?[iu]p\s+(?:(?:bana|bize|hemen|sonra|lutfen|da|de)\s+)?{_ASK_V}(?:{_RC_REQ1})?"
_RC_REQ_SG = rf"{_REQ_SG}|y?[iu]p\s+(?:(?:bana|bize|hemen|sonra|lutfen|da|de)\s+)?{_ASK_V}(?:{_REQ_SG})?"
# benzer videonun tekil yolu kibar çoğul soruyu ("yapar mısınız", "yapabilir misiniz") almaz (12. tur; server.js REQ_SG1 aynı metin; inceleme,
# 20 Ekim: "Evde videodaki gibi yapar mısınız #challenge" izleyici sözüne bakılmadan benzer video oluyordu): o biçim çoğul yoldan
# (RECREATE_PL, izleyici sözü yoksa) sayılır; "çizgi filme çevirir misiniz" tekil kolda kalır
_REQ_SG1 = (r"s[ae]n[ae]|y?[ae]l[iu]m(?!\s*m[iu](?![a-z]))|[aeiu]?r\s*m[iu](?:s[iu]n|y[iu]z)|y?[ae]bilir(?:\s*m[iu](?:s[iu]n|y[iu]z)|s[iu]n)|"
            r"y?[iu]ver(?:s[ae]n[ae]|[iu]r\s*m[iu]s[iu]n)?|m[ae]l[iu]s[iu]n|y?[aeiu]?c[ae](?:ks[iu]n|n|z|k\s*m[iu]s[iu]n)|"
            rf"m[ae](?:k|n[iu]|s[iu]n[iu])\s+{_WANT}|m[ae](?:k|n)\s+{_NEED}|s[ae]n\s+(?:iyi|guzel|harika|super)\s+olur")
_RC_REQ_SG1 = rf"{_REQ_SG1}|y?[iu]p\s+(?:(?:bana|bize|hemen|sonra|lutfen|da|de)\s+)?{_ASK_V}(?:{_REQ_SG1})?"
_PASS_OPT = r"(?:[iu]l|n)s[iu]n(?:l[ae]r)?"  # edilgen istek: yapılsın, hazırlansın
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
# işaretten (virgül, iki nokta, tire, nokta, ünlem, emoji…) ya da satır sonundan sonra en çok dört kelime ya da süre (ardından istek
# fiili gelmeli: "fragman, kısa olsun", "fragman - orijinal sesini kullan", "haber gibi, özetle", "haber gibi\nözetle"; inceleme, 20 Ekim:
# "fragman. kısa tut", "Fragman! Orijinal sesini kullan", "fragman 🎬 kısa olsun", "fragman. 40 saniye olsun", "haber gibi! özetle")
_CLAUSE = rf"[^\S\n]*(?:{_KS}(?:[^\S\n]*{_KS})*(?![^\S\n]*{_KS})|(?=\n))(?:\s+(?:{_KL}+|{_FILLTOK})){{0,4}}"  # işaret dizisi bütün (geri izlenmez)
# + yapılacak (yalnız talimatın sonunda, ardından yalnız işaret/dolgu/süre ya da işaretten sonra kısa "… olsun/kalsın" cümlesi: "mizah
# videosu yapılacak.", "bundan mizah videosu yapılacak, 40 saniye", "bundan mizah videosu yapılacak, kısa olsun" — 9. tur; inceleme, 20 Ekim: sıfat-fiil "haber yapılacak kadar önemli değil", "Mizah yapılacak bir durum değil", duyuru "Viral video
# çekilecek, herkes meydana", "Kazanın haberi yazılacak, ama kimse sorumluluk almıyor" istek sanılıyordu), yapılması lazım; "yapılmalı"
# görüş, "yapılacak mı?" soru, istek değil
_PASS = rf"(?:[iu]l|n)(?:s[iu]n(?:l[ae]r)?|[ae]c[ae]k(?={_SIGN_END}|{_CLAUSE}\s+(?:olsun|kalsin)(?!{_KL}){_SIGN_END})|m[ae]s[iu]\s+{_NEED})"
# "geç" (koy, yaz: "haber olarak geç") yalnız istek ekiyle ya da ifade sonunda; "son dakika geç kaldı" (sıfat) istek değil
_GEC = rf"gec(?:{_REQ}|(?={_TO_END}))"
_ASK_A = rf"(?:{_ASK_V}(?:{_REQ})?|{_GEC}|olsun)(?!{_KL})"  # etken istek ("haber gibi anlat", "haber olarak paylaş", "son dakika olsun")
_ASK_A_SG = rf"(?:{_ASK_V}(?:{_REQ_SG})?|{_GEC}|olsun)(?!{_KL})"  # zarf araya girince yalnız tekil/sahip biçimi
# etken ya da edilgen istek ("komik video yapılsın", "mizah videosu yapılacak") ya da istiyorum ("mizah videosu istiyorum")
_KIND_WANT = r"istiyoru[mz]|isterim|isteriz"
_ASK_P = rf"(?:{_ASK_V}(?:{_REQ}|{_PASS})?|{_GEC}|olsun|{_KIND_WANT})(?!{_KL})"
_ASK_P_SG = rf"(?:{_ASK_V}(?:{_REQ_SG}|{_PASS})?|{_GEC}|olsun|{_KIND_WANT})(?!{_KL})"


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
# ifade ile fiil arasında sayılan kelime (inceleme, 20 Ekim: "haberini kısaca hazırla", "haber gibi tarafsız anlat", "haber olarak sade bir
# dille anlat", "haberini ayrıntılı bir şekilde hazırla", "haber olarak tarafsız ve net anlat" kaçıyordu; "bir şekilde" tek ara kelime; "sen"
# yalnız _NEWS_SEN'de)
_ASK_GAP_O = rf"(?:bir|bi|kisa|uzun|video{_KL}*|ozet{_KL}*|bunu|sunu|bana|lutfen|hemen|olarak|sey|bisey|birsey|sekilde|bicimde)"  # HEAD'in listesi
_ASK_GAP = (rf"(?:(?:bir|bi)\s+(?:sekilde|bicimde)|bir|bi|kisa|uzun|video{_KL}*|ozet{_KL}*|bunu|sunu|bana|lutfen|hemen|olarak|sey|bisey|birsey|"
            rf"sekilde|bicimde|kisaca|hizlica|detayli|ayrintili|sade|net|tarafsiz|guzelce|biraz|dille|ve)")
# ara kelimeler: en çok üç, biri süreyse dört ("haber olarak 40 saniyelik kısa bir video hazırla"). Zarf (kısaca, net, tarafsız…) araya
# girerse fiil yalnız tekil/sahip istek biçiminde (9. tur, inceleme, 20 Ekim: yapıştırılan "Medya, haberleri tarafsız yapın!" haber isteği
# sanılıyordu): _GAP_O yalnız HEAD'in ara kelimeleri + her istek biçimi, _GAP zarflar da + _REQ_SG
_GAP_TOK = rf"(?:{_ASK_GAP}|{_FILLTOK})\s+"
_GAP_TOK_O = rf"(?:{_ASK_GAP_O}|{_FILLTOK})\s+"
_DUR = r"[0-9]+\s*(?:saniye|sn|dakika|dk)"
# süre ilk dört sözcükte mi (ucuz ön bakış); ikinci kol yalnız süre yokken: süre varken onun her eşleşmesi birinci kolda zaten denenmiştir
# (sonuç aynı, uzun girdide boşa geri izleme yok)
_GAP = rf"(?:(?=(?:\S+\s+){{0,3}}{_DUR})(?:{_GAP_TOK}){{0,4}}|(?!(?:\S+\s+){{0,3}}{_DUR})(?:{_GAP_TOK}){{0,3}})"
_GAP_O = rf"(?:(?=(?:\S+\s+){{0,3}}{_DUR})(?:{_GAP_TOK_O}){{0,4}}|(?!(?:\S+\s+){{0,3}}{_DUR})(?:{_GAP_TOK_O}){{0,3}})"
# ifadeden sonra istek fiili: araya en çok üç ara kelime ya da süre ("haber olarak 30 saniyelik bir video yap", "son dakika olarak kısa bir
# video hazırla"; inceleme, 19 Ekim: süre araya girince haber isteği kaçıyordu); fiilden sonra ret ("haber gibi yap değil") ve alıntı sayılmaz
_TO_VERB = rf"\s+(?!\s)(?:{_GAP_O}{_ASK_A}|{_GAP}{_ASK_A_SG})"  # (?!\s): boşluk dizisi geri izlenirken her adım ucuz
_TO_ASK = rf"{_TO_VERB}(?!{_REFUSAL_NEWS}){_SAY}"
# reddedilen istek ("son dakika yazma", "haber değil", "mizah videosu yapmayın") etiket ve ifade denetiminden önce atılır: kalan "mizah"
# etikettir ("son dakika diye yapma mizah", "haber değil mizah" → mizah)
_REFUSED_P = (rf"(?<!{_KL})(?:(?:son\s*dakika|haber(?:i|ini)?)(?!{_KL}){_REFUSAL_NEWS}|"
              rf"#?(?:mizah|mizahi|komik|esprili|komedi|trend|viral)(?:\s+(?:(?:bir|bi)\s+)?(?:video|icerik|paylasim){_KL}*)?(?!{_KL}){_REFUSAL_KIND})")
_REFUSED = re.compile(_REFUSED_P)
# açık haber isteği (fragman kararı, video türü, benzer video, özet; server.js NEWS_RE aynı kalıp). GÜÇLÜ biçim (her zaman haber):
# - "haber(i/ini/leri) yap|hazırla|üret|çek|yaz" (+ "haber videosu yap") istek biçiminde, edilgen istek de ("haberi yapılsın/yapılacak/yapılması
#   lazım"); araya en çok üç ara kelime ya da süre girebilir ("haberini 30 saniyelik hazırla", "bunun haberini kısa yap", "haberini kısa bir
#   şekilde hazırla", "haber videosu 30 saniyelik hazırla"; inceleme, 19 Ekim: trailer başlıklı link fragman analizine gidiyordu);
#   "haber yaparken/yapan/yaptığı", "haber çekimi", "haber yapmak yerine" değil
# - "haber olsun" yalnız videoyu gösterirken: talimatın başında ("haber olsun ama kısa") ya da bu/bu video/şu/bunu/şunu/videoyu (+ da/de)
#   sonra ("bu video haber olsun abi") ya da talimatın son sözü olarak (ardından yalnız işaret/dolgu/süre: "…ama vazgeçtim, normal haber
#   olsun"; bu biçim _HO_END'de, yalnız gülme emojisi yoksa); yönelme hâlinden ("herkese haber olsun") ve kalmasın/duysun/bilsin/görsün/
#   öğrensin'den sonra deyimdir, istek değil ("duymayan kalmasın haber olsun 😂", "herkes duysun, haber olsun"; inceleme, 19 Ekim)
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
# - "haber(i/ini) + ara kelime + yaz/çek": ad da olabilen bu iki kökte ara kelime varsa fiil istek ekli ya da yalın kök + ifade sonu (inceleme,
#   20 Ekim: "Acı haberi bir yaz günü aldık", "Bu haberi 2 yaz önce paylaşmıştık", "Kötü haberi bir çek ile verdiler" ad); yap/hazırla/üret
#   yalın kökü her yerde ("bunun haberini kısa yap ve paylaş", "haberini kısa yap sesi kalsın")
# - talimatın başında "(bundan/bunun) haber(ini) (videosu) istiyorum" ("haber istiyorum bundan, 40 saniye"; cümle içindeki "Tarafsız haber
#   istiyoruz" pankartı değil)
_NEWS_V = r"(?:yap|hazirla|uret|cek|yaz)"
# ara kelimeli yaz/çek ardından devam da istek sayılır (9. tur, inceleme, 20 Ekim: "bunun haberini kısa yaz ve paylaş", "haberini kısa çek ve
# gönder", "bunun haberini bi yaz bakalım", "haberini kısa yaz hadi" kaçıyordu): ve/sonra/da/de/ama + (en çok iki söz) istek fiili ya da
# bakalım/hadi/şimdi + ifade sonu ("Acı haberi bir yaz günü aldık" yine ad)
_YC_CONT = rf"(?=\s+(?:(?:ve|sonra|da|de|ama)\s+(?:{_KL}+\s+){{0,2}}{_ASK_A}|(?:bakalim|hadi|haydi|simdi){_TO_END}))"
_NEWS_GV = rf"(?:(?:yap|hazirla|uret)(?:{_REQ}|{_PASS})?|(?:cek|yaz)(?:{_REQ}|{_PASS}|(?={_TO_END})|{_YC_CONT}))"  # ara kelimeden sonra
_NEWS_GV_SG = rf"(?:(?:yap|hazirla|uret)(?:{_REQ_SG}|{_PASS})?|(?:cek|yaz)(?:{_REQ_SG}|{_PASS}|(?={_TO_END})|{_YC_CONT}))"  # zarflı ara kelimeden sonra
_GAP1 = rf"(?:(?=(?:\S+\s+){{0,3}}{_DUR})(?:{_GAP_TOK}){{1,4}}|(?!(?:\S+\s+){{0,3}}{_DUR})(?:{_GAP_TOK}){{1,3}})"
_GAP1_O = rf"(?:(?=(?:\S+\s+){{0,3}}{_DUR})(?:{_GAP_TOK_O}){{1,4}}|(?!(?:\S+\s+){{0,3}}{_DUR})(?:{_GAP_TOK_O}){{1,3}})"
NEWS_RE = re.compile(
    rf"(?<!{_KL})(?:son\s*(?:dakika|dk)(?!{_KL}|['’])(?!{_REFUSAL_NEWS})(?=\s+{_SD_FOLLOW}(?:{_TO_END}|{_TO_ASK})|{_TO_ASK})|"
    rf"haber(?:i|ini|inin|ler|leri|lerini)?\s+(?:videosu(?:nu)?\s+)?(?:{_NEWS_V}(?:{_REQ}|{_PASS})?|{_GAP1_O}{_NEWS_GV}|{_GAP1}{_NEWS_GV_SG})"
    rf"(?!{_KL}){_SAY}|"
    rf"(?:^(?:[^\w]|_)*|(?:(?:bu|su)(?:\s+video)?|bunu|sunu|videoyu)(?:\s+d[ae])?\s+(?=haber\s+olsun{_SIGN_END}))haber\s+olsun(?!{_KL}){_SAY}|"
    rf"^(?:[^\w]|_)*(?:(?:bundan|bunun|bunu|sundan|sunun|bir|bi)\s+){{0,2}}haber(?:i|ini)?\s+(?:videosu\s+)?istiyorum(?!{_KL}){_SAY}|"
    rf"haber\s+olarak(?=(?:\s+{_FILLTOK}){{1,4}}{_T}|[^\S\n]*(?:$|\n|(?![,;]){_KS}|[,;](?={_SIGN_END}|{_TO_ASK}|\s*{_REFUSED_P}))|{_TO_ASK})|"
    rf"haber\s+(?:gibi|seklinde|tarzinda|formatinda|diliyle)(?={_TO_ASK})|"
    rf"(?:habere\s+(?:cevir|donustur)|haberlestir|haber\s+haline\s+getir)(?:{_REQ})?(?!{_KL}){_SAY})(?!{_REFUSAL_NEWS})")
# talimatın son sözü "haber olsun" (ardından yalnız işaret/dolgu/süre) yalnız metinde gülme emojisi yoksa (inceleme, 20 Ekim: "Komşunun
# horozu yine sabah 5'te öttü, haber olsun 😂", "Kedim ilk kez kar gördü, haber olsun 😹" şaka; başta ve bu/şu'dan sonraki biçim NEWS_RE'de)
_HO_END = re.compile(rf"(?<!{_KL})(?<![ae]\s){_HO_IDIOM}haber\s+olsun(?={_SIGN_END})")
# bu/şu/bu video/bunu/şunu/videoyu (+ da/de) + "haber olsun" ardından altyazı sürüyorsa yalnız metinde gülme işareti yoksa (9. tur: "Bu haber
# olsun 😂 Köpek postacıyı kovaladı" şaka altyazısı; talimatın başındaki ve son sözü olan biçim — "bu video haber olsun 😂" — NEWS_RE'de)
_HO_THIS = re.compile(rf"(?<!{_KL})(?:(?:bu|su)(?:\s+video)?|bunu|sunu|videoyu)(?:\s+d[ae])?\s+haber\s+olsun(?!{_KL}){_SAY}(?!{_REFUSAL_NEWS})")
# "haberini sen hazırla" (ara kelime "sen") de yalnız metinde gülme işareti yoksa (inceleme, 20 Ekim: "Haberini sen yap, tıklanmayı biz
# alalım 😂" şaka)
_NEWS_SEN = re.compile(rf"(?<!{_KL})haber(?:i|ini|inin|ler|leri|lerini)?\s+(?:videosu(?:nu)?\s+)?(?:{_GAP_TOK}){{0,2}}sen\s+(?:{_GAP_TOK}){{0,2}}"
                       rf"{_NEWS_GV}(?!{_KL}){_SAY}(?!{_REFUSAL_NEWS})")
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
# gülme işareti (server.js LAUGH aynı kalıp): gülen/utanan/dil çıkaran emojiler ve yazıyla gülme (haha, ahah, jsjs, sjsj, kdkd, ksks, xd, :d;
# inceleme, 20 Ekim: "Son dakika: Kedim yine kanepeyi parçaladı 🙈", "… ahahaha", "… ülke şokta 💀" haber oluyordu)
_LAUGH = re.compile(rf"[😂🤣😹😆😅😁😄😝🤪🙈🤭😜😛😀😃🙃💀]|(?<!{_KL})(?:a?(?:ha){{2,}}h?|ah(?:ah)+|(?:js){{2,}}j?|(?:sj){{2,}}s?|(?:kd){{2,}}k?|(?:ks){{2,}}k?|xd+|:d+)(?!{_KL})")
_SD_LABEL = re.compile(rf"(?<!{_KL})son\s*dakika(?!{_KL}|['’])(?!{_REFUSAL_NEWS})(?={_T})")
_NEWS_START = re.compile(rf"^(?:[^\w]|_)*son\s*dakika\s+(?={_KL}+['’]|[0-9])")
# başta "Son dakika haberi:" / "SON DAKİKA HABERİ!" etiketi (ardından işaret ya da satır sonu) "son dakika:" gibi zayıf biçim (11. tur; server.js
# SD_HABER aynı metin): gülme işareti ya da açık #mizah/#komik/tür ifadesi karar verir; "son dakika haberi yap" güçlü biçim kalır; önünde emoji
# ve en çok 8 hashtag olabilir (13. tur; inceleme, 20 Ekim: "#mizah Son dakika haberi: …" güçlü biçim sayılıp haber oluyordu)
_SD_HABER = re.compile(rf"^(?:(?:[^\w]|_)*#(?:[^\W\d_]|[0-9])+){{0,8}}(?:[^\w]|_)*son\s*(?:dakika|dk)\s+haber(?:i|leri)?(?=[^\S\n]*(?:\n|{_KS}))")
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
_WORD = rf"{_KL}+(?:['’]{_KL}+)*(?!{_KL}|['’]{_KL})"  # kelime (kesme işaretli ek aynı kelime: "Kadıköy'de")
_KIND_VERB = rf"\s+(?!\s)(?:(?:ama|ve|ancak)\s+)?(?:{_GAP_O}{_ASK_P}|{_GAP}{_ASK_P_SG})(?!{_REFUSAL_KIND}){_SAY}"
# ciddi olay sözlü metinde ifade sonu (_KIND_END_S, server.js KIND_END_S aynı kural): metin sonu (araya dolgu/süre) ya da işaret/satır sonundan
# sonra metnin kalanında en çok 4 kelime (link, süre ve dolgu sayılmaz; _KIND_LEAD gibi) ve bunların arasında cümle sonu -DI geçmiş zaman yok ("komik video, kısa kes", "mizah videosu 😂", "komik video: haber
# gibi hazırlanmış skeç"; "Viral video: Selde araçlar sürüklendi" haber başlığı). Daha uzun kalan metin _phrase_kinds'te (_KIND_SIGNHEAD):
# kalanında sahibin istek/kurgu fiili varsa ("komik video, 30 saniye, başındaki titrek kısmı kes", "Komik video: kedinin düştüğü yeri ağır
# çekim göster") ya da -DI'sız şimdiki zamanla anlatım varsa ("komik video: adam merdivenden kayıyor, sonunda kova kafasına düşüyor") tür
# sayılır; geçmiş zamanlı uzun başlık ("Komik video, acı son: Balkondan düşen genç hayatını kaybetti", "Viral video: Selde mahsur kalan aile
# helikopterle kurtarıldı") ve fiilsiz uzun ad öbeği tür almaz (inceleme, 20 Ekim)
_FILL_W = rf"(?:saniye{_KL}*|sn|dakika{_KL}*|dk|lutfen|bunu|sunu|hemen|olarak)(?!{_KL})"  # kelime sayısına girmeyen dolgu
_FEW_SEP = rf"(?:(?!{_KL})[\s\S]|(?:https?:|www\.)\S*(?!\S)|(?<!{_KL}){_FILL_W}|(?<=[0-9]['’]){_KL}+(?!{_KL}))*"  # link tek parça (geri izlemede bölünmez); sayının eki kelime değil ("14'te"; 11. tur)
# cümle sonu -DI geçmiş zaman (haber dili: düştü, kaybetti, kurtarıldı, oldu; -DI ile biten yaygın adlar değil)
_PAST_W = (rf"(?!(?:kedi|kendi|simdi|hindi|hadi|haydi|ordu|alti|ustu|arti|ortu|yedi|parodi|komedi|trajedi|melodi|parti|kutu|adi|tadi|kaydi|yurdu|"
           rf"saati|sirketi|devleti|milleti|goruntu|marti|pati|bati|kati|cati|seti)(?!{_KL})){_KL}{{2,}}[dt][iu](?:[mnkz]|l[ae]r|n[iu]z)?"
           rf"(?!{_KL})(?=[^\S\n]*(?:$|\n|{_KS}))")
# (beşinci kelime aranır, bulununca hemen biter: uzun girdide her ifadede geri izleme yok)
_FEW_W = rf"{_FEW_SEP}(?!{_FILL_W}|https?:|www\.)(?<![0-9]['’])"  # kelimeye kadar (link bölünmez, dolgu kelime değil)
_KIND_END_S = rf"(?:\s+{_FILLTOK}){{0,4}}[^\S\n]*(?:$|(?=\n|{_KS})(?!(?:{_FEW_W}{_WORD}){{5}})(?!(?:{_FEW_W}{_WORD}){{0,3}}{_FEW_W}{_PAST_W}))"
# ÖNCE HEAD (server.js KIND_FOLLOW; 15. tur, inceleme, 21 Ekim: 9.-14. turun "işaretten sonra en çok 4 kelime ya da -DI/şimdiki zamanla en
# çok 8 kelime" kuralı HEAD'in "komik video, teşekkürler abi, iyi akşamlar, kolay gelsin", "Komik video: düğünde gelini görünce bayılan damat
# 😂" türünü düşürüyordu): metinde ciddi olay sözü (_SERIOUS) yoksa ya da gülme işareti varsa HEAD'in kuralı — tür ifadesinden sonra işaret,
# satır sonu ya da metin sonu (araya dolgu/süre) yeter, kalan metin ne olursa olsun —; ciddi olay sözü varken (gülme yoksa) 8. turun kuralı
# (_KIND_END_S: en çok 4 kelime, -DI yok): "Komik video, acı son: Balkondan düşen genç hayatını kaybetti", "Viral video: Selde araçlar
# sürüklendi" tür almaz
_KIND_FOLLOW = rf"{_TO_END}|{_KIND_VERB}"
_KIND_FOLLOW_S = rf"{_KIND_END_S}|{_KIND_VERB}"
# ciddi olay sözü (kind_fold'lu: "öldü" "oldu"dan ayrılamaz, yerine "hayatını kaybetti", "öldürüldü", "ölü")
_SERIOUS = re.compile(rf"(?<!{_KL})(?:hayatini\s+kaybet|yasamini\s+yitir|can\s+verdi|vefat|sehit|oldurul|olu(?:ler{_KL}*)?(?!{_KL})|yaralan|yarali|"
                      rf"gozalti|tutuklan|kaza(?!n)|deprem|yangin|sel(?:de|den|e|i|in|ler)?(?!{_KL})|saldir|cinayet|intihar|patlama|enkaz|"
                      rf"kurtarilamadi|istifa|bogul|katliam|bicakla|silahli|kursun|teror|bombal|taciz|istismar|darp|kaybol|kacirildi|felaket|"
                      rf"carpt|carpis|gercek(?!{_KL}))")
# "öldü/ölü/öldürüldü" harfsiz yazımda "oldu"dan ayrılmaz: tr-TR küçük harfli asıl metinde (server.js OLU aynı kalıp)
_OLU = re.compile(r"(?<![a-zçğıöşüâîû])öl(?:dü|dür|ü|müş|en)")
# esprili/komedi de mizah ("esprili bi video yap", "bunu komedi videosu yap"; yalın etiket değil)
_KIND_WORD = r"(mizah|mizahi|komik|esprili|komedi|viral|trend|cok\s+izlenen)"
_PHRASE_KIND = {**KIND_WORDS, "esprili": "mizah", "komedi": "mizah"}
_KIND_REST = (rf"\s+(?:(?:bir|bi)\s+)?(?:{_NOUN}|sey|bisey|birsey|olarak|amacli|kategori{_KL}*|sekilde|bicimde|dille|tarz(?:i|da|inda))(?!{_KL})"
              rf"(?!{_REFUSAL_KIND})")
_KIND_DOV = rf"\s+(?:{_ASK_V}(?:{_REQ}|{_PASS})?|{_GEC}|(?<!viral\s)olsun|{_KIND_WANT})(?!{_KL})(?!{_REFUSAL_KIND}){_SAY}"
# "mizaha çevir" ("habere çevir" gibi; inceleme, 19 Ekim): 4. grup. Fiilsiz ifade üstünlük sıfatından sonra betimlemedir ("Haftanın en çok
# izlenen videosu: Depremde enkazdan çıkarılan bebek", "en komik video 😂"; inceleme, 20 Ekim)
_KIND_PHRASE_P = (rf"(?<!{_KL})(?:(?<![iu]n\s)(?<!(?<!{_KL})en\s){_KIND_WORD}(?:{_KIND_REST}(?=FOLLOW)|{_KIND_DOV})|{_KIND_WORD}{_KIND_REST}(?={_KIND_VERB})|"
                   rf"(mizah)a\s+(?:cevir|donustur)(?:{_REQ})?(?!{_KL})(?!{_REFUSAL_KIND}){_SAY})")
_KIND_PHRASE = re.compile(_KIND_PHRASE_P.replace("FOLLOW", _KIND_FOLLOW))
_KIND_PHRASE_S = re.compile(_KIND_PHRASE_P.replace("FOLLOW", _KIND_FOLLOW_S))
# #etiket (#mizah, #trend, #haber) yalnız kısa metinde, metnin tek etiketiyse ya da gülme işaretiyle mizah/viral etiketiyse tür (9. tur: uzun
# altyazının sonundaki "#haber #gündem #viral" dizisi tür değil); reddedilenler atılmış metinde; #mizah ve #haber birlikte + gülme işareti →
# mizah ("Kedimiz kumandayı saklamış 😂 #komik #haber #keşfet")
_KIND_HASH = re.compile(rf"(?<!{_KL})#(mizah|mizahi|komik|trend|viral|haber)(?!{_KL})(?!{_REFUSAL_KIND})")
_HASHTAG = re.compile(rf"(?<!{_KL})#{_KL}")
# işaret ya da satır sonuyla biten tür ifadesi: kalan metne _phrase_kinds bakar (metin başına bir kez: son istek fiili, son şimdiki zaman ve
# son -DI geçmiş zaman yeri; uzun girdide her ifadede metnin sonuna kadar tarama yok). Sahibin istek/kurgu fiili tekil/sahip biçiminde
# (_REQ_SG; yayın fiilleri ve izleyiciye "yorum yaz" sayılmaz) ya da "kalsın": "sesi kalsın"
_KIND_SIGNHEAD = re.compile(rf"(?<!{_KL})(?<![iu]n\s)(?<!(?<!{_KL})en\s){_KIND_WORD}{_KIND_REST}(?:\s+{_FILLTOK}){{0,4}}[^\S\n]*(?=\n|{_KS})")
_OWN_V = (r"(?:anlat|yap|hazirla|uret|sun(?!un(?![a-z]))|yaz|kurgula|ver|goster|cek|at|isle|seslendir|oku|cevir|donustur|olustur|canlandir|"
          r"tasarla|ciz|koy(?!un(?![a-z]))|ekle|kullan|tut|ozetle|duzenle|kes|kisalt|al|yavaslat|hizlandir|sil|kirp|cikar)")
_KIND_ASK = re.compile(rf"(?<!{_KL})(?<!yorum\s)(?:{_OWN_V}(?:{_REQ_SG})?(?!{_KL})(?!{_REFUSAL_KIND}){_SAY}|kalsin(?!{_KL}))")
_KIND_PROG = re.compile(rf"(?<!{_KL}){_KL}+[iu]yor(?:[iu]m|[iu]z|sun(?:uz)?|l[ae]r)?(?!{_KL})")
_KIND_PAST = re.compile(rf"(?<!{_KL}){_PAST_W}")
# kalan metinde saat de sahibin isteğidir (14. tur; server.js KIND_SCHED_RE aynı metin; inceleme, 21 Ekim: WhatsApp videosunun açıklamasında
# "mizah videosu, 2 saat sonra yayınlarsan iyi olur", "komik video, 21:30 sularında post et sağ ol" HEAD'de türdü): saat varsa ve ardından -DI
# geçmiş zaman yoksa tür
_KIND_SCHED = re.compile(r"(?<![0-9.,:])[0-9]{1,2}(?::[0-9]{2}(?![0-9])|(?:[.:][0-9]{2})?['’](?:d[ae]|t[ae])(?!" + _KL + r"))|(?<!" + _KL
                         + r")(?:(?:saat|sabah|ogle(?:n|den\s+sonra)?|aksam|gece|ikindi)\s+(?:saat\s+)?[0-9]{1,2}(?![0-9])|(?:[0-9]{1,3}|bir|yarim)\s*"
                         r"(?:dakika|dk|saat)\s+sonra(?!" + _KL + r"))")
# sonda işaretten (ya da satır sonundan) sonra yalın etiket: "Adam düştü 😂 mizah", "son dakika diil bu, viral", "bu haber değil, mizah";
# yalnız kısa metinde (etiketin dışında en çok 4 kelime, _TAG_WORDS; inceleme, 19 Ekim: "Selde mahsur kalan aile helikopterle kurtarıldı -
# Viral", "Ünlü şefin skandalı ortaya çıktı… (Viral)" gibi uzun ciddi altyazı viral video oluyordu)
_KIND_TAIL = re.compile(rf"(?:{_KS}|\n)[^\S\n]*#?(mizah|mizahi|komik|trend|viral|haber)(?:[^\S\n]*{_KS})*\s*$")
_TAG_WORDS = 4
_URL = re.compile(r"https?://\S*|www\.\S*")  # kelime sayısında link sayılmaz
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


def _tr_low(t: str) -> str:
    """Türkçe küçük harf (server.js toLocaleLowerCase("tr-TR") ile aynı sonuç: ayrık İ, I → ı)."""
    t = _DOT_I.sub(lambda m: "i" + m.group(1) if all(unicodedata.combining(c) not in (0, 230) for c in m.group(1)) else m.group(0), str(t or ""))
    return t.replace("I", "ı").replace("İ", "i").lower()


def kind_fold(t: str) -> str:
    """Türkçe küçük harf + harfsiz yazım (ı→i, ş→s…): "MİZAH", "MIZAH", "mızah" aynı (server.js kindFold ile aynı sonuç)."""
    return _tr_low(t).translate(str.maketrans("ıöçşüğâîû", "iocsugaiu"))


_SIGN_RUN = re.compile(r"((?:[^\w\s'’]|_))\1{3,}")


def _kind_text(t: str) -> str:
    """kind_fold + JS'nin karakter sınıfları (server.js ile birebir aynı sonuç): Python'un harf sınıfına giren harf olmayan sayı işaretleri
    (², ₂, Ⅻ) ve yalnız Python'un boşluk saydığı denetim karakterleri ayraç, yalnız JS'nin boşluk saydığı U+FEFF boşluk."""
    t = "".join("\0" if c in "\x1c\x1d\x1e\x1f\x85" or (c.isnumeric() and not c.isdecimal() and not c.isalpha()) else " " if c == "﻿"
                else c for c in kind_fold(t))
    # aynı işaretin uzun dizisi üçe iner (11. tur; server.js kindFold aynı kural): kalıplar işaret sayısına bakmaz, uzun dizide boşa tarama
    return _SIGN_RUN.sub(r"\1\1\1", t)


def news_request(text: str) -> bool:
    """Talimat açıkça haber istiyor mu (yalnız istek biçimi: "haber yap", "haberini hazırlar mısın", "haber olarak paylaş", "haber gibi
    anlat", "habere çevir", "son dakika", "son dakika olarak"; ret, alıntı ve betimleme değil: "haber yapma", "haber yap dedi", "haber
    yaparken", "son dakika yok", "son dakika golü"). server.js newsRequest aynı kural."""
    return _news(_kind_text(text), bool(_OLU.search(_tr_low(text))))


def _news(t: str, ser: bool = False) -> bool:
    """news_request, _kind_text'li metinde (content_kind ve recreate_ask de bunu kullanır): güçlü biçim (NEWS_RE) her zaman, zayıf biçim
    (etiket "son dakika", başta "Son dakika Kadıköy'de…", başta fiilsiz "haber gibi") yalnız açık mizah/viral ifadesi yoksa."""
    lbl = bool(_SD_HABER.search(t))
    if NEWS_RE.search(_SD_HABER.sub(" ", t, count=1) if lbl else t) or ((_HO_END.search(t) or _HO_THIS.search(t) or _NEWS_SEN.search(t)) and not _LAUGH.search(t)):
        return True
    return bool((((_SD_LABEL.search(t) or _NEWS_START.search(t) or lbl) and not _LAUGH.search(t)) or _NEWS_LIKE.search(t))
                and not {"mizah", "trend"} & _phrase_kinds(_REFUSED.sub(" ", t), True, ser))


def _phrase_kinds(s: str, any_len: bool = False, ser: bool = False) -> set:
    """Reddedilenleri atılmış metindeki açık tür ifadelerinin ve sondaki yalın etiketin türleri (#haber → haber, çok izlenen → trend). Sondaki
    etiket tür olarak yalnız kısa metinde sayılır; zayıf haber biçimini (any_len: _news) her uzunlukta bastırır ("son dakika: …, mizah")."""
    laugh = _LAUGH.search(s)
    grave = bool((ser or _SERIOUS.search(s)) and not laugh)
    rx = _KIND_PHRASE_S if grave else _KIND_PHRASE
    ks = {_PHRASE_KIND.get(x, "trend") for g in rx.findall(s) for x in g if x}
    short = any_len or len(re.findall(_WORD, _URL.sub(" ", s))) <= _TAG_WORDS + 1
    hk = {KIND_WORDS[x] for x in _KIND_HASH.findall(s)}
    # ciddi olay sözü yoksa (ya da gülme varsa) #haber'siz mizah/viral hashtag'i HEAD gibi her uzunlukta tür (15. tur; server.js aynı kural:
    # "#mizah #komik Kedim yine masadan kaçtı", "Bu dans herkesi salladı #viral #trend"); #haber'li ya da ciddi uzun metin 9. turun kuralıyla
    if hk and (short or len(_HASHTAG.findall(s)) == 1 or (laugh and hk - {"haber"}) or (not grave and "haber" not in hk)):
        ks |= hk - {"haber"} if "mizah" in hk and laugh else hk
    heads = [m for m in _KIND_SIGNHEAD.finditer(s) if _PHRASE_KIND.get(m.group(1), "trend") not in ks]  # türü zaten bulunan atlanır
    if heads:  # işaretle biten tür ifadesi: kalanında sahibin isteği ya da -DI'sız şimdiki zamanla anlatım
        last = lambda rx: max((m.start() for m in rx.finditer(s)), default=-1)
        ask, prog, past = last(_KIND_ASK), last(_KIND_PROG), last(_KIND_PAST)
        sched = max((m.end() for m in _KIND_SCHED.finditer(s)), default=-1)  # saatin sonu (baş, saatin rakamını dolgu diye alabilir)
        ks |= {_PHRASE_KIND.get(m.group(1), "trend") for m in heads if ask >= m.end() or ((prog >= m.end() or sched >= m.end()) and past < m.end())}
    tail = _KIND_TAIL.search(s)
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
    ser = bool(_OLU.search(_tr_low(instruction)))
    s = _REFUSED.sub(" ", t)  # reddedilen istekler atılmış metin: kalan etiket ve ifade sayılır
    tags = _tag_words(s)
    if tags:
        ks = {KIND_WORDS[w] for w in tags}
        if "mizah" in ks and _LAUGH.search(t):  # "😂 #komik #haber" (9. tur)
            ks.discard("haber")
        return "haber" if "haber" in ks else "mizah" if "mizah" in ks else "trend"
    lead = _KIND_LEAD.match(t)  # başta ayraçla etiket: "mizah, kısa kes"; "Haber: Kedi itfaiyeyi alarma geçirdi 😂" değil (9. tur)
    if lead and not (lead.group(1) == "haber" and ":" in lead.group(0) and _LAUGH.search(t)):
        return KIND_WORDS[lead.group(1)]
    if _news(t, ser):
        return "haber"
    ks = _phrase_kinds(s, False, ser)
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
# işaretten sonra yalnız sahibin istek biçimi (tekil emir, -sana, -ır mısın, olsun, kalsın, analiz et, özetle; _REQ_SG) ve cümlede izleyiciye
# çağrı sözü yok (inceleme, 20 Ekim: yapıştırılan "Gerçek hayattan fragman 😱 hemen paylaşın", "Hayatın fragmanı 💔 beğen paylaş", "Bu gol
# fragman ⚽ izle paylaş" fragman analizine gidiyordu); "bu fragman çok iyi, analiz et" (değerlendirme sözü + istek) de istek
# (9. tur: bütün kelime; "fragman, yorumla", "fragman, takipçilere kısa anlat", "izlenme rekorunu da anlat" sahibin isteği)
# (10. tur: "yorumlara/yorumlarda/yorumunuzu" ve "beğendiyseniz" de: "Fragman. Yorumlara yazın, hangi sahne favoriniz?" istek değil; "yorumla" istek)
_TR_VIEW = (rf"(?:izle(?:yin(?:iz)?)?|begen(?:in(?:iz)?|diyseniz)?|kaydet|kaydedin(?:iz)?|takip|abone|yorum(?:lar)?(?:[ae]|d[ae]|[iu]|[iu]n[iu]z[iu]?)?|"
            rf"paylasin(?:iz)?|herkes)(?!{_KL})")  # izleyiciye çağrı
_CLAUSE_O = rf"[^\S\n]*(?:{_KS}(?:[^\S\n]*{_KS})*(?![^\S\n]*{_KS})|(?=\n))(?:\s+(?!{_TR_VIEW})(?:{_KL}+|{_FILLTOK})){{0,4}}"
_TR_ASKV = (rf"\s+(?!{_TR_VIEW})(?:{_ASK_V}(?:{_REQ_SG})?|{_GEC}|olsun|kalsin|(?:incele|yorumla)(?:{_REQ_SG})?|analiz\s+e[td](?:{_REQ_SG})?)(?!{_KL})"
            rf"(?!{_REFUSAL_KIND}){_SAY}")
_TR_EVAL = (r"(?:\s+(?:cok|baya|bayagi|gayet|cidden|asiri))?\s+(?:iyi|guzel|harika|super|efsane|mukemmel|muthis|sahane|basarili|etkileyici)"
            r"(?:\s+olmus)?(?![a-z])")
# talimatın başındaki fragman sözü + işaretten sonra sahibin çoğul isteği de (9. tur: "fragman, analiz edin", "Fragman: kısaca özetleyin")
_TR_ASKV_PL = (rf"\s+(?!{_TR_VIEW})(?:{_ASK_V}|incele|yorumla|analiz\s+e[td])(?:{_REQ_PL})(?!{_KL})(?!{_REFUSAL_KIND}){_SAY}")
TRAILER_ASK = re.compile(rf"^(?:[^\w]|_)*{_TR_WORD}(?!{_KL})(?:\s+(?:analiz{_KL}*|ozet{_KL}*|video{_KL}*|olarak))?(?={_CLAUSE_O}{_TR_ASKV_PL})|"
                         rf"(?<!{_KL}){_TR_WORD}(?!{_KL})(?:\s+(?:analiz{_KL}*|ozet{_KL}*|video{_KL}*|olarak))?"
                         rf"(?={_SIGN_END}|{_TR_VERB}|(?:{_TR_EVAL})?{_CLAUSE_O}{_TR_ASKV}|"
                         rf"[^\S\n]*[,;]?\s+(?:haber{_KL}*|son\s*dakika){_REFUSAL_NEWS})")


def _hash_tail(t: str) -> str:
    """Metnin sonundaki #etiket dizisi, önünde 4'ten çok kelime varsa atılır (9. tur: "Ünlü oyuncu sette kaza geçirdi 😱 #magazin #dizi
    #fragman" fragman isteği değil; server.js hashTail aynı kural)."""
    toks = list(re.finditer(r"\S+", t))
    k = len(toks)
    while k and toks[k - 1].group().startswith("#"):
        k -= 1
    if 0 < k < len(toks) and len(re.findall(_WORD, _URL.sub(" ", t[:toks[k].start()]))) > 4:
        return t[:toks[k].start()]
    return t


# fragman sözü yoksa kalıp ve sondaki etiket ayıklaması hiç çalışmaz (yalnız hız; server.js TR_HINT aynı metin)
_TR_HINT = re.compile(r"fragman|trailer|teaser")


def trailer_ask(instruction: str) -> bool:
    """Talimat fragman analizi istiyor mu (yalnız istek biçimi; server.js trailerAsk aynı kural)."""
    t = _kind_text(instruction)
    return bool(_TR_HINT.search(t) and TRAILER_ASK.search(_hash_tail(t)))


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
_RC_NUM = (r"(?:[0-9]+(?:[.,][0-9]+)?|(?:bir|iki|uc|dort|bes|alti|yedi|sekiz|dokuz|on|yirmi|otuz|kirk|elli|altmis|yetmis|seksen|doksan|yuz)"
           r"(?:\s+(?:bir|iki|uc|dort|bes|alti|yedi|sekiz|dokuz|on))?)")
# "siz de" ara kelime (13. tur: HEAD'in kabulü; sahibin çoğul isteği "Bunun benzerini siz de yapın" benzer video); yalın "daha" HEAD gibi ara
# kelime değil (14. tur; server.js aynı: alıntılanan "Bunun gibi bir video daha yapar mısınız?" sorusu benzer video değil; "bir tane daha" kalır)
_RC_FILL = (rf"(?:bir|bi|yeni|kisa|uzun|turkce|ingilizce|{_RC_NUM}\s*(?:saniye|sn|dakika|dk)(?:lik|\s*['’]\s*l[iu]k)?|(?:biz|sen|siz)(?:\s+d[ae])?|"
            rf"bana|bize|(?:benim|bizim)\s+icin|ayni|sifirdan|yeniden|tekrar|tarzda|sekilde|olarak|(?:{_RC_NUM}\s+)?tane(?:\s+daha)?|sey|bisey|birsey|"
            r"lutfen|hemen|"
            r"yarin|bugun|simdi|kendi\s+(?:cumle|soz)[a-z]*)(?![a-z])")
_RC_THING = r"(?:video(?:su|lar|lari)?|icerik|animasyon(?:la|lu)?|hikaye(?:yi)?|kissa(?:yi)?|cizim|cizgi\s+film(?:i|le|\s+gibi)?)(?![a-z])"
_RC_GAP = rf"(?:\s+(?:{_RC_FILL}|{_RC_THING})){{0,4}}"
_RC_GAP_T = rf"(?:\s+{_RC_FILL}){{0,3}}\s+{_RC_THING}(?:\s+{_RC_FILL}){{0,2}}"
_RC_WANT = r"\s+(?:olsun|istiyoru[mz]|isterim|isteriz)(?![a-z])"
_RC_END = (rf"(?:{_RC_WANT}|[^a-z0-9:]*$|\s*[,.;:!?…]+\s*(?:{_RC_FILL}|{_RC_THING})"
           rf"(?:\s+(?:{_RC_FILL}|{_RC_THING})){{0,3}}[^a-z0-9:]*$)")  # iki nokta açıklama başlatır, son değil ("Sıfırdan animasyon: …")
_RC_GEN = r"(?:(?<![iu]n\s)|(?<=(?<![a-z])bunun\s)|(?<=(?<![a-z])sunun\s))"  # ilgi hâli yalnız bunun/şunun (kelime başından)
_RC_DAT = r"(?<![ae]\sd[ae]\s)(?<!(?<![a-z])(?:buna|suna|bana|sana|bize|size)\s)(?<!(?<![a-z])ona\s)"  # "buna da aynısını yap" deyimi değil
_RC_LEFT = (r"(?:^[^a-z0-9]*|(?:bunu|sunu|onu|bunlari|videoyu|videolari|hikayeyi|kissayi|icerigi|animasyonu|hepsini|tamamen|"
            r"lutfen|ve|ama|sonra|yeniden)(?:\s+d[ae])?\s+)")  # şey adsız "sıfırdan"ın solu
# "videodaki/videonun" BU video: bu/şu'dan sonra, talimatın başında, dolgu sözünden sonra; işaretten ya da satır sonundan sonra ve tıpkı/
# aynen/hemen (da/de)/siz de'den sonra (_RC_THIS_H) — tekil ve çoğul istekte HEAD'in yerleri (13. tur: 12. turun "evde/sizde videodaki gibi
# yap" tekil eki kalktı) ("30 saniye, videodaki gibi yap", "tıpkı videodaki gibi yap")
_RC_THIS = (r"(?:(?:bu|su)\s+|(?:^[^a-z0-9]*|(?<=[^a-z0-9\s][^\S\n])|"
            r"(?:(?:bunu|sunu|lutfen|ayni|tam|abi|tamam)(?:\s+d[ae])?|sen\s+d[ae])\s+)(?:o\s+)?)")
_RC_THIS_H = r"(?:(?<=[^a-z0-9\s]|\n)[^\S\n]*|(?:(?:tipki|aynen|hemen)(?:\s+d[ae])?|siz\s+d[ae])\s+)(?:o\s+)?"
_RC_TARZ = r"\s+(?:tarz(?:i|da|inda|iyla)?|format(?:i|ta|inda)|stil(?:i|de|inde))(?![a-z])"
# çoğul istek ardından yalnız üretim bilgisi (süre, kısa/uzun, dil) gelirse tekil yolda da sahibin isteği ("tıpkı videodaki gibi yapın, 40 saniye")
_RC_PROD = rf"(?:{_RC_NUM}\s*(?:saniye|sn|dakika|dk)(?:lik|\s*['’]\s*l[iu]k)?|kisa|uzun|turkce|ingilizce)(?![a-z])"
_RC_PRODEND = rf"(?=[^a-z0-9:]*(?:{_RC_FILL}[^a-z0-9:]*){{0,2}}{_RC_PROD}[^a-z0-9:]*(?:{_RC_FILL}[^a-z0-9:]*){{0,2}}$)"


# metnin başındaki selamlama, nezaket ve hitap sözü (16. tur; server.js RC_COURT aynı metin)
_RC_COURT = r"(?:lutfen|selam(?:lar)?|merhaba(?:lar)?|gunaydin|iyi\s+(?:aksamlar|gunler|geceler|calismalar)|kolay\s+gelsin|tesekkur(?:ler|\s+ederim)?|tsk(?:ler)?|sag\s*ol(?:un)?|saol(?:un)?|eyvallah|abi|abla|kanka|kanki|hocam|reis|usta|kardes(?:im)?|canim|dostum|emixhas|jarvis|tamam)(?![a-z])"


def _rc_heads(sg: bool) -> tuple:
    """Benzer video başları (server.js rcHeads aynı metin). sg: yalnız tekil/sahip istek biçimi (_RC_REQ_SG1: yap, yapsana, yapar mısın,
    yapalım…; edilgen "yapılsın" da; çoğul istek yalnız ardından üretim bilgisiyle, _RC_PRODEND); değilse çoğul/kibar istek de (yapın,
    hazırlayın, yapar mısınız; HEAD'in kabul ettiği her yerde)."""
    v = (rf"{_RC_STEM}(?:(?:{_RC_REQ_SG1}|{_PASS_OPT})?(?![a-z])|(?:{_REQ_PL})(?![a-z]){_RC_PRODEND})" if sg
         else rf"{_RC_STEM}(?:{_RC_REQ}|{_PASS_OPT})?(?![a-z])")
    do, do_t, do_w = (rf"(?:{_RC_GAP}\s+{v}|{_RC_GAP_T}{_RC_END})", rf"{_RC_GAP_T}(?:\s+{v}|{_RC_END})", rf"{_RC_GAP_T}(?:\s+{v}|{_RC_WANT})")
    this = rf"(?:{_RC_THIS}|{_RC_THIS_H})"
    # işaretten sonra şey adsız "sıfırdan" yalnız çizim/anlatım fiiliyle ("Yılan ve fareler kıssası, sıfırdan anlat"; "kurgu kötü olmuş,
    # sıfırdan yap" yeniden kurgu isteği)
    strong = (rf"{_RC_LEFT}sifirdan(?![a-z]){do}|sifirdan(?![a-z]){do_t}|"
              rf"(?<=[^a-z0-9\s])\s*sifirdan(?![a-z]){_RC_GAP}\s+(?:(?:uret|ciz|anlat)(?:t[iu]r|d[iu]r)?|canlandir|tasarla)(?:{_RC_REQ_SG1 if sg else _RC_REQ}|{_PASS_OPT})?(?![a-z])|"
              rf"{_RC_GEN}(?:{_RC_DAT}(?:benzer(?:ini|i|lerini)|aynisini)|(?:buna|suna)\s+benzer)(?![a-z]){do}|"
              rf"{this}(?:videonun|videodakinin)\s+(?:benzer(?:ini|i|lerini)|aynisini)(?![a-z]){do}|"
              rf"(?:(?:bunun|sunun)\s+gibisin(?:i|den)|boylesini|esinlenerek|ilham\s+alarak)(?![a-z]){do}|"
              rf"{_RC_GEN}(?:benzer|(?:buna|suna)\s+benzeyen)(?![a-z]){do_w}")
    if sg:
        # "çizgi filme/animasyona çevir" yalnız tekil ("bunu animasyona çevir"; izleyiciye "Eski fotoğraflarınızı animasyona dönüştürün",
        # "Hayatınızı çizgi filme çevirin" değil), yalnız talimatın başında ya da bu videoyu gösteren nesneden sonra (bunu, şunu, onu, bunları,
        # videoyu, videoları, hikayeyi, kıssayı, içeriği; araya en çok iki dolgu) ve izleyici çağrısından (sen de/siz de) sonra değil (14.-15. tur;
        # server.js aynı metin: "Fotoğrafını çizgi filme çevir", "Sen de çizgi filme çevir, filtre linki profilde", "Hemen çizgi filme çevir,
        # uygulama linki bio'da" reklamı benzer video değil); 16. tur: metnin başındaki selamlama/nezaket/hitap sözünden sonra da (_RC_COURT,
        # ardından en çok iki dolgu; sen/siz değil) 14. turun kararı: "lütfen çizgi filme çevir", "selam, çizgi filme çevir", "Tamam, çizgi filme çevir"
        strong += (rf"|(?:^[^a-z0-9]*(?:{_RC_COURT}[^a-z0-9]*)+(?:(?!(?:sen|siz)(?![a-z])){_RC_FILL}\s+){{0,2}}|^[^a-z0-9]*|(?=(?:bunu|sunu|onu|bunlari|videoyu|videolari|hikayeyi|kissayi|icerigi)(?![a-z]))(?<!(?<![a-z])(?:sen|siz)\sd[ae]\s)(?<!(?<![a-z])(?:sende|sizde)\s)(?<!(?<![a-z])(?:sen|siz)\sd[ae]\s(?:bu|su)\s)"
                   rf"(?:bunu|sunu|onu|bunlari|videoyu|videolari|hikayeyi|kissayi|icerigi)(?:\s+d[ae])?\s+(?:(?!(?:sen|siz)(?![a-z])){_RC_FILL}\s+){{0,2}})"
                   rf"(?:cizgi\s+film|animasyon)[ae]\s+(?:cevir|donustur)(?:{_RC_REQ_SG}|{_PASS_OPT})?(?![a-z])")
    weak = (rf"(?:{this}videodaki|bunun|sunun)\s+gibi(?![a-z]){do}|(?:bu|su|ayni|bunun|sunun|{this}(?:videonun|videodaki)){_RC_TARZ}{do}|"
            rf"benzer\s+(?:(?:bir|bi)\s+)?sekilde(?![a-z]){do}")
    return strong, weak


_RC_S1, _RC_W1 = _rc_heads(True)
_RC_S2, _RC_W2 = _rc_heads(False)
_RC_NOT = (rf"(?!{_say('[a-z]')})(?!\s+(?:d(?:egi|ii|ei)l|olmasin|istemiyoru[mz]|istemem|istemeyiz|istemez|gerek\s+yok|gerekmez|gerekmiyor|"
           r"yok)(?![a-z]))")
RECREATE_RE = re.compile(rf"(?<![a-z])(?:{_RC_S1}|{_RC_W1}){_RC_NOT}")  # tekil/sahip biçimi her yerde
RECREATE_STRONG = re.compile(rf"(?<![a-z])(?:{_RC_S1}){_RC_NOT}")
RECREATE_PL = re.compile(rf"(?<![a-z])(?:{_RC_S2}|{_RC_W2}){_RC_NOT}")  # çoğul/kibar da
RECREATE_PL_STRONG = re.compile(rf"(?<![a-z])(?:{_RC_S2}){_RC_NOT}")
# ÇOĞUL/KİBAR İSTEK (13. tur; inceleme, 20 Ekim: 11.-12. turun izleyici sözü istisnası — siz de, etiketleyin, -abilirsiniz, çekiliş… — sahibin
# "bunun benzerini yapın, başlığı değiştirebilirsiniz", "… kaynağı etiketleyin" isteğini düşürüyordu): HEAD'in kabul ettiği her yerde,
# istisnasız benzer video (çıktı her zaman onay ister; server.js aynı kural)

# orijinal sesi, müziği, şarkıyı, efektleri ya da görüntüyü koruma isteği (sıfırdan çizimle çelişir; "şarkısı kalsın", "efektler kalsın",
# "orijinal şarkıyla"): "sesi kalsın", "sesini kullan", "orijinal sesle", "kendi
# sesiyle", "görüntüleri kullan", "orijinal görüntü"; araya da/de ve nitelik (aynen, aynı, olduğu gibi, orijinal, hiç), wa_video.WANT_SOUND
# biçimleri ve olumsuz bozma fiili (inceleme, 20 Ekim: "benzerini yap, sesi de kalsın", "sesleri kalsın", "konuşması duyulsun", "röportajı
# kullan", "sesli olsun", "sesini aç", "sesi olduğu gibi kalsın", "ses aynen kalsın", "sesine dokunma", "sesi silme", "sesi gitmesin", "ses
# kesilmesin", "sesi kısmadan", "ses efektleri kalsın", "müziği kalsın", "orijinal müzikle", "görüntüler aynı kalsın", "görüntüleri
# değiştirme", "konuşması aynen kalsın" sesi atıp çiziyordu); anlatıcı sesi koruma değil: "kadın sesiyle anlat", "robot sesiyle", "sesi
# olsun", "arka planda ses olsun" benzer video; "sesi kullanma", "kendi sesinle" (anlatıcı) değil. Ardından (araya hiç/asla/kesinlikle)
# ret gelirse koruma değil: değil (diil/deil; "değil mi" soru ekidir: "sesi kalsın değil mi" korur), yerine, yok ("yok olmasın" korur),
# gitsin, kapat(ın/ılsın), kaldır(ın/ılsın), kullan/iste/ol + olumsuz ek (VERB_NEG: kullanma, kullanmadan, kullanılmasın, istemiyorum, olmasın)
_RC_KEEP_NEG = VERB_NEG.replace(_KL, "[a-z]")  # benzer video kalıbı harfsiz katlanmış metinde [a-z] ile (server.js aynı metin)
_RC_USE = r"kullan(?:in|sana|ilsin)?"
_RC_QUAL = r"(?:\s+(?:d[ae]|aynen|ayni|oldugu\s+gibi|orijinal|tamamen|hic))?"
_RC_SPARE = r"(?:dokun|sil|kes|kis|kapat|degistir|kaldir|boz|git)(?:il|in|n)?m[ae](?:yin(?:iz)?|sin|d[ae]n|s[ae]n[ae])?"  # bozma fiili, olumsuz
RC_KEEP = re.compile(rf"(?<![a-z])(?!(?:muzik|efekt(?:ler)?|ses\s+efekt(?:i|ler|leri)?)\s+(?:kullan(?:in|sana|ilsin)?|ekle(?:yin|sene)?|acik|olsun)(?![a-z]))(?:(?:ses(?:i|ini|ine|ler|leri|lerini|lerine)?(?:\s+efekt[a-z]*)?|muzi(?:k|gi|gini|ge|gine|kler|kleri|klerini)|sarki(?:si(?:ni|na|yla)?|ya|yi|lar(?:i|ini|a)?)?|(?<!ses\s)efekt(?:ler)?(?:i|ini|e|ine)?){_RC_QUAL}"
                     rf"\s+(?:kalsin|koru|{_RC_USE}|acik|ac(?:in|sana|ilsin)?|duy(?:ul)?s[iu]n|duyalim|verilsin|{_RC_SPARE})|"
                     rf"(?:orijinal|gercek|asil|dogal|kendi|videonun)\s+(?:ses(?:i|iyle|le|ini|li|leri|lerini)?|muzi(?:k|kle|kli|gi|gini|giyle)|sarki(?:si|sini|siyla|yla|la|li)?|efekt[a-z]*)|"
                     rf"sesli\s+(?:{_RC_USE}|ver(?:in|ilsin)?|olsun|bolum[a-z]*)|"
                     rf"(?:konusma|roportaj)[a-z]*{_RC_QUAL}\s+(?:duyulsun|{_RC_USE}|ver(?:in|ilsin)?|kalsin|{_RC_SPARE})|"
                     rf"goruntu(?:ler)?(?:i|ini|yu|nu|ye|leri|lerini|lere)?{_RC_QUAL}\s+(?:kalsin|koru|kullan(?:in|sana)?|{_RC_SPARE})|"
                     rf"(?:orijinal|kendi)\s+goruntu[a-z]*)(?![a-z])"
                     rf"(?!\s+(?:(?:hic|asla|kesinlikle)\s+)?(?:d(?:egi|ii|ei)l(?!\s*m[iu](?![a-z]))|yerine|yok(?!\s+olmasin)|gitsin|"
                     rf"(?:kullan|iste|ol)(?:il|in|n)?{_RC_KEEP_NEG}|(?:kapat|kaldir)(?:in(?:iz)?|sana|ilsin|sin)?(?![a-z])))")


# benzer video başlarının her biri bu sözlerden birini içerir: yoksa kalıplar hiç taranmaz (yalnız hız; server.js RC_HINT aynı metin)
_RC_HINT = re.compile(r"sifirdan|benze|aynisi|gibi|boylesi|esinlen|ilham|tarz|format|stil|cizgi\s+film|animasyon")


def recreate_ask(instruction: str) -> bool:
    """Talimat benzer videoyu sıfırdan istiyor mu (açık haber isteği varsa yalnız nesneyi adlandıran baş; ses/görüntü koruma isteği varsa
    değil); server.js recreateAsk aynı kural."""
    t = _kind_text(instruction)
    if not _RC_HINT.search(t) or RC_KEEP.search(t) or not (RECREATE_RE.search(t) or RECREATE_PL.search(t)):
        return False
    return bool(RECREATE_STRONG.search(t) or RECREATE_PL_STRONG.search(t) or not _news(t, bool(_OLU.search(_tr_low(instruction)))))


def recreate_on() -> bool:
    """settings.waVideo.recreate (varsayılan açık; false, "false", 0 kapalı; server.js aynı kural)."""
    w = settings().get("waVideo")
    return not _off((w if isinstance(w, dict) else {}).get("recreate", True))


# Kare video (kullanıcı isteği, 23 Ekim: "bazen 10 dakikalık kare video linki gönderebilirim; link kare video yazarsam gönderdiğim video kaç
# dakika ise ortalama o dakikalarda bir kare video üretmeli"): talimat kare (1:1) UZUN video istiyor mu — videonun tamamı kendi sesiyle,
# başta kanca + kısa giriş, sonda kısa kapanış, bölüm başlıkları. "kare video", "kare videosu", "kare format", "kare olsun", "kare yap",
# "uzun kare video", "1:1"; "kareler", "kareyi kes", "kare çizelgesi" değil. server.js kareAsk aynı kural (katlanmış metin, _kind_text).
KARE_ASK = re.compile(r"(?<![^\W\d_])(?:kare|square)(?:\s+(?:uzun|format(?:ta|inda)?|bir))?\s*(?:video\w*|format\w*|olsun|yap\w*|haber\w*|olarak)(?![^\W\d_])|"
                      r"(?<![^\W\d_])uzun\s+kare(?:\s+video\w*)?(?![^\W\d_])|(?<![\d.,:])1\s*[:x]\s*1(?![\d.,:])", re.I)
KARE_DEFAULTS = {"enabled": True, "maxSeconds": 1800}


def kare_ask(instruction: str) -> bool:
    """Talimat kare (1:1) uzun video istiyor mu (server.js kareAsk aynı kural)."""
    return bool(KARE_ASK.search(_kind_text(instruction)))


def kare_cfg() -> dict:
    """settings.kare {enabled true, maxSeconds 1800}: bozuk/0 sayı varsayılana düşer; false/"false"/0 kapatır."""
    raw = settings().get("kare")
    s = raw if isinstance(raw, dict) else {"enabled": False} if raw is not None and _off(raw) else {}
    try:
        mx = float(s.get("maxSeconds"))
    except (TypeError, ValueError):
        mx = float(KARE_DEFAULTS["maxSeconds"])
    if not math.isfinite(mx) or mx <= 0:
        mx = float(KARE_DEFAULTS["maxSeconds"])
    return {**s, "enabled": not _off(s.get("enabled", True)), "maxSeconds": mx}


def kare_on() -> bool:
    return kare_cfg()["enabled"]


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


_URL_RE = re.compile(r"https?://\S+")


def _mask_keep_urls(text: str) -> str:
    """Hassas kelimeleri yıldızlar ama adreslere dokunmaz (…/silahli-saldiri linki bozulmasın)."""
    import censor
    out, last = [], 0
    for m in _URL_RE.finditer(text):
        out.append(censor.mask(text[last:m.start()]) + m.group(0))
        last = m.end()
    return "".join(out) + censor.mask(text[last:])


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
        if meta.get("kare") and meta.get("slotLabel") != "SON DAKİKA":  # kare (1:1) uzun video: son dakika değilse "📺 VİDEO: …"
            head = f"📺 {meta.get('slotLabel') or 'VİDEO'}"
        if meta.get("trailer") or meta.get("recreated") or meta.get("kare"):
            room = 100 - len(f"{head}:  | {s['channelName']} #Shorts")  # uzun başlık kanal adını ve #Shorts'u kesmesin
            if len(first) > room:
                first = first[:room].rsplit(" ", 1)[0].rstrip(" ,;:-–") or first[:room]
        # kare uzun video Shorts değildir (YouTube "#Shorts" etiketiyle 3 dk üstü videoyu Shorts saymaz; yanıltmasın)
        title = f"{head}: {first} | {s['channelName']}" + ("" if meta.get("kare") else " #Shorts")
        lines = [f"{head} · {s['channelName']} · {day} · {rng}", ""]
        if meta.get("kare"):  # YouTube bölümleri: 00:00 giriş + orijinal sesli bölümdeki bölüm başlıkları (wa_video.build_kare)
            t, chapters = 0.0, []
            for seg in meta.get("segments", []):
                if seg.get("kind") == "sesli":
                    for ch in seg.get("chapters") or []:
                        try:
                            at = t + float(ch.get("t") or 0)
                        except (TypeError, ValueError, AttributeError):
                            continue
                        if str(ch.get("title") or "").strip():
                            chapters.append(f"{int(at // 60):02d}:{int(at % 60):02d} {str(ch['title']).strip()}")
                t += float(seg.get("duration") or 0)
            if chapters:
                lines += ["00:00 Giriş", *chapters, ""]
    else:
        title = f"{first} | {s['channelName']} {day} {slot.lower()} #Shorts".strip()
        lines = [f"{s['channelName']} · {stamp}", f"Son {meta.get('scheduleHours', 5)} saatin en önemli {len(haber)} haberi.", ""]
    shown_urls = set()
    for i, h in enumerate(haber, 1):
        head = h["title"] if anlik else f"{i}. {h['title']}" if meta.get("format") in ("gunluk", "haftalik") else f"{'🔴 SON DAKİKA · ' if h.get('breaking') else ''}{i}. {h['title']}"
        lines.append(head)
        if h.get("narration"):
            lines.append(h["narration"].strip())
        # haberin kendi sayfasının linki kaynak olarak (kullanıcı isteği, 21 Ekim: "haberleri paylaşırken doğrudan haberin linkini
        # ekleyelim açıklamaya kaynak olarak"); articleUrl: attach_images'ın eşlediği haber sayfası ya da anlıkta kaynağın sayfası
        url = h.get("articleUrl") if str(h.get("articleUrl") or "").startswith("http") else ""
        if h.get("source") or url:
            lines.append("Kaynak: " + " · ".join(x for x in (h.get("source"), url) if x))
            if url:
                shown_urls.add(url)
        lines.append("")
    # sosyal medya linkinden video: kaynak videoda ve haber metinlerinde yok, açıklamanın EN ALTINDA tek satır (kullanıcı kararı, 14 Ekim)
    social_src = meta.get("sourceName") if meta.get("infoKind") == "video" and meta.get("sourceUrl") and meta.get("sourceName") else None
    if meta.get("sources"):  # çoklu son dakika: her haberin kaynağı (kartlarda yazılmayan adresler)
        rest = [f"• {x.get('name') or 'kaynak'} · {x.get('url')}" for x in meta["sources"] if x.get("url") and x["url"] not in shown_urls]
        if rest:
            lines += ["Haber kaynakları:"] + rest + [""]
    elif meta.get("sourceUrl") and not social_src and meta["sourceUrl"] not in shown_urls:
        lines += [f"Haber kaynağı: {meta.get('sourceName') or 'kaynak'} · {meta['sourceUrl']}", ""]
    from hashtags import for_meta
    # uzun video özeti, viral ve mizah videosu, benzer video (sıfırdan), SON DAKİKA olmayan kare uzun video son dakika haberi değil: #sondakika yok
    calm = (meta.get("summary") and meta.get("slotLabel") != "SON DAKİKA") or meta.get("contentKind") in ("trend", "mizah") or meta.get("recreated") or (meta.get("kare") and meta.get("slotLabel") != "SON DAKİKA")
    tags = trailer_tags(meta, s["hashtags"]) if meta.get("trailer") else for_meta(meta, calm_tags(s["hashtags"]) if calm else s["hashtags"],
                                                                                   ["#sondakika"] if anlik and not calm and meta.get("infoKind") in (None, "", "deprem", "meteo", "alarm", "video") else [])
    if meta.get("kare"):  # kare uzun video Shorts değil: kanal etiketlerindeki #shorts atılır
        tags = [t for t in tags if t.lower() != "#shorts"]
    # mizah videosu: mizah olduğu açıklamanın SONUNDA söylenir (kullanıcı isteği, 19 Ekim: "girişte yazarsa izlenmez, sonunda belirtelim")
    lines += ["Videonun tamamı kendi sesiyle. Yeni videolar için takip et, abone ol." if meta.get("kare") and meta.get("slotLabel") != "SON DAKİKA"
              else "Yeni hikâyeler ve kısa anlatımlar için takip et, abone ol." if meta.get("recreated")
              else "😄 Bu video mizah amaçlıdır. Güldüren videolar için takip et, abone ol." if meta.get("contentKind") == "mizah"
              else "Sosyal medyanın en çok konuşulan videoları için takip et, abone ol." if meta.get("contentKind") == "trend"
              else "Gelişmeleri takip etmeye devam ediyoruz. Takip et, abone ol." if meta.get("trailer") and meta.get("slotLabel") == "TANITIM FİLMİ"
              else "Yeni fragmanlar ve film, dizi haberleri için takip et, abone ol." if meta.get("trailer")
              else "Gelişmeleri takip etmeye devam ediyoruz. Takip et, abone ol." if anlik
              else "Her beş saatte bir kısa haberlerle, her akşam günün özetiyle, her pazar haftanın özetiyle buradayız. Abone ol." if meta.get("format") == "haftalik"
              else "Her beş saatte bir kısa haberlerle, her akşam günün özetiyle buradayız. Abone ol." if meta.get("format") == "gunluk"
              else "Her beş saatte bir son dakika haberleriyle buradayız. Takip et, abone ol.", ""]
    try:  # hassas kelimeler açıklamada ve başlıkta yıldızlı (int*har, s*lah), hassas hashtag atılır (censor.py); adresler yıldızlanmaz
        import censor
        title, lines, tags = censor.mask(title), [_mask_keep_urls(x) for x in lines], censor.clean_tags(tags)
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
    calm = (meta.get("summary") and meta.get("slotLabel") != "SON DAKİKA") or meta.get("contentKind") in ("trend", "mizah") or meta.get("recreated") or (meta.get("kare") and meta.get("slotLabel") != "SON DAKİKA")
    tags = trailer_tags(meta, s["hashtags"]) if meta.get("trailer") else for_meta(meta, calm_tags(s["hashtags"]) if calm else s["hashtags"], ["#sondakika"] if anlik and not calm else [])
    if meta.get("kare"):  # kare uzun video Shorts değil
        tags = [t for t in tags if t.lower() != "#shorts"]
    try:
        import censor
        return censor.clean_tags(tags)
    except Exception:
        return tags
