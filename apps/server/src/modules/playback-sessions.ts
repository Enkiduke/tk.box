import { defineModule } from './module.js';
import { PlaybackSessions, type Session } from '../services/playback-sessions.js';
import { every, errorDetail, type Repeating } from '../lib/every.js';

const media = (s: Session) => s.kind === 'vod' ? s.mediaId : s.channelId;

// The one registry of playback sessions (services/playback-sessions.ts): VOD, IPTV and custom channels open, touch and
// end their sessions in it. It owns the idle rule and the per-viewer limit, and announces `session.started` /
// `session.ended`, which watch history hears; Admin › Activity reads its rows. Mounted before watch history, Activity
// and the playback modules, so its sign-out listener ends a browser's sessions before watch history closes the rest.
// Its sweep only ends sessions in memory, so it runs in the preview too.
export const playbackSessionsModule = defineModule({
  name: 'playback-sessions',
  setup(_routes, { bus, log }) {
    const sessions = new PlaybackSessions(undefined, undefined, (message, detail) => log.warn(message, detail));
    sessions.onStarted = s => bus.emit('session.started', { id: s.id, kind: s.kind, hash: s.hash, accountId: s.accountId, media: media(s), history: s.history });
    sessions.onEnded = (s, reason) => bus.emit('session.ended', { id: s.id, kind: s.kind, hash: s.hash, accountId: s.accountId, media: media(s), reason });
    // Sign-out: everything that browser session was watching stops.
    bus.on('session.signed-out', ({ hash }) => sessions.endOwner(hash, 'revoked'));
    let sweep: Repeating | undefined;
    return {
      api: sessions,
      start() { sweep = every(5000, () => sessions.sweep(), e => log.warn('playback session sweep failed', errorDetail(e))); },
      stop() { sweep?.stop(); }
    };
  }
});
