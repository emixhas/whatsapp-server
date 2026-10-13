#!/usr/bin/env python3
"""Video sonrası altyazı denetimi (kullanıcı isteği: altyazı sesle kesinlikle eşit gitsin; sorun size gelmeden yakalansın).

Render bittikten sonra son videonun sesi (müzik ve efektler dahil, izleyicinin duyduğu) konuşma tanımayla bağımsız olarak
dinlenir; tanınan kelimeler videodaki altyazı kelimeleriyle sırayla eşlenir (difflib) ve her eşleşen kelimede altyazının
ekrana geldiği an ile sesteki başlangıç karşılaştırılır. Konuşma tanımanın kendi payı ~50-100 ms olduğu için eşik geniş tutulur.

  python3 scripts/caption_qa.py out/2026-10-14-3.mp4
Çıktı: "🔤 altyazı denetimi: …" satırı; sorun varsa "⚠️ altyazı denetimi" ile başlar. Sonuçlar `data/caption_qa.json`
(son 200). Konuşma tanıma (mlx-whisper) kurulu değilse atlanır.
"""
import difflib
import json
import statistics
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import DATA, load_json, now_iso, save_json  # noqa: E402

FILE = DATA / "caption_qa.json"


def main(mp4: Path) -> dict:
    import align
    meta = load_json(mp4.with_suffix(".json"), {}) or {}
    lead = float(meta.get("captionLead", 0.06))
    ours, t = [], 0.0
    for seg in meta.get("segments") or []:
        if seg.get("kind") != "intro":  # intro'da altyazı gösterilmez
            for w in seg.get("words") or []:
                ours.append((w["w"], t + float(w["s"]) - lead, seg.get("captionSync", "")))
        t += float(seg.get("duration") or 0)
    if len(ours) < 8:
        return {"ok": True, "skipped": "altyazı kelimesi yok"}
    run = align._whisper()
    if not run:
        return {"ok": True, "skipped": "konuşma tanıma kurulu değil"}
    with tempfile.TemporaryDirectory() as d:
        wav = Path(d) / "a.wav"
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(mp4), "-ac", "1", "-ar", "16000", str(wav)], check=True)
        rec = run(wav)
    a = [align._norm(w.replace("*", "")) for w, _, _ in ours]
    b = [align._norm(w) for w, _, _ in rec]
    diffs = []
    for blk in difflib.SequenceMatcher(None, a, b, autojunk=False).get_matching_blocks():
        for k in range(blk.size):
            if len(a[blk.a + k]) >= 3:  # kısa kelimeler (ve, bu) yanlış eşleşmeye açık
                diffs.append(ours[blk.a + k][1] - rec[blk.b + k][1])  # + : altyazı geç, - : erken
    if len(diffs) < 8:
        return {"ok": True, "skipped": f"yalnız {len(diffs)} kelime eşlendi"}
    med = statistics.median(diffs)
    within = sum(1 for x in diffs if abs(x) <= 0.15) / len(diffs)
    p90 = sorted(abs(x) for x in diffs)[int(len(diffs) * 0.9) - 1]
    bad = within < 0.7 or abs(med) > 0.12
    methods = sorted({m for _, _, m in ours if m})
    res = {"ok": True, "video": mp4.name, "at": now_iso(), "matched": len(diffs), "medianMs": round(med * 1000), "p90Ms": round(p90 * 1000),
           "within150": round(within, 2), "bad": bad, "methods": methods}
    hist = (load_json(FILE, []) or [])[-199:]
    save_json(FILE, hist + [res])
    yon = "geç" if med > 0 else "erken"
    line = (f"🔤 altyazı denetimi: {len(diffs)} kelime sesle karşılaştırıldı, 150 ms içinde olan: yüzde {round(within * 100)}, ortanca kayma "
            f"{abs(round(med * 1000))} ms {yon}, en kötü onda bir {round(p90 * 1000)} ms ({', '.join(methods)})")
    if bad:
        mad = statistics.median(abs(x - med) for x in diffs)  # sapmaların ortancadan dağılımı: küçükse kayma sabittir
        hint = (f" — altyazı sürekli {yon} geliyor: Ayarlar → Gelişmiş → Altyazı kaydırma'yı {abs(round(med, 2))} sn "
                f"{'artırın' if med > 0 else 'azaltın'}" if abs(med) > 0.12 and mad < 0.08 else
                " — kelimeler dağınık kayıyor: metin hizalama kurulu mu? (bash scripts/install_align.sh)")
        line = "⚠️ " + line + hint
    print(line, flush=True)
    return res


if __name__ == "__main__":
    try:
        out = main(Path(sys.argv[1]))
        if out.get("skipped"):
            print(f"🔤 altyazı denetimi atlandı: {out['skipped']}", flush=True)
    except Exception as e:
        out = {"ok": False, "error": str(e)[:300]}
        print(f"🔤 altyazı denetimi yapılamadı: {str(e)[:160]}", flush=True)
    print(json.dumps(out, ensure_ascii=False))
