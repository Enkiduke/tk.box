import { z } from 'zod';
import type { Db } from './database.js';
import { sportsHidden, NOW } from './sports-store.js';

// Channels list themselves: there is no approval step. A regular channel is listed while it plays (channel checks)
// and, when the source asks for it, while its guide has a program on now or soon. An event channel is listed while its
// event is live or starting soon. An administrator can still hide a channel, or list it always.
export type Listing = 'auto' | 'always' | 'hidden';
export const listingPolicy = z.object({
  // Wait for a channel's first passing check before listing it.
  requireCheck: z.boolean(),
  // List only channels with a program airing now or starting within `guideHours`.
  requireGuide: z.boolean(), guideHours: z.number().int().min(0).max(24),
  // Channel names or groups with any of these words never need guide data ("24/7" channels have no listings).
  alwaysOn: z.array(z.string().trim().min(1).max(60)).max(30)
}).strict();
export type ListingPolicy = z.infer<typeof listingPolicy>;
export const DEFAULT_LISTING: ListingPolicy = { requireCheck: true, requireGuide: false, guideHours: 2, alwaysOn: ['24/7', '24-7', '24x7', '247'] };
export function readListingPolicy(db: Db, sourceId: string): ListingPolicy {
  const row = db.prepare('SELECT require_check,require_guide,guide_hours,always_on FROM iptv_listing_policies WHERE source_id=?').get(sourceId) as { require_check: number; require_guide: number; guide_hours: number; always_on: string } | undefined;
  return row ? { requireCheck: !!row.require_check, requireGuide: !!row.require_guide, guideHours: row.guide_hours, alwaysOn: JSON.parse(row.always_on) } : { ...DEFAULT_LISTING, alwaysOn: [...DEFAULT_LISTING.alwaysOn] };
}
// "24/7" matches as a whole word, so "247" never matches inside "1247".
export function alwaysOnMatch(patterns: string[]) {
  const words = patterns.map(p => p.toLocaleLowerCase());
  return (text: string) => { const t = ` ${text.toLocaleLowerCase()} `; return words.some(w => new RegExp(`(^|[^\\p{L}\\p{N}])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\p{L}\\p{N}])`, 'u').test(t)); };
}

const policy = (column: string, fallback: number) => `COALESCE((SELECT lp.${column} FROM iptv_listing_policies lp WHERE lp.source_id=c.source_id),${fallback})`;
// SQL predicates (channel alias `c`). A confirmed failing channel of a source that hides failures.
export const healthHidden = `EXISTS(SELECT 1 FROM iptv_channel_health h LEFT JOIN iptv_health_policies p ON p.source_id=c.source_id WHERE h.channel_id=c.id AND COALESCE(p.hide_failing,1)=1 AND h.status IN ('offline','placeholder'))`;
// A regular channel that has never played, on a source that waits for a first check.
export const unverified = `(c.event=0 AND ${policy('require_check', 1)}=1 AND NOT EXISTS(SELECT 1 FROM iptv_channel_health h WHERE h.channel_id=c.id AND h.last_online IS NOT NULL))`;
// A regular channel with nothing in its guide from now until the look-ahead, on a source that requires guide data.
export const guideMissing = `(c.event=0 AND c.guide_exempt=0 AND ${policy('require_guide', 0)}=1 AND NOT EXISTS(SELECT 1 FROM iptv_guide_coverage g WHERE g.channel_id=c.id AND g.end>${NOW} AND g.start<=${NOW}+${policy('guide_hours', DEFAULT_LISTING.guideHours)}*3600000))`;
// Listed: what viewers see (with a lineup number). "Always" skips every automatic rule.
export const listed = `(c.present=1 AND c.conflict=0 AND c.listing<>'hidden' AND (c.listing='always' OR NOT (${healthHidden} OR ${unverified} OR ${guideMissing} OR ${sportsHidden})))`;
// Why a channel is or is not listed, first reason wins. For administrators.
export type ListingState = 'listed' | 'always' | 'hidden' | 'missing' | 'conflict' | 'no_event' | 'failing' | 'unverified' | 'no_guide';
export const listingState = `CASE WHEN c.present=0 THEN 'missing' WHEN c.conflict=1 THEN 'conflict' WHEN c.listing='hidden' THEN 'hidden' WHEN c.listing='always' THEN 'always'
  WHEN ${sportsHidden} THEN 'no_event' WHEN ${healthHidden} THEN 'failing' WHEN ${unverified} THEN 'unverified' WHEN ${guideMissing} THEN 'no_guide' ELSE 'listed' END`;
