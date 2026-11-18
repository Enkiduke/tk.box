import { defineModule } from './module.js';
import { ADMINS } from '../persistence/notifications-store.js';
import { JobWatch, type JobAlert } from '../services/job-alerts.js';
import { connectionHealth, type LibraryHealth } from '../services/connection-health.js';
import { every, errorDetail } from '../lib/every.js';
import type { PlexGrant } from '../providers/plex.js';
import { isOwner } from '../services/identity.js';

type Check = ReturnType<typeof connectionHealth>;
type Deps = {
  // The connection check: the provider keys (ctx.serviceKeys), the downloaders and TVmaze. `transports` reach TMDB in
  // tests; `checkConnections` replaces the whole check (tests).
  downloaders?: LibraryHealth['downloaders'];
  transports?: Parameters<typeof connectionHealth>[1];
  checkConnections?: Check;
  // Told when an account signs in to tk.box for the first time.
  identity: { firstSignIn?: ((account: Pick<PlexGrant, 'accountId' | 'name' | 'role'>) => void) | undefined };
};
const WATCH_MS = 60000, CHECK_MS = 15 * 60000, PLEX_GRACE_MS = 5 * 60000, ENCODER_QUIET_MS = 3600000;
// A failed connection check is tried again CONFIRM_MS later, and only a second failure in a row is an alert (a busy
// moment or a blip never reaches the bell). The first background check waits STARTUP_MS, past the startup rush.
export const CONFIRM_MS = 60000, STARTUP_MS = 2 * 60000;
const names: Record<string, string> = { sabnzbd: 'SABnzbd', qbittorrent: 'qBittorrent', tmdb: 'TMDb', tvdb: 'TVDB', fanart: 'Fanart.tv', mdblist: 'MDBList' };

// The admins' system alerts (docs/NOTIFICATIONS.md): failing and held-back jobs, Run now finishing, connections that
// stop working (two failed checks in a row; checked every 15 minutes, and whenever Admin › Connections checks), the Plex live connection down
// for 5 minutes, streams refused at the transcode limit (at most hourly), and first sign-ins. Everything goes out as
// `notification.post` / `notification.resolve` on the bus. API `{checkConnections}`: Admin › Connections' check, which
// also updates the alerts.
export const systemAlertsModule = defineModule({
  name: 'system-alerts',
  setup(_routes, { bus, jobs, budget, log, serviceKeys }, { identity, downloaders, transports, ...deps }: Deps) {
    const checkConnections = deps.checkConnections ?? connectionHealth(() => serviceKeys.providers(), transports, downloaders ? { downloaders } : undefined, { tvmaze: true });
    const apply = (alerts: JobAlert[]) => {
      for (const a of alerts) {
        if (a.post) bus.emit('notification.post', a.post);
        if (a.resolve) bus.emit('notification.resolve', a.resolve);
      }
    };

    // Jobs.
    const watch = new JobWatch();
    jobs.ranByHand = id => watch.ranByHand(id);

    // Connections: a service that fails two checks in a row is a condition; a later good check closes it.
    const failing = new Set<string>();
    let confirm: ReturnType<typeof setTimeout> | undefined;
    const checked = async () => {
      const results = await checkConnections();
      let unconfirmed = false;
      for (const [id, result] of Object.entries(results)) {
        const name = names[id] ?? id, key = `connection.${id}`;
        if (result.state !== 'failed') {
          failing.delete(id);
          bus.emit('notification.resolve', { to: ADMINS, key, resolution: { title: `${name} is working again` } });
        } else if (failing.has(id)) bus.emit('notification.post', { to: ADMINS, kind: 'connection.failed', tone: 'error', title: `${name} isn’t working`,
          ...(result.detail ? { detail: result.detail } : {}), link: '#admin?section=connections', key });
        else { failing.add(id); unconfirmed = true; }
      }
      // Services no longer checked (their key was removed) start over.
      for (const id of [...failing]) if (!(id in results)) failing.delete(id);
      if (unconfirmed && !confirm) {
        confirm = setTimeout(() => { confirm = undefined; void checkNow().catch(e => log.warn('connection check failed', errorDetail(e))); }, CONFIRM_MS);
        confirm.unref();
      }
      return results;
    };
    const checkNow = () => jobs.track('system.connections', checked);
    jobs.add({ id: 'system.connections', label: 'Check connections', area: 'Connections', section: 'connections',
      schedule: () => ({ enabled: true, schedule: { kind: 'every', minutes: CHECK_MS / 60000 } }), status: () => jobs.tracked('system.connections'), run: checkNow });

    // The Plex live connection (library changes, Plex app playback): only a drop that lasts is worth an alert.
    let plexDown: ReturnType<typeof setTimeout> | undefined, plexAlerted = false;
    bus.on('plex.playback.connection', ({ connected }) => {
      if (connected) {
        if (plexDown) { clearTimeout(plexDown); plexDown = undefined; }
        if (plexAlerted) { plexAlerted = false; bus.emit('notification.resolve', { to: ADMINS, key: 'plex.connection', resolution: { title: 'Reconnected to Plex' } }); }
        return;
      }
      if (plexDown || plexAlerted) return;
      plexDown = setTimeout(() => {
        plexDown = undefined; plexAlerted = true;
        bus.emit('notification.post', { to: ADMINS, kind: 'plex.connection', tone: 'warning', title: 'Lost the live connection to Plex',
          detail: 'New titles and Plex app playback aren’t being picked up. tk.box keeps retrying.', link: '#admin?section=connections', key: 'plex.connection' });
      }, PLEX_GRACE_MS);
      plexDown.unref();
    });

    // The transcode limit: a refused stream, at most once an hour.
    let lastRefused = 0;
    budget.refused = limit => {
      const now = Date.now();
      if (now - lastRefused < ENCODER_QUIET_MS) return;
      lastRefused = now;
      bus.emit('notification.post', { to: ADMINS, kind: 'encoder.full', tone: 'warning', title: 'Transcoding limit reached',
        detail: `A stream was refused with ${limit} transcode${limit === 1 ? '' : 's'} running. Raise the limit in Admin › Playback.`, link: '#admin?section=playback' });
    };

    // A new account.
    identity.firstSignIn = account => {
      if (isOwner(account)) return;
      bus.emit('notification.post', { to: ADMINS, kind: 'user.new', tone: 'info', title: `${account.name ?? 'Someone new'} signed in for the first time`, link: '#admin?section=users' });
    };

    let watching: { stop(): void } | undefined, checking: { stop(): void } | undefined, first: ReturnType<typeof setTimeout> | undefined;
    return {
      api: { checkConnections: checked },
      start() {
        apply(watch.check(jobs.view()));
        watching = every(WATCH_MS, () => apply(watch.check(jobs.view())), e => log.warn('job alerts failed', errorDetail(e)));
        first = setTimeout(() => { void checkNow().catch(e => log.warn('connection check failed', errorDetail(e))); }, STARTUP_MS);
        first.unref();
        checking = every(CHECK_MS, checkNow, e => log.warn('connection check failed', errorDetail(e)));
      },
      stop() { watching?.stop(); checking?.stop(); clearTimeout(first); clearTimeout(confirm); if (plexDown) clearTimeout(plexDown); jobs.ranByHand = undefined; budget.refused = undefined; identity.firstSignIn = undefined; }
    };
  }
});
