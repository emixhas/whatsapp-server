#!/usr/bin/env python3
"""WhatsApp'tan gönderilen videodan haber (kullanıcı isteği: "WhatsApp'tan video gönderdiğimde altına nasıl bir haber yapmanı
istersem hazırla, o videoyu kesmen gereken yerlerinden kes, montaj yap").

1) Çözümleme (her video, en çok 4): ffprobe süre/boyut, ffmpeg sahne geçişleri (scene > 0,3), konuşma dökümü (mlx-whisper, kelime
   zamanlı → cümle satırları; kurulu değilse boş), kare çizelgesi (6-16 kare tek resimde, `sheet-N.jpg`).
2) Kurgu planı: TEK Claude çağrısı (`prompts/montaj.md`; Read aracı yalnız iş klasöründeki çizelgeleri görmek için, olmazsa
   resimsiz bir kez daha): talimat + döküm + sahneler + kareler → anlık şemasında senaryo + her kanca/haber segmentine
   kullanılacak parçalar `clips` [{video, start, end}] + `cuts` (neyin neden kesildiği).
3) Montaj: her segmentin parçaları kesilip birleştirilir (sessiz; seslendirme ve müzik pipeline'da): kanca 1080x1920, haber
   kartı 1280x780; oranı uymayan görüntü kırpılmaz, aynı görüntünün bulanık hali zemin olur. Her segmente kare (kapak/yedek).
   İş klasörü `work/jobs/video-<zaman>/` (info_card şablon düzeni: claude_out.json + cards.json {video, image, tall}).

Fragman modu (`job.trailer`; kullanıcı isteği, 18 Ekim: "bir filmin fragmanını analiz edip kullanıcıların aşırı dikkatini çekecek
yapıda kurmamız lazım, videodan kareler, fragmanın özet videosu gibi"): süre `settings.trailer.duration` (40; talimattaki "N saniye"
önce gelir), videonun tamamı kendi sesiyle OYNAMAZ (sesli bölüm yalnız talimat açıkça isterse, toplam en çok `maxSoundSeconds` 8 sn),
konuşma dili kendiliğinden algılanır (fragman çoğu zaman İngilizce), kareler çekimlerden (TÜM sahne geçişleri arası, siyah çekimler
hariç, en çok 24, tüm fragmana yayılmış), siyah bölümler parçalardan ayıklanır, `prompts/fragman.md`; döküm iş klasörüne `fragman_dokum.txt`.
Etiket, giriş ve kapanış `trailer_label()` (eski fragmana "yeni" denmez), geçersiz parçanın yedeği baştaki logolardan sonra başlar.

  python3 scripts/wa_video.py --job IS.json     # IS.json: {"videos": [yol, ...], "instruction": "...", "duration": 30}
                                                # fragman: {..., "trailer": true, "film": "Dune: Part Three", "social": {...}}
Son satır JSON: {ok, job, plan: {label, hook, titles, cuts, segments: [{kind, title, clips}]}, duration}
"""
import json
import math
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import ROOT, settings  # noqa: E402
from info_card import new_job  # noqa: E402

SPEECH_OFF = False  # konuşma tanıma kurulamadı/kapalı: plan yalnız kareler ve sahne geçişleriyle
WORDS: dict = {}  # video yolu → [(kelime, başlangıç, bitiş)] (orijinal sesli bölümün altyazısı)
# kullanıcı isteği: talimatta videonun kendi sesi istenirse o bölümde seslendirme susar, video kendi sesiyle izlenir
WANT_SOUND = re.compile(r"(orijinal|kendi|videonun|gerçek|asıl|doğal)\s+ses|ses(?:i|ini)?\s+(?:kullan|koru|kalsın|açık|aç|duy|olsun|gitsin|verilsin|"
                        r"kapatma|kısma)|sesiyle|sesli\s+(?:kullan|ver|olsun|bölüm)|konuşma(?:sı|yı|ları|ları)?\s+(?:duyul|kullan|ver|kalsın)|"
                        r"röportaj\w*\s+(?:kullan|ver|duyul)|araya\s+gir\w*\s+(?:me|ma)", re.I)
# sosyal medya linkinden indirilen video varsayılan olarak baştan sona kendi sesiyle oynar (kullanıcı isteği, 14 Ekim: "indirilen video
# 1 dakikadan uzun olabilir, mümkünse hepsini orijinal sesiyle paylaşsın"); talimat açıkça seslendirme/sessiz isterse uygulanmaz
NO_SOUND = re.compile(r"ses(?:i|ini)?\s+(?:kapat(?!ma)|kıs(?!ma)|olmasın|gitsin\b|istemiyorum|kullanma)|sessiz|orijinal\s+ses\w*\s+(?:olmasın|kullanma|istemiyorum)|"
                      r"(?:yalnız|sadece|hep)\s+seslendir|kısa\s+(?:kes|parça|tut)|özetle", re.I)
CATS = {"finans", "siyaset", "asayis", "spor", "hava", "toplum", "teknoloji", "saglik", "dunya", "parti", "egitim", "sinema", "genel"}
LANGS: dict = {}  # video yolu → konuşma tanımanın algıladığı dil (fragmanda dil kendiliğinden algılanır)
TRAILER_TALIMAT = "Bu fragmanı analiz et: ne anlatıldığını ve en çarpıcı anlarını dikkat çeken ama doğru bir fragman özeti olarak anlat."
# fragman süresi (server.js SURE_RE/trailerSecs ile aynı kural): "N saniye/sn" ya da "N dakika/dk" (× 60); belirtme/çıkma ekli sayı süre
# değildir ("baştaki 15 saniyeyi kullanma", "ilk 5 sn'yi kes"), "40 saniyelik", "40 sn'lik", "40 saniyede", "1 dakikalık" süredir
SURE_RE = re.compile(r"(?:(\d{2,3})\s*(?:saniye(?:lik|de|ye)?|sn)|(\d{1,2})\s*(?:dakika(?:l[ıi]k|da|ya)?|dk))(?!\w|['’](?:y[ıi]|d[ae]n|t[ae]n))")


def trailer_secs(instruction: str) -> int:
    """Fragman talimatındaki süre (saniye; yoksa 0). Sınır (20-60) çağıranda."""
    m = SURE_RE.search(instruction.replace("I", "ı").replace("İ", "i").lower())
    return (int(m.group(1)) if m.group(1) else int(m.group(2)) * 60) if m else 0


def tr_settings() -> dict:
    """settings.trailer (server.js trailerCfg ile aynı kural): nesne değilse varsayılan (true/false yazılmış ayar fragman olmayan işi de
    düşürüyordu); süre ve sesli saniye sayıya çevrilir, bozuk ya da 0 değer varsayılana düşer (40 sn, 8 sn; panel yanıtıyla aynı süre)."""
    raw = settings().get("trailer")
    t = raw if isinstance(raw, dict) else {}

    def num(v, default: float) -> float:
        try:
            x = float(v)
        except (TypeError, ValueError):
            return default
        return x if math.isfinite(x) and x != 0 else default
    return {**t, "duration": int(num(t.get("duration"), 40)) or 40, "maxSoundSeconds": max(0.0, num(t.get("maxSoundSeconds"), 8))}


def log(msg: str) -> None:
    print(msg, flush=True)


def probe(p: Path) -> dict:
    r = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration:stream=codec_type,width,height:stream_tags=rotate",
                        "-of", "json", str(p)], capture_output=True, text=True)
    d = json.loads(r.stdout or "{}")
    v = next((s for s in d.get("streams", []) if s.get("codec_type") == "video"), {})
    w, h = int(v.get("width") or 0), int(v.get("height") or 0)
    if str((v.get("tags") or {}).get("rotate", "0")) in ("90", "270", "-90"):
        w, h = h, w
    return {"duration": float((d.get("format") or {}).get("duration") or 0), "width": w, "height": h,
            "audio": any(s.get("codec_type") == "audio" for s in d.get("streams", []))}


def scenes(p: Path, limit: int = 40) -> list:
    r = subprocess.run(["ffmpeg", "-hide_banner", "-i", str(p), "-vf", "select='gt(scene,0.3)',showinfo", "-an", "-f", "null", "-"],
                       capture_output=True, text=True)
    ts = [round(float(m), 1) for m in re.findall(r"pts_time:([\d.]+)", r.stderr)]
    return ts[:limit]


def transcript(p: Path, tmp: Path, language: str | None = "tr") -> list:
    """[(başlangıç, bitiş, metin)] — konuşma tanıma kurulu değilse ya da ses yoksa boş. language=None: dil algılanır (fragman)."""
    try:
        import align
        run = align._whisper()
    except Exception:
        run = None
    if not run:  # align._whisper Apple Silicon'da mlx-whisper'ı ilk ihtiyaçta kendisi kurar; olmadıysa söylenir
        global SPEECH_OFF
        SPEECH_OFF = True
        return []
    wav = tmp / f"{p.stem}.wav"
    if subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(p), "-vn", "-ac", "1", "-ar", "16000", str(wav)]).returncode:
        return []
    try:
        words = run(wav) if language == "tr" else run(wav, language=language)
    except Exception as e:
        log(f"  ! konuşma tanıma: {str(e)[:120]}")
        return []
    if language != "tr":
        LANGS[str(p)] = getattr(align, "_LAST_LANG", None) or language
    WORDS[str(p)] = [(str(w).strip(), float(a), float(b)) for w, a, b in words if str(w).strip()]
    lines, cur = [], []
    for w, s, e in words:
        if cur and (s - cur[-1][2] > 0.6 or len(cur) >= 12):
            lines.append((cur[0][1], cur[-1][2], " ".join(x[0].strip() for x in cur)))
            cur = []
        cur.append((w, s, e))
        if re.search(r"[.!?]$", w.strip()):
            lines.append((cur[0][1], cur[-1][2], " ".join(x[0].strip() for x in cur)))
            cur = []
    if cur:
        lines.append((cur[0][1], cur[-1][2], " ".join(x[0].strip() for x in cur)))
    return [(round(a, 1), round(b, 1), t) for a, b, t in lines if t.strip()]


def contact_sheet(p: Path, dur: float, out: Path, tmp: Path, times: list | None = None) -> list:
    """Videodan eşit aralıklı (ya da verilen saniyelerdeki) kareler → tek resim (4 sütun). Karelerin saniyeleri döner."""
    if not times:
        n = 16 if dur > 40 else 12 if dur > 15 else 8
        times = [round((i + 0.5) * dur / n, 1) for i in range(n)]
    fr = tmp / f"fr-{p.stem}"
    fr.mkdir(parents=True, exist_ok=True)
    for i, t in enumerate(times):
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-ss", f"{t:.2f}", "-i", str(p), "-frames:v", "1",
                        "-vf", "scale=320:-2", str(fr / f"{i:02d}.jpg")])
    got = sorted(fr.glob("*.jpg"))
    if not got:
        return []
    rows = (len(got) + 3) // 4
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-framerate", "1", "-i", str(fr / "%02d.jpg"),
                    "-vf", f"tile=4x{rows}:padding=6:color=white", "-frames:v", "1", "-q:v", "4", str(out)])
    return times[:len(got)] if out.exists() else []


def blacks(p: Path) -> list:
    """Siyah bölümler [(başlangıç, bitiş)]: fragmanda çekimler arası kararma, baştaki/sondaki boş kareler (ffmpeg blackdetect).
    pic_th 0.998: yalnız neredeyse tamamen siyah kare siyah sayılır; siyah zeminli beyaz yazı kartı ("IN THEATERS DECEMBER 18", film adı)
    varsayılan 0.98 ile siyah sayılıp kare çizelgesinden düşüyordu, vizyon tarihi karede okunamıyordu. Karenin ortadaki %70'ine bakılır:
    kararma boyunca köşede duran kanal logosu ya da yaş rozeti (dizi fragmanında atv/Show TV logosu) siyahı gizlemesin; sinemaskop
    siyah bantları da zaten kenarda kalır."""
    r = subprocess.run(["ffmpeg", "-hide_banner", "-i", str(p), "-vf", "crop=trunc(iw*0.35)*2:trunc(ih*0.35)*2,scale=320:-2,"
                        "blackdetect=d=0.1:pix_th=0.10:pic_th=0.998", "-an", "-f", "null", "-"],
                       capture_output=True, text=True)
    return [(round(float(a), 2), round(float(b), 2)) for a, b in re.findall(r"black_start:\s*([\d.]+)\s+black_end:\s*([\d.]+)", r.stderr)]


def shot_times(dur: float, sc: list, blk: list, n: int = 24) -> list:
    """Fragman kare çizelgesi (kullanıcı isteği, 18 Ekim: "videodan kareler"): fragman hızlı kesilir, eşit aralıklı kare çekimleri
    kaçırır. Sahne geçişlerinden çekimler çıkarılır, çoğu siyah olan çekim atlanır; çekim n'den çoksa n hedef zamana en yakın çekimler
    (tüm fragmana yayılır), azsa her çekime bir kare ve kalanlar en uzun çekimlere. Geçiş yoksa eşit aralıklı. En çok n (24) kare."""
    n = min(n, max(8, int(dur / 1.5)))
    cuts = sorted({round(float(t), 2) for t in sc if 0.2 < float(t) < dur - 0.2})
    edges = [0.0, *cuts, round(dur, 2)]
    shots = []
    for a, b in zip(edges, edges[1:]):
        for x, y in blk:  # çekimin başındaki/sonundaki kararma kareye girmesin (sahne geçişi siyahtan sonra gelmeyebilir)
            if x <= a + 0.05 < y:
                a = y
            if x < b - 0.05 <= y:
                b = x
        if b - a >= 0.35:
            shots.append((a, b))

    def dark(a: float, b: float) -> bool:
        return sum(max(0.0, min(b, y) - max(a, x)) for x, y in blk) >= (b - a) * 0.6
    shots = [x for x in shots if not dark(*x)] or shots
    if not shots:
        return [round((i + 0.5) * dur / n, 1) for i in range(n)]
    if len(shots) > n:
        picked: list = []
        for i in range(n):
            t = (i + 0.5) * dur / n
            picked.append(min((x for x in shots if x not in picked), key=lambda x: abs((x[0] + x[1]) / 2 - t)))
        return [round((a + b) / 2, 1) for a, b in sorted(picked)]
    k = [1] * len(shots)
    for _ in range(n - len(shots)):
        j = max(range(len(shots)), key=lambda i: (shots[i][1] - shots[i][0]) / (k[i] + 1))
        k[j] += 1
    return [round(a + (b - a) * (q + 0.5) / kk, 1) for (a, b), kk in zip(shots, k) for q in range(kk)]


def skip_black(clips: list, infos: list) -> list:
    """Fragman: parçadaki siyah bölüm (çekimler arası kararma) kesilip atılır. Kalan parçalar en az 0,8 sn; hiçbiri o kadar değilse
    en uzunu (≥0,5 sn, hızlı kesimde yeter), tamamı siyah parça atılır. En çok 8 parça; hiç kalmazsa Claude'un parçaları."""
    out = []
    for c in clips:
        pieces = [(c["start"], c["end"])]
        for x, y in infos[c["video"] - 1].get("black") or []:
            nxt = []
            for a, b in pieces:
                if y <= a or x >= b:
                    nxt.append((a, b))
                    continue
                nxt += [(a, x - 0.04), (y + 0.04, b)]
            pieces = [(a, b) for a, b in nxt if b - a > 0.05]
        keep = [(a, b) for a, b in pieces if b - a >= 0.8] or [x for x in sorted(pieces, key=lambda x: x[0] - x[1])[:1] if x[1] - x[0] >= 0.5]
        out += [{**c, "start": round(a, 2), "end": round(b, 2)} for a, b in keep]
    return out[:8] or clips


def sound_window(lines: list, dur: float, secs: float, avoid: list) -> dict:
    """Fragmanda Claude sesli bölüm eklemediyse: en çok `secs` saniyelik, BÜTÜN döküm satırlarından [(başlangıç, bitiş, metin)] oluşan
    pencere (fragman.md: "Konuşmayı cümle ortasında kesme"); önce sığan, sonra diğer segmentlerin parçalarıyla (`avoid`) en az çakışan
    ("Aynı saniyeleri iki kez kullanma"), sonra en çok kelimeli pencere. Konuşma yoksa ortası."""
    best = None
    for i, (a0, _, _) in enumerate(lines):
        j = i
        while j + 1 < len(lines) and lines[j + 1][1] - a0 <= secs - 0.4:
            j += 1
        s, e = max(0.0, a0 - 0.2), min(dur - 0.05, lines[j][1] + 0.2)
        fits, e = e - s <= secs, min(e, s + secs)  # tek satır bile uzunsa kesilir (başka pencere yoksa)
        over = sum(max(0.0, min(e, y) - max(s, x)) for x, y in avoid)
        key = (fits, -round(over, 1), sum(len(x[2].split()) for x in lines[i:j + 1]))
        if not best or key > best[0]:
            best = (key, s, e)
    if not best:
        s = max(0.0, dur / 2 - secs / 2)
        return {"start": round(s, 2), "end": round(min(dur - 0.05, s + secs), 2)}
    return {"start": round(best[1], 2), "end": round(best[2], 2)}


def trailer_label(label: str, date) -> tuple:
    """Fragman etiketi, giriş ve kapanış cümlesi (kullanıcı isteği, 18 Ekim: "fragmanda ne anlatıldı gibi 40 saniyelik video"): "Yeni
    fragman." yalnız yeni fragmanda (yükleme 30 günden eskiyse YENİ FRAGMAN → FRAGMAN; eski fragmana "yeni" denmez), hayran yapımında
    "Hayran yapımı fragman.", film olmayan tanıtım filminde "Tanıtım filmi.", diğerlerinde "Fragman analizi.". Etiket önce düzlenir:
    Türkçe büyük harf, emoji/noktalama atılır, boşluklar tekleşir ("🎬 YENİ FRAGMAN!", "Yeni fragman 🔥" → YENİ FRAGMAN), ASCII yazım
    bilinen etikete eşlenir (YENI FRAGMAN, DIZI FRAGMANI, TANITIM FILMI; "Hayran Yapımı Fragman" → HAYRAN FRAGMANI); uzun etiket kelime
    sınırında en çok 30 karakter."""
    key = re.sub(r"\s+", " ", re.sub(r"[^\w ]", " ", str(label or "").replace("i", "İ").replace("ı", "I").upper())).strip()
    fold = lambda t: t.translate(str.maketrans("İŞĞÜÖÇ", "ISGUOC"))  # noqa: E731
    canon = {fold(c): c for c in ("YENİ FRAGMAN", "DİZİ FRAGMANI", "HAYRAN FRAGMANI", "TANITIM FİLMİ", "FRAGMAN")}
    canon.update({"HAYRAN YAPIMI FRAGMAN": "HAYRAN FRAGMANI", "HAYRAN YAPIMI FRAGMANI": "HAYRAN FRAGMANI", "HAYRAN YAPIMI": "HAYRAN FRAGMANI"})
    key = canon.get(fold(key), key)
    try:
        old = (time.time() - time.mktime(time.strptime(str(date), "%d.%m.%Y"))) / 86400 > 30
    except (TypeError, ValueError, OverflowError):
        old = False
    if old and "YENI" in fold(key).split():  # eski fragmana "yeni" denmez ("ÇOK BEKLENEN YENİ FRAGMAN" dahil)
        key = "FRAGMAN"
    if len(key) > 30:
        key = key[:31].rsplit(" ", 1)[0] if " " in key[:31] else key[:30]
    intro = ("Yeni fragman." if key in ("YENİ FRAGMAN", "DİZİ FRAGMANI") and not old else "Hayran yapımı fragman." if key == "HAYRAN FRAGMANI"
             else "Tanıtım filmi." if key == "TANITIM FİLMİ" else "Fragman analizi.")
    outro = "Takip etmeyi unutma." if key == "TANITIM FİLMİ" else "Yeni fragmanları kaçırmamak için takip etmeyi unutma."
    return key or "FRAGMAN", intro, outro  # Türkçe büyük harf: açıklama başlığı ve etiket karşılaştırmaları ("TANITIM FİLMİ") tutarlı


def dokum_text(infos: list, srcs: list, film: str, social: dict | None, segs: list) -> str:
    """fragman_dokum.txt (kullanıcı isteği: "kelimelere döküp"): zaman damgalı konuşma dökümü + videonun Türkçe seslendirmesi."""
    so = social or {}
    mmss = lambda t: f"{int(t // 60)}:{t % 60:04.1f}"  # noqa: E731
    lines = [f"Fragman dökümü — {film or so.get('title') or 'fragman'}"]
    meta = [f"Başlık: {so['title']}" if so.get("title") else "", f"Kanal: {so.get('uploader') or so.get('handle')}" if so.get("uploader") or so.get("handle") else "",
            f"Yükleme: {so['date']}" if so.get("date") else "", so.get("url") or ""]
    lines += [" · ".join(x for x in meta if x), ""]
    for i, (info, p) in enumerate(zip(infos, srcs), 1):
        if len(infos) > 1:
            lines.append(f"— {i}. video —")
        lines.append(f"Konuşma dili: {LANGS.get(str(p)) or 'bilinmiyor'} · {len(info['speech'])} satır · {round(info['duration'], 1)} sn")
        if SPEECH_OFF:
            lines.append("Konuşma tanıma çalışmadı (mlx-whisper kurulu değil); döküm yok. Mac'te bir kez: bash scripts/install_align.sh")
        lines += [f"[{mmss(a)} – {mmss(b)}] {t}" for a, b, t in info["speech"]] + [""]
    lines.append("Videonun Türkçe seslendirmesi:")
    lines += [f"• {s.get('title') or s['kind']}: {s['narration']}" for s in segs if s["kind"] != "sesli"]
    return "\n".join(lines).rstrip() + "\n"


def claude(prompt: str, cwd: Path, images: bool, kind: str = "montaj") -> tuple[int, str]:
    """(çıkış kodu, metin). Kod: 0 tamam, 2 kalıcı (kullanım sınırı/oturum), diğer: hata."""
    r = subprocess.run(["bash", "scripts/find_claude.sh"], cwd=ROOT, capture_output=True, text=True)
    binp = r.stdout.strip()
    if not binp:
        return 2, "Claude Code bulunamadı"
    s = settings()
    eff = s.get("claudeEffort")
    effort = (eff.get("script") if isinstance(eff, dict) else eff) or "medium"
    args = [binp, "-p", "--output-format", "json", "--effort", effort, "--strict-mcp-config", "--disable-slash-commands", "--no-session-persistence"]
    if s.get("claudeModel", "opus"):
        args += ["--model", s.get("claudeModel", "opus")]
    args += ["--tools", "Read", "--allowedTools", "Read"] if images else ["--tools", ""]
    try:
        out = subprocess.run(args, input=prompt, cwd=cwd, capture_output=True, text=True, timeout=900)
    except subprocess.TimeoutExpired:
        return 1, "Claude zaman aşımı"
    raw, res = cwd / "claude_raw.json", cwd / "claude_plan.txt"
    raw.write_text(out.stdout or "", encoding="utf-8")
    rc = subprocess.run([sys.executable, str(ROOT / "scripts/claude_result.py"), str(raw), str(res), kind], capture_output=True, text=True)
    text = res.read_text(encoding="utf-8") if res.exists() else ""
    if rc.returncode:
        return rc.returncode, (rc.stdout.strip() or out.stderr.strip() or "Claude yanıt vermedi")[-300:]
    return 0, text


def parse_plan(text: str) -> dict:
    m = re.search(r"\{.*\}", text, re.S)
    if not m:
        raise ValueError("planda JSON yok")
    return json.loads(m.group(0))


def fit_filter(w: int, h: int, idx: int) -> str:
    """Kırpmadan sığdır + aynı görüntünün bulanık hali zemin (dikey video yatay kartta, yatay video dikey kancada)."""
    return (f"[{idx}:v]fps=30,setsar=1,split[a{idx}][b{idx}];"
            f"[a{idx}]scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h},boxblur=24:2,eq=brightness=-0.08[bg{idx}];"
            f"[b{idx}]scale={w}:{h}:force_original_aspect_ratio=decrease[fg{idx}];"
            f"[bg{idx}][fg{idx}]overlay=(W-w)/2:(H-h)/2,setsar=1,format=yuv420p[c{idx}]")


def cut(clips: list, srcs: list, w: int, h: int, out: Path, audio: list | None = None) -> bool:
    """Parçaları kesip birleştirir. `audio` verilirse (video başına ses var mı) videonun kendi sesi de alınır (sesli bölüm);
    sesi olmayan parçaya sessizlik konur, toplam ses -17 LUFS'a getirilir (seslendirmeyle aynı seviye)."""
    ins, fl, extra = [], [], []
    for i, c in enumerate(clips):
        ins += ["-ss", f"{c['start']:.2f}", "-t", f"{c['end'] - c['start']:.2f}", "-i", str(srcs[c["video"] - 1])]
        fl.append(fit_filter(w, h, i))
    if audio is not None:
        for i, c in enumerate(clips):
            if audio[c["video"] - 1]:
                fl.append(f"[{i}:a]aresample=48000,aformat=channel_layouts=stereo,asetpts=PTS-STARTPTS[a{i}]")
            else:
                j = len(clips) + len(extra)
                extra += ["-f", "lavfi", "-t", f"{c['end'] - c['start']:.2f}", "-i", "anullsrc=r=48000:cl=stereo"]
                fl.append(f"[{j}:a]asetpts=PTS-STARTPTS[a{i}]")
        fl.append("".join(f"[c{i}][a{i}]" for i in range(len(clips))) + f"concat=n={len(clips)}:v=1:a=1[out][aout]")
        fl.append("[aout]loudnorm=I=-17:TP=-1.5:LRA=11[an]")
        maps = ["-map", "[out]", "-map", "[an]", "-c:a", "aac", "-b:a", "160k"]
    else:
        fl.append("".join(f"[c{i}]" for i in range(len(clips))) + f"concat=n={len(clips)}:v=1:a=0[out]")
        maps = ["-map", "[out]", "-an"]
    r = subprocess.run(["ffmpeg", "-y", "-loglevel", "error", *ins, *extra, "-filter_complex", ";".join(fl), *maps,
                        "-c:v", "libx264", "-preset", "veryfast", "-crf", "19", "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(out)],
                       capture_output=True, text=True)
    if r.returncode:
        log(f"  ! montaj: {r.stderr.strip()[-200:]}")
    return r.returncode == 0 and out.exists()


def still(src: Path, t: float, w: int, h: int, out: Path) -> bool:
    fl = fit_filter(w, h, 0).replace("fps=30,", "")
    r = subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-ss", f"{t:.2f}", "-i", str(src), "-frames:v", "1",
                        "-filter_complex", fl, "-map", "[c0]", "-q:v", "2", str(out)], capture_output=True, text=True)
    return r.returncode == 0 and out.exists()


def clean_clips(raw, infos: list, need: float, used_until: dict, start0: float = 0.0) -> list:
    """Claude'un parçalarını doğrular (video numarası, sınırlar, en az 0,8 sn); hiç geçerli parça yoksa videonun
    henüz kullanılmamış kısmından seslendirme kadar bir parça verir (video biterse `start0`dan; fragmanda logolardan sonrası)."""
    out = []
    for c in raw or []:
        try:
            v, s, e = int(c.get("video", 1)), float(c["start"]), float(c["end"])
        except Exception:
            continue
        if not 1 <= v <= len(infos):
            continue
        d = infos[v - 1]["duration"]
        s, e = max(0.0, min(s, d)), max(0.0, min(e, d - 0.05))
        if e - s >= 0.8:
            out.append({"video": v, "start": round(s, 2), "end": round(e, 2)})
    for c in out[:8]:
        used_until[c["video"]] = max(used_until.get(c["video"], 0.0), c["end"])
    if out:
        return out[:8]
    v = 1
    d = infos[0]["duration"]
    s = used_until.get(v, min(0.5, d / 10))
    if s + 1.5 > d:
        s = start0
    e = min(d - 0.05, s + max(2.0, need))
    used_until[v] = e
    return [{"video": v, "start": round(s, 2), "end": round(e, 2)}]


def full_clips(raw, infos: list, max_s: float) -> list:
    """Videonun tamamı tek sesli bölümde: Claude'un sesli parçaları hedefin (%85) altındaysa baştaki/sondaki kayıt sarsıntısı
    dışında tüm video (en çok max_s sn) kullanılır."""
    v = max(range(len(infos)), key=lambda i: infos[i]["duration"])
    d = infos[v]["duration"]
    ok = clean_clips(raw, infos, 6.0, {}) if raw else []
    if sum(c["end"] - c["start"] for c in ok) >= min(d - 0.6, max_s) * 0.85:
        return ok
    s0 = min(0.3, d / 10)
    return [{"video": v + 1, "start": round(s0, 2), "end": round(min(d - 0.2, s0 + max_s), 2)}]


def cap_clips(clips: list, budget: float) -> list:
    """Parçaların toplamını `budget` saniyeyle sınırlar (sondan kırpar)."""
    out, acc = [], 0.0
    for c in clips:
        room = budget - acc
        if room < 0.8:
            break
        e = min(c["end"], c["start"] + room)
        out.append({**c, "end": round(e, 2)})
        acc += e - c["start"]
    return out or clips[:1]


def trailer_sound_clips(clips: list, infos: list, others: list, budget: float) -> list:
    """Fragman: Claude'un sesli parçaları bütçeyi (en çok 8 sn) aşıyor ve en uzun parça tek başına bütçeden uzunsa (örneğin "0-55")
    parça baştan kırpılmaz (açılıştaki stüdyo logosu, kancanın saniyeleri): o parçanın içinden `sound_window` ile bütün döküm
    satırlarından oluşan, diğer segmentlerin parçalarıyla en az çakışan pencere seçilir. Diğer durumda parçalar aynen (cap_clips kırpar)."""
    if not clips or sum(c["end"] - c["start"] for c in clips) <= budget:
        return clips
    c0 = max(clips, key=lambda c: c["end"] - c["start"])
    if c0["end"] - c0["start"] <= budget:
        return clips
    v, lo, hi = c0["video"], c0["start"], c0["end"]
    lines = [(a - lo, b - lo, t) for a, b, t in infos[v - 1].get("speech") or [] if a >= lo and b <= hi]
    avoid = []
    for x in others:
        for c in x.get("clips") or []:
            try:
                if int(c.get("video", 1)) == v:
                    avoid.append((float(c["start"]) - lo, float(c["end"]) - lo))
            except (TypeError, ValueError, KeyError, AttributeError):
                continue
    w = sound_window(lines, hi - lo, budget, avoid)
    return [{"video": v, "start": round(lo + w["start"], 2), "end": round(lo + w["end"], 2)}]


def build(job: dict) -> dict:
    srcs = [Path(p) for p in job.get("videos") or [] if Path(p).exists()][:4]
    if not srcs:
        return {"ok": False, "error": "video dosyası bulunamadı"}
    instruction = str(job.get("instruction") or "").strip()
    trailer = bool(job.get("trailer"))  # fragman analizi (kullanıcı isteği, 18 Ekim: "fragmanda ne anlatıldı gibi 40 saniyelik video")
    tr_cfg = tr_settings() if trailer else {}  # fragman olmayan iş settings.trailer'ı hiç okumaz
    m = re.search(r"(\d{2,3})\s*(?:saniye\w*|sn\b)", instruction.lower())  # fragman olmayan işin süre kuralı (değişmedi)
    asked = trailer_secs(instruction) if trailer else (int(m.group(1)) if m else 0)  # fragman: dakika da, ekli sayı değil (server.js ile aynı)
    dur = int(job.get("duration") or asked
              or (tr_cfg["duration"] if trailer else (settings().get("waVideo") or {}).get("duration")) or 30)
    dur = max(20, min(60, dur))
    social, rel = job.get("social") or None, job.get("related") or []
    soc_cfg = settings().get("social") or {}
    max_sound = float(soc_cfg.get("maxSoundSeconds") or 150)  # kanca + haberler + kapanışla toplam ≤ ~3 dk (YouTube Shorts sınırı)
    full_sound = bool(social) and soc_cfg.get("fullSound") is not False and not NO_SOUND.search(instruction)
    # film adı: panel yalnız başlık fragman diye tanındıysa verir; "fragman: <link>" ile istenen başka başlıktaki ("Video by …") ad
    # ayıklaması film adı sayılmaz, Claude adı karelerden ve açıklamadan okur
    film = str(job["film"] if "film" in job else ((social or {}).get("film") if (social or {}).get("trailer") else "") or "").strip()
    if trailer:  # fragman baştan sona kendi sesiyle oynamaz: sesli bölüm yalnız açıkça istenirse, toplam en çok 8 sn
        full_sound = False
        max_sound = tr_cfg["maxSoundSeconds"]
    if full_sound and not m:  # video kendi sesiyle oynayacak: seslendirme kısa (kanca + giriş + devam)
        dur = 25
    name = f"video-{time.strftime('%Y%m%d-%H%M%S')}"
    tmp = ROOT / "work" / "jobs" / f"{name}-analiz"
    shutil.rmtree(tmp, ignore_errors=True)
    tmp.mkdir(parents=True, exist_ok=True)
    infos, blocks = [], []
    for i, p in enumerate(srcs, 1):
        info = probe(p)
        if info["duration"] < 1.5:
            return {"ok": False, "error": f"{i}. video çok kısa ya da okunamadı"}
        if trailer:  # TÜM geçişler kare seçimine; isteme en çok 150, eşit aralıklı (yalnız ilk 150 değil: sondaki doruk ve ad kartı görünsün)
            info["cuts"] = scenes(p, 1000)
            info["scenes"] = info["cuts"][::max(1, math.ceil(len(info["cuts"]) / 150))]
        else:
            info["scenes"] = scenes(p)
        info["speech"] = (transcript(p, tmp, None) if trailer else transcript(p, tmp)) if info["audio"] else []
        sheet = tmp / f"kareler-{i}.jpg"
        if trailer:  # hızlı kurgu: her çekimden kare (siyah çekimler hariç), en çok 24, 4 sütun
            info["black"] = blacks(p)
            info["frames"] = contact_sheet(p, info["duration"], sheet, tmp, shot_times(info["duration"], info["cuts"], info["black"]))
        else:
            info["frames"] = contact_sheet(p, info["duration"], sheet, tmp)
        info["sheet"] = sheet.name if info["frames"] else None
        infos.append(info)
        log(f"🎬 video {i}: {round(info['duration'], 1)} sn, {info['width']}x{info['height']}, {len(info.get('cuts') or info['scenes'])} sahne geçişi, "
            f"{len(info['speech'])} konuşma satırı{'' if info['frames'] else ', kare çizelgesi yok'}")
        blocks.append({"video": i, "sure": round(info["duration"], 1), "boyut": f"{info['width']}x{info['height']}",
                       "sahne_gecisleri": info["scenes"], "konusma": [f"[{a}-{b}] {t}" for a, b, t in info["speech"]][:80],
                       "kareler_dosyasi": info["sheet"], "kareler": info["frames"]})
        if trailer:
            if info["audio"] and not SPEECH_OFF:
                log(f"🎬 fragman konuşması: {len(info['speech'])} satır, dil: {LANGS.get(str(p)) or 'bilinmiyor'}")
            log(f"🎬 fragman kareleri: {len(info['frames'])} çekimden kare, {len(info['black'])} siyah bölüm ayıklanacak")
            blocks[-1].update({"konusma_dili": LANGS.get(str(p)), "konusma": blocks[-1]["konusma"] + [f"[{a}-{b}] {t}" for a, b, t in info["speech"]][80:120],
                               "siyah_bolumler": [list(x) for x in info["black"][:40]]})
    if SPEECH_OFF:
        log("🎬 konuşma tanıma çalışmadı (mlx-whisper kurulamadı ya da kapalı): kurgu yalnız kareler ve sahne geçişleriyle yapılacak — Mac'te bir kez 'bash scripts/install_align.sh'")
    tpl = (ROOT / "prompts" / ("fragman.md" if trailer else "montaj.md")).read_text(encoding="utf-8").replace("__SURE__", str(dur)).replace("__KELIME__", str(int(dur * 2.4) - 6))
    if trailer:  # fragman: girdi fragmanın kendi bilgisi (başlık, açıklama, etiketler) + film adıyla bulunan haberler
        so = social or {}
        bare = re.sub(r"fragman\w*|trailer\w*|teaser\w*|analiz\w*|özet\w*|video\w*|yap\w*|hazırla\w*|üret\w*|\bet\b|[\W\d_]", "", instruction, flags=re.I)
        inp = {"talimat": instruction if len(bare) >= 3 else TRAILER_TALIMAT, "videolar": blocks,
               "fragman": {"film": film, "baslik": so.get("title"), "kanal": so.get("uploader") or so.get("handle"),
                           "aciklama": str(so.get("caption") or "")[:1500], "yukleme_tarihi": so.get("date"), "bugun": time.strftime("%d.%m.%Y"),
                           "izlenme": so.get("views"),
                           "etiketler": so.get("tags") or [], **({"bolum": so["bolum"]} if so.get("bolum") else {})},
               "ilgili_haberler": rel[:5]}
        if WANT_SOUND.search(instruction) and any(i["audio"] for i in infos):  # sessiz fragmanda orijinal ses istenmez
            inp["orijinal_ses_istegi"] = {"en_fazla_saniye": int(max_sound)}
    else:
        inp = {"talimat": instruction or "Videodaki olayı tarafsız bir haber olarak anlat.", "videolar": blocks}
    if social and not trailer:  # sosyal medya paylaşımı: açıklama iddiadır, haber sitelerinde bulunanlar doğrulanmış bilgidir
        inp["kaynak_paylasim"] = {k: social.get(k) for k in ("platform", "credit", "uploader", "caption", "title", "views", "likes", "comments", "date")}
        inp["ilgili_haberler"] = rel[:5]
    if full_sound:
        inp["orijinal_ses_tamami"] = {"video_suresi": round(max(i["duration"] for i in infos), 1), "en_fazla_saniye": int(max_sound)}
    prompt = tpl + json.dumps(inp, ensure_ascii=False, indent=1)
    log("🎬 kurgu planı yazılıyor (Claude görüntüleri ve konuşmayı inceliyor)")
    kind = "fragman" if trailer else "montaj"
    rc, text = claude(prompt, tmp, images=any(b["kareler_dosyasi"] for b in blocks), kind=kind)
    if rc not in (0, 2):  # resim aracı açılamadıysa ya da geçersiz yanıt: resimsiz bir kez daha
        log(f"  ! ilk deneme olmadı ({text[:120]}); kare resimleri olmadan yeniden deneniyor")
        # fragmanda resimsiz denemede görüntü tarif ettirilmez (fragman.md "KARELERİ AÇAMIYORSAN"): yoksa sahneler uydurulur
        see = ('KARELERİ GÖREMİYORSUN (Read aracı kapalı); "KARELERİ AÇAMIYORSAN" kuralını uygula. Görebilseydin bakacağın şeyler' if trailer
               else "Resimleri açamıyorsan dökümden ve sahne geçişlerinden karar ver")
        rc, text = claude(prompt.replace("Resmi Read aracıyla aç ve İNCELE", see)
                          + "\n\nÖNEMLİ: Yanıtın YALNIZCA şemadaki JSON nesnesi olsun.", tmp, images=False, kind=kind)
    if rc:
        return {"ok": False, "error": f"kurgu planı yazılamadı: {text[:200]}", "limit": rc == 2}
    try:
        plan = parse_plan(text)
    except Exception as e:
        return {"ok": False, "error": f"kurgu planı okunamadı: {e}"}
    want_sound = bool(WANT_SOUND.search(instruction)) or full_sound
    if trailer and want_sound and not any(i["audio"] for i in infos):  # ses izi yok: "ORİJİNAL SES" rozetli sessiz bölüm olmasın
        want_sound = False
        log("🔊 talimatta orijinal ses istendi ama fragmanın ses izi yok: sesli bölüm eklenmedi")
    segs = [s for s in plan.get("segments") or [] if (s.get("kind") in ("hook", "haber") and str(s.get("narration") or "").strip())
            or (s.get("kind") == "sesli" and want_sound)]  # sesli bölüm yalnız talimatta istendiyse (kullanıcı kararı)
    if not any(s["kind"] == "haber" for s in segs):
        return {"ok": False, "error": "planda haber segmenti yok"}
    if segs[0]["kind"] != "hook":
        h = next(x for x in segs if x["kind"] == "haber")
        segs.insert(0, {"kind": "hook", "title": h.get("title", ""), "narration": re.split(r"(?<=[.!?])\s", h["narration"])[0],
                        "category": h.get("category"), "clips": h.get("clips")})
    segs = [segs[0]] + [s for s in segs[1:] if s["kind"] in ("haber", "sesli")][:6]
    if want_sound and not any(s["kind"] == "sesli" for s in segs):
        # Claude eklemediyse: konuşması en çok olan videonun tamamı (baştaki/sondaki yarım saniye hariç) ilk haberden sonra
        v = max(range(len(infos)), key=lambda i: (len(infos[i]["speech"]), infos[i]["duration"]))
        dv = infos[v]["duration"]
        at = next(i for i, x in enumerate(segs) if x["kind"] == "haber") + 1
        clip = {"video": v + 1, "start": min(0.3, dv / 10), "end": max(1.0, dv - 0.2)}
        if trailer:  # fragman: bütün döküm satırlarından en çok 8 sn, diğer segmentlerin saniyeleriyle çakışmayan (logolar değil)
            avoid = []
            for x in segs:
                for c in x.get("clips") or []:
                    try:
                        if int(c.get("video", 1)) == v + 1:
                            avoid.append((float(c["start"]), float(c["end"])))
                    except (TypeError, ValueError, KeyError, AttributeError):
                        continue
            clip = {"video": v + 1, **sound_window(infos[v]["speech"], dv, max_sound, avoid)}
        segs.insert(at, {"kind": "sesli", "title": "", "clips": [clip]})
        log("🔊 talimatta orijinal ses istendi: videonun kendi sesiyle oynayan bölüm eklendi")
    if full_sound:  # tek sesli bölüm, videonun tamamı (Claude kısa kestiyse tamamlanır)
        firsts = [x for x in segs if x["kind"] == "sesli"]
        for x in firsts[1:]:
            segs.remove(x)
        firsts[0]["clips"] = full_clips(firsts[0].get("clips"), infos, max_sound)
    # fragman: geçersiz parçanın yedeği 0,5 sn'den (stüdyo/dağıtımcı logosu; kanca logoyla açılıyordu) değil, ilk %10'dan (en çok 8 sn)
    # sonraki ilk çekimden başlar; aranan geçiş açılışla sınırlı (en geç %25 ya da +4 sn): seyrek kesimli teaser'da sondaki "coming soon"
    # kartına atlamasın (yoksa her geçersiz parça aynı bitiş kartını oynatıyordu)
    d1 = infos[0]["duration"]
    lo = min(8.0, d1 * 0.1)
    seed = {1: next((t for t in infos[0].get("cuts") or [] if lo <= t <= max(lo + 4.0, d1 * 0.25)), lo)} if trailer else {}
    src_secs, sound_left = round(max(i["duration"] for i in infos), 1), max_sound
    for x in list(segs):  # orijinal ses toplamı en çok max_sound sn (videonun toplamı ~3 dk'yı geçmesin)
        if x["kind"] != "sesli":
            continue
        if trailer and sound_left < 0.8:  # fragman: bütçe (8 sn) bitti, fazla sesli bölüm atılır (cap_clips ilk parçayı kırpmadan verirdi)
            segs.remove(x)
            continue
        clips = clean_clips(x.get("clips"), infos, 6.0, dict(seed), seed.get(1, 0.0))
        if trailer:  # fragman: bütçeden uzun tek parça baştan (stüdyo logosu) kırpılmaz; o parçanın içindeki en iyi bütün-cümle penceresi
            clips = trailer_sound_clips(clips, infos, [y for y in segs if y is not x], sound_left)
        x["clips"] = cap_clips(clips, sound_left)
        sound_left -= sum(c["end"] - c["start"] for c in x["clips"])
    if full_sound:
        got = sum(c["end"] - c["start"] for x in segs if x["kind"] == "sesli" for c in x["clips"])
        log(f"🔊 sosyal medya videosu kendi sesiyle: {round(got)} sn" + (" (videonun tamamı)" if got >= src_secs - 2.5 else f" ({round(src_secs)} sn'lik videonun en önemli bölümü; en çok {int(max_sound)} sn)"))
    # dikey video (kullanıcı isteği: "video tam gözüksün, üstünde etrafında bizim süslemeler"): haber bölümleri de tam ekran
    vertical = all(i["height"] > i["width"] * 1.15 for i in infos if i["width"])
    if vertical:
        log("📱 dikey video: haber bölümleri tam ekran dikey düzende (kart yerine)")
    # montaj: her segmentin parçaları → kanca ve sesli bölüm dikey tam ekran, haber kartı yatay (dikey videoda tam ekran)
    d = tmp / "parcalar"
    d.mkdir(exist_ok=True)
    cards, used_until, plan_out = [], dict(seed), []
    has_audio = [bool(i["audio"]) for i in infos]
    for k, s in enumerate(segs):
        sesli = s["kind"] == "sesli"
        need = 0.0 if sesli else len(s["narration"].split()) / 2.4 + 0.5
        clips = clean_clips(s.get("clips"), infos, need or 6.0, used_until, seed.get(1, 0.0))
        if trailer:  # çekimler arası kararma ekranda görünmesin
            clips = skip_black(clips, infos)
        hook = s["kind"] == "hook"
        full = hook or sesli or vertical
        vid = d / f"seg-{k}.mp4"
        if not cut(clips, srcs, *((1080, 1920) if full else (1280, 780)), vid, audio=has_audio if sesli else None):
            return {"ok": False, "error": f"{k + 1}. segment kesilemedi (ffmpeg)"}
        c0 = clips[0]
        mid = c0["start"] + min(1.0, (c0["end"] - c0["start"]) / 2)
        img, tall = d / f"seg-{k}.jpg", d / f"seg-{k}-tall.jpg"
        still(srcs[c0["video"] - 1], mid, 1840, 1120, img)
        still(srcs[c0["video"] - 1], mid, 1080, 1920, tall)
        clen = round(sum(c["end"] - c["start"] for c in clips), 2)
        cards.append({"video": vid, "image": img if img.exists() else tall, "tall": tall if tall.exists() else img, "videoDuration": clen,
                      **({"sound": True} if sesli else {}), **({"fullFrame": True} if (vertical or sesli) and not hook else {})})
        if sesli:  # altyazı: videodaki konuşmanın kelimeleri, birleştirilmiş parçaların zamanına çevrilir
            ws, off = [], 0.0
            for c in clips:
                for w, a, b in WORDS.get(str(srcs[c["video"] - 1]), []):
                    if a >= c["start"] and b <= c["end"] + 0.05:
                        ws.append({"w": w, "s": round(off + a - c["start"], 3), "e": round(off + min(b, c["end"]) - c["start"], 3)})
                off += c["end"] - c["start"]
            s["soundWords"], s["soundDuration"] = ws, clen
        plan_out.append({"kind": s["kind"], "title": s.get("title", ""), "clips": clips, "seconds": clen, "narrationSeconds": round(need, 1)})
        label = "kanca" if hook else "🔊 orijinal ses" if sesli else f"{k}. haber"
        log(f"✂️ {label}: " + ", ".join(f"v{c['video']} {c['start']:.1f}-{c['end']:.1f} sn" for c in clips)
            + (f" (toplam {clen} sn, seslendirme yok — videonun kendi sesi)" if sesli else f" (toplam {clen} sn, seslendirme ~{round(need)} sn)"))
    src = str(next((x.get("source") for x in segs[1:] if x.get("source")), None) or "Türkiye Gündemi")
    if social:  # kullanıcı kararı (14 Ekim): sosyal medya kaynağı videoda yazmaz; açıklamanın en altında tek satır "Kaynak: …"
        src = ""
        for x in segs:
            x["source"] = ""
    # ilk yorum (kullanıcı isteği: "linkten gelen haberde de ilk yorum atsın"): habere özel soru (kaynak yalnız açıklamada)
    first = str(plan.get("firstComment") or "").strip()[:160] or ("Fragmanı nasıl buldunuz? İzleyecek misiniz? Yorumlara yazın 👇" if trailer
                                                                  else "Siz bu konuda ne düşünüyorsunuz? Yorumlarda buluşalım 👇")
    raw_label = str(plan.get("label") or ("FRAGMAN" if trailer else "SON DAKİKA"))
    label = raw_label[:30]
    intro, outro, cats, gen = "Son dakika.", "", CATS, "genel"  # geçersiz kategori → genel
    if trailer:  # etiket, giriş ve kapanış etikete göre (panel startAnlik'e bunları verir); kesme trailer_label'da kelime sınırında
        label, intro, outro = trailer_label(raw_label, (social or {}).get("date"))
        # fragman.md'nin izin verdiği kategoriler; "asayis", "dunya" gibi etiket fragman konusunu gerçek olay gibi gösterir (polis
        # sireni kartı, #asayiş): fragmanda sinema, film olmayan tanıtım filminde genel
        cats, gen = {"sinema", "teknoloji", "siyaset", "genel"}, "genel" if label == "TANITIM FİLMİ" else "sinema"
    script = {"titles": plan.get("titles") or {}, "hashtags": plan.get("hashtags") or [], "importance": plan.get("importance", 3),
              "importanceReason": plan.get("importanceReason", "Fragman analizi" if trailer else "WhatsApp'tan gönderilen görüntü"), "firstComment": first,
              "segments": [{"kind": "hook", "title": segs[0].get("title", ""), "narration": segs[0]["narration"], "source": src,
                            "category": segs[0].get("category") if segs[0].get("category") in cats else gen},
                           {"kind": "intro", "narration": intro}]
              + [({"kind": "sesli", "title": s.get("title", ""), "narration": "", "source": s.get("source") or src, "category": (
                     s.get("category") if s.get("category") in cats else gen), "soundDuration": s["soundDuration"], "soundWords": s["soundWords"]}
                  if s["kind"] == "sesli" else
                  {"kind": "haber", "title": s.get("title", ""), "narration": s["narration"], "source": s.get("source") or src,
                   "category": s.get("category") if s.get("category") in cats else gen, **({"breaking": True} if s.get("breaking") and not trailer else {})})
                 for s in segs[1:]]
              + [{"kind": "outro", "narration": "Takip etmeyi unutma."}]}
    job_dir = new_job(name, script, [], {"instruction": instruction, "cuts": plan.get("cuts"), "plan": plan_out, "videos": [str(p) for p in srcs],
                                         **({"trailer": True, "film": film} if trailer else {})})
    jd = ROOT / job_dir
    for i, c in enumerate(cards):  # parçaları iş klasörüne taşı (new_job klasörü yeniden kurdu)
        for key, suf in (("video", ".mp4"), ("image", ".jpg"), ("tall", "-tall.jpg")):
            dst = jd / f"part-{i}{suf}"
            shutil.copyfile(c[key], dst)
            c[key] = str(dst.relative_to(ROOT))
    (jd / "cards.json").write_text(json.dumps(cards, ensure_ascii=False, indent=2), encoding="utf-8")
    if trailer:  # kelimelere dökme (kullanıcı isteği): zaman damgalı döküm + Türkçe seslendirme iş klasöründe
        (jd / "fragman_dokum.txt").write_text(dokum_text(infos, srcs, film, social, segs), encoding="utf-8")
        log(f"🎬 fragman dökümü (kelimelere dökme): {job_dir / 'fragman_dokum.txt'}")
    shutil.rmtree(tmp, ignore_errors=True)
    words = sum(len(s.get("narration", "").split()) for s in segs if s["kind"] != "sesli")
    res = {"ok": True, "job": str(job_dir), "duration": max(dur, min(60, int(words / 2.4) + 3)), "vertical": vertical,
           "soundSeconds": round(sum(x["soundDuration"] for x in segs if x["kind"] == "sesli"), 1),
           "soundFull": full_sound, "sourceSeconds": src_secs,
           "plan": {"label": label, "hook": segs[0].get("title", ""), "titles": plan.get("titles") or {},
                    "cuts": str(plan.get("cuts") or "")[:600], "segments": plan_out,
                    "narration": " ".join(s["narration"] for s in segs if s["kind"] != "sesli")[:900], "speech": not SPEECH_OFF}}
    if trailer:
        res["trailer"] = True
        res["plan"].update({"trailer": True, "film": film, "intro": intro, "outro": outro, "speechLang": next((LANGS[str(p)] for p in srcs if LANGS.get(str(p))), None),
                            "transcriptFile": str(job_dir / "fragman_dokum.txt")})
    return res


if __name__ == "__main__":
    try:
        if "--job" in sys.argv:
            res = build(json.loads(Path(sys.argv[sys.argv.index("--job") + 1]).read_text(encoding="utf-8")))
        else:
            res = {"ok": False, "error": "kullanım: --job IS.json"}
    except Exception as ex:
        res = {"ok": False, "error": str(ex)[:300]}
    print(json.dumps(res, ensure_ascii=False))
