"""Deletion ordering and season processing, separate from request discovery."""

import logging

from .api import ApiError
from .plex import season_added_at
from .policy import days_remaining, held_until, hold_key, leaving_soon, rule_for_requests
from .reporting import add_entry, add_status, library_name

logger = logging.getLogger(__name__)


def delete_whole_item(item, settings, report):
    """Deletes from Plex only. tk.box forgets the title and marks its requests removed after the run, from the status
    file."""
    if settings.dry_run:
        logger.warning("DRY RUN: Would delete '%s' from Plex", item.title)
        report.planned += 1
        return
    item.delete()
    report.deleted += 1
    logger.warning("Deleted '%s' from Plex", item.title)


def process_seasons(show, requests, settings, history, now, report, tmdb_id):
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
                       reason="Specials" if season.index == 0 else "Latest season", key=hold_key("tv", tmdb_id, season.index))
        else:
            eligible.append(season)
    if not eligible:
        return True
    # A season goes from Plex only, and tk.box forgets it (and stops following it) after the run, from the status file.
    # Until then its records stand, so tk.box doesn't take it as missing and fetch it again.
    requestor_ids = {request.requestor_id for request in requests if request.requestor_id is not None}
    for season in eligible:
        label = f"{show.title} - {season.title}"
        hold = hold_key("tv", tmdb_id, season.index)
        try:
            added_at = season_added_at(season)
            watch = history.watch_status(season, "season", requestor_ids)
            rule = rule_for_requests(requests, watch, settings, season_added_at=added_at)
            held = held_until(rule, settings, hold)
            due_at = held or rule.deletion_date
            if now >= due_at:
                logger.warning("DELETE Candidate: '%s'. %s: %s", label, rule.name, rule.reason)
                add_entry(report.delete_summary, season, f"{label} [{rule.name}]")
                if settings.dry_run:
                    logger.warning("DRY RUN: Would delete season '%s' from Plex", label)
                    report.planned += 1
                else:
                    season.delete()
                    report.deleted += 1
                    logger.warning("Deleted season '%s' from Plex", label)
                add_status(report, season, "season", "due" if settings.dry_run else "deleted", title=label, rule=rule,
                           library=library_name(show), key=hold)
            else:
                remaining = days_remaining(due_at, now)
                leaving = leaving_soon(due_at, now, settings.leaving_soon_days)
                if leaving:
                    add_entry(report.season_summary, season, f"{label} in {remaining} days [{rule.name}]")
                add_status(report, season, "season", "leaving" if leaving else "kept", title=label, rule=rule,
                           library=library_name(show), key=hold, held=held)
                if settings.dry_run:
                    logger.info("DRY RUN Foresight: '%s' in %s days (%s: %s)", label, remaining, rule.name, rule.reason)
                else:
                    logger.info("Keeping season '%s' until %s (%s)", label, due_at.isoformat(), rule.name)
                report.kept += 1
        except Exception as exc:
            logger.exception("Skipping season '%s' after failed evaluation or deletion", label)
            add_status(report, season, "season", "error", title=label, reason=f"Skipped after an error: {exc}",
                       library=library_name(show), key=hold)
            report.failed += 1
            report.evaluation_complete = False
    return True
