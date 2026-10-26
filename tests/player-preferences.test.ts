import test from 'node:test';
import assert from 'node:assert/strict';
import {defaultPlayerPreferences,parsePlayerPreferences,pickSubtitle,subtitleChoice} from '../apps/web/src/player-preferences.js';

test('missing or broken saved preferences fall back to the default, field by field', () => {
  assert.deepEqual(parsePlayerPreferences(null), defaultPlayerPreferences);
  assert.deepEqual(parsePlayerPreferences('not json'), defaultPlayerPreferences);
  const prefs = parsePlayerPreferences(JSON.stringify({autoplay: false, countdownSeconds: 12, quality: '720p-3', subtitleMode: 'sometimes', subtitleLanguage: 'English', audioLanguage: 'FRE', startFrom: 'beginning'}));
  assert.equal(prefs.autoplay, false);
  assert.equal(prefs.countdownSeconds, 10);
  assert.equal(prefs.quality, '720p-3');
  assert.equal(prefs.subtitleMode, 'plex');
  assert.equal(prefs.subtitleLanguage, null);
  assert.equal(prefs.audioLanguage, 'fra');
  assert.equal(prefs.startFrom, 'beginning');
});

test('the player’s older separate preferences carry over until the first save', () => {
  assert.deepEqual(parsePlayerPreferences(null, {autoplay: 'off', autoskip: 'on', subtitles: 'eng'}), {...defaultPlayerPreferences, autoplay: false, skipIntros: true, skipCredits: true, subtitleMode: 'always', subtitleLanguage: 'eng'});
  assert.equal(parsePlayerPreferences(null, {subtitles: 'off'}).subtitleMode, 'off');
  assert.equal(parsePlayerPreferences(null, {subtitles: ''}).subtitleMode, 'plex');
  assert.equal(parsePlayerPreferences('{}', {autoplay: 'off'}).autoplay, true);
});

const track = (id: string, language: string | undefined, extra: {forced?: boolean; selected?: boolean; supported?: boolean} = {}) => ({id, ...(language ? {language} : {}), forced: false, selected: false, supported: true, ...extra});
const tracks = [track('1', 'fra', {selected: true}), track('2', 'eng'), track('3', 'eng', {forced: true}), track('4', 'spa', {supported: false}), track('5', undefined, {forced: true})];

test('subtitle mode and language choose the starting track', () => {
  assert.equal(pickSubtitle(tracks, {subtitleMode: 'plex', subtitleLanguage: 'eng'}), '1');
  assert.equal(pickSubtitle(tracks, {subtitleMode: 'off', subtitleLanguage: 'eng'}), null);
  assert.equal(pickSubtitle(tracks, {subtitleMode: 'always', subtitleLanguage: 'eng'}), '2');
  assert.equal(pickSubtitle(tracks, {subtitleMode: 'always', subtitleLanguage: null}), '1');
  // An unsupported track never starts, and a language with no track starts with none.
  assert.equal(pickSubtitle(tracks, {subtitleMode: 'always', subtitleLanguage: 'spa'}), null);
  assert.equal(pickSubtitle(tracks, {subtitleMode: 'forced', subtitleLanguage: 'eng'}), '3');
  assert.equal(pickSubtitle(tracks, {subtitleMode: 'forced', subtitleLanguage: 'deu'}), '5');
  assert.equal(pickSubtitle(tracks.slice(0, 2), {subtitleMode: 'forced', subtitleLanguage: 'eng'}), null);
});

test('picking a subtitle in the player becomes the preference', () => {
  assert.deepEqual(subtitleChoice({language: 'en', forced: false}), {subtitleMode: 'always', subtitleLanguage: 'eng'});
  assert.deepEqual(subtitleChoice({language: 'eng', forced: true}), {subtitleMode: 'forced', subtitleLanguage: 'eng'});
  assert.deepEqual(subtitleChoice(undefined), {subtitleMode: 'off'});
});
