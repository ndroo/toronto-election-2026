#!/usr/bin/env python3
"""Copies one election's saved feed versions from the `archive` branch into replay/, for the page's ?replay mode.

    python3 scripts/replay-pack.py [archive folder]     (default: 2026)

Writes replay/<UTC time>.json.gz (unchanged from the archive) and replay/index.json, the list in time order with
whether each version has any results yet (the replay starts just before the first ones).
"""
import gzip
import json
import os
import shutil
import subprocess
import sys

root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
folder = sys.argv[1] if len(sys.argv) > 1 else "2026"
git = lambda *a: subprocess.run(["git", "-C", root, *a], check=True, capture_output=True).stdout
git("fetch", "-q", "origin", "archive")
names = sorted(n for n in git("ls-tree", "-r", "--name-only", "origin/archive", f"archive/{folder}/").decode().split() if n.endswith(".json.gz"))
out = os.path.join(root, "replay")
shutil.rmtree(out, ignore_errors=True)
os.makedirs(out)
files = []
for n in names:
    raw = git("show", f"origin/archive:{n}")
    b = json.loads(gzip.decompress(raw))
    base = os.path.basename(n)
    open(os.path.join(out, base), "wb").write(raw)
    mayor = next(o for o in b["all"]["office"] if o["id"] == 1)["ward"][0]
    files.append({"file": base, "t": b["relayedAt"], "results": int(mayor.get("pollsReceived") or 0) > 0})
json.dump({"archive": folder, "files": files}, open(os.path.join(out, "index.json"), "w"), indent=0)
print(f"replay/: {len(files)} versions, first results in #{next((i for i, f in enumerate(files) if f['results']), -1) + 1}")
