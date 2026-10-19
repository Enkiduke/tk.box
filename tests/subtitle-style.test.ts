import test from 'node:test';
import assert from 'node:assert/strict';
import {defaultSubtitleStyle,edgeShadow,parseSubtitleStyle,rgba} from '../apps/web/src/subtitle-style.js';

test('missing or broken saved styles fall back to the default', () => {
  assert.deepEqual(parseSubtitleStyle(null), defaultSubtitleStyle);
  assert.deepEqual(parseSubtitleStyle('not json'), defaultSubtitleStyle);
  assert.deepEqual(parseSubtitleStyle('[1,2]'), defaultSubtitleStyle);
});

test('each field is validated on its own', () => {
  const style = parseSubtitleStyle(JSON.stringify({font: 'serif', color: '#FFE14D', edge: 'sparkles', textOpacity: 5, backgroundOpacity: 140, position: 12.4, bold: 'yes', backgroundShape: 'block'}));
  assert.equal(style.font, 'serif');
  assert.equal(style.color, '#ffe14d');
  assert.equal(style.edge, defaultSubtitleStyle.edge);
  assert.equal(style.textOpacity, 20);
  assert.equal(style.backgroundOpacity, 100);
  assert.equal(style.position, 12);
  assert.equal(style.bold, false);
  assert.equal(style.backgroundShape, 'block');
});

test('the older size-only preference carries over until a style is saved', () => {
  assert.equal(parseSubtitleStyle(null, 'l').size, 'l');
  assert.equal(parseSubtitleStyle(JSON.stringify({size: 'xl'}), 'l').size, 'xl');
  assert.equal(parseSubtitleStyle(null, 'huge').size, 'm');
});

test('colors and edges render as CSS', () => {
  assert.equal(rgba('#ff8000', 60), 'rgba(255,128,0,0.6)');
  assert.equal(edgeShadow('none', '#000000'), undefined);
  assert.equal(edgeShadow('outline', '#000000')!.split(',').length, 16);
});
