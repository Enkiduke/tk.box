#!/usr/bin/env python3
"""tk.box's Plex Metadata cleanup: the poster files the artwork engine (artwork_engine.py) sent to Plex that Plex no longer uses.

Plex keeps every poster ever uploaded in its Metadata folder, and its API can't delete one. This script reads which
images Plex still uses from a copy of its library database (which Plex makes itself), then works on the files in
plex.data_dir/Metadata directly:

- report, move, remove, restore: every unused poster the artwork engine made, anywhere in Metadata;
- superseded KEY...: just the old posters of those items, after their new ones went up.

Only files carrying both of the artwork engine's EXIF markers are ever touched, and never one Plex still uses. It reads
the same JSON config tk.box writes for the artwork engine (engine_common.py's checks). Requires Pillow (to read EXIF
tags) and requests.
"""

import argparse
import contextlib
import os
from pathlib import Path
import shutil
import sqlite3
import sys
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import urlparse
import xml.etree.ElementTree as ET
import zipfile

from PIL import Image

from engine_common import (HTTP, OVERLAY_EXIF_TAG, OVERLAY_EXIF_VALUE, SOFTWARE_EXIF_TAG, SOFTWARE_EXIF_VALUES, Plex, local_path,
                           option, read_config, run_lock)


IN_USE_FIELDS = (("user_thumb_url", True), ("user_art_url", True), ("user_banner_url", False),
                 ("user_clear_logo_url", False), ("user_square_art_url", False))


def plex_snapshot(plex, folder):
    """Download a consistent copy of Plex's library database (made by Plex itself, so recent writes are in it)."""
    target = folder / "download"
    with plex.http.request("GET", plex.url + "/diagnostics/databases", headers=plex.headers, stream=True) as response:
        with target.open("wb") as handle:
            for chunk in response.iter_content(1 << 20):
                handle.write(chunk)
    with target.open("rb") as handle:
        head = handle.read(16)
    if head.startswith(b"PK"):
        with zipfile.ZipFile(target) as archive:
            name = next((n for n in archive.namelist() if Path(n).name.startswith("databaseBackup") or n.endswith(".db")), None)
            if name is None:
                raise ValueError("Plex's database download contained no database")
            database = folder / "library.db"
            with archive.open(name) as source, database.open("wb") as out:
                shutil.copyfileobj(source, out)
        return database
    if head.startswith(b"SQLite format 3"):
        return target
    raise ValueError("Plex's database download was not a database")


def images_in_use(database):
    """File names of every uploaded/selected image Plex still refers to (ImageMaid's list, from metadata_items)."""
    names = set()
    connection = sqlite3.connect(f"file:{database}?mode=ro", uri=True)
    try:
        for field, required in IN_USE_FIELDS:
            try:
                rows = connection.execute(f"SELECT {field} FROM metadata_items WHERE {field} LIKE 'upload://%' OR {field} LIKE 'metadata://%'").fetchall()
            except sqlite3.OperationalError:
                if required:  # Never guess: a missing column would make everything look unused.
                    raise ValueError(f"Plex's database has no {field} column; refusing to clean up") from None
                continue
            names.update(urlparse(url).path.split("/")[-1] for (url,) in rows if url)
    finally:
        connection.close()
    if not names:
        raise ValueError("No images in use were found in Plex's database; refusing to clean up")
    return names


def made_by_engine(tags, scope="ours"):
    """Whether an image's EXIF tags say the artwork engine made it (scope "overlays": any overlay poster, Kometa's included)."""
    return tags.get(OVERLAY_EXIF_TAG) == OVERLAY_EXIF_VALUE and (scope == "overlays" or str(tags.get(SOFTWARE_EXIF_TAG, "")).startswith(SOFTWARE_EXIF_VALUES))


def plex_bundles(database, metadata, rating_keys):
    """{rating key: its Metadata bundle folders}: the item's own and its parents' (a season's or episode's files may sit in
    its show's). Plex keeps a hash per item, and its bundle is Metadata/<kind>/<first character>/<the rest>.bundle."""
    connection = sqlite3.connect(f"file:{database}?mode=ro", uri=True)
    try:
        found = {}
        for key in rating_keys:
            found[key], current = [], int(key)
            for _ in range(3):  # The item, its season, its show
                row = connection.execute("SELECT parent_id, hash FROM metadata_items WHERE id = ?", (current,)).fetchone()
                if row is None:
                    break
                parent, digest = row
                if digest:
                    found[key] += [path for path in metadata.glob(f"*/{digest[0]}/{digest[1:]}.bundle") if path.is_dir()]
                if not parent:
                    break
                current = parent
        return found
    finally:
        connection.close()


def remove_superseded_posters(plex, metadata, uploaded):
    """After uploading, delete the posters those items had before from Plex's Metadata folder (its API
    can't delete one). `uploaded` is {rating key: label}. Only a file that Plex lists for the item without selecting it, that
    no item uses any more, that sits in the item's own bundle folders and that carries both of the engine's tags is removed."""
    def unselected(key):
        photos = plex.xml(f"/library/metadata/{key}/posters").findall("Photo")
        return {urlparse(p.get("ratingKey")).path.split("/")[-1] for p in photos
                if (p.get("ratingKey") or "").startswith("upload://") and p.get("selected") != "1"}
    keys = list(uploaded)
    with ThreadPoolExecutor(8) as pool:
        names = {key: found for key, found in zip(keys, pool.map(unselected, keys)) if found}
    if not names:
        return 0
    with tempfile.TemporaryDirectory() as folder:  # Taken after the uploads, so the new posters count as in use
        database = plex_snapshot(plex, Path(folder))
        in_use, bundles = images_in_use(database), plex_bundles(database, metadata, names)
    removed = 0
    for key, found in names.items():
        if not bundles[key]:
            print(f"WARN {uploaded[key]}: its folder in Plex's Metadata wasn't found, so its old posters stay (plex_cleanup.py remove finds them)", file=sys.stderr, flush=True)
        wanted = found - in_use
        for bundle in bundles[key]:
            for root, _, files in os.walk(bundle / "Uploads"):
                for name in sorted(wanted.intersection(files)):
                    path = Path(root) / name
                    try:
                        with Image.open(path) as image:
                            ours = made_by_engine(image.getexif())
                        if ours:
                            path.unlink()
                    except (OSError, ValueError) as error:
                        print(f"WARN {uploaded[key]}: {path}: {error}", file=sys.stderr, flush=True)
                        continue
                    if ours:
                        removed += 1
                        print(f"REMOVED old poster of {uploaded[key]}: {name}", flush=True)
    print(f"Removed {removed} superseded tk.box poster{'s' * (removed != 1)}.", flush=True)
    return removed


def engine_orphans(metadata, in_use, min_age_seconds, scope="ours"):
    """Uploaded poster files that Plex no longer uses and that the artwork engine made (both EXIF tags). scope "overlays" takes
    any overlay poster, Kometa's included.

    Only files inside an Uploads folder (never Contents), with no extension, not in use, old enough to be sure the
    database snapshot saw them, and carrying our markers."""
    cutoff = time.time() - min_age_seconds
    found = []
    for root, _, files in os.walk(metadata):
        parts = Path(root).parts
        if "Contents" in parts or "Uploads" not in parts:
            continue
        for name in files:
            if "." in name or name in in_use:
                continue
            path = Path(root) / name
            try:
                if path.stat().st_mtime > cutoff:
                    continue
                with Image.open(path) as image:
                    tags = image.getexif()
            except (OSError, ValueError):
                continue
            if made_by_engine(tags, scope):
                found.append(path)
    return sorted(found)


def cleanup(config_path, mode="report"):
    """Find (report), set aside (move), delete (remove) or bring back (restore) unused tk.box posters."""
    config = read_config(config_path)
    plex = config.get("plex", {})
    base = config_path.resolve().parent
    data_dir = metadata_folder(config, base)
    metadata, restore = data_dir / "Metadata", data_dir / "tk.box Restore"
    if mode == "restore":
        files = [path for path in restore.rglob("*") if path.is_file()] if restore.is_dir() else []
        for path in files:
            target = metadata / path.relative_to(restore)
            target.parent.mkdir(parents=True, exist_ok=True)
            print(f"RESTORE {target}")
            shutil.move(str(path), str(target))
        if restore.is_dir():
            shutil.rmtree(restore)
        print(f"Restored {len(files)} files.")
        return 0
    http = HTTP(local_path(option(config, "cache_dir"), base))
    server = Plex(http, config)
    server.require("Cleanup (to ask Plex which images are in use)")
    with tempfile.TemporaryDirectory() as folder:
        in_use = images_in_use(plex_snapshot(server, Path(folder)))
    orphans = engine_orphans(metadata, in_use, float(option(plex, "cleanup_min_age_minutes")) * 60)
    size = 0
    label = {"report": "UNUSED", "move": "MOVE", "remove": "REMOVE"}[mode]
    for path in orphans:
        size += path.stat().st_size
        print(f"{label} {path}", flush=True)
        if mode == "move":
            target = restore / path.relative_to(metadata)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(path), str(target))
        elif mode == "remove":
            path.unlink()
    done = {"report": "Found", "move": "Moved", "remove": "Removed"}[mode]
    print(f"{done} {len(orphans)} unused tk.box posters ({size / 1e6:.1f} MB); {len(in_use)} images are in use.")
    if mode == "report" and orphans:
        print("Nothing was changed. Use move to set them aside (reversible with restore), or remove to delete them.")
    return 0


def metadata_folder(config, base):
    data_dir = config.get("plex", {}).get("data_dir")
    if not data_dir:
        raise ValueError("Cleanup needs plex.data_dir: the path of Plex's data folder (the one holding Metadata and Plug-in Support)")
    data_dir = local_path(data_dir, base)
    if not (data_dir / "Metadata").is_dir():
        raise ValueError(f"plex.data_dir does not hold a Metadata folder: {data_dir}")
    return data_dir


def superseded(config_path, rating_keys):
    """superseded: the old posters of these items (just sent to Plex) are removed; see remove_superseded_posters."""
    config = read_config(config_path)
    base = config_path.resolve().parent
    metadata = metadata_folder(config, base) / "Metadata"
    plex = Plex(HTTP(local_path(option(config, "cache_dir"), base)), config)
    plex.require("Removing old posters (to ask Plex which images are in use)")
    remove_superseded_posters(plex, metadata, {str(key): f"item {key}" for key in rating_keys})
    return 0


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("config", type=Path, help="The JSON config tk.box writes for the artwork engine")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("report", help="List the unused posters; changes nothing")
    commands.add_parser("move", help="Set them aside in plex.data_dir/tk.box Restore (reversible with restore)")
    commands.add_parser("remove", help="Delete them")
    commands.add_parser("restore", help="Put back what move set aside")
    commands.add_parser("superseded", help="Delete the old posters of these items, after their new ones were sent to Plex").add_argument(
        "rating_keys", type=int, nargs="+", metavar="PLEX_ID")
    args = parser.parse_args()
    if hasattr(os, "nice"):
        with contextlib.suppress(OSError):
            os.nice(10)  # Plex, its transcoder and anyone else on the machine come first
    try:
        with run_lock(args.config) if args.command != "report" else contextlib.nullcontext():
            if args.command == "superseded":
                return superseded(args.config, args.rating_keys)
            return cleanup(args.config, args.command)
    except (OSError, ValueError, TypeError, RuntimeError, ET.ParseError, sqlite3.Error, zipfile.BadZipFile) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
