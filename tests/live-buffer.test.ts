import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readdir,mkdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {DiskSegments} from '../apps/server/src/streaming/disk-segments.js';
import {LiveViewers} from '../apps/server/src/streaming/live-viewers.js';
import {renderManifest,type Segment} from '../apps/server/src/streaming/buffer.js';
import {TsContinuity} from '../apps/server/src/streaming/ts-continuity.js';

const segment=(n:number):Segment=>({id:`s-${n}`,sequence:n,start:n*2000,end:(n+1)*2000,bytes:100,uri:`s-${n}.ts`,programId:n<2?'a':'b',revision:1,discontinuity:n===2,discontinuitySequence:n>2?1:0});
const temporary=resolve('.local');await mkdir(temporary,{recursive:true});
test('disk quota deletes real files and expires only affected viewer cursors',async()=>{
  const root=await mkdtemp(join(temporary,'tk.box-disk-'));const input=join(root,'input.ts');await writeFile(input,Buffer.alloc(100));
  const store=new DiskSegments(join(root,'cache'),200,()=>30000,0,async()=>100000);await store.initialize();
  const viewers=new LiveViewers(store,()=>30000,async()=>{});const a=viewers.create('owner-a',2000),b=viewers.create('owner-b',2000);
  try{
    await store.publish(segment(0),input);viewers.pause(a,'owner-a',1000,2000);
    await store.publish(segment(1),input);await store.publish(segment(2),input);
    assert.equal(store.bytes,200);assert.equal(viewers.state(a,'owner-a',6000).state,'EXPIRED');assert.equal(viewers.state(b,'owner-b',6000).state,'LIVE');
    assert.deepEqual((await readdir(join(root,'cache'))).sort(),['s-1.ts','s-2.ts']);
    await assert.rejects(viewers.segment(b,'owner-a','s-2.ts',6000),{code:'SESSION_NOT_FOUND'});
    await assert.rejects(viewers.segment(a,'owner-a','s-2.ts',6000),{code:'BUFFER_EXPIRED'});
    viewers.goLive(a,'owner-a',6000);assert.equal((await viewers.segment(a,'owner-a','s-2.ts',6000)).bytes.length,100);
    await store.clear();assert.equal(store.bytes,0);assert.deepEqual(await readdir(join(root,'cache')),[]);
  }finally{await rm(root,{recursive:true,force:true});}
});
test('per-file authorization denies revoked reads and disk pressure stops unsafe buffering',async()=>{
  const root=await mkdtemp(join(temporary,'tk.box-auth-buffer-')),input=join(root,'input.ts');await writeFile(input,Buffer.alloc(100));let free=10000,revoked=false;
  const store=new DiskSegments(join(root,'cache'),1000,()=>30000,100,async()=>free);await store.initialize();
  const viewers=new LiveViewers(store,()=>30000,async(_owner,program)=>{if(revoked||program==='b')throw new Error('revoked');});const id=viewers.create('owner',0);
  try{
    await store.publish(segment(0),input);revoked=true;await assert.rejects(viewers.manifest(id,'owner',2000));await assert.rejects(viewers.segment(id,'owner','s-0.ts',2000));revoked=false;
    const manifest=await viewers.manifest(id,'owner',2000);assert.match(manifest,/EXT-X-START:TIME-OFFSET=0.000000/);
    free=50;await assert.rejects(store.publish(segment(1),input),{code:'SEGMENT_DISK_PRESSURE'});assert.equal(store.bytes,0);assert.deepEqual(await readdir(join(root,'cache')),[]);
  }finally{await rm(root,{recursive:true,force:true});}
});
test('init segments are charged once and deleted only after their final retained fragment',async()=>{
  const root=await mkdtemp(join(temporary,'tk.box-init-')),input=join(root,'media.m4s'),init=join(root,'init.mp4');await writeFile(input,Buffer.alloc(100));await writeFile(init,Buffer.alloc(50));
  const store=new DiskSegments(join(root,'cache'),300,()=>3000,0,async()=>10000);await store.initialize();
  try{
    await store.publish({...segment(0),uri:'s-0.m4s',initUri:'init-0.mp4'},input,init);await store.publish({...segment(1),uri:'s-1.m4s',initUri:'init-0.mp4'},input,init);
    assert.equal(store.bytes,250);await store.prune(5000);assert.equal(store.bytes,150);await store.prune(7000);assert.equal(store.bytes,0);
    await store.publish({...segment(4),uri:'s-4.m4s',initUri:'init-0.mp4'},input,init);assert.equal(store.bytes,150);assert.equal((await store.read('init-0.mp4',10000,async()=>{})).bytes.length,50);
    const manifest=renderManifest([{...segment(2),uri:'s-2.m4s',initUri:'init-4000.mp4',discontinuitySequence:0}],false,4500);
    assert.match(manifest,/VERSION:7/);assert.match(manifest,/DISCONTINUITY-SEQUENCE:0/);assert.match(manifest,/MAP:URI="init-4000.mp4"/);assert.match(manifest,/TIME-OFFSET=0.500000/);
  }finally{await rm(root,{recursive:true,force:true});}
});
test('transport continuity survives repeated sources without touching packet payloads',()=>{
  const packet=(pid:number,cc:number,payload=true)=>{const b=Buffer.alloc(188,0xaa);b[0]=0x47;b[1]=pid>>8;b[2]=pid&255;b[3]=(payload?0x10:0x20)|cc;return b;};
  const rewrite=new TsContinuity(),first=packet(256,14),second=packet(256,0),third=packet(256,5,false);
  const a=rewrite.rewrite(first),b=rewrite.rewrite(second),c=rewrite.rewrite(third);assert.equal(a[3]!&15,14);assert.equal(b[3]!&15,15);assert.equal(c[3]!&15,15);
  assert.deepEqual(b.subarray(4),second.subarray(4));assert.equal(rewrite.rewrite(packet(256,0))[3]!&15,0);
  assert.throws(()=>rewrite.rewrite(Buffer.alloc(187)));const scrambled=packet(256,0);scrambled[3]!|=0x80;assert.throws(()=>rewrite.rewrite(scrambled));
});
