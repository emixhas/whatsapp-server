#!/usr/bin/env python3
"""Paylaşım videosundaki çerçeve ve ekrandaki yazılar (kullanıcı isteği, 19 Ekim: "Instagram'dan video gönderdiğimde bazı haber ve
paylaşım yapanların etrafında çerçevesi oluyor ve bazen linkte açıklama olmuyor; videodaki kelimeleri analiz ederek haber üretebilir miyiz").

Çerçeve tespiti (`detect`): videoya yayılmış 48 kare 108 piksel genişlikte gri okunur (uzun videoda ortadaki iki dakikadan). Her pikselin
zamansal ortancası alınır; karelerin en az %85'inde ortancanın ±8 gri düzeyi içinde kalan piksel durağandır, böylece sıkıştırma gürültüsü,
kısa beyaz geçişler ve arada bir değişen başlık ölçüyü bozmaz. Videonun başında ya da sonunda düzenden farklı, tümüyle durağan bir kart
(giriş, "takip et" kartı) sürenin büyük kısmını kaplasa bile o kareler çıkarılır.

Kırpma hareketli bölgeden değil, çerçevenin kendisine ait olumlu kanıttan çıkar. Ortanca karenin her satırı ve sütunu özetlenir: baskın
renk ve payı, zeminden keskin ayrılan parça sayısı (yazı), keskin öğelerin çevresi dışındaki yerel değişim (doku: fotoğraf, doğal görüntü)
ve hareketli piksel sayısı. Kenardan içeri yürünür. Tasarlanmış bir çerçeve bandı şunlardan oluşur: tam düz renk satırları (ortanca karede
rengi yalnız sıkıştırma gürültüsü kadar oynar), iki yanı aynı zeminle çevrili kısa durağan kümeler (logo, hesap adı, başlık yazısı, panel)
ve tek tek karelerde yazı görülen kısa hareketli şeritler (kayan yazı, değişen başlık, alt yazı). Yürüyüş dokulu satırda, uzun hareketli
bölgede, yazısız hareketli şeritte (yoldaki arabalar) ya da rengi satırdan satıra yavaşça kayan düz bölgede (gökyüzü, ışık süzmesi) durur.
Bandın içe bakan ucundan, çerçeve zemini olduğu gösterilemeyen düz alanlar (içerikteki durağan gökyüzü, duvar) ve içeriğe yapışık kümeler
soyulur: içerikten pay kesmektense biraz fazla almak tercih edilir.

Bantlar ancak karşılıklı ikişer kabul edilir; tek yandaki gökyüzü, duvar ya da fotoğraf hiçbir zaman yetmez. Ya iki bantta da yazı vardır,
ya birinde yazı vardır ve ikisi aynı çerçeve zeminini paylaşır, ya da ikisi aynı düz renkte, yaklaşık eşit kalınlıkta, içeriğe keskin bir
sınırla geçen ve siyaha yakın (sinema bandı) ya da öbür eksenin çerçeve rengindeki bantlardır. Yan bantlar bulunup üst ve alt bantlar
bulunamadıysa üst ve alt yalnız içerik sütunlarında yeniden aranır (yatay karedeki dikey video). Sonra içerik denetlenir: karenin en az
%12'si, içinde hareket var, büyük kısmı çerçeve zemini renginde değil (düz zeminli yazı kartının ortasındaki hareketli simge içerik
sayılmaz) ve bölünmüş ekran değil: içeriğin bir ucunda düz renk olmayan durağan bir görüntü varsa ve sınırında tam genişlikte hareket
başlıyorsa (fotoğraf + video) kırpılmaz. Sınırın hücre içindeki yeri önce küçültmede bant rengiyle içeriğin karıştığı sınır çizgisinden
kestirilir, sonra ana düzenin içinden alınan üç tam çözünürlüklü anahtar karenin ortancasında, kaba sınırın bir hücre yakınında yeniden
bulunur: bant zemini ve ince kenarlık çizgisi atlanır, içerik ilk dokulu çizgide ya da içeri doğru süren düz bölgede başlar. Kırpma
bundan birkaç piksel içeriden yapılır, çerçeve renginden ince çizgi kalmaz. Dönüş bilgisi (eski etiket ya da yeni ffmpeg yan verisi)
okunur. Tespit hiçbir durumda çökmez, kırpmadığında nedenini ("why") söyler. numpy gerekmez.
`crop`: içerik dikdörtgeni kırpılmış kopya (ses aynen). `text_frames`: özgün (çerçeveli) videodan yazıların okunacağı büyük kareler.

  python3 scripts/frame_crop.py VIDEO            # tespit sonucu (JSON)
  python3 scripts/frame_crop.py VIDEO --crop OUT # kırpılmış kopya
"""
import json
import subprocess
import sys
from bisect import bisect_left, bisect_right
from pathlib import Path

SW = 108  # analiz genişliği (piksel)
NF = 48  # okunan kare sayısı
TOL = 8  # bir piksel, zamansal ortancasının ±8 gri düzeyi içindeyse o karede "aynı"
STILL = 0.85  # karelerin en az %85'inde aynı kalan piksel durağandır
SAME = 2.0  # çerçeve zemini ortanca karede tam düzdür: aynı renk sayılan en büyük fark (gri düzeyi)


def _dims(p: Path) -> tuple:
    r = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_streams", "-show_format", "-of", "json", str(p)],
                       capture_output=True, text=True)
    d = json.loads(r.stdout or "{}")
    s = (d.get("streams") or [{}])[0]
    w, h = int(s.get("width") or 0), int(s.get("height") or 0)
    rot = str((s.get("tags") or {}).get("rotate", "0"))
    for sd in s.get("side_data_list") or []:  # yeni ffmpeg dönüşü "display matrix" yan verisinde tutar
        if "rotation" in sd:
            rot = str(sd.get("rotation"))
    try:
        if int(float(rot)) % 180:
            w, h = h, w
    except ValueError:
        pass
    return w, h, float((d.get("format") or {}).get("duration") or 0)


def _frames(p: Path, dur: float, w: int, h: int, n: int = NF) -> tuple:
    sh = max(2, int(round(SW * h / w / 2)) * 2)
    a, b = dur * 0.03, dur * 0.97  # giriş/çıkış animasyonu (çerçevenin kayarak gelmesi) sayılmasın
    if b - a > 120:  # uzun videoda ortadaki iki dakika yeter (okuma süresi sınırlı kalsın)
        a = (dur - 120) / 2
        b = a + 120
    span = max(0.5, b - a)
    size = SW * sh
    for skip in (["-skip_frame", "noref"], []):  # başvurulmayan kareleri çözmemek okumayı yaklaşık yarıya indirir
        raw = subprocess.run(["ffmpeg", "-v", "error"] + skip + ["-ss", f"{a:.2f}", "-t", f"{span:.2f}", "-i", str(p), "-vf",
                              f"fps={n / span:.4f},scale={SW}:{sh}:flags=area,format=gray", "-f", "rawvideo", "-"],
                             capture_output=True, timeout=180).stdout
        fs = [raw[i:i + size] for i in range(0, len(raw) - size + 1, size)]
        if len(fs) >= n // 2:
            break
    return sh, fs, a, a + span


def _full_frames(p: Path, W: int, H: int, t0: float, t1: float) -> list:
    """Sınırın ince ayarı için ana düzenin içinden üç tam çözünürlüklü gri kare. Yalnız anahtar kareler çözülür (istenen anın hemen
    öncesindeki): her biri tek kare çözümü kadar sürer."""
    out = []
    for k in (0.3, 0.5, 0.7):
        raw = subprocess.run(["ffmpeg", "-v", "error", "-skip_frame", "nokey", "-noaccurate_seek", "-ss", f"{t0 + k * (t1 - t0):.2f}",
                              "-i", str(p), "-frames:v", "1", "-vf", "format=gray", "-f", "rawvideo", "-"],
                             capture_output=True, timeout=60).stdout
        if len(raw) >= W * H:
            out.append(raw[:W * H])
    if not out:
        raise ValueError("tam kare okunamadı")
    return out


def _stats(fs: list) -> tuple:
    """Her piksel için zamansal ortanca ve ortancaya yakın kalan karelerin oranı."""
    n = len(fs)
    med, frac = [], []
    lo_i = n // 2
    for t in zip(*fs):
        s = sorted(t)
        m = s[lo_i]
        med.append(m)
        frac.append((bisect_right(s, m + TOL) - bisect_left(s, m - TOL)) / n)
    return med, frac


class _Line:
    """Bir satırın (ya da sütunun) ortanca görüntüdeki özeti: baskın renk ve payı, keskin öğe (yazı) parçaları, doku, hareketli piksel."""
    __slots__ = ("m", "u", "segs", "tx", "nd", "cls", "L")

    def __init__(self, vals: list, dn: int):
        L = len(vals)
        hist = [0] * 262
        for v in vals:
            hist[v + 3] += 1
        best = run = sum(hist[0:7])
        c = 0
        for k in range(1, 256):
            run += hist[k + 6] - hist[k - 1]
            if run > best:
                best, c = run, k
        tot = sum(hist[c + j] * (c + j - 3) for j in range(7))
        m = tot / best if best else float(c)
        self.m, self.u, self.nd, self.L = m, best / max(1, L), dn, max(1, L)
        hcm = [abs(v - m) >= 40 for v in vals]  # zeminden keskin ayrılan piksel (yazı, logo)
        segs, prev = 0, False
        for i, x in enumerate(hcm):
            if x and not prev and i > 0:
                k = i
                while k < L and hcm[k]:
                    k += 1
                segs += k < L  # kenara değen parça (yan bant) sayılmaz
            prev = x
        self.segs = segs
        near = [False] * L
        for i, x in enumerate(hcm):
            if x:
                for j in range(max(0, i - 2), min(L, i + 3)):
                    near[j] = True
        # doku: keskin öğe çevresinde olmayan yerel değişim (fotoğraf, doğal görüntü); düz renkli blok yalnız iki kenarında değişir
        self.tx = sum(1 for i in range(1, L - 1) if not near[i] and max(abs(vals[i] - vals[i - 1]), abs(vals[i] - vals[i + 1])) >= 5)
        if dn >= max(2, 0.02 * L):
            self.cls = "D"  # hareketli
        elif self.u >= 0.85:
            self.cls = "U"  # düz renk
        elif self.tx <= 0.12 * L:
            self.cls = "G"  # düz bloklar ve keskin öğeler (yazı, logo, panel)
        else:
            self.cls = "T"  # doku (fotoğraf, doğal görüntü)


def _zone(ds: list, total: int, strip_text=None) -> tuple:
    """Kenardan içeri, çerçeve olabilecek satırları öğelere ayırır: [tür, başlangıç, bitiş, renk, güçlü yazı var mı, küme var mı].
    "run": aynı düz rengin ardışık satırları; iki yanı aynı renkte düz satırlarla çevrili kısa durağan küme (yazı, logo) bu öğeye
    katılır. "grp": iki yanı farklı düz renkte kısa küme. "strip": iki yanı çerçeve satırı olan kısa hareketli şerit (kayan yazı,
    değişen başlık, alt yazı). Doku, uzun hareket ya da rengi yavaşça kayan düz satırlar (gökyüzü gibi yumuşak geçiş) görülünce durur."""
    out, i, N = [], 0, len(ds)
    # gürültüye göre tolerans: en dıştaki düz bölgenin satır renkleri sıkıştırma yüzünden ne kadar oynuyor
    k0 = next((k for k in range(N) if ds[k].cls == "U"), N)
    ms = [ds[k0].m] if k0 < N else []
    for k in range(k0 + 1, min(N, k0 + 40)):
        if ds[k].cls != "U" or abs(ds[k].m - ds[k - 1].m) > 3:
            break
        ms.append(ds[k].m)
    noise = (sum((x - sum(ms) / len(ms)) ** 2 for x in ms) / len(ms)) ** 0.5 if len(ms) >= 4 else 0.0
    same = min(3.5, SAME + 2 * noise)
    while i < N:
        d = ds[i]
        if d.cls == "U":
            j, lo, hi = i + 1, d.m, d.m
            while j < N and ds[j].cls == "U" and abs(ds[j].m - ds[j - 1].m) <= 3:
                lo, hi = min(lo, ds[j].m), max(hi, ds[j].m)
                j += 1
            if hi - lo > same:  # yumuşak geçiş: gökyüzü, ışık süzmesi; tasarlanmış çerçeve zemini ortanca karede tam düzdür
                break
            c = (lo + hi) / 2
            if out and out[-1][0] == "run" and out[-1][2] == i and abs(out[-1][3] - c) <= same:
                out[-1][2] = j  # kümeden sonra aynı zemin sürüyor
            else:
                out.append(["run", i, j, c, False, False])
            i = j
            continue
        j = i
        while j < N and ds[j].cls != "U":
            j += 1
        g = j - i
        nd = sum(1 for k in range(i, j) if ds[k].cls == "D")
        tex = sum(ds[k].tx for k in range(i, j)) / (g * d.L)
        bgsh = sum(ds[k].u for k in range(i, j)) / g
        text = sum(1 for k in range(i, j) if ds[k].segs >= 5) >= 2
        sand = bool(out) and out[-1][0] == "run" and out[-1][2] == i and j < N and abs(ds[j].m - out[-1][3]) <= same
        # kısa küme: dokusu az (düz bloklar, kalın yazı) ya da satırların çoğu zemin rengi (seyrek küçük yazı); fotoğraf şeridi ikisi de
        # değil. Birkaç satırlık küçük yazı küçültülmüş karede dokuya benzer: iki yanı aynı zeminse dokusuna bakılmaz.
        if g <= 0.08 * total and j < N and (tex <= 0.3 or bgsh >= 0.55 or (sand and g <= 0.02 * total)) and (out or nd == 0):
            if sand:
                out[-1][2] = j
                out[-1][4] |= text
                out[-1][5] = True
            else:
                out.append(["grp", i, j, None, text, True])
            i = j
            continue
        if strip_text and out and j < N and nd * 2 >= g and g <= 0.15 * total and strip_text(i, j):
            out.append(["strip", i, j, None, True, True])
            i = j
            continue
        break
    return out, same


def _band(zs: tuple, known: list, total: int) -> dict:
    """Bölgenin içteki ucundan, çerçeveye ait olduğu gösterilemeyen öğeleri soyar: bilinen çerçeve renginde olmayan ve içinde yazı
    bulunmayan düz alan (içeriğin durağan bir parçası olabilir), içeriğe yapışık küme ya da şerit. Kalan bant ve kanıtı."""
    z, same = list(zs[0]), zs[1]
    while z and not (z[-1][0] == "run" and (z[-1][4] or any(abs(z[-1][3] - k) <= same for k in known))):
        z.pop()
    n = z[-1][2] if z else 0
    graphic = any(e[4] for e in z)
    uni = len(z) == 1 and not z[0][5]
    col = next((e[3] for e in z if e[0] == "run"), None)
    return {"n": n, "graphic": graphic, "uniform": uni, "color": round(col, 1) if col is not None else None,
            "ok": n >= 2 and n >= 0.02 * total, "colors": [round(e[3], 1) for e in z if e[0] == "run"], "tol": same}


def _pair(a: dict, b: dict, other: list) -> bool:
    """Karşılıklı iki bant birlikte çerçeve mi: ikisi de var ve en az birinde yazı ya da hareketli yazı şeridi var; ya da ikisi de aynı
    düz renkte, yaklaşık eşit kalınlıkta, içeriğe keskin bir sınırla geçiyor ve bu renk siyaha yakın (sinema bandı) ya da öbür
    eksendeki çerçeve bantlarının rengi. Tek yandaki bant (yalnız üstte gökyüzü, duvar, başlık) hiçbir zaman yetmez."""
    if not (a["ok"] and b["ok"]):
        return False
    if a["graphic"] and b["graphic"]:
        return True
    tol = max(a["tol"], b["tol"])
    if (a["graphic"] or b["graphic"]) and any(abs(x - y) <= tol for x in a["colors"] for y in b["colors"]):
        return True  # yazılı bant ve karşısındaki bant aynı çerçeve zemininden (şablon zemini iki yanda da görünür)
    if not (a["uniform"] and b["uniform"] and abs(a["color"] - b["color"]) <= 6 and a["sharp"] and b["sharp"]):
        return False
    if abs(a["n"] - b["n"]) > 0.2 * max(a["n"], b["n"]) + 2:
        return False
    return a["color"] <= 40 or any(k is not None and abs(a["color"] - k) <= 4 for k in other)


def _line_vals(med, w, axis, i, a0, a1):
    return med[i * w + a0:i * w + a1] if axis == "row" else [med[y * w + i] for y in range(a0, a1)]


def _sharp(med, w, axis, idx, a0, a1, color) -> bool:
    """Bandın bittiği yerden sonraki iki çizginin birinde piksellerin en az %60'ı bant renginden belirgin farklı mı (düz, keskin sınır)."""
    for i in idx:
        if i < 0 or i >= (len(med) // w if axis == "row" else w):
            continue
        v = _line_vals(med, w, axis, i, a0, a1)
        if v and sum(1 for x in v if abs(x - color) >= 12) >= 0.6 * len(v):
            return True
    return False


def _lines(med, dyn, w, h, axis, a0, a1):
    """axis "row": a0..a1 sütun aralığında her satır; "col": a0..a1 satır aralığında her sütun."""
    out = []
    if axis == "row":
        for y in range(h):
            out.append(_Line(med[y * w + a0:y * w + a1], sum(dyn[y * w + a0:y * w + a1])))
    else:
        for x in range(w):
            out.append(_Line([med[y * w + x] for y in range(a0, a1)], sum(dyn[y * w + x] for y in range(a0, a1))))
    return out


def _subcell(med, w, axis, k, nxt, a0, a1, color) -> float:
    """İlk içerik çizgisinin (k) ne kadarı içerik: alan ortalamasıyla küçültülmüş karede sınır çizgisi bant rengi ile içeriğin karışımıdır;
    içerikle zemin arasında yeterli fark olan piksellerde karışım oranının ortancası (0-1). Ölçülemezse 1 (çizginin tamamı içerik)."""
    vk, vn = _line_vals(med, w, axis, k, a0, a1), _line_vals(med, w, axis, nxt, a0, a1)
    r = sorted((x - color) / (y - color) for x, y in zip(vk, vn) if abs(y - color) >= 25)
    if len(r) < 0.15 * len(vk):
        return 1.0
    return min(1.0, max(0.0, r[len(r) // 2]))


def _analyse(fs: list, w: int, h: int) -> tuple:
    med, frac = _stats(fs)
    dyn = bytearray(1 if f < STILL else 0 for f in frac)
    rows = _lines(med, dyn, w, h, "row", 0, w)
    probe = [fs[len(fs) * k // 6] for k in range(1, 6)]

    def text_rows(y0, y1):
        """Hareketli şeritte tek tek karelerde yazı var mı (kayan yazı, değişen başlık, alt yazı); araba, insan gibi hareket yazı değildir."""
        hits = 0
        for f in probe:
            if sum(1 for y in range(y0, y1) if _Line(list(f[y * w:(y + 1) * w]), 0).segs >= 5) >= 2:
                hits += 1
        return hits >= 2

    def vertical(rows, x0, x1, other):
        """Üst ve alt bant (x0..x1 sütunlarında) ve birlikte çerçeve sayılıp sayılmadıkları."""
        zt = _zone(rows, h, text_rows)
        zb = _zone(rows[::-1], h, lambda i, j: text_rows(h - j, h - i))
        known = [next(e[3] for e in z[0] if e[0] == "run") for z in (zt, zb) if any(e[0] == "run" for e in z[0])]
        bt, bb = _band(zt, known, h), _band(zb, known, h)
        if bt["ok"]:
            bt["sharp"] = _sharp(med, w, "row", (bt["n"], bt["n"] + 1), x0, x1, bt["color"])
        if bb["ok"]:
            bb["sharp"] = _sharp(med, w, "row", (h - 1 - bb["n"], h - 2 - bb["n"]), x0, x1, bb["color"])
        ok = _pair(bt, bb, other) and h - bb["n"] - bt["n"] >= 0.1 * h
        return bt, bb, known, ok

    bt, bb, known, ok = vertical(rows, 0, w, [])
    top, bot = (bt["n"], h - bb["n"]) if ok else (0, h)
    cols = _lines(med, dyn, w, h, "col", top, bot)
    zl, zr = _zone(cols, w), _zone(cols[::-1], w)
    known2 = known + [next(e[3] for e in z[0] if e[0] == "run") for z in (zl, zr) if any(e[0] == "run" for e in z[0])]
    bl, br = _band(zl, known2, w), _band(zr, known2, w)
    if bl["ok"]:
        bl["sharp"] = _sharp(med, w, "col", (bl["n"], bl["n"] + 1), top, bot, bl["color"])
    if br["ok"]:
        br["sharp"] = _sharp(med, w, "col", (w - 1 - br["n"], w - 2 - br["n"]), top, bot, br["color"])
    left, right = 0, w
    if _pair(bl, br, [bt["color"], bb["color"]] if ok else []) and w - br["n"] - bl["n"] >= 0.1 * w:
        left, right = bl["n"], w - br["n"]
        if not ok:  # yan bantlar bulundu: üst/alt bantlar yalnız içerik sütunlarında aranır (dikey videonun yatay karede durması)
            sub = _lines(med, dyn, w, h, "row", left, right)
            bt2, bb2, _, ok2 = vertical(sub, left, right, [bl["color"], br["color"]])
            if ok2:
                bt, bb, top, bot = bt2, bb2, bt2["n"], h - bb2["n"]
    info = {"ust": bt, "alt": bb, "sol": bl, "sag": br}
    info["satirlar"] = "".join(r.cls for r in rows)
    if (top, bot, left, right) == (0, h, 0, w):
        return None, {**info, "why": "çerçeve kanıtı yok"}
    area = (bot - top) * (right - left) / (w * h)
    info["area"] = round(area, 2)
    if area < 0.12:
        return None, {**info, "why": "içerik alanı çok küçük"}
    npx = (bot - top) * (right - left)
    moving = sum(dyn[y * w + x] for y in range(top, bot) for x in range(left, right))
    if moving < 0.005 * npx:
        return None, {**info, "why": "içerikte hareket yok"}
    # içerik çerçeveden farklı bir görüntü olmalı: büyük kısmı bant zemin rengindeyse (düz zeminli yazı kartı, küçük hareketli simge)
    # ortadaki hareketli parça içerik değil, kartın kendisi videodur
    bg = [b["color"] for b, on in ((bt, top > 0), (bb, bot < h), (bl, left > 0), (br, right < w)) if on and b["color"] is not None]
    same = sum(1 for y in range(top, bot) for x in range(left, right) if any(abs(med[y * w + x] - c) <= 4 for c in bg))
    info["zemin_payi"] = round(same / npx, 2)
    if same >= 0.5 * npx:
        return None, {**info, "why": "içerik çoğunlukla çerçeve zemini renginde (yazı kartı)"}
    # bölünmüş ekran: içeriğin bir ucu düz renk olmayan durağan bir görüntü (fotoğraf, ikinci bir kare), sınırında tam genişlikte hareket
    # başlıyor; gökyüzü gibi düz/yumuşak durağan kısım bölünme sayılmaz
    sub = rows[top:bot] if (left, right) == (0, w) else _lines(med, dyn, w, h, "row", left, right)[top:bot]
    subc = _lines(med, dyn, w, h, "col", top, bot)[left:right]
    for seq in (sub, sub[::-1], subc, subc[::-1]):
        L = seq[0].L if seq else 1
        k = 0
        while k < len(seq) and seq[k].nd < max(2, 0.02 * L):
            k += 1
        if k >= 0.2 * len(seq) and k + 2 < len(seq) and all(seq[k + j].nd >= 0.3 * L for j in range(2)):
            if sum(1 for q in seq[:k] if q.cls != "U") >= 0.5 * k:
                return None, {**info, "why": "bölünmüş ekran: durağan görüntü + video"}
    # sınırın hücre içi konumu (çerçeve renginden ince çizgi kalmasın)
    f = {"ust": top, "alt": h - bot, "sol": left, "sag": w - right}
    if top:
        f["ust"] = top + 1 - _subcell(med, w, "row", top, top + 1, left, right, bt["color"])
    if bot < h:
        f["alt"] = h - bot + 1 - _subcell(med, w, "row", bot - 1, bot - 2, left, right, bb["color"])
    if left:
        f["sol"] = left + 1 - _subcell(med, w, "col", left, left + 1, top, bot, bl["color"])
    if right < w:
        f["sag"] = w - right + 1 - _subcell(med, w, "col", right - 1, right - 2, top, bot, br["color"])
    renk = {"ust": bt["colors"], "alt": bb["colors"], "sol": bl["colors"], "sag": br["colors"]}
    return f, {**info, "why": "çerçeve", "_renkler": renk}


def _cards(fs: list) -> tuple:
    """Videonun başında ya da sonunda ana düzenden farklı, tümüyle durağan bir kart (giriş/kapanış, "takip et" kartı) varsa o kareler
    çıkarılır; kart sürenin büyük kısmını kaplasa da kalan karelerde çerçeve aranabilsin."""
    n = len(fs)
    if n < 24:
        return fs, None, (0.0, 1.0)
    step = 7
    idx = range(0, len(fs[0]), step)

    def diff(a, b):
        return sum(abs(a[i] - b[i]) for i in idx) / len(idx)
    d = [diff(fs[j], fs[j + 1]) for j in range(n - 1)]
    a = 0
    while a < n - 1 and d[a] <= 1.5:
        a += 1
    b = 0
    while b < n - 1 and d[n - 2 - b] <= 1.5:
        b += 1
    a, b = a + 1 if a else 0, b + 1 if b else 0
    keep, why = list(range(n)), None
    if b >= 0.15 * n and n - b >= 12 and diff(fs[-1], fs[(n - b) // 2]) >= 10:
        keep, why = keep[:n - b], f"son {b} kare durağan kart"
    if a >= 0.15 * n and len(keep) - a >= 12 and diff(fs[0], fs[a + (len(keep) - a) // 2]) >= 10:
        keep, why = keep[a:], (why + ", " if why else "") + f"ilk {a} kare durağan kart"
    return [fs[i] for i in keep], why, (keep[0] / n, (keep[-1] + 1) / n)


def _refine(fr: list, W: int, H: int, res: dict, sx: float, sy: float, colors: dict) -> dict:
    """Her sınırı tam çözünürlükte, kaba sınırın bir hücre yakınında yeniden bulur: dıştan içe, bant renginde düz çizgiler ve iç tarafı
    keskin bir adımla biten ince düz çizgiler (kenarlık) atlanır; içerik ilk dokulu çizgide ya da içeri doğru süren düz bölgede (gökyüzü)
    başlar. Sınır kaba kestirimden en çok bir hücre oynar."""
    def med(i):
        v = sorted(f[i] for f in fr)
        return v[len(v) // 2]

    def line(axis, k, a0, a1):
        step = max(1, (a1 - a0) // 400)
        if axis == "row":
            return [med(k * W + x) for x in range(a0, a1, step)]
        return [med(y * W + k) for y in range(a0, a1, step)]

    out = dict(res)
    x0, x1 = int(res["sol"] * sx), int(W - res["sag"] * sx)
    y0, y1 = int(res["ust"] * sy), int(H - res["alt"] * sy)
    for side, axis, cell, size, a0, a1 in (("ust", "row", sy, H, x0, x1), ("alt", "row", sy, H, x0, x1),
                                           ("sol", "col", sx, W, y0, y1), ("sag", "col", sx, W, y0, y1)):
        if not res[side] or a1 - a0 < 8:
            continue
        c = res[side] * cell  # kenardan içeriğe uzaklık (piksel)
        lo, hi = max(0, int(c - 1.5 * cell)), min(size // 2, int(c + 1.5 * cell) + 1)
        seq = []
        for d in range(lo, hi):
            k = d if side in ("ust", "sol") else size - 1 - d
            v = line(axis, k, a0, a1)
            m = sorted(v)[len(v) // 2]
            seq.append((d, m, sum(1 for x in v if abs(x - m) <= 6) >= 0.9 * len(v)))
        def skip(i):
            """Bu düz çizgi dizisi çerçeveye mi ait (bant zemini ya da ince kenarlık): atlanınca gelinen yer, değilse None."""
            j = i + 1
            while j < len(seq) and seq[j][2] and abs(seq[j][1] - seq[j - 1][1]) <= 6:
                j += 1
            if any(abs(seq[i][1] - q) <= 6 for q in colors.get(side) or []):
                return j  # bant zemini
            if j < len(seq) and seq[j - 1][0] - seq[i][0] + 1 <= max(3, cell):
                return j  # ince kenarlık çizgisi
            return None

        start, i = None, 0
        while i < len(seq):
            if seq[i][2]:
                j = skip(i)
            else:  # sıkıştırmanın bıraktığı 1-2 piksellik geçiş, ardından yine çerçeve çizgisi geliyorsa atlanır
                k = next((k for k in range(i + 1, min(len(seq), i + 3)) if seq[k][2]), None)
                j = skip(k) if k is not None else None
            if j is None:
                start = seq[i][0]
                break
            i = j
        if start is None:
            start = seq[-1][0] + 1 if seq else c
        out[side] = min(c + cell, max(c - cell, start)) / cell
    return out


def detect(p: Path, dur: float | None = None) -> tuple:
    """(kırpma {x, y, w, h, W, H} ya da None, ayrıntı {neden, bantlar…})."""
    try:
        W, H, d = _dims(Path(p))
        dur = dur or d
        if not W or not H or dur < 2:
            return None, {"why": "video okunamadı ya da çok kısa"}
        h, fs, a, b = _frames(Path(p), dur, W, H)
    except Exception as e:
        return None, {"why": f"kareler alınamadı: {str(e)[:80]}"}
    try:
        return _detect(fs, SW, h, W, H, lambda span: _full_frames(Path(p), W, H, a + span[0] * (b - a), a + span[1] * (b - a)))
    except Exception as e:  # tespit hiçbir durumda çökmemeli
        return None, {"why": f"tespit hatası: {type(e).__name__}: {str(e)[:80]}"}


def _detect(fs: list, w: int, h: int, W: int, H: int, full=None) -> tuple:
    fs, card, span = _cards(fs)
    if len(fs) < 12:
        return None, {"why": "az kare"}
    res, info = _analyse(fs, w, h)
    if card:
        info["kart"] = card
    if not res:
        return None, info
    sx, sy = W / w, H / h
    cols = info.pop("_renkler", {})
    if full:
        try:
            res = _refine(full(span), W, H, res, sx, sy, cols)
            info["ince_ayar"] = True
        except Exception as e:  # ince ayar yapılamazsa hücre içi kestirim kalır
            info["ince_ayar"] = f"yapılamadı: {type(e).__name__}"
    ins = max(2, 0.0015 * max(W, H))  # karışık sınır pikselleri de kalmasın diye birkaç piksel içeri
    x0, x1 = res["sol"] * sx + (ins if res["sol"] else 0), W - res["sag"] * sx - (ins if res["sag"] else 0)
    y0, y1 = res["ust"] * sy + (ins if res["ust"] else 0), H - res["alt"] * sy - (ins if res["alt"] else 0)
    X, Y = -(-int(x0 + 0.999) // 2) * 2, -(-int(y0 + 0.999) // 2) * 2
    rect = {"x": X, "y": Y, "w": max(2, int(x1 - X) // 2 * 2), "h": max(2, int(y1 - Y) // 2 * 2), "W": W, "H": H}
    info["bant_px"] = {k: round(v * (sy if k in ("ust", "alt") else sx)) for k, v in res.items()}
    info["pct"] = {k: round(v / (h if k in ("ust", "alt") else w) * 100) for k, v in res.items()}  # wa_video kaydı bunu yazar
    return rect, info


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
