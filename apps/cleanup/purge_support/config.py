"""Validated configuration. Importing this module has no filesystem side effects.

tk.box keeps the settings (Admin > Server > Clean Up) and writes them out as a JSON config before each run. Keys and
the Plex token are never in that file: they arrive in the environment for that run only.
"""

import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Mapping
from urllib.parse import urlsplit


class ConfigError(ValueError):
    """Configuration is missing or unsafe to use for a purge."""


def boolean(config, name, default=False):
    value = config.get(name, default)
    if not isinstance(value, bool):
        raise ConfigError(f"{name} must be true or false")
    return value


def integer(config, name, default, minimum=0):
    value = config.get(name, default)
    if isinstance(value, bool) or not isinstance(value, int) or value < minimum:
        raise ConfigError(f"{name} must be an integer >= {minimum}")
    return value


def text(config, name, default=""):
    value = config.get(name, default)
    if not isinstance(value, str):
        raise ConfigError(f"{name} must be text")
    return value.strip()


def text_list(config, name):
    value = config.get(name, [])
    if not isinstance(value, list) or not all(isinstance(part, str) for part in value):
        raise ConfigError(f"{name} must be a list of text")
    return tuple(dict.fromkeys(part.strip() for part in value if part.strip()))


def holds(config):
    value = config.get("holds", {})
    if not isinstance(value, Mapping) or not all(isinstance(key, str) and isinstance(until, str) for key, until in value.items()):
        raise ConfigError("holds must map hold keys to ISO 8601 dates")
    try:
        parsed = {key: datetime.fromisoformat(until.replace("Z", "+00:00")) for key, until in value.items()}
    except ValueError:
        raise ConfigError("holds must map hold keys to ISO 8601 dates") from None
    return {key: (until if until.tzinfo else until.replace(tzinfo=timezone.utc)).astimezone(timezone.utc)
            for key, until in parsed.items()}


def _positive(value):
    return isinstance(value, int) and not isinstance(value, bool) and value > 0


def request_list(config):
    """tk.box's available and partly available requests: id, kind (movie or tv), tmdb, tvdb, title, year,
    requester_plex_id (null when the requester had no Plex account), available_at (ISO 8601 or null) and seasons."""
    value = config.get("requests", [])
    if not isinstance(value, list):
        raise ConfigError("requests must be a list")
    for row in value:
        if (not isinstance(row, Mapping) or not _positive(row.get("id")) or row.get("kind") not in {"movie", "tv"}
                or not _positive(row.get("tmdb")) or (row.get("tvdb") is not None and not _positive(row.get("tvdb")))
                or not isinstance(row.get("title"), str)
                or (row.get("requester_plex_id") is not None and not _positive(row.get("requester_plex_id")))
                or (row.get("available_at") is not None and not isinstance(row.get("available_at"), str))
                or not isinstance(row.get("seasons", []), list) or not all(_positive(s) for s in row.get("seasons", []))
                or not isinstance(row.get("keep", False), bool)):
            raise ConfigError("Each request needs an id, kind, TMDB id and title, with valid optional fields")
    return tuple(value)


WATCH_SCOPES = ("movie", "show", "season")


@dataclass(frozen=True)
class Watches:
    """Each title's latest watch, from tk.box (see watch_list): by scope (movie, show, season) and Plex rating key, the
    latest by anyone and by Plex account id."""
    server_id: str
    scopes: Mapping[str, Mapping[str, tuple[datetime, Mapping[int, datetime]]]]


def _watch_date(value):
    if not isinstance(value, str):
        raise ValueError
    date = datetime.fromisoformat(value.replace("Z", "+00:00"))
    return (date if date.tzinfo else date.replace(tzinfo=timezone.utc)).astimezone(timezone.utc)


def watch_list(config):
    """tk.box's watch history for this run: {server_id, movie, show, season}, each scope mapping a Plex rating key to
    {any: ISO date, users: {Plex account id: ISO date}}. Required: without it every title would look unwatched."""
    value = config.get("watches")
    if not isinstance(value, Mapping):
        raise ConfigError("watches is missing: tk.box needs PLEX_MACHINE_ID set to send watch history")
    server_id = value.get("server_id")
    if not isinstance(server_id, str) or not server_id.strip():
        raise ConfigError("watches needs the Plex server_id")
    scopes = {}
    try:
        for scope in WATCH_SCOPES:
            rows = value.get(scope)
            if not isinstance(rows, Mapping):
                raise ValueError
            parsed = {}
            for key, row in rows.items():
                if not isinstance(key, str) or not key.isdigit() or not isinstance(row, Mapping):
                    raise ValueError
                users = row.get("users", {})
                if not isinstance(users, Mapping) or not all(isinstance(user, str) and user.isdigit() for user in users):
                    raise ValueError
                parsed[key] = (_watch_date(row.get("any")), {int(user): _watch_date(at) for user, at in users.items()})
            scopes[scope] = parsed
    except (ValueError, TypeError):
        raise ConfigError("watches must map movie, show and season rating keys to ISO 8601 watch dates") from None
    return Watches(server_id.strip(), scopes)


COLLECTION_KINDS = ("franchise", "streaming", "custom", "seasonal", "other")


def collection_key(name):
    """Collection names compare as the collections engine compares them: case, punctuation and a trailing "Collection" ignored."""
    return re.sub(r"[^a-z0-9]", "", re.sub(r"\s+collection$", "", str(name or "").strip().casefold()))


def collection_kinds(config):
    value = config.get("protecting_collection_kinds", list(COLLECTION_KINDS))
    if not isinstance(value, list) or not all(kind in COLLECTION_KINDS for kind in value):
        raise ConfigError(f"protecting_collection_kinds must list some of {', '.join(COLLECTION_KINDS)}")
    return frozenset(value)


def tkbox_collections(config):
    """tk.box's own collections: (library name, collection key) to kind. Any other collection is "other"."""
    value = config.get("tkbox_collections", [])
    if not isinstance(value, list) or not all(
            isinstance(row, Mapping) and isinstance(row.get("name"), str) and isinstance(row.get("library"), str)
            and row.get("kind") in COLLECTION_KINDS[:-1] for row in value):
        raise ConfigError("tkbox_collections must list each collection's name, library and kind")
    return {(row["library"].strip().casefold(), collection_key(row["name"])): row["kind"] for row in value}


@dataclass(frozen=True)
class Service:
    url: str = ""
    key: str = field(default="", repr=False)

    @property
    def configured(self):
        return bool(self.url and self.key)

    def validate(self, name, required=False):
        if required and not self.configured:
            raise ConfigError(f"{name} address and token/API key are required")
        if self.url:
            parsed = urlsplit(self.url)
            if (parsed.scheme not in {"http", "https"} or not parsed.netloc
                    or parsed.username or parsed.password or parsed.query or parsed.fragment):
                raise ConfigError(f"The {name} address must be an HTTP(S) base URL without credentials, query, or fragment")


@dataclass(frozen=True)
class Settings:
    plex: Service
    sonarr: Service
    # Plex library section IDs.
    movie_libraries: tuple[str, ...]
    tv_libraries: tuple[str, ...]
    dry_run: bool = True
    # Movies are tk.box's own: a movie is kept by tk.box's Keep (a request's `keep`) and deleted from Plex only, and
    # tk.box forgets it after the run. Only shows go through Sonarr.
    delete_from_sonarr: bool = False
    days_after_watched: int = 30
    days_after_unwatched: int = 60
    days_after_any_watch_exempt: int = 90
    days_after_exempt_watch: int = 180
    exempt_user_ids: frozenset[int] = frozenset()
    exempt_arr_tags: frozenset[str] = frozenset()
    exempt_if_in_collection: bool = False
    # Which collections protect a title, and tk.box's own collections by kind (see tkbox_collections).
    protecting_collection_kinds: frozenset[str] = frozenset(COLLECTION_KINDS)
    tkbox_collections: Mapping[tuple[str, str], str] = field(default_factory=dict)
    enable_season_retention: bool = True
    protect_latest_season: bool = True
    protect_specials_season: bool = True
    create_leaving_soon_collection: bool = False
    leaving_soon_name: str = "Leaving Soon"
    leaving_soon_poster: Path | None = None
    leaving_soon_days: int = 7
    http_timeout_seconds: int = 30
    # Titles an administrator chose to keep longer (Clean Up > Status): hold key to the date kept until.
    holds: Mapping[str, datetime] = field(default_factory=dict)
    # tk.box's available requests (see request_list), the titles a run looks at.
    requests: tuple[Mapping, ...] = ()
    # tk.box's watch history (see watch_list).
    watches: Watches = Watches("", {scope: {} for scope in WATCH_SCOPES})

    @property
    def timeout(self):
        return (10, self.http_timeout_seconds)

    @classmethod
    def from_config(cls, config: Mapping, env: Mapping[str, str], *, dry_run=False):
        """`config` is tk.box's JSON config; `env` holds the keys. `dry_run` forces a preview whatever the config says."""
        if not isinstance(config, Mapping):
            raise ConfigError("The config must be a JSON object")

        def service(name, key_variable):
            section = config.get(name) or {}
            if not isinstance(section, Mapping):
                raise ConfigError(f"{name} must be an object")
            return Service(text(section, "url").rstrip("/"), env.get(key_variable, "").strip())

        ids = config.get("exempt_user_ids", [])
        if (not isinstance(ids, list)
                or any(isinstance(value, bool) or not isinstance(value, int) or value <= 0 for value in ids)):
            raise ConfigError("exempt_user_ids must be a list of positive integers")
        for name in ("movie_libraries", "tv_libraries"):
            if any(not key.isdigit() for key in text_list(config, name)):
                raise ConfigError(f"{name} must hold Plex library IDs")
        poster = text(config, "leaving_soon_poster")
        settings = cls(
            plex=service("plex", "PLEX_TOKEN"),
            sonarr=service("sonarr", "SONARR_API_KEY"),
            movie_libraries=text_list(config, "movie_libraries"), tv_libraries=text_list(config, "tv_libraries"),
            dry_run=dry_run or boolean(config, "dry_run", default=True),
            delete_from_sonarr=boolean(config, "delete_from_sonarr"),
            days_after_watched=integer(config, "days_after_watched", default=30),
            days_after_unwatched=integer(config, "days_after_unwatched", default=60),
            days_after_any_watch_exempt=integer(config, "days_after_any_watch_exempt", default=90),
            days_after_exempt_watch=integer(config, "days_after_exempt_watch", default=180),
            exempt_user_ids=frozenset(ids),
            exempt_arr_tags=frozenset(tag.casefold() for tag in text_list(config, "exempt_arr_tags")),
            exempt_if_in_collection=boolean(config, "exempt_if_in_collection"),
            protecting_collection_kinds=collection_kinds(config),
            tkbox_collections=tkbox_collections(config),
            enable_season_retention=boolean(config, "enable_season_retention", default=True),
            protect_latest_season=boolean(config, "protect_latest_season", default=True),
            protect_specials_season=boolean(config, "protect_specials_season", default=True),
            create_leaving_soon_collection=boolean(config, "create_leaving_soon_collection"),
            leaving_soon_name=text(config, "leaving_soon_name", default="Leaving Soon") or "Leaving Soon",
            leaving_soon_poster=Path(poster) if poster else None,
            leaving_soon_days=integer(config, "leaving_soon_days", default=7),
            http_timeout_seconds=integer(config, "http_timeout_seconds", default=30, minimum=1),
            holds=holds(config),
            requests=request_list(config),
            watches=watch_list(config),
        )
        settings.validate()
        return settings

    def validate(self):
        self.plex.validate("Plex", required=True)
        self.sonarr.validate("Sonarr", required=self.delete_from_sonarr)
        if not self.movie_libraries and not self.tv_libraries:
            raise ConfigError("Choose at least one movie or TV library")
        if self.exempt_arr_tags and self.tv_libraries:
            self.sonarr.validate("Sonarr", required=True)
