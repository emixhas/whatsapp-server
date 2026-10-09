#!/usr/bin/env python3
"""Haber değeri: YouTube'un günlük yükleme sınırı yüzünden anlık/Mynet videolarından yalnız "değerli" olanlar
YouTube'a gider (otomatik 5 saatlik üretimler her zaman gider). Değerli = halkı doğrudan ilgilendiren haber:
can kaybı, kaza/afet, emekli/memur maaşı ve asgari ücret, zam/fiyat/vergi, tatil/bayram/izin,
sınav/yasak duyurusu, terör/saldırı.

Karar iki kaynaktan: anahtar kelime grupları (aşağıda, settings.youtubePolicy.extraKeywords ile genişletilir)
ve senaryoyu yazan modelin verdiği "importance" (1-5): 4-5 her zaman değerli, 1-2 anahtar kelimeyi geçersiz kılar.

  python3 scripts/news_value.py "Asgari ücrete yüzde 30 zam"     # {"valuable": true, "score": 3, ...}
"""
import json
import re
import sys


def tr_lower(t: str) -> str:
    return t.replace("I", "ı").replace("İ", "i").lower()


# (grup adı, ağırlık, desenler) — desenler küçük harfli metinde kelime başından aranır
GROUPS = [
    ("can kaybı", 3, [r"öldü", r"ölü\b", r"ölüm", r"hayatını kaybet", r"yaşamını yitir", r"can kaybı", r"cansız",
                      r"şehit", r"vefat", r"cinayet", r"öldürül", r"cenaze"]),
    ("kaza/afet", 3, [r"kaza(?:sı|da|ya|nın|lar\w*)?\b", r"deprem", r"sel(?:de|deki|den|e|i)?\b", r"yangın", r"patlama",
                      r"çöktü", r"çökme", r"heyelan", r"çığ\b", r"fırtına", r"hortum", r"yaralı", r"enkaz"]),
    ("emekli/memur maaşı", 3, [r"emekli", r"memur", r"maaş", r"kök maaş", r"refah payı", r"toplu sözleşme",
                               r"enflasyon fark", r"bayram ikramiye", r"ikramiye", r"promosyon", r"bağ-?kur", r"sgk",
                               r"dul ve yetim", r"asgari ücret", r"asgari geçim"]),
    ("zam/fiyat/vergi", 3, [r"zam(?:m[ıi]|l[ıi]|landı|lar\w*| oran\w*)?\b", r"faiz", r"enflasyon", r"akaryakıt",
                            r"benzin", r"motorin", r"doğal ?gaz", r"elektri[kğ]", r"vergi", r"ötv", r"kdv", r"harç",
                            r"kira artış", r"köprü ve otoyol", r"tüik"]),
    ("tatil/izin", 3, [r"tatil", r"bayram", r"arife", r"idari izin", r"resmi tatil", r"köprü günü", r"uzun hafta sonu",
                       r"okullar", r"karne", r"ara tatil", r"yarıyıl"]),
    ("kamu duyurusu", 3, [r"sınav", r"kpss", r"yks\b", r"lgs\b", r"yasak", r"kısıtlama", r"bedelli", r"askerlik",
                          r"af\b", r"genelge", r"resmi gazete"]),
    ("güvenlik", 3, [r"terör", r"saldırı", r"bomba", r"silahlı", r"rehine"]),
]


# magazin/spor: anahtar kelime tek başına yetmez ("ünlü oyuncu tatilde"); model 4-5 derse değerli
SOFT = [r"ünlü", r"oyuncu", r"şarkıcı", r"magazin", r"dizi", r"sevgili", r"evlen", r"boşan", r"futbolcu", r"teknik direktör"]


def score(text: str, extra_keywords=None, importance=None) -> dict:
    t = tr_lower(text or "")
    hits = []
    total = 0
    for name, w, pats in GROUPS:
        found = next((p for p in pats if re.search(r"(?<![\wçğıöşü])" + p, t)), None)
        if found:
            hits.append(name)
            total += w
    for kw in extra_keywords or []:
        kw = tr_lower(str(kw).strip())
        if kw and kw in t:
            hits.append(f"anahtar: {kw}")
            total += 3
    imp = None
    try:
        imp = int(importance) if importance is not None else None
    except (TypeError, ValueError):
        imp = None
    # model 1-2 dediyse (magazin: "ünlünün annesi vefat etti") anahtar kelime tek başına yetmez
    soft = "can kaybı" not in hits and any(re.search(r"(?<![\wçğıöşü])" + p, t) for p in SOFT)
    valuable = (imp is not None and imp >= 4) or (total >= 3 and not soft and (imp is None or imp >= 3))
    if soft and total >= 3 and not valuable:
        hits.append("magazin/spor")
    reason = ", ".join(hits) or (f"önem {imp}/5" if imp else "sıradan haber")
    if imp is not None and hits:
        reason += f" · önem {imp}/5"
    return {"valuable": valuable, "score": total, "importance": imp, "reasons": hits, "reason": reason}


if __name__ == "__main__":
    print(json.dumps(score(" ".join(sys.argv[1:]) or sys.stdin.read()), ensure_ascii=False))
