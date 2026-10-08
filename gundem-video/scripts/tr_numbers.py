"""Türkçe seslendirme öncesi metin normalizasyonu: rakamları yazıya çevirir.

Yerel TTS modellerinin çoğu (Trendyol-TTS, Freya, Piper) rakamları ya atlar ya da yanlış okur;
bu yüzden "3 kişi" → "üç kişi", "1.250.000" → "bir milyon iki yüz elli bin", "3,5" → "üç virgül beş",
"7. gün" → "yedinci gün", "2026'da" → "iki bin yirmi altıda" dönüşümleri burada yapılır.
Dış bağımlılık yok.
"""
import re

ONES = ["", "bir", "iki", "üç", "dört", "beş", "altı", "yedi", "sekiz", "dokuz"]
TENS = ["", "on", "yirmi", "otuz", "kırk", "elli", "altmış", "yetmiş", "seksen", "doksan"]
SCALES = [(1_000_000_000_000, "trilyon"), (1_000_000_000, "milyar"), (1_000_000, "milyon"), (1_000, "bin")]


def _under_thousand(n: int) -> str:
    parts = []
    h, r = divmod(n, 100)
    if h:
        parts.append("yüz" if h == 1 else f"{ONES[h]} yüz")
    t, o = divmod(r, 10)
    if t:
        parts.append(TENS[t])
    if o:
        parts.append(ONES[o])
    return " ".join(parts)


def int_to_tr(n: int) -> str:
    if n == 0:
        return "sıfır"
    if n < 0:
        return "eksi " + int_to_tr(-n)
    parts = []
    for value, name in SCALES:
        q, n = divmod(n, value)
        if q:
            parts.append(name if (q == 1 and name == "bin") else f"{_under_thousand(q) if q < 1000 else int_to_tr(q)} {name}")
    if n:
        parts.append(_under_thousand(n))
    return " ".join(parts)


_ORD_SUFFIX = {"a": "ıncı", "ı": "ıncı", "e": "inci", "i": "inci", "o": "uncu", "u": "uncu", "ö": "üncü", "ü": "üncü"}
_VOWELS = "aeıioöuü"


def ordinal_tr(n: int) -> str:
    words = int_to_tr(n).split()
    last = words[-1]
    if last == "dört":
        last = "dördüncü"
    elif last == "üç":
        last = "üçüncü"
    else:
        vowel = next((ch for ch in reversed(last) if ch in _VOWELS), "e")
        suf = _ORD_SUFFIX[vowel]
        last = last + (suf[1:] if last[-1] in _VOWELS else suf)
    return " ".join(words[:-1] + [last])


# 1.250.000 / 1250000 / 3,5 / 12.5 / 2026'da / 7. (sıralı)
_NUM = re.compile(r"(?<![\w])(\d{1,3}(?:\.\d{3})+|\d+)(?:([,.])(\d+))?(\.(?=\s*[a-zçğıöşü]))?(?:'(\w+))?")


def _repl(m: re.Match) -> str:
    whole = m.group(1).replace(".", "")
    sep, frac, ordinal, suffix = m.group(2), m.group(3), m.group(4), m.group(5)
    n = int(whole)
    if ordinal and not frac:
        out = ordinal_tr(n)
    elif frac and sep == "," or (frac and sep == "." and len(frac) != 3):
        out = f"{int_to_tr(n)} virgül {' '.join(int_to_tr(int(d)) for d in frac) if frac.startswith('0') else int_to_tr(int(frac))}"
    elif frac and sep == ".":
        out = int_to_tr(int(whole + frac))  # 12.500 → on iki bin beş yüz
    else:
        out = int_to_tr(n)
    return out + (suffix if suffix else "")


_TIME = re.compile(r"(?<![\w:])(\d{1,2}):(\d{2})(?!\d)(?:'(\w+))?")


def _time_repl(m: re.Match) -> str:
    h, mi, suffix = int(m.group(1)), int(m.group(2)), m.group(3) or ""
    out = int_to_tr(h) if mi == 0 else f"{int_to_tr(h)} {int_to_tr(mi)}"
    return out + suffix


def normalize_tr(text: str) -> str:
    """Rakamları Türkçe yazıya çevirir; yüzde işaretini ve bazı sembolleri okunur yapar."""
    t = text.replace("%", "yüzde ")
    t = _TIME.sub(_time_repl, t)  # 14:00'te → on dörtte, 09:30 → dokuz otuz
    t = re.sub(r"(\d)\s*-\s*(\d)", r"\1 ile \2", t)  # 3-5 derece → 3 ile 5 derece
    t = _NUM.sub(_repl, t)
    t = re.sub(r"\s{2,}", " ", t)
    return t.strip()


if __name__ == "__main__":
    import sys
    print(normalize_tr(sys.stdin.read() if not sys.stdin.isatty() else " ".join(sys.argv[1:])))
