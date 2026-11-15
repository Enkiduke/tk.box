import {useSyncExternalStore} from 'react';
import type {NotificationItem,NotificationList} from '../../../packages/contracts/src/index.js';
import {api} from './api.js';
import {toast,type ToastOptions,type Tone} from './toasts.js';

// The bell's list (docs/NOTIFICATIONS.md), one per page. It loads when the viewer signs in and again on each
// `notifications` event. What arrives while the page is open also pops up as a toast, unless the page is quiet
// (watching); what was already there when the page opened only counts on the bell.
type Fetch=<T>(path:string,method?:string,body?:unknown)=>Promise<T>;
type Announce=(tone:Tone,title:string,options:ToastOptions)=>void;
export type FeedState={items:NotificationItem[];unread:number;loaded:boolean};

// Rows that are new, or say something new, since `before`, and are unread: what deserves a toast.
export function fresh(before:readonly NotificationItem[],after:readonly NotificationItem[]):NotificationItem[] {
  const seen=new Map(before.map(i=>[i.id,i.updatedAt]));
  return after.filter(i=>!i.read&&seen.get(i.id)!==i.updatedAt);
}
// Open conditions first (for System), then newest.
export const ordered=(items:readonly NotificationItem[])=>[...items].sort((a,b)=>Number(b.open)-Number(a.open)||b.updatedAt-a.updatedAt||b.id-a.id);

export class NotificationFeed {
  private state:FeedState={items:[],unread:0,loaded:false};
  private listeners=new Set<()=>void>();
  private loading?:Promise<void>;
  private again=false;
  // Set by the page: true while toasts would get in the way (the player).
  quiet:()=>boolean=()=>false;
  // Opens a notification's link (the page's router).
  open:(link:string)=>void=link=>{window.location.hash=link.replace(/^#/,'');};
  constructor(private fetcher:Fetch=api,private announce:Announce=(tone,title,options)=>{toast.show(tone,title,options);}) {}

  subscribe=(listener:()=>void)=>{this.listeners.add(listener);return()=>{this.listeners.delete(listener);};};
  snapshot=()=>this.state;
  private set(next:Partial<FeedState>) {this.state={...this.state,...next};for(const listener of this.listeners)listener();}

  // Reads the list again. Calls while one is running fold into one more read after it.
  reload():Promise<void> {
    if(this.loading){this.again=true;return this.loading;}
    this.loading=(async()=>{
      try {
        do {
          this.again=false;
          const before=this.state;
          const list=await this.fetcher<NotificationList>('/notifications');
          this.set({items:list.items,unread:list.unread,loaded:true});
          if(before.loaded&&!this.quiet())for(const item of fresh(before.items,list.items).reverse())this.pop(item);
        } while(this.again);
      } catch {/* the bell keeps what it had; the next event or page load tries again */}
      finally {this.loading=undefined;}
    })();
    return this.loading;
  }
  private pop(item:NotificationItem) {
    this.announce(item.tone,item.title,{key:`notification-${item.id}`,...(item.detail?{detail:item.detail}:{}),
      ...(item.link?{action:{label:'View',run:()=>this.follow(item)}}:{})});
  }
  // Signed out: forget everything, so the next account starts with a fresh list and no toasts for old rows.
  clear() {this.state={items:[],unread:0,loaded:false};for(const listener of this.listeners)listener();}

  follow(item:NotificationItem) {if(!item.read)void this.markRead([item.id]);if(item.link)this.open(item.link);}
  async markRead(ids:number[]|'all') {
    const marking=new Set(ids==='all'?this.state.items.filter(i=>!i.read).map(i=>i.id):ids);
    const was=this.state.items.filter(i=>marking.has(i.id)&&!i.read).length;
    if(!was&&ids!=='all')return;
    this.set({items:this.state.items.map(i=>marking.has(i.id)?{...i,read:true}:i),unread:ids==='all'?0:Math.max(0,this.state.unread-was)});
    try {await this.fetcher('/notifications/read','POST',ids==='all'?{all:true}:{ids});}
    catch(e) {toast.error((e as Error).message);void this.reload();}
  }
  async dismissAll() {
    if(!this.state.items.length)return;
    this.set({items:[],unread:0});
    try {await this.fetcher('/notifications','DELETE');}
    catch(e) {toast.error((e as Error).message);void this.reload();}
  }
  async dismiss(item:NotificationItem) {
    this.set({items:this.state.items.filter(i=>i.id!==item.id),unread:Math.max(0,this.state.unread-(item.read?0:1))});
    try {await this.fetcher(`/notifications/${item.id}`,'DELETE');}
    catch(e) {toast.error((e as Error).message);void this.reload();}
  }
}

export const notifications=new NotificationFeed();
export const useNotifications=()=>useSyncExternalStore(notifications.subscribe,notifications.snapshot);
