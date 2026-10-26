#!/usr/bin/env python3
"""Relay the City of Toronto unofficial results feeds into the `data` branch.

The City's feed does not send CORS headers, so browsers on another origin
cannot read it. This runs inside GitHub Actions, polls both feeds, and
force-pushes a single-commit `data` branch holding bundle.json whenever the
results change (plus a heartbeat so viewers can see the relay is alive).
The feed JSON is stored byte-for-byte as received - nothing is dropped.
"""
import hashlib
import json
import os
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

FEEDS = {
    "all": "https://mediaresults.toronto.ca/results/unofficialresult.json",
    "wardbyward": "https://mediaresults.toronto.ca/results/unofficialresult-wardbyward.json",
}
INTERVAL = int(os.environ.get("INTERVAL", "45"))
DURATION = int(os.environ.get("DURATION", "3300"))
HEARTBEAT = int(os.environ.get("HEARTBEAT", "300"))
REPO = os.environ["GITHUB_REPOSITORY"]
TOKEN = os.environ["GITHUB_TOKEN"]

state = {k: {"etag": None, "lastModified": None, "text": None} for k in FEEDS}


def now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def fetch(key):
    s = state[key]
    req = urllib.request.Request(FEEDS[key], headers={"User-Agent": "toronto-election-relay (GitHub Actions)"})
    if s["etag"]:
        req.add_header("If-None-Match", s["etag"])
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            text = r.read().decode("utf-8")
            json.loads(text)  # refuse to publish a truncated or invalid file
            s.update(text=text, etag=r.headers.get("ETag"), lastModified=r.headers.get("Last-Modified"))
            return True
    except urllib.error.HTTPError as e:
        if e.code == 304:
            return False
        print(f"{now()} {key}: HTTP {e.code}")
    except Exception as e:  # network blip or bad JSON - keep the last good copy
        print(f"{now()} {key}: {e!r}")
    return False


def content_hash():
    """Hash of the results ignoring `seq`, which changes on every regeneration."""
    h = hashlib.sha256()
    for k in FEEDS:
        if state[k]["text"]:
            d = json.loads(state[k]["text"])
            d.pop("seq", None)
            h.update(json.dumps(d, sort_keys=True).encode())
    return h.hexdigest()


def push(changed_at):
    bundle = {
        "relayedAt": now(),
        "changedAt": changed_at,
        "sources": {
            k: {"url": FEEDS[k], "etag": state[k]["etag"], "lastModified": state[k]["lastModified"]} for k in FEEDS
        },
    }
    body = json.dumps(bundle)[:-1]
    # Splice the raw feed text in unchanged so the published copy is exactly what the City served.
    body += "".join(f',"{k}":{state[k]["text"] or "null"}' for k in FEEDS) + "}"
    with tempfile.TemporaryDirectory() as d:
        open(os.path.join(d, "bundle.json"), "w").write(body)
        git = lambda *a: subprocess.run(["git", "-C", d, *a], check=True, capture_output=True)
        git("init", "-q", "-b", "data")
        git("add", "bundle.json")
        git("-c", "user.name=results-relay", "-c", "user.email=actions@users.noreply.github.com",
            "commit", "-q", "-m", f"results {bundle['relayedAt']}")
        git("push", "-q", "--force", f"https://x-access-token:{TOKEN}@github.com/{REPO}.git", "data:data")
    print(f"{now()} pushed (changedAt {changed_at})")


def main():
    end = time.time() + DURATION
    last_hash, last_push, changed_at = None, 0.0, now()
    while time.time() < end:
        for k in FEEDS:
            fetch(k)
        h = content_hash()
        if h != last_hash:
            changed_at = now()
        if h != last_hash or time.time() - last_push >= HEARTBEAT:
            try:
                push(changed_at)
                last_hash, last_push = h, time.time()
            except subprocess.CalledProcessError as e:
                print(f"{now()} push failed: {e.stderr.decode()[-300:]}")
        time.sleep(INTERVAL)


if __name__ == "__main__":
    main()
