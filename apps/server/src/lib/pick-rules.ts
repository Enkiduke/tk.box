import { matchMovie, parseRelease, type MovieTitle, type ParsedRelease, type ReleaseIds } from './release-name.js';
import { EARLY_COPIES, allowed, qualityOf, rank, scoreRelease, type Profile, type Quality, type ScoreRule } from './quality.js';

// Choosing a release (docs/ARR-REPLACEMENT.md, "Choosing a release"). Pure: every candidate gets a decision with its
// reasons as text, the rejected ones say why, and the accepted ones are ranked by quality, protocol, score, size, then
// seeders or grabs and age.

export type Protocol = 'usenet' | 'torrent';
// A release as an indexer found it.
export type Candidate = {
  name: string; indexer: string; guid: string; protocol: Protocol;
  size?: number; publishedAt?: number; seeders?: number; grabs?: number; freeleech?: boolean;
  ids?: ReleaseIds; infoHash?: string;
};
// The file tk.box has for the title (library_files): its quality, whether it is a PROPER/REPACK, its group, and when
// its grab was sent.
export type LibraryFile = { quality: Quality; proper: boolean; group?: string; grabbedAt?: number };
export type BlockedRelease = { name?: string; indexer?: string; guid?: string; infoHash?: string };
export type PickSettings = { earlyCopies: boolean; protocol: 'usenet-first' | 'torrent-first'; properDays: number };
export const defaultPickSettings = (): PickSettings => ({ earlyCopies: false, protocol: 'usenet-first', properDays: 7 });

export type MovieWant = { kind: 'movie'; title: MovieTitle; have?: LibraryFile };
export type PickContext = { profile: Profile; rules: readonly ScoreRule[]; settings: PickSettings; blocklist?: readonly BlockedRelease[]; now: number };

export type Decision = {
  release: Candidate; parsed: ParsedRelease; quality?: Quality;
  score: number; labels: string[];
  accepted: boolean; upgrade: boolean;
  reasons: string[];
};

const GB = 1024 ** 3, DAY = 86400000;
const gb = (bytes: number) => `${(bytes / GB).toFixed(1).replace(/\.0$/, '')} GB`;
const sizeLabel = (n: number) => `${n} GB`;

const blocked = (release: Candidate, list: readonly BlockedRelease[]) => list.some(b =>
  (b.guid !== undefined && b.guid === release.guid && (b.indexer === undefined || b.indexer === release.indexer))
  || (b.infoHash !== undefined && !!release.infoHash && b.infoHash.toLowerCase() === release.infoHash.toLowerCase())
  || (b.name !== undefined && b.name.toLowerCase() === release.name.toLowerCase()));

const sameGroup = (a?: string, b?: string) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

// Better than the library's file: a higher quality while that file is below the cutoff, or a PROPER/REPACK of the same
// quality and group within properDays of the grab. Never by score alone.
function againstLibrary(quality: Quality, parsed: ParsedRelease, have: LibraryFile | undefined, ctx: PickContext): { ok: boolean; reason?: string; upgrade: boolean } {
  if (!have) return { ok: true, upgrade: false };
  if (rank(quality) > rank(have.quality)) {
    if (rank(have.quality) >= rank(ctx.profile.cutoff)) return { ok: false, upgrade: false, reason: `the library's ${have.quality} already meets the cutoff ${ctx.profile.cutoff}` };
    return { ok: true, upgrade: true, reason: `upgrade from ${have.quality}` };
  }
  if (rank(quality) === rank(have.quality) && (parsed.proper || parsed.repack) && !have.proper) {
    const fresh = have.grabbedAt !== undefined && ctx.now - have.grabbedAt <= ctx.settings.properDays * DAY;
    if (sameGroup(parsed.group, have.group) && fresh) return { ok: true, upgrade: true, reason: `${parsed.repack ? 'REPACK' : 'PROPER'} of the library's ${have.quality} from ${parsed.group}` };
    if (!sameGroup(parsed.group, have.group)) return { ok: false, upgrade: false, reason: `a ${parsed.repack ? 'REPACK' : 'PROPER'} from another group than the library's ${have.group ?? 'file'}` };
    return { ok: false, upgrade: false, reason: `a ${parsed.repack ? 'REPACK' : 'PROPER'} more than ${ctx.settings.properDays} days after the grab` };
  }
  return { ok: false, upgrade: false, reason: `no better than the library's ${have.quality}` };
}

export function decide(release: Candidate, want: MovieWant, ctx: PickContext): Decision {
  const parsed = parseRelease(release.name, new Date(ctx.now).getUTCFullYear());
  const quality = qualityOf(parsed);
  const { score, bans, labels, matched } = scoreRelease({ parsed, ...(release.freeleech !== undefined ? { freeleech: release.freeleech } : {}) }, ctx.rules, want.kind);
  const rejects: string[] = [];
  if (blocked(release, ctx.blocklist ?? [])) rejects.push('on the blocklist');
  if (bans.length) rejects.push(`banned by ${bans.join(', ')}`);
  if (!quality) rejects.push('quality unknown');
  else if (EARLY_COPIES.has(quality) && !ctx.settings.earlyCopies) rejects.push(`${quality} is an early copy, and Early copies is off`);
  else if (!allowed(ctx.profile, quality)) rejects.push(`quality ${quality} isn't allowed`);
  if (parsed.multiSeason) rejects.push('a multi-season pack');
  else if (parsed.season !== undefined) rejects.push(`an episode or season, not a movie`);
  const match = matchMovie(parsed, want.title, release.ids);
  if (!match.ok) rejects.push(match.reason);
  if (release.size !== undefined && quality && !EARLY_COPIES.has(quality)) {
    const [min, max] = ctx.profile.movieSize;
    if (release.size > max * GB) rejects.push(`size ${gb(release.size)} over ${sizeLabel(max)}`);
    else if (release.size < min * GB) rejects.push(`size ${gb(release.size)} under ${sizeLabel(min)}`);
  }
  if (release.protocol === 'torrent' && release.seeders === 0) rejects.push('no seeders');
  let upgrade = false, upgradeReason: string | undefined;
  if (quality) {
    const library = againstLibrary(quality, parsed, want.have, ctx);
    if (!library.ok) rejects.push(library.reason!);
    else { upgrade = library.upgrade; upgradeReason = library.reason; }
  }
  const scoreText = `score ${score > 0 ? '+' : ''}${score}${matched.length ? ` (${matched.join(', ')})` : ''}`;
  const reasons = rejects.length ? rejects.map(r => `rejected: ${r}`)
    : [`accepted: ${quality}, ${scoreText}`, ...(upgradeReason ? [upgradeReason] : [])];
  return { release, parsed, ...(quality ? { quality } : {}), score, labels, accepted: !rejects.length, upgrade: !rejects.length && upgrade, reasons };
}

// Best first: quality, then protocol by the setting, then score, then size closest to the middle of the profile's
// range, then seeders (torrents) or grabs (Usenet), then the newest.
export function compareDecisions(a: Decision, b: Decision, ctx: PickContext): number {
  const byQuality = rank(b.quality!) - rank(a.quality!);
  if (byQuality) return byQuality;
  const first: Protocol = ctx.settings.protocol === 'torrent-first' ? 'torrent' : 'usenet';
  if (a.release.protocol !== b.release.protocol) return a.release.protocol === first ? -1 : 1;
  if (a.score !== b.score) return b.score - a.score;
  const [min, max] = ctx.profile.movieSize, preferred = (min + max) / 2 * GB;
  const distance = (d: Decision) => d.release.size === undefined || EARLY_COPIES.has(d.quality!) ? Number.MAX_SAFE_INTEGER : Math.abs(d.release.size - preferred);
  if (distance(a) !== distance(b)) return distance(a) - distance(b);
  const popularity = (d: Decision) => (d.release.protocol === 'torrent' ? d.release.seeders : d.release.grabs) ?? 0;
  if (popularity(a) !== popularity(b)) return popularity(b) - popularity(a);
  return (b.release.publishedAt ?? 0) - (a.release.publishedAt ?? 0);
}

// Every candidate's decision, the accepted ones ranked first, then the rejected in the order found; and the best.
export function pick(candidates: readonly Candidate[], want: MovieWant, ctx: PickContext): { decisions: Decision[]; best?: Decision } {
  const decisions = candidates.map(c => decide(c, want, ctx));
  const accepted = decisions.filter(d => d.accepted).sort((a, b) => compareDecisions(a, b, ctx));
  const best = accepted[0];
  return { decisions: [...accepted, ...decisions.filter(d => !d.accepted)], ...(best ? { best } : {}) };
}
