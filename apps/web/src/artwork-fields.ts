// The layout editor's settings as the layers of a poster or card: each layer's switch (`show`), its sections and rows, their
// ranges and controls, and when a row applies (`when`). Keys are the engine's layout fields; the engine checks every value again on save.
export type V = Record<string, any>;
// `badge` is a switch for one name in the `badges` list, `flip` a switch between two values ([on, off]), and `anchor` a grid
// that sets `k` (across) and `anchor.v` (down) together.
export type Field = { k: string; label: string; min?: number; max?: number; step?: number; int?: boolean; bool?: boolean; color?: boolean; auto?: boolean;
  choices?: [string, string][]; text?: string; fonts?: true | string; banners?: true; glows?: true; badge?: string; flip?: [string, string];
  anchor?: { v: string; across: string[]; down: string[] }; when?: (v: V) => boolean };
// `folded` sections start closed; `note` says which other layers share them.
export type Section = { name: string; fields: Field[]; folded?: true; note?: string; posterOnly?: true };
// `parent` nests a layer under another in the list; `posterOnly` layers aren't drawn on season posters (they get no badges).
export type Layer = { id: string; label: string; icon: string; show?: Field; sections: Section[]; parent?: string; posterOnly?: true; tv?: true;
  shared?: { note: string; to: string } };

export const isOn = (f: Field, value: unknown) => f.badge ? Array.isArray(value) && value.includes(f.badge) : f.flip ? value === f.flip[0] : !!value;
// The value of `f.k` with the switch turned on or off; a badge keeps its place in the engine's order.
export const turned = (f: Field, value: unknown, on: boolean): unknown => {
  if (f.flip) return f.flip[on ? 0 : 1];
  if (!f.badge) return on;
  const list = Array.isArray(value) ? value as string[] : [], known = BADGE_NAMES.map(b => b[0]);
  return [...known.filter(b => b === f.badge ? on : list.includes(b)), ...list.filter(b => !known.includes(b))];
};
export const layerFields = (l: Layer) => [...(l.show ? [l.show] : []), ...l.sections.flatMap(s => s.fields)];

const ALIGN: [string, string][] = [['left', 'Left'], ['center', 'Center'], ['right', 'Right']];
const CASE: [string, string][] = [['uppercase', 'ABC'], ['lowercase', 'abc'], ['none', 'As written']];
const always = () => true;
export const logoOn = (v: V) => v.logo_mode !== 'none', textOn = (v: V) => v.text_overlay_enabled, borderOn = (v: V) => v.border_enabled;
const matteOn = (v: V) => v.matte_height_ratio > 0 || v.fade_height_ratio > 0;
const badgeOn = (...names: string[]) => (v: V) => names.some(n => (v.badges as string[]).includes(n));
const badgeText = badgeOn('resolution', 'edition', 'status');
const bannerOn = badgeOn('status_banner'), bannerBorderOn = (v: V) => bannerOn(v) && v.status_banner_border_width > 0;
const vignetteOn = (v: V) => v.vignette_strength > 0, grainOn = (v: V) => v.grain_amount > 0;
const radialOn = (v: V) => vignetteOn(v) && v.vignette_mode === 'radial';
const flowOn = (v: V) => badgeText(v) && v.badge_layout === 'flow';
const badgeCorner = badgeOn('resolution', 'edition', 'status', 'codec', 'audience_score', 'streaming');
const streamingOn = badgeOn('streaming'), badgeArtOn = badgeOn('edition', 'codec', 'audience_score');

// The same shadow and stroke rows wherever they appear. A drop shadow (logos, badge art) is switched on and placed by angle and
// distance; a soft shadow (text) is on when its strength is above 0. Keys share a prefix: `uniform_logo_shadow_enabled`, `text_shadow_blur`.
const dropShadow = (p: string, max: { distance: number; size: number }, when: (v: V) => boolean, note?: string): Section => {
  const on = (v: V) => when(v) && v[`${p}_enabled`];
  return { name: 'Shadow', folded: true, note, fields: [
    { k: `${p}_enabled`, label: 'Shadow', bool: true, when },
    { k: `${p}_color`, label: 'Color', color: true, when: on },
    { k: `${p}_opacity`, label: 'Opacity (%)', min: 0, max: 100, int: true, when: on },
    { k: `${p}_angle`, label: 'Angle (°)', min: -180, max: 180, int: true, when: on },
    { k: `${p}_distance`, label: 'Distance', min: 0, max: max.distance, int: true, when: on },
    { k: `${p}_size`, label: 'Blur', min: 0, max: max.size, int: true, when: on },
    { k: `${p}_spread`, label: 'Spread (%)', min: 0, max: 100, int: true, when: on }] };
};
const softShadow = (p: string, max: { blur: number; offset: number }, when: (v: V) => boolean, note?: string): Section => {
  const on = (v: V) => when(v) && v[`${p}strength`] > 0;
  return { name: 'Shadow', folded: true, note, fields: [
    { k: `${p}strength`, label: 'Strength', min: 0, max: 1, step: 0.01, when },
    { k: `${p}color`, label: 'Color', color: true, when: on },
    { k: `${p}blur`, label: 'Blur', min: 0, max: max.blur, step: 0.5, when: on },
    { k: `${p}offset_y`, label: 'Offset down', min: -max.offset, max: max.offset, step: 0.5, when: on }] };
};
const stroke = (p: string, max: number, when: (v: V) => boolean, note?: string): Section => {
  const on = (v: V) => when(v) && v[`${p}width`] > 0;
  return { name: 'Stroke', folded: true, note, fields: [
    { k: `${p}width`, label: 'Width', min: 0, max, step: 0.5, when },
    { k: `${p}opacity`, label: 'Opacity', min: 0, max: 1, step: 0.01, when: on },
    { k: `${p}color`, label: 'Color', color: true, when: on }] };
};

export const BADGE_NAMES: [string, string][] = [['gradient_top', 'Top gradient'], ['gradient_bottom', 'Bottom gradient'], ['resolution', 'Resolution'], ['edition', 'Edition'], ['codec', 'Audio codec'], ['status', 'Show status'], ['audience_score', 'Audience score'], ['streaming', 'Streaming service logo (TV)'], ['status_banner', 'Status banner (TV)']];
export const BANNER_CATEGORIES: [string, string][] = [['new_show', 'New show'], ['new_season', 'New season soon'], ['new_season_started', 'New season started'], ['upcoming_episode', 'Upcoming episode'], ['new_episode', 'New Episode'],
  ['upcoming_finale', 'Upcoming finale'], ['season_finale', 'Season finale out'], ['final_episode', 'Final episode out'], ['returning', 'Returning'], ['ended', 'Ended'], ['canceled', 'Canceled']];
const badge = (name: string, label: string): Field => ({ k: 'badges', label, badge: name });
const TEXT_STYLE = 'Text color, case, stroke and shadow are set in Badges, shared by Resolution, Edition and Show status.';
const ART_STYLE = 'Size and shadow are set in Badges, shared by Edition, Audio codec and Audience score.';

// A poster's layers, top of the list first. Season posters use the same ones without the badges.
export const POSTER_LAYERS: Layer[] = [
  { id: 'artwork', label: 'Artwork', icon: 'image', sections: [
    { name: 'Framing', fields: [
      { k: 'poster_zoom', label: 'Zoom', min: 0.5, max: 2, step: 0.01 },
      { k: 'poster_shift_x', label: 'Move left or right', min: -0.5, max: 0.5, step: 0.005 },
      { k: 'poster_shift_y', label: 'Move up or down', min: -0.5, max: 0.5, step: 0.005 }] }] },
  { id: 'matte', label: 'Matte', icon: 'matte', sections: [
    { name: 'Matte', fields: [
      { k: 'matte_height_ratio', label: 'Height', min: 0, max: 0.5, step: 0.005 },
      { k: 'fade_height_ratio', label: 'Fade', min: 0, max: 1, step: 0.005 },
      { k: 'fade_smoothness', label: 'Fade smoothness', min: 0, max: 1, step: 0.01, when: matteOn },
      { k: 'matte_opacity', label: 'Opacity', min: 0, max: 1, step: 0.01, when: matteOn },
      { k: 'matte_color', label: 'Color', color: true, when: matteOn }] }] },
  { id: 'effects', label: 'Effects', icon: 'sparkle', sections: [
    { name: 'Gradients', posterOnly: true, fields: [
      badge('gradient_top', 'Top gradient'),
      { k: 'badge_gradient_top_height', label: 'Top height', min: 0.01, max: 1, step: 0.01, when: badgeOn('gradient_top') },
      { k: 'badge_gradient_top_strength', label: 'Top strength', min: 0, max: 1, step: 0.01, when: badgeOn('gradient_top') },
      badge('gradient_bottom', 'Bottom gradient'),
      { k: 'badge_gradient_bottom_height', label: 'Bottom height', min: 0.01, max: 1, step: 0.01, when: badgeOn('gradient_bottom') },
      { k: 'badge_gradient_bottom_strength', label: 'Bottom strength', min: 0, max: 1, step: 0.01, when: badgeOn('gradient_bottom') },
      { k: 'badge_gradient_color', label: 'Color', color: true, when: badgeOn('gradient_top', 'gradient_bottom') }] },
    { name: 'Vignette', fields: [
      { k: 'vignette_strength', label: 'Strength', min: 0, max: 1, step: 0.01 },
      { k: 'vignette_mode', label: 'Type', choices: [['classic', 'Even dim'], ['radial', 'Radial']], when: vignetteOn },
      { k: 'vignette_color', label: 'Color', color: true, when: vignetteOn },
      { k: 'vignette_size', label: 'Size', min: 0.2, max: 3, step: 0.05, when: radialOn },
      { k: 'vignette_falloff', label: 'Falloff', min: 0.2, max: 5, step: 0.05, when: radialOn }] },
    { name: 'Grain', fields: [
      { k: 'grain_amount', label: 'Amount', min: 0, max: 0.6, step: 0.01 },
      { k: 'grain_mode', label: 'Type', choices: [['blend', 'Blend'], ['film', 'Film']], when: grainOn },
      { k: 'grain_size', label: 'Size', min: 0, max: 10, step: 0.1, when: grainOn }] }] },
  { id: 'logo', label: 'Logo', icon: 'logo', show: { k: 'logo_mode', label: 'Logo', flip: ['original', 'none'] }, sections: [
    { name: 'Size', fields: [
      { k: 'uniform_logo_max_w', label: 'Max width', min: 1, max: 2000, int: true, when: logoOn },
      { k: 'uniform_logo_max_h', label: 'Max height', min: 1, max: 1500, int: true, when: logoOn },
      { k: 'uniform_logo_center_below', label: 'Center logos shorter than', min: 0, max: 1000, int: true, when: logoOn },
      { k: 'uniform_logo_trim', label: 'Trim logo padding', bool: true, when: logoOn }] },
    { name: 'Position', fields: [
      { k: 'uniform_logo_offset_x', label: 'Across', min: 0, max: 1, step: 0.005, when: logoOn },
      { k: 'uniform_logo_offset_y', label: 'Down', min: 0, max: 1, step: 0.005, when: logoOn },
      { k: 'uniform_logo_h_align', label: 'Align in its box', anchor: { v: 'uniform_logo_v_align', across: ['left', 'center', 'right'], down: ['top', 'center', 'bottom'] }, when: logoOn }] },
    dropShadow('uniform_logo_shadow', { distance: 100, size: 250 }, logoOn)] },
  { id: 'text', label: 'Text', icon: 'text', show: { k: 'text_overlay_enabled', label: 'Text', bool: true }, sections: [
    { name: 'Words', fields: [
      { k: 'custom_text', label: 'Words', text: '{title} {year} {season} {season_number}', when: textOn },
      { k: 'font_size', label: 'Size', min: 10, max: 400, int: true, when: textOn },
      { k: 'text_color', label: 'Color', color: true, when: textOn },
      { k: 'text_transform', label: 'Case', choices: [['none', 'As typed'], ['uppercase', 'ABC'], ['lowercase', 'abc']], when: textOn },
      { k: 'letter_spacing', label: 'Letter spacing', min: 0, max: 10, int: true, when: textOn },
      { k: 'text_line_spacing', label: 'Line spacing', min: 0, max: 2, step: 0.05, when: textOn }] },
    { name: 'Position', fields: [
      { k: 'position_x', label: 'Across', min: 0, max: 1, step: 0.005, when: textOn },
      { k: 'position_y', label: 'Down', min: 0, max: 1, step: 0.005, when: textOn }] },
    stroke('text_stroke_', 20, textOn),
    softShadow('text_shadow_', { blur: 60, offset: 40 }, textOn)] },
  { id: 'border', label: 'Border', icon: 'frame', show: { k: 'border_enabled', label: 'Border', bool: true }, sections: [
    { name: 'Border', fields: [
      { k: 'border_px', label: 'Width', min: 0, max: 120, int: true, when: borderOn },
      { k: 'border_radius', label: 'Corner radius', min: 0, max: 300, int: true, when: borderOn },
      { k: 'border_color', label: 'Color', color: true, when: borderOn }] }] },
  { id: 'badges', label: 'Badges', icon: 'tag', posterOnly: true, sections: [
    { name: 'Arrangement', fields: [
      { k: 'badge_layout', label: 'Layout', choices: [['kometa', 'Kometa boxes'], ['flow', 'Flow']], when: badgeText },
      { k: 'badge_margin', label: 'Margin', min: 0, max: 100, step: 1, when: badgeCorner },
      { k: 'badge_gap', label: 'Gap between badges', min: 0, max: 100, step: 1, when: flowOn },
      { k: 'badge_fit', label: 'Shrink text to fit', bool: true, when: badgeText }] },
    { name: 'Text style', note: 'Shared by Resolution, Edition and Show status.', fields: [
      { k: 'badge_text_color', label: 'Color', color: true, when: badgeText },
      { k: 'badge_text_transform', label: 'Case', choices: CASE, when: badgeText }] },
    stroke('badge_stroke_', 10, badgeText, 'Text stroke, shared by Resolution, Edition and Show status.'),
    softShadow('badge_shadow_', { blur: 30, offset: 20 }, badgeText, 'Text shadow, shared by Resolution, Edition and Show status.'),
    { name: 'Picture badges', note: 'Shared by Edition, Audio codec and Audience score.', fields: [
      { k: 'badge_art_scale', label: 'Size', min: 0.25, max: 3, step: 0.05, when: badgeArtOn }] },
    dropShadow('badge_art_shadow', { distance: 50, size: 125 }, badgeArtOn, 'Picture badge shadow, shared by Edition, Audio codec and Audience score.')] },
  { id: 'resolution', label: 'Resolution', icon: 'hd', parent: 'badges', posterOnly: true, show: badge('resolution', 'Resolution'), shared: { note: TEXT_STYLE, to: 'badges' }, sections: [
    { name: 'Size', fields: [{ k: 'resolution_font_size', label: 'Text size', min: 10, max: 200, int: true, when: badgeOn('resolution') }] }] },
  { id: 'edition', label: 'Edition', icon: 'collection', parent: 'badges', posterOnly: true, show: badge('edition', 'Edition'), shared: { note: `${TEXT_STYLE} ${ART_STYLE}`, to: 'badges' }, sections: [
    { name: 'Size', note: 'Shared with Show status.', fields: [{ k: 'edition_font_size', label: 'Text size', min: 10, max: 200, int: true, when: badgeOn('edition', 'status') }] }] },
  { id: 'status', label: 'Show status', icon: 'info', parent: 'badges', posterOnly: true, show: badge('status', 'Show status'), shared: { note: TEXT_STYLE, to: 'badges' }, sections: [
    { name: 'Size', note: 'Shared with Edition.', fields: [{ k: 'edition_font_size', label: 'Text size', min: 10, max: 200, int: true, when: badgeOn('edition', 'status') }] }] },
  { id: 'codec', label: 'Audio codec', icon: 'volume', parent: 'badges', posterOnly: true, show: badge('codec', 'Audio codec'), shared: { note: ART_STYLE, to: 'badges' }, sections: [] },
  { id: 'audience_score', label: 'Audience score', icon: 'star', parent: 'badges', posterOnly: true, show: badge('audience_score', 'Audience score'), shared: { note: ART_STYLE, to: 'badges' }, sections: [
    { name: 'Score', fields: [
      { k: 'audience_score_font_size', label: 'Text size', min: 10, max: 200, step: 1, when: badgeOn('audience_score') },
      { k: 'audience_score_text_color', label: 'Text color', color: true, when: badgeOn('audience_score') }] }] },
  { id: 'streaming', label: 'Streaming logo', icon: 'live', parent: 'badges', posterOnly: true, tv: true, show: badge('streaming', 'Streaming logo'), shared: { note: 'Margin is set in Badges.', to: 'badges' }, sections: [
    { name: 'Logo', fields: [
      { k: 'streaming_logo_source', label: 'Logo from', choices: [['any', 'Network, else where it streams'], ['originals', 'Original network'], ['available', 'Where it streams now']], when: streamingOn },
      { k: 'streaming_logo_max_w', label: 'Max width', min: 10, max: 600, int: true, when: streamingOn },
      { k: 'streaming_logo_max_h', label: 'Max height', min: 10, max: 300, int: true, when: streamingOn }] },
    { name: 'Position', fields: [
      { k: 'streaming_logo_h', label: 'Corner', anchor: { v: 'streaming_logo_v', across: ['left', 'right'], down: ['top', 'bottom'] }, when: streamingOn },
      { k: 'streaming_logo_offset_x', label: 'In from the side', min: -100, max: 500, step: 1, when: streamingOn },
      { k: 'streaming_logo_offset_y', label: 'In from the edge', min: -100, max: 500, step: 1, when: streamingOn }] },
    dropShadow('streaming_logo_shadow', { distance: 50, size: 125 }, streamingOn)] },
  { id: 'banner', label: 'Status banner', icon: 'flag', posterOnly: true, tv: true, show: badge('status_banner', 'Status banner'), sections: [
    { name: 'Categories', fields: [
      { k: 'status_banners', label: 'Category', banners: true, when: bannerOn },
      { k: 'status_banner_date_format', label: 'Date format', text: 'ddd dd/mm', when: bannerOn },
      { k: 'status_banner_simplify_dates', label: 'Today, tomorrow, weekday', bool: true, when: bannerOn }] },
    { name: 'Bar', fields: [
      { k: 'status_banner_h_align', label: 'Position', anchor: { v: 'status_banner_v_align', across: ['left', 'center', 'right'], down: ['top', 'center', 'bottom'] }, when: bannerOn },
      { k: 'status_banner_offset_x', label: 'In from the side', min: -300, max: 500, step: 1, when: bannerOn },
      { k: 'status_banner_offset_y', label: 'In from the edge', min: -300, max: 700, step: 1, when: bannerOn },
      { k: 'status_banner_width', label: 'Width', min: 50, max: 1000, step: 1, when: bannerOn },
      { k: 'status_banner_height', label: 'Height', min: 10, max: 300, step: 1, when: bannerOn },
      { k: 'status_banner_radius', label: 'Corner radius', min: 0, max: 150, step: 1, when: bannerOn },
      { k: 'status_banner_backdrop_opacity', label: 'Opacity', min: 0, max: 1, step: 0.01, when: bannerOn },
      { k: 'status_banner_border_width', label: 'Border', min: 0, max: 20, step: 0.5, when: bannerOn },
      { k: 'status_banner_border_color', label: 'Border color', color: true, when: bannerBorderOn }] },
    { name: 'Text', fields: [
      { k: 'status_banner_font_file', label: 'Font', fonts: 'Default (Poppins Bold)', when: bannerOn },
      { k: 'status_banner_font_size', label: 'Size', min: 10, max: 200, int: true, when: bannerOn },
      { k: 'status_banner_letter_spacing', label: 'Letter spacing', min: -10, max: 40, step: 0.5, when: bannerOn },
      { k: 'status_banner_text_transform', label: 'Case', choices: CASE, when: bannerOn },
      { k: 'status_banner_text_opacity', label: 'Opacity', min: 0, max: 1, step: 0.01, when: bannerOn },
      { k: 'status_banner_text_align', label: 'Align in the bar', choices: ALIGN, when: bannerOn },
      { k: 'status_banner_padding', label: 'Padding at the ends', min: 0, max: 200, step: 1, when: bannerOn },
      { k: 'status_banner_text_offset_x', label: 'Nudge across', min: -100, max: 100, step: 1, when: bannerOn },
      { k: 'status_banner_text_offset_y', label: 'Nudge down', min: -100, max: 100, step: 1, when: bannerOn }] },
    stroke('status_banner_stroke_', 10, bannerOn),
    softShadow('status_banner_shadow_', { blur: 30, offset: 20 }, bannerOn)] }];

// Collection layouts get this layer after Artwork: the glow the engine draws behind streaming, chart, custom and curated
// collections (TMDb franchises have real posters). A collection's own color, chosen on its Generated background tile, wins.
export const BACKGROUND_LAYER: Layer = { id: 'background', label: 'Background', icon: 'collection', sections: [
  { name: 'Glow', note: 'Drawn behind streaming, chart, custom and curated collections. Franchise collections use their TMDb poster.', fields: [
    { k: 'collection_gradient_radius', label: 'Reach', min: 0.2, max: 5, step: 0.05 },
    { k: 'collection_gradient_strength', label: 'Edge darkening', min: 0, max: 1, step: 0.01 },
    { k: 'collection_gradient_corner', label: 'Corner darkening', min: 0, max: 1, step: 0.01 }] },
  { name: 'Colors', note: 'Custom and curated collections named for a holiday glow in its color. A color picked on a collection’s Generated background tile wins.', fields: [
    { k: 'chart_color', label: 'Charts and custom', color: true }] },
  { name: 'Streaming services', folded: true, fields: [{ k: 'streaming_colors', label: 'Service colors', glows: true }] }] };

// An episode card's layers: sizes are pixels on a 3200px-wide card, and the page's 'none' gradient is the config's null.
const titleAuto = (v: V) => v.title_color === 'auto', cardStrokeOn = (v: V) => v.stroke_opacity > 0;
const CARD_SHADOW = 'Shared by the title and the season and episode numbers.';
export const CARD_LAYERS: Layer[] = [
  { id: 'gradient', label: 'Gradient', icon: 'sparkle', show: { k: 'card_gradient', label: 'Gradient', flip: ['radial', 'none'] }, sections: [
    { name: 'Clear center', fields: [
      { k: 'gradient_center_x', label: 'Across', min: 0, max: 1, step: 0.005 },
      { k: 'gradient_center_y', label: 'Down', min: 0, max: 1, step: 0.005 }] },
    { name: 'Fade', fields: [
      { k: 'gradient_radius_x', label: 'Width', min: 0.05, max: 2, step: 0.005 },
      { k: 'gradient_radius_y', label: 'Height', min: 0.05, max: 2, step: 0.005 },
      { k: 'gradient_softness', label: 'Softness', min: 0.5, max: 20, step: 0.1 },
      { k: 'gradient_strength', label: 'Strength', min: 0, max: 1, step: 0.01 },
      { k: 'gradient_corner_strength', label: 'Corner darkening', min: 0, max: 1, step: 0.01 }] }] },
  { id: 'logo', label: 'Logo', icon: 'logo', show: { k: 'logo_mode', label: 'Logo', flip: ['original', 'none'] }, sections: [
    { name: 'Size', fields: [
      { k: 'uniform_logo_max_w', label: 'Max width', min: 1, max: 3200, int: true, when: logoOn },
      { k: 'uniform_logo_max_h', label: 'Max height', min: 1, max: 1800, int: true, when: logoOn },
      { k: 'card_logo_trim', label: 'Trim logo padding', bool: true, when: logoOn }] },
    { name: 'Position', fields: [
      { k: 'card_logo_offset_x', label: 'Across (0 = left margin, 1 = right)', min: 0, max: 1, step: 0.005, when: logoOn },
      { k: 'card_logo_offset_y', label: 'Down (0 = top margin, 1 = bottom)', min: 0, max: 1, step: 0.005, when: logoOn },
      { k: 'card_logo_h_align', label: 'Align in its box', anchor: { v: 'card_logo_v_align', across: ['left', 'center', 'right'], down: ['top', 'center', 'bottom'] }, when: logoOn }] },
    dropShadow('card_logo_shadow', { distance: 150, size: 250 }, logoOn)] },
  { id: 'title', label: 'Title', icon: 'text', sections: [
    { name: 'Words', fields: [
      { k: 'title_font_file', label: 'Font', fonts: true },
      { k: 'title_font_size', label: 'Size', min: 10, max: 400, int: true },
      { k: 'title_color', label: 'Color', color: true, auto: true },
      { k: 'title_min_brightness', label: 'Darkest logo color', min: 0, max: 255, int: true, when: titleAuto },
      { k: 'text_transform', label: 'Case (title and numbers)', choices: [['none', 'As written'], ['uppercase', 'ABC'], ['lowercase', 'abc']] },
      { k: 'title_max_line_width', label: 'Characters per line', min: 1, max: 100, int: true },
      { k: 'title_max_lines', label: 'Most lines', min: 1, max: 10, int: true },
      { k: 'title_letter_spacing', label: 'Letter spacing', min: -20, max: 40, step: 0.25 },
      { k: 'title_line_spacing', label: 'Line spacing (less is tighter)', min: -100, max: 100, step: 1 }] },
    { name: 'Position', fields: [
      { k: 'title_x', label: 'Left edge', min: 0, max: 1600, step: 1 },
      { k: 'title_bottom', label: 'Height above the bottom', min: 0, max: 900, step: 1 }] },
    { name: 'Outline', folded: true, note: 'Opacity is shared with the season and episode numbers.', fields: [
      { k: 'title_stroke_width', label: 'Width', min: 0, max: 30, step: 0.5 },
      { k: 'stroke_opacity', label: 'Opacity', min: 0, max: 1, step: 0.01 },
      { k: 'title_stroke_color', label: 'Color', color: true, auto: true, when: cardStrokeOn }] },
    softShadow('shadow_', { blur: 100, offset: 100 }, always, CARD_SHADOW)] },
  { id: 'numbers', label: 'Season and episode', icon: 'list', sections: [
    { name: 'Words', fields: [
      { k: 'season_text', label: 'Season text', text: 'SEASON {season_number}' },
      { k: 'episode_text', label: 'Episode text', text: 'EPISODE {episode_number}' },
      { k: 'season_font_file', label: 'Season font', fonts: true },
      { k: 'episode_font_file', label: 'Episode font', fonts: true },
      { k: 'index_font_size', label: 'Size', min: 10, max: 300, int: true },
      { k: 'index_color', label: 'Color', color: true },
      { k: 'index_letter_spacing', label: 'Letter spacing', min: -20, max: 40, step: 0.25 },
      { k: 'index_gap', label: 'Space between season and episode', min: 0, max: 300, step: 1 }] },
    { name: 'Position', fields: [
      { k: 'index_x', label: 'Left edge', min: 0, max: 1600, step: 1 },
      { k: 'index_bottom', label: 'Height above the bottom', min: 0, max: 900, step: 1 }] },
    { name: 'Outline', folded: true, note: 'Opacity is shared with the title.', fields: [
      { k: 'index_stroke_width', label: 'Width', min: 0, max: 30, step: 0.5 },
      { k: 'stroke_opacity', label: 'Opacity', min: 0, max: 1, step: 0.01 },
      { k: 'index_stroke_color', label: 'Color', color: true, when: cardStrokeOn }] },
    softShadow('shadow_', { blur: 100, offset: 100 }, always, CARD_SHADOW)] }];
