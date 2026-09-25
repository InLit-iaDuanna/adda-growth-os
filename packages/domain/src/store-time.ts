/** Convert a datetime-local input in a store's IANA timezone, never in the
 * operator browser's timezone. Ambiguous/nonexistent DST times fail closed.
 * This function is deliberately self-contained for the browser renderer. */
export function storeLocalToIso(value: string, timezone: string): string | null {
  if (!value) return null;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(value)) throw new Error('store_local_datetime_invalid');
  const normalized=value.length===16?value+':00':value;
  const target=Date.parse(normalized+'Z');
  if(!Number.isFinite(target) || new Date(target).toISOString().slice(0,19)!==normalized)throw new Error('store_local_datetime_invalid');
  const formatter=new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
  const local=(instant:number):string=>{
    const p=Object.fromEntries(formatter.formatToParts(instant).map(x=>[x.type,x.value]));
    return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`;
  };
  const offsets=new Set<number>();
  for(const hours of [-36,-12,0,12,36]){
    const instant=target+hours*3600000;
    offsets.add(Date.parse(local(instant)+'Z')-instant);
  }
  const matches=[...offsets].map(offset=>target-offset).filter(instant=>local(instant)===normalized);
  if(matches.length!==1) throw new Error(matches.length?'store_local_datetime_ambiguous':'store_local_datetime_nonexistent');
  return new Date(matches[0]).toISOString();
}

/** Self-contained inverse used for editing local inputs without timezone drift. */
export function isoToStoreLocal(iso: string, timezone: string): string {
  if(!iso)return '';
  const parts=new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(iso));
  const p=Object.fromEntries(parts.map(x=>[x.type,x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}
