import { requireThat } from '../errors.js';

export type Segment = { id: string; start: number; end: number; bytes: number; programId: string; revision: number; uri: string; discontinuity: boolean; sequence: number; initUri?: string; discontinuitySequence?: number };
// Metadata index for a disk-backed store. Eviction results must be unlinked by its owner.
export class SegmentBuffer {
  private segments: Segment[] = [];
  constructor(private maxBytes: number, private retentionMs: () => number) { requireThat(Number.isSafeInteger(maxBytes) && maxBytes > 0, 'INVALID_QUOTA', 'Invalid segment quota.'); }
  add(segment: Segment, now: number) {
    requireThat(Number.isSafeInteger(segment.bytes) && segment.bytes > 0 && segment.start < segment.end && segment.end <= now, 'INVALID_SEGMENT', 'Invalid segment index.');
    const last = this.segments.at(-1);
    requireThat(!last || (segment.start >= last.end && segment.sequence > last.sequence), 'SEGMENT_ORDER', 'Segments must be ordered by broadcast time.');
    this.segments.push(segment); return this.prune(now);
  }
  prune(now: number) {
    const removed: Segment[] = [];
    while (this.segments.length && (this.bytes > this.maxBytes || this.segments[0]!.end <= now - this.retentionMs())) removed.push(this.segments.shift()!);
    return removed;
  }
  get bytes() { return this.segments.reduce((n, s) => n + s.bytes, 0); }
  get start() { return this.segments[0]?.start; }
  get end() { return this.segments.at(-1)?.end; }
  replace(segments:Segment[]) {
    requireThat(segments.every((s,i)=>s.start<s.end&&s.bytes>0&&(!i||(s.start>=segments[i-1]!.end&&s.sequence>segments[i-1]!.sequence))),'SEGMENT_ORDER','Invalid retained segment index.');
    this.segments=[...segments];
  }
  has(cursor: number) { return this.segments.some(s => s.start <= cursor && cursor < s.end); }
  from(cursor: number) { return this.segments.filter(s => s.end > cursor); }
}
export type ViewerState = 'LIVE' | 'PAUSED' | 'PLAYING_DELAYED' | 'EXPIRED' | 'STOPPED';
export class ViewerCursor {
  state: ViewerState = 'LIVE'; private cursor = 0; private changedAt = 0;
  constructor(private buffer: SegmentBuffer, private retentionMs: () => number) {}
  position(now: number) {
    if (this.state === 'LIVE') return now;
    return this.cursor + (this.state === 'PLAYING_DELAYED' ? now - this.changedAt : 0);
  }
  inspect(now: number) {
    const cursor = this.position(now);
    if (['PAUSED', 'PLAYING_DELAYED'].includes(this.state) && (now - cursor > this.retentionMs() || !this.buffer.has(cursor))) { this.cursor = cursor; this.state = 'EXPIRED'; }
    return {state: this.state, cursor: this.position(now), behindLiveMs: Math.max(0, now - this.position(now))};
  }
  pause(displayedUtc: number, now: number) {
    requireThat(this.state === 'LIVE' || this.state === 'PLAYING_DELAYED' || this.state === 'PAUSED', 'INVALID_STATE', 'Cannot pause expired/stopped playback.', 409);
    if (this.state === 'PAUSED') return;
    requireThat(displayedUtc <= now && now - displayedUtc <= this.retentionMs() && this.buffer.has(displayedUtc), 'BUFFER_EXPIRED', 'Displayed content is no longer retained.', 409);
    this.cursor = displayedUtc; this.changedAt = now; this.state = 'PAUSED';
  }
  resume(now: number) {
    this.inspect(now);
    requireThat(this.state === 'PAUSED' || this.state === 'PLAYING_DELAYED', 'BUFFER_EXPIRED', 'Buffer expired. Go Live to continue.', 409);
    if (this.state === 'PLAYING_DELAYED') return;
    this.changedAt = now; this.state = 'PLAYING_DELAYED';
  }
  goLive() { requireThat(this.state !== 'STOPPED', 'SESSION_STOPPED', 'Tune again to start a new session.', 409); this.state = 'LIVE'; this.cursor = 0; }
  stop() { this.state = 'STOPPED'; this.cursor = 0; }
}
export function renderManifest(segments: Segment[], ended = false, cursorUtc?: number) {
  requireThat(segments.length > 0, 'BUFFER_EXPIRED', 'No retained segments.', 409);
  const target = Math.ceil(Math.max(...segments.map(s => (s.end - s.start) / 1000)));
  const lines = ['#EXTM3U', `#EXT-X-VERSION:${segments.some(s => s.initUri) ? 7 : 3}`, `#EXT-X-TARGETDURATION:${target}`, `#EXT-X-MEDIA-SEQUENCE:${segments[0]!.sequence}`, `#EXT-X-DISCONTINUITY-SEQUENCE:${segments[0]!.discontinuitySequence ?? 0}`];
  if (cursorUtc !== undefined) {
    requireThat(segments.some(s => s.start <= cursorUtc && cursorUtc < s.end), 'BUFFER_EXPIRED', 'Requested playback point is not retained.', 410);
    lines.push(`#EXT-X-START:TIME-OFFSET=${((cursorUtc - segments[0]!.start) / 1000).toFixed(6)},PRECISE=YES`);
  }
  let previousInit: string | undefined;
  for (const s of segments) {
    requireThat(/^[a-zA-Z0-9_./-]+$/.test(s.uri) && !s.uri.includes('..') && !s.uri.startsWith('/'), 'INVALID_SEGMENT', 'Manifest URIs must be relative app paths.');
    if (s.discontinuity) lines.push('#EXT-X-DISCONTINUITY');
    if (s.initUri && s.initUri !== previousInit) {
      requireThat(/^[a-zA-Z0-9_./-]+$/.test(s.initUri) && !s.initUri.includes('..') && !s.initUri.startsWith('/'), 'INVALID_SEGMENT', 'Initialization URI must be a relative app path.');
      lines.push(`#EXT-X-MAP:URI="${s.initUri}"`); previousInit = s.initUri;
    }
    lines.push(`#EXT-X-PROGRAM-DATE-TIME:${new Date(s.start).toISOString()}`, `#EXTINF:${((s.end - s.start) / 1000).toFixed(6)},`, s.uri);
  }
  if (ended) lines.push('#EXT-X-ENDLIST');
  return lines.join('\n') + '\n';
}
