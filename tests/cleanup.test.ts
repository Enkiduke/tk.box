import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {CleanupStore} from '../apps/server/src/persistence/cleanup-store.js';
import { openMigratedDatabase } from '../apps/server/src/modules/migrations/index.js';
import {Vault} from '../apps/server/src/security/vault.js';
import {migrate} from '../apps/server/src/persistence/migrate.js';
import {cleanupMigrations} from '../apps/server/src/modules/migrations/cleanup.js';
import {cleanupCollections,cleanupConfig,cleanupMissing,cleanupWatches,holdUntil,snapshotRows,withHolds,withKept,type CleanupServices,type CleanupTitle} from '../apps/server/src/services/cleanup-engine.js';
import {HistoryStore} from '../apps/server/src/persistence/history-store.js';

const store=()=>new CleanupStore(openMigratedDatabase(':memory:'),new Vault(randomBytes(32)));
const services:CleanupServices={tautulli:{url:'http://tautulli:8181',key:'tautulli-key'},radarr:{url:'',key:undefined},sonarr:{url:'',key:undefined}};

test('clean up starts as a preview and writes the script’s config without keys',()=>{
  const {revision:_,...settings}=store().settings();
  assert.equal(settings.dryRun,true);
  const config=cleanupConfig({...settings,movieLibraries:['1'],leavingSoon:{...settings.leavingSoon,enabled:true}},services,{plexUrl:'http://plex:32400',poster:'/opt/tk.box/apps/cleanup/leaving-soon.png'});
  assert.equal(config.dry_run,true);
  assert.deepEqual(config.movie_libraries,['1']);
  assert.equal(config.create_leaving_soon_collection,true);
  assert.equal(config.leaving_soon_poster,'/opt/tk.box/apps/cleanup/leaving-soon.png');
  assert.equal(config.days_after_unwatched,60);
  assert.ok(!JSON.stringify(config).includes('-key'));
});

test('clean up says what it needs before it can run',()=>{
  const {revision:_,...settings}=store().settings();
  assert.deepEqual(cleanupMissing(settings,services),['Choose at least one movie or TV library.']);
  assert.deepEqual(cleanupMissing({...settings,movieLibraries:['1']},services),[]);
  // TV is cleaned up season by season by default, which deletes through Sonarr.
  assert.match(cleanupMissing({...settings,tvLibraries:['2']},services).join(),/Delete from Sonarr turned on/);
  assert.match(cleanupMissing({...settings,tvLibraries:['2'],deleteFromSonarr:true},services).join(),/needs Sonarr connected/);
  assert.match(cleanupMissing({...settings,movieLibraries:['1']},{...services,tautulli:{url:'http://tautulli:8181'}}).join(),/Connect Tautulli/);
});

test('clean up keys are sealed and a saved key survives a save without one',()=>{
  const s=store();
  s.updateConnections('admin',0,{tautulliUrl:'http://tautulli:8181/',tautulliKey:'abc123'});
  const view=s.updateConnections('admin',1,{tautulliUrl:'http://tautulli:8181'});
  assert.deepEqual(view,{revision:2,tautulliUrl:'http://tautulli:8181',tautulliKeySet:true});
  assert.equal(s.connections().tautulliKey,'abc123');
  assert.throws(()=>s.updateConnections('admin',1,{tautulliUrl:''}),/changed/);
});

test('a hold keeps a title longer and the status shows it until the next run',()=>{
  const s=store(),{revision:_,...settings}=s.settings(),DAY=86400000,now=Date.parse('2026-10-01T00:00:00Z');
  const title:CleanupTitle={title:'Dune',year:2021,kind:'movie',library:'Movies',status:'due',rule:'Rule 2',reason:'',deletion_date:'2026-09-30T00:00:00Z',held_until:null,key:'movie:438631',rating_key:'1'};
  const view={updated:'2026-10-01T00:00:00Z',dryRun:true,complete:true,items:[title,{...title,key:'movie:1',status:'protected' as const,deletion_date:null}]};
  // Start over gives the rule's whole period from today.
  assert.equal(holdUntil(title,settings,now),now+60*DAY);
  assert.throws(()=>holdUntil({...title,rule:null},settings,now),/no retention rule/);
  s.setHold('admin','movie:438631',now+3*DAY,now);
  const held=withHolds(view,s.holds(now),7,now).items;
  assert.equal(held[0]!.status,'leaving');
  assert.equal(held[0]!.held_until,new Date(now+3*DAY).toISOString());
  assert.equal(held[1]!.holdable,false);
  assert.equal(withHolds(view,s.holds(now),2,now).items[0]!.status,'kept');
  // A hold the run already used leaves its status alone; removing it puts the rule's date back.
  const ran={...view,items:[{...title,status:'leaving' as const,held_until:new Date(now+3*DAY).toISOString()}]};
  assert.equal(withHolds(ran,s.holds(now),7,now).items[0]!.status,'leaving');
  assert.equal(withHolds(ran,{},7,now).items[0]!.status,'due');
  // Past holds lapse, and the script gets the rest.
  assert.deepEqual(s.holds(now+4*DAY),{});
  assert.deepEqual(cleanupConfig(settings,services,{plexUrl:'',poster:''},s.holds(now)).holds,{'movie:438631':new Date(now+3*DAY).toISOString()});
  assert.throws(()=>s.setHold('admin','movie:1;drop',now),/can be held/);
});

test('clean up tells the script which collections protect, with tk.box’s own by kind',()=>{
  const {revision:_,...settings}=store().settings();
  // Streaming collections don't protect by default.
  assert.deepEqual(settings.collectionKinds,{franchise:true,streaming:false,custom:true,seasonal:true,other:true});
  const kept=[{name:'Netflix Shows',library:'TV',kind:'streaming' as const,items:9},{name:'Halloween',library:'Movies',kind:'custom' as const,items:4},{name:'Comfort Films',library:'Movies',kind:'custom' as const,items:3}];
  const collections=cleanupCollections(kept,[{name:'Halloween Collection',library:'Movies',schedule:'10-01..10-31'},{name:'Comfort Films',library:'Movies'}]);
  assert.deepEqual(collections.map(c=>c.kind),['streaming','seasonal','custom']);
  const config=cleanupConfig(settings,services,{plexUrl:'',poster:''},{},collections);
  assert.deepEqual(config.protecting_collection_kinds,['franchise','custom','seasonal','other']);
  assert.deepEqual(config.tkbox_collections[0],{name:'Netflix Shows',library:'TV',kind:'streaming'});
});

test('a kept show shows protected, every season, until a later run',()=>{
  const at=Date.parse('2026-10-20T00:00:00Z'),title=(key:string,kind:CleanupTitle['kind']):CleanupTitle=>({title:key,year:null,kind,library:'TV',status:'leaving',rule:'Rule 1',reason:'',deletion_date:'2026-10-30T00:00:00Z',key,holdable:true});
  const view={updated:'2026-10-19T00:00:00Z',dryRun:true,complete:true,items:[title('tv:1:1','season'),title('tv:1:2','season'),title('tv:2','show'),title('movie:1','movie')]};
  const kept=withKept(view,{'tv:1':{tag:'keep',by:'1',at}});
  assert.deepEqual(kept.items.map(i=>i.status),['protected','protected','leaving','leaving']);
  assert.equal(kept.items[0]!.reason,'Tagged keep');
  // A run after the keep reports the tag itself.
  assert.equal(withKept({...view,updated:'2026-10-21T00:00:00Z'},{'tv:1':{tag:'keep',by:'1',at}}).items[0]!.status,'leaving');
});

test('the script is given tk.box’s requests and no Seerr, and settings saved with Remove from Seerr lose it',()=>{
  const {revision:_,...settings}=store().settings();
  const requests=[{id:1,kind:'movie' as const,tmdb:603,tvdb:null,title:'The Matrix',year:1999,requester_plex_id:11,available_at:'2026-01-05T00:00:00.000Z',seasons:[]}];
  const config=cleanupConfig(settings,services,{plexUrl:'',poster:''},{},[],requests);
  assert.deepEqual(config.requests,requests);
  assert.ok(!/seerr/i.test(JSON.stringify(config)));
  const db=openMigratedDatabase(':memory:');
  db.prepare("INSERT INTO cleanup_config VALUES('settings',3,?)").run(JSON.stringify({...settings,deleteFromSeerr:true}));
  assert.equal('deleteFromSeerr' in new CleanupStore(db,new Vault(randomBytes(32))).settings(),false);
  db.prepare("DELETE FROM schema_migrations WHERE owner='cleanup' AND name='drop-seerr'").run();
  migrate(db,'cleanup',cleanupMigrations);
  assert.equal(JSON.parse((db.prepare("SELECT value FROM cleanup_config WHERE name='settings'").get() as {value:string}).value).deleteFromSeerr,undefined);
});

test('saved watch history keeps the later date of each, and only for its own Plex server',()=>{
  const s=store(),at=(d:string)=>Date.parse(d);
  s.saveWatchSnapshot('admin','srv',3,[{scope:'movie',ratingKey:'10',account:'',at:at('2026-01-01')},{scope:'movie',ratingKey:'10',account:'7',at:at('2026-01-01')}]);
  const info=s.saveWatchSnapshot('admin','srv',3,[{scope:'movie',ratingKey:'10',account:'',at:at('2025-06-01')},{scope:'season',ratingKey:'21',account:'',at:at('2026-02-01')}]);
  assert.deepEqual([info.checked,info.watches],[3,2]);
  assert.equal(s.watchSnapshotRows('srv').find(r=>r.ratingKey==='10'&&r.account==='')!.at,at('2026-01-01'));
  assert.deepEqual(s.watchSnapshotRows('other'),[]);
  s.saveWatchSnapshot('admin','other',1,[]);
  assert.deepEqual(s.watchSnapshotRows('other'),[]);
});

test('the run config’s watches take the later of the snapshot and tk.box’s history, per scope and user',()=>{
  const w=cleanupWatches('srv',[
    {scope:'show',ratingKey:'5',account:'',at:Date.parse('2026-01-01')},
    {scope:'show',ratingKey:'5',account:'7',at:Date.parse('2026-01-01')},
    {scope:'show',ratingKey:'5',account:'7',at:Date.parse('2026-03-01')},
    {scope:'show',ratingKey:'5',account:'9',at:Date.parse('2026-04-01')},
  ],new Set(['7']));
  assert.deepEqual(w,{server_id:'srv',movie:{},season:{},show:{'5':{any:'2026-04-01T00:00:00.000Z',users:{'7':'2026-03-01T00:00:00.000Z'}}}});
});

test('a watch history file is kept only when complete, from this server and well formed',()=>{
  const good={server_id:'srv',complete:true,checked:2,watches:[{scope:'season',rating_key:'21',any:'2026-01-01T00:00:00+00:00',users:{'7':'2025-12-01T00:00:00+00:00'}}]};
  assert.deepEqual(snapshotRows(good,'srv'),{checked:2,rows:[{scope:'season',ratingKey:'21',account:'',at:Date.parse('2026-01-01')},{scope:'season',ratingKey:'21',account:'7',at:Date.parse('2025-12-01')}]});
  assert.match(snapshotRows({...good,complete:false},'srv') as string,/could not be checked/);
  assert.match(snapshotRows(good,'other') as string,/different Plex server/);
  assert.match(snapshotRows({...good,watches:[{...good.watches[0],scope:'episode'}]},'srv') as string,/invalid/);
  assert.match(snapshotRows(null,'srv') as string,/did not write/);
});

test('tk.box’s own watches are read per movie, show and season, without channels or unwatched sessions',()=>{
  const db=openMigratedDatabase(':memory:'),history=new HistoryStore(db);
  const media=db.prepare('INSERT INTO history_media(server_id,rating_key,metadata) VALUES(?,?,?)');
  const movie=media.run('srv','10',JSON.stringify({type:'movie'})).lastInsertRowid,episode=media.run('srv','30',JSON.stringify({type:'episode',showId:'5',seasonId:'21'})).lastInsertRowid;
  const elsewhere=media.run('other','11',JSON.stringify({type:'movie'})).lastInsertRowid;
  const session=db.prepare("INSERT INTO history_sessions(id,source,account_id,media_id,client,stream,generation,started_at,observed_at,watch_ms,position_ms) VALUES(?,?,?,?,'c','{}','g',?,?,?,0)");
  session.run('a','plex','7',movie,100,100,5000); session.run('b','vod','7',movie,200,200,5000); session.run('c','vod','8',episode,300,300,5000);
  session.run('d','vod','7',episode,400,400,0); session.run('e','iptv','7',movie,500,500,5000); session.run('f','vod','7',elsewhere,600,600,5000);
  const rows=history.latestWatches('srv').map(r=>`${r.scope}:${r.ratingKey}:${r.account}:${r.at}`).sort();
  assert.deepEqual(rows,['movie:10:7:200','season:21:8:300','show:5:8:300']);
});
