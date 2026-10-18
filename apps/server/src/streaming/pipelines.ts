import { requireThat } from '../errors.js';

export type PipelineKey = { sourceId: string; channelId: string; credentialScope: string; rendition: string; tracks: string; protocol: string };
type Pipeline = { stop: () => Promise<void> };
type Record = { refs: number; ready: Promise<Pipeline>; closing?: Promise<void> };
export class SharedPipelines {
  private records = new Map<string, Record>();
  async join(key: PipelineKey, provider: { sharingAllowed: boolean; maxConnections: number }, viewerSessionId: string, authorize: () => Promise<void>, start: () => Promise<Pipeline>): Promise<() => Promise<void>> {
    await authorize(); // Sharing is never authorization; re-run on every protected media delivery too.
    const id = JSON.stringify([key.sourceId, key.channelId, key.credentialScope, key.rendition, key.tracks, key.protocol, ...(provider.sharingAllowed ? [] : [viewerSessionId])]);
    let record = this.records.get(id);
    if (record?.closing) {
      await record.closing;
      return this.join(key, provider, viewerSessionId, authorize, start);
    }
    if (!record) {
      const count = [...this.records.keys()].map(k => JSON.parse(k) as string[]).filter(k => k[0] === key.sourceId).length;
      requireThat(count < provider.maxConnections, 'IPTV_CONNECTION_LIMIT', 'Provider connection limit reached.', 503);
      // Publish the startup promise before invoking asynchronous work; pending startups count too.
      record = {refs: 0, ready: Promise.resolve().then(start)};
      this.records.set(id, record);
    }
    record.refs++;
    try { await record.ready; } catch (e) { record.refs--; if (this.records.get(id) === record) this.records.delete(id); throw e; }
    const selected = record; let released = false;
    return async () => {
      if (released) return; released = true; selected.refs--;
      if (selected.refs === 0) {
        // Keep the entry during shutdown to avoid racing a replacement with an open upstream.
        selected.closing = Promise.resolve().then(async () => {
          await (await selected.ready).stop();
          if (this.records.get(id) === selected) this.records.delete(id);
        });
        await selected.closing;
      }
    };
  }
  get count() { return this.records.size; }
}
export const recoveryDelays = [2000, 5000, 10000] as const;
export function retryNetworkFailure(code: string, attempt: number) {
  return ['UPSTREAM_DISCONNECTED', 'UPSTREAM_STALLED', 'UPSTREAM_TIMEOUT'].includes(code) ? recoveryDelays[attempt] : undefined;
}
