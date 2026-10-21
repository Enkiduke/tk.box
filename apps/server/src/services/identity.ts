import type { Db } from '../persistence/database.js';
import type { PlexAdapter, PlexGrant } from '../providers/plex.js';
import { Vault, opaque, digest } from '../security/vault.js';
import { requireThat } from '../errors.js';

export class IdentityService {
  private authorizing = new Map<string,Promise<PlexGrant>>();
  constructor(private db: Db, private vault: Vault, private plex: PlexAdapter) {}
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
    const cookie = opaque(), sessionHash = digest(cookie), expires = now + 12 * 60 * 60 * 1000;
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
    const row = this.db.prepare('SELECT u.allowed FROM sessions s JOIN users u ON u.account_id=s.account_id WHERE s.hash=? AND s.expires>?').get(hash, now) as {allowed: number} | undefined;
    requireThat(row?.allowed, 'UNAUTHENTICATED', 'Session expired or revoked.', 401);
    return hash;
  }
  async authenticateHash(hash: string, now = Date.now()) {
    const row = this.db.prepare('SELECT s.*,u.allowed FROM sessions s JOIN users u ON u.account_id=s.account_id WHERE hash=? AND expires>?').get(hash, now) as {account_id: string; encrypted_credential: string; allowed: number} | undefined;
    requireThat(row?.allowed, 'UNAUTHENTICATED', 'Session expired or revoked.', 401);
    // Coalesce only overlapping checks (e.g. a grid of artwork requests), with
    // no successful-grant TTL. Every later request still checks Plex again.
    let pending=this.authorizing.get(hash);
    if(!pending){pending=this.plex.authorize(this.vault.open(row.encrypted_credential,hash)).finally(()=>this.authorizing.delete(hash));this.authorizing.set(hash,pending);}
    const grant=await pending;
    const current=this.db.prepare('SELECT s.account_id,u.allowed FROM sessions s JOIN users u ON u.account_id=s.account_id WHERE s.hash=? AND s.expires>?').get(hash,now) as {account_id:string;allowed:number}|undefined;
    requireThat(current?.allowed&&current.account_id===row.account_id,'UNAUTHENTICATED','Session expired or revoked.',401);
    requireThat(grant.accountId === row.account_id, 'ACCESS_DENIED', 'Plex account identity changed.', 403);
    return { hash, grant };
  }
  // The viewer's Plex account token, for Plex's cloud catalog and Seerr sign-in. Call only after authenticate().
  accountToken(hash: string) {
    const row = this.db.prepare('SELECT encrypted_credential FROM sessions WHERE hash=?').get(hash) as {encrypted_credential: string} | undefined;
    requireThat(row, 'UNAUTHENTICATED', 'Session expired or revoked.', 401);
    return this.vault.open(row.encrypted_credential, hash);
  }
  logout(cookie?: string) { if (cookie) this.db.prepare('DELETE FROM sessions WHERE hash=?').run(digest(cookie)); }
  reap(now = Date.now()) {
    this.db.prepare('DELETE FROM sessions WHERE expires<=?').run(now);
    this.db.prepare('DELETE FROM auth_challenges WHERE expires<=?').run(now);
    this.db.prepare('DELETE FROM playback_sessions WHERE expires<=?').run(now);
  }
}
