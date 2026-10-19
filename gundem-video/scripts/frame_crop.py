#!/usr/bin/env python3
"""Paylaşım videosundaki çerçeve ve ekrandaki yazılar (kullanıcı isteği, 19 Ekim: "Instagram'dan video gönderdiğimde bazı haber ve
paylaşım yapanların etrafında çerçevesi oluyor ve bazen linkte açıklama olmuyor; videodaki kelimeleri analiz ederek haber üretebilir miyiz").

Çerçeve tespiti (`detect`): videoya yayılmış ~40 kare 108 px genişlikte gri okunur; her pikselin zaman içindeki değişimi (standart sapma)
ölçülür. Kenarda HİÇ değişmeyen bantlar (logo/hesap bandı, başlık paneli, düz renk ya da siyah kenarlık) çerçeve, ortadaki hareketli
dikdörtgen içeriktir. Temkinli: içerik alanı karenin %25-92'si, bantlar durağan (ortalama hareket ≤ %12), içerik gerçekten hareketli
(≥ %50; tek çekimde konuşan kişi ya da durağan zeminli video kırpılmaz) ve bant-içerik sınırı DÜZ bir çizgi (doğal sahnedeki durağan
gökyüzünün/duvarın sınırı eğri ve kademelidir). Bulanık zeminli (zemini hareketli) düzen çerçeve sayılmaz. numpy gerekmez.
`crop`: içerik dikdörtgeni kırpılmış kopya (ses aynen). `text_frames`: özgün (çerçeveli) videodan yazıların okunacağı büyük kareler.

  python3 scripts/frame_crop.py VIDEO            # tespit sonucu (JSON)
  python3 scripts/frame_crop.py VIDEO --crop OUT # kırpılmış kopya
"""
import json
import subprocess
import sys
from pathlib import Path

SW = 108  # analiz genişliği (piksel)
STD = 6.0  # bu standart sapmanın altı "durağan"


def _dims(p: Path) -> tuple:
    r = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height:stream_tags=rotate",
                        "-show_entries", "format=duration", "-of", "json", str(p)], capture_output=True, text=True)
    d = json.loads(r.stdout or "{}")
    s = (d.get("streams") or [{}])[0]
    w, h = int(s.get("width") or 0), int(s.get("height") or 0)
    if str((s.get("tags") or {}).get("rotate", "0")) in ("90", "270", "-90"):
        w, h = h, w
    return w, h, float((d.get("format") or {}).get("duration") or 0)


def _frames(p: Path, dur: float, w: int, h: int, n: int = 40) -> tuple:
    sh = max(2, int(round(SW * h / w / 2)) * 2)
    a, b = dur * 0.03, dur * 0.97  # giriş/çıkış animasyonu (çerçevenin kayarak gelmesi) sayılmasın
    raw = subprocess.run(["ffmpeg", "-v", "error", "-ss", f"{a:.2f}", "-t", f"{max(0.5, b - a):.2f}", "-i", str(p), "-vf",
                          f"fps={n / max(0.5, b - a):.4f},scale={SW}:{sh}:flags=area,format=gray", "-f", "rawvideo", "-"],
                         capture_output=True, timeout=180).stdout
    size = SW * sh
    return sh, [raw[i:i + size] for i in range(0, len(raw) - size + 1, size)]


def detect(p: Path, dur: float | None = None) -> tuple:
    """(kırpma {x, y, w, h, W, H} ya da None, ayrıntı {neden, bantlar…})."""
    try:
        W, H, d = _dims(Path(p))
        dur = dur or d
        if not W or not H or dur < 2:
            return None, {"why": "video okunamadı ya da çok kısa"}
        h, fs = _frames(Path(p), dur, W, H)
    except Exception as e:
        return None, {"why": f"kareler alınamadı: {str(e)[:80]}"}
    w, n = SW, len(fs)
    if n < 8:
        return None, {"why": "az kare"}
    dyn = bytearray(w * h)
    for i in range(w * h):
        s = s2 = 0
        for f in fs:
            v = f[i]
            s += v
            s2 += v * v
        m = s / n
        dyn[i] = 1 if s2 / n - m * m > STD * STD else 0
    row = [sum(dyn[y * w:(y + 1) * w]) / w for y in range(h)]

    def span(prof, hi=0.35):  # en az 3 ardışık hareketli satır/sütunun ilki ve sonuncusu
        L = len(prof)
        a = next((i for i in range(L - 2) if all(prof[i + k] >= hi for k in range(3))), None)
        b = next((i for i in range(L - 1, 1, -1) if all(prof[i - k] >= hi for k in range(3))), None)
        return a, b
    top, bot = span(row)
    if top is None or bot is None or bot <= top:
        return None, {"why": "hareketli bölge yok"}
    col = [sum(dyn[y * w + x] for y in range(top, bot + 1)) / (bot - top + 1) for x in range(w)]
    left, right = span(col)
    if left is None or right is None or right <= left:
        return None, {"why": "hareketli sütun yok"}
    inner = [dyn[y * w + x] for y in range(top, bot + 1) for x in range(left, right + 1)]
    inside = sum(inner) / len(inner)
    area = (bot - top + 1) * (right - left + 1) / (w * h)
    bands = {}
    if top > 0:
        bands["ust"] = sum(row[:top]) / top
    if bot < h - 1:
        bands["alt"] = sum(row[bot + 1:]) / (h - 1 - bot)
    if left > 0:
        bands["sol"] = sum(col[:left]) / left
    if right < w - 1:
        bands["sag"] = sum(col[right + 1:]) / (w - 1 - right)
    info = {"inside": round(inside, 2), "area": round(area, 2), "bands": {k: round(v, 3) for k, v in bands.items()},
            "pct": {"ust": round(top / h * 100), "alt": round((h - 1 - bot) / h * 100), "sol": round(left / w * 100), "sag": round((w - 1 - right) / w * 100)}}
    if area > 0.92:
        return None, {**info, "why": "çerçeve yok"}
    if area < 0.25:
        return None, {**info, "why": "hareketli içerik çok küçük"}
    if inside < 0.5:
        return None, {**info, "why": "içerik yeterince hareketli değil (tek çekim, durağan zemin)"}
    if any(v > 0.12 for v in bands.values()):
        return None, {**info, "why": "kenar bandı durağan değil"}

    # kenar düz bir çizgi olmalı: içerik tarafındaki her sütunda (satırda) ilk hareketli piksel sınırın 2 piksel içinde
    def straight(edge, axis, step):
        L = (right - left + 1) if axis == "row" else (bot - top + 1)
        hits = 0
        for k in range(L):
            for dd in range(6):
                i = edge + dd * step
                x, y = (left + k, i) if axis == "row" else (i, top + k)
                if 0 <= x < w and 0 <= y < h and dyn[y * w + x]:
                    hits += dd <= 2
                    break
        return hits / max(1, L)
    edges = {}
    if "ust" in bands:
        edges["ust"] = straight(top, "row", 1)
    if "alt" in bands:
        edges["alt"] = straight(bot, "row", -1)
    if "sol" in bands:
        edges["sol"] = straight(left, "col", 1)
    if "sag" in bands:
        edges["sag"] = straight(right, "col", -1)
    info["edges"] = {k: round(v, 2) for k, v in edges.items()}
    if any(v < 0.7 for v in edges.values()):
        return None, {**info, "why": "kenar düz değil (doğal sahne)"}
    sx, sy = W / w, H / h
    x0, y0, x1, y1 = left * sx, top * sy, (right + 1) * sx, (bot + 1) * sy
    mx, my = (x1 - x0) * 0.01, (y1 - y0) * 0.01  # çerçeve çizgisi kalmasın: %1 içeri
    x0, y0, x1, y1 = x0 + mx, y0 + my, x1 - mx, y1 - my
    rect = {"x": int(x0) // 2 * 2, "y": int(y0) // 2 * 2, "w": int((x1 - x0) // 2 * 2), "h": int((y1 - y0) // 2 * 2), "W": W, "H": H}
    return rect, {**info, "why": "çerçeve"}


def crop(p: Path, rect: dict, out: Path) -> bool:
    """İçerik dikdörtgeni kırpılmış kopya (yüksek kalite; ses aynen kopyalanır)."""
    r = subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(p), "-vf", f"crop={rect['w']}:{rect['h']}:{rect['x']}:{rect['y']},setsar=1",
                        "-c:v", "libx264", "-preset", "veryfast", "-crf", "17", "-pix_fmt", "yuv420p", "-c:a", "copy", "-movflags", "+faststart",
                        str(out)], capture_output=True, text=True)
    return r.returncode == 0 and out.exists() and out.stat().st_size > 1000


def text_frames(p: Path, dur: float, cuts: list, out_dir: Path, prefix: str, n: int = 4) -> list:
    """Ekrandaki yazıların okunacağı büyük kareler (özgün, çerçeveli görüntüden; uzun kenar 1280 px): farklı çekimlerden, baştan sona
    yayılmış `n` kare. [{"dosya", "saniye"}]."""
    a, b = dur * 0.04, dur * 0.96
    cand = [round((x + y) / 2, 1) for x, y in zip([a] + list(cuts), list(cuts) + [b]) if y - x >= 0.6 and a <= (x + y) / 2 <= b]
    if len(cand) < n:
        cand = [round(a + (k + 0.5) * (b - a) / n, 1) for k in range(n)]
    picks = [cand[round(k * (len(cand) - 1) / max(1, n - 1))] for k in range(n)] if len(cand) > n else cand
    out = []
    for k, t in enumerate(dict.fromkeys(picks), 1):
        f = out_dir / f"{prefix}-{k}.jpg"
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-ss", f"{t:.2f}", "-i", str(p), "-frames:v", "1", "-vf",
                        "scale='if(gt(iw,ih),1280,-2)':'if(gt(iw,ih),-2,1280)'", "-q:v", "3", str(f)], capture_output=True)
        if f.exists():
            out.append({"dosya": f.name, "saniye": t})
    return out


if __name__ == "__main__":
    src = Path(sys.argv[1])
    rect, info = detect(src)
    res = {"ok": True, "crop": rect, **info}
    if rect and "--crop" in sys.argv:
        res["out"] = str(sys.argv[sys.argv.index("--crop") + 1]) if crop(src, rect, Path(sys.argv[sys.argv.index("--crop") + 1])) else None
    print(json.dumps(res, ensure_ascii=False))
