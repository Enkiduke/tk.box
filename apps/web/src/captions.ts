// WebVTT cues rendered by the player itself rather than the browser's <track> renderer, so the
// size setting always applies (Chrome lets OS caption preferences override ::cue styles) and the
// cue clock can follow the media timeline instead of the HLS playlist's (see PLEX_HLS_TS_OFFSET).
export type CaptionSpan={text:string;i?:boolean;b?:boolean;u?:boolean};
export type Caption={start:number;end:number;lines:CaptionSpan[][]};

// Plex's HLS segments keep the source timestamps plus 10 s. hls.js anchors its clock to the first
// segment it loads at that segment's playlist position, but Plex cuts segments at keyframes, so a
// session that starts mid-title runs a few seconds off the source. Media time = currentTime + shift.
export const PLEX_HLS_TS_OFFSET=10;
export const timelineShift=(initPTS:number,timescale:number)=>initPTS/timescale-PLEX_HLS_TS_OFFSET;

const timing=/^((?:\d+:)?\d{1,2}:\d{2}[.,]\d{3})\s+-->\s+((?:\d+:)?\d{1,2}:\d{2}[.,]\d{3})/;
const seconds=(value:string)=>value.replace(',','.').split(':').reduce((total,part)=>total*60+Number(part),0);
const entities:Record<string,string>={amp:'&',lt:'<',gt:'>',nbsp:' ',lrm:'‎',rlm:'‏',quot:'"',apos:"'"};
const decode=(text:string)=>text.replace(/&(amp|lt|gt|nbsp|lrm|rlm|quot|apos);/g,(_,name:string)=>entities[name]!);

// Italic, bold and underline are kept; voice, class, ruby and karaoke timestamp tags are dropped.
export function captionLine(line:string):CaptionSpan[] {
  const spans:CaptionSpan[]=[],style={i:0,b:0,u:0};
  for(const part of line.split(/(<[^>]*>)/)) {
    const tag=part.match(/^<(\/?)([a-z]+)/i);
    if(tag){const name=tag[2]!.toLowerCase() as 'i'|'b'|'u';if(name in style)style[name]=Math.max(0,style[name]+(tag[1]?-1:1));continue;}
    if(part.startsWith('<')||!part)continue;
    spans.push({text:decode(part),...(style.i?{i:true}:{}),...(style.b?{b:true}:{}),...(style.u?{u:true}:{})});
  }
  return spans;
}
export function parseVtt(text:string):Caption[] {
  const cues:Caption[]=[];
  for(const block of text.replace(/^﻿/,'').replace(/\r\n?/g,'\n').split(/\n{2,}/)) {
    const lines=block.split('\n'),at=lines.findIndex(l=>timing.test(l));if(at<0||at>1)continue;
    const [,from,to]=lines[at]!.match(timing)!,start=seconds(from!),end=seconds(to!);
    const body=lines.slice(at+1).map(captionLine).filter(l=>l.some(s=>s.text.trim()));
    if(end>start&&body.length)cues.push({start,end,lines:body});
  }
  return cues.sort((a,b)=>a.start-b.start);
}
// Cues are sorted by start; overlapping cues are all shown, earliest first.
export function activeCaptions(cues:Caption[],time:number) {
  let low=0,high=cues.length;
  while(low<high){const mid=(low+high)>>1;if(cues[mid]!.start<=time)low=mid+1;else high=mid;}
  const active:number[]=[];
  for(let i=low-1;i>=0&&i>=low-50;i--)if(cues[i]!.end>time)active.unshift(i);
  return active;
}
