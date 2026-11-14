"""One-off (Clean Up > Save watch history): the watch dates Tautulli holds for every title a run looks at, which
tk.box keeps once Tautulli is gone. Remove this with Tautulli once tk.box has saved them."""

import json
import os
from pathlib import Path


def _iso(date):
    return date.isoformat() if date is not None else None


class WatchSnapshot:
    def __init__(self, history):
        self.history = history
        self.entries = {}

    def record(self, item, media_type, requestor_ids):
        """The title, and for a show each of its seasons too, whatever the season setting is now."""
        targets = [(item, "movie" if media_type == "movie" else "show", media_type)]
        if media_type == "tv":
            targets += [(season, "season", "season") for season in item.seasons()]
        for target, scope, history_type in targets:
            self.entries[(scope, str(target.ratingKey))] = self.history.watch_status(target, history_type, requestor_ids)

    def write(self, path, server_id, complete):
        """Written whole and then moved into place. Titles nobody watched have no row."""
        watches = [{"scope": scope, "rating_key": key, "any": _iso(status.last_watched_by_anyone),
                    "users": {str(user): _iso(date) for user, date in status.last_watched_by_user.items() if date is not None}}
                   for (scope, key), status in self.entries.items() if status.last_watched_by_anyone is not None]
        data = {"server_id": server_id, "complete": complete, "checked": len(self.entries), "watches": watches}
        path = Path(path)
        temporary = path.with_name(f"{path.name}.{os.getpid()}.tmp")
        temporary.write_text(json.dumps(data), encoding="utf-8")
        os.replace(temporary, path)
