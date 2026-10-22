import type { Sport } from '../services/sports-match.js';

// Fallback channel icons for event channels with no logo of their own: original line glyphs drawn for tk.box,
// in the interface accent so they sit with station logos in the guide's dark tiles. Static markup, no scripts.
const ACCENT = '#f5b82e';
const GLYPHS: Record<Sport, string> = {
  soccer: '<circle cx="24" cy="24" r="17"/><path d="M24 15l7 5-2.7 8.2h-8.6L17 20z"/><path d="M24 15V7M31 20l7.5-3M28.3 28.2l4.8 6.6M19.7 28.2l-4.8 6.6M17 20l-7.5-3"/>',
  football: '<path d="M8 40C6 26 14 10 40 8c2 14-6 30-32 32z"/><path d="M16 32l16-16M21 23l4 4M24.5 19.5l4 4M17.5 26.5l4 4"/>',
  basketball: '<circle cx="24" cy="24" r="17"/><path d="M7 24h34M24 7v34"/><path d="M12 12c5 4 7 8 7 12s-2 8-7 12M36 12c-5 4-7 8-7 12s2 8 7 12"/>',
  baseball: '<circle cx="24" cy="24" r="17"/><path d="M14 11c4 4 5 9 5 13s-1 9-5 13M34 11c-4 4-5 9-5 13s1 9 5 13"/><path d="M15 16l3-1M16 21h3M16 27h3M15 32l3 1M33 16l-3-1M32 21h-3M32 27h-3M33 32l-3 1"/>',
  hockey: '<path d="M30 6L18 34c-1 2-2 3-4 3H8v4h9c3 0 5-1 6-4l11-29z"/><ellipse cx="35" cy="38" rx="6" ry="2.5"/>',
  mma: '<path d="M17 6h14l10 10v16L31 42H17L7 32V16z"/><path d="M14 18h20M14 30h20M18 10v28M30 10v28"/>',
  boxing: '<path d="M14 30V17c0-6 4-10 11-10s11 4 11 11v8c0 3-2 5-5 5H14z"/><path d="M14 22h-2c-3 0-5 2-5 5s2 4 5 4h2"/><path d="M15 31v8h18v-8M15 35h18"/>',
  wrestling: '<rect x="5" y="16" width="38" height="16" rx="4"/><circle cx="24" cy="24" r="8"/><path d="M24 19l1.6 3.2 3.4.5-2.5 2.4.6 3.4-3.1-1.6-3.1 1.6.6-3.4-2.5-2.4 3.4-.5z"/>',
  golf: '<path d="M20 40V6l16 6-16 6"/><ellipse cx="22" cy="40" rx="12" ry="3"/><circle cx="31" cy="35" r="2"/>',
  racing: '<path d="M10 42V6"/><path d="M10 7h28v20H10"/><path d="M10 7h7v5h-7zM24 7h7v5h-7zM17 12h7v5h-7zM31 12h7v5h-7zM10 17h7v5h-7zM24 17h7v5h-7zM17 22h7v5h-7zM31 22h7v5h-7z" fill="currentColor" stroke="none"/>',
  tennis: '<circle cx="24" cy="24" r="17"/><path d="M11 13c6 5 6 17 0 22M37 13c-6 5-6 17 0 22"/>',
  cycling: '<circle cx="12" cy="32" r="8"/><circle cx="36" cy="32" r="8"/><path d="M12 32l8-14h12l4 14M20 18l6 14h-14M30 12h5l-3 6M18 14h5"/>',
  rugby: '<ellipse cx="24" cy="24" rx="19" ry="11" transform="rotate(-35 24 24)"/><path d="M15 33c4-2 14-12 18-18M20 21l4 4M24 18l4 4M17 25l4 4"/>',
  cricket: '<path d="M32 6l6 6-18 18-6-6z"/><path d="M14 24l-7 7 4 4 7-7"/><circle cx="35" cy="35" r="5"/>',
  darts: '<circle cx="22" cy="26" r="16"/><circle cx="22" cy="26" r="9"/><circle cx="22" cy="26" r="2.5"/><path d="M22 26L40 8M35 8h5v5"/>',
  curling: '<path d="M10 30c0-6 6-10 14-10s14 4 14 10v3c0 3-3 5-6 5H16c-3 0-6-2-6-5z"/><path d="M10 31h28M18 20v-6c0-3 2-5 5-5h9"/>',
  sports: '<path d="M15 8h18v9c0 6-4 10-9 10s-9-4-9-10z"/><path d="M15 11H8c0 6 3 9 7 9M33 11h7c0 6-3 9-7 9M24 27v7M16 41h16l-2-7H18z"/>',
};
export function sportIcon(sport: Sport) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-8 -8 64 64" width="96" height="96" color="${ACCENT}" fill="none" stroke="${ACCENT}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">${GLYPHS[sport] ?? GLYPHS.sports}</svg>`;
}

// An event channel's matchup: both teams' downloaded logos either side of "vs". Only raster images the logo
// fetcher accepted are embedded, so the markup stays script-free.
export function matchupLogo(left: { type: string; bytes: Buffer }, right: { type: string; bytes: Buffer }) {
  const team = (x: number, i: { type: string; bytes: Buffer }) => `<image x="${x}" y="4" width="72" height="72" preserveAspectRatio="xMidYMid meet" href="data:${i.type};base64,${i.bytes.toString('base64')}"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 176 80" width="176" height="80">${team(0, left)}<text x="88" y="46" text-anchor="middle" font-family="system-ui,sans-serif" font-size="17" font-weight="700" fill="${ACCENT}">vs</text>${team(104, right)}</svg>`;
}
