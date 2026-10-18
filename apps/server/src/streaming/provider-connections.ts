import { AppError } from '../errors.js';

export type ConnectionLease = { release: () => void; closing: () => void };
type Lease = { sourceId: string; kind: 'viewer' | 'check'; cancel?: () => void; closing: boolean };
type Waiter = { sourceId: string; grant: () => void };

// Provider plans allow a fixed number of simultaneous streams per account (often one or two).
// Everything that opens an upstream stream holds a lease here until its process has exited,
// so a relay or check that is still shutting down keeps counting until its socket is gone.
// Viewers always come first: a viewer cancels running checks and waits for them to exit,
// and a check never starts while a viewer is waiting or the source is full. Viewers never
// displace each other; once viewers hold every connection, the next one is refused.
export class ProviderConnections {
  private leases = new Set<Lease>();
  private waiters: Waiter[] = [];
  constructor(private limit: (sourceId: string) => number, private waitMs = 15000) {}
  usage(sourceId: string) {
    const held = this.of(sourceId);
    return { limit: this.limit(sourceId), viewers: held.filter(l => l.kind === 'viewer').length, checks: held.filter(l => l.kind === 'check').length };
  }
  tryCheck(sourceId: string, cancel: () => void): ConnectionLease | undefined {
    if (this.queued(sourceId) || this.of(sourceId).length >= this.limit(sourceId)) return undefined;
    return this.lease({ sourceId, kind: 'check', cancel, closing: false });
  }
  async viewer(sourceId: string, signal?: AbortSignal): Promise<ConnectionLease> {
    const limit = this.limit(sourceId), held = this.of(sourceId), queued = this.queued(sourceId);
    if (!queued && held.length < limit) return this.lease({ sourceId, kind: 'viewer', closing: false });
    const watching = held.filter(l => l.kind === 'viewer' && !l.closing).length + queued;
    if (watching >= limit) throw new AppError('LIVE_CONNECTIONS_FULL', `This provider allows ${limit} connection${limit === 1 ? '' : 's'} at a time and ${limit === 1 ? 'it is' : 'all are'} in use. Try again when someone stops watching.`, 503, true);
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
      const fail = (error: AppError) => { done(); reject(error); this.drain(sourceId); };
      const abort = () => fail(new AppError('MEDIA_CANCELLED', 'Live session was stopped.', 409));
      const timer = setTimeout(() => fail(new AppError('LIVE_CONNECTIONS_BUSY', 'A provider connection did not free up in time. Please try again.', 503, true)), this.waitMs);
      const waiter: Waiter = { sourceId, grant: () => { done(); resolve(this.lease({ sourceId, kind: 'viewer', closing: false })); } };
      signal?.addEventListener('abort', abort, { once: true });
      this.waiters.push(waiter);
    });
  }
  private of(sourceId: string) { return [...this.leases].filter(l => l.sourceId === sourceId); }
  private queued(sourceId: string) { return this.waiters.filter(w => w.sourceId === sourceId).length; }
  private lease(lease: Lease): ConnectionLease {
    this.leases.add(lease);
    return {
      closing: () => { lease.closing = true; },
      release: () => { if (this.leases.delete(lease)) this.drain(lease.sourceId); },
    };
  }
  private drain(sourceId: string) {
    while (this.of(sourceId).length < this.limit(sourceId)) {
      const next = this.waiters.find(w => w.sourceId === sourceId);
      if (!next) return;
      next.grant();
    }
  }
}
