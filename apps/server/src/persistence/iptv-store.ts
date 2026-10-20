import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Db } from './database.js';
import { Vault, digest } from '../security/vault.js';
import { requireThat } from '../errors.js';
import { validateEndpoint, sourceEndpoint, type SourceEndpoint } from '../providers/source-fetch.js';
import { readSportsSettings, eventRank } from './sports-store.js';
import { listed, listingState, listingPolicy, readListingPolicy, alwaysOnMatch, type Listing, type ListingState } from './listing.js';
import { byGroup, eventChannelName, channelTag, sportOf, SPORTS, type Sport } from '../services/sports-match.js';
import { stackKey, quality, feedRank } from '../services/channel-stacks.js';
import { scheduleStackKeys } from '../services/schedule-stacks.js';
import { entryKey, planFeeds } from '../services/feed-identity.js';
import type { CustomChannelStore } from './custom-channels.js';
import { parseM3u, parseXmltv, resolveGuideMapping, approveMapping, mappingCandidates, guideWindow, type GuideMapping, type M3uChannel, type M3uSnapshot, type Program, type XmlSnapshot } from '../providers/iptv.js';

type Kind='m3u'|'xmltv';
type SourceRow={id:string;kind:Kind;name:string;revision:number;interval_hours:number;encrypted_endpoint:string|null;encrypted_snapshot:string|null;encrypted_candidate:string|null;candidate_digest:string|null;last_attempt:number|null;last_success:number|null;next_due:number|null;last_error:string|null;retry_after:number|null};
type ChannelRow={id:string;source_id:string;identity:string;encrypted_provider:string;listing:Listing;event:number;guide_exempt:number;present:number;conflict:number;first_seen:number;last_seen:number;missing_since:number|null;display_name:string|null;stack_key:string|null;number:number|null;position:number|null};
type Feed={id:string;sourceId:string;name:string;number:number;position:number;hasLogo:boolean;stack:string;quality?:string;rank:number;online:boolean;label?:string;event?:{sport:string|null;league:string|null;start:number}};
// Viewer visibility: listed by the source's rules (listing.ts) and holding a lineup number.
const viewable=listed;
const hours=z.number().int().min(1).max(168);
export const sourceCreate=z.object({kind:z.enum(['m3u','xmltv']),name:z.string().trim().min(1).max(120),endpoint:sourceEndpoint.optional()}).strict();
export const sourceOrder=z.object({ids:z.array(z.string().uuid()).max(64)}).strict();
export const sourcePolicy=z.object({expectedRevision:z.number().int().nonnegative(),intervalHours:hours}).strict();
const listingValue=z.enum(['auto','always','hidden']);
export const channelEdit=z.object({expectedRevision:z.number().int().nonnegative(),listing:listingValue.optional(),displayName:z.string().trim().min(1).max(200).nullable().optional(),number:z.number().int().min(1).max(999999).optional(),position:z.number().int().min(0).max(999999).optional(),acceptIdentity:z.boolean().optional(),stack:z.string().trim().max(120).nullable().optional()}).strict();
export const listingEdit=listingPolicy.extend({expectedRevision:z.number().int().nonnegative()}).strict();
export const groupEdit=z.object({expectedRevision:z.number().int().nonnegative(),name:z.string().max(500),mode:z.enum(['auto','regular','events']),guideExempt:z.boolean()}).strict();
export const bulkListing=z.object({expectedRevision:z.number().int().nonnegative(),ids:z.array(z.string().uuid()).min(1).max(500),listing:listingValue}).strict();
export const identityResolution=z.object({expectedRevision:z.number().int().nonnegative(),action:z.enum(['match','new']),candidate:z.string().regex(/^[a-f0-9]{64}$/).optional(),separate:z.boolean().optional()}).strict();
// Guide placeholders that do not count as a program for "has guide data".
const GUIDE_FILLER=/^\s*(no (program(me)?s?|programming|information|info|data|listings?|epg)( available)?|to be (announced|determined)|tba|tbd|off ?air|sign ?off|close ?down|channel off ?air)\s*\.?\s*$/i;
export class IptvStore {
  private scheduleStackCache=new Map<string,{version:string;keys:Map<string,string>}>();
  constructor(private db:Db,private vault:Vault) {}
  private source(id:string) {const row=this.db.prepare('SELECT * FROM iptv_sources WHERE id=?').get(id) as SourceRow|undefined;requireThat(row,'SOURCE_NOT_FOUND','Source not found.',404);return row;}
  private channel(id:string) {const row=this.db.prepare('SELECT c.*,n.number,n.position FROM iptv_channels c LEFT JOIN lineup_numbers n ON n.channel_id=c.id WHERE c.id=?').get(id) as ChannelRow|undefined;requireThat(row,'CHANNEL_NOT_FOUND','Channel not found.',404);return row;}
  private channels(sourceId:string) {return this.db.prepare('SELECT c.*,n.number,n.position FROM iptv_channels c LEFT JOIN lineup_numbers n ON n.channel_id=c.id WHERE source_id=? ORDER BY first_seen,c.rowid').all(sourceId) as ChannelRow[];}
  private provider(c:ChannelRow) {return JSON.parse(this.vault.open(c.encrypted_provider,`iptv:channel:${c.id}`)) as M3uChannel;}
  private identityPlan(sourceId:string,snapshot:M3uSnapshot) {return planFeeds(this.channels(sourceId).map(c=>({id:c.id,identity:c.identity,provider:this.provider(c)})),snapshot.channels);}
  private audit(actor:string,event:string,id:string,now:number) {this.db.prepare('INSERT INTO audit(actor,event,at,detail) VALUES(?,?,?,?)').run(actor,event,now,JSON.stringify({id}));}
  private check(row:SourceRow,expected:number) {requireThat(row.revision===expected,'REVISION_CONFLICT','Source changed. Reload and retry.',409);}
  private snapshot<T>(row:SourceRow):T|undefined {return row.encrypted_snapshot ? JSON.parse(this.vault.open(row.encrypted_snapshot,`iptv:snapshot:${row.id}`)) as T : undefined;}
  status(id:string) {const r=this.source(id),feed=this.db.prepare('SELECT feed_id FROM iptv_source_feeds WHERE source_id=?').get(id) as {feed_id:string}|undefined;return {id:r.id,kind:r.kind,name:r.name,revision:r.revision,intervalHours:r.interval_hours,remote:!!r.encrypted_endpoint,lastAttempt:r.last_attempt,lastSuccess:r.last_success,nextDue:r.next_due,lastError:r.last_error,retryAfter:r.retry_after,candidateDigest:r.candidate_digest,feedId:feed?.feed_id};}
  private sourceOrder() {return (this.db.prepare('SELECT id FROM iptv_sources ORDER BY sort_order,rowid').all() as {id:string}[]).map(r=>r.id);}
  list() {return this.sourceOrder().map(id=>this.status(id));}
  // The guide lists each playlist's channels together, in this order.
  reorder(actor:string,input:z.input<typeof sourceOrder>,now=Date.now()) {
    const v=sourceOrder.parse(input);
    return this.db.transaction(()=>{
      const playlists=(this.db.prepare("SELECT id FROM iptv_sources WHERE kind='m3u'").all() as {id:string}[]).map(r=>r.id);
      requireThat(v.ids.length===playlists.length&&new Set(v.ids).size===v.ids.length&&v.ids.every(id=>playlists.includes(id)),'REVISION_CONFLICT','Sources changed. Reload and retry.',409);
      const set=this.db.prepare('UPDATE iptv_sources SET sort_order=? WHERE id=?');
      v.ids.forEach((id,i)=>set.run(i,id));
      this.db.prepare('INSERT INTO audit(actor,event,at,detail) VALUES(?,?,?,?)').run(actor,'iptv_sources_reordered',now,JSON.stringify({ids:v.ids}));
      return this.list();
    })();
  }
  create(actor:string,input:z.input<typeof sourceCreate>,now=Date.now()) {
    const v=sourceCreate.parse(input),id=randomUUID();
    requireThat(this.list().length<64,'SOURCE_LIMIT','Source limit reached.',409);
    const endpoint=v.endpoint ? validateEndpoint(v.endpoint) : undefined,interval=v.kind==='m3u'?12:6;
    this.db.transaction(()=>{
      this.db.prepare('INSERT INTO iptv_sources(id,kind,name,interval_hours,encrypted_endpoint,next_due,sort_order) VALUES(?,?,?,?,?,?,(SELECT COALESCE(MAX(sort_order),-1)+1 FROM iptv_sources))').run(id,v.kind,v.name,interval,endpoint ? this.vault.seal(JSON.stringify(endpoint),`iptv:endpoint:${id}`) : null,endpoint ? now : null);
      this.audit(actor,'iptv_source_created',id,now);
    })();return this.status(id);
  }
  remove(actor:string,id:string,expected:number,now=Date.now()) {
    return this.db.transaction(()=>{
      this.check(this.source(id),expected);
      const ownFeed=this.status(id).feedId;
      // Feed removal changes each linked playlist's configuration as well.
      const linked=this.db.prepare('SELECT source_id FROM iptv_source_feeds WHERE feed_id=?').all(id) as {source_id:string}[];
      for(const source of linked) {
        this.db.prepare('UPDATE iptv_sources SET revision=revision+1 WHERE id=?').run(source.source_id);
        this.audit(actor,'iptv_feed_unlinked',source.source_id,now);
      }
      this.db.prepare('DELETE FROM iptv_mappings WHERE feed_id=? OR channel_id IN (SELECT id FROM iptv_channels WHERE source_id=?)').run(id,id);
      this.db.prepare('DELETE FROM iptv_favorites WHERE channel_id IN (SELECT id FROM iptv_channels WHERE source_id=?)').run(id);
      this.db.prepare('DELETE FROM lineup_numbers WHERE channel_id IN (SELECT id FROM iptv_channels WHERE source_id=?)').run(id);
      this.db.prepare('DELETE FROM iptv_channel_health WHERE channel_id IN (SELECT id FROM iptv_channels WHERE source_id=?)').run(id);
      this.db.prepare('DELETE FROM iptv_health_policies WHERE source_id=?').run(id);
      this.db.prepare('DELETE FROM iptv_offline_slates WHERE source_id=?').run(id);
      this.db.prepare('DELETE FROM sports_windows WHERE source_id=?').run(id);
      this.db.prepare('DELETE FROM sports_admitted WHERE channel_id IN (SELECT id FROM iptv_channels WHERE source_id=?)').run(id);
      this.db.prepare('DELETE FROM sports_policies WHERE source_id=?').run(id);
      this.db.prepare('DELETE FROM iptv_guide_coverage WHERE channel_id IN (SELECT id FROM iptv_channels WHERE source_id=?)').run(id);
      this.db.prepare('DELETE FROM iptv_listing_policies WHERE source_id=?').run(id);
      this.db.prepare('DELETE FROM iptv_groups WHERE source_id=?').run(id);
      this.db.prepare('DELETE FROM iptv_source_feeds WHERE source_id=? OR feed_id=?').run(id,id);
      this.db.prepare('DELETE FROM iptv_channels WHERE source_id=?').run(id);
      this.db.prepare('DELETE FROM iptv_sources WHERE id=?').run(id);
      this.audit(actor,'iptv_source_removed',id,now);
      if(ownFeed&&!this.db.prepare('SELECT 1 FROM iptv_source_feeds WHERE feed_id=?').get(ownFeed))this.remove(actor,ownFeed,this.source(ownFeed).revision,now);
      return {status:'removed' as const,id};
    })();
  }
  endpoint(id:string):SourceEndpoint {const row=this.source(id);requireThat(row.encrypted_endpoint,'STATIC_SOURCE','Uploaded sources require a new administrator upload; there is no remote refresh.');return JSON.parse(this.vault.open(row.encrypted_endpoint,`iptv:endpoint:${id}`)) as SourceEndpoint;}
  replaceEndpoint(actor:string,id:string,expected:number,input:SourceEndpoint,now=Date.now()) {
    const endpoint=validateEndpoint(input);
    this.db.transaction(()=>{const row=this.source(id);this.check(row,expected);
      this.db.prepare('UPDATE iptv_sources SET revision=revision+1,encrypted_endpoint=?,next_due=? WHERE id=?').run(this.vault.seal(JSON.stringify(endpoint),`iptv:endpoint:${id}`),Math.max(now,row.retry_after??0),id);this.audit(actor,'iptv_endpoint_replaced',id,now);
    })();return this.status(id);
  }
  policy(actor:string,id:string,input:z.input<typeof sourcePolicy>,now=Date.now()) {
    const v=sourcePolicy.parse(input);
    this.db.transaction(()=>{const row=this.source(id);this.check(row,v.expectedRevision);
      this.db.prepare('UPDATE iptv_sources SET revision=revision+1,interval_hours=?,next_due=? WHERE id=?').run(v.intervalHours,row.encrypted_endpoint?Math.max(now+v.intervalHours*3600000,row.retry_after??0):null,id);this.audit(actor,'iptv_source_policy_changed',id,now);
    })();return this.status(id);
  }
  due(now=Date.now()) {return (this.db.prepare('SELECT id FROM iptv_sources WHERE encrypted_endpoint IS NOT NULL AND next_due<=? AND (retry_after IS NULL OR retry_after<=?) ORDER BY next_due,id LIMIT 4').all(now,now) as {id:string}[]).map(r=>r.id);}
  begin(id:string,now=Date.now()) {const row=this.source(id);requireThat(!row.retry_after||row.retry_after<=now,'SOURCE_BACKOFF','Provider backoff is still active.',429);this.endpoint(id);this.db.prepare('UPDATE iptv_sources SET last_attempt=? WHERE id=?').run(now,id);return row.revision;}
  failed(id:string,expected:number,retryAfter:number|undefined,now=Date.now()) {
    // A settings edit during fetch wins. Never overwrite its newly selected cadence.
    const row=this.source(id);if(row.revision!==expected)return;
    this.db.prepare('UPDATE iptv_sources SET last_error=?,retry_after=?,next_due=? WHERE id=?').run(retryAfter?'SOURCE_RATE_LIMITED':'SOURCE_REFRESH_FAILED',retryAfter??null,Math.max(now+row.interval_hours*3600000,retryAfter??0),id);
  }
  ingest(actor:string,id:string,expected:number,bytes:Buffer,now=Date.now()) {
    const row=this.source(id);this.check(row,expected);
    const parsed=row.kind==='m3u'?parseM3u(new TextDecoder('utf-8',{fatal:true}).decode(bytes)):parseXmltv(bytes);
    requireThat(parsed.channels.length<=20000,'IMPORT_LIMIT','Too many source channels.');
    return this.db.transaction(()=>{
      const current=this.source(id);this.check(current,expected);
      if(current.kind==='m3u') {
        const old=this.channels(id).filter(c=>c.present&&!c.conflict),plan=this.identityPlan(id,parsed as M3uSnapshot);
        // A clean HTTP EOF cannot detect a logically truncated provider export.
        // Hold a majority disappearance until the exact candidate is reviewed.
        if(old.length>=2 && old.filter(c=>!plan.present.has(c.id)).length>old.length/2) {
          const text=JSON.stringify(parsed),fingerprint=digest(text);
          this.db.prepare('UPDATE iptv_sources SET revision=revision+1,encrypted_candidate=?,candidate_digest=?,last_attempt=?,last_error=?,next_due=? WHERE id=?').run(this.vault.seal(text,`iptv:candidate:${id}`),fingerprint,now,'SNAPSHOT_REVIEW_REQUIRED',current.encrypted_endpoint?now+current.interval_hours*3600000:null,id);
          this.audit(actor,'iptv_snapshot_held',id,now);return {status:'review_required' as const,source:this.status(id)};
        }
      }
      this.publish(actor,current,parsed,now);return {status:'published' as const,source:this.status(id)};
    })();
  }
  acceptCandidate(actor:string,id:string,expected:number,fingerprint:string,now=Date.now()) {
    return this.db.transaction(()=>{const row=this.source(id);this.check(row,expected);requireThat(row.encrypted_candidate&&row.candidate_digest===fingerprint,'CANDIDATE_CHANGED','Reload the source candidate before approving.',409);
      const parsed=JSON.parse(this.vault.open(row.encrypted_candidate,`iptv:candidate:${id}`)) as M3uSnapshot;this.publish(actor,row,parsed,now);return this.status(id);
    })();
  }
  candidateReview(id:string) {
    const row=this.source(id);requireThat(row.encrypted_candidate,'CANDIDATE_NOT_FOUND','No snapshot is awaiting review.',404);
    const snapshot=JSON.parse(this.vault.open(row.encrypted_candidate,`iptv:candidate:${id}`)) as M3uSnapshot,plan=this.identityPlan(id,snapshot);
    return {revision:row.revision,digest:row.candidate_digest,incoming:plan.entries.map(c=>({tvgId:c.tvgId,name:c.name,group:c.group})),missing:this.channels(id).filter(c=>!plan.present.has(c.id)).map(c=>({id:c.id,name:c.display_name??this.provider(c).name,number:c.number}))};
  }
  private publish(actor:string,row:SourceRow,parsed:M3uSnapshot|XmlSnapshot,now:number) {
    if(row.kind==='m3u')this.reconcile(row,parsed as M3uSnapshot,now);
    this.db.prepare('UPDATE iptv_sources SET revision=revision+1,encrypted_snapshot=?,encrypted_candidate=NULL,candidate_digest=NULL,last_attempt=?,last_success=?,last_error=NULL,retry_after=NULL,next_due=? WHERE id=?').run(this.vault.seal(JSON.stringify(parsed),`iptv:snapshot:${row.id}`),now,now,row.encrypted_endpoint?now+row.interval_hours*3600000:null,row.id);
    this.audit(actor,'iptv_snapshot_published',row.id,now);
    // New channels and new listings change what is listed.
    if(row.kind==='m3u')this.relist(row.id);
    else for(const linked of this.db.prepare('SELECT source_id FROM iptv_source_feeds WHERE feed_id=?').all(row.id) as {source_id:string}[])this.coverage(linked.source_id);
  }
  // Recomputes what a source's channels are (regular or event, needing a guide or not), their guide coverage and numbers.
  relist(sourceId:string,now=Date.now()) {
    const row=this.source(sourceId);if(row.kind!=='m3u')return;
    this.db.transaction(()=>{this.classify(sourceId);this.coverage(sourceId);this.syncNumbers(sourceId,now);})();
  }
  // Startup: channels from before listing rules existed get their classification, coverage and numbers.
  relistAll(now=Date.now()) {
    for(const s of this.list())if(s.kind==='m3u')this.db.transaction(()=>{
      // Upgrade from guide-ID identities using the last validated snapshot, without fetching media or
      // changing refresh success times. The old UUIDs and all their curation remain in place.
      if(this.channels(s.id).some(c=>!c.identity.startsWith('feed:')&&!c.identity.startsWith('retired:'))) {
        const snapshot=this.snapshot<M3uSnapshot>(this.source(s.id));
        if(snapshot){this.reconcile(this.source(s.id),snapshot,now);this.db.prepare('UPDATE iptv_sources SET revision=revision+1 WHERE id=?').run(s.id);this.audit('system','iptv_feed_identity_migrated',s.id,now);}
      }
      this.relist(s.id,now);
    })();
  }
  listingPolicy(sourceId:string) {const row=this.source(sourceId);requireThat(row.kind==='m3u','INVALID_POLICY','Listing rules apply to M3U sources only.');return readListingPolicy(this.db,sourceId);}
  setListingPolicy(actor:string,sourceId:string,input:z.input<typeof listingEdit>,now=Date.now()) {
    const {expectedRevision,...v}=listingEdit.parse(input);
    return this.db.transaction(()=>{
      const row=this.source(sourceId);this.check(row,expectedRevision);requireThat(row.kind==='m3u','INVALID_POLICY','Listing rules apply to M3U sources only.');
      this.db.prepare('INSERT INTO iptv_listing_policies VALUES(?,?,?,?,?) ON CONFLICT(source_id) DO UPDATE SET require_check=excluded.require_check,require_guide=excluded.require_guide,guide_hours=excluded.guide_hours,always_on=excluded.always_on')
        .run(sourceId,Number(v.requireCheck),Number(v.requireGuide),v.guideHours,JSON.stringify([...new Set(v.alwaysOn)]));
      this.db.prepare('UPDATE iptv_sources SET revision=revision+1 WHERE id=?').run(sourceId);this.audit(actor,'iptv_listing_policy_changed',sourceId,now);
      this.relist(sourceId,now);return this.listingPolicy(sourceId);
    })();
  }
  // A playlist's categories: whether each follows events (all of them on a sports source, unless an administrator says otherwise) and needs guide data.
  groups(sourceId:string) {
    const sports=this.sportsEnabled(sourceId),settings=new Map((this.db.prepare('SELECT name,mode,guide_exempt FROM iptv_groups WHERE source_id=?').all(sourceId) as {name:string;mode:'auto'|'regular'|'events';guide_exempt:number}[]).map(g=>[g.name,g]));
    const rows=this.db.prepare(`SELECT c.*,(${listingState}) AS state FROM iptv_channels c WHERE c.source_id=? AND c.present=1`).all(sourceId) as (ChannelRow&{state:ListingState})[];
    const all=rows.map(c=>({...this.provider(c),state:c.state,event:!!c.event})),groups=byGroup(all);
    return [...groups].map(([name,channels])=>{const s=settings.get(name);
      return {name,channels:channels.length,listed:channels.filter(c=>c.state==='listed'||c.state==='always').length,mode:s?.mode??'auto',detected:sports?'events' as const:'regular' as const,events:sports&&channels.some(c=>c.event),guideExempt:!!s?.guide_exempt};
    }).sort((a,b)=>a.name.localeCompare(b.name));
  }
  setGroup(actor:string,sourceId:string,input:z.input<typeof groupEdit>,now=Date.now()) {
    const v=groupEdit.parse(input);
    return this.db.transaction(()=>{
      const row=this.source(sourceId);this.check(row,v.expectedRevision);requireThat(row.kind==='m3u','INVALID_POLICY','Groups apply to M3U sources only.');
      this.db.prepare('INSERT INTO iptv_groups VALUES(?,?,?,?) ON CONFLICT(source_id,name) DO UPDATE SET mode=excluded.mode,guide_exempt=excluded.guide_exempt').run(sourceId,v.name,v.mode,Number(v.guideExempt));
      this.db.prepare('UPDATE iptv_sources SET revision=revision+1 WHERE id=?').run(sourceId);this.audit(actor,'iptv_group_changed',sourceId,now);
      this.relist(sourceId,now);return this.status(sourceId);
    })();
  }
  private sportsEnabled(sourceId:string) {return !!this.db.prepare('SELECT 1 FROM sports_policies WHERE source_id=? AND enabled=1').get(sourceId);}
  // Event channels: the source uses sports events and the channel's category follows events. Guide-exempt: the category
  // is marked so, or the name or category reads like an always-on channel ("24/7").
  private classify(sourceId:string) {
    const sports=this.sportsEnabled(sourceId),settings=new Map((this.db.prepare('SELECT name,mode,guide_exempt FROM iptv_groups WHERE source_id=?').all(sourceId) as {name:string;mode:string;guide_exempt:number}[]).map(g=>[g.name,g]));
    const always=alwaysOnMatch(readListingPolicy(this.db,sourceId).alwaysOn),channels=this.channels(sourceId).map(c=>({row:c,...this.provider(c)}));
    const present=byGroup(channels.filter(c=>c.row.present)),events=new Map<string,boolean>();
    // On a source flagged for sports and live events, every category follows events unless an administrator marks it regular.
    for(const name of present.keys()){const mode=settings.get(name)?.mode??'auto';events.set(name,mode==='events'||(mode==='auto'&&sports));}
    const put=this.db.prepare('UPDATE iptv_channels SET event=?,guide_exempt=? WHERE id=? AND (event<>? OR guide_exempt<>?)');
    // A channel that becomes an event channel gives back its regular number, unless a viewer favorited it; it is numbered again while its event is on.
    const release=this.db.prepare("DELETE FROM lineup_numbers WHERE channel_id=? AND channel_id NOT IN (SELECT channel_id FROM iptv_favorites) AND (SELECT listing FROM iptv_channels WHERE id=?)='auto'");
    for(const c of channels){const event=Number(sports&&(events.get(c.group)??c.row.event===1)),exempt=Number(!!settings.get(c.group)?.guide_exempt||always(c.name)||always(c.group));put.run(event,exempt,c.row.id,event,exempt);if(event&&!c.row.event)release.run(c.row.id,c.row.id);}
  }
  // Merged intervals of real programs on each channel's guide, so the listing rule can ask "anything on soon?" in SQL.
  coverage(sourceId:string) {
    this.db.prepare('DELETE FROM iptv_guide_coverage WHERE channel_id IN (SELECT id FROM iptv_channels WHERE source_id=?)').run(sourceId);
    const feedId=this.status(sourceId).feedId;if(!feedId)return;
    const cache=new Map<string,M3uSnapshot|XmlSnapshot|undefined>(),byXml=new Map<string,Program[]>(),put=this.db.prepare('INSERT INTO iptv_guide_coverage VALUES(?,?,?)');
    let indexed=false;
    for(const c of this.channels(sourceId)){
      if(!c.present||c.conflict)continue;
      const data=this.guideData(c.id,feedId,cache),xmlId=data.mapping?.xmlId;if(!xmlId||!data.xml)continue;
      if(!indexed&&(indexed=true))for(const p of data.xml.programs)if(!GUIDE_FILLER.test(p.title)){const list=byXml.get(p.channelId);if(list)list.push(p);else byXml.set(p.channelId,[p]);}
      const spans=(byXml.get(xmlId)??[]).map(p=>[p.start,p.end] as [number,number]).sort((a,b)=>a[0]-b[0]),merged:[number,number][]=[];
      for(const [start,end] of spans){const last=merged.at(-1);if(last&&start<=last[1]+60000)last[1]=Math.max(last[1],end);else merged.push([start,end]);}
      for(const [start,end] of merged)put.run(c.id,start,end);
    }
  }
  private reserve(id:string,number?:number,position?:number) {
    const existing=this.db.prepare('SELECT number,position FROM lineup_numbers WHERE channel_id=?').get(id) as {number:number;position:number}|undefined;
    if(number!==undefined)requireThat(!this.db.prepare('SELECT 1 FROM lineup_numbers WHERE number=? AND channel_id<>?').get(number,id),'NUMBER_CONFLICT','Channel number is already reserved.',409);
    if(number===undefined&&!existing) {const used=new Set((this.db.prepare('SELECT number FROM lineup_numbers').all() as {number:number}[]).map(n=>n.number));number=1;while(used.has(number))number++;}
    const tail=position===undefined&&!existing ? (this.db.prepare('SELECT MAX(position) AS tail FROM lineup_numbers').get() as {tail:number|null}).tail??-1 : -1;
    this.db.prepare('INSERT INTO lineup_numbers VALUES(?,?,?) ON CONFLICT(channel_id) DO UPDATE SET number=excluded.number,position=excluded.position').run(id,number??existing!.number,position??existing?.position??tail+1);
  }
  private reconcile(row:SourceRow,snapshot:M3uSnapshot,now:number) {
    const prior=this.channels(row.id),plan=this.identityPlan(row.id,snapshot);
    for(const old of prior) {
      const p=plan.matches.get(old.id),conflict=plan.conflicts.has(old.id);
      if(plan.present.has(old.id))this.db.prepare('UPDATE iptv_channels SET identity=?,encrypted_provider=?,present=1,conflict=?,last_seen=?,missing_since=NULL WHERE id=?').run(`feed:${old.id}`,p&&!conflict?this.vault.seal(JSON.stringify(p),`iptv:channel:${old.id}`):old.encrypted_provider,Number(conflict),now,old.id);
      else this.db.prepare('UPDATE iptv_channels SET identity=?,present=0,conflict=0,missing_since=COALESCE(missing_since,?) WHERE id=?').run(old.identity.startsWith('retired:')?old.identity:`feed:${old.id}`,now,old.id);
    }
    for(const p of plan.added) {
      const id=randomUUID();
      this.db.prepare("INSERT INTO iptv_channels(id,source_id,identity,encrypted_provider,approval,present,conflict,first_seen,last_seen) VALUES(?,?,?,?,'pending',1,0,?,?)").run(id,row.id,`feed:${id}`,this.vault.seal(JSON.stringify(p),`iptv:channel:${id}`),now,now);
    }
  }
  adminChannels(id:string) {
    this.source(id);const stacks=this.automaticStackKeys(id),states=new Map((this.db.prepare(`SELECT c.id,(${listingState}) AS state FROM iptv_channels c WHERE c.source_id=?`).all(id) as {id:string;state:ListingState}[]).map(r=>[r.id,r.state]));
    return this.channels(id).map(c=>{const p=this.provider(c);return {id:c.id,sourceId:c.source_id,tvgId:p.tvgId,name:c.display_name??p.name,group:p.group,stack:c.stack_key,stackKey:stacks.get(c.id)??this.stackOf(c,p),quality:quality(p.name)??null,
      listing:c.listing,state:states.get(c.id)??'missing',event:!!c.event,guideExempt:!!c.guide_exempt,present:!!c.present,conflict:!!c.conflict,number:c.number,position:c.position,firstSeen:c.first_seen,lastSeen:c.last_seen,missingSince:c.missing_since};});
  }
  // Counts by listing state, for the source overview.
  listingSummary(id:string) {
    this.source(id);const rows=this.db.prepare(`SELECT (${listingState}) AS state,COUNT(*) AS n FROM iptv_channels c WHERE c.source_id=? GROUP BY 1`).all(id) as {state:ListingState;n:number}[];
    return Object.fromEntries(rows.map(r=>[r.state,r.n])) as Partial<Record<ListingState,number>>;
  }
  private stackOf(c:Pick<ChannelRow,'id'|'display_name'|'stack_key'>,p:M3uChannel) {return (c.stack_key===null?stackKey(c.display_name??p.name):c.stack_key&&stackKey(c.stack_key))||`solo:${c.id}`;}
  private automaticStackKeys(sourceId:string) {
    const link=this.db.prepare('SELECT s.revision,f.feed_id,g.revision AS guide_revision FROM iptv_sources s LEFT JOIN iptv_source_feeds f ON f.source_id=s.id LEFT JOIN iptv_sources g ON g.id=f.feed_id WHERE s.id=?').get(sourceId) as {revision:number;feed_id:string|null;guide_revision:number|null};
    if(!link.feed_id)return new Map<string,string>();
    // Guide mapping edits have their own revision, independent of the playlist revision.
    const mappings=this.db.prepare('SELECT channel_id,value FROM iptv_mappings WHERE feed_id=? AND channel_id IN (SELECT id FROM iptv_channels WHERE source_id=?) ORDER BY channel_id').all(link.feed_id,sourceId) as {channel_id:string;value:string}[];
    const now=Math.floor(Date.now()/60000)*60000,version=JSON.stringify([link.revision,link.feed_id,link.guide_revision,now,mappings]);
    const cached=this.scheduleStackCache.get(sourceId);if(cached?.version===version)return cached.keys;
    // Include health-hidden feeds so a primary failing does not change the station's stack key.
    const channels=this.channels(sourceId).filter(c=>c.present&&!c.conflict&&!c.event),manual=new Map(mappings.map(m=>[m.channel_id,JSON.parse(m.value) as GuideMapping]));
    let keys=new Map<string,string>();
    if(channels.some(c=>c.stack_key===null)) {
      const snapshot=this.snapshot<M3uSnapshot>(this.source(sourceId)),xml=this.snapshot<XmlSnapshot>(this.source(link.feed_id));
      if(snapshot&&xml) {
        const candidates=channels.map(c=>{const p=this.provider(c),mapping=c.stack_key===null?resolveGuideMapping({sourceId,feedId:link.feed_id!,channelId:c.id},p,snapshot.channels,xml,manual.get(c.id)):undefined;
          return {id:c.id,key:this.stackOf(c,p),automatic:c.stack_key===null,xmlId:mapping?.xmlId};});
        const ids=new Set(candidates.flatMap(c=>c.xmlId?[c.xmlId]:[])),programs=new Map<string,Program[]>();
        for(const p of xml.programs)if(ids.has(p.channelId)){const list=programs.get(p.channelId);if(list)list.push(p);else programs.set(p.channelId,[p]);}
        keys=scheduleStackKeys(candidates.map(c=>({...c,...(c.xmlId?{programs:programs.get(c.xmlId)??[]}:{} )})),now);
      }
    }
    if(this.scheduleStackCache.size>=64)this.scheduleStackCache.clear();
    this.scheduleStackCache.set(sourceId,{version,keys});return keys;
  }
  private feeds():Feed[] {const stacks=new Map<string,Map<string,string>>();return (this.db.prepare(`SELECT c.id,c.source_id,c.display_name,c.stack_key,c.encrypted_provider,n.number,n.position,(SELECT h.status FROM iptv_channel_health h WHERE h.channel_id=c.id) AS health,c.event AS sports,(SELECT w.stack_key FROM sports_windows w WHERE w.channel_id=c.id) AS event,ew.sport AS event_sport,ew.league_key AS event_league,ew.start AS event_start FROM iptv_channels c JOIN lineup_numbers n ON n.channel_id=c.id LEFT JOIN sports_windows ew ON ew.channel_id=c.id WHERE ${viewable} ORDER BY n.position,n.number,c.id`).all() as (ChannelRow&{health:string|null;sports:number|null;event:string|null;event_sport:string|null;event_league:string|null;event_start:number|null})[]).map(c=>{const p=this.provider(c),q=quality(p.name)??quality(c.display_name??'');
    if(!c.sports&&!stacks.has(c.source_id))stacks.set(c.source_id,this.automaticStackKeys(c.source_id));
    // Event channels are named by the event alone; their feeds are told apart by the provider's slot.
    const label=c.sports&&!c.display_name?channelTag(p.name):undefined;
    return {id:c.id,sourceId:c.source_id,name:this.nameOf(c,p,!!c.sports),number:c.number!,position:c.position!,hasLogo:/^https?:\/\//i.test(p.logo),...(label?{label}:{}),
    // Event channels stack by the scheduled event they carry ("Home Stream", "Away Stream"), never by name.
    stack:`${c.source_id}:${c.sports?c.event??`solo:${c.id}`:stacks.get(c.source_id)?.get(c.id)??this.stackOf(c,p)}`,...(q?{quality:q}:{}),rank:feedRank(p.name),online:c.health==='online',...(c.sports&&c.event_start!==null?{event:{sport:c.event_sport,league:c.event_league,start:c.event_start}}:{})};});}
  private nameOf(c:Pick<ChannelRow,'display_name'>,p:M3uChannel,sports:boolean) {return c.display_name??(sports?eventChannelName(p.name):p.name);}
  // The sport of the event a visible event channel carries, for its fallback icon.
  sportFor(id:string) {
    const row=this.db.prepare('SELECT w.sport FROM sports_windows w JOIN iptv_channels c ON c.id=w.channel_id AND c.event=1 WHERE w.channel_id=?').get(id) as {sport:string|null}|undefined;
    if(!row)return undefined;
    // Windows matched before sports were recorded fall back to the channel's own name, not the generic icon.
    return (SPORTS as readonly string[]).includes(row.sport??'')?row.sport as Sport:sportOf(this.provider(this.channel(id)).name);
  }
  // The saved logo of the league whose game a visible event channel carries, if one was downloaded.
  leagueLogo(id:string) {
    return this.db.prepare('SELECT l.type,l.bytes FROM sports_windows w JOIN iptv_channels c ON c.id=w.channel_id AND c.event=1 JOIN sports_league_logos l ON l.league_key=w.league_key WHERE w.channel_id=? AND l.bytes IS NOT NULL').get(id) as {type:string;bytes:Buffer}|undefined;
  }
  visible() {return this.feeds().map(({rank:_,online:__,label:___,event:____,...feed})=>feed);}
  // One lineup row per station within a source, like identity. The default feed is the best quality (FHD, then HD), primary before
  // backup, then a feed confirmed working; the row keeps the earliest lineup position of its feeds.
  // Rows are grouped by source in the administrator's order. Within a source, live event rows form one block, above or
  // below the rest (Live Sports settings), ordered by sport, league, then start.
  stacks() {
    const settings=readSportsSettings(this.db),rankOf=eventRank(settings),top=settings.placement==='top',sources=new Map(this.sourceOrder().map((id,i)=>[id,i]));
    const order=(e:NonNullable<Feed['event']>)=>[...rankOf(e.sport,e.league),e.start];
    const groups=new Map<string,Feed[]>();
    for(const feed of this.feeds()){const group=groups.get(feed.stack);if(group)group.push(feed);else groups.set(feed.stack,[feed]);}
    return [...groups.values()].map(group=>{
      const position=Math.min(...group.map(f=>f.position)),feeds=group.sort((a,b)=>b.rank-a.rank||Number(b.online)-Number(a.online)||a.position-b.position||a.number-b.number);
      const {rank:_,online:__,label:___,event:____,...primary}=feeds[0]!,event=feeds.find(f=>f.event)?.event;
      return {row:{...primary,position,feeds:feeds.map(f=>({id:f.id,name:f.label??f.name,number:f.number,...(f.quality?{quality:f.quality}:{})}))},event:event&&order(event)};
    }).sort((a,b)=>{
      const bySource=sources.get(a.row.sourceId)!-sources.get(b.row.sourceId)!;if(bySource)return bySource;
      if(!!a.event!==!!b.event)return (a.event?-1:1)*(top?1:-1);
      if(a.event&&b.event)for(const [i,v] of a.event.entries())if(v!==b.event[i])return v-b.event[i]!;
      return a.row.position-b.row.position||a.row.number-b.row.number;
    }).map(s=>s.row);
  }
  // Server-side only: the decrypted upstream URI must never reach an API response.
  tune(id:string) {requireThat(this.isVisible(id),'CHANNEL_NOT_FOUND','Channel not found.',404);const c=this.channel(id),p=this.provider(c);return {id:c.id,sourceId:c.source_id,name:this.nameOf(c,p,!!c.event),number:c.number!,streamUrl:p.streamUrl};}
  // Playlist logo first, then the mapped guide channel's icon. Server-side only, like stream URIs.
  logo(id:string) {
    requireThat(this.isVisible(id),'CHANNEL_NOT_FOUND','Channel not found.',404);const c=this.channel(id),p=this.provider(c);
    const feedId=this.feedFor(id),data=feedId?this.guideData(id,feedId):undefined;
    // The provider's own name drives library matching; an administrator rename is display-only.
    return {name:p.name,tvgId:p.tvgId,urls:[/^https?:\/\//i.test(p.logo)?p.logo:undefined,data?.xml?.channels.find(x=>x.id===data.mapping?.xmlId)?.icon].filter((u):u is string=>!!u)};
  }
  isVisible(id:string) {return !!this.db.prepare(`SELECT 1 FROM iptv_channels c JOIN lineup_numbers n ON n.channel_id=c.id WHERE c.id=? AND ${viewable}`).get(id);}
  // Health checks also cover unlisted and health-hidden channels, so this skips the visibility rule. Server-side only.
  streamFor(id:string) {const c=this.channel(id);requireThat(c.present&&!c.conflict&&c.listing!=='hidden','CHANNEL_NOT_FOUND','Channel not found.',404);return {id:c.id,sourceId:c.source_id,streamUrl:this.provider(c).streamUrl};}
  // Sets the listing override of several channels of one source at once.
  setListing(actor:string,sourceId:string,input:z.input<typeof bulkListing>,now=Date.now()) {
    const v=bulkListing.parse(input);
    return this.db.transaction(()=>{
      const source=this.source(sourceId);this.check(source,v.expectedRevision);
      requireThat(source.kind==='m3u'&&new Set(v.ids).size===v.ids.length,'INVALID_SELECTION','Select up to 500 unique channels.');
      const selected=v.ids.map(id=>this.channel(id));
      requireThat(selected.every(c=>c.source_id===sourceId),'SELECTION_CHANGED','Only channels from this source can be changed together.',409);
      const put=this.db.prepare('UPDATE iptv_channels SET listing=? WHERE id=?');
      for(const c of selected)put.run(v.listing,c.id);
      this.db.prepare('UPDATE iptv_sources SET revision=revision+1 WHERE id=?').run(sourceId);this.audit(actor,'iptv_channels_listing_changed',sourceId,now);
      this.syncNumbers(sourceId,now);return this.status(sourceId);
    })();
  }
  private identityOptions(c:ChannelRow) {
    const row=this.source(c.source_id),snapshot=this.snapshot<M3uSnapshot>(row);
    requireThat(c.present&&c.conflict&&snapshot,'IDENTITY_UNRESOLVED','This feed is no longer awaiting identity review. Reload the channels.');
    const plan=this.identityPlan(c.source_id,snapshot),conflict=plan.conflicts.get(c.id),match=plan.matches.get(c.id);
    return {snapshot,candidates:conflict?.candidates??(match?[match]:[]),reason:conflict?.reason??'legacy'};
  }
  identityReview(id:string) {
    const c=this.channel(id),p=this.provider(c),options=this.identityOptions(c);
    return {revision:this.status(c.source_id).revision,reason:options.reason,current:{name:p.name,tvgId:p.tvgId,group:p.group},candidates:options.candidates.map(p=>({key:entryKey(p),name:p.name,tvgId:p.tvgId,group:p.group,quality:quality(p.name)??null}))};
  }
  private applyIdentityChoice(c:ChannelRow,choice?:string,asNew=false,separate=false,now=Date.now()) {
    const {snapshot,candidates}=this.identityOptions(c);
    if(asNew) {
      requireThat(candidates.length>0,'IDENTITY_UNRESOLVED','No incoming feeds are available. Refresh the playlist and review again.');
      // Keep the saved feed and its curation, but explicitly stop associating new entries with it.
      this.db.prepare('UPDATE iptv_channels SET identity=? WHERE id=?').run(`retired:${c.id}`,c.id);
    } else {
      const selected=choice?candidates.find(p=>entryKey(p)===choice):candidates.length===1?candidates[0]:undefined;
      requireThat(selected,'IDENTITY_UNRESOLVED','Choose the playlist entry that belongs to this saved feed.');
      this.db.prepare('UPDATE iptv_channels SET encrypted_provider=?,conflict=0 WHERE id=?').run(this.vault.seal(JSON.stringify(selected),`iptv:channel:${c.id}`),c.id);
      if(separate)this.db.prepare("UPDATE iptv_channels SET stack_key='' WHERE id=?").run(c.id);
    }
    this.reconcile(this.source(c.source_id),snapshot,now);
  }
  resolveIdentity(actor:string,id:string,input:z.input<typeof identityResolution>,now=Date.now()) {
    const v=identityResolution.parse(input);
    this.db.transaction(()=>{
      const c=this.channel(id),row=this.source(c.source_id);this.check(row,v.expectedRevision);
      this.applyIdentityChoice(c,v.candidate,v.action==='new',v.separate,now);
      this.db.prepare('UPDATE iptv_sources SET revision=revision+1 WHERE id=?').run(row.id);this.audit(actor,'iptv_feed_identity_resolved',id,now);this.relist(row.id,now);
    })();return this.status(this.channel(id).source_id);
  }
  editChannel(actor:string,id:string,input:z.input<typeof channelEdit>,now=Date.now()) {
    const v=channelEdit.parse(input);
    this.db.transaction(()=>{let c=this.channel(id);const row=this.source(c.source_id);this.check(row,v.expectedRevision);
      if(v.acceptIdentity) {
        this.applyIdentityChoice(c,undefined,false,false,now);c=this.channel(id);
      }
      requireThat((v.number===undefined&&v.position===undefined)||(!c.conflict&&c.present),'IDENTITY_UNRESOLVED','Only present, unambiguous channels can be numbered.');
      if(v.number!==undefined||v.position!==undefined){this.reserve(id,v.number,v.position);this.db.prepare('DELETE FROM sports_admitted WHERE channel_id=?').run(id);}
      this.db.prepare('UPDATE iptv_channels SET listing=?,display_name=?,stack_key=? WHERE id=?').run(v.listing??c.listing,v.displayName===undefined?c.display_name:v.displayName,v.stack===undefined?c.stack_key:v.stack,id);
      this.db.prepare('UPDATE iptv_sources SET revision=revision+1 WHERE id=?').run(row.id);this.audit(actor,'iptv_channel_changed',id,now);
      if(v.acceptIdentity)this.relist(row.id,now);else this.syncNumbers(row.id,now);
    })();return this.status(this.channel(id).source_id);
  }
  // Server-side only: names and listings of a source's event channels, for event matching.
  sportsChannels(sourceId:string,from:number,to:number) {
    const cache=new Map<string,M3uSnapshot|XmlSnapshot|undefined>(),feedId=this.status(sourceId).feedId;
    return this.channels(sourceId).filter(c=>c.event&&c.present&&!c.conflict&&c.listing!=='hidden').map(c=>{
      const p=this.provider(c),data=feedId?this.guideData(c.id,feedId,cache):undefined,xmlId=data?.mapping?.xmlId;
      const programs=xmlId?(data!.xml?.programs??[]).filter(x=>x.channelId===xmlId&&x.end>from&&x.start<to).map(x=>({start:x.start,end:x.end,title:x.title,...(x.subtitle?{subtitle:x.subtitle}:{})})):[];
      return {id:c.id,name:p.name,group:p.group,programs};
    });
  }
  // Lineup numbers follow listing. Regular channels, and event channels set to "always", keep a number for good, in
  // import order. Other event channels take one while their event is live or starting soon and give it back when it is
  // over, unless a viewer favorited them. Hidden and missing channels keep the number they have.
  syncNumbers(sourceId:string,now=Date.now()) {
    return this.db.transaction(()=>{
      const open='SELECT channel_id FROM sports_windows WHERE source_id=@source AND visible_from<=@now AND visible_until>@now',scope={source:sourceId,now};
      const candidate="c.source_id=@source AND c.present=1 AND c.conflict=0 AND c.listing<>'hidden' AND n.channel_id IS NULL";
      this.db.prepare("DELETE FROM sports_admitted WHERE channel_id IN (SELECT id FROM iptv_channels WHERE source_id=@source AND (event=0 OR listing='always'))").run(scope);
      const permanent=(this.db.prepare(`SELECT c.id FROM iptv_channels c LEFT JOIN lineup_numbers n ON n.channel_id=c.id WHERE ${candidate} AND (c.event=0 OR c.listing='always') ORDER BY c.first_seen,c.rowid`).all(scope) as {id:string}[]).map(r=>r.id);
      const admit=(this.db.prepare(`SELECT c.id FROM iptv_channels c LEFT JOIN lineup_numbers n ON n.channel_id=c.id WHERE ${candidate} AND c.event=1 AND c.listing='auto' AND c.id IN (${open}) ORDER BY c.first_seen,c.rowid`).all(scope) as {id:string}[]).map(r=>r.id);
      const revoke=(this.db.prepare(`SELECT a.channel_id AS id FROM sports_admitted a JOIN iptv_channels c ON c.id=a.channel_id WHERE c.source_id=@source AND (a.channel_id NOT IN (${open}) OR c.present=0 OR c.conflict=1 OR c.listing='hidden')`).all(scope) as {id:string}[]).map(r=>r.id);
      if(permanent.length) {
        // One pass: the lowest free numbers, appended to the end of the lineup.
        const reservations=this.db.prepare('SELECT number,position FROM lineup_numbers').all() as {number:number;position:number}[],used=new Set(reservations.map(r=>r.number)),put=this.db.prepare('INSERT INTO lineup_numbers VALUES(?,?,?)');
        let number=1,position=reservations.reduce((max,r)=>Math.max(max,r.position),-1)+1;
        for(const id of permanent){while(used.has(number))number++;put.run(id,number++,position++);}
      }
      for(const id of admit){this.reserve(id,this.eventNumber(id));this.db.prepare('INSERT OR IGNORE INTO sports_admitted VALUES(?)').run(id);}
      for(const id of revoke){
        this.db.prepare('DELETE FROM lineup_numbers WHERE channel_id=? AND channel_id NOT IN (SELECT channel_id FROM iptv_favorites)').run(id);
        this.db.prepare('DELETE FROM sports_admitted WHERE channel_id=?').run(id);
      }
      if(admit.length||revoke.length){this.db.prepare('UPDATE iptv_sources SET revision=revision+1 WHERE id=?').run(sourceId);this.audit('system:sports','sports_numbers_synced',sourceId,now);}
      return {numbered:permanent.length+admit.length,released:revoke.length};
    })();
  }
  // Event channels take the lowest free number in the Live Sports block, when one is set. A channel that kept its
  // number (a viewer favorited it) keeps it.
  private eventNumber(id:string) {
    const start=readSportsSettings(this.db).numberStart;
    if(!start||this.db.prepare('SELECT 1 FROM lineup_numbers WHERE channel_id=?').get(id))return undefined;
    const used=new Set((this.db.prepare('SELECT number FROM lineup_numbers WHERE number>=?').all(start) as {number:number}[]).map(n=>n.number));
    let number=start;while(used.has(number))number++;return number;
  }
  // Moves the event channels the schedule admitted into the number block, in guide order. Favorited channels keep
  // their numbers, since viewers may know them. Returns how many moved.
  renumberEvents() {
    const start=readSportsSettings(this.db).numberStart;if(!start)return 0;
    return this.db.transaction(()=>{
      const rows=this.db.prepare('SELECT n.channel_id AS id,n.position FROM lineup_numbers n JOIN sports_admitted a ON a.channel_id=n.channel_id WHERE n.channel_id NOT IN (SELECT channel_id FROM iptv_favorites)').all() as {id:string;position:number}[];
      const guide=this.stacks().flatMap(s=>s.feeds.map(f=>f.id)),index=new Map(guide.map((id,i)=>[id,i]));
      rows.sort((a,b)=>(index.get(a.id)??guide.length)-(index.get(b.id)??guide.length));
      const remove=this.db.prepare('DELETE FROM lineup_numbers WHERE channel_id=?'),put=this.db.prepare('INSERT INTO lineup_numbers VALUES(?,?,?)');
      for(const row of rows)remove.run(row.id);
      const used=new Set((this.db.prepare('SELECT number FROM lineup_numbers WHERE number>=?').all(start) as {number:number}[]).map(n=>n.number));
      let number=start;
      for(const row of rows){while(used.has(number))number++;put.run(row.id,number++,row.position);}
      return rows.length;
    })();
  }
  favorite(account:string,id:string,value:boolean) {
    requireThat(this.isVisible(id),'CHANNEL_NOT_FOUND','Channel not found.',404);
    if(value)this.db.prepare('INSERT OR IGNORE INTO iptv_favorites VALUES(?,?)').run(account,id);
    // A stack is a favorite while any of its feeds is, so removing it clears every feed.
    else for(const feed of this.stacks().find(s=>s.feeds.some(f=>f.id===id))?.feeds??[{id}])this.db.prepare('DELETE FROM iptv_favorites WHERE account_id=? AND channel_id=?').run(account,feed.id);
  }
  favorites(account:string) {const ids=new Set((this.db.prepare('SELECT channel_id FROM iptv_favorites WHERE account_id=?').all(account) as {channel_id:string}[]).map(c=>c.channel_id));return this.visible().filter(c=>ids.has(c.id));}
  bindFeed(actor:string,sourceId:string,feedId:string,expected:number,now=Date.now()) {
    this.db.transaction(()=>{const source=this.source(sourceId),feed=this.source(feedId);this.check(source,expected);requireThat(source.kind==='m3u'&&feed.kind==='xmltv','MAPPING_SCOPE','Link an M3U source to an XMLTV feed.');
      this.db.prepare('INSERT INTO iptv_source_feeds VALUES(?,?) ON CONFLICT(source_id) DO UPDATE SET feed_id=excluded.feed_id').run(sourceId,feedId);
      this.db.prepare('UPDATE iptv_sources SET revision=revision+1 WHERE id=?').run(sourceId);this.audit(actor,'iptv_feed_linked',sourceId,now);this.coverage(sourceId);
    })();return this.status(sourceId);
  }
  saveGuide(actor:string,sourceId:string,expected:number,input:{endpoint?:SourceEndpoint;intervalHours:number},now=Date.now()) {
    return this.db.transaction(()=>{
      const source=this.source(sourceId);this.check(source,expected);
      requireThat(source.kind==='m3u','MAPPING_SCOPE','Add a program guide to an M3U source.');
      const interval=hours.parse(input.intervalHours),endpoint=input.endpoint?validateEndpoint(input.endpoint):undefined;
      const oldId=this.status(sourceId).feedId,old=oldId?this.source(oldId):undefined;
      requireThat(old||endpoint,'GUIDE_ENDPOINT_REQUIRED','Enter an EPG URL.');
      // Legacy feeds can be shared. Copy their saved data before editing so other playlists are unaffected.
      const shared=old&&!!this.db.prepare('SELECT 1 FROM iptv_source_feeds WHERE feed_id=? AND source_id<>?').get(old.id,sourceId);
      let feedId=old?.id;
      if(!old||shared) {
        const feed=this.create(actor,{kind:'xmltv',name:`${source.name.slice(0,114)} · EPG`,endpoint:endpoint??(old?.encrypted_endpoint?this.endpoint(old.id):undefined)},now);
        feedId=feed.id;
        if(old) {
          const snapshot=this.snapshot<XmlSnapshot>(old);
          if(snapshot)this.db.prepare('UPDATE iptv_sources SET encrypted_snapshot=?,last_attempt=?,last_success=?,last_error=?,retry_after=? WHERE id=?').run(this.vault.seal(JSON.stringify(snapshot),`iptv:snapshot:${feedId}`),old.last_attempt,old.last_success,old.last_error,old.retry_after,feedId);
          const mappings=this.db.prepare('SELECT m.channel_id,m.value FROM iptv_mappings m JOIN iptv_channels c ON c.id=m.channel_id WHERE c.source_id=? AND m.feed_id=?').all(sourceId,old.id) as {channel_id:string;value:string}[];
          for(const mapping of mappings)this.db.prepare('INSERT INTO iptv_mappings VALUES(?,?,?)').run(mapping.channel_id,feedId,JSON.stringify({...JSON.parse(mapping.value),feedId}));
          this.db.prepare('DELETE FROM iptv_mappings WHERE feed_id=? AND channel_id IN (SELECT id FROM iptv_channels WHERE source_id=?)').run(old.id,sourceId);
        }
      } else if(endpoint)this.replaceEndpoint(actor,old.id,old.revision,endpoint,now);
      const feed=this.status(feedId!);
      this.policy(actor,feed.id,{expectedRevision:feed.revision,intervalHours:interval},now);
      this.bindFeed(actor,sourceId,feed.id,expected,now);
      return {source:this.status(sourceId),guide:this.status(feed.id)};
    })();
  }
  removeGuide(actor:string,sourceId:string,expected:number,now=Date.now()) {
    return this.db.transaction(()=>{
      const source=this.source(sourceId);this.check(source,expected);
      requireThat(source.kind==='m3u','MAPPING_SCOPE','Remove a program guide from an M3U source.');
      const feedId=this.status(sourceId).feedId;
      this.db.prepare('DELETE FROM iptv_source_feeds WHERE source_id=?').run(sourceId);
      this.db.prepare('DELETE FROM iptv_mappings WHERE channel_id IN (SELECT id FROM iptv_channels WHERE source_id=?)').run(sourceId);
      this.db.prepare('DELETE FROM iptv_guide_coverage WHERE channel_id IN (SELECT id FROM iptv_channels WHERE source_id=?)').run(sourceId);
      this.db.prepare('UPDATE iptv_sources SET revision=revision+1 WHERE id=?').run(sourceId);
      this.audit(actor,'iptv_feed_unlinked',sourceId,now);
      if(feedId&&!this.db.prepare('SELECT 1 FROM iptv_source_feeds WHERE feed_id=?').get(feedId))this.remove(actor,feedId,this.source(feedId).revision,now);
      return this.status(sourceId);
    })();
  }
  feedFor(channelId:string) {const channel=this.channel(channelId),row=this.db.prepare('SELECT feed_id FROM iptv_source_feeds WHERE source_id=?').get(channel.source_id) as {feed_id:string}|undefined;return row?.feed_id;}
  private guideData(id:string,feedId:string,cache?:Map<string,M3uSnapshot|XmlSnapshot|undefined>) {
    requireThat(this.feedFor(id)===feedId,'MAPPING_SCOPE','The feed is not linked to this M3U source.');
    // Source rows carry the encrypted snapshot (megabytes for a guide), so a cached snapshot skips reading the row.
    const c=this.channel(id),kind=this.db.prepare('SELECT kind FROM iptv_sources WHERE id=?').get(feedId) as {kind:string}|undefined;requireThat(kind,'SOURCE_NOT_FOUND','Source not found.',404);requireThat(kind.kind==='xmltv','MAPPING_SCOPE','Select an XMLTV feed.');
    const read=<T extends M3uSnapshot|XmlSnapshot>(sourceId:string):T|undefined=>{if(cache?.has(sourceId))return cache.get(sourceId) as T|undefined;const value=this.snapshot<T>(this.source(sourceId));cache?.set(sourceId,value);return value;};
    const source={id:c.source_id},xml=read<XmlSnapshot>(feedId),snapshot=read<M3uSnapshot>(c.source_id),stored=this.db.prepare('SELECT value FROM iptv_mappings WHERE channel_id=? AND feed_id=?').get(id,feedId) as {value:string}|undefined;
    const manual=stored?JSON.parse(stored.value) as GuideMapping:undefined,scope={sourceId:source.id,feedId,channelId:id};
    const mapping=xml&&snapshot&&!c.conflict&&c.present?resolveGuideMapping(scope,this.provider(c),snapshot.channels,xml,manual):undefined;
    return {c,xml,manual,mapping,scope,snapshot};
  }
  mappingReview(id:string,feedId:string) {const {c,xml,manual,mapping,snapshot}=this.guideData(id,feedId);return {mapping,reviewRevision:manual?.revision??0,candidates:xml&&snapshot&&!c.conflict?mappingCandidates(this.provider(c),snapshot.channels,xml):{suggestions:[]}};}
  map(actor:string,id:string,feedId:string,xmlId:string,expectedRevision:number,now=Date.now()) {
    return this.db.transaction(()=>{const {c,xml,manual,scope}=this.guideData(id,feedId);requireThat(xml&&!c.conflict&&c.present,'MAPPING_CONFLICT','Channel or guide identity is unavailable or ambiguous.');
      const mapping=approveMapping({role:'admin',accountId:actor,...scope,xmlId,expectedRevision},manual,scope,xml);
      this.db.prepare('INSERT INTO iptv_mappings VALUES(?,?,?) ON CONFLICT(channel_id,feed_id) DO UPDATE SET value=excluded.value').run(id,feedId,JSON.stringify(mapping));this.audit(actor,'iptv_mapping_approved',id,now);this.coverage(c.source_id);return mapping;
    })();
  }
  guide(id:string,feedId:string|undefined,start:number,end:number) {
    requireThat(this.isVisible(id),'CHANNEL_NOT_FOUND','Channel not found.',404);
    const event=this.eventRows(id,start,end);if(event||!feedId)return event??guideWindow([],undefined,start,end);
    const {c,xml,mapping}=this.guideData(id,feedId);return guideWindow(xml?.programs??[],mapping?.xmlId,start,end,c.display_name??this.provider(c).name);
  }
  // A live sports event an event channel carries, as its guide listing: the event itself, led in by a
  // "starting soon" slot from when the channel appears, and blank afterwards rather than "No guide data".
  // A window taken from the EPG alone keeps the EPG.
  private eventRows(id:string,start:number,end:number) {
    const w=this.db.prepare("SELECT title,league,start,end,visible_from FROM sports_windows WHERE channel_id=? AND matched_by<>'epg'").get(id) as {title:string;league:string;start:number;end:number;visible_from:number}|undefined;
    if(!w)return undefined;
    const event:Program={channelId:'sports',start:w.start,end:w.end,title:w.title,...(w.league?{category:w.league}:{})};
    const programs=w.visible_from<w.start?[{...event,start:w.visible_from,end:w.start,subtitle:'Starting soon',status:'starting_soon' as const},event]:[event];
    return guideWindow(programs,'sports',start,end).map(row=>row.program?row:{...row,blank:true as const});
  }
  // Favorites lead the guide as their own group, pulled out of their sources; then custom channels, then IPTV sources
  // in the administrator's order. Each row names its group so the client can head each one (across pages too).
  // A filter other than the fixed ones names an IPTV source: that source's channels alone. Categories are every IPTV source
  // with channels, in guide order whatever the filter, for the guide's filter chips.
  guidePage(account:string,filter:string,start:number,end:number,offset:number,limit:number,q='',channelId?:string,custom?:CustomChannelStore) {
    const favorites=new Set((this.db.prepare('SELECT channel_id FROM iptv_favorites WHERE account_id=?').all(account) as {channel_id:string}[]).map(c=>c.channel_id));
    const search=q.trim().toLocaleLowerCase(),source=['all','custom','favorites'].includes(filter)?undefined:filter,stacks=this.stacks();
    const categories=[...new Set(stacks.map(c=>c.sourceId))].map(id=>({id,name:this.source(id).name}));
    const customs=source||!custom?[]:custom.stations(account,filter==='favorites',search,channelId);
    const channels=filter==='custom'?[]:stacks.filter(c=>(!source||c.sourceId===source)&&(filter!=='favorites'||c.feeds.some(f=>favorites.has(f.id)))&&(!channelId||c.feeds.some(f=>f.id===channelId))&&(!search||c.name.toLocaleLowerCase().includes(search)||c.feeds.some(f=>f.name.toLocaleLowerCase().includes(search)||String(f.number).includes(search)))),cache=new Map<string,M3uSnapshot|XmlSnapshot|undefined>();
    // The Favorites filter is all favorites already, and a source filter is one source, so both leave favorites in place.
    const pull=filter!=='favorites'&&!source;
    const rows=[...customs.map(c=>({kind:'custom' as const,c,favorite:c.favorite,group:'custom'})),...channels.map(c=>{const favorite=c.feeds.some(f=>favorites.has(f.id));return {kind:'iptv' as const,c,favorite,group:c.sourceId};})]
      .map(r=>pull&&r.favorite?{...r,group:'favorites'}:r);
    const ordered=[...rows.filter(r=>r.group==='favorites'),...rows.filter(r=>r.group!=='favorites')];
    const counts=new Map<string,number>();for(const r of ordered)counts.set(r.group,(counts.get(r.group)??0)+1);
    const sources=[...counts].map(([id,count])=>({id,name:id==='favorites'?'Favorites':id==='custom'?'Plex Channels':this.source(id).name,count}));
    const total=ordered.length;
    return {start,end,offset,limit,total,hasMore:offset+limit<total,sources,categories,channels:ordered.slice(offset,offset+limit).map(r=>{
      if(r.kind==='custom')return {...r.c,group:r.group,programs:custom!.programs(r.c.id,start,end)};
      const channel=r.c;
      // Feeds of one station share a schedule: use the first feed with a guide match.
      let data:ReturnType<IptvStore['guideData']>|undefined;
      for(const feed of channel.feeds){const feedId=this.feedFor(feed.id),candidate=feedId?this.guideData(feed.id,feedId,cache):undefined;data??=candidate;if(candidate?.mapping){data=candidate;break;}}
      // Any channel may match the logo library, so the logo route decides; the UI falls back to a monogram.
      const {hasLogo:_,...rest}=channel,logo=true;
      return {...rest,group:r.group,logo,type:'iptv' as const,favorite:r.favorite,programs:this.eventRows(channel.id,start,end)??guideWindow(data?.xml?.programs??[],data?.mapping?.xmlId,start,end,channel.name)};
    })};
  }
}
