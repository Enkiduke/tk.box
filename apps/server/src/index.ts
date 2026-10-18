import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { loadConfig } from './config.js';
import { openDatabase } from './persistence/database.js';
import { Vault } from './security/vault.js';
import { PlexAdapter } from './providers/plex.js';
import { buildApp } from './app.js';

try {
  const config = loadConfig(), db = openDatabase(join(config.DATA_DIR, 'tk.box.sqlite'));
  const vault = Vault.fromFile(config.SECRET_KEY_FILE ?? join(config.DATA_DIR, 'secret.key'));
  const idFile = join(config.DATA_DIR, 'client-id');
  if (!existsSync(idFile)) writeFileSync(idFile, randomUUID(), {flag: 'wx', mode: 0o600});
  const app = await buildApp(config, db, vault, new PlexAdapter(config, readFileSync(idFile, 'utf8')));
  if (!['127.0.0.1', '::1', 'localhost'].includes(config.APP_HOST)) app.log.warn('Listener is reachable beyond loopback. Firewall this port and permit only your existing reverse proxy.');
  app.addHook('onClose', async () => { db.close(); });
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void app.close(); });
  await app.listen({host: config.APP_HOST, port: config.APP_PORT});
} catch (e) {
  const code = (e as NodeJS.ErrnoException).code;
  process.stderr.write(JSON.stringify({level: 'error', code: code ?? 'STARTUP_FAILED', message: code === 'EADDRINUSE' ? 'Configured port is in use. Select an unused APP_PORT.' : 'Startup failed. Check configuration, state-directory permissions and dependency installation.'}) + '\n');
  process.exitCode = 1;
}
