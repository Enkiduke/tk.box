import test from 'node:test';
import assert from 'node:assert/strict';
import {Activity,PlexFreshness,describeClient,isLocalAddress,type StreamOpen} from '../apps/server/src/services/activity.js';
import {plexRow} from '../apps/server/src/activity-api.js';

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

test('streams whose browser went away drop out: playing after missed 10-second reports, paused after a missed minute, live sooner', () => {
  const activity=new Activity({playing:35000,paused:150000,live:30000});
  activity.open(vod(),0);activity.open(vod({id:'p'}),0);activity.open(vod({id:'b',kind:'live',delivery:'remux'}),0);activity.open(vod({id:'c',kind:'custom',delivery:'remux'}),0);
  activity.progress('p','h',60000,'paused',0);activity.touch('a',0,20000);activity.touch('b',0,20000);
  assert.deepEqual(activity.list(()=>true,40000).map(s=>s.id).sort(),['a','b','p']);
  assert.deepEqual(activity.list(()=>true,100000).map(s=>s.id),['p']);
  assert.equal(activity.list(()=>true,160000).length,0);
  activity.open(vod({id:'d'}),200000);
  assert.equal(activity.list(s=>s.id!=='d',200000).length,0,'the delivering service can end it first');
});

test('a Plex session left playing with a frozen position (a closed tab) is hidden; paused and moving ones stay', () => {
  const fresh=new PlexFreshness(45000),row=(id:string,state:string,positionMs:number)=>({id,state,positionMs});
  fresh.filter([row('ghost','playing',1000),row('paused','paused',5000),row('moving','playing',1000)],0);
  assert.equal(fresh.filter([row('ghost','playing',1000),row('paused','paused',5000),row('moving','playing',30000)],30000).length,3);
  assert.deepEqual(fresh.filter([row('ghost','playing',1000),row('paused','paused',5000),row('moving','playing',60000)],50000).map(r=>r.id),['paused','moving']);
  assert.deepEqual(fresh.filter([row('ghost','playing',2000)],60000).map(r=>r.id),['ghost'],'it comes back once its position moves again');
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

test('Plex app sessions are described like Tautulli: direct play, direct stream or transcode, with Plex’s own bandwidth', () => {
  const base={type:'episode',title:'Pilot',grandparentTitle:'Show',grandparentRatingKey:'9',ratingKey:'10',parentIndex:1,index:1,duration:3600000,viewOffset:60000,
    User:{id:'5',title:'casey'},Player:{product:'Plex Web',title:'Chrome',state:'paused',address:'192.168.1.4',local:true},Session:{id:'abc',bandwidth:20300,location:'lan'},
    Media:[{videoCodec:'h264',audioCodec:'eac3',height:1080,videoResolution:'1080'}]};
  const direct=plexRow(base);
  assert.deepEqual([direct.id,direct.delivery,direct.video,direct.audio,direct.state,direct.local,direct.rateKbps,direct.media?.posterId],['plex:abc','direct','Direct play (H264 1080p)','Direct play (EAC3)','paused',true,20300,'9']);
  const stream=plexRow({...base,TranscodeSession:{videoDecision:'copy',audioDecision:'transcode',audioCodec:'mp3',sourceAudioCodec:'eac3'}});
  assert.deepEqual([stream.delivery,stream.video,stream.audio],['remux','Direct stream (H264 1080p)','Transcode (EAC3 → MP3)']);
  const transcode=plexRow({...base,Player:{...base.Player,local:false,remotePublicAddress:'96.241.30.180'},Session:{id:'abc',location:'wan'},TranscodeSession:{videoDecision:'transcode',videoCodec:'h264',height:720,sourceVideoCodec:'hevc',speed:2.5}});
  assert.deepEqual([transcode.delivery,transcode.video,transcode.ip,transcode.local,transcode.speed],['transcode','Transcode (HEVC 1080p → H264 720p)','96.241.30.180',false,2.5]);
});
