import {useEffect,useSyncExternalStore} from 'react';

// Short popups at the bottom right: what you just did, or something live. See docs/NOTIFICATIONS.md.
// Success, info and warning fade on their own (hovering or focusing one pauses it); errors stay until dismissed.
// A toast with the same `key` as one on screen replaces it; the same text again adds a count instead.
export type Tone='success'|'info'|'warning'|'error';
export type ToastAction={label:string;run:()=>void};
export type ToastOptions={detail?:string;action?:ToastAction;key?:string;onDismiss?:()=>void;sticky?:boolean};
// `ms`: how long it shows (undefined: until dismissed). `version` changes whenever it is shown again, restarting its clock.
export type Toast={id:number;tone:Tone;title:string;detail?:string;action?:ToastAction;key?:string;count:number;sticky:boolean;
  ms?:number;version:number;onDismiss?:()=>void};

export const TOAST_MS:Record<Tone,number|undefined>={success:3500,info:5000,warning:8000,error:undefined};
export const VISIBLE_TOASTS=3;

type Timers={set:(run:()=>void,ms:number)=>unknown;clear:(handle:unknown)=>void;now:()=>number};
const realTimers:Timers={set:(run,ms)=>setTimeout(run,ms),clear:handle=>clearTimeout(handle as ReturnType<typeof setTimeout>),now:()=>Date.now()};

export class ToastStore {
  private list:Toast[]=[];
  private nextId=0;
  private timers=new Map<number,{handle:unknown;started:number;left:number}>();
  // Paused toasts and the time each had left.
  private paused=new Map<number,number|undefined>();
  private listeners=new Set<()=>void>();
  constructor(private clock:Timers=realTimers) {}

  subscribe=(listener:()=>void)=>{this.listeners.add(listener);return()=>{this.listeners.delete(listener);};};
  snapshot=()=>this.list;
  private emit() {for(const listener of this.listeners)listener();}

  show(tone:Tone,title:string,options:ToastOptions={}):number {
    const sticky=options.sticky??TOAST_MS[tone]===undefined,ms=sticky?undefined:TOAST_MS[tone],version=++this.nextId;
    const same=options.key===undefined?this.list.find(t=>t.key===undefined&&t.tone===tone&&t.title===title&&t.detail===options.detail):this.list.find(t=>t.key===options.key);
    const next:Omit<Toast,'id'|'count'>={tone,title,detail:options.detail,action:options.action,key:options.key,sticky,ms,version,onDismiss:options.onDismiss};
    let id:number;
    if(same) {
      id=same.id;
      const count=same.title===title&&same.tone===tone?same.count+1:1;
      // A replaced toast moves to the newest place, so it is the one in view.
      this.list=[...this.list.filter(t=>t.id!==id),{...next,id,count}];
    } else {
      id=version;
      this.list=[...this.list,{...next,id,count:1}];
    }
    this.stopTimer(id);
    if(this.paused.has(id))this.paused.set(id,ms);
    else if(ms!==undefined)this.startTimer(id,ms);
    this.emit();
    return id;
  }
  success=(title:string,options?:ToastOptions)=>this.show('success',title,options);
  info=(title:string,options?:ToastOptions)=>this.show('info',title,options);
  warning=(title:string,options?:ToastOptions)=>this.show('warning',title,options);
  error=(title:string,options?:ToastOptions)=>this.show('error',title,options);

  // One toast for work that takes a while: info (and sticky) while it runs, then success or error in its place.
  async promise<T>(work:Promise<T>,text:{pending:string;done:string|((value:T)=>string);failed?:string|((error:Error)=>string)}):Promise<T> {
    const key=`promise-${++this.nextId}`;
    this.show('info',text.pending,{key,sticky:true});
    try {
      const value=await work;
      this.show('success',typeof text.done==='function'?text.done(value):text.done,{key});
      return value;
    } catch(error) {
      const e=error as Error;
      this.show('error',text.failed===undefined?e.message:typeof text.failed==='function'?text.failed(e):text.failed,{key});
      throw error;
    }
  }

  dismiss(id:number) {
    const toast=this.list.find(t=>t.id===id);if(!toast)return;
    this.stopTimer(id);this.paused.delete(id);
    this.list=this.list.filter(t=>t.id!==id);
    this.emit();
    toast.onDismiss?.();
  }
  dismissKey(key:string) {const toast=this.list.find(t=>t.key===key);if(toast)this.dismiss(toast.id);}
  clear() {for(const toast of [...this.list])this.dismiss(toast.id);}

  // Hover or focus: the clock stops and picks up where it left off.
  pause(id:number) {
    if(this.paused.has(id)||!this.list.some(t=>t.id===id))return;
    const timer=this.timers.get(id);
    this.stopTimer(id);
    this.paused.set(id,timer&&Math.max(0,timer.left-(this.clock.now()-timer.started)));
  }
  resume(id:number) {
    if(!this.paused.has(id))return;
    const left=this.paused.get(id);this.paused.delete(id);
    if(left!==undefined)this.startTimer(id,left);
  }

  private startTimer(id:number,ms:number) {this.timers.set(id,{handle:this.clock.set(()=>{this.timers.delete(id);this.dismiss(id);},ms),started:this.clock.now(),left:ms});}
  private stopTimer(id:number) {const timer=this.timers.get(id);if(timer){this.clock.clear(timer.handle);this.timers.delete(id);}}
}

export const toast=new ToastStore();
export const useToasts=()=>useSyncExternalStore(toast.subscribe,toast.snapshot);

// A page's one error message (a failed action, playback trouble) as an error toast: shown while `error` is set, and
// dismissing the toast clears it.
export function useErrorToast(error:string,clear:()=>void) {
  useEffect(()=>{
    if(error)toast.error(error,{key:'page-error',onDismiss:clear});
    else toast.dismissKey('page-error');
  },[error]);
}
