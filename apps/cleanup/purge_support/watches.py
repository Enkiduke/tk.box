"""Watch history from tk.box's run config (the config's `watches`): plays tk.box saw in its own player and in Plex's
apps, with the saved history, the later of each. tk.box writes it for one Plex server; a run against another fails."""

from .config import ConfigError
from .policy import WatchStatus

SCOPES = {"movie": "movie", "tv": "show", "season": "season"}


class ConfigHistory:
    def __init__(self, watches, exempt_user_ids, server_id):
        if not server_id or str(server_id) != watches.server_id:
            raise ConfigError(f"The watch history is for Plex server {watches.server_id}, not this one ({server_id or 'unknown'})")
        self.watches = watches
        self.exempt_user_ids = exempt_user_ids

    def watch_status(self, item, media_type, requestor_ids):
        """The latest watch by anyone, and by each requester and exempt user (None when they haven't watched)."""
        last_any, by_user = self.watches.scopes[SCOPES[media_type]].get(str(item.ratingKey), (None, {}))
        last_by_user = {user_id: by_user.get(user_id) for user_id in sorted(set(requestor_ids) | self.exempt_user_ids)}
        dates = [date for date in (last_any, *last_by_user.values()) if date is not None]
        return WatchStatus(max(dates) if dates else None, last_by_user)
