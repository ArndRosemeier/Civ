#!/usr/bin/env python3
"""Register this app in futuremagic.de's app registry.

The site's landing page reads `/apps.json` at the web root: a list of `{slug, title, path,
updatedAt, manifesto}` entries, one per app. Campaigner does this with a Windows-only helper
(`Register-FuturemagicApp.ps1`, run by `deploy-sync.ps1`); the Linux deploy explicitly skips it, so
this is that step, written to be run from here.

**It edits one entry and leaves every other one alone.** `apps.json` is shared by every app on the
site, so the file is fetched, the entry for our slug is upserted, and the rest is written back
untouched — never regenerated from our own state, which would delete every other app.

The previous contents are saved next to this script before anything is uploaded, so a bad edit can be
undone by hand. `--dry-run` prints the merge and uploads nothing.

Password comes from FTP_PASSWORD in the environment only (same contract as `deploy-ftp.py`).

Usage:
  FTP_PASSWORD=... python3 register-app.py --server ftp.futuremagic.de --user 12529-Pyrion \
      --slug Civ --title CivTS --manifesto packages/web/public/futuremagic.json
"""

from __future__ import annotations

import argparse
import ftplib
import io
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

REGISTRY = "/apps.json"


def dotnet_timestamp() -> str:
    """`2026-09-02T21:32:33.6057207Z` — the shape the existing entries use.

    Seven fractional digits and a `Z`, because the file was written by .NET and every entry in it
    already looks like this. Reproducing the format rather than choosing a nicer one keeps the file
    uniform for whatever reads it.
    """
    now = datetime.now(timezone.utc)
    return f"{now.strftime('%Y-%m-%dT%H:%M:%S')}.{now.microsecond:06d}0Z"


def fetch_registry(ftp: ftplib.FTP) -> dict:
    buffer = io.BytesIO()
    ftp.retrbinary(f"RETR {REGISTRY}", buffer.write)
    return json.loads(buffer.getvalue().decode("utf-8"))


def upsert(registry: dict, entry: dict) -> tuple[dict, str]:
    """Return the registry with `entry` in place, and whether it was new or an update."""
    apps = registry.get("apps")
    if not isinstance(apps, list):
        raise SystemExit(f"{REGISTRY} has no 'apps' list; refusing to overwrite it")
    for index, existing in enumerate(apps):
        if isinstance(existing, dict) and existing.get("slug") == entry["slug"]:
            apps[index] = entry
            return registry, "updated"
    apps.append(entry)
    return registry, "added"


def main() -> int:
    parser = argparse.ArgumentParser(description="Register this app in /apps.json.")
    parser.add_argument("--server", required=True)
    parser.add_argument("--user", required=True)
    parser.add_argument("--slug", required=True)
    parser.add_argument("--title", required=True)
    parser.add_argument("--path", default=None, help="defaults to /<slug>/")
    parser.add_argument("--manifesto", default=None, help="local manifesto to read the title from")
    parser.add_argument("--backup-dir", default=None)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    password = os.environ.get("FTP_PASSWORD")
    if not password:
        print("Error: FTP_PASSWORD is not set.", file=sys.stderr)
        return 1

    title = args.title
    if args.manifesto:
        manifesto = json.loads(Path(args.manifesto).read_text(encoding="utf-8"))
        title = manifesto.get("title", title)

    entry = {
        "slug": args.slug,
        "title": title,
        "path": args.path or f"/{args.slug}/",
        "updatedAt": dotnet_timestamp(),
        "manifesto": True,
    }

    ftp = ftplib.FTP(args.server, timeout=120)
    try:
        ftp.login(args.user, password)
        ftp.set_pasv(True)
        before = fetch_registry(ftp)
        registry, how = upsert(before, entry)
    finally:
        try:
            ftp.quit()
        except Exception:
            ftp.close()

    print(f"{REGISTRY}: {len(before.get('apps', []))} app(s) before, entry {how}")
    print(json.dumps(entry, indent=2))

    if args.dry_run:
        print("--dry-run: nothing uploaded.")
        return 0

    backup_dir = Path(args.backup_dir) if args.backup_dir else Path.cwd()
    backup = backup_dir / f"apps.json.backup-{datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S')}"
    backup.write_bytes(json.dumps(before, indent=4).encode("utf-8"))
    print(f"Previous registry saved to {backup}")

    payload = json.dumps(registry, indent=4).encode("utf-8")
    ftp = ftplib.FTP(args.server, timeout=120)
    try:
        ftp.login(args.user, password)
        ftp.set_pasv(True)
        ftp.storbinary(f"STOR {REGISTRY}", io.BytesIO(payload))
    finally:
        try:
            ftp.quit()
        except Exception:
            ftp.close()

    print(f"Uploaded {REGISTRY} ({len(payload)} bytes, {len(registry['apps'])} apps).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
