import test from 'node:test';
import assert from 'node:assert/strict';
import {PlexAdapter} from '../apps/server/src/providers/plex.js';
import {verifyPlexAccess,verifyPlexReadIsolation} from '../apps/server/src/services/plex-verification.js';
import {config,fakePlex} from './fixtures.js';

test('live verification checks account roles without logging or writing watched state',async()=>{
  const f=fakePlex();const transport=(async(url,init)=>{const token=new Headers(init?.headers).get('X-Plex-Token');f.options.accountId=token==='owner'?1:2;f.options.authorized=token!=='unauthorized';return f.transport(url,init);}) as typeof fetch;
  const plex=new PlexAdapter(config(),'test',transport);await verifyPlexAccess(plex,{owner:'owner',viewer:'viewer',unauthorized:'unauthorized'});
  assert.ok(!f.calls.some(c=>c.path.includes('timeline')));
});
test('EOF transport verification refuses implicit history changes and incomplete reads',async()=>{
  const f=fakePlex();const plex=new PlexAdapter(config(),'test',f.transport);
  const result=await verifyPlexReadIsolation(plex,'viewer','42',{signal:AbortSignal.timeout(1000),maxBytes:100});assert.equal(result.bytesRead,3);assert.equal(result.historyUnchanged,true);
  await assert.rejects(verifyPlexReadIsolation(plex,'viewer','42',{signal:AbortSignal.timeout(1000),maxBytes:2}),{code:'LIVE_TEST_BYTE_LIMIT'});
  let metadataReads=0;
  const changed=(async(url,init)=>{
    const response=await f.transport(url,init);
    if(String(url).includes('/library/metadata/')) {const data=await response.json();metadataReads++;data.MediaContainer.Metadata[0].viewCount=metadataReads;return Response.json(data);}
    return response;
  }) as typeof fetch;
  await assert.rejects(verifyPlexReadIsolation(new PlexAdapter(config(),'test',changed),'viewer','42',{signal:AbortSignal.timeout(1000),maxBytes:100}),{code:'PLEX_HISTORY_MUTATED'});
  assert.ok(!f.calls.some(c=>c.path.includes('timeline')));
});
