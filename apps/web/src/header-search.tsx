import {useEffect,useRef,useState} from 'react';
import {Icon} from './components.js';

export function HeaderSearch({page,query,onChange}:{page:string;query:string;onChange:(value:string)=>void}) {
  const [open,setOpen]=useState(page==='search'),[text,setText]=useState(query);
  const input=useRef<HTMLInputElement>(null),toggle=useRef<HTMLButtonElement>(null);
  useEffect(()=>{setText(query);setOpen(page==='search');},[page,query]);
  useEffect(()=>{if(open)input.current?.focus();},[open]);
  const change=(value:string)=>{
    setText(value);
    onChange(value);
    if(!value.trim()){setOpen(false);toggle.current?.focus();}
  };
  return <div className="nav-search">
    <form className={`nav-search-box ${open?'is-open':''}`} role="search" onSubmit={e=>{e.preventDefault();if(text.trim())change(text);}}
      onBlur={e=>{if(!e.currentTarget.contains(e.relatedTarget)&&!text.trim())setOpen(false);}}
      onKeyDown={e=>{if(e.key==='Escape'){e.preventDefault();e.stopPropagation();change('');}}}>
      <input ref={input} id="banner-search" type="text" aria-label="Search movies, shows and channels" placeholder="Titles, people, channels…" value={text} maxLength={120} tabIndex={open?0:-1} aria-hidden={!open} onChange={e=>change(e.target.value)}/>
      {open&&text&&<button className="icon-button nav-search-clear" type="button" aria-label="Clear search" onClick={()=>change('')}><Icon name="close" size={16}/></button>}
      <button ref={toggle} className="icon-button nav-search-toggle" type="button" aria-label="Search (Ctrl K)" aria-expanded={open} aria-controls="banner-search" onClick={()=>{setOpen(true);input.current?.focus();}}><Icon name="search" size={22}/></button>
    </form>
  </div>;
}
