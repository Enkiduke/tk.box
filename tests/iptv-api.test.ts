import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { openDatabase } from '../apps/server/src/persistence/database.js';
import { Vault } from '../apps/server/src/security/vault.js';
import { PlexAdapter } from '../apps/server/src/providers/plex.js';
import { IdentityService } from '../apps/server/src/services/identity.js';
import { buildApp } from '../apps/server/src/app.js';
import { config, fakePlex } from './fixtures.js';
import Fastify from 'fastify';
import { gzipSync } from 'node:zlib';
import { IptvStore } from '../apps/server/src/persistence/iptv-store.js';
import { registerIptv } from '../apps/server/src/iptv-api.js';
import { SourceRefresh } from '../apps/server/src/services/source-refresh.js';
import { RestrictedSourceFetcher } from '../apps/server/src/providers/source-fetch.js';

test('EPG URL creation, immediate refresh and channel linking publish compressed XMLTV without exposing credentials',async()=>{
  const db=openDatabase(':memory:'),store=new IptvStore(db,new Vault(randomBytes(32))),app=Fastify();
  const xml='<tv><channel id="station"><display-name>Station</display-name></channel><programme channel="station" start="20261017120000 +0000" stop="20261017130000 +0000"><title>Remote programme</title></programme></tv>';
  let calls=0,fail=false;
  const fetcher=new RestrictedSourceFetcher(async()=>[{address:'8.8.8.8',family:4}],async(url,_address,headers)=>{
    calls++;assert.equal(url.href,'https://provider.invalid/guide.xml.gz?token=fixture-secret');assert.equal(headers.authorization,'Bearer fixture-secret');
    return {status:200,headers:{},body:gzipSync(fail?'<tv>invalid':xml),complete:true};
  });
  const access=async()=>({grant:{accountId:'owner'}});
  registerIptv(app,store,new SourceRefresh(store,fetcher),access,access);
  try {
    const created=await app.inject({method:'POST',url:'/api/v1/admin/iptv/sources',payload:{kind:'xmltv',name:'URL EPG',endpoint:{url:'https://provider.invalid/guide.xml.gz?token=fixture-secret',headers:{Authorization:'Bearer fixture-secret'}}}});
    assert.equal(created.statusCode,200);const feed=created.json();
    assert.equal(feed.remote,true);assert.equal(feed.intervalHours,6);assert.equal(feed.lastSuccess,null);assert.ok(!created.body.includes('fixture-secret'));
    const refreshUrl=`/api/v1/admin/iptv/sources/${feed.id}/refresh`;
    const imported=await app.inject({method:'POST',url:refreshUrl,payload:{}});
    assert.equal(imported.statusCode,200);assert.equal(imported.json().status,'published');assert.equal(calls,1);
    const success=imported.json().source;assert.ok(success.lastSuccess);assert.equal(success.nextDue-success.lastSuccess,6*3600000);
    const playlist=store.create('owner',{kind:'m3u',name:'Channels'});
    store.ingest('owner',playlist.id,0,Buffer.from('#EXTM3U\n#EXTINF:-1 tvg-id="station",Station\nhttps://streams.invalid/station'));
    const channel=store.adminChannels(playlist.id)[0]!;
    store.editChannel('owner',channel.id,{expectedRevision:1,listing:'always'});
    const linked=await app.inject({method:'POST',url:`/api/v1/admin/iptv/sources/${playlist.id}/feed`,payload:{expectedRevision:2,feedId:feed.id}});
    assert.equal(linked.statusCode,200);
    const start=Date.UTC(2026,9,17,12),guideUrl=`/api/v1/iptv/channels/${channel.id}/guide?start=${start}&end=${start+3600000}`;
    assert.equal((await app.inject({url:guideUrl})).json().rows[0].program.title,'Remote programme');
    fail=true;assert.notEqual((await app.inject({method:'POST',url:refreshUrl,payload:{}})).statusCode,200);
    const sources=await app.inject({url:'/api/v1/admin/iptv/sources'}),saved=sources.json().sources.find((s:{id:string})=>s.id===feed.id);
    assert.equal(saved.lastSuccess,success.lastSuccess);assert.equal(saved.lastError,'SOURCE_REFRESH_FAILED');assert.ok(!sources.body.includes('fixture-secret'));
    assert.equal((await app.inject({url:guideUrl})).json().rows[0].program.title,'Remote programme');
    assert.equal(store.list().filter(s=>s.kind==='xmltv').length,1);
  } finally {await app.close();db.close();}
});

test('IPTV HTTP boundaries enforce owner mutations, unlisted isolation, scoped guides and viewer-local favorites',async()=>{
  const db=openDatabase(':memory:'),vault=new Vault(randomBytes(32)),fixture=fakePlex({accountId:1}),plex=new PlexAdapter(config(),'test',fixture.transport),app=await buildApp(config(),db,vault,plex,false);
  const identity=new IdentityService(db,vault,plex),ownerLink=await identity.start(),owner=await identity.finish(ownerLink.binding);assert.ok(owner);
  fixture.options.accountId=2;const viewerLink=await identity.start(),viewer=await identity.finish(viewerLink.binding);assert.ok(viewer);
  const headers=(role:'owner'|'viewer')=>{fixture.options.accountId=role==='owner'?1:2;return {origin:'http://127.0.0.1:3000',cookie:`tk.box_local=${role==='owner'?owner.cookie:viewer.cookie}`};};
  try {
    assert.equal((await app.inject({url:'/api/v1/iptv/channels'})).statusCode,401);
    assert.equal((await app.inject({method:'POST',url:'/api/v1/admin/iptv/sources',headers:headers('viewer'),payload:{kind:'m3u',name:'blocked'}})).statusCode,403);
    assert.equal((await app.inject({method:'PUT',url:'/api/v1/admin/iptv/sources/00000000-0000-4000-8000-000000000000/listing',headers:headers('viewer'),payload:{expectedRevision:0,requireCheck:false,requireGuide:false,guideHours:2,alwaysOn:[]}})).statusCode,403);
    const created=await app.inject({method:'POST',url:'/api/v1/admin/iptv/sources',headers:headers('owner'),payload:{kind:'m3u',name:'Upload'}});assert.equal(created.statusCode,200);const source=created.json();
    const sourceGuideUrl=`/api/v1/admin/iptv/sources/${source.id}/guide`;
    const guidePayload={expectedRevision:0,endpoint:{url:'https://provider.invalid/guide.xml'},intervalHours:6};
    assert.equal((await app.inject({method:'PUT',url:sourceGuideUrl,headers:headers('viewer'),payload:guidePayload})).statusCode,403);
    assert.equal((await app.inject({method:'DELETE',url:sourceGuideUrl,headers:headers('viewer'),payload:{expectedRevision:0}})).statusCode,403);
    assert.equal((await app.inject({method:'PUT',url:sourceGuideUrl,headers:{...headers('owner'),origin:'https://attacker.invalid'},payload:guidePayload})).statusCode,403);
    assert.equal((await app.inject({method:'PUT',url:sourceGuideUrl,headers:headers('owner'),payload:{...guidePayload,expectedRevision:99}})).statusCode,409);
    assert.equal((await app.inject({method:'PUT',url:sourceGuideUrl,headers:headers('owner'),payload:{...guidePayload,intervalHours:0}})).statusCode,400);
    assert.equal(source.intervalHours,12);assert.equal(source.remote,false);
    const text='#EXTM3U\n#EXTINF:-1 tvg-id="station",Fixture station\nhttps://provider.invalid/live?credential=fixture-secret';
    const uploaded=await app.inject({method:'POST',url:`/api/v1/admin/iptv/sources/${source.id}/upload`,headers:headers('owner'),payload:{expectedRevision:0,text}});assert.equal(uploaded.statusCode,200);
    let list=await app.inject({url:'/api/v1/iptv/channels',headers:headers('viewer')});assert.equal(list.json().channels.length,0);
    assert.equal((await app.inject({url:`/api/v1/admin/iptv/sources/${source.id}/channels`,headers:headers('viewer')})).statusCode,403);
    const pending=await app.inject({url:`/api/v1/admin/iptv/sources/${source.id}/channels`,headers:headers('owner')});assert.ok(!pending.body.includes('fixture-secret'));const channel=pending.json().channels[0];
    assert.equal((await app.inject({method:'PUT',url:`/api/v1/iptv/channels/${channel.id}/favorite`,headers:headers('viewer'),payload:{favorite:true}})).statusCode,404);
    assert.equal((await app.inject({url:`/api/v1/iptv/channels/${channel.id}/guide?start=0&end=1000`,headers:headers('viewer')})).statusCode,404);
    const approved=await app.inject({method:'PATCH',url:`/api/v1/admin/iptv/channels/${channel.id}`,headers:headers('owner'),payload:{expectedRevision:1,listing:'always',number:101}});assert.equal(approved.statusCode,200);
    list=await app.inject({url:'/api/v1/iptv/channels',headers:headers('viewer')});assert.equal(list.json().channels[0].number,101);assert.ok(!list.body.includes('provider.invalid'));
    assert.equal((await app.inject({method:'PUT',url:`/api/v1/iptv/channels/${channel.id}/favorite`,headers:{...headers('viewer'),origin:'https://attacker.invalid'},payload:{favorite:true}})).statusCode,403);
    assert.equal((await app.inject({method:'PUT',url:`/api/v1/iptv/channels/${channel.id}/favorite`,headers:headers('viewer'),payload:{favorite:true}})).statusCode,200);
    assert.equal((await app.inject({url:'/api/v1/iptv/channels',headers:headers('viewer')})).json().favorites.length,1);
    assert.equal((await app.inject({url:'/api/v1/iptv/channels',headers:headers('owner')})).json().favorites.length,0);
    const noGuide=await app.inject({url:`/api/v1/iptv/channels/${channel.id}/guide?start=0&end=1000`,headers:headers('viewer')});assert.deepEqual(noGuide.json(),{rows:[{start:0,end:1000,program:null}]});
    const staticRefresh=await app.inject({method:'POST',url:`/api/v1/admin/iptv/sources/${source.id}/refresh`,headers:headers('owner'),payload:{}});assert.equal(staticRefresh.json().code,'STATIC_SOURCE');
    assert.equal((await app.inject({method:'PATCH',url:`/api/v1/admin/iptv/sources/${source.id}`,headers:headers('owner'),payload:{expectedRevision:2,intervalHours:0}})).statusCode,400);
    const guide=await app.inject({method:'POST',url:'/api/v1/admin/iptv/sources',headers:headers('owner'),payload:{kind:'xmltv',name:'Guide'}}),feed=guide.json();assert.equal(feed.intervalHours,6);
    const xml='<tv><channel id="station"><display-name>Station</display-name></channel><programme channel="station" start="20261017120000 +0000" stop="20261017130000 +0000"><title>Actual programme</title></programme></tv>';
    assert.equal((await app.inject({method:'POST',url:`/api/v1/admin/iptv/sources/${feed.id}/upload`,headers:headers('owner'),payload:{expectedRevision:0,text:xml}})).statusCode,200);
    assert.equal((await app.inject({method:'POST',url:`/api/v1/admin/iptv/sources/${source.id}/feed`,headers:headers('owner'),payload:{expectedRevision:2,feedId:feed.id}})).statusCode,200);
    const mapping=await app.inject({url:`/api/v1/admin/iptv/channels/${channel.id}/mapping?feedId=${feed.id}`,headers:headers('owner')});assert.equal(mapping.json().mapping.method,'exact_id');
    const start=Date.UTC(2026,9,17,12),end=start+7200000;
    const rows=await app.inject({url:`/api/v1/iptv/channels/${channel.id}/guide?start=${start}&end=${end}`,headers:headers('viewer')});assert.equal(rows.json().rows[0].program.title,'Actual programme');assert.equal(rows.json().rows[1].program,null);
    for(const filter of ['all','iptv','favorites']) {const guide=await app.inject({url:`/api/v1/guide?start=${start}&end=${end}&filter=${filter}`,headers:headers('viewer')});assert.equal(guide.statusCode,200);assert.equal(guide.json().channels.length,1);assert.equal(guide.json().channels[0].programs[1].program,null);assert.ok(!guide.body.includes('provider.invalid'));}
    for(const query of ['q=STATION','q=101',`channel=${channel.id}`])assert.equal((await app.inject({url:`/api/v1/guide?start=${start}&end=${end}&${query}`,headers:headers('viewer')})).json().channels.length,1);
    assert.equal((await app.inject({url:`/api/v1/guide?start=${start}&end=${end}&q=no-match`,headers:headers('viewer')})).json().total,0);
    assert.equal((await app.inject({url:`/api/v1/guide?start=${start}&end=${end}&channel=invalid`,headers:headers('viewer')})).statusCode,400);
    for(const [role,filter] of [['owner','favorites'],['viewer','custom']] as const)assert.equal((await app.inject({url:`/api/v1/guide?start=${start}&end=${end}&filter=${filter}`,headers:headers(role)})).json().channels.length,0);
    assert.equal((await app.inject({url:`/api/v1/guide?start=${start}&end=${end}&filter=pending`,headers:headers('viewer')})).statusCode,400);
    const reviewSource=(await app.inject({method:'POST',url:'/api/v1/admin/iptv/sources',headers:headers('owner'),payload:{kind:'m3u',name:'Listing rules'}})).json();
    await app.inject({method:'POST',url:`/api/v1/admin/iptv/sources/${reviewSource.id}/upload`,headers:headers('owner'),payload:{expectedRevision:0,text:'#EXTM3U\n#EXTINF:-1 tvg-id="one",One\nhttps://fixture.invalid/one\n#EXTINF:-1 tvg-id="two",Two\nhttps://fixture.invalid/two'}});
    const reviewIds=(await app.inject({url:`/api/v1/admin/iptv/sources/${reviewSource.id}/channels`,headers:headers('owner')})).json().channels.map((c:{id:string})=>c.id);
    // Unchecked channels wait for a first passing check until the source stops asking for one.
    assert.equal((await app.inject({url:'/api/v1/iptv/channels',headers:headers('viewer')})).json().channels.length,1);
    const rules=await app.inject({method:'PUT',url:`/api/v1/admin/iptv/sources/${reviewSource.id}/listing`,headers:headers('owner'),payload:{expectedRevision:1,requireCheck:false,requireGuide:false,guideHours:2,alwaysOn:['24/7']}});
    assert.equal(rules.statusCode,200);assert.deepEqual(rules.json().summary,{listed:2});assert.equal(rules.json().groups.length,1);
    assert.equal((await app.inject({url:'/api/v1/iptv/channels',headers:headers('viewer')})).json().channels.length,3);
    const bulkUrl=`/api/v1/admin/iptv/sources/${reviewSource.id}/channels/listing`;
    assert.equal((await app.inject({method:'POST',url:bulkUrl,headers:headers('owner'),payload:{expectedRevision:2,ids:[],listing:'hidden'}})).statusCode,400);
    assert.equal((await app.inject({method:'POST',url:bulkUrl,headers:headers('owner'),payload:{expectedRevision:1,ids:reviewIds.slice(0,1),listing:'hidden'}})).statusCode,409);
    assert.equal((await app.inject({method:'POST',url:bulkUrl,headers:headers('owner'),payload:{expectedRevision:2,ids:reviewIds.slice(0,1),listing:'hidden'}})).statusCode,200);
    assert.equal((await app.inject({url:'/api/v1/iptv/channels',headers:headers('viewer')})).json().channels.length,2);
    fixture.options.authorized=false;assert.equal((await app.inject({url:'/api/v1/iptv/channels',headers:headers('viewer')})).statusCode,403);
    assert.ok(!fixture.calls.some(c=>c.path==='/:/timeline'));
  }finally{await app.close();db.close();}
});
