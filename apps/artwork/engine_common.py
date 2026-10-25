"""What tk.box's artwork engine (overlayrr.py) and collections engine (plex_collections.py) share: the config and its
defaults, the HTTP cache, the Plex client, TMDb and TVDB lookups, the public-link downloader and the run lock.

Nothing here draws or decodes an image, so the collections engine runs without Pillow or NumPy loaded. Requires
requests and urllib3.
"""

import contextlib
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import re
import socket
import tempfile
import threading
import time
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import urljoin, urlparse
import xml.etree.ElementTree as ET

import requests
from requests.adapters import HTTPAdapter
import urllib3
from urllib3.util.retry import Retry


TMDB = "https://api.themoviedb.org/3"
TVDB = "https://api4.thetvdb.com/v4"
FANART = "https://webservice.fanart.tv/v3"
IMAGE_BASE = "https://image.tmdb.org/t/p/original"

RESOLUTIONS = ("480p", "576p", "720p", "1080p", "4k")  # ascending
PLEX_RESOLUTIONS = {"sd": "480p", "480": "480p", "576": "576p", "720": "720p", "1080": "1080p", "4k": "4k"}

# Settings left out of the config, top level and under plex: (no name is used in both).
DEFAULTS = {"assets_dir": "assets", "cache_dir": ".cache", "workers": 2, "quality": 95, "language": "en", "missing_art": "stock",
            "overlay_marker": True, "completion_label": "Overlayrr", "collection_min_items": 2, "collection_sync": "sync",
            "franchise_collections": True, "collection_streaming": "off", "collection_region": "US", "recent_movie_days": 90, "recent_episode_days": 7,
            "cleanup_min_age_minutes": 60, "upload_logo": True, "collections":[{'name': 'Halloween - All-Time Classics',
  'library': 'Movies',
  'type': 'movie',
  'enabled': False,
  'schedule': '10/01-10/31',
  'members': [{'title': 'Halloween', 'year': 1978},
              {'title': 'The Exorcist', 'year': 1973},
              {'title': 'Psycho', 'year': 1960},
              {'title': 'Alien', 'year': 1979},
              {'title': 'The Shining', 'year': 1980},
              {'title': 'The Thing', 'year': 1982},
              {'title': 'Night of the Living Dead', 'year': 1968},
              {'title': 'Poltergeist', 'year': 1982},
              {'title': 'A Nightmare on Elm Street', 'year': 1984},
              {'title': 'The Texas Chain Saw Massacre', 'year': 1974},
              {'title': 'Scream', 'year': 1996},
              {'title': 'The Blair Witch Project', 'year': 1999},
              {'title': 'The Conjuring', 'year': 2013},
              {'title': 'The Witch', 'year': 2015},
              {'title': "Trick 'r Treat", 'year': 2007},
              {'title': 'Get Out', 'year': 2017},
              {'title': 'Hereditary', 'year': 2018},
              {'title': 'The Ring', 'year': 2002},
              {'title': 'An American Werewolf in London', 'year': 1981},
              {'title': 'The Fly', 'year': 1986},
              {'title': 'Hocus Pocus', 'year': 1993},
              {'title': 'The Nightmare Before Christmas', 'year': 1993},
              {'title': 'Beetlejuice', 'year': 1988},
              {'title': 'Ghostbusters', 'year': 1984},
              {'title': 'The Addams Family', 'year': 1991},
              {'title': 'The Witches', 'year': 1990},
              {'title': 'Halloweentown', 'year': 1998},
              {'title': 'Casper', 'year': 1995},
              {'title': 'E.T. the Extra-Terrestrial', 'year': 1982},
              {'title': 'Coraline', 'year': 2009}],
  'sync': 'append',
  'visibility': {'home': True, 'shared': True, 'recommended': True},
  'acquire': False,
  'cleanup': 'keep'},
 {'name': 'Thanksgiving - Classics & Comforts',
  'library': 'Movies',
  'type': 'movie',
  'enabled': False,
  'schedule': '11/01-11/30',
  'members': [{'title': 'Planes, Trains and Automobiles', 'year': 1987},
              {'title': 'Home for the Holidays', 'year': 1995},
              {'title': 'Pieces of April', 'year': 2003},
              {'title': 'The Ice Storm', 'year': 1997},
              {'title': 'Dutch', 'year': 1991},
              {'title': 'Hannah and Her Sisters', 'year': 1986},
              {'title': 'Prisoners', 'year': 2013},
              {'title': 'Scent of a Woman', 'year': 1992},
              {'title': 'Spider-Man', 'year': 2002},
              {'title': 'Rocky', 'year': 1976},
              {'title': 'Tower Heist', 'year': 2011},
              {'title': 'Addams Family Values', 'year': 1993},
              {'title': 'Free Birds', 'year': 2013},
              {'title': 'Son in Law', 'year': 1993},
              {'title': 'Meet the Parents', 'year': 2000},
              {'title': "You've Got Mail", 'year': 1998},
              {'title': 'Knives Out', 'year': 2019},
              {'title': 'Fantastic Mr. Fox', 'year': 2009},
              {'title': 'Rudy', 'year': 1993},
              {'title': 'Mrs. Doubtfire', 'year': 1993},
              {'title': 'The Blind Side', 'year': 2009},
              {'title': 'The Big Chill', 'year': 1983},
              {'title': 'Love at the Thanksgiving Day Parade', 'year': 2012},
              {'title': 'A Family Thanksgiving', 'year': 2010},
              {'title': 'Pumpkin Pie Wars', 'year': 2016},
              {'title': 'An Old Fashioned Thanksgiving', 'year': 2008},
              {'title': 'The Thanksgiving House', 'year': 2013}],
  'sync': 'append',
  'visibility': {'home': True, 'shared': True, 'recommended': True},
  'acquire': False,
  'cleanup': 'keep'},
 {'name': 'Christmas - All-Time Classics',
  'library': 'Movies',
  'type': 'movie',
  'enabled': False,
  'schedule': '12/01-12/31',
  'members': [{'title': "It's a Wonderful Life", 'year': 1946},
              {'title': 'Miracle on 34th Street', 'year': 1947},
              {'title': 'White Christmas', 'year': 1954},
              {'title': 'A Christmas Story', 'year': 1983},
              {'title': "National Lampoon's Christmas Vacation", 'year': 1989},
              {'title': 'Home Alone', 'year': 1990},
              {'title': 'Home Alone 2: Lost in New York', 'year': 1992},
              {'title': 'Elf', 'year': 2003},
              {'title': 'The Muppet Christmas Carol', 'year': 1992},
              {'title': 'The Santa Clause', 'year': 1994},
              {'title': 'How the Grinch Stole Christmas!', 'year': 1966},
              {'title': 'How the Grinch Stole Christmas', 'year': 2000},
              {'title': 'A Charlie Brown Christmas', 'year': 1965},
              {'title': 'Rudolph the Red-Nosed Reindeer', 'year': 1964},
              {'title': 'Frosty the Snowman', 'year': 1969},
              {'title': 'Gremlins', 'year': 1984},
              {'title': 'Die Hard', 'year': 1988},
              {'title': 'Love Actually', 'year': 2003},
              {'title': 'The Nightmare Before Christmas', 'year': 1993},
              {'title': 'Arthur Christmas', 'year': 2011},
              {'title': 'Klaus', 'year': 2019},
              {'title': 'The Polar Express', 'year': 2004},
              {'title': 'Deck the Halls', 'year': 2006},
              {'title': 'Edward Scissorhands', 'year': 1990},
              {'title': 'The Holdovers', 'year': 2023},
              {'title': 'Little Women', 'year': 1994},
              {'title': 'Bad Santa', 'year': 2003},
              {'title': 'Jingle All the Way', 'year': 1996},
              {'title': 'Scrooged', 'year': 1988},
              {'title': 'The Christmas Chronicles', 'year': 2018}],
  'sync': 'append',
  'visibility': {'home': True, 'shared': True, 'recommended': True},
  'acquire': False,
  'cleanup': 'keep'}], "search": False, "collection_source_limit": 50, "collection_source_refresh": True}


SHOW_FIELDS = ("type", "title", "year", "tmdb_id", "tvdb_id", "imdb_id", "layout", "library", "logo")  # Seasons/episodes inherit these
# ImageMaid/Overlay-Reset recognize overlay posters by this EXIF tag (0x04bc == "overlay"), so tagging ours lets
# ImageMaid's --overlays-only remove only our orphaned posters from Plex.
OVERLAY_EXIF_TAG, OVERLAY_EXIF_VALUE = 0x04BC, "overlay"
# plex_cleanup.py only touches posters that also say they are ours (EXIF Software tag); Kometa's overlays carry just the one above.
SOFTWARE_EXIF_TAG, SOFTWARE_EXIF_VALUE = 0x0131, "Overlayrr"
# Cache lifetimes. API answers go stale in a day; downloaded images only need to last between nearby runs, because the
# artwork a title uses is saved in assets/ anyway. Full runs delete what has expired (prune_cache).
JSON_TTL, IMAGE_TTL, THUMB_TTL = 86400, 7 * 86400, 30 * 86400


def atomic_write(path, data):
    """Never leave a half-written poster or cache file after an interruption."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as handle:
        temporary = Path(handle.name)
        try:
            handle.write(data)
        except BaseException:
            handle.close()
            temporary.unlink(missing_ok=True)
            raise
    try:
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


ENGINE_DIR = Path(__file__).resolve().parent


def local_path(value, base):
    """Paths in the config are relative to its folder, except the bundled resources/, which ship beside this script."""
    path = Path(value)
    if not path.is_absolute() and path.parts[:1] == ("resources",):
        return (ENGINE_DIR / path).resolve()
    return (base / path).resolve()


def is_url(value):
    """A web address rather than a local file path."""
    return urlparse(str(value)).scheme in ("http", "https")


def option(settings, name):
    """A setting from the config (or its plex mapping), or its default."""
    return settings.get(name, DEFAULTS[name])


def secret(value):
    """Support literal secrets or ${ENV_VAR}; missing variables disable that API."""
    return re.sub(r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}",
                  lambda match: os.environ.get(match[1], ""), str(value or ""))


class HTTP:
    """Per-worker connection pools and a disk cache shared between runs."""

    def __init__(self, cache, refresh=False):
        self.cache = cache
        self.refresh = refresh
        self.local = threading.local()
        self.locks = [threading.Lock() for _ in range(64)]
        # Parsed JSON recently used in this run: one item asks for the same TMDb details several times, close together.
        # Kept small: a parsed TVDB or TMDb record with all its artwork can take a few MB.
        self.parsed, self.parsed_lock = OrderedDict(), threading.Lock()

    def session(self):
        if not hasattr(self.local, "session"):
            session = requests.Session()
            retry = Retry(total=3, backoff_factor=0.5,
                          status_forcelist=[429, 500, 502, 503, 504],
                          allowed_methods=["GET"], respect_retry_after_header=True)
            for scheme in ("http://", "https://"):
                session.mount(scheme, HTTPAdapter(max_retries=retry))
            session.headers["User-Agent"] = "Overlayrr-Standalone/1.0"
            self.local.session = session
        return self.local.session

    def request(self, method, url, **kwargs):
        # Exception strings from requests can contain API keys in query strings.
        try:
            response = self.session().request(method, url, timeout=(10, 30), **kwargs)
        except requests.RequestException as error:
            raise RuntimeError(f"{urlparse(url).hostname}: {type(error).__name__}") from None
        if not response.ok:
            status = response.status_code
            response.close()
            raise RuntimeError(f"{urlparse(url).hostname}: HTTP {status}")
        return response

    def get(self, url, *, params=None, headers=None, ttl=None, cache_scope=None):
        if ttl is None:
            with self.request("GET", url, params=params, headers=headers) as response:
                return response.content
        digest = self.digest(url, params, headers, cache_scope)
        path = self.cache / digest
        with self.locks[int(digest[:4], 16) % len(self.locks)]:
            data = self.hit(path, ttl)
            if data is None:
                with self.request("GET", url, params=params, headers=headers) as response:
                    data = response.content
                atomic_write(path, data)
            return data

    def hit(self, path, ttl):
        """Cached bytes younger than `ttl` seconds, or None."""
        try:
            if not self.refresh and time.time() - path.stat().st_mtime < ttl:
                return path.read_bytes()
        except OSError:
            pass
        return None

    @staticmethod
    def digest(url, params, headers, cache_scope):
        # Hash credentials too, so two accounts cannot share private cached responses.
        identity = json.dumps([url, params, headers if cache_scope is None else cache_scope], sort_keys=True)
        return hashlib.sha256(identity.encode()).hexdigest()

    def recall(self, key):
        with self.parsed_lock:
            if self.refresh or key not in self.parsed:
                return None
            self.parsed.move_to_end(key)
            return self.parsed[key]

    def remember(self, key, data):
        with self.parsed_lock:
            self.parsed[key] = data
            while len(self.parsed) > 32:
                self.parsed.popitem(last=False)
        return data

    def json(self, url, *, params=None, headers=None, cache_scope=None, stale=None):
        """Shared read-only responses; `stale` can reject disk data before its normal TTL expires."""
        key = self.digest(url, params, headers, cache_scope)
        data = self.recall(key)
        if data is None:
            raw = self.hit(self.cache / key, JSON_TTL) if stale else None
            if raw is not None:
                data = json.loads(raw)
                if stale(data):
                    data = None
            if data is None:
                data = json.loads(self.get(url, params=params, headers=headers, ttl=0 if raw is not None else JSON_TTL, cache_scope=cache_scope))
            self.remember(key, data)
        return data

    def cached_json(self, url, *, cache_scope, stale=None):
        """What json(url, cache_scope=...) would return from memory or disk, or None; never goes to the network."""
        key = self.digest(url, None, None, cache_scope)
        data = self.recall(key)
        if data is None:
            raw = self.hit(self.cache / key, JSON_TTL)
            if raw is not None:
                data = json.loads(raw)
                if stale and stale(data):
                    return None
                self.remember(key, data)
        return data




def best_resolution(values):
    found = [PLEX_RESOLUTIONS[value.lower()] for value in values if value and value.lower() in PLEX_RESOLUTIONS]
    return max(found, key=RESOLUTIONS.index, default=None)


def plex_media(element):
    """What badges need from a Plex listing entry: score, file paths and video resolution."""
    media = {"files": [part.get("file") for part in element.iter("Part") if part.get("file")],
             "resolution": best_resolution(m.get("videoResolution") for m in element.findall("Media"))}
    try:
        media["audience"] = float(element.get("audienceRating"))
    except (TypeError, ValueError):
        pass
    try:
        media["added"] = int(element.get("addedAt"))
    except (TypeError, ValueError):
        pass
    return media


def plex_item(element):
    item = {"type": {"show": "tv", "collection": "collection"}.get(element.get("type"), "movie"),
            "rating_key": element.get("ratingKey"), "title": element.get("title", ""),
            "genres": [g.get("tag", "") for g in element.findall("Genre")],
            "year": element.get("year", ""), "thumb": element.get("thumb"), "media": plex_media(element)}
    guids = [element.get("guid", "")] + [g.get("id", "") for g in element.findall("Guid")]
    for guid in guids:
        match = re.search(r"(?:tmdb|themoviedb)://(\d+)", guid)
        if match:
            item["tmdb_id"] = int(match[1])
        match = re.search(r"(?:tvdb|thetvdb)://(\d+)", guid)
        if match:
            item["tvdb_id"] = int(match[1])
        match = re.search(r"imdb://(tt\d+)", guid)
        if match:
            item["imdb_id"] = match[1]
    return item


# Streaming services as Kometa's streaming default lists them: collection name, TMDb watch-provider IDs, the network
# names TMDb uses for the service's own shows, and the glow color of its collection poster. Region-specific services
# are left out. Logos come from Kometa's public Default-Images repo, which files them under these names.
STREAMING = (("Netflix", (8,), ("Netflix",), "#5a0a0f"), ("Disney+", (337,), ("Disney+",), "#0d2f86"),
             ("Hulu", (15,), ("Hulu",), "#0c8f4f"),
             ("Prime Video", (9,), ("Prime Video", "Amazon", "Amazon Prime Video"), "#0b6b7d"),
             ("HBO Max", (1899,), ("HBO Max", "Max"), "#4a1470"), ("Apple TV", (350,), ("Apple TV+", "Apple TV"), "#333333"),
             ("Paramount+", (531, 1770), ("Paramount+", "Paramount Plus"), "#1f55b0"), ("Peacock", (387,), ("Peacock",), "#9a2a14"),
             ("discovery+", (510,), ("discovery+",), "#1c4fd0"), ("Crunchyroll", (283,), ("Crunchyroll",), "#c85a00"),
             ("AMC+", (528, 1854), ("AMC+",), "#1a4aa8"), ("BET+", (1759,), ("BET+",), "#6a1a9a"), ("hayu", (223,), ("hayu",), "#b0126f"),
             ("YouTube", (188,), ("YouTube",), "#8a0a0a"), ("Tubi", (73,), ("Tubi",), "#4a2a9a"))


STREAMING_LOGOS = "https://raw.githubusercontent.com/Kometa-Team/Default-Images/master/streaming/logos/"
# Kometa's two "basic" chart collections, as Plex smart collections: library kind, name, Plex type, date field, days back.
# Newly Released is movies released in the last 90 days; New Episodes is TV episodes aired in the last 7.
CHARTS = (("movie", "Newly Released", 1, "originallyAvailableAt", 90), ("show", "New Episodes", 4, "episode.originallyAvailableAt", 7))


def network_key(name):
    return re.sub(r"[^a-z0-9]", "", str(name or "").casefold().replace("+", "plus"))


def streaming_services(data, mode, region):
    """Streaming services for one TMDb show (fetched with append_to_response=watch/providers): those it originally
    aired on (mode "originals") or is streaming on now, free or subscription, in `region` (mode "available")."""
    if mode == "originals":
        networks = {network_key(network.get("name")) for network in data.get("networks") or []}
        return [name for name, _, aliases, _ in STREAMING if networks & {network_key(alias) for alias in aliases}]
    offers = ((data.get("watch/providers") or {}).get("results") or {}).get(region) or {}
    ids = {provider.get("provider_id") for kind in ("flatrate", "free", "ads") for provider in offers.get(kind) or []}
    return [name for name, providers, _, _ in STREAMING if ids & set(providers)]


def collection_key(name):
    """Names compare equal across Kometa's and TMDb's spellings: case, punctuation and a trailing "Collection" ignored."""
    return re.sub(r"[^a-z0-9]", "", re.sub(r"\s+collection$", "", str(name or "").strip().casefold()))


def chart_title(kind, title):
    """"Newly Released" in a movie library, or "New Episodes" in a TV one; else None."""
    return next((name for chart_kind, name, *_ in CHARTS if chart_kind == kind and collection_key(title) == collection_key(name)), None)


def streaming_service(title):
    """The streaming service a TV collection is named for ("Netflix Shows"), else None."""
    return next((name for name, _, _, _ in STREAMING if collection_key(title) == collection_key(f"{name} Shows")), None)


def custom_collection(item, config):
    return item.get("type") == "collection" and any(
        entry.get("enabled", True) and entry["library"] == item.get("library")
        and collection_key(entry["name"]) == collection_key(item.get("title"))
        for entry in option(config, "collections"))


class Plex:
    """The Plex server: library listings, collection listings, posters and labels. Its answers are never cached.
    Making and changing collections is plex_collections.py's."""

    def __init__(self, http, config):
        self.http, self.settings = http, config.get("plex", {})
        self.config = config
        self.url = str(self.settings.get("url", "")).rstrip("/")
        self.headers = {"X-Plex-Token": secret(self.settings.get("token", os.environ.get("PLEX_TOKEN", "")))}
        self.resolutions = {}  # Show rating key -> best episode resolution, noted while listing its episodes

    @property
    def configured(self):
        return bool(self.url and self.headers["X-Plex-Token"])

    def require(self, purpose):
        if not self.configured:
            raise ValueError(f"{purpose} needs plex.url and plex.token (or PLEX_TOKEN)")

    def xml(self, path, params=None):
        """Plex's XML answer for `path` (never cached)."""
        return ET.fromstring(self.http.get(self.url + path, params=params, headers=self.headers))

    def send(self, method, path, params=None):
        """A request that changes something in Plex."""
        with self.http.request(method, self.url + path, headers=self.headers, params=params):
            pass

    def pages(self, path, keep, params=None, size=200):
        """(page, entries) of a paged Plex listing, where entries are the page's elements that pass `keep`."""
        start = 0
        while True:
            page = self.xml(path, {**(params or {}), "X-Plex-Container-Start": start, "X-Plex-Container-Size": size})
            if not len(page):
                return
            yield page, [e for e in page if keep(e)]
            start += len(page)  # Everything Plex sent, kept or not, or the next page would overlap this one
            if start >= int(page.get("totalSize", page.get("size", len(page)))):
                return

    def scan(self, media_type=None):
        libraries = self.settings.get("libraries", [])
        if not libraries:
            return []
        self.require("Reading Plex libraries")
        sections = self.xml("/library/sections").findall("Directory")
        available = ", ".join(f"{section.get('title')} (ID {section.get('key')}, {section.get('type')})" for section in sections) or "none"
        items = []
        selected = set()
        for name in libraries:
            section = next((s for s in sections if str(name) in (s.get("key"), s.get("title"))), None)
            if section is None or section.get("type") not in ("movie", "show"):
                # A typed lookup shouldn't depend on unrelated or obsolete names
                # in the batch list. Batch runs still validate every library.
                if media_type is not None:
                    continue
                raise ValueError(f"No movie/TV Plex library found for {name!r}. Available libraries: {available}")
            if media_type is not None and section.get("type") != media_type:
                continue
            library_id = section.get("key")
            if library_id in selected:
                continue
            selected.add(library_id)
            for _, entries in self.pages(f"/library/sections/{library_id}/all", lambda e: e.tag in ("Video", "Directory")
                                              and e.get("type") in ("movie", "show"), {"includeGuids": 1}):
                items.extend({**plex_item(e), "library": section.get("title")} for e in entries)
        if media_type is not None and not selected:
            raise ValueError(f"No configured {media_type} Plex library was found. Available libraries: {available}")
        return items

    def sections(self, kind="movie"):
        """(key, title) of the configured libraries of one type (movie or show)."""
        libraries = {str(name) for name in self.settings.get("libraries", [])}
        if not libraries:
            return []
        self.require("Reading Plex libraries")
        return [(section.get("key"), section.get("title")) for section in self.xml("/library/sections").findall("Directory")
                if section.get("type") == kind and libraries & {section.get("key"), section.get("title")}]

    def gone(self, rating_key):
        """Whether Plex has no item with this ID (it answers 404). Any other trouble is an error, not an answer."""
        try:
            self.xml(f"/library/metadata/{rating_key}")
        except RuntimeError as error:
            if "HTTP 404" in str(error):
                return True
            raise
        return False

    def collection_entries(self, section_key):
        """Every collection in one library, whatever it holds, read page by page and never cached."""
        for _, entries in self.pages(f"/library/sections/{section_key}/collections",
                                          lambda e: e.tag == "Directory" and e.get("type") == "collection"):
            yield from entries

    def collections(self, kind="movie"):
        """Collections in the configured libraries of one type. Posters are only made for movie collections (TMDb has
        no TV ones); show collections are listed so the builder can find the ones that already exist."""
        items = []
        for key, title in self.sections(kind):
            for e in self.collection_entries(key):
                # A TV library's collections hold shows, seasons or episodes ("New Episodes" is a collection of episodes)
                if kind == "show" or e.get("subtype", kind) == kind:
                    chart = chart_title(kind, e.get("title"))
                    items.append({**plex_item(e), "library": title, "smart": e.get("smart") == "1", **({"chart": chart} if chart else {})})
        return items

    def poster_collections(self):
        """Collections that get Overlayrr posters: every movie collection, plus the TV collections named for a streaming
        service (service) or "New Episodes" (chart), whether Overlayrr or Kometa made them."""
        shows = []
        for collection in self.collections("show"):
            service = streaming_service(collection["title"])
            if service or collection.get("chart") or custom_collection(collection, self.config):
                shows.append({**collection, **({"service": service} if service else {})})
        return self.collections() + shows

    def get_item(self, rating_key):
        """Direct Plex lookup for a targeted run, without scanning the library."""
        self.require("Looking up a Plex item")
        root = self.xml(f"/library/metadata/{rating_key}", {"includeGuids": 1})
        entry = next((entry for entry in root if entry.get("ratingKey") == str(rating_key)), None)
        if entry is None:
            raise ValueError(f"Plex item {rating_key} was not found")
        if entry.tag not in ("Video", "Directory") or entry.get("type") not in ("movie", "show", "collection"):
            raise ValueError(f"Plex item {rating_key} is not a movie, show or collection")
        subtype = entry.get("subtype", "movie")
        subtype = "show" if subtype in ("show", "season", "episode") else subtype  # "New Episodes" holds episodes
        service = streaming_service(entry.get("title")) if subtype == "show" else None
        chart = chart_title(subtype, entry.get("title")) if entry.get("type") == "collection" else None
        if entry.get("type") == "collection" and subtype != "movie" and not (service or chart or custom_collection({"type": "collection", "title": entry.get("title"),
                "library": entry.get("librarySectionTitle") or root.get("librarySectionTitle")}, self.config)):
            raise ValueError(f"Plex item {rating_key} is a TV collection; only movie, configured custom, streaming-service and New Episodes collections are supported")
        item = plex_item(entry)
        if service:
            item["service"] = service
        if chart:
            item["chart"] = chart
        library = entry.get("librarySectionTitle") or root.get("librarySectionTitle")
        if library:
            item["library"] = library
        return item

    @staticmethod
    def child(show, element, **fields):
        """A season or episode item: the show's IDs and layout, plus its own fields."""
        return {**{key: show[key] for key in SHOW_FIELDS if key in show}, "rating_key": element.get("ratingKey"),
                "parent_rating_key": show["rating_key"], "thumb": element.get("thumb"), **fields}

    def seasons(self, show):
        return [self.child(show, season, season=int(season.get("index")), season_title=season.get("title", ""))
                for season in self.xml(f"/library/metadata/{show['rating_key']}/children").findall("Directory")
                if season.get("type") == "season" and season.get("index") is not None]

    def episodes(self, show):
        """Every episode of a show from Plex (one paged request), inheriting the show's IDs and layout."""
        items, resolutions = [], []
        for page, entries in self.pages(f"/library/metadata/{show['rating_key']}/allLeaves", lambda e: e.tag == "Video", size=500):
            resolutions += [media.get("videoResolution") for media in page.iter("Media")]
            items += [self.child(show, episode, season=int(episode.get("parentIndex")), episode=int(episode.get("index")),
                                 episode_title=episode.get("title", ""))
                      for episode in entries if episode.get("type") == "episode"
                      and episode.get("parentIndex") is not None and episode.get("index") is not None]
        self.resolutions[str(show["rating_key"])] = best_resolution(resolutions)
        return items

    def show_resolution(self, rating_key):
        """Plex has no resolution on a series; use the best one among its episodes."""
        if str(rating_key) in self.resolutions:  # Its episodes were already listed in this run
            return self.resolutions[str(rating_key)]
        leaves = self.xml(f"/library/metadata/{rating_key}/allLeaves", {"X-Plex-Container-Start": 0, "X-Plex-Container-Size": 500})
        return best_resolution(m.get("videoResolution") for m in leaves.iter("Media"))

    def photos(self, rating_key, endpoint):
        """Images Plex itself lists for an item ("posters" or "arts" for backdrops): its agents' and anything uploaded."""
        if not self.configured or not rating_key:
            return []
        photos = []
        for photo in self.xml(f"/library/metadata/{rating_key}/{endpoint}").iter("Photo"):
            key, thumb = photo.get("key") or "", photo.get("thumb") or ""
            # Plex gives agent images as their public URL; its own copies as a server path that needs the token.
            path = key if key.startswith("/") else thumb
            if is_url(key):
                photos.append({"url": key, "language": None, "has_text": None, "width": 0})
            elif path.startswith("/"):
                photos.append({"url": self.url + path, "language": None, "has_text": None, "width": 0,
                               "headers": self.headers})
        return photos

    def upload(self, item, payload, content_type):
        if not item.get("rating_key"):
            raise ValueError("Plex upload requires rating_key")
        headers = {**self.headers, "Content-Type": content_type}
        with self.http.request("POST", f"{self.url}/library/metadata/{item['rating_key']}/posters",
                               headers=headers, data=payload):
            pass

    def upload_logo(self, item, payload, content_type):
        """Make `payload` the item's clear logo in Plex and select it. Plex names an upload by its SHA-1, so a logo it
        already has is only selected, not uploaded again."""
        path = f"/library/metadata/{item['rating_key']}/clearLogos"
        name = "/" + hashlib.sha1(payload).hexdigest()
        find = lambda: next((key for key in (photo.get("ratingKey") or "" for photo in self.xml(path).findall("Photo"))
                             if key.startswith("upload://") and key.endswith(name)), None)
        found = find()
        if not found:
            with self.http.request("POST", self.url + path, headers={**self.headers, "Content-Type": content_type}, data=payload):
                pass
            found = find()
        if found:  # Otherwise Plex selected the upload itself
            self.send("PUT", f"/library/metadata/{item['rating_key']}/clearLogo", {"url": found})

    @staticmethod
    def label_kind(item):
        return {"movie": "movie", "collection": "collection"}.get(item["type"]) or ("season" if item.get("season") is not None else "show")

    def labels(self, item):
        """The item's labels as Plex has them right now."""
        kind = self.label_kind(item)
        entry = next((entry for entry in self.xml(f"/library/metadata/{item['rating_key']}")
                      if entry.get("ratingKey") == str(item["rating_key"]) and entry.get("type") == kind), None)
        if entry is None:
            raise ValueError(f"Plex metadata did not contain the requested {kind} {item['rating_key']}; labels were not changed")
        return [entry.get("tag") for entry in entry.findall("Label") if entry.get("tag")]

    def labelled(self, item):
        """Whether Plex already carries the completion label (either kind) on this item, which means its poster went up."""
        label = option(self.settings, "completion_label").strip().casefold()
        return bool(label) and bool({label, f"{label}: stock"} & {tag.casefold() for tag in self.labels(item)})

    def added_target(self, rating_key):
        """What a newly added Plex item stands for, as (show or movie key, season, episode): a season or an episode becomes
        its show's key with its numbers, so one hook can pass any media's own key. Anything else comes back unchanged."""
        self.require("Looking up a Plex item")
        entry = next((entry for entry in self.xml(f"/library/metadata/{rating_key}") if entry.get("ratingKey") == str(rating_key)), None)
        kind = entry.get("type") if entry is not None else None
        try:
            if kind == "season":
                return int(entry.get("parentRatingKey")), int(entry.get("index")), None
            if kind == "episode":
                return int(entry.get("grandparentRatingKey")), int(entry.get("parentIndex")), int(entry.get("index"))
        except (TypeError, ValueError):
            raise ValueError(f"Plex did not say which show {kind} {rating_key} belongs to") from None
        return rating_key, None, None

    def mark_uploaded(self, item, stock=False):
        """Record the uploaded result in Plex, preserving all unrelated labels."""
        label = option(self.settings, "completion_label").strip()
        if not label:
            return None
        desired, other = (f"{label}: Stock", label) if stock else (label, f"{label}: Stock")
        path = f"/library/metadata/{item['rating_key']}"
        kind = self.label_kind(item)
        existing = self.labels(item)  # No cache: never replace labels using stale data.
        folded = {value.casefold() for value in existing}
        if desired.casefold() in folded and other.casefold() not in folded:
            return desired
        labels = [value for value in existing if value.casefold() != other.casefold()]
        if desired.casefold() not in folded:
            labels.append(desired)
        params = {"type": {"movie": 1, "show": 2, "season": 3, "collection": 18}[kind], "label.locked": 1}
        params.update({f"label[{index}].tag.tag": value for index, value in enumerate(labels)})
        self.send("PUT", path, params)
        confirmed = {value.casefold() for value in self.labels(item)}
        if not {value.casefold() for value in labels}.issubset(confirmed) or other.casefold() in confirmed:
            raise RuntimeError(f"Plex did not confirm the completion label for {item['rating_key']}")
        return desired


def read_config(path):
    # tk.box writes this JSON from its database before each run; credentials come from the environment.
    with path.open(encoding="utf-8") as handle:
        config = json.load(handle)
    if not isinstance(config, dict):
        raise ValueError("Config must be a JSON object")
    allowed = {"api", "plex", "assets_dir", "cache_dir", "workers", "quality", "language", "missing_art", "overlay_marker", "default_layout", "layout_by_type", "layout_by_library", "layouts", "items", "overrides", "collections", "automatic_collections", "radarr"}
    unknown = set(config) - allowed
    if unknown:
        raise ValueError(f"Unknown config keys: {', '.join(sorted(map(str, unknown)))}")
    for name in ("api", "plex", "overrides"):
        if not isinstance(config.get(name, {}), dict):
            raise ValueError(f"{name} must be a mapping")
    for name, keys in (("api", {"tmdb_key", "tvdb_key", "tvdb_pin", "fanart_key", "fanart_client_key", "trakt_client_id", "mdblist_key"}),
                       ("plex", {"url", "token", "libraries", "upload", "include_seasons", "include_episodes", "include_collections", "sync_collections", "franchise_collections", "collection_min_items", "collection_sync", "collection_streaming", "collection_region", "recent_collections", "recent_movie_days", "recent_episode_days", "completion_label", "data_dir", "cleanup_min_age_minutes", "upload_logo"})):
        unknown = set(config.get(name, {})) - keys
        if unknown:
            raise ValueError(f"Unknown {name} keys: {', '.join(sorted(map(str, unknown)))}")
    for name, limit, default in (("workers", 32, 2), ("quality", 100, 95)):
        value = config.get(name, default)
        if type(value) is not int or not 1 <= value <= limit:
            raise ValueError(f"{name} must be an integer from 1 to {limit}")
    if type(option(config, "overlay_marker")) is not bool:
        raise ValueError("overlay_marker must be true or false")
    if option(config, "missing_art") not in ("stock", "skip"):
        raise ValueError("missing_art must be stock or skip")
    if not isinstance(config.get("items", []), list) or not all(isinstance(i, dict) for i in config.get("items", [])):
        raise ValueError("items must be a list of mappings")
    plex = config.get("plex", {})
    if not isinstance(plex.get("libraries", []), list):
        raise ValueError("plex.libraries must be a list of names or IDs")
    for name in ("upload", "upload_logo", "include_seasons", "include_episodes", "include_collections", "sync_collections", "franchise_collections", "recent_collections"):
        if type(plex.get(name, False)) is not bool:
            raise ValueError(f"plex.{name} must be true or false")
    region = option(plex, "collection_region")
    if not isinstance(region, str) or not re.fullmatch(r"[A-Z]{2}", region):
        raise ValueError("plex.collection_region must be a two-letter country code such as US")
    data_dir, min_age = plex.get("data_dir"), option(plex, "cleanup_min_age_minutes")
    if data_dir is not None and (not isinstance(data_dir, str) or not data_dir.strip()):
        raise ValueError("plex.data_dir must be the path of Plex's data folder")
    if isinstance(min_age, bool) or not isinstance(min_age, (int, float)) or min_age < 0:
        raise ValueError("plex.cleanup_min_age_minutes must be a number of minutes, 0 or more")
    label = option(plex, "completion_label")
    if not isinstance(label, str) or any(ord(character) < 32 for character in label):
        raise ValueError("plex.completion_label must be a string without control characters; use an empty string to disable")
    if not isinstance(option(config, "assets_dir"), str) or not option(config, "assets_dir").strip():
        raise ValueError("assets_dir must be a nonempty path")
    return config


def select_item(artwork, config, *, rating_key=None, title=None, media_type=None, year=None):
    """Resolve one exact target; never turn a failed selection into a batch run."""
    configured = [dict(item) for item in config.get("items", [])]
    if rating_key is not None:
        candidates = [item for item in configured if str(item.get("rating_key", "")) == str(rating_key)]
        if not candidates:
            candidates = [artwork.plex.get_item(rating_key)]
    else:
        candidates = artwork.plex.scan(media_type=media_type) if media_type != "collection" else []
        if media_type == "collection" or (media_type is None and config.get("plex", {}).get("include_collections")):
            candidates += artwork.plex.poster_collections()
        for item in configured:
            key = item.get("rating_key")
            existing = next((candidate for candidate in candidates if key is not None and
                             str(candidate.get("rating_key")) == str(key)), None)
            if existing is not None:
                existing.update(item)
            else:
                candidates.append(item)
        candidates = [item for item in candidates if str(item.get("title", "")).strip().casefold() == title.strip().casefold()]
    if media_type is not None:
        kind = {"show": "tv", "collection": "collection"}.get(media_type, "movie")
        candidates = [item for item in candidates if item.get("type", "movie") == kind]
    if year is not None:
        candidates = [item for item in candidates if str(item.get("year", "")) == str(year)]
    # A show request targets its series poster; season jobs are expanded separately.
    candidates = [item for item in candidates if item.get("season") is None]
    if not candidates:
        raise ValueError(f"No movie/show matches the requested item: {rating_key if rating_key is not None else title!r}")
    if len(candidates) != 1:
        matches = "; ".join(f"{item.get('title', '?')} ({item.get('year', '?')}), "
                            f"{ {'tv': 'show'}.get(item.get('type'), item.get('type', 'movie')) }, Plex ID {item.get('rating_key', 'not set')}"
                            for item in candidates[:10])
        raise ValueError(f"Ambiguous item selection: {matches}. Use --item PLEX_ID, --type, or --year to select one")
    candidates[0].setdefault("type", "movie")
    return candidates


@contextlib.contextmanager
def run_lock(config_path):
    """One writing run at a time: the nightly run, Tautulli hooks (a season pack fires many at once) and the web page's
    pushes would otherwise render, save and upload the same titles side by side. No-op without fcntl (Windows)."""
    try:
        import fcntl
    except ImportError:
        yield
        return
    with open(config_path.resolve().with_name(".overlayrr.lock"), "w") as handle:
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print("Waiting for another Overlayrr run to finish...", flush=True)
            fcntl.flock(handle, fcntl.LOCK_EX)
        yield


WEB_UPLOAD_LIMIT = 40 * 1024 * 1024


def web_download(url):
    """Fetch an image from a public http(s) link: no private addresses, at most 3 redirects, 40 MB.

    It connects to the address it checked (TLS still verifies the host name), so a second DNS answer can't swap in
    a private one."""
    for _ in range(4):
        parsed = urlparse(url)
        if parsed.scheme not in ("http", "https") or not parsed.hostname:
            raise ValueError("Use an http(s) link to an image")
        try:
            https = parsed.scheme == "https"
            port = parsed.port or (443 if https else 80)
            addresses = [info[4][0].split("%")[0] for info in socket.getaddrinfo(parsed.hostname, port, type=socket.SOCK_STREAM)]
            if not addresses or not all(ipaddress.ip_address(address).is_global for address in addresses):
                raise ValueError("That link points at a private address")
            tls = {"server_hostname": parsed.hostname, "assert_hostname": parsed.hostname, "ca_certs": requests.certs.where()} if https else {}
            target = (parsed.path or "/") + (f"?{parsed.query}" if parsed.query else "")
            headers = {"Host": parsed.netloc.rpartition("@")[2], "User-Agent": "Overlayrr-Standalone/1.0"}
            unique = list(dict.fromkeys(addresses))
            for address in unique:  # Like a normal connect: the next address when one can't be reached (no IPv6 route)
                pool = (urllib3.HTTPSConnectionPool if https else urllib3.HTTPConnectionPool)(
                    address, port, timeout=urllib3.Timeout(connect=10, read=30), retries=False, **tls)
                try:
                    response = pool.urlopen("GET", target, headers=headers, redirect=False, preload_content=False)
                    break
                except (urllib3.exceptions.NewConnectionError, urllib3.exceptions.ConnectTimeoutError):
                    pool.close()
                    if address == unique[-1]:
                        raise
            with pool, response:
                if response.status in (301, 302, 303, 307, 308):
                    url = urljoin(url, response.headers.get("Location", ""))
                    continue
                if not 200 <= response.status < 300:
                    raise ValueError(f"The link returned HTTP {response.status}")
                data = bytearray()
                for chunk in response.stream(65536):
                    data += chunk
                    if len(data) > WEB_UPLOAD_LIMIT:
                        raise ValueError("That file is larger than 40 MB")
                return bytes(data)
        except (OSError, urllib3.exceptions.HTTPError) as error:
            raise ValueError(f"Couldn't download that link ({type(error).__name__})") from None
    raise ValueError("Too many redirects")


class Metadata:
    """Plex, TMDb and TVDB for one run: the configured keys, a Plex client and the lookups both engines make."""

    def __init__(self, http, config, base):
        self.http, self.config, self.base = http, config, base
        self.plex = Plex(http, config)
        self.keys = {key: secret(config.get("api", {}).get(key, os.environ.get(variable, "")))
                     for key, variable in {"tmdb_key": "TMDB_API_KEY", "tvdb_key": "TVDB_API_KEY",
                                           "tvdb_pin": "TVDB_PIN", "fanart_key": "FANART_API_KEY",
                                           "fanart_client_key": "FANART_CLIENT_KEY"}.items()}
        self.token = None
        self.token_lock = threading.Lock()
        self.language = option(config, "language")
        self.pool, self.pool_lock = None, threading.Lock()

    def parallel(self, function, items):
        """[function(item) for item in items], up to six at a time (they download images); made on first use."""
        with self.pool_lock:
            if self.pool is None:
                self.pool = ThreadPoolExecutor(max_workers=6)
        return list(self.pool.map(function, items))

    def tmdb(self, path, *, stale=None, **params):
        key = self.keys.get("tmdb_key")
        if not key:
            return {}
        params["api_key"] = key
        return self.http.json(TMDB + path, params=params, **({"stale": stale} if stale else {}))

    def tvdb(self, path, *, stale=None):
        # A new login token must not invalidate the cache on every invocation.
        scope = {key: self.keys.get(key) for key in ("tvdb_key", "tvdb_pin")}
        cached = self.http.cached_json(TVDB + path, cache_scope=scope, stale=stale)
        if cached is not None:  # Log in only when TVDB must be asked: cached data works even while its login is down
            return cached
        with self.token_lock:
            if not self.token:
                payload = {"apikey": self.keys["tvdb_key"]}
                if self.keys.get("tvdb_pin"):
                    payload["pin"] = self.keys["tvdb_pin"]
                with self.http.request("POST", TVDB + "/login", json=payload) as response:
                    self.token = response.json()["data"]["token"]
        return self.http.json(TVDB + path, headers={"Authorization": "Bearer " + self.token}, cache_scope=scope, stale=stale)

    def identify(self, item):
        if item.get("tmdb_id") or not self.keys.get("tmdb_key"):
            return
        for field, source in (("imdb_id", "imdb_id"), ("tvdb_id", "tvdb_id")):
            if item.get(field) and (field != "tvdb_id" or item["type"] == "tv"):
                results = self.tmdb(f"/find/{item[field]}", external_source=source)
                matches = results.get("movie_results" if item["type"] == "movie" else "tv_results", [])
                if len(matches) == 1:
                    item["tmdb_id"] = matches[0]["id"]
                    return
