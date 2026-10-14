#!/usr/bin/env python3
"""Metni sese zorla hizalama (forced alignment; kullanıcı isteği: altyazı sesle kesinlikle eşit gitsin).

Ne söylendiği zaten bilinir (senaryo); konuşma tanıma gibi tahmin yapılmaz: Meta'nın çok dilli MMS hizalama modeli
(torchaudio.pipelines.MMS_FA, Türkçe dahil) bilinen harf dizisini sesin karelerine CTC ile oturtur, her kelimenin başı ve
sonu ~20 ms çözünürlükle bulunur. Model ilk kullanımda ~1,2 GB iner (torch önbelleği). Ayrı ortam `.venv-align`
(`bash scripts/install_align.sh`): ses modellerinin torch sürümüne dokunmaz. torchaudio 2.9+ forced_align'ı kaldırdığı için
2.8 sabitlenir.

Kullanım (align.py çağırır, tüm segmentler tek seferde): python mms_align.py ISLER.json
  ISLER.json: [{"wav": yol, "pairs": [["ekranda", "söylenen biçim"], ...]}, ...] → {"ok", "results": [...]}
  tek iş (deneme): python mms_align.py SES.wav KELIMELER.json
  KELIMELER.json: [["ekranda", "söylenen biçim"], ...]  (söylenen biçim: rakamlar yazıya çevrilmiş, ör. "4-1" → "dört bir")
  çıktı (son satır JSON): {"ok": true, "words": [{"w","s","e"}], "score": ortalama güven}
"""
import json
import re
import sys
import wave

def _use_ca() -> None:
    """Model ilk kullanımda HTTPS ile iner. python.org Python'u (ve onun venv'i) macOS sertifika deposunu görmez:
    "CERTIFICATE_VERIFY_FAILED" (kullanıcının Mac'inde 14 Ekim). certifi → SSL_CERT_FILE → /etc/ssl/cert.pem sırasıyla."""
    import os
    import ssl
    ca = None
    try:
        import certifi
        ca = certifi.where()
    except Exception:
        ca = os.environ.get("SSL_CERT_FILE") if os.path.exists(os.environ.get("SSL_CERT_FILE") or "") else None
    if not ca and os.path.exists("/etc/ssl/cert.pem"):
        ca = "/etc/ssl/cert.pem"
    if ca:
        os.environ["SSL_CERT_FILE"] = ca
        ssl._create_default_https_context = lambda: ssl.create_default_context(cafile=ca)


_use_ca()
TR = str.maketrans({"ç": "c", "ğ": "g", "ı": "i", "ö": "o", "ş": "s", "ü": "u", "â": "a", "î": "i", "û": "u"})


def romanize(w: str) -> str:
    w = w.replace("İ", "i").replace("I", "ı").lower().translate(TR)
    return re.sub(r"[^a-z]", "", w)  # kesme işareti (Maltepe'de) söylenmez


def load_wav(path: str):
    import numpy as np
    import torch
    with wave.open(path, "rb") as f:
        sr, n, ch, sw = f.getframerate(), f.getnframes(), f.getnchannels(), f.getsampwidth()
        raw = f.readframes(n)
    dt = {1: np.int8, 2: np.int16, 4: np.int32}[sw]
    x = np.frombuffer(raw, dtype=dt).astype(np.float32) / float(np.iinfo(dt).max)
    if ch > 1:
        x = x.reshape(-1, ch).mean(axis=1)
    return torch.from_numpy(x.copy()).unsqueeze(0), sr


def align_one(model, tokenizer, aligner, bundle, wav_path: str, pairs: list, device: str) -> dict:
    import torch
    import torchaudio
    wave_t, sr = load_wav(wav_path)
    if sr != bundle.sample_rate:
        wave_t = torchaudio.functional.resample(wave_t, sr, bundle.sample_rate)
    with torch.inference_mode():
        emission, _ = model(wave_t.to(device))
    emission = emission.cpu()  # forced_align CPU'da çalışır
    # ekrandaki her kelimenin söylenen biçimi bir ya da birkaç alt kelime ("1.250" → bin iki yüz elli)
    subs, owner = [], []
    for k, (_, spoken) in enumerate(pairs):
        for part in str(spoken).split():
            r = romanize(part)
            if r:
                subs.append(r)
                owner.append(k)
    if not subs:
        raise RuntimeError("hizalanacak harf yok")
    spans = aligner(emission[0], tokenizer(subs))
    ratio = wave_t.size(1) / emission.size(1) / bundle.sample_rate
    times = [None] * len(pairs)
    scores = []
    for k, sp in zip(owner, spans):
        s, e = sp[0].start * ratio, sp[-1].end * ratio
        scores += [t.score for t in sp]
        times[k] = (s, e) if times[k] is None else (min(times[k][0], s), max(times[k][1], e))
    out = []
    for k, (shown, _) in enumerate(pairs):
        if times[k] is None:  # harfi olmayan kelime (ör. "—"): komşularının arasına
            prev_e = out[-1]["e"] if out else 0.0
            nxt = next((times[j][0] for j in range(k + 1, len(pairs)) if times[j]), prev_e + 0.2)
            times[k] = (prev_e, max(prev_e + 0.05, nxt))
        out.append({"w": shown, "s": round(times[k][0], 3), "e": round(times[k][1], 3)})
    return {"ok": True, "words": out, "score": round(sum(scores) / max(1, len(scores)), 3)}


def main():
    """Toplu: model bir kez yüklenir (1,2 GB). İş dosyası: [{"wav": yol, "pairs": [[ekranda, söylenen], ...]}, ...]
    ya da eski biçim: SES.wav KELIMELER.json (tek iş)."""
    import torch
    import torchaudio
    if len(sys.argv) > 2:
        jobs = [{"wav": sys.argv[1], "pairs": json.loads(open(sys.argv[2], encoding="utf-8").read())}]
    else:
        jobs = json.loads(open(sys.argv[1], encoding="utf-8").read())
    bundle = torchaudio.pipelines.MMS_FA
    model = bundle.get_model(with_star=False)
    model.eval()
    device = "cpu"
    try:  # Apple Silicon GPU varsa model orada (hizalama adımı yine CPU)
        if torch.backends.mps.is_available():
            model = model.to("mps")
            device = "mps"
    except Exception:
        model, device = model.to("cpu"), "cpu"
    tokenizer, aligner = bundle.get_tokenizer(), bundle.get_aligner()
    results = []
    for j in jobs:
        try:
            results.append(align_one(model, tokenizer, aligner, bundle, j["wav"], j["pairs"], device))
        except Exception as e:
            if device == "mps":  # MPS'te desteklenmeyen işlem: CPU ile bir kez daha
                try:
                    model, device = model.to("cpu"), "cpu"
                    results.append(align_one(model, tokenizer, aligner, bundle, j["wav"], j["pairs"], device))
                    continue
                except Exception as e2:
                    e = e2
            results.append({"ok": False, "error": str(e)[:300]})
    print(json.dumps(results[0] if len(sys.argv) > 2 else {"ok": True, "results": results}, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(json.dumps({"ok": False, "error": str(e)[:300]}, ensure_ascii=False))
