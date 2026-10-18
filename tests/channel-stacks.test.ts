import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { openDatabase } from '../apps/server/src/persistence/database.js';
import { IptvStore } from '../apps/server/src/persistence/iptv-store.js';
import { Vault } from '../apps/server/src/security/vault.js';
import { stackKey, quality, feedRank } from '../apps/server/src/services/channel-stacks.js';

const entry=(name:string,id='')=>`#EXTINF:-1${id?` tvg-id="${id}"`:''} group-title="US News",${name}\nhttps://streams.invalid/${encodeURIComponent(name)}`;
const playlist=(...lines:string[])=>Buffer.from('#EXTM3U\n'+lines.join('\n'));
const cnn=['US: CNN SD','US CNN (S)','USA  CNN','US: CNN FHD (Backup)','US: CNN HD (Backup)','US: CNN FHD'];
function fixture() {const db=openDatabase(':memory:'),store=new IptvStore(db,new Vault(randomBytes(32)));db.prepare('INSERT INTO users VALUES(?,1)').run('viewer');return {db,store};}
// No channel checks run here, so list channels without waiting for a first passing check.
function listAll(store:IptvStore,source:string) {store.setListingPolicy('owner',source,{...store.listingPolicy(source),requireCheck:false,expectedRevision:store.status(source).revision});}

test('station keys ignore region prefixes, quality tags and feed letters but keep distinct stations apart',()=>{
  for(const name of [...cnn,'US CNN (A)','US: CNN'])assert.equal(stackKey(name),'cnn',name);
  for(const name of ['US MSNBC (H)','US MSNBC (A)','US MSNBC (S)','US: MSNBC FHD'])assert.equal(stackKey(name),'msnbc',name);
  assert.equal(stackKey('US: CNN International HD'),'cnn international');
  assert.equal(stackKey('UK| BBC One FHD'),'bbc one');
  assert.deepEqual(['US: CNN FHD','US: CNN HD','US: CNN 4K','US: CNN','US: CNN SD'].map(quality),['FHD','HD','4K',undefined,'SD']);
  const ranked=['US: CNN SD','US: CNN','US: CNN FHD (Backup)','US: CNN HD','US: CNN FHD'].sort((a,b)=>feedRank(b)-feedRank(a));
  assert.deepEqual(ranked,['US: CNN FHD','US: CNN FHD (Backup)','US: CNN HD','US: CNN','US: CNN SD']);
});

test('entries without a provider ID are reviewable by unique name and survive refreshes',()=>{
  const {store}=fixture(),s=store.create('owner',{kind:'m3u',name:'Fixture'});
  store.ingest('owner',s.id,0,playlist(...cnn.map(n=>entry(n)),entry('Twin'),entry('Twin')+'?second'));
  const channels=store.adminChannels(s.id);
  assert.equal(channels.filter(c=>!c.conflict&&c.listing==='auto').length,cnn.length);
  assert.equal(channels.filter(c=>c.conflict).length,2,'duplicate names stay ambiguous');
  listAll(store,s.id);const before=store.visible().map(c=>c.id).sort();
  store.ingest('owner',s.id,store.status(s.id).revision,playlist(...cnn.map(n=>entry(n)),entry('Twin'),entry('Twin')+'?second'));
  assert.deepEqual(store.visible().map(c=>c.id).sort(),before,'same records after refresh');
});

test('feeds of one station share a guide row that defaults to FHD and keeps every feed tunable',()=>{
  const {store}=fixture(),s=store.create('owner',{kind:'m3u',name:'Fixture'});
  store.ingest('owner',s.id,0,playlist(...cnn.map(n=>entry(n)),entry('US: CNN','8249'),entry('US MSNBC (H)','MSNBC.us'),entry('US: MSNBC FHD')));
  listAll(store,s.id);
  const stacks=store.stacks(),news=stacks.find(c=>c.stack.endsWith(':cnn'))!,msnbc=stacks.find(c=>c.stack.endsWith(':msnbc'))!;
  assert.equal(stacks.length,2);
  assert.equal(news.name,'US: CNN FHD');assert.equal(news.quality,'FHD');
  // Untagged feeds tie, so only their band is fixed.
  const names=news.feeds.map(f=>f.name);
  assert.deepEqual(names.slice(0,3),['US: CNN FHD','US: CNN FHD (Backup)','US: CNN HD (Backup)']);
  assert.deepEqual(names.slice(3,6).sort(),['US CNN (S)','US: CNN','USA  CNN']);assert.equal(names[6],'US: CNN SD');
  assert.equal(msnbc.name,'US: MSNBC FHD');
  for(const feed of news.feeds)assert.equal(store.tune(feed.id).id,feed.id);
  const page=store.guidePage('viewer','all',0,3600000,0,30);
  assert.equal(page.total,2);assert.equal(page.channels.find(c=>c.id===news.id)!.feeds.length,cnn.length+1);
  assert.equal(store.guidePage('viewer','all',0,3600000,0,30,'cnn sd').total,1,'any feed name finds its station');
  assert.equal(store.guidePage('viewer','all',0,3600000,0,30,'',news.feeds.at(-1)!.id).channels[0]!.id,news.id,'any feed selects its station');
  // Favoriting any feed marks the station; removing it clears every feed.
  store.favorite('viewer',news.feeds[3]!.id,true);
  assert.equal(store.guidePage('viewer','favorites',0,3600000,0,30).channels[0]!.favorite,true);
  store.favorite('viewer',news.id,false);
  assert.equal(store.guidePage('viewer','favorites',0,3600000,0,30).total,0);
});

test('administrators can keep a feed separate or stack it under another station',()=>{
  const {store}=fixture(),s=store.create('owner',{kind:'m3u',name:'Fixture'});
  store.ingest('owner',s.id,0,playlist(entry('US: CNN FHD'),entry('US: CNN SD'),entry('HLN HD')));listAll(store,s.id);
  const byName=(n:string)=>store.adminChannels(s.id).find(c=>c.name===n)!;
  store.editChannel('owner',byName('US: CNN SD').id,{expectedRevision:store.status(s.id).revision,stack:''});
  assert.equal(store.stacks().length,3);
  store.editChannel('owner',byName('HLN HD').id,{expectedRevision:store.status(s.id).revision,stack:'US: CNN'});
  const stacks=store.stacks();assert.equal(stacks.length,2);
  assert.deepEqual(stacks.find(c=>c.stack.endsWith(':cnn'))!.feeds.map(f=>f.name),['US: CNN FHD','HLN HD']);
});
