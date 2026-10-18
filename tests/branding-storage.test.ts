import test from 'node:test';
import assert from 'node:assert/strict';
import {readPreference} from '../apps/web/src/storage.js';

function storage(entries: [string, string][]) {
  const values = new Map(entries);
  return {getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => {values.set(key, value);}, removeItem: (key: string) => {values.delete(key);}};
}

test('rebranding preserves player, account browse and guide preferences', () => {
  for (const suffix of ['.player.subtitles', ':browse:1:movie', ':guide:1']) {
    const saved = storage([[`enki${suffix}`, 'saved-choice']]);
    assert.equal(readPreference(saved, `tk.box${suffix}`), 'saved-choice');
    assert.equal(saved.getItem(`tk.box${suffix}`), 'saved-choice');
    assert.equal(saved.getItem(`enki${suffix}`), null);
    assert.equal(readPreference(saved, `tk.box${suffix}`), 'saved-choice');
  }
});

test('current viewer choices take precedence and storage write failures retain old choices', () => {
  const saved = storage([['enki.player.subtitles', 'old-choice'], ['tk.box.player.subtitles', '']]);
  assert.equal(readPreference(saved, 'tk.box.player.subtitles'), '');
  const readonly = storage([['enki.player.subtitles', 'old-choice']]);
  readonly.setItem = () => {throw new Error('Storage unavailable');};
  assert.equal(readPreference(readonly, 'tk.box.player.subtitles'), 'old-choice');
  assert.equal(readonly.getItem('enki.player.subtitles'), 'old-choice');
  assert.equal(readPreference(storage([]), 'tk.box.player.subtitles'), null);
});
