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
    seerr: Service
    tautulli: Service
    radarr: Service
    sonarr: Service
    # Plex library section IDs.
    movie_libraries: tuple[str, ...]
    tv_libraries: tuple[str, ...]
    dry_run: bool = True
    delete_from_radarr: bool = False
    delete_from_sonarr: bool = False
    delete_from_seerr: bool = False
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
            plex=service("plex", "PLEX_TOKEN"), seerr=service("seerr", "SEERR_API_KEY"),
            tautulli=service("tautulli", "TAUTULLI_API_KEY"),
            radarr=service("radarr", "RADARR_API_KEY"), sonarr=service("sonarr", "SONARR_API_KEY"),
            movie_libraries=text_list(config, "movie_libraries"), tv_libraries=text_list(config, "tv_libraries"),
            dry_run=dry_run or boolean(config, "dry_run", default=True),
            delete_from_radarr=boolean(config, "delete_from_radarr"),
            delete_from_sonarr=boolean(config, "delete_from_sonarr"),
            delete_from_seerr=boolean(config, "delete_from_seerr"),
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
        )
        settings.validate()
        return settings

    def validate(self):
        for name, service in (("Plex", self.plex), ("Seerr", self.seerr), ("Tautulli", self.tautulli)):
            service.validate(name, required=True)
        self.radarr.validate("Radarr", required=self.delete_from_radarr)
        self.sonarr.validate("Sonarr", required=self.delete_from_sonarr)
        if not self.movie_libraries and not self.tv_libraries:
            raise ConfigError("Choose at least one movie or TV library")
        if self.exempt_arr_tags:
            if self.movie_libraries:
                self.radarr.validate("Radarr", required=True)
            if self.tv_libraries:
                self.sonarr.validate("Sonarr", required=True)
