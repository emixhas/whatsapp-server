"""Chatterbox ses sunucusuna istemci. Sunucu yoksa None döner (çağıran yedek motora düşer)."""
import json
import urllib.request
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
