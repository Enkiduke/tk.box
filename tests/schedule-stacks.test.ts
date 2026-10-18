import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { openDatabase } from '../apps/server/src/persistence/database.js';
import { IptvStore } from '../apps/server/src/persistence/iptv-store.js';
import { HealthStore } from '../apps/server/src/persistence/channel-health-store.js';
import { SportsStore } from '../apps/server/src/persistence/sports-store.js';
import { Vault } from '../apps/server/src/security/vault.js';
import type { Program } from '../apps/server/src/providers/iptv.js';
import type { ProbeResult } from '../apps/server/src/services/stream-probe.js';
import { scheduleSignature, scheduleStackKeys } from '../apps/server/src/services/schedule-stacks.js';

const hour = 3600000;
const base = Math.ceil(Date.now() / hour) * hour;
const schedule = (channelId: string, series = 'Movie', start = base): Program[] => Array.from({ length: 6 }, (_, i) => ({ channelId, start: start + i * hour, end: start + (i + 1) * hour, title: `${series} ${i}`, subtitle: `Part ${i}` }));
const escape = (s: string) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
const stamp = (time: number) => new Date(time).toISOString().replace(/[-:TZ]/g, '').slice(0, 14) + ' +0000';
function guide(programs: Program[]) {
  const ids = [...new Set(programs.map(p => p.channelId))];
  return Buffer.from(`<tv>${ids.map(id => `<channel id="${escape(id)}"><display-name>${escape(id)}</display-name></channel>`).join('')}${programs.map(p => `<programme channel="${escape(p.channelId)}" start="${stamp(p.start)}" stop="${stamp(p.end)}"><title>${escape(p.title)}</title>${p.subtitle ? `<sub-title>${escape(p.subtitle)}</sub-title>` : ''}</programme>`).join('')}</tv>`);
}
function fixture(t: { after: (fn: () => void) => void }) {
  const db = openDatabase(':memory:'), store = new IptvStore(db, new Vault(randomBytes(32)));
  t.after(() => db.close()); db.prepare('INSERT INTO users VALUES(?,1)').run('viewer');
  const feed = store.create('owner', { kind: 'xmltv', name: 'Guide' });
  const publish = (programs: Program[]) => store.ingest('owner', feed.id, store.status(feed.id).revision, guide(programs));
  const add = (names: [string, string][], name = 'Movies') => {
    const source = store.create('owner', { kind: 'm3u', name });
    const m3u = '#EXTM3U\n' + names.map(([name, id], i) => `#EXTINF:-1 tvg-id="${id}" group-title="Movies",${name}\nhttps://streams.invalid/${source.id}/${i}`).join('\n');
    store.ingest('owner', source.id, 0, Buffer.from(m3u));
    store.setListingPolicy('owner', source.id, { ...store.listingPolicy(source.id), requireCheck: false, expectedRevision: store.status(source.id).revision });
    store.bindFeed('owner', source.id, feed.id, store.status(source.id).revision);
    return source;
  };
  return { db, store, feed, publish, add };
}

test('schedule evidence needs three consecutive real programs and matches all current/upcoming slots', () => {
  const programs = schedule('first'), signature = scheduleSignature(programs, base);
  assert.ok(signature);
  assert.equal(signature, scheduleSignature(schedule('other').reverse().map(p => ({ ...p, title: `  ${p.title.toUpperCase()}  `, description: 'Different description' })), base));
  assert.equal(scheduleSignature(programs.slice(0, 2), base), undefined);
  assert.equal(scheduleSignature(programs, base + 7 * hour), undefined, 'expired evidence cannot group channels');
  assert.equal(scheduleSignature(programs.map(p => ({ ...p, title: 'To be announced' })), base), undefined);
  assert.equal(scheduleSignature(programs.map(p => ({ ...p, title: 'Paid Programming', subtitle: '' })), base), undefined, 'a generic repeated listing is insufficient');
  assert.equal(scheduleSignature(programs.map((p, i) => ({ ...p, start: p.start + i, end: p.end + i })), base), undefined, 'gaps cannot supply a consecutive run');
  assert.notEqual(signature, scheduleSignature(programs.map(p => ({ ...p, start: p.start + hour, end: p.end + hour })), base));
  assert.notEqual(signature, scheduleSignature(programs.map((p, i) => i === 5 ? { ...p, title: 'Different later program' } : p), base));
  assert.notEqual(signature, scheduleSignature(programs.map((p, i) => i === 5 ? { ...p, subtitle: 'Different episode' } : p), base));
});

test('name stacks with conflicting or incomplete guides cannot bridge stations through matching feeds', () => {
  const candidates = [
    { id: 'a', key: 'a', automatic: true, programs: schedule('a') },
    { id: 'a-backup', key: 'a', automatic: true, programs: schedule('a2', 'Other') },
    { id: 'b', key: 'b', automatic: true, programs: schedule('b') },
    { id: 'c', key: 'c', automatic: true, programs: schedule('c', 'Other') },
  ];
  assert.deepEqual([...scheduleStackKeys(candidates, base).values()], ['a', 'a', 'b', 'c']);
  candidates[1]!.programs = schedule('a2').slice(0, 2);
  assert.equal(scheduleStackKeys(candidates, base).get('b'), 'b');
});

test('the MGM+/EPIX and HBO Comedy examples share viewer rows and admin stack keys, retaining all feeds', t => {
  const { store, publish, add } = fixture(t);
  publish([...schedule('EPIX.us'), ...schedule('EpixEast.us'), ...schedule('hbocomedy.us', 'Comedy'), ...schedule('HBOComedy.us', 'Comedy')]);
  const source = add([['US MGM+ (East) (A)', 'EPIX.us'], ['US: EPIX', 'EpixEast.us'], ['US: HBO Comedy', 'hbocomedy.us'], ['US HBO Comedy (East) (H)', 'HBOComedy.us'], ['US HBO Comedy (East) (S)', '']]);
  const stations = store.stacks(); assert.equal(stations.length, 2);
  assert.deepEqual(stations.map(s => s.feeds.length), [2, 3]);
  const channels = store.adminChannels(source.id);
  assert.equal(channels[0]!.stackKey, channels[1]!.stackKey);
  assert.equal(channels[2]!.stackKey, channels[3]!.stackKey);
  assert.equal(channels[3]!.stackKey, channels[4]!.stackKey, 'a backup without EPG follows its name stack');
  for (const c of channels) assert.equal(store.tune(c.id).id, c.id);
  assert.equal(store.guidePage('viewer', 'all', base, base + 6 * hour, 0, 30).total, 2);
  store.favorite('viewer', channels[1]!.id, true);
  assert.equal(store.guidePage('viewer', 'favorites', base, base + 6 * hour, 0, 30).channels[0]!.feeds.length, 2);
});

test('time shifts, later divergence, placeholders, short guides and different sources stay separate', t => {
  const { store, publish, add } = fixture(t);
  const changed = schedule('diverges'); changed[5] = { ...changed[5]!, title: 'Different movie' };
  publish([...schedule('main'), ...schedule('shifted', 'Movie', base + 3 * hour), ...changed, ...schedule('short').slice(0, 2), ...schedule('filler').map(p => ({ ...p, title: 'No information' }))]);
  add([['Main East', 'main'], ['Main West', 'shifted'], ['Other station', 'diverges'], ['Short guide', 'short'], ['Placeholder guide', 'filler']]);
  add([['Identical in another source', 'main']], 'Other playlist');
  assert.equal(store.stacks().length, 6);
});

test('manual stacking and keep-separate take precedence, and guide refreshes invalidate schedule matches', t => {
  const { store, publish, add } = fixture(t);
  const programs = [...schedule('a'), ...schedule('b')]; publish(programs);
  const source = add([['Station A', 'a'], ['Station B', 'b']]);
  const b = store.adminChannels(source.id).find(c => c.tvgId === 'b')!;
  const edit = (stack: string | null) => store.editChannel('owner', b.id, { expectedRevision: store.status(source.id).revision, stack });
  assert.equal(store.stacks().length, 1);
  edit(''); assert.equal(store.stacks().length, 2);
  edit('Custom station'); assert.equal(store.stacks().length, 2);
  edit(null); assert.equal(store.stacks().length, 1);
  publish(programs.map((p, i) => i === 11 ? { ...p, title: 'Different later movie' } : p));
  assert.equal(store.stacks().length, 2, 'a later disagreement splits the automatic match after refresh');
  publish(programs); assert.equal(store.stacks().length, 1);
  edit('Station A'); assert.equal(store.stacks().length, 1, 'explicit same-name stacking is preserved');
});

test('manual guide mapping changes invalidate matches without needing a source revision', t => {
  const { store, feed, publish, add } = fixture(t);
  publish([...schedule('a'), ...schedule('b'), ...schedule('different', 'Other')]);
  const source = add([['Station A', 'a'], ['Station B', 'b']]);
  const b = store.adminChannels(source.id).find(c => c.tvgId === 'b')!;
  assert.equal(store.stacks().length, 1);
  store.map('owner', b.id, feed.id, 'different', 0);
  assert.equal(store.stacks().length, 2);
  store.map('owner', b.id, feed.id, 'a', store.mappingReview(b.id, feed.id).reviewRevision);
  assert.equal(store.stacks().length, 1);
});

test('health promotion retains the schedule stack key and events keep their own grouping rules', t => {
  const { db, store, publish, add } = fixture(t);
  publish([...schedule('a'), ...schedule('b')]);
  const source = add([['Station A FHD', 'a'], ['Station B HD', 'b']]);
  const before = store.stacks()[0]!, health = new HealthStore(db);
  const failure: ProbeResult = { verdict: 'offline', reason: 'HTTP_NOT_FOUND', elapsedMs: 10, frames: 0, mediaSeconds: 0, frozen: false, silent: false, informative: false, thumbnail: false };
  health.record(before.feeds[1]!.id, { ...failure, verdict: 'online', reason: 'OK', frames: 100, mediaSeconds: 7 });
  health.record(before.id, failure); health.record(before.id, failure);
  assert.equal(store.stacks()[0]!.stack, before.stack);
  assert.notEqual(store.stacks()[0]!.id, before.id);
  const sports = new SportsStore(db, id => store.relist(id));
  sports.setPolicy('owner', source.id, { enabled: true, leadMinutes: 30 });
  store.setListing('owner', source.id, { expectedRevision: store.status(source.id).revision, ids: before.feeds.map(f => f.id), listing: 'always' });
  assert.equal(store.stacks().length, 2, 'event feeds do not group by their regular EPG schedules');
});
