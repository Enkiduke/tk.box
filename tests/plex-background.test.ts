import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {openDatabase} from '../apps/server/src/persistence/database.js';
import {Vault} from '../apps/server/src/security/vault.js';
import {ServiceKeys} from '../apps/server/src/persistence/service-keys.js';
import {PlexBackground} from '../apps/server/src/services/plex-background.js';
import {AppError} from '../apps/server/src/errors.js';
import type {PlexAdapter,PlexGrant} from '../apps/server/src/providers/plex.js';

const grant=(role:'admin'|'viewer'):PlexGrant=>({accountId:'1',role,serverToken:'t',libraries:[]});
function setup() {
  const keys=new ServiceKeys(openDatabase(':memory:'),new Vault(randomBytes(32)));
  const plex={calls:0,answer:(_token:string):Promise<PlexGrant>=>Promise.resolve(grant('admin')),authorize(token:string){plex.calls++;return plex.answer(token);}};
  return {keys,plex,background:new PlexBackground(keys,plex as unknown as PlexAdapter)};
}

test('background work waits without a Plex admin token, and asks Plex again only every ten minutes',async()=>{
  const {keys,plex,background}=setup(),t=Date.UTC(2026,9,1);
  assert.equal(await background.grant(t),undefined);assert.equal(plex.calls,0);
  keys.update('admin',{plex:'owner-token'});
  assert.equal((await background.grant(t))?.role,'admin');
  await background.grant(t+9*60000);assert.equal(plex.calls,1);
  await background.grant(t+11*60000);assert.equal(plex.calls,2);
});
test('a token Plex stops accepting stops background work; Plex being down keeps the last grant for an hour',async()=>{
  const {keys,plex,background}=setup(),t=Date.UTC(2026,9,1);
  keys.update('admin',{plex:'owner-token'});await background.grant(t);
  plex.answer=()=>Promise.reject(new AppError('PLEX_UNAVAILABLE','down',502));
  assert.equal((await background.grant(t+20*60000))?.role,'admin');
  assert.equal(await background.grant(t+61*60000),undefined);
  plex.answer=()=>Promise.resolve(grant('admin'));await background.grant(t+62*60000);
  plex.answer=()=>Promise.reject(new AppError('PLEX_ACCESS_DENIED','no',403));
  assert.equal(await background.grant(t+80*60000),undefined);
});
test('only the server owner’s token is accepted',async()=>{
  const {plex,background}=setup();
  plex.answer=()=>Promise.resolve(grant('viewer'));
  await assert.rejects(background.check('viewer-token'),{code:'PLEX_TOKEN_NOT_OWNER'});
});
