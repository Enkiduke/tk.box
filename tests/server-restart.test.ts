import test from 'node:test';
import assert from 'node:assert/strict';
import {ServerWatch} from '../apps/web/src/server-restart.js';

// Each answer is a boot id, or undefined for an unreachable server.
function server(...answers:(string|undefined)[]) {
  let calls=0;
  const fetcher=async()=>{const boot=answers[Math.min(calls++,answers.length-1)];if(boot===undefined)throw new TypeError('Failed to fetch');return new Response(JSON.stringify({status:'ok',boot}));};
  return {watch:new ServerWatch(fetcher),calls:()=>calls};
}
const fast={everyMs:1};

test('the same server answering means the stream itself failed',async()=>{
  const {watch}=server('a','a');await watch.remember();
  assert.equal(await watch.check(()=>true,fast),'same');
});

test('a new boot id means the server restarted, even when it was never seen down',async()=>{
  const {watch}=server('a','b');await watch.remember();
  assert.equal(await watch.check(()=>true,fast),'restarted');
});

test('a server that was unreachable counts as restarted once it answers, and the new id is remembered',async()=>{
  const {watch}=server('a',undefined,undefined,'a','a');await watch.remember();
  assert.equal(await watch.check(()=>true,fast),'restarted');
  assert.equal(await watch.check(()=>true,fast),'same');
});

test('a server that never comes back is down, and an abandoned check stops polling',async()=>{
  const {watch}=server(undefined);
  assert.equal(await watch.check(()=>true,{waitMs:5,everyMs:1}),'down');
  const second=server(undefined);let active=true;
  const pending=second.watch.check(()=>active,{waitMs:60000,everyMs:1});
  setTimeout(()=>{active=false;},5);
  assert.equal(await pending,undefined);
});
