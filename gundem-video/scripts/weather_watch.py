#!/usr/bin/env python3
"""Meteoroloji uyarısı videosu (kullanıcı kararı: turuncu/kırmızı uyarıda il haritalı video).

Kaynak: Meteoalarm Türkiye akışı (Meteoroloji Genel Müdürlüğü'nün yayınladığı resmi uyarılar; CAP alanları: areaDesc,
awareness_level "3; orange; Severe", awareness_type "10; rain", onset, expires). `settings.weather` {enabled, minLevel
"orange", intervalMin 30, duration 25, url}. Aynı seviye + türdeki iller tek videoda; en şiddetli grup (kırmızı > turuncu, sonra
il sayısı) seçilir. Aynı uyarı (seviye, tür, başlangıç günü) bir kez; turuncudan kırmızıya yükselirse yeniden üretilir.
Görülenler `data/weather_seen.json`. Senaryo şablondan (Claude yok), görsel uyarı haritası kartı (il noktaları seviye renginde).

  python3 scripts/weather_watch.py --check   # yeni turuncu/kırmızı uyarı varsa iş klasörü
  python3 scripts/weather_watch.py --test    # örnek uyarıyla iş klasörü
"""
import html
import json
import re
import ssl
import sys
import time
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import DATA, load_json, save_json, settings  # noqa: E402
from info_card import DAYS, MONTHS, make_script, new_job  # noqa: E402
from quake_watch import _fold, title_case  # noqa: E402

try:
    import certifi
    CTX = ssl.create_default_context(cafile=certifi.where())
except ImportError:
    CTX = ssl.create_default_context()

SEEN = DATA / "weather_seen.json"
TR = timezone(timedelta(hours=3))
LEVELS = {"yellow": 2, "orange": 3, "red": 4}
LEVEL_TR = {"yellow": "sarı", "orange": "turuncu", "red": "kırmızı"}
TYPE_TR = {"wind": "kuvvetli rüzgar ve fırtına", "snow": "yoğun kar ve buzlanma", "ice": "yoğun kar ve buzlanma", "thunder": "gök gürültülü sağanak",
           "fog": "yoğun sis", "high-temperature": "aşırı sıcak", "low-temperature": "aşırı soğuk", "coastal": "kıyılarda fırtına ve dalga",
           "forest": "orman yangını riski", "avalanche": "çığ tehlikesi", "rain": "kuvvetli yağış", "flood": "sel ve su baskını"}
# il merkezlerinin yaklaşık enlem/boylamı (haritadaki nokta için)
CENTERS = {
    "Adana": (37.0, 35.32), "Adıyaman": (37.76, 38.28), "Afyonkarahisar": (38.76, 30.54), "Ağrı": (39.72, 43.05), "Aksaray": (38.37, 34.03),
    "Amasya": (40.65, 35.83), "Ankara": (39.93, 32.86), "Antalya": (36.9, 30.7), "Ardahan": (41.11, 42.7), "Artvin": (41.18, 41.82),
    "Aydın": (37.85, 27.85), "Balıkesir": (39.65, 27.88), "Bartın": (41.63, 32.34), "Batman": (37.88, 41.13), "Bayburt": (40.26, 40.23),
    "Bilecik": (40.14, 29.98), "Bingöl": (38.88, 40.5), "Bitlis": (38.4, 42.11), "Bolu": (40.74, 31.61), "Burdur": (37.72, 30.29),
    "Bursa": (40.19, 29.06), "Çanakkale": (40.15, 26.41), "Çankırı": (40.6, 33.62), "Çorum": (40.55, 34.95), "Denizli": (37.78, 29.09),
    "Diyarbakır": (37.91, 40.24), "Düzce": (40.84, 31.16), "Edirne": (41.68, 26.56), "Elazığ": (38.67, 39.22), "Erzincan": (39.75, 39.49),
    "Erzurum": (39.9, 41.27), "Eskişehir": (39.78, 30.52), "Gaziantep": (37.07, 37.38), "Giresun": (40.91, 38.39), "Gümüşhane": (40.46, 39.48),
    "Hakkari": (37.58, 43.74), "Hatay": (36.2, 36.16), "Iğdır": (39.92, 44.04), "Isparta": (37.76, 30.55), "İstanbul": (41.01, 28.98),
    "İzmir": (38.42, 27.14), "Kahramanmaraş": (37.58, 36.94), "Karabük": (41.2, 32.62), "Karaman": (37.18, 33.22), "Kars": (40.6, 43.1),
    "Kastamonu": (41.38, 33.78), "Kayseri": (38.73, 35.48), "Kilis": (36.72, 37.12), "Kırıkkale": (39.85, 33.51), "Kırklareli": (41.74, 27.22),
    "Kırşehir": (39.15, 34.16), "Kocaeli": (40.77, 29.92), "Konya": (37.87, 32.48), "Kütahya": (39.42, 29.98), "Malatya": (38.35, 38.31),
    "Manisa": (38.61, 27.43), "Mardin": (37.31, 40.74), "Mersin": (36.8, 34.64), "Muğla": (37.22, 28.36), "Muş": (38.74, 41.49),
    "Nevşehir": (38.62, 34.71), "Niğde": (37.97, 34.68), "Ordu": (40.98, 37.88), "Osmaniye": (37.07, 36.25), "Rize": (41.02, 40.52),
    "Sakarya": (40.78, 30.4), "Samsun": (41.29, 36.33), "Şanlıurfa": (37.16, 38.79), "Siirt": (37.93, 41.94), "Sinop": (42.03, 35.15),
    "Sivas": (39.75, 37.02), "Şırnak": (37.52, 42.46), "Tekirdağ": (40.98, 27.51), "Tokat": (40.31, 36.55), "Trabzon": (41.0, 39.72),
    "Tunceli": (39.11, 39.55), "Uşak": (38.68, 29.41), "Van": (38.5, 43.38), "Yalova": (40.66, 29.27), "Yozgat": (39.82, 34.81),
    "Zonguldak": (41.45, 31.79),
}
PROV_FOLD = {_fold(k): k for k in CENTERS}


def cfg() -> dict:
    return {"enabled": True, "minLevel": "orange", "intervalMin": 30, "duration": 25,
            "url": "https://feeds.meteoalarm.org/feeds/meteoalarm-legacy-atom-turkey", **(settings().get("weather") or {})}


def _tag(block: str, name: str) -> str:
    m = re.search(rf"<(?:cap:)?{name}\b[^>]*>(.*?)</(?:cap:)?{name}>", block, re.S | re.I)
    return html.unescape(re.sub(r"<!\[CDATA\[(.*?)\]\]>", r"\1", m.group(1), flags=re.S)).strip() if m else ""


def _province(area: str) -> str | None:
    """"Ankara", "ANKARA", "Ankara ili", "Istanbul" → il adı; bölge adlarında ilk eşleşen il."""
    for w in re.split(r"[\s,/;()-]+", area):
        hit = PROV_FOLD.get(_fold(w))
        if hit:
            return hit
    return None


def _type(raw: str) -> str:
    low = raw.lower()
    for k in ("high-temperature", "low-temperature", "thunder", "avalanche", "forest", "coastal", "flood", "snow", "ice", "wind", "fog", "rain"):
        if k in low:
            return k
    return "rain" if "yağış" in low else "wind" if "rüzgar" in low else "rain"


def _time(s: str) -> float | None:
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()
    except Exception:
        return None


def parse(xml: str) -> list:
    out = []
    for block in re.findall(r"<entry\b.*?</entry>", xml, re.S | re.I):
        lvl_raw = (_tag(block, "awareness_level") or _tag(block, "severity")).lower()
        level = next((k for k in LEVELS if k in lvl_raw), {"extreme": "red", "severe": "orange", "moderate": "yellow"}.get(lvl_raw.split(";")[-1].strip(), ""))
        prov = _province(_tag(block, "areaDesc"))
        if not level or not prov:
            continue
        out.append({"province": prov, "level": level, "type": _type(_tag(block, "awareness_type") or _tag(block, "event")),
                    "onset": _time(_tag(block, "onset") or _tag(block, "effective")), "expires": _time(_tag(block, "expires"))})
    return out


def fetch() -> list:
    req = urllib.request.Request(cfg()["url"], headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=25, context=CTX) as r:
        return parse(r.read(4 * 1024 * 1024).decode("utf-8", errors="replace"))


def when_tr(ts: float | None) -> str:
    if not ts:
        return ""
    d = datetime.fromtimestamp(ts, TR)
    today = datetime.now(TR).date()
    day = "bugün" if d.date() == today else "yarın" if d.date() == today + timedelta(days=1) else f"{d.day} {MONTHS[d.month - 1]} {DAYS[d.weekday()]}"
    return f"{day} saat {d.strftime('%H:%M')}"


def build_job(g: dict) -> str:
    provs = g["provinces"]
    lv, typ = LEVEL_TR[g["level"]], TYPE_TR.get(g["type"], "kuvvetli yağış")
    n = len(provs)
    listed = ", ".join(provs[:8]) + (f" ve {n - 8} il daha" if n > 8 else "")
    hook = f"{n} il için {lv} kod uyarısı." if n > 1 else f"{provs[0]} için {lv} kod uyarısı."
    until = when_tr(g.get("expires"))
    n1 = (f"Meteoroloji Genel Müdürlüğü {n} il için {typ} nedeniyle {lv} kod uyarısı yaptı. Uyarı kapsamındaki iller: {listed}."
          if n > 1 else f"Meteoroloji Genel Müdürlüğü {provs[0]} için {typ} nedeniyle {lv} kod uyarısı yaptı.")
    if until:
        n1 += f" Uyarı {until} itibarıyla sona erecek."
    n2 = ("Kırmızı kod en yüksek seviye. " if g["level"] == "red" else "") + \
         "Sel, su baskını, ulaşımda aksama gibi olumsuzluklara karşı dikkatli olun ve yetkililerin açıklamalarını takip edin."
    if g["type"] in ("wind", "coastal"):
        n2 = "Çatı uçması, ağaç devrilmesi ve ulaşımda aksamaya karşı dikkatli olun, yetkililerin açıklamalarını takip edin."
    elif g["type"] in ("snow", "ice", "avalanche", "low-temperature"):
        n2 = "Buzlanma ve don nedeniyle yolculuk öncesi yol durumunu öğrenin, zorunlu olmadıkça yola çıkmayın."
    elif g["type"] in ("high-temperature", "forest"):
        n2 = "Sıcak saatlerde güneşe çıkmayın, açık alanda ateş yakmayın ve yetkililerin uyarılarını takip edin."
    tag = re.sub(r"[^\wçğıöşü]", "", provs[0].replace("I", "ı").replace("İ", "i").lower())
    script = make_script(
        hook_title=f"{lv.upper()} KOD UYARISI", hook=hook,
        items=[{"title": f"{n} ile {lv} kod" if n > 1 else f"{provs[0]} {lv} kod", "narration": n1, "breaking": g["level"] == "red"},
               {"title": "Uyarıya dikkat", "narration": n2}],
        titles={"A": f"Meteoroloji'den {n} il için {lv} kod uyarısı" if n > 1 else f"{provs[0]} için {lv} kod uyarısı",
                "B": f"Dikkat: {typ} geliyor! İşte uyarı verilen iller", "cover": f"{lv.upper()} KOD"},
        hashtags=["#meteoroloji", f"#{tag}", f"#{lv}kod", "#havadurumu", "#uyarı"],
        importance=5 if g["level"] == "red" else 4, reason=f"{lv} kod meteoroloji uyarısı", source="Meteoroloji Genel Müdürlüğü", category="hava")
    card = {"kind": "weather", "label": f"{lv.upper()} KOD", "stamp": typ.upper(), "title": until and f"Bitiş: {until}",
            "weather": {"level": g["level"], "type": typ, "points": [{"name": p, "lat": CENTERS[p][0], "lon": CENTERS[p][1]} for p in provs]}}
    return str(new_job(f"meteo-{g['key']}", script, [card], {"group": g}))


def groups(items: list, min_level: str) -> list:
    now = time.time()
    by = {}
    for it in items:
        if LEVELS[it["level"]] < LEVELS.get(min_level, 3) or (it["expires"] and it["expires"] < now):
            continue
        k = (it["level"], it["type"])
        g = by.setdefault(k, {"level": it["level"], "type": it["type"], "provinces": [], "onset": it["onset"], "expires": it["expires"]})
        if it["province"] not in g["provinces"]:
            g["provinces"].append(it["province"])
        g["expires"] = max(filter(None, [g["expires"], it["expires"]]), default=None)
        g["onset"] = min(filter(None, [g["onset"], it["onset"]]), default=None)
    out = sorted(by.values(), key=lambda g: (-LEVELS[g["level"]], -len(g["provinces"])))
    for g in out:
        day = datetime.fromtimestamp(g["onset"] or now, TR).strftime("%Y%m%d")
        g["key"] = f"{day}-{g['type']}-{g['level']}"
    return out


def check() -> dict:
    c = cfg()
    try:
        items = fetch()
    except Exception as e:
        return {"ok": False, "errors": [f"Meteoalarm: {str(e)[:100]}"], "warnings": []}
    seen = {k: v for k, v in (load_json(SEEN, {}) or {}).items() if time.time() - float(v) < 5 * 86400}
    out = []
    for g in groups(items, c["minLevel"]):
        base = g["key"].rsplit("-", 1)[0]
        if g["key"] in seen or (g["level"] == "orange" and f"{base}-red" in seen):
            continue
        seen[g["key"]] = time.time()
        g["job"] = build_job(g)
        g["title"] = f"{len(g['provinces'])} il için {LEVEL_TR[g['level']]} kod uyarısı ({TYPE_TR.get(g['type'], '')})"
        out.append(g)
        break  # bir taramada bir video (en şiddetli grup)
    save_json(SEEN, seen)
    return {"ok": True, "warnings": out, "errors": [], "active": len(items)}


if __name__ == "__main__":
    try:
        if "--check" in sys.argv:
            res = check()
        elif "--test" in sys.argv:
            g = {"level": "orange", "type": "rain", "provinces": ["İstanbul", "Kocaeli", "Sakarya", "Düzce", "Zonguldak", "Bartın"],
                 "onset": time.time(), "expires": time.time() + 20 * 3600, "key": f"test-{int(time.time())}"}
            res = {"ok": True, "warnings": [{**g, "job": build_job(g)}]}
        else:
            res = {"ok": False, "error": "kullanım: --check | --test"}
    except Exception as ex:
        res = {"ok": False, "error": str(ex)[:300]}
    print(json.dumps(res, ensure_ascii=False))
