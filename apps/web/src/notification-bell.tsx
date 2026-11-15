import {useRef,useState} from 'react';
import type {NotificationItem} from '../../../packages/contracts/src/index.js';
import {Icon} from './components.js';
import {notifications,ordered,useNotifications} from './notifications.js';

const relative=new Intl.RelativeTimeFormat(undefined,{numeric:'auto'});
const ago=(at:number)=>{
  const seconds=(at-Date.now())/1000;
  for(const [unit,size] of [['year',31536000],['month',2592000],['week',604800],['day',86400],['hour',3600],['minute',60]] as const)if(Math.abs(seconds)>=size)return relative.format(Math.round(seconds/size),unit);
  return 'just now';
};
const rank={error:3,warning:2,info:1,success:0} as const;

// Each row's icon says what it is about, in its tone's colour: a shield for the admins' system alerts, a download for
// your requests, a bell for anything else.
const iconOf=(item:NotificationItem)=>item.audience==='admins'?'shield':item.kind.startsWith('request.')?'download':'bell';

// The header's bell: the unread count, and for admins a dot in the tone of the worst open condition (it stays while
// the condition does, even once read). One list: open conditions on top, then newest.
export function NotificationBell({admin}:{admin:boolean}) {
  const {items,unread}=useNotifications(),[open,setOpen]=useState(false);
  const button=useRef<HTMLButtonElement>(null),pop=useRef<HTMLDivElement>(null);
  const shown=ordered(items),conditions=items.filter(i=>i.audience==='admins'&&i.open);
  const worst=conditions.reduce<NotificationItem|undefined>((w,i)=>!w||rank[i.tone]>rank[w.tone]?i:w,undefined);
  const label=unread?`Notifications · ${unread} unread`:'Notifications';
  const place=()=>{
    const b=button.current?.getBoundingClientRect(),p=pop.current;if(!b||!p)return;
    p.style.top=`${b.bottom+8}px`;p.style.right=`${Math.max(8,innerWidth-b.right)}px`;
  };
  const follow=(item:NotificationItem)=>{if(item.link)pop.current?.hidePopover();notifications.follow(item);};
  return <>
    <button ref={button} type="button" className="nav-bell" popoverTarget="header-notifications" aria-label={label} title={label} aria-expanded={open}>
      <Icon name="bell" size={20}/>
      {unread>0&&<span className="bell-count" aria-hidden="true">{unread>99?'99+':unread}</span>}
      {admin&&worst&&!unread&&<span className={`bell-dot ${worst.tone}`} aria-hidden="true"/>}
    </button>
    <div ref={pop} id="header-notifications" popover="auto" className="streams-pop bell-pop" role="dialog" aria-label="Notifications"
      onBeforeToggle={e=>{if((e.nativeEvent as ToggleEvent).newState==='open')place();}}
      onToggle={e=>setOpen((e.nativeEvent as ToggleEvent).newState==='open')}>
      <header>
        <strong>Notifications</strong>
        {shown.length>0&&<div className="bell-actions">
          {unread>0&&<button type="button" className="text-button" onClick={()=>void notifications.markRead('all')}>Mark all read</button>}
          <button type="button" className="text-button" onClick={()=>void notifications.dismissAll()}>Clear all</button>
        </div>}
      </header>
      {!shown.length?<p className="streams-pop-note">Nothing here yet.</p>:<ul className="bell-list">{shown.map(item=>
        <li key={item.id} className={`bell-item ${item.tone}${item.read?'':' unread'}${item.open?' open':''}`}>
          <button type="button" className="bell-main" onClick={()=>follow(item)}>
            <span className="bell-icon" title={item.audience==='admins'?'System':undefined}><Icon name={iconOf(item)} size={16}/></span>
            <span className="bell-text">
              <span className="bell-title">{item.audience==='admins'&&<span className="sr-only">System: </span>}{item.title}</span>
              {item.detail&&<span className="bell-detail">{item.detail}</span>}
              <time dateTime={new Date(item.updatedAt).toISOString()} title={new Date(item.updatedAt).toLocaleString()}>{item.open?'Ongoing · ':''}{ago(item.updatedAt)}</time>
            </span>
            {!item.read&&<span className="bell-unread" aria-label="Unread"/>}
          </button>
          <button type="button" className="icon-button bell-dismiss" aria-label={`Dismiss ${item.title}`} onClick={()=>void notifications.dismiss(item)}><Icon name="close" size={14}/></button>
        </li>)}</ul>}
    </div>
  </>;
}
