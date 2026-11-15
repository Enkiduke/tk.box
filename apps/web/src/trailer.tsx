import {useState} from 'react';
import type {TitleTrailer} from '../../../packages/contracts/src/index.js';
import {Icon,Modal} from './components.js';

// A title's trailer from TMDB, played from YouTube's privacy-enhanced player over the dialog.
// tk.box sends no referrer; YouTube's player needs one, so the frame sends just this site's origin.
export function TrailerButton({trailer,title,className='secondary large'}:{trailer?:TitleTrailer;title:string;className?:string}) {
  const [open,setOpen]=useState(false);
  if(!trailer)return null;
  const src=`https://www.youtube-nocookie.com/embed/${encodeURIComponent(trailer.key)}?autoplay=1&rel=0&playsinline=1`;
  return <>
    <button type="button" className={className} onClick={()=>setOpen(true)}><Icon name="film"/>Trailer</button>
    {open&&<Modal title={`${title} trailer`} onClose={()=>setOpen(false)}>
      <div className="trailer-frame">
        <iframe src={src} title={trailer.name??`${title} trailer`} allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
          allowFullScreen referrerPolicy="strict-origin-when-cross-origin"/>
      </div>
    </Modal>}
  </>;
}
