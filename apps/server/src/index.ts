import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { ZodError } from 'zod';
import { loadConfig } from './config.js';
import { openDatabase } from './persistence/database.js';
import { Vault } from './security/vault.js';
import { checkKey } from './security/key-check.js';
import { AppError } from './errors.js';
import { PlexAdapter } from './providers/plex.js';
import { buildApp } from './app.js';

if (process.argv.includes('--read-only')) process.env.TKBOX_READ_ONLY = '1';

// Startup reports the step that failed and why: setting names, an error code or the key problem, never setting values.
let step = 'settings';
try {
  // Settings come from .env when there is one (first-run setup writes it); values already in the environment win.
  if (existsSync('.env')) process.loadEnvFile('.env');
  const config = loadConfig();
  step = 'database'; const db = openDatabase(join(config.DATA_DIR, 'tk.box.sqlite'));
  // Only the default key path is created on first run, and a key that doesn't open this database stops here.
  step = 'encryption key'; const vault = Vault.fromFile(config.SECRET_KEY_FILE ?? join(config.DATA_DIR, 'secret.key'), !config.SECRET_KEY_FILE); checkKey(db, vault);
  step = 'startup';
  const idFile = join(config.DATA_DIR, 'client-id');
  if (!existsSync(idFile)) writeFileSync(idFile, randomUUID(), {flag: 'wx', mode: 0o600});
  const app = await buildApp(config, db, vault, new PlexAdapter(config, readFileSync(idFile, 'utf8')));
  if (!['127.0.0.1', '::1', 'localhost'].includes(config.APP_HOST)) app.log.warn('Listener is reachable beyond loopback. Firewall this port and permit only your existing reverse proxy.');
  if (process.env.TKBOX_READ_ONLY === '1') app.log.warn('READ-ONLY MODE: nothing is changed in Plex, Seerr, Radarr or library files.');
  app.addHook('onClose', async () => { db.close(); });
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void app.close(); });
  step = 'listener'; await app.listen({host: config.APP_HOST, port: config.APP_PORT});
} catch (e) {
  const code = e instanceof ZodError ? 'INVALID_SETTINGS' : (e as NodeJS.ErrnoException).code ?? 'STARTUP_FAILED';
  const message = e instanceof ZodError ? `Invalid settings: ${[...new Set(e.issues.map(i => i.path.join('.') || 'environment'))].join(', ')}.`
    : code === 'EADDRINUSE' ? 'Configured port is in use. Select an unused APP_PORT.'
    : e instanceof AppError ? e.message
    : `Startup failed at ${step}${e instanceof Error && e.message ? `: ${e.message.slice(0, 300)}` : ''}. Check configuration, state-directory permissions and dependency installation.`;
  process.stderr.write(JSON.stringify({level: 'error', code, step, message}) + '\n');
  process.exitCode = 1;
}
