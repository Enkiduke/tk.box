import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { loadConfig } from '../apps/server/src/config.js';
import { openDatabase } from '../apps/server/src/persistence/database.js';
import { Vault } from '../apps/server/src/security/vault.js';
import { IptvStore } from '../apps/server/src/persistence/iptv-store.js';
import { args, classify, parseAnalysis } from '../apps/server/src/services/stream-probe.js';

// Runs the channel check's FFmpeg command against one channel and prints its log, so a verdict
// can be explained. Provider URLs, hosts and credentials are masked before anything is printed.
const channelId = process.argv[2], sample = Number(process.argv[3] ?? 7);
if (!channelId) { console.error('Usage: tsx scripts/probe-channel.ts <channelId> [sampleSeconds]'); process.exit(2); }
const c = loadConfig(), db = openDatabase(join(c.DATA_DIR, 'tk.box.sqlite'));
const vault = Vault.fromFile(c.SECRET_KEY_FILE ?? join(c.DATA_DIR, 'secret.key'));
const { streamUrl } = new IptvStore(db, vault).streamFor(channelId); db.close();
const secrets = (() => { const u = new URL(streamUrl); return [u.host, u.username, u.password, ...u.pathname.split('/'), ...u.searchParams.values()].filter(s => s.length >= 3); })();
const mask = (text: string) => secrets.reduce((t, s) => t.replaceAll(s, '***'), text.replace(/https?:\/\/[^\s'"]+/g, m => { try { const u = new URL(m); return `${u.protocol}//***${u.pathname.replace(/[^/]+(?=\/)/g, '*')}`; } catch { return '***'; } }));
const started = Date.now(), child = spawn(c.FFMPEG_PATH, args(streamUrl, Math.max(5, Math.min(20, sample)), true), { stdio: ['ignore', 'ignore', 'pipe'] });
let stderr = ''; child.stderr.on('data', (b: Buffer) => { stderr += b.toString(); });
const code = await new Promise<number | null>(done => child.on('close', done));
const analysis = parseAnalysis(stderr);
console.log(mask(stderr.split(/\r|\n/).filter(Boolean).join('\n')));
console.log('\n' + JSON.stringify({ exitCode: code, elapsedMs: Date.now() - started, analysis, verdict: classify(analysis, code === 0 ? 'ok' : 'failed') }, null, 2));
