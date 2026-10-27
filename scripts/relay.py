#!/usr/bin/env python3
"""Archive every version of the City of Toronto unofficial results feeds on election night.

Runs inside GitHub Actions (.github/workflows/relay.yml), polls both feeds, and each time the results change adds
the pair, gzipped, to the `archive` branch as archive/<election id>/<UTC time>.json.gz (one file per change, never
rewritten). The feed JSON is stored byte-for-byte as received. scripts/replay-pack.py turns these into the
page's ?replay mode. The page itself reads the results Worker, not this.
"""
import base64
import gzip
import hashlib
import json
import os
import re
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
REPO = os.environ["GITHUB_REPOSITORY"]
TOKEN = os.environ["GITHUB_TOKEN"]
ARCHIVE_BRANCH = "archive"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ELECTION = os.environ.get("ELECTION") or re.search(r"id: '([^']+)'", open(os.path.join(ROOT, "election.js")).read()).group(1)

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


def api(method, path, body=None):
    req = urllib.request.Request(f"https://api.github.com/repos/{REPO}{path}", method=method,
                                 data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Authorization": f"Bearer {TOKEN}", "Accept": "application/vnd.github+json",
                                          "User-Agent": "toronto-election-relay"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read() or b"null")


def ensure_archive_branch():
    """Create the archive branch as a separate history (no site files) the first time."""
    try:
        api("GET", f"/git/ref/heads/{ARCHIVE_BRANCH}")
        return
    except urllib.error.HTTPError as e:
        if e.code != 404:
            raise
    readme = ("# Results archive\n\nEvery version of the City of Toronto unofficial results feed seen on election night, "
              "as relayed to the results page: `archive/<election>/<UTC time>.json.gz`, each a gzipped bundle.json "
              "(both feed files byte-for-byte, plus relay metadata). For replays and future demos.\n")
    blob = api("POST", "/git/blobs", {"content": readme, "encoding": "utf-8"})
    tree = api("POST", "/git/trees", {"tree": [{"path": "README.md", "mode": "100644", "type": "blob", "sha": blob["sha"]}]})
    commit = api("POST", "/git/commits", {"message": "Start results archive", "tree": tree["sha"], "parents": []})
    api("POST", "/git/refs", {"ref": f"refs/heads/{ARCHIVE_BRANCH}", "sha": commit["sha"]})


def archive(body, relayed_at):
    stamp = relayed_at.replace(":", "").replace("-", "").replace("+0000", "Z")
    path = f"archive/{ELECTION}/{stamp}.json.gz"
    api("PUT", f"/contents/{path}", {"message": f"results {relayed_at}", "branch": ARCHIVE_BRANCH,
                                      "content": base64.b64encode(gzip.compress(body.encode(), mtime=0)).decode()})
    print(f"{now()} archived {path}")


def save(changed_at):
    bundle = {
        "relayedAt": now(),
        "changedAt": changed_at,
        "sources": {
            k: {"url": FEEDS[k], "etag": state[k]["etag"], "lastModified": state[k]["lastModified"]} for k in FEEDS
        },
    }
    body = json.dumps(bundle)[:-1]
    # Splice the raw feed text in unchanged so the saved copy is exactly what the City served.
    body += "".join(f',"{k}":{state[k]["text"] or "null"}' for k in FEEDS) + "}"
    ensure_archive_branch()
    archive(body, bundle["relayedAt"])


def main():
    end = time.time() + DURATION
    last_hash = None
    while time.time() < end:
        for k in FEEDS:
            fetch(k)
        h = content_hash()
        if h != last_hash:
            try:
                save(now())
                last_hash = h
            except Exception as e:  # try again next round
                print(f"{now()} archive failed: {e!r}")
        time.sleep(INTERVAL)


if __name__ == "__main__":
    main()
