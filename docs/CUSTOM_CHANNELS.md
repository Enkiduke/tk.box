# Custom Plex channels — design

October 18, 2026. Implements spec §5.4, §7.3 and §8 (`UNIFIED_MEDIA_PLATFORM_SPEC_v30.md`). dizqueTV (`references/dizquetv-main`, zlib) is a behavioral reference only; no source is copied.

## Scope

A custom channel is an administrator-made, ordered list of Plex movies and episodes that plays **one program after another, looping forever**, on a shared wall clock. Every viewer who tunes in sees the same program at the same position.

In scope:

- Channel Manager: create, rename, number, order, disable and delete channels, with a logo and summary.
- An in-app Plex picker for movies, whole shows, seasons and single episodes. Shows and seasons expand in season, then episode, order.
- Program list editing: add, remove, drag or keyboard reorder, intentional repeats, total runtime.
- **Arrange tools** (taken from dizqueTV), which only rewrite the draft list: shuffle, block shuffle (keeps runs of N episodes of a show together), sort by show, sort by release date, interleave shows evenly, remove duplicates, remove specials, replicate the list N times.
- Drafts, preview and publishing that takes effect at the next program boundary. Per-show **Automatically add new episodes**.
- Custom channels appear in the unified guide and player, with Pause, Resume and Go Live.

Out of scope permanently: filler, bumpers, commercials, time slots, start-time padding, logo watermarks, random slots, channel redirects and HDHomeRun/M3U export.

## What we take from dizqueTV and what we change

| dizqueTV | tk.box |
| --- | --- |
| Position is `(now - startTime) mod totalDuration`, walked through the list (`helperFuncs.getCurrentProgramAndTimeElapsed`) | Same idea, already in `services/scheduler.ts` (`resolveSlot`), anchored to an immutable published revision |
| Snaps to the program start when within 30 s of it, and to the next program within the last `SLACK` | No snapping. Viewers join at the exact clock position (spec LINEAR-04) |
| Saving a channel changes the schedule immediately and kills the playing streams (`channel-update` listener) | Publishing takes effect at the end of the current program. The next program is resolved by stable entry ID (LINEAR-43–58, already in `ChannelScheduler.publish`) |
| One FFmpeg per viewer, chained with `ffconcat` back into its own `/stream` URL | One shared pipeline per channel writes HLS segments indexed by broadcast time. Viewers each read their own manifest |
| Optional normalization re-encodes everything so players survive codec changes | Copy browser-safe H.264, encode only what must be encoded (within the shared 2-encoder budget), mark every program change with `#EXT-X-DISCONTINUITY` |
| Reports Plex timeline/progress while playing | Never writes Plex history (LINEAR-59). Media is read from disk, or as a plain part request |
| Doesn't watch Plex for new or removed media | Auto-add new episodes per show. Removed media is flagged in the editor |
| Program durations come from Plex metadata | Durations are checked against the file's actual playable length before publishing |
| Unauthenticated tuner and stream URLs | Every manifest and segment is authorized for the signed-in viewer |
| JSON files (diskdb) | SQLite with revisioned, transactional writes |

## Data model (new migration)

Existing tables reused: `channels` and `publications` (scheduler), `lineup_numbers` (one number namespace shared with IPTV) and `settings.pauseRetentionMinutes` (already defaults to 30).

- `custom_channels(id, name, summary, logo, enabled, created_at, revision)`, with the number and position in `lineup_numbers`.
- `custom_drafts(channel_id, revision, value)`. The draft is the editable list, stored as JSON: `{entries:[{entryId, mediaId, kind, title, show?, season?, episode?, durationMs, sourceId?, origin:'manual'|'auto'}]}`. The draft revision guards against concurrent edits.
- `custom_sources(id, channel_id, kind:'show'|'season', plex_id, auto_add, last_checked, last_result, last_error)` records each show or season selection.
- `custom_exclusions(source_id, plex_id)` stores episodes the administrator removed, so auto-add never brings them back.
- Published revisions stay in `publications.value`, as the existing `Timeline` (an immutable entry list plus `effectiveAt`, `cutoverAfterEntryId`, `nextEntryId` and `reason`). The publishing administrator and supersessions are recorded in `audit`.

Entry IDs are app-owned UUIDs. Reordering keeps an entry's ID, each intentional duplicate gets its own ID, and delete-then-re-add creates a new one.

## Scheduling

The scheduler computes the schedule from the clock and is never generated ahead. For time `t`, take the latest non-superseded publication with `effectiveAt <= t`, then `offset = (t - effectiveAt) mod cycle`. This is the existing `resolveSlot`. The guide asks for any window and gets exact program rows, so there's no 7-day table to keep in sync.

- **Publish:** the existing `ChannelScheduler.publish`. The current program finishes at its original end. The new list starts at the published successor of the airing entry, or at entry one if that entry was removed. A second publish before the cutover replaces the pending one.
- **Auto-add:** a background check (and a **Check for new episodes** button) adds new playable episodes. If a show's episodes are still one contiguous block in natural order, a new episode goes into its place in that block. Otherwise it goes right after the show's last entry. The change publishes automatically through the same safe-boundary path. If an administrator's publish is pending, auto-add rebases onto it and doesn't replace it.
- **Unavailable media:** publishing rejects entries with no playable file. If media disappears after publishing, its slot shows a plain "Program unavailable" slate until the slot's scheduled end, so the clock never shifts. The editor flags the entry, and the next auto-sync drops it at a safe boundary.
- **Channel compatibility:** when an item is added, its Plex stream info is checked against the streaming policy. An item that would need a forbidden encode (above 1080p and not browser-playable H.264) is marked **Not playable on channels** and can't be published.

## Playout

`services/custom-tv.ts` is a sibling of `LiveTv`. It reuses `DiskSegments`, `SegmentBuffer`, `ViewerCursor`, `LiveViewers`, `EncoderBudget` and `assertVideoEncode`.

1. **Tune:** authorize the viewer, resolve the current slot and start (or join) the channel's **station**. A station runs one program at a time: FFmpeg seeks into the program's file at the slot offset and writes MPEG-TS HLS segments. Each segment is timestamped in broadcast UTC (`slot.start + mediaPosition - mediaOffsetMs`) and published to the channel's `DiskSegments` once its broadcast time has passed.
2. **Codecs:** browser-safe H.264 (8-bit 4:2:0) is copied. Other video at 1080p or below is encoded with libx264 under one encoder permit. Audio is always AAC stereo. The first audio track is used for now (Plex-preferred track selection comes later).
3. **Boundaries:** about 30 seconds before a program ends, the station starts the next program's worker so its first segments are ready at the boundary. The first segment of each program carries `#EXT-X-DISCONTINUITY`. Transport continuity counters carry across, as in the spike (`ts-continuity.ts`).
4. **Input:** a local file through `LocalMedia` when `MEDIA_ROOTS` is configured. Otherwise a loopback-only part proxy, so the Plex token stays inside the Node process and never reaches FFmpeg's arguments or the process list. Either way, no timeline call is ever made.
5. **Viewers:** each viewer has a `ViewerCursor` and an authorized per-session manifest. LIVE serves the last few segments. PAUSED and PLAYING_DELAYED serve from the viewer's cursor, across program boundaries. Retention is `pauseRetentionMinutes`, with the byte cap and free-space floor from `DiskSegments`. When a cursor falls out of retention, the viewer gets `BUFFER_EXPIRED` and a **Go Live** button.
6. **Idle:** a station with no live viewers and no valid pause leases stops its FFmpeg and clears its cache. The schedule keeps advancing because it is only arithmetic.

## API

Admin:

- `GET/POST /api/v1/admin/custom-channels`
- `PATCH/DELETE /api/v1/admin/custom-channels/:id`
- `GET/PUT /api/v1/admin/custom-channels/:id/draft` (with `expectedRevision`)
- `POST /api/v1/admin/custom-channels/:id/draft/arrange` (`{tool, options}`, returns the new draft for review)
- `GET /api/v1/admin/custom-channels/:id/preview` (handoff: "Current X finishes at T → Next Y", plus projected rows)
- `POST /api/v1/admin/custom-channels/:id/publish`
- `PUT /api/v1/admin/custom-channels/:id/sources/:sourceId` (auto-add toggle)
- `POST /api/v1/admin/custom-channels/:id/sync`
- `GET/PATCH /api/v1/admin/settings/custom-channel-playback`

Viewer:

- `/api/v1/guide?filter=custom|all|favorites` includes custom rows with `type:'custom'`.
- `POST /api/v1/custom/sessions`
- `GET /api/v1/custom/sessions/:id/index.m3u8` and `/:segment`
- `POST /api/v1/custom/sessions/:id/{pause,resume,go-live}`
- `GET /api/v1/custom/sessions/:id/state`
- `DELETE /api/v1/custom/sessions/:id`

Favorites move to a source-neutral table, or `iptv_favorites` stops requiring an IPTV channel.

## UI

- **Settings → Channels:** a channel list with number, name, status (Live, Pending · goes live at …, Draft, Disabled) and reorder controls. The editor has four tabs: Details; Programs (picker on the left, program list on the right, arrange-tools menu, runtime total, warnings); Shows (auto-add toggles, last check, errors); and Publish (preview and handoff). Playback & Buffering holds retention, with a warning before a reduction and cache usage.
- **Live TV:** custom rows in the guide, using the Plex poster as the channel logo when none is set. The player shows Pause/Resume/Go Live and a "behind live" indicator only for custom channels.

## Build phases

1. **Channels and programming.** Migration, store, admin API, Channel Manager UI with picker, arrange tools, drafts, publish and preview. Custom rows in the guide (not yet tunable). Tests: arrange tools, the auto-add insertion rule, publish/rebase.
2. **Playout.** Station pipeline, tune, boundaries, idle stop, viewer authorization, unavailable slate. Requires a real check on the Linux host with real Plex files.
3. **Pause/Resume/Go Live.** Viewer cursors, retention setting, expiry, admin cache diagnostics.
4. **Auto-add.** Background sync, exclusions, audit trail, and sync status in the editor.

## Open risks

- Seeking mid-GOP when copying: the join starts at the previous keyframe, a few seconds early. That is acceptable for live, but the station must map timestamps from the actual first frame, not the requested offset.
- A/V alignment after a TS seek (about 443 ms on the old build, see `CONTINUOUS_SPIKE.md`) still needs checking on the maintained Linux FFmpeg.
- Two encoder permits are shared with VOD and IPTV, so channels that need encoding can be refused under load (`TRANSCODE_CAPACITY_REACHED`, no queue).
