import { delimiter, isAbsolute, resolve } from 'node:path';
import { isIP } from 'node:net';
import { z } from 'zod';

const optionalText = (value: z.ZodString) => z.preprocess(input => typeof input === 'string' && !input.trim() ? undefined : input, value.optional());
const schema = z.object({
  APP_HOST: z.string().default('127.0.0.1').refine(v => isIP(v) !== 0 || v === 'localhost', 'Use an IP address or localhost'),
  APP_PORT: z.coerce.number().int().min(1024).max(65535).default(3000),
  DEPLOYMENT_MODE: z.enum(['local', 'remote']).default('local'),
  PUBLIC_BASE_URL: optionalText(z.string().url()),
  DATA_DIR: z.string().default('./data'),
  CACHE_DIR: z.string().default('./data/cache'),
  SECRET_KEY_FILE: optionalText(z.string()),
  PLEX_URL: z.string().url().default('http://127.0.0.1:32400'),
  PLEX_MACHINE_ID: optionalText(z.string().min(1)),
  PLEX_OWNER_ACCOUNT_ID: optionalText(z.string().regex(/^\d+$/)),
  PLEX_REQUIRED_LIBRARY_IDS: z.string().default(''),
  TRUSTED_PROXY_CIDRS: z.string().default(''),
  // How long a viewer's passed Plex access check is reused before plex.tv is asked again (0 asks on every request).
  PLEX_RECHECK_SECONDS: z.coerce.number().int().min(0).max(600).default(60),
  FFMPEG_PATH: z.string().default('ffmpeg'), FFPROBE_PATH: z.string().default('ffprobe'),
  // The Python that runs the artwork engine (apps/artwork); a virtual environment with its requirements.txt.
  PYTHON_PATH: z.string().default('python3'),
  SEGMENT_CACHE_MAX_BYTES: z.coerce.number().int().min(1048576).default(2147483648),
  // Same-host mode: absolute local directories media parts may be read from, separated like PATH.
  MEDIA_ROOTS: z.string().default(''),
  // Optional Plex path prefix → local path prefix pairs for Docker, e.g. /movies=/srv/media/movies.
  PLEX_PATH_MAP: z.string().default(''),
  // Sports events. Comma-separated ESPN sport/league paths and TheSportsDB league IDs; empty uses the defaults.
  SPORTS_ESPN_LEAGUES: z.string().default(''),
  SPORTS_TSDB_LEAGUES: z.string().default(''),
  // Zone assumed for times written in channel names without one ("8PM").
  SPORTS_NAME_TIMEZONE: z.string().default('America/New_York').refine(zone => { try { new Intl.DateTimeFormat('en-US', { timeZone: zone }); return true; } catch { return false; } }, 'Use an IANA time zone')
});
export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const c = schema.parse(env);
  if (c.PUBLIC_BASE_URL) {
    const u = new URL(c.PUBLIC_BASE_URL);
    if (u.protocol !== 'https:' || u.username || u.password || u.pathname !== '/' || u.search || u.hash) throw new Error('PUBLIC_BASE_URL must be an HTTPS origin');
  }
  if (c.DEPLOYMENT_MODE === 'remote' && !c.PUBLIC_BASE_URL) throw new Error('Remote deployment requires PUBLIC_BASE_URL');
  const p = new URL(c.PLEX_URL);
  if (!['http:', 'https:'].includes(p.protocol) || p.username || p.password || p.pathname !== '/' || p.search || p.hash) throw new Error('PLEX_URL must be an HTTP(S) origin without credentials');
  const trustedProxies = c.TRUSTED_PROXY_CIDRS.split(',').map(s => s.trim()).filter(Boolean);
  for (const cidr of trustedProxies) {
    const [ip, mask] = cidr.split('/');
    const family = isIP(ip ?? '');
    if (!family || (mask !== undefined && (!/^\d+$/.test(mask) || Number(mask) > (family === 4 ? 32 : 128)))) throw new Error('Invalid trusted proxy IP/CIDR');
  }
  const list = (value: string) => value.split(delimiter).map(s => s.trim()).filter(Boolean);
  const mediaRoots = list(c.MEDIA_ROOTS), pathMap = list(c.PLEX_PATH_MAP).map(entry => {
    const at = entry.indexOf('='), from = entry.slice(0, at).trim(), to = entry.slice(at + 1).trim();
    if (at < 1 || !from || !isAbsolute(to)) throw new Error('PLEX_PATH_MAP entries must be plexPrefix=absoluteLocalPrefix');
    return { from, to: resolve(to) };
  });
  if (mediaRoots.some(root => !isAbsolute(root))) throw new Error('MEDIA_ROOTS must list absolute directories');
  if (pathMap.length && !mediaRoots.length) throw new Error('PLEX_PATH_MAP requires MEDIA_ROOTS');
  return { ...c, DATA_DIR: resolve(c.DATA_DIR), CACHE_DIR: resolve(c.CACHE_DIR), trustedProxies,
    requiredLibraries: c.PLEX_REQUIRED_LIBRARY_IDS.split(',').map(v => v.trim()).filter(Boolean),
    secureCookies: !!c.PUBLIC_BASE_URL,
    localMedia: mediaRoots.length ? { roots: mediaRoots.map(root => resolve(root)), pathMap } : undefined,
    plexConfigured: !!(c.PLEX_MACHINE_ID && c.PLEX_OWNER_ACCOUNT_ID && c.PLEX_REQUIRED_LIBRARY_IDS.trim()),
    browserOrigin: c.PUBLIC_BASE_URL ?? `http://${c.APP_HOST.includes(':') ? `[${c.APP_HOST}]` : c.APP_HOST}:${c.APP_PORT}`
  };
}
export type Config = ReturnType<typeof loadConfig>;
