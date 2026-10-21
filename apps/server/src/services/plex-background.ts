import type { PlexAdapter, PlexGrant } from '../providers/plex.js';
import type { ServiceKeys } from '../persistence/service-keys.js';
import { requireThat } from '../errors.js';

// Plex access for work nobody starts by hand (Artwork's and Collections' schedules and Plex's notification feed, Clean
// Up's schedule, automatic new episodes): the server owner's Plex token, saved in Admin › Connections. Plex vouches for
// it as the owner's before it's saved and again every few minutes while it's used; if Plex stops accepting it, the work
// waits. Plex being briefly unreachable keeps the last grant it accepted, for up to an hour.
const FRESH_MS = 10 * 60000, KEEP_MS = 60 * 60000;
export const WAITING = 'Waiting for a working Plex admin token (Admin › Connections).';

export class PlexBackground {
  private cached?: { token: string; grant: PlexGrant; at: number };
  private pending?: Promise<PlexGrant | undefined>;
  constructor(private keys: ServiceKeys, private plex: PlexAdapter, private log: (message: string, detail: Record<string, unknown>) => void = () => {}) {}
  // Undefined while there is no token, or Plex doesn't accept it as the owner's.
  grant(now = Date.now()) {
    const token = this.keys.get('plex');
    if (!token) return Promise.resolve(undefined);
    const cached = this.cached?.token === token ? this.cached : undefined;
    if (cached && now - cached.at < FRESH_MS) return Promise.resolve(cached.grant);
    this.pending ??= this.check(token).then(grant => { this.cached = { token, grant, at: now }; return grant; }, (e: Error & { code?: string }) => {
      this.log('plex admin token not usable', { code: e.code ?? 'PLEX_UNAVAILABLE' });
      if (e.code === 'PLEX_UNAVAILABLE' && cached && now - cached.at < KEEP_MS) return cached.grant;
      this.cached = undefined; return undefined;
    }).finally(() => { this.pending = undefined; });
    return this.pending;
  }
  // Plex's grant for `token`, which must be the server owner's.
  async check(token: string) {
    const grant = await this.plex.authorize(token);
    requireThat(grant.role === 'admin', 'PLEX_TOKEN_NOT_OWNER', 'That Plex token isn’t the server owner’s.', 400);
    return grant;
  }
  invalidate() { this.cached = undefined; }
}
