import {readFile,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {requireThat} from '../errors.js';
import type {Segment} from './buffer.js';
export async function readGeneratedHls(dir:string,slot:{start:number;programId:string;revision:number;sequence:number;discontinuitySequence:number}){
  const text=await readFile(join(dir,'index.m3u8'),'utf8');requireThat(text.includes('#EXT-X-ENDLIST'),'INCOMPLETE_HLS','Generated program is not complete.');
  const result:{segment:Segment;mediaPath:string;initPath?:string}[]=[];
  let duration=0,cursor=slot.start,initName:string|undefined;
  for(const line of text.split(/\r?\n/)){
    if(line.startsWith('#EXT-X-MAP:')){const match=/^#EXT-X-MAP:URI="(init\.mp4)"$/.exec(line);requireThat(match,'INVALID_HLS','Unexpected initialization reference.');initName=match[1];}
    else if(line.startsWith('#EXTINF:')){duration=Number(line.slice(8).split(',')[0])*1000;requireThat(Number.isFinite(duration)&&duration>0&&duration<=10000,'INVALID_HLS','Invalid generated segment duration.');}
    else if(line&&!line.startsWith('#')){
      requireThat(/^segment-\d+\.(ts|m4s)$/.test(line)&&duration>0,'INVALID_HLS','Invalid generated media reference.');
      const mediaPath=join(dir,line),bytes=(await stat(mediaPath)).size,sequence=slot.sequence+result.length;
      result.push({segment:{id:`s-${sequence}`,start:cursor,end:cursor+duration,bytes,programId:slot.programId,revision:slot.revision,sequence,
        uri:`s-${sequence}.${initName?'m4s':'ts'}`,discontinuity:result.length===0&&slot.discontinuitySequence>0,
        discontinuitySequence:slot.discontinuitySequence-(result.length===0&&slot.discontinuitySequence>0?1:0),
        ...(initName?{initUri:`init-${slot.start}.mp4`}:{})},mediaPath,...(initName?{initPath:join(dir,initName)}:{})});
      cursor+=duration;duration=0;
    }
  }
  requireThat(result.length>0,'EMPTY_HLS','No completed media segments.');return result;
}
