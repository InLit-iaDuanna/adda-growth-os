import { createHash } from 'node:crypto';
import type { DatabaseState } from './types';
import type { ContentApproval, ContentBrief, ContentFacts, ContentPackageData, ContentRevision } from './content';
import { validatePublishWindow, type PublishCheckInput, type PublishCheckResult } from './brand';
import { activeDuring, explicitTimestamp, nullableTimestamp, validTimeRange } from './validation';

export const contentDigest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sorted = (values: string[]) => [...new Set(values)].sort();
const sameIds = (a: string[], b: string[]) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));

function assetRightsHash(state: DatabaseState, ids: string[]): string {
  return contentDigest(sorted(ids).map(id => {
    const asset = state.mediaAssets.find(a => a.id === id);
    return asset ? { id, checksum: asset.checksum, rightsStatus: asset.rightsStatus, allowedUses: sorted(asset.allowedUses), expiresAt: asset.expiresAt } : { id, missing: true };
  }));
}

/** Capture from the exact state supplied to the generator, never from submission time. */
export function captureContentFacts(state: DatabaseState, brief: ContentBrief, data: ContentPackageData): ContentFacts {
  return {
    campaignRevision: state.campaigns.find(c => c.id === brief.campaignId)?.revision || 0,
    brandRevisionIds: sorted([data.brand_revision_id, ...data.sources.map(s => s.revision_id)]),
    productPriceRefs: sorted(brief.productIds).map(productId => ({ productId, priceVersionId: state.products.find(p => p.id === productId)?.currentPriceVersionId || '' })),
    assetIds: sorted(brief.assetIds),
    assetRightsHash: assetRightsHash(state, brief.assetIds)
  };
}

export function checkPublish(state: DatabaseState, input: PublishCheckInput, now: string): PublishCheckResult {
  const result = validatePublishWindow(new Date(now), input.startAt, input.endAt);
  const fail = (code: string, resourceId: string, detail: string) => result.errors.push({ code, resourceId, detail });
  for (const id of input.productIds || []) {
    const product = state.products.find(p => p.id === id && p.tenantId === input.tenantId && p.storeId === input.storeId);
    if (!product) { fail('product_not_found', id, '产品不属于当前门店'); continue; }
    if (product.status !== 'active') fail('product_inactive', id, '产品已停用');
    const price = state.priceVersions.find(p => p.id === product.currentPriceVersionId && p.productId === id && p.tenantId === input.tenantId);
    if (!price || price.amountMinor === null || price.status !== 'approved') fail('price_missing_or_unapproved', id, '缺少已批准价格');
    else if (!validTimeRange(price.validFrom, price.validTo, true)) fail('price_validity_invalid', id, '价格有效期无法确认');
    else if (!activeDuring(now, price.validFrom, price.validTo)) fail('price_outside_validity', id, '价格不在有效期内');
  }
  for (const id of input.assetIds || []) {
    const asset = state.mediaAssets.find(a => a.id === id && a.tenantId === input.tenantId && (!a.storeId || a.storeId === input.storeId));
    if (!asset) { fail('asset_not_found', id, '素材不属于当前门店'); continue; }
    if (asset.rightsStatus !== 'approved') fail('asset_rights_missing', id, '素材授权未批准');
    if (!nullableTimestamp(asset.expiresAt)) fail('asset_expiry_invalid', id, '素材到期时间无法确认');
    else if (!activeDuring(now, null, asset.expiresAt)) fail('asset_rights_expired', id, '素材授权已过期');
  }
  return { ...result, ok: result.errors.length === 0 };
}

export function checkContentFacts(state: DatabaseState, revision: ContentRevision, now: string): PublishCheckResult['errors'] {
  const errors: PublishCheckResult['errors'] = [];
  const fail = (code: string, detail: string, resourceId?: string) => errors.push({ code, detail, resourceId });
  const brief = state.contentBriefs.find(b => b.id === revision.briefId && b.tenantId === revision.tenantId);
  const campaign = brief && state.campaigns.find(c => c.id === brief.campaignId && c.tenantId === revision.tenantId && c.storeId === brief.storeId);
  if (!brief || !campaign) return [{ code: 'approval_scope_mismatch', detail: '内容、简报或活动范围已改变' }];
  const facts = revision.generationFacts;
  if (!facts) return [{ code: 'generation_facts_missing', detail: '旧内容缺少生成事实版本，请重新生成' }];
  const data = revision.packageData;
  if (data.brief_id !== brief.id || data.campaign_id !== campaign.id || data.channel !== brief.channel || data.source_link_id !== brief.sourceLinkId) fail('content_binding_changed', '内容引用的简报、活动、渠道或来源链接已改变');
  if (!sameIds(brief.productIds, data.product_refs) || !sameIds(brief.productIds, facts.productPriceRefs.map(p => p.productId))) fail('product_binding_changed', '产品清单已改变，请重新生成');
  if (campaign.revision !== facts.campaignRevision) fail('campaign_revision_changed', '活动已改变，请重新生成');
  if (!sameIds(brief.assetIds, facts.assetIds) || assetRightsHash(state, brief.assetIds) !== facts.assetRightsHash) fail('asset_binding_changed', '素材或授权已改变，请重新生成');
  for (const ref of facts.productPriceRefs) {
    const product = state.products.find(p => p.id === ref.productId && p.tenantId === revision.tenantId && p.storeId === brief.storeId);
    if (!product || !ref.priceVersionId || product.currentPriceVersionId !== ref.priceVersionId) fail('price_version_changed', '生成时的价格已改变，请重新生成', ref.productId);
  }
  if (!sameIds(facts.brandRevisionIds, [data.brand_revision_id, ...data.sources.map(s => s.revision_id)])) fail('invalid_source_reference', '内容出处与生成事实不一致');
  for (const id of facts.brandRevisionIds) {
    const brand = state.brandRevisions.find(b => b.id === id && b.tenantId === revision.tenantId);
    const doc = brand && state.brandDocuments.find(d => d.id === brand.documentId && d.tenantId === revision.tenantId);
    if (!brand || !doc || brand.status !== 'approved' || (doc.storeId && doc.storeId !== brief.storeId) || !activeDuring(now, brand.effectiveFrom, brand.effectiveTo)) fail('brand_revision_changed', '品牌版本已失效或不属于当前门店', id);
  }
  if (data.needs_input.length) fail('content_needs_input', '内容仍有未解决输入');
  if (data.variants.some(v => v.locale === 'bn' && v.review_status !== 'reviewed')) fail('bn_review_required', '孟语版本需要人工复核');
  errors.push(...checkPublish(state, { tenantId: revision.tenantId, storeId: brief.storeId, productIds: brief.productIds, assetIds: brief.assetIds, startAt: campaign.startAt, endAt: campaign.endAt }, now).errors);
  return errors;
}

export function checkContentApproval(state: DatabaseState, approval: ContentApproval | undefined, now: string): { ok: boolean; errors: PublishCheckResult['errors'] } {
  const errors: PublishCheckResult['errors'] = [];
  const fail = (code: string, detail: string) => errors.push({ code, detail });
  if (!approval) return { ok: false, errors: [{ code: 'approval_not_found', detail: '审批不存在' }] };
  if (!['pending', 'approved'].includes(approval.status)) fail('approval_not_active', '审批不可执行');
  if (!explicitTimestamp(now) || !explicitTimestamp(approval.expiresAt) || Date.parse(approval.expiresAt) <= Date.parse(now)) fail('approval_expired', '审批已过期');
  const revision = state.contentRevisions.find(r => r.id === approval.resourceRevisionId && r.tenantId === approval.tenantId);
  if (!revision) fail('approval_scope_mismatch', '审批内容不存在');
  else {
    if (approval.payloadHash !== revision.contentHash || contentDigest(revision.packageData) !== revision.contentHash) fail('stale_approval', '内容已改变');
    if (!revision.generationFacts || approval.factsHash !== contentDigest(revision.generationFacts)) fail('approval_binding_missing', '审批缺少生成事实绑定');
    const brief = state.contentBriefs.find(b => b.id === revision.briefId);
    if (brief?.channel !== approval.channel) fail('approval_scope_mismatch', '审批渠道已改变');
    errors.push(...checkContentFacts(state, revision, now));
  }
  return { ok: errors.length === 0, errors };
}
