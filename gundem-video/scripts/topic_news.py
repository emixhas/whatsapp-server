#!/usr/bin/env python3
"""Anlık haber: kullanıcının verdiği konuya ilişkin haberleri RSS listesinden süzer.

Kullanım: topic_news.py work/news.json work/anlik_topic.txt work/news_prompt.json
Çıktı: {"konu": <kullanıcının yazdığı bilgi>, "ilgili_haberler": [{k,b,o,s,u}]}
Eşleşme: konu metnindeki anlamlı kelimelerin ilk 4 harfi (Türkçe ekler kesilsin diye) haber başlığı ve
özetindeki kelimelerin ilk 4 harfiyle karşılaştırılır. Uyan kelime sayısı = puan. Konuya iki ve daha
fazla kelimeyle uyan en az 3 haber varsa tek kelimelik uyanlar elenir (ilgisiz haber karışmasın).
"""
import json
import os
import re
import sys

STOP = {"için", "ile", "olan", "olarak", "sonra", "daha", "göre", "yeni", "oldu", "etti", "dedi", "açıkladı", "haber",
        "son", "dakika", "bugün", "şimdi", "hakkında", "ilgili", "konu", "video", "anlık", "gündem", "olay", "olayı",
        "kadar", "gibi", "çok", "bir", "iki", "ama", "fakat", "veya", "şu", "bu", "da", "de", "mi", "ne", "nasıl"}


def low(t: str) -> str:
    return (t or "").replace("I", "ı").replace("İ", "i").lower()


def stems(t: str):
    return {w[:4] for w in re.sub(r"[^\w\s]", " ", low(t)).split() if len(w) > 2 and w not in STOP}


def main():
    src, topic_file, dst = sys.argv[1], sys.argv[2], sys.argv[3]
    topic = open(topic_file, encoding="utf-8").read().strip()
    items = json.load(open(src, encoding="utf-8")).get("items", [])
    kw = stems(topic)
    scored = []
    for it in items:
        s = len(kw & stems(f"{it.get('title', '')} {it.get('summary', '')}"))
        if s >= 1:
            scored.append((s, it.get("published") or "", it))
    if len(kw) > 2 and sum(1 for x in scored if x[0] >= 2) >= 3:
        scored = [x for x in scored if x[0] >= 2]
    scored.sort(key=lambda x: (x[0], x[1]), reverse=True)
    seen, rel = set(), []
    for s, _, it in scored:
        key = low(it.get("title", ""))[:60]
        if key in seen:
            continue
        seen.add(key)
        rel.append({"k": it.get("source"), "b": it.get("title"), "o": (it.get("summary") or "")[:300], "s": (it.get("published") or "")[11:16], "u": s})
        if len(rel) >= 12:
            break
    src = os.environ.get("ANLIK_SOURCE", "").strip()
    out = {"aciklama": "konu = kullanıcının (kanal editörünün) verdiği bilgi. ilgili_haberler = RSS'te bu konuya uyan haberler; "
           "k=kaynak b=başlık o=özet s=saat(UTC) u=konuyla uyum puanı.", "konu": topic, "ilgili_haberler": rel}
    if src:  # konu bir haber sitesinin manşetinden geldi (ör. Mynet): doğrulanmış haber metni
        out["kaynak"] = src
        out["aciklama"] += f" kaynak = 'konu' metninin geldiği haber sitesi ({src})."
    json.dump(out,
              open(dst, "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
    print(f"anlık konu: {topic[:80]} · ilgili haber: {len(rel)} (toplam {len(items)} haber tarandı)")


if __name__ == "__main__":
    main()
