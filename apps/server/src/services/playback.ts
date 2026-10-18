import type { Db } from '../persistence/database.js';
import type { PlexAdapter, PlexGrant } from '../providers/plex.js';
import { requireThat } from '../errors.js';
import { opaque } from '../security/vault.js';
import type { PlaybackMode } from '../../../../packages/contracts/src/index.js';

// direct: original file bytes; remux: Plex HLS with copied video; transcode: Plex HLS with a CPU video encode.
export type VodDelivery = 'direct' | 'remux' | 'transcode';
export type PlaybackRecord = { id: string; session_hash: string; mode: PlaybackMode; rating_key: string; expires: number };
export class PlaybackService {
  constructor(private db: Db, private plex: PlexAdapter) {}
  createVod(sessionHash: string, ratingKey: string, startOffsetMs = 0, delivery: VodDelivery = 'direct') {
    const {n} = this.db.prepare('SELECT count(*) AS n FROM playback_sessions WHERE session_hash=? AND expires>?').get(sessionHash, Date.now()) as {n: number};
    requireThat(n < 20, 'PLAYBACK_SESSION_LIMIT', 'Too many active playback sessions. Stop an existing session first.', 429);
    const id = opaque();
    this.db.prepare('INSERT INTO playback_sessions VALUES(?,?,?,?,?)').run(id, sessionHash, 'plex_vod', ratingKey, Date.now() + 2 * 60 * 60 * 1000);
    return { id, mode: 'plex_vod' as const, startOffsetMs, delivery, streamUrl: `/api/v1/playback/sessions/${id}/${delivery === 'direct' ? 'file' : 'hls/start.m3u8'}` };
  }
  owned(id: string, sessionHash: string) {
    const s = this.db.prepare('SELECT * FROM playback_sessions WHERE id=? AND session_hash=? AND expires>?').get(id, sessionHash, Date.now()) as PlaybackRecord | undefined;
    requireThat(s, 'SESSION_NOT_FOUND', 'Playback session is unavailable.', 404); return s;
  }
  async progress(id: string, sessionHash: string, grant: PlexGrant, timeMs: number, state: 'playing' | 'paused' | 'stopped') {
    const s = this.owned(id, sessionHash);
    requireThat(s.mode === 'plex_vod', 'HISTORY_WRITE_FORBIDDEN', 'Only on-demand playback can update Plex history.', 403);
    const item = await this.plex.metadata(grant, s.rating_key);
    requireThat(timeMs <= item.duration, 'INVALID_PROGRESS', 'Progress is beyond the media duration.');
    await this.plex.reportVod(grant, s.rating_key, timeMs, state, item.duration);
  }
  stop(id: string, hash: string) { this.owned(id, hash); this.db.prepare('DELETE FROM playback_sessions WHERE id=?').run(id); }
}
