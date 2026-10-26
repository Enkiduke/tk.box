import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {resolve} from 'node:path';
import {ArtworkStore} from '../apps/server/src/persistence/artwork-store.js';
import {openDatabase} from '../apps/server/src/persistence/database.js';
import {Vault} from '../apps/server/src/security/vault.js';
import {ArtworkSchedule} from '../apps/server/src/services/artwork-schedule.js';
import {finishedSections} from '../apps/server/src/services/plex-notifications.js';
import type {ArtworkEngine} from '../apps/server/src/services/artwork-engine.js';
import type {PlexAdapter,PlexGrant} from '../apps/server/src/providers/plex.js';

const grant:PlexGrant={accountId:'1',role:'admin',serverToken:'token',libraries:[{key:'1',title:'Movies',type:'movie'}]};
const start=Date.UTC(2026,9,1)/1000;
// A schedule with artwork's newly added check on for library 1, a Plex whose recently added list is `titles`
// (addedAt in seconds) and an engine that records what it queued.
async function setup(titles:{id:string;addedAt:number}[],streaming=async()=>0) {
  const store=new ArtworkStore(openDatabase(':memory:'),new Vault(randomBytes(32)),resolve('apps/artwork/defaults.json'));
  const {revision,...settings}=store.settings();
  await store.update('admin',revision,{...settings,libraries:['1'],schedules:{...settings.schedules,added:{enabled:true,schedule:{kind:'every',minutes:60}}}},async()=>{});
  const queued:string[]=[],plex={fail:false,addedSince:async(_:PlexGrant,__:string,since:number)=>{
    if(plex.fail)throw new Error('down');
    return {items:titles.filter(t=>t.addedAt*1000>since).sort((a,b)=>b.addedAt-a.addedAt).map(t=>({...t,title:t.id})),complete:true};
  }};
  // Artwork's jobs are recorded by title ID; the collections engine's (the Discover index, the full run) whole.
  const jobs:string[][]=[],engine={pending:(args:string[])=>queued.includes(args[1]!)||jobs.some(j=>j.join()===args.join()),
    enqueue:(_:string,__:string,args:string[],___:unknown,options?:{script?:string})=>{if(options?.script==='collections')jobs.push(args);else queued.push(args[1]!);}};
  const schedule=new ArtworkSchedule(store,engine as unknown as ArtworkEngine,plex as unknown as PlexAdapter,async()=>grant,()=>{},streaming);
  return {store,schedule,queued,jobs,plex,note:()=>schedule.states().added.note};
}

test('newly added titles queue oldest first, at most 50 a check, and the rest come next check',async()=>{
  const titles=Array.from({length:60},(_,i)=>({id:String(100+i),addedAt:start+60+i}));
  const {schedule,queued,note}=await setup(titles);
  await schedule.tick(new Date(start*1000),true);
  assert.equal(note(),'Watching for titles added from now on.');assert.equal(queued.length,0);
  await schedule.tick(new Date((start+120)*1000),true);
  assert.deepEqual(queued,titles.slice(0,50).map(t=>t.id));
  assert.equal(note(),'Queued 50 newly added titles; 10 more next check.');
  await schedule.tick(new Date((start+180)*1000),true);
  assert.deepEqual(queued,titles.map(t=>t.id));assert.equal(note(),'Queued 10 newly added titles.');
  await schedule.tick(new Date((start+240)*1000),true);
  assert.equal(queued.length,60);assert.equal(note(),'Nothing new.');
});
test('titles added in the same second as the 50th are not skipped',async()=>{
  const titles=[...Array.from({length:49},(_,i)=>({id:String(100+i),addedAt:start+60+i})),{id:'a',addedAt:start+200},{id:'b',addedAt:start+200}];
  const {schedule,queued}=await setup(titles);
  await schedule.tick(new Date(start*1000),true);
  await schedule.tick(new Date((start+300)*1000),true);
  assert.equal(queued.length,50);
  await schedule.tick(new Date((start+360)*1000),true);
  assert.equal(queued.length,51);assert.deepEqual(new Set(queued.slice(49)),new Set(['a','b']));
});
test('when Plex does not answer, the watermark stays for the next check',async()=>{
  const {schedule,queued,plex,note}=await setup([{id:'1',addedAt:start+60}]);
  await schedule.tick(new Date(start*1000),true);
  plex.fail=true;await schedule.tick(new Date((start+120)*1000),true);
  assert.equal(queued.length,0);assert.match(note()!,/didn’t answer/);
  plex.fail=false;await schedule.tick(new Date((start+180)*1000),true);
  assert.deepEqual(queued,['1']);
});
test('the newly added check waits for its minutes unless Plex said something was added',async()=>{
  const {schedule,queued}=await setup([{id:'1',addedAt:start+60}]);
  await schedule.tick(new Date(start*1000),true);
  await schedule.tick(new Date((start+120)*1000));
  assert.equal(queued.length,0);
  await schedule.tick(new Date((start+3600)*1000));
  assert.deepEqual(queued,['1']);
});
test('newly added movies join the Discover index in one job a check',async()=>{
  const {schedule,jobs}=await setup([{id:'1',addedAt:start+60},{id:'2',addedAt:start+61}]);
  await schedule.tick(new Date(start*1000),true);
  assert.deepEqual(jobs,[]);
  await schedule.tick(new Date((start+120)*1000),true);
  assert.deepEqual(jobs,[['index','added','1','2']]);
  await schedule.tick(new Date((start+180)*1000));  // Not 15 minutes yet, and nothing new after
  await schedule.tick(new Date((start+1200)*1000));
  assert.equal(jobs.length,1);
});
test('the nightly full collections run waits while anyone is streaming, for up to four hours',async()=>{
  let streams=2;
  const {store,schedule,jobs}=await setup([],async()=>streams);
  const {revision,...settings}=store.settings();
  await store.update('admin',revision,{...settings,upload:true},async()=>{});
  const at=new Date(start*1000),time=`${String(at.getHours()).padStart(2,'0')}:${String(at.getMinutes()).padStart(2,'0')}`;
  const {revision:collections,radarrKeySet:_,scheduleStates:__,...value}=store.collections() as ReturnType<ArtworkStore['collections']>&{scheduleStates?:unknown};
  await store.updateCollections('admin',{value:{...value,schedules:{...value.schedules,all:{enabled:true,time}}} as never,expectedRevision:collections},async()=>{});
  const full=()=>jobs.filter(j=>j[0]==='all');
  await schedule.tick(new Date((start+60)*1000));
  assert.deepEqual(full(),[]);assert.match(schedule.collectionStates().all.note!,/^Waiting: 2 streams are playing/);
  streams=0;await schedule.tick(new Date((start+120)*1000));
  assert.deepEqual(full(),[['all','apply']]);
  // The next night it runs at four hours even if people are still watching.
  jobs.length=0;streams=1;const night=start+86400;
  await schedule.tick(new Date((night+3*3600)*1000));
  assert.deepEqual(full(),[]);
  await schedule.tick(new Date((night+4*3600+60)*1000));
  assert.deepEqual(full(),[['all','apply']]);
});

test('Plex notifications name the sections where a title finished processing, or any when a scan ended',()=>{
  const timeline=(entries:object[])=>JSON.stringify({NotificationContainer:{type:'timeline',size:entries.length,TimelineEntry:entries}});
  const entry={identifier:'com.plexapp.plugins.library',sectionID:'2',itemID:'500',type:4,title:'Pilot',state:5,updatedAt:1};
  assert.deepEqual(finishedSections(timeline([entry,{...entry,sectionID:3,type:1}])),new Set(['2','3']));
  // Still processing, a deleted item, a non-library entry, a photo or a non-section entry say nothing.
  assert.equal(finishedSections(timeline([{...entry,state:0},{...entry,state:9},{...entry,identifier:'other'},{...entry,type:13},{...entry,sectionID:'-1'}])),undefined);
  assert.equal(finishedSections(JSON.stringify({NotificationContainer:{type:'activity',ActivityNotification:[{event:'ended',Activity:{type:'library.update.section'}}]}})),'any');
  assert.equal(finishedSections(JSON.stringify({NotificationContainer:{type:'activity',ActivityNotification:[{event:'started',Activity:{type:'library.update.section'}}]}})),undefined);
  assert.equal(finishedSections(JSON.stringify({NotificationContainer:{type:'playing',PlaySessionStateNotification:[{}]}})),undefined);
  assert.equal(finishedSections('not json'),undefined);
});
