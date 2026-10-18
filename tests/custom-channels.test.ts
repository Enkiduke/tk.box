import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../apps/server/src/persistence/database.js';
import { CustomChannelStore, entryIssue, type Selection } from '../apps/server/src/persistence/custom-channels.js';
import { arrange, type ArrangeEntry } from '../apps/server/src/services/arrange.js';
import type { ChannelMedia } from '../apps/server/src/providers/plex.js';

const ep = (show: string, season: number, episode: number): ArrangeEntry => ({ entryId: `${show}${season}-${episode}`, mediaId: `${show}${season}${episode}`, kind: 'episode', title: `${show} ${season}x${episode}`, showId: show, showTitle: show, season, episode });
const movie = (title: string, year?: number): ArrangeEntry => ({ entryId: title, mediaId: title, kind: 'movie', title, year });
const ids = (list: ArrangeEntry[]) => list.map(e => e.entryId);
let counter = 0; const newId = () => `copy-${++counter}`;
const seeded = (seed: number) => () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
const order = (list: ArrangeEntry[], show: string) => list.filter(e => e.showId === show).map(e => e.episode);

test('arrange tools reorder, drop and copy without losing entry identity', () => {
  const list = [ep('B', 1, 2), movie('Zed'), ep('A', 1, 1), ep('B', 1, 1), movie('Alpha'), ep('A', 0, 1), ep('A', 1, 2)];
  assert.deepEqual(ids(arrange(list, { tool: 'sortShows' }, newId)), ['A0-1', 'A1-1', 'A1-2', 'B1-1', 'B1-2', 'Alpha', 'Zed']);
  // Round robin in first-appearance order: B, Movies, A.
  assert.deepEqual(ids(arrange(list, { tool: 'interleave' }, newId)), ['B1-2', 'Zed', 'A1-1', 'B1-1', 'Alpha', 'A0-1', 'A1-2']);
  assert.deepEqual(ids(arrange(list, { tool: 'removeSpecials' }, newId)), ['B1-2', 'Zed', 'A1-1', 'B1-1', 'Alpha', 'A1-2']);
  const shuffled = arrange(list, { tool: 'shuffle' }, newId, seeded(7));
  assert.deepEqual(ids(shuffled).sort(), ids(list).sort());
  // Block shuffle keeps each show's current order and keeps blocks of two together.
  const shows = [ep('A', 1, 1), ep('A', 1, 2), ep('A', 1, 3), ep('A', 1, 4), ep('B', 1, 1), ep('B', 1, 2), movie('M')];
  for (let seed = 1; seed < 20; seed++) {
    const out = arrange(shows, { tool: 'blockShuffle', size: 2 }, newId, seeded(seed));
    assert.deepEqual(order(out, 'A'), [1, 2, 3, 4]); assert.deepEqual(order(out, 'B'), [1, 2]);
    const a = out.findIndex(e => e.entryId === 'A1-1'); assert.equal(out[a + 1]!.entryId, 'A1-2');
  }
  const copies = arrange([movie('X'), movie('Y')], { tool: 'replicate', times: 3 }, newId);
  assert.equal(copies.length, 6); assert.equal(new Set(ids(copies)).size, 6); assert.deepEqual(copies.map(e => e.mediaId), ['X', 'Y', 'X', 'Y', 'X', 'Y']);
  assert.deepEqual(ids(arrange(copies, { tool: 'removeDuplicates' }, newId)), ['X', 'Y']);
  assert.deepEqual(ids(arrange([movie('New', 2020), movie('Undated'), movie('Old', 1990)], { tool: 'sortDate' }, newId)), ['Old', 'New', 'Undated']);
});

const media = (mediaId: string, extra: Partial<ChannelMedia> = {}): ChannelMedia => ({ mediaId, kind: 'movie', title: mediaId, durationMs: 10000, video: { codec: 'h264', width: 1920, height: 1080, container: 'mkv' }, ...extra });
const episode = (mediaId: string, season: number, episodeNumber: number) => media(mediaId, { kind: 'episode', showId: 'show', showTitle: 'Show', season, episode: episodeNumber });
test('channel compatibility follows the encode policy', () => {
  assert.equal(entryIssue(media('a')), undefined);
  assert.equal(entryIssue(media('b', { video: { codec: 'h264', width: 3840, height: 2160 } })), undefined); // copied, not encoded
  assert.equal(entryIssue(media('c', { video: { codec: 'hevc', width: 3840, height: 2160 } })), 'incompatible');
  assert.equal(entryIssue(media('d', { video: { codec: 'hevc', width: 1920, height: 1080 } })), undefined);
  assert.equal(entryIssue(media('e', { durationMs: 0 })), 'no_duration');
  assert.equal(entryIssue(media('f', { video: undefined })), 'no_media');
});

test('drafts expand shows in order, skip repeats, and publish at the next program boundary', () => {
  const db = openDatabase(':memory:'), store = new CustomChannelStore(db);
  try {
    const channel = store.create('admin', { name: 'Sitcoms', number: 5 }, 0);
    assert.throws(() => store.create('admin', { name: 'Clash', number: 5 }, 0), { code: 'NUMBER_CONFLICT' });
    const show: Selection = { root: { id: '100', type: 'show', title: 'Show' }, items: [episode('e3', 1, 2), episode('e1', 0, 1), episode('e2', 1, 1)] };
    let result = store.addItems('admin', channel.id, { expectedRevision: channel.revision, ids: ['100'] }, [show], 0);
    assert.deepEqual(result.channel.entries.map(e => e.mediaId), ['e2', 'e3']); assert.equal(result.specials, 1);
    result = store.addItems('admin', channel.id, { expectedRevision: result.channel.revision, ids: ['100', '7'] }, [show, { root: { id: '7', type: 'movie', title: 'Film' }, items: [media('m1')] }], 0);
    assert.equal(result.skipped, 2); assert.equal(result.added, 1);
    assert.equal(result.channel.sources.length, 1);
    assert.throws(() => store.setOrder('admin', channel.id, { expectedRevision: 0, entryIds: [] }), { code: 'REVISION_CONFLICT' });
    let detail = result.channel;
    const [a, b, c] = detail.entries;
    assert.equal(store.list(0)[0]!.changed, true); assert.equal(store.stations('viewer', false, '', undefined, 0).length, 0);
    // First publication starts now: A 0–10s, B 10–20s, C 20–30s.
    let published = store.publish('admin', channel.id, { expectedRevision: detail.revision, expectedPublication: 0 }, 0);
    assert.equal(published.effectiveAt, 0); assert.equal(published.channel.changed, false);
    assert.equal(store.stations('viewer', false, '', undefined, 1).length, 1);
    // During B, remove B and reorder: B finishes, then the list restarts at its first entry.
    detail = store.setOrder('admin', channel.id, { expectedRevision: published.channel.revision, entryIds: [c!.entryId, a!.entryId] }, 12000);
    const preview = store.preview(channel.id, 12000);
    assert.equal(preview.current?.entryId, b!.entryId); assert.equal(preview.effectiveAt, 20000); assert.equal(preview.reason, 'FIRST_ENTRY');
    assert.deepEqual(preview.upcoming.slice(0, 3).map(s => s.entryId), [c!.entryId, a!.entryId, c!.entryId]);
    published = store.publish('admin', channel.id, { expectedRevision: detail.revision, expectedPublication: 1 }, 12000);
    assert.equal(store.list(15000)[0]!.pending?.effectiveAt, 20000);
    const guide = store.programs(channel.id, 0, 40000);
    assert.deepEqual(guide.map(s => s.program?.title), ['Show', 'Show', 'm1', 'Show']);
    assert.deepEqual(guide.map(s => s.start), [0, 10000, 20000, 30000]);
    assert.equal(guide[0]!.program?.subtitle, 'S1E1 · e2');
    // Unplayable programs block publishing.
    const bad = store.addItems('admin', channel.id, { expectedRevision: published.channel.revision, ids: ['9'] }, [{ root: { id: '9', type: 'movie', title: '4K' }, items: [media('k', { video: { codec: 'hevc', width: 3840, height: 2160 } })] }], 13000);
    assert.equal(bad.issues, 1);
    assert.throws(() => store.publish('admin', channel.id, { expectedRevision: bad.channel.revision, expectedPublication: 2 }, 13000), { code: 'UNPLAYABLE_PROGRAMS' });
    const discarded = store.discard('admin', channel.id, { expectedRevision: bad.channel.revision }, 13000);
    assert.deepEqual(discarded.entries.map(e => e.entryId), [c!.entryId, a!.entryId]);
    store.remove('admin', channel.id, discarded.revision, 14000);
    assert.equal(store.list().length, 0); assert.equal((db.prepare('SELECT count(*) AS n FROM publications').get() as { n: number }).n, 0);
  } finally { db.close(); }
});
