import { loadConfig } from '../apps/server/src/config.js';
export const config = () => loadConfig({PLEX_MACHINE_ID: 'machine', PLEX_OWNER_ACCOUNT_ID: '1', PLEX_REQUIRED_LIBRARY_IDS: '10,20', PLEX_RECHECK_SECONDS: '0'});
export const metadata = {ratingKey: '42', librarySectionID: 10, title: 'Fixture movie', duration: 600000, type: 'movie', Media: [{container: 'mp4', videoCodec: 'h264', audioCodec: 'aac', width: 1920, height: 1080, Part: [{key: '/library/parts/7/123/file.mp4'}]}]};
export function fakePlex(options: {accountId?: number; authorized?: boolean; missingLibrary?: boolean; file?: string} = {}) {
  const calls: {path: string; token: string | null; method: string}[] = [];
  const transport = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url)); const headers = new Headers(init?.headers);
    calls.push({path: u.pathname, token: headers.get('X-Plex-Token'), method: init?.method ?? 'GET'});
    const accountId = options.accountId ?? 2;
    let data: unknown;
    if (u.pathname === '/api/v2/pins') data = {id: 5, code: 'fixture-code', expiresIn: 600};
    else if (u.pathname === '/api/v2/pins/5') data = {id: 5, code: 'fixture-code', expiresIn: 600, authToken: 'fixture-account-token'};
    else if (u.pathname === '/api/v2/user') data = {id: accountId};
    else if (u.pathname === '/api/v2/friends') data = [{id: 2, title: 'Viewer', username: 'viewer'}];
    else if (u.pathname === '/api/v2/home/users') data = {users: [{id: 1, title: 'Owner'}, {id: 3, title: 'Kid', home: true}]};
    else if (u.pathname === '/api/v2/resources') data = options.authorized === false ? [] : [{clientIdentifier: 'machine', provides: 'server', owned: accountId === 1, accessToken: 'fixture-viewer-server-token'}];
    else if (u.pathname === '/identity') data = {MediaContainer: {machineIdentifier: 'machine'}};
    else if (u.pathname === '/library/sections') data = {MediaContainer: {Directory: [{key: '10', title: 'Movies', type: 'movie'}, ...(options.missingLibrary ? [] : [{key: '20', title: 'TV', type: 'show'}])]}};
    else if (u.pathname === '/library/metadata/42') data = {MediaContainer: {Metadata: [options.file ? {...metadata, Media: [{...metadata.Media[0]!, Part: [{...metadata.Media[0]!.Part[0]!, file: options.file}]}]} : metadata]}};
    else if (u.pathname === '/library/parts/7/123/file.mp4') return new Response(new Uint8Array([1,2,3]), {status: headers.has('Range') ? 206 : 200, headers: {'Content-Type':'video/mp4','Content-Length':'3','Accept-Ranges':'bytes',...(headers.has('Range') ? {'Content-Range':'bytes 0-2/3'} : {})}});
    else if (u.pathname === '/:/timeline') return new Response('', {status: 200});
    else throw new Error(`Unexpected fixture path ${u.pathname}`);
    return Response.json(data);
  }) as typeof fetch;
  return {transport, calls, options};
}
