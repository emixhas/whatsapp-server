#!/usr/bin/env python3
"""Claude'a gidecek haber setini küçültür: en yeni N haber, 200 karakter özet, kaynak ve saat. Link yok."""
import json
import sys

import re

# Önem puanı: sert haberler (can kaybı, saldırı, savaş, afet, büyük kaza) 3; ekonomi/siyaset kararları 2; diğer 1.
PRIORITY = [
    (3, r"(öldü|hayatını kaybetti|can kaybı|ölü sayısı|\d+ ölü|şehit|katled|cinayet|saldırı düzenle|saldırıda|bombalı|patlama meydana|patladı|savaş ilan|çatışma çıktı|füze|hava saldırısı|terör saldırısı|rehin al|deprem oldu|büyüklüğünde deprem|sarsıldı|sel felaketi|heyelan|yangın çıktı|yangında|zincirleme kaza|trafik kazası|otobüs devrildi|tren kazası|uçak düştü|kaza.*(yaralı|ölü)|facia|katliam|darbe girişimi|sıkıyönetim|olağanüstü hal)"),
    (2, r"(merkez bankası|faiz kararı|enflasyon|zam|asgari ücret|emekli maaş|dolar|altın rekor|istifa|görevden al|atama|kabine|seçim|meclis|cumhurbaşkanı|bakan|operasyon|gözaltı|tutuklan|mahkeme|karar verdi|yasa|kanun|grev|iptal|skandal|kriz)"),
]


def score(it):
    t = f"{it.get('title', '')} {it.get('summary', '')}".lower()
    for pts, pat in PRIORITY:
        if re.search(pat, t):
            return pts
    return 1


src, dst, n = sys.argv[1], sys.argv[2], int(sys.argv[3]) if len(sys.argv) > 3 else 50
data = json.load(open(src, encoding="utf-8"))
items = data.get("items", [])
for it in items:
    it["_p"] = score(it)
# Önce önem (yüksek → düşük), eşitlerde yenilik (yeni → eski); ilk n haber
items = sorted(items, key=lambda it: it.get("published") or "", reverse=True)
items = sorted(items, key=lambda it: -it["_p"])[:n]
slim = [{"p": it["_p"], "k": it.get("source"), "b": it.get("title"), "o": (it.get("summary") or "")[:160], "s": (it.get("published") or "")[11:16]} for it in items]
counts = {k: sum(1 for it in items if it["_p"] == k) for k in (3, 2, 1)}
json.dump({"aciklama": "p=önem (3 sert haber: can kaybı/saldırı/savaş/afet/büyük kaza, 2 önemli karar, 1 diğer) k=kaynak b=başlık o=özet s=saat(UTC)", "haberler": slim},
          open(dst, "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
print(f"{len(slim)} haber Claude'a gidiyor (önem 3: {counts[3]}, önem 2: {counts[2]}, önem 1: {counts[1]}; toplam {len(data.get('items', []))})")
