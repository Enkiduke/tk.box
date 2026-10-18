import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, SettingsStore } from '../apps/server/src/persistence/database.js';
import { ChannelScheduler, type Entry } from '../apps/server/src/services/scheduler.js';
import { SegmentBuffer, ViewerCursor, renderManifest } from '../apps/server/src/streaming/buffer.js';

const entry = (id: string, mediaId = id): Entry => ({occurrenceId: id, mediaId, title: id, durationMs: 10000, mediaOffsetMs: 0});
test('persistent deterministic clock joins, exact boundaries, wrap and safe successor publications', () => {
  const path = mkdtempSync(join(tmpdir(), 'tk.box-scheduler-')); const file = join(path, 'db.sqlite'); let db = openDatabase(file);
  try {
    let scheduler = new ChannelScheduler(db); const a = entry('A'), b = entry('B'), c = entry('C'), x = entry('X');
    scheduler.publish('channel', [a,b,c], 0, 100000, 'admin');
    assert.equal(scheduler.current('channel', 118000).entry.occurrenceId, 'B'); assert.equal(scheduler.current('channel', 118000).offsetMs, 8000);
    const pub = scheduler.publish('channel', [a,b,x,c], 1, 118000, 'admin');
    assert.equal(pub.effectiveAt, 120000); assert.equal(pub.nextEntryId, 'X');
    assert.equal(scheduler.current('channel', 119999).entry.occurrenceId, 'B'); assert.equal(scheduler.current('channel', 120000).entry.occurrenceId, 'X');
    assert.equal(scheduler.current('channel', 121000).offsetMs, 1000);
    assert.equal(scheduler.current('channel', 160000).entry.occurrenceId, 'X');
    db.close(); db = openDatabase(file); scheduler = new ChannelScheduler(db);
    assert.equal(scheduler.current('channel', 121000).offsetMs, 1000);
    const preview = scheduler.guide('channel', 115000, 145000);
    assert.deepEqual(preview.map(s => s.entry.occurrenceId), ['B', 'X', 'C', 'A']);
    assert.throws(() => scheduler.publish('channel', [], 2, 122000, 'admin'));
    assert.throws(() => scheduler.publish('channel', [a,b], 1, 122000, 'admin'), {code: 'REVISION_CONFLICT'});
  } finally {db.close(); rmSync(path, {recursive: true, force: true});}
});
test('removed occurrence fallback, duplicate media identity, wrap, and pending supersession', () => {
  const db = openDatabase(':memory:'), scheduler = new ChannelScheduler(db);
  try {
    const a = entry('A', 'same-plex-item'), b = entry('B', 'same-plex-item'), c = entry('C');
    scheduler.publish('channel', [a,b,c], 0, 0, 'admin');
    const first = scheduler.publish('channel', [c,a,b], 1, 15000, 'admin'); assert.equal(first.nextEntryId, 'C');
    const second = scheduler.publish('channel', [a,c], 2, 16000, 'admin'); assert.equal(second.effectiveAt, first.effectiveAt); assert.equal(second.reason, 'FIRST_ENTRY');
    assert.equal(scheduler.current('channel', 19999).entry.occurrenceId, 'B'); assert.equal(scheduler.current('channel', 20000).entry.occurrenceId, 'A');
    const superseded = db.prepare('SELECT count(*) AS n FROM publications WHERE superseded=1').get() as {n: number}; assert.equal(superseded.n, 1);
    assert.throws(() => scheduler.publish('channel', [a,a], 3, 21000, 'admin'), {code: 'DUPLICATE_OCCURRENCE'});
  } finally {db.close();}
});
test('settings defaults, validation, transactional revision and restart persistence', () => {
  const path = mkdtempSync(join(tmpdir(), 'tk.box-settings-')), file = join(path, 'db.sqlite'); let db = openDatabase(file);
  try {
    const store = new SettingsStore(db); assert.deepEqual(store.get(), {revision: 0, maxConcurrentCpuVideoTranscodes: 2, pauseRetentionMinutes: 30});
    assert.throws(() => store.update('admin', 0, {maxConcurrentCpuVideoTranscodes: 2.5, pauseRetentionMinutes: 0}));
    store.update('admin', 0, {maxConcurrentCpuVideoTranscodes: 3, pauseRetentionMinutes: 15});
    db.close(); db = openDatabase(file); assert.equal(new SettingsStore(db).get().maxConcurrentCpuVideoTranscodes, 3);
  } finally {db.close(); rmSync(path, {recursive: true, force: true});}
});
test('independent Pause/Resume across program boundary, retained delay and explicit Go Live', () => {
  let retention = 30000;
  const buffer = new SegmentBuffer(100000, () => retention);
  for (let i=0; i<30; i++) buffer.add({id: `s${i}`, start: i*1000, end: (i+1)*1000, bytes: 100, programId: i < 10 ? 'A' : 'B', revision: 1, uri: `segment-${i}.ts`, discontinuity: i === 10, sequence: i}, (i+1)*1000);
  const a = new ViewerCursor(buffer, () => retention), b = new ViewerCursor(buffer, () => retention);
  a.pause(8000, 9000); assert.equal(a.position(16000), 8000); assert.equal(b.position(16000), 16000);
  a.resume(16000); assert.equal(a.position(20000), 12000); assert.equal(a.inspect(20000).behindLiveMs, 8000);
  assert.ok(renderManifest(buffer.from(8000)).includes('#EXT-X-DISCONTINUITY'));
  a.goLive(); assert.equal(a.inspect(21000).state, 'LIVE'); assert.equal(a.position(21000), 21000);
  a.pause(20000, 21000); retention = 5000; assert.equal(a.inspect(27000).state, 'EXPIRED'); assert.throws(() => a.resume(27000));
  a.goLive(); assert.equal(a.inspect(27000).state, 'LIVE'); a.stop(); assert.throws(() => a.goLive());
});
test('disk quota and actual missing segments shorten retention without silent cursor jumps', () => {
  const buffer = new SegmentBuffer(200, () => 30000), viewer = new ViewerCursor(buffer, () => 30000);
  const segment = (i: number) => ({id: `s${i}`, start: i*1000, end: (i+1)*1000, bytes: 100, programId: 'A', revision: 1, uri: `s${i}.ts`, discontinuity: false, sequence: i});
  buffer.add(segment(0), 1000); viewer.pause(500, 1000); buffer.add(segment(1), 2000);
  const removed = buffer.add(segment(2), 3000); assert.equal(removed.length, 1); assert.equal(buffer.bytes, 200);
  assert.equal(viewer.inspect(3000).state, 'EXPIRED'); assert.equal(viewer.position(3000), 500);
});
