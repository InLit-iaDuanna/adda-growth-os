import { nullableTimestamp, validTimeRange } from './validation';

export type KnowledgeStatus = 'draft' | 'approved' | 'rejected' | 'expired' | 'conflict';
export type SourceType = 'form' | 'markdown' | 'txt' | 'csv';

export interface BrandDocument {
  id: string;
  tenantId: string;
  storeId: string | null;
  sourceType: SourceType;
  sourceLabel: string;
  sourceUri: string | null;
  checksum: string;
  createdBy: string;
  createdAt: string;
}

export interface BrandRevision {
  id: string;
  documentId: string;
  tenantId: string;
  version: number;
  status: KnowledgeStatus;
  content: string;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  supersedesId: string | null;
  conflictKeys: string[];
  createdAt: string;
}

export interface BrandFact {
  id: string;
  tenantId: string;
  revisionId: string;
  key: string;
  value: string | null;
  valueType: 'text' | 'date' | 'money' | 'url' | 'boolean';
  sourceCitation: string;
  status: KnowledgeStatus;
  effectiveFrom: string | null;
  effectiveTo: string | null;
}

export interface Product {
  id: string;
  tenantId: string;
  storeId: string;
  externalSku: string;
  names: Record<string, string>;
  status: 'active' | 'inactive';
  needsInput: string[];
  currentPriceVersionId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PriceVersion {
  id: string;
  tenantId: string;
  productId: string;
  version: number;
  currency: string;
  amountMinor: number | null;
  validFrom: string;
  validTo: string | null;
  status: KnowledgeStatus;
  sourceCitation: string;
  createdBy: string;
  createdAt: string;
}

export interface MediaAsset {
  id: string;
  tenantId: string;
  storeId: string | null;
  storageKey: string;
  checksum: string;
  mimeType: string;
  rightsStatus: 'unknown' | 'approved' | 'expired' | 'rejected';
  allowedUses: string[];
  expiresAt: string | null;
  sourceCitation: string | null;
  createdBy: string;
  createdAt: string;
}

export interface BrandReference {
  id: string;
  tenantId: string;
  storeId: string;
  resourceType: 'campaign' | 'content' | 'publication';
  resourceId: string;
  productPriceRefs: Array<{ productId: string; priceVersionId: string }>;
  brandRevisionIds: string[];
  status: 'valid' | 'stale';
  createdAt: string;
  invalidatedAt: string | null;
  invalidationReason: string | null;
}

export interface PublishCheckInput {
  tenantId: string;
  storeId: string;
  productIds?: string[];
  assetIds?: string[];
  startAt?: string | null;
  endAt?: string | null;
}

export interface PublishCheckResult {
  ok: boolean;
  errors: Array<{ code: string; resourceId?: string; detail: string }>;
  warnings: Array<{ code: string; detail: string }>;
}

export function validatePublishWindow(now: Date, startAt?: string | null, endAt?: string | null): PublishCheckResult {
  const errors: PublishCheckResult['errors'] = [];
  const warnings: PublishCheckResult['warnings'] = [];
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) errors.push({ code: 'invalid_now', detail: 'current time is invalid' });
  if (!nullableTimestamp(startAt ?? null)) errors.push({ code: 'invalid_start_at', detail: 'startAt requires a timestamp with timezone, or null' });
  if (!nullableTimestamp(endAt ?? null)) errors.push({ code: 'invalid_end_at', detail: 'endAt requires a timestamp with timezone, or null' });
  if (!validTimeRange(startAt ?? null, endAt ?? null)) errors.push({ code: 'invalid_window', detail: 'dates must be valid and endAt must follow startAt' });
  if (endAt && Date.parse(endAt) <= nowMs) errors.push({ code: 'campaign_expired', detail: 'campaign end is in the past' });
  if (!startAt) warnings.push({ code: 'start_date_missing', detail: '具体开始时间尚未提供' });
  return { ok: errors.length === 0, errors, warnings };
}
