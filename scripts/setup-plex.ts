import {readFile,writeFile,mkdir,unlink} from 'node:fs/promises';
import {existsSync,writeFileSync,readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {z,ZodError} from 'zod';
import {loadConfig} from '../apps/server/src/config.js';
import {Vault,digest} from '../apps/server/src/security/vault.js';
import {PlexAdapter} from '../apps/server/src/providers/plex.js';
import {AppError,requireThat} from '../apps/server/src/errors.js';
import {savePlexConfiguration,loadPlexSetupConfig} from '../apps/server/src/services/plex-setup.js';

const challengeSchema=z.object({pinId:z.number().int(),code:z.string(),expires:z.number(),endpointDigest:z.string(),envDigest:z.string(),lastPoll:z.number()});
let stage='configuration';
try {
  const action=process.argv[2];requireThat(action==='start'||action==='finish','SETUP_USAGE','Use setup:plex -- start or setup:plex -- finish.');
  const config=loadPlexSetupConfig(),envPath=resolve('.env'),original=await readFile(envPath,'utf8');
  const vault=Vault.fromFile(config.SECRET_KEY_FILE??join(config.DATA_DIR,'secret.key'));
  await mkdir(config.DATA_DIR,{recursive:true,mode:0o700});const clientPath=join(config.DATA_DIR,'client-id');
  if(!existsSync(clientPath))writeFileSync(clientPath,randomUUID(),{flag:'wx',mode:0o600});
  const plex=new PlexAdapter(config,readFileSync(clientPath,'utf8').trim()),root=resolve('.local/plex-setup'),file=join(root,'challenge');
  await mkdir(root,{recursive:true,mode:0o700});
  if(action==='start') {
    stage='server_identity';
    const machineId=await plex.serverIdentity();requireThat(!config.PLEX_MACHINE_ID||config.PLEX_MACHINE_ID===machineId,'PLEX_SERVER_MISMATCH','Configured Plex server identity does not match.',403);
    stage='plex_pin';
    const pin=await plex.createPin();
    const challenge={pinId:pin.id,code:pin.code,expires:Date.now()+Math.min(pin.expiresIn*1000,600000),endpointDigest:digest(config.PLEX_URL),envDigest:digest(original),lastPoll:0};
    await writeFile(file,vault.seal(JSON.stringify(challenge),'plex-local-setup'),{mode:0o600});
    console.log(JSON.stringify({status:'awaiting_owner_sign_in',serverIdentityReachable:true,authUrl:plex.authUrl(pin.code),expiresAt:new Date(challenge.expires).toISOString()}));
  } else {
    requireThat(existsSync(file),'SETUP_CHALLENGE_REQUIRED','Start Plex setup first.');
    const lock=join(root,'finish.lock');
    try {await writeFile(lock,'',{flag:'wx',mode:0o600});}catch{throw new AppError('SETUP_BUSY','Another setup finish is active. If a previous process crashed, remove the local finish.lock file.');}
    try {
      const challenge=challengeSchema.parse(JSON.parse(vault.open(await readFile(file,'utf8'),'plex-local-setup')));
      requireThat(challenge.expires>Date.now(),'AUTH_EXPIRED','Plex setup sign-in expired. Start again.',401);
      requireThat(challenge.endpointDigest===digest(config.PLEX_URL)&&challenge.envDigest===digest(original),'SETUP_CONFIG_CHANGED','Configuration changed. Start setup again.',409);
      requireThat(Date.now()-challenge.lastPoll>=2000,'POLL_TOO_FAST','Wait before checking Plex sign-in again.',429);
      challenge.lastPoll=Date.now();await writeFile(file,vault.seal(JSON.stringify(challenge),'plex-local-setup'),{mode:0o600});
      const credential=await plex.pollPin(challenge.pinId,challenge.code);
      if(!credential)console.log(JSON.stringify({status:'pending'}));
      else {
        const discovery=await plex.discoverOwner(credential);
        const resolved=loadConfig({...process.env,PLEX_OWNER_ACCOUNT_ID:discovery.ownerAccountId,PLEX_MACHINE_ID:discovery.machineId,PLEX_REQUIRED_LIBRARY_IDS:discovery.requiredLibraryIds.join(',')});
        const grant=await new PlexAdapter(resolved,readFileSync(clientPath,'utf8').trim()).authorize(credential);
        requireThat(grant.role==='admin','PLEX_OWNER_REQUIRED','Owner verification failed.',403);
        await savePlexConfiguration(envPath,challenge.envDigest,config.PLEX_URL,discovery);
        const report={generatedAt:new Date().toISOString(),serverIdentityVerified:true,ownerAccountVerified:true,ownerRole:'admin',requiredLibraries:{movies:discovery.libraries.filter(l=>l.type==='movie'&&discovery.requiredLibraryIds.includes(l.key)).length,tv:discovery.libraries.filter(l=>l.type==='show'&&discovery.requiredLibraryIds.includes(l.key)).length},unverified:['Shared/unauthorized accounts','Browser VOD playback and progress','Custom-channel history safety','Media codec/track compatibility']};
        await writeFile(join(root,'report.json'),JSON.stringify(report,null,2),{mode:0o600});await unlink(file);
        console.log(JSON.stringify({status:'configured',...report}));
      }
    }finally{await unlink(lock).catch(()=>{});}
  }
}catch(error){console.error(JSON.stringify({code:error instanceof AppError?error.code:'PLEX_SETUP_FAILED',stage,message:error instanceof AppError?error.message:'Plex setup failed. Check configuration and connectivity; no credentials or upstream diagnostics were logged.',fields:error instanceof ZodError?error.issues.map(i=>({field:i.path.join('.'),code:i.code})):undefined}));process.exitCode=1;}
