import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { openDatabase } from '../apps/server/src/persistence/database.js';
import { IptvStore } from '../apps/server/src/persistence/iptv-store.js';
import { HealthStore } from '../apps/server/src/persistence/channel-health-store.js';
import { SportsStore, type SportsSettings } from '../apps/server/src/persistence/sports-store.js';
import { SportsSchedule } from '../apps/server/src/services/sports-schedule.js';
import { Vault } from '../apps/server/src/security/vault.js';
import { channelWindow, eventScore, nameTime, cleanTitle, type SportsEvent } from '../apps/server/src/services/sports-match.js';
import { espnEvents, tsdbEvents, espnLeagueLogo, tsdbLeagueLogo } from '../apps/server/src/providers/sports-feeds.js';

const HOUR = 3600_000, now = Date.parse('2026-10-18T17:30:00Z');
// Shapes as returned by ESPN's scoreboard and TheSportsDB's free v1 API on 2026-10-18.
const nfl = espnEvents('football/nfl', { leagues: [{ abbreviation: 'NFL' }], events: [
  { id: '401872996', name: 'Houston Texans at Jacksonville Jaguars', date: '2026-10-18T17:00Z', status: { type: { state: 'in' } }, competitions: [{ competitors: [
    { team: { displayName: 'Jacksonville Jaguars', shortDisplayName: 'Jaguars', name: 'Jaguars', location: 'Jacksonville', abbreviation: 'JAX' } },
    { team: { displayName: 'Houston Texans', shortDisplayName: 'Texans', name: 'Texans', location: 'Houston', abbreviation: 'HOU' } }] }] },
  { id: '401872997', name: 'Atlanta Falcons at Chicago Bears', date: '2026-10-19T00:20Z', status: { type: { state: 'pre' } }, competitions: [{ competitors: [
    { team: { displayName: 'Chicago Bears', shortDisplayName: 'Bears', name: 'Bears', location: 'Chicago', abbreviation: 'CHI' } },
    { team: { displayName: 'Atlanta Falcons', shortDisplayName: 'Falcons', name: 'Falcons', location: 'Atlanta', abbreviation: 'ATL' } }] }] }] });
const ufc = espnEvents('mma/ufc', { events: [{ id: '600061267', name: 'UFC 333: Volkanovski vs. Evloev', date: '2026-10-18T22:00Z', status: { type: { state: 'pre' } }, competitions: [] }] });
const boxing = tsdbEvents({ events: [{ idEvent: '1', strEvent: 'Dalton Smith vs Alberto Puello', strSport: 'Fighting', strLeague: 'Boxing', strTimestamp: '2026-10-18T00:00:00', strTime: '00:00:00', strStatus: null }] });
const events: SportsEvent[] = [...nfl, ...ufc, ...boxing];
const opts = { zone: 'America/New_York', nameHours: 3 };
const win = (name: string, programs: { start: number; end: number; title: string }[] = []) => channelWindow({ id: 'x', name, group: 'Sports', programs }, events, now, opts);

test('channel names match events by teams, abbreviations, fighters and numbered cards', () => {
  assert.equal(win('NFL 03: Texans vs Jaguars')?.eventId, 'espn:401872996');
  assert.equal(win('US: NFL GAMEPASS 7 | HOU @ JAX')?.eventId, 'espn:401872996');
  assert.equal(win('Sunday Night: Atlanta Falcons @ Chicago Bears 8:20 PM ET')?.eventId, 'espn:401872997');
  assert.equal(win('PPV 1: UFC 333')?.eventId, 'espn:600061267');
  assert.equal(win('PPV EVENT 04 - Volkanovski vs Evloev (Main Card)')?.eventId, 'espn:600061267');
  assert.equal(win('DAZN PPV: Smith vs Puello')?.eventId, 'tsdb:1');
  assert.equal(win('ESPN+ 041'), undefined, 'a numbered slot with no event listed stays hidden');
  assert.equal(win('PPV 3: No Event Scheduled'), undefined);
  assert.equal(win('NBA 2', [{ start: now - HOUR, end: now + HOUR, title: 'SIGN OFF' }, { start: now - HOUR, end: now + HOUR, title: 'Next game: Indiana Pacers at New Orleans Pelicans at 10/21/2026 08:00 PM' }, { start: now - HOUR, end: now + HOUR, title: 'Postseason Replay' }]), undefined, 'guide filler is not an event');
  assert.equal(eventScore('Houston Rockets vs Jacksonville Dolphins', nfl[0]!) > 0, true, 'city names count on both sides');
});

test('stale listings are rejected: a written date that contradicts the event, or an event already over', () => {
  assert.equal(win('PPV 2: Texans vs Jaguars 08/16'), undefined, 'same matchup, months ago');
  assert.equal(win('PPV 2: Canelo vs Crawford | 09/13 8PM ET'), undefined, 'unknown, past fight');
  const later = win('PPV 9: Big Fight Night 10/18 9:00 PM ET');
  assert.equal(later?.matchedBy, 'name_time');
  assert.equal(later?.start, Date.parse('2026-10-19T01:00:00Z'));
  assert.equal(cleanTitle('PPV 9: Big Fight Night 10/18 9:00 PM ET'), 'Big Fight Night');
  assert.equal(cleanTitle('Sportsnet+ 04: Eredivisie: SC Cambuur vs AZ Alkmaar @ Oct 18 08:20 AM :Sportsnet+ 04'), 'Eredivisie: SC Cambuur vs AZ Alkmaar');
  assert.equal(cleanTitle('P+ 03: Celtic vs. Heart of Midlothian'), 'Celtic vs. Heart of Midlothian');
  assert.equal(cleanTitle('Football Event 06ⓧ: Netherlands, Eredivisie | PEC Zwolle vs. Go Ahead Eagles'), 'Netherlands, Eredivisie | PEC Zwolle vs. Go Ahead Eagles');
  assert.equal(cleanTitle('Bulgaria, Bulgarian Cup | FK Burgas vs. FK Botev Plovdiv | Sunday, 18 October 2026'), 'Bulgaria, Bulgarian Cup | FK Burgas vs. FK Botev Plovdiv');
  assert.equal(cleanTitle('Men | Arnhem (149.2km): Eneco Tour | Stage 5'), 'Men | Arnhem (149.2km): Eneco Tour | Stage 5');
  // A date-only fight card takes its start from the channel name.
  assert.equal(win('Boxing 2: Smith vs Puello 7PM ET')?.start, Date.parse('2026-10-18T23:00:00Z'));
});

test('names and listings: written dates, EPG events and provider placeholders', () => {
  assert.equal(nameTime('Oct 18 @ 20:00 UK', now)?.at, Date.parse('2026-10-18T19:00:00Z'));
  assert.equal(nameTime('2026-10-19 13:00', now)?.at, Date.parse('2026-10-19T17:00:00Z'));
  assert.equal(nameTime('Event 12/28', now)?.dateOnly, true);
  const epg = win('Sports Event 12', [{ start: now - HOUR, end: now + HOUR, title: 'No Event' }, { start: now + 6 * HOUR, end: now + 10 * HOUR, title: 'NFL: Falcons at Bears' }]);
  assert.deepEqual([epg?.matchedBy, epg?.eventId], ['epg_event', 'espn:401872997']);
});

test('an event-driven source shows only channels whose event is on, numbers them and lists the event in the guide', () => {
  const db = openDatabase(':memory:'), iptv = new IptvStore(db, new Vault(randomBytes(32))), store = new SportsStore(db, id => iptv.relist(id)), health = new HealthStore(db);
  const s = iptv.create('owner', { kind: 'm3u', name: 'Sports' });
  const names = ['NFL 03: Texans vs Jaguars', 'NFL 04: Falcons vs Bears', 'PPV 2: Texans vs Jaguars 08/16', 'ESPN+ 041', 'PPV 1: UFC 333'];
  iptv.ingest('owner', s.id, 0, Buffer.from('#EXTM3U\n' + names.map((n, i) => `#EXTINF:-1 tvg-id="ev${i}" group-title="Sports",${n}\nhttps://streams.invalid/${i}`).join('\n')));
  store.setPolicy('owner', s.id, { enabled: true, leadMinutes: 30 });
  store.upsert(events, now);
  const schedule = new SportsSchedule(iptv, store, health, () => {}, { espn: [], tsdb: [], tsdbKey: () => '123', zone: 'America/New_York', nameHours: 3, tickMs: 3600_000 });
  schedule.match(now); schedule.close();
  const byName = new Map(iptv.adminChannels(s.id).map(c => [c.name, c]));
  assert.deepEqual(names.map(n => byName.get(n)!.number !== null), [true, false, false, false, false], 'only the live game is numbered; later events wait until starting soon');
  // Only the live game is airing at 17:30 UTC. Listing state uses the real clock inside SQL, so it is checked against
  // the windows at the real time rather than at the fixture's now.
  const windows = store.windows(s.id);
  assert.equal(windows.size, 3);
  const open = (id: string, at = Date.now()) => { const w = windows.get(id); return !!w && w.visible_from <= at && w.visible_until > at; };
  assert.deepEqual(names.map(n => byName.get(n)!.state), names.map(n => open(byName.get(n)!.id) ? 'listed' : 'no_event'));
  const live = windows.get(byName.get(names[0]!)!.id)!;
  assert.equal(live.visible_from, Date.parse('2026-10-18T16:30:00Z'));
  assert.ok(live.visible_until >= live.end);
  // Turned off, the source behaves like any other: windows are cleared and its channels follow the regular rules.
  store.setPolicy('owner', s.id, { enabled: false, leadMinutes: 30 });
  assert.equal(store.windows(s.id).size, 0);
  assert.ok(iptv.adminChannels(s.id).every(c => !c.event && c.number !== null && c.state === 'unverified'), 'regular channels wait for a first check');
});

test('viewer visibility and checks follow the window in real time', () => {
  const db = openDatabase(':memory:'), iptv = new IptvStore(db, new Vault(randomBytes(32))), store = new SportsStore(db, id => iptv.relist(id)), health = new HealthStore(db), t = Date.now();
  const s = iptv.create('owner', { kind: 'm3u', name: 'Sports' });
  iptv.ingest('owner', s.id, 0, Buffer.from('#EXTM3U\n#EXTINF:-1 tvg-id="a",PPV 1: Texans vs Jaguars\nhttps://streams.invalid/a\n#EXTINF:-1 tvg-id="b",PPV 2: Falcons vs Bears\nhttps://streams.invalid/b'));
  store.setPolicy('owner', s.id, { enabled: true, leadMinutes: 30 });
  const shift = (e: SportsEvent, start: number): SportsEvent => ({ ...e, start, end: start + 3 * HOUR, state: 'pre' });
  store.upsert([shift(nfl[0]!, t - HOUR), shift(nfl[1]!, t + 5 * HOUR)], t);
  new SportsSchedule(iptv, store, health, () => {}, { espn: [], tsdb: [], tsdbKey: () => '123', zone: 'UTC', nameHours: 3, tickMs: 3600_000 }).match(t);
  const stacks = iptv.stacks();
  assert.deepEqual(stacks.map(c => c.name), ['Texans vs Jaguars'], 'the later game stays hidden until 30 minutes before');
  const program = iptv.guidePage('owner', 'all', t - HOUR, t + HOUR, 0, 10).channels[0]!.programs.find(p => p.program)!.program!;
  assert.equal(program.title, 'Houston Texans at Jacksonville Jaguars');
  // Only the airing channel is due for a check, and it is queued now that its window is open.
  assert.equal(health.queueEvents(s.id, t), 1);
  assert.deepEqual(health.due(s.id, 10, new Set(), t), [stacks[0]!.id]);
});

test('real provider names: a family writing UK times is learned from known kickoffs and applied to the rest', async () => {
  const { learnZones, family } = await import('../apps/server/src/services/sports-match.js');
  const at = Date.parse('2026-10-18T13:00:00Z');
  const serieA = espnEvents('soccer/ita.1', { leagues: [{ abbreviation: 'Serie A' }], events: [{ id: '1', name: 'Lecce at Udinese', date: '2026-10-18T10:30Z', status: { type: { state: 'post' } }, competitions: [{ competitors: [
    { team: { displayName: 'Udinese', shortDisplayName: 'Udinese', name: 'Udinese', location: 'Udinese', abbreviation: 'UDI' } }, { team: { displayName: 'Lecce', shortDisplayName: 'Lecce', name: 'Lecce', location: 'Lecce', abbreviation: 'LEC' } }] }] }] });
  const ligue1 = espnEvents('soccer/fra.1', { leagues: [{ abbreviation: 'Ligue 1' }], events: [{ id: '2', name: 'AJ Auxerre at Le Havre AC', date: '2026-10-18T15:15Z', status: { type: { state: 'pre' } }, competitions: [{ competitors: [
    { team: { displayName: 'Le Havre AC', shortDisplayName: 'Le Havre', name: 'Le Havre', location: 'Le Havre', abbreviation: 'HAC' } }, { team: { displayName: 'AJ Auxerre', shortDisplayName: 'Auxerre', name: 'Auxerre', location: 'Auxerre', abbreviation: 'AUX' } }] }] }] });
  const all = [...serieA, ...ligue1], channels = [
    'Serie A 05ⓧ: Udinese Calcio vs. US Lecce | Sunday, 18 October 2026 11:30',
    'Football Event 06ⓧ: Netherlands, Eredivisie | PEC Zwolle vs. Go Ahead Eagles | Sunday, 18 October 2026 11:15',
    'FNTZ 06: Ligue 1: Le Havre vs Auxerre Oct 18 11:15 AM'].map(name => ({ id: name, name, group: '', programs: [] }));
  assert.equal(family(channels[1]!.name), 'football event');
  // Serie A's family is learned as UK time; FNTZ stays Eastern.
  const zones = learnZones(channels, all, at, 'America/New_York');
  assert.equal(zones.get('serie a'), 'Europe/London');
  assert.equal(zones.has('fntz'), false);
  const options = { zone: 'America/New_York', nameHours: 3, zones };
  assert.equal(channelWindow(channels[0]!, all, at, options), undefined, 'Udinese–Lecce finished at 12:30 UTC, not later today');
  assert.equal(channelWindow(channels[2]!, all, at, options)?.eventId, 'espn:2');
  // "Football Event" shares no kickoff with a known event here, so it keeps the default zone.
  assert.equal(channelWindow(channels[1]!, all, at, options)?.start, Date.parse('2026-10-18T15:15:00Z'));
  assert.equal(channelWindow(channels[1]!, all, at, { ...options, zones: new Map([['football event', 'Europe/London']]) })?.start, Date.parse('2026-10-18T10:15:00Z'));
});

test('real provider names: league shows count while the league plays, team-channel filler does not', () => {
  const sunday = Date.parse('2026-10-18T15:00:00Z'), listing = (title: string) => [{ start: sunday - HOUR, end: sunday + 5 * HOUR, title }];
  assert.equal(channelWindow({ id: 'r', name: 'NFL Redzone', group: '', programs: listing('NFL Red Zone') }, events, sunday, opts)?.matchedBy, 'epg');
  assert.equal(channelWindow({ id: 'o', name: 'US NBA Oklahoma City Thunder (HD) (S)', group: '', programs: listing('NBA: Oklahoma City Thunder') }, events, sunday, opts), undefined);
  assert.equal(win('NFL 02: Jaguars vs Texans (10.18 9:30AM ET)')?.eventId, 'espn:401872996');
  assert.equal(win('NFL 02: Houston Texans @ Jacksonville Jaguars | Away Stream | 9:30 AM')?.eventId, 'espn:401872996');
});

test('feeds of one event combine into one selectable row, with or without a scheduled event', () => {
  const db = openDatabase(':memory:'), iptv = new IptvStore(db, new Vault(randomBytes(32))), store = new SportsStore(db, id => iptv.relist(id)), health = new HealthStore(db), t = Date.now();
  db.prepare('INSERT INTO users VALUES(?,1)').run('viewer');
  const s = iptv.create('owner', { kind: 'm3u', name: 'Sports' }), day = new Date(t);
  const when = `${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][day.getUTCMonth()]} ${day.getUTCDate()} ${String(day.getUTCHours()).padStart(2, '0')}:00 UTC`;
  const names = ['NFL 02: Jaguars vs Texans', 'NFL | 02 Texans at Jaguars', 'NFL 02: Houston Texans @ Jacksonville Jaguars | Away Stream',
    `FAWSL: Aston Villa vs Liverpool @ ${when} :Sportsnet+ 06`, `Football Event 03: Aston Villa v Liverpool | ${when}`, `FAWSL: Arsenal vs Chelsea @ ${when} :Sportsnet+ 07`];
  iptv.ingest('owner', s.id, 0, Buffer.from('#EXTM3U\n' + names.map((n, i) => `#EXTINF:-1 tvg-id="f${i}",${n}\nhttps://streams.invalid/${i}`).join('\n')));
  store.setPolicy('owner', s.id, { enabled: true, leadMinutes: 30 });
  store.upsert([{ ...nfl[0]!, start: t - HOUR, end: t + 2 * HOUR }], t);
  new SportsSchedule(iptv, store, health, () => {}, { espn: [], tsdb: [], tsdbKey: () => '123', zone: 'UTC', nameHours: 3, tickMs: 3600_000 }).match(t);
  const rows = iptv.stacks().map(r => ({ name: r.name, feeds: r.feeds.map(f => f.name).sort() }));
  assert.equal(rows.length, 3, 'one row per event');
  assert.deepEqual(rows.map(r => r.feeds.length).sort(), [1, 2, 3]);
  const villa = rows.find(r => r.feeds.length === 2)!;
  assert.equal(villa.name, 'Aston Villa vs Liverpool', 'name-only matches of one game combine under the event name');
  assert.deepEqual(villa.feeds, ['Football Event 03', 'Sportsnet+ 06'], 'feeds are labelled by provider slot');
  assert.deepEqual(rows.find(r => r.feeds.length === 3)!.feeds, ['NFL 02', 'NFL 02', 'NFL 02 · Away Stream']);
  assert.equal(iptv.guidePage('viewer', 'all', t - HOUR, t + HOUR, 0, 10, 'liverpool').channels.length, 1, 'search still finds the event');
  // Every feed stays tunable, and the guide row lists the event.
  const nflRow = iptv.stacks().find(r => r.feeds.length === 3)!;
  for (const feed of nflRow.feeds) assert.equal(iptv.tune(feed.id).id, feed.id);
  const guide = iptv.guidePage('viewer', 'all', t - HOUR, t + HOUR, 0, 10).channels.find(c => c.feeds.length === 3)!;
  assert.equal(guide.programs.find(p => p.program)?.program?.title, 'Houston Texans at Jacksonville Jaguars');
});

test('the guide leads into an event with "starting soon" and is blank after it, for event matches only', () => {
  const db = openDatabase(':memory:'), iptv = new IptvStore(db, new Vault(randomBytes(32))), store = new SportsStore(db, id => iptv.relist(id)), health = new HealthStore(db), t = Date.now();
  db.prepare('INSERT INTO users VALUES(?,1)').run('viewer');
  const s = iptv.create('owner', { kind: 'm3u', name: 'Sports' });
  iptv.ingest('owner', s.id, 0, Buffer.from('#EXTM3U\n#EXTINF:-1 tvg-id="a",NFL 02: Texans vs Jaguars\nhttps://streams.invalid/a'));
  store.setPolicy('owner', s.id, { enabled: true, leadMinutes: 30 });
  const kickoff = t + 10 * 60_000;
  store.upsert([{ ...nfl[0]!, start: kickoff, end: kickoff + 3 * HOUR, state: 'pre' }], t);
  new SportsSchedule(iptv, store, health, () => {}, { espn: [], tsdb: [], tsdbKey: () => '123', zone: 'UTC', nameHours: 3, tickMs: 3600_000 }).match(t);
  const rows = iptv.guidePage('viewer', 'all', t - HOUR, t + 5 * HOUR, 0, 10).channels[0]!.programs;
  const lead = rows.find(r => r.program?.status === 'starting_soon')!;
  assert.deepEqual([lead.start, lead.end, lead.program!.title, lead.program!.subtitle], [kickoff - 30 * 60_000, kickoff, 'Houston Texans at Jacksonville Jaguars', 'Starting soon']);
  assert.ok(rows.some(r => r.program?.start === kickoff && !r.program.status), 'the event follows its lead-in');
  const after = rows.filter(r => r.start >= kickoff + 3 * HOUR);
  assert.ok(after.length && after.every(r => r.program === null && 'blank' in r && r.blank), 'blank after the event, not "No guide data"');
});

test('a sports source is checked and numbered only while live or starting soon, then retired; nothing is flagged on import', () => {
  const db = openDatabase(':memory:'), iptv = new IptvStore(db, new Vault(randomBytes(32))), store = new SportsStore(db, id => iptv.relist(id)), health = new HealthStore(db), t = Date.now();
  const s = iptv.create('owner', { kind: 'm3u', name: 'Sports' });
  store.setPolicy('owner', s.id, { enabled: true, leadMinutes: 30 });
  // Mostly idle event slots and old listings, like a real sports category.
  const names = ['NFL 01: Texans vs Jaguars', 'NFL 02: Falcons vs Bears', ...Array.from({ length: 40 }, (_, i) => `PPV ${i + 1}: Old Fight ${i} vs Someone 08/16`)];
  iptv.ingest('owner', s.id, iptv.status(s.id).revision, Buffer.from('#EXTM3U\n' + names.map((n, i) => `#EXTINF:-1 tvg-id="p${i}",${n}\nhttps://streams.invalid/${i}`).join('\n')));
  // Before any match, nothing is due: no sweep of the whole playlist.
  assert.deepEqual(health.due(s.id, 100, new Set(), t), []);
  assert.equal(health.queueSource(s.id, t), 0, 'checking "all" checks only live and starting-soon channels');
  const shift = (e: SportsEvent, start: number): SportsEvent => ({ ...e, start, end: start + 3 * HOUR, state: 'pre' });
  store.upsert([shift(nfl[0]!, t - HOUR), shift(nfl[1]!, t + 20 * 60_000)], t);
  const schedule = new SportsSchedule(iptv, store, health, () => {}, { espn: [], tsdb: [], tsdbKey: () => '123', zone: 'UTC', nameHours: 3, tickMs: 3600_000 });
  schedule.match(t);
  const ids = new Map(iptv.adminChannels(s.id).map(c => [c.name, c.id]));
  const approved = () => iptv.adminChannels(s.id).filter(c => c.number !== null).map(c => c.name).sort();
  assert.deepEqual(approved(), ['NFL 01: Texans vs Jaguars', 'NFL 02: Falcons vs Bears'], 'live and starting soon (20 minutes away, 30-minute lead)');
  assert.equal(health.queueEvents(s.id, t), 2);
  assert.deepEqual(health.due(s.id, 100, new Set(), t).sort(), [ids.get(names[0]!)!, ids.get(names[1]!)!].sort());
  // Hours later the first game is over: it is unlisted and gives back its number.
  const later = t + 3 * HOUR;
  assert.deepEqual(iptv.syncNumbers(s.id, later), { numbered: 0, released: 1 });
  assert.deepEqual(approved(), ['NFL 02: Falcons vs Bears']);
  assert.equal(iptv.adminChannels(s.id).find(c => c.name === names[0])!.number, null);
  // A channel an administrator always lists keeps its number whatever the schedule says.
  const old = ids.get(names[5]!)!;
  iptv.editChannel('owner', old, { expectedRevision: iptv.status(s.id).revision, listing: 'always' });
  iptv.syncNumbers(s.id, later);
  assert.ok(approved().includes(names[5]!));
  // The administrator chooses the source type: even a playlist of event slots stays regular until flagged.
  const other = iptv.create('owner', { kind: 'm3u', name: 'Unflagged' });
  iptv.ingest('owner', other.id, 0, Buffer.from('#EXTM3U\n' + names.map((n, i) => `#EXTINF:-1 tvg-id="u${i}",${n}\nhttps://streams.invalid/u${i}`).join('\n')));
  assert.equal(store.policy(other.id).enabled, false);
  assert.ok(iptv.adminChannels(other.id).every(c => !c.event));
});

test('event channel names keep only the event; feed labels keep the provider slot', async () => {
  const { eventChannelName, channelTag } = await import('../apps/server/src/services/sports-match.js');
  const cases: [string, string, string][] = [
    ['Bundesliga 09ⓧ: Borussia Monchengladbach vs. TSG Hoffenheim | Sunday, 18 October 2026 16:30', 'Borussia Monchengladbach vs. TSG Hoffenheim', 'Bundesliga 09'],
    ['Eredivisie: FC Groningen vs AFC Ajax @ Oct 18 10:35 AM :Sportsnet+ 09', 'FC Groningen vs AFC Ajax', 'Sportsnet+ 09'],
    ['FNTZ 05: Liga Nacional de Futsal CRESOL SILVER: Dracena vs São Caetano Oct 18 10:00 AM', 'Dracena vs São Caetano', 'FNTZ 05'],
    ['Football Event 37ⓧ: Czech Republic, 1. Liga | FC Banik Ostrava vs. AC Sparta Prague | Sunday, 18 October 2026 14:00', 'FC Banik Ostrava vs. AC Sparta Prague', 'Football Event 37'],
    ['NFL | 02 9:30am Texans at Jaguars', 'Texans at Jaguars', 'NFL 02'],
    ['NFL 02: Houston Texans @ Jacksonville Jaguars | Away Stream | 9:30 AM', 'Houston Texans @ Jacksonville Jaguars', 'NFL 02 · Away Stream'],
    ['HBO 05: Men | Cittadella Bassano del Grappa (158km): Veneto Classic (10.18 9:50AM ET)', 'Veneto Classic', 'HBO 05'],
    ['PPV 1: UFC 333', 'UFC 333', 'PPV 1']];
  for (const [raw, name, tag] of cases) { assert.equal(eventChannelName(raw), name, raw); assert.equal(channelTag(raw), tag, raw); }
});

test('event channels without a logo get an icon for their sport', async () => {
  const { sportOf } = await import('../apps/server/src/services/sports-match.js');
  const { sportIcon } = await import('../apps/server/src/providers/sport-icons.js');
  const cases: [string, string][] = [
    ['Bundesliga 09ⓧ: Borussia Monchengladbach vs. TSG Hoffenheim | Sunday, 18 October 2026 16:30', 'soccer'],
    ['Football Event 37ⓧ: Czech Republic, 1. Liga | FC Banik Ostrava vs. AC Sparta Prague', 'soccer'],
    ['FNTZ 05: Liga Nacional de Futsal CRESOL SILVER: Dracena vs São Caetano', 'soccer'],
    ['NFL 02: Houston Texans @ Jacksonville Jaguars | Away Stream', 'football'], ['NFL Redzone', 'football'],
    ['US NBA Oklahoma City Thunder (HD) (S)', 'basketball'], ['PPV 1: UFC 333', 'mma'], ['DAZN PPV: Smith vs Puello Boxing', 'boxing'],
    ['WWE Raw', 'wrestling'], ['HBO 05: Men | Cittadella Bassano del Grappa (158km): Veneto Classic', 'cycling'], ['PPV 7: Event', 'sports'],
    ['Freeway Insurance 500: No. 48 Alex Bowman', 'racing'], ['Race: FIA WEC | 6 Hours of Monza', 'racing'], ['Lucas Oil DTWC at West Virginia', 'racing'],
    ['STSS Octoberfest at Hagerstown', 'racing'], ['Primera A (Colombia): Deportivo Cali vs Junior', 'soccer'], ['Liga1 Te Apuesto: Cienciano vs Universitario', 'soccer'],
    ['ONE Fight Night 37: Gabriel vs. Rasulov', 'mma'], ['Men: Superprestige | Overijse', 'cycling'], ['Winmau Canada Classic | CDC Ontario Board 4', 'darts'],
    ['GSOC: GSOC Invitational Mens Final', 'curling']];
  for (const [name, sport] of cases) assert.equal(sportOf(name), sport, name);
  assert.equal(sportOf('PPV 3: Smith vs Jones', 'boxing'), 'boxing', 'the schedule knows best');
  assert.match(sportIcon('soccer'), /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"[^>]*>.*<\/svg>$/);
  assert.doesNotMatch(Object.values({ a: sportIcon('boxing'), b: sportIcon('sports') }).join(''), /<script|on\w+=|href/i);
  // The store reports the sport of a visible event channel's window.
  const db = openDatabase(':memory:'), iptv = new IptvStore(db, new Vault(randomBytes(32))), store = new SportsStore(db, id => iptv.relist(id)), health = new HealthStore(db), t = Date.now();
  const s = iptv.create('owner', { kind: 'm3u', name: 'Sports' });
  iptv.ingest('owner', s.id, 0, Buffer.from('#EXTM3U\n#EXTINF:-1 tvg-id="a",NFL 02: Texans vs Jaguars\nhttps://streams.invalid/a'));
  store.setPolicy('owner', s.id, { enabled: true, leadMinutes: 30 });
  store.upsert([{ ...nfl[0]!, start: t - HOUR, end: t + 2 * HOUR }], t);
  new SportsSchedule(iptv, store, health, () => {}, { espn: [], tsdb: [], tsdbKey: () => '123', zone: 'UTC', nameHours: 3, tickMs: 3600_000 }).match(t);
  assert.equal(iptv.sportFor(iptv.stacks()[0]!.id), 'football');
});

// Live Sports settings: three leagues airing now plus a channel known only by the time in its name.
function liveSports() {
  const db = openDatabase(':memory:'), iptv = new IptvStore(db, new Vault(randomBytes(32))), store = new SportsStore(db, id => iptv.relist(id)), health = new HealthStore(db), t = Date.now();
  const at = new Date(t - 20 * 60_000), written = `${at.getUTCMonth() + 1}/${at.getUTCDate()} ${String(at.getUTCHours()).padStart(2, '0')}:${String(at.getUTCMinutes()).padStart(2, '0')}`;
  const team = (name: string, abbreviation: string) => ({ team: { displayName: name, shortDisplayName: name, name, location: name, abbreviation } });
  const epl = espnEvents('soccer/eng.1', { leagues: [{ abbreviation: 'EPL' }], events: [{ id: '9001', name: 'Chelsea at Arsenal', date: new Date(t - 30 * 60_000).toISOString(), status: { type: { state: 'in' } }, competitions: [{ competitors: [team('Arsenal', 'ARS'), team('Chelsea', 'CHE')] }] }] });
  const live = (e: SportsEvent): SportsEvent => ({ ...e, start: t - HOUR, end: t + 2 * HOUR, state: 'in' });
  const s = iptv.create('owner', { kind: 'm3u', name: 'Sports' }), names = ['PPV 1: Texans vs Jaguars', 'PPV 2: UFC 333', 'Soccer 1: Arsenal vs Chelsea', `Event 9: Big Fight Night ${written}`];
  const playlist = (extra = '') => Buffer.from('#EXTM3U\n' + names.map((n, i) => `#EXTINF:-1 tvg-id="ls${i}",${n}\nhttps://streams.invalid/ls${i}`).join('\n') + extra);
  iptv.ingest('owner', s.id, 0, playlist());
  store.setPolicy('owner', s.id, { enabled: true, leadMinutes: 30 });
  store.upsert([live(nfl[0]!), live(ufc[0]!), ...epl], t);
  const schedule = new SportsSchedule(iptv, store, health, () => {}, { espn: [], tsdb: [], tsdbKey: () => '123', zone: 'UTC', nameHours: 3, tickMs: 3600_000 });
  schedule.close();
  const save = (patch: Partial<SportsSettings>) => { const { revision, ...current } = store.settings(); store.setSettings('owner', revision, { ...current, ...patch }); schedule.match(t); };
  return { iptv, store, save, source: s.id, playlist };
}

test('live sports: only selected leagues are shown, and unscheduled channels follow their own switch', () => {
  const { iptv, store, save } = liveSports();
  save({});
  assert.deepEqual(iptv.stacks().map(c => c.name).sort(), ['Arsenal vs Chelsea', 'Big Fight Night', 'Texans vs Jaguars', 'UFC 333'], 'every league by default');
  save({ leagueMode: 'selected', leagues: ['soccer/eng.1', 'mma/ufc'], unscheduled: false });
  assert.deepEqual(iptv.stacks().map(c => c.name).sort(), ['Arsenal vs Chelsea', 'UFC 333'], 'the NFL game and the unscheduled channel leave the lineup');
  save({ unscheduled: true });
  assert.deepEqual(iptv.stacks().map(c => c.name).sort(), ['Arsenal vs Chelsea', 'Big Fight Night', 'UFC 333']);
  assert.deepEqual(store.leagues(0).map(l => l.key).sort(), ['football/nfl', 'mma/ufc', 'soccer/eng.1']);
  const { revision, ...current } = store.settings();
  assert.throws(() => store.setSettings('owner', revision - 1, current), /changed/, 'a stale revision is refused');
});

test('live sports: event rows follow sport and league priority, sit above or below other channels, and use their number block', () => {
  // The guide is grouped by source, so placement is relative to the other channels of the same source.
  const { iptv, save, source, playlist } = liveSports();
  iptv.ingest('owner', source, iptv.status(source).revision, playlist('\n#EXTINF:-1 tvg-id="cnn",CNN\nhttps://streams.invalid/cnn'));
  const cnn = iptv.adminChannels(source).find(c => c.name === 'CNN')!;
  iptv.editChannel('owner', cnn.id, { expectedRevision: iptv.status(source).revision, listing: 'always' });
  save({ sportOrder: ['soccer', 'mma', 'football'], placement: 'top', numberStart: 500 });
  const rows = () => iptv.stacks().map(c => c.name);
  assert.deepEqual(rows(), ['Arsenal vs Chelsea', 'UFC 333', 'Texans vs Jaguars', 'Big Fight Night', 'CNN'], 'sport order, unscheduled last, events above');
  assert.ok(iptv.stacks().filter(c => c.name !== 'CNN').every(c => c.number >= 500 && c.number < 504), 'event channels are numbered in the block');
  assert.equal(iptv.stacks().find(c => c.name === 'CNN')!.number, 1);
  save({ sportOrder: ['football', 'soccer', 'mma'], placement: 'bottom' });
  assert.deepEqual(rows(), ['CNN', 'Texans vs Jaguars', 'Arsenal vs Chelsea', 'UFC 333', 'Big Fight Night'], 'reordering applies without renumbering');
  save({ numberStart: 700 });
  assert.equal(iptv.renumberEvents(), 4);
  assert.deepEqual(iptv.stacks().map(c => c.number), [1, 700, 701, 702, 703], 'a new block renumbers live event channels in guide order');
});

test('league logos prefer the dark version and are downloaded again when their address changes', () => {
  assert.equal(espnLeagueLogo({ leagues: [{ logos: [{ href: 'https://a.espncdn.com/i/teamlogos/leagues/500/nfl.png', rel: ['full', 'default'] }, { href: 'https://a.espncdn.com/i/teamlogos/leagues/500-dark/nfl.png', rel: ['full', 'dark'] }] }] }), 'https://a.espncdn.com/i/teamlogos/leagues/500-dark/nfl.png');
  assert.equal(espnLeagueLogo({ leagues: [{ logos: [{ href: 'http://insecure/nfl.png' }] }] }), undefined);
  assert.equal(tsdbLeagueLogo({ leagues: [{ strBadge: null, strLogo: 'https://r2.thesportsdb.com/images/media/league/logo/wwe.png' }] }), 'https://r2.thesportsdb.com/images/media/league/logo/wwe.png');
  const store = new SportsStore(openDatabase(':memory:')), image = { type: 'image/png', bytes: Buffer.from('png') };
  store.setLogoUrl('football/nfl', 'https://a/1.png');
  assert.deepEqual(store.logosMissing(), [{ key: 'football/nfl', url: 'https://a/1.png' }]);
  store.saveLogo('football/nfl', 'https://a/1.png', image);
  store.setLogoUrl('football/nfl', 'https://a/1.png');
  assert.deepEqual(store.logosMissing(), []);
  store.setLogoUrl('football/nfl', 'https://a/2.png');
  assert.deepEqual(store.logosMissing(), [{ key: 'football/nfl', url: 'https://a/2.png' }]);
});

test('matchup logos follow the title: away then home on ESPN, home then away on TheSportsDB', () => {
  const [game] = espnEvents('football/nfl', { events: [{ id: '1', name: 'Houston Texans at Jacksonville Jaguars', date: '2026-10-18T17:00Z', competitions: [{ competitors: [
    { homeAway: 'home', team: { displayName: 'Jacksonville Jaguars', logo: 'https://a.espncdn.com/jax.png' } },
    { homeAway: 'away', team: { displayName: 'Houston Texans', logo: 'https://a.espncdn.com/hou.png' } }] }] }] });
  assert.deepEqual(game!.logos, ['https://a.espncdn.com/hou.png', 'https://a.espncdn.com/jax.png']);
  const [missing] = espnEvents('football/nfl', { events: [{ id: '2', name: 'A at B', date: '2026-10-18T17:00Z', competitions: [{ competitors: [
    { homeAway: 'home', team: { displayName: 'Bees', logo: 'https://a.espncdn.com/b.png' } }, { homeAway: 'away', team: { displayName: 'Aces' } }] }] }] });
  assert.deepEqual(missing!.logos, []);
  const [match] = tsdbEvents({ events: [{ idEvent: '3', strEvent: 'Arsenal vs Chelsea', strSport: 'Soccer', strLeague: 'EPL', strTimestamp: '2026-10-18T15:00:00', strHomeTeam: 'Arsenal', strAwayTeam: 'Chelsea',
    strHomeTeamBadge: 'https://r2.thesportsdb.com/ars.png', strAwayTeamBadge: 'https://r2.thesportsdb.com/che.png' }] });
  assert.deepEqual(match!.logos, ['https://r2.thesportsdb.com/ars.png', 'https://r2.thesportsdb.com/che.png']);
});
