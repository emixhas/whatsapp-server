#!/usr/bin/env python3
"""Yerel doğal ses sunucusu: Chatterbox Multilingual (MIT) modelini bir kez yükler, HTTP ile seslendirir.

  python3 scripts/tts_server.py            → http://127.0.0.1:3139
  POST /tts  {"text": "...", "lang": "tr", "ref": "voices/ref.wav", "exaggeration": 0.5, "cfg": 0.5}  → audio/wav
  GET  /health → {"ready": true, "device": "mps"}

Model ilk çalıştırmada Hugging Face'ten iner (~2 GB), sonra yerel çalışır. Referans ses verilirse
o sesi klonlar; verilmezse modelin varsayılan sesi kullanılır. Her çıktıya duyulmayan PerTh filigranı eklenir.
"""
import io
import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PORT = int(os.environ.get("TTS_PORT", "3139"))
STATE = {"ready": False, "device": None, "error": None, "loading": False}
MODEL = {"m": None}
LOCK = threading.Lock()


def log(msg):
    print(msg, flush=True)


def load_model():
    STATE["loading"] = True
    try:
        import torch
        import torchaudio  # noqa: F401
        from chatterbox.mtl_tts import ChatterboxMultilingualTTS
        device = "mps" if torch.backends.mps.is_available() else ("cuda" if torch.cuda.is_available() else "cpu")
        if device == "mps":
            # Chatterbox bazı tensörleri cuda/cpu varsayar; MPS'te yükleme için map_location düzeltmesi
            _orig = torch.load
            torch.load = lambda *a, **k: _orig(*a, **{**k, "map_location": k.get("map_location", "cpu")})
        log(f"[tts] model yükleniyor (cihaz: {device})…")
        t0 = time.time()
        MODEL["m"] = ChatterboxMultilingualTTS.from_pretrained(device=device)
        STATE.update({"ready": True, "device": device})
        log(f"[tts] hazır ({time.time() - t0:.0f} sn)")
    except Exception as e:
        STATE["error"] = f"{type(e).__name__}: {e}"
        log(f"[tts] HATA: {STATE['error']}")
    finally:
        STATE["loading"] = False


def synth(text, lang="tr", ref=None, exaggeration=0.5, cfg=0.5):
    import torch
    import torchaudio
    m = MODEL["m"]
    kw = {"language_id": lang, "exaggeration": float(exaggeration), "cfg_weight": float(cfg)}
    if ref:
        p = Path(ref) if Path(ref).is_absolute() else ROOT / ref
        if p.exists():
            kw["audio_prompt_path"] = str(p)
    with LOCK:
        wav = m.generate(text, **kw)
    buf = io.BytesIO()
    torchaudio.save(buf, wav.cpu() if hasattr(wav, "cpu") else torch.tensor(wav), m.sr, format="wav")
    return buf.getvalue()


class H(BaseHTTPRequestHandler):
    def _json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)

    def do_GET(self):
        if self.path.startswith("/health"):
            return self._json(200, STATE)
        self._json(404, {"error": "yok"})

    def do_POST(self):
        if self.path != "/tts":
            return self._json(404, {"error": "yok"})
        n = int(self.headers.get("Content-Length", "0"))
        try:
            req = json.loads(self.rfile.read(n) or b"{}")
        except Exception:
            return self._json(400, {"error": "geçersiz JSON"})
        if not STATE["ready"]:
            return self._json(503, {"error": STATE["error"] or "model henüz yüklenmedi", "loading": STATE["loading"]})
        text = (req.get("text") or "").strip()
        if not text:
            return self._json(400, {"error": "metin boş"})
        try:
            t0 = time.time()
            data = synth(text, req.get("lang", "tr"), req.get("ref"), req.get("exaggeration", 0.5), req.get("cfg", 0.5))
            log(f"[tts] {len(text)} karakter → {len(data) // 1000} KB, {time.time() - t0:.1f} sn")
        except Exception as e:
            return self._json(500, {"error": f"{type(e).__name__}: {e}"})
        self.send_response(200); self.send_header("Content-Type", "audio/wav"); self.send_header("Content-Length", str(len(data))); self.end_headers(); self.wfile.write(data)

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    threading.Thread(target=load_model, daemon=True).start()
    log(f"[tts] sunucu http://127.0.0.1:{PORT}")
    HTTPServer(("127.0.0.1", PORT), H).serve_forever()
