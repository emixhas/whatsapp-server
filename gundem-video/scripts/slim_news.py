#!/usr/bin/env python3
"""Claude'a gidecek haber setini küçültür ve sıralar.

- Önem (p): 3 sert haber (can kaybı, saldırı, savaş, afet, büyük kaza), 2 önemli karar, 1 diğer.
- Kapsam (c): aynı olayı kaç farklı kaynak veriyor. Başlıklar benzerlikle kümelenir, kümenin en yeni
  sürümü kalır. Yüksek c = en çok konuşulan haber ("en çok merak edilen" için yerel ölçü).
- Tekrar engeli: data/used_news.json içindeki son 48 saatte videoya girmiş haberler elenir. Elenince
  yeterli haber kalmazsa (HABER×2'den az) elenenler "e":1 işaretiyle geri eklenir ve p bir düşer.
Sıra: p → c → yenilik. Çıktı: {"aciklama": ..., "haberler": [{p,c,k,b,o,s[,e]}]}
"""
import json
import os
import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import DATA, load_json  # noqa: E402

PRIORITY = [
    (3, r"(öldü|hayatını kaybetti|can kaybı|ölü sayısı|\d+ ölü|şehit|katled|cinayet|saldırı düzenle|saldırıda|bombalı|patlama meydana|patladı|savaş ilan|çatışma çıktı|füze|hava saldırısı|terör saldırısı|rehin al|deprem oldu|büyüklüğünde deprem|sarsıldı|sel felaketi|heyelan|yangın çıktı|yangında|zincirleme kaza|trafik kazası|otobüs devrildi|tren kazası|uçak düştü|kaza.*(yaralı|ölü)|facia|katliam|darbe girişimi|sıkıyönetim|olağanüstü hal)"),
    (2, r"(merkez bankası|faiz kararı|enflasyon|zam|asgari ücret|emekli maaş|dolar|altın rekor|istifa|görevden al|atama|kabine|seçim|meclis|cumhurbaşkanı|bakan|operasyon|gözaltı|tutuklan|mahkeme|karar verdi|yasa|kanun|grev|iptal|skandal|kriz)"),
]
STOP = {"için", "ile", "olan", "olarak", "sonra", "daha", "göre", "yeni", "oldu", "etti", "dedi", "açıkladı", "haber", "son", "dakika"}


def score(it):
    t = f"{it.get('title', '')} {it.get('summary', '')}".lower()
    for pts, pat in PRIORITY:
        if re.search(pat, t):
            return pts
    return 1


def words(t: str):
    return {w for w in re.sub(r"[^\w\s]", " ", (t or "").lower()).split() if len(w) > 3 and w not in STOP}


def jaccard(a, b):
    return len(a & b) / len(a | b) if a and b else 0.0


def used_recent(hours=48):
    """Son videolara girmiş haberler: (başlık kelimeleri, başlık+metin kelimeleri). assemble_script yazar."""
    cutoff = (datetime.now(timezone.utc) - timedelta(hours=hours)).isoformat()
    return [(set(u.get("w", [])), set(u.get("w", [])) | set(u.get("wn", []))) for u in load_json(DATA / "used_news.json", []) if u.get("at", "") >= cutoff]


def seen_before(item_words, used):
    """Haber başlığının kelimeleri önceki bir haberin başlığıyla yarı yarıya ya da metniyle büyük ölçüde örtüşüyorsa eski."""
    if not item_words:
        return False
    for title_w, all_w in used:
        if len(item_words & title_w) / len(item_words) >= 0.5 or len(item_words & all_w) / len(item_words) >= 0.7:
            return True
    return False


def main():
    src, dst, n = sys.argv[1], sys.argv[2], int(sys.argv[3]) if len(sys.argv) > 3 else 50
    need = int(os.environ.get("HABER", "4"))
    data = json.load(open(src, encoding="utf-8"))
    items = data.get("items", [])
    for it in items:
        it["_p"] = score(it)
        it["_w"] = words(it.get("title", ""))
    items.sort(key=lambda it: it.get("published") or "", reverse=True)

    # Aynı olayı veren haberleri kümele: en yeni sürüm kalır, kaynak sayısı c olur
    clusters = []
    for it in items:
        for cl in clusters:
            if jaccard(it["_w"], cl["w"]) >= 0.45:
                cl["sources"].add(it.get("source"))
                cl["w"] |= it["_w"]
                cl["p"] = max(cl["p"], it["_p"])
                break
        else:
            clusters.append({"item": it, "w": set(it["_w"]), "sources": {it.get("source")}, "p": it["_p"]})

    # Tekrar engeli: önceki videolarda kullanılan haberler
    used = used_recent()
    fresh, old = [], []
    for cl in clusters:
        if seen_before(cl["item"]["_w"], used):
            if cl["p"] == 3:  # gelişen sert haber (can kaybı artışı vb.): listede kalır, e=1 ile işaretlenir
                cl["old"] = True
                fresh.append(cl)
            else:
                old.append(cl)
        else:
            fresh.append(cl)
    chosen = fresh
    note = ""
    if len(fresh) < need * 2 and old:
        for cl in old:
            cl["old"] = True
            cl["p"] = max(1, cl["p"] - 1)
        chosen = fresh + old
        note = f" Yeterli yeni haber yok: {len(old)} eski haber e=1 ile geri eklendi; önce yeni olanları seç."
    try:  # Google Trends Türkiye: şu an çok aranan konuya uyan haber öne (scripts/trends.py önbelleği)
        from trends import current, match
        tr = current()
    except Exception:
        tr = []
    for cl in chosen:
        hits = match(f"{cl['item'].get('title', '')} {(cl['item'].get('summary') or '')[:200]}", tr) if tr else []
        cl["trend"] = hits[0] if hits else None
    # Manşet (m=1): şu an Mynet manşetinde ya da son dakika sitelerinde olan, ya da halk için değerli (news_value) olay.
    # Kullanıcı kararı: kanca her zaman manşetlik haberden, manşet haberi videoda daha fazla yer alır.
    try:
        from breaking_watch import recent_items, same_event
        heads = [i.get("title", "") for i in recent_items()]
    except Exception:
        heads, same_event = [], None
    try:
        from news_value import score as value_score
    except Exception:
        value_score = None
    for cl in chosen:
        t = cl["item"].get("title", "")
        on_front = bool(same_event) and any(same_event(t, h) for h in heads if h)
        valuable = False
        if value_score:
            try:
                valuable = bool(value_score(f"{t} {(cl['item'].get('summary') or '')[:200]}").get("valuable"))
            except Exception:
                valuable = False
        cl["m"] = 1 if (on_front or valuable or cl["p"] == 3) and not cl.get("old") else 0
    chosen.sort(key=lambda cl: (cl["p"], cl["m"], bool(cl.get("trend")), len(cl["sources"]), cl["item"].get("published") or ""), reverse=True)
    chosen = chosen[:n]
    slim = []
    for cl in chosen:
        it = cl["item"]
        row = {"p": cl["p"], "c": len(cl["sources"]), "k": it.get("source"), "b": it.get("title"), "o": (it.get("summary") or "")[:160], "s": (it.get("published") or "")[11:16]}
        if cl.get("m"):
            row["m"] = 1
        if cl.get("old"):
            row["e"] = 1
        if cl.get("trend"):
            row["t"], row["tr"] = 1, cl["trend"]
        slim.append(row)
    counts = {k: sum(1 for r in slim if r["p"] == k) for k in (3, 2, 1)}
    multi = sum(1 for r in slim if r["c"] > 1)
    json.dump({"aciklama": "p=önem (3 sert haber, 2 önemli karar, 1 diğer) c=aynı olayı veren kaynak sayısı (yüksek c = en çok konuşulan) "
               "k=kaynak b=başlık o=özet s=saat(UTC) e=1 önceki videoda kullanılmış (yalnızca yeni haber yoksa). "
               "t=1 Türkiye'de şu an Google'da çok aranan konu (tr=aranan ifade). m=1 manşetlik haber (sitelerin manşetinde/son dakikasında "
               "ya da halk için değerli; kanca bunlardan seçilir)." + note, "haberler": slim},
              open(dst, "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
    print(f"{len(slim)} haber Claude'a gidiyor (önem 3: {counts[3]}, önem 2: {counts[2]}, önem 1: {counts[1]}; çok kaynaklı: {multi}; "
          f"önceki videolardan elenen: {len(old)}; toplam {len(items)})")


if __name__ == "__main__":
    main()
