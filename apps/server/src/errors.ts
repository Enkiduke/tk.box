export class AppError extends Error {
  constructor(public code: string, message: string, public status = 400, public retryable = false) { super(message); }
}
// TKBOX_READ_ONLY=1 (npm run dev:readonly): nothing tk.box does may change Plex, Seerr, Radarr or library files.
export const readOnly = () => process.env.TKBOX_READ_ONLY === '1';
export function requireWritable() {
  if (readOnly()) throw new AppError('READ_ONLY', 'tk.box is running in read-only mode.', 409);
}
export function requireThat(condition: unknown, code: string, message: string, status = 400): asserts condition {
  if (!condition) throw new AppError(code, message, status);
}
