import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {CleanupStore} from '../apps/server/src/persistence/cleanup-store.js';
import {openDatabase} from '../apps/server/src/persistence/database.js';
import {Vault} from '../apps/server/src/security/vault.js';
import {cleanupConfig,cleanupMissing,holdUntil,withHolds,type CleanupServices,type CleanupTitle} from '../apps/server/src/services/cleanup-engine.js';

const store=()=>new CleanupStore(openDatabase(':memory:'),new Vault(randomBytes(32)));
const services:CleanupServices={seerr:{url:'http://seerr:5055',apiKey:'seerr-key'},tautulli:{url:'http://tautulli:8181',key:'tautulli-key'},radarr:{url:'',key:undefined},sonarr:{url:'',key:undefined}};

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
  s.updateConnections('admin',0,{tautulliUrl:'http://tautulli:8181/',sonarrUrl:'',tautulliKey:'abc123'});
  const view=s.updateConnections('admin',1,{tautulliUrl:'http://tautulli:8181',sonarrUrl:'http://sonarr:8989'});
  assert.deepEqual(view,{revision:2,tautulliUrl:'http://tautulli:8181',sonarrUrl:'http://sonarr:8989',tautulliKeySet:true,sonarrKeySet:false});
  assert.equal(s.connections().tautulliKey,'abc123');
  assert.throws(()=>s.updateConnections('admin',1,{tautulliUrl:'',sonarrUrl:''}),/changed/);
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
