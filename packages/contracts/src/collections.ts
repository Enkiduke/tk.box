// Whether the movies a custom collection downloads stay off Recently added: as set (`hide_recent`), or else when the
// collection is seasonal or kept up to date from a list.
export function hidesFromRecent(definition:{schedule?:unknown;source?:unknown;hide_recent?:unknown}) {
  if(typeof definition.hide_recent==='boolean')return definition.hide_recent;
  const source=definition.source;
  return !!definition.schedule||(typeof source==='object'&&source!==null&&(source as {refresh?:unknown}).refresh!==false);
}
