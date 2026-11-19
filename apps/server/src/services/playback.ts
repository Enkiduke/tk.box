import type { Db } from '../persistence/database.js';
import type { PlexAdapter, PlexGrant } from '../providers/plex.js';
import { requireThat } from '../errors.js';
import { opaque } from '../security/vault.js';
import { PlaybackStore, type PlaybackRecord } from '../persistence/playback-store.js';

// direct: original file bytes; remux: Plex HLS with copied video; transcode: Plex HLS with a CPU video encode.
export type VodDelivery = 'direct' | 'remux' | 'transcode';
export type { PlaybackRecord };
export class PlaybackService {
  private store: PlaybackStore;
  constructor(db: Db, private plex: PlexAdapter) { this.store = new PlaybackStore(db); }
  createVod(sessionHash: string, ratingKey: string, startOffsetMs = 0, delivery: VodDelivery = 'direct') {
    // How many streams a viewer may hold is the playback session registry's (services/playback-sessions.ts).
    const id = opaque();
    this.store.insert({ id, session_hash: sessionHash, mode: 'plex_vod', rating_key: ratingKey, expires: Date.now() + 2 * 60 * 60 * 1000 });
    return { id, mode: 'plex_vod' as const, startOffsetMs, delivery, streamUrl: `/api/v1/playback/sessions/${id}/${delivery === 'direct' ? 'file' : 'hls/start.m3u8'}` };
  }
  owned(id: string, sessionHash: string) {
    const s = this.store.owned(id, sessionHash, Date.now());
    requireThat(s, 'SESSION_NOT_FOUND', 'Playback session is unavailable.', 404); return s;
  }
  async progress(id: string, sessionHash: string, grant: PlexGrant, timeMs: number, state: 'playing' | 'paused' | 'stopped') {
    const s = this.owned(id, sessionHash);
    requireThat(s.mode === 'plex_vod', 'HISTORY_WRITE_FORBIDDEN', 'Only on-demand playback can update Plex history.', 403);
    const item = await this.plex.metadata(grant, s.rating_key);
    requireThat(timeMs <= item.duration, 'INVALID_PROGRESS', 'Progress is beyond the media duration.');
    await this.plex.reportVod(grant, s.rating_key, timeMs, state, item.duration);
  }
  stop(id: string, hash: string) { this.owned(id, hash); this.store.delete(id); }
}
