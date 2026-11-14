import type {FastifyInstance} from 'fastify';
import {viewer} from './modules/access.js';

// Changes open pages should pick up without a reload, sent down one server-sent events stream per page. Only names
// what changed; pages read the details again through the usual API, with the viewer's own access. An event for one
// account (`requests`: one of their requests changed) goes only to that account's pages.
export type ClientEvent='library'|'requests';
const HEARTBEAT_MS=25000;

export class ClientEvents {
  private listeners=new Set<{account:string;send:(event:ClientEvent)=>void}>();
  subscribe(account:string,send:(event:ClientEvent)=>void) {const entry={account,send};this.listeners.add(entry);return()=>{this.listeners.delete(entry);};}
  publish(event:ClientEvent,account?:string) {for(const listener of this.listeners)if(account===undefined||listener.account===account)listener.send(event);}
}

// Open streams never finish on their own, so shutting down ends them first: call the returned function then.
export function registerEvents(app:FastifyInstance,events:ClientEvents) {
  const open=new Set<()=>void>();
  app.get('/api/v1/events',{config:{access:'viewer'}},async(request,reply)=>{
    // Proxies must pass each event straight on rather than buffer the response (X-Accel-Buffering is nginx's switch).
    reply.hijack();
    const out=reply.raw;
    out.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-store','X-Accel-Buffering':'no','X-Content-Type-Options':'nosniff'});
    out.write('retry: 5000\n\n');
    const unsubscribe=events.subscribe(viewer(request).grant.accountId,event=>out.write(`event: ${event}\ndata: {}\n\n`));
    // A comment line now and then keeps idle proxies from closing the stream.
    const heartbeat=setInterval(()=>out.write(': ping\n\n'),HEARTBEAT_MS);heartbeat.unref();
    const end=()=>{open.delete(end);clearInterval(heartbeat);unsubscribe();out.end();};
    open.add(end);request.raw.once('close',end);
  });
  return ()=>{for(const end of open)end();};
}
