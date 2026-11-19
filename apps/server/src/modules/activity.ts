import { defineModule } from './module.js';
import { viewer } from './access.js';
import { requireThat } from '../errors.js';
import { plexRow, type Title } from '../activity-api.js';
import { describeClient, isLocalAddress, PlexFreshness } from '../services/activity.js';
import { sessionPosition, sessionRate, type PlaybackSessions, type Session, type StreamDelivery, type StreamKind, type StreamSource } from '../services/playback-sessions.js';
import type { PlexGrant, PlexSession } from '../providers/plex.js';

export type ActivityStream = Session & { positionMs?: number; rateKbps?: number };
// What a stream's own module adds to its Admin › Activity row.
export type ActivityDetail = {
  state: 'playing' | 'paused'; delivery: StreamDelivery; source?: StreamSource; media?: Title; positionMs?: number; durationMs?: number;
  behindLiveMs?: number; program?: string;
};
// The module that delivers a kind of stream: its row's details. (Ending one, Stop included, is the session registry's.)
export type ActivitySource = {
  describe: (s: ActivityStream, now: number, title: (mediaId: string | undefined) => Promise<Title | undefined> | undefined) => ActivityDetail | Promise<ActivityDetail>;
};
// `streaming`: how many streams are playing, in tk.box or any Plex app (anyone streaming holds back Artwork's nightly
// full collections run).
export type ActivityApi = { source: (kind: StreamKind, source: ActivitySource) => void; streaming: (grant: PlexGrant) => Promise<number> };
// `sessions`: tk.box's own streams (the playback session registry); `monitor`: Plex's own apps' sessions (watch
// history's Plex playback monitor).
type Deps = { sessions: PlaybackSessions; monitor: { sessions(grant: PlexGrant): Promise<PlexSession[]> } };

// Admin › Activity: who is watching what, how it is delivered, and a way to end a stream. tk.box's streams are the
// playback session registry's; each playback module registers a source that describes its kind's rows.
export const activityModule = defineModule({
  name: 'activity',
  setup(routes, { plex }, { sessions, monitor }: Deps) {
    const plexSessions = (grant: PlexGrant) => monitor.sessions(grant);
    const sources = new Map<StreamKind, ActivitySource>();
    // Titles are read with the administrator's grant, which reaches every library; a failed lookup just shows no title.
    const titles = new Map<string, Promise<Title | undefined>>(), fresh = new PlexFreshness();
    const title = (grant: PlexGrant, id: string | undefined) => {
      if (!id) return undefined;
      if (titles.size > 300) titles.clear();
      let found = titles.get(id);
      if (!found) {
        found = plex.metadata(grant, id).then((m): Title => ({ title: m.title, type: m.type, year: m.year, show: m.grandparentTitle, season: m.parentIndex, episode: m.index, durationMs: m.duration,
          posterId: m.type === 'episode' ? m.grandparentRatingKey ?? m.ratingKey : m.ratingKey }), () => { titles.delete(id); return undefined; });
        titles.set(id, found);
      }
      return found;
    };
    routes.get('/api/v1/admin/activity', { config: { access: 'admin' } }, async req => {
      const { grant } = viewer(req), now = Date.now();
      const streams = sessions.list().map((s): ActivityStream => ({ ...s, positionMs: sessionPosition(s, now), rateKbps: sessionRate(s, now) }));
      const rows = await Promise.all(streams.map(async s => {
        const base = { id: s.id, kind: s.kind, user: s.user ?? 'Plex user', accountId: s.accountId, client: describeClient(s.userAgent), ip: s.ip, local: isLocalAddress(s.ip),
          startedAt: s.started, quality: s.quality, target: s.target, rateKbps: s.rateKbps ?? 0, channel: s.channel, channelId: s.channelId };
        return { ...base, ...await sources.get(s.kind)!.describe(s, now, id => title(grant, id)) };
      }));
      // Plex's own apps, read live from Plex; when Plex can't be reached, tk.box's streams still show.
      let plexError: string | undefined, others: ReturnType<typeof plexRow>[] = [];
      try { others = fresh.filter((await plexSessions(grant)).map(m => plexRow(m, now)), now); } catch { plexError = 'Plex’s own streams couldn’t be read. Only tk.box streams are shown.'; }
      const all = [...rows.map(r => ({ ...r, canStop: true })), ...others], total = (list: typeof all) => list.reduce((n, r) => n + r.rateKbps, 0);
      return { streams: all, transcodes: all.filter(r => r.delivery === 'transcode').length, bandwidthKbps: total(all), wanBandwidthKbps: total(all.filter(r => !r.local)), plexError };
    });
    // Ending a stream here stops its delivery the way the viewer's own Stop would.
    routes.delete<{ Params: { id: string } }>('/api/v1/admin/activity/:id', { config: { access: 'admin' } }, async req => {
      const { grant } = viewer(req);
      if (req.params.id.startsWith('plex:')) {
        const id = req.params.id.slice(5);
        requireThat(/^[\w-]{1,100}$/.test(id), 'SESSION_NOT_FOUND', 'That stream has already ended.', 404);
        await plex.terminateSession(grant, id, 'This stream was stopped by the server administrator.');
        return { status: 'stopped' };
      }
      requireThat(sessions.end(req.params.id, 'admin'), 'SESSION_NOT_FOUND', 'That stream has already ended.', 404);
      return { status: 'stopped' };
    });
    const api: ActivityApi = {
      source(kind, source) {
        if (sources.has(kind)) throw new Error(`Activity source ${kind} is already registered.`);
        sources.set(kind, source);
      },
      streaming: async grant => sessions.count + (await plexSessions(grant)).length,
    };
    return { api };
  }
});
