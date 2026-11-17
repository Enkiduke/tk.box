export class AppError extends Error {
  constructor(public code: string, message: string, public status = 400, public retryable = false) { super(message); }
}
// TKBOX_READ_ONLY=1 (npm run dev:readonly): nothing tk.box does may change Plex or library files.
export const readOnly = () => process.env.TKBOX_READ_ONLY === '1';
// TKBOX_PREVIEW=1 (npm run preview:plex): read-only, and frozen. No background work runs (schedules, sweeps, the queue,
// the RSS feed, IPTV refreshes) and indexers are never asked, so a snapshot of the server stays as it was and its API
// limits and provider connections aren't used.
export const preview = () => process.env.TKBOX_PREVIEW === '1';
export function requireLive(what: string) {
  if (preview()) throw new AppError('PREVIEW', `${what} is off in the preview.`, 409);
}
export function requireWritable() {
  if (readOnly()) throw new AppError('READ_ONLY', 'tk.box is running in read-only mode.', 409);
}
export function requireThat(condition: unknown, code: string, message: string, status = 400): asserts condition {
  if (!condition) throw new AppError(code, message, status);
}
