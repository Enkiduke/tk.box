import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {CleanupStore} from '../apps/server/src/persistence/cleanup-store.js';
import {openDatabase} from '../apps/server/src/persistence/database.js';
import {Vault} from '../apps/server/src/security/vault.js';
import {cleanupConfig,cleanupMissing,type CleanupServices} from '../apps/server/src/services/cleanup-engine.js';

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
