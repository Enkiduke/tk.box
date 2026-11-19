# Clean Up (Admin › Server › Clean Up)

Deletes requested movies and shows once the people who asked for them have watched them, or had long enough to. It began as a Python cron script; its rules now run in tk.box itself.

## How it fits together

- **Rules:** `services/cleanup-rules.ts` decides, from facts tk.box already has: the requested titles on Plex (the requests module), each title's Plex copies, seasons and added dates (the Plex index, by TMDB/TVDB id; no title search), who watched what (watch history), the library's Keep and the Artwork collections. `services/cleanup-run.ts` deletes what is due from Plex (with its files) and updates Leaving Soon. After a real run tk.box's library forgets each title and season it deleted, and the requests of each whole title are marked removed. One job at a time (`services/cleanup-engine.ts`).
- **Settings live in tk.box's database** (`cleanup_config`). Libraries are Plex library IDs.
- **Watch history:** for every movie, show and season, the latest watch by anyone and by each requester and selected user (Plex account ids), from tk.box's own history (its player and Plex's apps) and the saved watch dates. A watch of any of a title's copies counts. It is kept per Plex server (`PLEX_MACHINE_ID`); a run refuses another server. A request with no available date uses Plex's added date; a season's date is its newest episode's.
- **Connections:** only Plex, with the Plex admin token (Admin › Connections).
- **Preview only** is on until an administrator turns it off. **Preview** never changes anything. `TKBOX_READ_ONLY` forces every run to be a preview.
- **Schedule:** on its schedule in server local time, at most hourly (every N hours, set times on chosen weekdays, or a cron expression), a missed time run up to two hours late. Like Artwork's schedules, it reads Plex with the Plex admin token (Admin › Connections) and waits while there is no working one.
- **Leaving Soon:** the collection's poster is `apps/server/assets/leaving-soon.png`.
- **Status:** when a run finishes it writes every movie, show and season it looked at to `DATA_DIR/cleanup/status.json` (status, library, deletion date and the rule behind it). The Status tab shows that file as posters grouped by status (soonest gone first), so it is as current as the last preview or clean up. Each entry carries its Plex `rating_key` for the poster and a hold key (`movie:<tmdb>`, `tv:<tmdb>` or `tv:<tmdb>:<season>`).
- **Holds:** an administrator can *start over* a title (its rule's full period again from today) from its dialog in the Status tab, or by right-clicking a Leaving Soon title there or in the library. Holds are kept in `cleanup_config` (`state:holds`), and only ever move a date later; the rule's own date wins once it is later still, and a hold lapses after its date. The Status tab shows a changed hold straight away; a run acts on it next time.
- **Jobs** keep their last 2000 lines of output. A restart marks unfinished jobs as canceled.

## Setup

Plex's **Allow media deletion** setting must be on, and Admin › Connections needs a working Plex admin token. Nothing else to install.
