#!/usr/bin/env python3
"""tk.box's artwork engine (Overlayrr): Plex -> artwork APIs -> layouts -> disk/Plex.

Posters, season posters and title cards; making and changing Plex collections is plex_collections.py's.

tk.box writes the config as JSON from its database and runs this script for each job; credentials arrive in the
environment (PLEX_TOKEN, TMDB_API_KEY, TVDB_API_KEY, FANART_API_KEY). Requires Python 3.10+, Pillow, NumPy, PyYAML
(for Kometa/MediUX imports) and requests. Shares engine_common.py with plex_collections.py; no app imports.
"""

import argparse
import base64
import binascii
import contextlib
import hashlib
import io
import json
import math
import os
from pathlib import Path
import re
import sys
import textwrap
import threading
import time
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import asdict, dataclass, fields, replace
from datetime import date, timedelta
from functools import lru_cache
from urllib.parse import quote, urlencode, urlparse
import xml.etree.ElementTree as ET

# NumPy's math library (OpenBLAS) starts a busy-waiting thread per core at import: seconds of CPU on a big shared
# server for nothing, since this script only does per-pixel NumPy work. Set these variables yourself to override.
for _variable in ("OPENBLAS_NUM_THREADS", "OMP_NUM_THREADS", "MKL_NUM_THREADS"):
    os.environ.setdefault(_variable, "1")

import numpy as np
from PIL import Image, ImageChops, ImageColor, ImageDraw, ImageFilter, ImageFont, ImageOps
import yaml

from engine_common import (CHARTS, FANART, HTTP as SharedHTTP, IMAGE_BASE, IMAGE_TTL, OVERLAY_EXIF_TAG, OVERLAY_EXIF_VALUE,
                           SOFTWARE_EXIF_TAG, SOFTWARE_EXIF_VALUE, STREAMING, STREAMING_LOGOS, THUMB_TTL, WEB_UPLOAD_LIMIT,
                           Metadata, Plex, atomic_write, collection_key, custom_collection, is_url, local_path, option,
                           plex_item, read_config as read_shared_config, run_lock, select_item, streaming_services,
                           web_download)


BADGES = ("gradients", "gradient_top", "gradient_bottom", "resolution", "edition", "codec", "status", "audience_score", "streaming", "status_banner")
# The white logos Kometa lays over posters, bundled in resources/streaming_overlay/ (its defaults/overlays/images/streaming/white):
# the file name of each service in STREAMING where it isn't the service's own name.
STREAMING_OVERLAY = {"Apple TV": "AppleTV", "Tubi": "tubi"}
# Ported from Kometa's media_info.yml; TRaSH-style tags in the Plex file path drive these.
VIDEO_TAGS = (("DV-HDR", r"\[(DV HDR10)\]"), ("DV-Plus", r"\[(DV HDR10Plus)\]"),
              ("DV", r"\[(?!.*HDR)(DV)\]"), ("HDR", r"\[(HDR10)\]"), ("Plus", r"\[(HDR10Plus)\]"))
AUDIO_TAGS = (("TrueHD-Atmos", r"\[(TrueHD Atmos( 7\.1)?)\]"), ("Atmos", r"\[(EAC3 Atmos( 5\.1)?)\]"),
              ("TrueHD", r"\[(?![^\]]*Atmos)[^\]]*TrueHD( 7\.1| 5\.1)?\]"),
              ("DTS-X", r"\[(DTS-X(?: 5\.1| 7\.1)?)\]"), ("DTS-HD", r"\[(DTS-HD MA(?: 5\.1| 7\.1)?)\]"),
              ("DigitalPlus", r"\[(EAC3( 5\.1)?)\]"))
# Ascending Kometa weight: the last match wins.
EDITIONS = (("IMAX", r"\{edition-IMAX[^}]*\}"), ("Unrated-Edition", r"\{edition-Unrated[^}]*\}"),
            ("Directors-Cut", r"\{edition-(Director|Ultimate Director)[^}]*\}"),
            ("Special-Edition", r"\{edition-Special[^}]*\}"),
            ("Anniversary-Edition", r"\{edition-\d+th Anniversary[^}]*\}"),
            ("Collectors-Edition", r"\{edition-Collector[^}]*\}"), ("Minus-Color", r"\{edition-Minus Color[^}]*\}"),
            ("Extended-Cut", r"\{edition-Extended Cut[^}]*\}"), ("Extended-Edition", r"\{edition-Extended(?! Cut)[^}]*\}"),
            ("Open-Matte", r"\{edition-Open Matte[^}]*\}"), ("Final-Cut", r"\{edition-Final Cut[^}]*\}"),
            ("Remastered", r"\{edition-Remastered[^}]*\}"), ("Restored", r"\{edition-Restored[^}]*\}"),
            ("Signature-Edition", r"\{edition-Signature[^}]*\}"), ("Theatrical", r"\{edition-Theatrical(?! Cut)[^}]*\}"),
            ("Theatrical-Cut", r"\{edition-Theatrical Cut[^}]*\}"), ("Uncut", r"\{edition-Uncut[^}]*\}"),
            ("Ultimate-Edition", r"\{edition-Ultimate(?! Director)[^}]*\}"))
CAM = r"(?:^|[\\\/\[\]\(\)\s._-])(CAMRIP|TELESYNC|TELECINE|WORKPRINT|SCREENER|DVDSCR|BDSCR|SYNCUP|CAM|TS|TC|WP|SCR|DDC|R5|R6)(?:$|[\\\/\[\]\(\)\s._-])"
RESOLUTION_FILES = {"480p": "SD", "576p": "SD", "720p": "HD", "1080p": "FHD", "4k": "UHD"}
STATUS_FILES = {"new": "New", "airing": "Airing", "returning": "Returning", "canceled": "Cancelled", "ended": "Ended"}
# The status banner (the `status_banner` badge), after TSSK (TV Show Status for Kometa): a bar of text along the bottom of a show's poster
# for the one thing most worth saying about it. Per category: text, text color, backdrop color (False = none), days of its window
# (None = no window) and weight. {season}, {episode} and {date} in the text are the event's own. The heaviest weight wins, the earlier
# category on a tie. Upcoming events count days ahead, recent ones days back; all of it overridable in the layout's `status_banners`.
BANNERS = {"new_show": ("RECENTLY ADDED", "#FFFFFF", "#EB3233", 7, 50),
           "new_season": ("SEASON {season} AIRS {date}", "#FFFFFF", "#228B22", 31, 25),
           "new_season_started": ("SEASON {season} STARTED", "#FFFFFF", "#228B22", 7, 35),
           "upcoming_episode": ("NEXT EPISODE {date}", "#FFFFFF", "#006580", 31, 20),
           "new_episode": ("NEW EPISODE", "#FFFFFF", "#006580", 1, 45),
           "upcoming_finale": ("FINALE AIRS {date}", "#FFFFFF", "#9932CC", 31, 40),
           "season_finale": ("SEASON {season} FINALE", "#000000", "#FFB902", 7, 30),
           "final_episode": ("FINAL EPISODE", "#000000", "#FFB902", 7, 30),
           "returning": ("R E T U R N I N G", "#FF9000", False, None, 10),
           "ended": ("E N D E D", "#00FF3D", False, None, 10),
           "canceled": ("C A N C E L E D", "#EB3233", False, None, 10)}
BANNER_KEYS = ("text", "color", "backdrop", "opacity", "days", "weight", "enabled")
WEEKDAYS = ("Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday")
MONTHS = ("January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December")
AUDIENCE_TIERS = ((8.5, "excellent"), (7.0, "good"), (5.5, "average"), (3.0, "bad"), (0, "worst"))
# The score's box is drawn: 140x80 with 15px corners on a 1000px poster, filled by tier. A PNG in resources/audience_score replaces it.
AUDIENCE_COLORS = {"excellent": (0, 133, 198), "good": (92, 184, 92), "average": (245, 197, 24), "bad": (255, 145, 56), "worst": (226, 49, 51)}
SCORE_BOX, SCORE_RADIUS = (140, 80), 15
# Resolution, edition and status badges are drawn as text. Kometa's PNGs were 80px tall boxes on a 1000px poster: the text
# is centered in that box, resolution is right-aligned to BADGE_RESOLUTION_EDGE and edition/status start BADGE_LABEL_INSET in.
# IMAX (a logo) and codec art stay PNGs. Spacing and sizes are poster pixels.
BADGE_BOX_HEIGHT, BADGE_RESOLUTION_EDGE, BADGE_LABEL_INSET = 80, 132, 10
BADGE_RESOLUTION_KERNING, BADGE_LABEL_KERNING, BADGE_LABEL_BULLET_GAP = -1.5, 1.5, 12
BADGE_TEXT_FIELDS = ("resolution_font_file", "resolution_font_size", "edition_font_file", "edition_font_size", "badge_text_color")
BADGE_STROKE_FIELDS = ("badge_stroke_width", "badge_stroke_opacity", "badge_stroke_color")
BADGE_SHADOW_FIELDS = ("badge_shadow_strength", "badge_shadow_blur", "badge_shadow_offset_y", "badge_shadow_color")
LOGO_SHADOW_FIELDS = ("uniform_logo_shadow_enabled", "uniform_logo_shadow_opacity", "uniform_logo_shadow_angle", "uniform_logo_shadow_distance",
                      "uniform_logo_shadow_size", "uniform_logo_shadow_spread", "uniform_logo_shadow_color")
BADGE_ART_SHADOW_FIELDS = ("badge_art_shadow_enabled", "badge_art_shadow_opacity", "badge_art_shadow_angle", "badge_art_shadow_distance",
                           "badge_art_shadow_size", "badge_art_shadow_spread", "badge_art_shadow_color")
# Settings render_signature never records: badge positions and text are in each badge's entry, the audience score's art and
# font are hashed there too, and the generated collection backgrounds are saved as the collection's poster.
STREAMING_SHADOW_FIELDS = ("streaming_logo_shadow_enabled", "streaming_logo_shadow_opacity", "streaming_logo_shadow_angle", "streaming_logo_shadow_distance",
                           "streaming_logo_shadow_size", "streaming_logo_shadow_spread", "streaming_logo_shadow_color")
SIGNATURE_ELSEWHERE = ("badge_margin", "badge_text_transform", "audience_score_font_file", "audience_score_tiers", "resolution_labels", "status_labels",
                       "edition_labels", "collection_gradient_radius", "collection_gradient_strength", "collection_gradient_corner", "streaming_colors", "chart_color",
                       "streaming_logo_source", "streaming_logo_max_w", "streaming_logo_max_h", "streaming_logo_h", "streaming_logo_v", "streaming_logo_offset_x",
                       "streaming_logo_offset_y")
EDITION_LABELS = {"Directors-Cut": "Director’s Cut", "Collectors-Edition": "Collector’s Edition"}  # Shown in badge_text_transform's case (upper by default)
# Episode title cards, ported from TitleCardMaker's azuravian "TitleColorMatch" card. Pixel values are
# for its 3200x1800 card and scale with the card width.
COLOR_MIN_BRIGHTNESS, COLOR_MIN_SATURATION = 60, 0.15  # logo_preference "color": never black, needs real color
CARD_WIDTH = 3200
CARD_MARGIN = 50
CARD_TITLE_BOTTOM, CARD_TITLE_KERNING, CARD_TITLE_SPACE, CARD_TITLE_LINE_GAP = 125, -1.25, 50, -22
CARD_INDEX_KERNING, CARD_INDEX_GAP = 5.42, 30
CARD_DEFAULT_COLOR = "#EBEBEB"
TITLE_SPLIT_CHARACTERS = (":", ",", ")", "]", "?", "!", "-", ".", "/", "|")
CARD_FIELDS = ("card_gradient", "gradient_center_x", "gradient_center_y", "gradient_radius_x", "gradient_radius_y",
               "gradient_softness", "gradient_strength", "gradient_corner_strength", "title_font_file", "title_font_size", "title_color", "title_max_line_width",
               "title_max_lines", "title_min_brightness", "stroke_opacity", "title_stroke_width", "index_stroke_width", "shadow_strength", "shadow_blur", "shadow_offset_y", "season_font_file", "episode_font_file", "index_font_size", "index_color",
               "season_text", "episode_text")
CARD_LOGO_SHADOW_FIELDS = ("card_logo_shadow_enabled", "card_logo_shadow_opacity", "card_logo_shadow_angle", "card_logo_shadow_distance",
                           "card_logo_shadow_size", "card_logo_shadow_spread", "card_logo_shadow_color")
CARD_LOGO_FIELDS = ("card_logo_offset_x", "card_logo_offset_y", "card_logo_h_align", "card_logo_v_align", "card_logo_trim")
CARD_TEXT_FIELDS = ("title_letter_spacing", "title_line_spacing", "title_x", "title_bottom", "title_stroke_color",
                    "index_letter_spacing", "index_gap", "index_x", "index_bottom", "index_stroke_color")
CARD_FIELDS += CARD_LOGO_FIELDS + CARD_LOGO_SHADOW_FIELDS + CARD_TEXT_FIELDS + ("shadow_color",)
IMAGE_SUFFIXES = {"JPEG": ".jpg", "PNG": ".png", "WEBP": ".webp", "GIF": ".gif", "TIFF": ".tiff", "BMP": ".bmp"}


class Digests:
    """SHA-256 of files, remembered between runs (run() loads and saves .cache/digests.json), so an unchanged nightly
    run reads no artwork. A file is hashed again when its size, modification time or change time differs; Linux sets
    the change time on every write, rename or touch, and nothing can set it back. (On Windows that field is the
    creation time, so there it's size and modification time.)"""

    def __init__(self):
        self.path, self.entries, self.used, self.lock = None, {}, set(), threading.Lock()

    def load(self, path):
        try:
            entries = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            entries = {}
        with self.lock:
            self.path, self.used = path, set()
            self.entries = {key: value for key, value in entries.items()
                            if isinstance(value, list) and len(value) == 4} if isinstance(entries, dict) else {}

    def digest(self, path):
        key, stat = str(path), Path(path).stat()
        stamp = [stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns]
        with self.lock:
            entry = self.entries.get(key)
            self.used.add(key)
            if entry and entry[:3] == stamp:
                return entry[3]
        digest = hashlib.sha256(Path(path).read_bytes()).hexdigest()
        with self.lock:
            self.entries[key] = stamp + [digest]
        return digest

    def save(self, prune=False):
        """Write them back; `prune` (a whole-library run) drops files this run didn't look at."""
        with self.lock:
            if self.path is None:
                return
            if prune:
                self.entries = {key: value for key, value in self.entries.items() if key in self.used}
            atomic_write(self.path, json.dumps(self.entries, separators=(",", ":")).encode())


DIGESTS = Digests()


def file_digest(path):
    """SHA-256 of a file; see Digests."""
    return DIGESTS.digest(path)


def prune_cache(cache):
    """Delete expired API answers and downloads, and web thumbnails nobody has looked at for THUMB_TTL."""
    now = time.time()
    for folder, ttl in ((cache, IMAGE_TTL), (cache / "thumbs", THUMB_TTL)):
        if not folder.is_dir():
            continue
        for path in folder.iterdir():
            try:  # Only the cache's own hash-named files; web_pending.json and renders/ stay
                if re.fullmatch(r"[0-9a-f]{64}(\.jpg|\.png)?", path.name) and now - path.stat().st_mtime > ttl and path.is_file():
                    path.unlink()
            except OSError:
                pass


def folder_title(title):
    """A title as it is written in a folder name."""
    return re.sub(r'[<>:"/\\|?*\x00-\x1f{}]', "_", str(title)).strip(" .")[:100] or "Untitled"


class HTTP(SharedHTTP):
    """The shared HTTP cache, plus pictures decoded for drawing."""

    def image(self, source, base, headers=None):
        if is_url(source):
            data = self.get(source, headers=headers, ttl=IMAGE_TTL)
        else:
            data = local_path(source, base).read_bytes()
        with Image.open(io.BytesIO(data)) as image:
            result = image.convert("RGBA")
            # Save original bytes to the source folders without recompression.
            result.info["source_bytes"] = data
            result.info["source_format"] = image.format
            return result


class ArtworkFiles:
    """Editable inputs organized by title; existing files always take priority."""

    extensions = {".jpg", ".jpeg", ".png", ".webp", ".tif", ".tiff", ".bmp", ".gif"}

    def __init__(self, root, full=True):
        """`full` reads every title's .overlayrr.json now (a whole-library run; it also catches an ID claimed by two
        folders). Otherwise, for a run on one title, folders are found by the ID in their name and the files are only
        read when that finds nothing."""
        self.root, self.index, self.lock, self.scanned = root, {}, threading.RLock(), False
        for category in ("movies", "tv", "collections"):
            (root / category).mkdir(parents=True, exist_ok=True)
        self.scan(read=full)

    def scan(self, read=True):
        self.scanned = read
        for category in ("movies", "tv", "collections"):
            for folder in (self.root / category).iterdir():
                if not folder.is_dir():
                    continue
                aliases = []
                if read:
                    try:
                        aliases = self.aliases(self.metadata(folder))
                    except ValueError as error:  # Only that title fails (when it's saved or read again), not the whole run
                        print(f"WARN {error}; fix or delete it", file=sys.stderr)
                match = re.search(r"\{((?:tmdb|tvdb|imdb|plex|local)-[A-Za-z0-9]+)\}$", folder.name)
                if match:
                    aliases.append(match[1])
                self.register(category, folder, aliases)

    @staticmethod
    def metadata(folder):
        path = folder / ".overlayrr.json"
        if not path.exists():
            return {}
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            if not isinstance(data, dict):
                raise ValueError("expected an object")
            return data
        except (ValueError, OSError) as error:
            raise ValueError(f"Invalid artwork metadata: {path}: {error}") from None

    @staticmethod
    def aliases(item):
        if item.get("type") == "collection" and str(item.get("rating_key") or "").isdigit():
            # Two Plex collections ("Star Wars", "Star Wars: Skywalker Saga") can resolve to one TMDb collection;
            # each keeps its own folder, found by its Plex ID.
            return [f"plex-{item['rating_key']}"]
        keys = [("tmdb", item.get("tmdb_id")), ("tvdb", item.get("tvdb_id")),
                ("imdb", item.get("imdb_id")), ("plex", item.get("parent_rating_key") or item.get("rating_key"))]
        if item.get("type") == "tv":
            keys[0], keys[1] = keys[1], keys[0]
        return [f"{kind}-{value}" for kind, value in keys if value and
                (str(value).isdigit() or (kind == "imdb" and re.fullmatch(r"tt\d+", str(value))))]

    def register(self, category, folder, aliases):
        for alias in aliases:
            key = (category, alias)
            if key in self.index and self.index[key] != folder:
                raise ValueError(f"Duplicate artwork ID {alias}: {self.index[key]} and {folder}")
            self.index[key] = folder

    def adopt(self, item, gone):
        """A collection Plex made again (a reset deletes them all) has a new Plex ID, which no folder is filed under. This
        hands it the one earlier folder with the same name, renamed to the new ID with its poster, logo and picks kept, so no
        duplicate is started. Every Plex ID that folder was filed under must be gone (`gone` asks Plex); a folder with none
        (older ones are named by TMDb ID) is taken as it is. Returns that folder, or None."""
        key = str(item.get("rating_key") or "")
        if item.get("type") != "collection" or not key.isdigit() or not item.get("title"):
            return None
        with self.lock:
            if self.folder(item) is not None:
                return None
            wanted, earlier = folder_title(item["title"]).casefold(), []
            for folder in {path for (category, _), path in self.index.items() if category == "collections"}:
                try:
                    details = self.metadata(folder)
                except ValueError:
                    continue
                keys = {old for old in [str(details.get("rating_key") or "")] + re.findall(r"\{plex-(\d+)\}$", folder.name) if old.isdigit()}
                name = folder_title(details.get("title") or re.sub(r"\s*\{[a-z]+-\w+\}$", "", folder.name)).casefold()
                if name == wanted and key not in keys:
                    earlier.append((folder, keys))
            if len(earlier) != 1 or not all(gone(old) for old in earlier[0][1]):
                return None
            folder = earlier[0][0]
            stem = re.sub(r"\s*\{[a-z]+-\w+\}$", "", folder.name)
            renamed = folder.with_name(f"{stem} {{plex-{key}}}")
            if renamed.exists():
                return None
            folder.rename(renamed)
            atomic_write(renamed / ".overlayrr.json", json.dumps({**self.metadata(renamed), "type": "collection", "rating_key": item["rating_key"]}, indent=2).encode())
            self.index = {entry: path for entry, path in self.index.items() if path != folder}
            self.register("collections", renamed, [f"plex-{key}"])
            return renamed

    @staticmethod
    def local_alias(item):
        identity = [item.get("title"), item.get("year"), item.get("output_name", "rendered.jpg")]
        return "local-" + hashlib.sha256(json.dumps(identity).encode()).hexdigest()[:12]

    def folder(self, item, create=False, planned=False):
        category = {"movie": "movies", "collection": "collections"}.get(item["type"], "tv")
        aliases = self.aliases(item)
        if not aliases:
            aliases = [self.local_alias(item)]
        with self.lock:
            matches = {self.index[category, alias] for alias in aliases if (category, alias) in self.index}
            if not matches and not self.scanned:  # Not found by folder name: read the IDs saved in the folders
                self.scan()
                matches = {self.index[category, alias] for alias in aliases if (category, alias) in self.index}
            if len(matches) > 1:
                raise ValueError(f"Conflicting artwork folders for {item.get('title', aliases[0])}")
            folder = next(iter(matches), None)
            if folder is None and (create or planned):
                title = str(item.get("title") or Path(item.get("output_name", "rendered.jpg")).stem)
                title = folder_title(title)
                year = str(item.get("year") or "")
                year = f" ({year})" if re.fullmatch(r"\d{4}", year) and not title.endswith(f"({year})") else ""
                folder = self.root / category / f"{title}{year} {{{aliases[0]}}}"
                if create:
                    folder.mkdir(parents=True, exist_ok=True)
            if folder is not None:
                if folder.exists():
                    self.register(category, folder, aliases)
                if item.get("season") is not None:
                    folder = folder / f"Season {item['season']:02d}"
                    if item.get("episode") is not None:
                        folder = folder / f"Episode {item['episode']:02d}"
                    if create:
                        folder.mkdir(parents=True, exist_ok=True)
            return folder

    @staticmethod
    def source(folder, name):
        """The folder's one poster or logo file (any image extension), or None."""
        if folder is None or not folder.exists():
            return None
        matches = [path for path in folder.iterdir() if path.is_file() and
                   path.stem.lower() == name and path.suffix.lower() in ArtworkFiles.extensions]
        if len(matches) > 1:
            raise ValueError(f"Keep exactly one {name} file in {folder}; found {len(matches)}")
        return matches[0] if matches else None

    def discard(self, item, keep=()):
        """--refetch: delete the item's own saved poster and logo (not ones the config names) so they are picked again."""
        with self.lock:
            folder = self.folder(item)
            for name in ("poster", "logo"):
                path = self.source(folder, name)
                if path and path.resolve() not in keep:
                    path.unlink()

    def apply(self, item):
        folder = self.folder(item)
        metadata = self.metadata(folder) if folder and folder.exists() else {}
        for key in ("title", "year", "tmdb_id", "tvdb_id", "imdb_id", "season_title", "episode_title"):
            if key in metadata:
                item.setdefault(key, metadata[key])
        poster = self.source(folder, "poster")
        if item.get("season") is None:
            show, logo = folder, self.source(folder, "logo")
        else:  # Seasons and episodes always use the series' logo, whatever their own folders hold
            show = folder and folder.parents[1 if item.get("episode") is not None else 0]
            logo = folder and self.source(show, "logo")
        if show and show.exists() and self.metadata(show).get("no_logo"):  # The web page's "No logo", set on the series
            item["no_logo"], logo = True, None
        if poster:
            item["poster"] = str(poster)
        if logo:
            item["logo"] = str(logo)
        if metadata.get("background_color"):  # Chosen on the web page for its generated background
            item["background_color"] = metadata["background_color"]
        stock_hash = metadata.get("stock_poster") if poster else None
        return bool(stock_hash and file_digest(poster) == stock_hash)

    @staticmethod
    def save_image(folder, name, image):
        existing = ArtworkFiles.source(folder, name)
        if existing or image is None:
            return existing
        suffix = IMAGE_SUFFIXES.get(image.info.get("source_format"))
        data = image.info.get("source_bytes") if suffix else None
        if data is None:
            buffer = io.BytesIO()
            image.save(buffer, format="PNG", compress_level=1)
            suffix, data = ".png", buffer.getvalue()
        path = folder / f"{name}{suffix}"
        atomic_write(path, data)
        return path

    def keep(self, item):
        """A title's folder without art yet (a curated collection nothing could be found for), so it is listed in Artwork and
        a poster of your own has somewhere to go."""
        with self.lock:
            folder = self.folder(item, create=True)
            if not (folder / ".overlayrr.json").exists():
                metadata = {key: item[key] for key in ("type", "title", "year", "rating_key") if item.get(key) is not None}
                atomic_write(folder / ".overlayrr.json", json.dumps(metadata, indent=2).encode())
            return folder

    def save(self, item, background, logo, stock):
        with self.lock:
            folder = self.folder(item, create=True)
            previous = self.metadata(folder)
            existing_poster = self.source(folder, "poster")
            poster = self.save_image(folder, "poster", background)
            # Automatic season and episode logos are shared with the series.
            episode = item.get("episode") is not None
            show_folder = folder.parent.parent if episode else folder.parent if item.get("season") is not None else folder
            if item.get("season") is not None or not self.source(folder, "logo"):
                self.save_image(show_folder, "logo", logo)
            metadata = {key: item[key] for key in ("type", "title", "year", "tmdb_id", "tvdb_id", "imdb_id", "rating_key", "season", "season_title", "episode", "episode_title") if item.get(key) is not None}
            for key in ("no_logo", "background_color", "generated"):  # Set from the web page; a run must not forget them
                if previous.get(key):
                    metadata[key] = previous[key]
            source_stock = item.get("_stock_poster", stock)
            if existing_poster and item.get("poster") != str(existing_poster):
                source_stock = previous.get("stock_poster") == file_digest(poster)
            if source_stock:
                metadata["stock_poster"] = file_digest(poster)
            atomic_write(folder / ".overlayrr.json", json.dumps(metadata, indent=2).encode())
            if item.get("season") is not None:
                show = self.metadata(show_folder)
                show.update({key: value for key, value in metadata.items() if key not in ("season", "season_title", "episode", "episode_title", "rating_key", "stock_poster")})
                if item.get("parent_rating_key"):
                    show["rating_key"] = item["parent_rating_key"]
                atomic_write(show_folder / ".overlayrr.json", json.dumps(show, indent=2).encode())
            return folder


def label_map(name, value, allowed, hexes=False):
    """A mapping (or the pairs it was stored as) from known names to text, as a sorted tuple of pairs so Style stays
    hashable. Names match the allowed ones in any case; with `hexes` the values must be #RRGGBB."""
    pairs = tuple(value.items()) if isinstance(value, dict) else tuple(value)
    known, result = {key.lower(): key for key in allowed}, {}
    for pair in pairs:
        if not isinstance(pair, (list, tuple)) or len(pair) != 2:
            raise ValueError(f"{name} must be a mapping")
        key, text = pair
        if str(key).lower() not in known:
            raise ValueError(f"{name}: unknown name {key!r}; use one of: {', '.join(allowed)}")
        if not isinstance(text, str) or not text.strip() or (hexes and not re.fullmatch(r"#[0-9a-fA-F]{6}", text)):
            raise ValueError(f"{name}.{key} must be {'#RRGGBB' if hexes else 'some text'}")
        result[known[str(key).lower()]] = text
    return tuple(sorted(result.items()))


def banner_options(value):
    """The `status_banners` mapping (category -> some of BANNER_KEYS) as sorted tuples so Style stays hashable. Categories match
    BANNERS in any case; a backdrop of false or "none" is stored as False."""
    pairs = tuple(value.items()) if isinstance(value, dict) else tuple(value)
    known, result = {key.lower(): key for key in BANNERS}, {}
    for pair in pairs:
        if not isinstance(pair, (list, tuple)) or len(pair) != 2:
            raise ValueError("status_banners must be a mapping")
        name, entry = pair
        if str(name).lower() not in known:
            raise ValueError(f"status_banners: unknown category {name!r}; use one of: {', '.join(BANNERS)}")
        category = known[str(name).lower()]
        try:
            entry = dict(entry)
        except (TypeError, ValueError):
            raise ValueError(f"status_banners.{category} must be a mapping") from None
        if set(entry) - set(BANNER_KEYS):
            raise ValueError(f"status_banners.{category}: unknown setting {', '.join(sorted(map(str, set(entry) - set(BANNER_KEYS))))}; use: {', '.join(BANNER_KEYS)}")
        for key, setting in list(entry.items()):
            where = f"status_banners.{category}.{key}"
            hexed = isinstance(setting, str) and re.fullmatch(r"#[0-9a-fA-F]{6}", setting)
            if key == "text" and (not isinstance(setting, str) or not setting.strip()):
                raise ValueError(f"{where} must be some text")
            if key == "color" and not hexed:
                raise ValueError(f"{where} must be #RRGGBB")
            if key == "backdrop":
                entry[key] = setting = False if isinstance(setting, str) and setting.lower() == "none" else setting
                if setting is not False and not hexed:
                    raise ValueError(f"{where} must be #RRGGBB, or false for no backdrop")
            if key == "opacity" and setting is not None and (isinstance(setting, bool) or not isinstance(setting, (int, float)) or not 0 <= setting <= 1):
                raise ValueError(f"{where} must be a number from 0 to 1 (or null to follow status_banner_backdrop_opacity)")
            if key == "days" and (type(setting) is not int or not 0 <= setting <= 3650 or BANNERS[category][3] is None):
                raise ValueError(f"{where} must be a whole number of days (0 to 3650), and only categories with a window have one")
            if key == "weight" and (type(setting) is not int or not 0 <= setting <= 1000):
                raise ValueError(f"{where} must be a whole number from 0 to 1000")
            if key == "enabled" and type(setting) is not bool:
                raise ValueError(f"{where} must be true or false")
        result[category] = tuple(sorted(entry.items()))
    return tuple(sorted(result.items()))


@lru_cache(maxsize=32)
def banner_settings(overrides):
    """Every category's text, color, backdrop, days, weight and enabled, with a layout's `status_banners` (as Style stores it) laid over BANNERS."""
    return {name: {"text": text, "color": color, "backdrop": backdrop, "opacity": None, "days": days, "weight": weight, "enabled": True,
                   **dict(dict(overrides).get(name, ()))}
            for name, (text, color, backdrop, days, weight) in BANNERS.items()}


@dataclass(frozen=True)
class Style:
    width: int = 2000
    height: int = 3000
    poster_zoom: float = 1.0
    poster_shift_y: float = 0.0
    poster_shift_x: float = 0.0  # Moves the picture sideways as poster_shift_y moves it up and down (a fraction of the width)
    matte_height_ratio: float = 0.0
    fade_height_ratio: float = 0.0
    fade_smoothness: float = 0.0  # 0 = straight ramp; 1 = eased at both ends, so there's no visible edge where the fade starts or meets the matte
    matte_opacity: float = 1.0  # How solid the matte is (the fade ramps up to it); lower lets the poster show through
    matte_color: str = "#000000"  # What the poster fades to
    vignette_strength: float = 0.0
    vignette_mode: str = "classic"  # classic dims the whole picture evenly (as the parent app does); radial is a real vignette, clear in the middle and darkest at the corners
    vignette_color: str = "#000000"
    vignette_size: float = 1.0  # radial: how far in it reaches (smaller darkens nearer the center, larger keeps it to the corners)
    vignette_falloff: float = 2.0  # radial: the shape of the ramp (1 = straight; higher stays clear longer, then darkens toward the edges)
    grain_amount: float = 0.0
    grain_mode: str = "blend"  # blend (as in Simposter) pulls blacks up and whites down toward grey; film adds visible grain that fades out in the darkest and brightest areas
    grain_size: float = 1.5  # Blur of the noise, in pixels on a 2000px-wide poster: larger is coarser; 0 = none
    uniform_logo_max_w: int = 600
    uniform_logo_max_h: int = 240
    uniform_logo_offset_x: float = 0.5
    uniform_logo_offset_y: float = 0.5
    uniform_logo_h_align: str = "center"
    uniform_logo_v_align: str = "center"
    uniform_logo_center_below: int = 0  # Logos shorter than this (px on a 3000px-tall poster) are centered in their box; 0 = off
    uniform_logo_trim: bool = False  # Trim the logo's transparent padding before fitting it, so every logo fills its box alike
    uniform_logo_shadow_enabled: bool = False  # Drop shadow behind the logo, as in Simposter (same names and meanings), plus spread
    uniform_logo_shadow_opacity: float = 60  # Percent
    uniform_logo_shadow_angle: float = -45  # Degrees where the light comes from, counterclockwise from the right (Photoshop's); the shadow falls the other way
    uniform_logo_shadow_distance: float = 8  # Pixels on a 2000px-wide poster
    uniform_logo_shadow_size: float = 15  # Blur, in pixels on a 2000px-wide poster
    uniform_logo_shadow_spread: float = 0  # Percent of the size that is grown solid before the blur; 0 = a plain blurred copy
    uniform_logo_shadow_color: str = "#000000"
    border_enabled: bool = False
    border_px: int = 0
    border_color: str = "#FFFFFF"
    border_radius: int = 0  # Rounds the picture's corners inside the border (px on a 2000px-wide poster); 0 = square
    poster_filter: str = "all"
    logo_preference: str = "any"
    logo_mode: str = "original"
    logo_min_brightness: int = 0  # Skip logos darker than this (0-255 average brightness); 0 keeps any
    text_overlay_enabled: bool = False
    custom_text: str = ""
    font_file: str | None = None
    font_size: int = 120
    text_color: str = "#FFFFFF"
    text_transform: str = "none"
    letter_spacing: int = 0
    position_y: float = 0.5
    position_x: float = 0.5  # Where the text is centered across the poster (0-1)
    text_line_spacing: float = 0.2  # Gap between lines, as a fraction of the font size
    text_stroke_width: float = 0  # Outline around the text, in pixels on a 2000px-wide poster; 0 = none
    text_stroke_opacity: float = 1.0
    text_stroke_color: str = "#000000"
    text_shadow_strength: float = 0.0  # Soft shadow behind the text: 0 = none, 1 = solid
    text_shadow_blur: float = 10  # How far it spreads (pixels on a 2000px-wide poster)
    text_shadow_offset_y: float = 0  # Pixels to shift it down; 0 centers it on the text
    text_shadow_color: str = "#000000"
    grain_seed: int | None = None
    badges: tuple = ()
    resource_dir: str = "resources"
    badge_layout: str = "kometa"  # kometa: top-left badges sit in Kometa's fixed boxes; flow: left to right from the margin, each after the previous one's real width
    badge_margin: float = 25  # Distance from the poster's edges, in pixels on a 1000px-wide poster
    badge_gap: float = 14  # With flow: space between the top-left badges (same units)
    badge_fit: bool = False  # Shrink resolution, edition and status text that would run past the margins
    badge_text_transform: str = "uppercase"  # none (as written), uppercase or lowercase: the resolution, edition and status text
    badge_art_scale: float = 1.0  # Size of the IMAX, codec and score art (the text badges have their own sizes)
    badge_art_shadow_enabled: bool = False  # Drop shadow behind that art, with the streaming logo's settings and meanings
    badge_art_shadow_opacity: float = 60  # Percent
    badge_art_shadow_angle: float = 135  # Light from the upper left, so the shadow falls down and to the right
    badge_art_shadow_distance: float = 4  # Pixels on a 1000px-wide poster
    badge_art_shadow_size: float = 8  # Blur
    badge_art_shadow_spread: float = 0
    badge_art_shadow_color: str = "#000000"
    badge_gradient_color: str = "#000000"  # What the gradient badges fade to
    audience_score_text_color: str = "#111111"
    audience_score_font_size: float = 68  # Pixels on a 1000px-wide poster
    audience_score_font_file: str | None = None  # null = resources/fonts/centurygothic_bold.ttf
    audience_score_tiers: tuple = (8.5, 7.0, 5.5, 3.0)  # The scores where the art becomes excellent, good, average and bad (below the last: worst)
    resolution_labels: tuple = ()  # A mapping, e.g. {4k: "4K"}: resolution (480p, 576p, 720p, 1080p, 4k, cam) to the text shown
    status_labels: tuple = ()  # Same for new, airing, returning, canceled and ended
    edition_labels: tuple = ()  # Same for the editions, e.g. {Directors-Cut: "DC"}; the names are in the README
    badge_gradient_height: float = 0.25  # How far the top and bottom gradients fade in, as a fraction of the height (both edges, unless set below)
    badge_gradient_strength: float = 0.67  # How black they are at the edge
    badge_gradient_top_height: float | None = None  # null = badge_gradient_height
    badge_gradient_top_strength: float | None = None  # null = badge_gradient_strength
    badge_gradient_bottom_height: float | None = None
    badge_gradient_bottom_strength: float | None = None
    resolution_font_file: str | None = None  # null = resources/fonts/Poppins/Poppins-ExtraBold.ttf
    resolution_font_size: int = 60  # Pixels on a 1000px-wide poster
    edition_font_file: str | None = None  # Edition and status text; null = resources/fonts/Poppins/Poppins-Regular.ttf
    edition_font_size: int = 58
    badge_text_color: str = "#FFFFFF"
    badge_stroke_width: float = 0  # Outline around the resolution, edition and status text, in pixels on a 1000px-wide poster; 0 = none
    badge_stroke_opacity: float = 1.0  # 0 = none, 1 = solid
    badge_stroke_color: str = "#000000"
    badge_shadow_strength: float = 0.0  # Soft shadow behind that text: 0 = none, 1 = solid
    badge_shadow_blur: float = 5  # How far it spreads, in pixels on a 1000px-wide poster
    badge_shadow_offset_y: float = 0  # Pixels to shift it down (1000px-wide poster); 0 centers it on the text
    badge_shadow_color: str = "#000000"
    # The streaming service's logo on a TV show's poster (the `streaming` badge), Kometa's white ones. Sizes are pixels on a 1000px-wide poster.
    streaming_logo_source: str = "any"  # Which service: originals (the network it aired on), available (where it streams now, in plex.collection_region) or any (its network, else where it streams)
    streaming_logo_max_w: float = 285  # The box the logo is fitted in (Kometa's logos are at most 285 x 85)
    streaming_logo_max_h: float = 80  # Also the height the top-left text badges are centered in
    streaming_logo_h: str = "left"  # The corner it sits in; the top left is where a movie's resolution text goes
    streaming_logo_v: str = "top"
    streaming_logo_offset_x: float = 0  # Pixels in from the badge margin along the top or bottom edge (negative moves it out)
    streaming_logo_offset_y: float = 0
    streaming_logo_shadow_enabled: bool = False  # Drop shadow behind the logo, with the poster logo's settings and meanings
    streaming_logo_shadow_opacity: float = 60  # Percent
    streaming_logo_shadow_angle: float = 135  # Light from the upper left, so the shadow falls down and to the right (the poster logo's default falls up and left)
    streaming_logo_shadow_distance: float = 4
    streaming_logo_shadow_size: float = 8  # Blur
    streaming_logo_shadow_spread: float = 0
    streaming_logo_shadow_color: str = "#000000"
    # The status banner (the `status_banner` badge): TSSK's bar of text for a TV show's poster. Sizes are pixels on a 1000px-wide poster.
    # Where the bar is: against a side and an edge (center = middle), moved in from them by the offsets (with center, positive moves right and down).
    status_banner_h_align: str = "center"  # left, center or right
    status_banner_v_align: str = "bottom"  # top, center or bottom
    status_banner_offset_x: float = 0
    status_banner_offset_y: float = 20
    status_banner_width: float = 950  # The bar; with no backdrop it is still the room the words shrink to fit
    status_banner_height: float = 90
    status_banner_radius: float = SCORE_RADIUS  # Rounds the bar's corners; the default is the audience score badge's, so the two match
    status_banner_backdrop_opacity: float = 1.0  # How solid the bar is (a category's own `opacity` wins)
    status_banner_border_width: float = 0  # An outline inside the bar's edge; 0 = none (only on categories that have a bar)
    status_banner_border_color: str = "#FFFFFF"
    # The words
    status_banner_font_file: str | None = None  # null = resources/fonts/Poppins/Poppins-Bold.ttf
    status_banner_font_size: int = 70
    status_banner_letter_spacing: float = 0  # Added after every character; negative is tighter
    status_banner_text_transform: str = "uppercase"  # none (as written), uppercase or lowercase
    status_banner_text_opacity: float = 1.0
    status_banner_text_align: str = "center"  # Where they sit in the bar: left, center or right
    status_banner_padding: float = 20  # Between the bar's ends and the words, which shrink to fit between them
    status_banner_text_offset_x: float = 0  # Nudges the words inside the bar
    status_banner_text_offset_y: float = 0
    status_banner_stroke_width: float = 0  # Their outline; 0 = none
    status_banner_stroke_opacity: float = 1.0
    status_banner_stroke_color: str = "#000000"
    status_banner_shadow_strength: float = 0.0  # Their soft shadow: 0 = none, 1 = solid
    status_banner_shadow_blur: float = 5
    status_banner_shadow_offset_y: float = 0  # Pixels to shift it down; 0 centers it on the words
    status_banner_shadow_color: str = "#000000"
    status_banner_date_format: str = "ddd dd/mm"  # What {date} shows: d, dd, ddd (weekday), dddd, m, mm, mmm, mmmm, yy and yyyy are replaced
    status_banner_simplify_dates: bool = False  # A date up to seven days ahead reads today, tomorrow or the weekday
    status_banners: tuple = ()  # A mapping, category to text, color, backdrop, opacity, days, weight and enabled; see BANNERS
    # Episode title cards (only used by episode_options; logo bounds are then pixels on a 3200px-wide card).
    card_gradient: str | None = None  # "radial" (generated from the gradient_* settings) or null
    gradient_center_x: float = 0.68
    gradient_center_y: float = 0.48
    gradient_radius_x: float = 0.465
    gradient_radius_y: float = 0.6
    gradient_softness: float = 4
    gradient_strength: float = 1.0
    gradient_corner_strength: float = 0.35  # extra, very faint darkening that mostly touches the corners
    title_font_file: str | None = None
    title_font_size: int = 157
    title_color: str = "auto"
    title_min_brightness: int = 0  # With title_color auto: skip logo colors darker than this (0-255); 0 = any
    stroke_opacity: float = 1.0  # Opacity of the dark outline around the title and season/episode text (0 = none)
    title_stroke_width: float = 3  # Outline width in pixels on a 3200px-wide card (the original card uses 3)
    index_stroke_width: float = 6  # Same for the season/episode text (the original card uses 6)
    shadow_strength: float = 0.0  # Soft shadow behind the title and season/episode text: 0 = none, 1 = solid black
    shadow_blur: float = 14  # How far the shadow spreads, in pixels on a 3200px-wide card
    shadow_offset_y: float = 0  # Pixels to shift it down (3200px-wide card); 0 centers it on the text
    title_max_line_width: int = 32
    title_max_lines: int = 3
    season_font_file: str | None = None
    episode_font_file: str | None = None
    index_font_size: int = 68
    index_color: str = "#CFCFCF"
    season_text: str = "SEASON {season_number}"
    episode_text: str = "EPISODE {episode_number}"
    # More title card settings, all in pixels on a 3200px-wide card. The defaults are what the card always drew, so cards
    # that don't set them don't change. The card's logo and text don't follow the poster's settings: these are its own.
    card_logo_offset_x: float = 0.0  # Where the logo's box sits between the margins: 0 = against the left one, 1 = against the right one
    card_logo_offset_y: float = 0.0  # 0 = against the top margin, 1 = against the bottom one
    card_logo_h_align: str = "left"  # Where the logo sits inside its box
    card_logo_v_align: str = "top"
    card_logo_trim: bool = True  # Trim the logo's transparent padding before fitting it (the card always did)
    card_logo_shadow_enabled: bool = False  # Drop shadow behind the logo, with the poster's settings and meanings
    card_logo_shadow_opacity: float = 60
    card_logo_shadow_angle: float = -45
    card_logo_shadow_distance: float = 12
    card_logo_shadow_size: float = 24
    card_logo_shadow_spread: float = 0
    card_logo_shadow_color: str = "#000000"
    title_letter_spacing: float = CARD_TITLE_KERNING  # Added after every character of the title
    title_line_spacing: float = CARD_TITLE_LINE_GAP  # Added between title lines (negative is tighter)
    title_x: float = CARD_MARGIN  # The title's left edge
    title_bottom: float = CARD_TITLE_BOTTOM  # Distance from the card's bottom edge to the title's last line
    title_stroke_color: str = "auto"  # auto = black, or white if title_color: auto picks a very dark color
    index_letter_spacing: float = CARD_INDEX_KERNING  # The same for the season/episode text
    index_gap: float = CARD_INDEX_GAP  # Space between the season and the episode text
    index_x: float = CARD_MARGIN
    index_bottom: float = CARD_MARGIN
    index_stroke_color: str = "#000000"
    shadow_color: str = "#000000"  # Of the title and season/episode shadow
    # Collection posters Overlayrr draws itself (streaming services, "New Episodes"); they apply when a poster is generated.
    collection_gradient_radius: float = 1.25  # How far the glow reaches from the center
    collection_gradient_strength: float = 0.55  # How much the edges darken
    collection_gradient_corner: float = 0.4  # Extra darkening toward the bottom left
    streaming_colors: tuple = ()  # A mapping of service name to #RRGGBB, overriding the built-in colors
    chart_color: str = "#8a5a10"  # The glow of "Newly Released" and "New Episodes"

    def __post_init__(self):
        for side in ("top", "bottom"):  # An edge's gradient follows the shared setting unless it has its own
            for what in ("height", "strength"):
                if getattr(self, f"badge_gradient_{side}_{what}") is None:
                    object.__setattr__(self, f"badge_gradient_{side}_{what}", getattr(self, f"badge_gradient_{what}"))
        limits = {
            "width": (64, 8000), "height": (64, 8000), "poster_zoom": (0.1, 3),
            "poster_shift_y": (-0.5, 0.5), "matte_height_ratio": (0, 0.5),
            "fade_height_ratio": (0, 1), "fade_smoothness": (0, 1), "matte_opacity": (0, 1), "vignette_strength": (0, 1),
            "grain_amount": (0, 0.6), "uniform_logo_max_w": (1, 8000),
            "uniform_logo_max_h": (1, 8000), "uniform_logo_offset_x": (0, 1),
            "uniform_logo_offset_y": (0, 1), "uniform_logo_center_below": (0, 8000),
            "font_size": (1, 1000), "letter_spacing": (0, 10), "position_y": (0, 1),
            "title_font_size": (1, 1000), "index_font_size": (1, 1000),
            "title_max_line_width": (1, 200), "title_max_lines": (1, 10),
            "gradient_center_x": (0, 1), "gradient_center_y": (0, 1), "gradient_radius_x": (0.01, 5),
            "gradient_radius_y": (0.01, 5), "gradient_softness": (0.5, 20), "gradient_strength": (0, 1),
            "gradient_corner_strength": (0, 1), "logo_min_brightness": (0, 255), "title_min_brightness": (0, 255),
            "stroke_opacity": (0, 1), "title_stroke_width": (0, 60), "index_stroke_width": (0, 60), "shadow_strength": (0, 1), "shadow_blur": (0, 200), "shadow_offset_y": (-200, 200), "badge_gradient_height": (0.01, 1), "badge_gradient_strength": (0, 1),
            "resolution_font_size": (1, 500), "edition_font_size": (1, 500), "border_radius": (0, 1000),
            "badge_gradient_top_height": (0.01, 1), "badge_gradient_top_strength": (0, 1),
            "badge_gradient_bottom_height": (0.01, 1), "badge_gradient_bottom_strength": (0, 1),
            "badge_stroke_width": (0, 20), "badge_stroke_opacity": (0, 1), "badge_shadow_strength": (0, 1),
            "badge_shadow_blur": (0, 60), "badge_shadow_offset_y": (-60, 60),
            "uniform_logo_shadow_opacity": (0, 100), "uniform_logo_shadow_angle": (-180, 180), "uniform_logo_shadow_distance": (0, 100),
            "uniform_logo_shadow_size": (0, 250), "uniform_logo_shadow_spread": (0, 100),
            "poster_shift_x": (-0.5, 0.5), "vignette_size": (0.2, 3), "vignette_falloff": (0.2, 5), "grain_size": (0, 10),
            "position_x": (0, 1), "text_line_spacing": (0, 2), "text_stroke_width": (0, 40), "text_stroke_opacity": (0, 1),
            "text_shadow_strength": (0, 1), "text_shadow_blur": (0, 100), "text_shadow_offset_y": (-100, 100),
            "badge_margin": (0, 200), "badge_gap": (0, 200), "badge_art_scale": (0.2, 4), "audience_score_font_size": (1, 500),
            "streaming_logo_max_w": (1, 1000), "streaming_logo_max_h": (1, 500), "streaming_logo_offset_x": (-200, 1000), "streaming_logo_offset_y": (-200, 1000),
            "streaming_logo_shadow_opacity": (0, 100), "streaming_logo_shadow_angle": (-180, 180), "streaming_logo_shadow_distance": (0, 50),
            "streaming_logo_shadow_size": (0, 125), "streaming_logo_shadow_spread": (0, 100),
            "badge_art_shadow_opacity": (0, 100), "badge_art_shadow_angle": (-180, 180), "badge_art_shadow_distance": (0, 50),
            "badge_art_shadow_size": (0, 125), "badge_art_shadow_spread": (0, 100),
            "collection_gradient_radius": (0.2, 5), "collection_gradient_strength": (0, 1), "collection_gradient_corner": (0, 1),
            "card_logo_offset_x": (0, 1), "card_logo_offset_y": (0, 1), "card_logo_shadow_opacity": (0, 100), "card_logo_shadow_angle": (-180, 180),
            "card_logo_shadow_distance": (0, 300), "card_logo_shadow_size": (0, 500), "card_logo_shadow_spread": (0, 100),
            "title_letter_spacing": (-50, 100), "title_line_spacing": (-300, 300), "title_x": (0, 8000), "title_bottom": (0, 8000),
            "index_letter_spacing": (-50, 100), "index_gap": (0, 1000), "index_x": (0, 8000), "index_bottom": (0, 8000),
            "status_banner_font_size": (1, 500), "status_banner_width": (50, 1000), "status_banner_height": (10, 500), "status_banner_offset_x": (-1000, 1000),
            "status_banner_offset_y": (-1000, 1000), "status_banner_radius": (0, 500), "status_banner_backdrop_opacity": (0, 1), "status_banner_border_width": (0, 50),
            "status_banner_letter_spacing": (-50, 100), "status_banner_text_opacity": (0, 1), "status_banner_padding": (0, 500),
            "status_banner_text_offset_x": (-500, 500), "status_banner_text_offset_y": (-500, 500), "status_banner_stroke_width": (0, 20),
            "status_banner_stroke_opacity": (0, 1), "status_banner_shadow_strength": (0, 1), "status_banner_shadow_blur": (0, 60), "status_banner_shadow_offset_y": (-60, 60),
        }
        for name, (low, high) in limits.items():
            value = getattr(self, name)
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not low <= value <= high:
                raise ValueError(f"style.{name} must be a number from {low} to {high}")
        for name in ("width", "height", "uniform_logo_max_w", "uniform_logo_max_h", "uniform_logo_center_below", "font_size", "letter_spacing",
                     "title_font_size", "index_font_size", "title_max_line_width", "title_max_lines", "logo_min_brightness",
                     "title_min_brightness", "resolution_font_size", "edition_font_size", "border_radius", "status_banner_font_size"):
            if not isinstance(getattr(self, name), int):
                raise ValueError(f"style.{name} must be an integer")
        if self.width * self.height > 24_000_000:
            raise ValueError("Canvas must have at most 24 million pixels")
        if self.grain_seed is not None and (type(self.grain_seed) is not int or self.grain_seed < 0):
            raise ValueError("style.grain_seed must be a nonnegative integer or null")
        for name, choices in (("uniform_logo_h_align", ("left", "center", "right")),
                              ("uniform_logo_v_align", ("top", "center", "bottom")),
                              ("poster_filter", ("all", "textless", "text")),
                              ("logo_preference", ("white", "any", "color")),
                              ("logo_mode", ("original", "none")),
                              ("text_transform", ("none", "uppercase", "lowercase")),
                              ("badge_layout", ("kometa", "flow")),
                              ("badge_text_transform", ("none", "uppercase", "lowercase")),
                              ("grain_mode", ("blend", "film")),
                              ("vignette_mode", ("classic", "radial")),
                              ("card_logo_h_align", ("left", "center", "right")),
                              ("card_logo_v_align", ("top", "center", "bottom")),
                              ("streaming_logo_source", ("any", "originals", "available")),
                              ("streaming_logo_h", ("left", "right")),
                              ("streaming_logo_v", ("top", "bottom")),
                              ("status_banner_text_transform", ("none", "uppercase", "lowercase")),
                              ("status_banner_text_align", ("left", "center", "right")),
                              ("status_banner_h_align", ("left", "center", "right")),
                              ("status_banner_v_align", ("top", "center", "bottom"))):
            value = str(getattr(self, name)).lower()
            if value not in choices:
                raise ValueError(f"{name} must be one of: {', '.join(choices)}")
            object.__setattr__(self, name, value)
        if type(self.border_enabled) is not bool or type(self.border_px) is not int or not 0 <= self.border_px <= 300:
            raise ValueError("border_enabled must be boolean; border_px must be an integer from 0 to 300")
        for name in ("uniform_logo_shadow_enabled", "uniform_logo_trim", "badge_fit", "card_logo_trim", "card_logo_shadow_enabled", "streaming_logo_shadow_enabled", "badge_art_shadow_enabled",
                     "status_banner_simplify_dates"):
            if type(getattr(self, name)) is not bool:
                raise ValueError(f"{name} must be boolean")
        for name in ("border_color", "text_color", "badge_text_color", "matte_color", "badge_stroke_color", "badge_shadow_color", "uniform_logo_shadow_color",
                     "vignette_color", "text_stroke_color", "text_shadow_color", "badge_gradient_color", "audience_score_text_color", "chart_color",
                     "card_logo_shadow_color", "index_stroke_color", "shadow_color", "streaming_logo_shadow_color", "status_banner_border_color",
                     "status_banner_stroke_color", "status_banner_shadow_color", "badge_art_shadow_color"):
            if not isinstance(getattr(self, name), str) or not re.fullmatch(r"#[0-9a-fA-F]{6}", getattr(self, name)):
                raise ValueError(f"{name} must be #RRGGBB")
        if type(self.text_overlay_enabled) is not bool or not isinstance(self.custom_text, str):
            raise ValueError("text_overlay_enabled must be boolean; custom_text must be a string")
        if self.font_file is not None and not isinstance(self.font_file, str):
            raise ValueError("font_file must be a local font path or null")
        if not isinstance(self.badges, (list, tuple)) or any(name not in BADGES for name in self.badges):
            raise ValueError(f"badges must be a list of: {', '.join(BADGES)}")
        object.__setattr__(self, "badges", tuple(dict.fromkeys(self.badges)))
        if not isinstance(self.resource_dir, str) or not self.resource_dir.strip():
            raise ValueError("resource_dir must be a nonempty folder path")
        for name in ("title_font_file", "season_font_file", "episode_font_file", "resolution_font_file", "edition_font_file", "audience_score_font_file",
                     "status_banner_font_file"):
            if getattr(self, name) is not None and not isinstance(getattr(self, name), str):
                raise ValueError(f"{name} must be a local file path or null")
        if self.card_gradient is not None:
            if not isinstance(self.card_gradient, str) or self.card_gradient.strip().lower() != "radial":
                raise ValueError("card_gradient must be radial or null")
            object.__setattr__(self, "card_gradient", "radial")
        if not isinstance(self.title_color, str) or not re.fullmatch(r"auto|#[0-9a-fA-F]{6}", self.title_color, re.I):
            raise ValueError("title_color must be auto or #RRGGBB")
        object.__setattr__(self, "title_color", self.title_color.lower() if self.title_color.lower() == "auto" else self.title_color)
        if not isinstance(self.title_stroke_color, str) or not re.fullmatch(r"auto|#[0-9a-fA-F]{6}", self.title_stroke_color, re.I):
            raise ValueError("title_stroke_color must be auto or #RRGGBB")
        object.__setattr__(self, "title_stroke_color", self.title_stroke_color.lower() if self.title_stroke_color.lower() == "auto" else self.title_stroke_color)
        if not isinstance(self.index_color, str) or not re.fullmatch(r"#[0-9a-fA-F]{6}", self.index_color):
            raise ValueError("index_color must be #RRGGBB")
        if not isinstance(self.season_text, str) or not isinstance(self.episode_text, str):
            raise ValueError("season_text and episode_text must be strings")
        object.__setattr__(self, "badge_margin", int(self.badge_margin) if float(self.badge_margin).is_integer() else self.badge_margin)  # 25.0 hashes as 25
        tiers = self.audience_score_tiers
        if (not isinstance(tiers, (list, tuple)) or len(tiers) != 4 or any(isinstance(t, bool) or not isinstance(t, (int, float)) or not 0 <= t <= 10 for t in tiers)
                or list(tiers) != sorted(tiers, reverse=True)):
            raise ValueError("audience_score_tiers must be four scores from 0 to 10, highest first")
        object.__setattr__(self, "audience_score_tiers", tuple(tiers))
        for name, allowed, hexes in (("resolution_labels", ("480p", "576p", "720p", "1080p", "4k", "cam"), False), ("status_labels", tuple(STATUS_FILES), False),
                                     ("edition_labels", tuple(key for key, _ in EDITIONS), False), ("streaming_colors", tuple(row[0] for row in STREAMING), True)):
            object.__setattr__(self, name, label_map(name, getattr(self, name), allowed, hexes))
        if not isinstance(self.status_banner_date_format, str) or not self.status_banner_date_format.strip():
            raise ValueError("status_banner_date_format must be some text, such as ddd dd/mm")
        object.__setattr__(self, "status_banners", banner_options(self.status_banners))

    @property
    def plain_matte(self):
        """The original matte (a straight ramp into solid black), which keeps its exact pixels and signature."""
        return not self.fade_smoothness and self.matte_opacity == 1 and self.matte_color == "#000000"

    def edge_gradient(self, side):
        """(height, strength) of the badge gradient on the "top" or "bottom" edge."""
        return getattr(self, f"badge_gradient_{side}_height"), getattr(self, f"badge_gradient_{side}_strength")


# Every status banner setting is drawn from its layer (see banner_layer), which render_signature records, so none is hashed on its own.
SIGNATURE_ELSEWHERE += tuple(field.name for field in fields(Style) if field.name.startswith("status_banner"))


def cover(background, width, height, zoom=1.0):
    scale = max(width / background.width, height / background.height) * zoom
    size = (max(1, int(background.width * scale)), max(1, int(background.height * scale)))
    resized = background.resize(size, Image.Resampling.LANCZOS)
    x, y = max(0, (size[0] - width) // 2), max(0, (size[1] - height) // 2)
    return resized.crop((x, y, x + width, y + height))


@lru_cache(maxsize=8)
def effect_masks(width, height, matte_height_ratio, fade_height_ratio, vignette_strength):
    """Layouts with the same effects share immutable masks. (The "classic" vignette: the rings are painted smallest to
    largest, so the largest wins everywhere and the result is an even dimming, kept as it was for the parent app's pixels.)"""
    black = Image.new("RGB", (width, height), 0)
    matte_height = int(height * matte_height_ratio)
    fade_height = int(height * fade_height_ratio)
    matte_start = height - matte_height
    fade_start = max(0, matte_start - fade_height)
    column = np.zeros(height, dtype=np.float32)
    column[fade_start:matte_start] = (
        np.arange(matte_start - fade_start, dtype=np.float32) / max(fade_height, 1) * 255)
    column[matte_start:] = 255
    matte = Image.fromarray(column.astype(np.uint8).reshape(height, 1)).resize(
        (width, height), Image.Resampling.NEAREST)
    vignette = None
    if vignette_strength:
        mask = Image.new("L", (width, height), 0)
        draw = ImageDraw.Draw(mask)
        for i in range(60):
            radius = max(width, height) * (i / 60)
            draw.ellipse((width / 2 - radius, height / 2 - radius,
                          width / 2 + radius, height / 2 + radius),
                         fill=int(255 * vignette_strength * (i / 60)))
        vignette = mask.filter(ImageFilter.GaussianBlur(90 * width / 2000))
    return black, matte, vignette


@lru_cache(maxsize=2)
def radial_vignette(width, height, strength, size, falloff):
    """The real vignette (vignette_mode radial): 0 in the middle rising to `strength` at the corners, along an ellipse that
    follows the picture's frame. `size` scales how far in it reaches; `falloff` shapes the ramp (above 1 stays clear longer)."""
    x = (np.arange(width, dtype=np.float32) - (width - 1) / 2) / (width / 2)
    y = (np.arange(height, dtype=np.float32) - (height - 1) / 2) / (height / 2)
    mask = np.minimum(np.sqrt(x[None, :] ** 2 + y[:, None] ** 2) / math.sqrt(2) / size, 1) ** falloff * strength
    mask = mask.astype(np.float32)
    mask.flags.writeable = False  # Shared between renders
    return mask


@lru_cache(maxsize=8)
def matte_ramp(height, matte_height_ratio, fade_height_ratio, fade_smoothness, matte_opacity):
    """(first row of the fade, first row of the matte block, the fade's opacity per row) for the matte used when
    `Style.plain_matte` is false: effect_masks' ramp, eased by `fade_smoothness` (a blend of straight and smootherstep,
    which are flat where the ramp starts and meets the block) and scaled to `matte_opacity`."""
    matte_start = height - int(height * matte_height_ratio)
    fade_height = min(int(height * fade_height_ratio), matte_start)
    t = np.arange(fade_height, dtype=np.float32) / max(fade_height, 1)
    t += fade_smoothness * (t * t * t * (t * (t * 6 - 15) + 10) - t)
    t *= matte_opacity
    t.flags.writeable = False  # Shared between renders
    return matte_start - fade_height, matte_start, t


def codec_key(files):
    """Badge file stem for the first file whose name tags a video and/or audio codec."""
    for path in files:
        video = next((key for key, tag in VIDEO_TAGS if re.search(tag, path, re.I)), None)
        audio = next((key for key, tag in AUDIO_TAGS if re.search(tag, path, re.I)), None)
        if video or audio:
            return f"{video}-{audio}" if video and audio else video or audio
    return None


def gradient_sides(badges):
    """The edges the gradient badges shade, top first (`gradients` is both)."""
    return tuple(side for side in ("top", "bottom") if "gradients" in badges or f"gradient_{side}" in badges)


def to_date(text):
    try:
        return date.fromisoformat(text)
    except (TypeError, ValueError):
        return None


def banner_date(day, pattern, simplify, today):
    """A date worded by `pattern` (English names): d, dd, ddd (weekday), dddd, m, mm, mmm, mmmm, yy and yyyy are replaced. With `simplify`
    dates up to seven days ahead read today, tomorrow or the full weekday (abbreviated only for an explicit ddd without dddd)."""
    ahead, weekday = (day - today).days, WEEKDAYS[day.weekday()]
    if simplify and 0 <= ahead <= 7:
        weekday = weekday[:3] if "ddd" in pattern and "dddd" not in pattern else weekday
        return "today" if ahead == 0 else "tomorrow" if ahead == 1 else weekday
    names = {"yyyy": f"{day.year:04d}", "yy": f"{day.year % 100:02d}", "mmmm": MONTHS[day.month - 1], "mmm": MONTHS[day.month - 1][:3],
             "mm": f"{day.month:02d}", "m": str(day.month), "dddd": weekday, "ddd": weekday[:3], "dd": f"{day.day:02d}", "d": str(day.day)}
    return re.sub(r"yyyy|yy|mmmm|mmm|mm|m|dddd|ddd|dd|d", lambda found: names[found[0]], pattern)


def banner_pick(data, added, today, settings):
    """The status banner a show gets, by TSSK's rules but from TMDb's /tv details `data` (no Sonarr) and the day it was added to Plex
    (`added`, or None): {"category", "season", "episode", "date"}, or None. A category applies when its event falls inside its window
    of days (ahead for what is coming, back for what has happened) and it is enabled; `settings` is banner_settings()."""
    status = data.get("status")
    last, upcoming = data.get("last_episode_to_air") or {}, data.get("next_episode_to_air") or {}
    seasons = {season.get("season_number"): season for season in data.get("seasons") or []}

    def finale(episode):
        """A season's last episode: as TMDb's episode_type says where it has one, else by number (a lone episode doesn't count)."""
        if "episode_type" in episode:
            return episode["episode_type"] == "finale"
        number = episode.get("episode_number") or 0
        return number > 1 and number == (seasons.get(episode.get("season_number")) or {}).get("episode_count")

    def near(category, day, ahead):
        gap = (day - today if ahead else today - day).days if day else -1
        return 0 <= gap <= (settings[category]["days"] or 0)

    coming, aired = to_date(upcoming.get("air_date")), to_date(last.get("air_date"))
    season, number = upcoming.get("season_number") or 0, upcoming.get("episode_number") or 0
    found = []
    if near("new_show", added, False):
        found.append(("new_show", None, None, added))
    kind = (None if season < 1 else "new_season" if number == 1 and season > 1 else "upcoming_finale" if number > 1 and finale(upcoming)
            else "upcoming_episode" if number > 1 else None)  # A show's first episode is the new show's business, not a banner of its own
    if kind and near(kind, coming, True):
        found.append((kind, season, number, coming))
    for started in sorted((n for n in seasons if isinstance(n, int) and n > 1), reverse=True):
        day = to_date(seasons[started].get("air_date"))
        if near("new_season_started", day, False):
            found.append(("new_season_started", started, 1, day))
            break
    ended = (last.get("season_number"), last.get("episode_number"), aired)
    for episode, day in ((upcoming, coming), (last, aired)):
        season, number = episode.get("season_number") or 0, episode.get("episode_number") or 0
        if season > 0 and number > 0 and (season, number) != (1, 1) and near("new_episode", day, False):
            found.append(("new_episode", season, number, day))
            break
    if status == "Returning Series" and finale(last) and near("season_finale", aired, False):
        found.append(("season_finale", *ended))
    if status == "Ended" and near("final_episode", aired, False):
        found.append(("final_episode", *ended))
    for category, wanted in (("returning", "Returning Series"), ("ended", "Ended"), ("canceled", "Canceled")):
        if status == wanted:
            found.append((category, None, None, None))
    found = [entry for entry in found if settings[entry[0]]["enabled"]]
    if not found:
        return None
    category, season, episode, day = max(found, key=lambda entry: (settings[entry[0]]["weight"], -list(BANNERS).index(entry[0])))
    return {"category": category, "season": season, "episode": episode, "date": day.isoformat() if day else None}


def sample_banner(category):
    """Made-up facts for a Template preview of one banner category: season 2, episode 8, three days from today."""
    return {"category": category, "season": 2, "episode": 8, "date": (date.today() + timedelta(days=3)).isoformat()}


def banner_layer(banner, style, base):
    """The status banner as a layer, in badge pixels like the rest: its words (with {season}, {episode} and {date} filled in, in
    status_banner_text_transform's case), color and backdrop, and a `look` with everything else that draws it (the bar, words and
    effects), so that render_signature records it all. `banner` is banner_pick's answer."""
    settings = banner_settings(style.status_banners)[banner["category"]]
    day, text = to_date(banner.get("date")), settings["text"]
    values = {"season": banner.get("season"), "episode": banner.get("episode"),
              "date": banner_date(day, style.status_banner_date_format, style.status_banner_simplify_dates, date.today()) if day else ""}
    for name, value in values.items():
        text = text.replace("{" + name + "}", "" if value is None else str(value))
    font, opacity = style.status_banner_font_file, settings["opacity"]
    look = {"bar": (style.status_banner_width, style.status_banner_height), "radius": style.status_banner_radius,
            "opacity": style.status_banner_backdrop_opacity if opacity is None else opacity,
            "border": (style.status_banner_border_width, style.status_banner_border_color),
            "spacing": style.status_banner_letter_spacing, "text_opacity": style.status_banner_text_opacity, "align": style.status_banner_text_align,
            "pad": style.status_banner_padding, "dx": style.status_banner_text_offset_x, "dy": style.status_banner_text_offset_y,
            "stroke": (style.status_banner_stroke_width, style.status_banner_stroke_opacity, style.status_banner_stroke_color),
            "shadow": (style.status_banner_shadow_strength, style.status_banner_shadow_blur, style.status_banner_shadow_offset_y, style.status_banner_shadow_color)}
    return {"banner": transform_text(text, style.status_banner_text_transform).strip(), "h": style.status_banner_h_align, "v": style.status_banner_v_align,
            "x": style.status_banner_offset_x, "y": style.status_banner_offset_y, "backdrop": settings["backdrop"] or None,
            "size": style.status_banner_font_size, "color": settings["color"], "look": look,
            "font": local_path(font, base) if font else local_path(style.resource_dir, base) / "fonts" / "Poppins" / "Poppins-Bold.ttf"}


def badge_layers(item, style, base):
    """Badges for one item, in draw order. The renderer and render_signature share this plan.

    Offsets are Kometa's pixels on a 1000px-wide poster (scaled at draw time). Season
    posters get none, as in Kometa's show-level overlays.
    """
    if not style.badges or item.get("season") is not None:
        return []
    root, media, movie = local_path(style.resource_dir, base), item.get("media") or {}, item.get("type", "movie") == "movie"
    files, resolution, layers, margin = media.get("files", []), media.get("resolution"), [], style.badge_margin
    start = margin  # Where the top-left text badges begin: after the streaming logo, when that sits there

    def add(folder, name, h="left", v="top", x=None, **extra):
        layers.append({"file": root / folder / f"{name}.png", "h": h, "v": v, "x": margin if x is None else x, "y": margin, **extra})

    def label(kind, text, x=None):
        size, file, default = ((style.resolution_font_size, style.resolution_font_file, "Poppins-ExtraBold.ttf") if kind == "resolution"
                               else (style.edition_font_size, style.edition_font_file, "Poppins-Regular.ttf"))
        layers.append({"label": text, "kind": kind, "h": "left", "v": "top", "x": start if x is None else x, "y": margin, "size": size,
                       "font": local_path(file, base) if file else root / "fonts" / "Poppins" / default, "color": style.badge_text_color})

    def words(kind, key, default):
        """A badge's text: the layout's own wording for `key` if it has some, else `default`, in badge_text_transform's case."""
        text = dict(getattr(style, f"{kind}_labels")).get(key) or default
        return text.upper() if style.badge_text_transform == "uppercase" else text.lower() if style.badge_text_transform == "lowercase" else text

    layers += [{"gradient": side, "h": "fill", "v": side, "x": 0, "y": 0} for side in gradient_sides(style.badges)]
    service = media.get("streaming")
    if "streaming" in style.badges and item.get("type") == "tv" and service:
        file = root / "streaming_overlay" / f"{STREAMING_OVERLAY.get(service, service)}.png"
        if file.is_file():
            box, x = (style.streaming_logo_max_w, style.streaming_logo_max_h), margin + style.streaming_logo_offset_x
            layers.append({"file": file, "h": style.streaming_logo_h, "v": style.streaming_logo_v, "x": x, "y": margin + style.streaming_logo_offset_y, "box": box})
            if style.streaming_logo_h == "left" and style.streaming_logo_v == "top":  # The text badges follow it
                width, height = badge_image(file, 1).size
                start = x + width * min(box[0] / width, box[1] / height) + style.badge_gap
    shifted = False
    if "resolution" in style.badges:
        cam = movie and any(re.search(CAM, path, re.I) for path in files)
        text = "CAM" if cam else RESOLUTION_FILES.get(resolution)
        if text:
            label("resolution", words("resolution", "cam" if cam else resolution, text))
            shifted = True
    second = start + 136 if shifted else start  # Kometa's second box starts 136px after the first (x 161 at the default margin)
    if "edition" in style.badges and movie and resolution in ("1080p", "4k"):
        edition = next((key for key, tag in reversed(EDITIONS) if any(re.search(tag, path, re.I) for path in files)), None)
        if edition == "IMAX":
            add("edition", edition, x=second)
        elif edition:
            label("edition", words("edition", edition, EDITION_LABELS.get(edition) or edition.replace("-", " ")), x=second)
    if "codec" in style.badges and movie:
        key = codec_key(files)
        if key:
            add("codec", key, v="bottom")
    if "status" in style.badges and media.get("status"):
        label("edition", words("status", media["status"], STATUS_FILES[media["status"]]), x=second)
    rating = media.get("audience")
    if "audience_score" in style.badges and rating is not None:
        tier = next(name for floor, (_, name) in zip(style.audience_score_tiers + (0,), AUDIENCE_TIERS) if rating >= floor)
        art = root / "audience_score" / f"audience_score_{tier}.png"
        layers.append({"h": "right", "v": "bottom", "x": margin, "y": margin, "text": f"{rating:.1f}",
                       "font": local_path(style.audience_score_font_file, base) if style.audience_score_font_file else root / "fonts" / "centurygothic_bold.ttf",
                       **({"file": art} if art.is_file() else {"fill": AUDIENCE_COLORS[tier]})})
    if "status_banner" in style.badges and item.get("type") == "tv" and media.get("banner"):
        layer = banner_layer(media["banner"], style, base)
        if layer["banner"]:
            layers.append(layer)
    return layers


@lru_cache(maxsize=4)
def dither_noise(width, height):
    """A fixed triangular dither (-1..1 per pixel). Smooth fades are darkened in float and get this before their single
    rounding to 8 bits, so they can't band."""
    rng = np.random.default_rng(0)
    noise = rng.random((height, width), dtype=np.float32) + rng.random((height, width), dtype=np.float32) - 1
    noise.flags.writeable = False  # Shared between renders
    return noise


def dither_shade(pixels, shade, lift=None, noise=None):
    """Darken float32 RGB `pixels` (changed in place) by `shade`, per row or per pixel, add `lift` (the color faded to),
    dither (with `noise`, a matching piece of dither_noise's picture-sized pattern, if given), and round once to 8 bits."""
    pixels *= shade.reshape(shade.shape + (1,) * (pixels.ndim - shade.ndim))
    if lift is not None:
        pixels += lift
    pixels += (dither_noise(pixels.shape[1], pixels.shape[0]) if noise is None else noise)[..., None]
    np.clip(np.rint(pixels, out=pixels), 0, 255, out=pixels)
    return Image.fromarray(pixels.astype(np.uint8))


def running_max(pixels, window):
    """The maximum over every `window` consecutive entries along the last axis (zeros beyond the ends), by van Herk and
    Gil-Werman: the same few passes at any window size, where PIL's MaxFilter slows down with its square."""
    n, reach = pixels.shape[-1], window // 2
    blocks = -(-(n + 2 * reach) // window)
    padded = np.zeros(pixels.shape[:-1] + (blocks * window,), pixels.dtype)
    padded[..., reach:reach + n] = pixels
    shaped = padded.reshape(pixels.shape[:-1] + (blocks, window))
    head = np.maximum.accumulate(shaped, axis=-1).reshape(padded.shape)  # Largest so far in each block
    tail = np.maximum.accumulate(shaped[..., ::-1], axis=-1)[..., ::-1].reshape(padded.shape)  # Largest from here to its end
    return np.maximum(tail[..., :n], head[..., window - 1:window - 1 + n])


def film_grain(noise, blur, amount):
    """The noise of grain_mode film, as float32 levels: `noise` (uniform 0-1) blurred to the grain size, then scaled to a
    standard deviation of 20 x `amount` levels whatever the size, so a coarser grain isn't a fainter one."""
    grain = Image.fromarray((noise * 255).astype(np.uint8))
    if blur:
        grain = grain.filter(ImageFilter.GaussianBlur(blur))
    values = np.asarray(grain, dtype=np.float32)
    values = values - values.mean()
    return values * (20 * amount / max(float(values.std()), 1e-6))


def grow_mask(mask, radius):
    """An "L" mask with every shape grown by `radius` pixels (the maximum over a square window along each axis)."""
    pixels = np.asarray(mask)
    for axis in (0, 1):
        pixels = np.moveaxis(running_max(np.moveaxis(pixels, axis, -1), 2 * radius + 1), -1, axis)
    return Image.fromarray(np.ascontiguousarray(pixels))


@lru_cache(maxsize=4)
def badge_gradient(height, edges):
    """Black fades from the top and/or bottom edge as a per-row brightness multiplier; `edges` is ((side, extent, strength), ...).

    The falloff, 1 - exp(-(distance/sigma)^1.8), has no hard start or end, and `extent` is where it is ~2% (as in
    the Kometa PNGs this replaces).
    """
    rows = np.arange(height, dtype=np.float32) / height
    shade = np.ones(height, dtype=np.float32)
    for side, extent, strength in edges:
        sigma = extent / 2.14
        shade *= 1 - strength * np.exp(-(((rows if side == "top" else 1 - rows) / sigma) ** 1.8))
    return shade


@lru_cache(maxsize=256)
def badge_image(path, scale):
    """Load a badge drawn for a 1000px poster; prefer its @2x art on large canvases."""
    retina = path.parent / "@2x" / f"{path.stem}@2x{path.suffix}"
    source, factor = (retina, scale / 2) if scale > 1.5 and retina.is_file() else (path, scale)
    with Image.open(source) as image:
        image = image.convert("RGBA")
    size = (max(1, round(image.width * factor)), max(1, round(image.height * factor)))
    return image if image.size == size else image.resize(size, Image.Resampling.LANCZOS)


@lru_cache(maxsize=32)
def score_box(color, scale):
    """The audience score's box in `color` for a 1000px poster drawn at `scale`, supersampled so the corners stay smooth."""
    width, height = (max(1, round(side * scale)) for side in SCORE_BOX)
    big = Image.new("L", (width * 8, height * 8), 0)
    ImageDraw.Draw(big).rounded_rectangle((0, 0, width * 8 - 1, height * 8 - 1), radius=SCORE_RADIUS * width / SCORE_BOX[0] * 8, fill=255)
    box = Image.new("RGBA", (width, height), color)
    box.putalpha(big.resize((width, height), Image.Resampling.BOX))
    return box


@lru_cache(maxsize=8)
def badge_font(path, size):
    try:
        return ImageFont.truetype(str(path), size)
    except OSError:
        raise ValueError(f"Cannot open font file {path}") from None


def badge_label(layer, scale, left=None, bounds=None):
    """Where a text badge goes, as (x, baseline, glyphs, font, right), where `right` is where its ink ends. Normally it sits in
    Kometa's 80px badge box: vertically centered, resolution right-aligned and edition/status (with a leading bullet)
    left-aligned, by their ink rather than their advance widths. With `left` its ink starts there instead (the flow
    layout). With `bounds` = (low, high) the ink must stay between them, and the text shrinks until it does."""
    resolution, size = layer["kind"] == "resolution", layer["size"]
    for _ in range(12):
        font = badge_font(layer["font"], max(1, size * scale))
        glyphs, advance = spaced_glyphs(font, layer["label"], (BADGE_RESOLUTION_KERNING if resolution else BADGE_LABEL_KERNING) * scale)
        if not resolution:
            shift = font.getlength("•") + BADGE_LABEL_BULLET_GAP * scale
            glyphs = [("•", 0.0)] + [(char, offset + shift) for char, offset in glyphs]
            advance += shift
        pad = font.size  # Rasterize once to find where the ink really starts and ends (glyph boxes include side bearings)
        probe = Image.new("L", (int(advance + 2 * pad), int(2 * pad)), 0)
        draw_spaced(ImageDraw.Draw(probe), pad, pad * 1.5, glyphs, font, 255)
        ink_left, _, ink_right, _ = probe.getbbox()
        ink_left, ink_right = ink_left - pad, ink_right - pad
        x = (left - ink_left if left is not None else (layer["x"] + BADGE_RESOLUTION_EDGE) * scale - ink_right if resolution
             else (layer["x"] + BADGE_LABEL_INSET) * scale - ink_left)
        over = 0 if bounds is None else max(bounds[0] - (x + ink_left), (x + ink_right) - bounds[1], 0)
        if not over or size <= 6:
            break
        size = max(6, size * max(0.5, 1 - over / (ink_right - ink_left)) * 0.99)
    cap = -font.getbbox("H", anchor="ls")[1]
    return x, (layer["y"] + BADGE_BOX_HEIGHT / 2) * scale + cap / 2, glyphs, font, x + ink_right


def banner_shape(layer, scale, width, height):
    """Where a status banner goes: its bar as (left, top, right, bottom) and its words as badge_label's (x, baseline, glyphs, font,
    right). The bar sits against its side and edge, moved in by the offsets; the words are placed in it by their ink and capital
    height, and shrunk until they fit between the paddings."""
    look = layer["look"]
    bar_w, bar_h = look["bar"][0] * scale, look["bar"][1] * scale
    offset_x, offset_y, pad, size = layer["x"] * scale, layer["y"] * scale, look["pad"] * scale, layer["size"]
    left = {"left": offset_x, "center": (width - bar_w) / 2 + offset_x, "right": width - bar_w - offset_x}[layer["h"]]
    top = {"top": offset_y, "center": (height - bar_h) / 2 + offset_y, "bottom": height - bar_h - offset_y}[layer["v"]]
    room = max(1, bar_w - 2 * pad)
    for _ in range(8):
        font = badge_font(layer["font"], max(1, size * scale))
        glyphs, advance = spaced_glyphs(font, layer["banner"], look["spacing"] * scale)
        margin = font.size  # Rasterize once to find where the ink really starts and ends
        probe = Image.new("L", (max(1, int(advance + 2 * margin)), max(1, int(2 * margin))), 0)
        draw_spaced(ImageDraw.Draw(probe), margin, margin * 1.5, glyphs, font, 255)
        found = probe.getbbox()
        ink_left, ink_right = (found[0] - margin, found[2] - margin) if found else (0, advance)
        if ink_right - ink_left <= room or size <= 6:
            break
        size = max(6, size * room / (ink_right - ink_left) * 0.99)
    x = {"left": left + pad - ink_left, "center": left + bar_w / 2 - (ink_left + ink_right) / 2, "right": left + bar_w - pad - ink_right}[look["align"]]
    x += look["dx"] * scale
    baseline = top + bar_h / 2 - font.getbbox("H", anchor="ls")[1] / 2 + look["dy"] * scale
    return (round(left), round(top), round(left + bar_w), round(top + bar_h)), (x, baseline, glyphs, font, x + ink_right)


@lru_cache(maxsize=4)
def rounded_mask(width, height, radius):
    """A width x height mask with rounded corners. Only the corners are drawn, 4x larger and scaled down, so the curve is
    smooth without drawing the whole poster at 4x."""
    radius = min(radius, width // 2, height // 2)
    mask = Image.new("L", (width, height), 255)
    if radius < 1:
        return mask
    big = Image.new("L", (radius * 8, radius * 8), 0)
    ImageDraw.Draw(big).ellipse((0, 0, radius * 8 - 1, radius * 8 - 1), fill=255)
    corner = big.resize((radius * 2, radius * 2), Image.Resampling.LANCZOS).crop((0, 0, radius, radius))
    mask.paste(corner, (0, 0))
    mask.paste(corner.transpose(Image.Transpose.FLIP_LEFT_RIGHT), (width - radius, 0))
    mask.paste(corner.transpose(Image.Transpose.FLIP_TOP_BOTTOM), (0, height - radius))
    mask.paste(corner.transpose(Image.Transpose.ROTATE_180), (width - radius, height - radius))
    return mask


class Renderer:
    """Render a resolved layout, reusing cached masks across the batch."""

    def __init__(self, style, base=Path(".")):
        self.style, self.base = style, base
        radial = style.vignette_strength and style.vignette_mode == "radial"
        self.black, self.matte, self.vignette = effect_masks(
            style.width, style.height, style.matte_height_ratio,
            style.fade_height_ratio, 0 if radial else style.vignette_strength)
        self.vignette_color = None if style.vignette_color == "#000000" else Image.new("RGB", (style.width, style.height), style.vignette_color)
        self.radial = radial_vignette(style.width, style.height, style.vignette_strength, style.vignette_size, style.vignette_falloff) if radial else None
        self.vignette_rgb = np.array(ImageColor.getrgb(style.vignette_color), dtype=np.float32)
        self.ramp = None if style.plain_matte else matte_ramp(
            style.height, style.matte_height_ratio, style.fade_height_ratio, style.fade_smoothness, style.matte_opacity)
        self.font = self.grain = None
        if style.grain_amount:
            # Made once per layout: with grain_seed every render used the same noise anyway, and without one the
            # posters of a run now share a single random pattern instead of paying ~90 ms each for a new one.
            # Float32 noise uses half the temporary memory of the app's float64 noise.
            noise = np.random.default_rng(style.grain_seed).random((style.height, style.width), dtype=np.float32)
            blur = style.grain_size * style.width / 2000
            if style.grain_mode == "film":
                self.grain = film_grain(noise, blur, style.grain_amount)
            else:
                noise *= 256 * style.grain_amount
                noise += 128 - 128 * style.grain_amount
                grain = Image.fromarray(noise.clip(0, 255).astype(np.uint8))
                if blur:
                    grain = grain.filter(ImageFilter.GaussianBlur(blur))
                self.grain = Image.merge("RGB", (grain, grain, grain))
        if style.text_overlay_enabled:
            size = max(1, round(style.font_size * style.width / 2000))
            self.font = ImageFont.truetype(str(local_path(style.font_file, base)), size) if style.font_file else ImageFont.load_default(size=size)

    def badge_text_effects(self, canvas, shapes, scale):
        """The shadow, then the outline, under the resolution, edition and status text, in the title card's order."""
        style = self.style
        stroke = max(1, round(style.badge_stroke_width * scale)) if style.badge_stroke_width and style.badge_stroke_opacity else 0
        if shapes and style.badge_shadow_strength:
            text_shadow(canvas, [(x, y, glyphs, font, stroke) for x, y, glyphs, font in shapes], style.badge_shadow_blur * scale,
                        style.badge_shadow_strength, round(style.badge_shadow_offset_y * scale), ImageColor.getrgb(style.badge_shadow_color))
        if shapes and stroke:
            text_stroke(canvas, [(x, y, glyphs, font, stroke, style.badge_stroke_color) for x, y, glyphs, font in shapes], style.badge_stroke_opacity)

    def paint_bar(self, canvas, layer, box, scale):
        """The status banner's bar: rounded, at its opacity, with its border (solid) drawn inside its edge. No backdrop, no bar."""
        left, top, right, bottom = box
        width, height, look = right - left, bottom - top, layer["look"]
        if not layer["backdrop"] or width < 1 or height < 1:
            return
        radius, border = round(look["radius"] * scale), round(look["border"][0] * scale)
        outer = rounded_mask(width, height, radius)
        canvas.paste(layer["backdrop"], (left, top), outer if look["opacity"] >= 1 else outer.point(lambda value: round(value * look["opacity"])))
        if border and width > 2 * border and height > 2 * border:
            inner = Image.new("L", (width, height), 0)
            inner.paste(rounded_mask(width - 2 * border, height - 2 * border, max(0, radius - border)), (border, border))
            canvas.paste(look["border"][1], (left, top), ImageChops.subtract(outer, inner))

    def banner_text(self, canvas, layer, shape, scale):
        """The status banner's words: the shadow, then the outline, then the letters at their opacity."""
        look, (x, y, glyphs, font, _) = layer["look"], shape
        (stroke_width, stroke_opacity, stroke_color), (strength, blur, offset, shadow_color) = look["stroke"], look["shadow"]
        stroke = max(1, round(stroke_width * scale)) if stroke_width and stroke_opacity else 0
        if strength:
            text_shadow(canvas, [(x, y, glyphs, font, stroke)], blur * scale, strength, round(offset * scale), ImageColor.getrgb(shadow_color))
        if stroke:
            text_stroke(canvas, [(x, y, glyphs, font, stroke, stroke_color)], stroke_opacity)
        if look["text_opacity"] >= 1:
            draw_spaced(ImageDraw.Draw(canvas), x, y, glyphs, font, layer["color"])
            return
        mask = Image.new("L", canvas.size, 0)
        draw_spaced(ImageDraw.Draw(mask), x, y, glyphs, font, 255)
        found = mask.getbbox()
        if found:
            canvas.paste(layer["color"], found, mask.crop(found).point(lambda value: round(value * look["text_opacity"])))

    def streaming_placement(self, layer, scale, width, height):
        """The streaming logo as (image, x, y): fitted in its box, against the corner it names, centered along the box's height."""
        box_w, box_h = layer["box"]
        native = badge_image(layer["file"], 1)
        image = badge_image(layer["file"], scale * min(box_w / native.width, box_h / native.height))
        x = width - image.width - round(layer["x"] * scale) if layer["h"] == "right" else round(layer["x"] * scale)
        top = height - round(box_h * scale) - round(layer["y"] * scale) if layer["v"] == "bottom" else round(layer["y"] * scale)
        return image, x, top + (round(box_h * scale) - image.height) // 2

    def paste_streaming(self, canvas, layer, scale):
        style = self.style
        image, x, y = self.streaming_placement(layer, scale, *canvas.size)
        if style.streaming_logo_shadow_enabled and style.streaming_logo_shadow_opacity:
            logo_shadow(canvas, image, x, y, scale, style.streaming_logo_shadow_opacity, style.streaming_logo_shadow_angle,
                        style.streaming_logo_shadow_distance, style.streaming_logo_shadow_size, style.streaming_logo_shadow_spread, style.streaming_logo_shadow_color)
        canvas.paste(image, (x, y), image)

    def paste_badges(self, canvas, layers):
        style = self.style
        width, height = canvas.size
        scale = width / 1000
        art = scale * style.badge_art_scale  # The IMAX, codec and score art; the text badges have their own sizes
        draw = ImageDraw.Draw(canvas)
        edges = tuple((layer["gradient"], *style.edge_gradient(layer["gradient"])) for layer in layers if layer.get("gradient"))
        if edges:
            shade = badge_gradient(height, edges)
            color = ImageColor.getrgb(style.badge_gradient_color)
            lift = None if color == (0, 0, 0) else (1 - shade)[:, None, None] * np.array(color, dtype=np.float32)
            canvas.paste(dither_shade(np.asarray(canvas.convert("RGB"), dtype=np.float32), shade, lift))
        flow, margin = style.badge_layout == "flow", style.badge_margin * scale
        bounds = (margin, width - margin) if style.badge_fit else None
        shapes, art_x, cursor, bars = {}, {}, None, {}  # The flow layout chains the top-left badges: each starts after the previous one's ink
        for index, layer in enumerate(layers):
            if layer.get("gradient"):
                continue
            if layer.get("banner"):  # Centered along the bottom: no part of the top-left flow
                bars[index], shapes[index] = banner_shape(layer, scale, width, height)
                continue
            start = margin if cursor is None else cursor + style.badge_gap * scale
            if layer.get("label"):
                shapes[index] = badge_label(layer, scale, start if flow else None, bounds)
                cursor = shapes[index][4]
            elif layer.get("box"):  # The streaming logo
                if flow and layer["h"] == "left" and layer["v"] == "top":
                    image, x, _ = self.streaming_placement(layer, scale, width, height)
                    cursor = x + image.width
            elif flow and layer["h"] == "left" and layer["v"] == "top":
                image = badge_image(layer["file"], art)
                box = image.getchannel("A").getbbox() or (0, 0, image.width, image.height)
                art_x[index] = start - box[0]  # So the visible art, not its transparent margin, starts there
                cursor = art_x[index] + box[2]
        for index, box in bars.items():
            self.paint_bar(canvas, layers[index], box, scale)
        self.badge_text_effects(canvas, [shape[:4] for index, shape in shapes.items() if index not in bars], scale)
        for index, layer in enumerate(layers):
            if layer.get("gradient"):
                continue
            if layer.get("banner"):
                self.banner_text(canvas, layer, shapes[index], scale)
                continue
            if index in shapes:
                x, y, glyphs, font, _ = shapes[index]
                draw_spaced(draw, x, y, glyphs, font, layer["color"])
                continue
            if layer.get("box"):
                self.paste_streaming(canvas, layer, scale)
                continue
            image = score_box(layer["fill"], art) if "fill" in layer else badge_image(layer["file"], art)
            offset_x, offset_y = round(layer["x"] * scale), round(layer["y"] * scale)
            x = width - image.width - offset_x if layer["h"] == "right" else round(art_x[index]) if index in art_x else offset_x
            y = height - image.height - offset_y if layer["v"] == "bottom" else offset_y
            if style.badge_art_shadow_enabled and style.badge_art_shadow_opacity:
                logo_shadow(canvas, image, x, y, scale, style.badge_art_shadow_opacity, style.badge_art_shadow_angle,
                            style.badge_art_shadow_distance, style.badge_art_shadow_size, style.badge_art_shadow_spread, style.badge_art_shadow_color)
            canvas.paste(image, (x, y), image)
            if layer.get("text"):
                font = badge_font(layer["font"], round(style.audience_score_font_size * art))
                left, top, right, bottom = draw.textbbox((0, 0), layer["text"], font=font)
                draw.text((x + (image.width - (right - left)) / 2 - left, y + (image.height - (bottom - top)) / 2 - top),
                          layer["text"], font=font, fill=style.audience_score_text_color)

    def text_effects(self, canvas, rows):
        """The shadow, then the outline, under the custom text (rows are (x, top, line)), in the title card's order."""
        style, k = self.style, canvas.width / 2000
        stroke = max(1, round(style.text_stroke_width * k)) if style.text_stroke_width and style.text_stroke_opacity else 0
        if style.text_shadow_strength:
            text_shadow(canvas, [(x, top, line, self.font, stroke) for x, top, line in rows], style.text_shadow_blur * k, style.text_shadow_strength,
                        round(style.text_shadow_offset_y * k), ImageColor.getrgb(style.text_shadow_color))
        if stroke:
            text_stroke(canvas, [(x, top, line, self.font, stroke, style.text_stroke_color) for x, top, line in rows], style.text_stroke_opacity)

    def add_film_grain(self, canvas):
        """Add the film grain, weighted by brightness so it fades out toward pure black and pure white: a black matte stays black."""
        pixels = np.asarray(canvas, dtype=np.float32)
        light = pixels @ np.array([0.299, 0.587, 0.114], dtype=np.float32) / 255
        pixels += (self.grain * np.minimum(1, np.minimum(light, 1 - light) / 0.2))[..., None]
        return Image.fromarray(np.rint(pixels).clip(0, 255).astype(np.uint8))

    def paint_matte(self, canvas):
        """Fade to `matte_color`: the fade is darkened in float and dithered so it can't band; the block below it is one blend."""
        start, end, alpha = self.ramp
        color, opacity = ImageColor.getrgb(self.style.matte_color), self.style.matte_opacity
        width, height = canvas.size
        if end > start:
            band = np.asarray(canvas.crop((0, start, width, end)), dtype=np.float32)
            canvas.paste(dither_shade(band, 1 - alpha, alpha[:, None, None] * np.array(color, dtype=np.float32)), (0, start))
        if end < height:
            if opacity == 1:
                canvas.paste(color, (0, end, width, height))
            else:
                block = canvas.crop((0, end, width, height))
                canvas.paste(Image.blend(block, Image.new("RGB", block.size, color), opacity), (0, end))
        return canvas

    def logo_shadow(self, canvas, logo, x, y):
        style = self.style  # Distances are pixels on a 2000px-wide poster, like the logo box
        logo_shadow(canvas, logo, x, y, canvas.width / 2000, style.uniform_logo_shadow_opacity, style.uniform_logo_shadow_angle,
                    style.uniform_logo_shadow_distance, style.uniform_logo_shadow_size, style.uniform_logo_shadow_spread, style.uniform_logo_shadow_color)

    def render(self, background, logo=None, stock=False, item=None):
        style = self.style
        width, height = style.width, style.height
        layers = badge_layers(item or {}, style, self.base)
        backdrops = [layer for layer in layers if layer["h"] == "fill"]
        badges = layers[len(backdrops):]
        if stock:
            canvas = cover(background, width, height).convert("RGB")
            self.paste_badges(canvas, layers)
            return canvas
        # Pasting RGBA into RGB drops alpha, exactly as compositing in RGBA and converting afterwards did.
        canvas = Image.new("RGB", (width, height), 0)
        canvas.paste(cover(background, width, height, style.poster_zoom),
                     (int(style.poster_shift_x * width), int(style.poster_shift_y * height)))
        if style.matte_height_ratio or style.fade_height_ratio:  # Otherwise the matte mask is all zero
            canvas = Image.composite(self.black, canvas, self.matte) if self.ramp is None else self.paint_matte(canvas)
        if self.vignette is not None:
            canvas = Image.composite(self.black if self.vignette_color is None else self.vignette_color, canvas, self.vignette)
        elif self.radial is not None:  # In float and dithered, like the other fades, so a faint vignette can't band
            canvas = dither_shade(np.asarray(canvas, dtype=np.float32), 1 - self.radial, self.radial[..., None] * self.vignette_rgb)
        if self.grain is not None:
            canvas = Image.blend(canvas, self.grain, style.grain_amount) if style.grain_mode == "blend" else self.add_film_grain(canvas)
        self.paste_badges(canvas, backdrops)  # Behind the logo and text so they stay crisp.
        if logo is not None and style.logo_mode != "none":
            logo = logo.convert("RGBA")
            center_below = 0 if (item or {}).get("season") is not None else style.uniform_logo_center_below  # Series posters only
            if center_below or style.uniform_logo_trim:  # Transparent padding would make the visible art smaller and off-center
                trim = logo.getchannel("A").getbbox()
                if trim:
                    logo = logo.crop(trim)
            max_w = style.uniform_logo_max_w * width / 2000
            max_h = style.uniform_logo_max_h * height / 3000
            scale = min(max_w / logo.width, max_h / logo.height)
            size = (max(1, int(logo.width * scale)), max(1, int(logo.height * scale)))
            logo = logo.resize(size, Image.Resampling.LANCZOS)
            center = (int(width * style.uniform_logo_offset_x), int(height * style.uniform_logo_offset_y))
            box_w, box_h = int(max_w), int(max_h)
            x = center[0] - box_w // 2 if style.uniform_logo_h_align == "left" else center[0] + box_w // 2 - size[0] if style.uniform_logo_h_align == "right" else center[0] - size[0] // 2
            v_align = style.uniform_logo_v_align
            if size[1] < center_below * height / 3000:  # Short logo: center in the matte band, else its box
                center = (center[0], int(height * (1 - style.matte_height_ratio / 2)) if style.matte_height_ratio else center[1])
                v_align = "center"
            y = center[1] - box_h // 2 if v_align == "top" else center[1] + box_h // 2 - size[1] if v_align == "bottom" else center[1] - size[1] // 2
            if style.uniform_logo_shadow_enabled and style.uniform_logo_shadow_opacity:
                self.logo_shadow(canvas, logo, x, y)
            canvas.paste(logo, (x, y), logo)
        if style.text_overlay_enabled and style.custom_text:
            item = item or {}
            number = item.get("season")
            season = item.get("season_title") or ("Specials" if number == 0 else f"Season {number}" if number is not None else "")
            text = style.custom_text
            for placeholder, value in (("title", item.get("title", "")), ("title_lines", "\n".join(str(item.get("title", "")).split())),
                                       ("year", item.get("year", "")),
                                       ("season", season), ("season_number", "" if number is None else number)):
                text = text.replace("{" + placeholder + "}", str(value))
            if style.text_transform == "uppercase":
                text = text.upper()
            elif style.text_transform == "lowercase":
                text = text.lower()
            # Match the app's letter_spacing: spaces inserted between characters.
            lines = [(" " * style.letter_spacing).join(line) for line in text.splitlines()]
            draw = ImageDraw.Draw(canvas)
            boxes = [draw.textbbox((0, 0), line, font=self.font) for line in lines]
            gap = round(style.font_size * width / 2000 * style.text_line_spacing)
            total = sum(box[3] - box[1] for box in boxes) + gap * max(0, len(lines) - 1)
            y = int(height * style.position_y - total / 2)
            rows = []
            for line, box in zip(lines, boxes):
                if box[2] - box[0] > width * 0.9:
                    raise ValueError("Text exceeds the canvas width; reduce font_size or letter_spacing, or add a newline")
                rows.append((int(width * style.position_x - (box[2] - box[0]) / 2) - box[0], y - box[1], line))
                y += box[3] - box[1] + gap
            self.text_effects(canvas, rows)
            for x, top, line in rows:
                draw.text((x, top), line, font=self.font, fill=style.text_color)
        self.paste_badges(canvas, badges)
        if style.border_enabled and style.border_px:
            border, radius = max(1, round(style.border_px * width / 2000)), round(style.border_radius * width / 2000)
            if radius:  # The border color shows in the rounded-off corners; the poster itself stays rectangular
                framed = Image.new("RGB", (width + 2 * border, height + 2 * border), style.border_color)
                framed.paste(canvas, (border, border), rounded_mask(width, height, radius))
                canvas = framed
            else:
                canvas = ImageOps.expand(canvas, border=border, fill=style.border_color)
        return canvas


def split_title(text, width, count):
    """TitleCardMaker's bottom-heavy split: lines of about `width` characters, at most `count` of them."""
    if " " not in text or count <= 1 or len(text) <= width:
        return [text]
    lines = [text]
    for _ in range(count + 1):
        top, bottom = "", lines.pop()
        while " " in bottom and (len(bottom) > width or 1 <= len(top) <= 5):
            for char in TITLE_SPLIT_CHARACTERS:
                if f"{char} " in bottom[:min(width, len(bottom) // 2)]:
                    head, bottom = bottom.split(f"{char} ", 1)
                    top = f"{top} {head}{char}"
                    break
            else:
                head, bottom = bottom.split(" ", 1)
                top = f"{top} {head}".strip()
        lines += [bottom, top]
    lines = [line for line in (line.strip() for line in lines[::-1]) if line]
    if len(lines) > count:
        lines[-2:] = [f"{lines[-2]} {lines[-1]}"]
    return lines


def logo_colors(logo, minimum=0):
    """TitleColorMatch: the logo's most common usable color, and a stroke color that contrasts with it.

    Colors darker than `minimum` (perceived brightness, 0-255) are skipped, like near-black and near-white ones."""
    small = logo.convert("RGBA").resize((100, 100), Image.Resampling.BOX)
    pixels = np.asarray(small).reshape(-1, 4)
    pixels = pixels[pixels[:, 3] >= 75, :3]
    if len(pixels):
        palette = Image.fromarray(pixels.reshape(1, -1, 3)).quantize(16, dither=Image.Dither.NONE)
        table = palette.getpalette()
        for _, index in sorted(palette.getcolors(), reverse=True):
            red, green, blue = table[index * 3:index * 3 + 3]
            luminance = red * 0.299 + green * 0.587 + blue * 0.114
            if min(red, green, blue) > 240 or max(red, green, blue) < 15 or luminance < minimum:
                continue
            return f"#{red:02x}{green:02x}{blue:02x}", "black" if luminance > 50 else "white"
    return CARD_DEFAULT_COLOR, "black"


def spaced_glyphs(font, text, spacing, space=None):
    """(character, x offset) pairs and the total width; `spacing` is added per character like ImageMagick's
    -kerning, and `space` replaces the width of a space like -interword-spacing."""
    x, glyphs = 0.0, []
    for index, char in enumerate(text):
        glyphs.append((char, x))
        if char == " " and space is not None:
            x += space + spacing
        else:
            pair = text[index:index + 2]
            x += font.getlength(pair) - font.getlength(pair[1:]) + spacing
    return glyphs, x


def draw_spaced(draw, x, baseline, glyphs, font, fill, stroke=0, stroke_fill=None):
    if isinstance(glyphs, str):  # A whole line of the custom text, drawn from its top left
        draw.text((x, baseline), glyphs, font=font, fill=fill, stroke_width=stroke, stroke_fill=stroke_fill)
        return
    for char, offset in glyphs:
        if char != " ":
            draw.text((x + offset, baseline), char, font=font, fill=fill, anchor="ls",
                      stroke_width=stroke, stroke_fill=stroke_fill)


def transform_text(text, mode):
    return text.upper() if mode == "uppercase" else text.lower() if mode == "lowercase" else text


def logo_shadow(canvas, logo, x, y, k, opacity, angle, distance, size, spread, color):
    """Drop shadow behind the logo about to be pasted at (x, y): Simposter's (the logo's alpha, blurred by `size`, scaled
    by `opacity`, offset by `distance` away from the light's `angle`), with `spread` growing the shape before the blur so
    thin logos still cast a shadow. `k` turns the settings' pixels into the canvas's. Laid on in floating point and
    dithered, so a soft shadow can't band."""
    blur = size * k
    angle = math.radians(angle)
    dx = round(-distance * k * math.cos(angle))
    dy = round(distance * k * math.sin(angle))
    grow = round(spread / 100 * blur)
    pad = int(blur * 3) + grow + max(abs(dx), abs(dy)) + 2  # Room for the blur to fade out
    mask = Image.new("L", (logo.width + 2 * pad, logo.height + 2 * pad), 0)
    mask.paste(logo.getchannel("A"), (pad, pad))
    if grow:
        mask = grow_mask(mask, grow)
    if blur:
        mask = mask.filter(ImageFilter.GaussianBlur(blur))
    left, top = x - pad + dx, y - pad + dy
    box = (max(0, left), max(0, top), min(canvas.width, left + mask.width), min(canvas.height, top + mask.height))
    if box[0] >= box[2] or box[1] >= box[3]:
        return
    alpha = np.asarray(mask.crop((box[0] - left, box[1] - top, box[2] - left, box[3] - top)), dtype=np.float32)
    alpha *= opacity / 25500  # 0-255 mask, percent opacity
    color = np.array(ImageColor.getrgb(color), dtype=np.float32)
    noise = dither_noise(*canvas.size)[box[1]:box[3], box[0]:box[2]]
    canvas.paste(dither_shade(np.asarray(canvas.crop(box), dtype=np.float32), 1 - alpha, alpha[..., None] * color, noise), box[:2])


def text_shadow(canvas, shapes, blur, strength, offset, color=(0, 0, 0)):
    """Darken the canvas softly around text: blur the glyph shapes and lay that over as `color` (black by default).

    `shapes` are (x, baseline, glyphs, font, stroke) rows. Only the area around the text is blurred."""
    mask = Image.new("L", canvas.size, 0)
    draw = ImageDraw.Draw(mask)
    for x, y, glyphs, font, stroke in shapes:
        draw_spaced(draw, x, y + offset, glyphs, font, 255, stroke, 255)
    box = mask.getbbox()
    if not box:
        return
    pad = int(blur * 3) + 1
    box = (max(0, box[0] - pad), max(0, box[1] - pad), min(canvas.width, box[2] + pad), min(canvas.height, box[3] + pad))
    # Thin text spreads out thin when blurred, so thicken the shapes first to keep the halo solid enough.
    region = mask.crop(box).filter(ImageFilter.MaxFilter(3)).filter(ImageFilter.GaussianBlur(blur))
    gain = min(255, 255 * strength * 1.6)
    canvas.paste(color, box, region.point(lambda value: min(255, round(value * gain / 255))))


def text_stroke(canvas, shapes, opacity):
    """Outline text under its fill. `shapes` are (x, baseline, glyphs, font, width, color) rows; the outline is laid
    on at `opacity`, so below 1 the picture shows through it slightly."""
    for color in {shape[5] for shape in shapes}:
        mask = Image.new("L", canvas.size, 0)
        draw = ImageDraw.Draw(mask)
        for x, y, glyphs, font, width, shape_color in shapes:
            if width and shape_color == color:
                draw_spaced(draw, x, y, glyphs, font, 255, width, 255)
        box = mask.getbbox()
        if box:
            canvas.paste(color, box, mask.crop(box).point(lambda value: round(value * opacity)))


class CardRenderer:
    """Episode title card: still, left gradient, logo (at the top left unless moved), title and season/episode at the bottom left."""

    def __init__(self, style, base=Path(".")):
        self.style, self.base, self.scale = style, base, style.width / CARD_WIDTH
        self.title_font = self.load_font(style.title_font_file, style.title_font_size)
        self.season_font = self.load_font(style.season_font_file, style.index_font_size)
        self.episode_font = self.load_font(style.episode_font_file, style.index_font_size)
        self.shade = None
        if style.card_gradient == "radial":
            width, height = style.width, style.height
            x = (np.arange(width, dtype=np.float32) / width - style.gradient_center_x) / style.gradient_radius_x
            y = (np.arange(height, dtype=np.float32) / height - style.gradient_center_y) / style.gradient_radius_y
            distance = np.sqrt(x[None, :] ** 2 + y[:, None] ** 2)
            self.shade = 1 - style.gradient_strength * (1 - np.exp(-distance ** style.gradient_softness))
            if style.gradient_corner_strength:
                # 0 at the center, ~0.7 at the middle of each edge, 1 in the corners; the 6th power keeps edges nearly clear.
                corner = np.sqrt(((np.arange(width, dtype=np.float32) / width - 0.5) ** 2 * 2)[None, :]
                                 + ((np.arange(height, dtype=np.float32) / height - 0.5) ** 2 * 2)[:, None])
                self.shade *= 1 - style.gradient_corner_strength * np.minimum(corner, 1) ** 6

    def load_font(self, path, size):
        size = max(1, size * self.scale)
        if not path:
            return ImageFont.load_default(size=size)
        try:
            return ImageFont.truetype(str(local_path(path, self.base)), size)
        except OSError:
            raise ValueError(f"Cannot open font file {local_path(path, self.base)}") from None

    def render(self, background, logo=None, stock=False, item=None):
        style, scale, item = self.style, self.scale, item or {}
        width, height = style.width, style.height
        margin = round(CARD_MARGIN * scale)
        canvas = cover(background, width, height)
        if self.shade is not None:
            canvas = dither_shade(np.asarray(canvas.convert("RGB"), dtype=np.float32), self.shade).convert("RGBA")
        canvas = canvas.convert("RGB")
        if style.logo_mode == "none":
            logo = None
        if logo is not None:
            logo = logo.convert("RGBA")
            box = logo.getchannel("A").getbbox()
            if box and style.card_logo_trim:
                logo = logo.crop(box)
            max_w, max_h = style.uniform_logo_max_w * scale, style.uniform_logo_max_h * scale
            ratio = min(max_w / logo.width, max_h / logo.height)
            logo = logo.resize((max(1, int(logo.width * ratio)), max(1, int(logo.height * ratio))), Image.Resampling.LANCZOS)
            # The logo's box slides between the margins (the default is against the top left one) and the logo sits in it by its alignment
            box_w, box_h = int(max_w), int(max_h)
            left = margin + round(style.card_logo_offset_x * max(0, width - 2 * margin - box_w))
            top = margin + round(style.card_logo_offset_y * max(0, height - 2 * margin - box_h))
            x = {"left": left, "right": left + box_w - logo.width}.get(style.card_logo_h_align, left + (box_w - logo.width) // 2)
            y = {"top": top, "bottom": top + box_h - logo.height}.get(style.card_logo_v_align, top + (box_h - logo.height) // 2)
            if style.card_logo_shadow_enabled and style.card_logo_shadow_opacity:
                logo_shadow(canvas, logo, x, y, scale, style.card_logo_shadow_opacity, style.card_logo_shadow_angle, style.card_logo_shadow_distance,
                            style.card_logo_shadow_size, style.card_logo_shadow_spread, style.card_logo_shadow_color)
            canvas.paste(logo, (x, y), logo)
        draw = ImageDraw.Draw(canvas)

        title = transform_text(str(item.get("episode_title") or ""), style.text_transform)
        title_rows, title_stroke = [], round(style.title_stroke_width * scale / 2)
        stroke_color = "black"
        if title:
            title_color, stroke_color = (logo_colors(logo, style.title_min_brightness) if logo is not None else (CARD_DEFAULT_COLOR, "black"))                 if style.title_color == "auto" else (style.title_color, "black")
            if style.title_stroke_color != "auto":
                stroke_color = style.title_stroke_color
            replacements = {"―": "-", "…": "..."}
            if style.title_font_file and "sequel" in Path(style.title_font_file).stem.lower():
                replacements.update({"[": "(", "]": ")", "(": "[", ")": "]"})  # Sequel Neue draws these swapped
            lines = split_title(title.translate(str.maketrans(replacements)), style.title_max_line_width, style.title_max_lines)
            font = self.title_font
            ascent, descent = font.getmetrics()
            baseline = height - style.title_bottom * scale - descent
            title_rows = [(round(style.title_x * scale), baseline - number * (ascent + descent + style.title_line_spacing * scale),
                           spaced_glyphs(font, line, style.title_letter_spacing * scale, CARD_TITLE_SPACE * scale)[0], font)
                          for number, line in enumerate(reversed(lines))]

        def label(template):
            text = template.replace("{season_number}", str(item.get("season", ""))).replace("{episode_number}", str(item.get("episode", "")))
            return transform_text(text, style.text_transform).strip()
        season, episode = label(style.season_text), label(style.episode_text)
        x, entries = float(round(style.index_x * scale)), []
        for text, font in ((f"{season} •" if season else "", self.season_font), (episode, self.episode_font)):
            if text:
                glyphs, advance = spaced_glyphs(font, text, style.index_letter_spacing * scale)
                entries.append((x, height - round(style.index_bottom * scale) - font.getmetrics()[1], glyphs, font))
                x += advance + style.index_gap * scale
        index_stroke = round(style.index_stroke_width * scale / 2)

        if style.shadow_strength:
            text_shadow(canvas, [(x, y, glyphs, font, title_stroke) for x, y, glyphs, font in title_rows]
                        + [(x, y, glyphs, font, index_stroke) for x, y, glyphs, font in entries],
                        style.shadow_blur * scale, style.shadow_strength, round(style.shadow_offset_y * scale), ImageColor.getrgb(style.shadow_color))
        if style.stroke_opacity:  # As RGB, so a title and index outline of the same color are laid on in one pass
            text_stroke(canvas, [(x, y, glyphs, font, title_stroke, ImageColor.getrgb(stroke_color)) for x, y, glyphs, font in title_rows]
                        + [(x, y, glyphs, font, index_stroke, ImageColor.getrgb(style.index_stroke_color)) for x, y, glyphs, font in entries],
                        style.stroke_opacity)
        for x, y, glyphs, font in title_rows:
            draw_spaced(draw, x, y, glyphs, font, title_color)
        for x, y, glyphs, font in entries:
            draw_spaced(draw, x, y, glyphs, font, style.index_color)
        return canvas


CHART_LOGOS = "https://raw.githubusercontent.com/Kometa-Team/Default-Images/master/chart/logos/"


def streaming_background(color, width=1000, height=1500, radius=1.25, strength=0.55, corner=0.4):
    """A streaming collection poster's background: the service's color glowing at the center and falling off toward the
    edges, darkest in the bottom-left corner and only partly darkened in the others. `radius` is how far the glow reaches,
    `strength` how much the edges darken and `corner` the extra darkening toward the bottom left. Darkened in float with a
    little dither so the fade doesn't band."""
    base = np.array([int(color[index:index + 2], 16) for index in (1, 3, 5)], dtype=np.float32)
    x, y = np.arange(width, dtype=np.float32) / width, np.arange(height, dtype=np.float32) / height  # 0..1, y down
    t = np.clip(np.sqrt((x[None, :] - 0.5) ** 2 + (y[:, None] - 0.5) ** 2) * 2 / radius, 0, 1)
    nearness = np.clip(1 - np.sqrt(x[None, :] ** 2 + (1 - y[:, None]) ** 2) / math.sqrt(2), 0, 1) ** 2  # 1 at bottom left
    shade = 1 - (strength + corner * nearness) * t * t * (3 - 2 * t)
    return dither_shade(np.broadcast_to(base, (height, width, 3)).copy(), shade).convert("RGBA")


HOLIDAY_COLORS = (("halloween", "#9b430c"), ("thanksgiving", "#865025"), ("christmas", "#17633c"),
                  ("valentine", "#92264c"), ("easter", "#66518c"), ("new year", "#8a5a10"))


def default_background_color(item, style):
    """The color a collection's generated background glows in unless one is chosen for it: the service's, the chart
    color, or for a custom or curated collection a holiday's when its title names one, else the chart color."""
    if item.get("service"):
        return dict(style.streaming_colors).get(item["service"]) or next(color for name, _, _, color in STREAMING if name == item["service"])
    title = str(item.get("title") or "").casefold()
    return next((color for name, color in HOLIDAY_COLORS if not item.get("chart") and name in title), style.chart_color)


def generated_background(item, style, color=None):
    """A collection's generated background, in `color`, else the one chosen for it, else its default."""
    return streaming_background(color or item.get("background_color") or default_background_color(item, style),
                                radius=style.collection_gradient_radius, strength=style.collection_gradient_strength,
                                corner=style.collection_gradient_corner)


def visible_pixels(image):
    """A logo's visible pixels (alpha over 64) as float32 RGB rows, read from a copy at most 256px on a side."""
    small = image.convert("RGBA")
    small.thumbnail((256, 256), Image.Resampling.LANCZOS)
    pixels = np.asarray(small)
    return pixels[:, :, :3][pixels[:, :, 3] > 64].astype(np.float32)


def logo_luminance(image, visible=None):
    """Average perceived brightness (0-255) of a logo's visible pixels; black text scores near 0."""
    visible = visible_pixels(image) if visible is None else visible
    return float((visible @ np.array([0.299, 0.587, 0.114], dtype=np.float32)).mean()) if len(visible) else 0.0


def tmdb_rows(images, kind):
    """Entries for one kind of TMDb image (posters, logos, backdrops)."""
    return [{"url": IMAGE_BASE + art["file_path"], "thumb": "https://image.tmdb.org/t/p/w300" + art["file_path"],
             "language": art.get("iso_639_1"), "has_text": bool(art.get("iso_639_1")),
             "width": art.get("width") or 0, "height": art.get("height") or 0}
            for art in images.get(kind, []) if art.get("file_path")]


def fanart_rows(data, *names):
    """Entries for Fanart.tv's image lists of these names, in order."""
    return [{"url": art["url"], "language": art.get("lang"), "has_text": art.get("lang") not in (None, "", "00"),
             "width": art.get("width") or 0} for name in names for art in data.get(name, []) if art.get("url")]


def tvdb_rows(artwork, types, kind):
    """Entries for the TVDB artwork whose type name contains `kind` (poster, clearlogo, background)."""
    ids = {int(t["id"]) for t in types if kind in re.sub(r"[^a-z]", "", str(t.get("name", "")).lower())}
    return [{"url": art["image"], "thumb": art.get("thumbnail") or art["image"], "language": art.get("language"),
             "has_text": art.get("includesText", bool(art.get("language"))), "width": art.get("width") or 0,
             "height": art.get("height") or 0}
            for art in artwork if art.get("image") and int(art.get("type") or 0) in ids]


class Artwork(Metadata):
    """Picks each title's artwork (posters, logos, backdrops) from Plex, TMDb, Fanart.tv and TVDB for a layout."""

    def __init__(self, http, config, base):
        super().__init__(http, config, base)
        self.logo_lock, self.logo_locks, self.show_logos = threading.Lock(), {}, {}

    def generated_poster(self, item, style, label, bundled, remote, fallback=None):
        """Poster inputs for a collection Overlayrr draws itself: a logo (a logo file in the collection's folder, else
        the bundled file under resources/, else the first of `remote` that downloads) over its generated background
        (unless a poster file is in the folder)."""
        item["_stock_poster"] = False
        background = self.http.image(item["poster"], self.base) if item.get("poster") else generated_background(item, style)
        if item.get("logo"):
            return background, self.http.image(item["logo"], self.base), False
        path = local_path(style.resource_dir, self.base) / bundled if bundled else None
        if path and path.is_file():
            return background, self.http.image(str(path), self.base), False
        for url in remote:
            try:
                return background, self.http.image(url, self.base), False
            except RuntimeError:
                continue
        if fallback is not None:
            return background, fallback(), False
        raise ValueError(f"No logo found for {label}; put a logo.png in its folder under assets/collections/ or {bundled} in resources/")

    def select_streaming(self, item, style):
        service = item["service"]
        # The image set files a few names in lowercase (tubi)
        remote = [f"{STREAMING_LOGOS}{quote(name)}.png" for name in dict.fromkeys((service, service.lower()))]
        return self.generated_poster(item, style, service, f"streaming/{service}.png", remote)

    def select_chart(self, item, style):
        return self.generated_poster(item, style, item["chart"], "charts/Plex.png", [CHART_LOGOS + "Plex.png"])

    def select_custom(self, item, style):
        title = item["title"]
        def title_logo():
            # The title as a logo, a word per line at poster size, so it is one logo among the ones that can be picked
            text = "\n".join(title.upper().split())
            path = local_path(style.font_file, self.base) if style.font_file else local_path(style.resource_dir, self.base) / "fonts/Poppins/Poppins-Regular.ttf"
            font = ImageFont.truetype(str(path), 300) if path.is_file() else ImageFont.load_default(size=300)
            options = {"font": font, "spacing": 75, "align": "center", "stroke_width": 10}
            bounds = ImageDraw.Draw(Image.new("RGBA", (1, 1))).multiline_textbbox((0, 0), text, **options)
            canvas = Image.new("RGBA", (max(1, math.ceil(bounds[2] - bounds[0])) + 4, max(1, math.ceil(bounds[3] - bounds[1])) + 4))
            ImageDraw.Draw(canvas).multiline_text((2 - bounds[0], 2 - bounds[1]), text, fill="white", stroke_fill="black", **options)
            return canvas
        return self.generated_poster(item, style, title, None, [], title_logo)

    def resolve_collection(self, item):
        """Plex collections carry no TMDb ID. Use the TMDb collection most of the first members belong to, else an
        exact title match; a wrong franchise is worse than none, so curated collections ("Christmas") stay unresolved."""
        if item.get("tmdb_id") or not self.keys.get("tmdb_key") or not item.get("rating_key"):
            return
        children = self.plex.xml(f"/library/metadata/{item['rating_key']}/children", {"includeGuids": 1})
        members = [plex_item(e).get("tmdb_id") for e in children.findall("Video")]
        votes = {}
        sampled = [member for member in members if member][:5]
        for member in sampled:
            collection = (self.tmdb(f"/movie/{member}").get("belongs_to_collection") or {}).get("id")
            if collection:
                votes[collection] = votes.get(collection, 0) + 1
        best = max(votes, key=votes.get, default=None)
        if best is not None and votes[best] * 2 > len(sampled):
            item["tmdb_id"] = best
            return
        def normalize(name):
            return re.sub(r"\s+collection$", "", str(name or "").strip().casefold())
        target = normalize(item.get("title"))
        for result in self.tmdb("/search/collection", query=item.get("title", "")).get("results", []):
            if target and normalize(result.get("name")) == target:
                item["tmdb_id"] = result["id"]
                return

    def tmdb_episode(self, item):
        """TMDb lists a whole season per request (cached), so every episode of it shares one call."""
        if not item.get("tmdb_id") or not self.keys.get("tmdb_key"):
            return {}
        data = self.tmdb(f"/tv/{item['tmdb_id']}/season/{item['season']}", language=self.language)
        entry = next((e for e in data.get("episodes", []) if e.get("episode_number") == item["episode"]), {})
        return {"title": entry.get("name"), "still": entry.get("still_path") and IMAGE_BASE + entry["still_path"]}

    def tvdb_episode(self, item):
        if not self.keys.get("tvdb_key") or not item.get("tvdb_id"):
            return {}
        data = (self.tvdb(f"/series/{item['tvdb_id']}/episodes/default?season={item['season']}&page=0").get("data") or {})
        entry = next((e for e in data.get("episodes", []) if e.get("seasonNumber") == item["season"] and e.get("number") == item["episode"]), {})
        image = entry.get("image") or ""
        if image and not image.startswith("http"):
            image = "https://artworks.thetvdb.com" + image
        return {"title": entry.get("name"), "still": image}

    def show_logo(self, item, style):
        """The show's logo URL, chosen once and shared by all of its episodes in this run."""
        show = {key: value for key, value in item.items() if key not in ("season", "episode", "season_title", "episode_title")}
        key = (show.get("parent_rating_key"), show.get("tmdb_id"), show.get("tvdb_id"), show.get("title"))
        with self.logo_lock:  # One lock per show, so one show's lookup doesn't hold up every other show's episodes
            lock = self.logo_locks.setdefault(key, threading.Lock())
        with lock:
            if key not in self.show_logos:
                chosen, white = None, False
                for fetch in (self.tmdb_art, self.fanart_art, self.tvdb_art):
                    try:
                        candidate, candidate_white = self.pick_logo(fetch(show)[1], style.logo_preference, style.logo_min_brightness)
                        if candidate and (chosen is None or candidate_white):
                            chosen, white = candidate, candidate_white
                    except (OSError, ValueError, KeyError, RuntimeError) as error:
                        print(f"WARN {show.get('title', '?')}: {fetch.__name__}: {error}", file=sys.stderr)
                    if white:
                        break
                self.show_logos[key] = chosen["url"] if chosen else None
            return self.show_logos[key]

    def tmdb_details(self, item):
        def stale(data):
            upcoming = to_date((data.get("next_episode_to_air") or {}).get("air_date"))
            return upcoming is not None and upcoming < date.today()
        return self.tmdb(f"/{item['type']}/{item['tmdb_id']}", stale=stale if item["type"] == "tv" else None,
                         append_to_response="images,external_ids", include_image_language=f"{self.language},en,null")

    def show_details(self, item):
        """TMDb status facts, with TVDB filling missing episodes or verifying a disputed ended/canceled status."""
        data = self.tmdb_details(item)
        upcoming = data.get("next_episode_to_air") or {}
        day = to_date(upcoming.get("air_date"))
        today = date.today()
        ended = data.get("status") in ("Ended", "Canceled")
        if not ended and day and day >= today and (upcoming.get("season_number") or 0) > 0 and (upcoming.get("episode_number") or 0) > 0:
            return data
        tvdb_id = item.get("tvdb_id") or (data.get("external_ids") or {}).get("tvdb_id")
        if not tvdb_id or not self.keys.get("tvdb_key") or data.get("status") not in ("Returning Series", "Planned", "In Production", "Ended", "Canceled"):
            return data

        def stale(reply):
            day = to_date((reply.get("data") or {}).get("nextAired"))
            return day is not None and day < today

        try:
            series = self.tvdb(f"/series/{tvdb_id}/nextAired", stale=stale).get("data") or {}
            if ended and (series.get("status") or {}).get("name") != "Continuing":
                return data
            day = to_date(series.get("nextAired"))
            if day is None or day < today:
                return data
            reply = self.tvdb(f"/series/{tvdb_id}/episodes/default?airDate={day.isoformat()}&page=0")
            episodes = [e for e in (reply.get("data") or {}).get("episodes") or []
                        if to_date(e.get("aired")) == day and (e.get("seasonNumber") or 0) > 0 and (e.get("number") or 0) > 0]
            if episodes:
                episode = min(episodes, key=lambda e: (e["seasonNumber"], e["number"]))
                upcoming = {"air_date": day.isoformat(), "season_number": episode["seasonNumber"], "episode_number": episode["number"],
                            "episode_type": "finale" if episode.get("finaleType") in ("season", "series") else "standard"}
                return {**data, "status": "Returning Series" if ended else data.get("status"), "next_episode_to_air": upcoming}
        except (OSError, ValueError, RuntimeError) as error:
            print(f"WARN {item.get('title', '?')}: TVDB next episode: {error}", file=sys.stderr)
        return data

    def show_status(self, item):
        """Kometa's status overlays from TMDb, with TVDB as the upcoming-episode fallback."""
        self.identify(item)
        if not item.get("tmdb_id") or not self.keys.get("tmdb_key"):
            return None
        data = self.show_details(item)
        status, today = data.get("status"), date.today()
        if status == "Canceled":
            return "canceled"
        if status == "Ended":
            return "ended"
        if status not in ("Returning Series", "Planned", "In Production"):
            return None
        first = data.get("first_air_date") or ""
        upcoming = (data.get("next_episode_to_air") or {}).get("air_date") or ""
        if (today - timedelta(days=90)).isoformat() <= first <= today.isoformat():
            return "new"
        # TMDb's "on the air" list is shows with an episode in the next 7 days.
        if today.isoformat() <= upcoming <= (today + timedelta(days=7)).isoformat():
            return "airing"
        return "returning"

    def show_banner(self, item, style):
        """The status banner of a show (banner_pick's answer, by the layout's status_banners), or None without a TMDb key and ID."""
        self.identify(item)
        if not item.get("tmdb_id") or not self.keys.get("tmdb_key"):
            return None
        added = (item.get("media") or {}).get("added")
        return banner_pick(self.show_details(item), date.fromtimestamp(added) if added else None, date.today(), banner_settings(style.status_banners))

    def show_streaming(self, item, style):
        """The service whose logo goes on a show's poster, as streaming_logo_source picks it (one of STREAMING), or None."""
        self.identify(item)
        if not item.get("tmdb_id") or not self.keys.get("tmdb_key"):
            return None
        data = self.tmdb(f"/tv/{item['tmdb_id']}", append_to_response="watch/providers")
        region = option(self.config.get("plex", {}), "collection_region")
        modes = ("originals", "available") if style.streaming_logo_source == "any" else (style.streaming_logo_source,)
        return next((found[0] for found in (streaming_services(data, mode, region) for mode in modes) if found), None)

    def badge_facts(self, item, style):
        """Fill item['media'] with what the enabled badges need beyond the Plex listing."""
        if not style.badges or item.get("season") is not None:
            return
        try:
            if "media" not in item and item.get("rating_key") and self.plex.url:
                item["media"] = self.plex.get_item(item["rating_key"])["media"]
            media = item.setdefault("media", {})
            if item["type"] == "tv":
                if "resolution" in style.badges and item.get("rating_key") and self.plex.url:
                    media["resolution"] = self.plex.show_resolution(item["rating_key"])
                if "status" in style.badges:
                    media["status"] = self.show_status(item)
                if "status_banner" in style.badges:
                    media["banner"] = self.show_banner(item, style)
                if "streaming" in style.badges:
                    media["streaming"] = self.show_streaming(item, style)
        except (ValueError, RuntimeError, ET.ParseError) as error:
            print(f"WARN {item.get('title', item.get('rating_key', '?'))}: badge data: {error}", file=sys.stderr)

    def tmdb_images(self, item):
        """TMDb's images of the item, filling in its title, year and other IDs on the way; None without a key or ID."""
        if not item.get("tmdb_id") or not self.keys.get("tmdb_key"):
            return None
        if item["type"] == "collection":  # Posters and backdrops only; TMDb collections have no logos
            return self.tmdb(f"/collection/{item['tmdb_id']}/images", include_image_language=f"{self.language},en,null")
        data = self.tmdb_details(item)
        item.setdefault("title", data.get("title") or data.get("name") or str(item["tmdb_id"]))
        item.setdefault("year", (data.get("release_date") or data.get("first_air_date") or "")[:4])
        for field in ("tvdb_id", "imdb_id"):
            value = (data.get("external_ids") or {}).get(field)
            if value:
                item.setdefault(field, value)
        return data.get("images") or {}

    def tmdb_art(self, item):
        images = self.tmdb_images(item)
        if images is None:
            return [], []
        posters = tmdb_rows(images, "posters")
        if item.get("season") is not None:
            try:
                seasonal = self.tmdb(f"/tv/{item['tmdb_id']}/season/{item['season']}/images",
                                     include_image_language=f"{self.language},en,null")
                posters = tmdb_rows(seasonal, "posters") + posters
            except (ValueError, RuntimeError) as error:
                print(f"WARN {item.get('title', '?')}: TMDb season artwork: {error}", file=sys.stderr)
        return posters, tmdb_rows(images, "logos")

    def tmdb_backdrops(self, item):
        images = self.tmdb_images(item)
        return [] if images is None else tmdb_rows(images, "backdrops")

    def fanart_data(self, item):
        """Fanart.tv's listing for the item, or None without a key or an ID."""
        # Fanart files franchise logos under the TMDb collection ID in its movies namespace.
        lookup = (item.get("tmdb_id") or item.get("imdb_id")) if item["type"] != "tv" else item.get("tvdb_id")
        if not lookup or not (self.keys.get("fanart_key") or self.keys.get("fanart_client_key")):
            return None
        headers = {}
        if self.keys.get("fanart_key"):
            headers["api-key"] = self.keys["fanart_key"]
        if self.keys.get("fanart_client_key"):
            headers["client-key"] = self.keys["fanart_client_key"]
        category = "tv" if item["type"] == "tv" else "movies"
        data = self.http.json(f"{FANART}/{category}/{lookup}", headers=headers)
        item.setdefault("title", data.get("name") or str(lookup))
        return data

    def fanart_art(self, item):
        data = self.fanart_data(item)
        if data is None:
            return [], []
        if item["type"] != "tv":
            return fanart_rows(data, "movieposter"), fanart_rows(data, "hdmovielogo", "movielogo", "clearlogo")
        posters = fanart_rows(data, "tvposter")
        if item.get("season") is not None:
            seasonal = {"seasonposter": [art for art in data.get("seasonposter", []) if str(art.get("season")) == str(item["season"])]}
            posters = fanart_rows(seasonal, "seasonposter") + posters
        return posters, fanart_rows(data, "hdtvlogo", "clearlogo")

    def fanart_backdrops(self, item):
        data = self.fanart_data(item)
        return [] if data is None else fanart_rows(data, "showbackground" if item["type"] == "tv" else "moviebackground")

    def tvdb_record(self, item):
        """(TVDB's extended record of the item, TVDB's artwork types), looking the TVDB ID up by IMDb ID if needed;
        None without a key or an ID."""
        if not self.keys.get("tvdb_key"):
            return None
        if not item.get("tvdb_id") and item.get("imdb_id"):
            results = self.tvdb(f"/search/remoteid/{item['imdb_id']}").get("data") or []
            kind = "movie" if item["type"] == "movie" else "series"
            matches = [result[kind] for result in results if result.get(kind)]
            if len(matches) == 1:
                item["tvdb_id"] = matches[0]["id"]
        if not item.get("tvdb_id"):
            return None
        category = "movies" if item["type"] == "movie" else "series"
        data = self.tvdb(f"/{category}/{item['tvdb_id']}/extended").get("data") or {}
        item.setdefault("title", data.get("name") or str(item["tvdb_id"]))
        item.setdefault("year", (data.get("firstAired") or "")[:4])
        # TVDB separates movie and series artwork type IDs. Resolve from its schema.
        return data, self.tvdb("/artwork/types").get("data") or []

    def tvdb_art(self, item):
        record = self.tvdb_record(item)
        if record is None:
            return [], []
        data, types = record
        artwork = data.get("artworks") or []
        if item.get("season") is not None:
            matches = [s for s in data.get("seasons", []) if s.get("number") == item["season"]]
            official = [s for s in matches if "official" in str((s.get("type") or {}).get("type", "")).lower()
                        or "official" in str((s.get("type") or {}).get("name", "")).lower()]
            matches = official or matches
            if len(matches) == 1:
                try:
                    seasonal = self.tvdb(f"/seasons/{matches[0]['id']}/extended").get("data") or {}
                    artwork = (seasonal.get("artwork") or []) + artwork
                except (ValueError, RuntimeError) as error:
                    print(f"WARN {item.get('title', '?')}: TVDB season artwork: {error}", file=sys.stderr)
        return tvdb_rows(artwork, types, "poster"), tvdb_rows(artwork, types, "clearlogo")

    def tvdb_backdrops(self, item):
        record = self.tvdb_record(item)
        return [] if record is None else tvdb_rows(record[0].get("artworks") or [], record[1], "background")

    def plex_art(self, item):
        """Posters Plex itself lists for the item, as candidates; no logos."""
        return self.plex.photos(item.get("rating_key"), "posters"), []

    def found_backdrops(self, item):
        """Wide backdrops from every provider as (provider, art) rows, to be cropped into posters; no image is downloaded."""
        self.resolve_ids(item)
        parent = item.get("parent_rating_key") or item.get("rating_key")  # A season has none of its own
        found, errors, seen = [], [], set()
        for name, fetch in (("tmdb", lambda: self.tmdb_backdrops(item)), ("fanart", lambda: self.fanart_backdrops(item)),
                            ("tvdb", lambda: self.tvdb_backdrops(item)), ("plex", lambda: self.plex.photos(parent, "arts"))):
            try:
                rows = fetch()
            except (OSError, ValueError, KeyError, RuntimeError, ET.ParseError) as error:
                print(f"WARN {item.get('title', item.get('rating_key', '?'))}: {name} backdrops: {error}", file=sys.stderr)
                errors.append(f"{name}: {error}")
                continue
            found += [(name, art) for art in rows if art["url"] not in seen and not seen.add(art["url"])]
        return {"backdrops": found, "errors": errors}

    def language_rank(self, art):
        language = art.get("language")
        alias = {"en": "eng", "fr": "fra", "de": "deu", "es": "spa", "it": "ita", "pt": "por", "ja": "jpn", "ko": "kor", "zh": "zho", "ru": "rus"}.get(self.language, self.language)
        return 0 if language in (self.language, alias) else 1 if language in ("en", "eng") else 2 if language in (None, "", "00") else 3

    def logo_stats(self, art):
        """(perceived brightness, saturation, peak brightness) of a logo's visible pixels; None if unreadable or blank."""
        try:
            image = self.http.image(art.get("thumb") or art["url"], self.base)
            if not image.getchannel("A").getbbox():
                return None
            rgb = visible_pixels(image)
            if not len(rgb):
                return None
            maximum, lowest = rgb.max(axis=1), rgb.min(axis=1)
            saturation = np.divide(maximum - lowest, maximum, out=np.zeros_like(maximum), where=maximum > 0).mean()
            return logo_luminance(image, rgb), float(saturation), float(maximum.mean())
        except (OSError, ValueError, RuntimeError):
            return None

    @staticmethod
    def logo_score(preference, saturation, brightness):
        """Score for a logo that fits the preference (higher is better), or None when it doesn't.

        white: bright and unsaturated. color: clearly colored, nothing more; every colored logo ties, so the one
        ranked highest (language, then size) wins instead of the most saturated.
        """
        if preference == "color":
            return 1.0 if saturation >= COLOR_MIN_SATURATION else None
        if preference == "white":
            return brightness / 255 * 0.7 + (1 - saturation) * 0.3 if saturation <= 0.25 and brightness >= 60 else None
        return 0.0

    def found_art(self, item):
        """Every poster and logo the providers list for the item as (provider, art) rows; no image is downloaded."""
        self.resolve_ids(item)
        found = {"posters": [], "logos": [], "errors": []}
        for name, fetch in (("tmdb", self.tmdb_art), ("fanart", self.fanart_art), ("tvdb", self.tvdb_art), ("plex", self.plex_art)):
            try:
                new_posters, new_logos = fetch(item)
            except (OSError, ValueError, KeyError, RuntimeError, ET.ParseError) as error:
                print(f"WARN {item.get('title', item.get('rating_key', '?'))}: {fetch.__name__}: {error}", file=sys.stderr)
                found["errors"].append(f"{name}: {error}")
                continue
            found["posters"] += [(name, art) for art in new_posters]
            found["logos"] += [(name, art) for art in new_logos]
        seen = set()  # Plex lists the same TMDb/TVDB images its agents found
        found["posters"] = [row for row in found["posters"] if not (row[1]["url"] in seen or seen.add(row[1]["url"]))]
        return found

    def alternates(self, item, style, posters, icons):
        """Ranked extra artwork for one item as (kind, provider, art) rows; `posters`/`icons` are a count or "all".

        Follows the layout's rules: poster_filter for posters; raster logos with real transparency for
        icons, and under logo_preference "white" or "color" only the white or colored ones when any exist.
        """
        found = self.found_art(item)
        rows = []
        if posters:
            # Plex's posters aren't labeled with or without text (has_text None), so only "all" includes them.
            wanted = [row for row in found["posters"] if style.poster_filter == "all"
                      or (row[1]["has_text"] is not None and row[1]["has_text"] == (style.poster_filter == "text"))]
            if found["posters"] and not wanted:
                print(f"NOTE {item.get('title', '?')}: {len(found['posters'])} posters found, but none are {style.poster_filter}; "
                      "use --poster-filter all to see them", flush=True)
            wanted.sort(key=lambda row: (self.language_rank(row[1]), -int(row[1].get("width") or 0)))
            rows += [("posters", name, art) for name, art in (wanted if posters == "all" else wanted[:posters])]
        if icons and item.get("season") is None:  # Seasons share their show's logos
            logos = [row for row in found["logos"] if not urlparse(row[1]["url"]).path.lower().endswith(".svg") and self.language_rank(row[1]) < 3]
            stats = self.parallel(lambda row: self.logo_stats(row[1]), logos)
            floor = style.logo_min_brightness or (COLOR_MIN_BRIGHTNESS if style.logo_preference == "color" else 0)
            usable = [(row, self.logo_score(style.logo_preference, stat[1], stat[2])) for row, stat in zip(logos, stats)
                      if stat is not None and stat[0] >= floor]
            if any(score is not None for _, score in usable):  # Only the ones that fit, when any do
                usable = [pair for pair in usable if pair[1] is not None]
            else:
                usable = [(row, 0) for row, _ in usable]
            usable.sort(key=lambda pair: (self.language_rank(pair[0][1]), -pair[1], -int(pair[0][1].get("width") or 0)))
            rows += [("logos", name, art) for (name, art), _ in (usable if icons == "all" else usable[:icons])]
        return rows

    def pick_logo(self, logos, preference="white", minimum=0):
        # Examine at most six raster logos, preferring the requested language.
        language_rank = self.language_rank
        # Fanart and TVDB return every language; a logo in a language that isn't yours or English is never used.
        logos = sorted([art for art in logos if not urlparse(art["url"]).path.lower().endswith(".svg") and language_rank(art) < 3],
                       key=lambda art: (language_rank(art), -int(art.get("width") or 0)))[:6]
        if preference == "any":
            for art in logos:
                try:
                    image = self.http.image(art.get("thumb") or art["url"], self.base)
                    if image.getchannel("A").getbbox() and not (minimum and logo_luminance(image) < minimum):
                        return art, True
                except (OSError, ValueError, RuntimeError):
                    continue
            return None, False
        floor = minimum or (COLOR_MIN_BRIGHTNESS if preference == "color" else 0)
        def analyze(art):
            stats = self.logo_stats(art)
            if stats is None or stats[0] < floor:
                return None
            score = self.logo_score(preference, stats[1], stats[2])
            return art, None if score is None else score - language_rank(art) * 0.2
        results = self.parallel(analyze, logos)
        best, best_score, first = None, -math.inf, None
        for result in results:
            if result is None:
                continue
            art, score = result
            if first is None:
                first = art
            if score is not None and score > best_score:
                best, best_score = art, score
        return best or first, best is not None

    def resolve_ids(self, item):
        try:
            if item["type"] == "collection":
                return self.resolve_collection(item)
            if item.get("rating_key") and not any(item.get(field) for field in ("tmdb_id", "tvdb_id", "imdb_id")):
                lookup_key = item.get("parent_rating_key") or item["rating_key"]
                root = self.plex.xml(f"/library/metadata/{lookup_key}", {"includeGuids": 1})
                entry = root.find("Video") if item["type"] == "movie" else root.find("Directory")
                if entry is not None:
                    for field, value in plex_item(entry).items():
                        if value and not item.get(field):
                            item[field] = value
            self.identify(item)
        except (ValueError, RuntimeError, ET.ParseError) as error:
            print(f"WARN {item.get('title', '?')}: ID lookup: {error}", file=sys.stderr)

    def select_episode(self, item, style, show_style=None):
        """An episode card needs the episode's still and its show's logo (chosen with the series' layout settings).
        Returns (still, logo, stock=False)."""
        item["_stock_poster"] = False
        manual_poster, manual_logo = item.get("poster"), item.get("logo")
        want_logo = style.logo_mode != "none"
        if not (manual_poster and (manual_logo or not want_logo) and item.get("episode_title")):
            self.resolve_ids(item)
        still, logo = manual_poster, manual_logo if want_logo else None
        if not still or not item.get("episode_title"):
            for lookup in (self.tmdb_episode, self.tvdb_episode):
                try:
                    found = lookup(item)
                except (ValueError, KeyError, RuntimeError) as error:
                    print(f"WARN {item.get('title', '?')}: {lookup.__name__}: {error}", file=sys.stderr)
                    continue
                if not item.get("episode_title") and found.get("title"):
                    item["episode_title"] = found["title"]
                still = still or found.get("still")
                if still and item.get("episode_title"):
                    break
        background = None
        if still:
            background = self.http.image(still, self.base)
        elif item.get("thumb") and self.plex.url and option(self.config, "missing_art") != "skip":
            # No provider still: fall back to Plex's own episode image, unless it is already one of our cards.
            try:
                background = self.http.image(self.plex.url + item["thumb"], self.base, self.plex.headers)
                if Image.open(io.BytesIO(background.info["source_bytes"])).getexif().get(OVERLAY_EXIF_TAG) == OVERLAY_EXIF_VALUE:
                    background = None
            except (OSError, ValueError, RuntimeError) as error:
                print(f"WARN {item.get('title', '?')}: Plex episode image: {error}", file=sys.stderr)
        if background is None:
            return None, None, True
        if want_logo and not logo:
            logo = self.show_logo(item, show_style or style)
            if not logo and option(self.config, "missing_art") == "skip":
                return None, None, True
        return background, self.http.image(logo, self.base) if logo else None, False

    def wanted_poster(self, poster, style):
        """Fits the layout's poster_filter. A poster in another language never does, even when flagged textless."""
        return self.language_rank(poster) < 3 and (style.poster_filter == "all" or poster["has_text"] == (style.poster_filter == "text"))

    def provider_art(self, item, style, manual_poster, own_logo):
        """(posters, chosen logo) from TMDb, then Fanart.tv, then TVDB, stopping once there is a wanted poster (or a
        manual one) and, if the item picks its own logo, one that fits the logo preference."""
        posters, chosen_logo, white = [], None, False
        for fetch in (self.tmdb_art, self.fanart_art, self.tvdb_art):
            try:
                new_posters, logos = fetch(item)
                posters.extend(new_posters)
                if own_logo and not white:
                    candidate, candidate_white = self.pick_logo(logos, style.logo_preference, style.logo_min_brightness)
                    if candidate and (chosen_logo is None or candidate_white):
                        chosen_logo, white = candidate, candidate_white
                if (manual_poster or any(self.wanted_poster(p, style) for p in posters)) and (not own_logo or white):
                    break
            except (OSError, ValueError, KeyError, RuntimeError) as error:
                print(f"WARN {item.get('title', item.get('rating_key', '?'))}: {fetch.__name__}: {error}", file=sys.stderr)
        return posters, chosen_logo

    def backdrop_poster(self, item):
        """The best textless backdrop to crop into the poster when no provider poster fits the layout (TMDb's first, then
        Fanart.tv's, then TVDB's; the widest of the first provider that has one), or None."""
        for fetch in (self.tmdb_backdrops, self.fanart_backdrops, self.tvdb_backdrops):
            try:
                found = [art for art in fetch(item) if art.get("has_text") is not True and self.language_rank(art) < 3
                         and not urlparse(art["url"]).path.lower().endswith(".svg")]
            except (OSError, ValueError, KeyError, RuntimeError) as error:
                print(f"WARN {item.get('title', item.get('rating_key', '?'))}: {fetch.__name__}: {error}", file=sys.stderr)
                continue
            if found:
                return max(found, key=lambda art: int(art.get("width") or 0))
        return None

    def select(self, item, style=None, saved_stock=False, show_style=None):
        style = style or Style()
        if item.get("episode") is not None:
            return self.select_episode(item, style, show_style)
        if item.get("service"):
            return self.select_streaming(item, style)
        if item.get("chart"):
            return self.select_chart(item, style)
        if item.get("custom") or custom_collection(item, self.config):
            return self.select_custom(item, style)
        item["_stock_poster"] = saved_stock
        if saved_stock and option(self.config, "missing_art") == "skip":
            return None, None, True
        # Fully specified local overrides work without any credentials/network.
        manual_poster, manual_logo = item.get("poster"), item.get("logo")
        if manual_poster and (manual_logo or style.logo_mode == "none"):
            return self.http.image(manual_poster, self.base), self.http.image(manual_logo, self.base) if style.logo_mode != "none" else None, saved_stock
        season = item.get("season") is not None
        own_logo = style.logo_mode != "none" and not manual_logo and not season  # Seasons use their series' logo
        self.resolve_ids(item)
        # A manual poster with no logo to pick needs no provider at all.
        posters, chosen_logo = ([], None) if manual_poster and not own_logo else self.provider_art(item, style, manual_poster, own_logo)
        if season and style.logo_mode != "none" and not manual_logo:
            logo_url = self.show_logo(item, show_style or style)
            chosen_logo = {"url": logo_url} if logo_url else None
        poster = next((p for p in posters if self.wanted_poster(p, style)), None)
        if (poster is None and not manual_poster and style.poster_filter != "text"
                and (style.logo_mode == "none" or manual_logo or chosen_logo)):
            # Nothing fits the layout's filter (commonly: no textless poster exists): crop a textless backdrop into the poster
            # rather than settle for a stock one. Without a logo the title is stock anyway, so it keeps a real poster.
            poster = self.backdrop_poster(item)
        item["_stock_poster"] = saved_stock or (not manual_poster and poster is None)
        stock = saved_stock or not (manual_poster or poster) or (style.logo_mode != "none" and not (manual_logo or chosen_logo))
        if stock and option(self.config, "missing_art") == "skip":
            return None, None, True
        if stock and not manual_poster:
            usable = [p for p in posters if self.language_rank(p) < 3]
            poster = next((p for p in usable if p["has_text"]), None) or (usable[0] if usable else None)
        background_source = manual_poster or (poster and poster["url"])
        headers = None
        # A collection's Plex poster is an auto-made collage; uploading a copy would freeze it, so skip instead.
        if not background_source and item.get("thumb") and self.plex.url and item["type"] != "collection":
            background_source = self.plex.url + item["thumb"]
            headers = self.plex.headers
        if not background_source:
            if item["type"] == "collection":
                # No TMDb collection (a curated one, "What Should I Watch?"): drawn like a custom collection, its title over a
                # gradient, unless missing art is skipped. A poster of your own in its folder replaces it.
                if option(self.config, "missing_art") != "skip" and item.get("title"):
                    return self.select_custom(item, style)
                return None, None, True
            raise ValueError("No poster found; provide a local poster override or a provider ID")
        background = self.http.image(background_source, self.base, headers)
        logo = None
        if style.logo_mode != "none" and (manual_logo or chosen_logo):
            logo = self.http.image(manual_logo or chosen_logo["url"], self.base)
        return background, logo, stock


def layout_styles(config):
    layouts = config.get("layouts")
    if not isinstance(layouts, dict) or not layouts:
        raise ValueError("Define at least one named layout in layouts")
    allowed = {field.name for field in fields(Style)}
    styles = {}
    for name, options in layouts.items():
        if not isinstance(name, str) or not name.strip() or not isinstance(options, dict):
            raise ValueError("Each layout needs a nonempty name and a mapping of settings")
        options = dict(options)
        season = options.pop("season_options", {})
        episode = options.pop("episode_options", None)
        if not isinstance(season, dict) or not (episode is None or isinstance(episode, dict)):
            raise ValueError(f"layouts.{name}.season_options and episode_options must be mappings")
        for kind, extra in (("season_options", season), ("episode_options", episode or {})):
            clash = {"logo_preference", "logo_min_brightness"} & set(extra)
            if clash:
                raise ValueError(f"layouts.{name}.{kind}: {', '.join(sorted(clash))} must be set on the layout itself; "
                                 "seasons and episodes always use their series' logo")
        unknown = (set(options) | set(season) | set(episode or {})) - allowed
        if unknown:
            raise ValueError(f"Unknown settings in layout {name}: {', '.join(sorted(map(str, unknown)))}")
        styles[name, False] = Style(**options)
        styles[name, True] = Style(**{**options, **season})
        if episode is not None:
            styles[name, "episode"] = Style(**{**options, **episode})
    default = config.get("default_layout")
    if default is not None and (not isinstance(default, str) or default not in layouts):
        raise ValueError("default_layout must name a layout defined in layouts")
    choices = config.get("layout_by_type", {})
    if not isinstance(choices, dict) or set(choices) - {"movie", "tv", "collection", "streaming", "chart", "custom"}:
        raise ValueError("layout_by_type must map movie, tv, collection, streaming, chart and/or custom to a layout name")
    if any(not isinstance(name, str) or name not in layouts for name in choices.values()):
        raise ValueError("layout_by_type references an undefined layout")
    libraries = config.get("layout_by_library", {})
    if not isinstance(libraries, dict) or any(not isinstance(name, str) or name not in layouts for name in libraries.values()):
        raise ValueError("layout_by_library must map Plex library names or IDs to defined layouts")
    return styles


def item_layout(item, config, styles):
    by_library = {str(library): name for library, name in config.get("layout_by_library", {}).items()}
    by_type = config.get("layout_by_type", {})
    fallback = by_library.get(str(item.get("library")), by_type.get(item["type"], config.get("default_layout")))
    kind = ("chart" if item.get("chart") else "streaming" if item.get("service") else "custom" if item.get("custom") else "collection") if item["type"] == "collection" else None
    if kind == "custom":
        fallback = by_type.get("collection", fallback)
    if kind in by_type:
        fallback = by_type[kind]  # Collections live in a movie/TV library; don't let its layout win
    name = item.get("layout", fallback)
    episode = item.get("episode") is not None
    key = (name, "episode" if episode else item.get("season") is not None)
    if not isinstance(name, str) or key not in styles:
        if episode and (name, False) in styles:
            raise ValueError(f"Layout {name!r} needs episode_options to render episodes")
        raise ValueError(f"Undefined layout for item: {name!r}")
    return key


def read_config(path):
    """The shared config checks, plus this engine's layouts."""
    config = read_shared_config(path)
    layout_styles(config)
    return config


def prepare_items(artwork, config, selected=None, include_seasons=None, include_episodes=None):
    plex = config.get("plex", {})
    if selected is None:
        collections = artwork.plex.poster_collections() if plex.get("include_collections") else []
        items = artwork.plex.scan() + collections + [dict(item) for item in config.get("items", [])]
    else:
        items = [dict(item) for item in selected]
    overrides = {str(key): value for key, value in config.get("overrides", {}).items()}
    # Apply show overrides before expanding seasons, so corrected IDs and layout
    # choices are inherited. Poster overrides belong to the individual season.
    for item in items:
        override = overrides.get(str(item.get("rating_key", "")), {})
        if not isinstance(override, dict):
            raise ValueError("Each override must be a mapping")
        item.update(override)
    expand_seasons = plex.get("include_seasons") if include_seasons is None else include_seasons
    expand_episodes = plex.get("include_episodes") if include_episodes is None else include_episodes
    shows = [item for item in items if item.get("type") == "tv" and item.get("season") is None and str(item.get("rating_key", "")).isdigit()]
    listings = [listing for listing, wanted in ((artwork.plex.seasons, expand_seasons), (artwork.plex.episodes, expand_episodes)) if wanted]
    if shows and listings:
        # One Plex request (or a few pages) per show, so ask for several shows at once; results keep the show order.
        with ThreadPoolExecutor(max_workers=6) as pool:
            for listing in listings:
                items.extend(child for children in pool.map(listing, shows) for child in children)
    styles = layout_styles(config)
    seen = set()
    for index, item in enumerate(items):
        key = str(item.get("rating_key", ""))
        override = overrides.get(key, {})
        if not isinstance(override, dict):
            raise ValueError(f"Override {key} must be a mapping")
        item.update(override)
        allowed = {"type", "rating_key", "parent_rating_key", "season", "season_title", "episode", "episode_title", "title", "year", "thumb", "tmdb_id", "tvdb_id", "imdb_id", "poster", "logo", "output", "layout", "library", "media", "smart", "service", "chart", "custom", "genres"}
        unknown = set(item) - allowed
        if unknown:
            raise ValueError(f"Unknown item/override keys: {', '.join(sorted(map(str, unknown)))}")
        item.setdefault("type", "movie")
        if custom_collection(item, config):
            item["custom"] = True
        if item["type"] not in ("movie", "tv", "collection"):
            raise ValueError("Item type must be movie, tv or collection")
        if item.get("season") is not None and (item["type"] != "tv" or type(item["season"]) is not int or item["season"] < 0):
            raise ValueError("season must be a nonnegative integer on a tv item")
        if item.get("episode") is not None and (item.get("season") is None or type(item["episode"]) is not int or item["episode"] < 0):
            raise ValueError("episode must be a nonnegative integer on a tv season item")
        for field in ("tmdb_id", "tvdb_id"):
            if item.get(field) is not None and (type(item[field]) is not int or item[field] <= 0):
                raise ValueError(f"{field} must be a positive integer")
        if item.get("rating_key") is not None and not str(item["rating_key"]).isdigit():
            raise ValueError("rating_key must be a numeric Plex ID")
        if item.get("parent_rating_key") is not None and not str(item["parent_rating_key"]).isdigit():
            raise ValueError("parent_rating_key must be a numeric Plex ID")
        identifier = f"plex-{item['rating_key']}" if item.get("rating_key") else f"{item['type']}-tmdb-{item['tmdb_id']}" if item.get("tmdb_id") else f"{item['type']}-tvdb-{item['tvdb_id']}" if item.get("tvdb_id") else f"item-{index + 1}"
        if item.get("season") is not None and not item.get("rating_key"):
            identifier += f"-season-{item['season']}" + (f"-episode-{item['episode']}" if item.get("episode") is not None else "")
        name = item.get("output") or "rendered.jpg"
        if not isinstance(name, str) or re.search(r'[<>:"/\\|?*\x00-\x1f]', name) or name.endswith((" ", ".")):
            raise ValueError("Output must be a filename inside the media folder, without directories")
        output = Path(name)
        if output.suffix.lower() not in (".jpg", ".jpeg", ".png"):
            raise ValueError("Output must be .jpg, .jpeg or .png")
        if output.stem.lower() in ("poster", "logo"):
            raise ValueError("An output would overwrite an input poster/logo; use rendered.jpg or another filename")
        item["output_name"] = name
        aliases = ArtworkFiles.aliases(item) or [ArtworkFiles.local_alias(item)]
        destinations = {(item["type"], alias, item.get("season"), item.get("episode"), name.casefold()) for alias in aliases}
        if seen & destinations:
            raise ValueError(f"Duplicate output for the same media: {name}; use a separate output filename")
        seen.update(destinations)
        item["identifier"] = identifier
        item["layout_key"] = item_layout(item, config, styles)
        if plex.get("upload") and not item.get("rating_key"):
            raise ValueError("All items need rating_key when plex.upload is true")
    return items


def render_signature(item, style, config, base, server=None, legacy=False):
    """Hash editable files and the recipe; timestamps alone can miss replacements.

    `server` is the Plex server's own ID (plex_server_id), so reaching the same server by another address isn't a
    change. `legacy` gives the signature as recorded before that, when plex.url stood in for the server."""
    inputs = {}
    for name in ("poster", "logo"):
        value = item.get(name)
        if not value or (name == "logo" and style.logo_mode == "none"):
            inputs[name] = None
            continue
        if is_url(value):
            return None
        path = local_path(value, base)
        if not path.is_file():
            return None
        inputs[name] = file_digest(path)
    if not inputs["poster"]:
        return None
    if style.font_file and style.text_overlay_enabled:
        inputs["font"] = file_digest(local_path(style.font_file, base))
    # Only settings that can change this image are hashed, so editing an unrelated one doesn't rebuild and re-upload it.
    recipe_style = asdict(style)
    del recipe_style["logo_min_brightness"]  # Only picks which logo file is fetched; the file itself is hashed
    episode = item.get("episode") is not None
    if episode:
        for name, path in (("title_font", style.title_font_file), ("season_font", style.season_font_file),
                           ("episode_font", style.episode_font_file)):
            if path:
                inputs[name] = file_digest(local_path(path, base))
    else:
        for name in CARD_FIELDS:  # Title card settings; posters don't use them
            del recipe_style[name]
    layers = badge_layers(item, style, base)
    if style.badges:
        # Art, text and position of every badge.
        inputs["badges"] = [[layer["h"], layer["v"], layer["x"], layer["y"], layer.get("text"),
                             *(file_digest(layer[key]) for key in ("file", "font") if key in layer),
                             *(layer[key] for key in ("label", "kind", "size", "color", "box", "banner", "backdrop", "look", "fill") if key in layer)]
                            for layer in layers]
    else:
        del recipe_style["badges"], recipe_style["resource_dir"]
    for name in BADGE_TEXT_FIELDS:  # Already in each badge's entry above, and unused without badges
        del recipe_style[name]
    has_text = any(layer.get("label") for layer in layers)
    for names, used in ((BADGE_STROKE_FIELDS, style.badge_stroke_width and style.badge_stroke_opacity),
                        (BADGE_SHADOW_FIELDS, style.badge_shadow_strength)):
        if not (has_text and used):  # Nothing drawn on this item, or as recorded before they existed
            for name in names:
                del recipe_style[name]
    shared = (style.badge_gradient_height, style.badge_gradient_strength)
    shared_only = "gradients" in style.badges and all(style.edge_gradient(side) == shared for side in ("top", "bottom"))
    if not shared_only:  # `gradients` at the shared settings is as recorded before each edge had its own
        del recipe_style["badge_gradient_height"], recipe_style["badge_gradient_strength"]
    drawn = gradient_sides(style.badges) if item.get("season") is None else ()  # Seasons and episodes get no badges
    for side in ("top", "bottom"):
        if shared_only or side not in drawn:
            del recipe_style[f"badge_gradient_{side}_height"], recipe_style[f"badge_gradient_{side}_strength"]
    if not (style.border_enabled and style.border_px and style.border_radius):  # Square corners: as recorded before it existed
        del recipe_style["border_radius"]
    if style.plain_matte or episode or not (style.matte_height_ratio or style.fade_height_ratio):  # As recorded before they existed; title cards draw no matte
        for name in ("fade_smoothness", "matte_opacity", "matte_color"):
            del recipe_style[name]
    if not (style.uniform_logo_shadow_enabled and style.uniform_logo_shadow_opacity and inputs["logo"] and not episode):
        for name in LOGO_SHADOW_FIELDS:  # No shadowed logo on this item (or a title card), or as recorded before they existed
            del recipe_style[name]
    elif not style.uniform_logo_shadow_distance:
        del recipe_style["uniform_logo_shadow_angle"]  # No distance, no direction
    if not (style.streaming_logo_shadow_enabled and style.streaming_logo_shadow_opacity and any(layer.get("box") for layer in layers)):
        for name in STREAMING_SHADOW_FIELDS:  # No shadowed streaming logo on this item
            del recipe_style[name]
    elif not style.streaming_logo_shadow_distance:
        del recipe_style["streaming_logo_shadow_angle"]
    art_drawn = any(("file" in layer or "fill" in layer) and "box" not in layer for layer in layers)  # IMAX, codec or score art
    if not (style.badge_art_shadow_enabled and style.badge_art_shadow_opacity and art_drawn):  # No shadowed art on this item
        for name in BADGE_ART_SHADOW_FIELDS:
            del recipe_style[name]
    elif not style.badge_art_shadow_distance:
        del recipe_style["badge_art_shadow_angle"]
    for name in SIGNATURE_ELSEWHERE:  # Their effect is already in the badge entries above or in the saved poster
        del recipe_style[name]

    def keep(used, *names):
        """These stay in the recipe only where they change this item's picture and differ from their default (so the
        signatures recorded before they existed still match)."""
        for name in names:
            if not used or getattr(style, name) == getattr(Style, name):
                del recipe_style[name]
    corner = any(layer["h"] != "fill" and not layer.get("banner") for layer in layers)
    text_drawn = style.text_overlay_enabled and style.custom_text and not episode
    keep(corner, "badge_layout")
    keep(corner and style.badge_layout == "flow", "badge_gap")
    keep(has_text, "badge_fit")
    keep(art_drawn, "badge_art_scale")
    keep(any(layer.get("gradient") for layer in layers), "badge_gradient_color")
    keep(any(layer.get("text") for layer in layers), "audience_score_text_color", "audience_score_font_size")
    keep(style.grain_amount and not episode, "grain_mode", "grain_size")
    keep(style.vignette_strength and not episode, "vignette_mode", "vignette_color")
    keep(style.vignette_strength and style.vignette_mode == "radial" and not episode, "vignette_size", "vignette_falloff")
    keep(not episode, "poster_shift_x")
    keep(inputs["logo"] and not episode, "uniform_logo_trim")
    if episode:  # A card's own settings (posters dropped them with CARD_FIELDS above); at their defaults they match signatures recorded before they existed
        keep(True, *CARD_TEXT_FIELDS)
        keep(style.shadow_strength, "shadow_color")
        keep(inputs["logo"], *CARD_LOGO_FIELDS)
        keep(inputs["logo"] and style.card_logo_shadow_enabled and style.card_logo_shadow_opacity, *CARD_LOGO_SHADOW_FIELDS)
    keep(text_drawn, "position_x", "text_line_spacing")
    keep(text_drawn and style.text_stroke_width and style.text_stroke_opacity, "text_stroke_width", "text_stroke_opacity", "text_stroke_color")
    keep(text_drawn and style.text_shadow_strength, "text_shadow_strength", "text_shadow_blur", "text_shadow_offset_y", "text_shadow_color")
    plex = config.get("plex", {})
    recipe = {"version": 1, "inputs": inputs, "style": recipe_style,
              **({"custom": True} if item.get("custom") else {}),
              "labels": {key: item.get(key) for key in ("title", "year", "season", "season_title") + (("episode", "episode_title") if episode else ())},
              "quality": option(config, "quality"), "missing_art": option(config, "missing_art"),
              "overlay_marker": option(config, "overlay_marker"),
              "upload": plex.get("upload", False), "completion_label": option(plex, "completion_label").strip(),
              "rating_key": item.get("rating_key"), **({"plex_url": plex.get("url")} if legacy else {"plex_server": server})}
    return hashlib.sha256(json.dumps(recipe, sort_keys=True).encode()).hexdigest()


def plex_server_id(plex, cache):
    """Plex's own ID for the server at plex.url, asked once and remembered in the cache folder."""
    known = cache / "plex_servers.json"
    try:
        servers = json.loads(known.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        servers = {}
    if not isinstance(servers, dict):
        servers = {}
    if plex.url not in servers:
        servers[plex.url] = plex.xml("/").get("machineIdentifier") or plex.url
        atomic_write(known, json.dumps(servers, indent=2).encode())
    return servers[plex.url]


def download_alternates(artwork, sources, items, styles, posters, icons, poster_filter=None):
    """--poster/--logo: save extra candidates beside the title's files as poster2, poster3... and logo2, logo3...
    (best first; a rerun overwrites those numbers) without rendering or uploading."""
    failures = 0
    for item in items:
        sources.apply(item)
        name = item.get("title") or item.get("rating_key") or "?"
        try:
            folder = sources.folder(item, create=True)
            saved, numbers = 0, {"posters": 1, "logos": 1}
            style = styles[item["layout_key"]]
            if poster_filter:
                style = replace(style, poster_filter=poster_filter)
            for kind, provider, art in artwork.alternates(item, style, posters, icons):
                try:
                    data = artwork.http.get(art["url"], headers=art.get("headers"), ttl=IMAGE_TTL)
                    with Image.open(io.BytesIO(data)) as image:
                        suffix = IMAGE_SUFFIXES.get(image.format, ".png")
                        image.verify()
                    # Plex also lists Overlayrr's own finished posters; those aren't sources. (verify() must come first.)
                    with Image.open(io.BytesIO(data)) as image:
                        ours = provider == "plex" and image.getexif().get(OVERLAY_EXIF_TAG) == OVERLAY_EXIF_VALUE
                except (OSError, ValueError, RuntimeError, SyntaxError) as error:
                    print(f"WARN {name}: {art['url']}: {error}", file=sys.stderr)
                    continue
                if ours:
                    continue
                numbers[kind] += 1
                stem = f"{kind[:-1]}{numbers[kind]}"
                for old in folder.glob(stem + ".*"):  # Same number, maybe another extension
                    old.unlink()
                atomic_write(folder / (stem + suffix), data)
                saved += 1
                print(f"SAVED {folder / (stem + suffix)}  ({provider}, {art.get('language') or 'no language'}, {art.get('width') or 0}w)", flush=True)
            label = "season " + str(item["season"]) if item.get("season") is not None else "title"
            print(f"{name} ({label}): {saved} saved in {folder}", flush=True)
        except Exception as error:
            failures += 1
            print(f"ERROR {name}: {error}", file=sys.stderr, flush=True)
    return 1 if failures else 0


def import_posters(config_path, source):
    """--import-posters: save the poster URLs of a Kometa/MediUX metadata YAML (TMDb IDs -> url_poster, seasons ->
    url_poster) as poster files in the titles' asset folders, replacing any poster already saved there. Titles that
    aren't in your Plex libraries are skipped. Episode and background URLs are ignored: Overlayrr draws its own cards.
    `source` is a file, or "-" for YAML pasted in at the terminal."""
    config = read_config(config_path)
    if not config.get("plex", {}).get("libraries"):
        raise ValueError("--import-posters matches titles through Plex, so plex.libraries must be set")
    pasted = str(source) == "-"
    if pasted:
        if sys.stdin.isatty():
            print("Paste the YAML here, then press Ctrl+D on a new line (Ctrl+Z then Enter on Windows):", flush=True)
        text = sys.stdin.read()
    else:
        text = source.read_text(encoding="utf-8")
    try:
        data = yaml.safe_load(textwrap.dedent(text))
    except yaml.YAMLError:
        # A copy often loses the first line's leading spaces; give it the indent of the next ID line and try again.
        lines = text.splitlines()
        first = next((i for i, line in enumerate(lines) if line.strip()), 0)
        later = next((len(line) - len(line.lstrip()) for line in lines[first + 1:] if re.match(r"\s*(?:\d+|tt\d+)\s*:", line)), 0)
        if lines:
            lines[first] = " " * later + lines[first].lstrip()
        data = yaml.safe_load(textwrap.dedent("\n".join(lines)))
    entries = data.get("metadata", data) if isinstance(data, dict) else None
    if not isinstance(entries, dict):
        raise ValueError(f"{'The pasted text' if pasted else source} is not a metadata YAML: expected TMDb IDs mapped to url_poster (optionally under metadata:)")
    base = config_path.resolve().parent
    http = HTTP(local_path(option(config, "cache_dir"), base))
    sources = ArtworkFiles(local_path(option(config, "assets_dir"), base))
    by_id = {}
    for item in Plex(http, config).scan():
        for field in ("tmdb_id", "imdb_id"):
            if item.get(field):
                by_id.setdefault((item["type"], str(item[field])), item)
    counts = {"saved": 0, "missing": 0, "failed": 0, "episodes": 0}

    def save(folder, url, label):
        try:
            if not is_url(url):
                raise ValueError("not a web address")
            image = http.image(url, base)
            folder.mkdir(parents=True, exist_ok=True)
            existing = sources.source(folder, "poster")
            if existing:
                existing.unlink()
            sources.save_image(folder, "poster", image)
            counts["saved"] += 1
            print(f"IMPORT {label}", flush=True)
        except (OSError, ValueError, RuntimeError) as error:
            counts["failed"] += 1
            print(f"ERROR {label}: {error}", file=sys.stderr, flush=True)

    for key, entry in entries.items():
        if not isinstance(entry, dict):
            continue
        key = str(key).strip()
        seasons = {number: season for number, season in (entry.get("seasons") or {}).items() if isinstance(season, dict)}
        counts["episodes"] += sum(len((season.get("episodes") or {})) for season in seasons.values())
        wanted = bool(entry.get("url_poster")) or any(season.get("url_poster") for season in seasons.values())
        if not wanted:
            continue
        kinds = ("tv",) if seasons else ("movie", "tv")
        item = next((by_id[kind, key] for kind in kinds if (kind, key) in by_id), None)
        if item is None:
            counts["missing"] += 1
            print(f"SKIP {key}: not in your Plex libraries")
            continue
        folder = sources.folder(item, create=True)
        title = f"{item.get('title', key)} ({item['year']})" if item.get("year") else item.get("title", key)
        if entry.get("url_poster"):
            save(folder, entry["url_poster"], title)
        for number, season in seasons.items():
            if season.get("url_poster"):
                save(folder / f"Season {int(number):02d}", season["url_poster"], f"{title} season {number}")
    print(f"Imported {counts['saved']} posters; {counts['missing']} not in your Plex libraries, {counts['failed']} failed."
          + (f" Ignored {counts['episodes']} episode entries (Overlayrr draws its own title cards)." if counts["episodes"] else ""))
    if counts["saved"]:
        print("Nothing was rendered or uploaded. Run overlayrr.py with --changed-only to build them.")
    return 1 if counts["failed"] else 0


def check_run_options(*, refresh, changed_only, limit, rating_key, title, media_type, year, force,
                      with_seasons, with_episodes, season, episode, posters, icons, added, poster_filter):
    """Refuse option combinations that make no sense, before anything is read or fetched."""
    if poster_filter and not posters:
        raise ValueError("--poster-filter goes with --poster")
    targeted = rating_key is not None or title is not None
    if added:
        if not targeted:
            raise ValueError("--added requires --item or --title")
        if refresh or force or changed_only or posters or icons or with_seasons or with_episodes:
            raise ValueError("--added picks what to build by itself; don't combine it with --refresh, --remake, --changed-only, --poster, --logo, --with-seasons or --with-episodes")
    if rating_key is not None and title is not None:
        raise ValueError("Choose --item or --title, not both")
    if not targeted and (with_seasons or with_episodes or media_type is not None or year is not None):
        raise ValueError("--with-seasons, --with-episodes, --type and --year require --item or --title")
    if refresh and changed_only:
        raise ValueError("--refresh re-sends everything selected to Plex, so it can't be combined with --changed-only")
    if (season is not None or episode is not None) and not (with_episodes or added):
        raise ValueError("--season and --episode require --with-episodes")
    if episode is not None and season is None and added:
        raise ValueError("--episode needs --season")
    for flag, value in (("--poster", posters), ("--logo", icons)):
        if value is not None and value != "all" and (type(value) is not int or value < 1):
            raise ValueError(f"{flag} must be a positive number or 'all'")
    if (posters or icons) and not targeted:
        raise ValueError("--poster and --logo require --item or --title")
    if targeted and limit is not None:
        raise ValueError("--limit cannot be combined with --item or --title")
    if rating_key is not None and (not str(rating_key).isdigit() or int(rating_key) < 1):
        raise ValueError("--item must be a positive Plex item ID")
    if title is not None and not title.strip():
        raise ValueError("--title must be a nonempty exact title")
    if media_type is not None and media_type not in ("movie", "show", "collection"):
        raise ValueError("--type must be movie, show or collection")
    if year is not None and (type(year) is not int or not 1000 <= year <= 9999):
        raise ValueError("--year must be a four-digit release year")


class Batch:
    """A run's rendering. For each item: reuse or pick its artwork, render it, save it, upload it, and record what was
    made so --changed-only can skip it next time. process() runs on several workers at once."""

    def __init__(self, artwork, sources, config, base, inputs, *, force, changed_only, refresh, refetch, upload, added=False):
        self.artwork, self.http, self.sources, self.config, self.base = artwork, artwork.http, sources, config, base
        self.inputs, self.styles = inputs, layout_styles(config)
        self.force, self.changed_only = force, changed_only
        self.refresh, self.refetch, self.upload, self.added = refresh, refetch, upload, added
        self.server = None  # Plex's ID for the server (plex_server_id); set before an uploading run processes anything
        self.outputs, self.output_lock = {}, threading.Lock()
        self.renderers, self.renderer_lock = {}, threading.Lock()

    def destination(self, item, folder):
        output = (folder / item["output_name"]).resolve()
        if output in self.inputs:
            raise ValueError("An output would overwrite an input poster/logo")
        with self.output_lock:
            if output in self.outputs and self.outputs[output] is not item:
                raise ValueError(f"Duplicate output: {output}; use a separate output filename")
            self.outputs[output] = item
        item["output_path"] = output
        return output

    def record(self, output):
        """Where the change record of one output is kept."""
        return self.http.cache / "renders" / hashlib.sha256(str(output).encode()).hexdigest()

    def delivered(self, item):
        """Whether the item's existing output has already reached Plex (always, in a run that doesn't upload). Movies,
        shows and seasons carry the completion label once uploaded. Episodes carry none, so the record of their last
        finished upload stands in for it, as it does when labels are switched off."""
        if not self.upload:
            return True
        if item.get("episode") is None and option(self.artwork.plex.settings, "completion_label").strip():
            return self.artwork.plex.labelled(item)
        return self.record(item["output_path"]).is_file()

    def recorded(self, item, style, state, signature):
        """The output's change record, brought up to date if it was made when plex.url stood in for the server."""
        recorded = state.read_text() if state.is_file() else None
        if signature and recorded and recorded != signature and recorded == render_signature(item, style, self.config, self.base, legacy=True):
            atomic_write(state, signature.encode())  # Nothing changed, only how the record is made
            return signature
        return recorded

    def renderer(self, item, style):
        with self.renderer_lock:
            if item["layout_key"] not in self.renderers:
                self.renderers[item["layout_key"]] = (CardRenderer if item.get("episode") is not None else Renderer)(style, self.base)
            return self.renderers[item["layout_key"]]

    def encode(self, image, png):
        options = {"compress_level": 3} if png else {"quality": option(self.config, "quality"), "subsampling": 0}
        if option(self.config, "overlay_marker"):
            exif = Image.Exif()
            exif[OVERLAY_EXIF_TAG] = OVERLAY_EXIF_VALUE
            exif[SOFTWARE_EXIF_TAG] = SOFTWARE_EXIF_VALUE
            options["exif"] = exif
        buffer = io.BytesIO()
        image.save(buffer, format="PNG" if png else "JPEG", **options)
        return buffer.getvalue()

    def persisted(self, image, path):
        """The image already decoded, unless the file saved for it holds other bytes."""
        data = image is not None and image.info.get("source_bytes")
        return image if data and local_path(path, self.base).read_bytes() == data else self.http.image(path, self.base)

    def better_than_stock(self, item, style):
        """What a saved stock poster can be replaced with now, as Artwork.select returns it, or None while a new pick would
        still be stock. The saved stock poster is deleted when it can be replaced, so the new one is saved in its place."""
        saved = item.pop("poster", None)
        selection = None
        try:
            if saved:
                selection = self.artwork.select(item, style, False, self.styles[item["layout_key"][0], False])
        except (OSError, ValueError, RuntimeError) as error:
            print(f"WARN {item.get('title', '?')}: looking for a better poster than the stock one: {error}", file=sys.stderr)
        if selection is None or selection[0] is None or selection[2]:
            item["poster"] = saved
            return None
        local_path(saved, self.base).unlink(missing_ok=True)
        return selection

    def send_logo(self, item):
        """plex.upload_logo: a movie's or series' saved logo also becomes its clear logo in Plex. A failure only warns."""
        logo = item.get("logo")
        if (not option(self.artwork.plex.settings, "upload_logo") or item["type"] not in ("movie", "tv") or item.get("season") is not None
                or not logo or is_url(logo) or item.get("no_logo")):
            return
        try:
            path = local_path(logo, self.base)
            kind = Image.registered_extensions().get(path.suffix.lower(), "PNG")
            self.artwork.plex.upload_logo(item, path.read_bytes(), Image.MIME.get(kind, "image/png"))
        except Exception as error:  # Best effort: the poster is already in Plex
            print(f"WARN {item.get('title', '?')}: uploading its logo to Plex: {error}", file=sys.stderr)

    def process(self, item):
        artwork, sources, config, base =self.artwork, self.sources, self.config, self.base
        output = item["output_path"]
        resend = self.refresh
        if self.added and output.exists():
            if self.delivered(item):
                return "EXISTS", output
            resend = True  # --added: a poster on disk that Plex never got (a failed upload, a re-added title) is sent, not trusted
        style = self.styles[item["layout_key"]]
        if self.refetch:
            sources.discard(item, self.inputs)
        saved_stock = sources.apply(item)
        if item.get("no_logo"):  # "No logo" on the series: its poster, seasons and episode cards are all made as if the layout drew none
            style = replace(style, logo_mode="none")
        artwork.badge_facts(item, style)
        state = self.record(output)
        signature = render_signature(item, style, config, base, self.server)
        current = bool(signature and output.is_file() and self.recorded(item, style, state, signature) == signature)
        selection = None
        if not self.force and self.changed_only and current:
            if saved_stock:
                # Made as a stock poster: look again, and rebuild only if a poster that fits has turned up by now.
                selection = self.better_than_stock(item, style)
                if selection is None:
                    return "UNCHANGED", output
            elif style.logo_mode == "none" or item.get("logo"):
                return "UNCHANGED", output
            else:
                # Made without a logo for want of one: look again, and rebuild only if one has turned up.
                selection = artwork.select(item, style, saved_stock, self.styles[item["layout_key"][0], False])
                if selection[1] is None:
                    return "UNCHANGED", output
        if resend and not self.force and current:
            # --refresh (or --added, for a poster Plex doesn't have): send the finished file to Plex again without rendering it.
            is_episode = item.get("episode") is not None
            state.unlink(missing_ok=True)  # Not a success record until the server confirms
            artwork.plex.upload(item, output.read_bytes(), "image/png" if output.suffix.lower() == ".png" else "image/jpeg")
            self.send_logo(item)
            label = None if is_episode else artwork.plex.mark_uploaded(item, saved_stock or (style.logo_mode != "none" and not item.get("logo")))
            atomic_write(state, signature.encode())
            return "RELOAD" + (f" [Plex: {label}]" if label else ""), output
        if item["output_path"] in {local_path(item[field], base) for field in ("poster", "logo")
                                    if item.get(field) and not is_url(item[field])}:
            raise ValueError("An output would overwrite an input poster/logo")
        background, logo, stock = selection or artwork.select(item, style, saved_stock, self.styles[item["layout_key"][0], False])
        if background is None:
            if item["type"] == "collection" and not item.get("tmdb_id"):
                # A curated collection with no TMDb franchise while missing art is skipped: not missing artwork either. Its
                # folder is still made, so a poster can be chosen for it.
                sources.keep(item)
                return "LEFT (no TMDb collection; choose a poster for it in Artwork to include it)", output
            return "SKIP", output
        folder = sources.save(item, background, logo, stock)
        output = self.destination(item, folder)
        state = self.record(output)
        # Render the persisted files, including inputs saved by another worker
        # for this same title. The output and its change record must agree.
        saved_stock = sources.apply(item)
        background = self.persisted(background, item["poster"])
        logo = self.persisted(logo, item["logo"]) if item.get("logo") and style.logo_mode != "none" else None
        is_episode = item.get("episode") is not None  # Title cards have no stock fallback: a missing logo just isn't drawn.
        stock = not is_episode and (saved_stock or (style.logo_mode != "none" and logo is None))
        png = output.suffix.lower() == ".png"
        payload = self.encode(self.renderer(item, style).render(background, logo, stock, item), png)
        atomic_write(output, payload)
        label = None
        if self.upload:
            # A forced resend can fail even with previously unchanged inputs.
            # Invalidate its old success record before any server mutation.
            state.unlink(missing_ok=True)
            artwork.plex.upload(item, payload, "image/png" if png else "image/jpeg")
            self.send_logo(item)
            if not is_episode:  # Episodes carry no completion label; --changed-only tracks them locally.
                label = artwork.plex.mark_uploaded(item, stock)
        # Of the files this render used (as the apply() above found them), so a later change to either is noticed.
        signature = render_signature(item, style, config, base, self.server)
        if signature:
            # Mark success only after upload and verified server label updates.
            atomic_write(state, signature.encode())
        status = "STOCK" if stock else f"LAYOUT {item['layout_key'][0]}"
        if label:
            status += f" [Plex: {label}]"
        return status, output

    def run(self, items):
        """Process every item on the configured number of workers; returns (failures, items missing artwork)."""
        failures = skips = 0
        with ThreadPoolExecutor(max_workers=option(self.config, "workers")) as pool:
            # Movies and series first: their logos are saved before any season or episode needs them.
            for group in ([item for item in items if item.get("season") is None], [item for item in items if item.get("season") is not None]):
                pending = {pool.submit(self.process, item): item for item in group}
                for future in as_completed(pending):
                    try:
                        status, output = future.result()
                        skips += status == "SKIP"
                        print(f"{status} {output}", flush=True)
                    except Exception as error:
                        failures += 1
                        print(f"ERROR {pending[future]['output_path']}: {error}", file=sys.stderr, flush=True)
        return failures, skips


def run(config_path, *, refetch=False, refresh=False, changed_only=False, limit=None,
        rating_key=None, title=None, media_type=None, year=None, force=False, with_seasons=False,
        with_episodes=False, season=None, episode=None, posters=None, icons=None, added=False, poster_filter=None):
    started = time.perf_counter()
    check_run_options(refresh=refresh, changed_only=changed_only, limit=limit, rating_key=rating_key,
                      title=title, media_type=media_type, year=year, force=force, with_seasons=with_seasons,
                      with_episodes=with_episodes, season=season, episode=episode, posters=posters, icons=icons, added=added,
                      poster_filter=poster_filter)
    targeted = rating_key is not None or title is not None
    config = read_config(config_path)
    base = config_path.resolve().parent
    http = HTTP(local_path(option(config, "cache_dir"), base), refetch)
    artwork = Artwork(http, config, base)
    if not targeted:  # The nightly run tidies up; hooks and web pushes stay quick
        prune_cache(http.cache)
    DIGESTS.load(http.cache / "digests.json")
    upload = bool(artwork.plex.settings.get("upload"))
    if refresh and not upload:
        raise ValueError("--refresh uploads to Plex, so plex.upload must be true")
    if upload:
        artwork.plex.require("Uploading to Plex")
    if added and rating_key is not None and season is None and episode is None and artwork.plex.configured:
        rating_key, season, episode = artwork.plex.added_target(rating_key)  # A season's or episode's own key works too
    if targeted:
        selected = select_item(artwork, config, rating_key=rating_key, title=title, media_type=media_type, year=year)
        if added and selected[0]["type"] == "tv":
            with_seasons = with_episodes = True  # Narrowed to what's missing once output paths are known
            if not selected[0].get("rating_key"):
                raise ValueError("--added requires the show's Plex rating_key")
        for flag, wanted in (("--with-seasons", with_seasons), ("--with-episodes", with_episodes)):
            if wanted and selected[0]["type"] != "tv":
                raise ValueError(f"{flag} requires a show")
            if wanted and not selected[0].get("rating_key"):
                raise ValueError(f"{flag} requires the show's Plex rating_key")
        items = prepare_items(artwork, config, selected=selected, include_seasons=with_seasons, include_episodes=with_episodes)
        if (season is not None or episode is not None) and not added:
            # A season/episode filter selects episodes only, not the show or season posters.
            items = [item for item in items if item.get("episode") is not None
                     and season in (None, item["season"]) and episode in (None, item["episode"])]
            if not items:
                raise ValueError("No episode matches --season/--episode")
    else:
        items = prepare_items(artwork, config)
    if limit is not None:
        items = items[:limit]
    if not items:
        raise ValueError("No items selected; configure plex.libraries or items")
    source_root = local_path(option(config, "assets_dir"), base)
    sources = ArtworkFiles(source_root, full=not targeted)
    input_items = items + config.get("items", []) + list(config.get("overrides", {}).values())
    inputs = {local_path(item[field], base) for item in input_items if isinstance(item, dict) for field in ("poster", "logo")
              if item.get(field) and not is_url(item[field])}
    batch = Batch(artwork, sources, config, base, inputs, force=force,
                  changed_only=changed_only, refresh=refresh, refetch=refetch, upload=upload, added=added)
    for item in items:  # A collection Plex made again (after a reset) carries on in its old folder instead of starting a second one
        if item["type"] == "collection":
            try:
                adopted = sources.adopt(item, artwork.plex.gone)
            except RuntimeError as error:  # Plex wouldn't say whether the old one is gone, so nothing is taken over
                print(f"WARN {item.get('title', '?')}: looking for its earlier folder: {error}", file=sys.stderr, flush=True)
                break
            if adopted:
                print(f"COLLECTION {item['title']}: made again in Plex, so it continues in {adopted.name}", flush=True)
    for item in items:
        batch.destination(item, sources.folder(item, planned=True))
    if added and items[0]["type"] == "tv":
        # A show whose poster isn't in Plex yet (none made, or never sent): build all of it. Known show: only the
        # requested season/episode, and only the pieces Plex doesn't have yet.
        show = next(item for item in items if item.get("season") is None)
        if season is not None and show["output_path"].exists() and batch.delivered(show):
            # A lone episode also covers its season poster, which is skipped if it's already in Plex.
            items = [item for item in items if item.get("season") == season and (
                episode is None or item.get("episode") in (None, episode))]
        if not items:
            raise ValueError("--added matched nothing; is the season/episode in Plex yet?")
    if posters or icons:
        return download_alternates(artwork, sources, [item for item in items if item.get("episode") is None],
                                   batch.styles, posters, icons, poster_filter)
    if upload:
        batch.server = plex_server_id(artwork.plex, http.cache)
    failures, skips = batch.run(items)
    DIGESTS.save(prune=not targeted)
    print(f"Finished {len(items)} items in {time.perf_counter() - started:.2f}s; {failures} failed, {skips} missing artwork.")
    return 1 if failures or skips else 0


# Image helpers for picking and cropping artwork in tk.box's Admin console (asset folders, downloads, uploads).
WEB_CATEGORIES = ("movies", "tv", "collections")
WEB_FILE = re.compile(r"(poster|logo)(\d+|-[0-9a-f]{8})?", re.I)


def web_meta(folder):
    """A folder's .overlayrr.json, or {} when it's missing or broken (the page still lists the folder)."""
    try:
        return ArtworkFiles.metadata(folder)
    except ValueError:
        return {}


WEB_MAX_PIXELS = 30_000_000


def web_small(source, bound):
    """Decode an image (a file, or its bytes) no bigger than needed (a JPEG is decoded at a reduced size), so previews stay light."""
    with Image.open(io.BytesIO(source) if isinstance(source, bytes) else source) as image:
        image.draft("RGB", bound)
        image.thumbnail(bound)
        return image.convert("RGBA")


def web_check_image(data, kind):
    """(file extension, warning) for image bytes the script can use; ValueError for anything else."""
    try:
        with Image.open(io.BytesIO(data)) as image:
            suffix = IMAGE_SUFFIXES.get(image.format)
            if suffix is None:
                raise ValueError("Use a JPEG, PNG, WebP, GIF, TIFF or BMP image")
            if image.width * image.height > WEB_MAX_PIXELS:
                raise ValueError("That image is too large; use one under 30 megapixels")
            transparent = True
            if kind == "logo":
                image.thumbnail((512, 512))
                transparent = image.convert("RGBA").getchannel("A").getextrema()[0] < 255
            else:
                image.verify()
    except (OSError, SyntaxError, Image.DecompressionBombError):
        raise ValueError("That isn't a readable image") from None
    warning = None if transparent else "This logo has no transparent background, so it will be drawn as a solid box"
    return suffix, warning


def web_crop(data, crop):
    """The part of an image the page's crop window chose (fractions of its width and height), as lossless PNG bytes."""
    try:
        x, y, w, h = (float(crop[key]) for key in ("x", "y", "w", "h"))
    except (KeyError, TypeError, ValueError):
        raise ValueError("That crop isn't valid") from None
    if not (0 <= x < 1 and 0 <= y < 1 and 0 < w <= 1 and 0 < h <= 1):
        raise ValueError("That crop isn't valid")
    try:
        with Image.open(io.BytesIO(data)) as image:
            if image.width * image.height > WEB_MAX_PIXELS:
                raise ValueError("That image is too large; use one under 30 megapixels")
            box = (round(x * image.width), round(y * image.height),
                   min(image.width, round((x + w) * image.width)), min(image.height, round((y + h) * image.height)))
            if box[2] - box[0] < 32 or box[3] - box[1] < 32:
                raise ValueError("That crop is too small")
            out = io.BytesIO()
            image.crop(box).convert("RGB").save(out, format="PNG", compress_level=3)
            return out.getvalue()
    except (OSError, SyntaxError, Image.DecompressionBombError):
        raise ValueError("That isn't a readable image") from None


# The layout settings the page's Template view can change (no paths, canvas size or art choice).
TEMPLATE_FIELDS = ("poster_zoom", "poster_shift_y", "poster_shift_x", "matte_height_ratio", "fade_height_ratio", "fade_smoothness", "matte_opacity", "matte_color",
                   "vignette_strength", "vignette_mode", "vignette_color", "vignette_size", "vignette_falloff", "grain_amount", "grain_mode", "grain_size",
                   "logo_mode", "uniform_logo_max_w", "uniform_logo_max_h", "uniform_logo_offset_x", "uniform_logo_offset_y",
                   "uniform_logo_h_align", "uniform_logo_v_align", "uniform_logo_center_below", "uniform_logo_trim",
                   "uniform_logo_shadow_enabled", "uniform_logo_shadow_opacity", "uniform_logo_shadow_angle", "uniform_logo_shadow_distance",
                   "uniform_logo_shadow_size", "uniform_logo_shadow_spread", "uniform_logo_shadow_color",
                   "text_overlay_enabled", "custom_text", "font_size", "letter_spacing", "position_y", "position_x", "text_line_spacing", "text_transform", "text_color",
                   "text_stroke_width", "text_stroke_opacity", "text_stroke_color", "text_shadow_strength", "text_shadow_blur", "text_shadow_offset_y", "text_shadow_color",
                   "border_enabled", "border_px", "border_color", "border_radius",
                   "badges", "badge_layout", "badge_margin", "badge_gap", "badge_fit",
                   "badge_gradient_top_height", "badge_gradient_top_strength", "badge_gradient_bottom_height", "badge_gradient_bottom_strength", "badge_gradient_color",
                   "resolution_font_size", "edition_font_size", "badge_text_color", "badge_text_transform", "badge_stroke_width", "badge_stroke_opacity", "badge_stroke_color",
                   "badge_shadow_strength", "badge_shadow_blur", "badge_shadow_offset_y", "badge_shadow_color",
                   "badge_art_scale", "badge_art_shadow_enabled", "badge_art_shadow_opacity", "badge_art_shadow_angle", "badge_art_shadow_distance",
                   "badge_art_shadow_size", "badge_art_shadow_spread", "badge_art_shadow_color",
                   "audience_score_text_color", "audience_score_font_size",
                   "streaming_logo_source", "streaming_logo_max_w", "streaming_logo_max_h", "streaming_logo_h", "streaming_logo_v",
                   "streaming_logo_offset_x", "streaming_logo_offset_y", "streaming_logo_shadow_enabled", "streaming_logo_shadow_opacity",
                   "streaming_logo_shadow_angle", "streaming_logo_shadow_distance", "streaming_logo_shadow_size", "streaming_logo_shadow_spread",
                   "streaming_logo_shadow_color",
                   "status_banners", "status_banner_date_format", "status_banner_simplify_dates", "status_banner_h_align", "status_banner_v_align",
                   "status_banner_offset_x", "status_banner_offset_y", "status_banner_width", "status_banner_height", "status_banner_radius",
                   "status_banner_backdrop_opacity", "status_banner_border_width", "status_banner_border_color", "status_banner_font_file", "status_banner_font_size",
                   "status_banner_letter_spacing", "status_banner_text_transform", "status_banner_text_opacity", "status_banner_text_align", "status_banner_padding",
                   "status_banner_text_offset_x", "status_banner_text_offset_y", "status_banner_stroke_width", "status_banner_stroke_opacity",
                   "status_banner_stroke_color", "status_banner_shadow_strength", "status_banner_shadow_blur", "status_banner_shadow_offset_y", "status_banner_shadow_color")
# The same for its Episode card mode, saved under episode_options: every title card setting, plus the few shared ones the card
# uses (no card size).
CARD_TEMPLATE_FIELDS = CARD_FIELDS + ("logo_mode", "uniform_logo_max_w", "uniform_logo_max_h", "text_transform")
TEMPLATE_SECTIONS = {"poster": None, "season": "season_options", "episode": "episode_options"}


def card_values(values):
    """Template view values as the config holds them: the page's "none" gradient and its empty font are null."""
    return {key: None if (key == "card_gradient" and value == "none") or (key.endswith("_font_file") and value == "") else value
            for key, value in values.items()}


class Worker:
    """--worker: tk.box's Admin › Artwork asks this long-lived process for titles, picks, previews and layout previews as
    JSON lines on stdin (see serve_worker); renders and uploads still run as separate jobs."""

    def __init__(self, config_path):
        config = read_config(config_path)
        self.config_path = config_path
        self.root = local_path(option(config, "assets_dir"), config_path.parent)
        self.cache = local_path(option(config, "cache_dir"), config_path.parent)
        self.lock = threading.RLock()
        self.renderers, self.previews, self.items, self.stamp, self.timer = {}, {}, {}, None, None
        self.samples, self.decoded, self.drafts, self.layouts = {}, OrderedDict(), OrderedDict(), (None, None)  # Template view
        self.fetched = OrderedDict()  # Online pictures downloaded to be previewed (bytes, never saved), newest last
        self.library_cache = None  # (when asked, library_kinds' answer)
        self.rendering, self.thumbing = threading.Semaphore(1), threading.Semaphore(2)  # One preview and two thumbnails at a time
        self.pending_file = self.cache / "web_pending.json"
        try:
            self.pending = json.loads(self.pending_file.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            self.pending = {}
        if not isinstance(self.pending, dict):
            self.pending = {}
        self.sources_file = self.cache / "web_sources.json"  # short_hash -> the online picture it was downloaded from
        try:
            self.sources = json.loads(self.sources_file.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            self.sources = {}
        if not isinstance(self.sources, dict):
            self.sources = {}

    def path(self, rel, depths):
        """A folder or file under assets/, only ever <category>/<title>[/Season NN][/file]."""
        parts = Path(str(rel)).parts
        if len(parts) not in depths or parts[0] not in WEB_CATEGORIES or any(
                part in ("", ".", "..") or Path(part).name != part for part in parts):
            raise ValueError("Unknown path")
        return self.root.joinpath(*parts)

    def locate(self, rel):
        folder = self.path(rel, (2, 3))
        if len(Path(rel).parts) == 3 and not re.fullmatch(r"Season \d+", folder.name):
            raise ValueError("Unknown folder")
        if not folder.is_dir():
            raise ValueError("Folder not found")
        return folder.parent if len(Path(rel).parts) == 3 else folder, folder

    @staticmethod
    def url(path, rel, width):
        return WORKER_ROUTES + "/file?" + urlencode({"p": rel, "w": width, "v": path.stat().st_mtime_ns})

    def titles(self):
        rows = []
        for category in WEB_CATEGORIES:
            if not (self.root / category).is_dir():
                continue
            for folder in (self.root / category).iterdir():
                if not folder.is_dir():
                    continue
                meta, rel = web_meta(folder), f"{category}/{folder.name}"
                named = {path.stem.lower(): path for path in folder.iterdir()
                         if path.is_file() and path.suffix.lower() in ArtworkFiles.extensions}
                cover = named.get("rendered") or named.get("poster")
                rows.append({"id": rel, "cat": category, "title": str(meta.get("title") or folder.name), "year": meta.get("year"),
                             "first": category == "collections" and collection_key(meta.get("title") or folder.name) in {collection_key(chart[1]) for chart in CHARTS},
                             "thumb": self.url(cover, f"{rel}/{cover.name}", 300) if cover else None})
        return sorted(rows, key=lambda row: row["title"].casefold())

    @staticmethod
    def picked(folder, kind, name, candidate=False):
        """A poster or logo file of this folder by name: the one in use or a candidate (poster2, poster-1a2b3c4d);
        with `candidate`, only a candidate."""
        path = folder / str(name)
        match = WEB_FILE.fullmatch(path.stem)
        if (kind not in ("poster", "logo") or Path(str(name)).name != name or not path.is_file()
                or path.suffix.lower() not in ArtworkFiles.extensions or not match or match[1].lower() != kind
                or (candidate and not match[2])):
            raise ValueError("Not a candidate file" if candidate else "Not a poster or logo file")
        return path

    def version(self, folder, title):
        """Changes whenever a file the preview depends on does, so the page knows when to ask for a new one."""
        state = [self.config_path.stat().st_mtime_ns, self.no_logo(title)]
        for where, kind in ((folder, "poster"), (title, "logo")):
            path = ArtworkFiles.source(where, kind)
            state.append(path and (path.name, path.stat().st_mtime_ns, path.stat().st_size))
        return hashlib.sha1(repr(state).encode()).hexdigest()[:10]

    def drop_previews(self):
        """Forget every rendered preview and layout mask; the page asks for this when a title is closed."""
        with self.lock:
            self.renderers, self.previews, self.items = {}, {}, {}
            self.samples, self.decoded, self.drafts, self.fetched = {}, OrderedDict(), OrderedDict(), OrderedDict()
            if self.timer:
                self.timer.cancel()
                self.timer = None

    def idle(self):
        """Restart the five-minute countdown after which drop_previews lets go of everything."""
        with self.lock:
            if self.timer:
                self.timer.cancel()
            self.timer = threading.Timer(300, self.drop_previews)
            self.timer.daemon = True
            self.timer.start()

    def renderer(self, key, style, base):
        with self.lock:
            if key not in self.renderers:
                self.renderers[key] = Renderer(style, base)
            return self.renderers[key]

    def fetched_picture(self, url, plex, kind):
        """The bytes of an online picture (a provider's link, or one of Plex's own paths) to preview it before it's chosen. They are checked
        like an upload and kept only in memory, for the last few asked for."""
        key = plex or url
        with self.lock:
            if key in self.fetched:
                self.fetched.move_to_end(key)
                return self.fetched[key]
        data = self.plex_get(plex) if plex else web_download(str(url))
        web_check_image(data, kind)
        with self.lock:
            self.fetched[key] = data
            while len(self.fetched) > 3:
                self.fetched.popitem(last=False)
        return data

    def preview(self, rel, poster=None, logo=None, width=480, online=None):
        """JPEG of what a push would make from the files now in use (or from a named candidate), rendered in memory.
        `online` is (kind, link, Plex path): a picture the providers offer, drawn in place of that kind's file."""
        title, folder = self.locate(rel)
        season = None if folder == title else int(re.search(r"\d+", folder.name)[0])
        if (logo or (online and online[0] == "logo")) and season is not None:
            raise ValueError("Seasons use the series logo")
        files = {"poster": self.picked(folder, "poster", poster) if poster else ArtworkFiles.source(folder, "poster"),
                 "logo": self.picked(folder, "logo", logo) if logo else ArtworkFiles.source(title, "logo")}  # A season's logo is its series'
        if online:
            if online[0] not in ("poster", "logo"):
                raise ValueError("Pick posters or logos")
            files[online[0]] = self.fetched_picture(online[1], online[2], online[0])
        if files["poster"] is None:
            raise ValueError("No poster saved yet, so there is nothing to preview")
        signature = lambda path: path and (("online", hashlib.sha1(path).hexdigest()) if isinstance(path, bytes)
                                           else (str(path), path.stat().st_mtime_ns, path.stat().st_size))
        key = (rel, signature(files["poster"]), signature(files["logo"]), self.no_logo(title), width)
        with self.lock:
            self.idle()
            stamp = self.config_path.stat().st_mtime_ns
            if stamp != self.stamp:  # The layout may have changed
                self.renderers, self.previews, self.items, self.stamp = {}, {}, {}, stamp
            if key in self.previews:
                return self.previews[key]
        try:
            with self.rendering:
                data = self.render_preview(title, folder, season, files, width)
        except (RuntimeError, KeyError, TypeError, ET.ParseError) as error:
            raise ValueError(f"Couldn't build the preview: {error}") from None
        with self.lock:
            self.previews[key] = data
            while len(self.previews) > 40:
                self.previews.pop(next(iter(self.previews)))
        return data

    @staticmethod
    def hang_up(client):
        """Close the worker's pooled connections of an Artwork or Plex made for one request."""
        session = getattr(client.http.local, "session", None)
        if session:
            session.close()

    def remote(self, rel, kind):
        """Every poster, logo or backdrop the providers offer, as links the browser loads itself; nothing is downloaded here."""
        if kind not in ("poster", "logo", "backdrop"):
            raise ValueError("Pick posters, logos or backdrops")
        title, folder = self.locate(rel)
        # Seasons share their show's logos
        season = None if folder == title or kind == "logo" else int(re.search(r"\d+", folder.name)[0])
        item, style = self.base_item(title, season)
        artwork = Artwork(HTTP(self.cache), read_config(self.config_path), self.config_path.parent)
        try:
            found = artwork.found_backdrops(item) if kind == "backdrop" else artwork.found_art(item)
        finally:
            self.hang_up(artwork)
        rows = found[{"poster": "posters", "logo": "logos", "backdrop": "backdrops"}[kind]]
        if kind == "logo":
            rows = [row for row in rows if not urlparse(row[1]["url"]).path.lower().endswith(".svg") and artwork.language_rank(row[1]) < 3]
        # Textless (or language-neutral) first, then the rest; each group by language, then size
        rows.sort(key=lambda row: (row[1].get("has_text") is not False, artwork.language_rank(row[1]), -int(row[1].get("width") or 0)))
        items = []
        for provider, art in rows:
            url = art["url"]
            plex = url[len(artwork.plex.url):] if art.get("headers") else None
            # The page loads images only from tk.box: Plex's own copies need the token, the providers' are proxied
            if plex:
                view = thumb = WORKER_ROUTES + "/plex-image?" + urlencode({"p": plex})
            else:
                size = "w1280" if kind == "backdrop" else "w780"  # A smaller copy than the original is plenty to look at
                view = f"https://image.tmdb.org/t/p/{size}" + url[len(IMAGE_BASE):] if url.startswith(IMAGE_BASE) else url
                thumb = art.get("thumb") or (url.replace("/fanart/", "/preview/") if "assets.fanart.tv" in url else url)
                view, thumb = (WORKER_ROUTES + "/image?" + urlencode({"u": link}) for link in (view, thumb))
            items.append({"provider": provider, "url": None if plex else url, "plex": plex, "view": view, "thumb": thumb,
                          "language": art.get("language"), "text": art.get("has_text"), "width": int(art.get("width") or 0),
                          "height": int(art.get("height") or 0)})
        # A backdrop is cropped to this layout's poster shape and size
        return {"items": items, "notes": found["errors"], "target": [style.width, style.height] if kind == "backdrop" else None}

    def plex_get(self, path):
        """An image from Plex's own library path, fetched with the server's token."""
        if (not path.startswith(("/library/metadata/", "/library/collections/")) or ".." in path  # Collections: their collage
                or re.search(r"[\s\x00-\x1f]", path)):
            raise ValueError("Not a Plex image path")
        server = Plex(HTTP(self.cache), read_config(self.config_path))
        try:
            if not server.url:
                raise ValueError("Plex isn't configured")
            data = server.http.get(server.url + path, headers=server.headers)
        except RuntimeError as error:
            raise ValueError(f"Plex: {error}") from None
        finally:
            self.hang_up(server)
        if len(data) > WEB_UPLOAD_LIMIT:
            raise ValueError("That file is larger than 40 MB")
        return data

    def base_item(self, title, season):
        """The Plex item and layout a push would use, looked up once while the title stays open."""
        rel = f"{title.parent.name}/{title.name}"
        with self.lock:
            if (rel, season) in self.items:
                item, style = self.items[rel, season]
                return dict(item), self.logo_style(title, style)
        config = read_config(self.config_path)
        artwork = Artwork(HTTP(self.cache), config, self.config_path.parent)
        try:
            items = prepare_items(artwork, config, selected=[artwork.plex.get_item(self.key(rel))], include_seasons=season is not None)
            item = next((entry for entry in items if entry.get("season") == season), None)
            if item is None:
                raise ValueError("Plex doesn't list that season")
            style = layout_styles(config)[item["layout_key"]]
            artwork.badge_facts(item, style)
        finally:
            self.hang_up(artwork)
        with self.lock:
            self.items[rel, season] = (item, style)
        return dict(item), self.logo_style(title, style)

    @staticmethod
    def no_logo(title):
        """Whether the title is set to have no logo (the "No logo" tile)."""
        return bool(web_meta(title).get("no_logo"))

    @staticmethod
    def logo_style(title, style):
        return replace(style, logo_mode="none") if Worker.no_logo(title) else style

    @staticmethod
    def write_no_logo(title, on):
        """Set or clear the title's "No logo" (kept in its .overlayrr.json, which pushes preserve)."""
        meta = ArtworkFiles.metadata(title)
        if not meta:
            raise ValueError("This title has no saved details yet, so run the script for it once first")
        meta.pop("no_logo", None)
        if on:
            meta["no_logo"] = True
        atomic_write(title / ".overlayrr.json", json.dumps(meta, indent=2).encode())

    def render_preview(self, title, folder, season, files, width):
        base = self.config_path.parent
        item, style = self.base_item(title, season)
        # Layouts scale with their width, so a small render looks like the full-size one for a fraction of the work.
        style = replace(style, width=width, height=round(style.height * width / style.width))
        bound = (2 * style.width, 2 * style.height)
        logo_path = files["logo"] or (local_path(item["logo"], base) if item.get("logo") and not is_url(item["logo"]) else None)
        background = web_small(files["poster"], bound)
        logo = web_small(logo_path, bound) if logo_path and style.logo_mode != "none" else None
        picture = isinstance(files["poster"], bytes)  # An online picture isn't the title's stock poster
        item["poster"] = "online picture" if picture else str(files["poster"])
        stock_hash = web_meta(folder).get("stock_poster")
        stock = bool(stock_hash and not picture and file_digest(files["poster"]) == stock_hash) or (style.logo_mode != "none" and logo is None)
        image = self.renderer((item["layout_key"], width), style, base).render(background, logo, stock, item)
        buffer = io.BytesIO()
        image.convert("RGB").save(buffer, format="JPEG", quality=80)
        return buffer.getvalue()

    def template_config(self):
        """(version, config): read again only when tk.box writes the config again, since the layout editor asks on every slider move."""
        data = self.config_path.read_bytes()
        version = hashlib.sha1(data).hexdigest()[:12]
        with self.lock:
            if self.layouts[0] != version:
                self.layouts = (version, read_config(self.config_path))
            return self.layouts

    def template(self):
        """Every layout's settings as the Template view edits them, for posters and for seasons."""
        version, config = self.template_config()
        kinds = {"movie": "All movies", "tv": "All TV", "collection": "Collections", "streaming": "Streaming collections", "chart": "Chart collections", "custom": "Custom collections"}
        uses = {}
        if config.get("default_layout"):
            uses[config["default_layout"]] = ["Default"]
        for library, name in config.get("layout_by_library", {}).items():
            uses.setdefault(name, []).append(str(library))
        for kind, name in config.get("layout_by_type", {}).items():
            uses.setdefault(name, []).append(kinds[kind])
        def pick(style):
            values = {key: value for key, value in asdict(style).items() if key in TEMPLATE_FIELDS + ("width", "height")}
            # The page has a switch per edge, so `gradients` shows as both
            values["badges"] = [name for name in values["badges"] if not name.startswith("gradient")] + [f"gradient_{side}" for side in gradient_sides(values["badges"])]
            values["status_banners"] = {category: dict(entry) for category, entry in values["status_banners"]}  # What the page edits: the overrides only
            values["status_banner_font_file"] = values["status_banner_font_file"] or ""  # The page's empty font is the config's null
            return values
        def pick_card(style):
            values = {key: value for key, value in asdict(style).items() if key in CARD_TEMPLATE_FIELDS + ("width", "height")}
            values["card_gradient"] = values["card_gradient"] or "none"  # The page's "none" and empty font are the config's null
            return {key: "" if key.endswith("_font_file") and value is None else value for key, value in values.items()}
        media = self.template_media(config)
        layouts = []
        for name, options in config["layouts"].items():
            options = dict(options)
            season = options.pop("season_options", None)
            card = options.pop("episode_options", None)
            # A layout without season_options or episode_options (a movie layout) gets no Season or Episode card mode
            layouts.append({"name": name, "uses": uses.get(name, []), "media": media.get(name), "seasons": season is not None, "cards": card is not None,
                            "poster": pick(Style(**options)), "season": pick(Style(**{**options, **(season or {})})),
                            "episode": pick_card(Style(**{**options, **card})) if card is not None else None})
        return {"version": version, "default": config.get("default_layout"), "layouts": layouts,
                "fonts": self.template_fonts(config), "banners": banner_settings(())}  # The categories as they are with nothing overridden

    def library_kinds(self, config):
        """[(title, "movie" or "show")] for the configured Plex libraries, or None when Plex can't say. Plex gets a few seconds to
        answer, and the answer (or None) is kept for a minute, so the Template view never waits on a server that's down."""
        with self.lock:
            if self.library_cache and time.time() - self.library_cache[0] < 60:
                return self.library_cache[1]
            self.library_cache = (time.time(), None)  # What a caller that stops waiting gets; ask() replaces it with the answer

        def ask():
            try:
                server = Plex(HTTP(self.cache), config)
                try:
                    kinds = [(title, kind) for kind in ("movie", "show") for _, title in server.sections(kind)]
                finally:
                    self.hang_up(server)
            except (ValueError, RuntimeError, OSError, ET.ParseError):  # Not set up, not reachable, or not Plex's kind of answer
                kinds = None
            with self.lock:
                self.library_cache = (time.time(), kinds)
        thread = threading.Thread(target=ask, daemon=True)
        thread.start()
        thread.join(4)
        with self.lock:
            return self.library_cache[1]

    def template_media(self, config):
        """{layout: the assets categories ("movies", "tv", "collections") it makes posters for}, worked out the way item_layout
        picks layouts, from which configured Plex libraries hold movies or shows. Layouts nothing is known to use are left out,
        and so is everything when Plex can't say; the page then previews them on any title."""
        libraries = self.library_kinds(config)
        if libraries is None:
            return {}
        by_type = config.get("layout_by_type", {})
        by_library = {str(library): name for library, name in config.get("layout_by_library", {}).items()}
        media = {}
        def add(name, category):
            if name:
                media.setdefault(name, set()).add(category)
        for kind in ("collection", "streaming", "chart", "custom"):
            add(by_type.get(kind), "collections")
        for title, kind in libraries:
            name = by_library.get(title, by_type.get("movie" if kind == "movie" else "tv", config.get("default_layout")))
            add(name, "movies" if kind == "movie" else "tv")
            if "collection" not in by_type:  # Otherwise a library's collections use the collection layout, not the library's
                add(name, "collections")
        return {name: sorted(categories) for name, categories in media.items()}

    def template_fonts(self, config):
        """The font files in each layout's resource_dir/fonts, named as the config would name them (relative to the YAML)."""
        base, found = self.config_path.parent.resolve(), set()
        for options in config["layouts"].values():
            folder = local_path(str(options.get("resource_dir") or Style.resource_dir), base) / "fonts"
            for path in folder.rglob("*") if folder.is_dir() else ():
                if path.suffix.lower() in (".ttf", ".otf", ".ttc"):
                    found.add(path.relative_to(base).as_posix() if path.is_relative_to(base) else path.as_posix())
        return sorted(found, key=str.casefold)

    def template_style(self, name, mode, values):
        """The layout (or its season or episode card version) with unsaved Template settings on top."""
        layouts = self.template_config()[1]["layouts"]
        if not isinstance(name, str) or name not in layouts:
            raise ValueError("Unknown layout")
        if mode not in TEMPLATE_SECTIONS:
            raise ValueError("Unknown mode")
        if not isinstance(values, dict) or set(values) - set(CARD_TEMPLATE_FIELDS if mode == "episode" else TEMPLATE_FIELDS):
            raise ValueError("Only the Template view's settings can be changed here")
        options = dict(layouts[name])
        season = options.pop("season_options", None) or {}
        card = options.pop("episode_options", None)
        if mode == "episode" and card is None:
            raise ValueError(f"Layout {name} has no episode_options")
        extra = {"poster": {}, "season": season, "episode": card}[mode]
        try:
            return Style(**{**options, **extra, **card_values(values)})
        except TypeError as error:
            raise ValueError(str(error)) from None

    def episode_sample(self, title):
        """(folder, item) behind an Episode card preview: the show's first saved episode still (Specials last) and that
        episode's numbers and title; without one, the show's own folder and a made-up episode."""
        with self.lock:
            if (title, "episode") in self.samples:
                folder, item = self.samples[title, "episode"]
                return folder, dict(item)
        found = [(int(season.name.split()[1]), int(episode.name.split()[1]), episode)
                 for season in title.iterdir() if season.is_dir() and re.fullmatch(r"Season \d+", season.name)
                 for episode in season.iterdir() if episode.is_dir() and re.fullmatch(r"Episode \d+", episode.name) and ArtworkFiles.source(episode, "poster")]
        if found:
            number, episode, folder = min(found, key=lambda entry: (entry[0] == 0, entry[:2]))
            item = {"season": number, "episode": episode, "episode_title": web_meta(folder).get("episode_title") or "Episode title"}
        else:
            folder, item = title, {"season": 1, "episode": 1, "episode_title": "Episode title"}
        with self.lock:
            self.samples[title, "episode"] = folder, item
        return folder, dict(item)

    def sample_item(self, title, season):
        """The Plex item behind a Template preview, with what every badge needs; without Plex, just the title's name."""
        with self.lock:
            if (title, season) in self.samples:
                return dict(self.samples[title, season])
        try:
            item = self.base_item(title, season)[0]
            artwork = Artwork(HTTP(self.cache), read_config(self.config_path), self.config_path.parent)
            try:
                artwork.badge_facts(item, Style(badges=BADGES))
            finally:
                self.hang_up(artwork)
        except (ValueError, RuntimeError, KeyError, TypeError, OSError, ET.ParseError):
            meta = web_meta(title)
            item = {"type": {"movies": "movie", "tv": "tv"}.get(title.parent.name, "collection"),
                    "title": str(meta.get("title") or title.name), "year": meta.get("year"), "season": season}
        with self.lock:
            self.samples[title, season] = item
        return dict(item)

    def decode(self, path, bound):
        """web_small, kept for the next few previews (the poster doesn't change while the sliders move)."""
        key = (str(path), path.stat().st_mtime_ns, bound)
        with self.lock:
            if key in self.decoded:
                self.decoded.move_to_end(key)
                return self.decoded[key]
        image = web_small(path, bound)
        with self.lock:
            self.decoded[key] = image
            while len(self.decoded) > 6:
                self.decoded.popitem(last=False)
        return image

    def template_preview(self, name, mode, values, rel, width, banner=""):
        """(JPEG, note) of a layout with unsaved settings on one title's saved poster and logo, rendered in memory.
        For seasons it uses the show's first season with a poster (Specials last); for episode cards, the show's first
        saved episode still (note "no-still" when it has none, and the card is drawn on the show's poster instead)."""
        style = self.template_style(name, mode, values)
        title = self.path(rel, (2,))
        if not title.is_dir():
            raise ValueError("Folder not found")
        folder, number, card = title, None, mode == "episode"
        if card:
            folder, item = self.episode_sample(title)
        if mode == "season":
            seasons = [(int(path.name.split()[1]), path) for path in title.iterdir()
                       if path.is_dir() and re.fullmatch(r"Season \d+", path.name) and ArtworkFiles.source(path, "poster")]
            if not seasons:
                raise ValueError("This show has no season poster saved yet; pick another")
            number, folder = min(seasons, key=lambda pair: (pair[0] == 0, pair[0]))
        poster = ArtworkFiles.source(folder, "poster")
        if poster is None:
            raise ValueError("This title has no poster saved yet; pick another")
        self.idle()
        base = self.config_path.parent
        if not card:
            item = self.sample_item(title, number)
            if banner in BANNERS and number is None:  # Previewed as this category, whatever the show is up to
                item = {**item, "media": {**item.get("media", {}), "banner": sample_banner(banner)}}
        logo_path = ArtworkFiles.source(title, "logo") or (local_path(item["logo"], base) if item.get("logo") and not is_url(item["logo"]) else None)
        # A fixed grain pattern, so moving a slider doesn't make the grain flicker
        style = replace(style, width=width, height=round(style.height * width / style.width), grain_seed=style.grain_seed or 0)
        bound = (2 * style.width, 2 * style.height)
        try:
            with self.rendering:
                background = self.decode(poster, bound)
                logo = self.decode(logo_path, bound) if logo_path and style.logo_mode != "none" else None
                with self.lock:
                    renderer = self.drafts.pop((card, style), None) or (CardRenderer if card else Renderer)(style, base)
                    self.drafts[card, style] = renderer
                    while len(self.drafts) > 4:
                        self.drafts.popitem(last=False)
                image = renderer.render(background, logo, False, item)
        except (RuntimeError, KeyError, TypeError) as error:
            raise ValueError(f"Couldn't build the preview: {error}") from None
        buffer = io.BytesIO()
        image.convert("RGB").save(buffer, format="JPEG", quality=85)
        notes = ["no-still"] * (card and folder == title) + ["no-logo"] * (logo is None and style.logo_mode != "none")
        return buffer.getvalue(), " ".join(notes)

    def section(self, folder, rel, label, title):
        found = {"id": rel, "label": label, "pv": self.version(folder, title), "rendered": None, "poster": None, "logo": None, "posters": [], "logos": []}
        order = lambda path: re.sub(r"\d+", lambda number: number[0].zfill(6), path.name.casefold())
        for path in sorted(folder.iterdir(), key=order):
            match = WEB_FILE.fullmatch(path.stem)
            if not path.is_file() or path.suffix.lower() not in ArtworkFiles.extensions or not (match or path.stem.lower() == "rendered"):
                continue
            file_rel = f"{rel}/{path.name}"
            entry = {"name": path.name, "thumb": self.url(path, file_rel, 360), "full": self.url(path, file_rel, 1400),
                     "kb": path.stat().st_size // 1024, "kept": bool(match and match[2] and match[2].startswith("-"))}
            try:
                with Image.open(path) as image:
                    entry["size"] = f"{image.width}\u00d7{image.height}"
            except (OSError, SyntaxError, Image.DecompressionBombError):
                pass
            if not match:
                found["rendered"] = entry
                continue
            entry["hash"] = self.short_hash(path)  # Names change as picks rename files; the contents don't
            entry["source"] = self.sources.get(entry["hash"])
            if match[2]:
                found[match[1].lower() + "s"].append(entry)
            else:
                found[match[1].lower()] = entry
        return found

    def detail(self, rel):
        folder = self.path(rel, (2,))
        if not folder.is_dir():
            raise ValueError("Folder not found")
        meta = web_meta(folder)
        seasons = sorted((path for path in folder.iterdir() if path.is_dir() and re.fullmatch(r"Season \d+", path.name)),
                         key=lambda path: path.name)
        try:
            found = self.generated(folder)
        except (ValueError, KeyError, RuntimeError, OSError) as error:  # Plex unreachable: the rest of the page still works
            print(f"WARN {folder.name}: generated background: {error}", file=sys.stderr, flush=True)
            found = None
        generated = found and {"color": found[0], "default": found[1], "name": found[2].name, "hash": self.short_hash(found[2]),
                               "thumb": self.url(found[2], f"{rel}/{found[2].name}", 360), "full": self.url(found[2], f"{rel}/{found[2].name}", 1400)}
        return {"id": rel, "title": str(meta.get("title") or folder.name), "year": meta.get("year"),
                "key": meta.get("rating_key"), "tv": rel.startswith("tv/"), "no_logo": bool(meta.get("no_logo")), "generated": generated,
                "sections": [self.section(folder, rel, None, folder)] + [self.section(path, f"{rel}/{path.name}", path.name, folder) for path in seasons]}

    def mark(self, rel, changed, before=None):
        """Note a title as changed (or pushed). `before` is (folder|kind, file name or None): the file in use before
        the first unpushed change there, which Discard puts back; later changes don't replace it."""
        with self.lock:
            if changed:
                entry = self.pending.get(rel) or {"title": web_meta(self.path(rel, (2,))).get("title") or Path(rel).name, "before": {}}
                if before and "before" in entry:  # Titles changed before this was recorded can't be put back
                    entry["before"].setdefault(*before)
                self.pending[rel] = entry
            else:
                self.pending.pop(rel, None)
            atomic_write(self.pending_file, json.dumps(self.pending, indent=2).encode())

    @staticmethod
    def short_hash(path):
        """A file's identity for the page and for set-aside names. Hashed fresh: renames can leave the remembered
        digest stale."""
        return hashlib.sha256(path.read_bytes()).hexdigest()[:8]

    @staticmethod
    def kept_name(path, kind):
        """The name a poster/logo gets when it's set aside."""
        return f"{kind}-{Worker.short_hash(path)}{path.suffix.lower()}"

    def swap(self, folder, kind, chosen):
        """Make `chosen` (or nothing) the folder's poster/logo; the old one stays beside it as poster-<hash>, never
        deleted, except a collection's generated background, which is only ever kept as generated.png. Returns the
        name of the file the old one is kept as."""
        current = ArtworkFiles.source(folder, kind)
        generated = ArtworkFiles.source(folder, "generated") if kind == "poster" else None
        kept = current and folder / self.kept_name(current, kind)
        if current and generated and file_digest(current) == file_digest(generated):
            current.unlink()
            kept = generated
        elif current and kept.exists():  # The same image is already kept
            current.unlink()
        elif current:
            current.rename(kept)
        if chosen and chosen == generated:  # Copied, so the generated background stays on offer
            atomic_write(folder / (kind + chosen.suffix.lower()), chosen.read_bytes())
        elif chosen:
            chosen.rename(folder / (kind + chosen.suffix.lower()))
        return kept and kept.name

    def select(self, rel, kind, name):
        """Make a candidate the title's poster/logo; the one it replaces stays beside it as poster-<hash>."""
        title, folder = self.locate(rel)
        if kind == "logo" and folder != title:
            raise ValueError("Seasons use the series logo; change it on the series")
        kept = self.swap(folder, kind, self.picked(folder, kind, name, candidate=True))
        was = kind == "logo" and self.no_logo(title)
        if was:  # Picking a logo means wanting one
            self.write_no_logo(title, False)
        if not web_meta(title).get("rating_key"):
            return {"warning": "This title has no Plex ID saved yet, so it can't be pushed until the script has run for it once"}
        self.mark(f"{title.parent.name}/{title.name}", True, (f"{rel}|{kind}", kept))
        if was:
            self.mark(f"{title.parent.name}/{title.name}", True, (f"{rel}|nologo", True))
        return {"warning": None}

    def generated(self, title, redraw=False):
        """A collection's generated background, for the collections that get one (streaming, chart, custom and curated):
        (color, default color, generated.png), drawn again when its color or its layout's glow changed. None for others."""
        meta = web_meta(title)
        if title.parent.name != "collections" or not meta:
            return None
        item, style = self.base_item(title, None)
        if not (item.get("service") or item.get("chart") or item.get("custom") or not meta.get("tmdb_id")):
            return None  # A TMDb franchise: its posters are real ones
        default = default_background_color(item, style)
        color = meta.get("background_color") or default
        key = [color, style.collection_gradient_radius, style.collection_gradient_strength, style.collection_gradient_corner]
        path = ArtworkFiles.source(title, "generated")
        if redraw or path is None or meta.get("generated") != key:
            if path:
                path.unlink()
            path = ArtworkFiles.save_image(title, "generated", generated_background(item, style, color))
            atomic_write(title / ".overlayrr.json", json.dumps({**ArtworkFiles.metadata(title), "generated": key}, indent=2).encode())
        return color, default, path

    def use_generated(self, rel, kept=None):
        """The Generated background tile: make the collection's generated background its poster."""
        title, folder = self.locate(rel)
        found = self.generated(title) if folder == title else None
        if found is None:
            raise ValueError("Only streaming, chart, custom and curated collections have a generated background")
        kept = self.swap(title, "poster", found[2]) or kept
        if not web_meta(title).get("rating_key"):
            return {"warning": "This title has no Plex ID saved yet, so it can't be pushed until the script has run for it once"}
        self.mark(rel, True, (f"{rel}|poster", kept))
        return {"warning": None}

    def background_color(self, rel, color):
        """Right-click > colour on the Generated background tile: draw it again in `color` (#RRGGBB, or None for its
        default) over the one before, and make it the poster."""
        title, folder = self.locate(rel)
        if color is not None and not re.fullmatch(r"#[0-9a-fA-F]{6}", str(color)):
            raise ValueError("Pick a colour as #RRGGBB")
        found = self.generated(title) if folder == title else None
        if found is None:
            raise ValueError("Only streaming, chart, custom and curated collections have a generated background")
        was = web_meta(title).get("background_color")
        current, kept = ArtworkFiles.source(title, "poster"), None
        if current and file_digest(current) == file_digest(found[2]):
            current.unlink()  # The old colour's poster: replaced, not kept (Discard draws it again from generated.png)
            kept = found[2].name
        meta = ArtworkFiles.metadata(title)
        meta.pop("background_color", None)
        if color is not None and color.lower() != found[1].lower():
            meta["background_color"] = color.lower()
        atomic_write(title / ".overlayrr.json", json.dumps(meta, indent=2).encode())
        self.generated(title, redraw=True)
        result = self.use_generated(rel, kept)
        if web_meta(title).get("rating_key"):
            self.mark(rel, True, (f"{rel}|background", was))
        return result

    def choose_no_logo(self, rel, on):
        """The "No logo" tile: the next push makes this title's poster, and its seasons' and episodes', without a logo, until
        a logo is picked (or this is switched off)."""
        title, folder = self.locate(rel)
        if folder != title:
            raise ValueError("Seasons use the series logo; change it on the series")
        was = self.no_logo(title)
        if was == on:
            return {"warning": None}
        self.write_no_logo(title, on)
        if not web_meta(title).get("rating_key"):
            return {"warning": "This title has no Plex ID saved yet, so it can't be pushed until the script has run for it once"}
        self.mark(f"{title.parent.name}/{title.name}", True, (f"{rel}|nologo", was))
        return {"warning": None}

    def last_render(self, title, folder, season):
        """The files the last render of this folder was made from, found by matching its change record (the same one
        --changed-only reads) against the saved files: {"poster": path, "logo": path or None}, without "logo" when the
        layout draws none. None when nothing matches: never rendered, or the layout or settings changed since."""
        item, style = self.base_item(title, season)
        output = (folder / item["output_name"]).resolve()
        try:
            recorded = (self.cache / "renders" / hashlib.sha256(str(output).encode()).hexdigest()).read_text()
        except OSError:
            return None
        config, base = read_config(self.config_path), self.config_path.parent
        server = Plex(HTTP(self.cache), config)
        try:
            server_id = plex_server_id(server, self.cache) if server.url else None
        except RuntimeError:
            server_id = None
        finally:
            self.hang_up(server)
        # The record says whether that run uploaded, so try both, and the older form keyed on plex.url
        variants = [(dict(config, plex=dict(config.get("plex", {}), upload=upload)), server_id if upload else None, legacy)
                    for upload in (True, False) for legacy in (False, True)]

        def files(where, kind):
            return [path for path in sorted(where.iterdir()) if path.is_file() and path.suffix.lower() in ArtworkFiles.extensions
                    and (match := WEB_FILE.fullmatch(path.stem)) and match[1].lower() == kind]
        logos = [None] if style.logo_mode == "none" else files(title, "logo") + [None]
        for poster in files(folder, "poster"):
            for logo in logos:
                item["poster"] = str(poster)
                if logo:
                    item["logo"] = str(logo)
                else:
                    item.pop("logo", None)
                if any(render_signature(item, style, settings, base, server_key, legacy) == recorded for settings, server_key, legacy in variants):
                    return {"poster": poster} if style.logo_mode == "none" else {"poster": poster, "logo": logo}
        return None

    def live(self, rel):
        """The files the last push used for this folder (see last_render), by short_hash, so the page can mark them Live;
        `known` is false when they can't be told (never pushed, layout changed since, or Plex unreachable)."""
        title, folder = self.locate(rel)
        try:
            hit = self.last_render(title, folder, None if folder == title else int(folder.name.split()[1]))
        except (ValueError, KeyError, RuntimeError, OSError):
            hit = None
        if not hit:
            return {"known": False}
        return {"known": True, **{kind: path and self.short_hash(path) for kind, path in hit.items()}}

    def discard(self, rel):
        """Go back to the files the last push used, and forget the title's unpushed changes. Each changed spot gets
        the file its last render was made from; failing that, the file noted before the first change; failing that,
        nothing (the next run picks one). The files it replaces stay beside them as poster-<hash>."""
        with self.lock:
            entry = self.pending.get(rel)
        if entry is None:
            raise ValueError("Nothing to discard")
        title = self.path(rel, (2,))
        sections = [(title, None, rel)] + [(path, int(path.name.split()[1]), f"{rel}/{path.name}") for path in sorted(title.iterdir())
                                            if path.is_dir() and re.fullmatch(r"Season \d+", path.name)]
        before = entry.get("before")  # Missing for changes made before it was recorded: then any spot may have changed
        if before and f"{rel}|nologo" in before:  # "No logo" first, so what the last push used is looked for the way it was made
            self.write_no_logo(title, bool(before[f"{rel}|nologo"]))
        if before and f"{rel}|background" in before:  # And the generated background's colour, so the one it puts back is the one pushed
            meta = ArtworkFiles.metadata(title)
            meta.pop("background_color", None)
            if before[f"{rel}|background"]:
                meta["background_color"] = before[f"{rel}|background"]
            atomic_write(title / ".overlayrr.json", json.dumps(meta, indent=2).encode())
            self.generated(title, redraw=True)
        found = {}
        for folder, season, where in sections:
            try:
                found[where] = self.last_render(title, folder, season)
            except (ValueError, KeyError):  # Plex doesn't list that season (any more)
                found[where] = None
        if before is None and not any(found.values()):
            raise ValueError("Couldn't tell which files the last push used (the layout or settings may have changed since), "
                             "so nothing was changed. Pick the one you want, or push.")
        for folder, season, where in sections:
            for kind in ("poster",) if season is not None else ("poster", "logo"):  # Seasons use the series logo
                key, hit = f"{where}|{kind}", found[where]
                if before is not None and key not in before:
                    continue  # Not changed since the last push
                if hit and kind in hit:
                    chosen = hit[kind]
                elif hit:
                    continue  # The layout draws no logo, so whichever is there doesn't matter
                elif before is not None and before[key] and (folder / before[key]).is_file():
                    chosen = folder / before[key]
                else:
                    chosen = None
                current = ArtworkFiles.source(folder, kind)
                if chosen == current or (before is not None and before[key] and current and self.kept_name(current, kind) == before[key] and not hit):
                    continue  # Already in use
                self.swap(folder, kind, chosen)
        self.mark(rel, False)
        return {"warning": None}

    def add(self, rel, kind, data, use):
        """Save an uploaded or downloaded image as a candidate (poster-<hash>), optionally making it the one in use."""
        title, folder = self.locate(rel)
        if kind not in ("poster", "logo"):
            raise ValueError("Pick posters or logos")
        if kind == "logo" and folder != title:
            raise ValueError("Seasons use the series logo; change it on the series")
        suffix, warning = web_check_image(data, kind)
        stem = f"{kind}-{hashlib.sha256(data).hexdigest()[:8]}"
        saved = next(folder.glob(stem + ".*"), None)
        if saved is None:
            saved = folder / (stem + suffix)
            atomic_write(saved, data)
        selected = self.select(rel, kind, saved.name) if use else {}
        return {"name": saved.name, "warning": warning or selected.get("warning")}

    def remember(self, name, source):
        """Note where a file (poster-<hash>) came from: the online picture it was downloaded from, so the page shows it in
        that picture's place, a pasted link, or "own" for an upload or crop."""
        match = re.fullmatch(r"(?:poster|logo)-([0-9a-f]{8})\.\w+", str(name))
        if match and source:
            with self.lock:
                self.sources[match[1]] = source
                atomic_write(self.sources_file, json.dumps(self.sources).encode())

    def remove(self, rel, kind, name):
        self.picked(self.locate(rel)[1], kind, name, candidate=True).unlink()

    def key(self, rel):
        title = self.locate(rel)[1]
        key = web_meta(title).get("rating_key")
        if not key or not str(key).isdigit():
            raise ValueError(f"{title.name} has no Plex ID saved yet; run the script for it once first")
        return str(key)

    def push(self, ids):
        """The job each title's push runs: tk.box queues them and calls pushed() for each that succeeds."""
        ids = list(self.pending) if ids is None else ids
        if not ids:
            raise ValueError("Nothing to push")
        plex = read_config(self.config_path).get("plex", {})
        episodes = bool(plex.get("include_episodes"))
        # A new logo reaches every season and every episode card. --changed-only skips whatever didn't change,
        # so shows with title cards (turned on in the settings, or already rendered) always include them.
        return [{"id": rel, "title": self.pending.get(rel, {}).get("title") or web_meta(self.path(rel, (2,))).get("title") or Path(rel).name,
                 "args": ["--item", self.key(rel), "--changed-only"] + (["--with-seasons"] if rel.startswith("tv/") else [])
                 + (["--with-episodes"] if rel.startswith("tv/") and (episodes or any(self.path(rel, (2,)).glob("Season */Episode *"))) else [])}
                for rel in ids]

    def pushed(self, rel):
        self.mark(rel, False)
        return {}

    def state(self):
        return {"upload": bool(read_config(self.config_path).get("plex", {}).get("upload")), "pending": dict(self.pending)}

    def thumbnail(self, path, width):
        stat = path.stat()
        key = hashlib.sha256(f"{path}|{stat.st_mtime_ns}|{stat.st_size}|{width}".encode()).hexdigest()
        folder = self.cache / "thumbs"
        for suffix, kind in ((".jpg", "image/jpeg"), (".png", "image/png")):
            cached = folder / (key + suffix)
            if cached.is_file():
                with contextlib.suppress(OSError):
                    os.utime(cached)  # Still in use, so prune_cache keeps it
                    return cached.read_bytes(), kind
        with self.thumbing, Image.open(path) as image:
            image.draft("RGB", (width * 2, width * 4))
            image.thumbnail((width, width * 2))
            alpha = image.mode in ("RGBA", "LA", "PA") or "transparency" in image.info
            image = image.convert("RGBA" if alpha else "RGB")
        buffer = io.BytesIO()
        image.save(buffer, format="PNG" if alpha else "JPEG", **({} if alpha else {"quality": 82}))
        atomic_write(folder / (key + (".png" if alpha else ".jpg")), buffer.getvalue())
        return buffer.getvalue(), "image/png" if alpha else "image/jpeg"

    def template_merge(self, name, mode, values):
        """The layout with layout-editor settings saved into it (into season_options or episode_options for those modes),
        for tk.box to store; refused when a render would refuse it."""
        if not values:
            raise ValueError("Nothing to save")
        self.template_style(name, mode, values)
        layout = json.loads(json.dumps(self.template_config()[1]["layouts"][name]))
        section = TEMPLATE_SECTIONS[mode]
        (layout.setdefault(section, {}) if section else layout).update(card_values(values))
        return layout

    def find(self, rating_key):
        """The asset folder of a Plex title (movie, show or collection) by its rating key, or None before its first run."""
        key = str(rating_key)
        for category in WEB_CATEGORIES:
            for folder in (self.root / category).iterdir() if (self.root / category).is_dir() else ():
                if folder.is_dir() and str(web_meta(folder).get("rating_key")) == key:
                    return {"id": f"{category}/{folder.name}"}
        return {"id": None}


def worker_image(data, kind="image/jpeg", note=""):
    return {"image": base64.b64encode(data).decode("ascii"), "type": kind, **({"note": note} if note else {})}


def worker_width(params, low, high, default):
    return min(max(int(params.get("w") or default), low), high)


def worker_file(worker, params):
    path = worker.path(params.get("p"), (3, 4))
    if not path.is_file() or path.suffix.lower() not in ArtworkFiles.extensions:
        raise ValueError("Not an image")
    return worker_image(*worker.thumbnail(path, worker_width(params, 64, 2000, 400)))


def worker_plex_image(worker, params):
    data = worker.plex_get(str(params.get("p") or ""))
    try:
        with Image.open(io.BytesIO(data)) as image:
            kind = Image.MIME.get(image.format) or "application/octet-stream"
    except (OSError, SyntaxError):
        raise ValueError("Not an image") from None
    return worker_image(data, kind)


def worker_preview(worker, params):
    online = (params.get("kind"), params.get("url"), params.get("plex")) if params.get("url") or params.get("plex") else None
    return worker_image(worker.preview(params.get("id"), params.get("poster"), params.get("logo"), worker_width(params, 160, 640, 480), online))


def worker_import(worker, params):
    """A provider's picture, or one of Plex's own, saved into the title's folder (cropped from a backdrop when asked)."""
    image = worker.plex_get(str(params["plex"])) if params.get("plex") else web_download(str(params.get("url") or ""))
    if params.get("crop"):
        image = web_crop(image, params["crop"])
    added = worker.add(params.get("id"), params.get("kind"), image, bool(params.get("use")))
    worker.remember(added["name"], "own" if params.get("crop") else params.get("plex") or params.get("url"))  # A crop is a picture of your own
    return added


def worker_upload(worker, params):
    data = base64.b64decode(str(params.get("data") or ""), validate=True)
    if len(data) > WEB_UPLOAD_LIMIT:
        raise ValueError("That file is larger than 40 MB")
    added = worker.add(params.get("id"), params.get("kind"), data, bool(params.get("use")))
    worker.remember(added["name"], "own")
    return added


def worker_template_preview(worker, params):
    image, note = worker.template_preview(params.get("layout"), params.get("mode"), params.get("values") or {}, params.get("id"),
                                          worker_width(params, 160, 720, 480), str(params.get("banner") or ""))
    return worker_image(image, note=note)


WORKER_ROUTES = "/api/v1/admin/artwork"  # Where tk.box serves the images the worker's answers link to
WORKER_METHODS = {
    "titles": lambda w, p: {"titles": w.titles(), **w.state()},
    "state": lambda w, p: w.state(),
    "detail": lambda w, p: w.detail(p.get("id")),
    "find": lambda w, p: w.find(p.get("rating_key")),
    "live": lambda w, p: w.live(p.get("id")),
    "remote": lambda w, p: w.remote(p.get("id"), p.get("kind")),
    "preview": worker_preview,
    "file": worker_file,
    "plex_image": worker_plex_image,
    "select": lambda w, p: w.select(p.get("id"), p.get("kind"), p.get("name")),
    "no_logo": lambda w, p: w.choose_no_logo(p.get("id"), bool(p.get("on"))),
    "generated": lambda w, p: w.use_generated(p.get("id")),
    "background_color": lambda w, p: w.background_color(p.get("id"), p.get("color")),
    "import": worker_import,
    "upload": worker_upload,
    "discard": lambda w, p: w.discard(p.get("id")),
    "remove": lambda w, p: w.remove(p.get("id"), p.get("kind"), p.get("name")) or {},
    "push": lambda w, p: {"jobs": w.push(p.get("ids"))},
    "pushed": lambda w, p: w.pushed(p.get("id")),
    "clear": lambda w, p: w.drop_previews() or {},
    "template": lambda w, p: w.template(),
    "template_preview": worker_template_preview,
    "template_merge": lambda w, p: {"layout": w.template_merge(p.get("layout"), p.get("mode"), p.get("values") or {})},
}


def serve_worker(config_path):
    """--worker: answer tk.box's requests, one JSON object per line on stdin ({"id", "method", "params"}), with one JSON line
    each on stdout ({"id", "result"} or {"id", "error"}). Images come back base64-encoded. Requests run side by side; the
    worker's own locks keep renders to one at a time. It exits when tk.box closes stdin."""
    worker, out, out_lock = Worker(config_path), sys.stdout, threading.Lock()
    sys.stdout = sys.stderr  # Anything the engine prints goes to the log, never between replies

    def answer(request):
        reply = {"id": request.get("id")}
        try:
            method = WORKER_METHODS.get(request.get("method"))
            if method is None:
                raise ValueError("Unknown request")
            reply["result"] = method(worker, request.get("params") or {})
        except (ValueError, TypeError, KeyError, OSError, RuntimeError, ET.ParseError, binascii.Error) as error:
            reply["error"] = str(error) or type(error).__name__
        except Exception as error:  # Never take the worker down; tk.box shows the name
            reply["error"] = type(error).__name__
        line = json.dumps(reply, default=str)
        with out_lock:
            out.write(line + "\n")
            out.flush()

    out.write(json.dumps({"ready": True}) + "\n")
    out.flush()
    with ThreadPoolExecutor(4) as pool:
        for line in sys.stdin:
            try:
                request = json.loads(line)
            except ValueError:
                continue
            if isinstance(request, dict):
                pool.submit(answer, request)
    return 0


def count_or_all(value):
    if value.lower() == "all":
        return "all"
    if not value.isdigit() or int(value) < 1:
        raise argparse.ArgumentTypeError("use a positive number or 'all'")
    return int(value)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("config", type=Path, help="The JSON config tk.box writes for the run")
    parser.add_argument("--refetch", action="store_true", help="Ignore cached API responses and downloaded images, and delete the selected titles' saved poster/logo files so new ones are picked and downloaded (your own files in those folders go too)")
    parser.add_argument("--refresh", action="store_true", help="Upload everything selected to Plex again (reuses current rendered files; needs plex.upload: true)")
    parser.add_argument("--changed-only", action="store_true", help="Rebuild/upload only items with changed source files or settings")
    selector = parser.add_mutually_exclusive_group()
    selector.add_argument("--item", type=int, metavar="PLEX_ID", help="Process one movie/show by its Plex rating key")
    selector.add_argument("--title", help="Process one movie/show by exact title (case-insensitive)")
    parser.add_argument("--type", dest="media_type", choices=("movie", "show", "collection"), help="Restrict the selected item's media type")
    parser.add_argument("--year", type=int, help="Restrict the selected item's release year")
    parser.add_argument("--remake", dest="force", action="store_true", help="Re-render everything selected (whole library, or one title with --item/--title) even if unchanged, bypassing --changed-only; saved source files are kept")
    parser.add_argument("--with-seasons", action="store_true", help="Also process the selected show's season posters")
    parser.add_argument("--with-episodes", action="store_true", help="Also make title cards for the selected show's episodes")
    parser.add_argument("--import-posters", dest="import_posters", nargs="?", const=Path("-"), type=Path, metavar="YAML",
                        help="Save the poster URLs in a Kometa/MediUX metadata YAML into your titles' asset folders as poster files (replacing saved ones); renders nothing. Give a file, or no file to paste the YAML in")
    parser.add_argument("--poster", type=count_or_all, metavar="N|all",
                        help="With --item/--title: only download the N best (or all) extra posters allowed by the layout as poster2, poster3... in the title's folder")
    parser.add_argument("--poster-filter", choices=("all", "textless", "text"), help="With --poster: which posters to download, instead of the layout's poster_filter (all = with or without text)")
    parser.add_argument("--logo", "--icons", dest="icons", type=count_or_all, metavar="N|all",
                        help="With --item/--title: only download the N best (or all) extra logos allowed by the layout as logo2, logo3... in the title's folder")
    parser.add_argument("--season", type=int, help="With --with-episodes: only this season's episodes (no show/season posters)")
    parser.add_argument("--episode", type=int, help="With --with-episodes: only this episode number (no show/season posters)")
    parser.add_argument("--added", action="store_true", help="For a newly added title (Tautulli/Plex hook): with --item/--title, build and send only what Plex doesn't have yet. --item takes a movie's, show's, season's or episode's own key. A show Plex has no poster for gets everything; a known show gets just --season/--season --episode. Waits if another run is active")
    parser.add_argument("--limit", type=int, help="Process only the first N items")
    parser.add_argument("--check", action="store_true", help="Only validate the config and its layouts, then exit (tk.box runs this before saving)")
    parser.add_argument("--worker", action="store_true", help="Answer tk.box's Admin › Artwork requests on stdin until it closes (see serve_worker)")
    args = parser.parse_args()
    if args.check:
        try:
            read_config(args.config)
        except (OSError, ValueError, TypeError) as error:
            print(f"ERROR: {error}", file=sys.stderr)
            return 1
        print("Config OK")
        return 0
    if args.worker:
        if hasattr(os, "nice"):
            with contextlib.suppress(OSError):
                os.nice(5)  # Previews are interactive, so less than a job's 10; streaming still comes first
        try:
            return serve_worker(args.config)
        except (OSError, ValueError, TypeError) as error:
            print(json.dumps({"ready": False, "error": str(error)}), flush=True)
            return 1
    if hasattr(os, "nice"):
        with contextlib.suppress(OSError):
            os.nice(10)  # Plex, its transcoder and anyone else on the machine come first; web pushes inherit this
    if args.limit is not None and args.limit < 1:
        parser.error("--limit must be positive")
    if args.import_posters:
        busy = [flag for flag, value in (("--item", args.item), ("--title", args.title), ("--type", args.media_type), ("--year", args.year),
                                          ("--remake", args.force), ("--with-seasons", args.with_seasons), ("--with-episodes", args.with_episodes),
                                          ("--poster", args.poster), ("--logo", args.icons), ("--season", args.season), ("--episode", args.episode),
                                          ("--limit", args.limit), ("--changed-only", args.changed_only),
                                          ("--refresh", args.refresh), ("--refetch", args.refetch)) if value]
        if busy:
            parser.error(f"--import-posters runs on its own and can't be combined with {', '.join(busy)}")
        try:
            with run_lock(args.config):
                return import_posters(args.config, args.import_posters)
        except (OSError, ValueError, TypeError, RuntimeError, yaml.YAMLError) as error:
            print(f"ERROR: {error}", file=sys.stderr)
            return 1
    try:
        with run_lock(args.config):
            return run(args.config, refetch=args.refetch, refresh=args.refresh, changed_only=args.changed_only, limit=args.limit,
                       rating_key=args.item, title=args.title, media_type=args.media_type, year=args.year,
                       force=args.force, with_seasons=args.with_seasons, with_episodes=args.with_episodes,
                       season=args.season, episode=args.episode, posters=args.poster, icons=args.icons, added=args.added, poster_filter=args.poster_filter)
    except (OSError, ValueError, TypeError, RuntimeError, ET.ParseError, yaml.YAMLError) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
