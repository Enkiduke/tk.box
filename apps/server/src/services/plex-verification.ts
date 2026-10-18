import {AppError, requireThat} from '../errors.js';
import type {PlexAdapter, PlexMetadata} from '../providers/plex.js';

const history = (m: PlexMetadata) => ({viewOffset: m.viewOffset ?? null, viewCount: m.viewCount ?? null, lastViewedAt: m.lastViewedAt ?? null});
export async function verifyPlexAccess(plex: PlexAdapter, tokens: {owner: string; viewer: string; unauthorized: string}) {
  const owner = await plex.authorize(tokens.owner), viewer = await plex.authorize(tokens.viewer);
  requireThat(owner.role === 'admin' && viewer.role === 'viewer' && owner.accountId !== viewer.accountId, 'LIVE_TEST_ACCOUNTS', 'Supply distinct owner and shared-viewer accounts.');
  let rejected = false;
  try {await plex.authorize(tokens.unauthorized);} catch(e) {if (e instanceof AppError && e.code === 'PLEX_ACCESS_DENIED') rejected = true; else throw e;}
  requireThat(rejected, 'LIVE_TEST_UNAUTHORIZED_ADMITTED', 'The unauthorized test account was admitted.', 500);
  return {owner, viewer};
}
// Read-only transport experiment. Never sends timeline/scrobble or attempts to restore state.
export async function verifyPlexReadIsolation(plex: PlexAdapter, accountToken: string, ratingKey: string, options: {signal: AbortSignal; maxBytes: number; settle?: () => Promise<void>}) {
  const grant = await plex.authorize(accountToken), before = await plex.metadata(grant, ratingKey);
  const response = await plex.directPart(grant,before,undefined,options.signal);
  requireThat(response.status === 200 && response.body, 'LIVE_TEST_INCOMPLETE_STREAM', 'Full source delivery was not available.', 502);
  const expected = response.headers.get('content-length'); let bytes = 0;
  const reader = response.body.getReader();
  try {
    while (true) {
      options.signal.throwIfAborted(); const chunk = await reader.read(); if(chunk.done) break;
      bytes += chunk.value.length;
      requireThat(bytes <= options.maxBytes, 'LIVE_TEST_BYTE_LIMIT', 'Media exceeds the configured test byte budget.', 413);
    }
  } finally {await reader.cancel().catch(()=>{});reader.releaseLock();}
  requireThat(bytes > 0 && (!expected || bytes === Number(expected)), 'LIVE_TEST_INCOMPLETE_STREAM', 'Media did not reach verified EOF.', 502);
  await options.settle?.();
  const freshGrant = await plex.authorize(accountToken), after = await plex.metadata(freshGrant,ratingKey);
  const beforeState = history(before), afterState = history(after);
  requireThat(JSON.stringify(beforeState) === JSON.stringify(afterState), 'PLEX_HISTORY_MUTATED', 'Read-only delivery changed Plex history. Do not enable custom-channel playback.', 500);
  return {completedRead: true, historyUnchanged: true, bytesRead: bytes, reportedHistoryFields: Object.entries(beforeState).filter(([,v])=>v!==null).map(([key])=>key),
    limitation: 'Verifies authorized original-part EOF delivery only; not paced playback, VOD writes, custom playout, or delayed Plex updates beyond the settle interval.'};
}
