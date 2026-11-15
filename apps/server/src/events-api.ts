import type {FastifyInstance} from 'fastify';
import {viewer} from './modules/access.js';
import type {PlexGrant} from './providers/plex.js';

// Changes open pages should pick up without a reload, sent down one server-sent events stream per page. Only names
// what changed; pages read the details again through the usual API, with the viewer's own access. An event for one
// account (`requests`: one of their requests changed; `notifications`: their bell changed) goes only to that account's
// pages, and one for 'admins' to every admin's pages.
// 'downloads': tk.box's library moved a grab on (admins only; Admin › Downloads reads it in phase 1c).
export type ClientEvent='library'|'requests'|'notifications'|'downloads';
const HEARTBEAT_MS=25000;

export class ClientEvents {
  private listeners=new Set<{account:string;admin:boolean;send:(event:ClientEvent)=>void}>();
  subscribe(account:string,send:(event:ClientEvent)=>void,admin=false) {const entry={account,admin,send};this.listeners.add(entry);return()=>{this.listeners.delete(entry);};}
  // `to`: one account id, 'admins' for every admin's pages, or nobody named for every page.
  publish(event:ClientEvent,to?:string) {for(const listener of this.listeners)if(to===undefined||(to==='admins'?listener.admin:listener.account===to))listener.send(event);}
}

// Open streams never finish on their own, so shutting down ends them first: call the returned function then.
export function registerEvents(app:FastifyInstance,events:ClientEvents,isAdmin:(grant:PlexGrant)=>boolean=()=>false) {
  const open=new Set<()=>void>();
  app.get('/api/v1/events',{config:{access:'viewer'}},async(request,reply)=>{
    // Proxies must pass each event straight on rather than buffer the response (X-Accel-Buffering is nginx's switch).
    reply.hijack();
    const out=reply.raw;
    out.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-store','X-Accel-Buffering':'no','X-Content-Type-Options':'nosniff'});
    out.write('retry: 5000\n\n');
    const {grant}=viewer(request);
    const unsubscribe=events.subscribe(grant.accountId,event=>out.write(`event: ${event}\ndata: {}\n\n`),isAdmin(grant));
    // A comment line now and then keeps idle proxies from closing the stream.
    const heartbeat=setInterval(()=>out.write(': ping\n\n'),HEARTBEAT_MS);heartbeat.unref();
    const end=()=>{open.delete(end);clearInterval(heartbeat);unsubscribe();out.end();};
    open.add(end);request.raw.once('close',end);
  });
  return ()=>{for(const end of open)end();};
}
