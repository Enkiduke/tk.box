import assert from 'node:assert/strict';
import {test} from 'node:test';
import {parseEnv} from 'node:util';
import {setEnvValues} from '../apps/server/src/services/env-file.js';
import {plexAddressCandidates,isLocalAddress,chosenLibraries} from '../apps/server/src/setup-api.js';

test('.env values replace their own line and keep everything else', () => {
  const text='# Plex\r\nPLEX_URL=http://127.0.0.1:32400\r\nexport PLEX_MACHINE_ID=old\r\nAPP_PORT=3000\r\n';
  assert.equal(setEnvValues(text,{PLEX_MACHINE_ID:'abc',PLEX_OWNER_ACCOUNT_ID:'42'}),
    "# Plex\r\nPLEX_URL=http://127.0.0.1:32400\r\nPLEX_MACHINE_ID='abc'\r\nAPP_PORT=3000\r\nPLEX_OWNER_ACCOUNT_ID='42'\r\n");
});
test('a missing .env starts from nothing, and a file without a final newline gets one', () => {
  assert.equal(setEnvValues('',{PLEX_URL:'http://nas:32400'}),"PLEX_URL='http://nas:32400'\n");
  assert.equal(setEnvValues('APP_PORT=3000',{PLEX_URL:'http://nas:32400'}),"APP_PORT=3000\nPLEX_URL='http://nas:32400'\n");
});
test('a duplicated key or a value spanning lines is refused', () => {
  assert.throws(()=>setEnvValues('PLEX_URL=a\nPLEX_URL=b\n',{PLEX_URL:'c'}),/duplicate PLEX_URL/);
  assert.throws(()=>setEnvValues('',{FFMPEG_PATH:'a\nAPP_HOST=0.0.0.0'}),/span lines/);
});
test('written values read back unchanged, Windows paths included', () => {
  const values={FFMPEG_PATH:'C:\\new\\bin\\ffmpeg.exe',PYTHON_PATH:"C:\\Users\\O'Neil\\venv\\python.exe",PLEX_URL:'http://nas:32400'};
  assert.deepEqual({...parseEnv(setEnvValues('',values))},values);
});
test('a typed Plex address becomes the origins to try', () => {
  assert.deepEqual(plexAddressCandidates('192.168.1.20'),['http://192.168.1.20:32400','https://192.168.1.20:32400']);
  assert.deepEqual(plexAddressCandidates(' nas.local:8080/ '),['http://nas.local:8080','https://nas.local:8080']);
  assert.deepEqual(plexAddressCandidates('https://plex.example.com'),['https://plex.example.com:32400']);
  assert.deepEqual(plexAddressCandidates('http://nas:32400'),['http://nas:32400']);
  assert.deepEqual(plexAddressCandidates('http://nas:32400/web'),[]);
  assert.deepEqual(plexAddressCandidates('ftp://nas'),[]);
  assert.deepEqual(plexAddressCandidates(''),[]);
});
test('setup answers this computer and private networks only', () => {
  for (const ip of ['127.0.0.1','::1','::ffff:192.168.1.5','10.0.0.2','172.20.1.1','169.254.3.4','fd00::1','fe80::1']) assert.ok(isLocalAddress(ip),ip);
  for (const ip of ['8.8.8.8','172.32.0.1','::ffff:1.2.3.4','2001:db8::1']) assert.ok(!isLocalAddress(ip),ip);
});
test('chosen libraries need a Movies and a TV library from the server', () => {
  const libraries=[{key:'1',title:'Movies',type:'movie'},{key:'2',title:'TV',type:'show'},{key:'3',title:'Kids',type:'movie'}];
  assert.deepEqual(chosenLibraries(libraries,['1','2']),['1','2']);
  assert.throws(()=>chosenLibraries(libraries,['1','3']),/one TV library/);
  assert.throws(()=>chosenLibraries(libraries,['1','2','9']),/from your Plex server/);
});
