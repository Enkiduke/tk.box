import Database from 'better-sqlite3';
import {spawn} from 'node:child_process';
import {createWriteStream,existsSync,mkdirSync,mkdtempSync,renameSync,rmSync,writeFileSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {pipeline} from 'node:stream/promises';

// npm run preview:sync: copies the server's state into the Plex preview (.local/plex-preview/data), so the preview shows
// exactly what the server holds. Read-only on the server: a consistent snapshot of the database is taken there with
// SQLite's online backup (tk.box keeps running), streamed down and deleted, and a few state files are read. Settings in
// .env: PREVIEW_SSH_HOST (an ssh alias with key login, default tkbox) and PREVIEW_REMOTE_DATA_DIR (the server's
// DATA_DIR). The server's secret.key comes too: the preview can't read saved tokens and keys without it, so treat
// .local/plex-preview like the server's own state.

// State files the pages read; the rest of the server's data folder (artwork assets, run configs) is left behind.
const FILES=['secret.key','client-id','cleanup/status.json','artwork/collections-state.json'];

if(existsSync('.env'))process.loadEnvFile('.env');
const host=process.env.PREVIEW_SSH_HOST||'tkbox',remote=process.env.PREVIEW_REMOTE_DATA_DIR??'';
if(!/^[\w.-]+$/.test(host))throw new Error('PREVIEW_SSH_HOST must be an ssh host alias.');
if(!/^\/[\w./-]+$/.test(remote)||remote.split('/').includes('..'))throw new Error('Set PREVIEW_REMOTE_DATA_DIR in .env to the server\u2019s DATA_DIR (an absolute path).');

// Windows' own ssh can use the passphrase Windows keeps (ssh-agent); Git Bash's can't.
const windowsSsh='C:\\Windows\\System32\\OpenSSH\\ssh.exe';
const ssh=process.platform==='win32'&&existsSync(windowsSsh)?windowsSsh:'ssh';
function run(command:string,out?:NodeJS.WritableStream) {
  return new Promise<string>((done,fail)=>{
    const child=spawn(ssh,['-o','BatchMode=yes','-o','ConnectTimeout=15',host,command],{stdio:['ignore','pipe','pipe'],windowsHide:true});
    let text='',err='';
    const writing=out?pipeline(child.stdout,out):(child.stdout.on('data',d=>{text+=d;}),Promise.resolve());
    child.stderr.on('data',d=>{err+=d;});
    child.on('error',fail);
    child.on('close',code=>{void writing.then(()=>code===0?done(text):fail(new Error(`ssh ${host} failed (${code}): ${err.trim()||'no output'}`)),fail);});
  });
}

export async function syncPreview(root=resolve('.local/plex-preview')) {
  mkdirSync(root,{recursive:true,mode:0o700});
  const staging=mkdtempSync(join(root,'sync-')),started=Date.now();
  try {
    // The database, through SQLite's online backup on the server: consistent even while tk.box writes.
    const db=`${remote}/tk.box.sqlite`;
    await run(`set -e; umask 077; t=$(mktemp); trap 'rm -f "$t"' EXIT; sqlite3 '${db}' ".backup '$t'"; cat "$t"`,createWriteStream(join(staging,'tk.box.sqlite'),{mode:0o600}));
    const check=new Database(join(staging,'tk.box.sqlite'),{readonly:true,fileMustExist:true});
    try {
      const result=check.pragma('quick_check',{simple:true});
      if(result!=='ok')throw new Error(`The snapshot failed its check: ${String(result)}`);
    } finally {check.close();}
    // The state files, as base64 lines (one ssh call); a missing one is skipped.
    const listed=await run(`cd '${remote}' && for f in ${FILES.join(' ')}; do [ -f "$f" ] && printf '%s\\t%s\\n' "$f" "$(base64 -w0 "$f")"; done; true`);
    const got:string[]=[];
    for(const line of listed.split('\n')){
      const [name,data]=line.split('\t');
      if(!name||data===undefined||!FILES.includes(name))continue;
      const to=join(staging,name);
      mkdirSync(dirname(to),{recursive:true,mode:0o700});
      writeFileSync(to,Buffer.from(data,'base64'),{mode:0o600});
      got.push(name);
    }
    if(!got.includes('secret.key'))throw new Error('The server\u2019s secret.key wasn\u2019t found; the preview couldn\u2019t read the snapshot without it.');
    // Sign-ins made in the preview carry over, so a sync doesn't sign you out. Both copies use the server's key.
    const data=join(root,'data'),old=join(root,`data-old-${Date.now()}`);
    let kept=0;
    if(existsSync(join(data,'tk.box.sqlite'))){
      const fresh=new Database(join(staging,'tk.box.sqlite'));
      try {
        fresh.prepare('ATTACH DATABASE ? AS prior').run(join(data,'tk.box.sqlite'));
        fresh.transaction(()=>{
          fresh.prepare('INSERT OR IGNORE INTO users(account_id) SELECT account_id FROM prior.sessions WHERE expires > ?').run(Date.now());
          kept=fresh.prepare('INSERT OR IGNORE INTO sessions SELECT * FROM prior.sessions WHERE expires > ?').run(Date.now()).changes;
        })();
        fresh.prepare('DETACH DATABASE prior').run();
      } catch(e){console.warn(`Preview sign-ins couldn’t be kept (${(e as Error).message}); sign in again.`);}
      finally {fresh.close();}
    }
    // Swap it in whole; the preview's cache and built web files stay.
    if(existsSync(data))renameSync(data,old);
    renameSync(staging,data);
    rmSync(old,{recursive:true,force:true});
    console.log(`Preview synced from ${host} in ${((Date.now()-started)/1000).toFixed(1)} s (${got.length} state files, ${kept} preview sign-ins kept).`);
  } finally {
    rmSync(staging,{recursive:true,force:true});
  }
}

if(process.argv[1]&&resolve(process.argv[1])===resolve('scripts/preview-sync.ts'))await syncPreview();
