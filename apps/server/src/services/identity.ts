import type { Db } from '../persistence/database.js';
import type { PlexAdapter, PlexGrant } from '../providers/plex.js';
import { Vault, opaque, digest } from '../security/vault.js';
import { AppError, requireThat } from '../errors.js';

// A sign-in lasts while it's used: each use pushes its end to a week out, so it ends only after 7 days unused.
// The row is written at most hourly, not on every video segment.
export const SESSION_IDLE_MS = 7 * 24 * 60 * 60 * 1000;
const RENEW_EVERY_MS = 60 * 60 * 1000;
export class IdentityService {
  private authorizing = new Map<string,Promise<PlexGrant>>();
  // A Plex check that passed is reused for `recheckMs` (0 checks every request), so a page of artwork doesn't
  // wait on plex.tv for each image. Sign-out and disabled accounts still apply at once: the session row is read every time.
  private grants = new Map<string,{grant:PlexGrant;until:number}>();
  // plex.tv now and then refuses or drops a check it passes a moment later, so a failed check is asked again after
  // each of `retryDelays` before the request fails; that keeps a brief Plex hiccup from stopping playback.
  constructor(private db: Db, private vault: Vault, private plex: PlexAdapter, private recheckMs = 0, private retryDelays = [500, 1500]) {}
  async start(now = Date.now()) {
    const count = this.db.prepare('SELECT count(*) AS n FROM auth_challenges WHERE expires>?').get(now) as {n: number};
    requireThat(count.n < 100, 'LOGIN_LIMIT', 'Too many pending sign-ins.', 429);
    const pin = await this.plex.createPin(), binding = opaque();
    this.db.prepare('DELETE FROM auth_challenges WHERE expires<=?').run(now);
    this.db.prepare('INSERT INTO auth_challenges(hash,pin_id,code,expires) VALUES(?,?,?,?)').run(digest(binding), pin.id, pin.code, now + Math.min(pin.expiresIn * 1000, 600000));
    return { binding, authUrl: this.plex.authUrl(pin.code) };
  }
  async finish(binding: string, now = Date.now()) {
    const hash = digest(binding);
    const challenge = this.db.prepare('SELECT * FROM auth_challenges WHERE hash=? AND expires>?').get(hash, now) as {pin_id: number; code: string; last_poll: number} | undefined;
    requireThat(challenge, 'AUTH_EXPIRED', 'Plex sign-in expired. Start again.', 401);
    requireThat(now - challenge.last_poll >= 2000, 'POLL_TOO_FAST', 'Wait before polling again.', 429);
    this.db.prepare('UPDATE auth_challenges SET last_poll=? WHERE hash=?').run(now, hash);
    const accountToken = await this.plex.pollPin(challenge.pin_id, challenge.code);
    if (!accountToken) return undefined;
    const grant = await this.plex.authorize(accountToken);
    const cookie = opaque(), sessionHash = digest(cookie), expires = now + SESSION_IDLE_MS;
    this.db.transaction(() => {
      const claimed = this.db.prepare('DELETE FROM auth_challenges WHERE hash=?').run(hash);
      requireThat(claimed.changes === 1, 'AUTH_EXPIRED', 'Sign-in challenge was already consumed.', 401);
      this.db.prepare('INSERT OR IGNORE INTO users(account_id) VALUES(?)').run(grant.accountId);
      const user = this.db.prepare('SELECT allowed FROM users WHERE account_id=?').get(grant.accountId) as {allowed: number};
      requireThat(user.allowed, 'ACCESS_DENIED', 'Account access is disabled.', 403);
      this.db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(sessionHash, grant.accountId, this.vault.seal(accountToken, sessionHash), expires);
    })();
    return { cookie, grant };
  }
  async authenticate(cookie: string | undefined, now = Date.now()) {
    requireThat(cookie, 'UNAUTHENTICATED', 'Sign in with Plex.', 401);
    return this.authenticateHash(digest(cookie), now);
  }
  // Local-only session check for high-frequency media segments. Callers must
  // pair it with periodic full Plex reauthorization (authenticateHash).
  session(cookie: string | undefined, now = Date.now()) {
    requireThat(cookie, 'UNAUTHENTICATED', 'Sign in with Plex.', 401);
    const hash = digest(cookie);
    const row = this.db.prepare('SELECT s.expires,u.allowed FROM sessions s JOIN users u ON u.account_id=s.account_id WHERE s.hash=? AND s.expires>?').get(hash, now) as {expires: number; allowed: number} | undefined;
    requireThat(row?.allowed, 'UNAUTHENTICATED', 'Session expired or revoked.', 401);
    this.renew(hash, row.expires, now);
    return hash;
  }
  async authenticateHash(hash: string, now = Date.now()) {
    const row = this.db.prepare('SELECT s.*,u.allowed FROM sessions s JOIN users u ON u.account_id=s.account_id WHERE hash=? AND expires>?').get(hash, now) as {account_id: string; encrypted_credential: string; expires: number; allowed: number} | undefined;
    requireThat(row?.allowed, 'UNAUTHENTICATED', 'Session expired or revoked.', 401);
    this.renew(hash, row.expires, now);
    const recent=this.grants.get(hash);
    if(recent&&recent.until>now&&recent.grant.accountId===row.account_id)return { hash, grant: recent.grant };
    // Overlapping checks (e.g. a grid of artwork requests) share one Plex call.
    let pending=this.authorizing.get(hash);
    if(!pending){pending=this.authorize(this.vault.open(row.encrypted_credential,hash)).finally(()=>this.authorizing.delete(hash));this.authorizing.set(hash,pending);}
    const grant=await pending;
    const current=this.db.prepare('SELECT s.account_id,u.allowed FROM sessions s JOIN users u ON u.account_id=s.account_id WHERE s.hash=? AND s.expires>?').get(hash,now) as {account_id:string;allowed:number}|undefined;
    requireThat(current?.allowed&&current.account_id===row.account_id,'UNAUTHENTICATED','Session expired or revoked.',401);
    requireThat(grant.accountId === row.account_id, 'ACCESS_DENIED', 'Plex account identity changed.', 403);
    if(this.recheckMs>0){
      this.grants.delete(hash);this.grants.set(hash,{grant,until:now+this.recheckMs});
      while(this.grants.size>1000)this.grants.delete(this.grants.keys().next().value!);
    }
    return { hash, grant };
  }
  private async authorize(accountToken: string) {
    for (let attempt = 0; ; attempt++) {
      try { return await this.plex.authorize(accountToken); }
      catch (error) {
        const brief = error instanceof AppError && ['PLEX_ACCESS_DENIED', 'PLEX_UNAVAILABLE'].includes(error.code);
        if (!brief || attempt >= this.retryDelays.length) throw error;
        await new Promise(resolve => setTimeout(resolve, this.retryDelays[attempt]));
      }
    }
  }
  private renew(hash: string, expires: number, now: number) {
    if (expires < now + SESSION_IDLE_MS - RENEW_EVERY_MS) this.db.prepare('UPDATE sessions SET expires=? WHERE hash=?').run(now + SESSION_IDLE_MS, hash);
  }
  // Drops a reused Plex check, so the session's next request asks Plex again (after Plex refused it something).
  forget(cookie: string | undefined) { if (cookie) this.grants.delete(digest(cookie)); }
  // The viewer's Plex account token, for Plex's cloud catalog and Seerr sign-in. Call only after authenticate().
  accountToken(hash: string) {
    const row = this.db.prepare('SELECT encrypted_credential FROM sessions WHERE hash=?').get(hash) as {encrypted_credential: string} | undefined;
    requireThat(row, 'UNAUTHENTICATED', 'Session expired or revoked.', 401);
    return this.vault.open(row.encrypted_credential, hash);
  }
  logout(cookie?: string) { if (cookie) { this.db.prepare('DELETE FROM sessions WHERE hash=?').run(digest(cookie)); this.forget(cookie); } }
  reap(now = Date.now()) {
    for (const [hash, entry] of this.grants) if (entry.until <= now) this.grants.delete(hash);
    this.db.prepare('DELETE FROM sessions WHERE expires<=?').run(now);
    this.db.prepare('DELETE FROM auth_challenges WHERE expires<=?').run(now);
    this.db.prepare('DELETE FROM playback_sessions WHERE expires<=?').run(now);
  }
}
