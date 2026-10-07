#!/usr/bin/env python3
"""Claude'un ürettiği segment JSON'unu doğrular, tarih ve bölüm bilgisini ekler.

Kullanım: python3 scripts/assemble_script.py work/claude_out.json work/script.json
"""
import json
import re
import sys
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
AYLAR = ["Ocak", "Şubat", "Mart", "Nisan", "Mayıs", "Haziran", "Temmuz", "Ağustos", "Eylül", "Ekim", "Kasım", "Aralık"]
MAX_WORDS_TOTAL = 95   # ~30 sn Türkçe haber temposu
HABER_MIN, HABER_MAX = 3, 5


def extract_json(text: str):
    m = re.search(r"\{.*\}", text, re.S)  # Claude kod bloğu eklerse içinden JSON'u al
    if not m:
        sys.exit("Claude çıktısında JSON bulunamadı")
    return json.loads(m.group(0))


def episode_of_day(date: str) -> int:
    return len(list((ROOT / "out").glob(f"{date}-*.mp4"))) + 1


def main(src: str, dst: str):
    raw = Path(src).read_text(encoding="utf-8")
    data = extract_json(raw)
    segs = data.get("segments", [])
    haber = [s for s in segs if s.get("kind") == "haber"]
    if not (HABER_MIN <= len(haber) <= HABER_MAX):
        sys.exit(f"Haber sayısı {len(haber)}, beklenen {HABER_MIN}-{HABER_MAX}")
    if segs[0].get("kind") != "intro" or segs[-1].get("kind") != "outro":
        sys.exit("İlk segment intro, son segment outro olmalı")
    for s in segs:
        if not s.get("narration", "").strip():
            sys.exit("Boş seslendirme metni")
        if s["kind"] == "haber" and not s.get("title", "").strip():
            sys.exit("Haber segmentinde başlık yok")
    words = sum(len(s["narration"].split()) for s in segs)
    if words > MAX_WORDS_TOTAL:
        sys.exit(f"Toplam {words} kelime, üst sınır {MAX_WORDS_TOTAL}. Senaryo 30 saniyeye sığmaz.")

    now = datetime.now()
    date = now.strftime("%Y-%m-%d")
    out = {
        "date": date,
        "dateLabel": f"{now.day} {AYLAR[now.month - 1]} {now.year}",
        "episodeOfDay": episode_of_day(date),
        "timeLabel": now.strftime("%H:%M"),
        "segments": segs,
    }
    Path(dst).write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"{len(haber)} haber, {words} kelime, günün {out['episodeOfDay']}. videosu -> {dst}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
