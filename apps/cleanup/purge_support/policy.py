"""Pure retention rules shared by whole items and individual seasons."""

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from math import ceil

from .config import Settings


class MissingAddedAtError(ValueError):
    """The request has no added-date anchor (and Tautulli could not supply one)."""


def plex_datetime(value):
    """PlexAPI's naive timestamp datetimes are in the host's local timezone."""
    if not isinstance(value, datetime):
        raise ValueError("Missing Plex addedAt date")
    return value.astimezone(timezone.utc)


@dataclass(frozen=True)
class WatchStatus:
    last_watched_by_anyone: datetime | None
    last_watched_by_user: dict[int, datetime | None]


@dataclass(frozen=True)
class RetentionRule:
    name: str
    deletion_date: datetime
    reason: str


def parse_added_at(value):
    if value is None or (isinstance(value, str) and not value.strip()):
        raise MissingAddedAtError("The request's available date is missing")
    if not isinstance(value, str):
        raise ValueError("available_at must be an ISO 8601 date string")
    result = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    if result.tzinfo is None:
        result = result.replace(tzinfo=timezone.utc)
    return result.astimezone(timezone.utc)


def retention_rule(added_at: datetime, requestor_id: int, watch: WatchStatus, settings: Settings):
    # A request with no Plex requester (an old local Seerr account) is never exempt and has no watches of its own.
    if requestor_id is not None and requestor_id in settings.exempt_user_ids:
        exempt_dates = [watch.last_watched_by_user[user_id] for user_id in settings.exempt_user_ids
                        if watch.last_watched_by_user[user_id] is not None]
        if exempt_dates:
            anchor = max(exempt_dates)
            days, name = settings.days_after_exempt_watch, "Rule 4"
            reason = f"Exempt request, last exempt-user watch on {anchor.date()}"
        else:
            anchor = watch.last_watched_by_anyone or added_at
            days, name = settings.days_after_any_watch_exempt, "Rule 3"
            reason = f"Exempt request without exempt-user watches, anchored to {anchor.date()}"
    elif requestor_id is not None and watch.last_watched_by_user.get(requestor_id) is not None:
        anchor = watch.last_watched_by_anyone
        if anchor is None:
            raise ValueError("Requestor watch exists without global watch history")
        days, name = settings.days_after_watched, "Rule 1"
        reason = f"Non-exempt requestor watched it, last watch by anyone on {anchor.date()}"
    else:
        # Anyone else's watch keeps it too, for as long as the requester's own watch would.
        added_deadline = added_at + timedelta(days=settings.days_after_unwatched)
        last_any = watch.last_watched_by_anyone
        if last_any is not None and last_any + timedelta(days=settings.days_after_watched) > added_deadline:
            reason = (f"Non-exempt requestor has not watched it; last watch by anyone on {last_any.date()}"
                      f"; retention={settings.days_after_watched} days after that watch")
            return RetentionRule("Rule 2", last_any + timedelta(days=settings.days_after_watched), reason)
        anchor = added_at
        days, name = settings.days_after_unwatched, "Rule 2"
        reason = f"Non-exempt requestor has not watched it since added on {anchor.date()}"
    return RetentionRule(name, anchor + timedelta(days=days), f"{reason}; retention={days} days")


def rule_for_requests(requests, watch, settings, season_added_at=None):
    """Shared media is due only after every request's retention deadline has elapsed."""
    rules = [retention_rule(season_added_at or request.added_at, request.requestor_id, watch, settings)
             for request in requests]
    return max(rules, key=lambda rule: rule.deletion_date)


def hold_key(media_type, tmdb_id, season=None):
    """How tk.box names a title's hold: movie:<tmdb>, tv:<tmdb> or tv:<tmdb>:<season>."""
    return f"{'movie' if media_type == 'movie' else 'tv'}:{tmdb_id}" + ("" if season is None else f":{season}")


def held_until(rule, settings, key):
    """The date an administrator's hold keeps the title until, when it is later than the rule's own date."""
    until = settings.holds.get(key)
    return until if until is not None and until > rule.deletion_date else None


def days_remaining(deletion_date, now):
    return max(0, ceil((deletion_date - now).total_seconds() / 86400))


def leaving_soon(deletion_date, now, days):
    return now < deletion_date <= now + timedelta(days=days)
