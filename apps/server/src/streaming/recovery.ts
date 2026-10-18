import { setTimeout as delay } from 'node:timers/promises';
import { AppError } from '../errors.js';
import { retryNetworkFailure } from './pipelines.js';

export class RecoveryController {
  private inFlight?: Promise<void>;
  private attempts = 0;
  private cancelled = new AbortController();
  state: 'active' | 'reconnecting' | 'failed' | 'stopped' = 'active';
  constructor(private wait: (ms: number, signal: AbortSignal) => Promise<void> = async (ms, signal) => {await delay(ms, undefined, {signal});}) {}
  recover(causeCode: string, reconnect: (signal: AbortSignal) => Promise<void>): Promise<void> {
    if (this.inFlight) return this.inFlight;
    if (this.state === 'stopped') return Promise.reject(new AppError('RECOVERY_STOPPED', 'Source recovery stopped.', 409));
    if (this.state === 'failed') return Promise.reject(new AppError('RETRY_REQUIRED', 'Stream interrupted. Use Retry.', 503, true));
    this.inFlight = this.run(causeCode, reconnect).finally(() => {this.inFlight = undefined;});
    return this.inFlight;
  }
  private async run(cause: string, reconnect: (signal: AbortSignal) => Promise<void>) {
    while (!this.cancelled.signal.aborted) {
      const ms = retryNetworkFailure(cause, this.attempts);
      if (ms === undefined) {this.state = 'failed'; throw new AppError(cause, 'Stream interrupted. Use Retry.', 503, true);}
      this.state = 'reconnecting'; this.attempts++;
      try {
        await this.wait(ms, this.cancelled.signal);
        await reconnect(AbortSignal.any([this.cancelled.signal, AbortSignal.timeout(10000)]));
        this.cancelled.signal.throwIfAborted();
        this.state = 'active'; return;
      } catch (e) {
        if (this.cancelled.signal.aborted) throw new AppError('RECOVERY_STOPPED', 'Source recovery stopped.', 409);
        cause = e instanceof AppError ? e.code : 'UPSTREAM_DISCONNECTED';
      }
    }
  }
  // Reset only after measured stable service, never immediately on a reconnect response.
  markStable(stableForMs: number) { if (this.state === 'active' && stableForMs >= 30000) this.attempts = 0; }
  manualRetry() { if (!this.inFlight && this.state === 'failed') {this.attempts = 0; this.state = 'active';} }
  stop() {this.state = 'stopped'; this.cancelled.abort();}
  get attemptCount() {return this.attempts;}
}
