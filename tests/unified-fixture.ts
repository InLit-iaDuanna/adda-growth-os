import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { startTestApp, TestClient } from '../packages/testing/src/http';
import { processControlRunsOnce } from '../packages/adapters/src/control-worker';

export const post = (client:TestClient, path:string, data:unknown={}) => client.request(path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data)});
export const patch = (client:TestClient, path:string, data:unknown={}) => client.request(path,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify(data)});

/** Only synthetic records, in a new isolated temporary database. */
export async function unifiedFixture(options: Parameters<typeof startTestApp>[0] = {}) {
  const app=await startTestApp({seedDemo:true,...options}); const owner=new TestClient(app.baseUrl);
  assert.equal((await owner.login('owner@demo.adda.local')).response.status,200);
  const brand=await post(owner,'/api/brand/documents',{source_type:'form',store_id:'sto_demo_01',source_label:'QA SYNTHETIC brand facts',content:JSON.stringify({brand_name:'ADDA DEMO',parent_brand:'SUIWU 随物'})});
  assert.equal((await post(owner,`/api/brand/revisions/${brand.body.revision.id}/approve`)).response.status,200);
  const product=await post(owner,'/api/products',{store_id:'sto_demo_01',external_sku:'QA-SYNTHETIC-001',names:{en:'Synthetic test product'}});
  assert.equal((await post(owner,`/api/products/${product.body.item.id}/prices`,{amount_minor:10000,status:'approved',source_citation:'SYNTHETIC test amount, not customer menu'})).response.status,201);
  const asset=await post(owner,'/api/media-assets',{store_id:'sto_demo_01',storage_key:'synthetic/test-asset.jpg',checksum:'synthetic-qa-only',rights_status:'approved',allowed_uses:['organic_social']});
  const campaign=await post(owner,'/api/campaigns',{store_id:'sto_demo_01',name:'QA 合成活动 · 非真实经营',objective:'qualified orders',budget_minor:10000,product_ids:[product.body.item.id],asset_ids:[asset.body.item.id]});
  const campaignId=campaign.body.item.id;
  assert.equal((await patch(owner,`/api/campaigns/${campaignId}`,{status:'approved'})).response.status,200);
  const content=await post(owner,'/api/content/generate',{campaign_id:campaignId,channel:'manual',content_pillar:'Synthetic test',target_metric:'qualified_order_count'});
  assert.equal(content.response.status,201); const revisionId=content.body.revision.id;
  const link=await post(owner,`/api/campaigns/${campaignId}/source-links`,{label:'QA synthetic campaign',channel:'manual'});
  const offer=await post(owner,'/api/offers',{campaign_id:campaignId,name:'QA test coupon',terms:'SYNTHETIC ONLY — no real entitlement',valid_to:new Date(Date.now()+86400000).toISOString(),max_redemptions:20});
  const feedback=await post(owner,'/api/feedback',{store_id:'sto_demo_01',source:'synthetic QA input',text:'Synthetic test: please review the queue.'});
  assert.equal(feedback.response.status,201);
  const result={app,owner,campaignId,revisionId,sourceToken:link.body.token,sourceUrl:link.body.url,offerId:offer.body.item.id};
  return {...result,close:async()=>{await app.close();await fs.rm(app.dataDir,{recursive:true,force:true});}};
}

if(require.main===module){
  void unifiedFixture().then(f=>{
    console.log(JSON.stringify({baseUrl:f.app.baseUrl,sourceUrl:f.sourceUrl,revisionId:f.revisionId,campaignId:f.campaignId,offerId:f.offerId,sourceToken:f.sourceToken,dataFile:f.app.config.dataFile}));
    let busy=false;
    const timer=setInterval(()=>{if(busy)return;busy=true;void processControlRunsOnce(f.app.repository).catch(()=>undefined).finally(()=>{busy=false;});},300);
    const stop=async()=>{clearInterval(timer);await f.close();process.exit(0);};process.once('SIGTERM',()=>void stop());process.once('SIGINT',()=>void stop());
  }).catch(error=>{console.error(error);process.exitCode=1;});
}
