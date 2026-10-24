import { mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { IptvStore } from '../persistence/iptv-store.js';
import type { HealthStore } from '../persistence/channel-health-store.js';
import { ProviderConnections, type ConnectionLease } from '../streaming/provider-connections.js';
import { probeStream, type Prober } from './stream-probe.js';
import type { StreamGuard } from '../streaming/stream-guard.js';

// What the live relay layer tells the checker. Connections themselves are shared through
// ProviderConnections: a check only starts on a free one, and a new viewer cancels checks.
export type RelayUsage = { live: (channelId: string) => boolean };
type Check = { sourceId: string; abort: AbortController };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Background channel checks. Work is persisted as per-channel due times, so a restart resumes
// where it stopped and a large lineup is spread over the source's interval instead of bursting.
export class ChannelHealth {
  private checks = new Map<string, Check>();
  private timer: NodeJS.Timeout;
  private closed = false;
  private dir: string;
  relays: RelayUsage = { live: () => false };
  connections = new ProviderConnections(() => 1);
  // Checks read streams through the guard (public addresses only) unless their source allows local-network streams.
  guard?: StreamGuard;
  constructor(private store: IptvStore, private health: HealthStore, cacheDir: string, private ffmpeg = 'ffmpeg',
    private log: (message: string, detail: Record<string, unknown>) => void = () => {},
    private options = { maxChecks: 4, sampleSeconds: 7, tickMs: 5000 }, private probe: Prober = probeStream) {
    this.dir = join(cacheDir, 'channel-health');
    this.timer = setInterval(() => this.pump(), options.tickMs); this.timer.unref();
    void this.prune();
  }
  thumbnail(channelId: string) { return uuid.test(channelId) ? join(this.dir, `${channelId}.jpg`) : undefined; }
  // Cancelled checks stay listed until their process exits, but no longer hold a connection.
  active(sourceId?: string) { return [...this.checks.values()].filter(c => !c.abort.signal.aborted && (!sourceId || c.sourceId === sourceId)).length; }
  checking(channelId: string) { return this.checks.has(channelId); }
  queueSource(sourceId: string) { const queued = this.health.queueSource(sourceId); this.pump(); return queued; }
  queueChannels(sourceId: string, ids: string[]) { const queued = this.health.queueChannels(sourceId, ids); this.pump(); return queued; }
  queueChannel(channelId: string) { this.health.queueChannel(channelId); this.pump(); }
  tuned(channelId: string) { this.health.relayOnline(channelId); }
  // A failed tune is a strong hint; verify it now rather than waiting for the next sweep.
  tuneFailed(channelId: string) { try { this.queueChannel(channelId); } catch { /* left the lineup */ } }
  pump(now = Date.now()) {
    if (this.closed) return;
    for (const sourceId of this.health.dueSources(now)) {
      if (this.options.maxChecks - this.active() <= 0) break;
      // Channels already playing are settled from their relay and do not use up a connection.
      for (const channelId of this.health.due(sourceId, this.options.maxChecks * 3, new Set(this.checks.keys()), now)) {
        if (this.relays.live(channelId)) { this.health.relayOnline(channelId, now); continue; }
        if (this.options.maxChecks - this.active() <= 0) break;
        const check: Check = { sourceId, abort: new AbortController() };
        const lease = this.connections.tryCheck(() => check.abort.abort());
        if (!lease) break;
        this.start(channelId, check, lease);
      }
    }
  }
  private start(channelId: string, check: Check, lease: ConnectionLease) {
    this.checks.set(channelId, check);
    void (async () => {
      try {
        const { streamUrl, allowPrivate } = this.store.streamFor(channelId), proxy = allowPrivate ? undefined : await this.guard?.url();
        await mkdir(this.dir, { recursive: true, mode: 0o700 });
        const result = await this.probe(streamUrl, { ffmpeg: this.ffmpeg, signal: check.abort.signal, sampleSeconds: this.options.sampleSeconds, thumbnailPath: this.thumbnail(channelId), ...(proxy ? { proxy } : {}) });
        if (this.closed) return;
        const outcome = this.health.record(channelId, result);
        if (result.reason === 'CHECKER_UNAVAILABLE') this.log('channel check could not start FFmpeg', { channelId });
        if (outcome?.applied && outcome.status !== 'online' && outcome.status !== 'unchecked') this.log('channel check failed', { channelId, status: outcome.status, reason: result.reason });
      } catch (error) {
        // The channel was removed, ignored or conflicted while queued. Nothing to record.
        if (!this.closed) this.log('channel check skipped', { channelId, code: (error as { code?: string }).code });
      } finally {
        // The probe settles only after FFmpeg exits, so the connection is really closed here.
        lease.release();
        if (this.checks.get(channelId) === check) this.checks.delete(channelId);
        if (!this.closed) setImmediate(() => this.pump());
      }
    })();
  }
  // Thumbnails are a disposable cache; drop those of channels that no longer exist.
  async prune() {
    const ids = this.health.channelIds();
    for (const name of await readdir(this.dir).catch(() => [] as string[])) if (!ids.has(name.slice(0, 36))) await rm(join(this.dir, name), { force: true }).catch(() => {});
  }
  close() { this.closed = true; clearInterval(this.timer); for (const check of this.checks.values()) check.abort.abort(); this.checks.clear(); }
}
