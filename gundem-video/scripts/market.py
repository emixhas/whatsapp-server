#!/usr/bin/env python3
"""Sabah piyasa kartı (kullanıcı kararı: her sabah dolar, euro, gram altın, benzin ve motorin; dünle karşılaştırmalı).

Kaynaklar (sırayla, ulaşılamayan atlanır; hangisi düştüyse loga yazılır):
  - Döviz ve altın: Truncgil Finans (finans.truncgil.com v4, olmazsa eski today.json), olmazsa TCMB günlük kurları
    (yalnız dolar ve euro; tcmb.gov.tr/kurlar/today.xml).
  - Akaryakıt: `settings.market.fuelUrl` (varsayılan Opet'in il fiyatları servisi, `fuelProvince` 34 İstanbul).
Değişim kaynakta yoksa dünkü kayıttan hesaplanır (`data/market_history.json`, 30 gün). Akaryakıtta dünkü fiyattan fark
varsa "zam/indirim geldi" cümlesi eklenir. Senaryo şablondan yazılır (Claude yok), görsel piyasa tablosu kartı.

  python3 scripts/market.py --job     # bugünün piyasa videosu için iş klasörü (panel settings.market.hour'da)
  python3 scripts/market.py --show    # yalnız verileri yazdır
  python3 scripts/market.py --alarm   # akaryakıt fiyat değişimi / dolar-euro-altın rekoru varsa iş klasörü (panel 20 dk'da bir)

Alarm (kullanıcı kararı: zam ve rekor anında video):
  - Akaryakıt: son görülen fiyattan (`data/fuel_last.json`) ≥ 10 kuruş fark → "Benzine X zam/indirim geldi" videosu. Fiyatlar
    gece yarısı değişir; 07:00-22:00 arasında bakılır ki video sabah izlenirken yayında olsun. İlk çalıştırma yalnız kaydeder.
  - Rekor: dolar, euro, gram altın tüm zamanların en yükseğini geçip yeni bir eşiği aşınca (`recordSteps` {usd 1, eur 1, gram
    250} lira: "Dolar ilk kez 42 lirayı aştı") video; varlık başına günde en çok bir. Tüm zamanların en yükseği Yahoo Finance
    aylık verisinden bir kez tohumlanır (`data/market_records.json`; altın: ons × dolar en yüksekleri / 31,1035, temkinli
    yüksek). Tohumlanamazsa yanlış "rekor" demeyelim diye o varlıkta rekor videosu 365 günlük kendi kaydı birikene kadar yapılmaz.
"""
import json
import re
import ssl
import sys
import time
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import DATA, load_json, save_json, settings  # noqa: E402
from info_card import make_script, new_job, num_tr, tr_date  # noqa: E402

try:
    import certifi
    CTX = ssl.create_default_context(cafile=certifi.where())
except ImportError:
    CTX = ssl.create_default_context()

HIST = DATA / "market_history.json"
FUEL_LAST = DATA / "fuel_last.json"
RECORDS = DATA / "market_records.json"
NAMES = {"usd": "Dolar", "eur": "Euro", "gram": "Gram altın"}


def cfg() -> dict:
    return {"enabled": True, "hour": 9, "minute": 0, "duration": 35, "fuelProvince": 34, "alarm": True, "fuelMinDiff": 0.10,
            "recordSteps": {"usd": 1, "eur": 1, "gram": 250}, "fuelFrom": 7, "fuelTo": 22,
            "fuelUrl": "https://api.opet.com.tr/api/fuelprices/prices?ProvinceCode={province}&IncludeAllProducts=true",
            **(settings().get("market") or {})}


def _get(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0", "Accept": "application/json,text/xml,*/*"})
    with urllib.request.urlopen(req, timeout=20, context=CTX) as r:
        return r.read(2 * 1024 * 1024)


def _num(v) -> float | None:
    """"41,8500" / "41.85" / "%0,12" / "1.234,56" / 41.85 → float."""
    if v is None:
        return None
    if isinstance(v, (int, float)):
        return float(v)
    t = str(v).strip().replace("%", "").replace("₺", "").replace(" ", "")
    if "," in t:
        t = t.replace(".", "").replace(",", ".")
    try:
        return float(t)
    except ValueError:
        return None


def truncgil() -> dict:
    out = {}
    for url in ("https://finans.truncgil.com/v4/today.json", "https://finans.truncgil.com/today.json"):
        try:
            d = json.loads(_get(url).decode("utf-8"))
        except Exception:
            continue
        for key, names in (("usd", ("USD",)), ("eur", ("EUR",)), ("gram", ("GRA", "gram-altin", "Gram Altın")), ("ceyrek", ("CEY", "ceyrek-altin", "Çeyrek Altın"))):
            for n in names:
                x = d.get(n)
                if isinstance(x, dict):
                    price = _num(x.get("Selling") or x.get("Satış") or x.get("selling"))
                    if price:
                        out[key] = {"price": price, "change": _num(x.get("Change") if "Change" in x else x.get("Değişim"))}
                        break
        if out:
            out["_source"] = "Truncgil Finans"
            return out
    return out


def tcmb() -> dict:
    xml = _get("https://www.tcmb.gov.tr/kurlar/today.xml").decode("utf-8", errors="replace")
    out = {}
    for code, key in (("USD", "usd"), ("EUR", "eur")):
        m = re.search(rf'CurrencyCode="{code}".*?<ForexSelling>([\d.]+)</ForexSelling>', xml, re.S)
        if m:
            out[key] = {"price": float(m.group(1)), "change": None}
    if out:
        out["_source"] = "Merkez Bankası"
    return out


def fuel(c: dict) -> dict:
    data = json.loads(_get(c["fuelUrl"].format(province=c["fuelProvince"])).decode("utf-8"))
    found = {}

    def walk(x):
        if isinstance(x, dict):
            name = str(x.get("productName") or x.get("ProductName") or x.get("name") or "").lower()
            amount = _num(x.get("amount") or x.get("Amount") or x.get("price") or x.get("Price"))
            if amount and 10 < amount < 500:
                if "benzin" in name and "benzin" not in found:
                    found["benzin"] = {"price": amount, "change": None}
                elif "motorin" in name and "motorin" not in found:
                    found["motorin"] = {"price": amount, "change": None}
            for v in x.values():
                walk(v)
        elif isinstance(x, list):
            for v in x:
                walk(v)
    walk(data)
    return found


def collect() -> tuple:
    c = cfg()
    vals, errors, sources = {}, [], []
    for name, fn in (("döviz/altın", truncgil), ("TCMB", tcmb)):
        if all(k in vals for k in ("usd", "eur")):
            break
        try:
            got = fn()
            if got.get("_source"):
                sources.append(got.pop("_source"))
            for k, v in got.items():
                vals.setdefault(k, v)
            if not got:
                errors.append(f"{name}: veri yok")
        except Exception as e:
            errors.append(f"{name}: {str(e)[:80]}")
    try:
        f = fuel(c)
        vals.update(f)
        if f:
            sources.append("Opet")
        else:
            errors.append("akaryakıt: veri yok")
    except Exception as e:
        errors.append(f"akaryakıt: {str(e)[:80]}")
    # değişim kaynakta yoksa dünkü kayıttan; bugünün değerleri kaydedilir
    hist = load_json(HIST, {}) or {}
    today = time.strftime("%Y-%m-%d")
    prev_day = max((d for d in hist if d < today), default=None)
    prev = hist.get(prev_day, {}) if prev_day else {}
    for k, v in vals.items():
        old = prev.get(k)
        if v.get("change") is None and old:
            v["change"] = round((v["price"] - old) / old * 100, 2)
        v["diff"] = round(v["price"] - old, 2) if old else None
    if vals:
        hist[today] = {k: v["price"] for k, v in vals.items()}
        hist = {d: hist[d] for d in sorted(hist)[-30:]}
        save_json(HIST, hist)
    return vals, errors, sources


def lira(x: float) -> str:
    """41.85 → "41 lira 85 kuruş" (seslendirmede doğal)."""
    tl, kr = int(x), int(round((x - int(x)) * 100))
    if kr == 100:
        tl, kr = tl + 1, 0
    return f"{tl} lira" + (f" {kr} kuruş" if kr else "")


def lira_from(x: float) -> str:
    """Ayrılma ekiyle: "41 lira 85 kuruştan", "42 liradan"."""
    t = lira(x)
    return t + ("tan" if t.endswith("kuruş") else "dan")


def move(ch: float | None) -> str:
    if ch is None or abs(ch) < 0.05:
        return "yatay seyretti"
    return f"yüzde {num_tr(abs(ch), 2)} {'yükseldi' if ch > 0 else 'düştü'}"


def build_job(vals: dict, sources: list) -> str | None:
    if "usd" not in vals:
        return None
    usd, eur, gram = vals.get("usd"), vals.get("eur"), vals.get("gram")
    # kanca: en çok hareket eden (dolar, euro, altın); hepsi sakinse dolarla açılır
    movers = [(abs(v["change"] or 0), n, v) for n, v in (("Dolar", usd), ("Euro", eur), ("Gram altın", gram)) if v and v.get("change") is not None]
    movers.sort(key=lambda x: -x[0])
    if movers and movers[0][0] >= 0.5:
        _, n, v = movers[0]
        hook_title = f"{n.split()[-1].upper()} {'YÜKSELDİ' if v['change'] > 0 else 'DÜŞTÜ'}"
        hook = f"{n} yüzde {num_tr(abs(v['change']), 2)} {'yükseldi' if v['change'] > 0 else 'düştü'}."
    else:
        hook_title, hook = "PİYASALARDA BUGÜN", f"Dolar {lira_from(usd['price'])} güne başladı."
    items = []
    t = f"Dolar {lira_from(usd['price'])} işlem görüyor" + (f", euro {lira_from(eur['price'])}" if eur else "") + ". "
    t += f"Dolar dünden bu yana {move(usd.get('change'))}" + (f", euro {move(eur.get('change'))}" if eur else "") + "."
    items.append({"title": "Dolar ve euro", "narration": t, "category": "finans"})
    if gram:
        thousands = lambda x: f"{int(round(x)):,}".replace(",", ".")  # noqa: E731
        g = f"Gram altın {thousands(gram['price'])} liradan satılıyor ve dünkü fiyata göre {move(gram.get('change'))}."
        if vals.get("ceyrek"):
            g += f" Çeyrek altın {thousands(vals['ceyrek']['price'])} lira."
        items.append({"title": "Altın fiyatları", "narration": g, "category": "finans"})
    if vals.get("benzin") or vals.get("motorin"):
        b, m = vals.get("benzin"), vals.get("motorin")
        city = {34: "İstanbul'da", 6: "Ankara'da", 35: "İzmir'de"}.get(int(cfg()["fuelProvince"]), "")
        f = f"{city} benzinin litresi {lira(b['price'])}" if b else ""
        f += (", motorinin litresi " if b else f"{city} motorinin litresi ") + lira(m["price"]) if m else ""
        f += "."
        for nm, v in (("benzine", b), ("motorine", m)):
            if v and v.get("diff") and abs(v["diff"]) >= 0.05:
                f += f" Dünden bu yana {nm} {lira(abs(v['diff']))} {'zam' if v['diff'] > 0 else 'indirim'} geldi."
        items.append({"title": "Akaryakıt fiyatları", "narration": f.strip(), "category": "finans"})
    day = tr_date(weekday=True)
    rows = [{"name": n, "value": (f"{num_tr(v['price'], 2)} ₺" if v["price"] < 1000 else f"{int(round(v['price'])):,} ₺".replace(",", ".")), "change": v.get("change")}
            for n, v in (("Dolar", usd), ("Euro", eur), ("Gram altın", gram), ("Benzin", vals.get("benzin")), ("Motorin", vals.get("motorin"))) if v]
    script = make_script(
        hook_title=hook_title, hook=hook, items=items,
        titles={"A": f"Dolar, euro, altın ve akaryakıt: {day} piyasalar", "B": hook.rstrip(".") + f" | {day}", "cover": hook_title},
        hashtags=["#dolar", "#altın", "#akaryakıt", "#piyasa", "#ekonomi"],
        importance=3, reason="günlük piyasa özeti", source=" · ".join(dict.fromkeys(sources)) or "Piyasa verisi", category="finans", expires=time.time() + 2 * 86400)
    card = {"kind": "market", "label": "PİYASALAR", "stamp": tr_date(), "rows": rows}
    return str(new_job(f"piyasa-{time.strftime('%Y%m%d')}", script, [card], {"values": vals}))


def _yahoo_max(symbol: str) -> list:
    """Aylık en yüksekler [(zaman, değer)] (Yahoo Finance grafik verisi)."""
    d = json.loads(_get(f"https://query1.finance.yahoo.com/v8/finance/chart/{symbol}?range=max&interval=1mo").decode("utf-8"))
    r = d["chart"]["result"][0]
    return [(t, h) for t, h in zip(r.get("timestamp") or [], r["indicators"]["quote"][0].get("high") or []) if h]


def seed_records(rec: dict, vals: dict) -> list:
    """Tüm zamanların en yükseğini bir kez tohumla; olmazsa kendi kaydından başla (rekor videosu kapalı)."""
    errors = []
    try_hi = None
    for key, sym in (("usd", "TRY=X"), ("eur", "EURTRY=X"), ("gram", None)):
        if key in rec or key not in vals:
            continue
        try:
            if key == "gram":
                try_hi = try_hi or dict(_yahoo_max("TRY=X"))
                gold = _yahoo_max("GC=F")
                hi = max(h * try_hi[t] / 31.1035 for t, h in gold if t in try_hi)
            else:
                rows = _yahoo_max(sym)
                if sym == "TRY=X":
                    try_hi = dict(rows)
                hi = max(h for _, h in rows)
            rec[key] = {"max": max(hi, vals[key]["price"]), "seeded": "yahoo", "since": time.time()}
        except Exception as e:
            errors.append(f"{NAMES[key]} geçmiş en yüksek alınamadı: {str(e)[:60]}")
            rec[key] = {"max": vals[key]["price"], "seeded": "self", "since": time.time()}
    return errors


def alarm() -> dict:
    c = cfg()
    jobs, errors = [], []
    hour = int(time.strftime("%H"))
    # akaryakıt fiyat değişimi
    if int(c["fuelFrom"]) <= hour < int(c["fuelTo"]):
        try:
            f = fuel(c)
            last = load_json(FUEL_LAST, {}) or {}
            changes = {k: round(v["price"] - last[k], 2) for k, v in f.items() if k in last and abs(v["price"] - last[k]) >= float(c["fuelMinDiff"])}
            if f:
                save_json(FUEL_LAST, {**{k: v["price"] for k, v in f.items()}, "at": time.time()})
            if changes:
                jobs.append(fuel_job(f, changes, c))
        except Exception as e:
            errors.append(f"akaryakıt: {str(e)[:80]}")
    # dolar / euro / gram altın rekoru
    vals, sources = {}, []
    for fn in (truncgil, tcmb):
        try:
            got = fn()
            if got.get("_source"):
                sources.append(got.pop("_source"))
            for k, v in got.items():
                vals.setdefault(k, v)
        except Exception as e:
            errors.append(f"kur: {str(e)[:60]}")
        if all(k in vals for k in ("usd", "eur", "gram")):
            break
    rec = load_json(RECORDS, {}) or {}
    errors += seed_records(rec, vals)
    today = time.strftime("%Y-%m-%d")
    for key in ("usd", "eur", "gram"):
        v, r = vals.get(key), rec.get(key)
        if not v or not r:
            continue
        old, new = float(r["max"]), v["price"]
        if new <= old:
            continue
        r["max"] = new
        step = float(c["recordSteps"].get(key, 1))
        trusted = r.get("seeded") == "yahoo" or time.time() - float(r.get("since") or time.time()) > 365 * 86400
        crossed = int(new // step) > int(old // step)
        if trusted and crossed and r.get("videoDay") != today:
            r["videoDay"] = today
            jobs.append(record_job(key, new, int(new // step) * step, vals, sources))
    save_json(RECORDS, rec)
    return {"ok": True, "jobs": [j for j in jobs if j], "errors": errors}


def fuel_job(f: dict, changes: dict, c: dict) -> str:
    city_name = {34: "İstanbul", 6: "Ankara", 35: "İzmir"}.get(int(c["fuelProvince"]), "")
    city = {34: "İstanbul'da", 6: "Ankara'da", 35: "İzmir'de"}.get(int(c["fuelProvince"]), "")
    names = {"benzin": "benzine", "motorin": "motorine"}
    ups = [k for k, d in changes.items() if d > 0]
    downs = [k for k, d in changes.items() if d < 0]
    parts = []
    for grp, word in ((ups, "zam"), (downs, "indirim")):
        if grp:
            same = len(grp) == 2 and abs(changes[grp[0]]) == abs(changes[grp[1]])
            if same:
                parts.append(f"Benzin ve motorine {lira(abs(changes[grp[0]]))} {word} geldi.")
            else:
                parts += [f"{names[k].capitalize()} {lira(abs(changes[k]))} {word} geldi." for k in grp]
    word = "ZAM" if ups and not downs else "İNDİRİM" if downs and not ups else "FİYAT DEĞİŞTİ"
    who_tr = "Benzine" if list(changes) == ["benzin"] else "Motorine" if list(changes) == ["motorin"] else "Akaryakıta"
    who = {"Benzine": "BENZİNE", "Motorine": "MOTORİNE", "Akaryakıta": "AKARYAKITA"}[who_tr]
    word_tr = {"ZAM": "zam", "İNDİRİM": "indirim", "FİYAT DEĞİŞTİ": "fiyat değişikliği"}
    prices = ", ".join(f"{k}in litresi {lira(f[k]['price'])}" for k in ("benzin", "motorin") if k in f)
    n1 = " ".join(parts) + f" Yeni fiyatlarla {city} {prices} oldu."
    rows = [{"name": k.capitalize(), "value": f"{num_tr(f[k]['price'], 2)} ₺", "change": round(changes.get(k, 0) / (f[k]["price"] - changes.get(k, 0)) * 100, 2)} for k in ("benzin", "motorin") if k in f]
    script = make_script(hook_title=f"{who} {word}", hook=parts[0], items=[{"title": f"{who_tr} {word_tr[word]}", "narration": n1, "category": "finans"}],
                         titles={"A": parts[0].rstrip(".") + (f" | {city_name} güncel akaryakıt fiyatları" if city_name else " | Güncel akaryakıt fiyatları"), "B": f"{who_tr} {word_tr[word]}! İşte yeni fiyatlar", "cover": f"{who} {word}"},
                         hashtags=["#akaryakıt", "#benzin", "#motorin", "#zam" if ups else "#indirim"], importance=4, reason="akaryakıt fiyat değişimi",
                         source="Opet", category="finans", expires=time.time() + 2 * 86400)
    return str(new_job(f"akaryakit-{time.strftime('%Y%m%d%H')}", script, [{"kind": "market", "label": f"{who} {word}", "stamp": tr_date(), "rows": rows}],
                       {"changes": changes}))


def record_job(key: str, price: float, level: float, vals: dict, sources: list) -> str:
    name = NAMES[key]
    lvl = f"{int(level):,}".replace(",", ".")
    hook = f"{name} rekor kırdı."
    n1 = f"{name} ilk kez {lvl} liranın üzerine çıktı ve {lira_from(price)} işlem görüyor."
    ch = vals[key].get("change")
    if ch is not None:
        n1 += f" Dünden bu yana {move(ch)}."
    rows = [{"name": NAMES[k], "value": (f"{num_tr(v['price'], 2)} ₺" if v["price"] < 1000 else f"{int(round(v['price'])):,} ₺".replace(",", ".")), "change": v.get("change")}
            for k, v in vals.items() if k in NAMES]
    script = make_script(hook_title=f"{name.split()[-1].upper()} REKOR KIRDI", hook=hook, items=[{"title": f"{name} {lvl} lirayı aştı", "narration": n1, "category": "finans", "breaking": True}],
                         titles={"A": f"{name} ilk kez {lvl} lirayı aştı", "B": f"{name} rekor kırdı! İşte son durum", "cover": f"{name.split()[-1].upper()} REKOR"},
                         hashtags=["#dolar" if key == "usd" else "#euro" if key == "eur" else "#altın", "#rekor", "#piyasa", "#ekonomi"],
                         importance=4, reason=f"{name} rekor", source=" · ".join(sources) or "Piyasa verisi", category="finans",
                         expires=time.time() + 2 * 86400)
    return str(new_job(f"rekor-{key}-{time.strftime('%Y%m%d')}", script, [{"kind": "market", "label": "REKOR", "stamp": tr_date(), "rows": rows}],
                       {"asset": key, "price": price}))


if __name__ == "__main__":
    try:
        if "--alarm" in sys.argv:
            print(json.dumps(alarm(), ensure_ascii=False))
            sys.exit(0)
        vals, errors, sources = collect()
        if "--job" in sys.argv:
            job = build_job(vals, sources)
            res = {"ok": bool(job), "job": job, "errors": errors, "sources": sources, "values": vals,
                   **({} if job else {"error": "döviz verisi alınamadı: " + "; ".join(errors)})}
        else:
            res = {"ok": True, "values": vals, "errors": errors, "sources": sources}
    except Exception as ex:
        res = {"ok": False, "error": str(ex)[:300]}
    print(json.dumps(res, ensure_ascii=False))
