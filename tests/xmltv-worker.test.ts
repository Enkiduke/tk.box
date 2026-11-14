import test from 'node:test';
import assert from 'node:assert/strict';
import { parseXmltv } from '../apps/server/src/providers/iptv.js';
import { parseXmltvOffThread } from '../apps/server/src/providers/xmltv-parse.js';

const guide = Buffer.from(`<tv><channel id="a.us"><display-name>A</display-name></channel>
  <programme channel="a.us" start="20261114120000 +0000" stop="20261114130000 +0000"><title>News</title><desc>Today</desc></programme></tv>`);

test('a guide parsed in the worker matches the in-thread parse', async () => {
  const parsed = await parseXmltvOffThread(guide);
  assert.equal(parsed.text, JSON.stringify(parseXmltv(guide)));
  assert.equal(parsed.channels, 1);
});

test('worker parse errors keep their code and status', async () => {
  await assert.rejects(parseXmltvOffThread(Buffer.from('<rss></rss>')), { code: 'INVALID_XMLTV', status: 400 });
  await assert.rejects(parseXmltvOffThread(Buffer.from('<!DOCTYPE tv><tv/>')), { code: 'UNSAFE_XML' });
});

test('aborting stops the worker parse', async () => {
  const controller = new AbortController();
  const parsing = parseXmltvOffThread(guide, controller.signal);
  controller.abort(new Error('stopped'));
  await assert.rejects(parsing, /stopped/);
  const aborted = new AbortController(); aborted.abort(new Error('already'));
  await assert.rejects(parseXmltvOffThread(guide, aborted.signal), /already/);
});
