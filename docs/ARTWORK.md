# Artwork (Admin › Artwork)

Custom posters, season posters and episode title cards, merged in from Overlayrr. They're sent to Plex, so tk.box and every Plex app show them; tk.box's own artwork route needs no changes (a new upload gets a new Plex image path).

## How it fits together

- **Engine:** `apps/artwork/overlayrr.py` with its bundled `resources/` (fonts, badges, streaming logos). It is Overlayrr's renderer and Plex/TMDb/Fanart.tv/TVDB code, run as a separate Python process for every job. It lowers its own CPU priority (`nice 10`), so ffmpeg and the server come first.
- **Collections engine:** `apps/artwork/plex_collections.py` makes and keeps Plex's collections: franchise, streaming and chart collections, custom and seasonal ones, Radarr acquisition, and Discover. It reads the same config. It shares `apps/artwork/engine_common.py` with the artwork engine: the config checks and defaults, the HTTP cache, the Plex client, TMDb and TVDB lookups (`Metadata`, which the artwork engine's `Artwork` builds on), the public-link downloader and the run lock. Nothing in that module touches images, so the collections engine never loads Pillow or NumPy. Its commands are `all`, `custom`, `added`, `discover`, `defaults` and `check`. Jobs for both scripts share one queue. A run over every title queues `all apply` first when franchise collections are kept in sync and results go to Plex, so new collections get their posters in the same pass. Newly added titles join their custom collections on the collections' own schedule. Settings are checked by both scripts before saving.
- **Plex Metadata cleanup:** `apps/artwork/plex_cleanup.py` finds the posters the artwork engine sent to Plex that Plex no longer uses. Its commands are `report`, `move`, `remove` and `restore` for the whole Metadata folder, and `superseded <keys>` for the items just pushed. It reads which images are in use from a copy of Plex's database, and only touches files carrying both of the artwork engine's EXIF markers. It needs `plex.data_dir`, which tk.box doesn't write into the config, so nothing in tk.box runs it yet.
- **Settings and layouts live in tk.box's database** (`artwork_settings`, `artwork_layouts`; migration 17). There is no YAML: before each run tk.box writes the engine's JSON config to `DATA_DIR/artwork/config.json` (`artworkConfig` in `services/artwork-engine.ts`). The first start seeds the layouts from `apps/artwork/defaults.json`: six tk-* layouts taken from the live Overlayrr config (tk-movies, tk-tv, tk-custom, tk-collections, tk-streaming, tk-charts), used by kind of title until a library is given its own. A database seeded with the earlier set (overlayrr-main and Overlayrr's example layouts) has those replaced once, and settings that named them move to the tk-* ones. The engine tests keep Overlayrr's example layouts in `apps/artwork/tests/example_layouts.json`.
- **Credentials:** provider keys are sealed in the database. The Plex token is that of the administrator who started the job; scheduled jobs use the Plex admin token. Both are passed to the engine in its environment for that run only, and are redacted from the job output.
- **Files:** asset folders and rendered results are kept in `DATA_DIR/artwork/assets`, and downloads in `CACHE_DIR/artwork`.
- **Jobs** run one at a time, in order. Their output streams to the Jobs tab, and the last 2000 lines are kept with each job. A restart marks unfinished jobs as canceled.
- **Worker:** the interactive pages (Titles, Layouts) talk to one long-lived `overlayrr.py --worker` process (`services/artwork-worker.ts`). It speaks JSON lines on stdin/stdout, with images base64-encoded, and lowers its own priority (`nice 5`).
  - It starts when those pages are opened and stops after 10 minutes unused.
  - It restarts when the Plex token or keys change.
  - It reads the same `config.json`, which tk.box writes again whenever settings, layouts or collections are saved.
  - The worker's methods are Overlayrr's former web interface (`Worker` in the engine), without its login, YAML editing or cron code.
- **Images** reach the page only through the admin routes, because tk.box's CSP allows images from itself alone:
  - asset files and previews come from the worker;
  - Plex's own copies come through the worker, with the token;
  - provider pictures are proxied by `/image`, limited to the TMDb, Fanart.tv and TVDB image hosts.
- **Pushes:** a push queues one job per title. When a job succeeds, its "not pushed" mark is cleared.
- **Collections** live in `artwork_collections` (migration 18): custom and seasonal definitions in the engine's format, franchise/streaming/chart options, and Radarr. Franchise collections (movies) and streaming collections (TV) each have their own switch; turning one off stops tk.box keeping them but leaves them in Plex. After each full apply (`all apply`) the collections engine writes the franchise and streaming collections it kept to `DATA_DIR/artwork/kept_collections.json`, which the Collections page lists. The Radarr key is sealed, and the config only refers to `${RADARR_API_KEY}`. Discover runs `plex_collections.py discover` for each request (JSON on stdin and stdout) and uses the TMDb and MDBList keys and Explore's Trakt app.
- **Schedules** (`services/artwork-schedule.ts`) replace the old cron entries and the Tautulli hook. Artwork's are kept with its settings (Artwork › Schedules) and the collections' with the collections (Admin › Collections › Schedules); collection schedules saved with the artwork settings before then move over once, at startup.
  - daily tasks at a server-local time, run once each day (or up to two hours late): artwork's changed titles; the custom and seasonal collections; every collection;
  - two newly-added checks, each with its own watermark in `artwork_state`: artwork's reads the chosen libraries and queues `--added` artwork jobs; the collections' reads the libraries that enabled custom collections use and queues `added <key>` collections jobs. A check reads each library's recently added list back to its watermark, queues up to 50 titles oldest first, and moves the watermark only past what it queued; if Plex doesn't answer for a library, it moves nothing.
  - the checks run as soon as Plex finishes adding a title. While either check is on, tk.box keeps Plex Media Server's notification feed open (`services/plex-notifications.ts`, the websocket at `/:/websockets/notifications` that Tautulli also watches). When a movie, show, season or episode in a watched library finishes processing, or a library scan ends, the checks run once things have been quiet for 30 seconds (at most 3 minutes after the first). Each connection also runs them once on opening, for anything missed while it was down. It reconnects after a drop. The "every N minutes" setting is a backstop.

  The schedules and the notification feed read Plex with the Plex admin token (Admin › Connections, see `services/plex-background.ts`), so they run whether or not anyone is signed in; without a working token they wait. Plex never connects to tk.box, so no webhook or Plex Pass is needed.
- **Isolation:** the routes are `/api/v1/admin/artwork/*` (administrators only). The Admin console is its own lazy-loaded bundle. No playback, live or catalog code path calls into artwork. A title's details show **Edit artwork** only to administrators; it opens `#admin?section=artwork&title=<rating key>`.

## Setup

```sh
cd /opt/tk.box
python3 -m venv artwork-venv
artwork-venv/bin/pip install -r apps/artwork/requirements.txt
```

Set `PYTHON_PATH=/opt/tk.box/artwork-venv/bin/python` in the service environment and restart. Then add the provider keys, choose the libraries in Admin › Artwork › Settings, and run **Update changed titles**. Sending results to Plex stays off until you turn it on.

## Engine tests

```sh
py -3 -m unittest discover -s apps/artwork/tests      # Windows
python3 -m unittest discover -s apps/artwork/tests    # Linux
```

`test_streaming_collections_group_shows_and_skip_smart_collections` also fails in the standalone Overlayrr; three parity tests are skipped outside its parent app.
