import type { Db } from './database.js';
import { prepared } from './statements.js';
import type { PlaybackMode } from '../../../../packages/contracts/src/index.js';

// On-demand playback sessions (core table playback_sessions, persistence/database.ts). Its SQL lives here only.
export type PlaybackRecord = { id: string; session_hash: string; mode: PlaybackMode; rating_key: string; expires: number };
export class PlaybackStore {
  constructor(private db: Db) {}
  insert(record: PlaybackRecord) {
    prepared(this.db, 'INSERT INTO playback_sessions(id, session_hash, mode, rating_key, expires) VALUES(?,?,?,?,?)')
      .run(record.id, record.session_hash, record.mode, record.rating_key, record.expires);
  }
  owned(id: string, sessionHash: string, now: number) {
    return prepared(this.db, 'SELECT * FROM playback_sessions WHERE id=? AND session_hash=? AND expires>?').get(id, sessionHash, now) as PlaybackRecord | undefined;
  }
  delete(id: string) { prepared(this.db, 'DELETE FROM playback_sessions WHERE id=?').run(id); }
  reap(now: number) { prepared(this.db, 'DELETE FROM playback_sessions WHERE expires<=?').run(now); }
}
