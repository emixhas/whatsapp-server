#!/usr/bin/env python3
"""Deprem takibi (kullanıcı kararı: büyük deprem olunca dakikalar içinde video).

AFAD deprem servisi (deprem.afad.gov.tr apiv2), ulaşılamazsa Kandilli Rasathanesi son depremler listesi. Türkiye ve
yakın çevresinde (enlem 35-43, boylam 25-45,5) `settings.quake.minMag` (4,5) ve üstü, `maxAgeMin` (45) dakikadan yeni
deprem → şablon senaryo (Claude çağrılmaz, yalnız ölçülen veri) + deprem haritası kartı (`info_card.py`). Aynı deprem iki
kaynaktan gelirse (3 dk ve ~60 km içinde) tek sayılır; görülenler `data/quake_seen.json`.

  python3 scripts/quake_watch.py --check     # yeni deprem varsa iş klasörünü hazırlar, JSON yazar (panel 2 dk'da bir)
  python3 scripts/quake_watch.py --last      # son depremler (panel kartı)
  python3 scripts/quake_watch.py --test 5.1  # sahte depremle iş klasörü (deneme)
"""
import json
import math
import re
import ssl
import sys
import time
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import DATA, load_json, save_json, settings  # noqa: E402
from info_card import make_script, new_job, num_tr  # noqa: E402

try:
    import certifi
    CTX = ssl.create_default_context(cafile=certifi.where())
except ImportError:
    CTX = ssl.create_default_context()

SEEN = DATA / "quake_seen.json"
TR = timezone(timedelta(hours=3))
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36"


def cfg() -> dict:
    return {"enabled": True, "minMag": 4.5, "maxAgeMin": 45, "intervalMin": 2, "maxPerDay": 6, "duration": 25, **(settings().get("quake") or {})}


def _get(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json,text/html,*/*"})
    with urllib.request.urlopen(req, timeout=20, context=CTX) as r:
        return r.read(3 * 1024 * 1024)


PROVINCES = ("Adana Adıyaman Afyonkarahisar Ağrı Aksaray Amasya Ankara Antalya Ardahan Artvin Aydın Balıkesir Bartın Batman Bayburt "
             "Bilecik Bingöl Bitlis Bolu Burdur Bursa Çanakkale Çankırı Çorum Denizli Diyarbakır Düzce Edirne Elazığ Erzincan Erzurum "
             "Eskişehir Gaziantep Giresun Gümüşhane Hakkari Hatay Iğdır Isparta İstanbul İzmir Kahramanmaraş Karabük Karaman Kars "
             "Kastamonu Kayseri Kilis Kırıkkale Kırklareli Kırşehir Kocaeli Konya Kütahya Malatya Manisa Mardin Mersin Muğla Muş "
             "Nevşehir Niğde Ordu Osmaniye Rize Sakarya Samsun Şanlıurfa Siirt Sinop Sivas Şırnak Tekirdağ Tokat Trabzon Tunceli Uşak "
             "Van Yalova Yozgat Zonguldak Ege Akdeniz Karadeniz Marmara Denizi Körfezi Açıkları").split()


def _fold(w: str) -> str:
    return w.translate(str.maketrans("çğıöşüÇĞİÖŞÜI", "cgiosuCGIOSUI")).lower()


FIX = {_fold(w): w for w in PROVINCES}


def title_case(t: str, ascii_src: bool = False) -> str:
    """"KAHRAMANMARAŞ" → "Kahramanmaraş"; Kandilli'nin ASCII yazımı ("ELBISTAN (KAHRAMANMARAS)", "EGE DENIZI") il ve deniz
    adlarında Türkçe harfe çevrilir (ilçe adları ASCII kalabilir: "I" → "i")."""
    def cap(m):
        w = m.group(0)
        if _fold(w) in FIX:
            return FIX[_fold(w)]
        low = w.lower() if ascii_src else w.replace("I", "ı").replace("İ", "i").lower()
        return low[:1].replace("i", "İ").upper() + low[1:]
    return re.sub(r"[^\W\d_]+", cap, (t or "").strip())


def afad(hours: int = 6) -> list:
    end = datetime.now(timezone.utc)
    start = end - timedelta(hours=hours)
    url = ("https://deprem.afad.gov.tr/apiv2/event/filter?start=" + start.strftime("%Y-%m-%dT%H:%M:%S") + "&end=" + end.strftime("%Y-%m-%dT%H:%M:%S")
           + "&minmag=3&orderby=timedesc&format=json")
    data = json.loads(_get(url).decode("utf-8"))
    out = []
    for e in data if isinstance(data, list) else data.get("result") or []:
        try:
            t = datetime.fromisoformat(str(e["date"]).replace("Z", "")[:19]).replace(tzinfo=timezone.utc)
            if t.timestamp() - time.time() > 600:  # saat yerel yazılmışsa (gelecekte görünür) Türkiye saati say
                t = t.replace(tzinfo=TR)
            prov, dist = title_case(e.get("province") or ""), title_case(e.get("district") or "")
            out.append({"id": f"afad-{e.get('eventID')}", "ts": t.timestamp(), "mag": round(float(e["magnitude"]), 1),
                        "lat": float(e["latitude"]), "lon": float(e["longitude"]), "depth": round(float(e.get("depth") or 0), 1),
                        "province": prov, "district": dist if dist and dist != prov else "",
                        "location": title_case(e.get("location") or ""), "source": "AFAD"})
        except Exception:
            continue
    return out


KANDILLI_RE = re.compile(r"^(\d{4})\.(\d{2})\.(\d{2})\s+(\d{2}):(\d{2}):(\d{2})\s+(-?[\d.]+)\s+(-?[\d.]+)\s+([\d.]+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(.+?)\s{2,}", re.M)


def kandilli() -> list:
    raw = _get("http://www.koeri.boun.edu.tr/scripts/lst0.asp")
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        text = raw.decode("cp1254", errors="replace")
    out = []
    for m in KANDILLI_RE.finditer(text):
        y, mo, d, h, mi, s, lat, lon, depth, md, ml, mw, place = m.groups()
        mags = [float(x) for x in (mw, ml, md) if re.match(r"^\d+(\.\d+)?$", x)]
        if not mags:
            continue
        t = datetime(int(y), int(mo), int(d), int(h), int(mi), int(s), tzinfo=TR)
        # "ELBISTAN (KAHRAMANMARAS)" → ilçe + il; "EGE DENIZI" → yer
        pm = re.match(r"(.+?)-?\s*\((.+)\)", place.strip())
        dist, prov = (title_case(pm.group(1).split("-")[-1], True), title_case(pm.group(2), True)) if pm else ("", "")
        out.append({"id": f"koeri-{y}{mo}{d}{h}{mi}{s}", "ts": t.timestamp(), "mag": round(mags[0], 1), "lat": float(lat), "lon": float(lon),
                    "depth": round(float(depth), 1), "province": prov, "district": dist if dist != prov else "",
                    "location": title_case(place.strip(), True), "source": "Kandilli Rasathanesi"})
    return out


def km(a: dict, b: dict) -> float:
    la1, la2 = math.radians(a["lat"]), math.radians(b["lat"])
    dla, dlo = la2 - la1, math.radians(b["lon"] - a["lon"])
    h = math.sin(dla / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin(dlo / 2) ** 2
    return 6371 * 2 * math.asin(math.sqrt(h))


def same(a: dict, b: dict) -> bool:
    return abs(a["ts"] - b["ts"]) < 180 and km(a, b) < 60


def recent() -> tuple:
    events, errors = [], []
    for name, fn in (("AFAD", afad), ("Kandilli", kandilli)):
        try:
            got = fn()
        except Exception as e:
            errors.append(f"{name}: {str(e)[:100]}")
            continue
        for e in got:  # AFAD önce gelir; Kandilli yalnız AFAD'da olmayanı ekler
            if not any(same(e, x) for x in events):
                events.append(e)
    events = [e for e in events if 35 <= e["lat"] <= 43 and 25 <= e["lon"] <= 45.5]
    events.sort(key=lambda e: -e["ts"])
    return events, errors


def loc(word: str) -> str:
    """Bulunma eki: Elbistan'da, Malatya'da, Kahramanmaraş'ta, İzmir'de, Ege Denizi'nde."""
    w = word.strip()
    if not w:
        return w
    low = w.replace("I", "ı").replace("İ", "i").lower()
    if low.endswith(("denizi", "körfezi", "açıkları")):
        return w + "'nde"
    vowel = next((c for c in reversed(low) if c in "aeıioöuü"), "a")
    a = "a" if vowel in "aıou" else "e"
    d = "t" if low[-1] in "fstkçşhp" else "d"
    return f"{w}'{d}{a}"


def place_name(e: dict) -> str:
    if e.get("province") and e.get("district"):
        return f"{e['province']} {e['district']}"
    return e.get("province") or e.get("location") or "Türkiye"


def build_job(e: dict) -> str:
    mag = num_tr(e["mag"])
    lt = datetime.fromtimestamp(e["ts"], TR)
    hhmm = lt.strftime("%H:%M")
    prov, dist = e.get("province") or "", e.get("district") or ""
    if prov and dist:
        where_long = f"{prov} ilinin {dist} ilçesinde"
    elif prov:
        where_long = loc(prov)
    else:
        where_long = loc(e.get("location") or "Türkiye yakınlarında")
    head_place = dist or prov or e.get("location") or "Türkiye"
    hook = f"{loc(head_place)} {mag} büyüklüğünde deprem."
    n1 = (f"{e['source']} verilerine göre saat {hhmm} sularında {where_long} {mag} büyüklüğünde bir deprem meydana geldi. "
          f"Depremin derinliği {num_tr(e['depth'])} kilometre olarak ölçüldü.")
    n2 = ("Uzmanlar artçı depremlere karşı hasar gören binalara girilmemesini ve yalnızca resmi açıklamaların takip edilmesini öneriyor. "
          "Gelişmeleri aktarmaya devam edeceğiz.")
    if e["mag"] >= 6:
        n2 = ("Büyük bir deprem. Bölgedekilerin hasarlı binalara girmemesi, açık alanda kalması ve AFAD ile valiliğin "
              "açıklamalarını takip etmesi gerekiyor. Gelişmeleri aktarmaya devam edeceğiz.")
    city_tag = re.sub(r"[^\wçğıöşü]", "", (prov or head_place).replace("I", "ı").replace("İ", "i").lower())
    script = make_script(
        hook_title=f"{mag} DEPREM", hook=hook,
        items=[{"title": f"{head_place} {mag} deprem", "narration": n1, "breaking": True},
               {"title": "Artçılara dikkat", "narration": n2}],
        titles={"A": f"{loc(prov or head_place)} {mag} büyüklüğünde deprem", "B": f"Son dakika: {loc(head_place)} {mag} deprem",
                "cover": f"{mag} DEPREM"},
        hashtags=["#deprem", f"#{city_tag}deprem" if city_tag else "#deprem", "#afad", "#sondakika"],
        importance=5 if e["mag"] >= 5 else 4, reason=f"{mag} büyüklüğünde deprem", source=e["source"], category="hava")
    card = {"kind": "quake", "label": "DEPREM", "stamp": hhmm,
            "quake": {"mag": e["mag"], "lat": e["lat"], "lon": e["lon"], "place": place_name(e), "time": hhmm, "depth": e["depth"], "source": e["source"]}}
    d = new_job(f"deprem-{e['id']}", script, [card], {"event": e})
    return str(d)


def check() -> dict:
    c = cfg()
    events, errors = recent()
    seen = load_json(SEEN, {}) or {}
    seen = {k: v for k, v in seen.items() if time.time() - float(v.get("at", 0)) < 3 * 86400}
    day = time.strftime("%Y-%m-%d")
    today = sum(1 for v in seen.values() if v.get("day") == day and v.get("produced"))
    out = []
    for e in events:
        if e["id"] in seen or any(same(e, v["e"]) for v in seen.values() if v.get("e")):
            continue
        fresh = time.time() - e["ts"] <= float(c["maxAgeMin"]) * 60
        big = e["mag"] >= float(c["minMag"])
        rec = {"at": time.time(), "day": day, "e": e}
        if fresh and big and today < int(c["maxPerDay"]):
            e["job"] = build_job(e)
            e["title"] = f"{loc(e.get('district') or e.get('province') or e.get('location') or 'Türkiye')} {num_tr(e['mag'])} büyüklüğünde deprem"
            e["topic"] = f"{e['source']}: {e['location'] or place_name(e)} {num_tr(e['mag'])} büyüklüğünde deprem, derinlik {num_tr(e['depth'])} km"
            rec["produced"] = True
            today += 1
            out.append(e)
        seen[e["id"]] = rec
    save_json(SEEN, seen)
    out.sort(key=lambda e: -e["mag"])
    return {"ok": True, "events": out, "errors": errors, "checked": len(events)}


if __name__ == "__main__":
    try:
        if "--check" in sys.argv:
            res = check()
        elif "--last" in sys.argv:
            ev, err = recent()
            res = {"ok": True, "events": [e for e in ev if e["mag"] >= 3][:10], "errors": err}
        elif "--test" in sys.argv:
            mag = float(sys.argv[sys.argv.index("--test") + 1]) if len(sys.argv) > sys.argv.index("--test") + 1 else 4.8
            e = {"id": f"test-{int(time.time())}", "ts": time.time() - 120, "mag": mag, "lat": 38.21, "lon": 37.2, "depth": 7.2,
                 "province": "Kahramanmaraş", "district": "Elbistan", "location": "Elbistan (Kahramanmaraş)", "source": "AFAD"}
            res = {"ok": True, "events": [{**e, "job": build_job(e)}]}
        else:
            res = {"ok": False, "error": "kullanım: --check | --last | --test [büyüklük]"}
    except Exception as ex:
        res = {"ok": False, "error": str(ex)[:300]}
    print(json.dumps(res, ensure_ascii=False))
