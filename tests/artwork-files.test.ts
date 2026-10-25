import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdirSync,mkdtempSync,readFileSync,readdirSync,writeFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ArtworkFiles,imageSize} from '../apps/server/src/services/artwork-files.js';
import {ArtworkPictures} from '../apps/server/src/services/artwork-pictures.js';

const png=(w:number,h:number)=>{const b=Buffer.alloc(33);b.writeUInt32BE(0x89504e47,0);b.writeUInt32BE(0x0d0a1a0a,4);b.writeUInt32BE(13,8);b.write('IHDR',12,'latin1');b.writeUInt32BE(w,16);b.writeUInt32BE(h,20);return b;};
const jpeg=(w:number,h:number)=>Buffer.from([0xff,0xd8,0xff,0xe0,0,4,0,0,0xff,0xc0,0,11,8,h>>8,h&255,w>>8,w&255,3,0,0,0xff,0xd9]);
const hash=(data:Buffer)=>createHash('sha256').update(data).digest('hex').slice(0,8);
function setup(){
  const base=mkdtempSync(join(tmpdir(),'tk-artwork-')),root=join(base,'assets'),cache=join(base,'cache');
  mkdirSync(cache,{recursive:true});
  const title=join(root,'movies','Alien (1979) {tmdb-348}');mkdirSync(title,{recursive:true});
  writeFileSync(join(title,'.artwork.json'),JSON.stringify({type:'movie',title:'Alien',year:'1979',tmdb_id:348,imdb_id:'tt0078748',rating_key:'10'}));
  writeFileSync(join(base,'config.json'),'{}');
  return {base,root,cache,title,files:new ArtworkFiles(root,cache,join(base,'config.json'))};
}

test('image sizes are read from PNG and JPEG headers',()=>{
  assert.deepEqual(imageSize(png(1000,1500)),[1000,1500]);
  assert.deepEqual(imageSize(jpeg(1920,1080)),[1920,1080]);
  assert.equal(imageSize(Buffer.from('not an image')),undefined);
});

test('picking a candidate keeps the one it replaces beside it and notes the title as not pushed',async()=>{
  const {title,files,cache}=setup(),old=png(1000,1500),next=png(800,1200);
  writeFileSync(join(title,'poster.png'),old);writeFileSync(join(title,'poster2.png'),next);
  const id='movies/Alien (1979) {tmdb-348}';
  assert.deepEqual(await files.select(id,'poster',  'poster2.png'),{warning:null});
  assert.deepEqual(readFileSync(join(title,'poster.png')),next);
  assert.deepEqual(readFileSync(join(title,`poster-${hash(old)}.png`)),old);
  assert.ok(!existsSync(join(title,'poster2.png')));
  const pending=JSON.parse(readFileSync(join(cache,'web_pending.json'),'utf8'));
  assert.deepEqual(pending[id],{title:'Alien',before:{[`${id}|poster`]:`poster-${hash(old)}.png`}});
  // A later pick keeps the first "before": Discard goes back to what was pushed
  await files.select(id,'poster',`poster-${hash(old)}.png`);
  assert.equal(JSON.parse(readFileSync(join(cache,'web_pending.json'),'utf8'))[id].before[`${id}|poster`],`poster-${hash(old)}.png`);
  const detail=await files.detail(id);
  assert.equal(detail.sections[0]!.poster?.size,'1000×1500');assert.equal(detail.sections[0]!.posters.length,1);
  await assert.rejects(files.select(id,'poster','poster.png'),{message:'Not a candidate file'});
  await assert.rejects(files.select('movies/../../etc','poster','poster2.png'),{message:'Unknown path'});
});

test('turning a title’s logo off, then picking a logo, turns it back on',async()=>{
  const {title,files}=setup(),id='movies/Alien (1979) {tmdb-348}';
  writeFileSync(join(title,'logo.png'),png(10,10));writeFileSync(join(title,'logo2.png'),png(20,10));
  await files.noLogo(id,true);
  assert.equal(JSON.parse(readFileSync(join(title,'.artwork.json'),'utf8')).no_logo,true);
  await files.select(id,'logo','logo2.png');
  assert.equal('no_logo' in JSON.parse(readFileSync(join(title,'.artwork.json'),'utf8')),false);
  const {pending}=await files.state(true);
  assert.equal(pending[id]!.before![`${id}|nologo`],false);
});

test('a thumbnail the engine made is found by its name; one it hasn’t made yet is named for it',async()=>{
  const {title,files,cache}=setup();
  writeFileSync(join(title,'poster.png'),png(1000,1500));
  const first=await files.thumbnail('movies/Alien (1979) {tmdb-348}/poster.png',300);
  assert.equal(first.bytes,undefined);assert.match(first.key,/^[0-9a-f]{64}$/);
  mkdirSync(join(cache,'thumbs'));writeFileSync(join(cache,'thumbs',`${first.key}.jpg`),'small');
  const second=await files.thumbnail('movies/Alien (1979) {tmdb-348}/poster.png',300);
  assert.equal(second.type,'image/jpeg');assert.equal(String(second.bytes),'small');
});

test('a push finds a title again by its TMDb ID when Plex has given it a new Plex ID',async()=>{
  const {title,files}=setup(),asked:string[]=[];
  const plex=async(path:string)=>{asked.push(path);
    if(path==='/library/metadata/10')return {status:404,data:undefined};
    return {status:200,data:{MediaContainer:{totalSize:2,Metadata:[{ratingKey:'77',Guid:[{id:'tmdb://999'}]},{ratingKey:'88',Guid:[{id:'imdb://tt0078748'},{id:'tmdb://348'}]}]}}};};
  const [job]=await files.push(['movies/Alien (1979) {tmdb-348}'],false,plex,[{key:'1',type:'movie'},{key:'2',type:'show'}]);
  assert.deepEqual(job!.args,['--item','88','--changed-only']);
  assert.equal(JSON.parse(readFileSync(join(title,'.artwork.json'),'utf8')).rating_key,'88');
  assert.ok(!asked.some(p=>p.includes('/sections/2/')));  // Only libraries of its kind are read
  assert.deepEqual(readdirSync(title).filter(n=>n.endsWith('.tmp')),[]);
});

test('online pictures put textless ones first, then by language and size, and a failing provider becomes a note',async()=>{
  const transport=(async(input:URL|RequestInfo)=>{
    const url=String(input);
    if(url.startsWith('https://api.themoviedb.org/3/movie/348'))return Response.json({external_ids:{imdb_id:'tt0078748'},images:{posters:[
      {file_path:'/fr.jpg',iso_639_1:'fr',width:2000},{file_path:'/en.jpg',iso_639_1:'en',width:1000},{file_path:'/none.jpg',iso_639_1:null,width:500}],logos:[]}});
    if(url.startsWith('https://webservice.fanart.tv'))return new Response('down',{status:503});
    return new Response('{}',{status:404});
  }) as typeof fetch;
  const pictures=new ArtworkPictures(()=>({tmdb:'k',fanart:'f'}),()=>'en',transport);
  const plex=async()=>({status:200,data:{MediaContainer:{Metadata:[{key:'/library/metadata/10/file?url=upload%3A%2F%2Fposters%2Fabc',thumb:'/x'}]}}});
  const {items,notes}=await pictures.list({type:'movie',tmdb_id:348,rating_key:'10'},null,'poster',plex);
  // Plex doesn't say which language or whether there's text: after your language and English, before the others
  assert.deepEqual(items.map(i=>i.provider+':'+(i.url??i.plex)),['tmdb:https://image.tmdb.org/t/p/original/none.jpg','tmdb:https://image.tmdb.org/t/p/original/en.jpg',
    'plex:/library/metadata/10/file?url=upload%3A%2F%2Fposters%2Fabc','tmdb:https://image.tmdb.org/t/p/original/fr.jpg']);
  assert.match(items[0]!.view,/^\/api\/v1\/admin\/artwork\/image\?u=https%3A%2F%2Fimage\.tmdb\.org%2Ft%2Fp%2Fw780%2Fnone\.jpg$/);
  assert.match(items[2]!.view,/^\/api\/v1\/admin\/artwork\/plex-image\?p=/);
  assert.deepEqual(notes,['fanart: Fanart.tv answered 503']);
});
