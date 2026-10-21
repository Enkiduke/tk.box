import { z } from 'zod';

// Plex Media Server's notification feed: a websocket Plex pushes library changes down as they happen. It's how Tautulli
// spots newly added titles, and tk.box opens it itself, so Plex needs no way to reach tk.box. After a drop it reconnects,
// quickly at first and then every few minutes; while `open` has nothing to connect with (no Plex admin token,
// nothing watching) it asks again each minute. Each connection reports 'any' once open, for what a drop may have missed.
const RETRY_MS = 5000, MAX_RETRY_MS = 5 * 60000, WAIT_MS = 60000, CONNECT_MS = 15000;

const message = z.object({ NotificationContainer: z.object({
  type: z.string(),
  TimelineEntry: z.array(z.object({ identifier: z.string().optional(), sectionID: z.coerce.string().optional(), type: z.number().optional(), state: z.number().optional() })).optional(),
  ActivityNotification: z.array(z.object({ event: z.string().optional(), Activity: z.object({ type: z.string().optional() }).optional() })).optional()
}) });
export type Finished = Set<string> | 'any';

// The library sections in which a movie, show, season or episode just finished processing (timeline state 5), or 'any'
// when a library scan ended. Plex's other notifications (playback, transcodes, its own tasks) give undefined.
export function finishedSections(data: string): Finished | undefined {
  let parsed;
  try { parsed = message.safeParse(JSON.parse(data)); } catch { return undefined; }
  if (!parsed.success) return undefined;
  const { type, TimelineEntry = [], ActivityNotification = [] } = parsed.data.NotificationContainer;
  if (type === 'activity') return ActivityNotification.some(a => a.event === 'ended' && a.Activity?.type?.startsWith('library.update')) ? 'any' : undefined;
  if (type !== 'timeline') return undefined;
  const sections = new Set(TimelineEntry.filter(e => e.identifier === 'com.plexapp.plugins.library' && e.state === 5 && [1, 2, 3, 4].includes(e.type ?? 0)
    && e.sectionID && /^\d+$/.test(e.sectionID)).map(e => e.sectionID!));
  return sections.size ? sections : undefined;
}

export class PlexNotifications {
  private socket?: WebSocket;
  private timer?: NodeJS.Timeout;
  private closed = true;
  private delay = RETRY_MS;
  constructor(private open: () => Promise<WebSocket | undefined>, private onFinished: (sections: Finished) => void,
    private log: (message: string, detail: Record<string, unknown>) => void = () => {}) {}
  start() { if (!this.closed) return; this.closed = false; void this.connect(); }
  close() { this.closed = true; clearTimeout(this.timer); const socket = this.socket; this.socket = undefined; socket?.close(); }
  private async connect() {
    const socket = await this.open().catch((e: Error) => { this.log('plex notifications unavailable', { error: e.message }); return undefined; });
    if (this.closed) { socket?.close(); return; }
    if (!socket) return this.retry(WAIT_MS);
    this.socket = socket;
    // A connection that fails only errors, or never opens; a dropped one closes, and may error first. Each retries once.
    const dropped = () => {
      clearTimeout(opening);
      if (this.socket !== socket) return;
      this.socket = undefined; socket.close(); this.retry(this.delay); this.delay = Math.min(this.delay * 2, MAX_RETRY_MS);
    };
    const opening = setTimeout(dropped, CONNECT_MS); opening.unref();
    socket.addEventListener('open', () => { clearTimeout(opening); this.delay = RETRY_MS; this.onFinished('any'); });
    socket.addEventListener('message', event => {
      const found = typeof event.data === 'string' ? finishedSections(event.data) : undefined;
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
