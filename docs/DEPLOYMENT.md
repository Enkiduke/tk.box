# Native deployment draft

This recipe is prepared for Ubuntu/Debian and has **not** been executed on the owner's host. Complete the live validation gates before exposing actual media to viewers.

1. Install a maintained Node 22 or 24 LTS release and system `ffmpeg`/`ffprobe` appropriate to that OS. FFmpeg must include software H.264 (`libx264`), AAC, HTTP(S), MPEG-TS and HLS. No hardware encoders are used. `better-sqlite3` may need Python/make/g++ when a native prebuilt is unavailable.
2. Create a non-login service account and directories, then place the application outside `references`:

```sh
sudo useradd --system --home /var/lib/tk.box --shell /usr/sbin/nologin tk.box
sudo install -d -o tk.box -g tk.box -m 0700 /var/lib/tk.box /var/cache/tk.box
sudo install -d -o root -g tk.box -m 0750 /etc/tk.box
# Put reviewed application sources at /opt/tk.box, owned by the deployment administrator.
cd /opt/tk.box
npm ci
npm run typecheck
npm test
npm run build
```

3. Create `/etc/tk.box/tk.box.env` (root:tk.box, mode 0640) using `.env.example`. Set `DATA_DIR=/var/lib/tk.box`, `CACHE_DIR=/var/cache/tk.box`, `DEPLOYMENT_MODE=remote`, the protected Plex connection identifiers and the chosen `PUBLIC_BASE_URL=https://media.example.com`. No trailing path, credentials or query parameters. The default key is created at `/var/lib/tk.box/secret.key` with 0600 permissions; back it up separately. If moving the key to `/etc/tk.box`, pre-create it securely for the service user because the hardened service cannot create files there.
4. Pick an unused high port and bind address. Default loopback is appropriate only if the existing proxy can reach that loopback listener. For another LAN proxy, bind a specific reachable private address and firewall the app port to that proxy. Non-loopback startup emits a warning. `TRUSTED_PROXY_CIDRS` is an explicit comma-separated proxy IP/CIDR allowlist; it defaults to trusting none. Do not use blanket trust.
5. Run migrations/doctor under the service environment and install `deploy/tk.box.service` at `/etc/systemd/system/tk.box.service`. Ensure its `/usr/bin/node` matches the installed runtime. Then `sudo systemctl daemon-reload` and `sudo systemctl enable --now tk.box`. Inspect `journalctl -u tk.box`; restart after listener/environment changes. Runtime admin encoder/retention changes use SQLite settings and do not need a restart.
6. Configure the **existing owner-managed proxy** with one mapping:

```text
https://media.example.com/* -> http://<reachable APP_HOST>:<APP_PORT>/*
```

All compiled frontend/API/media paths share that listener. Do not install another proxy, provision certificates, expose worker ports, or prescribe port forwarding/tunnels. Remote browser access must use the configured HTTPS origin; never derive Plex links or cookie security from untrusted Host/forwarded headers. A mismatched `PUBLIC_BASE_URL` correctly rejects state-changing requests via the origin/JSON CSRF boundary.

For eventual long-lived HLS and byte-range delivery: retain Range/Content-Range/Accept-Ranges and upstream status, allow sustained responses and sensible upstream read timeouts, disable buffering that delays live segments, avoid caching protected responses, preserve same-origin authenticated cookies, and forward manifests/segments without path rewriting. No WebSocket implementation currently requires upgrade handling. The current direct VOD route rechecks account/item access at request boundaries and periodically during long responses, aborts on logout/Stop, and proxies only validated Plex part paths. Remote streaming behavior still requires verification.

## Secrets, logs, updates and recovery

### Upgrading an existing Enki installation

Stop the old service before changing paths. Preserve the complete state directory, encryption key, `client-id`, cache and environment values. With the service stopped, rename `enki.sqlite` to `tk.box.sqlite`, including any matching `-wal`, `-shm` or `-journal` sidecars; never rename only the main database while it is open. Do not overwrite an existing destination database. No schema or credential changes are required for the rebrand.

For a deployed Linux installation, move the old application/configuration/state/cache directories to the tk.box paths in the recipe above, migrate ownership to the new service account, update any absolute environment paths, and replace the old systemd unit with `deploy/tk.box.service`. Disable the old unit before enabling the new one so only one backend owns the state. The public URL and port can remain the same. Existing Enki browser cookies and saved preferences are migrated to tk.box names when used, preserving sessions and viewer choices. Preview sessions retain their separate namespaces.

### Routine recovery

- Plex account credentials are encrypted using AES-256-GCM with session hash as authenticated context. Cookies and linking challenges are opaque; database session identifiers are SHA-256 hashes. Viewer server tokens are resolved afresh from Plex account resources and never returned in API URLs. No owner token substitutes for a viewer token.
- Restrict the state directory and backups (service UMask 0077). Windows ACLs require equivalent local protection during development; POSIX mode bits alone do not set Windows ACLs. Never commit `.env`, keys, databases or real provider fixtures.
- tk.box creates a key only at the default path (`DATA_DIR/secret.key`) on first run. A `SECRET_KEY_FILE` that doesn't exist stops startup (`SECRET_KEY_MISSING`) instead of making a new key there, and a key that can't decrypt the database's stored values stops it too (`SECRET_KEY_MISMATCH`). To move the key, stop tk.box, move the file, set `SECRET_KEY_FILE` to its absolute path and start again. On a shared host, keep the state directory mode 0700 and the key 0600; moving the key elsewhere on the same disk adds little.
- The key is essential for decrypting sessions/source snapshots. This initial version has no online key-rotation command. To rotate safely now: stop tk.box; take a protected offline backup; revoke encrypted app sessions; re-encrypt any retained source snapshots under a new host key with an audited offline migration, or remove/reimport those prototypes; restart and relink. Do not replace the key under live encrypted rows.
- Stop the service before a simple SQLite backup. Back up `tk.box.sqlite` and the rest of the state directory consistently after shutdown, but leave `secret.key` out of those backups: keep one copy of the key somewhere else (a password manager, say), since a database backup and its key together give away everything encrypted in it. Do not copy only the SQLite main file while WAL writes are active. Restore while stopped, preserving account ownership/permissions. Do not restore playback sessions as live media jobs; there are no auto-started IPTV/FFmpeg workers on restart. Session expiry is enforced; explicitly revoke sessions when restoring an old backup.
- Generated `.local/media-spike` files and future cache segments are disposable and excluded from database backups. Schedules/settings are durable. Source cache prototypes encrypt transport URLs at rest; only sanitized status is intended for administrators.
- systemd supervises restarts; journald handles logs/retention via host policy. Logs use safe codes/request IDs and omit upstream URLs, tokens and raw exception payloads. Stop first before applying code/dependency updates, run checks/build/migrations, then restart. No automated schema downgrade is provided.
- A single backend process owns the in-memory encoder permits/shared pipeline registry. **Do not launch clustered/multiple backend processes** until admission/leases move to cross-process coordination. Children are bounded local diagnostic workers with hard timeouts; long-lived supervised workers are a remaining integration task.

`npm run doctor` reports OS/Node/FFmpeg, actual local CPU and free cache space, listener availability and Plex HTTP reachability. It deliberately does not assert external proxy reachability, account authorization, provider sharing permission, browser decoding or internet throughput. Run it under the same service environment and separately test those inputs.
