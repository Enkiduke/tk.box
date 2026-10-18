import {mkdir,readFile,writeFile,rename,unlink,stat,statfs} from 'node:fs/promises';
import {join} from 'node:path';
import {SegmentBuffer,type Segment} from './buffer.js';
import {requireThat} from '../errors.js';

type CachedFile={path:string;bytes:number;programId:string};
export class DiskSegments {
  readonly index:SegmentBuffer;
  private files=new Map<string,CachedFile>();
  private entries:Segment[]=[];
  private operation:Promise<unknown>=Promise.resolve();
  constructor(private root:string,private maxBytes:number,private retentionMs:()=>number,private freeFloorBytes=64*1024*1024,
    private freeBytes:()=>Promise<number>=async()=>{const s=await statfs(root);return s.bavail*s.bsize;}){
    this.index=new SegmentBuffer(maxBytes,retentionMs);
  }
  private serial<T>(fn:()=>Promise<T>):Promise<T>{const next=this.operation.then(fn,fn);this.operation=next.catch(()=>{});return next;}
  get bytes(){return [...this.files.values()].reduce((n,f)=>n+f.bytes,0);}
  get fileCount(){return this.files.size;}
  async initialize(){await mkdir(this.root,{recursive:true,mode:0o700});}
  private async discard(removed:Segment[]){
    for(const segment of removed){
      const file=this.files.get(segment.uri);if(file){await unlink(file.path);this.files.delete(segment.uri);}
      this.entries=this.entries.filter(s=>s.id!==segment.id);
    }
    for(const [uri,file] of this.files){if(!this.entries.some(s=>s.uri===uri||s.initUri===uri)){await unlink(file.path);this.files.delete(uri);}}
  }
  private async evictFirst(){
    const first=this.entries[0];if(!first)return false;
    // SegmentBuffer eviction uses its own clock-independent reset below to keep both indexes aligned.
    await this.discard([first]);this.rebuild();return true;
  }
  private rebuild(){
    // Rebuild is bounded by the small retained segment count, and never changes viewer cursors.
    this.index.replace(this.entries);
  }
  publish(segment:Segment,mediaPath:string,initPath?:string){return this.serial(async()=>{
    requireThat(/^s-\d+\.(m4s|ts)$/.test(segment.uri)&&(!segment.initUri||/^init-\d+\.mp4$/.test(segment.initUri)),'INVALID_SEGMENT','Invalid cache filename.');
    requireThat(!this.entries.some(s=>s.sequence===segment.sequence),'DUPLICATE_SEGMENT','Segment was already published.',409);
    const media=await stat(mediaPath);const init=segment.initUri?await stat(initPath!):undefined;
    requireThat(media.size===segment.bytes&&media.size>0,'INVALID_SEGMENT','Segment size mismatch.');
    requireThat(media.size+(init?.size??0)<=this.maxBytes,'SEGMENT_QUOTA','One segment exceeds the disk cache quota.',507);
    await this.pruneInternal(segment.end);
    const needed=()=>media.size+(init&&segment.initUri&&!this.files.has(segment.initUri)?init.size:0);
    while(this.bytes+needed()>this.maxBytes||await this.freeBytes()-needed()<this.freeFloorBytes){if(!await this.evictFirst())requireThat(false,'SEGMENT_DISK_PRESSURE','Insufficient safe disk space for buffering.',507);}
    const added:string[]=[];
    try{
      for(const [uri,path,bytes] of [[segment.uri,mediaPath,media.size],...(init&&segment.initUri&&!this.files.has(segment.initUri)?[[segment.initUri,initPath!,init.size] as const]:[])] as const){
        const dest=join(this.root,uri);await writeFile(dest+'.part',await readFile(path),{flag:'wx',mode:0o600});await rename(dest+'.part',dest);
        this.files.set(uri,{path:dest,bytes,programId:segment.programId});added.push(uri);
      }
      this.entries.push(segment);this.index.replace(this.entries);
    }catch(e){for(const uri of added){await unlink(this.files.get(uri)!.path).catch(()=>{});this.files.delete(uri);}await unlink(join(this.root,segment.uri)+'.part').catch(()=>{});if(segment.initUri)await unlink(join(this.root,segment.initUri)+'.part').catch(()=>{});throw e;}
  });}
  private async pruneInternal(now:number){await this.discard(this.entries.filter(s=>s.end<=now-this.retentionMs()));this.rebuild();}
  prune(now:number){return this.serial(()=>this.pruneInternal(now));}
  available(now:number){return this.entries.filter(s=>s.end<=now);}
  read(uri:string,now:number,authorize:(programId:string)=>Promise<void>){return this.serial(async()=>{
    await this.pruneInternal(now);const file=this.files.get(uri);requireThat(file,'BUFFER_EXPIRED','Segment is no longer retained.',410);
    await authorize(file.programId);return {bytes:await readFile(file.path),type:uri.endsWith('.ts')?'video/mp2t':'video/mp4'};
  });}
  clear(){return this.serial(async()=>{await this.discard([...this.entries]);this.index.replace([]);});}
}
