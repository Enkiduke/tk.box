import { z } from 'zod';

// When a job runs on its own, in server local time: every so many minutes since it last ran, at set times on chosen
// weekdays (none chosen is every day), or a five-field cron expression (minute hour day month weekday) for anything else.
export type Schedule = { kind: 'every'; minutes: number } | { kind: 'times'; times: string[]; days: number[] } | { kind: 'cron'; expression: string };
export type Scheduled = { enabled: boolean; schedule: Schedule };
export const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/, DAY_MS = 86400000;

type Cron = { fields: Set<number>[]; anyDay: boolean; anyWeekday: boolean };
const RANGES = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]] as const, FIELD = ['minute', 'hour', 'day', 'month', 'weekday'];
const NAMES: Record<string, number> = Object.fromEntries([
  ...'jan feb mar apr may jun jul aug sep oct nov dec'.split(' ').map((m, i) => [m, i + 1]),
  ...'sun mon tue wed thu fri sat'.split(' ').map((d, i) => [d, i])]);
const MACROS: Record<string, string> = { '@hourly': '0 * * * *', '@daily': '0 0 * * *', '@midnight': '0 0 * * *', '@weekly': '0 0 * * 0', '@monthly': '0 0 1 * *', '@yearly': '0 0 1 1 *', '@annually': '0 0 1 1 *' };
const parsed = new Map<string, Cron>();
// Each field is *, a value, a range (1-5) or a list of them (1,3,5), any of them stepped (*/15, 8-18/2). Months and
// weekdays take names too (jan, mon-fri); weekday 7 is Sunday as well. Throws with a reason fit to show.
export function parseCron(expression: string): Cron {
  const text = expression.trim().toLowerCase(), cached = parsed.get(text);
  if (cached) return cached;
  const parts = (MACROS[text] ?? text).split(/\s+/);
  if (parts.length !== 5) throw new Error('Use five fields: minute hour day month weekday.');
  const fields = parts.map((part, f) => {
    const [min, max] = RANGES[f]!, values = new Set<number>(), name = FIELD[f];
    const value = (v: string) => {
      const n = /^\d+$/.test(v) ? Number(v) : f >= 3 ? NAMES[v] : undefined;
      if (n === undefined || n < min || n > max) throw new Error(`The ${name} field takes ${min}–${max}${f >= 3 ? ' or names' : ''}, not “${v}”.`);
      return n;
    };
    for (const item of part.split(',')) {
      const [range = '', step, extra] = item.split('/');
      if (extra !== undefined || (step !== undefined && !/^[1-9]\d*$/.test(step))) throw new Error(`The ${name} field has an invalid step: “${item}”.`);
      const [a = '', b] = range === '*' ? [String(min), String(max)] : range.split('-');
      const from = value(a), to = b !== undefined ? value(b) : step !== undefined ? max : from;
      if (to < from) throw new Error(`The ${name} field has a backwards range: “${item}”.`);
      for (let n = from; n <= to; n += Number(step ?? 1)) values.add(f === 4 && n === 7 ? 0 : n);
    }
    return values;
  });
  const cron = { fields, anyDay: parts[2]!.startsWith('*'), anyWeekday: parts[4]!.startsWith('*') };
  parsed.set(text, cron);
  return cron;
}
// As cron has it, a day matches when both day fields allow it, or either one when neither is *.
function cronDay({ fields: [, , day, , weekday], anyDay, anyWeekday }: Cron, d: Date) {
  const byDay = day!.has(d.getDate()), byWeekday = weekday!.has(d.getDay());
  return anyDay || anyWeekday ? byDay && byWeekday : byDay || byWeekday;
}

// The first time a set-times or cron schedule runs after `after` (ms), or undefined if it never does (Feb 30). An
// every-N schedule runs N minutes after `after`, its last run.
export function nextRun(schedule: Schedule, after: number): number | undefined {
  if (schedule.kind === 'every') return after + schedule.minutes * 60000;
  if (schedule.kind === 'times') {
    const times = schedule.times.map(t => t.split(':').map(Number) as [number, number]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    for (let i = 0; i <= 8; i++) {
      const d = new Date(after); d.setDate(d.getDate() + i);
      if (schedule.days.length && !schedule.days.includes(d.getDay())) continue;
      for (const [hour, minute] of times) { d.setHours(hour, minute, 0, 0); if (d.getTime() > after) return d.getTime(); }
    }
    return undefined;
  }
  const cron = parseCron(schedule.expression), [minute, hour, , month] = cron.fields as [Set<number>, Set<number>, Set<number>, Set<number>];
  const d = new Date(after); d.setSeconds(0, 0); d.setMinutes(d.getMinutes() + 1);
  const until = after + 5 * 366 * DAY_MS;
  while (d.getTime() <= until) {
    if (!month.has(d.getMonth() + 1)) { d.setMonth(d.getMonth() + 1, 1); d.setHours(0, 0, 0, 0); }
    else if (!cronDay(cron, d)) { d.setDate(d.getDate() + 1); d.setHours(0, 0, 0, 0); }
    else if (!hour.has(d.getHours())) d.setHours(d.getHours() + 1, 0, 0, 0);
    else if (!minute.has(d.getMinutes())) d.setMinutes(d.getMinutes() + 1, 0, 0);
    else return d.getTime();
  }
  return undefined;
}
// When a job last fell due, if that was after its last run and no more than `lateMs` ago (a server that was down
// then catches up only so late); otherwise undefined. With several times missed, it runs once, for the latest.
export function dueAt(schedule: Schedule, lastRun: number | undefined, now: number, lateMs = 7 * DAY_MS) {
  if (schedule.kind === 'every') { const due = nextRun(schedule, lastRun ?? 0)!; return due <= now ? due : undefined; }
  let due: number | undefined;
  for (let next = nextRun(schedule, Math.max(lastRun ?? 0, now - lateMs)); next !== undefined && next <= now; next = nextRun(schedule, next)) due = next;
  return due;
}
// The shortest wait between two runs, over the next 200 of them; undefined if it never runs.
export function shortestGap(schedule: Schedule, from = Date.now()) {
  if (schedule.kind === 'every') return schedule.minutes;
  let gap = Infinity, at = nextRun(schedule, from);
  if (at === undefined) return undefined;
  for (let i = 0; i < 200; i++) { const next = nextRun(schedule, at); if (next === undefined) break; gap = Math.min(gap, (next - at) / 60000); at = next; }
  return gap;
}

const list = (items: string[]) => items.length > 1 ? `${items.slice(0, -1).join(', ')} and ${items.at(-1)}` : items[0] ?? '';
export function everyText(minutes: number) {
  const [n, unit] = minutes % 1440 === 0 ? [minutes / 1440, 'day'] : minutes % 60 === 0 ? [minutes / 60, 'hour'] : [minutes, 'minute'];
  return n === 1 ? `Every ${unit}` : `Every ${n} ${unit}s`;
}
export function daysText(days: number[]) {
  const set = [...new Set(days)].sort();
  if (!set.length || set.length === 7) return 'Daily';
  if (set.join() === '1,2,3,4,5') return 'Weekdays';
  if (set.join() === '0,6') return 'Weekends';
  return set.map(d => WEEKDAYS[d]).join(', ');
}
// A short line for a schedule: "Every 6 hours", "Weekdays at 04:00 and 16:00", "Cron 0 4 1 * *".
export function describeSchedule(schedule: Schedule) {
  if (schedule.kind === 'every') return everyText(schedule.minutes);
  if (schedule.kind === 'times') return `${daysText(schedule.days)} at ${list([...schedule.times].sort())}`;
  return `Cron ${schedule.expression.trim()}`;
}

// Schedules saved before these were "daily at a time" ({ time }) or "every N minutes" ({ minutes }).
export function toScheduled(value: unknown): unknown {
  if (!value || typeof value !== 'object' || 'schedule' in value) return value;
  const { enabled, time, minutes } = value as { enabled?: unknown; time?: unknown; minutes?: unknown };
  if (typeof time === 'string') return { enabled, schedule: { kind: 'times', times: [time], days: [] } };
  if (typeof minutes === 'number') return { enabled, schedule: { kind: 'every', minutes } };
  return value;
}

export const schedule = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('every'), minutes: z.number().int().min(1).max(28 * 1440) }).strict(),
  z.object({ kind: z.literal('times'), times: z.array(z.string().regex(TIME, 'Use HH:MM')).min(1, 'Add a time').max(24), days: z.array(z.number().int().min(0).max(6)).max(7) }).strict(),
  z.object({ kind: z.literal('cron'), expression: z.string().trim().min(1, 'Enter a cron expression').max(100) }).strict()
]);
// A schedule that runs, and no more often than every `minutes` (so a heavy job can't be set to run every minute).
export const scheduleEvery = (minutes: number) => schedule.superRefine((value, ctx) => {
  if (value.kind === 'cron') try { parseCron(value.expression); } catch (e) { ctx.addIssue({ code: 'custom', message: (e as Error).message }); return; }
  const gap = shortestGap(value);
  if (gap === undefined) ctx.addIssue({ code: 'custom', message: 'This schedule never runs.' });
  else if (gap < minutes) ctx.addIssue({ code: 'custom', message: `Runs too often: at most ${everyText(minutes).toLowerCase()}.` });
});
export const scheduled = (minutes: number) => z.preprocess(toScheduled, z.object({ enabled: z.boolean(), schedule: scheduleEvery(minutes) }).strict());
