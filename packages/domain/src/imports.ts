import { explicitTimestamp } from './validation';
import { createHash, randomUUID } from 'node:crypto';

export type ImportKind = 'orders' | 'refunds' | 'members';

export interface OrderRecord {
  id: string;
  tenantId: string;
  storeId: string;
  source: string;
  externalOrderId: string;
  memberId: string | null;
  paidAt: string;
  currency: string;
  amountPaidMinor: number;
  status: 'paid' | 'cancelled' | 'void' | 'pending';
  revision: number;
  sourceRowHash: string;
  active: boolean;
  correctionOfId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RefundRecord {
  id: string;
  tenantId: string;
  storeId: string;
  source: string;
  externalAdjustmentId: string;
  externalOrderId: string;
  occurredAt: string;
  amountMinor: number;
  sourceRowHash: string;
  createdAt: string;
}

export interface MemberRecord {
  id: string;
  tenantId: string;
  storeId: string;
  externalMemberId: string;
  displayName: string | null;
  registeredAt: string;
  language: string | null;
  contact: string | null;
  contactHmac: string | null;
  publicAccessTokenHash: string | null;
  isSynthetic: boolean;
  contactVerified: boolean;
  verificationProof: string | null;
  verificationExpiresAt: string | null;
  createdAt: string;
}

export interface AttributionEvidenceRecord {
  id: string;
  tenantId: string;
  storeId: string;
  orderExternalId: string;
  orderSource?: string;
  orderId?: string;
  campaignId: string;
  method: 'verified_coupon' | 'linked_first_party_touch' | 'declared_source';
  occurredAt: string;
}

export interface ImportRowError {
  id: string;
  importId: string;
  rowNumber: number;
  code: string;
  message: string;
  rawRow: Record<string, string>;
}

export interface ImportBatch {
  id: string;
  tenantId: string;
  storeId: string;
  kind: ImportKind;
  source: string;
  fileName: string;
  fileHash: string;
  status: 'preview' | 'committed' | 'rejected';
  rowCount: number;
  validRowCount: number;
  errorCount: number;
  completeThrough: string | null;
  createdBy: string;
  createdAt: string;
  committedAt: string | null;
}

export interface ImportStagedRow {
  id: string;
  importId: string;
  rowNumber: number;
  kind: ImportKind;
  raw: Record<string, string>;
  value: ParsedOrder | ParsedRefund | ParsedMember;
  valid: boolean;
}

export interface SourceWatermark {
  tenantId: string;
  storeId: string;
  source: string;
  completeThrough: string | null;
  updatedAt: string;
  confirmed: boolean;
}

export interface ParsedOrder {
  tenantId: string;
  storeId: string;
  source: string;
  externalOrderId: string;
  memberId: string | null;
  paidAt: string;
  currency: string;
  amountPaidMinor: number;
  status: OrderRecord['status'];
}

export interface ParsedRefund {
  tenantId: string;
  storeId: string;
  source: string;
  externalAdjustmentId: string;
  externalOrderId: string;
  occurredAt: string;
  amountMinor: number;
}

export interface ParsedMember {
  tenantId: string;
  storeId: string;
  externalMemberId: string;
  displayName: string | null;
  registeredAt: string;
  language: string | null;
  contact: string | null;
  isSynthetic: boolean;
}

export interface ParsedCsv<T> {
  headers: string[];
  rows: Array<{ rowNumber: number; raw: Record<string, string>; value?: T; errors: Array<{ code: string; message: string }> }>;
}

export function parseCsv(content: string): { headers: string[]; rows: string[][] } {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < content.length; i += 1) {
    const char = content[i];
    const next = content[i + 1];
    if (quoted) {
      if (char === '"' && next === '"') { field += '"'; i += 1; }
      else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"' && field.length === 0) quoted = true;
    else if (char === ',') { row.push(field); field = ''; }
    else if (char === '\n') { row.push(field.replace(/\r$/, '')); rows.push(row); row = []; field = ''; }
    else field += char;
  }
  if (field.length || row.length) { row.push(field.replace(/\r$/, '')); rows.push(row); }
  const headers = (rows.shift() || []).map((header) => header.trim());
  return { headers, rows: rows.filter((values) => values.some((value) => value.trim() !== '')) };
}

export function parseTypedCsv<T>(content: string, parser: (raw: Record<string, string>, rowNumber: number) => { value?: T; errors: Array<{ code: string; message: string }> }): ParsedCsv<T> {
  const parsed = parseCsv(content);
  const rows = parsed.rows.map((values, index) => {
    const raw: Record<string, string> = {};
    parsed.headers.forEach((header, column) => { raw[header] = (values[column] || '').trim(); });
    const result = parser(raw, index + 2);
    return { rowNumber: index + 2, raw, ...result };
  });
  return { headers: parsed.headers, rows };
}

function required(raw: Record<string, string>, key: string, errors: Array<{ code: string; message: string }>): string {
  const value = raw[key]?.trim() || '';
  if (!value) errors.push({ code: 'required', message: `${key} is required` });
  return value;
}

function isoDate(raw: string, key: string, errors: Array<{ code: string; message: string }>): string {
  if (!raw || !explicitTimestamp(raw)) errors.push({ code: 'invalid_date', message: `${key} must be an ISO timestamp` });
  return raw;
}

function minorAmount(raw: string, key: string, errors: Array<{ code: string; message: string }>): number {
  if (!/^\d+$/.test(raw || '')) { errors.push({ code: 'invalid_amount', message: `${key} must be a non-negative integer minor unit` }); return 0; }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) errors.push({ code: 'invalid_amount', message: `${key} exceeds safe integer range` });
  return value;
}

export function parseOrdersCsv(content: string): ParsedCsv<ParsedOrder> {
  return parseTypedCsv(content, (raw) => {
    const errors: Array<{ code: string; message: string }> = [];
    const tenantId = required(raw, 'tenant_id', errors);
    const storeId = required(raw, 'store_id', errors);
    const source = required(raw, 'source', errors);
    const externalOrderId = required(raw, 'external_order_id', errors);
    const paidAt = isoDate(required(raw, 'paid_at', errors), 'paid_at', errors);
    const currency = required(raw, 'currency', errors);
    const amountPaidMinor = minorAmount(raw.amount_paid_minor, 'amount_paid_minor', errors);
    const status = raw.status as ParsedOrder['status'];
    if (!['paid', 'cancelled', 'void', 'pending'].includes(status)) errors.push({ code: 'invalid_status', message: 'status must be paid/cancelled/void/pending' });
    return { value: errors.length ? undefined : { tenantId, storeId, source, externalOrderId, memberId: raw.member_id || null, paidAt, currency, amountPaidMinor, status } as ParsedOrder, errors };
  });
}

export function parseRefundsCsv(content: string): ParsedCsv<ParsedRefund> {
  return parseTypedCsv(content, (raw) => {
    const errors: Array<{ code: string; message: string }> = [];
    const tenantId = required(raw, 'tenant_id', errors);
    const storeId = required(raw, 'store_id', errors);
    const source = required(raw, 'source', errors);
    const externalAdjustmentId = required(raw, 'external_adjustment_id', errors);
    const externalOrderId = required(raw, 'external_order_id', errors);
    const occurredAt = isoDate(required(raw, 'occurred_at', errors), 'occurred_at', errors);
    const amountMinor = minorAmount(raw.amount_minor, 'amount_minor', errors);
    return { value: errors.length ? undefined : { tenantId, storeId, source, externalAdjustmentId, externalOrderId, occurredAt, amountMinor }, errors };
  });
}

export function parseMembersCsv(content: string): ParsedCsv<ParsedMember> {
  return parseTypedCsv(content, (raw) => {
    const errors: Array<{ code: string; message: string }> = [];
    const tenantId = required(raw, 'tenant_id', errors);
    const storeId = required(raw, 'store_id', errors);
    const externalMemberId = required(raw, 'id', errors);
    const registeredAt = isoDate(required(raw, 'registered_at', errors), 'registered_at', errors);
    return { value: errors.length ? undefined : { tenantId, storeId, externalMemberId, displayName: raw.display_name || null, registeredAt, language: raw.language || null, contact: raw.contact || null, isSynthetic: /^(true|1|yes)$/i.test(raw.is_synthetic || '') }, errors };
  });
}

export function rowHash(raw: Record<string, string>): string {
  return createHash('sha256').update(JSON.stringify(Object.keys(raw).sort().map((key) => [key, raw[key]]))).digest('hex');
}

export function makeImportId(): string { return randomUUID(); }
