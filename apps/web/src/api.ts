export class ApiClientError extends Error {constructor(message:string,public code:string,public status:number){super(message);}}
export async function api<T>(path: string, method = 'GET', body?: unknown,signal?:AbortSignal): Promise<T> {
  const deadline=AbortSignal.timeout(30000);
  const r = await fetch(`/api/v1${path}`, {method, signal:signal?AbortSignal.any([signal,deadline]):deadline,credentials: 'same-origin', headers: method === 'GET' ? {} : {'Content-Type': 'application/json'}, ...(method === 'GET' ? {} : {body: JSON.stringify(body ?? {})})});
  // Empty (204) or non-JSON proxy errors must still surface as API errors.
  const data = r.status===204?{}:await r.json().catch(()=>({}));
  if (r.status===401&&sessionEnded&&!path.startsWith('/auth/')&&path!=='/me')sessionEnded();
  if (!r.ok) throw new ApiClientError(data.message ?? 'Request failed.',data.code??'REQUEST_FAILED',r.status);
  return data as T;
}

// A file sent as its own bytes (application/octet-stream) to a route that takes one, with its other inputs in the address.
export async function apiFile<T>(path: string, query: Record<string,string>, file: Blob): Promise<T> {
  const r = await fetch(`/api/v1${path}?${new URLSearchParams(query)}`, {method:'POST', signal:AbortSignal.timeout(120000), credentials:'same-origin', headers:{'Content-Type':'application/octet-stream'}, body:file});
  const data = r.status===204?{}:await r.json().catch(()=>({}));
  if (r.status===401&&sessionEnded)sessionEnded();
  if (!r.ok) throw new ApiClientError(data.message ?? 'Request failed.',data.code??'REQUEST_FAILED',r.status);
  return data as T;
}

// Told when a call comes back 401 while the page thinks it is signed in (the session ended elsewhere or expired).
let sessionEnded:(()=>void)|undefined;
export function onSessionEnded(handler:()=>void) {sessionEnded=handler;return()=>{if(sessionEnded===handler)sessionEnded=undefined;};}
