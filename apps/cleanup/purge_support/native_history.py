"""Read-only comparison of Clean Up dates with the watches tk.box observed."""

import json
import logging
import sqlite3
from contextlib import closing
from dataclasses import replace
from datetime import datetime, timezone
from pathlib import Path

from .api import positive_id
from .policy import WatchStatus, held_until, parse_added_at, plex_datetime, rule_for_requests

logger = logging.getLogger(__name__)


class NativeHistoryPreview:
    def __init__(self, database, server_id, status_path):
        self.database = Path(database)
        self.server_id = server_id
        self.saved = self._read_saved(status_path)

    @staticmethod
    def _read_saved(path):
        if path is None:
            return {}
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            return {row["key"]: row for row in data["items"]
                    if row.get("key") and row.get("rating_key") and row.get("status") in {"due", "leaving", "kept"}}
        except (OSError, ValueError, TypeError, KeyError, AttributeError):
            return {}

    def watch_status(self, item, media_type, user_ids):
        if not self.server_id:
            raise ValueError("Missing Plex server identity")
        scope = {
            "movie": "m.rating_key",
            "tv": "json_extract(m.metadata,'$.showId')",
            "season": "json_extract(m.metadata,'$.seasonId')",
        }[media_type]
        key = str(positive_id(item.ratingKey))
        with closing(sqlite3.connect(self.database.resolve().as_uri() + "?mode=ro", uri=True, timeout=0.25)) as db:
            rows = db.execute(
                f"""SELECT s.account_id,MAX(s.started_at)
                    FROM history_sessions s JOIN history_media m ON m.id=s.media_id
                    WHERE s.source IN ('vod','plex') AND s.watch_ms>0 AND m.server_id=? AND {scope}=?
                    GROUP BY s.account_id""", (self.server_id, key)).fetchall()
        times = {account: datetime.fromtimestamp(ms / 1000, tz=timezone.utc) for account, ms in rows}
        return WatchStatus(max(times.values(), default=None), {user: times.get(str(user)) for user in user_ids})

    def compare(self, item, media_type, requests, settings, key, current_rule, now, season_added_at=None):
        """Log hypothetical retention only. Coverage must be established separately before native deletion."""
        try:
            users = {request.requestor_id for request in requests} | settings.exempt_user_ids
            watch = self.watch_status(item, media_type, users)
            if season_added_at is None and any(request.added_at is None for request in requests):
                added_at = plex_datetime(item.addedAt)
                requests = [replace(request, added_at=added_at) if request.added_at is None else request for request in requests]
            rule = rule_for_requests(requests, watch, settings, season_added_at=season_added_at)
            candidate = held_until(rule, settings, key) or rule.deletion_date
            saved = self.saved.get(key)
            if saved and str(saved["rating_key"]) == str(item.ratingKey) and saved.get("deletion_date"):
                candidate = max(candidate, parse_added_at(saved["deletion_date"]))
            current = held_until(current_rule, settings, key) or current_rule.deletion_date
            comparison = "same" if candidate == current else "earlier" if candidate < current else "later"
            logger.info("Native history comparison for %s: %s date (%s vs %s), %s. Native coverage is unverified.",
                        key, comparison, candidate.isoformat(), current.isoformat(),
                        "would be due if coverage were confirmed" if now >= candidate else "protected by date")
        except (OSError, sqlite3.Error, ValueError, AttributeError, TypeError, OverflowError) as exc:
            logger.warning("Native history comparison unavailable for %s (%s); coverage is unknown.", key, type(exc).__name__)
