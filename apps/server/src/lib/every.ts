// A task repeated in the background, stopped with `stop()`.
export type Repeating = { stop: () => void };

// Runs `task` every `ms`. A run that is due while the last one (a promise) is still going is skipped, so runs never
// overlap. An error, thrown or rejected, goes to `onError` instead of crashing the server. The timer doesn't keep the
// process alive. For a task whose runs must overlap, use a plain setInterval.
export function every(ms: number, task: () => unknown, onError: (error: unknown) => void): Repeating {
  let running = false;
  const run = () => {
    if (running) return;
    let result: unknown;
    try { result = task(); } catch (error) { onError(error); return; }
    if (result instanceof Promise) {
      running = true;
      result.catch(onError).finally(() => { running = false; });
    }
  };
  const timer = setInterval(run, ms); timer.unref();
  return { stop: () => clearInterval(timer) };
}

export const errorDetail = (error: unknown) => ({ error: error instanceof Error ? error.message : String(error) });
