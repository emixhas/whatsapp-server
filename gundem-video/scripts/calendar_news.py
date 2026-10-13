#!/usr/bin/env python3
"""Takvim haberleri (kullanıcı kararı: önceden bilinen tarihlerde "Yarın …" hatırlatma videosu; uydurma riski yok).

Bir gün önce `settings.calendar.hour` (19:00) olunca, yarına denk gelen olay için şablon senaryo + takvim yaprağı kartı
(Claude çağrılmaz). Olaylar:
  - Resmi tatiller ve bayramlar (sabit günler; Ramazan/Kurban Bayramı Diyanet takvimine göre yıl yıl `RELIGIOUS` içinde —
    yeni yıl eklenirken Diyanet'in ilan ettiği tarihlerle güncelle),
  - Vergi ve ödeme son günleri (KDV beyannamesi her ayın 28'i, motorlu taşıtlar vergisi Ocak ve Temmuz sonu, yıllık gelir
    vergisi beyannamesi 31 Mart), memur maaşları her ayın 15'i, 10 Kasım saat 09.05 anma,
  - Panelden eklenenler `settings.calendar.extra`: satır başına "2027-06-19 | YKS ilk oturum | açıklama" (tarih YYYY-AA-GG,
    her yıl için AA-GG, her ay için "ay:15").
Üretilenler `data/calendar_done.json` (aynı olay bir kez).

  python3 scripts/calendar_news.py --due       # yarının olayları (üretilmemiş)
  python3 scripts/calendar_news.py --job KEY   # olay için iş klasörü
  python3 scripts/calendar_news.py --list 60   # önümüzdeki 60 günün olayları
"""
import json
import re
import sys
import time
from datetime import date, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import DATA, load_json, save_json, settings  # noqa: E402
from info_card import DAYS, MONTHS, make_script, new_job  # noqa: E402

DONE = DATA / "calendar_done.json"

# her yıl aynı gün: (AA-GG, başlık, kısa etiket, ayrıntı)
FIXED = [
    ("01-01", "Yılbaşı tatili", "RESMİ TATİL", "Yılbaşı nedeniyle resmi tatil. Kamu kurumları ve okullar kapalı olacak."),
    ("04-23", "23 Nisan Ulusal Egemenlik ve Çocuk Bayramı", "RESMİ TATİL", "Resmi tatil nedeniyle kamu kurumları ve okullar kapalı olacak. Yurt genelinde kutlama törenleri düzenlenecek."),
    ("05-01", "1 Mayıs Emek ve Dayanışma Günü", "RESMİ TATİL", "Resmi tatil nedeniyle kamu kurumları ve okullar kapalı olacak."),
    ("05-19", "19 Mayıs Atatürk'ü Anma, Gençlik ve Spor Bayramı", "RESMİ TATİL", "Resmi tatil nedeniyle kamu kurumları ve okullar kapalı olacak. Yurt genelinde törenler düzenlenecek."),
    ("07-15", "15 Temmuz Demokrasi ve Milli Birlik Günü", "RESMİ TATİL", "Resmi tatil nedeniyle kamu kurumları kapalı olacak. Yurt genelinde anma programları düzenlenecek."),
    ("08-30", "30 Ağustos Zafer Bayramı", "RESMİ TATİL", "Resmi tatil nedeniyle kamu kurumları kapalı olacak. Yurt genelinde kutlama törenleri düzenlenecek."),
    ("10-29", "29 Ekim Cumhuriyet Bayramı", "RESMİ TATİL", "Resmi tatil nedeniyle kamu kurumları ve okullar kapalı olacak. Bugün öğleden sonra yarım gün tatil uygulanıyor."),
    ("11-10", "10 Kasım Atatürk'ü anma günü", "ANMA", "Atatürk ölümünün yıl dönümünde saat 9'u 5 geçe saygı duruşuyla anılacak. Yurt genelinde anma törenleri düzenlenecek."),
    ("03-31", "Gelir vergisi beyannamesinin son günü", "SON GÜN", "Yıllık gelir vergisi beyannamesi için son gün. Beyanname Hazır Beyan sistemi üzerinden verilebiliyor."),
    ("01-31", "Motorlu taşıtlar vergisi ilk taksit son günü", "SON GÜN", "Motorlu taşıtlar vergisinin ilk taksidi için son gün. Ödemeler bankalar ve dijital vergi dairesi üzerinden yapılabiliyor."),
    ("07-31", "Motorlu taşıtlar vergisi ikinci taksit son günü", "SON GÜN", "Motorlu taşıtlar vergisinin ikinci taksidi için son gün. Ödemeler bankalar ve dijital vergi dairesi üzerinden yapılabiliyor."),
]
# her ay: (gün, başlık, etiket, ayrıntı)
MONTHLY = [
    (15, "Memur maaşları yatıyor", "MAAŞ GÜNÜ", "Memur maaşları her ayın 15'inde hesaplara yatırılıyor."),
    (28, "Katma değer vergisi beyannamesinin son günü", "SON GÜN", "Katma değer vergisi beyannamesi ve ödemesi için son gün her ayın 28'i."),
]
# Diyanet takvimi: bayramın 1. günü ve gün sayısı (arife bir gün önce, öğleden sonra yarım gün)
RELIGIOUS = {
    "2026-03-20": ("Ramazan Bayramı", 3), "2026-05-27": ("Kurban Bayramı", 4),
    "2027-03-09": ("Ramazan Bayramı", 3), "2027-05-16": ("Kurban Bayramı", 4),
}


def cfg() -> dict:
    return {"enabled": True, "hour": 19, "minute": 0, "duration": 25, "monthly": True, "extra": [], **(settings().get("calendar") or {})}


def tr_day(d: date, weekday: bool = True) -> str:
    return f"{d.day} {MONTHS[d.month - 1]}" + (f" {DAYS[d.weekday()]}" if weekday else "")


def events_on(d: date) -> list:
    c = cfg()
    out = []
    md = d.strftime("%m-%d")
    weekend = d.weekday() >= 5  # son gün / maaş günü hafta sonuna denk gelirse ilk iş gününe kayar: o gün hatırlatma yapılmaz
    for k, title, label, detail in FIXED:
        if k == md and not (weekend and label == "SON GÜN"):
            out.append({"key": f"{d}-{k}", "title": title, "label": label, "detail": detail})
    if c.get("monthly", True):
        for day, title, label, detail in MONTHLY:
            if d.day == day and not weekend:
                out.append({"key": f"{d}-ay{day}", "title": title, "label": label, "detail": detail})
    for first, (name, n) in RELIGIOUS.items():
        f = date.fromisoformat(first)
        if d == f:
            out.append({"key": f"{d}-bayram", "title": f"{name} başlıyor", "label": "BAYRAM",
                        "detail": f"{name} {n} gün sürecek. Bugün arife; kamu kurumlarında öğleden sonra yarım gün tatil uygulanıyor."})
    for line in c.get("extra") or []:
        parts = [p.strip() for p in str(line).split("|")]
        if len(parts) < 2 or not parts[1]:
            continue
        when, title, detail = parts[0], parts[1], (parts[2] if len(parts) > 2 else "")
        hit = when == d.isoformat() or when == md or (re.match(r"^ay:(\d{1,2})$", when) and int(when[3:]) == d.day)
        if hit:
            out.append({"key": f"{d}-x-{re.sub(r'[^a-z0-9]+', '', title.lower())[:20]}", "title": title, "label": "HATIRLATMA", "detail": detail})
    for e in out:
        e["date"] = d.isoformat()
    return out


def due() -> list:
    done = load_json(DONE, {}) or {}
    tomorrow = date.today() + timedelta(days=1)
    return [e for e in events_on(tomorrow) if e["key"] not in done]


def build_job(e: dict) -> str:
    d = date.fromisoformat(e["date"])
    title = e["title"]
    # cümle içinde küçük harfle ("Yarın memur maaşları yatıyor"); özel ad ve rakamla başlayan başlık olduğu gibi
    inner = title if re.match(r"^(\d|[A-ZÇĞİÖŞÜ]{2})", title) or title.split()[0] in ("Ramazan", "Kurban", "Yılbaşı") else title[:1].lower() + title[1:]
    hook = f"Yarın {inner}."
    if re.match(r"^\d", title):  # "29 Ekim Cumhuriyet Bayramı": tarih zaten başlıkta
        narr = f"{title} bu yıl {DAYS[d.weekday()]} gününe denk geliyor. {e['detail']}".strip()
    else:
        narr = f"{tr_day(d)} günü {inner}. {e['detail']}".strip()
    short = re.sub(r"^\d+\s+\w+\s+", "", e["title"]).split(",")[0]
    script = make_script(
        hook_title=f"YARIN {short}", hook=hook,
        items=[{"title": short, "narration": narr}],
        titles={"A": f"Yarın {e['title']} ({tr_day(d)})", "B": f"Unutmayın: {e['title']}", "cover": f"YARIN {short}"},
        hashtags=["#" + re.sub(r"[^\wçğıöşü]", "", short.replace("I", "ı").replace("İ", "i").lower())[:30], "#hatırlatma", "#gündem"],
        importance=3, reason="takvim hatırlatması", source="Takvim", category="toplum")
    card = {"kind": "calendar", "label": "YARIN", "stamp": e["label"], "title": e["title"], "sub": tr_day(d),
            "date": {"day": str(d.day), "month": MONTHS[d.month - 1], "weekday": DAYS[d.weekday()]}}
    return str(new_job(f"takvim-{e['key']}", script, [card], {"event": e}))


def mark(key: str) -> None:
    done = load_json(DONE, {}) or {}
    done[key] = time.time()
    save_json(DONE, {k: v for k, v in done.items() if time.time() - v < 400 * 86400})


if __name__ == "__main__":
    try:
        if "--due" in sys.argv:
            res = {"ok": True, "events": due()}
        elif "--job" in sys.argv:
            key = sys.argv[sys.argv.index("--job") + 1]
            ev = next((e for e in events_on(date.today() + timedelta(days=1)) if e["key"] == key), None)
            res = {"ok": bool(ev), "job": build_job(ev) if ev else None, "event": ev, **({} if ev else {"error": "olay bulunamadı"})}
            if ev:
                mark(key)
        elif "--list" in sys.argv:
            n = int(sys.argv[sys.argv.index("--list") + 1]) if len(sys.argv) > sys.argv.index("--list") + 1 else 60
            res = {"ok": True, "events": [e for i in range(1, n + 1) for e in events_on(date.today() + timedelta(days=i))]}
        else:
            res = {"ok": False, "error": "kullanım: --due | --job KEY | --list N"}
    except Exception as ex:
        res = {"ok": False, "error": str(ex)[:300]}
    print(json.dumps(res, ensure_ascii=False))
