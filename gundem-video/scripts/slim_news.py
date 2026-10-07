#!/usr/bin/env python3
"""Claude'a gidecek haber setini küçültür: en yeni N haber, 200 karakter özet, kaynak ve saat. Link yok."""
import json
import sys

src, dst, n = sys.argv[1], sys.argv[2], int(sys.argv[3]) if len(sys.argv) > 3 else 20
data = json.load(open(src, encoding="utf-8"))
items = data.get("items", [])[:n]
slim = [{"k": it.get("source"), "b": it.get("title"), "o": (it.get("summary") or "")[:200], "s": (it.get("published") or "")[11:16]} for it in items]
json.dump({"aciklama": "k=kaynak b=başlık o=özet s=saat(UTC)", "haberler": slim}, open(dst, "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
print(f"{len(slim)} haber Claude'a gidiyor ({len(items)}/{len(data.get('items', []))} seçildi)")
