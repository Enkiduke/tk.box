import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { resolve } from 'node:path';
import { isIP } from 'node:net';
import { z } from 'zod';
import type { Config } from './config.js';
import type { PlexAdapter } from './providers/plex.js';
import type { IdentityService } from './services/identity.js';
import { writeEnvValues } from './services/env-file.js';
import { runProcess } from './streaming/ffmpeg.js';
import { opaque, digest } from './security/vault.js';
import { AppError, requireThat } from './errors.js';

type Discovery = Awaited<ReturnType<PlexAdapter['discoverOwner']>>;
type Library = { key: string; title: string; type: string };
type Pending = { pinId: number; code: string; expires: number; lastPoll: number; token?: string; discovery?: Discovery };
type CookieOptions = { httpOnly: boolean; secure: boolean; sameSite: 'lax'; path: string };

// What someone typed for their Plex server, as the addresses to try in order: a bare host gets Plex's port 32400,
// and without a scheme http is tried before https. Only plain http(s) origins come back.
export function plexAddressCandidates(input: string) {
  const text = input.trim().replace(/\/+$/, '');
  if (!text) return [];
  const schemes = /^https?:\/\//i.test(text) ? [''] : ['http://', 'https://'];
  return [...new Set(schemes.flatMap(scheme => {
    try {
      const url = new URL(scheme + text);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) return [];
      if (!url.port && !/:\d+$/.test(url.host)) url.port = '32400';
      return [url.origin];
    } catch { return []; }
  }))];
}
// First-run setup answers this computer and the home network only, so a stranger who reaches an unconfigured
// tk.box through a public proxy can't start it. (Claiming it also needs the Plex account that owns the server.)
export function isLocalAddress(ip: string) {
  const v4 = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  if (isIP(v4) === 4) {
    const [a = 0, b = 0] = v4.split('.').map(Number);
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  const lower = ip.toLowerCase();
  return lower === '::1' || /^f[cd]/.test(lower) || /^fe[89ab]/.test(lower);
}
// The libraries chosen on the setup screen, checked against what the owner's server has: at least one Movies and
// one TV library, each one of the server's own.
export function chosenLibraries(libraries: Library[], chosen: string[]) {
  const picked = libraries.filter(l => chosen.includes(l.key));
  requireThat(picked.length === new Set(chosen).size, 'PLEX_LIBRARIES_REQUIRED', 'Choose libraries from your Plex server.');
  requireThat(picked.some(l => l.type === 'movie') && picked.some(l => l.type === 'show'), 'PLEX_LIBRARIES_REQUIRED', 'Choose at least one Movies library and one TV library.');
  return picked.map(l => l.key);
}
const toolVersion = async (path: string, args: string[]) => {
  try { const line = (await runProcess(path, args, 10000)).stdout.trim().split('\n')[0]?.trim(); return line || 'found'; }
  catch { return null; }
};

// First-run setup in the browser: find Plex, sign in as the account that owns it, choose libraries and check the
// tools, then write .env and apply it to the running server. Every route but GET /setup closes once Plex is set up.
export function registerSetup(app: FastifyInstance, config: Config, plex: PlexAdapter, identity: IdentityService,
  cookies: { setup: string; session: string; options: CookieOptions; sessionAge: number }, envPath = resolve('.env')) {
  const pending = new Map<string, Pending>();
  const open = (req: FastifyRequest) => {
    requireThat(!config.plexConfigured, 'ALREADY_SET_UP', 'tk.box is already set up.', 409);
    requireThat(isLocalAddress(req.ip), 'SETUP_LOCAL_ONLY', 'Set up tk.box from this computer or your home network.', 403);
  };
  const challenge = (req: FastifyRequest) => {
    const binding = req.cookies[cookies.setup], now = Date.now();
    for (const [hash, entry] of pending) if (entry.expires <= now) pending.delete(hash);
    const entry = binding ? pending.get(digest(binding)) : undefined;
    requireThat(entry, 'AUTH_EXPIRED', 'Plex sign-in expired. Sign in again.', 401);
    return entry;
  };
  const owner = (req: FastifyRequest) => {
    const entry = challenge(req);
    requireThat(entry.token && entry.discovery, 'UNAUTHENTICATED', 'Sign in with Plex first.', 401);
    return { token: entry.token, discovery: entry.discovery };
  };
  const signedIn = (discovery: Discovery) => ({ status: 'signed_in' as const, libraries: discovery.libraries.map(l => ({ key: l.key, title: l.title, type: l.type })), selected: discovery.requiredLibraryIds });

  app.get('/api/v1/setup', async () => ({ plexConfigured: config.plexConfigured, milestone: 0, ...(config.plexConfigured ? {} : { plexUrl: config.PLEX_URL }) }));
  // Looks for Plex at the typed address, or at the configured one (127.0.0.1:32400 by default) when none is given.
  app.post('/api/v1/setup/plex/find', { config: { rateLimit: { max: 30, timeWindow: 60000 } } }, async req => {
    open(req);
    const { url } = z.object({ url: z.string().max(300).optional() }).strict().parse(req.body ?? {});
    const candidates = url === undefined ? [config.PLEX_URL.replace(/\/+$/, '')] : plexAddressCandidates(url);
    requireThat(candidates.length, 'INVALID_URL', 'Enter your Plex server address, like 192.168.1.20 or http://192.168.1.20:32400.');
    for (const origin of candidates) {
      try {
        const response = await fetch(new URL('/identity', origin), { headers: { Accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(5000) });
        if (!response.ok) { await response.body?.cancel(); continue; }
        z.object({ MediaContainer: z.object({ machineIdentifier: z.string().min(1) }) }).parse(await response.json());
        config.PLEX_URL = origin;
        return { found: true, plexUrl: origin };
      } catch { /* try the next address */ }
    }
    return { found: false, plexUrl: candidates[0] };
  });
  app.post('/api/v1/setup/plex/start', { config: { rateLimit: { max: 10, timeWindow: 60000 } } }, async (req, reply) => {
    open(req);
    requireThat(pending.size < 20, 'LOGIN_LIMIT', 'Too many pending sign-ins.', 429);
    const pin = await plex.createPin(), binding = opaque();
    pending.set(digest(binding), { pinId: pin.id, code: pin.code, expires: Date.now() + Math.min(pin.expiresIn * 1000, 600000), lastPoll: 0 });
    reply.setCookie(cookies.setup, binding, { ...cookies.options, maxAge: 3600 });
    return { authUrl: plex.authUrl(pin.code) };
  });
  app.post('/api/v1/setup/plex/status', async req => {
    open(req);
    const entry = challenge(req), now = Date.now();
    if (entry.discovery) return signedIn(entry.discovery);
    requireThat(now - entry.lastPoll >= 2000, 'POLL_TOO_FAST', 'Wait before checking again.', 429);
    entry.lastPoll = now;
    const token = await plex.pollPin(entry.pinId, entry.code);
    if (!token) return { status: 'pending' as const };
    const discovery = await plex.discoverOwner(token);
    // Signed in: the rest of setup gets an hour, not what's left of Plex's ten-minute link.
    Object.assign(entry, { token, discovery, expires: now + 3600000 });
    return signedIn(discovery);
  });
  // Runs each tool with its version flag. Owner-only, since it starts the programs it's given.
  app.post('/api/v1/setup/tools', async req => {
    open(req); owner(req);
    const body = z.object({ ffmpeg: z.string().trim().min(1).max(500), ffprobe: z.string().trim().min(1).max(500), python: z.string().trim().min(1).max(500) }).partial().strict().parse(req.body ?? {});
    const paths = { ffmpeg: body.ffmpeg ?? config.FFMPEG_PATH, ffprobe: body.ffprobe ?? config.FFPROBE_PATH, python: body.python ?? config.PYTHON_PATH };
    const [ffmpeg, ffprobe, python] = await Promise.all([toolVersion(paths.ffmpeg, ['-version']), toolVersion(paths.ffprobe, ['-version']), toolVersion(paths.python, ['--version'])]);
    return { ffmpeg: { path: paths.ffmpeg, version: ffmpeg }, ffprobe: { path: paths.ffprobe, version: ffprobe }, python: { path: paths.python, version: python } };
  });
  app.post('/api/v1/setup/finish', { config: { rateLimit: { max: 10, timeWindow: 60000 } } }, async (req, reply: FastifyReply) => {
    open(req);
    const { token, discovery } = owner(req);
    const body = z.object({ libraries: z.array(z.string().regex(/^\d+$/)).min(2).max(100), ffmpeg: z.string().trim().min(1).max(500).optional(), ffprobe: z.string().trim().min(1).max(500).optional(), python: z.string().trim().min(1).max(500).optional() }).strict().parse(req.body);
    const libraries = chosenLibraries(discovery.libraries, body.libraries);
    const changedTools: Record<string, string> = {};
    for (const [key, value] of [['FFMPEG_PATH', body.ffmpeg], ['FFPROBE_PATH', body.ffprobe], ['PYTHON_PATH', body.python]] as const)
      if (value && value !== config[key]) changedTools[key] = value;
    const values = { PLEX_URL: config.PLEX_URL, PLEX_OWNER_ACCOUNT_ID: discovery.ownerAccountId, PLEX_MACHINE_ID: discovery.machineId, PLEX_REQUIRED_LIBRARY_IDS: libraries.join(','), ...changedTools };
    try { await writeEnvValues(envPath, values); }
    catch (e) { throw e instanceof AppError ? e : new AppError('SETUP_SAVE_FAILED', 'tk.box could not save its .env file. Check that its folder can be written to.', 500); }
    // Plex settings take effect at once; tool paths are handed to the streaming services when the server starts.
    Object.assign(config, { PLEX_OWNER_ACCOUNT_ID: values.PLEX_OWNER_ACCOUNT_ID, PLEX_MACHINE_ID: values.PLEX_MACHINE_ID, PLEX_REQUIRED_LIBRARY_IDS: values.PLEX_REQUIRED_LIBRARY_IDS, requiredLibraries: libraries, plexConfigured: true });
    pending.clear();
    reply.clearCookie(cookies.setup, cookies.options);
    const session = await identity.signIn(token);
    reply.setCookie(cookies.session, session.cookie, { ...cookies.options, maxAge: cookies.sessionAge });
    return { status: 'configured' as const, restartNeeded: Object.keys(changedTools).length > 0 };
  });
}
