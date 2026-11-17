import {existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {build} from 'vite';
import {loadConfig} from '../apps/server/src/config.js';
import {syncPreview} from './preview-sync.js';

// npm run preview:plex: the server's data on your own Plex connection, read-only and frozen (TKBOX_PREVIEW): nothing is
// written to Plex, the downloaders or the library files, no background work runs, and indexers and IPTV
// sources aren't fetched. It first copies the server's state down (npm run preview:sync); `-- --keep` starts on the
// copy already here instead, and `-- --port=3014` serves on another port (so a second preview can run beside yours).
// If the copy fails and an earlier one exists, it starts on that and says so.

if(existsSync('.env'))process.loadEnvFile('.env');
const source=loadConfig();
if(!source.plexConfigured)throw new Error('Configure your local Plex connection in .env before running the Plex preview.');

const root=resolve('.local/plex-preview'),data=join(root,'data');
const port=process.argv.find(a=>a.startsWith('--port='))?.slice(7)??'3012';
// Each port builds into its own folder, so a second preview doesn't swap the files under the first.
const web=join(root,port==='3012'?'web':`web-${port}`);
if(!process.argv.includes('--keep')){
  try {await syncPreview(root);}
  catch(e){
    if(!existsSync(join(data,'tk.box.sqlite')))throw e;
    console.warn(`Couldn’t sync from the server (${(e as Error).message}); starting on the last copy.`);
  }
}
if(!existsSync(join(data,'tk.box.sqlite')))throw new Error('No copy of the server yet. Run npm run preview:sync.');

// The preview has its own state, static files and browser origin.
Object.assign(process.env,{
  APP_HOST:'localhost',APP_PORT:port,DEPLOYMENT_MODE:'local',PUBLIC_BASE_URL:'',
  DATA_DIR:data,CACHE_DIR:join(root,'cache'),SECRET_KEY_FILE:'',WEB_DIR:web,TKBOX_READ_ONLY:'1',TKBOX_PREVIEW:'1',CHANNEL_HEALTH_CHECKS:'0'
});
await build({configFile:'apps/web/vite.config.ts',build:{outDir:web}});
console.log(`Plex preview (read-only, frozen): http://localhost:${port}`);
await import('../apps/server/src/index.js');
