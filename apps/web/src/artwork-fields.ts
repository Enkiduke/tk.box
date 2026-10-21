// The layout editor's settings, ported from Overlayrr's Template editor: each group's rows, their ranges and controls,
// and when a row applies (`when`). Keys are the engine's layout fields; the engine checks every value again on save.
export type V = Record<string, any>;
export type Field = { k: string; label: string; min?: number; max?: number; step?: number; int?: boolean; bool?: boolean; color?: boolean; auto?: boolean;
  choices?: [string, string][]; text?: string; fonts?: true | string; badges?: true; banners?: true; when?: (v: V) => boolean };
// [name, rows, poster only (seasons get no badges)]
export type Group = [string, Field[], boolean?];
const ALIGN: [string, string][] = [['left', 'Left'], ['center', 'Center'], ['right', 'Right']];
export const logoOn = (v: V) => v.logo_mode !== 'none', textOn = (v: V) => v.text_overlay_enabled, borderOn = (v: V) => v.border_enabled;
const logoShadowOn = (v: V) => logoOn(v) && v.uniform_logo_shadow_enabled;
const matteOn = (v: V) => v.matte_height_ratio > 0 || v.fade_height_ratio > 0;
const badgeOn = (...names: string[]) => (v: V) => names.some(n => (v.badges as string[]).includes(n));
const badgeText = badgeOn('resolution', 'edition', 'status');
const bannerOn = badgeOn('status_banner'), bannerBorderOn = (v: V) => bannerOn(v) && v.status_banner_border_width > 0;
const bannerStrokeOn = (v: V) => bannerOn(v) && v.status_banner_stroke_width > 0, bannerShadowOn = (v: V) => bannerOn(v) && v.status_banner_shadow_strength > 0;
const strokeOn = (v: V) => badgeText(v) && v.badge_stroke_width > 0, shadowOn = (v: V) => badgeText(v) && v.badge_shadow_strength > 0;
const vignetteOn = (v: V) => v.vignette_strength > 0, grainOn = (v: V) => v.grain_amount > 0;
const radialOn = (v: V) => vignetteOn(v) && v.vignette_mode === 'radial';
const textStrokeOn = (v: V) => textOn(v) && v.text_stroke_width > 0, textShadowOn = (v: V) => textOn(v) && v.text_shadow_strength > 0;
const flowOn = (v: V) => badgeText(v) && v.badge_layout === 'flow';
const badgeCorner = badgeOn('resolution', 'edition', 'status', 'codec', 'audience_score', 'streaming');
const streamingOn = badgeOn('streaming'), streamingShadowOn = (v: V) => streamingOn(v) && v.streaming_logo_shadow_enabled;
const badgeArtOn = badgeOn('edition', 'codec', 'audience_score'), badgeArtShadowOn = (v: V) => badgeArtOn(v) && v.badge_art_shadow_enabled;
export const BADGE_NAMES: [string, string][] = [['gradient_top', 'Top gradient'], ['gradient_bottom', 'Bottom gradient'], ['resolution', 'Resolution'], ['edition', 'Edition'], ['codec', 'Audio codec'], ['status', 'Show status'], ['audience_score', 'Audience score'], ['streaming', 'Streaming service logo (TV)'], ['status_banner', 'Status banner (TV)']];
export const BANNER_CATEGORIES: [string, string][] = [['new_show', 'New show'], ['new_season', 'New season soon'], ['new_season_started', 'New season started'], ['upcoming_episode', 'Upcoming episode'], ['new_episode', 'New Episode'],
  ['upcoming_finale', 'Upcoming finale'], ['season_finale', 'Season finale out'], ['final_episode', 'Final episode out'], ['returning', 'Returning'], ['ended', 'Ended'], ['canceled', 'Canceled']];
export const TPL_GROUPS: Group[] = [
  ['Image', [
    {k: 'poster_zoom', label: 'Zoom', min: 0.5, max: 2, step: 0.01},
    {k: 'poster_shift_y', label: 'Move up or down', min: -0.5, max: 0.5, step: 0.005},
    {k: 'poster_shift_x', label: 'Move left or right', min: -0.5, max: 0.5, step: 0.005},
    {k: 'matte_height_ratio', label: 'Matte height', min: 0, max: 0.5, step: 0.005},
    {k: 'fade_height_ratio', label: 'Matte fade', min: 0, max: 1, step: 0.005},
    {k: 'fade_smoothness', label: 'Fade smoothness', min: 0, max: 1, step: 0.01, when: matteOn},
    {k: 'matte_opacity', label: 'Matte opacity', min: 0, max: 1, step: 0.01, when: matteOn},
    {k: 'matte_color', label: 'Matte color', color: true, when: matteOn},
    {k: 'vignette_strength', label: 'Vignette', min: 0, max: 1, step: 0.01},
    {k: 'vignette_mode', label: 'Vignette type', choices: [['classic', 'Even dim'], ['radial', 'Radial']], when: vignetteOn},
    {k: 'vignette_color', label: 'Vignette color', color: true, when: vignetteOn},
    {k: 'vignette_size', label: 'Vignette size', min: 0.2, max: 3, step: 0.05, when: radialOn},
    {k: 'vignette_falloff', label: 'Vignette falloff', min: 0.2, max: 5, step: 0.05, when: radialOn},
    {k: 'grain_amount', label: 'Grain', min: 0, max: 0.6, step: 0.01},
    {k: 'grain_mode', label: 'Grain type', choices: [['blend', 'Blend'], ['film', 'Film']], when: grainOn},
    {k: 'grain_size', label: 'Grain size', min: 0, max: 10, step: 0.1, when: grainOn}]],
  ['Logo', [
    {k: 'logo_mode', label: 'Logo', choices: [['original', 'Show'], ['none', 'Hide']]},
    {k: 'uniform_logo_max_w', label: 'Max width', min: 1, max: 2000, int: true, when: logoOn},
    {k: 'uniform_logo_max_h', label: 'Max height', min: 1, max: 1500, int: true, when: logoOn},
    {k: 'uniform_logo_offset_x', label: 'Across', min: 0, max: 1, step: 0.005, when: logoOn},
    {k: 'uniform_logo_offset_y', label: 'Down', min: 0, max: 1, step: 0.005, when: logoOn},
    {k: 'uniform_logo_h_align', label: 'Align across', choices: ALIGN, when: logoOn},
    {k: 'uniform_logo_v_align', label: 'Align down', choices: [['top', 'Top'], ['center', 'Center'], ['bottom', 'Bottom']], when: logoOn},
    {k: 'uniform_logo_center_below', label: 'Center logos shorter than', min: 0, max: 1000, int: true, when: logoOn},
    {k: 'uniform_logo_trim', label: 'Trim logo padding', bool: true, when: logoOn},
    {k: 'uniform_logo_shadow_enabled', label: 'Logo shadow', bool: true, when: logoOn},
    {k: 'uniform_logo_shadow_color', label: 'Shadow color', color: true, when: logoShadowOn},
    {k: 'uniform_logo_shadow_opacity', label: 'Shadow opacity (%)', min: 0, max: 100, int: true, when: logoShadowOn},
    {k: 'uniform_logo_shadow_angle', label: 'Shadow angle (°)', min: -180, max: 180, int: true, when: logoShadowOn},
    {k: 'uniform_logo_shadow_distance', label: 'Shadow distance', min: 0, max: 100, int: true, when: logoShadowOn},
    {k: 'uniform_logo_shadow_size', label: 'Shadow size / blur', min: 0, max: 250, int: true, when: logoShadowOn},
    {k: 'uniform_logo_shadow_spread', label: 'Shadow spread (%)', min: 0, max: 100, int: true, when: logoShadowOn}]],
  ['Text', [
    {k: 'text_overlay_enabled', label: 'Text', bool: true},
    {k: 'custom_text', label: 'Words', text: '{title} {year} {season} {season_number}', when: textOn},
    {k: 'font_size', label: 'Size', min: 10, max: 400, int: true, when: textOn},
    {k: 'letter_spacing', label: 'Letter spacing', min: 0, max: 10, int: true, when: textOn},
    {k: 'position_y', label: 'Down', min: 0, max: 1, step: 0.005, when: textOn},
    {k: 'position_x', label: 'Across', min: 0, max: 1, step: 0.005, when: textOn},
    {k: 'text_line_spacing', label: 'Line spacing', min: 0, max: 2, step: 0.05, when: textOn},
    {k: 'text_transform', label: 'Case', choices: [['none', 'As typed'], ['uppercase', 'ABC'], ['lowercase', 'abc']], when: textOn},
    {k: 'text_color', label: 'Color', color: true, when: textOn},
    {k: 'text_stroke_width', label: 'Stroke', min: 0, max: 20, step: 0.5, when: textOn},
    {k: 'text_stroke_opacity', label: 'Stroke opacity', min: 0, max: 1, step: 0.01, when: textStrokeOn},
    {k: 'text_stroke_color', label: 'Stroke color', color: true, when: textStrokeOn},
    {k: 'text_shadow_strength', label: 'Shadow', min: 0, max: 1, step: 0.01, when: textOn},
    {k: 'text_shadow_blur', label: 'Shadow blur', min: 0, max: 60, step: 0.5, when: textShadowOn},
    {k: 'text_shadow_offset_y', label: 'Shadow offset', min: -40, max: 40, step: 0.5, when: textShadowOn},
    {k: 'text_shadow_color', label: 'Shadow color', color: true, when: textShadowOn}]],
  ['Border', [
    {k: 'border_enabled', label: 'Border', bool: true},
    {k: 'border_px', label: 'Width', min: 0, max: 120, int: true, when: borderOn},
    {k: 'border_radius', label: 'Corner radius', min: 0, max: 300, int: true, when: borderOn},
    {k: 'border_color', label: 'Color', color: true, when: borderOn}]],
  ['Badges', [
    {k: 'badges', label: 'Show', badges: true},
    {k: 'badge_layout', label: 'Layout', choices: [['kometa', 'Kometa boxes'], ['flow', 'Flow']], when: badgeText},
    {k: 'badge_margin', label: 'Margin', min: 0, max: 100, step: 1, when: badgeCorner},
    {k: 'badge_gap', label: 'Gap between badges', min: 0, max: 100, step: 1, when: flowOn},
    {k: 'badge_fit', label: 'Shrink text to fit', bool: true, when: badgeText},
    {k: 'badge_art_scale', label: 'Codec, IMAX and score size', min: 0.25, max: 3, step: 0.05, when: badgeOn('edition', 'codec', 'audience_score')}], true],
  ['Gradients', [
    {k: 'badge_gradient_top_height', label: 'Top height', min: 0.01, max: 1, step: 0.01, when: badgeOn('gradient_top')},
    {k: 'badge_gradient_top_strength', label: 'Top strength', min: 0, max: 1, step: 0.01, when: badgeOn('gradient_top')},
    {k: 'badge_gradient_bottom_height', label: 'Bottom height', min: 0.01, max: 1, step: 0.01, when: badgeOn('gradient_bottom')},
    {k: 'badge_gradient_bottom_strength', label: 'Bottom strength', min: 0, max: 1, step: 0.01, when: badgeOn('gradient_bottom')},
    {k: 'badge_gradient_color', label: 'Color', color: true, when: badgeOn('gradient_top', 'gradient_bottom')}], true],
  ['Resolution, edition and status', [
    {k: 'resolution_font_size', label: 'Resolution size', min: 10, max: 200, int: true, when: badgeOn('resolution')},
    {k: 'edition_font_size', label: 'Edition and status size', min: 10, max: 200, int: true, when: badgeOn('edition', 'status')},
    {k: 'badge_text_color', label: 'Text color', color: true, when: badgeText},
    {k: 'badge_text_transform', label: 'Text case', choices: [['uppercase', 'ABC'], ['lowercase', 'abc'], ['none', 'As written']], when: badgeText},
    {k: 'badge_stroke_width', label: 'Text stroke', min: 0, max: 10, step: 0.5, when: badgeText},
    {k: 'badge_stroke_opacity', label: 'Stroke opacity', min: 0, max: 1, step: 0.01, when: strokeOn},
    {k: 'badge_stroke_color', label: 'Stroke color', color: true, when: strokeOn},
    {k: 'badge_shadow_strength', label: 'Text shadow', min: 0, max: 1, step: 0.01, when: badgeText},
    {k: 'badge_shadow_blur', label: 'Shadow blur', min: 0, max: 30, step: 0.5, when: shadowOn},
    {k: 'badge_shadow_offset_y', label: 'Shadow offset', min: -20, max: 20, step: 0.5, when: shadowOn},
    {k: 'badge_shadow_color', label: 'Shadow color', color: true, when: shadowOn}], true],
  ['Audience score', [
    {k: 'audience_score_text_color', label: 'Text color', color: true, when: badgeOn('audience_score')},
    {k: 'audience_score_font_size', label: 'Text size', min: 10, max: 200, step: 1, when: badgeOn('audience_score')}], true],
  ['Codec, IMAX and score shadow', [
    {k: 'badge_art_shadow_enabled', label: 'Shadow', bool: true, when: badgeArtOn},
    {k: 'badge_art_shadow_color', label: 'Shadow color', color: true, when: badgeArtShadowOn},
    {k: 'badge_art_shadow_opacity', label: 'Shadow opacity (%)', min: 0, max: 100, int: true, when: badgeArtShadowOn},
    {k: 'badge_art_shadow_angle', label: 'Shadow angle (°)', min: -180, max: 180, int: true, when: badgeArtShadowOn},
    {k: 'badge_art_shadow_distance', label: 'Shadow distance', min: 0, max: 50, int: true, when: badgeArtShadowOn},
    {k: 'badge_art_shadow_size', label: 'Shadow size / blur', min: 0, max: 125, int: true, when: badgeArtShadowOn},
    {k: 'badge_art_shadow_spread', label: 'Shadow spread (%)', min: 0, max: 100, int: true, when: badgeArtShadowOn}], true],
  ['Streaming logo', [
    {k: 'streaming_logo_source', label: 'Logo from', choices: [['any', 'Network, else where it streams'], ['originals', 'Original network'], ['available', 'Where it streams now']], when: streamingOn},
    {k: 'streaming_logo_max_w', label: 'Max width', min: 10, max: 600, int: true, when: streamingOn},
    {k: 'streaming_logo_max_h', label: 'Max height', min: 10, max: 300, int: true, when: streamingOn},
    {k: 'streaming_logo_h', label: 'Side', choices: [['left', 'Left'], ['right', 'Right']], when: streamingOn},
    {k: 'streaming_logo_v', label: 'Edge', choices: [['top', 'Top'], ['bottom', 'Bottom']], when: streamingOn},
    {k: 'streaming_logo_offset_x', label: 'In from the side', min: -100, max: 500, step: 1, when: streamingOn},
    {k: 'streaming_logo_offset_y', label: 'In from the edge', min: -100, max: 500, step: 1, when: streamingOn},
    {k: 'streaming_logo_shadow_enabled', label: 'Shadow', bool: true, when: streamingOn},
    {k: 'streaming_logo_shadow_color', label: 'Shadow color', color: true, when: streamingShadowOn},
    {k: 'streaming_logo_shadow_opacity', label: 'Shadow opacity (%)', min: 0, max: 100, int: true, when: streamingShadowOn},
    {k: 'streaming_logo_shadow_angle', label: 'Shadow angle (°)', min: -180, max: 180, int: true, when: streamingShadowOn},
    {k: 'streaming_logo_shadow_distance', label: 'Shadow distance', min: 0, max: 50, int: true, when: streamingShadowOn},
    {k: 'streaming_logo_shadow_size', label: 'Shadow size / blur', min: 0, max: 125, int: true, when: streamingShadowOn},
    {k: 'streaming_logo_shadow_spread', label: 'Shadow spread (%)', min: 0, max: 100, int: true, when: streamingShadowOn}], true],
  ['Status banner', [
    {k: 'status_banners', label: 'Category', banners: true, when: bannerOn},
    {k: 'status_banner_date_format', label: 'Date format', text: 'ddd dd/mm', when: bannerOn},
    {k: 'status_banner_simplify_dates', label: 'Today, tomorrow, weekday', bool: true, when: bannerOn}], true],
  ['Status banner bar', [
    {k: 'status_banner_h_align', label: 'Side', choices: ALIGN, when: bannerOn},
    {k: 'status_banner_v_align', label: 'Edge', choices: [['top', 'Top'], ['center', 'Center'], ['bottom', 'Bottom']], when: bannerOn},
    {k: 'status_banner_offset_x', label: 'In from the side', min: -300, max: 500, step: 1, when: bannerOn},
    {k: 'status_banner_offset_y', label: 'In from the edge', min: -300, max: 700, step: 1, when: bannerOn},
    {k: 'status_banner_width', label: 'Width', min: 50, max: 1000, step: 1, when: bannerOn},
    {k: 'status_banner_height', label: 'Height', min: 10, max: 300, step: 1, when: bannerOn},
    {k: 'status_banner_radius', label: 'Corner radius', min: 0, max: 150, step: 1, when: bannerOn},
    {k: 'status_banner_backdrop_opacity', label: 'Opacity', min: 0, max: 1, step: 0.01, when: bannerOn},
    {k: 'status_banner_border_width', label: 'Border', min: 0, max: 20, step: 0.5, when: bannerOn},
    {k: 'status_banner_border_color', label: 'Border color', color: true, when: bannerBorderOn}], true],
  ['Status banner text', [
    {k: 'status_banner_font_file', label: 'Font', fonts: 'Default (Poppins Bold)', when: bannerOn},
    {k: 'status_banner_font_size', label: 'Size', min: 10, max: 200, int: true, when: bannerOn},
    {k: 'status_banner_letter_spacing', label: 'Letter spacing', min: -10, max: 40, step: 0.5, when: bannerOn},
    {k: 'status_banner_text_transform', label: 'Case', choices: [['uppercase', 'ABC'], ['lowercase', 'abc'], ['none', 'As written']], when: bannerOn},
    {k: 'status_banner_text_opacity', label: 'Opacity', min: 0, max: 1, step: 0.01, when: bannerOn},
    {k: 'status_banner_text_align', label: 'Align in the bar', choices: ALIGN, when: bannerOn},
    {k: 'status_banner_padding', label: 'Padding at the ends', min: 0, max: 200, step: 1, when: bannerOn},
    {k: 'status_banner_text_offset_x', label: 'Nudge across', min: -100, max: 100, step: 1, when: bannerOn},
    {k: 'status_banner_text_offset_y', label: 'Nudge down', min: -100, max: 100, step: 1, when: bannerOn},
    {k: 'status_banner_stroke_width', label: 'Stroke', min: 0, max: 10, step: 0.5, when: bannerOn},
    {k: 'status_banner_stroke_opacity', label: 'Stroke opacity', min: 0, max: 1, step: 0.01, when: bannerStrokeOn},
    {k: 'status_banner_stroke_color', label: 'Stroke color', color: true, when: bannerStrokeOn},
    {k: 'status_banner_shadow_strength', label: 'Shadow', min: 0, max: 1, step: 0.01, when: bannerOn},
    {k: 'status_banner_shadow_blur', label: 'Shadow blur', min: 0, max: 30, step: 0.5, when: bannerShadowOn},
    {k: 'status_banner_shadow_offset_y', label: 'Shadow offset', min: -20, max: 20, step: 0.5, when: bannerShadowOn},
    {k: 'status_banner_shadow_color', label: 'Shadow color', color: true, when: bannerShadowOn}], true]];  // Seasons get no badges
// The Episode card mode's rows: sizes are pixels on a 3200px-wide card, and the page's 'none' gradient is the config's null.
const gradientOn = (v: V) => v.card_gradient !== 'none', titleAuto = (v: V) => v.title_color === 'auto', cardShadowOn = (v: V) => v.shadow_strength > 0;
const cardLogoShadowOn = (v: V) => logoOn(v) && v.card_logo_shadow_enabled, cardStrokeOn = (v: V) => v.stroke_opacity > 0;
export const CARD_GROUPS: Group[] = [
  ['Image', [
    {k: 'card_gradient', label: 'Gradient', choices: [['radial', 'Radial'], ['none', 'None']]},
    {k: 'gradient_center_x', label: 'Clear center across', min: 0, max: 1, step: 0.005, when: gradientOn},
    {k: 'gradient_center_y', label: 'Clear center down', min: 0, max: 1, step: 0.005, when: gradientOn},
    {k: 'gradient_radius_x', label: 'Fade width', min: 0.05, max: 2, step: 0.005, when: gradientOn},
    {k: 'gradient_radius_y', label: 'Fade height', min: 0.05, max: 2, step: 0.005, when: gradientOn},
    {k: 'gradient_softness', label: 'Softness', min: 0.5, max: 20, step: 0.1, when: gradientOn},
    {k: 'gradient_strength', label: 'Strength', min: 0, max: 1, step: 0.01, when: gradientOn},
    {k: 'gradient_corner_strength', label: 'Corner darkening', min: 0, max: 1, step: 0.01, when: gradientOn}]],
  ['Logo', [
    {k: 'logo_mode', label: 'Logo', choices: [['original', 'Show'], ['none', 'Hide']]},
    {k: 'uniform_logo_max_w', label: 'Max width', min: 1, max: 3200, int: true, when: logoOn},
    {k: 'uniform_logo_max_h', label: 'Max height', min: 1, max: 1800, int: true, when: logoOn},
    {k: 'card_logo_offset_x', label: 'Across (0 = left margin, 1 = right)', min: 0, max: 1, step: 0.005, when: logoOn},
    {k: 'card_logo_offset_y', label: 'Down (0 = top margin, 1 = bottom)', min: 0, max: 1, step: 0.005, when: logoOn},
    {k: 'card_logo_h_align', label: 'Align across', choices: ALIGN, when: logoOn},
    {k: 'card_logo_v_align', label: 'Align down', choices: [['top', 'Top'], ['center', 'Center'], ['bottom', 'Bottom']], when: logoOn},
    {k: 'card_logo_trim', label: 'Trim logo padding', bool: true, when: logoOn},
    {k: 'card_logo_shadow_enabled', label: 'Logo shadow', bool: true, when: logoOn},
    {k: 'card_logo_shadow_color', label: 'Shadow color', color: true, when: cardLogoShadowOn},
    {k: 'card_logo_shadow_opacity', label: 'Shadow opacity (%)', min: 0, max: 100, int: true, when: cardLogoShadowOn},
    {k: 'card_logo_shadow_angle', label: 'Shadow angle (°)', min: -180, max: 180, int: true, when: cardLogoShadowOn},
    {k: 'card_logo_shadow_distance', label: 'Shadow distance', min: 0, max: 150, int: true, when: cardLogoShadowOn},
    {k: 'card_logo_shadow_size', label: 'Shadow size / blur', min: 0, max: 250, int: true, when: cardLogoShadowOn},
    {k: 'card_logo_shadow_spread', label: 'Shadow spread (%)', min: 0, max: 100, int: true, when: cardLogoShadowOn}]],
  ['Title', [
    {k: 'title_font_file', label: 'Font', fonts: true},
    {k: 'title_font_size', label: 'Size', min: 10, max: 400, int: true},
    {k: 'title_color', label: 'Color', color: true, auto: true},
    {k: 'title_min_brightness', label: 'Darkest logo color', min: 0, max: 255, int: true, when: titleAuto},
    {k: 'text_transform', label: 'Case (title and numbers)', choices: [['none', 'As written'], ['uppercase', 'ABC'], ['lowercase', 'abc']]},
    {k: 'title_max_line_width', label: 'Characters per line', min: 1, max: 100, int: true},
    {k: 'title_max_lines', label: 'Most lines', min: 1, max: 10, int: true},
    {k: 'title_letter_spacing', label: 'Letter spacing', min: -20, max: 40, step: 0.25},
    {k: 'title_line_spacing', label: 'Line spacing (less is tighter)', min: -100, max: 100, step: 1},
    {k: 'title_x', label: 'Left edge', min: 0, max: 1600, step: 1},
    {k: 'title_bottom', label: 'Height above the bottom', min: 0, max: 900, step: 1}]],
  ['Season and episode', [
    {k: 'season_font_file', label: 'Season font', fonts: true},
    {k: 'episode_font_file', label: 'Episode font', fonts: true},
    {k: 'season_text', label: 'Season text', text: 'SEASON {season_number}'},
    {k: 'episode_text', label: 'Episode text', text: 'EPISODE {episode_number}'},
    {k: 'index_font_size', label: 'Size', min: 10, max: 300, int: true},
    {k: 'index_color', label: 'Color', color: true},
    {k: 'index_letter_spacing', label: 'Letter spacing', min: -20, max: 40, step: 0.25},
    {k: 'index_gap', label: 'Space between season and episode', min: 0, max: 300, step: 1},
    {k: 'index_x', label: 'Left edge', min: 0, max: 1600, step: 1},
    {k: 'index_bottom', label: 'Height above the bottom', min: 0, max: 900, step: 1}]],
  ['Outline and shadow', [
    {k: 'stroke_opacity', label: 'Outline opacity', min: 0, max: 1, step: 0.01},
    {k: 'title_stroke_width', label: 'Title outline', min: 0, max: 30, step: 0.5},
    {k: 'title_stroke_color', label: 'Title outline color', color: true, auto: true, when: cardStrokeOn},
    {k: 'index_stroke_width', label: 'Season and episode outline', min: 0, max: 30, step: 0.5},
    {k: 'index_stroke_color', label: 'Season and episode outline color', color: true, when: cardStrokeOn},
    {k: 'shadow_strength', label: 'Shadow', min: 0, max: 1, step: 0.01},
    {k: 'shadow_color', label: 'Shadow color', color: true, when: cardShadowOn},
    {k: 'shadow_blur', label: 'Shadow blur', min: 0, max: 100, step: 0.5, when: cardShadowOn},
    {k: 'shadow_offset_y', label: 'Shadow offset', min: -100, max: 100, step: 0.5, when: cardShadowOn}]]];
