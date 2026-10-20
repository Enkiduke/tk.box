import test from 'node:test';
import assert from 'node:assert/strict';
import {seasonList,seasonsFor} from '../apps/web/src/request-seasons.js';

const seasons=[
  {number:1,name:'Season 1',airDate:'2019-01-01',status:'available' as const},
  {number:2,name:'Season 2',airDate:'2020-01-01'},
  {number:3,name:'Season 3',airDate:'2021-01-01',status:'requested' as const},
  {number:4,name:'Season 4',airDate:'2026-09-01'},
  {number:5,name:'Season 5'}];

test('Season modes leave out what is on the server or requested',()=>{
  assert.deepEqual(seasonsFor('all',seasons),[2,4,5]);
  // Season 1 is already available, so First Season has nothing to ask for.
  assert.deepEqual(seasonsFor('first',seasons),[]);
  assert.deepEqual(seasonsFor('last',seasons),[5]);
  assert.deepEqual(seasonsFor('manual',seasons,{picked:[1,2,4]}),[2,4]);
});
test('Season lists read as a range when they run on',()=>{
  assert.equal(seasonList([]),'No seasons');
  assert.equal(seasonList([3]),'Season 3');
  assert.equal(seasonList([1,2,3,4]),'Seasons 1–4');
  assert.equal(seasonList([1,3,5]),'Seasons 1, 3 and 5');
});
