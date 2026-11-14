import { z } from 'zod';
import { defineModule } from './module.js';
import { authorize, session, viewer } from './access.js';
import { requireThat } from '../errors.js';
import { digest } from '../security/vault.js';
import { playbackObservation } from '../../../../packages/contracts/src/index.js';
import { describeClient } from '../services/activity.js';
import type { ActivityApi } from './activity.js';
import type { PlaybackHistory } from '../services/playback-history.js';
import type { SubtitleService } from '../services/subtitles.js';
import type { LiveTv } from '../services/live-tv.js';
import type { CustomTv } from '../services/custom-tv.js';
import type { IptvStore } from '../persistence/iptv-store.js';
import type { CustomChannelStore } from '../persistence/custom-channels.js';

type Deps = {
  live: LiveTv; iptv: IptvStore; customTv: CustomTv; custom: CustomChannelStore;
  // Admin › Activity and watch history, which every live and custom channel viewer reports to.
  activity: ActivityApi; history: PlaybackHistory; subtitles: SubtitleService;
};
type Params = { Params: { id: string } };

// Live sessions: watching a channel, IPTV or custom, through one set of routes. Starting picks the channel's player;
// playlists, segments, progress and stopping go to whichever owns the session. Pause, Resume and Go Live, program
// lists and subtitles exist only on custom channels; IPTV stays strictly live.
export const liveSessionsModule = defineModule({
  name: 'live-sessions',
  setup(routes, { plex, bus }, { live, iptv, customTv, custom, activity: { activity, source }, history, subtitles }: Deps) {
    bus.on('session.signed-out', ({ hash }) => { live.stopWhere(v => v.hash === hash); customTv.stopWhere(v => v.hash === hash); });
    // Admin › Activity rows: an IPTV viewer shows the guide's current program, a custom one the title airing for them.
    const program = (channelId: string, now: number) => {
      try {
        const p = iptv.guide(channelId, iptv.feedFor(channelId), now, now + 60000)[0]?.program;
        return p ? { title: p.title, start: p.start, end: p.end } : undefined;
      } catch { return undefined; }
    };
    source('live', {
      delivering: s => !!live.watching(s.id),
      describe: (s, now) => {
        const w = live.watching(s.id)!, p = program(s.channelId!, now);
        return { state: 'playing', delivery: w.delivery, source: w.source, program: p?.title, positionMs: p ? now - p.start : undefined, durationMs: p ? p.end - p.start : undefined };
      },
      stop: s => live.stop(s.id, s.hash)
    });
    source('custom', {
      delivering: (s, now) => !!customTv.watching(s.id, now),
      describe: async (s, now, title) => {
        const w = customTv.watching(s.id, now)!, media = await title(w.mediaId);
        return { state: w.state === 'PAUSED' ? 'paused' : 'playing', delivery: w.delivery, source: w.source, behindLiveMs: w.behindLiveMs, media, positionMs: media ? w.mediaMs : undefined, durationMs: media?.durationMs };
      },
      stop: s => customTv.stop(s.id, s.hash)
    });
    const timeshift = <T>(id: string, run: () => T) => { requireThat(customTv.has(id), 'NOT_SUPPORTED', 'Only Plex channels can be paused.', 409); activity.touch(id); return run(); };
    const asViewer = { config: { access: 'viewer' as const } };
    routes.get<Params>('/api/v1/live/sessions/:id/state', asViewer, async req => { const { hash } = viewer(req); return timeshift(req.params.id, () => customTv.state(req.params.id, hash)); });
    routes.post<Params>('/api/v1/live/sessions/:id/pause', asViewer, async req => {
      const { hash } = viewer(req), input = z.object({ displayedUtc: z.number().finite() }).strict().parse(req.body);
      return timeshift(req.params.id, () => customTv.pause(req.params.id, hash, input.displayedUtc));
    });
    routes.post<Params>('/api/v1/live/sessions/:id/resume', asViewer, async req => { const { hash } = viewer(req); z.object({}).strict().parse(req.body); return timeshift(req.params.id, () => customTv.resume(req.params.id, hash)); });
    routes.post<Params>('/api/v1/live/sessions/:id/go-live', asViewer, async req => {
      const { hash } = viewer(req), { id } = req.params;
      z.object({}).strict().parse(req.body);
      const state = timeshift(id, () => customTv.goLive(id, hash));
      history.suspend(id, hash);
      return state;
    });
    // Custom channels are Plex media, so they offer each program's subtitles; IPTV has none.
    routes.get<Params>('/api/v1/live/sessions/:id/programs', asViewer, async req => {
      const { hash } = viewer(req); requireThat(customTv.has(req.params.id), 'NOT_SUPPORTED', 'Only Plex channels have subtitles.', 409);
      return { programs: customTv.airings(req.params.id, hash) };
    });
    routes.get<{ Params: { id: string; airing: string; stream: string } }>('/api/v1/live/sessions/:id/subtitles/:airing/:stream', asViewer, async (req, reply) => {
      requireThat(/^\d+$/.test(req.params.stream) && /^[\w-]{1,32}$/.test(req.params.airing), 'INVALID_MEDIA', 'Invalid subtitle identifier.');
      const { hash, grant } = viewer(req); requireThat(customTv.has(req.params.id), 'NOT_SUPPORTED', 'Only Plex channels have subtitles.', 409);
      const item = await plex.metadata(grant, customTv.airingMedia(req.params.id, hash, req.params.airing));
      return reply.type('text/vtt; charset=utf-8').send(await subtitles.webvtt(grant, item, req.params.stream));
    });
    routes.post('/api/v1/live/sessions', { config: { access: 'viewer', rateLimit: { max: 30, timeWindow: 60000 } } }, async req => {
      const input = z.object({ channelId: z.string().uuid(), previousDeliveryId: z.string().regex(/^[\w-]{43}$/).optional() }).strict().parse(req.body);
      const { hash, grant } = viewer(req), own = custom.exists(input.channelId);
      const started = await (own ? customTv.start(hash, grant, input.channelId) : live.start(hash, input.channelId));
      const browser = { ip: req.ip, userAgent: req.headers['user-agent']?.slice(0, 400) };
      activity.open({ id: started.id, kind: own ? 'custom' : 'live', hash, accountId: grant.accountId, user: grant.name, delivery: started.delivery, ...browser,
        channelId: input.channelId, channel: { name: started.channel.name, number: started.channel.number }, source: started.source });
      const entry = {
        id: started.id, owner: hash, accountId: grant.accountId, accountName: grant.name, client: describeClient(browser.userAgent),
        media: { type: 'channel' as const, serverId: own ? 'custom' as const : 'iptv' as const, ratingKey: input.channelId,
          title: started.channel.name, number: started.channel.number },
        stream: { delivery: started.delivery, video: started.delivery === 'remux' ? 'copy' : 'transcode', audio: 'transcode',
          sourceHeight: started.source.height, sourceWidth: started.source.width }
      };
      history.open(entry, input.previousDeliveryId, Date.now(), own ? undefined : (from, to) => {
        try { return iptv.sameHistoryStation(from, to); }
        catch { return false; }
      });
      return started;
    });
    const recordLive = (id: string, hash: string, observation: z.infer<typeof playbackObservation>, epoch: number, replacing = false) => {
      const now = Date.now();
      if (customTv.has(id)) {
        const watcher = customTv.historyViewer(id, hash);
        if (watcher.state === 'EXPIRED') {
          history.suspend(id, hash);
          return;
        }
        if (watcher.state === 'PAUSED' && observation.state === 'playing') return;
        history.observe(id, hash, observation, now, { epoch, replacing, airings: watcher.airings });
      } else {
        const watcher = live.owned(id, hash), current = live.watching(id);
        const stream = current && { delivery: current.delivery, video: current.delivery === 'remux' ? 'copy' : 'transcode', audio: 'transcode',
          sourceHeight: current.source.height, sourceWidth: current.source.width };
        history.observe(id, hash, observation, now, { epoch, replacing, stream, airings: (from, to) => {
          // PDT is the relay clock. Upstream delay is unknown, so leave a margin around EPG changes.
          if (to > now + 2000 || from < now - 120000) return [];
          try {
            return iptv.historyGuide(watcher.channelId, from, to).flatMap(program =>
              from >= program.start + 30000 && to <= program.end - 30000 ? [{
                id: digest(JSON.stringify([program.channelId, program.start, program.end, program.title])), start: program.start, end: program.end,
                guide: { title: program.title, subtitle: program.subtitle, category: program.category, estimated: true as const }
              }] : []);
          } catch { return []; }
        } });
      }
    };
    routes.patch<Params>('/api/v1/live/sessions/:id/progress', { config: { access: 'session' } }, async req => {
      const { observation, epoch } = z.object({ observation: playbackObservation, epoch: z.number().int().nonnegative() }).strict().parse(req.body);
      recordLive(req.params.id, session(req), observation, epoch);
      return { status: 'accepted' };
    });
    // Playlists reauthorize fully, like VOD; segments use the local session check.
    routes.get<{ Params: { id: string; file: string } }>('/api/v1/live/sessions/:id/:file', { config: { access: 'session', rateLimit: { max: 1200, timeWindow: 60000 } } }, async (req, reply) => {
      const service = customTv.has(req.params.id) ? customTv : undefined;
      activity.touch(req.params.id);
      if (req.params.file === 'index.m3u8') {
        const { hash, grant } = await authorize(req, 'viewer');
        return reply.type('application/vnd.apple.mpegurl').send(await (service ? service.playlist(req.params.id, hash, grant) : live.playlist(req.params.id, hash)));
      }
      const segment = await (service ?? live).segment(req.params.id, session(req), req.params.file);
      activity.touch(req.params.id, segment.size);
      return reply.type('video/mp2t').header('content-length', String(segment.size)).send(segment.body);
    });
    routes.delete<Params>('/api/v1/live/sessions/:id', asViewer, async req => {
      const { hash } = viewer(req), { id } = req.params;
      const { replacing, observation, epoch } = z.object({ replacing: z.boolean().optional(), observation: playbackObservation.optional(),
        epoch: z.number().int().nonnegative().default(0) }).parse(req.body ?? {});
      if (history.ownsChannel(id, hash)) {
        if (observation?.state === 'stopped' && (customTv.has(id) || live.watching(id))) recordLive(id, hash, observation, epoch, replacing);
        history.end(id, replacing ? 'replacing' : 'stopped');
      }
      live.stop(id, hash); customTv.stop(id, hash);
      if (activity.get(id)?.hash === hash) activity.close(id);
      return { status: 'stopped' };
    });
    return { api: {} };
  }
});
