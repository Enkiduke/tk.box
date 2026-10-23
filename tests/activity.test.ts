import test from 'node:test';
import assert from 'node:assert/strict';
import {Activity,describeClient,isLocalAddress,type StreamOpen} from '../apps/server/src/services/activity.js';

const vod=(over:Partial<StreamOpen>={}):StreamOpen=>({id:'a',kind:'vod',hash:'h',accountId:'1',delivery:'transcode',ip:'203.0.113.5',positionMs:60000,durationMs:600000,...over});

test('a playing title carries its position forward; a paused one holds it', () => {
  const activity=new Activity();
  activity.open(vod(),0);
  assert.equal(activity.list(()=>true,5000)[0]!.positionMs,65000);
  activity.progress('a','h',70000,'paused',6000);
  assert.equal(activity.list(()=>true,20000)[0]!.positionMs,70000);
  activity.progress('a','h',70000,'playing',20000);
  activity.touch('a',0,1000000);
  assert.equal(activity.list(()=>true,1000000)[0]!.positionMs,600000,'never past the end');
});

test('progress from another session is ignored, and stopped ends the stream', () => {
  const activity=new Activity();
  activity.open(vod(),0);
  activity.progress('a','other',1,'stopped',1000);
  assert.equal(activity.list(()=>true,1000).length,1);
  activity.progress('a','h',1,'stopped',1000);
  assert.equal(activity.list(()=>true,1000).length,0);
});

test('idle streams drop out: library after a missed paused check-in, live sooner, and when the service has ended them', () => {
  const activity=new Activity({vod:150000,live:60000});
  activity.open(vod(),0);activity.open(vod({id:'b',kind:'live',delivery:'remux'}),0);activity.open(vod({id:'c',kind:'custom',delivery:'remux'}),0);
  assert.deepEqual(activity.list(()=>true,90000).map(s=>s.id),['a']);
  activity.touch('a',0,140000);
  assert.equal(activity.list(()=>true,200000).length,1);
  assert.equal(activity.list(s=>s.id!=='a',200000).length,0);
});

test('bandwidth is measured over the last 30 seconds, and estimated from the file for direct play', () => {
  const activity=new Activity();
  activity.open(vod({id:'hls',kind:'live',delivery:'remux'}),0);
  for(let at=1000;at<=60000;at+=4000)activity.touch('hls',2_500_000,at);
  // 2.5 MB every 4 s is 5 Mbps.
  const rate=activity.list(()=>true,60000)[0]!.rateKbps!;
  assert.ok(rate>4500&&rate<5500,String(rate));
  activity.open(vod({id:'file',delivery:'direct',source:{bitrateKbps:9800}}),60000);
  assert.equal(activity.list(()=>true,61000).find(s=>s.id==='file')!.rateKbps,9800);
  activity.progress('file','h',1,'paused',61000);
  assert.equal(activity.list(()=>true,62000).find(s=>s.id==='file')!.rateKbps,0);
});

test('clients and addresses are described for the activity cards', () => {
  assert.equal(describeClient('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'),'Chrome · Windows');
  assert.equal(describeClient('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'),'Safari · iOS');
  assert.equal(describeClient(undefined),'Unknown device');
  for(const ip of ['192.168.1.20','10.0.0.4','172.20.1.1','127.0.0.1','::1','::ffff:192.168.0.9','fd12::1'])assert.ok(isLocalAddress(ip),ip);
  for(const ip of ['96.241.30.180','172.32.0.1','2001:db8::1'])assert.ok(!isLocalAddress(ip),ip);
});
