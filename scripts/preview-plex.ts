import Database from 'better-sqlite3';
import {copyFileSync,existsSync,mkdirSync,mkdtempSync,renameSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {build} from 'vite';
import {loadConfig} from '../apps/server/src/config.js';

if(existsSync('.env'))process.loadEnvFile('.env');
const source=loadConfig();
if(!source.plexConfigured)throw new Error('Configure your local Plex connection in .env before running the Plex preview.');

const root=resolve('.local/plex-preview'),data=join(root,'data'),web=join(root,'web');
mkdirSync(root,{recursive:true,mode:0o700});
if(!existsSync(data)){
  const original=join(source.DATA_DIR,'tk.box.sqlite');
  const key=source.SECRET_KEY_FILE??join(source.DATA_DIR,'secret.key');
  const staging=mkdtempSync(join(root,'seed-'));
  try {
    if(existsSync(original)){
      copyFileSync(key,join(staging,'secret.key'));
      const db=new Database(original,{readonly:true,fileMustExist:true});
      try {await db.backup(join(staging,'tk.box.sqlite'));} finally {db.close();}
    }
    renameSync(staging,data);
  } finally {
    rmSync(staging,{recursive:true,force:true});
  }
}

// The preview has its own state, static files and browser origin.
Object.assign(process.env,{
  APP_HOST:'localhost',APP_PORT:'3012',DEPLOYMENT_MODE:'local',PUBLIC_BASE_URL:'',
  DATA_DIR:data,CACHE_DIR:join(root,'cache'),SECRET_KEY_FILE:'',WEB_DIR:web,TKBOX_READ_ONLY:'1',CHANNEL_HEALTH_CHECKS:'0'
});
await build({configFile:'apps/web/vite.config.ts',build:{outDir:web}});
console.log('Plex preview: http://localhost:3012');
await import('../apps/server/src/index.js');
