import test from 'node:test';
import assert from 'node:assert/strict';
import {connectionHealth} from '../apps/server/src/services/connection-health.js';

test('checks saved services independently and reports useful failures without exposing credentials', async () => {
  const calls:string[] = [];
  const transport = (async (input,init) => {
    const url = new URL(String(input));
    calls.push(url.hostname);
    assert.equal(init?.redirect,'manual');
    if(url.hostname==='radarr.test') {
      assert.equal(new Headers(init?.headers).get('X-Api-Key'),'fixture-key');
      assert.equal(url.pathname,'/radarr/api/v3/system/status');
      return Response.json({version:'6.0'});
    }
    if(url.hostname==='sonarr.test') return Response.json({message:'fixture-key'},{status:401});
    if(url.hostname==='tautulli.test') return Response.json({response:{result:'error',message:'fixture-key'}});
    if(url.hostname==='seerr.test') return Response.json({initialized:true});
    if(url.hostname==='api4.thetvdb.com') return Response.json({data:{token:'fixture-tvdb-token'}});
    return new Response('<html>Proxy sign-in</html>');
  }) as typeof fetch;
  const key = 'fixture-key';
  const check = connectionHealth(()=>({
    seerr:{url:'http://seerr.test'},radarr:{url:'http://radarr.test/radarr',key},
    sonarr:{url:'http://sonarr.test',key},tautulli:{url:'http://tautulli.test',key},
  }),()=>({tvdb:key,tmdb:key}),{other:transport,tmdb:transport,seerr:transport});
  const pending = check();
  assert.equal(check(),pending);
  const results = await pending;
  assert.deepEqual(Object.fromEntries(Object.entries(results).map(([id,{state}])=>[id,state])),{
    seerr:'limited',radarr:'working',sonarr:'failed',tautulli:'failed',tmdb:'failed',tvdb:'working',
  });
  assert.match(results.sonarr!.detail!,/saved API key/);
  assert.match(results.tmdb!.detail!,/unexpected response/);
  assert.ok(Object.values(results).every(result=>result.checkedAt>0));
  assert.doesNotMatch(JSON.stringify(results),/fixture-/);
  assert.equal(calls.length,6);
  await check();
  assert.equal(calls.length,12);
});
