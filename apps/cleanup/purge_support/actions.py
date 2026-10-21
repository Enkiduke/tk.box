"""Deletion ordering and season processing, separate from request discovery."""

import logging

from .api import ApiError, positive_id, season_targets
from .plex import season_added_at
from .policy import days_remaining, leaving_soon, rule_for_requests
from .reporting import add_entry, add_status, library_name

logger = logging.getLogger(__name__)


def delete_whole_item(item, media_type, arr_item, media_ids, settings, arr, seerr, report):
    """Validate targets first; keep Seerr requests until the content deletion succeeds."""
    delete_from_arr = settings.delete_from_radarr if media_type == "movie" else settings.delete_from_sonarr
    if delete_from_arr:
        if arr_item is None:
            raise ApiError(f"Required {arr.name} item was not found")
        positive_id(arr_item.get("id"))
    if settings.delete_from_seerr:
        media_ids = sorted({positive_id(media_id) for media_id in media_ids})
        if not media_ids:
            raise ApiError("Seerr media IDs are required for deletion")
    if settings.dry_run:
        if delete_from_arr:
            logger.warning("DRY RUN: Would delete '%s' from %s with files", item.title, arr.name)
        logger.warning("DRY RUN: Would delete '%s' from Plex", item.title)
        if settings.delete_from_seerr:
            logger.warning("DRY RUN: Would remove Seerr media IDs %s after content deletion", media_ids)
        report.planned += 1
        return
    if delete_from_arr:
        arr.delete_item(arr_item)
    item.delete()
    report.deleted += 1
    logger.warning("Deleted '%s' from Plex", item.title)
    if settings.delete_from_seerr:
        for media_id in media_ids:
            try:
                seerr.delete_media(media_id)
            except ApiError as exc:
                logger.error("Content deleted, but Seerr cleanup failed for media ID %s: %s", media_id, exc)
                report.failed += 1


def process_seasons(show, requests, series, settings, sonarr, history, now, report):
    """Keep season policy after cleanup leaves only a later season."""
    seasons = show.seasons()  # Failure must never fall back to deleting the show.
    if not seasons or any(isinstance(season.index, bool) or not isinstance(season.index, int)
                          or season.index < 0 for season in seasons):
        raise ApiError("Plex returned an empty or invalid season list")
    normal = [season for season in seasons if season.index > 0]
    # Earlier seasons may already have been purged. A lone later season must
    # retain its protections instead of falling through to whole-show deletion.
    if len(normal) <= 1 and not any(season.index > 1 for season in normal):
        return False
    latest = max(season.index for season in normal)
    eligible = []
    for season in sorted(seasons, key=lambda season: season.index):
        if ((settings.protect_specials_season and season.index == 0)
                or (settings.protect_latest_season and season.index == latest)):
            report.protected += 1
            logger.info("Keeping protected season '%s - %s'", show.title, season.title)
            add_status(report, season, "season", "protected", title=f"{show.title} - {season.title}", library=library_name(show),
                       reason="Specials" if season.index == 0 else "Latest season")
        else:
            eligible.append(season)
    if not eligible:
        return True
    if not settings.delete_from_sonarr or series is None:
        raise ApiError("Multi-season deletion needs Delete from Sonarr turned on and a matching Sonarr series")
    episodes = sonarr.episodes(series["id"])
    requestor_ids = {request.requestor_id for request in requests}
    rescan_needed = False
    for season in eligible:
        label = f"{show.title} - {season.title}"
        try:
            added_at = season_added_at(season)
            watch = history.watch_status(season, "season", requestor_ids)
            rule = rule_for_requests(requests, watch, settings, season_added_at=added_at)
            if now >= rule.deletion_date:
                season_targets(season.index, episodes)
                logger.warning("DELETE Candidate: '%s'. %s: %s", label, rule.name, rule.reason)
                add_entry(report.delete_summary, season, f"{label} [{rule.name}]")
                if settings.dry_run:
                    logger.warning("DRY RUN: Would delete season '%s' from Sonarr and Plex", label)
                    report.planned += 1
                else:
                    rescan_needed = True
                    sonarr.delete_season(series, season.index, episodes)
                    season.delete()
                    report.deleted += 1
                    logger.warning("Deleted season '%s' from Sonarr and Plex", label)
                add_status(report, season, "season", "due" if settings.dry_run else "deleted", title=label, rule=rule, library=library_name(show))
            else:
                remaining = days_remaining(rule.deletion_date, now)
                leaving = leaving_soon(rule.deletion_date, now, settings.leaving_soon_days)
                if leaving:
                    add_entry(report.season_summary, season, f"{label} in {remaining} days [{rule.name}]")
                add_status(report, season, "season", "leaving" if leaving else "kept", title=label, rule=rule, library=library_name(show))
                if settings.dry_run:
                    logger.info("DRY RUN Foresight: '%s' in %s days (%s: %s)", label, remaining, rule.name, rule.reason)
                else:
                    logger.info("Keeping season '%s' until %s (%s)", label, rule.deletion_date.isoformat(), rule.name)
                report.kept += 1
        except Exception as exc:
            logger.exception("Skipping season '%s' after failed evaluation or deletion", label)
            add_status(report, season, "season", "error", title=label, reason=f"Skipped after an error: {exc}", library=library_name(show))
            report.failed += 1
            report.evaluation_complete = False
    if rescan_needed:
        try:
            sonarr.rescan(series["id"])
        except ApiError as exc:
            logger.error("Sonarr rescan failed for '%s': %s", show.title, exc)
            report.failed += 1
    return True
