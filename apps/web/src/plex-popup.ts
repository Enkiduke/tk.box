// Opens synchronously in the click so popup blockers allow it; the caller points it at Plex once the auth URL arrives.
export function openPlexPopup(url='') {
  const width=520,height=720,left=Math.round(window.screenX+(window.outerWidth-width)/2),top=Math.round(window.screenY+(window.outerHeight-height)/2);
  const popup=window.open(url,'tkbox-plex-auth',`popup,width=${width},height=${height},left=${left},top=${top}`);
  if(popup)popup.opener=null;
  return popup;
}
