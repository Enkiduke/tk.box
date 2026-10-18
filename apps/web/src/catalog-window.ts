// The viewport and alphabet jump use the same absolute item positions.
export const CATALOG_PAGE_SIZE=60;
export function catalogWindow(count:number,columns:number,rowHeight:number,top:number,viewport:number,overscan=3) {
  const rows=Math.ceil(count/columns),visibleRow=Math.max(0,Math.floor(top/rowHeight));
  const firstRow=Math.max(0,Math.min(rows,visibleRow-overscan));
  const endRow=Math.min(rows,Math.ceil((Math.max(0,top)+viewport)/rowHeight)+overscan);
  return {firstRow,endRow,visibleIndex:Math.min(Math.max(0,count-1),visibleRow*columns),height:rows*rowHeight};
}
export function catalogPages(start:number,end:number,count:number) {
  const pages:number[]=[];
  for(let offset=Math.floor(start/CATALOG_PAGE_SIZE)*CATALOG_PAGE_SIZE;offset<Math.min(end,count);offset+=CATALOG_PAGE_SIZE)pages.push(offset);
  return pages;
}
