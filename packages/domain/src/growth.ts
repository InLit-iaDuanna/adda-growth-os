export interface SourceLink {
  id: string;
  tenantId: string;
  storeId: string;
  campaignId: string;
  label: string;
  channel: string;
  variant: string | null;
  tokenHash: string;
  createdBy: string;
  createdAt: string;
  status: 'active' | 'disabled';
}

export interface TouchEvent {
  id: string;
  tenantId: string;
  storeId: string;
  sourceLinkId: string;
  eventType: 'view' | 'click' | 'member_register' | 'coupon_issue';
  sessionTokenHash: string;
  occurredAt: string;
}

export interface ConsentEvent {
  id: string;
  tenantId: string;
  memberId: string;
  channel: 'email' | 'sms' | 'whatsapp' | 'unknown';
  purpose: 'marketing' | 'service' | 'event';
  granted: boolean;
  noticeVersion: string;
  source: string;
  occurredAt: string;
}

export interface SuppressionEntry {
  id: string;
  tenantId: string;
  memberId: string;
  channel: ConsentEvent['channel'];
  purpose: ConsentEvent['purpose'];
  reason: string;
  occurredAt: string;
}

export interface Offer {
  id: string;
  tenantId: string;
  storeId: string;
  campaignId: string;
  name: string;
  terms: string;
  validFrom: string;
  validTo: string;
  status: 'active' | 'cancelled' | 'expired';
  maxRedemptions: number | null;
  issuedCount: number;
  createdBy: string;
  createdAt: string;
}

export type CouponStatus = 'issued' | 'reserved' | 'pending_pos_verification' | 'redeemed' | 'expired' | 'cancelled' | 'reversed';

export interface IssuedCoupon {
  id: string;
  tenantId: string;
  storeId: string;
  offerId: string;
  campaignId: string;
  memberId: string;
  sourceLinkId: string | null;
  tokenHash: string;
  status: CouponStatus;
  issuedAt: string;
  reservedAt: string | null;
  posOrderRef: string | null;
  posOrderSource?: string;
  posOrderId?: string;
  redeemedAt: string | null;
  reversedAt: string | null;
}

export interface RedemptionAttempt {
  id: string;
  tenantId: string;
  storeId: string;
  couponId: string;
  employeeUserId: string;
  posOrderRef: string | null;
  posOrderSource?: string;
  posOrderId?: string;
  status: 'reserved' | 'rejected' | 'matched' | 'unknown';
  errorCode: string | null;
  createdAt: string;
}
