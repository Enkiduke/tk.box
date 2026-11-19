// A public list page as the collections sources read it: its structured data (JSON-LD and Next.js data scripts), its
// <title>, its links (with their text and image alt text, whether they sit in a table, and the movie/TV section heading
// above them) and Letterboxd's poster slugs. Scripts are never run; this is a small tolerant tokenizer, not a full HTML
// parser, and reads only what those need.
export type PageLink = { url: string; title: string; next: boolean; table: boolean; media: 'movie' | 'tv' | null };
export type ParsedPage = { scripts: unknown[]; links: PageLink[]; posters: { url: string; title: string }[]; title: string };

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', bull: '•', middot: '·', eacute: 'é', egrave: 'è', aacute: 'á', oacute: 'ó', iacute: 'í', uacute: 'ú', ntilde: 'ñ', ouml: 'ö', uuml: 'ü', auml: 'ä', ccedil: 'ç' };
export function decodeEntities(text: string) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);?/gi, (whole, name: string) => {
    if (name[0] === '#') {
      const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return NAMED[name.toLowerCase()] ?? whole;
  });
}
function attributes(text: string) {
  const found: Record<string, string> = {};
  for (const m of text.matchAll(/([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
    const name = m[1]!.toLowerCase();
    if (!(name in found)) found[name] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
  }
  return found;
}
const RAW = new Set(['script', 'style', 'textarea', 'title']);

export function parsePage(html: string): ParsedPage {
  const page: ParsedPage = { scripts: [], links: [], posters: [], title: '' };
  let link: PageLink | undefined, heading = '', headingTag: string | undefined, section: PageLink['media'] = null, tables = 0;
  const text = (data: string) => { if (headingTag) heading += data; if (link) link.title += data; };
  const end = (tag: string) => {
    if (tag === 'table') tables = Math.max(0, tables - 1);
    if (tag === headingTag) {
      section = /\b(movies|films)\b/i.test(heading) ? 'movie' : /\b(tv|shows|series)\b/i.test(heading) ? 'tv' : null;
      headingTag = undefined;
    }
    if (tag === 'a' && link) { link.title = link.title.split(/\s+/).filter(Boolean).join(' '); page.links.push(link); link = undefined; }
  };
  const tag = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<![^>]*>|<\?[^>]*>|<(\/?)([a-zA-Z][\w:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
  let at = 0;
  for (let m = tag.exec(html); m; m = tag.exec(html)) {
    if (m.index > at) text(decodeEntities(html.slice(at, m.index)));
    at = tag.lastIndex;
    if (!m[2]) continue;  // A comment, doctype or processing instruction
    const name = m[2].toLowerCase(), closing = m[1] === '/';
    if (closing) { end(name); continue; }
    const attrs = attributes(m[3] ?? '');
    if (RAW.has(name) && !/\/\s*$/.test(m[3] ?? '')) {
      // Raw text up to its own end tag: a script's JSON, or the page's title.
      const close = new RegExp(`</${name}\\s*>`, 'ig'); close.lastIndex = at;
      const found = close.exec(html), body = html.slice(at, found ? found.index : html.length);
      at = tag.lastIndex = found ? close.lastIndex : html.length;
      if (name === 'script' && (attrs.type === 'application/ld+json' || attrs.id === '__NEXT_DATA__')) {
        const json = body.trim().replace(/^\/\* <!\[CDATA\[ \*\//, '').replace(/\/\* \]\]> \*\/$/, '');
        try { page.scripts.push(JSON.parse(json)); } catch { /* not readable data */ }
      } else if (name === 'title') { page.title += decodeEntities(body); text(decodeEntities(body)); }
      continue;
    }
    if (name === 'h1' || name === 'h2' || name === 'h3') { heading = ''; headingTag = name; }
    if (name === 'table') tables++;
    if (name === 'a' && attrs.href) link = { url: attrs.href, title: '', next: attrs.rel === 'next' || (attrs.class ?? '').split(/\s+/).includes('next'), table: tables > 0, media: section };
    const film = attrs['data-film-slug'] || attrs['data-item-slug'];
    if (film) page.posters.push({ url: attrs['data-item-link'] || `/film/${film.replace(/^\/+|\/+$/g, '').replace(/^film\//, '')}/`, title: attrs['data-item-name'] || attrs['data-film-name'] || '' });
    if (name === 'img' && link && attrs.alt) link.title += attrs.alt;
  }
  if (at < html.length) text(decodeEntities(html.slice(at)));
  return page;
}
