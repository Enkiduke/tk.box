# Milestone 0 playback findings

## Evidence from the local generated-media experiment

Run `npm run spike:media`. It generates eight seconds each of H.264/AAC in MPEG-TS and MPEG-4/PCM in AVI, probes them with the real ffprobe executable, remuxes the first source starting at a schedule-derived two-second offset, CPU-encodes the incompatible second source, writes actual HLS segments, assembles a discontinuous manifest, decodes it with FFmpeg, and compares compressed video payload hashes on a full-copy path. No actual service credentials or downloaded media are used.

October 17 result on this Windows/i7-9700K development machine with FFmpeg 2020-11-11:

- Join offset: 2000 ms; generated segment boundary agrees with the synthetic clock boundary (0 ms arithmetic error).
- MPEG-TS → HLS copy preserves the compressed video payload SHA-256.
- Joined manifest decodes 350 frames over 14 seconds; the segment-aligned delayed manifest decodes 300 frames.
- Seven segments occupy 618,896 bytes, indexed once for two independent simulated viewer cursors. This is **not** a production retention/cache estimate.
- One old-FFmpeg `Packet corrupt` warning occurs at the TS timestamp discontinuity, although all expected video frames decode. Investigate packet/timestamp signaling and test a maintained Linux FFmpeg and real browsers before committing to this boundary architecture. Successful decoding does not prove seamless A/V playback.
- A fabricated 4K HEVC classification is rejected during command construction, before starting any encoder. No actual 4K fixture was encoded or tested for direct playback.

The reproducible machine-readable run report is `.local/media-spike/report.json` (ignored, regenerable). Timings vary between runs and are only costs for **320×180 synthetic** media. They do not establish 1080p concurrency, real-time startup, seeking accuracy at arbitrary GOP positions, production CPU throughput, disk retention, or external network bandwidth.

`npm run spike:serve` exposes the finite generated manifests to a loopback-only HTML/HLS browser harness. It uses actual video/HLS decoding and two video elements as **two independent experimental viewers**, not two production streams in one app tab. In this pass the in-app browser loaded both at 320×180, reached readyState 4, played concurrently and completed without a reported media error. A second run paused viewer 1 at 1.947678 seconds; its cursor remained there while viewer 2 continued to the end at 12 seconds, then viewer 1 was resumed through its normal Play control and reached completion. This verifies basic independent browser Pause/Resume over finite retained media, not bounded live-buffer expiry or browser Go Live. The joined stream initially reported 14 seconds and finished at about 14.443 seconds; the delayed one finished at 12 seconds. That duration change is additional timestamp/A/V continuity evidence to investigate, not a seamless-playback acceptance pass. The application itself has one persistent video element, and its workbench exposes only VOD direct delivery.

## Route policy implemented

| Source/condition | Result |
| --- | --- |
| Compatible source codec/bit depth, audio and container | Direct; no encoder permit |
| Compatible video, different container and/or unsupported audio | HLS remux; `-c:v copy`; audio conversion if necessary |
| Verified ≤1920×1080 source, including portrait equivalent, requires video compatibility/quality conversion | Software libx264/AAC only after synchronous global permit reservation |
| Original request that would need video encoding | Explicit incompatibility |
| Manual 720p/1080p cap with smaller compatible original | Keep original; no upscaling |
| Unknown/invalid source dimensions or any above-1080p source requiring encode | `QUALITY_NOT_PERMITTED` before encoder command/spawn |
| Compatible original 4K HEVC | Policy allows direct; actual browser/proxy path unverified |
| 4K HEVC remux or audio conversion | Negotiation fails unless hosting permission was explicitly verified; no production enabling flag is exposed |
| 4K HEVC scaling/burn-in/tone-map/video conversion | Always prohibited; generic worker exposes no arbitrary video filters/encoder arguments |
| New eligible encoder when limit is full | Immediate `TRANSCODE_CAPACITY_REACHED` / HTTP 503, manual Retry; no queue or automatic retry |
| Compatible existing shared encoder | Reuse pipeline; one permit per worker, independent viewer authorization |

Client capability reports are advisory. Codec name/bit depth and `canPlayType` do not capture all profile/level, HDR, audio layout, OS/decoder and packaging differences. The workbench's direct route requires real browser verification; its API explicitly returns `LIVE_VALIDATION_REQUIRED` for non-direct routes instead of pretending a streaming session exists. Local FFmpeg workers are executed by the CLI spike, not connected to production playback yet. Existing adaptive HLS rendition parsing/selection, actual track/preferences negotiation and managed Plex transcodes remain pending.

The encoder budget is deliberately single-process and synchronous; pending worker starts reserve before spawning, release in `finally`, and never wait for a slot. Settings are persisted with revision preconditions and audit. Lowering the limit does not terminate existing permits. Video copy/audio-only routes do not reserve video slots. The local worker separately caps total media jobs at four. App-initiated Plex transcodes must use this same admission interface when implemented; external Plex-client transcodes are outside its control.

## Timeshift implementation direction

The implemented prototype separates persistent schedule time, shared segment metadata and viewer cursor state. Real segments carry program/revision, sequence, byte size, broadcast start/end, and discontinuity. The index enforces time/byte eviction and returns removed entries for physical deletion by a future cache owner. Each viewer can freeze the displayed broadcast timestamp, resume with constant behind-live delay, expire explicitly, or Go Live without changing the station schedule. Lower retention or absent segment coverage expires the cursor; it never silently jumps to the oldest available content. Retention defaults to 30 minutes in SQLite and supports validated 5–120 minute engineering bounds.

A production implementation must connect that index to atomic segment-file publication, free-space floors, global/channel quotas, deletion and leases, periodic reaping, per-viewer authenticated manifests and segment permissions. Resume must map the browser's displayed PTS/PDT to the retained UTC cursor, including subsegment offset; the finite delayed manifest begins at a containing segment and is not frame-exact by itself. HLS discontinuity counters/initialization/profile changes and segment sequence persistence must be validated. No arbitrary seeking, restart-program, IPTV timeshift or inactive-channel recording is introduced.

## Plex history and access gates

The real HTTP adapter implements PIN creation/polling, account identity, server resource matching, resource-scoped viewer credentials, configured machine identity, required library checks, item metadata and original byte-range delivery. SQLite binds encrypted account credentials to hashed opaque sessions. Login owner role is determined by configured stable account ID plus ownership. Authentication is rerun for protected requests; item access is checked using the viewer's credential. Stop/logout abort open VOD responses; long responses revalidate at a bounded interval. No owner-token fallback exists.

The progress service loads immutable playback mode and ownership from storage before accepting any timeline update. `custom_linear`/`iptv_live` calls are rejected and fixture tests observe no upstream history requests. This proves the **tk.box code boundary**, not Plex's implicit behavior. Custom streaming is not enabled until before/after watched-state checks on a real Plex server pass across natural completion, pause/resume and Go Live. Real VOD resume/completion semantics and owner/shared/unauthorized accounts must also be verified before release.

## IPTV remaining integration work

The parsers, matching, conservative reconciliation and encrypted last-good snapshot store are working prototypes. M3U syntax alone cannot prove a response is a complete provider snapshot. The future fetch layer needs complete transport/decompression checks, provider-specific completeness evidence, suspicious-count-drop protection and administrator review for uncertain data; it must never hide channels based on an untrusted partial list. Unknown/recycled identities remain quarantined. The current reconciliation conservatively requires review on a provider-name change; a stable-ID/corroborating-metadata reconciliation strategy is needed to accept legitimate renames while rejecting recycled IDs.

Source intervals persist independently at 12h (M3U) and 6h (XMLTV), bounded 1–168 whole hours. Uploaded snapshots are marked non-refreshable. Failed refresh state preserves encrypted last-good snapshots and authentic future guide coverage. The cache prototype is not a complete source manager/background runner or an authorization boundary by itself; it is not exposed to viewers. Mapping suggestions remain advisory; explicit unique exact-ID resolution or admin approval produces a scoped mapping. No age cutoff invents or hides genuine scheduled coverage.

Shared upstream registration includes source/channel/credential/rendition/tracks/protocol and provider permission/limits; startup is single-flight and reference-counted, with the closing pipeline still occupying its provider slot until stopped. Each attach authorizes separately. The finite recovery controller coordinates one reconnect cycle, preserves retry count across unstable recoveries, resets only after stability, supports cancellation and excludes capacity/policy/auth/rate-limit failures. These are tested with injected operations; an actual provider fetch/remux/relay pipeline is still required, including SSRF-resistant origin/DNS/redirect policy. No arbitrary URL-fetch or proxy endpoint has been exposed.
