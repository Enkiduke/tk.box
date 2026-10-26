import test from 'node:test';
import assert from 'node:assert/strict';
import {collectionKey,hiddenDownloads} from '../apps/server/src/services/hidden-downloads.js';
import {hidesFromRecent} from '../packages/contracts/src/collections.js';

test('seasonal and list-kept collections hide their downloads unless set otherwise', () => {
  assert.equal(hidesFromRecent({schedule:'10/01-10/31'}),true);
  assert.equal(hidesFromRecent({source:{url:'https://example.com/list'}}),true);
  assert.equal(hidesFromRecent({source:{url:'https://example.com/list',refresh:false}}),false);
  assert.equal(hidesFromRecent({}),false);
  assert.equal(hidesFromRecent({schedule:'10/01-10/31',hide_recent:false}),false);
  assert.equal(hidesFromRecent({hide_recent:true}),true);
});

test('collection names compare as the engine compares them', () => {
  assert.equal(collectionKey('  Halloween Collection'),'halloween');
  assert.equal(collectionKey("Spooky Season: '80s!"),'spookyseason80s');
});

test('a download is hidden when any collection that asked for it hides downloads', () => {
  const definitions=[
    {name:'Halloween',library:'Movies',type:'movie',schedule:'10/01-10/31',acquire:true},
    {name:'Picks',library:'Movies',type:'movie',acquire:true},
    {name:'Top Week',library:'Movies',type:'movie',acquire:true,source:{url:'https://example.com/list'},hide_recent:false}
  ];
  const journal={version:1,movies:{
    '948':{id:1,owners:['Movies:halloween']},
    '603':{id:2,owners:['Movies:picks']},
    '27205':{id:3,owners:['Movies:picks','Movies:halloween']},
    '155':{id:4,owners:['Movies:topweek']},
    '13':{id:5,owners:['Movies:gone']},
    '680':{id:6,owners:['Films:halloween']}
  }};
  assert.deepEqual([...hiddenDownloads(journal,definitions)].sort((a,b)=>a-b),[948,27205]);
  assert.equal(hiddenDownloads(journal,null).size,0);
  assert.equal(hiddenDownloads(null,definitions).size,0);
  assert.equal(hiddenDownloads({movies:{'948':{owners:'Movies:halloween'}}},definitions).size,0);
});
