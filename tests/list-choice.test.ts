import assert from 'node:assert/strict';
import {test} from 'node:test';
import {chooseTitles,isoWeek,weekHash,type Candidate} from '../apps/web/src/list-choice.js';

// The same cases as the engine's test_a_list_is_filtered_and_sorted_before_the_collection_size_cuts_it, which must agree.
const today=new Date(2026,9,25);
const row=(tmdb_id:number,year:number,rating=7,genres=['Drama'],certification:string|null='R',language='en'):Candidate=>
  ({title:`Movie ${tmdb_id}`,year:String(year),member:{tmdb_id},details:{year,rating,genres,certification,language}});
const rows=[row(1,2024),row(2,1984,8.1),row(3,2006,5),row(4,1976,7,['Horror']),row(5,1996,7,['Drama'],null)];

test('filters go first and say why each title is left out', () => {
  const {kept,left}=chooseTitles([...rows,{title:'Unknown',year:'',member:{imdb_id:'tt1'},details:null},row(6,1990,7,['Drama'],'R','fr'),row(7,1999,9.5)],
    {filter:{year_to:2021,min_rating:6,max_rating:9,languages:['en'],exclude_genres:['horror'],exclude_certifications:['NR']},sort:'anniversary'},1,[],today);
  assert.deepEqual(kept.map(r=>r.member),[{tmdb_id:2}]);
  assert.deepEqual(Object.fromEntries(left.map(l=>[l.title,l.why])),{'Movie 1':'released after 2021','Movie 3':'rated below 6 on TMDb',
    'Movie 4':'in a genre left out','Movie 5':'rated NR','Unknown':'no TMDb details','Movie 6':'in a language left out','Movie 7':'rated above 9 on TMDb'});
});

test('the sort runs before the collection size, and removed titles take no place', () => {
  const {kept,left}=chooseTitles(rows,{sort:'anniversary'},2,[],today);
  assert.deepEqual(kept.map(r=>r.member.tmdb_id),[3,4]);
  assert.deepEqual(left.map(l=>l.why),Array(3).fill('beyond the collection size'));
  assert.deepEqual(chooseTitles(rows,{sort:'anniversary'},2,[{tmdb_id:3}],today).kept.map(r=>r.member.tmdb_id),[4,5]);
  assert.deepEqual(chooseTitles(rows,{sort:'rating'},5,[],today).kept.map(r=>r.member.tmdb_id),[2,1,4,5,3]);
});

test('random keeps one order all week, by the engine’s hash', () => {
  assert.equal(isoWeek(today),'2026-43');
  assert.equal(isoWeek(new Date(2027,0,1)),'2026-53');
  assert.equal(weekHash('2026-43',{tmdb_id:218}),2508485222);
  assert.equal(weekHash('2026-43',{title:'Amélie',year:2001}),773514683);
  assert.deepEqual(chooseTitles(rows,{sort:'random'},5,[],today).kept,chooseTitles(rows,{sort:'random'},5,[],new Date(2026,9,21)).kept);
});
