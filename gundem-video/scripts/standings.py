#!/usr/bin/env python3
"""Süper Lig puan durumu: ilk N takım (kullanıcı kararı: "sıralamadaki ilk 5 takımdan gelen haberler değerli").

Kaynak ESPN'in açık puan durumu verisi (lig kodu tur.1). 12 saatlik önbellek `data/standings.json`; erişilemezse eski
liste, o da yoksa `settings.sports.topTeams` (varsayılan büyük kulüpler) kullanılır. `news_value` bu listeyi okur.

  python3 scripts/standings.py          # önbellek tazeyse onu, değilse yeniden çeker; ilk 5'i yazar
  python3 scripts/standings.py --force  # her durumda yeniden çeker
"""
import json
import ssl
import sys
import time
import unicodedata
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import DATA, load_json, save_json, settings  # noqa: E402

try:
    import certifi
    CTX = ssl.create_default_context(cafile=certifi.where())
except ImportError:
    CTX = ssl.create_default_context()

FILE = DATA / "standings.json"
URL = "https://site.api.espn.com/apis/v2/sports/soccer/tur.1/standings"
DEFAULT_TOP = ["Galatasaray", "Fenerbahçe", "Beşiktaş", "Trabzonspor", "Başakşehir"]
# ESPN adları Türkçe karaktersiz; panelde ve logda düzgün görünsün diye
TR_NAMES = {"fenerbahce": "Fenerbahçe", "besiktas": "Beşiktaş", "istanbul basaksehir": "Başakşehir", "basaksehir": "Başakşehir",
            "goztepe": "Göztepe", "kasimpasa": "Kasımpaşa", "eyupspor": "Eyüpspor", "caykur rizespor": "Çaykur Rizespor",
            "rizespor": "Çaykur Rizespor", "genclerbirligi": "Gençlerbirliği", "karagumruk": "Karagümrük", "fatih karagumruk": "Karagümrük",
            "kocaelispor": "Kocaelispor", "konyaspor": "Konyaspor", "antalyaspor": "Antalyaspor", "alanyaspor": "Alanyaspor",
            "gaziantep fk": "Gaziantep FK", "kayserispor": "Kayserispor", "samsunspor": "Samsunspor", "trabzonspor": "Trabzonspor",
            "galatasaray": "Galatasaray", "sivasspor": "Sivasspor", "hatayspor": "Hatayspor", "bodrumspor": "Bodrumspor",
            "adana demirspor": "Adana Demirspor", "pendikspor": "Pendikspor", "ankaragucu": "Ankaragücü"}


def fold(t: str) -> str:
    t = (t or "").replace("ı", "i").replace("İ", "i").lower()
    return "".join(c for c in unicodedata.normalize("NFKD", t) if not unicodedata.combining(c))


def fetch() -> list:
    req = urllib.request.Request(URL, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=20, context=CTX) as r:
        data = json.loads(r.read().decode("utf-8"))
    entries = []
    for child in data.get("children") or [data]:
        entries += (child.get("standings") or {}).get("entries") or []
    teams = []
    for e in entries:
        name = (e.get("team") or {}).get("displayName") or (e.get("team") or {}).get("name") or ""
        stats = {s.get("name"): s.get("value") for s in e.get("stats") or []}
        rank = stats.get("rank") or stats.get("position")
        if name and rank:
            teams.append({"name": TR_NAMES.get(fold(name), name), "rank": int(rank), "points": stats.get("points")})
    teams.sort(key=lambda x: x["rank"])
    return teams


def top(n: int | None = None, refresh: bool = False) -> list:
    """İlk n takımın adı (önbellek / ESPN / ayar)."""
    n = n or int((settings().get("sports") or {}).get("topN") or 5)
    st = load_json(FILE, {}) or {}
    if refresh or time.time() - float(st.get("at") or 0) > 12 * 3600:
        try:
            teams = fetch()
            if len(teams) >= n:
                st = {"at": time.time(), "teams": teams, "source": "ESPN"}
                save_json(FILE, st)
        except Exception as e:
            st.setdefault("error", str(e)[:120])
    names = [t["name"] for t in (st.get("teams") or [])][:n]
    return names or list((settings().get("sports") or {}).get("topTeams") or DEFAULT_TOP)[:n]


def cached_top() -> list:
    """Ağ çağrısı yapmadan (haber puanlamada her haberde çağrılır)."""
    n = int((settings().get("sports") or {}).get("topN") or 5)
    names = [t["name"] for t in ((load_json(FILE, {}) or {}).get("teams") or [])][:n]
    return names or list((settings().get("sports") or {}).get("topTeams") or DEFAULT_TOP)[:n]


if __name__ == "__main__":
    names = top(refresh="--force" in sys.argv)
    print(f"⚽ Süper Lig ilk {len(names)}: {', '.join(names)}")
