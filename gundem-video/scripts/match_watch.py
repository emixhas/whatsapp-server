#!/usr/bin/env python3
"""Maç sonu skor videosu (kullanıcı kararı: Süper Lig ilk 5 takımın maçı bitince otomatik video).

ESPN'in açık skor verisi (site.api.espn.com scoreboard): `settings.match.leagues` (Süper Lig `tur.1`, Şampiyonlar Ligi,
Avrupa Ligi, Konferans Ligi). Süper Lig'de puan durumunun ilk N (`standings.cached_top`) takımından biri oynadıysa, Avrupa
kupalarında herhangi bir Türk takımı oynadıysa ve maç son `maxAgeHours` (8) saat içinde BİTTİYSE → şablon senaryo (skor,
golcüler, dakikalar, Süper Lig'de güncel sıra ve puan; Claude çağrılmaz) + skor kartı. Görülen maçlar `data/match_seen.json`.

  python3 scripts/match_watch.py --check   # biten yeni maç varsa iş klasörünü hazırlar (panel 10 dk'da bir)
  python3 scripts/match_watch.py --test    # örnek maçla iş klasörü (deneme)
"""
import json
import re
import ssl
import sys
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import DATA, load_json, save_json, settings  # noqa: E402
from info_card import make_script, new_job, tr_date  # noqa: E402
from standings import FILE as STANDINGS, TR_NAMES, cached_top, fold, top  # noqa: E402

try:
    import certifi
    CTX = ssl.create_default_context(cafile=certifi.where())
except ImportError:
    CTX = ssl.create_default_context()

SEEN = DATA / "match_seen.json"
LEAGUE_TR = {"tur.1": "Trendyol Süper Lig", "uefa.champions": "UEFA Şampiyonlar Ligi", "uefa.europa": "UEFA Avrupa Ligi",
             "uefa.europa.conf": "UEFA Konferans Ligi", "tur.cup": "Türkiye Kupası"}


def cfg() -> dict:
    return {"enabled": True, "leagues": ["tur.1", "uefa.champions", "uefa.europa", "uefa.europa.conf"], "maxAgeHours": 8,
            "intervalMin": 10, "duration": 25, **(settings().get("match") or {})}


def tr_name(n: str) -> str:
    return TR_NAMES.get(fold(n), n)


def scoreboard(league: str) -> list:
    url = f"https://site.api.espn.com/apis/site/v2/sports/soccer/{league}/scoreboard"
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=20, context=CTX) as r:
        data = json.loads(r.read().decode("utf-8"))
    out = []
    for ev in data.get("events") or []:
        comp = (ev.get("competitions") or [{}])[0]
        st = (comp.get("status") or ev.get("status") or {}).get("type") or {}
        teams = {c.get("homeAway"): c for c in comp.get("competitors") or []}
        if "home" not in teams or "away" not in teams:
            continue
        ids = {teams[k].get("id") or (teams[k].get("team") or {}).get("id"): k for k in ("home", "away")}
        goals = []
        for d in comp.get("details") or []:
            if not d.get("scoringPlay"):
                continue
            who = ((d.get("athletesInvolved") or [{}])[0]).get("displayName") or ""
            side = ids.get((d.get("team") or {}).get("id"), "home")
            goals.append({"side": side, "player": who, "minute": (d.get("clock") or {}).get("displayValue") or "",
                          "own": bool(d.get("ownGoal")), "pen": bool(d.get("penaltyKick"))})
        try:
            ts = datetime.fromisoformat(str(ev.get("date")).replace("Z", "+00:00")).timestamp()
        except Exception:
            ts = time.time()
        out.append({"id": f"{league}-{ev.get('id')}", "league": league, "ts": ts, "completed": bool(st.get("completed")) or st.get("state") == "post",
                    "home": tr_name((teams["home"].get("team") or {}).get("displayName") or ""),
                    "away": tr_name((teams["away"].get("team") or {}).get("displayName") or ""),
                    "hs": int(teams["home"].get("score") or 0), "as": int(teams["away"].get("score") or 0), "goals": goals})
    return out


def suffix(name: str, kind: str) -> str:
    """Takım adına ek: acc "Galatasaray'ı", "Göztepe'yi"; gen "Fenerbahçe'nin", "Beşiktaş'ın"."""
    low = name.replace("I", "ı").replace("İ", "i").lower().strip()
    last_vowel = next((c for c in reversed(low) if c in "aeıioöuü"), "e")
    v4 = {"a": "ı", "ı": "ı", "e": "i", "i": "i", "o": "u", "u": "u", "ö": "ü", "ü": "ü"}[last_vowel]
    ends_vowel = low[-1:] in "aeıioöuü"
    if kind == "acc":
        return f"{name}'{'y' if ends_vowel else ''}{v4}"
    return f"{name}'{'n' if ends_vowel else ''}{v4}n"


def goal_text(g: dict) -> str:
    minute = re.sub(r"[^\d+]", "", g["minute"]).split("+")[0]
    extra = " kendi kalesine" if g["own"] else " penaltıdan" if g["pen"] else ""
    return f"{minute}. dakikada {g['player']}{extra}" if minute else f"{g['player']}{extra}"


def standing_of(team: str) -> dict | None:
    for t in (load_json(STANDINGS, {}) or {}).get("teams") or []:
        if fold(t.get("name", "")) == fold(team):
            return t
    return None


def build_job(m: dict) -> str:
    home, away, hs, as_ = m["home"], m["away"], m["hs"], m["as"]
    league = LEAGUE_TR.get(m["league"], "")
    score = f"{hs}-{as_}"
    if hs == as_:
        hook_title = "GOLSÜZ BERABERLİK" if hs == 0 else f"{score} BERABERE"
        hook = f"{home} ile {away} {score} berabere kaldı."
        result = f"{league} maçında {home} ile {away} {score} berabere kaldı."
    else:
        win, lose = (home, away) if hs > as_ else (away, home)
        hook_title = f"{win} KAZANDI"
        hook = f"{win}, {suffix(lose, 'acc')} {max(hs, as_)}-{min(hs, as_)} yendi."
        venue = "sahasında" if win == home else "deplasmanda"
        result = f"{league} maçında {win} {venue} {suffix(lose, 'acc')} {max(hs, as_)}-{min(hs, as_)} mağlup etti."
    lines = [result]
    for side, team in (("home", home), ("away", away)):
        gs = [goal_text(g) for g in m["goals"] if g["side"] == side and g["player"]]
        if gs:
            lines.append(f"{suffix(team, 'gen')} {'gollerini' if len(gs) > 1 else 'golünü'} {', '.join(gs[:-1]) + ' ve ' + gs[-1] if len(gs) > 1 else gs[0]} {'attı' if len(gs) == 1 else 'kaydetti'}.")
    items = [{"title": f"{home} {score} {away}", "narration": " ".join(lines)}]
    note = ""
    if m["league"] == "tur.1":
        try:
            top(refresh=True)  # maç sonrası güncel puan durumu
        except Exception:
            pass
        rows, notes = [], []
        for team in (home, away):
            st = standing_of(team)
            if st and st.get("rank"):
                pts = int(st["points"]) if st.get("points") is not None else None
                rows.append(f"{team} {pts} puanla {st['rank']}. sırada" if pts is not None else f"{team} {st['rank']}. sırada")
                notes.append(f"{team} {st['rank']}. sıra" + (f", {pts} puan" if pts is not None else ""))
        if rows:
            items.append({"title": "Puan durumu", "narration": "Bu sonuçla " + ", ".join(rows) + " yer alıyor."})
            note = " · ".join(notes)
    tag = lambda t: "#" + re.sub(r"[^\wçğıöşü]", "", t.replace("I", "ı").replace("İ", "i").lower())  # noqa: E731
    script = make_script(
        hook_title=hook_title, hook=hook, items=items,
        titles={"A": f"{home} {score} {away} | Maç sonucu ve goller", "B": hook.rstrip("."), "cover": f"{score} {hook_title.split()[0]}"},
        hashtags=[tag(home), tag(away), "#süperlig" if m["league"] == "tur.1" else "#avrupakupaları", "#maçsonucu", "#futbol"],
        importance=4, reason=f"{home}-{away} maç sonucu", source="Maç sonucu", category="spor")
    card = {"kind": "score", "label": "MAÇ SONUCU", "stamp": tr_date(m["ts"]),
            "score": {"home": home, "away": away, "hs": hs, "as": as_, "league": league,
                      "goals": [{"side": g["side"], "player": g["player"] + (" (k.k.)" if g["own"] else " (p)" if g["pen"] else ""), "minute": g["minute"]} for g in m["goals"] if g["player"]],
                      "note": note}}
    return str(new_job(f"mac-{m['id']}", script, [card], {"match": m}))


def interesting(m: dict) -> bool:
    if m["league"] == "tur.1":
        tops = {fold(t) for t in cached_top()}
        return fold(m["home"]) in tops or fold(m["away"]) in tops
    turkish = {fold(v) for v in TR_NAMES.values()}  # Avrupa kupaları: herhangi bir Türk takımı
    return fold(m["home"]) in turkish or fold(m["away"]) in turkish


def check() -> dict:
    c = cfg()
    seen = {k: v for k, v in (load_json(SEEN, {}) or {}).items() if time.time() - float(v) < 7 * 86400}
    out, errors = [], []
    for lg in c["leagues"]:
        try:
            games = scoreboard(lg)
        except Exception as e:
            errors.append(f"{lg}: {str(e)[:80]}")
            continue
        for m in games:
            if m["id"] in seen or not m["completed"] or not interesting(m):
                continue
            seen[m["id"]] = time.time()
            if time.time() - m["ts"] > float(c["maxAgeHours"]) * 3600:
                continue  # eski maç (ilk çalıştırma ya da Mac uyuyordu): video yok
            m["job"] = build_job(m)
            m["title"] = f"{m['home']} {m['hs']}-{m['as']} {m['away']}"
            out.append(m)
    save_json(SEEN, seen)
    return {"ok": True, "matches": out, "errors": errors}


if __name__ == "__main__":
    try:
        if "--check" in sys.argv:
            res = check()
        elif "--test" in sys.argv:
            m = {"id": f"test-{int(time.time())}", "league": "tur.1", "ts": time.time() - 3600, "completed": True, "home": "Fenerbahçe",
                 "away": "Galatasaray", "hs": 2, "as": 1, "goals": [{"side": "home", "player": "Dzeko", "minute": "23'", "own": False, "pen": False},
                                                                     {"side": "away", "player": "Icardi", "minute": "51'", "own": False, "pen": True},
                                                                     {"side": "home", "player": "Tadic", "minute": "88'", "own": False, "pen": False}]}
            res = {"ok": True, "matches": [{**m, "job": build_job(m)}]}
        else:
            res = {"ok": False, "error": "kullanım: --check | --test"}
    except Exception as ex:
        res = {"ok": False, "error": str(ex)[:300]}
    print(json.dumps(res, ensure_ascii=False))
