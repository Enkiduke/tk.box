import { randomUUID } from 'node:crypto';
import type { PlaybackObservation } from '../../../../packages/contracts/src/index.js';
import type { HistoryAiring, HistoryDay, HistoryEnd, HistorySession, HistoryStore, HistoryTarget, LiveAllocation } from '../persistence/history-store.js';
import { digest } from '../security/vault.js';

type Delivery = Pick<HistorySession, 'source' | 'accountId' | 'accountName' | 'media' | 'client' | 'stream'> & { id: string; owner: string };
type LiveObservation = { epoch: number; airings?: Airings; stream?: HistorySession['stream']; replacing?: boolean };
type Sample = PlaybackObservation & { receivedAt: number; epoch: number };
type View = {
  delivery: Delivery;
  id: string;
  seen: number;
  previous?: Sample;
  session?: HistorySession;
  days: Map<string, HistoryDay>;
  live: Map<string, LiveAllocation>;
  dirty: boolean;
};
type Resume = { session: HistorySession; detachedAt: number; view?: View };
const CHECKPOINT_MS = 30000;
const MAX_INTERVAL_MS = 20000;
const RESUME_MS = 180000;
const MAX_VIEWS = 512;
const BATCH_SIZE = 32;
const MAX_PENDING_DAYS = 4;

const canResume = (reason: HistoryEnd) => reason === 'interrupted' || reason === 'replacing' || reason === 'idle';

function splitDays(start: number, ms: number, add: (day: string, ms: number) => void) {
  const date = new Date(start);
  const day = [date.getFullYear(), date.getMonth() + 1, date.getDate()].map(n => String(n).padStart(2, '0')).join('-');
  date.setHours(24, 0, 0, 0);
  const untilMidnight = Math.min(ms, date.getTime() - start);
  add(day, untilMidnight);
  if (untilMidnight < ms) splitDays(start + untilMidnight, ms - untilMidnight, add);
}

function credit(previous: Sample | undefined, next: Sample, external: boolean) {
  if (previous?.state !== 'playing' || next.state === 'seeking' || next.epoch !== previous.epoch || next.sequence !== previous.sequence + 1) return 0;
  const elapsed = next.elapsedMs - previous.elapsedMs, advanced = next.positionMs - previous.positionMs;
  const received = next.receivedAt - previous.receivedAt;
  if (elapsed <= 0 || elapsed > (external ? 60000 : MAX_INTERVAL_MS) || received < 0 || Math.abs(received - elapsed) > 5000 || advanced <= 0) return 0;
  const played = advanced / previous.rate;
  // Clock jitter is normal. A large discontinuity without a seek event is missing evidence.
  return played <= elapsed + 1250 ? Math.round(Math.min(elapsed, played)) : 0;
}

type Airings = (from: number, to: number) => HistoryAiring[];

function addTime(view: View, previous: Sample, next: Sample, ms: number, airings?: Airings) {
  const feed = view.delivery.media;
  const fallback = view.delivery.stream.delivery;
  const end = next.receivedAt;
  const add = (start: number, length: number, airing?: HistoryAiring) => splitDays(start, length, (day, duration) => {
    const total = view.days.get(day) ?? { direct: 0, remux: 0, transcode: 0 };
    total[airing?.delivery ?? fallback] += duration;
    view.days.set(day, total);
    if (feed.type !== 'channel') return;
    const key = JSON.stringify([day, feed.ratingKey, airing?.id]);
    const attributed = view.live.size < 128 || view.live.has(key);
    const allocationKey = attributed ? key : JSON.stringify([day, feed.ratingKey, undefined]);
    const allocation = view.live.get(allocationKey) ?? { day, feedId: feed.ratingKey, airing: attributed ? airing : undefined, watchMs: 0 };
    allocation.watchMs += duration;
    view.live.set(allocationKey, allocation);
  });
  const from = previous.presentationUtc, to = next.presentationUtc;
  if (!airings || from === undefined || to === undefined || Math.abs(to - from - (next.positionMs - previous.positionMs)) > 1000 || to <= from) {
    add(end - ms, ms);
    return;
  }
  let credited = 0;
  const offset = (instant: number) => Math.round(ms * (instant - from) / (to - from));
  for (const airing of airings(from, to)) {
    const start = Math.max(credited, offset(Math.max(from, airing.start))), stop = offset(Math.min(to, airing.end));
    if (stop <= start) continue;
    if (start > credited) add(end - ms + credited, start - credited);
    add(end - ms + start, stop - start, airing);
    credited = stop;
  }
  if (credited < ms) add(end - ms + credited, ms - credited);
}

export class PlaybackHistory {
  private active = new Map<string, View>();
  private resumable = new Map<string, Resume>();
  private pending = new Set<View>();
  private timer?: NodeJS.Timeout;
  private scheduled?: NodeJS.Immediate;
  private recovered = false;
  private retryAt = 0;
  private capacityLogAt = 0;
  private closed = false;

  constructor(private store: Pick<HistoryStore, 'recover' | 'checkpoint'>, private log: (message: string) => void = () => {}) {}

  start(now = Date.now()) {
    this.flush(now);
    this.timer = setInterval(() => this.tick(), CHECKPOINT_MS);
    this.timer.unref();
  }

  open(delivery: Delivery, previousId?: string, now = Date.now(), sameStation?: (from: string, to: string) => boolean) {
    if (this.closed) return;
    const previous = previousId ? this.active.get(previousId) : undefined;
    const previousGeneration = previousId && digest(previousId);
    const saved = previousGeneration ? this.resumable.get(previousGeneration) : undefined;
    const sameMedia = (media: HistoryTarget) =>
      delivery.media.type === media.type && delivery.media.serverId === media.serverId &&
      (delivery.media.ratingKey === media.ratingKey || (media.type === 'channel' && sameStation?.(media.ratingKey, delivery.media.ratingKey)));
    let view: View | undefined;
    if (previous && previous.delivery.owner === delivery.owner && sameMedia(previous.delivery.media) && now - previous.seen <= RESUME_MS) {
      this.active.delete(previous.delivery.id);
      view = previous;
    } else if (saved && saved.session.accountId === delivery.accountId && sameMedia(saved.session.media) && now - saved.detachedAt <= RESUME_MS &&
        (!saved.view || saved.view.delivery.owner === delivery.owner)) {
      view = saved.view ?? { id: saved.session.id, delivery, seen: now, days: new Map(), live: new Map(), dirty: false, session: saved.session };
      this.resumable.delete(previousGeneration!);
    } else if (this.active.size + this.pending.size >= MAX_VIEWS) {
      if (now >= this.capacityLogAt) {
        this.capacityLogAt = now + CHECKPOINT_MS;
        this.log('Playback history active session limit reached');
      }
      return;
    }
    view ??= { id: randomUUID(), delivery, seen: now, days: new Map(), live: new Map(), dirty: false };
    view.delivery = delivery;
    if (view.session) {
      view.session.generation = digest(delivery.id);
      view.dirty = true;
      this.requestFlush();
    }
    view.previous = undefined;
    view.seen = now;
    this.active.set(delivery.id, view);
  }

  observe(id: string, owner: string, observation: PlaybackObservation, now = Date.now(), live?: LiveObservation) {
    const epoch = live?.epoch ?? 0;
    let view = this.active.get(id);
    if (!view) {
      const saved = this.resumable.get(digest(id));
      if (saved && this.canReattach(saved, owner, observation.sequence, epoch, now)) {
        // The caller has already checked that this delivery still belongs to the signed-in session.
        const { accountId, accountName, media, client, stream } = saved.session;
        this.open({ id, owner, accountId, accountName, media, client, stream, source: saved.session.source }, id, now);
        view = this.active.get(id);
      }
    }
    if (!view || view.delivery.owner !== owner) return;
    if (view.previous && (epoch < view.previous.epoch || epoch === view.previous.epoch &&
        (observation.sequence <= view.previous.sequence || observation.elapsedMs < view.previous.elapsedMs))) return;
    const target = view.delivery.media;
    const positionMs = target.type === 'channel' ? observation.positionMs : Math.min(observation.positionMs, Math.round(target.durationMs));
    const next = { ...observation, positionMs, receivedAt: now, epoch };
    const previous = view.previous;
    const ms = credit(previous, next, view.delivery.source === 'plex');
    view.previous = next;
    view.seen = now;
    if (ms && previous && view.days.size < MAX_PENDING_DAYS) {
      const first = !view.session;
      const { media, accountId, accountName, stream, client, source } = view.delivery;
      const s = view.session ??= { media, accountId, accountName, stream, client, source, id: view.id, generation: digest(id), startedAt: previous.receivedAt,
        observedAt: now, positionMs: next.positionMs, watchMs: 0 };
      if (live?.stream) view.delivery.stream = live.stream;
      s.stream = view.delivery.stream;
      s.end = undefined;
      s.watchMs += ms;
      s.observedAt = now;
      s.positionMs = next.positionMs;
      addTime(view, previous, next, ms, live?.airings);
      view.dirty = true;
      if (first) this.requestFlush();
    }
    if (next.state === 'ended' || next.state === 'stopped') this.end(id, live?.replacing ? 'replacing' : next.state, now);
  }

  ownsChannel(id: string, owner: string) {
    const active = this.active.get(id);
    const delivery = (active ?? this.resumable.get(digest(id))?.view)?.delivery;
    return delivery?.owner === owner && delivery.media.type === 'channel';
  }

  suspend(id: string, owner: string) {
    const view = this.active.get(id);
    if (view?.delivery.owner === owner && view.previous) view.previous.state = 'buffering';
  }

  end(id: string, reason: HistoryEnd, now = Date.now()) {
    const view = this.active.get(id);
    if (!view) {
      if (!canResume(reason)) {
        const generation = digest(id), saved = this.resumable.get(generation)?.view;
        this.resumable.delete(generation);
        if (saved?.session) {
          saved.session.end = reason;
          saved.dirty = true;
          this.pending.add(saved);
          this.requestFlush();
        }
      }
      return;
    }
    this.active.delete(id);
    if (view.session) {
      view.session.end = reason;
      view.dirty = true;
      this.pending.add(view);
      if (canResume(reason)) {
        this.resumable.set(view.session.generation, { session: view.session, detachedAt: now, view });
        if (this.resumable.size > MAX_VIEWS) this.resumable.delete(this.resumable.keys().next().value!);
      }
      this.requestFlush();
    }
  }

  endOwner(owner: string) {
    for (const [id, view] of this.active) if (view.delivery.owner === owner) this.end(id, 'revoked');
    for (const resume of this.resumable.values()) if (resume.view?.delivery.owner === owner) this.end(resume.view.delivery.id, 'revoked');
  }

  tick(now = Date.now()) {
    for (const [id, view] of this.active) {
      if (now - view.seen > this.idleTimeout(view)) this.end(id, 'idle', now);
    }
    for (const [id, resume] of this.resumable) if (now - resume.detachedAt > RESUME_MS) this.resumable.delete(id);
    this.flush(now);
  }

  private idleTimeout(view: View) {
    if (view.delivery.source === 'plex') return 150000;
    return view.previous?.state === 'playing' ? 35000 : 150000;
  }

  private canReattach(saved: Resume, owner: string, sequence: number, epoch: number, now: number) {
    if (now - saved.detachedAt > RESUME_MS) return false;
    if (!saved.view) return saved.session.end === 'interrupted';
    const previous = saved.view.previous;
    return saved.session.end === 'idle' && saved.view.delivery.owner === owner &&
      (!previous || epoch > previous.epoch || epoch === previous.epoch && sequence > previous.sequence);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    for (const id of this.active.keys()) this.end(id, 'interrupted');
    clearImmediate(this.scheduled);
    this.scheduled = undefined;
    this.flush(Date.now(), true);
  }

  private requestFlush() {
    if (this.scheduled) return;
    this.scheduled = setImmediate(() => {
      this.scheduled = undefined;
      this.flush();
    });
    this.scheduled.unref();
  }

  private flush(now = Date.now(), closing = false) {
    if (!closing && now < this.retryAt) return;
    try {
      if (!this.recovered) {
        for (const session of this.store.recover(now - RESUME_MS)) {
          if (!this.resumable.has(session.generation)) this.resumable.set(session.generation, { session, detachedAt: session.observedAt });
        }
        this.recovered = true;
      }
      const dirty = new Set([...this.pending, ...this.active.values()].filter(view => view.dirty));
      do {
        const batch = [...dirty].slice(0, BATCH_SIZE);
        if (!batch.length) return;
        this.store.checkpoint(batch.map(view => ({ session: view.session!, days: view.days, live: view.live.values() })));
        for (const view of batch) {
          view.days.clear();
          view.live.clear();
          view.dirty = false;
          this.pending.delete(view);
          dirty.delete(view);
        }
      } while (closing && dirty.size);
      if (dirty.size) this.requestFlush();
    } catch {
      this.retryAt = now + CHECKPOINT_MS;
      this.log('Playback history checkpoint failed');
    }
  }
}
