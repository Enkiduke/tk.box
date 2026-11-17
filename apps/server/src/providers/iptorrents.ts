import { SaxesParser } from 'saxes';
import { IndexerError } from './newznab.js';
import { readTorrent } from './bencode.js';

// IPTorrents, read directly (docs/ARR-REPLACEMENT.md, "Clients" › IPTorrents): the personal RSS feed (its links carry
// the passkey), the search page read with the browser cookie and user agent, and the .torrent itself. The page is read
// the way the common IPTorrents indexer definition reads it: rows of `table#torrents`, the title in `a.hv`, the download link
// `a[href^="/download.php/"]`, size, snatches, seeders and leechers found by their header ("Sort by size", …),
// freeleech by `span.free`, and the page is signed in only when it links to lout.php.

export const IPTORRENTS = 'https://iptorrents.com';
export const PASSKEY = '{passkey}';

// The site's category ids and the Newznab category each maps to (movies and TV). Admin picks Newznab ids; a parent (2000, 5000) takes every site category under it.
export const SITE_CATEGORIES: readonly (readonly [site: number, newznab: number, name: string])[] = [
  [72, 2000, 'Movies'], [87, 2060, 'Movie/3D'], [77, 2030, 'Movie/480p'], [101, 2045, 'Movie/4K'], [89, 2040, 'Movie/BD-R'],
  [90, 2030, 'Movie/BD-Rip'], [96, 2030, 'Movie/Cam'], [6, 2070, 'Movie/DVD-R'], [48, 2050, 'Movie/HD/Bluray'], [54, 2000, 'Movie/Kids'],
  [62, 2030, 'Movie/MP4'], [38, 2010, 'Movie/Non-English'], [68, 2000, 'Movie/Packs'], [20, 2080, 'Movie/Web-DL'], [7, 2030, 'Movie/Xvid'],
  [100, 2000, 'Movie/x265'],
  [73, 5000, 'TV'], [26, 5080, 'TV/Documentaries'], [55, 5060, 'Sports'], [78, 5030, 'TV/480p'], [23, 5040, 'TV/BD'], [24, 5030, 'TV/DVD-R'],
  [25, 5030, 'TV/DVD-Rip'], [66, 5030, 'TV/Mobile'], [82, 5020, 'TV/Non-English'], [65, 5000, 'TV/Packs'], [83, 5020, 'TV/Packs/Non-English'],
  [79, 5030, 'TV/SD/x264'], [22, 5010, 'TV/Web-DL'], [5, 5040, 'TV/x264'], [99, 5040, 'TV/x265'], [4, 5030, 'TV/Xvid'],
];
export const NEWZNAB_CATEGORIES = new Set(SITE_CATEGORIES.map(([, n]) => n).concat([2000, 5000]));
// The default categories: the ones you use (2026-11-15).
export const IPT_DEFAULT_CATEGORIES = { movies: [2000, 2010, 2030, 2040, 2045, 2050, 2060, 2070, 2080], tv: [5000, 5010, 5020, 5030, 5040] };

export function siteCategories(newznab: readonly number[]) {
  const ids = new Set<number>();
  for (const cat of newznab) {
    for (const [site, n] of SITE_CATEGORIES) if (n === cat || (cat % 1000 === 0 && Math.floor(n / 1000) === cat / 1000)) ids.add(site);
  }
  return [...ids].sort((a, b) => a - b);
}
const newznabOf = (site: number | undefined) => SITE_CATEGORIES.find(([s]) => s === site)?.[1];

// The search page's address: the site categories as bare keys, then q (a Sphinx group), qf=all for an IMDb id (it is
// in the description), and free=on for freeleech only.
export function searchUrl(input: { categories: readonly number[]; imdbId?: string; term?: string; freeleechOnly?: boolean }, base = IPTORRENTS) {
  const parts = siteCategories(input.categories).map(String);
  if (input.imdbId) parts.push(`q=${encodeURIComponent(`+(${input.imdbId})`)}`, 'qf=all');
  else if (input.term) parts.push(`q=${encodeURIComponent(`+(${input.term})`)}`);
  if (input.freeleechOnly) parts.push('free=on');
  return `${base}/t${parts.length ? `?${parts.join('&')}` : ''}`;
}

export type IptItem = {
  id: string; name: string; link: string; size?: number; seeders?: number; leechers?: number; snatched?: number;
  freeleech: boolean; publishedAt?: number; categories: number[];
};

// ---- HTML ----

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
export const decodeEntities = (text: string) => text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, code: string) => {
  if (code[0] === '#') { const n = code[1]?.toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : Number(code.slice(1)); return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : all; }
  return ENTITIES[code.toLowerCase()] ?? all;
});
const textOf = (html: string) => decodeEntities(html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
const attr = (tag: string, name: string) => {
  const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  return m ? decodeEntities(m[1] ?? m[2] ?? m[3] ?? '') : undefined;
};
const hasClass = (tag: string, name: string) => (attr(tag, 'class') ?? '').split(/\s+/).includes(name);
const UNITS: Record<string, number> = { B: 1, KB: 1024, KIB: 1024, MB: 1024 ** 2, MIB: 1024 ** 2, GB: 1024 ** 3, GIB: 1024 ** 3, TB: 1024 ** 4, TIB: 1024 ** 4 };
export function bytesOf(text: string) {
  const m = /([\d.,]+)\s*([KMGT]?i?B)\b/i.exec(text);
  if (!m) return undefined;
  const n = Number(m[1]!.replace(/,/g, '')), unit = UNITS[m[2]!.toUpperCase()];
  return Number.isFinite(n) && unit ? Math.round(n * unit) : undefined;
}
const intOf = (text: string | undefined) => { const m = /-?\d[\d,]*/.exec(text ?? ''); return m ? Number(m[0].replace(/,/g, '')) : undefined; };
// "2.3 hours ago", "1 day ago", "3.0 weeks ago" → when.
const AGO: Record<string, number> = { second: 1000, sec: 1000, minute: 60000, min: 60000, hour: 3600000, day: 86400000, week: 7 * 86400000, month: 30 * 86400000, year: 365 * 86400000 };
export function timeAgo(text: string, now: number) {
  const m = /([\d.]+)\s*(sec(?:ond)?|min(?:ute)?|hour|day|week|month|year)s?\s+ago/i.exec(text);
  if (!m) return undefined;
  return Math.round(now - Number(m[1]) * AGO[m[2]!.toLowerCase()]!);
}
export const torrentId = (link: string) => /\/download\.php\/(\d+)\//.exec(link)?.[1] ?? /[?&;]id=(\d+)/.exec(link)?.[1] ?? /\/t\/(\d+)/.exec(link)?.[1] ?? /\/details\.php\?id=(\d+)/.exec(link)?.[1];

// The cells of one row, td or th, as their outer HTML. The table has no nested tables.
const cellsOf = (row: string) => [...row.matchAll(/<(t[dh])\b[^>]*>[\s\S]*?(?=<t[dh]\b|<\/tr>|$)/gi)].map(m => m[0]);

export type SearchPage = { signedIn: boolean; items: IptItem[] };
export function parseSearchPage(html: string, now = Date.now(), base = IPTORRENTS): SearchPage {
  const signedIn = html.includes('lout.php');
  const start = html.search(/<table\b[^>]*\bid\s*=\s*["']?torrents\b/i);
  if (!signedIn || start < 0) return { signedIn, items: [] };
  const end = html.indexOf('</table>', start);
  const table = html.slice(start, end < 0 ? undefined : end);
  const rows = table.split(/<tr\b/i).slice(1).map(r => `<tr${r}`);
  // The header labels (text, or a link's title), to find the columns; else its defaults.
  const header = rows.find(r => /<th\b/i.test(r));
  const labels = header ? cellsOf(header).map(cell => `${textOf(cell)} ${[...cell.matchAll(/\btitle\s*=\s*"([^"]*)"/gi)].map(m => m[1]).join(' ')}`.toLowerCase()) : [];
  const column = (label: string) => { const i = labels.findIndex(l => l.includes(label)); return i >= 0 ? i : undefined; };
  const items: IptItem[] = [];
  for (const row of rows) {
    if (/<th\b/i.test(row)) continue;
    const cells = cellsOf(row);
    const title = /<a\b[^>]*>/gi, titles = [...row.matchAll(title)].map(m => m[0]);
    const titleTag = titles.find(tag => hasClass(tag, 'hv'));
    const downloadTag = titles.find(tag => (attr(tag, 'href') ?? '').startsWith('/download.php/'));
    if (!titleTag || !downloadTag) continue;
    const titleAt = row.indexOf(titleTag), titleEnd = row.indexOf('</a>', titleAt);
    const name = textOf(row.slice(titleAt + titleTag.length, titleEnd)).replace(/\u000f/g, '');
    const href = attr(downloadTag, 'href')!, id = torrentId(href);
    if (!name || !id) continue;
    const ten = cells.length >= 10;
    const cell = (i: number | undefined) => i !== undefined ? cells[i] : undefined;
    const size = bytesOf(textOf(cell(column('sort by size') ?? 5) ?? ''));
    const snatched = intOf(textOf(cell(column('sort by snatches') ?? (ten ? 7 : 6)) ?? ''));
    const seeders = intOf(textOf(cell(column('sort by seeders') ?? (ten ? 8 : 7)) ?? ''));
    const leechers = intOf(textOf(cell(column('sort by leechers') ?? (ten ? 9 : 8)) ?? ''));
    const sub = /<div\b[^>]*class\s*=\s*["'][^"']*\bsub\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i.exec(row);
    const when = sub ? timeAgo(textOf(sub[1]!).split('|').pop()!.split(' by ')[0]!, now) : undefined;
    // The category's icon link in the first cell (`?72`), when the site shows the category column as icons.
    const catHref = cells[0] ? /<a\b[^>]*href\s*=\s*["'][^"']*\?(\d+)/i.exec(cells[0])?.[1] : undefined;
    const category = newznabOf(catHref ? Number(catHref) : undefined);
    items.push({
      id, name, link: new URL(href, base).toString(), freeleech: /<span\b[^>]*class\s*=\s*["'][^"']*\bfree\b/i.test(row), categories: category ? [category] : [],
      ...(size !== undefined ? { size } : {}), ...(seeders !== undefined ? { seeders } : {}), ...(leechers !== undefined ? { leechers } : {}),
      ...(snatched !== undefined ? { snatched } : {}), ...(when !== undefined ? { publishedAt: when } : {}),
    });
  }
  return { signedIn, items };
}

// ---- RSS ----

// The passkey in the personal RSS address (`tp=`), which its links carry too.
export const passkeyOf = (rssUrl: string) => /[?;&]tp=([A-Za-z0-9]+)/.exec(rssUrl)?.[1];
// A link with its passkey swapped for a placeholder, so it can be kept in the queue and shown; put back on download.
export const withoutPasskey = (link: string, passkey: string | undefined) => passkey && passkey.length >= 8 ? link.split(passkey).join(PASSKEY) : link;

// The personal feed: each item's title, link (a download link with the passkey, or a details link), date, and the
// description's size and category ("1.37 GB; Movie/Web-DL").
export function parseRss(xml: string, passkey?: string): IptItem[] {
  const parser = new SaxesParser();
  const items: IptItem[] = [];
  let item: Record<string, string> | undefined, field: string | undefined, text = '';
  parser.on('opentag', ({ name }) => {
    if (name === 'item') { item = {}; return; }
    if (item && ['title', 'link', 'pubDate', 'description', 'guid', 'category'].includes(name)) { field = name; text = ''; }
  });
  const take = (chunk: string) => { if (field) text += chunk; };
  parser.on('text', take);
  parser.on('cdata', take);
  parser.on('closetag', ({ name }) => {
    if (item && field && name === field) { item[field] = (item[field] ? `${item[field]} ` : '') + text.trim(); field = undefined; return; }
    if (name !== 'item' || !item) return;
    const { title, link, pubDate, description = '', category = '' } = item;
    item = undefined;
    if (!title || !link) return;
    const id = torrentId(link);
    if (!id) return;
    const at = pubDate ? Date.parse(pubDate) : NaN, size = bytesOf(description);
    const catName = (description.split(';')[1] ?? category).trim().toLowerCase();
    // The longest category name the text starts with ("movie/web-dl freeleech" is Movie/Web-DL).
    const cat = SITE_CATEGORIES.filter(([, , n]) => catName === n.toLowerCase() || catName.startsWith(`${n.toLowerCase()} `))
      .sort((a, b) => b[2].length - a[2].length)[0]?.[1];
    items.push({ id, name: decodeEntities(title), link: withoutPasskey(link, passkey), freeleech: /free\s*leech/i.test(`${description} ${category}`),
      categories: cat ? [cat] : [], ...(size !== undefined ? { size } : {}), ...(Number.isFinite(at) ? { publishedAt: at } : {}) });
  });
  parser.write(xml).close();
  return items;
}

// ---- The client ----

export type IptSecret = { rssUrl?: string; cookie?: string; userAgent?: string };
export const IPT_COOKIE_FORMAT_ERROR = 'Paste the full IPTorrents Cookie value from your browser’s Request Headers (uid=…; pass=…).';

export function isIptCookieHeader(cookie: string) {
  return cookie.trim().replace(/;$/, '').split(';').every(pair => /^[\w!#$%&'*+.^`|~-]+=/.test(pair.trimStart()));
}

const isIptHost = (url: URL, also?: string) => { const h = url.hostname.toLowerCase(); return h === 'iptorrents.com' || h.endsWith('.iptorrents.com') || h === also; };
const looksSignedOut = (body: string) => /<html|<form|<!doctype/i.test(body.slice(0, 4096)) && !body.includes('lout.php');

export class IPTorrents {
  constructor(private secret: IptSecret, private transport: typeof fetch = fetch, private base = IPTORRENTS, private timeoutMs = 30000) {}

  private async get(url: string, withCookie: boolean, maxBytes: number, signal?: AbortSignal) {
    const headers: Record<string, string> = { 'User-Agent': this.secret.userAgent || 'tk.box/0.0.1' };
    if (withCookie) {
      if (!this.secret.cookie) throw new IndexerError('cookie', 'IPTorrents has no cookie saved.');
      if (!isIptCookieHeader(this.secret.cookie)) throw new IndexerError('other', IPT_COOKIE_FORMAT_ERROR);
      headers.Cookie = this.secret.cookie;
    }
    let response: Response;
    try {
      response = await this.transport(url, { headers, redirect: 'follow',
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]) : AbortSignal.timeout(this.timeoutMs) });
    } catch (e) {
      if (signal?.aborted) throw e;
      throw new IndexerError('other', 'IPTorrents could not be reached.');
    }
    if (response.status === 429) { await response.body?.cancel(); throw new IndexerError('rate', 'IPTorrents answered 429 (too many requests).'); }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > maxBytes) throw new IndexerError('other', 'IPTorrents sent too much data.');
    if (response.status >= 400) throw new IndexerError(response.status === 401 || response.status === 403 ? 'cookie' : 'other', `IPTorrents answered ${response.status}.`);
    return bytes;
  }

  // One search page. A page without lout.php means the cookie has expired.
  async search(input: Parameters<typeof searchUrl>[0], signal?: AbortSignal, now = Date.now()) {
    const page = parseSearchPage((await this.get(searchUrl(input, this.base), true, 8 * 1024 * 1024, signal)).toString('utf8'), now, this.base);
    if (!page.signedIn) throw new IndexerError('cookie', 'IPTorrents cookie expired: the page shows the signed-out form.');
    return page.items;
  }

  // Admin's Test: the search page, signed in.
  async check(signal?: AbortSignal) {
    const html = (await this.get(`${this.base}/t`, true, 8 * 1024 * 1024, signal)).toString('utf8');
    if (!html.includes('lout.php')) throw new IndexerError('cookie', 'IPTorrents cookie expired: the page shows the signed-out form.');
    return true;
  }

  async rss(signal?: AbortSignal) {
    if (!this.secret.rssUrl) throw new IndexerError('other', 'IPTorrents has no RSS address saved.');
    const xml = (await this.get(this.secret.rssUrl, false, 8 * 1024 * 1024, signal)).toString('utf8');
    if (!/<rss|<channel/i.test(xml.slice(0, 2048))) throw new IndexerError('other', 'The IPTorrents RSS address didn’t answer with a feed.');
    return parseRss(xml, passkeyOf(this.secret.rssUrl));
  }

  // The .torrent, with its info hash. A link from the feed gets its passkey back; any other goes with the cookie.
  async torrent(link: string, signal?: AbortSignal): Promise<{ bytes: Buffer; infoHash: string }> {
    const passkey = this.secret.rssUrl ? passkeyOf(this.secret.rssUrl) : undefined;
    const keyed = link.includes(PASSKEY);
    if (keyed && !passkey) throw new IndexerError('other', 'That link needs the RSS passkey, and no RSS address is saved.');
    const url = keyed ? link.split(PASSKEY).join(passkey!) : link;
    let parsed: URL;
    try { parsed = new URL(url); } catch { throw new IndexerError('other', 'That torrent link isn’t a web address.'); }
    const rssHost = this.secret.rssUrl ? new URL(this.secret.rssUrl).hostname.toLowerCase() : undefined;
    if (parsed.protocol !== 'https:' || !isIptHost(parsed, rssHost)) throw new IndexerError('other', 'That torrent link isn’t IPTorrents’.');
    const bytes = await this.get(url, !keyed && !!this.secret.cookie, 16 * 1024 * 1024, signal);
    try { return { bytes, ...readTorrent(bytes) }; }
    catch {
      if (looksSignedOut(bytes.toString('utf8'))) throw new IndexerError(keyed ? 'other' : 'cookie', keyed ? 'IPTorrents refused the passkey link.' : 'IPTorrents cookie expired: the page shows the signed-out form.');
      throw new IndexerError('other', 'IPTorrents didn’t send a torrent file.');
    }
  }
}
