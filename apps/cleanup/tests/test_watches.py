"""The run config's watch history: parsing, scopes and the Plex server check.

Run from the repository root: py -3 -m unittest discover -s apps/cleanup/tests"""

import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from purge_support.config import ConfigError, Settings  # noqa: E402
from purge_support.watches import ConfigHistory  # noqa: E402

ENV = {"PLEX_TOKEN": "token"}


def config(**watches):
    base = {"server_id": "abc", "movie": {}, "show": {}, "season": {}}
    return {"plex": {"url": "http://plex:32400"}, "movie_libraries": ["1"], "exempt_user_ids": [7],
            "watches": {**base, **watches}}


def at(day):
    return datetime(2026, 1, day, tzinfo=timezone.utc)


class WatchesTest(unittest.TestCase):
    def history(self, server_id="abc", **watches):
        settings = Settings.from_config(config(**watches), ENV)
        return ConfigHistory(settings.watches, settings.exempt_user_ids, server_id)

    def test_scopes(self):
        history = self.history(
            movie={"10": {"any": "2026-01-05T00:00:00.000Z", "users": {"3": "2026-01-02T00:00:00.000Z"}}},
            show={"20": {"any": "2026-01-06T00:00:00Z", "users": {"7": "2026-01-06T00:00:00Z"}}},
            season={"21": {"any": "2026-01-04T00:00:00Z", "users": {}}})
        movie = history.watch_status(SimpleNamespace(ratingKey=10), "movie", {3, 4})
        self.assertEqual(movie.last_watched_by_anyone, at(5))
        self.assertEqual(movie.last_watched_by_user, {3: at(2), 4: None, 7: None})
        show = history.watch_status(SimpleNamespace(ratingKey=20), "tv", {3})
        self.assertEqual((show.last_watched_by_anyone, show.last_watched_by_user[7]), (at(6), at(6)))
        season = history.watch_status(SimpleNamespace(ratingKey=21), "season", set())
        self.assertEqual((season.last_watched_by_anyone, season.last_watched_by_user), (at(4), {7: None}))
        # A key is looked up only in its own scope; nobody watched a title without a row.
        unwatched = history.watch_status(SimpleNamespace(ratingKey=20), "movie", {3})
        self.assertEqual((unwatched.last_watched_by_anyone, unwatched.last_watched_by_user), (None, {3: None, 7: None}))

    def test_other_server(self):
        with self.assertRaises(ConfigError):
            self.history(server_id="other")
        with self.assertRaises(ConfigError):
            self.history(server_id="")

    def test_missing_or_invalid(self):
        without = config()
        del without["watches"]
        for bad in (without, config(movie=None), config(server_id=""),
                    config(movie={"x": {"any": "2026-01-01T00:00:00Z"}}),
                    config(movie={"1": {"any": "yesterday"}}),
                    config(season={"1": {"any": "2026-01-01T00:00:00Z", "users": {"7": None}}})):
            with self.assertRaises(ConfigError):
                Settings.from_config(bad, ENV)


if __name__ == "__main__":
    unittest.main()
