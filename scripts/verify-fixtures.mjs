/** Verify this specification's synthetic golden data. Not an application test. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = p => JSON.parse(fs.readFileSync(path.join(root,p), 'utf8'));
const d=read('fixtures/golden_dataset.json');
const expected=read('fixtures/expected_metrics.json');
assert.equal(d.is_synthetic,true);
const ms=x=>{const n=Date.parse(x); assert.ok(Number.isFinite(n),`Invalid timestamp ${x}`); return n;};
const day=86400000;
const cutoff=Math.min(ms(d.as_of),ms(d.orders_complete_through));
function unique(rows,key) {
  const map=new Map();
  for (const row of rows) {
    const k=key(row);
    if(map.has(k)) assert.deepEqual(row,map.get(k),`Conflicting duplicate ${k}`);
    else map.set(k,row);
  }
  return [...map.values()];
}
const scoped=r=>r.tenant_id===d.tenant_id&&r.store_id===d.store_id;
const orders=unique(d.orders.filter(scoped),r=>[r.tenant_id,r.store_id,r.source,r.external_order_id].join('|'));
const refunds=unique(d.adjustments.filter(scoped),r=>[r.tenant_id,r.store_id,r.source,r.external_adjustment_id].join('|'));
const net=o=>{
  const v=o.amount_paid_minor-refunds.filter(r=>r.source===o.source&&r.external_order_id===o.external_order_id&&ms(r.occurred_at)<=cutoff).reduce((a,r)=>a+r.amount_minor,0);
  assert.ok(Number.isSafeInteger(v)&&v>=0,`Illegal net for ${o.external_order_id}`);return v;
};
const q=orders.filter(o=>o.status==='paid'&&ms(o.paid_at)<=cutoff&&net(o)>0);
const revenue=q.reduce((a,o)=>a+net(o),0);
const linked=q.filter(o=>o.member_id);
const memberRevenue=linked.reduce((a,o)=>a+net(o),0);
const first=new Map();
for (const o of [...linked].sort((a,b)=>ms(a.paid_at)-ms(b.paid_at))) if(!first.has(o.member_id)) first.set(o.member_id,o);
const businessDate=timestamp=>new Intl.DateTimeFormat('en-CA',{timeZone:d.timezone,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(timestamp));
const mature30=[...first.entries()].filter(([,o])=>ms(o.paid_at)+30*day<=cutoff);
const repeats=mature30.filter(([id,o])=>q.some(n=>n.member_id===id&&n.external_order_id!==o.external_order_id&&ms(n.paid_at)>ms(o.paid_at)&&ms(n.paid_at)<=ms(o.paid_at)+30*day&&businessDate(n.paid_at)!==businessDate(o.paid_at)));
const mature7=d.members.filter(scoped).filter(m=>ms(m.registered_at)+7*day<=cutoff&&(!first.has(m.id)||ms(first.get(m.id).paid_at)>=ms(m.registered_at)));
const converted=mature7.filter(m=>first.has(m.id)&&ms(first.get(m.id).paid_at)<=ms(m.registered_at)+7*day);
const attribution={CMP_CAMPUS_01:0,CMP_EVENT_01:0,unknown:0};
for (const o of q) {
  const ev=d.attribution_evidence.filter(e=>e.order_id===o.external_order_id&&ms(e.occurred_at)<=ms(o.paid_at));
  const coupon=ev.filter(e=>e.method==='verified_coupon');
  assert.ok(new Set(coupon.map(e=>e.campaign_id)).size<=1,'Conflicting coupon sources require review');
  const touch=ev.filter(e=>e.method==='linked_first_party_touch'&&ms(e.occurred_at)>=ms(o.paid_at)-7*day).sort((a,b)=>ms(b.occurred_at)-ms(a.occurred_at));
  const campaign=(coupon[0]??touch[0])?.campaign_id??'unknown';
  attribution[campaign]=(attribution[campaign]??0)+net(o);
}
const actual={net_revenue_minor:revenue,qualified_order_count:q.length,average_order_value_minor:revenue/q.length,
linked_order_count:linked.length,identity_coverage:linked.length/q.length,member_revenue_minor:memberRevenue,member_revenue_share:memberRevenue/revenue,
mature_30d_cohort_count:mature30.length,repeat_30d_count:repeats.length,repeat_30d_rate:repeats.length/mature30.length,
mature_7d_registration_cohort_count:mature7.length,converted_7d_count:converted.length,conversion_7d_rate:converted.length/mature7.length,
primary_attributed_revenue_minor:attribution};
assert.deepEqual(actual,expected);
assert.equal(Object.values(attribution).reduce((a,b)=>a+b,0),revenue);
const taskIds=read('TASKS.json').goals.map(g=>g.id);
assert.equal(new Set(taskIds).size,taskIds.length);
for(const g of read('TASKS.json').goals){
  assert.ok(fs.existsSync(path.join(root,'goals',g.id+'.md')));
  for(const dep of g.depends_on) assert.ok(taskIds.includes(dep));
}
console.log('PASS: specification fixtures and goal references are internally consistent.');
console.log(JSON.stringify(actual,null,2));
console.log('NOT PROOF of application implementation, live integrations or customer acceptance.');
