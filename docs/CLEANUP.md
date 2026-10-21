# Clean Up (Admin › Server › Clean Up)

Deletes requested movies and shows once the people who asked for them have watched them, or had long enough to. It is the former `purge_requests.py` cron script, now run by tk.box with settings kept in tk.box.

## How it fits together

- **Script:** `apps/cleanup/purge_requests.py` and `apps/cleanup/purge_support/`. It reads Seerr's available requests, finds each title in Plex, reads its watch history from Tautulli, and deletes what is due from Plex (with its files) and, if chosen, from Radarr, Sonarr and Seerr. It runs as its own Python process, one job at a time (`services/cleanup-engine.ts`).
- **Settings live in tk.box's database** (`cleanup_config`). There is no `.env`: before each run tk.box writes the script's JSON config to `DATA_DIR/cleanup/config.json` (`cleanupConfig`). Libraries are Plex library IDs.
- **Connections:** Seerr is Explore's connection and Radarr is Collections'; Tautulli and Sonarr are Clean Up's own. All are set in Admin › Connections. Keys are sealed and passed to the script in its environment for that run only (`PLEX_TOKEN`, `SEERR_API_KEY`, `TAUTULLI_API_KEY`, `RADARR_API_KEY`, `SONARR_API_KEY`), and are redacted from the job output. The Plex token is that of the administrator who started the job; the scheduled run uses the Plex admin token.
- **Preview only** is on until an administrator turns it off. **Preview** always runs with `--dry-run`.
- **Schedule:** once a day at a server-local time (or up to two hours late). Like Artwork's schedules, it reads Plex with the Plex admin token (Admin › Connections) and waits while there is no working one.
- **Leaving Soon:** the collection's poster is `apps/cleanup/leaving-soon.png`.
- **Status:** each run is given `--status DATA_DIR/cleanup/status.json`; when it finishes, the script writes every movie, show and season it looked at there (status, library, deletion date and the rule behind it). The Status tab lists that file, with filters and sorting, so it is as current as the last preview or clean up.
- **Jobs** keep their last 2000 lines of output. A restart marks unfinished jobs as canceled.

## Setup

The script uses the same Python as Artwork (`PYTHON_PATH`):

```sh
cd /opt/tk.box
artwork-venv/bin/pip install -r apps/cleanup/requirements.txt
```

Plex's **Allow media deletion** setting must be on.

## Running it by hand

```sh
PLEX_TOKEN=… SEERR_API_KEY=… TAUTULLI_API_KEY=… python apps/cleanup/purge_requests.py data/cleanup/config.json --dry-run
```
