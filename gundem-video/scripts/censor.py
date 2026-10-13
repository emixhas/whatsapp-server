#!/usr/bin/env python3
"""Hassas kelimeleri platform denetimine takılmayacak, ama anlaşılır kalacak şekilde gizler (kullanıcı isteği).

- Seste: kelimenin yerine "bip" sesi çalar (tts.py, `pieces()`); cümlenin geri kalanı okunur, anlam bağlamdan anlaşılır.
- Yazıda (açıklama, yayın başlığı, ekrandaki başlıklar, yanan altyazı): kelimenin bir harfi yıldızla gizlenir
  (`mask()`): intihar → int*har, silah → s*lah, ölüm → ö*üm, cinayet → c*nayet. Hassas kelime içeren hashtag atılır.

Kelime listesi `settings.censor.words` ile değiştirilir (kök ya da düzenli ifade; Türkçe ekler kendiliğinden kapsanır);
panelden eklenen düz kelimeler `settings.censor.extra`. `settings.censor` {enabled, audio, text, words, extra}.

Kullanım (deneme): python3 scripts/censor.py "Genç kadın intihar etti, silahla vurulan adam öldü."
"""
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import settings  # noqa: E402

# Kökler (küçük harf, Türkçe). Yanlış eşleşmeyi önlemek için kısa köklerde ek kalıbı açık yazılır
# (ör. "öl" ölçü/ölçek'i yakalamasın, "boğ" Boğaz'ı yakalamasın).
DEFAULT_WORDS = [
    "intihar", r"öl(?:üm|ü|dü|dür|en|me|müş|ecek|ür)", "silah", "cinayet", r"katil", r"katle", r"bıçak",
    "kurşun", "tecavüz", "istismar", "taciz", "uyuşturucu", r"ces(?:et|ed)", "işkence", "vahşet",
    r"boğ(?:ul|arak|du|duğu|dular)", r"tabanca", r"pompalı", r"rehin", r"bomba", r"terör",
]

_LOW = str.maketrans({"I": "ı", "İ": "i"})
VOWELS = set("aeıioöuüAEIİOÖUÜâîû")


def cfg() -> dict:
    c = {"enabled": True, "audio": True, "text": True, "words": DEFAULT_WORDS, "extra": [], **(settings().get("censor") or {})}
    # panelden eklenen kelimeler (düz kelime; düzenli ifade karakterleri kaçırılır)
    extra = [re.escape(tr_lower(str(w).strip())) for w in (c.get("extra") or []) if str(w).strip()]
    c["words"] = list(c.get("words") or DEFAULT_WORDS) + extra
    return c


def tr_lower(t: str) -> str:
    """Uzunluğu koruyan Türkçe küçük harf (İ → i, I → ı); konumlar özgün metinle aynı kalır."""
    return "".join(ch.translate(_LOW).lower()[:1] if ch in "Iİ" else ch.lower()[:1] or ch for ch in t)


def _pattern(words=None):
    words = words or cfg()["words"]
    # kelime başında başlar, ekleriyle birlikte kelime sonuna kadar uzanır
    return re.compile(r"(?<![\wçğıöşü])(?:" + "|".join(f"(?:{w})" for w in words) + r")[\wçğıöşü']*", re.I)


def spans(text: str, words=None) -> list:
    """Hassas kelimelerin (başlangıç, bitiş) konumları."""
    if not text:
        return []
    return [(m.start(), m.end()) for m in _pattern(words).finditer(tr_lower(text))]


def mask_word(w: str) -> str:
    """Bir harfi yıldızla gizler, kelime okunur kalır: kısa kelimede 2. harf, uzunda 2. harften sonraki ilk ünlü."""
    core = w.split("'")[0]
    rest = w[len(core):]
    if len(core) <= 2:
        return core[0] + "*" + rest if core else w
    idx = 1
    if len(core) > 4:
        idx = next((i for i in range(1, len(core) - 1) if core[i] in VOWELS), 1)
    return core[:idx] + "*" + core[idx + 1:] + rest


def mask(text: str, words=None) -> str:
    if not text or not cfg().get("enabled") or not cfg().get("text"):
        return text
    out, last = [], 0
    for a, b in spans(text, words):
        out.append(text[last:a] + mask_word(text[a:b]))
        last = b
    return "".join(out) + text[last:]


def has(text: str) -> bool:
    return bool(text) and bool(spans(text))


def pieces(text: str) -> list:
    """Seslendirme parçaları: [("text", "..."), ("beep", saniye), ("text", "...")…]; hassas kelime yoksa tek parça."""
    c = cfg()
    if not text or not c.get("enabled") or not c.get("audio"):
        return [("text", text)]
    out, last = [], 0
    for a, b in spans(text):
        before = text[last:a].strip()
        if before and re.search(r"[\wçğıöşüÇĞİÖŞÜ]", before):  # yalnız noktalama kalan parça seslendirilmez
            out.append(("text", before))
        word = text[a:b]
        out.append(("beep", round(min(0.8, max(0.32, 0.065 * len(word))), 2)))
        last = b
    after = text[last:].strip()
    # kelimeden sonra yalnız noktalama kaldıysa ayrı seslendirilmez
    if after and re.search(r"[\wçğıöşüÇĞİÖŞÜ]", after):
        out.append(("text", after))
    return out or [("text", text)]


def clean_tags(tags: list) -> list:
    """Hassas kelime içeren hashtag'ler atılır (#int*har geçerli etiket olmaz)."""
    if not cfg().get("enabled") or not cfg().get("text"):
        return tags
    return [t for t in tags if not has(str(t).lstrip("#"))]


if __name__ == "__main__":
    t = " ".join(sys.argv[1:]) or "Genç kadın intihar etti; silahla vurulan adam öldü, cesedi bulundu. Ölçü ve Boğaz etkilenmedi."
    print(mask(t))
    print(pieces(t))
