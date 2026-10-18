import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import Fastify from 'fastify';
import {openDatabase} from '../apps/server/src/persistence/database.js';
import {IptvStore} from '../apps/server/src/persistence/iptv-store.js';
import {Vault} from '../apps/server/src/security/vault.js';
import {SourceRefresh} from '../apps/server/src/services/source-refresh.js';
import {registerIptv} from '../apps/server/src/iptv-api.js';

const playlist=Buffer.from('#EXTM3U\n#EXTINF:-1 tvg-id="station",Station\nhttps://streams.invalid/station');
const xml=Buffer.from('<tv><channel id="guide"><display-name>Station</display-name></channel><programme channel="guide" start="20261017120000 +0000" stop="20261017130000 +0000"><title>Programme</title></programme></tv>');
const endpoint={url:'https://provider.invalid/guide.xml.gz?token=fixture-secret',headers:{Authorization:'Bearer fixture-secret'},allowInsecureHttp:false};
function fixture() {
  const db=openDatabase(':memory:'),store=new IptvStore(db,new Vault(randomBytes(32)));
  const add=(name:string)=>{
    const source=store.create('owner',{kind:'m3u',name});store.ingest('owner',source.id,0,playlist);
    const channel=store.adminChannels(source.id)[0]!;store.editChannel('owner',channel.id,{expectedRevision:1,listing:'always'});
    return {source:store.status(source.id),channel};
  };
  return {db,store,add};
}

test('source EPG saves are atomic and revision checked, and repeat saves reuse the individual guide',()=>{
  const {db,store,add}=fixture();
  try {
    const {source}=add('Channels');
    const before=()=>JSON.stringify(['iptv_sources','iptv_source_feeds','audit'].map(t=>db.prepare(`SELECT * FROM ${t}`).all()));
    const snapshot=before();
    assert.throws(()=>store.saveGuide('owner',source.id,0,{endpoint,intervalHours:6}),{code:'REVISION_CONFLICT'});
    assert.throws(()=>store.saveGuide('owner',source.id,source.revision,{intervalHours:6}),{code:'GUIDE_ENDPOINT_REQUIRED'});
    assert.throws(()=>store.saveGuide('owner',source.id,source.revision,{endpoint:{...endpoint,url:'http://provider.invalid/guide'},intervalHours:6}),{code:'SOURCE_ENDPOINT_REJECTED'});
    assert.equal(before(),snapshot);
    db.exec("CREATE TRIGGER block_binding BEFORE INSERT ON iptv_source_feeds BEGIN SELECT RAISE(ABORT,'fixture failure'); END");
    assert.throws(()=>store.saveGuide('owner',source.id,source.revision,{endpoint,intervalHours:6}));assert.equal(before(),snapshot);
    db.exec('DROP TRIGGER block_binding');
    const saved=store.saveGuide('owner',source.id,source.revision,{endpoint,intervalHours:6});
    assert.equal(saved.source.feedId,saved.guide.id);assert.equal(saved.guide.intervalHours,6);assert.equal(saved.guide.remote,true);
    assert.ok(!JSON.stringify(saved).includes('fixture-secret'));
    assert.ok(!JSON.stringify(db.prepare('SELECT * FROM iptv_sources').all()).includes('fixture-secret'));
    const changed=store.saveGuide('owner',source.id,saved.source.revision,{intervalHours:12});
    assert.equal(changed.guide.id,saved.guide.id);assert.equal(changed.guide.intervalHours,12);assert.equal(store.list().length,2);
    assert.equal(store.endpoint(saved.guide.id).headers.authorization,'Bearer fixture-secret');
    assert.throws(()=>store.saveGuide('owner',saved.guide.id,changed.guide.revision,{endpoint,intervalHours:6}),{code:'MAPPING_SCOPE'});
    assert.throws(()=>store.removeGuide('owner',source.id,saved.source.revision),{code:'REVISION_CONFLICT'});
    const removed=store.removeGuide('owner',source.id,changed.source.revision);
    assert.equal(removed.feedId,undefined);assert.equal(store.list().length,1);assert.equal(store.visible().length,1);
  } finally {db.close();}
});

test('editing a legacy shared EPG isolates its settings and keeps saved listings and manual mappings',()=>{
  const {db,store,add}=fixture();
  try {
    const first=add('First'),second=add('Second'),feed=store.create('owner',{kind:'xmltv',name:'Legacy shared guide',endpoint});
    store.ingest('owner',feed.id,0,xml);
    for(const {source,channel} of [first,second]){store.bindFeed('owner',source.id,feed.id,source.revision);store.map('owner',channel.id,feed.id,'guide',0);}
    const oldFeed=store.status(feed.id),otherSource=store.status(second.source.id);
    const saved=store.saveGuide('owner',first.source.id,store.status(first.source.id).revision,{endpoint:{...endpoint,url:'https://other.invalid/guide.xml'},intervalHours:24});
    assert.notEqual(saved.guide.id,feed.id);assert.equal(saved.guide.lastSuccess,oldFeed.lastSuccess);
    assert.deepEqual(store.status(second.source.id),otherSource);assert.deepEqual(store.status(feed.id),oldFeed);
    assert.equal(store.endpoint(feed.id).url,endpoint.url);assert.equal(store.endpoint(saved.guide.id).url,'https://other.invalid/guide.xml');
    assert.equal(store.mappingReview(first.channel.id,saved.guide.id).mapping?.method,'admin');
    const start=Date.UTC(2026,9,17,12);
    assert.equal(store.guide(first.channel.id,saved.guide.id,start,start+3600000)[0]?.program?.title,'Programme');
    store.remove('owner',first.source.id,saved.source.revision);
    assert.throws(()=>store.status(saved.guide.id),{code:'SOURCE_NOT_FOUND'});
    assert.equal(store.status(second.source.id).feedId,feed.id);assert.equal(store.visible().length,1);
    store.removeGuide('owner',second.source.id,otherSource.revision);
    assert.throws(()=>store.status(feed.id),{code:'SOURCE_NOT_FOUND'});assert.equal(store.visible().length,1);
  } finally {db.close();}
});

test('removing a guide from one legacy source leaves other linked sources and their mappings intact',()=>{
  const {db,store,add}=fixture();
  try {
    const first=add('First'),second=add('Second'),feed=store.create('owner',{kind:'xmltv',name:'Shared'});
    store.ingest('owner',feed.id,0,xml);
    for(const {source,channel} of [first,second]){store.bindFeed('owner',source.id,feed.id,source.revision);store.map('owner',channel.id,feed.id,'guide',0);}
    const other=store.status(second.source.id);
    store.removeGuide('owner',first.source.id,store.status(first.source.id).revision);
    assert.equal(store.status(first.source.id).feedId,undefined);assert.deepEqual(store.status(second.source.id),other);
    assert.equal(store.mappingReview(second.channel.id,feed.id).mapping?.xmlId,'guide');assert.equal(store.visible().length,2);
    assert.equal(db.prepare('SELECT 1 FROM iptv_mappings WHERE channel_id=?').get(first.channel.id),undefined);
  } finally {db.close();}
});

test('source guide HTTP saves bind immediately, survive failed imports and clean up active refreshes on removal',async()=>{
  const {db,store,add}=fixture(),app=Fastify();
  let fail=false,delayed=false,finish:(bytes:Buffer)=>void=()=>{},signal:AbortSignal|undefined;
  const refresh=new SourceRefresh(store,{fetch:async(_endpoint,inputSignal)=>{
    if(fail)throw Error('provider failure');
    if(delayed){signal=inputSignal;return new Promise<Buffer>(resolve=>{finish=resolve;});}
    return xml;
  }}),access=async()=>({grant:{accountId:'owner'}});
  registerIptv(app,store,refresh,access,access);
  try {
    const {source}=add('Channels'),url=`/api/v1/admin/iptv/sources/${source.id}/guide`;
    const response=await app.inject({method:'PUT',url,payload:{expectedRevision:source.revision,endpoint,intervalHours:6}});
    assert.equal(response.statusCode,200);assert.ok(!response.body.includes('fixture-secret'));
    const saved=response.json();assert.equal(store.status(source.id).feedId,saved.guide.id);
    const refreshUrl=`/api/v1/admin/iptv/sources/${saved.guide.id}/refresh`;
    fail=true;assert.notEqual((await app.inject({method:'POST',url:refreshUrl,payload:{}})).statusCode,200);
    assert.equal(store.status(source.id).feedId,saved.guide.id);assert.equal(store.status(saved.guide.id).lastError,'SOURCE_REFRESH_FAILED');
    fail=false;assert.equal((await app.inject({method:'POST',url:refreshUrl,payload:{}})).statusCode,200);
    assert.ok(store.status(saved.guide.id).lastSuccess);assert.equal(store.list().length,2);
    delayed=true;const work=refresh.refresh('owner',saved.guide.id),cancelled=assert.rejects(work,{name:'AbortError'});await Promise.resolve();
    const removed=await app.inject({method:'DELETE',url,payload:{expectedRevision:saved.source.revision}});
    assert.equal(removed.statusCode,200);assert.equal(removed.json().feedId,undefined);assert.equal(signal?.aborted,true);
    finish(xml);await cancelled;assert.equal(store.list().length,1);assert.equal(store.visible().length,1);
  } finally {await app.close();db.close();}
});
