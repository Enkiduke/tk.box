import type { GrabOutcome } from '../../../../packages/contracts/src/downloads.js';
import type { Grab, GrabStep } from '../persistence/library-store.js';

// Downloads › History: where each grab ended up, and which later grab took over a failed or cancelled one.
// A grab is taken over by the grab swapped in for it, else by the first later grab of the same title covering any of
// the same episodes (for a movie, any later grab). Only grabs in `rows` are looked at: a page of recent history.
export type GrabHistoryRow = { grab: Pick<Grab, 'id' | 'titleId' | 'episodes' | 'state' | 'swappedFrom' | 'importedAt' | 'finishedAt'>; steps: GrabStep[] };
export type GrabHistoryFacts = { outcome: GrabOutcome; startedAt: number; lastAt: number; endedAt?: number; replacedBy?: number };

const IMPORTED = new Set(['imported', 'seeding', 'done']);
const overlaps = (a: Grab['episodes'], b: Grab['episodes']) =>
  !a.length && !b.length ? true : a.some(([s, e]) => b.some(([s2, e2]) => s === s2 && e === e2));

export function grabHistoryFacts(rows: readonly GrabHistoryRow[]): Map<number, GrabHistoryFacts> {
  const startOf = (r: GrabHistoryRow) => r.steps[0]?.at ?? 0;
  const byStart = [...rows].sort((a, b) => startOf(a) - startOf(b) || a.grab.id - b.grab.id);
  const facts = new Map<number, GrabHistoryFacts>();
  for (const row of rows) {
    const g = row.grab, startedAt = startOf(row), lastAt = row.steps.at(-1)?.at ?? startedAt;
    const ended = g.state === 'failed' || g.state === 'cancelled';
    let replacedBy: number | undefined;
    if (ended) replacedBy = rows.find(r => r.grab.swappedFrom === g.id)?.grab.id
      ?? byStart.find(r => r.grab.id !== g.id && r.grab.titleId === g.titleId && (startOf(r) > startedAt || (startOf(r) === startedAt && r.grab.id > g.id))
        && overlaps(r.grab.episodes, g.episodes))?.grab.id;
    const outcome: GrabOutcome = IMPORTED.has(g.state) ? 'imported' : !ended ? 'active' : replacedBy !== undefined ? 'replaced' : g.state === 'failed' ? 'failed' : 'cancelled';
    const endedAt = outcome === 'active' ? undefined : outcome === 'imported'
      ? g.importedAt ?? row.steps.find(s => IMPORTED.has(s.kind))?.at
      : [...row.steps].reverse().find(s => s.kind === g.state)?.at ?? g.finishedAt;
    facts.set(g.id, { outcome, startedAt, lastAt, ...(endedAt !== undefined ? { endedAt } : {}), ...(replacedBy !== undefined ? { replacedBy } : {}) });
  }
  return facts;
}
