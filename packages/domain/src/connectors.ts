export type ConnectorProvider = 'whatsapp';
export type ConnectorStatus = 'unconfigured' | 'sandbox' | 'pending_approval' | 'active' | 'limited' | 'revoked' | 'failed';

export interface ConnectorState {
  id: string;
  tenantId: string;
  provider: ConnectorProvider;
  mode: 'manual' | 'demo' | 'live';
  status: ConnectorStatus;
  enabled: boolean;
  killSwitch: boolean;
  capabilities: { readMetrics: boolean; reply: boolean; sendTemplate: boolean };
  reason: string;
  checkedAt: string;
  updatedAt: string;
}

export type DeliveryStatus = 'pending' | 'accepted' | 'unknown_delivery' | 'delivered' | 'failed' | 'blocked';

export interface DeliveryIntent {
  id: string;
  tenantId: string;
  storeId: string;
  provider: ConnectorProvider;
  memberId: string;
  templateName: string;
  approvalHash: string;
  idempotencyKey: string;
  requestKeys?: string[];
  outreachId?: string;
  costMinor?: number;
  status: DeliveryStatus;
  providerReference: string | null;
  errorCode: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface WebhookEvent {
  id: string;
  tenantId: string | null;
  provider: ConnectorProvider;
  providerEventId: string;
  providerMessageId: string | null;
  status: DeliveryStatus;
  occurredAt: string;
  receivedAt: string;
}

export const DELIVERY_STATUS_ORDER: Record<DeliveryStatus, number> = {
  pending: 0,
  accepted: 1,
  unknown_delivery: 2,
  failed: 2,
  delivered: 3,
  blocked: 4
};

export function canAdvanceDelivery(current: DeliveryStatus, next: DeliveryStatus): boolean {
  if (current === 'unknown_delivery') return next !== 'pending';
  return DELIVERY_STATUS_ORDER[next] >= DELIVERY_STATUS_ORDER[current];
}
