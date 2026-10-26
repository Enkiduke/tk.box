"""Plex matching, exemption checks, and library-scoped collection updates."""

import logging
from datetime import datetime, timezone

from plexapi.exceptions import NotFound

from .api import ApiError, positive_id
from .config import COLLECTION_KINDS, collection_key

logger = logging.getLogger(__name__)
LEAVING_SOON_SORT_TITLE = "!011_Leaving Soon"


def item_guids(item):
    guids = {guid.id for guid in getattr(item, "guids", [])}
    primary = getattr(item, "guid", "")
    guids.add(primary)
    # Older Plex agents store the external ID in the primary GUID.
    for prefix, target in (("com.plexapp.agents.themoviedb://", "tmdb://"),
                           ("com.plexapp.agents.thetvdb://", "tvdb://")):
        if primary.startswith(prefix):
            guids.add(target + primary[len(prefix):].split("?", 1)[0].split("/", 1)[0])
    return guids


def find_plex_item(plex, media_type, library_keys, tmdb_id=None, tvdb_id=None, title=None, year=None):
    """Prefer external IDs; reject fuzzy titles and conflicting identifiers. Libraries are Plex section IDs."""
    expected = {}
    for prefix, value in (("tmdb", tmdb_id), ("tvdb", tvdb_id if media_type == "tv" else None)):
        if value is not None:
            expected[prefix] = f"{prefix}://{positive_id(value)}"

    def verified(item):
        guids = item_guids(item)
        if any(any(guid.startswith(prefix + "://") for guid in guids) and wanted not in guids
               for prefix, wanted in expected.items()):
            return False
        return bool(set(expected.values()) & guids)

    for library_key in library_keys:
        library = plex.library.sectionByID(int(library_key))
        if library.type != ("movie" if media_type == "movie" else "show"):
            raise ApiError(f"Plex library '{library.title}' has the wrong media type")
        for guid in expected.values():
            try:
                item = library.getGuid(guid)
            except NotFound:
                continue
            if verified(item):
                return item
        if not title or title == "Unknown Title":
            continue
        queries = [{"title": title}]
        if year is not None:
            queries.append({"year": year})
        for query in queries:
            matches = library.search(**query)
            for item in matches:
                if verified(item):
                    return item
            # Title/year is only a fallback when there are no external IDs at all.
            if not expected and year is not None:
                exact = [item for item in matches if item.title.casefold() == title.casefold() and item.year == year]
                if len(exact) == 1:
                    return exact[0]
    return None


def protected_collections(item, leaving_soon_name, kinds=frozenset(COLLECTION_KINDS), tkbox=None):
    """The item's collections that protect it: tk.box's own (`tkbox`, see config.tkbox_collections) when their kind is
    in `kinds`, any other when "other" is. Leaving Soon never does."""
    item.reload()
    collections = item.collections() if callable(item.collections) else item.collections
    titles = {getattr(collection, "tag", None) or getattr(collection, "title", "") for collection in collections}
    library = str(getattr(item, "librarySectionTitle", "") or "").strip().casefold()
    return sorted(title for title in titles if title and title.strip().casefold() != leaving_soon_name.strip().casefold()
                  and (tkbox or {}).get((library, collection_key(title)), "other") in kinds)


def matching_arr_tags(item, tag_names, exempt_names):
    if item is None or tag_names is None:
        raise ApiError("Arr item or tag cache unavailable for exemption check")
    tags = item.get("tags")
    if not isinstance(tags, list):
        raise ApiError("Arr item has no valid tag list for exemption check")
    matches = set()
    for tag_id in tags:
        try:
            name = tag_names[positive_id(tag_id)]
        except (KeyError, ValueError, TypeError):
            raise ApiError("Arr item contains an unknown or invalid tag") from None
        if name.casefold() in exempt_names:
            matches.add(name)
    return sorted(matches)


def plex_datetime(value):
    """PlexAPI's naive timestamp datetimes are in the host's local timezone."""
    if not isinstance(value, datetime):
        raise ValueError("Missing Plex addedAt date")
    return value.astimezone(timezone.utc)


def season_added_at(season):
    episodes = season.episodes()
    if not episodes:
        raise ValueError("Season has no episodes to derive an addedAt date")
    # Missing dates must not let a recently added episode go unprotected.
    return max(plex_datetime(getattr(episode, "addedAt", None)) for episode in episodes)


def update_plex_collection(plex, library_keys, name, candidates, poster=None, *, remove_stale=True, settled=frozenset()):
    """Add confirmed candidates. After a complete evaluation remove every other member; after an incomplete one, only
    members in `settled` (rating keys the run confirmed as not leaving)."""
    def removable(key):
        return remove_stale or key in settled
    by_library = {}
    for item in candidates:
        by_library.setdefault(positive_id(item.librarySectionID), {})[str(item.ratingKey)] = item
    if poster and not poster.is_file():
        logger.warning("Collection poster does not exist: %s", poster)
        poster = None
    successful = True
    for library_key in dict.fromkeys(positive_id(key) for key in library_keys):
        try:
            library = plex.library.sectionByID(library_key)
            wanted = by_library.get(library_key, {})
            collections = [collection for collection in library.collections()
                           if collection.title.strip().casefold() == name.strip().casefold()]
            if any(getattr(collection, "smart", False) for collection in collections):
                raise ApiError(f"Collection '{name}' is smart and cannot be managed as a manual collection")
            collections.sort(key=lambda collection: (plex_datetime(collection.addedAt).timestamp()
                                                     if collection.addedAt else 0, str(collection.ratingKey)))
            collection = collections[0] if collections else None
            if not wanted:
                if remove_stale:
                    for existing in collections:
                        existing.delete()
                elif collection is not None:
                    stale = [item for item in collection.items() if removable(str(item.ratingKey))]
                    if stale:
                        collection.removeItems(stale)
                continue
            if collection is None:
                library.createCollection(name, items=list(wanted.values()))
                collection = library.collection(name)
            else:
                current = {str(item.ratingKey): item for item in collection.items()}
                missing = [item for key, item in wanted.items() if key not in current]
                stale = [item for key, item in current.items() if key not in wanted and removable(key)]
                if missing:
                    collection.addItems(missing)
                if stale:
                    collection.removeItems(stale)
            if remove_stale:
                for duplicate in collections[1:]:
                    duplicate.delete()
            collection.editSortTitle(LEAVING_SOON_SORT_TITLE)
            if poster:
                collection.uploadPoster(filepath=str(poster))
        except Exception:
            logger.exception("Failed to update collection '%s' in library %s", name, library_key)
            successful = False
    return successful
