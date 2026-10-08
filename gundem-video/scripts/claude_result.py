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
d = json.loads(Path(raw).read_text(encoding="utf-8"))
Path(out).write_text(d.get("result", ""), encoding="utf-8")
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
print("senaryo hazır")
