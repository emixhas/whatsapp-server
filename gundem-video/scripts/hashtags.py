#!/usr/bin/env python3
"""Konuya özel hashtag: senaryodaki "hashtags" (model yazar) + kategori + haber değeri grubu + kanal etiketleri.
YouTube 15'ten fazla hashtag görürse hepsini yok saydığı için toplam MAX_TAGS ile sınırlıdır; ilk üçü başlığın
üstünde görünür, bu yüzden konuya özel olanlar önce gelir. Hashtag'ler boşluksuz, küçük harf, Türkçe karakterli.
"""
import re

MAX_TAGS = 12

CATEGORY_TAGS = {"finans": "#ekonomi", "siyaset": "#siyaset", "parti": "#siyaset", "asayis": "#asayiş", "spor": "#spor",
                 "hava": "#havadurumu", "toplum": "#toplum", "egitim": "#eğitim", "teknoloji": "#teknoloji",
                 "saglik": "#sağlık", "dunya": "#dünya"}
VALUE_TAGS = {"can kaybı": "#sondakika", "kaza/afet": "#kaza", "emekli/memur maaşı": "#emekli",
              "zam/fiyat/vergi": "#zam", "tatil/izin": "#tatil", "kamu duyurusu": "#duyuru", "güvenlik": "#güvenlik",
              "para ve destek": "#ekonomi", "sağlık ve gıda": "#sağlık", "milli başarı": "#millitakım"}


def tr_lower(t: str) -> str:
    return t.replace("I", "ı").replace("İ", "i").lower()


def clean(tag: str) -> str:
    """'Asgari Ücret' / '#asgari_ücret' → '#asgariücret'; geçersizse ''."""
    t = re.sub(r"[^0-9a-zçğıöşü]", "", tr_lower(str(tag or "")))
    return f"#{t}" if 2 < len(t) <= 30 and not t.isdigit() else ""


def for_meta(meta: dict, base: str = "", extra=()) -> list:
    """Bir bölümün hashtag listesi (sırayla, tekrarsız)."""
    out = []

    def add(t):
        t = clean(t)
        if t and t not in out:
            out.append(t)

    for t in meta.get("hashtags") or []:
        add(t)
    for t in extra:
        add(t)
    for r in (meta.get("value") or {}).get("reasons") or []:
        if r in VALUE_TAGS:
            add(VALUE_TAGS[r])
    for s in meta.get("segments", []):
        if s.get("kind") == "haber" and s.get("category") in CATEGORY_TAGS:
            add(CATEGORY_TAGS[s["category"]])
    for t in (base or "").split():
        if t.lower() == "#shorts" and meta.get("format") == "gunluk":  # yatay uzun video Shorts değil
            continue
        add(t)
    return out[:MAX_TAGS]


def youtube_tags(tags: list) -> list:
    """YouTube 'tags' alanı: # olmadan, toplam 450 karakteri aşmadan."""
    out, n = [], 0
    for t in tags:
        w = t.lstrip("#")
        if n + len(w) + 1 > 450:
            break
        out.append(w)
        n += len(w) + 1
    return out
