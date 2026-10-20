#!/usr/bin/env python3
"""Benzer videonun sahne çizimleri (kullanıcı isteği, 19 Ekim: "o videodaki gibi sıfırdan video üretmesini"): Claude'un yazdığı SVG
güvenli ve düzenli hale getirilir, Remotion `SvgScene` (src/SvgScene.tsx) onu sayfaya satır içi koyar ve grupları sırayla gösterir.

Güvenlik (satır içi SVG sayfanın bir parçasıdır): yalnız çizim öğeleri ve öznitelikleri kalır (beyaz liste). script, foreignObject,
image, iframe, style, a, animasyon (animate/set: kare zamanından bağımsız oynar) ve bilinmeyen öğeler çocuklarıyla atılır; on* olay
öznitelikleri, "#" ile başlamayan href/xlink:href atılır. Dış kaynak yok (inceleme, 19 Ekim: image-set("http…"), CSS kaçışı "\\75 rl(",
kapanmamış "url(http…" ve kökün style'ındaki background-image iki katmandan da geçip tarayıcıya resim indirtiyordu): değerde yalnız
düzgün iç başvuru url(#ad) kalabilir; o çıkarıldıktan sonra url( kalan, ters bölü, image-set, image(, cross-fade, element(, src(, attr(, ://,
data:, javascript:, @import, expression içeren öznitelik ya da style bildirimi atılır; style'da yalnız görünüm özellikleri (fill, stroke…,
opacity, font-…; background, mask-image, content yok), kökün style'ı hiç kalmaz. <use> çoğaltması sınırlı (iç içe <use> bombası: altı
düzey × 10 kopya bir milyon şekil çizdirip çizim süresini bitiriyordu): en çok 200 <use>, açılınca en çok 2000 öğe; aşan ya da döngülü
çizim yedeğe düşer. <style> sayfanın tamamına uygulanacağı için hiç kalmaz; içindeki basit kurallar (".sinif{…}", "path{…}") öğelerin
style özniteliğine taşınır. class öznitelikleri atılır (sahnenin kendi rN grupları karışmasın), id'ler "c-" önekiyle yeniden
adlandırılır (sayfadaki kimliklerle çakışmasın).
Düzen: kök viewBox geçerliyse kalır (yoksa "0 0 1080 1920"), preserveAspectRatio "xMidYMid meet", width/height atılır; kökün her çizim
çocuğu <g class='rN'> içine alınır (N = 0..adet-1, 24'ten fazlası sonuncuda birleşir; tek <g> varsa içine inilir): SvgScene grupları
bu sırayla belirtir. XML ayrıştırılamazsa hoşgörülü ayrıştırıcıyla (html.parser: kapanmamış öğe, &nbsp;, tırnaksız öznitelik) denenir;
boş, bozuk ya da çok büyük çizimde `fallback()` sade bir sahne çizer: üretim hiç düşmez.

  python3 scripts/scene_svg.py DOSYA.svg       # deneme: temizlenmiş SVG ve grup sayısı
"""
import html
import re
import sys
import xml.etree.ElementTree as ET
from html.parser import HTMLParser

VIEWBOX = "0 0 1080 1920"
MAX_GROUPS = 24
MAX_IN, MAX_OUT, MAX_NODES, MAX_DEPTH = 200_000, 60_000, 1500, 24  # bayt, bayt, öğe, iç içe derinlik
MAX_USE, MAX_DRAWN = 200, 2000  # <use> sayısı, <use>'lar açılınca çizilen öğe (iç içe <use> bombası)
DEFAULT_PALETTE = ["#F3E6C8", "#D9BF8C", "#A9825A", "#6B4A2F", "#2E2118"]  # sıcak kâğıt, sepya
TAGS = {t.lower(): t for t in (
    "svg", "g", "path", "rect", "circle", "ellipse", "line", "polyline", "polygon", "defs", "linearGradient", "radialGradient", "stop",
    "clipPath", "mask", "pattern", "use", "symbol", "text", "tspan", "filter", "feGaussianBlur", "feOffset", "feBlend",
    "feColorMatrix", "feTurbulence", "feDisplacementMap", "feMerge", "feMergeNode", "feFlood", "feComposite", "feMorphology", "feDropShadow")}
UNWRAP = {"a", "switch"}  # öğe atılır, çocukları kalır
NO_DRAW = {"defs", "linearGradient", "radialGradient", "clipPath", "mask", "pattern", "symbol", "filter"}
ATTRS = {a.lower(): a for a in (
    "id", "d", "points", "x", "y", "x1", "y1", "x2", "y2", "cx", "cy", "r", "rx", "ry", "fx", "fy", "width", "height", "dx", "dy", "rotate",
    "viewBox", "preserveAspectRatio", "transform", "fill", "fill-opacity", "fill-rule", "stroke", "stroke-width", "stroke-opacity",
    "stroke-linecap", "stroke-linejoin", "stroke-dasharray", "stroke-dashoffset", "stroke-miterlimit", "opacity", "color", "style",
    "clip-path", "clip-rule", "mask", "filter", "href", "offset", "stop-color", "stop-opacity", "gradientUnits", "gradientTransform",
    "spreadMethod", "patternUnits", "patternContentUnits", "patternTransform", "clipPathUnits", "maskUnits", "maskContentUnits",
    "filterUnits", "primitiveUnits", "stdDeviation", "in", "in2", "result", "mode", "type", "values", "baseFrequency", "numOctaves", "seed",
    "stitchTiles", "scale", "xChannelSelector", "yChannelSelector", "operator", "k1", "k2", "k3", "k4", "radius", "flood-color",
    "flood-opacity", "font-size", "font-weight", "font-style", "font-family", "text-anchor", "dominant-baseline", "letter-spacing",
    "visibility", "display", "pathLength", "vector-effect", "paint-order", "mix-blend-mode")}
# dış kaynak ya da betik getirebilen değer (CSS kaçışı \75 rl( / u\rl( ters bölüyle; resim işlevleri url'siz adres alır)
BAD_VALUE = re.compile(r"javascript:|vbscript:|data:|expression\s*\(|@import|behavio(?:u)?r\s*:|-moz-binding|<|>|\\|image-set|image\s*\(|"
                       r"cross-fade|element\s*\(|src\s*\(|attr\s*\(|://", re.I)
INNER = re.compile(r"url\(\s*(['\"]?)#([\w.-]{1,60})\1\s*\)", re.I)  # düzgün iç başvuru url(#ad); başka her url( atılır (kapanmamışı da)
# style özniteliğinde kalan özellikler: yalnız görünüm (background*, mask-image, -webkit-mask*, content, cursor… dış resim alabilir)
STYLE_PROPS = {
    "fill", "fill-opacity", "fill-rule", "stroke", "stroke-width", "stroke-opacity", "stroke-linecap", "stroke-linejoin", "stroke-dasharray",
    "stroke-dashoffset", "stroke-miterlimit", "opacity", "color", "clip-path", "clip-rule", "mask", "filter", "stop-color", "stop-opacity",
    "flood-color", "flood-opacity", "lighting-color", "font-size", "font-weight", "font-style", "font-family", "font-variant", "text-anchor",
    "dominant-baseline", "letter-spacing", "word-spacing", "text-decoration", "visibility", "display", "paint-order", "vector-effect",
    "mix-blend-mode", "isolation", "transform", "transform-origin", "transform-box", "shape-rendering", "color-interpolation-filters"}
MAX_TEXT, MAX_TEXTS = 40, 6  # sahnede yazı yalnız küçük etiket: en çok 6 yazı öğesi, her biri 40 karakter


class _Node:
    __slots__ = ("tag", "attrs", "text", "tail", "kids")

    def __init__(self, tag: str, attrs: dict):
        self.tag, self.attrs, self.text, self.tail, self.kids = tag, attrs, "", "", []


def _local(name: str) -> str:
    return name.rsplit("}", 1)[-1].split(":")[-1]


def _from_etree(e) -> _Node:
    n = _Node(_local(e.tag) if isinstance(e.tag, str) else "", {_local(k): v for k, v in e.attrib.items()})
    n.text = e.text or ""
    for c in e:
        k = _from_etree(c)
        k.tail = c.tail or ""
        n.kids.append(k)
    return n


LEAF = {"path", "rect", "circle", "ellipse", "line", "polyline", "polygon", "stop", "use", "image"} | {t for t in TAGS if t.startswith("fe")} - {"femerge"}


class _Loose(HTMLParser):
    """Hoşgörülü ayrıştırma (XML bozuksa): html.parser adları küçük harfe çevirir; bilinen SVG adları geri büyük/küçük yazılır.
    Kapanmamış şekil öğesi (<rect …>, <path …>) yeni öğe gelince kapanır: sonraki şekil onun içine girip görünmez olmasın."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.root = _Node("#root", {})
        self.stack = [self.root]

    def handle_starttag(self, tag, attrs):
        while len(self.stack) > 1 and self.stack[-1].tag.lower() in LEAF:
            self.stack.pop()
        n = _Node(TAGS.get(tag, tag), {ATTRS.get(_local(k), _local(k)): (v or "") for k, v in attrs})
        self.stack[-1].kids.append(n)
        self.stack.append(n)  # kapanmamış öğe üstündeki kapanışa kadar açık kalır (handle_endtag)

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        self.stack.pop()

    def handle_endtag(self, tag):
        for i in range(len(self.stack) - 1, 0, -1):  # kapanmamış öğeler bu kapanışla biter
            if self.stack[i].tag.lower() == tag:
                del self.stack[i:]
                return

    def handle_data(self, data):
        cur = self.stack[-1]
        if cur.kids:
            cur.kids[-1].tail += data
        else:
            cur.text += data


def _parse(src: str):
    m = re.search(r"<svg\b.*</svg\s*>", src, re.S | re.I) or re.search(r"<svg\b.*", src, re.S | re.I)
    if not m:
        return None
    s = m.group(0)
    try:
        return _from_etree(ET.fromstring(s))
    except ET.ParseError:
        pass
    p = _Loose()
    try:
        p.feed(s)
        p.close()
    except Exception:
        return None
    return next((k for k in p.root.kids if k.tag.lower() == "svg"), None)


def _bad(v: str) -> bool:
    """Değer dış kaynak getirebilir mi: düzgün url(#ad)'ler çıkarıldıktan sonra url( kalıyorsa (dış adres, kapanmamış url) ya da
    BAD_VALUE (ters bölü, image-set…) varsa."""
    rest = INNER.sub(" ", v)
    return bool(BAD_VALUE.search(v) or BAD_VALUE.search(rest) or re.search(r"url\s*\(", rest, re.I))


def _inner(v: str) -> str:
    """url(#ad) → url(#c-ad) (kimlikler önekli)."""
    return INNER.sub(lambda m: f"url(#c-{m.group(2)})", v)


def _clean_style(v: str) -> str:
    out = []
    for decl in v.split(";"):
        if ":" not in decl:
            continue
        k, val = (x.strip() for x in decl.split(":", 1))
        if k.lower() not in STYLE_PROPS or not val or len(val) > 200 or _bad(val):
            continue
        out.append(f"{k.lower()}:{val}")
    return ";".join(out)


def _rules(css: str) -> list:
    """<style> içindeki basit kurallar [(seçici türü, ad, bildirimler)]: ".ad{…}", "path{…}", virgülle birden çok seçici."""
    out = []
    css = re.sub(r"@[^;{}]*;", "", re.sub(r"/\*.*?\*/", "", css, flags=re.S))  # @import … ; atılır (@media içindeki kurallar kalır)
    for sel, body in re.findall(r"([^{}@]+)\{([^{}]*)\}", css):
        decl = _clean_style(body)
        if not decl:
            continue
        for one in sel.split(";")[-1].split(","):
            one = one.strip()
            if re.fullmatch(r"\.[\w-]{1,40}", one):
                out.append(("class", one[1:], decl))
            elif re.fullmatch(r"[a-zA-Z]{1,20}", one):
                out.append(("tag", one.lower(), decl))
    return out


def _collect_styles(n: _Node, acc: list) -> None:
    for k in n.kids:
        if k.tag.lower() == "style":
            acc.extend(_rules(k.text + "".join(x.text + x.tail for x in k.kids)))
        else:
            _collect_styles(k, acc)


def _sanitize(n: _Node, rules: list, stats: dict, depth: int = 0):
    """Beyaz listeye göre temiz kopya (ya da None: öğe çocuklarıyla atılır; liste: öğe atılır, çocukları kalır)."""
    tag = TAGS.get(n.tag.lower())
    if n.tag.lower() in UNWRAP:
        return [x for k in n.kids for x in _as_list(_sanitize(k, rules, stats, depth + 1))]
    if not tag or depth > MAX_DEPTH:
        return None
    stats["nodes"] += 1
    if stats["nodes"] > MAX_NODES:
        return None
    classes = (n.attrs.get("class") or "").split()
    pre = [d for kind, name, d in rules if (kind == "tag" and name == tag.lower()) or (kind == "class" and name in classes)]
    attrs = {}
    for k, v in n.attrs.items():
        name = ATTRS.get(k.lower())
        v = str(v or "").strip()
        if not name or k.lower().startswith("on") or len(v) > 20000:
            continue
        if name == "href":
            if not v.startswith("#") or not re.fullmatch(r"#[\w.-]{1,60}", v):
                continue
            v = "#c-" + v[1:]
        elif name == "style":
            v = _clean_style(v)
        elif name == "id":
            if not re.fullmatch(r"[\w.-]{1,60}", v):
                continue
            v = "c-" + v
        else:
            if _bad(v):
                continue
            v = _inner(v)
        if v:
            attrs[name] = v
    if pre:  # <style> kuralları öğenin kendi style'ından önce (kendi yazdığı kazanır)
        attrs["style"] = ";".join([*pre, *([attrs["style"]] if attrs.get("style") else [])])
    if attrs.get("style"):  # url(#ad) → url(#c-ad) (kimlikler önekli; _clean_style yalnız url(#…) bırakır)
        attrs["style"] = _inner(attrs["style"])
    out = _Node(tag, attrs)
    if tag in ("text", "tspan"):
        if tag == "text":
            stats["texts"] += 1
            if stats["texts"] > MAX_TEXTS:
                return None
        out.text = re.sub(r"\s+", " ", n.text)[:MAX_TEXT]
    for k in n.kids:
        for c in _as_list(_sanitize(k, rules, stats, depth + 1)):
            if tag in ("text", "tspan"):
                c.tail = re.sub(r"\s+", " ", k.tail)[:MAX_TEXT]
            out.kids.append(c)
    return out


def _as_list(x) -> list:
    return [] if x is None else x if isinstance(x, list) else [x]


def _esc(v: str) -> str:
    return html.escape(str(v), quote=True).replace("&#x27;", "&#39;")


def _ser(n: _Node) -> str:
    a = "".join(f" {k}='{_esc(v)}'" for k, v in n.attrs.items())
    inner = html.escape(n.text, quote=False) + "".join(_ser(k) + html.escape(k.tail, quote=False) for k in n.kids)
    return f"<{n.tag}{a}>{inner}</{n.tag}>" if inner else f"<{n.tag}{a}/>"


def _viewbox(v) -> str:
    try:
        x = [float(t) for t in re.split(r"[\s,]+", str(v or "").strip())]
    except ValueError:
        return VIEWBOX
    return " ".join(f"{t:g}" for t in x) if len(x) == 4 and x[2] > 0 and x[3] > 0 and all(abs(t) < 1e6 for t in x) else VIEWBOX


def _drawable(n: _Node) -> bool:
    return n.tag not in NO_DRAW


def _drawn(root: _Node) -> int:
    """<use>'lar açılınca çizilecek öğe sayısı (en çok MAX_DRAWN + 1): her öğe 1 + çocukları, <use> ayrıca hedefinin tamamı (ilk aynı
    id'li öğe; tarayıcı da onu alır). Döngülü başvuru (kendini içeren <use>) ve MAX_USE'dan çok <use> sınırı aşmış sayılır."""
    ids, uses = {}, 0
    todo = [root]
    while todo:  # belge sırası
        n = todo.pop()
        if n.attrs.get("id"):
            ids.setdefault(n.attrs["id"], n)
        uses += n.tag == "use"
        todo.extend(reversed(n.kids))
    if uses > MAX_USE:
        return MAX_DRAWN + 1
    memo, busy = {}, set()

    def size(n: _Node) -> int:
        if id(n) in memo:
            return memo[id(n)]
        if id(n) in busy:
            return MAX_DRAWN + 1
        busy.add(id(n))
        t = 1 + sum(size(k) for k in n.kids)
        ref = ids.get(str(n.attrs.get("href") or "")[1:]) if n.tag == "use" else None
        if ref is not None:
            t += size(ref)
        busy.discard(id(n))
        memo[id(n)] = min(t, MAX_DRAWN + 1)
        return memo[id(n)]
    return size(root)


def sanitize(src) -> tuple:
    """(temiz SVG, grup sayısı); kullanılamıyorsa ("", 0). Hiçbir girdide hata fırlatmaz (çok derin iç içe öğe dahil)."""
    if not isinstance(src, str) or not src.strip() or len(src) > MAX_IN:
        return "", 0
    try:
        return _sanitize_root(src)
    except (RecursionError, ValueError, TypeError, AttributeError, IndexError):
        return "", 0


def _sanitize_root(src: str) -> tuple:
    root = _parse(src.replace("\\'", "'"))
    if root is None or root.tag.lower() != "svg":
        return "", 0
    rules, stats = [], {"nodes": 0, "texts": 0}
    _collect_styles(root, rules)
    clean = _sanitize(root, rules, stats)
    if not isinstance(clean, _Node) or _drawn(clean) > MAX_DRAWN:
        return "", 0
    # kökün style'ı hiç kalmaz (background-image sahnenin tamamını kaplıyordu)
    keep = {k: v for k, v in clean.attrs.items() if k not in ("width", "height", "x", "y", "viewBox", "preserveAspectRatio", "id", "transform", "style")}
    clean.attrs = {"xmlns": "http://www.w3.org/2000/svg", "viewBox": _viewbox(root.attrs.get("viewBox") or root.attrs.get("viewbox")),
                   "preserveAspectRatio": "xMidYMid meet", **keep}
    host = clean  # tek <g> içine sarılmış çizim: gruplar onun içinden (dış g'nin transform/fill'i kalır)
    while True:
        draw = [k for k in host.kids if _drawable(k)]
        if len(draw) == 1 and draw[0].tag == "g" and sum(1 for k in draw[0].kids if _drawable(k)) >= 2:
            host = draw[0]
            continue
        break
    draw = [k for k in host.kids if _drawable(k)]
    if not draw:
        return "", 0
    n = min(len(draw), MAX_GROUPS)
    groups = [_Node("g", {"class": f"r{i}"}) for i in range(n)]
    for i, k in enumerate(draw):
        groups[min(i, n - 1)].kids.append(k)
    host.kids = [k for k in host.kids if not _drawable(k)] + groups
    for k in host.kids:
        k.tail = ""
    out = _ser(clean)
    if len(out) > MAX_OUT:
        return "", 0
    return out, n


def palette(raw) -> list:
    """3-5 geçerli renk (#rgb / #rrggbb → #RRGGBB, tekrarsız); yoksa sıcak kâğıt/sepya varsayılanı."""
    got = []
    for c in raw if isinstance(raw, list) else []:
        c = str(c).strip().upper()
        if re.fullmatch(r"#[0-9A-F]{3}", c):
            c = "#" + "".join(x * 2 for x in c[1:])
        if re.fullmatch(r"#[0-9A-F]{6}", c) and c not in got:
            got.append(c)
    return got[:5] if len(got) >= 3 else list(DEFAULT_PALETTE)


def lum(c: str) -> float:
    """Rengin parlaklığı (0-255): paletin en açığı kâğıt, en koyusu mürekkep."""
    c = c.lstrip("#")
    r, g, b = (int(c[i:i + 2], 16) for i in (0, 2, 4))
    return 0.299 * r + 0.587 * g + 0.114 * b


def fallback(title: str, pal=None, seed: int = 1) -> tuple:
    """Sade yedek sahne (Claude'un çizimi kullanılamadığında): gökyüzü, tepeler, güneş/ay, kuşlar ve sahnenin başlığı; renkler
    paletten (açıktan koyuya), yerleşim `seed` ile değişir (aynı seed hep aynı)."""
    p = sorted(palette(pal), key=lum, reverse=True)
    light, ink = p[0], p[-1]
    # güneş ve tepeler aradaki en az doygun iki renkten: paletteki canlı vurgu (kırmızı göz, ünlem) koca tepeyi boyamasın
    sat = lambda c: max(int(c[i:i + 2], 16) for i in (1, 3, 5)) - min(int(c[i:i + 2], 16) for i in (1, 3, 5))  # noqa: E731
    calm = sorted(sorted(p[1:-1], key=sat)[:2] or [light], key=lum, reverse=True)
    mid, dark = calm[0], calm[-1]
    s = abs(int(seed or 1)) % 997
    sx, sy = 260 + (s * 37) % 560, 420 + (s * 53) % 260
    h1, h2 = 900 + (s * 29) % 120, 1010 + (s * 41) % 90  # tepeler altyazı (y 1090) ve başlığın (y 1260) üstünde görünsün
    birds = "".join(f"<path d='M{x} {y} q 22 -18 44 0 q 22 -18 44 0' fill='none' stroke='{ink}' stroke-width='6' stroke-linecap='round'/>"
                    for x, y in ((180 + (s * 13 + i * 170) % 640, 300 + (s * 17 + i * 90) % 260) for i in range(3)))
    t = html.escape(re.sub(r"\s+", " ", str(title or "")).strip()[:28], quote=False)
    parts = [f"<rect x='0' y='0' width='1080' height='1150' fill='{light}' fill-opacity='0.45'/>",  # kâğıt zemini SvgScene çizer: gökyüzü yarı saydam; başlık y 330 (üstteki kategori etiketinin altında)
             f"<circle cx='{sx}' cy='{sy}' r='120' fill='{mid}' stroke='{ink}' stroke-width='6'/>",
             f"<path d='M0 {h1} C 260 {h1 - 140} 520 {h1 + 60} 1080 {h1 - 80} L1080 1920 L0 1920 Z' fill='{mid}' stroke='{ink}' stroke-width='6'/>",
             f"<path d='M0 {h2} C 300 {h2 - 90} 700 {h2 + 90} 1080 {h2 - 20} L1080 1920 L0 1920 Z' fill='{dark}' stroke='{ink}' stroke-width='6'/>",
             f"<g>{birds}</g>"]
    if t:
        parts.append(f"<text x='540' y='330' text-anchor='middle' font-size='64' font-weight='700' fill='{ink}'>{t}</text>")
    body = "".join(f"<g class='r{i}'>{x}</g>" for i, x in enumerate(parts))
    return (f"<svg xmlns='http://www.w3.org/2000/svg' viewBox='{VIEWBOX}' preserveAspectRatio='xMidYMid meet'>{body}</svg>", len(parts))


if __name__ == "__main__":
    svg, n = sanitize(open(sys.argv[1], encoding="utf-8").read())
    print(svg or "(kullanılamaz)")
    print(n, file=sys.stderr)
