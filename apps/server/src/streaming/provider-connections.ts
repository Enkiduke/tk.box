import { AppError } from '../errors.js';

export type ConnectionLease = { release: () => void; closing: () => void };
type Lease = { kind: 'viewer' | 'check'; cancel?: () => void; closing: boolean };
type Waiter = { grant: () => void };

// Provider plans allow a fixed number of simultaneous streams (often one or two), and every
// source of this server counts against the same limit. Everything that opens an upstream stream
// holds a lease here until its process has exited, so a relay or check that is still shutting
// down keeps counting until its socket is gone. Viewers always come first: a viewer cancels
// running checks and waits for them to exit, and a check never starts while a viewer is waiting
// or every connection is taken. Viewers never displace each other; once viewers hold every
// connection, the next one is refused.
export class ProviderConnections {
  private leases = new Set<Lease>();
  private waiters: Waiter[] = [];
  constructor(private limit: () => number, private waitMs = 15000) {}
  usage() {
    const held = [...this.leases];
    return { limit: this.limit(), viewers: held.filter(l => l.kind === 'viewer').length, checks: held.filter(l => l.kind === 'check').length };
  }
  tryCheck(cancel: () => void): ConnectionLease | undefined {
    if (this.waiters.length || this.leases.size >= this.limit()) return undefined;
    return this.lease({ kind: 'check', cancel, closing: false });
  }
  async viewer(signal?: AbortSignal): Promise<ConnectionLease> {
    const limit = this.limit(), held = [...this.leases], queued = this.waiters.length;
    if (!queued && held.length < limit) return this.lease({ kind: 'viewer', closing: false });
    const watching = held.filter(l => l.kind === 'viewer' && !l.closing).length + queued;
    if (watching >= limit) throw new AppError('LIVE_CONNECTIONS_FULL', `Live TV allows ${limit} connection${limit === 1 ? '' : 's'} at a time and ${limit === 1 ? 'it is' : 'all are'} in use. Try again when someone stops watching.`, 503, true);
    // Take back just enough connections from checks for this viewer and those queued ahead.
    let open = held.filter(l => !l.closing).length + queued + 1 - limit;
    for (const lease of held) {
      if (open <= 0) break;
      if (lease.kind !== 'check' || lease.closing) continue;
      lease.closing = true; lease.cancel?.(); open--;
    }
    signal?.throwIfAborted();
    return new Promise<ConnectionLease>((resolve, reject) => {
      const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); this.waiters = this.waiters.filter(w => w !== waiter); };
      const fail = (error: AppError) => { done(); reject(error); this.drain(); };
      const abort = () => fail(new AppError('MEDIA_CANCELLED', 'Live session was stopped.', 409));
      const timer = setTimeout(() => fail(new AppError('LIVE_CONNECTIONS_BUSY', 'A provider connection did not free up in time. Please try again.', 503, true)), this.waitMs);
      const waiter: Waiter = { grant: () => { done(); resolve(this.lease({ kind: 'viewer', closing: false })); } };
      signal?.addEventListener('abort', abort, { once: true });
      this.waiters.push(waiter);
    });
  }
  private lease(lease: Lease): ConnectionLease {
    this.leases.add(lease);
    return {
      closing: () => { lease.closing = true; },
      release: () => { if (this.leases.delete(lease)) this.drain(); },
    };
  }
  private drain() { while (this.waiters.length && this.leases.size < this.limit()) this.waiters[0]!.grant(); }
}
