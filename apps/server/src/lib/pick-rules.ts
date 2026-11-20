import { inShowNumbering, matchMovie, matchShow, parseRelease, type MovieTitle, type ParsedRelease, type ReleaseIds, type ShowTitle } from './release-name.js';
import { EARLY_COPIES, qualityOf, rank, type Quality } from './quality.js';
import { scoreFormats, type Format, type Score } from './formats.js';
import { DEFAULT_RUNTIME, meetsCutoff, sizeLimits, tierOf, type QualityProfile } from './profiles.js';

// Choosing a release (docs/ARR-REPLACEMENT.md, "Choosing a release"; docs/PROFILES.md). Pure: every candidate gets a
// decision with its reasons as text, the rejected ones say why, and the accepted ones are ranked by the profile's tier,
// protocol, score, size, then seeders or grabs and age.

export type Protocol = 'usenet' | 'torrent';
// A release as an indexer found it.
export type Candidate = {
  name: string; indexer: string; guid: string; protocol: Protocol;
  size?: number; publishedAt?: number; seeders?: number; grabs?: number; freeleech?: boolean;
  ids?: ReleaseIds; infoHash?: string;
};
// The file tk.box has for the title (library_files): its quality, whether it is a PROPER/REPACK, its group, and when
// its grab was sent; its score under the title's profile, when known (score upgrades need it).
export type LibraryFile = { quality: Quality; proper: boolean; group?: string; grabbedAt?: number; score?: number };
export type BlockedRelease = { name?: string; indexer?: string; guid?: string; infoHash?: string };
export type PickSettings = { earlyCopies: boolean; protocol: 'usenet-first' | 'torrent-first'; properDays: number };
export const defaultPickSettings = (): PickSettings => ({ earlyCopies: false, protocol: 'usenet-first', properDays: 7 });

// `runtime`: TMDB's, in minutes, for the size limits (DEFAULT_RUNTIME when unknown).
export type MovieWant = { kind: 'movie'; title: MovieTitle; have?: LibraryFile; runtime?: number };
// Episodes of one season. `pack`: a season search, which takes a season pack covering the season; otherwise single and
// multi-episode releases covering at least one of `episodes` (the ones wanted). `have`: the library's file for each
// episode that has one. `runtime`: an episode's, in minutes; `seasonEpisodes`: how many the season has, for a pack's size.
export type EpisodeWant = { kind: 'episode'; title: ShowTitle; season: number; episodes: readonly number[]; pack: boolean;
  have?: ReadonlyMap<number, LibraryFile>; runtime?: number; seasonEpisodes?: number };
export type Want = MovieWant | EpisodeWant;
const code = (season: number, episode?: number) => `S${String(season).padStart(2, '0')}${episode === undefined ? '' : `E${String(episode).padStart(2, '0')}`}`;

// What the release covers for a show want, or why it doesn't fit: the season, a pack only for a season search, an
// episode release only for an episode search and covering one that's wanted.
function episodeFit(parsed: ParsedRelease, want: EpisodeWant): { covers: number[]; count: number } | { reject: string } {
  if (parsed.multiSeason) return { reject: 'a multi-season pack' };
  if (parsed.season === undefined) return { reject: 'not an episode or season' };
  if (parsed.season !== want.season) return { reject: `season ${parsed.season} isn't ${want.season}` };
  if (parsed.seasonPack) {
    if (!want.pack) return { reject: 'a season pack; an episode is wanted' };
    const covers = [...new Set([...want.episodes, ...want.have?.keys() ?? []])].sort((a, b) => a - b);
    return { covers, count: Math.max(want.seasonEpisodes ?? 0, covers.length, 1) };
  }
  if (want.pack) return { reject: 'an episode; a season pack is wanted' };
  if (!parsed.episodes.some(e => want.episodes.includes(e))) return { reject: `${code(parsed.season, parsed.episodes[0])} isn't wanted` };
  return { covers: [...parsed.episodes], count: parsed.episodes.length };
}
export type PickContext = { profile: QualityProfile; formats: readonly Format[]; settings: PickSettings; blocklist?: readonly BlockedRelease[]; now: number };

export type Decision = {
  // `tier`: the profile's tier the quality is in (0 is best); `sizeTarget`: the middle of its size range, in bytes.
  release: Candidate; parsed: ParsedRelease; quality?: Quality; tier?: number; sizeTarget?: number;
  score: number; labels: string[];
  accepted: boolean; upgrade: boolean;
  reasons: string[];
  // The same, structured: every format that matched with its points, every reason it's rejected, and what makes it an
  // upgrade.
  scoreParts: Score['parts']; rejections: string[]; upgradeReason?: string;
};

const DAY = 86400000;
const gb = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1).replace(/\.0$/, '')} GB`;

const blocked = (release: Candidate, list: readonly BlockedRelease[]) => list.some(b =>
  (b.guid !== undefined && b.guid === release.guid && (b.indexer === undefined || b.indexer === release.indexer))
  || (b.infoHash !== undefined && !!release.infoHash && b.infoHash.toLowerCase() === release.infoHash.toLowerCase())
  || (b.name !== undefined && b.name.toLowerCase() === release.name.toLowerCase()));

const sameGroup = (a?: string, b?: string) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

// Better than the library's file:
// - a better tier while the file is below the cutoff (in a fallback tier; or, on a rung the profile doesn't take,
//   under the profile's lowest preferred rung, judged by ladder rank);
// - the file's tier or better, scoring at least upgradeStep more while the file scores under upgradeUntil;
// - a PROPER/REPACK of the same rung and group within properDays of the grab.
type Against = { quality: Quality; tier: number; score: number; parsed: ParsedRelease };
function againstLibrary({ quality, tier, score, parsed }: Against, have: LibraryFile | undefined, ctx: PickContext): { ok: boolean; reason?: string; upgrade: boolean } {
  if (!have) return { ok: true, upgrade: false };
  const { profile } = ctx, haveTier = tierOf(profile, have.quality);
  const better = haveTier >= 0 ? tier < haveTier : rank(quality) > rank(have.quality);
  const notWorse = haveTier >= 0 ? tier <= haveTier : rank(quality) >= rank(have.quality);
  const meets = meetsCutoff(profile, have.quality);
  if (better && !meets) return { ok: true, upgrade: true, reason: `upgrade from ${have.quality}` };
  const until = profile.upgradeUntil, scoring = until !== undefined && have.score !== undefined && notWorse;
  if (scoring && have.score! < until! && score >= have.score! + profile.upgradeStep)
    return { ok: true, upgrade: true, reason: `upgrade from score ${have.score} to ${score}` };
  if (quality === have.quality && (parsed.proper || parsed.repack) && !have.proper) {
    const kind = parsed.repack ? 'REPACK' : 'PROPER';
    const fresh = have.grabbedAt !== undefined && ctx.now - have.grabbedAt <= ctx.settings.properDays * DAY;
    if (sameGroup(parsed.group, have.group) && fresh) return { ok: true, upgrade: true, reason: `${kind} of the library's ${have.quality} from ${parsed.group}` };
    if (!sameGroup(parsed.group, have.group)) return { ok: false, upgrade: false, reason: `a ${kind} from another group than the library's ${have.group ?? 'file'}` };
    return { ok: false, upgrade: false, reason: `a ${kind} more than ${ctx.settings.properDays} days after the grab` };
  }
  if (better) return { ok: false, upgrade: false, reason: `the library's ${have.quality} already meets the cutoff` };
  if (scoring && have.score! >= until!) return { ok: false, upgrade: false, reason: `the library's file already scores ${have.score}, the upgrade-until is ${until}` };
  return { ok: false, upgrade: false, reason: `no better than the library's ${have.quality}${scoring ? ` (score ${score}, an upgrade needs ${have.score! + profile.upgradeStep})` : ''}` };
}

// Whether a downloaded file betters the library's file for one episode, by the same rules a pick uses (the import of a
// pack skips an episode it doesn't better). A quality the profile doesn't take betters nothing the library has.
export function bettersLibrary(file: { quality: Quality; score: number; parsed: ParsedRelease }, have: LibraryFile | undefined, ctx: PickContext): { ok: boolean; reason?: string } {
  if (!have) return { ok: true };
  const tier = tierOf(ctx.profile, file.quality);
  if (tier < 0) return { ok: false, reason: `quality ${file.quality} isn't allowed` };
  const { ok, reason } = againstLibrary({ ...file, tier }, have, ctx);
  return { ok, ...(reason ? { reason } : {}) };
}

export function decide(release: Candidate, want: Want, ctx: PickContext): Decision {
  // A show filed under another TVDB series reads the release in its own season numbers (lib/release-name.ts).
  const raw = parseRelease(release.name, new Date(ctx.now).getUTCFullYear());
  const numbered = want.kind === 'episode' ? inShowNumbering(raw, want.title) : raw, parsed = typeof numbered === 'string' ? raw : numbered;
  const { profile } = ctx;
  let quality = qualityOf(parsed);
  if (!quality && tierOf(profile, 'Unknown') >= 0) quality = 'Unknown';
  const tier = quality ? tierOf(profile, quality) : -1;
  const { score, bans, labels, matched, parts } = scoreFormats({ parsed, ...(quality ? { quality } : {}), ...(release.freeleech !== undefined ? { freeleech: release.freeleech } : {}) },
    ctx.formats, profile.scores);
  const rejects: string[] = [];
  if (blocked(release, ctx.blocklist ?? [])) rejects.push('on the blocklist');
  if (bans.length) rejects.push(`banned by ${bans.join(', ')}`);
  if (!quality) rejects.push('quality unknown');
  else if (EARLY_COPIES.has(quality) && !ctx.settings.earlyCopies) rejects.push(`${quality} is an early copy, and Early copies is off`);
  else if (tier < 0) rejects.push(`quality ${quality} isn't allowed`);
  if (profile.minScore !== undefined && score < profile.minScore) rejects.push(`score ${score} under the minimum ${profile.minScore}`);
  // What it is: a movie, or episodes of the wanted season (and how many, for the size limits).
  let fit: { covers: number[]; count: number } | undefined;
  if (want.kind === 'movie') {
    if (parsed.multiSeason) rejects.push('a multi-season pack');
    else if (parsed.season !== undefined) rejects.push(`an episode or season, not a movie`);
  } else {
    const f = typeof numbered === 'string' ? { reject: numbered } : episodeFit(parsed, want);
    if ('reject' in f) rejects.push(f.reject); else fit = f;
  }
  const match = want.kind === 'movie' ? matchMovie(parsed, want.title, release.ids) : matchShow(parsed, want.title, release.ids);
  if (!match.ok) rejects.push(match.reason);
  const runtime = want.kind === 'movie' ? want.runtime || DEFAULT_RUNTIME.movie : (want.runtime || DEFAULT_RUNTIME.show) * (fit?.count ?? 1);
  const limits = quality && tier >= 0 && !EARLY_COPIES.has(quality) ? sizeLimits(profile.tiers[tier]!, runtime) : undefined;
  if (release.size !== undefined && limits) {
    if (release.size > limits.max) rejects.push(`size ${gb(release.size)} over ${gb(limits.max)}`);
    else if (release.size < limits.min) rejects.push(`size ${gb(release.size)} under ${gb(limits.min)}`);
  }
  if (release.protocol === 'torrent' && release.seeders === 0) rejects.push('no seeders');
  let upgrade = false, upgradeReason: string | undefined;
  if (quality && tier >= 0 && want.kind === 'movie') {
    const library = againstLibrary({ quality, tier, score, parsed }, want.have, ctx);
    if (!library.ok) rejects.push(library.reason!);
    else { upgrade = library.upgrade; upgradeReason = library.reason; }
  } else if (quality && tier >= 0 && want.kind === 'episode' && fit) {
    // Each episode it covers that the library has must be bettered: a pack or multi-episode release never replaces an
    // episode with one no better.
    for (const episode of fit.covers) {
      const library = againstLibrary({ quality, tier, score, parsed }, want.have?.get(episode), ctx);
      if (!library.ok) { rejects.push(`${code(want.season, episode)}: ${library.reason!}`); break; }
      if (library.upgrade && !upgrade) { upgrade = true; upgradeReason = fit.covers.length > 1 ? `${code(want.season, episode)}: ${library.reason}` : library.reason; }
    }
  }
  const scoreText = `score ${score > 0 ? '+' : ''}${score}${matched.length ? ` (${matched.join(', ')})` : ''}`;
  const reasons = rejects.length ? rejects.map(r => `rejected: ${r}`)
    : [`accepted: ${quality}, ${scoreText}`, ...(upgradeReason ? [upgradeReason] : []), ...(fewSeeders(release) ? [`few seeders (${release.seeders}): ranked last in its tier`] : [])];
  return { release, parsed, ...(quality ? { quality } : {}), ...(tier >= 0 ? { tier } : {}), ...(limits ? { sizeTarget: limits.target } : {}),
    score, labels, accepted: !rejects.length, upgrade: !rejects.length && upgrade, reasons,
    scoreParts: parts, rejections: rejects, ...(!rejects.length && upgradeReason ? { upgradeReason } : {}) };
}

// Swarm sizes (docs/STALLS.md, "Pick fast releases"): within a tier, a torrent known to have under FEW_SEEDERS ranks
// after every other release; at HEALTHY_SEEDERS or more it beats a smaller swarm before size is weighed. A better tier
// still wins whatever its seeders. Unknown counts and Usenet are never few.
export const FEW_SEEDERS = 5, HEALTHY_SEEDERS = 20;
type Swarm = Pick<Partial<Candidate>, 'protocol' | 'seeders'>;
export const fewSeeders = (r: Swarm) => r.protocol === 'torrent' && r.seeders !== undefined && r.seeders < FEW_SEEDERS;
const healthy = (r: Swarm) => r.protocol !== 'torrent' || r.seeders === undefined || r.seeders >= HEALTHY_SEEDERS;

// Best first: the profile's tier, then few seeders last, then protocol by the setting, then score, then a healthy
// swarm, then size closest to the middle of the tier's range, then seeders (torrents) or grabs (Usenet), then the newest.
type RankedRelease = Pick<Decision, 'tier' | 'sizeTarget'> & { score?: number; release: Pick<Partial<Candidate>, 'protocol' | 'size' | 'seeders' | 'grabs' | 'publishedAt'> };
export function compareDecisions(a: RankedRelease, b: RankedRelease, ctx: PickContext): number {
  const byTier = a.tier! - b.tier!;
  if (byTier) return byTier;
  if (fewSeeders(a.release) !== fewSeeders(b.release)) return fewSeeders(a.release) ? 1 : -1;
  const first: Protocol = ctx.settings.protocol === 'torrent-first' ? 'torrent' : 'usenet';
  if (a.release.protocol && b.release.protocol && a.release.protocol !== b.release.protocol) return a.release.protocol === first ? -1 : 1;
  if (a.score !== undefined && b.score !== undefined && a.score !== b.score) return b.score - a.score;
  if (healthy(a.release) !== healthy(b.release)) return healthy(a.release) ? -1 : 1;
  const distance = (d: RankedRelease) => d.release.size === undefined || d.sizeTarget === undefined ? Number.MAX_SAFE_INTEGER : Math.abs(d.release.size - d.sizeTarget);
  if (distance(a) !== distance(b)) return distance(a) - distance(b);
  const popularity = (d: RankedRelease) => (d.release.protocol === 'torrent' ? d.release.seeders : d.release.grabs) ?? 0;
  if (popularity(a) !== popularity(b)) return popularity(b) - popularity(a);
  return (b.release.publishedAt ?? 0) - (a.release.publishedAt ?? 0);
}

// Every candidate's decision, the accepted ones ranked first, then the rejected in the order found; and the best.
export function pick(candidates: readonly Candidate[], want: Want, ctx: PickContext): { decisions: Decision[]; best?: Decision } {
  const decisions = candidates.map(c => decide(c, want, ctx));
  const accepted = decisions.filter(d => d.accepted).sort((a, b) => compareDecisions(a, b, ctx));
  const best = accepted[0];
  return { decisions: [...accepted, ...decisions.filter(d => !d.accepted)], ...(best ? { best } : {}) };
}
