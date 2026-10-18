import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { parseM3u, parseXmltv, xmltvTime, mappingCandidates, approveMapping, guideWindow, resolveGuideMapping } from '../apps/server/src/providers/iptv.js';
import { newSource, reconcile, viewerChannels } from '../apps/server/src/services/iptv-reconcile.js';
const m3u = readFileSync(new URL('./fixtures/live.m3u', import.meta.url), 'utf8');
const xml = readFileSync(new URL('./fixtures/guide.xml', import.meta.url), 'utf8');
test('M3U handles quoted commas, excludes explicit VOD, rejects truncated/empty/unsafe input', () => {
  const s = parseM3u(m3u); assert.equal(s.channels.length, 2); assert.equal(s.ignoredNonLive, 1); assert.equal(s.channels[0]!.group, 'News, UK');
  for (const input of ['#EXTM3U', '#EXTM3U\n#EXTINF:-1,Missing URI', '#EXTM3U\n#EXTINF:-1,Bad\nfile:///etc/passwd']) assert.throws(() => parseM3u(input));
});
test('XMLTV explicit offsets, calendar validation, gzip and XML safety', () => {
  const s = parseXmltv(gzipSync(xml)); assert.equal(s.programs.length, 3); assert.equal(s.programs[0]!.start, Date.UTC(2026, 9, 17, 11)); assert.equal(s.programs[0]!.title, 'News & Weather');
  assert.equal(xmltvTime('20261101013000 -0400') + 3600000, xmltvTime('20261101013000 -0500'));
  for (const input of ['20260230010000 +0000', '20261017250000 +0000', '20261017120000']) assert.throws(() => xmltvTime(input));
  for (const input of [xml.slice(0, -8), '<!DOCTYPE tv [<!ENTITY x "bad">]><tv/>', '<tv/>']) assert.throws(() => parseXmltv(input));
});
test('guide exact ID automatic candidates; approximate matches require source-scoped admin approval', () => {
  const s = parseM3u(m3u), x = parseXmltv(xml);
  assert.equal(mappingCandidates(s.channels[0]!, s.channels, x).exactId, 'news.uk');
  const sport = mappingCandidates(s.channels[1]!, s.channels, x); assert.equal(sport.exactId, undefined); assert.equal(sport.suggestions[0]!.applied, false);
  const scope = {sourceId: 'source-a', feedId: 'feed-a'};
  const input = {...scope, accountId: 'admin', role: 'admin' as const, channelId: 'station', xmlId: 'sports-guide', expectedRevision: 0};
  const approved = approveMapping(input, undefined, scope, x); assert.equal(approved.method, 'admin'); assert.equal(approved.reviewedBy, 'admin');
  const mappedScope = {...scope, channelId: 'station'};
  assert.equal(resolveGuideMapping(mappedScope, s.channels[0]!, s.channels, x)?.method, 'exact_id');
  assert.equal(resolveGuideMapping(mappedScope, s.channels[0]!, s.channels, x, approved)?.xmlId, 'sports-guide');
  assert.throws(() => approveMapping({...input, role: 'viewer'}, undefined, scope, x));
  assert.throws(() => approveMapping({...input, feedId: 'other'}, undefined, scope, x));
  assert.throws(() => approveMapping(input, approved, scope, x));
  const duplicate = {...x, channels: [...x.channels, x.channels[0]!]};
  assert.equal(mappingCandidates(s.channels[0]!, s.channels, duplicate).exactId, undefined);
  assert.equal(mappingCandidates(s.channels[0]!, [...s.channels, s.channels[0]!], x).exactId, 'news.uk');
  const unrelated={...s.channels[0]!,name:'Unrelated station'};
  assert.equal(mappingCandidates(s.channels[0]!, [...s.channels, unrelated], x).exactId, undefined);
  assert.equal(resolveGuideMapping(mappedScope,s.channels[0]!,[...s.channels,unrelated],x,approved)?.xmlId,'sports-guide','manual mappings survive shared IDs');
});
test('cached guide uses actual intervals with exact gaps and no age cutoff', () => {
  const s = parseXmltv(xml), start = Date.UTC(2026, 9, 17, 10, 30), end = Date.UTC(2026, 9, 17, 14);
  const window = guideWindow(s.programs, 'news.uk', start, end);
  assert.deepEqual(window.map(r => r.program?.title ?? 'No guide data'), ['No guide data', 'News & Weather', 'No guide data', 'Afternoon', 'No guide data']);
  assert.equal(window.at(-1)!.start, Date.UTC(2026, 9, 17, 13));
  assert.equal(guideWindow(s.programs, undefined, start, end)[0]!.program, null);
});
test('24/7 channels fill guide gaps with their own name', () => {
  const start = Date.UTC(2026, 9, 17, 10), end = Date.UTC(2026, 9, 17, 12);
  const [row, ...rest] = guideWindow([], undefined, start, end, 'US: 24/7 Marvel Movies');
  assert.equal(rest.length, 0);
  assert.deepEqual({ ...row!.program, channelId: undefined }, { channelId: undefined, start, end, title: '24/7 Marvel Movies', continuous: true });
  assert.equal(guideWindow([], undefined, start, end, 'US: CNN')[0]!.program, null);
});
test('invalid and overlapping XMLTV intervals are quarantined without invented timing', () => {
  const extra = '<programme channel="news.uk" start="20261017121500 +0100" stop="20261017124500 +0100"><title>Conflict</title></programme>';
  const s = parseXmltv(xml.replace('</tv>', extra + '</tv>'));
  assert.equal(s.quarantined, 2); assert.ok(!s.programs.some(p => p.title === 'News & Weather' || p.title === 'Conflict'));
});
test('new channels default pending; future policy flips preserve pending; disappearance/restore retain disabled state and numbers', () => {
  const snapshot = parseM3u(m3u); let state = reconcile(newSource('source-a'), snapshot, 0, true, [1], 0);
  assert.equal(state.refreshIntervalHours, 12); assert.equal(viewerChannels(state).length, 0);
  state.autoAddNewChannels = true; state = reconcile(state, snapshot, 1, true, [1], 1); assert.equal(viewerChannels(state).length, 0);
  const c = state.channels[0]!; c.status = 'approved'; c.number = 5; c.order = 20; c.displayName = 'Curated name'; c.adminEnabled = false;
  const id = c.id;
  const missing = reconcile(state, {...snapshot, channels: [snapshot.channels[1]!]}, 2, true, [], 2);
  assert.equal(missing.channels[0]!.present, false); assert.equal(missing.channels[0]!.number, 5);
  const restored = reconcile(missing, snapshot, 3, true, [], 3);
  assert.equal(restored.channels[0]!.id, id); assert.equal(restored.channels[0]!.present, true); assert.equal(restored.channels[0]!.displayName, 'Curated name'); assert.equal(viewerChannels(restored).length, 0);
  assert.throws(() => reconcile(restored, snapshot, 4, false, [], 4));
  const recycled = {...snapshot, channels: [{...snapshot.channels[0]!, name: 'Different station'}, snapshot.channels[1]!]};
  assert.equal(reconcile(restored, recycled, 4, true, [], 4).channels[0]!.status, 'conflict');
});
