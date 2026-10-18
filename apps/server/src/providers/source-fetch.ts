import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { gunzipSync } from 'node:zlib';
import { z } from 'zod';
import { AppError, requireThat } from '../errors.js';

export const sourceEndpoint = z.object({
  url: z.string().url().max(8192),
  headers: z.record(z.string(), z.string().max(8192)).default({}),
  allowInsecureHttp: z.boolean().default(false)
}).strict();
export type SourceEndpoint = z.infer<typeof sourceEndpoint>;
const MAX = 16 * 1024 * 1024;
const blocked = new BlockList();
for (const [ip, prefix] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.88.99.0',24],['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',3]] as const) blocked.addSubnet(ip,prefix,'ipv4');
// Permit native global unicast IPv6 only, excluding protocol assignments,
// documentation and 6to4. This also excludes mapped IPv4, NAT64 and link-local.
for (const [ip,prefix] of [['2001::',23],['2001:db8::',32],['2002::',16],['3fff::',20]] as const) blocked.addSubnet(ip,prefix,'ipv6');
const globalV6 = new BlockList(); globalV6.addSubnet('2000::',3,'ipv6');
export function publicAddress(address: string) {
  const family = isIP(address);
  return family === 4 ? !blocked.check(address,'ipv4') : family === 6 && globalV6.check(address,'ipv6') && !blocked.check(address,'ipv6');
}
export function validateEndpoint(input: SourceEndpoint): SourceEndpoint {
  const endpoint = sourceEndpoint.parse(input), url = new URL(endpoint.url);
  requireThat((url.protocol === 'https:' || (url.protocol === 'http:' && endpoint.allowInsecureHttp)) && !url.username && !url.password && !url.hash,
    'SOURCE_ENDPOINT_REJECTED','Use an HTTPS source without userinfo or fragments; HTTP requires explicit administrator opt-in.');
  const headers: Record<string,string> = {};
  for (const [key,value] of Object.entries(endpoint.headers)) {
    const name = key.toLowerCase();
    requireThat(['authorization','user-agent','referer','accept'].includes(name) && !/[\r\n\0]/.test(value) && !(name in headers), 'SOURCE_HEADERS_REJECTED','Source headers are invalid or unsupported.');
    headers[name] = value;
  }
  return {...endpoint,url:url.href,headers};
}
type Address = {address: string; family: number};
export type SourceResponse = {status: number; headers: IncomingHttpHeaders; body: Buffer; complete: boolean};
export type SourceExchange = (url: URL, address: Address, headers: Record<string,string>, signal: AbortSignal) => Promise<SourceResponse>;

// No pooled socket, second DNS lookup, automatic redirect, environment proxy,
// or relaxed TLS verification. The URL retains Host/SNI/certificate identity.
export const exchangeSource: SourceExchange = (url,address,headers,signal) => new Promise((resolve,reject) => {
  const req = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
    agent:false, signal, headers:{...headers,'accept-encoding':'gzip'}, maxHeaderSize:16384,
    lookup: (_host,_options,callback) => callback(null,[{address:address.address,family:address.family}])
  }, res => {
    let length=0; const chunks:Buffer[]=[];
    res.on('data',(chunk:Buffer) => {
      length += chunk.length;
      if(length>MAX) {req.destroy(new AppError('IMPORT_LIMIT','Source exceeds import limit.'));return;}
      chunks.push(chunk);
    });
    res.on('error',reject);
    res.on('end',()=>resolve({status:res.statusCode ?? 0,headers:res.headers,body:Buffer.concat(chunks),complete:res.complete}));
  });
  req.on('error',reject); req.setTimeout(10000,()=>req.destroy(new AppError('SOURCE_TIMEOUT','Source request timed out.'))); req.end();
});
export class SourceFetchError extends AppError {
  constructor(code: string, public retryAt?: number) {super(code,'Source refresh could not be completed.',502);}
}
export class RestrictedSourceFetcher {
  constructor(private resolve: (host:string)=>Promise<Address[]> = host=>lookup(host,{all:true,verbatim:true}), private exchange:SourceExchange=exchangeSource) {}
  async fetch(input:SourceEndpoint, signal?:AbortSignal):Promise<Buffer> {
    const endpoint=validateEndpoint(input), initial=new URL(endpoint.url);
    const timeout=AbortSignal.timeout(30000), bounded=signal ? AbortSignal.any([signal,timeout]) : timeout;
    try {
      let url=initial;
      for(let redirects=0;redirects<=3;redirects++) {
        bounded.throwIfAborted();
        const host=url.hostname.replace(/^\[|\]$/g,'');
        // Race DNS against deadline as OS resolver cancellation is unavailable.
        const records=await abortable(isIP(host) ? Promise.resolve([{address:host,family:isIP(host)}]) : this.resolve(host),bounded);
        requireThat(records.length>0 && records.every(r=>publicAddress(r.address) && isIP(r.address)===r.family), 'SOURCE_ADDRESS_REJECTED','Source must resolve exclusively to public addresses.');
        const response=await abortable(this.exchange(url,records[0]!,endpoint.headers,bounded),bounded);
        if([301,302,303,307,308].includes(response.status)) {
          requireThat(redirects<3 && typeof response.headers.location==='string','SOURCE_REDIRECT_REJECTED','Source redirect rejected.');
          const next=new URL(response.headers.location,url);
          requireThat(next.origin===initial.origin && !next.username && !next.password && !next.hash,'SOURCE_REDIRECT_REJECTED','Only redirects within the approved source origin are allowed.');
          url=next; continue;
        }
        if(response.status===429 || response.status===503) {
          const raw=response.headers['retry-after']; let at=Date.now()+60000;
          if(typeof raw==='string') {const delta=/^\d+$/.test(raw) ? Date.now()+Number(raw)*1000 : Date.parse(raw);if(Number.isFinite(delta)) at=Math.max(at,Math.min(delta,Date.now()+7*86400000));}
          throw new SourceFetchError('SOURCE_RATE_LIMITED',at);
        }
        requireThat(response.status===200 && response.complete,'SOURCE_INCOMPLETE','Source did not return a complete successful snapshot.');
        const length=response.headers['content-length'];
        requireThat(response.body.length>0 && response.body.length<=MAX && (length===undefined || (typeof length==='string' && /^\d+$/.test(length) && Number(length)===response.body.length)), 'SOURCE_INCOMPLETE','Source length is invalid or incomplete.');
        const encoding=response.headers['content-encoding'];
        requireThat(encoding===undefined || encoding==='identity' || encoding==='gzip','SOURCE_ENCODING_REJECTED','Unsupported source compression.');
        const gzip=encoding==='gzip' || (response.body[0]===0x1f && response.body[1]===0x8b);
        const bytes=gzip ? gunzipSync(response.body,{maxOutputLength:MAX}) : response.body;
        new TextDecoder('utf-8',{fatal:true}).decode(bytes); return bytes;
      }
      throw new SourceFetchError('SOURCE_REDIRECT_REJECTED');
    } catch(e) {
      if(e instanceof AppError) throw e;
      throw new SourceFetchError(bounded.aborted ? 'SOURCE_TIMEOUT' : 'SOURCE_FETCH_FAILED');
    }
  }
}
async function abortable<T>(promise:Promise<T>,signal:AbortSignal):Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve,reject)=>{
    const abort=()=>reject(new SourceFetchError('SOURCE_TIMEOUT'));
    signal.addEventListener('abort',abort,{once:true});
    promise.then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));
  });
}
