import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { gzipSync } from 'node:zlib';
import { openDatabase } from '../apps/server/src/persistence/database.js';
import { IptvStore } from '../apps/server/src/persistence/iptv-store.js';
import { Vault } from '../apps/server/src/security/vault.js';
import { RestrictedSourceFetcher, exchangeSource, publicAddress, validateEndpoint, SourceFetchError, type SourceEndpoint } from '../apps/server/src/providers/source-fetch.js';
import { SourceRefresh } from '../apps/server/src/services/source-refresh.js';

const endpoint={url:'https://provider.invalid/list?credential=fixture-secret',headers:{authorization:'Bearer fixture-secret'},allowInsecureHttp:false};
const playlist=(ids:string[],suffix='')=>Buffer.from('#EXTM3U\n'+ids.map(id=>`#EXTINF:-1 tvg-id="${id}",Station ${id}${suffix}\nhttps://streams.invalid/${id}?key=fixture-secret`).join('\n'));
function fixture() {const db=openDatabase(':memory:'),vault=new Vault(randomBytes(32)),store=new IptvStore(db,vault);return {db,vault,store};}
// No channel checks run here, so list channels without waiting for a first passing check.
function openListing(store:IptvStore,source:string) {store.setListingPolicy('owner',source,{...store.listingPolicy(source),requireCheck:false,expectedRevision:store.status(source).revision});}
const revision=(store:IptvStore,id:string)=>store.status(id).revision;

test('bulk listing overrides are atomic, source-scoped and revision checked',()=>{
  const {db,store}=fixture();
  try {
    const source=store.create('owner',{kind:'m3u',name:'Listing'}),other=store.create('owner',{kind:'m3u',name:'Other'});
    store.ingest('owner',source.id,0,playlist(['a','b','c']));store.ingest('owner',other.id,0,playlist(['foreign']));
    // Nothing has played yet, so nothing is listed; every present channel already holds a number.
    assert.equal(store.visible().length,0);assert.ok(store.adminChannels(source.id).every(c=>c.number!==null&&c.state==='unverified'));
    openListing(store,source.id);assert.equal(store.visible().length,3);
    const ids=store.adminChannels(source.id).map(c=>c.id),foreign=store.adminChannels(other.id)[0]!.id,before=revision(store,source.id);
    assert.throws(()=>store.setListing('owner',source.id,{expectedRevision:before,ids:[ids[0]!,foreign],listing:'hidden'}),{code:'SELECTION_CHANGED'});
    assert.throws(()=>store.setListing('owner',source.id,{expectedRevision:before,ids:[ids[0]!,ids[0]!],listing:'hidden'}),{code:'INVALID_SELECTION'});
    assert.throws(()=>store.setListing('owner',source.id,{expectedRevision:before-1,ids:[ids[0]!],listing:'hidden'}),{code:'REVISION_CONFLICT'});
    assert.equal(store.visible().length,3);assert.equal(revision(store,source.id),before);
    store.setListing('owner',source.id,{expectedRevision:before,ids:ids.slice(0,2),listing:'hidden'});
    assert.deepEqual(store.visible().map(c=>c.id),[ids[2]]);assert.deepEqual(store.adminChannels(source.id).map(c=>c.state),['hidden','hidden','listed']);
    assert.deepEqual(store.listingSummary(source.id),{hidden:2,listed:1});
  }finally{db.close();}
});

test('guide search and channel deep links filter before pagination without exposing hidden or missing stations',()=>{
  const {db,store}=fixture();
  try {
    const source=store.create('owner',{kind:'m3u',name:'Lineup'});
    store.ingest('owner',source.id,0,playlist(['a','b','c']));openListing(store,source.id);
    const b=store.adminChannels(source.id).find(c=>c.tvgId==='b')!;
    const result=store.guidePage('viewer','all',0,1000,0,1,'STATION B');
    assert.equal(result.total,1);assert.equal(result.channels[0]!.id,b.id);assert.equal(result.hasMore,false);
    assert.equal(store.guidePage('viewer','all',0,1000,0,1,String(b.number)).channels[0]!.id,b.id);
    assert.equal(store.guidePage('viewer','all',0,1000,0,1,'',b.id).channels[0]!.id,b.id);
    store.ingest('owner',source.id,revision(store,source.id),playlist(['a','c','d']));
    const hidden=store.adminChannels(source.id).find(c=>c.tvgId==='d')!;
    store.editChannel('owner',hidden.id,{expectedRevision:revision(store,source.id),listing:'hidden'});
    for(const id of [b.id,hidden.id])assert.equal(store.guidePage('viewer','all',0,1000,0,30,'',id).total,0);
    assert.equal(store.guidePage('viewer','all',0,1000,0,30,'Station b').total,0);
  }finally{db.close();}
});

test('restricted metadata fetching pins DNS, follows only the approved origin and decodes bounded gzip',async()=>{
  const requested:{url:URL;address:string;authorization:string|undefined}[]=[];
  let lookups=0;
  const fetcher=new RestrictedSourceFetcher(async()=>{lookups++;return [{address:'8.8.8.8',family:4}];},async(url,address,headers)=>{
    requested.push({url,address:address.address,authorization:headers.authorization});
    return url.pathname==='/list'?{status:302,headers:{location:'/actual'},body:Buffer.alloc(0),complete:true}:{status:200,headers:{'content-encoding':'gzip'},body:gzipSync(playlist(['a'])),complete:true};
  });
  assert.deepEqual(await fetcher.fetch(endpoint),playlist(['a']));assert.equal(lookups,2);assert.equal(requested.length,2);assert.equal(requested[1]!.address,'8.8.8.8');assert.equal(requested[1]!.authorization,'Bearer fixture-secret');
  for(const location of ['https://other.invalid/export','http://provider.invalid/export','http://127.0.0.1/private']) {
    let calls=0;const f=new RestrictedSourceFetcher(async()=>[{address:'8.8.8.8',family:4}],async()=>{calls++;return {status:302,headers:{location},body:Buffer.alloc(0),complete:true};});
    await assert.rejects(f.fetch(endpoint),{code:'SOURCE_REDIRECT_REJECTED'});assert.equal(calls,1);
  }
});
test('SSRF address families, mixed DNS results, source headers and malformed transport responses fail closed',async()=>{
  for(const ip of ['127.0.0.1','0.0.0.0','10.2.3.4','172.16.1.2','192.168.0.1','169.254.169.254','100.64.1.2','224.0.0.1','198.18.0.1','::1','::ffff:8.8.8.8','64:ff9b::808:808','fe80::1','fc00::1','2001:db8::1','2002:808:808::1','3fff::1'])assert.equal(publicAddress(ip),false,ip);
  assert.equal(publicAddress('8.8.8.8'),true);assert.equal(publicAddress('2606:4700:4700::1111'),true);
  let exchanges=0;const f=new RestrictedSourceFetcher(async()=>[{address:'8.8.8.8',family:4},{address:'127.0.0.1',family:4}],async()=>{exchanges++;throw Error('must not connect');});
  await assert.rejects(f.fetch(endpoint),{code:'SOURCE_ADDRESS_REJECTED'});assert.equal(exchanges,0);
  const invalid:Partial<SourceEndpoint>[]=[{url:'file:///etc/passwd'},{url:'https://user:pass@provider.invalid/'},{url:'http://provider.invalid/'},{headers:{Host:'internal'}},{headers:{authorization:'bad\r\nheader'}}];
  for(const overrides of invalid)assert.throws(()=>validateEndpoint({...endpoint,...overrides}));
  for(const response of [
    {status:206,headers:{},body:playlist(['a']),complete:true},
    {status:200,headers:{},body:playlist(['a']),complete:false},
    {status:200,headers:{'content-length':'9999999'},body:playlist(['a']),complete:true},
    {status:200,headers:{},body:Buffer.from([0xff]),complete:true},
    {status:200,headers:{'content-encoding':'br'},body:playlist(['a']),complete:true},
    {status:200,headers:{'content-encoding':'gzip'},body:gzipSync(Buffer.alloc(16*1024*1024+1)),complete:true}
  ])await assert.rejects(new RestrictedSourceFetcher(async()=>[{address:'8.8.8.8',family:4}],async()=>response).fetch(endpoint));
});
test('native HTTP exchange preserves Host, pins the socket and detects truncated bodies',async()=>{
  let host='';const server=createServer((req,res)=>{host=req.headers.host??'';if(req.url==='/truncated'){res.writeHead(200,{'content-length':100});res.write('short');res.destroy();}else res.end(playlist(['a']));});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    const port=(server.address() as {port:number}).port,url=new URL(`http://provider.invalid:${port}/list`),signal=AbortSignal.timeout(3000);
    const response=await exchangeSource(url,{address:'127.0.0.1',family:4},{},signal);assert.equal(response.complete,true);assert.equal(host,`provider.invalid:${port}`);assert.deepEqual(response.body,playlist(['a']));
    await assert.rejects(exchangeSource(new URL('/truncated',url),{address:'127.0.0.1',family:4},{},signal));
  } finally {await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));}
});
test('durable listing reserves numbers while missing and restores favorites and overrides',()=>{
  const {db,store}=fixture();try {
    const s=store.create('owner',{kind:'m3u',name:'Fixture upload'},0);assert.equal(s.nextDue,null);
    store.ingest('owner',s.id,0,playlist(['a','b','c']),1);assert.equal(store.visible().length,0);openListing(store,s.id);
    const a=store.adminChannels(s.id).find(c=>c.tvgId==='a'),b=store.adminChannels(s.id).find(c=>c.tvgId==='b');assert.ok(a&&b);const before=store.visible();
    db.prepare('INSERT INTO users VALUES(?,1)').run('viewer');store.favorite('viewer',a.id,true);
    store.editChannel('owner',b.id,{expectedRevision:revision(store,s.id),listing:'hidden',displayName:'My station'});
    store.ingest('owner',s.id,revision(store,s.id),playlist(['b','c']),2);assert.equal(store.visible().some(c=>c.id===a.id),false);assert.equal(store.favorites('viewer').length,0);
    assert.equal(store.adminChannels(s.id).find(c=>c.id===a.id)!.number,a.number);assert.equal(store.adminChannels(s.id).find(c=>c.id===a.id)!.state,'missing');
    store.policy('owner',s.id,{expectedRevision:revision(store,s.id),intervalHours:24},3);
    store.ingest('owner',s.id,revision(store,s.id),playlist(['a','b','c','d']),4);
    const after=store.visible();assert.equal(after.find(c=>c.id===a.id)!.number,before.find(c=>c.id===a.id)!.number);assert.equal(store.favorites('viewer')[0]!.id,a.id);
    assert.equal(after.some(c=>c.id===b.id),false);assert.equal(store.adminChannels(s.id).find(c=>c.id===b.id)!.name,'My station');assert.equal(new Set(store.adminChannels(s.id).map(c=>c.number)).size,4);
    assert.throws(()=>store.favorite('viewer','nonexistent',true),{code:'CHANNEL_NOT_FOUND'});
  }finally{db.close();}
});
test('new channels list themselves, hidden channels stay hidden and numbering conflicts roll back atomically',()=>{
  const {db,store}=fixture();try {
    const s=store.create('owner',{kind:'m3u',name:'Fixture'});store.ingest('owner',s.id,0,playlist(['a','b']));openListing(store,s.id);const a=store.adminChannels(s.id).find(c=>c.tvgId==='a'),b=store.adminChannels(s.id).find(c=>c.tvgId==='b');assert.ok(a&&b);
    store.editChannel('owner',a.id,{expectedRevision:revision(store,s.id),listing:'hidden'});
    store.ingest('owner',s.id,revision(store,s.id),playlist(['a','b','c']));
    assert.equal(store.adminChannels(s.id).find(c=>c.id===a.id)!.listing,'hidden');assert.deepEqual(store.visible().map(c=>c.name),['Station b','Station c']);
    const c=store.adminChannels(s.id).find(x=>x.tvgId==='c')!,oldRevision=revision(store,s.id);
    assert.throws(()=>store.editChannel('owner',b.id,{expectedRevision:oldRevision,listing:'always',number:c.number!}),{code:'NUMBER_CONFLICT'});
    assert.equal(revision(store,s.id),oldRevision);assert.equal(store.adminChannels(s.id).find(x=>x.id===b.id)!.listing,'auto');
  }finally{db.close();}
});
test('complete missing snapshots hide immediately; suspicious drops require review of an exact immutable candidate',()=>{
  const {db,store}=fixture();try {
    const s=store.create('owner',{kind:'m3u',name:'Fixture'});store.ingest('owner',s.id,0,playlist(['a','b','c','d']));openListing(store,s.id);
    assert.throws(()=>store.ingest('owner',s.id,revision(store,s.id),Buffer.from('#EXTM3U\n#EXTINF:-1,bad')));assert.equal(store.visible().length,4);
    const held=store.ingest('owner',s.id,revision(store,s.id),playlist(['a']));assert.equal(held.status,'review_required');assert.equal(store.visible().length,4);
    const candidate=store.candidateReview(s.id);assert.equal(candidate.missing.length,3);assert.ok(!JSON.stringify(candidate).includes('fixture-secret'));
    assert.throws(()=>store.acceptCandidate('owner',s.id,candidate.revision,'0'.repeat(64)),{code:'CANDIDATE_CHANGED'});
    store.acceptCandidate('owner',s.id,candidate.revision,candidate.digest!);assert.equal(store.visible().length,1);
    store.ingest('owner',s.id,revision(store,s.id),playlist(['a','b','c','d']));assert.equal(store.visible().length,4);
    const count=db.prepare('SELECT COUNT(*) AS n FROM iptv_channels').get() as {n:number};assert.equal(count.n,4);
  }finally{db.close();}
});
test('renames with stable stream identity survive, recycled IDs need review and exact repeats deduplicate',()=>{
  const {db,store}=fixture();try {
    const s=store.create('owner',{kind:'m3u',name:'Fixture'});store.ingest('owner',s.id,0,playlist(['a']));openListing(store,s.id);const id=store.visible()[0]!.id;
    store.ingest('owner',s.id,revision(store,s.id),playlist(['a'],' renamed'));assert.equal(store.visible()[0]!.id,id);
    const recycled=Buffer.from(playlist(['a'],' recycled').toString().replace('streams.invalid/a','other.invalid/new'));
    store.ingest('owner',s.id,revision(store,s.id),recycled);assert.equal(store.visible().length,0);assert.equal(store.adminChannels(s.id)[0]!.state,'conflict');
    store.editChannel('owner',id,{expectedRevision:revision(store,s.id),acceptIdentity:true});assert.equal(store.visible()[0]!.id,id);
    store.ingest('owner',s.id,revision(store,s.id),playlist(['a','a']));assert.equal(store.visible().length,0);
    store.editChannel('owner',id,{expectedRevision:revision(store,s.id),acceptIdentity:true});assert.equal(store.visible().length,1);assert.equal(store.visible()[0]!.id,id);
  }finally{db.close();}
});
test('manual guide mappings persist through refresh failures, never cross source bindings or yield invented coverage',()=>{
  const {db,store}=fixture();try {
    const s=store.create('owner',{kind:'m3u',name:'Playlist'}),feed=store.create('owner',{kind:'xmltv',name:'Guide',endpoint});
    store.ingest('owner',s.id,0,playlist(['station.hd']));openListing(store,s.id);const channel=store.visible()[0]!.id;
    const xml=Buffer.from('<tv><channel id="station.guide"><display-name>Station station.hd</display-name></channel><programme channel="station.guide" start="20261017120000 +0000" stop="20261017130000 +0000"><title>Real programme</title></programme></tv>');
    store.ingest('owner',feed.id,0,xml);assert.throws(()=>store.mappingReview(channel,feed.id),{code:'MAPPING_SCOPE'});store.bindFeed('owner',s.id,feed.id,revision(store,s.id));
    assert.equal(store.mappingReview(channel,feed.id).mapping,undefined);assert.equal(store.mappingReview(channel,feed.id).candidates.suggestions.length,1);
    const start=Date.UTC(2026,9,17,12),end=start+7200000;assert.equal(store.guide(channel,feed.id,start,end)[0]!.program,null);
    store.map('owner',channel,feed.id,'station.guide',0);store.failed(feed.id,revision(store,feed.id),undefined,end);
    const rows=store.guide(channel,feed.id,start,end);assert.equal(rows[0]!.program!.title,'Real programme');assert.equal(rows[1]!.program,null);
    store.ingest('owner',s.id,revision(store,s.id),playlist(['station.hd']));assert.equal(store.mappingReview(channel,feed.id).mapping!.method,'admin');
    assert.throws(()=>store.map('owner',channel,feed.id,'station.guide',0),{code:'REVISION_CONFLICT'});
  }finally{db.close();}
});
test('single-flight refreshes retain last-good imports, respect 429 backoff and do not overwrite edited intervals',async()=>{
  const {db,store}=fixture();const source=store.create('owner',{kind:'m3u',name:'Remote',endpoint});let calls=0,finish:(v:Buffer)=>void=()=>{};
  const fetcher={fetch:async()=>{calls++;return new Promise<Buffer>(resolve=>{finish=resolve;});}};
  const refresh=new SourceRefresh(store,fetcher);
  try {
    const first=refresh.refresh('owner',source.id),second=refresh.refresh('system',source.id);assert.equal(first,second);await Promise.resolve();assert.equal(calls,1);finish(playlist(['a']));await first;
    const next=refresh.refresh('owner',source.id);await Promise.resolve();store.policy('owner',source.id,{expectedRevision:revision(store,source.id),intervalHours:24});const due=store.status(source.id).nextDue;finish(playlist(['b']));await assert.rejects(next,{code:'REVISION_CONFLICT'});assert.equal(store.adminChannels(source.id)[0]!.tvgId,'a');assert.equal(store.status(source.id).nextDue,due);
    store.failed(source.id,revision(store,source.id),Date.now()+3600000);assert.throws(()=>refresh.refresh('owner',source.id),{code:'SOURCE_BACKOFF'});assert.equal(calls,2);
    const staticSource=store.create('owner',{kind:'xmltv',name:'Static'});assert.throws(()=>refresh.refresh('owner',staticSource.id),{code:'STATIC_SOURCE'});assert.equal(store.status(staticSource.id).nextDue,null);
  }finally{await refresh.close();db.close();}
});
test('scheduled refresh resumes persisted due work; failures preserve cache and shutdown cancels active work',async()=>{
  const {db,store}=fixture(),s=store.create('owner',{kind:'m3u',name:'Due source',endpoint},0);let calls=0;
  const worker=new SourceRefresh(store,{fetch:async()=>{calls++;return playlist(['a']);}});
  try {
    await worker.tick();await worker.refresh('owner',s.id);assert.equal(calls,1);assert.equal(store.status(s.id).revision,1);const good=store.status(s.id).lastSuccess;
    await worker.close();
    const failure=new SourceRefresh(store,{fetch:async()=>{throw new SourceFetchError('SOURCE_RATE_LIMITED',Date.now()+7200000);}});
    await assert.rejects(failure.refresh('owner',s.id),{code:'SOURCE_RATE_LIMITED'});assert.equal(store.status(s.id).lastSuccess,good);assert.equal(store.adminChannels(s.id).length,1);assert.equal(store.status(s.id).lastError,'SOURCE_RATE_LIMITED');await failure.close();
    const other=store.create('owner',{kind:'m3u',name:'Cancellation',endpoint});
    const cancellable=new SourceRefresh(store,{fetch:async(_endpoint,signal)=>new Promise((_resolve,reject)=>{signal!.addEventListener('abort',()=>reject(new SourceFetchError('SOURCE_TIMEOUT')),{once:true});})});
    const work=cancellable.refresh('owner',other.id),outcome=assert.rejects(work);await Promise.resolve();await cancellable.close();await outcome;assert.equal(cancellable.active(other.id),false);assert.throws(()=>cancellable.refresh('owner',other.id),{code:'REFRESH_STOPPED'});
  }finally{await worker.close();db.close();}
});
test('DNS is revalidated after redirects and provider Retry-After delays are sanitized and bounded',async()=>{
  let resolutions=0,calls=0;const rebinding=new RestrictedSourceFetcher(async()=>[{address:++resolutions===1?'8.8.8.8':'127.0.0.1',family:4}],async()=>{calls++;return {status:302,headers:{location:'/redirect'},complete:true,body:Buffer.alloc(0)};});
  await assert.rejects(rebinding.fetch(endpoint),{code:'SOURCE_ADDRESS_REJECTED'});assert.equal(calls,1);
  const limited=new RestrictedSourceFetcher(async()=>[{address:'8.8.8.8',family:4}],async()=>({status:429,headers:{'retry-after':'9999999999999999999'},complete:true,body:Buffer.alloc(0)}));
  await assert.rejects(limited.fetch(endpoint),(error:unknown)=>error instanceof SourceFetchError&&error.code==='SOURCE_RATE_LIMITED'&&error.retryAt!>Date.now()&&error.retryAt!<=Date.now()+7*86400000);
});
test('encrypted source/channel state and mapping intent survive database reopen without credentials in diagnostics or audit',()=>{
  const folder=mkdtempSync(join(resolve('.local'),'iptv-state-')),file=join(folder,'state.sqlite'),vault=new Vault(randomBytes(32));let db=openDatabase(file);
  try {
    let store=new IptvStore(db,vault);const s=store.create('owner',{kind:'m3u',name:'Remote',endpoint},0);store.ingest('owner',s.id,0,playlist(['a']),1);openListing(store,s.id);const id=store.visible()[0]!.id;
    const feed=store.create('owner',{kind:'xmltv',name:'Retained guide'});
    store.ingest('owner',feed.id,0,Buffer.from('<tv><channel id="guide"><display-name>Station a</display-name></channel><programme channel="guide" start="20261017120000 +0000" stop="20261017130000 +0000"><title>Retained programme</title></programme></tv>'));
    store.bindFeed('owner',s.id,feed.id,revision(store,s.id));store.map('owner',id,feed.id,'guide',0);
    const raw=JSON.stringify({sources:db.prepare('SELECT * FROM iptv_sources').all(),channels:db.prepare('SELECT * FROM iptv_channels').all(),audit:db.prepare('SELECT * FROM audit').all()});assert.ok(!raw.includes('fixture-secret'));assert.ok(!JSON.stringify(store.list()).includes('provider.invalid'));assert.ok(!JSON.stringify(store.adminChannels(s.id)).includes('streams.invalid'));
    db.close();db=openDatabase(file);store=new IptvStore(db,vault);assert.equal(store.visible()[0]!.id,id);assert.deepEqual(store.endpoint(s.id),endpoint);assert.equal(store.status(s.id).intervalHours,12);assert.equal(store.mappingReview(id,feed.id).mapping!.method,'admin');assert.equal(store.mappingReview(id,feed.id).reviewRevision,1);
  }finally{db.close();rmSync(folder,{recursive:true,force:true});}
});
