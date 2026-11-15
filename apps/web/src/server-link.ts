import {toast} from './toasts.js';

// The page's own connection to tk.box, said in toasts (docs/NOTIFICATIONS.md): "Reconnecting…" once the events
// stream has been down for DOWN_MS (until it is back, then "Reconnected"), and "tk.box was updated" with Reload when
// the server that answers after a drop is a new start (`/health`'s boot id changed).
export const DOWN_MS=10000;
type Toasts=Pick<typeof toast,'warning'|'success'|'info'|'dismissKey'>;
type Timers={set:(run:()=>void,ms:number)=>unknown;clear:(handle:unknown)=>void};
type Boot=()=>Promise<string|undefined>;

const readBoot:Boot=async()=>{
  try {
    const r=await fetch('/health',{cache:'no-store',signal:AbortSignal.timeout(5000)});
    return r.ok?(await r.json() as {boot?:string}).boot:undefined;
  } catch {return undefined;}
};

export class ServerLink {
  private boot?:string;
  private timer:unknown;
  private down=false;
  private shown=false;
  private updated=false;
  private stopped=false;
  constructor(private toasts:Toasts=toast,private bootOf:Boot=readBoot,
    private timers:Timers={set:(run,ms)=>window.setTimeout(run,ms),clear:handle=>window.clearTimeout(handle as number)},private reload=()=>window.location.reload()) {}

  // The page signed in and opened its stream: remember which server start it is talking to.
  async start() {this.stopped=false;this.boot??=await this.bootOf();}
  lost() {
    if(this.down||this.stopped)return;
    this.down=true;
    this.timer=this.timers.set(()=>{this.timer=undefined;this.shown=true;
      this.toasts.warning('Reconnecting…',{key:'server-link',sticky:true,detail:'tk.box isn’t answering. This page catches up when it’s back.'});},DOWN_MS);
  }
  async back() {
    if(!this.down)return;
    this.down=false;
    if(this.timer!==undefined){this.timers.clear(this.timer);this.timer=undefined;}
    if(this.shown){this.shown=false;this.toasts.dismissKey('server-link');this.toasts.success('Reconnected',{key:'server-link'});}
    const boot=await this.bootOf();
    if(boot&&this.boot&&boot!==this.boot&&!this.updated) {
      this.updated=true;
      this.toasts.info('tk.box was updated',{key:'server-updated',sticky:true,detail:'Reload to get the new version.',action:{label:'Reload',run:this.reload}});
    }
    this.boot??=boot;
  }
  // Signed out or the page is going away: nothing more to say until the next start.
  stop() {this.stopped=true;if(this.timer!==undefined)this.timers.clear(this.timer);this.timer=undefined;this.down=false;if(this.shown)this.toasts.dismissKey('server-link');this.shown=false;}
}

export const serverLink=new ServerLink();
