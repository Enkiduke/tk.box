import { AppError } from '../errors.js';

export type RemoteResponse = { status: number; data: unknown; headers: Headers };
// One JSON request to a catalog service outside Plex (Seerr, Trakt). Any status is returned to the caller;
// only an unreachable service, a redirect or an oversized body throws. A User-Agent is sent: Trakt's firewall refuses requests without one.
export async function remoteJson(url: URL, init: { method?: string; headers?: Record<string, string>; body?: unknown }, service: string, transport: typeof fetch = fetch, timeoutMs = 15000, maxBytes = 4 * 1024 * 1024): Promise<RemoteResponse> {
  let response: Response;
  try {
    response = await transport(url, { method: init.method ?? 'GET', headers: { Accept: 'application/json', 'User-Agent': 'tk.box/0.0.1', ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...init.headers },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}), redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
  } catch { throw new AppError('CATALOG_UNAVAILABLE', `${service} could not be reached.`, 502); }
  if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); throw new AppError('CATALOG_UNAVAILABLE', `${service} redirected the request. Check its address.`, 502); }
  const chunks: Uint8Array[] = []; let size = 0;
  const reader = response.body?.getReader();
  if (reader) try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.length;
      if (size > maxBytes) { await reader.cancel(); throw new AppError('CATALOG_RESPONSE_LIMIT', `${service} sent too much data.`, 502); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const text = Buffer.concat(chunks).toString('utf8');
  let data: unknown;
  try { data = text ? JSON.parse(text) : undefined; } catch { data = undefined; }
  return { status: response.status, data, headers: response.headers };
}
// The message a service put in its error body, if it gave one.
export const remoteMessage = (data: unknown) => {
  const value = data && typeof data === 'object' ? (data as Record<string, unknown>).message ?? (data as Record<string, unknown>).error_description ?? (data as Record<string, unknown>).error : undefined;
  return typeof value === 'string' && value.length < 300 ? value : undefined;
};
