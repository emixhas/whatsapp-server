#!/usr/bin/env python3
"""Ses kataloğu ve motor sürücüleri. Tüm motorlar yerel çalışır.

Katalog (data/settings.json → narration ile seçilir):
  trendyol    Trendyol-TTS (VoxCPM2 tabanlı Türkçe, MIT) — MLX çalışma zamanı, en doğal
  vox-kadin   VoxCPM2 tabanı, "kadın haber spikeri" ses tasarımı (PyTorch/MPS)
  vox-erkek   VoxCPM2 tabanı, "erkek haber spikeri" ses tasarımı (PyTorch/MPS)
  klon-<ad>   voices/klon/<ad>.wav referansından klonlanmış ses (VoxCPM2)
  ema         EMA Lightning (Apache-2.0, 34 MB, anında)
  chatterbox  Chatterbox sunucusu (varsa; voices/ref.wav ile klon)
  yelda       macOS Yelda
  piper       Piper tr_TR-dfki-medium
  auto        kurulu olan ilk motor: trendyol → ema → chatterbox → yelda → piper

Komut satırı:  voices.py --list            kataloğu ve kurulu olup olmadıklarını JSON yazar
               voices.py --preview <id> --out dosya.wav [--text "..."]   ön dinleme üretir
"""
import json
import os
import re
import shutil
import time
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import ROOT, settings  # noqa: E402
from natural_tts import chatterbox_installed, chatterbox_ready, chatterbox_tts, on_demand  # noqa: E402
from tr_numbers import normalize_tr  # noqa: E402

_S = settings()
TR = _S.get("turkishVoice", {})
TR_PY = ROOT / TR.get("python", ".venv-tr/bin/python")
TR_BIN = ROOT / TR.get("trendyolBin", ".venv-tr/bin/trendyol-tts")
TR_MLX = ROOT / TR.get("mlxModel", "models/Trendyol-TTS-mlx")
VOX_BASE = TR.get("baseModel", "openbmb/VoxCPM2")
PIPER_ONNX = os.environ.get("PIPER_VOICE", str(ROOT / "voices" / "tr_TR-dfki-medium.onnx"))
PIPER_LENGTH = os.environ.get("PIPER_LENGTH_SCALE", "0.82")
KLON_DIR = ROOT / "voices" / "klon"
PREVIEW_TEXT = "Merhaba, ben Türkiye Gündemi'nin sesiyim. Her beş saatte bir son dakika haberleriyle buradayım, takip etmeyi unutma."
AUTO_ORDER = ["trendyol", "ema", "chatterbox", "yelda", "piper"]

BUILTIN = [
    {"id": "trendyol", "label": "Trendyol-TTS", "gender": "", "engine": "trendyol", "note": "En doğal Türkçe ses, MLX ile yerel"},
    {"id": "vox-kadin", "label": "Kadın spiker (VoxCPM2)", "gender": "kadin", "engine": "voxcpm", "model": VOX_BASE,
     "instruct": "(A young adult female Turkish news anchor; clear, calm, warm and professional voice)"},
    {"id": "vox-erkek", "label": "Erkek spiker (VoxCPM2)", "gender": "erkek", "engine": "voxcpm", "model": VOX_BASE,
     "instruct": "(An adult male Turkish news anchor; deep, clear, confident and calm voice)"},
    {"id": "ema", "label": "EMA Lightning", "gender": "", "engine": "ema", "note": "Hızlı, 34 MB"},
    {"id": "chatterbox", "label": "Chatterbox", "gender": "", "engine": "chatterbox", "note": "voices/ref.wav ile klon"},
    {"id": "yelda", "label": "Mac · Yelda", "gender": "kadin", "engine": "say", "name": "Yelda"},
    {"id": "piper", "label": "Piper · dfki", "gender": "", "engine": "piper"},
]


def catalog() -> list:
    out = [dict(v) for v in BUILTIN]
    if KLON_DIR.is_dir():
        for wav in sorted(KLON_DIR.glob("*.wav")):
            stem = re.sub(r"[^a-z0-9çğıöşü_-]", "", wav.stem.lower())
            out.append({"id": f"klon-{stem}", "label": f"Klon · {wav.stem}", "gender": "", "engine": "voxcpm", "model": VOX_BASE,
                        "ref": str(wav.relative_to(ROOT)), "note": "Referans kayıttan klon"})
    return out


def voice(vid: str):
    return next((v for v in catalog() if v["id"] == vid), None)


# ---------- hazır olma kontrolleri ----------
_import_cache: dict = {}
_disabled: set = set()


_PYWITH_FILE = ROOT / "work" / ".python_with.json"


def python_with(module: str):
    """module'ü içe aktarabilen ilk Python (proje .venv'i ya da .venv-tr); yoksa None.
    Kontrol (import) torch gibi ağır paketlerde saniyeler sürer; sonuç 24 saat diske yazılır ki Emixhas'ın her
    sesli yanıtında tekrar yapılmasın. Paket sonradan bozulursa sentez hata verir ve yedek sese düşülür."""
    if module in _import_cache:
        return _import_cache[module]
    try:
        disk = json.loads(_PYWITH_FILE.read_text())
    except Exception:
        disk = {}
    hit = disk.get(module)
    ttl = 86400 if hit and hit.get("py") else 600  # "kurulu değil" sonucu yalnızca 10 dk saklanır
    if hit and time.time() - hit.get("at", 0) < ttl and (hit["py"] is None or Path(hit["py"]).exists()):
        _import_cache[module] = Path(hit["py"]) if hit["py"] else None
        return _import_cache[module]
    found = None
    for py in (Path(sys.executable), TR_PY):
        if py.exists() and subprocess.run([str(py), "-c", f"import {module}"], capture_output=True).returncode == 0:
            found = py
            break
    _import_cache[module] = found
    try:
        disk[module] = {"py": str(found) if found else None, "at": time.time()}
        _PYWITH_FILE.parent.mkdir(parents=True, exist_ok=True)
        _PYWITH_FILE.write_text(json.dumps(disk))
    except Exception:
        pass
    return found


def trendyol_mlx_ready() -> bool:
    return TR_BIN.exists() and TR_MLX.is_dir() and any(TR_MLX.iterdir())


def say_has_voice(name: str) -> bool:
    if not shutil.which("say"):
        return False
    try:
        out = subprocess.run(["say", "-v", "?"], capture_output=True, text=True, timeout=10).stdout
    except Exception:
        return False
    return any(line.split()[0] == name and "tr_TR" in line for line in out.splitlines() if line.strip())


def vox_model_present(model: str) -> bool:
    local = ROOT / "models" / model.split("/")[-1]
    if local.is_dir() and any(local.iterdir()):
        return True
    cache = Path(os.environ.get("HF_HOME", Path.home() / ".cache" / "huggingface")) / "hub" / ("models--" + model.replace("/", "--"))
    return cache.is_dir()


def available(v: dict):
    """(hazır mı, neden) — kurulu değilse panelde gösterilecek kısa açıklama."""
    if v["id"] in _disabled:
        return False, "bu çalıştırmada hata verdi"
    e = v["engine"]
    if e == "trendyol":
        if trendyol_mlx_ready():
            return True, ""
        if python_with("voxcpm") and vox_model_present(TR.get("torchModel", "Trendyol/Trendyol-TTS")):
            return True, "PyTorch yolu"
        return False, "bash scripts/install_turkish_voice.sh"
    if e == "voxcpm":
        if not python_with("voxcpm"):
            return False, "voxcpm paketi yok (install_turkish_voice.sh)"
        if not vox_model_present(v.get("model", VOX_BASE)):
            return False, "VoxCPM2 tabanı inmemiş (install_turkish_voice.sh)"
        if v.get("ref") and not (ROOT / v["ref"]).exists():
            return False, "referans kayıt yok"
        return True, "PyTorch/MPS, yavaş"
    if e == "ema":
        return (True, "") if python_with("ema_lightning") else (False, "pip install ema-lightning")
    if e == "chatterbox":
        # Sunucu sürekli açık tutulmaz; kuruluysa üretim/ön dinleme sırasında açılıp kapanır
        return (True, "") if chatterbox_ready() else (True, "gerektiğinde açılır, iş bitince kapanır") if chatterbox_installed() else (False, "kurulu değil (bash scripts/install_voice.sh)")
    if e == "say":
        return (True, "") if say_has_voice(v.get("name", "Yelda")) else (False, "macOS Türkçe sesi inmemiş")
    if e == "piper":
        return (True, "") if shutil.which("piper") and Path(PIPER_ONNX).exists() else (False, "piper kurulu değil")
    return False, "bilinmeyen motor"


def resolve(vid: str, quiet=False) -> dict:
    """auto ya da kurulu olmayan bir seçim → sırayla ilk hazır ses. Hiçbiri yoksa SystemExit."""
    if vid and vid != "auto":
        v = voice(vid)
        if v and available(v)[0]:
            return v
        if not quiet and os.environ.get("TTS_ENGINE") != "silent":
            print(f"  ! ses '{vid}' hazır değil, otomatik sıraya geçildi", file=sys.stderr)
    for cand in AUTO_ORDER:
        v = voice(cand)
        if v and available(v)[0]:
            return v
    if os.environ.get("TTS_ENGINE") == "silent":
        return {"id": "silent", "label": "sessiz", "engine": "silent", "gender": ""}
    sys.exit("Hiçbir ses motoru hazır değil. bash scripts/install_turkish_voice.sh")


# ---------- metin ----------
def tr_lower(w: str) -> str:
    return w.replace("İ", "i").replace("I", "ı").lower()


# Kelime gibi okunan kısa büyük harfli adlar: ses motorları bunları harf harf okur ("AK" → "A, K").
# Yalnızca SESE gider; ekranda yine "AK Parti" yazar. Harf harf okunması doğru olanlar (PKK, THY, BBC) listede yok.
SPOKEN_WORDS = {"AK": "Ak", "DEM": "Dem", "İYİ": "İyi", "TİP": "Tip", "HÜDA": "Hüda", "PAR": "Par", "EMEP": "Emep"}
_PARTY_CTX = re.compile(r"\b(AK|DEM|İYİ|TİP)\b(?=\s+(?:Parti|PARTİ|parti))|\b(HÜDA)\s+(PAR)\b|\bAK\b(?=\s*(?:Partili|PARTİLİ|Parti'|PARTİ'))")


# Okunuş sözlüğü: yabancı kökenli marka/adların Türkçe okunuşu (yalnız seslendirmede; ekranda yazım değişmez).
# Ekler korunur: "Mynet'in" → "Maynet'in". settings.pronunciations {"Kelime": "Okunuş"} ile genişletilir.
# TV: ses motorları İngilizce "tivi" okuyor (kullanıcı bildirimi) → "Teve" ("Halk TV'de" → "Halk Teve'de", "TV8" → "Teve 8"; ATV, NTV de).
PRONOUNCE = {"Mynet": "Maynet", "PKK": "Pekaka", "TV": "Teve", "ATV": "Ateve", "NTV": "Enteve", "Sondakika": "son dakika"}
_GLUED_NUM = re.compile(r"(?<![\wçğıöşüÇĞİÖŞÜ])(TV)(?=\d)")  # kanal adındaki bitişik sayı ayrılır: TV8 → TV 8 (sayı yazıya çevrilsin)


# Seslendirmede başka adla söylenen adlar (yalnız ses; ekranda yazım değişmez). Kesmeden sonraki ek yeni ada göre yeniden
# kurulur: "Amed SFK'nın" → "Amed Spor'un", "Amed SFK'ya" → "Amed Spor'a" (kullanıcı isteği: "Amed SFK değil Amed Spor").
SPOKEN_AS = {"Amed SFK": "Amed Spor", "Amed S.F.K.": "Amed Spor", "Amed Sportif Faaliyetler": "Amed Spor"}
_TR_VOWELS = "aeıioöuü"


def _reharmonize(word: str, suf: str) -> str:
    """Ekin ünlülerini ve kaynaştırma/sertleşme harfini yeni kelimenin son sesine uydurur (genel Türkçe ünlü uyumu)."""
    w = tr_lower(word)
    last_v = next((ch for ch in reversed(w) if ch in _TR_VOWELS), "e")
    back, rounded = last_v in "aıou", last_v in "oöuü"
    ends_vowel = w[-1] in _TR_VOWELS
    if not ends_vowel and len(suf) > 1 and ((suf[0] in "ny" and suf[1] in _TR_VOWELS) or suf[:3] in ("yla", "yle")):
        suf = suf[1:]  # kaynaştırma harfi ünsüzle bitende düşer: 'nın → 'ın, 'ya → 'a, 'yla → 'la
    out = []
    for i, ch in enumerate(suf):
        if ch in "ae":
            ch = "a" if back else "e"
        elif ch in "ıiuü":
            ch = ("u" if back else "ü") if rounded else ("ı" if back else "i")
        elif i == 0 and ch in "dt":
            ch = "t" if w[-1] in "pçtkfsşh" else "d"
        out.append(ch)
    return "".join(out)


def _spoken_as(t: str) -> str:
    for name, say in sorted(SPOKEN_AS.items(), key=lambda x: -len(x[0])):
        pat = re.escape(name).replace(r"\ ", r"\s+")
        t = re.sub(rf"(?<![\wçğıöşüÇĞİÖŞÜ]){pat}(?:['’]([a-zçğıöşü]+))?(?![\wçğıöşüÇĞİÖŞÜ])",
                   lambda m: say + (f"'{_reharmonize(say, m.group(1))}" if m.group(1) else ""), t, flags=re.IGNORECASE)
    return t


def _pronounce(t: str) -> str:
    words = {**PRONOUNCE, **(settings().get("pronunciations") or {})}
    t = _GLUED_NUM.sub(r"\1 ", _spoken_as(t))
    for w, say in words.items():
        if not (w and say):
            continue
        if w.isupper() and len(w) <= 6:  # kısaltma (PKK): bitişik küçük ek de olabilir ("PKKlı" → "Pekakalı")
            t = re.sub(rf"(?<![\wçğıöşüÇĞİÖŞÜ]){re.escape(w)}(?![A-ZÇĞİÖŞÜ0-9])", say, t)
            t = re.sub(rf"(?<![\wçğıöşüÇĞİÖŞÜ]){re.escape(w.lower())}(?![\wçğıöşüÇĞİÖŞÜ])", say.lower(), t)
        else:
            t = re.sub(rf"(?<![\wçğıöşüÇĞİÖŞÜ]){re.escape(w)}(?![\wçğıöşüÇĞİÖŞÜ])", say, t, flags=re.IGNORECASE)
    return t


# Harf + rakam kodları (kullanıcı şikâyeti, 19 Ekim: "C4'ü seslendirirken 'cfour' diye seslendiriyor; seslendirmemizin tam profesyonel
# olması lazım"): ses modelleri bitişik harf-rakamı İngilizce okuyor. Büyük harf kısmı (en çok 3 harf) Türkçe harf adlarıyla, rakam
# ayrı (sonra yazıya çevrilir): C4 / C-4 → ce dört, TB2 → te be iki, T-129 → te yüz yirmi dokuz, X5 → iks beş, G20 → ge yirmi, U17 → u
# on yedi, 5G → beş ge, 4K → dört ka, 3D → üç de; ek korunur (C4'ün → ce dördün, C4lü → ce dörtlü). Savaş uçağı F → "ef" (F-16, F-35),
# S-300/400/500 → "es"; yerleşik okunuşlar CODE_SAY'de; settings.pronunciations ({"M4": "em dört"}) hepsinden önce gelir. 4 harften
# uzun kelime içeren kod (COVID-19) ve küçük harfli adlar (iPhone 15, Mi-17) değişmez.
LETTER_TR = {"A": "a", "B": "be", "C": "ce", "Ç": "çe", "D": "de", "E": "e", "F": "fe", "G": "ge", "Ğ": "yumuşak ge", "H": "he", "I": "ı",
             "İ": "i", "J": "je", "K": "ka", "L": "le", "M": "me", "N": "ne", "O": "o", "Ö": "ö", "P": "pe", "Q": "kü", "R": "re", "S": "se",
             "Ş": "şe", "T": "te", "U": "u", "Ü": "ü", "V": "ve", "W": "dabılyu", "X": "iks", "Y": "ye", "Z": "ze"}
CODE_SAY = {"F1": "Formula 1", "H5N1": "ha 5 en 1", "H1N1": "ha 1 en 1", "CO2": "karbondioksit", "A400M": "a 400 em", "MP3": "em pe 3",
            "MP4": "em pe 4", "4X4": "4 çeker", "COVID19": "kovid 19"}
_CODE = re.compile(r"(?<![\wçğıöşüÇĞİÖŞÜ])([A-ZÇĞİÖŞÜ0-9]+(?:-[A-ZÇĞİÖŞÜ0-9]+)*)(?![A-ZÇĞİÖŞÜ0-9])")


def _codes(text: str) -> str:
    user = settings().get("pronunciations") or {}

    def say(m):
        tok = m.group(1)
        if not (re.search(r"\d", tok) and re.search(r"[A-ZÇĞİÖŞÜ]", tok)):
            return tok
        key = tok.replace("-", "")
        if tok in user or key in user:
            return user.get(tok) or user[key]
        if key in CODE_SAY:
            return CODE_SAY[key]
        parts = re.findall(r"[A-ZÇĞİÖŞÜ]+|\d+", key)
        if any(p.isalpha() and len(p) > 3 for p in parts):
            return tok  # kelime içeren kod (COVID-19): eski davranış
        out = []
        for i, p in enumerate(parts):
            if p.isdigit():
                out.append(p)
            elif i == 0 and len(parts) > 1 and p == "F":
                out.append("ef")  # savaş uçağı: F-16, F-35
            elif i == 0 and len(parts) > 1 and p == "S" and parts[1] in ("300", "400", "500"):
                out.append("es")  # hava savunma: S-400
            else:
                out.append(" ".join(LETTER_TR.get(ch, ch) for ch in p))
        return " ".join(out)
    return _CODE.sub(say, text)


# Web adresleri (kullanıcı isteği, 20 Ekim: "haber.com ve sondakika.com'u mantıklı seslendirsin"): ses modelleri alan adını bitişik
# ya da İngilizce okuyordu. Türkçe okunur: site adı bilinen okunuşuyla (sondakika → son dakika, haberturk → Habertürk; harfsiz kısa ad
# harf harf: trt → te re te), nokta "nokta", uzantı com → kom, tr → te re, tv → teve; "https://", "www." ve yol okunmaz, ek yeni son
# heceye uyar: sondakika.com'un → son dakika nokta kom'un, aa.com.tr'ye → a a nokta kom nokta te re'ye. Uzantısı bilinmeyen nokta
# (3.5, A.Ş.) değişmez. settings.pronunciations'ta tam alan adı ({"sondakika.com": "Son Dakika sitesi"}) önce gelir.
SITE_SAY = {"sondakika": "son dakika", "haberturk": "Habertürk", "hurriyet": "Hürriyet", "sozcu": "Sözcü", "cnnturk": "ce en en türk",
            "trthaber": "te re te haber", "ensonhaber": "en son haber", "gazeteduvar": "gazete duvar", "yenisafak": "Yeni Şafak",
            "aksam": "Akşam", "ahaber": "a haber", "aa": "a a", "dha": "de ha a", "iha": "i ha a", "bbc": "bi bi si", "cnn": "ce en en",
            "ntv": "Enteve", "mynet": "Maynet", "birgun": "BirGün", "dunya": "Dünya", "fotomac": "Fotomaç", "ajansspor": "ajans spor",
            "halktv": "Halk Teve", "sozcutv": "Sözcü Teve", "tv100": "Teve yüz", "odatv": "Oda Teve", "bloomberght": "Bloomberg ha te",
            "haberler": "haberler", "gazeteoksijen": "gazete oksijen", "medyascope": "medyaskop", "evrensel": "Evrensel"}
TLD_SAY = {"com": "kom", "net": "net", "org": "org", "tv": "teve", "gov": "gov", "edu": "edu", "info": "info", "io": "i o", "co": "ko",
           "biz": "biz", "news": "nyuz", "tr": "te re", "uk": "yu ke", "de": "de", "eu": "e u", "az": "a ze", "cy": "si vay"}
_DOMAIN = re.compile(r"(?<![\w@./-])(?:https?://)?(?:www\.)?((?:[a-zçğıöşü0-9](?:[a-zçğıöşü0-9-]*[a-zçğıöşü0-9])?\.)+[a-z]{2,6})"
                     r"(?:/[^\s'’\"]*[^\s'’\".,;:!?)*_])?(?![\wçğıöşü])(?:['’]([a-zçğıöşü]+))?", re.IGNORECASE)


def _site_word(label: str) -> str:
    if tr_lower(label) in SITE_SAY:
        return SITE_SAY[tr_lower(label)]
    out = []
    for p in re.findall(r"[^\W\d_]+|\d+", label):  # bilinmeyen ad yazıldığı gibi (Instagram, Haber), rakam ayrı (haber7 → haber 7)
        lp = tr_lower(p)
        if p.isdigit() or lp in SITE_SAY:
            out.append(SITE_SAY.get(lp, p))
        elif len(p) <= 3 and not re.search(r"[aeıioöuü]", lp):  # harfsiz kısa ad (trt, cnn): harf harf
            out.append(" ".join(LETTER_TR.get(ch, ch) for ch in lp.replace("i", "İ").replace("ı", "I").upper()))
        else:
            out.append(p)
    return " ".join(out) or label


def _domains(text: str) -> str:
    user = {tr_lower(k): v for k, v in (settings().get("pronunciations") or {}).items() if k and v and "." in k}

    def say(m):
        host, suf = m.group(1), m.group(2)
        labels = host.split(".")
        n = 0  # sondaki uzantı etiketleri (com, com.tr); en az bir ad etiketi kalmalı
        while n < len(labels) - 1 and tr_lower(labels[-1 - n]) in TLD_SAY:
            n += 1
        if not n or (n == 1 and len(labels) > 2 and tr_lower(labels[-1]) not in ("com", "net", "org", "tv", "gov", "edu", "info", "io", "co", "biz", "news")):
            return m.group(0)
        spoken = user.get(tr_lower(host)) or " nokta ".join([_site_word(x) for x in labels[:-n]] + [TLD_SAY[tr_lower(x)] for x in labels[-n:]])
        return spoken + (f"'{_reharmonize(spoken.split()[-1], tr_lower(suf))}" if suf else "")
    return _DOMAIN.sub(say, text)


def speakable(text: str) -> str:
    """Parti adları gibi kelime olarak okunması gereken kısaltmaları normal yazıma çevirir (AK Parti → Ak Parti),
    okunuş sözlüğünü uygular (Mynet → Maynet)."""
    def fix(m):
        return " ".join(SPOKEN_WORDS.get(g, g) for g in m.groups() if g)
    t = _PARTY_CTX.sub(fix, _pronounce(_codes(_domains(text))))
    t = re.sub(r"\bAK\b(?=[\s-]*(?:Parti|PARTİ|parti))", "Ak", t)
    # Kesme işaretinden sonraki büyük harfli ekler harf harf okunmasın: PARTİ'YE → PARTİ'ye, PKK'NIN → PKK'nın
    return re.sub(r"(?<=[A-Za-zÇĞİÖŞÜçğıöşü])['’]([A-ZÇĞİÖŞÜ]{1,6})\b", lambda m: "'" + tr_lower(m.group(1)), t)


def prep_text(text: str) -> str:
    """Yerel modeller için: rakamlar yazıya, parti adları kelime olarak, BÜYÜK HARFLİ kelimeler (NATO, TÜİK) normal yazıma."""
    t = speakable(normalize_tr(_codes(_GLUED_NUM.sub(r"\1 ", _domains(text)))))  # kod ve site rakamı sonra yazıya: C4 → ce 4 → ce dört
    return re.sub(r"\b([A-ZÇĞİÖŞÜ]{4,})\b", lambda m: m.group(1)[0] + tr_lower(m.group(1)[1:]), t)


def resample(src: Path, out: Path) -> None:
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(src), "-ar", "44100", "-ac", "1", str(out)], check=True)
    if src != out:
        src.unlink(missing_ok=True)


# ---------- motorlar ----------
def _run_trendyol_mlx(text: str, out: Path) -> None:
    tmp = out.with_name(out.stem + ".raw.wav")
    env = {**os.environ, "MLX_ARTIFACT_DIR": str(TR_MLX), "INFERENCE_SEED": str(TR.get("seed", 42))}
    cmd = [str(TR_BIN), "--text", text, "--out", str(tmp), "--device", "mps", "--backend", "mlx",
           "--cfg", str(TR.get("cfg", 2.0)), "--steps", str(TR.get("steps", 16)), "--max-len", "4096", "--mlx-artifact-dir", str(TR_MLX)]
    r = subprocess.run(cmd, capture_output=True, text=True, env=env, cwd=ROOT)
    if r.returncode != 0 or not tmp.exists():
        raise RuntimeError("trendyol-tts: " + (r.stderr or r.stdout).strip()[-400:])
    resample(tmp, out)


def _run_voxcpm_batch(model: str, jobs: list) -> None:
    """VoxCPM2/Trendyol PyTorch yolu; model bir kez yüklenir. jobs: {text,out,instruct?,ref?}"""
    env = {**os.environ, "VOX_MODEL": model, "VOX_CFG": str(TR.get("cfg", 2.0)), "VOX_STEPS": str(TR.get("steps", 16)), "VOX_SEED": str(TR.get("seed", 42))}
    r = subprocess.run([str(TR_PY), str(ROOT / "scripts" / "voxcpm_tts.py")], input=json.dumps(jobs), text=True, cwd=ROOT, env=env, capture_output=True)
    if r.returncode != 0:
        err = next((l for l in reversed(r.stderr.strip().splitlines()) if "HATA" in l or "Error" in l), r.stderr.strip()[-400:])
        raise RuntimeError("voxcpm: " + err[-500:])


def _run_ema_batch(jobs: list, speed: float) -> None:
    py = python_with("ema_lightning")
    env = {**os.environ, "EMA_SPEED": str(speed)}
    r = subprocess.run([str(py), str(ROOT / "scripts" / "ema_tts.py")], input=json.dumps(jobs), text=True, cwd=ROOT, env=env, capture_output=True)
    if r.returncode != 0:
        raise RuntimeError("ema: " + r.stderr.strip()[-400:])


def _run_chatterbox(text: str, out: Path) -> None:
    if not chatterbox_tts(text, out):
        raise RuntimeError("chatterbox sunucusu yanıt vermedi")
    tmp = out.with_name(out.stem + ".raw.wav")
    out.rename(tmp)
    resample(tmp, out)


def _run_say(name: str, text: str, out: Path) -> None:
    aiff = out.with_suffix(".aiff")
    rate = int(_S.get("voice", {}).get("rate", 195)) - 15
    subprocess.run(["say", "-v", name, "-r", str(rate), "-o", str(aiff), speakable(text)], check=True, capture_output=True)
    resample(aiff, out)


def _run_piper(text: str, out: Path) -> None:
    v = _S.get("voice", {})
    subprocess.run(["piper", "--model", PIPER_ONNX, "--length_scale", str(v.get("piperLength", PIPER_LENGTH)), "--noise_scale", str(v.get("piperNoise", 0.5)),
                    "--noise_w_scale", "0.6", "--sentence_silence", "0.12", "--output_file", str(out)], input=text.encode("utf-8"), check=True, capture_output=True)


def _run_silent(text: str, out: Path) -> None:
    secs = max(1.0, len(text) / 15.0)
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono", "-t", f"{secs:.2f}", str(out)], check=True)


def synthesize(jobs: list, speed: float | None = None) -> None:
    """jobs: [{"voice": <katalog kaydı>, "text": ..., "out": Path}] — aynı motordakiler toplu üretilir.
    Çıktılar 44.1 kHz mono wav. Hata: RuntimeError(voice id)."""
    groups: dict = {}
    for j in jobs:
        groups.setdefault(j["voice"]["id"], []).append(j)
    for vid, js in groups.items():
        v = js[0]["voice"]
        e = v["engine"]
        try:
            if e == "trendyol" and trendyol_mlx_ready():
                for j in js:
                    _run_trendyol_mlx(prep_text(j["text"]), Path(j["out"]))
            elif e in ("trendyol", "voxcpm"):
                model = v.get("model") or TR.get("torchModel", "Trendyol/Trendyol-TTS")
                tmps = [Path(j["out"]).with_name(Path(j["out"]).stem + ".raw.wav") for j in js]
                _run_voxcpm_batch(model, [{"text": prep_text(j["text"]), "out": str(t), "instruct": v.get("instruct", ""),
                                           "ref": str(ROOT / v["ref"]) if v.get("ref") else ""} for j, t in zip(js, tmps)])
                for j, t in zip(js, tmps):
                    resample(t, Path(j["out"]))
            elif e == "ema":
                tmps = [Path(j["out"]).with_name(Path(j["out"]).stem + ".raw.wav") for j in js]
                _run_ema_batch([{"text": prep_text(j["text"]), "out": str(t)} for j, t in zip(js, tmps)], speed or float(TR.get("emaSpeed", 1.0)))
                for j, t in zip(js, tmps):
                    resample(t, Path(j["out"]))
            elif e == "chatterbox":
                with on_demand() as ok:
                    if not ok:
                        raise RuntimeError("Chatterbox sunucusu açılamadı")
                    for j in js:
                        _run_chatterbox(prep_text(j["text"]), Path(j["out"]))
            elif e == "say":
                for j in js:
                    _run_say(v.get("name", "Yelda"), j["text"], Path(j["out"]))
            elif e == "piper":
                for j in js:
                    _run_piper(prep_text(j["text"]), Path(j["out"]))
            elif e == "silent":
                for j in js:
                    _run_silent(j["text"], Path(j["out"]))
            else:
                raise RuntimeError(f"bilinmeyen motor {e}")
        except Exception as err:
            raise RuntimeError(f"{vid}: {str(err)[:300]}") from err


# ---------- segment → ses ataması ----------
def assign(n_segments: int) -> list:
    """settings.narration: {mode: single|alternate, voice, voiceA, voiceB}. Dönüşümlü modda sıra
    kanca=A, intro=B, 1. haber=A, 2. haber=B … (kadın/erkek sırayla). Katalog kayıtlarını döndürür."""
    n = {**{"mode": "single", "voice": "auto", "voiceA": "vox-kadin", "voiceB": "vox-erkek"}, **_S.get("narration", {})}
    legacy = _S.get("narrationEngine", "auto")
    if n["voice"] == "auto" and legacy not in ("auto", None):
        n["voice"] = {"say": "yelda"}.get(legacy, legacy)
    forced = os.environ.get("TTS_ENGINE")
    if forced and forced != "silent":
        n = {**n, "mode": "single", "voice": {"say": "yelda"}.get(forced, forced)}
    if n["mode"] == "alternate" and os.environ.get("TTS_ENGINE") != "silent":
        a, b = resolve(n["voiceA"]), resolve(n["voiceB"])
        if a["id"] == b["id"]:
            print("  ! dönüşümlü mod için iki farklı ses hazır değil, tek sesle devam", file=sys.stderr)
        return [a if i % 2 == 0 else b for i in range(n_segments)]
    v = resolve(n["voice"])
    return [v] * n_segments


def preview(vid: str, out: Path, text: str | None = None) -> dict:
    v = resolve(vid, quiet=True) if vid == "auto" else voice(vid)
    if not v:
        return {"ok": False, "error": "bilinmeyen ses"}
    ok, why = available(v)
    if not ok:
        return {"ok": False, "error": why}
    out.parent.mkdir(parents=True, exist_ok=True)
    synthesize([{"voice": v, "text": text or PREVIEW_TEXT, "out": out}])
    return {"ok": True, "voice": v["id"], "file": str(out)}


if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--preview")
    ap.add_argument("--out")
    ap.add_argument("--text")
    a = ap.parse_args()
    if a.list:
        rows = []
        for v in catalog():
            ok, why = available(v)
            rows.append({k: v[k] for k in ("id", "label", "gender", "engine") if k in v} | {"note": v.get("note", ""), "ready": ok, "why": why})
        print(json.dumps(rows, ensure_ascii=False))
    elif a.preview:
        try:
            print(json.dumps(preview(a.preview, Path(a.out), a.text), ensure_ascii=False))
        except Exception as e:
            print(json.dumps({"ok": False, "error": str(e)[:300]}, ensure_ascii=False))
