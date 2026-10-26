import test from 'node:test';
import assert from 'node:assert/strict';
import {defaultSubtitleStyle,effect,effectKinds,effectShadows,effects,hasLook,parseCustomPresets,parseSubtitleStyle,rgba,textShadow,withLook} from '../apps/web/src/subtitle-style.js';

const shown = (style: ReturnType<typeof parseSubtitleStyle>) => effectKinds.filter(([k]) => style.effects[k].on).map(([k]) => k);

test('missing or broken saved styles fall back to the default', () => {
  assert.deepEqual(parseSubtitleStyle(null), defaultSubtitleStyle);
  assert.deepEqual(parseSubtitleStyle('not json'), defaultSubtitleStyle);
  assert.deepEqual(parseSubtitleStyle('[1,2]'), defaultSubtitleStyle);
});

test('each field is validated on its own', () => {
  const style = parseSubtitleStyle(JSON.stringify({font: 'serif', color: '#FFE14D', edge: 'sparkles', textOpacity: 5, backgroundOpacity: 140, position: 12.3, bold: 'yes', backgroundShape: 'block', customFont: 'Inter"; color:red', letterSpacing: 2.26}));
  assert.equal(style.font, 'serif');
  assert.equal(style.color, '#ffe14d');
  assert.deepEqual(style.effects, defaultSubtitleStyle.effects);
  assert.equal(style.textOpacity, 10);
  assert.equal(style.backgroundOn, true);
  assert.equal(style.backgroundOpacity, 100);
  assert.equal(style.position, 12.5);
  assert.equal(style.letterSpacing, 2.5);
  assert.equal(style.weight, 500);
  assert.equal(style.backgroundShape, 'block');
  assert.equal(style.customFont, 'Inter color:red');
});

test('the older size-only preference carries over until a style is saved', () => {
  assert.equal(parseSubtitleStyle(null, 'l').size, 'l');
  assert.equal(parseSubtitleStyle(JSON.stringify({size: 'xl'}), 'l').size, 'xl');
  assert.equal(parseSubtitleStyle(null, 'huge').size, 'm');
});

test('older styles carry over: bold, one edge style, frosted, padding, uppercase and no background', () => {
  const old = parseSubtitleStyle(JSON.stringify({bold: true, edge: 'outline', edgeColor: '#FF0000', edgeWidth: 200, frosted: true, backgroundShape: 'block', backgroundPadding: 200, backgroundRadius: 50, uppercase: true, backgroundOpacity: 0}));
  assert.equal(old.weight, 700);
  assert.deepEqual(shown(old), ['outline']);
  assert.deepEqual([old.effects.outline.color, old.effects.outline.size], ['#ff0000', 11]);
  assert.deepEqual([old.frostedOn, old.backgroundBlur], [true, 10]);
  assert.deepEqual([old.backgroundOn, old.backgroundOpacity], [false, 60]);
  assert.deepEqual([old.paddingX, old.paddingY, old.cornerRadius], [100, 30, 30]);
  assert.equal(old.textCase, 'upper');
  assert.deepEqual(shown(parseSubtitleStyle(JSON.stringify({edge: 'none'}))), []);
  const border = parseSubtitleStyle(JSON.stringify({borderWidth: 3, backgroundBlur: 0}));
  assert.deepEqual([border.borderOn, border.borderWidth, border.frostedOn, border.backgroundBlur], [true, 3, false, 10]);
  // A list of effects, as briefly saved, keeps the first of each kind, turned on.
  const listed = parseSubtitleStyle(JSON.stringify({effects: [{kind: 'glow', size: 30}, {kind: 'glow', size: 10}, {kind: 'sparkles'}]}));
  assert.deepEqual(shown(listed), ['glow']);
  assert.equal(listed.effects.glow.size, 30);
});

test('every effect is always there, on or off, and draws in a fixed order', () => {
  const style = parseSubtitleStyle(JSON.stringify({effects: {glow: {on: true, size: 999, strength: 2}, shadow: {on: true, distance: 10, angle: 0, blur: 0, size: 0}, outline: {on: false}, bogus: {on: true}}}));
  assert.deepEqual(Object.keys(style.effects), effectKinds.map(([k]) => k));
  assert.equal(style.effects.glow.size, 60);
  assert.equal(textShadow(style.effects), '0.1em 0em 0em rgba(0,0,0,1),0em 0em 0.3em rgba(0,0,0,1),0em 0em 0.6em rgba(0,0,0,1)');
  assert.deepEqual(shown(parseSubtitleStyle(JSON.stringify({effects: {}}))), ['shadow']);
  assert.equal(effectShadows(effect('outline')).length, 16);
  assert.equal(effectShadows(effect('extrude', {size: 12})).length, 12);
  assert.equal(effectShadows(effect('shadow')).length, 2);
  assert.deepEqual(effectShadows(effect('stroke')), []);
  assert.equal(textShadow(effects()), undefined);
  assert.equal(rgba('#ff8000', 60), 'rgba(255,128,0,0.6)');
});

test('presets change the look and keep where subtitles sit', () => {
  const mine = {...defaultSubtitleStyle, size: 'xl' as const, position: 12, anchor: 'top' as const, color: '#ff6b6b', weight: 800};
  const look = {effects: effects({outline: {}}), backgroundOn: false};
  const applied = withLook(mine, look);
  assert.deepEqual([applied.size, applied.position, applied.anchor, applied.color, applied.weight, applied.effects.outline.on, applied.effects.shadow.on], ['xl', 12, 'top', '#ffffff', 500, true, false]);
  assert.ok(hasLook(applied, look));
  assert.ok(!hasLook({...applied, letterSpacing: 4}, look));
  assert.ok(!hasLook({...applied, effects: {...applied.effects, outline: {...applied.effects.outline, size: 9}}}, look));
});

test('saved presets drop broken entries, duplicate names and layout fields', () => {
  const presets = parseCustomPresets(JSON.stringify([{name: ' Mine ', look: {color: '#FFE14D', position: 20}}, {name: 'Mine', look: {}}, {name: '', look: {}}, {name: 'No look'}, 'junk']));
  assert.equal(presets.length, 1);
  assert.equal(presets[0]!.name, 'Mine');
  assert.equal(presets[0]!.look.color, '#ffe14d');
  assert.ok(!('position' in presets[0]!.look));
  assert.deepEqual(parseCustomPresets('{"not":"a list"}'), []);
});
