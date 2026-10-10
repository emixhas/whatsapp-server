#!/usr/bin/env python3
"""claude -p --output-format json çıktısından metni ayırır, token kullanımını loglar ve data/usage.json'a ekler.
Kullanım: python3 scripts/claude_result.py work/claude_raw.json work/claude_out.json senaryo
"""
import json
import sys
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import DATA, load_json, save_json  # noqa: E402

raw, out, kind = sys.argv[1], sys.argv[2], (sys.argv[3] if len(sys.argv) > 3 else "senaryo")
try:
    d = json.loads(Path(raw).read_text(encoding="utf-8"))
except Exception:  # claude JSON yerine düz hata yazdıysa
    txt = Path(raw).read_text(encoding="utf-8", errors="replace").strip()
    print(f"  ! Claude yanıtı okunamadı: {txt[:300] or '(boş)'}")
    sys.exit(3)
result = d.get("result") or ""
Path(out).write_text(result, encoding="utf-8")
u = d.get("usage", {})
inp = u.get("input_tokens", 0) + u.get("cache_creation_input_tokens", 0) + u.get("cache_read_input_tokens", 0)
outp = u.get("output_tokens", 0)
think = (u.get("output_tokens_details") or {}).get("thinking_tokens", 0)
cost = float(d.get("total_cost_usd") or 0)
usage = load_json(DATA / "usage.json", {"days": {}, "total": {"calls": 0, "input": 0, "output": 0, "cost": 0.0}})
day = usage["days"].setdefault(date.today().isoformat(), {"calls": 0, "input": 0, "output": 0, "cost": 0.0, "byKind": {}})
for bucket in (day, usage["total"]):
    bucket["calls"] += 1; bucket["input"] += inp; bucket["output"] += outp; bucket["cost"] = round(bucket["cost"] + cost, 4)
k = day["byKind"].setdefault(kind, {"calls": 0, "input": 0, "output": 0, "cost": 0.0})
k["calls"] += 1; k["input"] += inp; k["output"] += outp; k["cost"] = round(k["cost"] + cost, 4)
save_json(DATA / "usage.json", usage)
# Çıkış kodları pipeline.sh için: 2 = kalıcı (kullanım sınırı/oturum) → tekrar deneme yok, 3 = JSON yok → bir kez daha dene
low = result.lower()
if d.get("is_error") or d.get("subtype") not in (None, "success"):
    print(f"  ! Claude hata döndürdü ({d.get('subtype') or 'error'}): {result[:300] or '(boş yanıt)'}")
    sys.exit(2 if any(k in low for k in ("usage", "limit", "credit", "login", "auth", "kullanım")) else 3)
if "{" not in result:
    print(f"  ! Claude senaryo yerine düz metin döndürdü: {result[:300] or '(boş yanıt)'}")
    sys.exit(2 if any(k in low for k in ("usage limit", "out of usage", "credit", "/login", "rate limit")) else 3)
print("senaryo hazır")
