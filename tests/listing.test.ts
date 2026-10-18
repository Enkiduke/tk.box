import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { openDatabase } from '../apps/server/src/persistence/database.js';
import { IptvStore } from '../apps/server/src/persistence/iptv-store.js';
import { HealthStore } from '../apps/server/src/persistence/channel-health-store.js';
import { SportsStore } from '../apps/server/src/persistence/sports-store.js';
import { alwaysOnMatch } from '../apps/server/src/persistence/listing.js';
import { Vault } from '../apps/server/src/security/vault.js';

const HOUR = 3600_000;
const entry = (id: string, name: string, group = '') => `#EXTINF:-1 tvg-id="${id}"${group ? ` group-title="${group}"` : ''},${name}\nhttps://streams.invalid/${id}`;
const playlist = (...lines: string[]) => Buffer.from('#EXTM3U\n' + lines.join('\n'));
function fixture() {
  const db = openDatabase(':memory:'), iptv = new IptvStore(db, new Vault(randomBytes(32))), health = new HealthStore(db), sports = new SportsStore(db, id => iptv.relist(id));
  return { db, iptv, health, sports };
}
const states = (iptv: IptvStore, source: string) => Object.fromEntries(iptv.adminChannels(source).map(c => [c.tvgId, c.state]));
const rules = (iptv: IptvStore, source: string, patch: Partial<ReturnType<IptvStore['listingPolicy']>>) =>
  iptv.setListingPolicy('owner', source, { ...iptv.listingPolicy(source), ...patch, expectedRevision: iptv.status(source).revision });

test('regular channels list themselves once they play, and an administrator can hide or always list one', () => {
  const { db, iptv, health } = fixture();
  try {
    const s = iptv.create('owner', { kind: 'm3u', name: 'TV' });
    iptv.ingest('owner', s.id, 0, playlist(entry('a', 'Alpha'), entry('b', 'Bravo'), entry('c', 'Charlie')));
    // Nothing is approved and nothing is listed until it is seen playing.
    assert.deepEqual(states(iptv, s.id), { a: 'unverified', b: 'unverified', c: 'unverified' });
    const id = (tvg: string) => iptv.adminChannels(s.id).find(c => c.tvgId === tvg)!.id;
    health.relayOnline(id('a'));
    assert.deepEqual(iptv.visible().map(c => c.name), ['Alpha']);
    // An administrator's choices win over the rules, either way.
    iptv.editChannel('owner', id('b'), { expectedRevision: iptv.status(s.id).revision, listing: 'always' });
    iptv.editChannel('owner', id('a'), { expectedRevision: iptv.status(s.id).revision, listing: 'hidden' });
    assert.deepEqual(states(iptv, s.id), { a: 'hidden', b: 'always', c: 'unverified' });
    assert.deepEqual(iptv.visible().map(c => c.name), ['Bravo']);
    // Without the first-check rule, unchecked channels list straight away; failing ones stay hidden.
    rules(iptv, s.id, { requireCheck: false });
    assert.deepEqual(iptv.visible().map(c => c.name).sort(), ['Bravo', 'Charlie']);
  } finally { db.close(); }
});

test('the guide rule lists channels with a program on now or soon, except always-on channels', () => {
  const { db, iptv } = fixture();
  try {
    const s = iptv.create('owner', { kind: 'm3u', name: 'TV' }), t = Date.now();
    iptv.ingest('owner', s.id, 0, playlist(entry('now', 'Now'), entry('soon', 'Soon'), entry('later', 'Later'), entry('filler', 'Filler'),
      entry('loop', 'Movies 24/7'), entry('radio', 'Jazz FM', 'Radio'), entry('none', 'No guide')));
    rules(iptv, s.id, { requireCheck: false });
    const at = (ms: number) => new Date(ms).toISOString().replace(/[-:T]/g, '').slice(0, 14) + ' +0000';
    const programme = (channel: string, start: number, end: number, title = 'Programme') => `<programme channel="${channel}" start="${at(start)}" stop="${at(end)}"><title>${title}</title></programme>`;
    const ids = ['now', 'soon', 'later', 'filler', 'loop', 'radio', 'none'];
    const xml = '<tv>' + ids.map(id => `<channel id="${id}"><display-name>${id}</display-name></channel>`).join('') +
      programme('now', t - HOUR, t + HOUR) + programme('soon', t + 1.5 * HOUR, t + 3 * HOUR) + programme('later', t + 3 * HOUR, t + 4 * HOUR) + programme('filler', t - HOUR, t + HOUR, 'No Information') + '</tv>';
    const feed = iptv.create('owner', { kind: 'xmltv', name: 'Guide' });
    iptv.ingest('owner', feed.id, 0, Buffer.from(xml)); iptv.bindFeed('owner', s.id, feed.id, iptv.status(s.id).revision);
    // Off by default: every working channel lists.
    assert.equal(iptv.visible().length, 7);
    rules(iptv, s.id, { requireGuide: true, guideHours: 2 });
    assert.deepEqual(states(iptv, s.id), { now: 'listed', soon: 'listed', later: 'no_guide', filler: 'no_guide', loop: 'listed', radio: 'no_guide', none: 'no_guide' });
    // A category can be exempted, like radio stations that never have listings.
    iptv.setGroup('owner', s.id, { expectedRevision: iptv.status(s.id).revision, name: 'Radio', mode: 'auto', guideExempt: true });
    assert.equal(states(iptv, s.id).radio, 'listed');
    // Look-ahead 0: only what is airing right now.
    rules(iptv, s.id, { guideHours: 0 });
    assert.equal(states(iptv, s.id).soon, 'no_guide');
    // Without the pattern, a 24/7 channel needs listings like any other.
    rules(iptv, s.id, { alwaysOn: [] });
    assert.equal(states(iptv, s.id).loop, 'no_guide');
    // Removing the guide leaves no coverage behind.
    iptv.removeGuide('owner', s.id, iptv.status(s.id).revision);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM iptv_guide_coverage').get() as { n: number }).n, 0);
  } finally { db.close(); }
});

test('always-on patterns match whole words only', () => {
  const match = alwaysOnMatch(['24/7', '247']);
  for (const name of ['Movies 24/7', '24/7 Comedy', 'US: Cartoons (24/7)', 'Loop 247']) assert.equal(match(name), true, name);
  for (const name of ['Channel 1247', 'News 24', 'Sports 247a']) assert.equal(match(name), false, name);
});

test('event categories follow their events while categories marked regular in the same playlist list as usual', () => {
  const { db, iptv, sports } = fixture();
  try {
    const s = iptv.create('owner', { kind: 'm3u', name: 'Mixed' });
    iptv.ingest('owner', s.id, 0, playlist(entry('p1', 'PPV 1: UFC 333', 'PPV Events'), entry('p2', 'PPV 2: Smith vs Jones', 'PPV Events'), entry('p3', 'PPV 3', 'PPV Events'),
      entry('cnn', 'CNN', 'News'), entry('bbc', 'BBC World', 'News')));
    sports.setPolicy('owner', s.id, { enabled: true, leadMinutes: 30 });
    const byGroup = Object.fromEntries(iptv.groups(s.id).map(g => [g.name, g]));
    assert.deepEqual([byGroup['PPV Events']!.detected, byGroup['PPV Events']!.events, byGroup['News']!.detected, byGroup['News']!.events], ['events', true, 'events', true]);
    // Every category of a sports source follows events until an administrator marks it regular.
    iptv.setGroup('owner', s.id, { expectedRevision: iptv.status(s.id).revision, name: 'News', mode: 'regular', guideExempt: false });
    assert.deepEqual(states(iptv, s.id), { p1: 'no_event', p2: 'no_event', p3: 'no_event', cnn: 'unverified', bbc: 'unverified' });
    // Event channels hold no number until their event; regular ones keep theirs.
    assert.deepEqual(Object.fromEntries(iptv.adminChannels(s.id).map(c => [c.tvgId, c.number !== null])), { p1: false, p2: false, p3: false, cnn: true, bbc: true });
    // An administrator can override a category either way.
    iptv.setGroup('owner', s.id, { expectedRevision: iptv.status(s.id).revision, name: 'PPV Events', mode: 'regular', guideExempt: false });
    assert.ok(iptv.adminChannels(s.id).every(c => !c.event && c.number !== null));
    iptv.setGroup('owner', s.id, { expectedRevision: iptv.status(s.id).revision, name: 'News', mode: 'events', guideExempt: false });
    assert.deepEqual(iptv.adminChannels(s.id).filter(c => c.event).map(c => c.tvgId).sort(), ['bbc', 'cnn']);
    // Turning sports events off makes every category regular.
    sports.setPolicy('owner', s.id, { enabled: false, leadMinutes: 30 });
    assert.ok(iptv.adminChannels(s.id).every(c => !c.event));
  } finally { db.close(); }
});

test('every category of a sports source follows events unless marked regular, and checks skip what cannot list', () => {
  const { db, iptv, health, sports } = fixture();
  try {
    const s = iptv.create('owner', { kind: 'm3u', name: 'Provider' });
    iptv.ingest('owner', s.id, 0, playlist(...Array.from({ length: 6 }, (_, i) => entry(`e${i}`, `ESPN+ 0${i + 1}`, 'Slots')), entry('cnn', 'CNN', 'News'), entry('bbc', 'BBC World', 'News')));
    // Not flagged: slots without event names are regular channels waiting for a check.
    assert.equal(sports.policy(s.id).enabled, false);
    assert.equal(states(iptv, s.id).e0, 'unverified'); assert.equal(health.summary(s.id).unchecked, 8);
    // Flagged as sports and live events: nothing is regular by default, and slots wait for an event, not a check.
    sports.setPolicy('owner', s.id, { enabled: true, leadMinutes: 30 });
    assert.ok(iptv.groups(s.id).every(g => g.detected === 'events'));
    assert.ok(Object.values(states(iptv, s.id)).every(v => v === 'no_event'));
    assert.equal(health.summary(s.id).unchecked, 0); assert.equal(health.queueSource(s.id), 0); assert.equal(health.due(s.id, 50, new Set()).length, 0);
    // An administrator marks a category regular; only its channels wait for a check.
    iptv.setGroup('owner', s.id, { expectedRevision: iptv.status(s.id).revision, name: 'News', mode: 'regular', guideExempt: false });
    assert.deepEqual([states(iptv, s.id).cnn, states(iptv, s.id).e0], ['unverified', 'no_event']);
    assert.equal(health.summary(s.id).unchecked, 2); assert.equal(health.due(s.id, 50, new Set()).length, 2);
    // A regular channel kept out by a missing guide is not checked either.
    rules(iptv, s.id, { requireGuide: true });
    assert.equal(health.summary(s.id).unchecked, 0); assert.equal(health.due(s.id, 50, new Set()).length, 0);
  } finally { db.close(); }
});

test('older databases convert approval: ignored or disabled channels are hidden, check exemptions are always listed', () => {
  const folder = mkdtempSync(join(resolve('.local'), 'listing-')), file = join(folder, 'state.sqlite'), vault = new Vault(randomBytes(32));
  let db = openDatabase(file);
  try {
    let iptv = new IptvStore(db, vault);
    const s = iptv.create('owner', { kind: 'm3u', name: 'Old' });
    iptv.ingest('owner', s.id, 0, playlist(entry('ignored', 'Ignored'), entry('disabled', 'Disabled'), entry('exempt', 'Exempt'), entry('plain', 'Plain')));
    const id = (tvg: string) => iptv.adminChannels(s.id).find(c => c.tvgId === tvg)!.id;
    const [ignored, disabled, exempt] = [id('ignored'), id('disabled'), id('exempt')];
    // Recreate the state from before listing rules existed.
    db.exec('DROP INDEX IF EXISTS iptv_guide_coverage_channel; DROP TABLE iptv_guide_coverage; DROP TABLE iptv_groups; DROP TABLE iptv_listing_policies;');
    for (const column of ['listing', 'event', 'guide_exempt']) db.exec(`ALTER TABLE iptv_channels DROP COLUMN ${column}`);
    db.prepare("UPDATE iptv_channels SET approval='ignored' WHERE id=?").run(ignored);
    db.prepare('UPDATE iptv_channels SET enabled=0 WHERE id=?').run(disabled);
    db.prepare('INSERT INTO iptv_channel_health(channel_id,exempt) VALUES(?,1)').run(exempt);
    db.prepare('DELETE FROM migrations WHERE version=9').run();
    db.close(); db = openDatabase(file); iptv = new IptvStore(db, vault);
    assert.deepEqual(Object.fromEntries(iptv.adminChannels(s.id).map(c => [c.tvgId, c.listing])), { ignored: 'hidden', disabled: 'hidden', exempt: 'always', plain: 'auto' });
    assert.deepEqual(iptv.visible().map(c => c.name), ['Exempt']);
  } finally { db.close(); rmSync(folder, { recursive: true, force: true }); }
});
