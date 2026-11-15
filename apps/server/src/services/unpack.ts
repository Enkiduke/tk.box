import * as fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';
import { runProcess } from '../streaming/ffmpeg.js';

// Unpacking a torrent's RARs on import (docs/ARR-REPLACEMENT.md, "Import and seeding", step 2): `unrar x -o+ -inul`,
// or `7z x` when unrar isn't there, run under `nice -n 15` (and `ionice -c3`), into `.tk-unpack/<grab id>/` beside the
// download on the same mount. The RARs stay where they are and keep seeding; the unpacked copy is moved into the
// library, then the unpack folder is removed. Both are in /usr/bin on Whatbox (checked 2026-11-15).

export type Run = (exe: string, args: string[], timeoutMs: number, signal?: AbortSignal) => Promise<unknown>;
const SKIP = /(?:^|[^a-z0-9])(?:sample|subs?|subtitles?|proof)(?:[^a-z0-9]|$)/i;
const UNPACK_MS = 110 * 60000;

// The first volume of each RAR set under `root`: name.part01.rar (or part1), else a .rar that isn't a later part
// (name.rar with name.r00…). Sample, subtitle and proof folders are left alone.
export async function rarSets(root: string, ops: Pick<typeof fs, 'stat' | 'readdir'> = fs): Promise<string[]> {
  const found: string[] = [];
  const visit = async (path: string, depth: number): Promise<void> => {
    const info = await ops.stat(path);
    if (info.isDirectory()) {
      if (depth > 4 || basename(path) === '.tk-unpack') return;
      for (const name of (await ops.readdir(path)).sort()) await visit(join(path, String(name)), depth + 1);
      return;
    }
    if (!info.isFile() || !/\.rar$/i.test(path)) return;
    const inside = relative(root, path), parts = inside ? inside.split(sep) : [basename(path)];
    if (parts.slice(0, -1).some(p => SKIP.test(p))) return;
    const part = /\.part(\d+)\.rar$/i.exec(path);
    if (part && Number(part[1]) !== 1) return;
    found.push(path);
  };
  await visit(root, 0);
  return found;
}

export const unpackFolder = (contentPath: string, grabId: number) => join(dirname(contentPath), '.tk-unpack', String(grabId));

const ionice = () => ['/usr/bin/ionice', '/bin/ionice'].find(p => existsSync(p));
// Low priority on the server; straight on Windows (development).
const lowPriority = (exe: string, args: string[]) => {
  if (process.platform === 'win32') return { exe, args };
  const io = ionice();
  return io ? { exe: io, args: ['-c3', 'nice', '-n', '15', exe, ...args] } : { exe: 'nice', args: ['-n', '15', exe, ...args] };
};
const defaultRun: Run = (exe, args, timeoutMs, signal) => runProcess(exe, args, timeoutMs, signal);

// Unpacks each set into `dest` with unrar, or 7z when unrar can't be started. Throws when neither works.
export async function unpack(archives: readonly string[], dest: string, signal?: AbortSignal, run: Run = defaultRun, tools = { unrar: 'unrar', sevenZip: '7z' }) {
  await fs.mkdir(dest, { recursive: true });
  for (const archive of archives) {
    const unrar = lowPriority(tools.unrar, ['x', '-o+', '-inul', '-y', archive, `${dest}${sep}`]);
    try { await run(unrar.exe, unrar.args, UNPACK_MS, signal); continue; }
    catch (e) {
      if (signal?.aborted) throw e;
      const sevenZip = lowPriority(tools.sevenZip, ['x', '-y', '-bso0', '-bsp0', `-o${dest}`, archive]);
      try { await run(sevenZip.exe, sevenZip.args, UNPACK_MS, signal); }
      catch (second) {
        if (signal?.aborted) throw second;
        throw new Error(`${basename(archive)} couldn’t be unpacked by unrar or 7z (${(e as Error).message}; ${(second as Error).message})`);
      }
    }
  }
}
