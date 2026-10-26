import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { IptvStore } from './persistence/iptv-store.js';
import { SportsStore, sportsPolicy, sportsSettings, SPORT_ORDER } from './persistence/sports-store.js';
import type { SportsSchedule } from './services/sports-schedule.js';
import { LEAGUE_NAMES, leagueSport } from './providers/sports-feeds.js';
import { requireThat } from './errors.js';

type Access = (req: FastifyRequest) => Promise<{ grant: { accountId: string } }>;
// Administrator-only: the event-driven source policy and which channel carries which event.
export function registerSports(app: FastifyInstance, iptv: IptvStore, store: SportsStore, schedule: SportsSchedule, admin: Access) {
  const params = (p: unknown) => { const id = z.object({ id: z.string().uuid() }).parse(p).id; requireThat(iptv.status(id).kind === 'm3u', 'INVALID_POLICY', 'Sports events apply to M3U sources only.'); return id; };
  const view = (id: string, now = Date.now()) => {
    const windows = store.windows(id), names = new Map(iptv.adminChannels(id).map(c => [c.id, c.name]));
    const channels = [...windows.values()].map(w => ({ channelId: w.channel_id, name: names.get(w.channel_id) ?? '', title: w.title, league: w.league, start: w.start, end: w.end, state: w.state, matchedBy: w.matched_by, airing: w.visible_from <= now && w.visible_until > now })).sort((a, b) => a.start - b.start);
    return { policy: store.policy(id), lastSync: schedule.lastSync, lastError: schedule.lastError, events: store.count(now), summary: { matched: channels.length, airing: channels.filter(c => c.airing).length }, channels };
  };
  app.get('/api/v1/admin/iptv/sources/:id/sports', async req => { await admin(req); return view(params(req.params)); });
  app.put('/api/v1/admin/iptv/sources/:id/sports', async req => {
    const { grant } = await admin(req), id = params(req.params); store.setPolicy(grant.accountId, id, sportsPolicy.parse(req.body)); schedule.invalidate(); return view(id);
  });
  // Live Events settings: every downloaded league (configured or seen in a schedule), plus any still selected.
  const settingsView = (now = Date.now()) => {
    const settings = store.settings(), configured = new Set(schedule.leagues()), seen = new Map(store.leagues(now).map(l => [l.key, l]));
    const keys = [...new Set([...configured, ...seen.keys(), ...settings.leagues])];
    const sport = (s: string) => (SPORT_ORDER as readonly string[]).includes(s) ? s : 'sports';
    const leagues = keys.map(key => ({ key, name: LEAGUE_NAMES[key] ?? seen.get(key)?.name ?? key, sport: sport(configured.has(key) || !seen.has(key) ? leagueSport(key) : seen.get(key)!.sport), configured: configured.has(key), upcoming: seen.get(key)?.upcoming ?? 0 }));
    return { settings, leagues, lastSync: schedule.lastSync, lastError: schedule.lastError };
  };
  app.get('/api/v1/admin/sports/settings', async req => { await admin(req); return settingsView(); });
  app.put('/api/v1/admin/sports/settings', async req => {
    const { grant } = await admin(req), { expectedRevision, ...input } = sportsSettings.extend({ expectedRevision: z.number().int().nonnegative() }).strict().parse(req.body);
    const before = store.settings().numberStart, saved = store.setSettings(grant.accountId, expectedRevision, input);
    // Rematch now, so hidden leagues leave the lineup before the reply, then move live channels into a new block.
    schedule.match();
    if (saved.numberStart !== before) iptv.renumberEvents();
    return settingsView();
  });
}
