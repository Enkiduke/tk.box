import { z } from 'zod';

// Plex Media Server's notification feed: a websocket Plex pushes library changes down as they happen. It's how Tautulli
// spots newly added titles, and tk.box opens it itself, so Plex needs no way to reach tk.box. After a drop it reconnects,
// quickly at first and then every few minutes. While there is no Plex admin token it asks again each minute.
// Each connection reports 'any' once open, for what a drop may have missed.
const RETRY_MS = 5000, MAX_RETRY_MS = 5 * 60000, WAIT_MS = 60000, CONNECT_MS = 15000;

const message = z.object({ NotificationContainer: z.object({
  type: z.string(),
  TimelineEntry: z.array(z.object({ identifier: z.string().optional(), sectionID: z.coerce.string().optional(), type: z.number().optional(), state: z.number().optional() })).optional(),
  ActivityNotification: z.array(z.object({ event: z.string().optional(), Activity: z.object({ type: z.string().optional() }).optional() })).optional()
}) });
export type Finished = Set<string> | 'any';
const playbackState = z.object({
  sessionKey: z.coerce.string().regex(/^[\w-]{1,100}$/), ratingKey: z.coerce.string().regex(/^\d{1,40}$/),
  state: z.enum(['playing', 'paused', 'buffering', 'stopped', 'error']),
  viewOffset: z.union([z.number(), z.string().regex(/^\d+$/)]).transform(Number).pipe(z.number().int().nonnegative()).optional()
});
export type PlexPlaybackState = z.infer<typeof playbackState>;
const playbackEnvelope = z.object({ type: z.literal('playing'),
  PlaySessionStateNotification: z.array(z.unknown()).optional(), _children: z.array(z.unknown()).optional() });

function playbackStates(container: unknown): PlexPlaybackState[] {
  const parsed = playbackEnvelope.safeParse(container);
  if (!parsed.success) return [];
  return (parsed.data.PlaySessionStateNotification ?? parsed.data._children ?? []).slice(0, 256).flatMap(entry => {
    const state = playbackState.safeParse(entry);
    return state.success ? [state.data] : [];
  });
}

// The library sections in which a movie, show, season or episode just finished processing (timeline state 5), or 'any'
// when a library scan ended. Plex's other notifications (playback, transcodes, its own tasks) give undefined.
export function finishedSections(data: string): Finished | undefined {
  try { return sectionsFor(JSON.parse(data)); } catch { return undefined; }
}

function sectionsFor(value: unknown): Finished | undefined {
  const parsed = message.safeParse(value);
  if (!parsed.success) return undefined;
  const { type, TimelineEntry = [], ActivityNotification = [] } = parsed.data.NotificationContainer;
  if (type === 'activity') return ActivityNotification.some(a => a.event === 'ended' && a.Activity?.type?.startsWith('library.update')) ? 'any' : undefined;
  if (type !== 'timeline') return undefined;
  const sections = new Set(TimelineEntry.filter(e => e.identifier === 'com.plexapp.plugins.library' && e.state === 5 && [1, 2, 3, 4].includes(e.type ?? 0)
    && e.sectionID && /^\d+$/.test(e.sectionID)).map(e => e.sectionID!));
  return sections.size ? sections : undefined;
}

export function plexPlaybackStates(data: string): PlexPlaybackState[] {
  try {
    const value = JSON.parse(data);
    return playbackStates(value?.NotificationContainer ?? value);
  } catch { return []; }
}

export class PlexNotifications {
  private socket?: WebSocket;
  private timer?: NodeJS.Timeout;
  private opening?: NodeJS.Timeout;
  private generation = 0;
  private closed = true;
  private delay = RETRY_MS;
  constructor(private open: () => Promise<WebSocket | undefined>, private onFinished: (sections: Finished) => void,
    private log: (message: string, detail: Record<string, unknown>) => void = () => {},
    private playback?: { states: (rows: PlexPlaybackState[]) => void; connected: (open: boolean) => void }) {}
  start() { if (!this.closed) return; this.closed = false; void this.connect(); }
  close() { this.closed = true; this.generation++; clearTimeout(this.timer); clearTimeout(this.opening); const socket = this.socket; this.socket = undefined; socket?.close(); }
  reconnect() { this.close(); this.delay = RETRY_MS; this.playback?.connected(false); this.start(); }
  private async connect() {
    const generation = this.generation;
    const socket = await this.open().catch(() => { this.log('plex notifications unavailable', {}); return undefined; });
    if (this.closed || generation !== this.generation) { socket?.close(); return; }
    if (!socket) return this.retry(WAIT_MS);
    this.socket = socket;
    // A connection that fails only errors, or never opens; a dropped one closes, and may error first. Each retries once.
    const dropped = () => {
      clearTimeout(opening);
      if (this.socket !== socket) return;
      this.socket = undefined; socket.close(); this.playback?.connected(false); this.retry(this.delay); this.delay = Math.min(this.delay * 2, MAX_RETRY_MS);
    };
    const opening = this.opening = setTimeout(dropped, CONNECT_MS); opening.unref();
    socket.addEventListener('open', () => {
      if (this.socket !== socket) return;
      clearTimeout(opening); this.delay = RETRY_MS; this.onFinished('any'); this.playback?.connected(true);
    });
    socket.addEventListener('message', event => {
      if (this.socket !== socket || typeof event.data !== 'string' || event.data.length > 1024 * 1024) return;
      let value;
      try { value = JSON.parse(event.data); } catch { return; }
      const container = value?.NotificationContainer ?? value;
      if (container?.type === 'playing') {
        const states = this.playback && playbackStates(container);
        if (states?.length) this.playback?.states(states);
        return;
      }
      const found = sectionsFor(value);
      if (found) this.onFinished(found);
    });
    socket.addEventListener('close', dropped);
    socket.addEventListener('error', dropped);
  }
  private retry(ms: number) {
    if (this.closed) return;
    this.timer = setTimeout(() => void this.connect(), ms); this.timer.unref();
  }
}
