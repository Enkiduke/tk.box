import assert from 'node:assert/strict';
import {test} from 'node:test';
import {exportCollection,plexOnly,readCollections,type Definition} from '../apps/web/src/collection-files.js';

const halloween:Definition={name:'Halloween',library:'Movies',type:'movie',enabled:true,schedule:'10/01-10/31',
  members:[{tmdb_id:948},{rating_key:'123'}],visibility:{home:true,shared:true,recommended:true},acquire:true,cleanup:'remove-delete',
  source:{url:'https://mdblist.com/lists/x/halloween',limit:100,refresh:true,sort:'anniversary',filter:{year_from:1970,min_rating:6.5,languages:['en'],exclude_certifications:['NC-17']}},exclude:[{tmdb_id:10},{title:'Hocus Pocus',year:1993}]};
const picks:Definition={name:'Picks',library:'TV',type:'tv',members:[]};

test('an export is the collection itself, and reads back with every setting and title', () => {
  assert.deepEqual(JSON.parse(exportCollection(halloween)),halloween);
  assert.deepEqual(readCollections(exportCollection(halloween)),[halloween]);
});

test('a list, a {collections} wrapper and a ```json fence read too', () => {
  assert.deepEqual(readCollections(JSON.stringify([halloween,picks])),[halloween,picks]);
  assert.deepEqual(readCollections(JSON.stringify({collections:[picks]})),[picks]);
  assert.deepEqual(readCollections('```json\n'+exportCollection(picks)+'```\n'),[picks]);
});

test('unknown or wrong fields are left out', () => {
  assert.deepEqual(readCollections(JSON.stringify([{name:' Picks ',library:'Movies',type:'movie',poster:'x.jpg',sync:'mirror',enabled:'yes',
    members:[{tmdb_id:1,extra:true},{},'tmdb:2',{tmdb_id:1.5,title:'Alien'}],rules:{},exclude:[]}])),
    [{name:'Picks',library:'Movies',type:'movie',members:[{tmdb_id:1},{title:'Alien'}]}]);
});

test('text that isn’t a collection is refused with a reason', () => {
  assert.throws(()=>readCollections('not json'),/isn’t valid JSON/);
  assert.throws(()=>readCollections('"Halloween"'),/Paste one collection/);
  assert.throws(()=>readCollections('[]'),/no collections in this/);
  assert.throws(()=>readCollections('[{"name":"A","library":"Movies","type":"music"}]'),/A isn’t movies or TV/);
  assert.throws(()=>readCollections('{"library":"Movies","type":"movie"}'),/Collection 1 has no name/);
});

test('titles known only by Plex ID are counted', () => {
  assert.equal(plexOnly(halloween),1);
});
