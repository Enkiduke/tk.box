"""Purge available Seerr requests according to watch history and retention policy.

tk.box runs this as ``python purge_requests.py <config.json> [--dry-run]`` (Admin > Server > Clean Up). The config is
written by tk.box from its settings; the Plex token and the service keys arrive in the environment. ``--dry-run``
previews a run whatever the config says. Output goes to stdout, which tk.box keeps with the job.
"""

import argparse
import json
import logging
import os
import sys
from dataclasses import dataclass, replace
from datetime import datetime, timezone
from pathlib import Path

import requests
from plexapi.server import PlexServer

from purge_support.actions import delete_whole_item, process_seasons
from purge_support.api import ApiError, ArrClient, HttpClient, SeerrClient, positive_id
from purge_support.config import ConfigError, Settings
from purge_support.history import TautulliClient
from purge_support.plex import find_plex_item, matching_arr_tags, protected_collections, update_plex_collection
from purge_support.policy import (MissingAddedAtError, days_remaining, held_until, hold_key, leaving_soon, parse_added_at,
                                  rule_for_requests)
from purge_support.reporting import RunReport, add_entry, add_status, log_report, write_status

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class MediaRequest:
    request_id: int
    requestor_id: int
    added_at: datetime | None
    media: dict


def group_requests(requests_data):
    """Group shared media before deciding whether any request permits deletion."""
    groups = {}
    for request in requests_data:
        media = request.get("media")
        if not isinstance(media, dict) or media.get("mediaType") not in {"movie", "tv"}:
            raise ApiError("Seerr request has missing or unsupported media information")
        try:
            key = (media["mediaType"], positive_id(media.get("tmdbId")))
        except (TypeError, ValueError):
            raise ApiError("Seerr request has an invalid TMDB ID") from None
        groups.setdefault(key, []).append(request)
    return groups


def parse_requests(raw_requests):
    parsed = []
    for raw in raw_requests:
        requestor = raw.get("requestedBy")
        if not isinstance(requestor, dict):
            raise ValueError("Missing requestor information")
        try:
            added_at = parse_added_at(raw["media"].get("mediaAddedAt"))
        except MissingAddedAtError:
            added_at = None
        parsed.append(MediaRequest(positive_id(raw.get("id")), positive_id(requestor.get("plexId")),
                                   added_at, raw["media"]))
    return parsed


def resolve_added_dates(requests_group, item, history):
    """Use one validated Tautulli date for requests missing their Seerr date."""
    missing = [request.request_id for request in requests_group if request.added_at is None]
    if not missing:
        return requests_group
    try:
        added_at = history.added_at(item.ratingKey)
    except ApiError as exc:
        raise MissingAddedAtError(f"Seerr mediaAddedAt is missing and Tautulli added_at is unavailable: {exc}") from None
    logger.warning("Using Tautulli added_at=%s for '%s' (Plex ratingKey=%s, request IDs %s) "
                   "because Seerr mediaAddedAt is missing", added_at.isoformat(), item.title, item.ratingKey, missing)
    return [replace(request, added_at=added_at) if request.added_at is None else request for request in requests_group]


def media_title_and_year(media_type, details):
    title = details.get("title") if media_type == "movie" else details.get("name") or details.get("title")
    date = details.get("releaseDate") if media_type == "movie" else details.get("firstAirDate")
    year = int(date[:4]) if isinstance(date, str) and date[:4].isdigit() else None
    return title or "Unknown Title", year


def load_arr_data(client, needed, tags_needed):
    if not needed:
        return {}, {}
    try:
        library = client.library()
        tags = client.tags() if tags_needed else {}
        return library, tags
    except ApiError as exc:
        logger.error("%s cache unavailable: %s", client.name, exc)
        return None, None


def process_request_group(key, raw_requests, *, settings, plex, seerr, radarr, sonarr, history,
                          arr_data, now, report, processed_keys, context):
    """`context` collects the title and Plex item as they are found, for the status entry of a failed evaluation."""
    requests_group = parse_requests(raw_requests)
    media_type, tmdb_id = key
    media = requests_group[0].media
    tvdb_ids = {positive_id(request.media["tvdbId"]) for request in requests_group if request.media.get("tvdbId")}
    if len(tvdb_ids) > 1:
        raise ApiError("Requests for the same media contain conflicting TVDB IDs")
    tvdb_id = next(iter(tvdb_ids), None)
    try:
        details = seerr.details(media_type, tmdb_id)
    except ApiError as exc:
        logger.warning("Seerr details unavailable for %s TMDB %s: %s; using request metadata",
                       media_type, tmdb_id, exc)
        details = media
    title, year = media_title_and_year(media_type, details)
    context["title"] = title
    hold = hold_key(media_type, tmdb_id)
    libraries = settings.movie_libraries if media_type == "movie" else settings.tv_libraries
    if not libraries:
        report.kept += 1
        return
    item = find_plex_item(plex, media_type, libraries, tmdb_id, tvdb_id, title, year)
    if item is None:
        logger.warning("Plex item not found: %s TMDB=%s TVDB=%s", title, tmdb_id, tvdb_id)
        report.not_found += 1
        report.evaluation_complete = False
        add_status(report, None, "movie" if media_type == "movie" else "show", "not_found", title=title,
                   reason="Not found in the chosen Plex libraries", key=hold)
        return
    item_key = (str(item.librarySectionID), str(item.ratingKey))
    if item_key in processed_keys:
        raise ApiError("Different media IDs resolved to the same Plex item; refusing repeated processing")
    processed_keys.add(item_key)
    context["item"] = item
    kind = "movie" if media_type == "movie" else "show"
    logger.info("Processing '%s' for request IDs %s", item.title, [request.request_id for request in requests_group])

    arr = radarr if media_type == "movie" else sonarr
    library, tags = arr_data[media_type]
    external_id = tmdb_id if media_type == "movie" else tvdb_id
    arr_item = library.get(external_id) if library is not None else None
    if settings.exempt_arr_tags:
        matches = matching_arr_tags(arr_item, tags, settings.exempt_arr_tags)
        if matches:
            logger.info("Keeping '%s': protected by Arr tags %s", item.title, ", ".join(matches))
            report.protected += 1
            report.settled.add(str(item.ratingKey))
            add_status(report, item, kind, "protected", reason=f"Tagged {', '.join(matches)}", key=hold)
            return
    if settings.exempt_if_in_collection:
        collections = protected_collections(item, settings.leaving_soon_name, settings.protecting_collection_kinds,
                                           settings.tkbox_collections)
        if collections:
            logger.info("Keeping '%s': protected by collections %s", item.title, ", ".join(collections))
            report.protected += 1
            report.settled.add(str(item.ratingKey))
            add_status(report, item, kind, "protected", reason=f"In {', '.join(collections)}", key=hold)
            return
    if media_type == "tv" and settings.enable_season_retention:
        if process_seasons(item, requests_group, arr_item, settings, sonarr, history, now, report, tmdb_id):
            # Season by season, the show itself never belongs in the collection.
            report.settled.add(str(item.ratingKey))
            return

    requests_group = resolve_added_dates(requests_group, item, history)
    watch = history.watch_status(item, media_type, {request.requestor_id for request in requests_group})
    rule = rule_for_requests(requests_group, watch, settings)
    held = held_until(rule, settings, hold)
    due_at = held or rule.deletion_date
    if held:
        logger.info("Keeping '%s' until at least %s: held by an administrator", item.title, held.isoformat())
    if now >= due_at:
        logger.warning("DELETE Candidate: '%s'. %s: %s", item.title, rule.name, rule.reason)
        add_entry(report.delete_summary, item, f"{item.title} [{rule.name}]")
        delete_whole_item(item, media_type, arr_item, [request.media.get("id") for request in requests_group],
                          settings, arr, seerr, report)
        add_status(report, item, kind, "due" if settings.dry_run else "deleted", rule=rule, key=hold)
    else:
        report.kept += 1
        remaining = days_remaining(due_at, now)
        leaving = leaving_soon(due_at, now, settings.leaving_soon_days)
        if leaving:
            report.leaving_items.append(item)
            add_entry(report.leaving_summary, item, f"{item.title} in {remaining} days [{rule.name}]")
        else:
            report.settled.add(str(item.ratingKey))
        add_status(report, item, kind, "leaving" if leaving else "kept", rule=rule, key=hold, held=held)
        if settings.dry_run:
            logger.info("DRY RUN Foresight: '%s' in %s days (%s: %s)", item.title, remaining, rule.name, rule.reason)
        else:
            logger.info("Keeping '%s' until %s (%s)", item.title, due_at.isoformat(), rule.name)


def run(settings, plex, seerr, radarr, sonarr, history, now=None):
    """Run with injectable integrations so regression tests never contact live services."""
    now = now or datetime.now(timezone.utc)
    report = RunReport()
    library_keys = []
    for keys, expected in ((settings.movie_libraries, "movie"), (settings.tv_libraries, "show")):
        for key in keys:
            library = plex.library.sectionByID(int(key))
            if library.type != expected:
                raise ConfigError(f"Plex library '{library.title}' must have type '{expected}'")
            library_keys.append(library.key)
    requests_data = seerr.available_requests()
    report.processed = len(requests_data)
    groups = group_requests(requests_data)
    logger.info("Processing %s requests across %s media items", len(requests_data), len(groups))
    arr_data = {
        "movie": load_arr_data(radarr, any(key[0] == "movie" for key in groups) and bool(settings.movie_libraries) and
                               (settings.delete_from_radarr or bool(settings.exempt_arr_tags)), bool(settings.exempt_arr_tags)),
        "tv": load_arr_data(sonarr, any(key[0] == "tv" for key in groups) and bool(settings.tv_libraries) and
                            (settings.delete_from_sonarr or bool(settings.exempt_arr_tags) or settings.enable_season_retention),
                            bool(settings.exempt_arr_tags)),
    }
    processed_keys = set()
    for key, raw_requests in groups.items():
        context = {}
        # A failed title is listed as kept, with what went wrong.
        def failed(reason):
            add_status(report, context.get("item"), "movie" if key[0] == "movie" else "show", "error",
                       title=context.get("title") or f"TMDB {key[1]}", reason=reason, key=hold_key(*key))
        try:
            process_request_group(key, raw_requests, settings=settings, plex=plex, seerr=seerr,
                                  radarr=radarr, sonarr=sonarr, history=history, arr_data=arr_data,
                                  now=now, report=report, processed_keys=processed_keys, context=context)
        except MissingAddedAtError as exc:
            logger.warning("Skipping %s TMDB=%s (request IDs %s): %s; retaining media",
                           *key, [request.get("id") for request in raw_requests], exc)
            report.skipped_missing_added_at += 1
            report.evaluation_complete = False
            failed(str(exc))
        except Exception as exc:
            logger.exception("Skipping %s TMDB=%s after failed evaluation or deletion", *key)
            report.failed += 1
            report.evaluation_complete = False
            failed(f"Skipped after an error: {exc}")
    if settings.create_leaving_soon_collection and not settings.dry_run:
        if not report.evaluation_complete:
            logger.warning("Leaving Soon evaluation was incomplete: adding confirmed candidates and removing members "
                           "confirmed as not leaving; members that couldn't be checked stay until a complete run")
        if not update_plex_collection(plex, library_keys, settings.leaving_soon_name,
                                      report.leaving_items, settings.leaving_soon_poster,
                                      remove_stale=report.evaluation_complete, settled=report.settled):
            report.failed += 1
    elif settings.create_leaving_soon_collection:
        logger.info("DRY RUN: Leaving Soon collection was not modified (%s candidates)", len(report.leaving_items))
    log_report(report, settings.dry_run)
    return report


def configure_logging():
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s", datefmt="%H:%M:%S",
                        handlers=[logging.StreamHandler(sys.stdout)], force=True)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("config", type=Path, help="tk.box's JSON config for this run")
    parser.add_argument("--dry-run", action="store_true", help="report what would be deleted; change nothing")
    parser.add_argument("--status", type=Path, help="write each title's status here as JSON when the run finishes")
    args = parser.parse_args(argv)
    configure_logging()
    try:
        config = json.loads(args.config.read_text(encoding="utf-8"))
        settings = Settings.from_config(config, os.environ, dry_run=args.dry_run or os.environ.get("TKBOX_READ_ONLY") == "1")
    except (ConfigError, OSError, ValueError) as exc:
        logger.error("Cannot start purge: %s", exc)
        return 1
    logger.info("Starting purge (%s)", "DRY RUN: nothing is deleted" if settings.dry_run else "deleting for real")
    try:
        with requests.Session() as session:
            http = HttpClient(session, settings.timeout)
            plex = PlexServer(settings.plex.url, settings.plex.key, timeout=settings.http_timeout_seconds)
            report = run(settings, plex, SeerrClient(http, settings.seerr),
                         ArrClient(http, settings.radarr, "Radarr"), ArrClient(http, settings.sonarr, "Sonarr"),
                         TautulliClient(http, settings.tautulli, settings.exempt_user_ids))
        if args.status:
            write_status(report, args.status, settings.dry_run)
        return 1 if report.failed or report.skipped_missing_added_at else 0
    except Exception:
        logger.exception("Purge aborted")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
