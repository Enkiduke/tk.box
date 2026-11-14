# Removing Tautulli (review, 2026-11-14)

For step 7 of `docs/REQUESTS.md`. Only Clean Up actually calls Tautulli. Everything else is comments, the health check or the Connections card.

Decisions (2026-11-14):
- Tautulli `user_id` and `history_sessions.account_id` were checked on the server and match.
- A **Save watch history** button takes the snapshot. The button goes after a successful snapshot.

## 1. Uses and replacements

| Use | What it does | Replacement |
|---|---|---|
| `purge_support/history.py` `TautulliClient.watch_status` | Latest play by anyone and by each requester and exempt user, for each movie (`rating_key`), show (`grandparent_rating_key`) or season (`parent_rating_key`). Counts partial and in-progress plays (`include_activity=1`). If a scoped lookup fails, it checks every episode. | `history_sessions` ⋈ `history_media`: `MAX(started_at)` per `account_id`, scoped by `rating_key` / `metadata.showId` / `metadata.seasonId`, `source IN ('vod','plex')`, `watch_ms>0`. `native_history.py` already runs exactly this query. Indexes `history_media_by_show` / `_by_season` exist. No per-episode fallback is needed. |
| `TautulliClient.added_at` (`resolve_added_dates`) | Fills a missing `available_at` with the date Plex added the title. | Plex's own `item.addedAt`, which is the same value Tautulli shows and is already loaded. `native_history.compare` already uses it. |
| Per-user ids (`exempt_user_ids`, `requester_plex_id`) | Tautulli `user_id`, the plex.tv account id. | `history_sessions.account_id` is the plex.tv id too: the Plex monitor maps PMS's local owner `1` to the owner's id (`plex-playback-monitor.ts:171`), and VOD uses `grant.accountId`. It is stored as TEXT, so compare as strings, as `native_history` does. The "Plex user IDs" field stays. Only its copy changes. |
| `purge_requests.py` | Builds `TautulliClient` and logs "Tautulli added_at". | Builds the native reader. `--compare-native-history` and `NativeHistoryPreview.compare` go. |
| `config.py` | `tautulli` service, required in `validate()`. | Removed. |
| `policy.py`, `api.py` | Comments only (`MissingAddedAtError`, key redaction). | Reword them. |
| `cleanup-engine.ts` | `CleanupServices.tautulli`, `tautulli.url` in the config, `TAUTULLI_API_KEY`, "Connect Tautulli" in `cleanupMissing`, the `--compare-native-history` arg. | Remove them. Add watches to the config (see below). |
| `modules/cleanup.ts` | Passes `own.tautulliUrl/Key` into services. | Remove it. Add a `history` dep (watch-history mounts earlier). |
| `cleanup-store.ts` | `connections` row (`tautulliUrl`, sealed `tautulliKey`), `connectionsView`, `updateConnections`, `cleanupConnectionsInput`, the audit event. | Remove them, plus the cleanup migration `drop-tautulli` that deletes `cleanup_config` row `connections`. |
| `cleanup-api.ts` | `connected.tautulli`, the `/admin/cleanup/connections` routes, a comment. | Remove them. |
| `connection-health.ts` | `get_tautulli_info` check. | Remove it, and the `tautulli` service. |
| `admin-connections.tsx` | Tautulli card and `CleanupView`. | Remove them. |
| `cleanup-admin.tsx` | `connected.tautulli`, header comment, and "A play recorded in Tautulli counts". | "A play tk.box saw (its player or Plex's apps) counts". |
| `activity-api.ts`, `modules/activity.ts`, `plex-notifications.ts`, `artwork-schedule.ts`, `artwork-store.ts`, `engine_common.py`, `artwork_engine.py` (`--added` help), `docs/ARTWORK.md` | Comments that compare to Tautulli or mention the old hook. | Reword them. Nothing calls Tautulli. |
| `docs/CLEANUP.md` | Connections, the native comparison bullet, `TAUTULLI_API_KEY=` in the manual run. | Rewrite them. |

**SQLite vs run config: put watches in the run config.** That matches requests, and the script stops knowing tk.box's schema, DB path and server id. tk.box doesn't know Plex rating keys per request, so send an aggregate keyed by Plex key:
`watches: { server_id, movie|show|season: { "<ratingKey>": { any: ms, users: { "<plexId>": ms } } } }`.
Limit `users` to requesters plus exempt ids. Expect a few thousand entries. The script checks `server_id` against `plex.machineIdentifier` and fails the run if they differ.

## 2. Gaps and risks

- **History from before tk.box recorded is the main risk.** Missing watches only ever move dates **earlier**:
  - Rule 1 ("requester watched": last watch by anyone + 30d) turns into Rule 2 (added + 60d). For an old title that date has already passed, so the title is due at once.
  - Rule 4 (exempt user watched + 180d) turns into Rule 3 (any watch or added + 90d).
  - Rule 2's "someone else watched it" extension disappears.
  - The first real run after the switch could delete titles that were watched recently, before tk.box started recording.
- **Fix: save the last-watched dates once, then add new watches.** While Tautulli is still connected, a final snapshot run records what the current `TautulliClient.watch_status` returns for every title Clean Up looks at, then stops reading Tautulli. That is the latest watch by anyone and by each requester and exempt user, for each movie, show and season.
  - tk.box keeps the snapshot as a fixed table: scope, Plex rating key, account (or "any") and date. Nothing ever writes to it again.
  - After that, each run uses the later of the snapshot date and tk.box's own history, for each scope and user.
  - Rules still recalculate when settings change, and "requester watched" keeps working for watches from before the switch.
  - The snapshot holds one row per title and user, not every play. Admin › History is unaffected.
- **Limits of the snapshot:**
  - It only covers titles that run found. Any title that comes out `error` or `not_found` has no saved dates, so the snapshot must be repeated until nothing fails, or each failure listed.
  - It only covers the users known then. Someone added to `exempt_user_ids` later has no pre-switch watches of their own, though "any" still covers them.
  - It is keyed by the Plex rating key, like everything else here.
  - Requests that become available after the switch don't need it: they count from `available_at`.
- Alternatives considered:
  - A full import of Tautulli's history into `history_*`: more work, and it mixes old plays into Admin › History.
  - Keeping the last deletion dates as a floor: they are frozen with today's settings, and `status.json` loses a title's row after one bad run.
  - Plex's own `/status/sessions/history/all`: it only records finished views, and its `accountID` is a local id that needs mapping.
- **Gaps while tk.box is down.** Plex-app plays aren't seen while tk.box is down or the monitor has no admin token. Tautulli had the same weakness when it was down, but it ran separately from tk.box. Keep the line in CLEANUP.md. A safety check could refuse a real run if the monitor was disconnected for long since the last run.
- **Rating-key churn.** History is keyed by the rating key at play time. If Plex re-adds an item under a new key, its history is lost. Tautulli had the same problem, so this is no worse.
- **Sources.** Live TV and custom channels (`history_live_allocations`) are rightly excluded. A Plex app session that plays through tk.box must not be counted twice. That only affects `watch_ms`, and `MAX(started_at)` doesn't care.
- **Partial plays.** Tautulli counted any recorded play. Native counts `watch_ms>0`, which is a little stricter. Recording starts are equivalent.

## 3. Recommended order (add under step 7)

Steps 1 and 2 are built (2026-11-14, not committed):
- **Script:** `purge_support/watch_snapshot.py` records every movie, show and all of a show's seasons before protections apply. A title not found in Plex doesn't make the snapshot incomplete; a failed title does.
- **Saving:** `CleanupEngine.saveWatchHistory` and `snapshotRows` check the file, and `CleanupStore.saveWatchSnapshot` stores it.
- **Watches:** `HistoryStore.latestWatches` reads tk.box's history, and `cleanupWatches` merges it with the snapshot into the config's `watches`. The script doesn't read them yet.
- **Page:** `POST /admin/cleanup/watch-snapshot` and the button in Clean Up's header.

1. **Snapshot the last-watched dates** (while Tautulli is still connected):
   - A dry-run flag `--watch-snapshot <file>` makes the script write the `watch_status` for every movie, show and season it checks, plus its Plex `server_id`. It uses the existing `TautulliClient`.
   - A **Save watch history** button in Admin › Server › Clean Up starts that run as a job.
   - tk.box adds a cleanup migration `watch-snapshot` (a `cleanup_watch_snapshot` table: scope, rating_key, account, at). It saves the file only after a run with no failed titles (`not_found` is fine: it has nothing to keep), and shows how many titles and dates were saved. The button can be pressed again until Tautulli is removed.
   - Tests: the store keeps the later date on a retake, rejects a failed run's file, and checks `server_id`.
2. **Add watches to the run config:**
   - `cleanupConfig` takes the later of the snapshot and HistoryStore's aggregate (sources `vod`, `plex`), for each scope and user.
   - `modules/cleanup.ts` gets a `history` dep.
   - Tests: `cleanup.test.ts` (aggregate shape, max with the snapshot, per-user filter, server id).
3. **Python switch:**
   - A `ConfigHistory` reader replaces `TautulliClient`: `watch_status` from the config, `added_at` from `item.addedAt`.
   - Delete `history.py` and `native_history.py`, the `tautulli` service in `config.py`, and the `--compare-native-history` and `--watch-snapshot` flags.
   - Remove the Save watch history button and its route. Keep the table.
   - Reword `policy.py` and `api.py`.
4. **You:** take the snapshot, then run a dry run and compare it with the last Tautulli-based Status. Look especially at titles marked Rule 1 or Rule 4: their dates should match or be later.
5. **Remove the connection:** the `TAUTULLI_API_KEY` secret and `cleanupMissing` line, the `cleanup-store.ts` connections and the cleanup migration `drop-tautulli`, the `cleanup-api.ts` routes and `connected.tautulli`, the `connection-health.ts` check, the Admin › Connections card, and the `cleanup-admin.tsx` copy.
   - Tests: `cleanup.test.ts` (drop the connections test and the "Connect Tautulli" assertion, add the migration), `connection-health.test.ts` (drop the tautulli fixture and expected state), `arr.test.ts` (the legacy `connections` row: assert that `drop-tautulli` removes it after the arr move), `activity.test.ts` (rename only).
6. **Comments and docs:** activity, plex-notifications, artwork schedule/store, the artwork Python, ARTWORK.md and CLEANUP.md (including the manual run).
7. **Check:** `grep -ri tautulli` matches only REQUESTS.md and this review. The snapshot table doesn't name Tautulli. Run typecheck and the tests above.

There are no Python tests for the purge script today, so step 3 has no tests to update. Add a small one for `ConfigHistory` scopes if wanted.
