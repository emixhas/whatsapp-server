"""Chatterbox ses sunucusuna istemci.

Sunucu sürekli açık TUTULMAZ (birkaç GB bellek kaplar). `on_demand()` yalnızca o iş için sunucuyu başlatır,
model yüklenene kadar bekler, iş bitince kapatır. Zaten açık bir sunucu varsa ona dokunmaz.
"""
import json
import os
import subprocess
import sys
import time
import urllib.request
from contextlib import contextmanager
from pathlib import Path

from common import settings


def chatterbox_ready(timeout=1.5):
    c = settings().get("chatterbox", {})
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{c.get('port', 3139)}/health", timeout=timeout) as r:
            return json.loads(r.read()).get("ready", False)
    except Exception:
        return False


def chatterbox_tts(text: str, out: Path, timeout=600) -> bool:
    c = settings().get("chatterbox", {})
    body = json.dumps({"text": text, "lang": "tr", "ref": c.get("refVoice"), "exaggeration": c.get("exaggeration", 0.45), "cfg": c.get("cfg", 0.5)}).encode()
    req = urllib.request.Request(f"http://127.0.0.1:{c.get('port', 3139)}/tts", data=body, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            Path(out).write_bytes(r.read())
        return True
    except Exception:
        return False


ROOT = Path(__file__).resolve().parent.parent


def _py():
    venv = ROOT / ".venv" / "bin" / "python3"
    return str(venv) if venv.exists() else sys.executable


def chatterbox_installed() -> bool:
    """chatterbox-tts paketi kurulu mu (içe aktarmadan, hızlı kontrol)."""
    code = "import importlib.util,sys;sys.exit(0 if importlib.util.find_spec('chatterbox') else 1)"
    try:
        return subprocess.run([_py(), "-c", code], capture_output=True, timeout=20).returncode == 0
    except Exception:
        return False


@contextmanager
def on_demand(wait_s: int = 900):
    """Chatterbox sunucusunu bu iş için aç, hazır olunca devam et, iş bitince kapat."""
    if chatterbox_ready():
        yield True
        return
    port = str(settings().get("chatterbox", {}).get("port", 3139))
    print("  🎤 Chatterbox modeli bu iş için yükleniyor (iş bitince kapanacak)", file=sys.stderr)
    proc = subprocess.Popen([_py(), str(ROOT / "scripts" / "tts_server.py")], cwd=str(ROOT),
                            env={**os.environ, "TTS_PORT": port}, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        t0 = time.time()
        while time.time() - t0 < wait_s and proc.poll() is None and not chatterbox_ready():
            time.sleep(2)
        ok = chatterbox_ready()
        if not ok:
            print("  ! Chatterbox sunucusu hazır olmadı", file=sys.stderr)
        yield ok
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=15)
        except Exception:
            proc.kill()
        print("  🎤 Chatterbox modeli kapatıldı, bellek boşaltıldı", file=sys.stderr)
