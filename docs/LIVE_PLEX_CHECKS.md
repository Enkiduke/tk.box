# Real Plex verification gate

## Initial local owner setup

Set `PLEX_URL` in `.env`, then run `npm run setup:plex -- start`. Open its official Plex sign-in link with the server owner's account and run `npm run setup:plex -- finish`. Challenges expire after at most ten minutes; restart if expired. This is a local CLI, not an unauthenticated web administrator-bootstrap endpoint.

The command verifies the configured server identity against a unique Plex-owned server resource, derives the stable numeric owner ID and required Movies/TV section IDs, then rechecks normal administrator authorization. Existing numeric owner/server/library constraints remain enforced. Empty optional configuration fields are treated as unset. A nonnumeric owner value can be repaired after verified ownership, while normal server startup still rejects nonnumeric account IDs. Configuration is updated through a same-directory temporary file, with revision-by-content checks before replacement; unrelated settings and comments are retained. Do not edit `.env` while a challenge is pending.

Only the short-lived challenge is persisted, encrypted with the application's local key. No account/server token is written to `.env`, source, console or setup report. Completion deletes the challenge. The ignored `.local/plex-setup/report.json` records sanitized outcome/counts. Linux temporary/state files use owner-only modes; maintain equivalent Windows ACLs. The CLI neither reads media nor sends watch-history updates. An interrupted finish can leave `.local/plex-setup/finish.lock`; remove it only after confirming that no finish command is active.

**Observed October 17, 2026:** the configured remote HTTPS server was reachable; live Plex PIN linking, ownership/resource/server identity checks, normal administrator authorization, and discovery of one Movies plus one TV library succeeded. Verified identifiers were saved to `.env`. No shared/unauthorized account or real media playback was tested by this setup. Restart tk.box and use normal browser sign-in for the application session; the setup command does not install a browser cookie.

## Full access and original-read checks

`npm run verify:plex` checks distinct owner/shared-viewer roles, refuses an unauthorized test account, downloads one authorized original part to verified EOF, then re-reads Plex history after a five-second settle interval. This is a bounded transport experiment, **not** proof of all custom-channel behavior or real browser PIN linking.

Configure the existing `PLEX_URL`, `PLEX_MACHINE_ID`, `PLEX_OWNER_ACCOUNT_ID` and `PLEX_REQUIRED_LIBRARY_IDS`. Supply **Plex account credentials** in owner-readable token files, not query strings, command-line token arguments, fixture source or chat messages. Use the linking flow or your existing protected account-token management. Never substitute the owner's server token for a viewer's account credential.

Set these environment variable names to file paths/identifiers:

```text
PLEX_TEST_OWNER_TOKEN_FILE=<protected owner account-token file>
PLEX_TEST_VIEWER_TOKEN_FILE=<protected shared-viewer account-token file>
PLEX_TEST_UNAUTHORIZED_TOKEN_FILE=<protected valid account-token file without server access>
PLEX_TEST_READ_ITEM=<numeric movie/episode rating key accessible to the viewer>
```

On Linux the files must have mode 0600 (or stricter). Protect equivalent Windows ACLs during development. Prefer a short permitted test item; do not put live tokens in `.env.example`. Using the protected environment file:

```sh
node --env-file=.env --import tsx scripts/verify-plex.ts
```

The read is capped at 512 MiB and two minutes. Oversized/incomplete delivery, wrong roles, unauthorized-account admission or changed history fails the command. It reads `viewOffset`, `viewCount` and `lastViewedAt`, preserving absence as a distinct value; the report records which history fields were actually present. It does not store media, log credential paths/URLs, restore history, send scrobble, or call the VOD reporter. Protect the ignored `.local/plex-verification/report.json` as operational data. A failure to provide configuration is a gate failure, never a simulated pass.

The earlier full-verifier run returned `SETUP_REQUIRED`. Remote configuration and owner setup are now verified as described above, but the full verifier still needs distinct protected owner/shared/unauthorized account token files and a designated test item. Fixture tests cover the verifier, including detection of an implicit history change; they do not establish real shared-account access or media/history behavior.

Still required before enabling custom Plex streaming:

1. Link real owner/viewer accounts in the workbench and verify rejection/revocation independently of token-file tests.
2. Designate a disposable/approved VOD test item and exercise actual Play/Pause/Seek/Stop/completion, confirming its viewer's resume/Continue Watching state. The read-only verifier deliberately does not modify real library history as a default diagnostic.
3. Run the actual custom playout transport at normal speed through natural completion, unattended progression, per-viewer pause, Resume and Go Live. Compare watched flag, offset, count, last-viewed and Continue Watching in Plex before/after for both accounts. A fast part download alone does not establish natural playback-completion behavior.
4. Check account-specific audio/subtitle preferences, current restrictions and source transitions, then test the owner's existing HTTPS proxy and target browsers. Capture delayed history changes beyond the initial settle window as well.
