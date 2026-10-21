import { AppError } from '../errors.js';
import type { CustomChannelStore, SyncResult } from '../persistence/custom-channels.js';
import type { PlexAdapter, PlexGrant } from '../providers/plex.js';

// Automatic new episodes for custom channels. Each enabled show or season selection is read from Plex now and then
// (and on demand), and genuinely new playable episodes are added through CustomChannelStore.applySync, which
// publishes at the next program boundary. Plex is read with the Plex admin token from Admin › Connections
// (services/plex-background.ts); the background check waits while there is no working one.
export class EpisodeSync {
  private running = new Map<string, Promise<SyncResult>>();
  private timer?: NodeJS.Timeout;
  constructor(private store: CustomChannelStore, private plex: PlexAdapter, private adminGrant: () => Promise<PlexGrant | undefined>,
    private log: (message: string, detail: Record<string, unknown>) => void = () => {}, private intervalMs = 3600000) {}
  start() { this.timer = setInterval(() => void this.tick(), this.intervalMs); this.timer.unref(); void this.tick(); }
  close() { clearInterval(this.timer); }
  // One check per selection at a time; a second request joins the running one.
  source(source: { id: string; plexId: string }, grant: PlexGrant, actor: string) {
    let work = this.running.get(source.id);
    if (!work) {
      work = this.plex.channelMedia(grant, source.plexId).then(({ items }) => this.store.applySync(actor, source.id, items), e => {
        const code = e instanceof AppError ? e.code : 'PLEX_UNAVAILABLE';
        this.store.syncFailed(source.id, code); this.log('episode check failed', { sourceId: source.id, code });
        throw e;
      }).finally(() => this.running.delete(source.id));
      this.running.set(source.id, work);
    }
    return work;
  }
  // Every enabled selection of one channel, for the Check for new episodes button.
  async channel(channelId: string, grant: PlexGrant, actor: string) {
    const sources = this.store.autoSources(channelId);
    const results = await Promise.allSettled(sources.map(s => this.source(s, grant, actor)));
    return { checked: sources.length, added: results.reduce((n, r) => n + (r.status === 'fulfilled' ? r.value.added : 0), 0), failed: results.filter(r => r.status === 'rejected').length };
  }
  async tick() {
    const sources = this.store.autoSources();
    if (!sources.length) return;
    const grant = await this.adminGrant().catch(() => undefined);
    if (!grant) { for (const s of sources) this.store.syncWaiting(s.id); return; }
    // One at a time keeps Plex load low; a failure leaves that selection's programs as they were.
    for (const s of sources) await this.source(s, grant, 'system:auto-add').catch(() => {});
  }
}
