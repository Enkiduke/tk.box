import { inflateSync } from 'node:zlib';

// Fast path for text subtitles embedded in Matroska (PLAY-SUB). Instead of reading the
// whole part, it reads the header, the Cues index and then only the subtitle blocks
// through byte ranges. mkvmerge and FFmpeg write a cue for every subtitle block (with
// its exact position), so a multi-GB file needs a few hundred kB of reads. Anything
// this does not fully understand returns undefined and the caller reads the whole file.
export type RangeReader = (start: number, end: number) => Promise<Buffer>; // [start, end)
export type TextTrack = { format: 'srt' | 'ass'; text: string; cues: number };

const ID = {
  EBML: 0x1a45dfa3, Segment: 0x18538067, SeekHead: 0x114d9b74, Seek: 0x4dbb, SeekID: 0x53ab, SeekPosition: 0x53ac,
  Info: 0x1549a966, TimestampScale: 0x2ad7b1, Tracks: 0x1654ae6b, TrackEntry: 0xae, TrackNumber: 0xd7, TrackUID: 0x73c5, TrackType: 0x83,
  CodecID: 0x86, CodecPrivate: 0x63a2, ContentEncodings: 0x6d80, ContentEncoding: 0x6240, ContentEncodingType: 0x5033,
  ContentCompression: 0x5034, ContentCompAlgo: 0x4254, ContentCompSettings: 0x4255, Cues: 0x1c53bb6b, CuePoint: 0xbb, CueTime: 0xb3,
  CueTrackPositions: 0xb7, CueTrack: 0xf7, CueClusterPosition: 0xf1, CueRelativePosition: 0xf0, CueDuration: 0xb2, Cluster: 0x1f43b675,
  Tags: 0x1254c367, Tag: 0x7373, Targets: 0x63c0, TagTrackUID: 0x63c5, SimpleTag: 0x67c8, TagName: 0x45a3, TagString: 0x4487,
  SimpleBlock: 0xa3, BlockGroup: 0xa0, Block: 0xa1, BlockDuration: 0x9b,
} as const;
const HEAD_BYTES = 64 * 1024, MAX_INDEX_BYTES = 32 * 1024 * 1024, MAX_BLOCK_BYTES = 256 * 1024, BLOCK_WINDOW = 4 * 1024, MAX_CUES = 50000;
const codecs: Record<string, TextTrack['format']> = { 'S_TEXT/UTF8': 'srt', 'S_TEXT/ASS': 'ass', 'S_TEXT/SSA': 'ass' };
class Unsupported extends Error {}
const check: (ok: unknown) => asserts ok = ok => { if (!ok) throw new Unsupported(); };

type Element = { id: number; start: number; data: number; end: number };
function vint(buf: Buffer, pos: number, keepMarker: boolean) {
  check(pos < buf.length);
  const first = buf[pos]!, length = Math.clz32(first) - 23;
  check(length >= 1 && length <= 8 && pos + length <= buf.length);
  let value = keepMarker ? first : first & (0xff >> length);
  for (let i = 1; i < length; i++) value = value * 256 + buf[pos + i]!;
  return { value, length, unknown: !keepMarker && value === 2 ** (7 * length) - 1 };
}
// Element header at `pos` of `buf`; `base` is the file offset of buf[0].
function header(buf: Buffer, pos: number, base = 0): Element {
  const id = vint(buf, pos, true), size = vint(buf, pos + id.length, false);
  check(!size.unknown && Number.isSafeInteger(size.value));
  const data = base + pos + id.length + size.length;
  return { id: id.value, start: base + pos, data, end: data + size.value };
}
function* children(buf: Buffer, from: number, to: number) {
  for (let pos = from; pos < to;) { const e = header(buf, pos); check(e.end <= to); yield e; pos = e.end; }
}
const uint = (buf: Buffer, e: Element) => { check(e.end - e.data <= 6); let v = 0; for (let i = e.data; i < e.end; i++) v = v * 256 + buf[i]!; return v; };
const text = (buf: Buffer, e: Element) => buf.subarray(e.data, e.end).toString('utf8').replace(/\0+$/, '');

type Track = { number: number; uid: number; format: TextTrack['format']; codecPrivate?: Buffer; decode: (b: Buffer) => Buffer };
function tracks(buf: Buffer, tracksElement: Element, index: number): Track {
  const entries = [...children(buf, tracksElement.data, tracksElement.end)].filter(e => e.id === ID.TrackEntry);
  const entry = entries[index]; check(entry);
  let number = 0, uid = 0, type = 0, codec = '', codecPrivate: Buffer | undefined, decode = (b: Buffer) => b;
  for (const e of children(buf, entry.data, entry.end)) {
    if (e.id === ID.TrackNumber) number = uint(buf, e); else if (e.id === ID.TrackUID) uid = e.end - e.data <= 6 ? uint(buf, e) : -1;
    else if (e.id === ID.TrackType) type = uint(buf, e); else if (e.id === ID.CodecID) codec = text(buf, e);
    else if (e.id === ID.CodecPrivate) codecPrivate = buf.subarray(e.data, e.end);
    else if (e.id === ID.ContentEncodings) decode = encodings(buf, e);
  }
  const format = codecs[codec]; check(type === 0x11 && number > 0 && format);
  return { number, uid, format, codecPrivate: codecPrivate && decode(codecPrivate), decode };
}
// Only lossless compression is supported (zlib, header stripping); encryption is refused.
function encodings(buf: Buffer, list: Element) {
  const steps: ((b: Buffer) => Buffer)[] = [];
  for (const encoding of children(buf, list.data, list.end)) {
    check(encoding.id === ID.ContentEncoding);
    let type = 0, algo = 0, settings = Buffer.alloc(0);
    for (const e of children(buf, encoding.data, encoding.end)) {
      if (e.id === ID.ContentEncodingType) type = uint(buf, e);
      else if (e.id === ID.ContentCompression) for (const c of children(buf, e.data, e.end)) {
        if (c.id === ID.ContentCompAlgo) algo = uint(buf, c); else if (c.id === ID.ContentCompSettings) settings = Buffer.from(buf.subarray(c.data, c.end));
      }
    }
    check(type === 0 && (algo === 0 || algo === 3));
    steps.unshift(algo === 0 ? b => inflateSync(b, { maxOutputLength: MAX_BLOCK_BYTES * 4 }) : b => Buffer.concat([settings, b]));
  }
  return (b: Buffer) => steps.reduce((v, step) => step(v), b);
}

type Cue = { time: number; cluster: number; relative: number; duration?: number };
function cues(buf: Buffer, track: number) {
  const out: Cue[] = [];
  for (const point of children(buf, 0, buf.length)) {
    if (point.id !== ID.CuePoint) continue;
    let time = -1; const positions: Omit<Cue, 'time'>[] = [];
    for (const e of children(buf, point.data, point.end)) {
      if (e.id === ID.CueTime) time = uint(buf, e);
      else if (e.id === ID.CueTrackPositions) {
        let t = 0, cluster = -1, relative = -1, duration: number | undefined;
        for (const p of children(buf, e.data, e.end)) {
          if (p.id === ID.CueTrack) t = uint(buf, p); else if (p.id === ID.CueClusterPosition) cluster = uint(buf, p);
          else if (p.id === ID.CueRelativePosition) relative = uint(buf, p); else if (p.id === ID.CueDuration) duration = uint(buf, p);
        }
        if (t === track) { check(cluster >= 0 && relative >= 0); positions.push({ cluster, relative, duration }); }
      }
    }
    check(time >= 0 || !positions.length);
    for (const p of positions) out.push({ time, ...p });
    check(out.length <= MAX_CUES);
  }
  return out;
}
// mkvmerge's statistics tags record each track's block count; when present it must match the cues.
function frameCount(buf: Buffer, uid: number) {
  for (const tag of children(buf, 0, buf.length)) {
    if (tag.id !== ID.Tag) continue;
    let target = false, frames: number | undefined;
    for (const e of children(buf, tag.data, tag.end)) {
      if (e.id === ID.Targets) for (const t of children(buf, e.data, e.end)) { if (t.id === ID.TagTrackUID && t.end - t.data <= 6 && uint(buf, t) === uid) target = true; }
      else if (e.id === ID.SimpleTag) {
        let name = '', value = '';
        for (const s of children(buf, e.data, e.end)) { if (s.id === ID.TagName) name = text(buf, s); else if (s.id === ID.TagString) value = text(buf, s); }
        if (name === 'NUMBER_OF_FRAMES' && /^\d+$/.test(value)) frames = Number(value);
      }
    }
    if (target && frames !== undefined) return frames;
  }
  return undefined;
}

// Reads one block at a cue. The cluster header (ID + size) is 5 to 12 bytes, so the block
// starts at one of eight offsets; exactly one must parse as a block of this track.
async function block(read: RangeReader, clusterStart: number, cue: Cue, track: Track) {
  const from = clusterStart + 5 + cue.relative;
  let buf = await read(from, from + BLOCK_WINDOW);
  const found: Element[] = [];
  for (let offset = 0; offset < 8; offset++) {
    try {
      const e = header(buf, offset);
      if ((e.id === ID.SimpleBlock || e.id === ID.BlockGroup) && e.end - e.data <= MAX_BLOCK_BYTES && blockTrack(buf, e) === track.number) found.push(e);
    } catch (error) { if (!(error instanceof Unsupported)) throw error; }
  }
  check(found.length === 1);
  const e = found[0]!;
  if (e.end > buf.length) buf = Buffer.concat([buf, await read(from + buf.length, from + e.end)]);
  let payload: Buffer | undefined, duration = cue.duration;
  const parse = (b: Element) => {
    const t = vint(buf, b.data, false), flags = buf[b.data + t.length + 2]!;
    check(t.value === track.number && (flags & 0x06) === 0);
    payload = track.decode(buf.subarray(b.data + t.length + 3, b.end));
  };
  if (e.id === ID.SimpleBlock) parse(e);
  else for (const c of children(buf, e.data, e.end)) { if (c.id === ID.Block) parse(c); else if (c.id === ID.BlockDuration) duration = uint(buf, c); }
  check(payload && duration !== undefined);
  return { start: cue.time, end: cue.time + duration, payload: payload! };
}
// Peeks at a candidate block's track number; for a BlockGroup, at its Block child.
function blockTrack(buf: Buffer, e: Element) {
  if (e.id === ID.SimpleBlock) return vint(buf, e.data, false).value;
  for (let pos = e.data; pos < Math.min(e.end, buf.length);) {
    const c = header(buf, pos); check(c.end <= e.end);
    if (c.id === ID.Block) return vint(buf, c.data, false).value;
    pos = c.end;
  }
  return -1;
}

async function pool<T, R>(items: T[], limit: number, run: (item: T) => Promise<R>) {
  const out = new Array<R>(items.length); let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => { try { while (next < items.length) { const i = next++; out[i] = await run(items[i]!); } } catch (error) { next = items.length; throw error; } }));
  return out;
}

const pad = (n: number, w = 2) => String(Math.floor(n)).padStart(w, '0');
const srtTime = (ms: number) => `${pad(ms / 3600000)}:${pad(ms / 60000 % 60)}:${pad(ms / 1000 % 60)},${pad(ms % 1000, 3)}`;
const assTime = (ms: number) => `${Math.floor(ms / 3600000)}:${pad(ms / 60000 % 60)}:${pad(ms / 1000 % 60)}.${pad(ms / 10 % 100)}`;

// `index` is the container stream index (TrackEntry order), as Plex and FFmpeg number streams.
export async function matroskaTextTrack(read: RangeReader, index: number, concurrency = 12): Promise<TextTrack | undefined> {
  try {
    const head = await read(0, HEAD_BYTES);
    const ebml = header(head, 0); check(ebml.id === ID.EBML);
    const segment = header(head, ebml.end - ebml.start); check(segment.id === ID.Segment);
    const base = segment.data, found = new Map<number, number>(); // element ID -> absolute offset
    // Level-1 elements in the head, plus everything the SeekHead points to.
    for (let pos = base; pos < head.length - 12;) {
      let e: Element; try { e = header(head, pos); } catch { break; }
      if (e.id === ID.Cluster) break;
      if (!found.has(e.id)) found.set(e.id, e.start);
      if (e.id === ID.SeekHead && e.end <= head.length) for (const seek of children(head, e.data, e.end)) {
        if (seek.id !== ID.Seek) continue;
        let id = 0, position = -1;
        for (const s of children(head, seek.data, seek.end)) { if (s.id === ID.SeekID) id = vint(head, s.data, true).value; else if (s.id === ID.SeekPosition) position = uint(head, s); }
        if (id && position >= 0 && !found.has(id)) found.set(id, base + position);
      }
      pos = e.end;
    }
    const element = async (id: number) => {
      const start = found.get(id); if (start === undefined) return undefined;
      const peek = start + 12 <= head.length ? head.subarray(start) : await read(start, start + 12);
      const e = header(peek, 0, start); check(e.id === id && e.end - e.start <= MAX_INDEX_BYTES);
      return e.end <= head.length ? head.subarray(e.data, e.end) : read(e.data, e.end);
    };
    const [info, trackList, cueList, tagList] = await Promise.all([element(ID.Info), element(ID.Tracks), element(ID.Cues), element(ID.Tags)]);
    check(info && trackList && cueList);
    let scale = 1000000;
    for (const e of children(info, 0, info.length)) if (e.id === ID.TimestampScale) scale = uint(info, e);
    const track = tracks(trackList, { id: ID.Tracks, start: 0, data: 0, end: trackList.length }, index);
    const points = cues(cueList, track.number);
    check(points.length > 0);
    const expected = tagList && track.uid > 0 ? frameCount(tagList, track.uid) : undefined;
    check(expected === undefined || expected === points.length);
    const blocks = await pool(points, concurrency, cue => block(read, base + cue.cluster, cue, track));
    const ms = (t: number) => Math.round(t * scale / 1e6);
    blocks.sort((a, b) => a.start - b.start);
    if (track.format === 'srt') {
      const body = blocks.map((b, i) => `${i + 1}\n${srtTime(ms(b.start))} --> ${srtTime(ms(b.end))}\n${b.payload.toString('utf8').replace(/\r\n?/g, '\n').trim()}\n`).join('\n');
      return { format: 'srt', text: body, cues: blocks.length };
    }
    // ASS blocks hold "ReadOrder,Layer,Style,Name,MarginL,MarginR,MarginV,Effect,Text".
    let script = (track.codecPrivate?.toString('utf8') ?? '').replace(/\r\n?/g, '\n').replace(/\0+$/, '').trimEnd();
    check(/^\[Script Info\]/m.test(script));
    if (!/^\[Events\]/m.test(script)) script += '\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text';
    const lines = blocks.map(b => {
      const fields = b.payload.toString('utf8').split(','); check(fields.length >= 9);
      return `Dialogue: ${fields[1]},${assTime(ms(b.start))},${assTime(ms(b.end))},${fields.slice(2).join(',').replace(/[\r\n]+/g, '\\N')}`;
    });
    return { format: 'ass', text: `${script}\n${lines.join('\n')}\n`, cues: blocks.length };
  } catch (error) {
    if (error instanceof Unsupported) return undefined;
    throw error;
  }
}
