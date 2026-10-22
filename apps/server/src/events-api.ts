import type {FastifyInstance,FastifyRequest} from 'fastify';

// Changes open pages should pick up without a reload, sent down one server-sent events stream per page. Only names
// what changed; pages read the details again through the usual API, with the viewer's own access.
export type ClientEvent='library';
const HEARTBEAT_MS=25000;

export class ClientEvents {
  private listeners=new Set<(event:ClientEvent)=>void>();
  subscribe(listener:(event:ClientEvent)=>void) {this.listeners.add(listener);return()=>{this.listeners.delete(listener);};}
  publish(event:ClientEvent) {for(const listener of this.listeners)listener(event);}
}

export function registerEvents(app:FastifyInstance,events:ClientEvents,auth:(request:FastifyRequest)=>Promise<unknown>) {
  // Open streams never finish on their own, so shutting down ends them first.
  const open=new Set<()=>void>();
  app.addHook('preClose',async()=>{for(const end of open)end();});
  app.get('/api/v1/events',async(request,reply)=>{
    await auth(request);
    // Proxies must pass each event straight on rather than buffer the response (X-Accel-Buffering is nginx's switch).
    reply.hijack();
    const out=reply.raw;
    out.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-store','X-Accel-Buffering':'no','X-Content-Type-Options':'nosniff'});
    out.write('retry: 5000\n\n');
    const unsubscribe=events.subscribe(event=>out.write(`event: ${event}\ndata: {}\n\n`));
    // A comment line now and then keeps idle proxies from closing the stream.
    const heartbeat=setInterval(()=>out.write(': ping\n\n'),HEARTBEAT_MS);heartbeat.unref();
    const end=()=>{open.delete(end);clearInterval(heartbeat);unsubscribe();out.end();};
    open.add(end);request.raw.once('close',end);
  });
}
