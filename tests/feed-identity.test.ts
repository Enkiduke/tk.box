import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { openDatabase } from '../apps/server/src/persistence/database.js';
import { IptvStore } from '../apps/server/src/persistence/iptv-store.js';
import { Vault } from '../apps/server/src/security/vault.js';
import { parseM3u } from '../apps/server/src/providers/iptv.js';

const entry=(name:string,path:string,id='cnn.us',group='News')=>`#EXTINF:-1 tvg-id="${id}" group-title="${group}",${name}\nhttps://streams.invalid/${path}?token=fixture-secret`;
const playlist=(...entries:string[])=>Buffer.from('#EXTM3U\n'+entries.join('\n'));
function fixture() {
  const db=openDatabase(':memory:'),vault=new Vault(randomBytes(32)),store=new IptvStore(db,vault),s=store.create('owner',{kind:'m3u',name:'Feeds'});
  db.prepare('INSERT INTO users VALUES(?,1)').run('viewer');
  const ingest=(...entries:string[])=>store.ingest('owner',s.id,store.status(s.id).revision,playlist(...entries));
  const list=()=>store.setListingPolicy('owner',s.id,{...store.listingPolicy(s.id),requireCheck:false,expectedRevision:store.status(s.id).revision});
  const rows=()=>store.adminChannels(s.id),revision=()=>store.status(s.id).revision;
  return {db,vault,store,s,ingest,list,rows,revision};
}

test('shared guide IDs import distinct feeds, collapse exact repeats and share station guide data',()=>{
  const {db,store,s,ingest,list,rows,revision}=fixture();
  try {
    const feeds=['US: CNN FHD','US: CNN HD','US: CNN SD','US: CNN HD (Backup)'].map((n,i)=>entry(n,`${i}`));
    ingest(...feeds,feeds[0]!);list();
    assert.equal(rows().length,4);assert.ok(rows().every(c=>!c.conflict));
    const station=store.stacks()[0]!;assert.equal(store.stacks().length,1);assert.equal(station.feeds.length,4);
    for(const f of station.feeds)assert.equal(store.tune(f.id).id,f.id);
    const guide=store.create('owner',{kind:'xmltv',name:'Guide'}),start=Date.UTC(2026,9,17,12);
    store.ingest('owner',guide.id,0,Buffer.from('<tv><channel id="cnn.us"><display-name>CNN</display-name></channel><programme channel="cnn.us" start="20261017120000 +0000" stop="20261017130000 +0000"><title>News</title></programme></tv>'));
    store.bindFeed('owner',s.id,guide.id,revision());
    for(const c of rows())assert.equal(store.guide(c.id,guide.id,start,start+3600000)[0]!.program?.title,'News');
    assert.equal(store.guidePage('viewer','all',start,start+3600000,0,30).channels[0]!.feeds.length,4);
  } finally {db.close();}
});

test('reordering, URL rotation, feed removal and return preserve UUIDs and saved settings',()=>{
  const {db,store,s,ingest,list,rows,revision}=fixture();
  try {
    const hd=entry('US: CNN HD','hd'),sd=entry('US: CNN SD','sd');ingest(hd,sd);list();
    const before=rows(),primary=before[0]!,backup=before[1]!;
    store.favorite('viewer',primary.id,true);
    store.editChannel('owner',backup.id,{expectedRevision:revision(),listing:'hidden',displayName:'My backup',stack:'Special station',number:777,position:40});
    assert.equal(ingest(entry('US: CNN SD','sd-new'),entry('US: CNN HD','hd-new')).status,'published');
    assert.deepEqual(rows().map(c=>c.id),before.map(c=>c.id));
    const saved=rows().find(c=>c.id===backup.id)!;
    assert.equal(saved.listing,'hidden');assert.equal(saved.name,'My backup');assert.equal(saved.number,777);assert.equal(saved.position,40);assert.equal(saved.stack,'Special station');
    assert.equal(store.favorites('viewer')[0]!.id,primary.id);
    ingest(entry('US: CNN SD','sd-again'));assert.equal(rows().find(c=>c.id===primary.id)!.state,'missing');
    ingest(entry('US: CNN HD','hd-return'),entry('US: CNN SD','sd-again'));
    assert.equal(store.favorites('viewer')[0]!.id,primary.id);assert.equal(rows().find(c=>c.id===primary.id)!.number,primary.number);
    assert.equal(rows().length,2);
  } finally {db.close();}
});

test('startup upgrades a collapsed legacy ID from its cached playlist and retains curation and refresh times',()=>{
  const {db,vault,store,s,ingest,list,rows,revision}=fixture();
  try {
    const first=entry('US: CNN HD','hd'),second=entry('US: CNN SD','sd');ingest(first);list();
    const old=rows()[0]!;store.favorite('viewer',old.id,true);
    store.editChannel('owner',old.id,{expectedRevision:revision(),displayName:'Saved CNN',number:101,stack:'US: CNN'});
    db.prepare("UPDATE iptv_channels SET identity='id:cnn.us',conflict=1 WHERE id=?").run(old.id);
    db.prepare('UPDATE iptv_sources SET encrypted_snapshot=? WHERE id=?').run(vault.seal(JSON.stringify(parseM3u(playlist(first,second).toString())),`iptv:snapshot:${s.id}`),s.id);
    const status=store.status(s.id);store.relistAll();
    assert.equal(rows().length,2);assert.ok(rows().every(c=>!c.conflict));
    assert.equal(rows()[0]!.id,old.id);assert.equal(rows()[0]!.name,'Saved CNN');assert.equal(rows()[0]!.number,101);
    assert.equal(store.favorites('viewer')[0]!.id,old.id);assert.equal(store.stacks()[0]!.feeds.length,2);
    assert.equal(store.status(s.id).lastSuccess,status.lastSuccess);assert.equal(store.status(s.id).nextDue,status.nextDue);
    const upgraded=revision();store.relistAll();assert.equal(revision(),upgraded,'migration runs once');
  } finally {db.close();}
});

test('ambiguous rotating feeds stay in review until an explicit revision-checked choice',()=>{
  const {db,store,s,ingest,list,rows,revision}=fixture();
  try {
    ingest(entry('US: CNN HD','a'),entry('US: CNN HD','b'));list();const before=rows();
    store.favorite('viewer',before[0]!.id,true);
    ingest(entry('US: CNN HD','c'),entry('US: CNN HD','d'));
    assert.equal(rows().length,2);assert.ok(rows().every(c=>c.conflict));assert.equal(store.visible().length,0);
    ingest(entry('US: CNN HD','d'),entry('US: CNN HD','c'));assert.ok(rows().every(c=>c.conflict),'refresh does not bypass review');
    const review=store.identityReview(before[0]!.id);assert.equal(review.reason,'ambiguous');assert.equal(review.candidates.length,2);
    assert.ok(!JSON.stringify(review).includes('fixture-secret'));assert.ok(!JSON.stringify(review).includes('streams.invalid'));
    assert.throws(()=>store.resolveIdentity('owner',before[0]!.id,{expectedRevision:review.revision-1,action:'match',candidate:review.candidates[0]!.key}),{code:'REVISION_CONFLICT'});
    assert.throws(()=>store.resolveIdentity('owner',before[0]!.id,{expectedRevision:review.revision,action:'match',candidate:'0'.repeat(64)}),{code:'IDENTITY_UNRESOLVED'});
    assert.equal(revision(),review.revision);
    store.resolveIdentity('owner',before[0]!.id,{expectedRevision:review.revision,action:'match',candidate:review.candidates[0]!.key,separate:true});
    assert.equal(store.favorites('viewer')[0]!.id,before[0]!.id);assert.equal(rows().find(c=>c.id===before[0]!.id)!.stack,'');
    const other=store.identityReview(before[1]!.id);assert.equal(other.candidates.length,1);
    store.resolveIdentity('owner',before[1]!.id,{expectedRevision:other.revision,action:'match',candidate:other.candidates[0]!.key});
    assert.ok(rows().every(c=>!c.conflict));assert.equal(store.stacks().length,2);
    assert.notEqual(store.tune(before[0]!.id).streamUrl,store.tune(before[1]!.id).streamUrl);
    ingest(entry('US: CNN HD','d'),entry('US: CNN HD','c'));assert.deepEqual(rows().map(c=>c.id),before.map(c=>c.id));
  } finally {db.close();}
});

test('a failed legacy upgrade rolls back identities, alternate feeds and the source revision together',()=>{
  const {db,vault,store,s,ingest,rows,revision}=fixture();
  try {
    const first=entry('US: CNN HD','hd');ingest(first);const old=rows()[0]!;
    db.prepare("UPDATE iptv_channels SET identity='id:cnn.us',conflict=1 WHERE id=?").run(old.id);
    db.prepare('UPDATE iptv_sources SET encrypted_snapshot=? WHERE id=?').run(vault.seal(JSON.stringify(parseM3u(playlist(first,entry('US: CNN SD','sd')).toString())),`iptv:snapshot:${s.id}`),s.id);
    const before=revision();db.exec("CREATE TRIGGER reject_alternate BEFORE INSERT ON iptv_channels BEGIN SELECT RAISE(ABORT,'fixture rollback'); END");
    assert.throws(()=>store.relistAll(),/fixture rollback/);
    assert.equal(rows().length,1);assert.equal(rows()[0]!.conflict,true);assert.equal(revision(),before);
    assert.equal((db.prepare('SELECT identity FROM iptv_channels WHERE id=?').get(old.id) as {identity:string}).identity,'id:cnn.us');
    db.exec('DROP TRIGGER reject_alternate');store.relistAll();assert.equal(rows().length,2);assert.ok(rows().every(c=>!c.conflict));
  } finally {db.close();}
});

test('importing uncertain entries as new feeds retains the saved feed as missing across refreshes',()=>{
  const {db,store,ingest,list,rows,revision}=fixture();
  try {
    ingest(entry('US: CNN HD','old'));list();const old=rows()[0]!;store.favorite('viewer',old.id,true);
    const changed=entry('US: Different station','new');ingest(changed);assert.equal(rows()[0]!.state,'conflict');
    store.resolveIdentity('owner',old.id,{expectedRevision:revision(),action:'new'});
    assert.equal(rows().length,2);assert.equal(rows().find(c=>c.id===old.id)!.state,'missing');assert.equal(rows().find(c=>c.id===old.id)!.number,old.number);
    assert.equal(store.favorites('viewer').length,0);const fresh=store.visible()[0]!.id;assert.notEqual(fresh,old.id);
    ingest(changed);assert.equal(store.visible()[0]!.id,fresh);assert.equal(rows().length,2);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM iptv_favorites WHERE channel_id=?').get(old.id) as {n:number}).n,1);
  } finally {db.close();}
});

test('reused IDs and shared URLs do not merge unrelated stations or silently give them a guide',()=>{
  const {db,store,s,ingest,list,rows,revision}=fixture();
  try {
    ingest(entry('US: CNN HD','shared'),entry('US: Other station HD','shared'));list();
    assert.equal(rows().length,2);assert.equal(store.stacks().length,2);
    const guide=store.create('owner',{kind:'xmltv',name:'Guide'});
    store.ingest('owner',guide.id,0,Buffer.from('<tv><channel id="cnn.us"><display-name>CNN</display-name></channel><programme channel="cnn.us" start="20261017120000 +0000" stop="20261017130000 +0000"><title>News</title></programme></tv>'));
    store.bindFeed('owner',s.id,guide.id,revision());
    const c=rows()[0]!;assert.equal(store.mappingReview(c.id,guide.id).mapping,undefined);
    store.map('owner',c.id,guide.id,'cnn.us',0);assert.equal(store.mappingReview(c.id,guide.id).mapping?.method,'admin');
  } finally {db.close();}
});
