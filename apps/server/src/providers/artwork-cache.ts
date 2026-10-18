type Image={type:string;bytes:Buffer};
// Only immutable image bytes live here. Callers must authorize and resolve the
// current metadata path before reading; this cache never stores access grants.
export class ArtworkCache {
  private entries=new Map<string,{image:Image;until:number}>();
  private size=0;
  constructor(private maxBytes=32*1024*1024,private maxEntries=256,private ttlMs=300000) {}
  get(key:string,now=Date.now()) {
    const entry=this.entries.get(key);if(!entry)return;
    this.entries.delete(key);
    if(entry.until<=now){this.size-=entry.image.bytes.length;return;}
    this.entries.set(key,entry);return entry.image;
  }
  set(key:string,image:Image,now=Date.now()) {
    const previous=this.entries.get(key);if(previous){this.size-=previous.image.bytes.length;this.entries.delete(key);}
    if(image.bytes.length>this.maxBytes)return;
    this.entries.set(key,{image,until:now+this.ttlMs});this.size+=image.bytes.length;
    while(this.size>this.maxBytes||this.entries.size>this.maxEntries){const oldest=this.entries.keys().next().value!;this.size-=this.entries.get(oldest)!.image.bytes.length;this.entries.delete(oldest);}
  }
}
