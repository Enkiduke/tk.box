export class ApiClientError extends Error {constructor(message:string,public code:string,public status:number){super(message);}}
export async function api<T>(path: string, method = 'GET', body?: unknown,signal?:AbortSignal): Promise<T> {
  const deadline=AbortSignal.timeout(30000);
  const r = await fetch(`/api/v1${path}`, {method, signal:signal?AbortSignal.any([signal,deadline]):deadline,credentials: 'same-origin', headers: method === 'GET' ? {} : {'Content-Type': 'application/json'}, ...(method === 'GET' ? {} : {body: JSON.stringify(body ?? {})})});
  // Empty (204) or non-JSON proxy errors must still surface as API errors.
  const data = r.status===204?{}:await r.json().catch(()=>({}));
  if (!r.ok) throw new ApiClientError(data.message ?? 'Request failed.',data.code??'REQUEST_FAILED',r.status);
  return data as T;
}
