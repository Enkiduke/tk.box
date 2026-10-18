# Continuous clock and retained-media spike

This follow-up advances Milestone 0 using **generated 320×180 fixtures**. It does not enable custom Plex or IPTV streaming in tk.box's production API.

## Timing findings and accepted local path

`npm run spike:timing` reproduces the original seek issue: the old local FFmpeg's TS seek produces audio about 443 ms ahead of video. Remuxing that seek into fMP4 alone does not fix alignment. An indexed MP4 reduces that case but still needs codec/GOP-specific validation. Do not treat metadata arithmetic as measured seek accuracy.

The new fixture uses indexed H.264/AAC without B frames for the copy path, and MPEG-4/PCM for the eligible CPU fallback. Each program is eight seconds; the output has four two-second segments. Files are generated on demand for the currently airing short fixture program, then only completed broadcast-time segments are published as the server clock advances. Multiple viewers share that work. This short-program pre-generation is an experiment, **not a production plan to pre-encode entire Plex movies**. Unwatched channels have no segment jobs, while their persisted schedule continues to advance.

Transport continuity counters now carry across program files without changing elementary payloads, PTS or PCR. HLS discontinuity tags still mark program timestamp boundaries. `spike:live:prepare` verifies compressed video payload hashes before/after the transport-header change, decodes all 400 expected video frames across the joined stream, and observes zero packet-corruption warnings. The joined output reports aligned initial audio/video start timestamps on this fixture. Sources with different profiles/GOPs/HDR/tracks/resolution remain separate integration gates.

An attempted CPU fMP4 path on this 2020 FFmpeg build produced corrupt decode output despite process exit success. The frame-count assertion caught it. CPU fMP4 command construction is now explicitly refused with `PACKAGING_NOT_VALIDATED`; the tested local CPU output remains MPEG-TS. A maintained Linux FFmpeg may support a validated fMP4 implementation later. Initialization-map and discontinuity-sequence support is tested independently without claiming that the rejected encode path works.

Manifest behavior follows [HLS RFC 8216](https://www.rfc-editor.org/rfc/rfc8216.html); the supported muxer options are documented by [FFmpeg](https://ffmpeg.org/ffmpeg-formats.html#hls-2). The actual local build is tested rather than assumed to implement every current option correctly.

## Working code

- `DiskSegments`: serialized, atomic file publication; charged segment/init bytes; age and hard byte-cap eviction; free-space floor; actual file deletion; init reference cleanup; no arbitrary filesystem URL exposure. A disk-pressure failure may shorten retention and expire affected viewer cursors. Partial writes are cleaned on failure.
- `LiveViewers`: opaque viewer IDs bound to a separate owner identity, per-file/program authorization, expiring heartbeat leases, independent displayed-UTC cursors, precise HLS start offsets, explicit expired-buffer errors and Go Live. Non-live cursors never alter the shared schedule. Revoked access is denied even when media is cached.
- `FixtureBroadcast`: persisted clock/anchor, shared per-program work, strict expected duration checks, cancellation, safe work cleanup, and a terminal latch for capacity/policy failures until manual Retry. Stop cancels outstanding child work and releases cache resources. Pure scheduler time continues while idle.
- `serve-live.ts`/`live-spike.html`: separate loopback-only browser experiment with temporary HttpOnly fixture cookies and CSRF protection. Two video elements represent **two experimental viewers**, not simultaneous production streams in one tab. All session manifests and segments check fixture ownership. No Plex sign-in bypass is mounted in the application.

The harness accelerates retention to **30 seconds** and uses a 2 MiB published-media cap and 64 MiB free-space floor. Those are experimental values; tk.box's persisted production retention remains **30 minutes**, and its configurable encoder default remains **2**. Fixture working files are separately bounded by the fixed eight-second/320×180 inputs; general streaming worker temp-space limits still need a production implementation.

## Evidence

`npm run spike:live:check` ran against a real 17-second wall clock and actual FFmpeg/filesystem operations:

- First completed media after approximately 2.0 seconds; maximum observed segment publication lateness 97 ms in that run.
- Two viewers share three per-program preparations across two full boundaries, rather than preparing once per viewer.
- One viewer's cursor stays fixed, resumes behind live, crosses a real program boundary, then returns to LIVE explicitly; the other viewer stays LIVE.
- A retained snapshot decodes 400 expected video frames with zero packet-corruption warnings. Peak cache 777,192 bytes; cache and encoder reservations return to zero on Stop.

The in-app browser separately played two clock-driven streams with no reported media error. Initially their displayed UTC positions differed by about 40 ms and were roughly 2.5 seconds behind server time. Viewer 1 paused while viewer 2 kept playing; after Resume its displayed time was about 17.2 seconds behind live and within roughly 150 ms of its backend delayed cursor, including through a program boundary. Go Live restored live playback without moving the other viewer; observed presentation latency was several seconds, not zero. The later live-start hint targets about three seconds when completed segments allow it; this is an engineering latency target, not a synchronization guarantee.

The browser also exercised the accelerated retention limit: viewer 1 stayed pinned until its cursor became `EXPIRED`, while viewer 2 continued live. Resume refused the expired position; Go Live was the explicit recovery action. This checks the generated-media browser flow, not real Plex permissions or the production 30-minute disk envelope.

The same browser run continued through dozens of generated program boundaries before both viewers were explicitly stopped. No browser media error was reported; this remains a controlled-profile observation rather than proof of long-running heterogeneous Plex playout.

Reports are reproducible under ignored `.local/live-spike/`: `preparation-report.json`, `continuous-report.json`; timing comparison is `.local/timestamp-spike/report.json`. `verify:plex` is a separate live gate and did not pass without configuration.

## Remaining work

Verify the maintained Ubuntu/Debian FFmpeg build, arbitrary mid-GOP source joins, exact A/V timing, long-duration clock drift, codec/resolution changes, real Plex history isolation and live provider transport. Connect this cache/session design to current Plex grants on every production manifest/segment, rather than fixture identities. Add whole-worker disk/memory/network quotas, crash/orphan cleanup and load measurements before exposing real media. The app-level persistent Live TV player/handoff and channel editor are still later milestones.
