"""Ortak yardımcılar: veri dosyaları, .env, zaman."""
import json
import os
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
SECRETS = ROOT / "secrets"
OUT = ROOT / "out"
DATA.mkdir(exist_ok=True)


def load_json(path: Path, default):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except Exception:
        return default


def save_json(path: Path, obj):
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    tmp = Path(str(path) + ".tmp")
    tmp.write_text(json.dumps(obj, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(path)


def load_env():
    env = {}
    p = SECRETS / ".env"
    if p.exists():
        for line in p.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                env[k.strip()] = v.strip().strip('"').strip("'")
    env.update({k: v for k, v in os.environ.items() if k.startswith(("IG_", "TIKTOK_")) or k == "PUBLIC_BASE_URL"})
    return env


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def metrics():
    return load_json(DATA / "metrics.json", {"videos": {}})


def save_metrics(m):
    save_json(DATA / "metrics.json", m)


def _deep_merge(a, b):
    out = dict(a)
    for k, v in (b or {}).items():
        out[k] = _deep_merge(a.get(k, {}), v) if isinstance(v, dict) and isinstance(a.get(k), dict) else v
    return out


def settings():
    return _deep_merge(_DEFAULTS, load_json(DATA / "settings.json", {}))


_DEFAULTS = ({
        "autopublish": {"youtube": False, "instagram": False, "tiktok": False},
        "dailyReportHour": 9,
        "metricsSyncMinutes": 60,
        "channelName": "Türkiye Gündemi",
        "hashtags": "#gündem #haber #türkiye #sondakika #shorts",
        "assistantName": "Emixhas",
        "wakeWords": ["emixhas", "emiks has", "emiks", "emix", "emixas", "emikhas", "emihas", "e mix has", "emiş has", "emişhas"],
        "fullAuthority": True,
        "voice": {"engine": "auto", "name": "Yelda", "rate": 195, "piperLength": 0.85, "piperNoise": 0.5},
        "narrationEngine": "auto",
        # Video anlatım sesi: single → voice; alternate → kanca/1./3. haber voiceA, intro/2./4. haber voiceB (scripts/voices.py)
        "narration": {"mode": "single", "voice": "auto", "voiceA": "vox-kadin", "voiceB": "vox-erkek"},
        "claudeEffort": {"script": "medium", "brain": "high"},
        "formats": {
            "sabah": {"hours": [5, 11], "duration": 45, "label": "Güne Başlarken", "intro": "Güne başlarken Türkiye gündemi.", "tone": "sakin, bilgilendirici, günün ajandasını kuran"},
            "ogle": {"hours": [11, 17], "duration": 30, "label": "Son Dakika", "intro": "Son dakika, Türkiye gündemi.", "tone": "hızlı, net, en yeni gelişmeler öncelikli"},
            "aksam": {"hours": [17, 29], "duration": 90, "label": "Günün Özeti", "intro": "Günün özeti, Türkiye gündemi.", "tone": "toparlayıcı, günün en önemli olaylarını sıralayan"},
        },
        "musicVolume": 0.07,
        "chatterbox": {"port": 3139, "refVoice": "voices/ref.wav", "exaggeration": 0.4, "cfg": 0.55, "autoStart": False},
        # Türkçe doğal ses: Trendyol-TTS (VoxCPM2 tabanlı, MIT) + EMA Lightning (Apache-2.0). Kurulum: scripts/install_turkish_voice.sh
        "turkishVoice": {"python": ".venv-tr/bin/python", "trendyolBin": ".venv-tr/bin/trendyol-tts", "mlxModel": "models/Trendyol-TTS-mlx",
                         "torchModel": "Trendyol/Trendyol-TTS", "baseModel": "openbmb/VoxCPM2", "backend": "auto", "cfg": 2.0, "steps": 16, "seed": 42, "refVoice": "", "emaSpeed": 1.0},
    })


def pick_format(hour: int | None = None):
    """Saate göre format: sabah 05-11, öğle 11-17, akşam 17-05."""
    from datetime import datetime
    h = datetime.now().hour if hour is None else hour
    for key, f in settings()["formats"].items():
        lo, hi = f["hours"]
        if lo <= h < hi or lo <= h + 24 < hi:
            return key, f
    return "aksam", settings()["formats"]["aksam"]


def episode_meta(video_name: str):
    return load_json(OUT / video_name.replace(".mp4", ".json"), None)


def build_caption(video_name: str, max_len: int = 2000):
    """Yayın başlığı ve açıklaması senaryo meta'sından üretilir."""
    meta = episode_meta(video_name) or {}
    s = settings()
    haber = [x for x in meta.get("segments", []) if x.get("kind") == "haber"]
    first = meta.get("publishTitle") or (haber[0]["title"] if haber else "Günün özeti")
    title = f"{first} | {s['channelName']} {meta.get('dateLabel', '')} #Shorts".strip()
    lines = [f"{s['channelName']} · {meta.get('dateLabel', '')} · günün {meta.get('episodeOfDay', '')}. özeti", ""]
    for i, h in enumerate(haber, 1):
        lines.append(f"{i}. {h['title']}" + (f" ({h.get('source')})" if h.get("source") else ""))
    lines += ["", s["hashtags"]]
    return title[:100], "\n".join(lines)[:max_len]
