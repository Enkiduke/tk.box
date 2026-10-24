import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { AppError } from '../errors.js';

export class Vault {
  constructor(private key: Buffer) { if (key.length !== 32) throw new Error('Encryption key must be 32 bytes'); }
  // `create` makes a key when there is none, on first run. A key path an administrator named is never created: a typo
  // would otherwise start tk.box with a new key that opens none of the stored data.
  static fromFile(path: string, create = true) {
    if (!create && !existsSync(path)) throw new AppError('SECRET_KEY_MISSING', 'SECRET_KEY_FILE names a file that does not exist. tk.box does not create a key there; check the path.', 500);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    try { writeFileSync(path, randomBytes(32), { flag: 'wx', mode: 0o600 }); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
    return new Vault(readFileSync(path));
  }
  seal(value: string, context: string) {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(context));
    return Buffer.concat([iv, cipher.update(value, 'utf8'), cipher.final(), cipher.getAuthTag()]).toString('base64');
  }
  open(value: string, context: string) {
    const b = Buffer.from(value, 'base64');
    const cipher = createDecipheriv('aes-256-gcm', this.key, b.subarray(0, 12));
    cipher.setAAD(Buffer.from(context)); cipher.setAuthTag(b.subarray(-16));
    return Buffer.concat([cipher.update(b.subarray(12, -16)), cipher.final()]).toString('utf8');
  }
}
export const opaque = () => randomBytes(32).toString('base64url');
export const digest = (s: string) => createHash('sha256').update(s).digest('hex');
