import { constants } from 'node:fs';
import { open, realpath, stat, type FileHandle } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { requireThat } from '../errors.js';
import type { Config } from '../config.js';
import type { PlexGrant, PlexMetadata } from './plex.js';

// Containers read from disk, with the FFmpeg demuxer forced for them (so a part can never be
// treated as a playlist that references other files) and the type served for direct play.
const containers: Record<string, { demuxer: string; type: string }> = {
  mkv: { demuxer: 'matroska', type: 'video/x-matroska' }, webm: { demuxer: 'matroska', type: 'video/webm' },
  mp4: { demuxer: 'mov', type: 'video/mp4' }, m4v: { demuxer: 'mov', type: 'video/mp4' }, mov: { demuxer: 'mov', type: 'video/quicktime' },
  avi: { demuxer: 'avi', type: 'video/x-msvideo' }, mpegts: { demuxer: 'mpegts', type: 'video/mp2t' }, ts: { demuxer: 'mpegts', type: 'video/mp2t' },
};
export type LocalPart = { handle: FileHandle; path: string; size: number; demuxer: string; type: string };

// Same-host mode: tk.box reads a part straight from the Plex server's disk. A path is only
// resolved for an item that PlexAdapter.metadata already authorized for this grant, it must
// resolve (symlinks included) inside a configured media root, and it is opened read-only.
// Anything that does not qualify returns undefined and callers fall back to Plex HTTP.
// Paths are never logged or put in error messages.
export class LocalMedia {
  constructor(private options?: NonNullable<Config['localMedia']>) {}
  get enabled() { return !!this.options; }
  async open(grant: PlexGrant, item: PlexMetadata): Promise<LocalPart | undefined> {
    if (!this.options) return undefined;
    requireThat(grant.libraries.some(l => l.key === item.librarySectionID), 'PLEX_ACCESS_DENIED', 'Media is not accessible to this account.', 403);
    const media = item.Media[0], part = media?.Part[0], kind = containers[media?.container.toLowerCase() ?? ''];
    const candidate = part?.file && kind ? this.localPath(part.file) : undefined;
    if (!candidate || !kind) return undefined;
    let handle: FileHandle | undefined;
    try {
      const real = await realpath(candidate);
      if (!await this.inside(real)) return undefined;
      handle = await open(real, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      // Re-resolve after opening: a path swapped for a symlink in between is refused.
      const [info, again] = await Promise.all([handle.stat(), realpath(candidate)]), named = await stat(again);
      if (!info.isFile() || again !== real || named.dev !== info.dev || named.ino !== info.ino) throw new Error('changed');
      return { handle, path: real, size: info.size, ...kind };
    } catch {
      await handle?.close().catch(() => {});
      return undefined;
    }
  }
  // Plex's path, translated through the longest matching PLEX_PATH_MAP prefix.
  localPath(file: string) {
    if (file.includes('\0')) return undefined;
    const fold = (s: string) => process.platform === 'win32' ? s.toLowerCase() : s;
    const maps = [...this.options?.pathMap ?? []].map(m => ({ ...m, from: m.from.replace(/[\\/]+$/, '') })).sort((a, b) => b.from.length - a.from.length);
    for (const { from, to } of maps) {
      const head = fold(file.slice(0, from.length)), next = file[from.length];
      if (head !== fold(from) || (next !== undefined && next !== '/' && next !== '\\')) continue;
      const rest = file.slice(from.length).split(/[\\/]+/).filter(Boolean);
      return rest.includes('..') ? undefined : join(to, ...rest);
    }
    return isAbsolute(file) && !file.split(/[\\/]+/).includes('..') ? file : undefined;
  }
  private async inside(real: string) {
    for (const root of this.options?.roots ?? []) {
      const base = await realpath(root).catch(() => undefined);
      if (!base) continue;
      const rel = relative(base, real);
      if (rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) return true;
    }
    return false;
  }
}

// One "bytes=" range of a file of `size` bytes, as validated by the /file route.
// undefined means serve the whole file; 'unsatisfiable' means 416.
export function byteRange(header: string | undefined, size: number): { start: number; end: number } | 'unsatisfiable' | undefined {
  const m = header?.match(/^bytes=(\d*)-(\d*)$/);
  if (!m || (!m[1] && !m[2])) return undefined;
  if (!m[1]) {
    const suffix = Number(m[2]);
    return suffix > 0 && size > 0 ? { start: Math.max(0, size - suffix), end: size - 1 } : 'unsatisfiable';
  }
  const start = Number(m[1]), end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  return start < size && start <= end ? { start, end } : 'unsatisfiable';
}
