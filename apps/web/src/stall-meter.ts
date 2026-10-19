// Counts mid-playback stalls (not the first load or a seek) to tell when a viewer
// is buffering often enough that a lighter quality would help.
export class StallMeter {
  private stalls:{start:number;end?:number}[]=[];
  constructor(private windowMs=120000,private maxStalls=3,private maxStalledMs=10000) {}
  start(now:number) {const last=this.stalls.at(-1);if(!last||last.end!==undefined)this.stalls.push({start:now});}
  end(now:number) {const last=this.stalls.at(-1);if(last&&last.end===undefined)last.end=now;}
  reset() {this.stalls=[];}
  // Heavy: several stalls, or a long total time stalled (an ongoing stall counts so far), within the window.
  heavy(now:number) {
    const from=now-this.windowMs;this.stalls=this.stalls.filter(s=>(s.end??now)>=from);
    const stalled=this.stalls.reduce((total,s)=>total+(s.end??now)-Math.max(s.start,from),0);
    return this.stalls.filter(s=>s.start>=from).length>=this.maxStalls||stalled>=this.maxStalledMs;
  }
}
