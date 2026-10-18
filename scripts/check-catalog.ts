import Database from 'better-sqlite3';
import {readFileSync} from 'node:fs';
import {mkdir,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {ZodError} from 'zod';
import {loadConfig} from '../apps/server/src/config.js';
import {Vault} from '../apps/server/src/security/vault.js';
import {PlexAdapter} from '../apps/server/src/providers/plex.js';
import {AppError,requireThat} from '../apps/server/src/errors.js';

try {
  const config=loadConfig(),db=new Database(join(config.DATA_DIR,'tk.box.sqlite'),{readonly:true});
  let row:{hash:string;encrypted_credential:string}|undefined;
  try {row=db.prepare('SELECT hash,encrypted_credential FROM sessions WHERE account_id=? AND expires>? ORDER BY expires DESC LIMIT 1').get(config.PLEX_OWNER_ACCOUNT_ID??'',Date.now()) as typeof row;}finally{db.close();}
  requireThat(row,'BROWSER_LOGIN_REQUIRED','Sign in to tk.box with the owner account before this local read-only catalog check.');
  const vault=new Vault(readFileSync(config.SECRET_KEY_FILE??join(config.DATA_DIR,'secret.key'))),plex=new PlexAdapter(config,readFileSync(join(config.DATA_DIR,'client-id'),'utf8').trim());
  const grant=await plex.authorize(vault.open(row.encrypted_credential,row.hash));requireThat(grant.role==='admin','PLEX_OWNER_REQUIRED','Owner session required.');
  const checks:Record<string,unknown>[]=[];
  for(const library of grant.libraries.filter(l=>['movie','show'].includes(l.type))) {
    const page=await plex.catalogPage(grant,library.key,{limit:3}),recent=await plex.catalogPage(grant,library.key,{limit:3,shelf:'recent'}),ongoing=await plex.catalogPage(grant,library.key,{limit:3,shelf:'continue'}),genres=await plex.catalogGenres(grant,library.key),unwatched=await plex.catalogPage(grant,library.key,{limit:3,shelf:'unwatched'});
    const result:Record<string,unknown>={type:library.type,total:page.total,browsed:page.items.length,recent:recent.items.length,continueWatching:ongoing.items.length,genres:genres.genres.length,unwatched:unwatched.items.length};
    if(genres.genres[0]){const filtered=await plex.catalogPage(grant,library.key,{limit:3,genre:genres.genres[0].id});result.genreFiltered=filtered.items.length;}
    if(page.items[0]) {
      const item=await plex.catalogItem(grant,page.items[0].id),search=await plex.catalogPage(grant,library.key,{limit:3,q:item.title});
      requireThat(search.items.some(c=>c.id===item.id),'CATALOG_SEARCH_MISMATCH','Known title was not returned by scoped search.');result.details=true;result.search=true;
      if(item.posterUrl){result.artworkBytes=(await plex.artwork(grant,item.id,'poster')).bytes.length;}
      if(item.type==='show') {
        const seasons=await plex.catalogChildren(grant,item.id,{limit:3});result.seasons=seasons.items.length;
        if(seasons.items[0]){const episodes=await plex.catalogChildren(grant,seasons.items[0].id,{limit:3});result.episodes=episodes.items.length;if(episodes.items[0]){await plex.catalogItem(grant,episodes.items[0].id);result.episodeDetails=true;}}
      }
    }
    checks.push(result);
  }
  const report={generatedAt:new Date().toISOString(),checks,mediaRead:false,watchHistoryWrites:false,limitation:'Read-only owner catalog verification; not proof of viewer isolation, media decoding, playback or watched-state synchronization.'};
  const root=resolve('.local/catalog-verification');await mkdir(root,{recursive:true,mode:0o700});await writeFile(join(root,'report.json'),JSON.stringify(report,null,2),{mode:0o600});console.log(JSON.stringify(report,null,2));
}catch(error){console.error(JSON.stringify({code:error instanceof AppError?error.code:'CATALOG_CHECK_FAILED',fields:error instanceof ZodError?error.issues.map(i=>({field:i.path.join('.'),code:i.code})):undefined}));process.exitCode=1;}
