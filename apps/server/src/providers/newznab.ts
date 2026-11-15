import { SaxesParser } from 'saxes';

// NZBGeek's Newznab API (docs/ARR-REPLACEMENT.md, "Clients" › NZBGeek): the XML parse and the HTTP calls. The API key
// goes in the query; links kept from a feed have it taken out, and it is added back only for NZBGeek's own hosts.

export const NZBGEEK_API = 'https://api.nzbgeek.info/api';
export type NewznabItem = {
  title: string; guid: string; link: string;
  size?: number; publishedAt?: number; categories: number[];
  imdb?: string; tvdbid?: number; grabs?: number; usenetDate?: number;
};
export type NewznabError = { code: number; description: string };
export type NewznabFeed = { items: NewznabItem[]; error?: NewznabError };

const number = (value: string | undefined) => {
  if (value === undefined || value.trim() === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
};
const date = (value: string | undefined) => {
  if (!value) return undefined;
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : undefined;
};

// The link without its apikey, so it can be kept and shown.
export function withoutKey(link: string) {
  try {
    const url = new URL(link);
    for (const name of [...url.searchParams.keys()]) if (name.toLowerCase() === 'apikey' || name.toLowerCase() === 'r') url.searchParams.delete(name);
    return url.toString();
  } catch { return link; }
}

// A Newznab RSS answer (search, movie, tvsearch, or the new-release feed), or its <error code description/>.
export function parseNewznab(xml: string): NewznabFeed {
  const parser = new SaxesParser();
  const items: NewznabItem[] = [];
  let error: NewznabError | undefined;
  let item: { fields: Record<string, string>; attrs: Record<string, string>; categories: number[]; enclosure?: { url?: string; length?: string } } | undefined;
  let field: string | undefined, text = '';
  parser.on('opentag', ({ name, attributes }) => {
    const attr = attributes as Record<string, string>;
    if (name === 'error' && !item) { error = { code: Number(attr.code ?? 0), description: attr.description ?? 'Unknown error' }; return; }
    if (name === 'item') { item = { fields: {}, attrs: {}, categories: [] }; return; }
    if (!item) return;
    if (name === 'newznab:attr' || name === 'torznab:attr') {
      const key = attr.name, value = attr.value;
      if (!key || value === undefined) return;
      if (key === 'category') { const c = number(value); if (c !== undefined) item.categories.push(c); }
      else item.attrs[key] = value;
      return;
    }
    if (name === 'enclosure') { item.enclosure = { ...(attr.url ? { url: attr.url } : {}), ...(attr.length ? { length: attr.length } : {}) }; return; }
    if (['title', 'guid', 'link', 'pubDate', 'size'].includes(name)) { field = name; text = ''; }
  });
  const take = (chunk: string) => { if (field) text += chunk; };
  parser.on('text', take);
  parser.on('cdata', take);
  parser.on('closetag', ({ name }) => {
    if (item && field && name === field) { item.fields[field] = text.trim(); field = undefined; return; }
    if (name !== 'item' || !item) return;
    const { fields, attrs, categories, enclosure } = item;
    item = undefined;
    const link = fields.link || enclosure?.url, title = fields.title;
    if (!title || !link) return;
    const size = number(attrs.size) ?? number(fields.size) ?? number(enclosure?.length);
    const imdb = attrs.imdb?.replace(/^tt/i, '').trim(), tvdbid = number(attrs.tvdbid), grabs = number(attrs.grabs);
    const publishedAt = date(fields.pubDate), usenetDate = date(attrs.usenetdate);
    items.push({
      title, guid: fields.guid || link, link: withoutKey(link), categories,
      ...(size !== undefined && size > 0 ? { size } : {}), ...(publishedAt !== undefined ? { publishedAt } : {}),
      ...(imdb && /^\d+$/.test(imdb) && Number(imdb) > 0 ? { imdb } : {}), ...(tvdbid ? { tvdbid } : {}),
      ...(grabs !== undefined ? { grabs } : {}), ...(usenetDate !== undefined ? { usenetDate } : {}),
    });
  });
  parser.write(xml).close();
  return { items, ...(error ? { error } : {}) };
}

// Why a call failed. `rate`: a 429, or Newznab's request or download limit (codes 500, 501), which pauses the indexer
// until the next hour. `auth`: the key was refused or the account is suspended (100–102). `other`: the rest.
export class IndexerError extends Error {
  constructor(public kind: 'rate' | 'auth' | 'other', message: string) { super(message); }
}

const errorKind = (code: number): IndexerError['kind'] => code >= 100 && code <= 102 ? 'auth' : code === 500 || code === 501 || code === 429 ? 'rate' : 'other';

async function readText(response: Response, maxBytes: number): Promise<Buffer> {
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.length;
      if (size > maxBytes) { await reader.cancel(); throw new IndexerError('other', 'NZBGeek sent too much data.'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks);
}

export const isNzbGeekHost = (link: string) => {
  try { const host = new URL(link).hostname.toLowerCase(); return host === 'nzbgeek.info' || host.endsWith('.nzbgeek.info'); } catch { return false; }
};

export class NzbGeek {
  constructor(private key: string, private transport: typeof fetch = fetch, private base = NZBGEEK_API, private timeoutMs = 30000) {}

  private async get(url: URL, signal: AbortSignal | undefined, maxBytes: number) {
    let response: Response;
    try {
      response = await this.transport(url, { headers: { 'User-Agent': 'tk.box/0.0.1' }, redirect: 'follow',
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]) : AbortSignal.timeout(this.timeoutMs) });
    } catch (e) {
      if (signal?.aborted) throw e;
      throw new IndexerError('other', 'NZBGeek could not be reached.');
    }
    if (response.status === 429) { await response.body?.cancel(); throw new IndexerError('rate', 'NZBGeek answered 429 (too many requests).'); }
    if (response.status === 401 || response.status === 403) { await response.body?.cancel(); throw new IndexerError('auth', `NZBGeek refused the API key (${response.status}).`); }
    const body = await readText(response, maxBytes);
    if (response.status >= 400) {
      const error = safeParse(body.toString('utf8')).error;
      throw new IndexerError(error ? errorKind(error.code) : 'other', error ? `NZBGeek: ${error.description} (${error.code}).` : `NZBGeek answered ${response.status}.`);
    }
    return body;
  }

  // One API call (t=search, t=movie, t=tvsearch) with these parameters; extended=1 asks for every attribute.
  async call(params: Record<string, string>, signal?: AbortSignal): Promise<NewznabItem[]> {
    const url = new URL(this.base);
    for (const [k, v] of Object.entries({ ...params, extended: '1', o: 'xml' })) url.searchParams.set(k, v);
    url.searchParams.set('apikey', this.key);
    const feed = safeParse((await this.get(url, signal, 16 * 1024 * 1024)).toString('utf8'));
    if (feed.error) throw new IndexerError(errorKind(feed.error.code), `NZBGeek: ${feed.error.description} (${feed.error.code}).`);
    return feed.items;
  }

  // The NZB file itself, fetched by tk.box so the key never reaches SABnzbd.
  async nzb(link: string, signal?: AbortSignal): Promise<Buffer> {
    if (!isNzbGeekHost(link)) throw new IndexerError('other', 'That NZB link isn’t NZBGeek’s.');
    const url = new URL(link);
    url.searchParams.set('apikey', this.key);
    const body = await this.get(url, signal, 64 * 1024 * 1024);
    const head = body.subarray(0, 4096).toString('utf8');
    if (!/<nzb[\s>]/i.test(head) && !/<nzb[\s>]/i.test(body.toString('utf8'))) {
      const error = safeParse(body.toString('utf8')).error;
      if (error) throw new IndexerError(errorKind(error.code), `NZBGeek: ${error.description} (${error.code}).`);
      throw new IndexerError('other', 'NZBGeek didn’t send an NZB file.');
    }
    return body;
  }
}

function safeParse(xml: string): NewznabFeed {
  try { return parseNewznab(xml); } catch { return { items: [], error: { code: 900, description: 'The answer wasn’t valid XML' } }; }
}
