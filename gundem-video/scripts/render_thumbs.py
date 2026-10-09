#!/usr/bin/env python3
"""Kapakları üretir ve EKSİK KALMAMASINI garanti eder.

Kullanım: python3 scripts/render_thumbs.py public/episode.json out/2026-10-08-1
          python3 scripts/render_thumbs.py --missing   (kapağı eksik tüm eski videolar)
Çıktılar: <base>-kapakA.jpg (haberci), <base>-kapakB.jpg (merak), seçilen varyant <base>-kapak.jpg (dikey,
Shorts/Reels/TikTok) ve <base>-kapakYT.jpg (1280x720 YouTube).

1. scripts/render_thumbs.mjs: proje bir kez paketlenir, dört kapak sırayla çizilir, her biri 3 kez denenir.
2. Yine de eksik kalan olursa yedek: videonun İLK KARESİ zaten kapaktır (GundemVideo 0. kare = Thumb);
   dikey kapak o kareden, YouTube kapağı aynı kareden bulanık zeminle 1280x720 üretilir.
Son satırda her dosyanın durumu yazar; kapak yoksa açıkça uyarır.
"""
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import ROOT, settings  # noqa: E402

def media(rel):
    """Görsel public/ altında hâlâ varsa yolu; silinmişse None (kapak fotoğrafsız çizilir, çökmez)."""
    return rel if rel and (ROOT / "public" / rel).exists() else None


def jobs_for(ep: dict, base: str) -> list:
    haber = [x for x in ep["segments"] if x.get("kind") == "haber"]
    first = haber[0] if haber else {}
    titles = ep.get("titles", {})
    v_sel = ep.get("titleVariant", "A")
    cp = {"category": first.get("category"), "breaking": bool(first.get("breaking")), "channel": settings()["channelName"],
          "dayLabel": ep.get("dayLabel"), "slotLabel": ep.get("slotLabel"), "timeRange": ep.get("timeRange")}

    def text_for(v: str) -> str:
        t = titles.get("cover") if v == "A" else titles.get("B", titles.get("cover", ""))
        return t or first.get("title", "")

    js = [{"id": "Thumb", "out": f"{base}-kapak{v}.jpg", "props": {**cp, "text": text_for(v), "variant": v,
                                                                     "image": media(first.get("imageTall")) or media(first.get("image"))}} for v in ("A", "B")]
    js.append({"id": "ThumbWide", "out": f"{base}-kapakYT.jpg", "props": {**cp, "text": text_for(v_sel), "variant": v_sel,
                                                                           "image": media(first.get("image")), "wide": True}})
    return js


if sys.argv[1] == "--missing":
    # Kapağı eksik eski videolar: hepsi tek seferde çizilir (panel açılışında arka planda çalışır)
    todo = []
    for meta in sorted((ROOT / "out").glob("*.json")):
        b = str(meta.with_suffix(""))
        if Path(b + ".mp4").exists() and not (Path(b + "-kapak.jpg").exists() and Path(b + "-kapakYT.jpg").exists()):
            try:
                todo.append((json.loads(meta.read_text(encoding="utf-8")), b))
            except Exception:
                pass
    if not todo:
        print("kapak eksik video yok")
        sys.exit(0)
    print(f"kapağı eksik {len(todo)} video için kapak üretiliyor")
    work_items = todo
else:
    work_items = [(json.loads(Path(sys.argv[1]).read_text(encoding="utf-8")), sys.argv[2])]
jobs = [j for ep_, b in work_items for j in jobs_for(ep_, b)]
jobs_file = ROOT / "work" / "thumb_jobs.json"
jobs_file.parent.mkdir(parents=True, exist_ok=True)
jobs_file.write_text(json.dumps(jobs, ensure_ascii=False), encoding="utf-8")
try:
    r = subprocess.run(["node", str(ROOT / "scripts" / "render_thumbs.mjs"), str(jobs_file)], cwd=ROOT, capture_output=True, text=True, timeout=600)
    if r.returncode != 0:
        print(f"  ! kapak çizimi hata verdi: {(r.stdout + r.stderr).strip()[-300:]}", file=sys.stderr)
except subprocess.TimeoutExpired:
    print("  ! kapak çizimi zaman aşımına uğradı", file=sys.stderr)
except Exception as e:  # node bulunamadı vb.: yedek yola geçilir
    print(f"  ! kapak çizimi başlatılamadı: {e}", file=sys.stderr)

ok = lambda p: Path(p).exists() and Path(p).stat().st_size > 10000  # noqa: E731


def ff(args: list) -> bool:
    return subprocess.run(["ffmpeg", "-y", "-loglevel", "error", *args], capture_output=True).returncode == 0


def finish(ep: dict, base: str) -> None:
    """Eksik kapakları videonun ilk karesinden tamamlar, seçilen varyantı -kapak.jpg yapar, durumu yazar."""
    js = jobs_for(ep, base)
    v_sel = ep.get("titleVariant", "A")
    video = f"{base}.mp4"
    first_frame = ROOT / "work" / "cover_frame.jpg"
    if not all(ok(j["out"]) for j in js) and Path(video).exists():
        ff(["-i", video, "-frames:v", "1", "-q:v", "2", str(first_frame)])
        for j in js:
            if ok(j["out"]) or not first_frame.exists():
                continue
            if j["id"] == "Thumb":
                shutil.copy(first_frame, j["out"])
            else:
                ff(["-i", str(first_frame), "-filter_complex",
                    "[0:v]split[a][b];[a]scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720,boxblur=28:2,eq=brightness=-0.12[bg];"
                    "[b]scale=1280:720:force_original_aspect_ratio=decrease[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2", "-frames:v", "1", "-q:v", "2", j["out"]])
            if ok(j["out"]):
                print(f"  kapak yedekten (videonun ilk karesi): {Path(j['out']).name}", file=sys.stderr)
    chosen = f"{base}-kapak{v_sel}.jpg"
    if ok(chosen):
        shutil.copy(chosen, f"{base}-kapak.jpg")
    names = {f"{base}-kapak.jpg": "dikey", f"{base}-kapakYT.jpg": "YouTube"}
    missing = [label for f, label in names.items() if not ok(f)]
    if missing:
        print(f"  ! kapak eksik ({Path(base).name}): {', '.join(missing)}", file=sys.stderr)
    print(f"kapaklar hazır{' (' + Path(base).name + ')' if len(work_items) > 1 else ''}: dikey {'✓' if ok(f'{base}-kapak.jpg') else '✗'}, "
          f"YouTube {'✓' if ok(f'{base}-kapakYT.jpg') else '✗'}, A/B {'✓' if ok(f'{base}-kapakA.jpg') and ok(f'{base}-kapakB.jpg') else '✗'} (seçilen varyant {v_sel})")


for ep_, b in work_items:
    finish(ep_, b)
