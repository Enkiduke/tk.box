import type { RequestRow } from '../persistence/requests-store.js';
import { ADMINS, type NewNotification } from '../persistence/notifications-store.js';
import type { RequestChange } from './requests.js';

// What the bell says about a request (docs/NOTIFICATIONS.md). The requester has one row per request (key
// `request.<id>`): open while it is downloading, then turned into the outcome (available, partly, failed, removed) and
// closed. A failure is also an open admin condition (`request.failed.<id>`) until it is sent or removed. Every new
// request tells the admins. Cancelling your own request says nothing here (the page already confirmed it).
export type RequestNotice = { post?: NewNotification; resolve?: { to: string; key: string } };

const ADMIN_LINK = '#admin?section=requests';
const seasonText = (row: RequestRow) => row.kind === 'show' && row.seasons.length
  ? row.seasons.length === 1 ? `Season ${row.seasons[0]!.season}` : `Seasons ${row.seasons.map(s => s.season).join(', ')}` : undefined;
const removedText = (row: RequestRow) =>
  row.removedBy === 'cleanup' ? 'Clean Up removed it from the library.'
  : row.removedBy === 'library' ? 'It was removed from the library.'
  : 'An admin removed the request.';

export function requestNotices(change: RequestChange, row: RequestRow | undefined): RequestNotice[] {
  if (!row) return [];
  const mine = row.accountId, key = `request.${row.id}`, failedKey = `request.failed.${row.id}`, notices: RequestNotice[] = [];
  const toRequester = (n: Omit<NewNotification, 'to' | 'key'>, close = true) => {
    if (!mine) return;
    notices.push({ post: { ...n, to: mine, key } });
    if (close) notices.push({ resolve: { to: mine, key } });
  };
  const seasons = seasonText(row);
  if (change.made) notices.push({ post: { to: ADMINS, kind: 'request.new', tone: 'info', title: `New request: ${row.title}`,
    detail: [row.accountName, seasons].filter(Boolean).join(' · '), link: ADMIN_LINK } });
  switch (change.status) {
    case 'downloading':
      toRequester({ kind: 'request.downloading', tone: 'info', title: `${row.title} is downloading`, ...(seasons ? { detail: seasons } : {}) }, false);
      break;
    case 'available':
      toRequester({ kind: 'request.available', tone: 'success', title: `${row.title} is ready to watch` });
      break;
    case 'partial':
      toRequester({ kind: 'request.partial', tone: 'success', title: `Some of ${row.title} is ready to watch`,
        detail: row.seasons.filter(s => s.availableAt).map(s => `Season ${s.season}`).join(', ') || undefined });
      break;
    case 'failed':
      toRequester({ kind: 'request.failed', tone: 'error', title: `${row.title} couldn’t be requested`, detail: 'An admin has been told.' });
      notices.push({ post: { to: ADMINS, kind: 'request.failed', tone: 'error', title: `Request failed: ${row.title}`,
        detail: [row.accountName, row.lastError].filter(Boolean).join(' · '), link: ADMIN_LINK, key: failedKey } });
      break;
    case 'requested':
      notices.push({ resolve: { to: ADMINS, key: failedKey } });
      break;
    case 'removed':
      notices.push({ resolve: { to: ADMINS, key: failedKey } });
      if (row.removedBy === mine) { if (mine) notices.push({ resolve: { to: mine, key } }); break; }
      toRequester({ kind: 'request.removed', tone: 'info', title: `${row.title} was removed`, detail: removedText(row) });
      break;
  }
  return notices;
}
