// Tells a stream that died because tk.box restarted (an update) from one whose source failed.
// The server's /health carries an id that changes on every start.
type Fetch=(url:string,init:RequestInit)=>Promise<Response>;
const pause=(ms:number)=>new Promise(r=>setTimeout(r,ms));

export class ServerWatch {
  private boot?:string;
  constructor(private fetcher:Fetch=(url,init)=>fetch(url,init)) {}
  private async read():Promise<string|undefined> {
    try {
      const r=await this.fetcher('/health',{cache:'no-store',signal:AbortSignal.timeout(5000)});
      if(!r.ok)return undefined;
      return (await r.json() as {boot?:string}).boot??'';
    } catch {return undefined;}
  }
  // Remembers the running server, so a later check can tell it was replaced.
  async remember(){const boot=await this.read();if(boot!==undefined)this.boot??=boot;}
  // Waits up to `waitMs` for the server to answer. 'restarted' when it was unreachable or answers with a new id,
  // 'same' when the same server answered all along, 'down' when it never came back, undefined when abandoned.
  async check(active:()=>boolean,{waitMs=90000,everyMs=2000}={}):Promise<'restarted'|'same'|'down'|undefined> {
    const until=Date.now()+waitMs;let unreachable=false;
    for(;;) {
      if(!active())return undefined;
      const boot=await this.read();
      if(boot!==undefined) {
        const known=this.boot;this.boot=boot;
        return unreachable||known!==undefined&&known!==boot?'restarted':'same';
      }
      unreachable=true;
      if(Date.now()>=until)return 'down';
      await pause(everyMs);
    }
  }
}
