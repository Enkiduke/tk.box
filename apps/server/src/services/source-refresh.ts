import { IptvStore } from '../persistence/iptv-store.js';
import { RestrictedSourceFetcher, SourceFetchError } from '../providers/source-fetch.js';
import { requireThat } from '../errors.js';

// One application process owns the SQLite state and this registry. No detached
// work survives shutdown, and scheduled/manual requests share the same promise.
export class SourceRefresh {
  private running=new Map<string,Promise<ReturnType<IptvStore['ingest']>>>();
  private controllers=new Map<string,AbortController>();
  private abort=new AbortController();
  // Told about every successful import, e.g. to rematch sports events against the new channels.
  published:(id:string)=>void=()=>{};
  constructor(private store:IptvStore,private fetcher:Pick<RestrictedSourceFetcher,'fetch'>=new RestrictedSourceFetcher()) {}
  refresh(actor:string,id:string) {
    const active=this.running.get(id);if(active)return active;
    requireThat(!this.abort.signal.aborted,'REFRESH_STOPPED','Refresh service is stopped.',503);
    requireThat(this.running.size<4,'REFRESH_CAPACITY','Too many source refreshes are active.',429);
    const revision=this.store.begin(id),endpoint=this.store.endpoint(id);
    const controller=new AbortController(),signal=AbortSignal.any([this.abort.signal,controller.signal]);
    this.controllers.set(id,controller);
    // Defer the worker so the map exists even when a test transport resolves immediately.
    const work=Promise.resolve().then(async()=>{
      try {signal.throwIfAborted();const bytes=await this.fetcher.fetch(endpoint,signal);signal.throwIfAborted();const result=this.store.ingest(actor,id,revision,bytes);this.published(id);return result;}
      catch(error) {if(!signal.aborted)this.store.failed(id,revision,error instanceof SourceFetchError?error.retryAt:undefined);throw error;}
    }).finally(()=>{this.running.delete(id);this.controllers.delete(id);});
    this.running.set(id,work);return work;
  }
  active(id:string) {return this.running.has(id);}
  remove(actor:string,id:string,expectedRevision:number) {
    const result=this.store.remove(actor,id,expectedRevision);
    this.abortRemoved();
    return result;
  }
  removeGuide(actor:string,id:string,expectedRevision:number) {
    const result=this.store.removeGuide(actor,id,expectedRevision);
    this.abortRemoved();
    return result;
  }
  private abortRemoved() {
    const remaining=new Set(this.store.list().map(s=>s.id));
    for(const [id,controller] of this.controllers)if(!remaining.has(id))controller.abort();
  }
  async tick() {
    for(const id of this.store.due()) {
      if(this.running.size>=4&&!this.running.has(id))break;
      // Each failure is persisted as a sanitized diagnostic; never emit raw upstream errors.
      void this.refresh('system',id).catch(()=>{});
    }
  }
  async close() {this.abort.abort();await Promise.allSettled([...this.running.values()]);}
}
