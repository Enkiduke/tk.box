import {requireThat} from '../errors.js';
// Preserve elementary payloads/PTS/PCR. Only transport continuity counters change.
// HLS discontinuity tags still identify program timestamp/codec boundaries.
export class TsContinuity {
  private counters=new Map<number,number>();
  rewrite(input:Buffer){
    requireThat(input.length>0&&input.length%188===0,'INVALID_MPEG_TS','Expected complete 188-byte transport packets.');
    const output=Buffer.from(input);
    for(let offset=0;offset<output.length;offset+=188){
      requireThat(output[offset]===0x47,'INVALID_MPEG_TS','Invalid transport sync byte.');
      requireThat((output[offset+1]!&0x80)===0,'INVALID_MPEG_TS','Transport error indicator is set.');
      const header=output[offset+3]!;
      requireThat((header&0xc0)===0&&(header&0x30)!==0,'UNSUPPORTED_MPEG_TS','Scrambled or invalid transport packet.');
    }
    for(let offset=0;offset<output.length;offset+=188){
      const header=output[offset+3]!,pid=((output[offset+1]!&0x1f)<<8)|output[offset+2]!;
      if(pid===0x1fff)continue;
      const previous=this.counters.get(pid),payload=(header&0x10)!==0;
      const counter=previous===undefined?header&0xf:payload?(previous+1)%16:previous;
      output[offset+3]=(header&0xf0)|counter;this.counters.set(pid,counter);
    }
    return output;
  }
}
