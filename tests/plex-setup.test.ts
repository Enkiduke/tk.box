import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {PlexAdapter} from '../apps/server/src/providers/plex.js';
import {savePlexConfiguration,loadPlexSetupConfig} from '../apps/server/src/services/plex-setup.js';
import {loadConfig} from '../apps/server/src/config.js';
import {digest} from '../apps/server/src/security/vault.js';
import {fakePlex,config} from './fixtures.js';
import {parseEnv} from 'node:util';

test('local Plex discovery requires verified owner and both Movies/TV, preserving existing configuration constraints',async()=>{
  const incomplete=loadConfig({PLEX_MACHINE_ID:'',PLEX_OWNER_ACCOUNT_ID:'',PUBLIC_BASE_URL:'',SECRET_KEY_FILE:''});assert.equal(incomplete.plexConfigured,false);assert.equal(incomplete.SECRET_KEY_FILE,undefined);
  assert.equal(loadPlexSetupConfig({PLEX_OWNER_ACCOUNT_ID:'fixture-username'}).PLEX_OWNER_ACCOUNT_ID,undefined);assert.equal(loadPlexSetupConfig({PLEX_OWNER_ACCOUNT_ID:'99'}).PLEX_OWNER_ACCOUNT_ID,'99');
  const owner=fakePlex({accountId:1}),base=loadConfig({PLEX_URL:'https://server.invalid'}),adapter=new PlexAdapter(base,'setup-test',owner.transport);
  const discovered=await adapter.discoverOwner('fixture-owner-account-token');assert.equal(discovered.ownerAccountId,'1');assert.equal(discovered.machineId,'machine');assert.deepEqual(discovered.requiredLibraryIds,['10','20']);
  for(const options of [{accountId:2},{accountId:1,authorized:false},{accountId:1,missingLibrary:true}]) {
    const fixture=fakePlex(options);await assert.rejects(new PlexAdapter(base,'setup-test',fixture.transport).discoverOwner('fixture'));
  }
  await assert.rejects(new PlexAdapter({...config(),PLEX_MACHINE_ID:'another'},'setup',owner.transport).discoverOwner('fixture'),{code:'PLEX_SERVER_MISMATCH'});
  await assert.rejects(new PlexAdapter({...config(),PLEX_OWNER_ACCOUNT_ID:'99'},'setup',owner.transport).discoverOwner('fixture'),{code:'PLEX_OWNER_MISMATCH'});
  await assert.rejects(new PlexAdapter({...config(),requiredLibraries:['10']},'setup',owner.transport).discoverOwner('fixture'),{code:'PLEX_LIBRARIES_REQUIRED'});
  assert.ok(!owner.calls.some(c=>c.path==='/:/timeline'||c.path.startsWith('/library/parts/')));
});
test('setup writes only verified IDs, preserves unrelated settings and rejects stale or ambiguous environment edits',async()=>{
  await mkdir(resolve('.local'),{recursive:true});const folder=await mkdtemp(join(resolve('.local'),'plex-setup-test-')),path=join(folder,'.env');
  const original='# preserved comment\r\nPLEX_URL=https://server.invalid\r\nPLEX_REQUIRED_LIBRARY_IDS=\r\nUNRELATED_SECRET=fixture-secret\r\n';
  const discovery={ownerAccountId:'1',machineId:'machine',requiredLibraryIds:['10','20'],libraries:[]};
  try {
    await writeFile(path,original);await savePlexConfiguration(path,digest(original),'https://server.invalid',discovery);
    const saved=await readFile(path,'utf8'),env=parseEnv(saved);assert.equal(env.PLEX_URL,'https://server.invalid');assert.equal(env.UNRELATED_SECRET,'fixture-secret');assert.equal(env.PLEX_OWNER_ACCOUNT_ID,'1');assert.equal(env.PLEX_MACHINE_ID,'machine');assert.equal(env.PLEX_REQUIRED_LIBRARY_IDS,'10,20');assert.ok(saved.startsWith('# preserved comment\r\n'));
    await assert.rejects(savePlexConfiguration(path,digest(original),'https://server.invalid',discovery),{code:'SETUP_CONFIG_CHANGED'});assert.equal(await readFile(path,'utf8'),saved);
    for(const [text,code] of [[original+'PLEX_OWNER_ACCOUNT_ID=99\r\n','PLEX_OWNER_MISMATCH'],[original+'PLEX_REQUIRED_LIBRARY_IDS=10\r\n','SETUP_CONFIG_AMBIGUOUS']] as const) {
      await writeFile(path,text);await assert.rejects(savePlexConfiguration(path,digest(text),'https://server.invalid',discovery),{code});assert.equal(await readFile(path,'utf8'),text);
    }
    await writeFile(path,original);await assert.rejects(savePlexConfiguration(path,digest(original),'https://other.invalid',discovery),{code:'SETUP_CONFIG_CHANGED'});
    await assert.rejects(savePlexConfiguration(path,digest(original),'https://server.invalid',{...discovery,machineId:'invalid\nINJECTED=true'}),{code:'PLEX_INVALID_ID'});assert.equal(await readFile(path,'utf8'),original);
    const repair=original+'PLEX_OWNER_ACCOUNT_ID=fixture-username\r\n';await writeFile(path,repair);await savePlexConfiguration(path,digest(repair),'https://server.invalid',discovery);assert.equal(parseEnv(await readFile(path,'utf8')).PLEX_OWNER_ACCOUNT_ID,'1');
  }finally{await rm(folder,{recursive:true,force:true});}
});
