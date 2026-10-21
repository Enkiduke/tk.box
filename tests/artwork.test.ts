import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {resolve} from 'node:path';
import {ArtworkStore} from '../apps/server/src/persistence/artwork-store.js';
import {openDatabase} from '../apps/server/src/persistence/database.js';
import {Vault} from '../apps/server/src/security/vault.js';
import {artworkConfig} from '../apps/server/src/services/artwork-engine.js';
import {lastDue} from '../apps/server/src/services/artwork-schedule.js';

const seeded=()=>{const db=openDatabase(':memory:');return {db,store:new ArtworkStore(db,new Vault(randomBytes(32)),resolve('apps/artwork/defaults.json'))};};
const ok=async()=>{};

test('artwork starts from the engine’s bundled layouts, local-only',()=>{
  const {store}=seeded();
  assert.deepEqual(store.layoutNames(),['tk-charts','tk-collections','tk-custom','tk-movies','tk-streaming','tk-tv']);
  const view=store.view();
  assert.equal(view.upload,false);assert.equal(view.defaultLayout,'tk-movies');assert.equal(view.layoutByType.custom,'tk-custom');assert.deepEqual(view.keysSet,{tmdb:false,tvdb:false,fanart:false,mdblist:false});
  assert.equal(view.schedules.added.enabled,false);
});
test('artwork keys are sealed, kept when omitted and removed when empty',async()=>{
  const {db,store}=seeded(),base={...store.settings(),revision:undefined};delete base.revision;
  await store.update('admin',0,{...base,tmdbKey:'tmdb-secret-1',fanartKey:'fanart-secret'},ok);
  assert.ok(!(db.prepare('SELECT value FROM artwork_settings').get() as {value:string}).value.includes('tmdb-secret-1'));
  assert.deepEqual(store.keys(),{tmdb:'tmdb-secret-1',fanart:'fanart-secret'});
  await store.update('admin',1,{...base,fanartKey:''},ok);
  assert.deepEqual(store.keys(),{tmdb:'tmdb-secret-1'});
  assert.deepEqual(store.view().keysSet,{tmdb:true,tvdb:false,fanart:false,mdblist:false});
  await assert.rejects(store.update('admin',1,base,ok),{code:'REVISION_CONFLICT'});
  // A layout that doesn't exist, or a failed engine check, saves nothing.
  await assert.rejects(store.update('admin',2,{...base,defaultLayout:'missing'},ok),{code:'LAYOUT_NOT_FOUND'});
  await assert.rejects(store.update('admin',2,{...base,quality:80},async()=>{throw new Error('rejected');}),/rejected/);
  assert.equal(store.settings().quality,95);
});
test('artwork layouts in use cannot be removed, and a name is created once',async()=>{
  const {store}=seeded(),base={...store.settings(),revision:undefined};delete base.revision;
  await store.update('admin',0,{...base,libraries:['2'],layoutByLibrary:{'2':'tk-tv'}},ok);
  assert.throws(()=>store.removeLayout('admin','tk-tv'),{code:'LAYOUT_IN_USE'});
  assert.throws(()=>store.removeLayout('admin','tk-movies'),{code:'LAYOUT_IN_USE'});
  await store.update('admin',1,{...base,libraries:['2'],layoutByLibrary:{'2':'tk-tv'},layoutByType:{}},ok);
  store.removeLayout('admin','tk-charts');
  const created=await store.saveLayout('admin','posters-2',0,{width:2000},ok);
  assert.equal(created.revision,1);
  await assert.rejects(store.saveLayout('admin','posters-2',0,{width:1000},ok),{code:'REVISION_CONFLICT'});
  assert.equal((await store.saveLayout('admin','posters-2',1,{width:1000},ok)).value.width,1000);
});
test('the engine config names libraries by title for their layouts and keeps credentials out',()=>{
  const {store}=seeded(),settings={...store.settings(),libraries:['1','2'],layoutByLibrary:{'1':'tk-movies','2':'tk-tv','9':'tk-tv'},layoutByType:{collection:'tk-collections'},upload:true};
  const config=artworkConfig(settings,store.layouts(),[{key:'1',title:'Movies',type:'movie'},{key:'2',title:'TV Shows',type:'show'}],{plexUrl:'http://plex.local:32400',cacheDir:'/cache/artwork'});
  assert.deepEqual(config.plex.libraries,['1','2']);assert.equal(config.plex.upload,true);
  // A library the administrator can no longer see is left out rather than guessed.
  assert.deepEqual(config.layout_by_library,{Movies:'tk-movies','TV Shows':'tk-tv'});
  assert.deepEqual(config.layout_by_type,{collection:'tk-collections'});
  assert.equal(config.cache_dir,'/cache/artwork');
  assert.ok(!JSON.stringify(config).includes('token')&&!('api' in config));
});
test('settings saved before schedules existed read with the default schedules',()=>{
  const {db,store}=seeded(),{revision:_,schedules:__,...old}=store.settings();
  db.prepare('INSERT INTO artwork_settings VALUES(1,1,?)').run(JSON.stringify({...old,keys:{}}));
  assert.deepEqual(store.settings().schedules.scrub,{enabled:false,time:'04:00'});
});
test('collection schedules saved with the artwork settings move to the collections once',()=>{
  const {db,store}=seeded(),{revision:_,...settings}=store.settings(),vault=new Vault(randomBytes(32));
  const schedules={...settings.schedules,added:{enabled:true,minutes:20},seasonal:{enabled:true,time:'03:10'},collections:{enabled:false,time:'05:00'}};
  db.prepare('INSERT INTO artwork_settings VALUES(1,3,?)').run(JSON.stringify({...settings,schedules,keys:{}}));
  const {revision:__,radarrKeySet:___,schedules:____,...collections}=store.collections();
  db.prepare('INSERT INTO artwork_collections VALUES(1,2,?)').run(JSON.stringify({...collections,definitions:[{name:'Halloween',library:'Movies',type:'movie'}]}));
  const moved=new ArtworkStore(db,vault).collections();
  assert.deepEqual(moved.schedules,{custom:{enabled:true,time:'03:10'},all:{enabled:false,time:'05:00'},added:{enabled:true,minutes:20}});
  assert.equal(moved.revision,3);
  assert.deepEqual(Object.keys(JSON.parse((db.prepare('SELECT value FROM artwork_settings').get() as {value:string}).value).schedules),['scrub','added']);
  assert.equal(new ArtworkStore(db,vault).collections().revision,3);  // Only once
});
test('artwork collections keep the Radarr key sealed and out of the engine config',async()=>{
  const {db,store}=seeded(),current=store.collections();
  assert.equal(current.definitions,null);
  const value={definitions:[{name:'Halloween',library:'Movies',type:'movie',members:[{tmdb_id:948}],schedule:'10/01-10/31',acquire:true}],franchise:{...current.franchise,sync:true},
    radarr:{url:'http://radarr.local:7878/',rootFolder:'/movies',qualityProfileId:4,search:true},schedules:current.schedules};
  let checked:unknown;
  await store.updateCollections('admin',{value,radarrKey:'radarr-secret-1',expectedRevision:0},async v=>{checked=v;});
  assert.equal((checked as {radarrKey?:string}).radarrKey,'radarr-secret-1');
  assert.ok(!(db.prepare('SELECT value FROM artwork_collections').get() as {value:string}).value.includes('radarr-secret-1'));
  assert.equal(store.collections().radarrKeySet,true);assert.equal(store.collections().radarr.url,'http://radarr.local:7878');
  await assert.rejects(store.updateCollections('admin',{value,expectedRevision:0},ok),{code:'REVISION_CONFLICT'});
  const {radarrKey,...collections}=store.collectionsConfig();assert.equal(radarrKey,'radarr-secret-1');
  const config=artworkConfig(store.settings(),store.layouts(),[],{plexUrl:'http://plex.local:32400',cacheDir:'/cache'},collections);
  assert.equal(config.plex.sync_collections,true);assert.equal(config.plex.franchise_collections,true);assert.equal(config.collections?.length,1);
  assert.deepEqual(config.radarr,{url:'http://radarr.local:7878',api_key:'${RADARR_API_KEY}',root_folder:'/movies',search:true,quality_profile_id:4});
  assert.ok(!JSON.stringify(config).includes('radarr-secret-1'));
  // Collections saved before the franchise switch existed keep making them.
  const {franchises:_,...older}=value.franchise;
  db.prepare('UPDATE artwork_collections SET value=? WHERE id=1').run(JSON.stringify({...value,franchise:older}));
  assert.equal(store.collections().franchise.franchises,true);
});
test('a daily schedule falls due at its local time, or the day before until then',()=>{
  const at=(h:number,m:number)=>{const d=new Date(2026,9,20,h,m);return d;};
  assert.equal(lastDue('04:00',at(4,0)),at(4,0).getTime());
  assert.equal(lastDue('04:00',at(9,30)),at(4,0).getTime());
  const before=lastDue('04:00',at(3,59)),yesterday=new Date(2026,9,19,4,0).getTime();
  assert.equal(before,yesterday);
});
test('a database seeded with the earlier layouts gets the tk-* set, and settings follow the renames',()=>{
  const db=openDatabase(':memory:'),vault=new Vault(randomBytes(32)),insert=db.prepare('INSERT INTO artwork_layouts VALUES(?,?,?,0)');
  for(const name of ['overlayrr-main','tk-movies','tk-tv','collection-tmdb','streaming-collection','chart-collection'])insert.run(name,1,'{"width":1000}');
  insert.run('mine',3,'{"width":1200}');
  db.prepare('INSERT INTO artwork_settings VALUES(1,4,?)').run(JSON.stringify({libraries:['1'],defaultLayout:'overlayrr-main',layoutByLibrary:{'1':'tk-tv','2':'mine'},layoutByType:{collection:'collection-tmdb'},keys:{}}));
  const store=new ArtworkStore(db,vault,resolve('apps/artwork/defaults.json'));
  assert.deepEqual(store.layoutNames(),['mine','tk-charts','tk-collections','tk-custom','tk-movies','tk-streaming','tk-tv']);
  assert.notEqual(store.layout('tk-movies').value.width,1000);
  const s=store.settings();
  assert.equal(s.defaultLayout,'tk-movies');assert.deepEqual(s.layoutByLibrary,{'1':'tk-tv','2':'mine'});
  assert.equal(s.layoutByType.collection,'tk-collections');assert.equal(s.layoutByType.custom,'tk-custom');assert.equal(s.revision,4);
  // Only once: later starts leave the layouts alone.
  db.prepare('DELETE FROM artwork_layouts WHERE name=?').run('tk-charts');
  new ArtworkStore(db,vault,resolve('apps/artwork/defaults.json'));
  assert.ok(!store.layoutNames().includes('tk-charts'));
});
