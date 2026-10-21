"""Tautulli watch history and added-date fallback with strict validation."""

import logging
from datetime import datetime, timezone
from math import isfinite

from .api import ApiError, positive_id
from .policy import WatchStatus

logger = logging.getLogger(__name__)


def unix_datetime(value, description):
    try:
        if isinstance(value, bool):
            raise ValueError
        timestamp = float(value)
        if not isfinite(timestamp) or timestamp <= 0:
            raise ValueError
        return datetime.fromtimestamp(timestamp, tz=timezone.utc)
    except (ValueError, TypeError, OverflowError, OSError):
        raise ApiError(f"Tautulli returned an invalid {description} timestamp") from None


class TautulliClient:
    def __init__(self, http, service, exempt_user_ids):
        self.http = http
        self.url = service.url + "/api/v2"
        self.api_key = service.key
        self.exempt_user_ids = exempt_user_ids
        self._latest_cache = {}

    def _get_data(self, command, **params):
        data = self.http.request("GET", self.url, decode=True,
                                 params={"apikey": self.api_key, "cmd": command, **params})
        envelope = data.get("response") if isinstance(data, dict) else None
        if not isinstance(envelope, dict) or envelope.get("result") != "success":
            raise ApiError("Tautulli reported an API failure")
        result = envelope.get("data")
        if not isinstance(result, dict):
            raise ApiError(f"Invalid Tautulli {command} response")
        return result

    def added_at(self, rating_key):
        """Return Plex's library-added timestamp exposed by Tautulli metadata."""
        rating_key = positive_id(rating_key)
        metadata = self._get_data("get_metadata", rating_key=rating_key)
        try:
            returned_key = positive_id(metadata.get("rating_key"))
        except (ValueError, TypeError):
            raise ApiError("Tautulli metadata has no valid rating key") from None
        if returned_key != rating_key:
            raise ApiError("Tautulli metadata rating key does not match the Plex item")
        return unix_datetime(metadata.get("added_at"), "added_at")

    def latest(self, scope, user_id=None):
        if len(scope) != 1 or next(iter(scope)) not in {"rating_key", "parent_rating_key", "grandparent_rating_key"}:
            raise ValueError("Exactly one Tautulli rating-key scope is required")
        cache_key = (tuple((key, str(value)) for key, value in scope.items()), user_id)
        if cache_key in self._latest_cache:
            return self._latest_cache[cache_key]
        params = {"length": 1, "start": 0,
                  "order_column": "date", "order_dir": "desc", "grouping": 0, "include_activity": 1, **scope}
        if user_id is not None:
            params["user_id"] = user_id
        history = self._get_data("get_history", **params)
        count, rows = history.get("recordsFiltered"), history.get("data")
        if isinstance(count, bool) or not isinstance(count, int) or count < 0 or not isinstance(rows, list):
            raise ApiError("Invalid Tautulli history count or rows")
        if count == 0:
            if rows:
                raise ApiError("Tautulli history count disagrees with its rows")
            latest = None
        else:
            if not rows or not isinstance(rows[0], dict):
                raise ApiError("Tautulli reported watches without returning a history row")
            latest = unix_datetime(rows[0].get("date"), "watch")
        self._latest_cache[cache_key] = latest
        return latest

    def _scope_status(self, scope, user_ids):
        last_any = self.latest(scope)
        last_by_user = {user_id: self.latest(scope, user_id) for user_id in sorted(user_ids)}
        # A new play may arrive between calls; keep the more recent user timestamp.
        dates = [date for date in (last_any, *last_by_user.values()) if date is not None]
        return WatchStatus(max(dates) if dates else None, last_by_user)

    def watch_status(self, item, media_type, requestor_ids):
        user_ids = set(requestor_ids) | self.exempt_user_ids
        scope_name = {"movie": "rating_key", "tv": "grandparent_rating_key", "season": "parent_rating_key"}[media_type]
        try:
            return self._scope_status({scope_name: item.ratingKey}, user_ids)
        except ApiError:
            if media_type == "movie":
                raise
            logger.warning("Scoped Tautulli lookup failed for '%s'; checking every episode", item.title)
        # Every episode must be checked successfully; a partial result is unsafe.
        episodes = item.episodes()
        if not episodes:
            raise ApiError(f"No episodes available for history fallback: {item.title}")
        last_any = None
        last_by_user = dict.fromkeys(user_ids)
        for episode in episodes:
            status = self._scope_status({"rating_key": episode.ratingKey}, user_ids)
            if status.last_watched_by_anyone is not None:
                last_any = max(last_any, status.last_watched_by_anyone) if last_any else status.last_watched_by_anyone
            for user_id, date in status.last_watched_by_user.items():
                if date is not None:
                    previous = last_by_user[user_id]
                    last_by_user[user_id] = max(previous, date) if previous else date
        return WatchStatus(last_any, last_by_user)
