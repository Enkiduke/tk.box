import test from 'node:test';
import assert from 'node:assert/strict';
import {activeCaptions,captionLine,parseVtt,timelineShift} from '../apps/web/src/captions.js';

const vtt='WEBVTT\n\n00:32.580 --> 00:33.514\nAlright, who else?\n\nNOTE skipped\n\n2\n01:00:00.000 --> 01:00:02.000 line:90%\n<i>We were</i> &amp; <b>expecting</b>\n<v Ben>our <c.x>first.</c>\n\n01:00:01.000 --> 01:00:03.000\nOverlap\n';

test('WebVTT cues parse with timing, line breaks and safe inline styles',()=>{
  const cues=parseVtt(vtt);
  assert.deepEqual(cues.map(c=>[c.start,c.end]),[[32.58,33.514],[3600,3602],[3601,3603]]);
  assert.deepEqual(cues[1]!.lines,[[{text:'We were',i:true},{text:' & '},{text:'expecting',b:true}],[{text:'our '},{text:'first.'}]]);
  assert.deepEqual(captionLine('<script>x</script><u>y'),[{text:'x'},{text:'y',u:true}]);
});

test('active captions follow the media time, including overlapping cues',()=>{
  const cues=parseVtt(vtt);
  assert.deepEqual(activeCaptions(cues,10),[]);
  assert.deepEqual(activeCaptions(cues,33),[0]);
  assert.deepEqual(activeCaptions(cues,3601.5),[1,2]);
  assert.deepEqual(activeCaptions(cues,3602.5),[2]);
});

test('Plex HLS timeline shift maps the player clock to source time',()=>{
  // Measured on a real title: resuming at the 2740 s playlist slot, whose segment really starts at source keyframe 2736.901 s (+10 s in PTS).
  const shift=timelineShift((2746.901-2740)*90000,90000);
  assert.ok(Math.abs(2740+shift-2736.901)<1e-6);
  assert.ok(Math.abs(timelineShift(10.083*90000,90000)-.083)<1e-6);
});
