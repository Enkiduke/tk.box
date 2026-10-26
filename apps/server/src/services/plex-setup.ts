import {readFile,writeFile,rename,unlink} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {parseEnv} from 'node:util';
import {digest} from '../security/vault.js';
import {requireThat} from '../errors.js';
import type {PlexAdapter} from '../providers/plex.js';
import {loadConfig} from '../config.js';
import {setEnvValues} from './env-file.js';

type Discovery=Awaited<ReturnType<PlexAdapter['discoverOwner']>>;
// A local operator may repair a username/other invalid owner setting, but only
// through verified ownership below. The server's normal config stays strict.
export function loadPlexSetupConfig(env:NodeJS.ProcessEnv=process.env) {
  const owner=env.PLEX_OWNER_ACCOUNT_ID;
  return loadConfig({...env,PLEX_OWNER_ACCOUNT_ID:owner&&!/^\d+$/.test(owner)?undefined:owner});
}
// Only verified identifiers are written. Preserve the endpoint and all unrelated
// settings/comments, and refuse to overwrite configuration edited during setup.
export async function savePlexConfiguration(path:string,originalDigest:string,expectedUrl:string,discovery:Discovery) {
  const original=await readFile(path,'utf8');
  requireThat(digest(original)===originalDigest,'SETUP_CONFIG_CHANGED','Configuration changed during setup. Start setup again.',409);
  const env=parseEnv(original);
  requireThat(env.PLEX_URL&&new URL(env.PLEX_URL).href===new URL(expectedUrl).href,'SETUP_CONFIG_CHANGED','Configured Plex endpoint changed.',409);
  requireThat(!env.PLEX_OWNER_ACCOUNT_ID||!/^\d+$/.test(env.PLEX_OWNER_ACCOUNT_ID)||env.PLEX_OWNER_ACCOUNT_ID===discovery.ownerAccountId,'PLEX_OWNER_MISMATCH','Setup cannot replace an already configured numeric owner.',403);
  const ids={PLEX_OWNER_ACCOUNT_ID:discovery.ownerAccountId,PLEX_MACHINE_ID:discovery.machineId,PLEX_REQUIRED_LIBRARY_IDS:discovery.requiredLibraryIds.join(',')};
  requireThat(/^\d+$/.test(ids.PLEX_OWNER_ACCOUNT_ID)&&discovery.requiredLibraryIds.length>0&&discovery.requiredLibraryIds.every(id=>/^\d+$/.test(id))&&/^[A-Za-z0-9_.:-]{1,128}$/.test(ids.PLEX_MACHINE_ID),'PLEX_INVALID_ID','Plex returned unsupported configuration identifiers.');
  const next=setEnvValues(original,ids);
  const temporary=`${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary,next,{flag:'wx',mode:0o600});
    requireThat(digest(await readFile(path,'utf8'))===originalDigest,'SETUP_CONFIG_CHANGED','Configuration changed during setup. Start setup again.',409);
    await rename(temporary,path);
  }finally{await unlink(temporary).catch(()=>{});}
}
