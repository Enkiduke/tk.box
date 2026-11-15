import { createHash } from 'node:crypto';

// A small bencode reader for .torrent files (docs/ARR-REPLACEMENT.md, "Clients" › IPTorrents): enough to check a file
// is a torrent and read its info hash, the SHA-1 of the `info` dictionary's exact bytes, before it goes to qBittorrent.

export type Bencoded = number | Buffer | Bencoded[] | { [key: string]: Bencoded };
export class BencodeError extends Error {}

const MAX_DEPTH = 64;

// Decodes the value at `start`, and returns where it ended. `onInfo` hears the byte span of a top-level `info` value.
function decodeAt(bytes: Buffer, start: number, depth: number, onInfo?: (from: number, to: number) => void): { value: Bencoded; end: number } {
  if (depth > MAX_DEPTH) throw new BencodeError('Nested too deeply.');
  const c = bytes[start];
  if (c === undefined) throw new BencodeError('Ends early.');
  if (c === 0x69) { // i<digits>e
    const end = bytes.indexOf(0x65, start + 1);
    if (end < 0) throw new BencodeError('An integer has no end.');
    const text = bytes.toString('latin1', start + 1, end);
    if (!/^-?\d+$/.test(text) || /^-?0\d/.test(text) || text === '-0') throw new BencodeError(`Bad integer ${text}.`);
    return { value: Number(text), end: end + 1 };
  }
  if (c === 0x6c) { // l…e
    const list: Bencoded[] = [];
    let at = start + 1;
    while (bytes[at] !== 0x65) {
      if (at >= bytes.length) throw new BencodeError('A list has no end.');
      const item = decodeAt(bytes, at, depth + 1);
      list.push(item.value); at = item.end;
    }
    return { value: list, end: at + 1 };
  }
  if (c === 0x64) { // d…e, keys are byte strings
    const dict: { [key: string]: Bencoded } = {};
    let at = start + 1;
    while (bytes[at] !== 0x65) {
      if (at >= bytes.length) throw new BencodeError('A dictionary has no end.');
      const key = decodeAt(bytes, at, depth + 1);
      if (!Buffer.isBuffer(key.value)) throw new BencodeError('A dictionary key is not a string.');
      const name = key.value.toString('latin1');
      const value = decodeAt(bytes, key.end, depth + 1);
      if (onInfo && depth === 0 && name === 'info') onInfo(key.end, value.end);
      dict[name] = value.value; at = value.end;
    }
    return { value: dict, end: at + 1 };
  }
  if (c >= 0x30 && c <= 0x39) { // <length>:<bytes>
    const colon = bytes.indexOf(0x3a, start);
    if (colon < 0) throw new BencodeError('A string has no length.');
    const length = Number(bytes.toString('latin1', start, colon));
    if (!Number.isSafeInteger(length) || colon + 1 + length > bytes.length) throw new BencodeError('A string runs past the end.');
    return { value: bytes.subarray(colon + 1, colon + 1 + length), end: colon + 1 + length };
  }
  throw new BencodeError(`Unexpected byte ${c} at ${start}.`);
}

export function decode(bytes: Buffer): Bencoded {
  const { value, end } = decodeAt(bytes, 0, 0);
  if (end !== bytes.length) throw new BencodeError('Bytes after the end.');
  return value;
}

// A .torrent's info hash (lowercase hex, as qBittorrent lists it) and name. Throws when it isn't a torrent.
export function readTorrent(bytes: Buffer): { infoHash: string; name?: string } {
  let span: [number, number] | undefined;
  const { value, end } = decodeAt(bytes, 0, 0, (from, to) => { span = [from, to]; });
  if (end !== bytes.length) throw new BencodeError('Bytes after the end.');
  const info = value && typeof value === 'object' && !Buffer.isBuffer(value) && !Array.isArray(value) ? value.info : undefined;
  if (!span || !info || typeof info !== 'object' || Buffer.isBuffer(info) || Array.isArray(info)) throw new BencodeError('Not a torrent: no info dictionary.');
  const name = Buffer.isBuffer(info.name) ? info.name.toString('utf8') : undefined;
  return { infoHash: createHash('sha1').update(bytes.subarray(span[0], span[1])).digest('hex'), ...(name ? { name } : {}) };
}
