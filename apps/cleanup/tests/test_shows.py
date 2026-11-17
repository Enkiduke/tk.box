"""Shows are tk.box's: seasons go from Plex only.

Run from the repository root: py -3 -m unittest discover -s apps/cleanup/tests"""

import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from purge_support import actions  # noqa: E402
from purge_support.config import Settings  # noqa: E402

ENV = {"PLEX_TOKEN": "token"}
NOW = datetime(2026, 6, 1, tzinfo=timezone.utc)


def config(**extra):
    watches = {"server_id": "abc", "movie": {}, "show": {}, "season": {}}
    return {"plex": {"url": "http://plex:32400"}, "tv_libraries": ["2"], "watches": watches, **extra}


class Season:
    def __init__(self, index):
        self.index, self.title, self.deleted = index, f"Season {index}", False
        self.librarySectionTitle = "TV"

    def delete(self):
        self.deleted = True


def report():
    return SimpleNamespace(planned=0, deleted=0, protected=0, kept=0, failed=0, evaluation_complete=True, items=[],
                           delete_summary={}, season_summary={})


class ShowsTest(unittest.TestCase):
    def setUp(self):
        due = SimpleNamespace(name="Unwatched", reason="never watched", deletion_date=NOW - timedelta(days=1))
        self.patched = {name: getattr(actions, name) for name in ("rule_for_requests", "season_added_at", "held_until")}
        actions.rule_for_requests = lambda *args, **kwargs: due
        actions.season_added_at = lambda season: NOW - timedelta(days=90)
        actions.held_until = lambda rule, settings, key: None

    def tearDown(self):
        for name, value in self.patched.items():
            setattr(actions, name, value)

    def test_seasons_go_from_plex_only(self):
        settings = Settings.from_config(config(dry_run=False), ENV)
        seasons = [Season(1), Season(2), Season(3)]
        show = SimpleNamespace(title="Severance", seasons=lambda: seasons, librarySectionTitle="TV")
        history = SimpleNamespace(watch_status=lambda *args: None)
        result = report()
        self.assertTrue(actions.process_seasons(show, [], settings, history, NOW, result, 95396))
        self.assertEqual([s.deleted for s in seasons], [True, True, False], "the latest season is protected")
        self.assertEqual(result.deleted, 2)
        self.assertEqual([(i["key"], i["status"]) for i in result.items if i["status"] == "deleted"], [("tv:95396:1", "deleted"), ("tv:95396:2", "deleted")])


if __name__ == "__main__":
    unittest.main()
