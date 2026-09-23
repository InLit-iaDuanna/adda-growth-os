export type ContentStatus = 'draft' | 'needs_local_review' | 'pending_approval' | 'approved' | 'rejected' | 'stale' | 'exported';
export type VariantReviewStatus = 'draft' | 'needs_local_review' | 'reviewed' | 'rejected';

export interface ContentPackageData {
  brief_id: string;
  campaign_id: string;
  brand_revision_id: string;
  target_metric: string;
  content_pillar: string;
  channel: string;
  product_refs: string[];
  hook_variants: string[];
  shot_list: Array<{ index: number; duration_seconds: number; visual: string; spoken_line: string; onscreen_text: string; rights_needed: string[] }>;
  operator_notes_zh: string;
  variants: Array<{ locale: 'zh-CN' | 'en' | 'bn'; title: string; caption: string; subtitle_srt: string; cta: string; review_status: VariantReviewStatus; reviewer_id: string | null }>;
  source_link_id: string | null;
  sources: Array<{ source_id: string; revision_id: string; kind: 'brand_fact' | 'metric_snapshot' | 'campaign_revision' | 'feedback' | 'verified_context'; excerpt: string }>;
  needs_input: string[];
  risk_flags: string[];
}

export interface ContentBrief {
  id: string;
  tenantId: string;
  storeId: string;
  campaignId: string;
  targetMetric: string;
  contentPillar: string;
  channel: string;
  productIds: string[];
  assetIds: string[];
  sourceLinkId: string | null;
  createdBy: string;
  createdAt: string;
}

export interface ContentRevision {
  id: string;
  briefId: string;
  tenantId: string;
  revision: number;
  status: ContentStatus;
  packageData: ContentPackageData;
  contentHash: string;
  generationFacts?: ContentFacts;
  currentApprovalId?: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface ContentFacts {
  campaignRevision: number;
  brandRevisionIds: string[];
  productPriceRefs: Array<{ productId: string; priceVersionId: string }>;
  assetIds: string[];
  assetRightsHash: string;
}

export interface ContentApproval {
  id: string;
  tenantId: string;
  resourceType: 'content';
  resourceId: string;
  resourceRevisionId: string;
  payloadHash: string;
  audienceSnapshotId: string | null;
  channel: string;
  language: string;
  budgetMinor: number | null;
  campaignRevision?: number;
  brandRevisionIds?: string[];
  productPriceRefs?: Array<{ productId: string; priceVersionId: string }>;
  assetIds?: string[];
  policyVersion: string;
  factsHash?: string;
  approvedBy: string | null;
  approvedAt: string | null;
  expiresAt: string;
  status: 'pending' | 'approved' | 'revoked' | 'expired' | 'stale';
  createdAt: string;
}

export interface PublicationIntent {
  id: string;
  tenantId: string;
  storeId: string;
  contentRevisionId: string;
  approvalId?: string;
  payloadHash?: string;
  packageData?: ContentPackageData;
  channel: string;
  mode: 'manual' | 'live';
  status: 'manual_ready' | 'submitted' | 'provider_confirmed' | 'operator_attested' | 'failed' | 'unknown';
  createdBy: string;
  createdAt: string;
}

export interface PublicationReceipt {
  id: string;
  intentId: string;
  evidenceType: 'imported_evidence' | 'operator_attested' | 'provider_confirmed';
  externalPostId: string | null;
  evidenceUrl: string | null;
  createdBy: string;
  createdAt: string;
}

export function contentStatusAfterPackage(data: ContentPackageData): ContentStatus {
  return data.variants.some((variant) => variant.locale === 'bn' && variant.review_status === 'needs_local_review') ? 'needs_local_review' : 'draft';
}

export function validateContentPackage(data: unknown): string[] {
  const errors: string[] = [];
  if (!data || typeof data !== 'object') return ['package_not_object'];
  const value = data as Record<string, unknown>;
  for (const key of ['brief_id', 'campaign_id', 'brand_revision_id', 'target_metric', 'content_pillar', 'channel', 'operator_notes_zh']) if (typeof value[key] !== 'string' || !(value[key] as string).trim()) errors.push(`missing_${key}`);
  if (!Array.isArray(value.product_refs)) errors.push('product_refs_not_array');
  if (!Array.isArray(value.hook_variants) || !(value.hook_variants as unknown[]).every((item) => typeof item === 'string' && item.length > 0)) errors.push('hook_variants_invalid');
  if (!Array.isArray(value.shot_list) || !(value.shot_list as unknown[]).length) errors.push('shot_list_invalid');
  if (!Array.isArray(value.variants)) errors.push('variants_not_array');
  else {
    const locales = new Set((value.variants as any[]).map((item) => item?.locale));
    for (const locale of ['zh-CN', 'en', 'bn']) if (!locales.has(locale)) errors.push(`variant_missing_${locale}`);
    for (const variant of value.variants as any[]) if (!variant || typeof variant.title !== 'string' || typeof variant.caption !== 'string' || !['draft', 'needs_local_review', 'reviewed', 'rejected'].includes(variant.review_status)) errors.push('variant_invalid');
  }
  if (!Array.isArray(value.sources) || !(value.sources as any[]).every((source) => source && typeof source.source_id === 'string' && typeof source.revision_id === 'string' && typeof source.excerpt === 'string')) errors.push('sources_invalid');
  if (!Array.isArray(value.needs_input) || !Array.isArray(value.risk_flags)) errors.push('status_arrays_invalid');
  return errors;
}
