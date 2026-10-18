import {readFile,stat,mkdir,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {loadConfig} from '../apps/server/src/config.js';
import {PlexAdapter} from '../apps/server/src/providers/plex.js';
import {verifyPlexAccess,verifyPlexReadIsolation} from '../apps/server/src/services/plex-verification.js';
import {AppError,requireThat} from '../apps/server/src/errors.js';

async function token(name: string) {
  const path=process.env[name];requireThat(path,'LIVE_TEST_INPUT_REQUIRED',`Set ${name} to a protected account-token file.`);
  const info=await stat(path);requireThat(info.isFile()&&info.size>0&&info.size<=4096,'LIVE_TEST_TOKEN_FILE','Invalid token file.');
  if(process.platform!=='win32') requireThat((info.mode&0o077)===0,'LIVE_TEST_TOKEN_PERMISSIONS','Token files must be accessible only to their owner.');
  const value=(await readFile(path,'utf8')).trim();requireThat(value&&!/[\r\n]/.test(value),'LIVE_TEST_TOKEN_FILE','Invalid token file contents.');return value;
}
try {
  const config=loadConfig();requireThat(config.plexConfigured,'SETUP_REQUIRED','Configure Plex machine, owner and required library IDs first.');
  const tokens={owner:await token('PLEX_TEST_OWNER_TOKEN_FILE'),viewer:await token('PLEX_TEST_VIEWER_TOKEN_FILE'),unauthorized:await token('PLEX_TEST_UNAUTHORIZED_TOKEN_FILE')};
  const plex=new PlexAdapter(config,'tk.box-milestone-0-verification');await verifyPlexAccess(plex,tokens);
  const ratingKey=process.env.PLEX_TEST_READ_ITEM;requireThat(ratingKey&&/^\d+$/.test(ratingKey),'LIVE_TEST_INPUT_REQUIRED','Set PLEX_TEST_READ_ITEM to an authorized, preferably short test item.');
  const result=await verifyPlexReadIsolation(plex,tokens.viewer,ratingKey,{signal:AbortSignal.timeout(120000),maxBytes:512*1024*1024,settle:()=>delay(5000)});
  const report={generatedAt:new Date().toISOString(),access:{owner:'passed',sharedViewer:'passed',unauthorized:'rejected'},originalRead:result,
    unverified:['Browser PIN linking','VOD resume/completion writes','Paced custom-channel playback/history isolation','Audio/subtitle preferences','Remote HTTPS proxy playback']};
  const root=resolve('.local/plex-verification');await mkdir(root,{recursive:true,mode:0o700});await writeFile(join(root,'report.json'),JSON.stringify(report,null,2),{mode:0o600});
  console.log(JSON.stringify(report,null,2));
} catch(e) {console.error(JSON.stringify({code:e instanceof AppError?e.code:'LIVE_VERIFICATION_FAILED',message:e instanceof AppError?e.message:'Live verification failed. No credentials or upstream diagnostics were logged.'}));process.exitCode=1;}
