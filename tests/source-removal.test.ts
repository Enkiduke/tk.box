import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { openDatabase } from '../apps/server/src/persistence/database.js';
import { IptvStore } from '../apps/server/src/persistence/iptv-store.js';
import { Vault } from '../apps/server/src/security/vault.js';
import { SourceRefresh } from '../apps/server/src/services/source-refresh.js';
import { PlexAdapter } from '../apps/server/src/providers/plex.js';
import { IdentityService } from '../apps/server/src/services/identity.js';
import { buildApp } from '../apps/server/src/app.js';
import { config, fakePlex } from './fixtures.js';

const playlist=Buffer.from('#EXTM3U\n#EXTINF:-1 tvg-id="station",Station\nhttps://streams.invalid/live');
const xml=Buffer.from('<tv><channel id="guide"><display-name>Station</display-name></channel><programme channel="guide" start="20261017120000 +0000" stop="20261017130000 +0000"><title>Programme</title></programme></tv>');
function fixture() {
  const db=openDatabase(':memory:'),vault=new Vault(randomBytes(32)),store=new IptvStore(db,vault);
  db.prepare('INSERT INTO users(account_id) VALUES(?)').run('owner');
  const feed=store.create('owner',{kind:'xmltv',name:'Shared EPG'});
  store.ingest('owner',feed.id,0,xml);
  const addPlaylist=(name:string)=>{
    const source=store.create('owner',{kind:'m3u',name});store.ingest('owner',source.id,0,playlist);
    const channel=store.adminChannels(source.id)[0]!;
    store.editChannel('owner',channel.id,{expectedRevision:1,listing:'always'});
    store.bindFeed('owner',source.id,feed.id,2);store.map('owner',channel.id,feed.id,'guide',0);store.favorite('owner',channel.id,true);
    return {source:store.status(source.id),channel:store.adminChannels(source.id)[0]!};
  };
  return {db,store,feed,addPlaylist};
}

test('M3U removal is atomic, revision checked and releases only its own channels, favorites and numbers',()=>{
  const {db,store,feed,addPlaylist}=fixture();
  try {
    const first=addPlaylist('First'),second=addPlaylist('Second');
    const before=()=>JSON.stringify(['iptv_sources','iptv_channels','iptv_favorites','iptv_mappings','lineup_numbers','iptv_source_feeds','audit'].map(table=>db.prepare(`SELECT * FROM ${table}`).all()));
    const snapshot=before();
    assert.throws(()=>store.remove('owner',first.source.id,0),{code:'REVISION_CONFLICT'});assert.equal(before(),snapshot);
    db.exec("CREATE TRIGGER block_removal BEFORE DELETE ON iptv_sources BEGIN SELECT RAISE(ABORT,'fixture failure'); END");
    assert.throws(()=>store.remove('owner',first.source.id,first.source.revision));assert.equal(before(),snapshot);
    db.exec('DROP TRIGGER block_removal');
    assert.equal(store.remove('owner',first.source.id,first.source.revision).status,'removed');
    assert.throws(()=>store.status(first.source.id),{code:'SOURCE_NOT_FOUND'});
    assert.deepEqual(store.visible().map(c=>c.id),[second.channel.id]);assert.deepEqual(store.favorites('owner').map(c=>c.id),[second.channel.id]);
    for(const table of ['iptv_favorites','iptv_mappings','lineup_numbers'])assert.equal(db.prepare(`SELECT 1 FROM ${table} WHERE channel_id=?`).get(first.channel.id),undefined);
    assert.equal(store.status(second.source.id).feedId,feed.id);assert.equal(store.status(second.source.id).revision,second.source.revision);
    assert.equal(store.mappingReview(second.channel.id,feed.id).mapping?.xmlId,'guide');
    const replacement=addPlaylist('Replacement');assert.equal(replacement.channel.number,first.channel.number);
    const audit=db.prepare("SELECT detail FROM audit WHERE event='iptv_source_removed'").all();assert.equal(audit.length,1);assert.ok(!JSON.stringify(audit).includes('streams.invalid'));
  } finally {db.close();}
});

test('EPG removal unlinks every playlist, invalidates stale revisions and keeps channels and other guides',()=>{
  const {db,store,feed,addPlaylist}=fixture();
  try {
    const first=addPlaylist('First'),second=addPlaylist('Second'),other=store.create('owner',{kind:'xmltv',name:'Other EPG'});
    store.ingest('owner',other.id,0,xml);
    store.bindFeed('owner',first.source.id,other.id,first.source.revision);store.map('owner',first.channel.id,other.id,'guide',0);
    const firstRevision=store.status(first.source.id).revision;
    const channels=JSON.stringify(store.visible()),favorites=JSON.stringify(store.favorites('owner'));
    store.remove('owner',feed.id,store.status(feed.id).revision);
    assert.equal(store.status(second.source.id).feedId,undefined);assert.equal(store.status(second.source.id).revision,second.source.revision+1);
    assert.equal(store.status(first.source.id).feedId,other.id);assert.equal(store.status(first.source.id).revision,firstRevision);
    assert.equal(db.prepare('SELECT 1 FROM iptv_mappings WHERE feed_id=?').get(feed.id),undefined);
    assert.equal(store.mappingReview(first.channel.id,other.id).mapping?.xmlId,'guide');
    assert.equal(JSON.stringify(store.visible()),channels);assert.equal(JSON.stringify(store.favorites('owner')),favorites);
    const start=Date.UTC(2026,9,17,12),page=store.guidePage('owner','all',start,start+3600000,0,30);
    assert.equal(page.channels.find(c=>c.id===second.channel.id)!.programs[0]!.program,null);
    assert.equal(page.channels.find(c=>c.id===first.channel.id)!.programs[0]!.program?.title,'Programme');
    assert.throws(()=>store.policy('owner',second.source.id,{expectedRevision:second.source.revision,intervalHours:12}),{code:'REVISION_CONFLICT'});
  } finally {db.close();}
});

test('removing an actively refreshing source cancels only its fetch and prevents late publication',async()=>{
  const db=openDatabase(':memory:'),store=new IptvStore(db,new Vault(randomBytes(32)));
  const endpoint={url:'https://provider.invalid/playlist'},first=store.create('owner',{kind:'m3u',name:'First',endpoint}),second=store.create('owner',{kind:'m3u',name:'Second',endpoint});
  const pending:{signal:AbortSignal;finish:(bytes:Buffer)=>void}[]=[];
  const refresh=new SourceRefresh(store,{fetch:async(_endpoint,signal)=>new Promise<Buffer>(finish=>pending.push({signal:signal!,finish}))});
  try {
    const a=refresh.refresh('owner',first.id),b=refresh.refresh('owner',second.id),rejected=assert.rejects(a,{name:'AbortError'});
    await Promise.resolve();assert.equal(pending.length,2);
    store.policy('owner',first.id,{expectedRevision:0,intervalHours:24});
    assert.throws(()=>refresh.remove('owner',first.id,0),{code:'REVISION_CONFLICT'});assert.equal(pending[0]!.signal.aborted,false);
    refresh.remove('owner',first.id,1);assert.equal(pending[0]!.signal.aborted,true);assert.equal(pending[1]!.signal.aborted,false);
    pending[0]!.finish(playlist);pending[1]!.finish(playlist);await rejected;await b;
    assert.throws(()=>store.status(first.id),{code:'SOURCE_NOT_FOUND'});assert.equal(store.adminChannels(second.id).length,1);
    assert.equal(refresh.active(first.id),false);assert.equal(store.list().length,1);
    const queued=store.create('owner',{kind:'m3u',name:'Queued',endpoint}),work=refresh.refresh('owner',queued.id),cancelled=assert.rejects(work,{name:'AbortError'});
    refresh.remove('owner',queued.id,0);await cancelled;assert.equal(pending.length,2);
  } finally {await refresh.close();db.close();}
});

test('source removal HTTP requires administrator, exact origin and current revision for M3U and EPG',async()=>{
  const db=openDatabase(':memory:'),vault=new Vault(randomBytes(32)),fixture=fakePlex({accountId:1}),plex=new PlexAdapter(config(),'test',fixture.transport),app=await buildApp(config(),db,vault,plex,false),identity=new IdentityService(db,vault,plex);
  const ownerLink=await identity.start(),owner=await identity.finish(ownerLink.binding);assert.ok(owner);
  fixture.options.accountId=2;const viewerLink=await identity.start(),viewer=await identity.finish(viewerLink.binding);assert.ok(viewer);
  const headers=(isOwner=true)=>{fixture.options.accountId=isOwner?1:2;return {origin:'http://127.0.0.1:3000',cookie:`tk.box_local=${isOwner?owner.cookie:viewer.cookie}`};};
  try {
    for(const kind of ['m3u','xmltv']) {
      const created=await app.inject({method:'POST',url:'/api/v1/admin/iptv/sources',headers:headers(),payload:{kind,name:'Remove fixture'}}),source=created.json(),url=`/api/v1/admin/iptv/sources/${source.id}`;
      assert.equal(created.statusCode,200);
      assert.equal((await app.inject({method:'DELETE',url,headers:{origin:'http://127.0.0.1:3000'},payload:{expectedRevision:0}})).statusCode,401);
      assert.equal((await app.inject({method:'DELETE',url,headers:headers(false),payload:{expectedRevision:0}})).statusCode,403);
      assert.equal((await app.inject({method:'DELETE',url,headers:{...headers(),origin:'https://attacker.invalid'},payload:{expectedRevision:0}})).statusCode,403);
      for(const payload of [{},{expectedRevision:-1},{expectedRevision:0,extra:true}])assert.equal((await app.inject({method:'DELETE',url,headers:headers(),payload})).statusCode,400);
      assert.equal((await app.inject({method:'DELETE',url,headers:headers(),payload:{expectedRevision:1}})).statusCode,409);
      const removed=await app.inject({method:'DELETE',url,headers:headers(),payload:{expectedRevision:0}});assert.equal(removed.statusCode,200);assert.deepEqual(removed.json(),{status:'removed',id:source.id});
      assert.equal((await app.inject({method:'DELETE',url,headers:headers(),payload:{expectedRevision:0}})).statusCode,404);
      assert.equal((await app.inject({method:'POST',url:`${url}/refresh`,headers:headers(),payload:{}})).statusCode,404);
    }
    assert.deepEqual((await app.inject({url:'/api/v1/admin/iptv/sources',headers:headers()})).json().sources,[]);
  } finally {await app.close();db.close();}
});
