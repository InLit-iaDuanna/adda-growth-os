import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export type WhatsAppDeliveryStatus = 'accepted' | 'unknown_delivery' | 'delivered' | 'failed';

export interface WhatsAppAdapterConfig {
  appSecret: string;
  accessToken: string;
  phoneNumberId: string;
  graphVersion: string;
  externalWrites: boolean;
  apiBaseUrl?: string;
}

export interface ApprovedTemplateSend {
  to: string;
  templateName: string;
  languageCode: string;
  components?: unknown[];
}

export interface WhatsAppTransportResponse {
  ok: boolean;
  status: number;
  json: unknown;
}

export type WhatsAppTransport = (url: string, init: RequestInit) => Promise<WhatsAppTransportResponse>;

export interface NormalizedWhatsAppEvent {
  providerEventId: string;
  providerMessageId: string | null;
  status: WhatsAppDeliveryStatus;
  occurredAt: string;
}

/**
 * WhatsApp Cloud API status values are deliberately mapped into the smaller
 * delivery ledger vocabulary used by the application.  Unknown values are
 * retained as an explicit uncertain state instead of being treated as a
 * successful delivery.
 */
function normalizeProviderStatus(value: unknown): WhatsAppDeliveryStatus {
  if (value === 'sent' || value === 'accepted' || value === 'queued') return 'accepted';
  if (value === 'delivered' || value === 'read') return 'delivered';
  if (value === 'failed') return 'failed';
  return 'unknown_delivery';
}

function normalizeOccurredAt(value: unknown): string {
  const unixSeconds = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN;
  if (Number.isFinite(unixSeconds) && unixSeconds >= 0) {
    const date = new Date(unixSeconds * 1000);
    if (Number.isFinite(date.getTime())) return date.toISOString();
  }
  if (typeof value === 'string' && Number.isFinite(Date.parse(value))) return new Date(value).toISOString();
  return new Date().toISOString();
}

function stableProviderEventId(parts: Array<string | null | undefined>): string {
  const canonical = parts.map((part) => part == null ? '' : part).join('|');
  return `wa_${createHash('sha256').update(canonical).digest('hex').slice(0, 48)}`;
}

/**
 * Verify Meta's GET webhook handshake without requiring an application login.
 * The challenge is returned only for the exact subscribe mode and configured
 * verify token; callers should respond with the returned challenge verbatim.
 */
export function verifyWhatsAppWebhookChallenge(input: { mode: string | null; token: string | null; challenge: string | null }, expectedToken: string): string | null {
  if (!expectedToken || input.mode !== 'subscribe' || !input.token || !input.challenge) return null;
  const expected = Buffer.from(expectedToken, 'utf8');
  const provided = Buffer.from(input.token, 'utf8');
  if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) return null;
  return input.challenge;
}

/**
 * Normalize both the real WhatsApp Cloud API envelope and the historical
 * internal test envelope.  One provider callback may contain multiple entries
 * and multiple statuses, so the result is intentionally a list.  Event IDs
 * are deterministic across retries, allowing the repository to de-duplicate
 * callbacks without trusting a caller-supplied tenant identifier.
 */
export function normalizeWhatsAppWebhookEvents(body: unknown): NormalizedWhatsAppEvent[] {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return [];
  const value = body as Record<string, unknown>;
  const events: NormalizedWhatsAppEvent[] = [];
  const entries = Array.isArray(value.entry) ? value.entry : [];

  // Backward-compatible offline envelope used by existing tests and fixtures.
  const internalEventId = typeof value.provider_event_id === 'string' ? value.provider_event_id : entries.length === 0 && typeof value.id === 'string' ? value.id : '';
  if (internalEventId) {
    const providerMessageId = typeof value.provider_message_id === 'string' ? value.provider_message_id : typeof value.message_id === 'string' ? value.message_id : null;
    events.push({
      providerEventId: internalEventId,
      providerMessageId,
      status: normalizeProviderStatus(value.status),
      occurredAt: normalizeOccurredAt(value.occurred_at)
    });
  }

  entries.forEach((entry, entryIndex) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return;
    const entryValue = entry as Record<string, unknown>;
    const entryId = typeof entryValue.id === 'string' ? entryValue.id : `entry_${entryIndex}`;
    const changes = Array.isArray(entryValue.changes) ? entryValue.changes : [];
    changes.forEach((change, changeIndex) => {
      if (!change || typeof change !== 'object' || Array.isArray(change)) return;
      const changeValue = change as Record<string, unknown>;
      const field = typeof changeValue.field === 'string' ? changeValue.field : `change_${changeIndex}`;
      const payload = changeValue.value;
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return;
      const payloadValue = payload as Record<string, unknown>;
      const statuses = Array.isArray(payloadValue.statuses) ? payloadValue.statuses : [];
      statuses.forEach((statusItem, statusIndex) => {
        if (!statusItem || typeof statusItem !== 'object' || Array.isArray(statusItem)) return;
        const statusValue = statusItem as Record<string, unknown>;
        const providerMessageId = typeof statusValue.id === 'string' ? statusValue.id : null;
        const rawStatus = typeof statusValue.status === 'string' ? statusValue.status : '';
        const occurredAt = normalizeOccurredAt(statusValue.timestamp);
        const recipient = typeof statusValue.recipient_id === 'string' ? statusValue.recipient_id : null;
        // A provider message id is the stable identity for a status update;
        // only status records without one need the array position as a
        // deterministic fallback.
        const statusKey = providerMessageId || `status_${statusIndex}`;
        const providerEventId = stableProviderEventId([entryId, field, statusKey, rawStatus, String(statusValue.timestamp ?? ''), recipient]);
        events.push({ providerEventId, providerMessageId, status: normalizeProviderStatus(rawStatus), occurredAt });
      });
    });
  });

  return events;
}

export class WhatsAppAdapter {
  constructor(private readonly config: WhatsAppAdapterConfig, private readonly transport: WhatsAppTransport = defaultTransport) {}

  capabilities(): Record<string, unknown> {
    const configured = Boolean(this.config.appSecret && this.config.accessToken && this.config.phoneNumberId);
    return { provider: 'whatsapp', mode: configured && this.config.externalWrites ? 'live' : 'manual', status: configured ? 'pending_approval' : 'unconfigured', send_template: configured && this.config.externalWrites, reason: configured ? 'template_status_and_tenant_approval_required' : 'server_credentials_required' };
  }

  verifyWebhook(rawBody: Buffer, signature: string): boolean {
    if (!this.config.appSecret || !/^sha256=[a-f0-9]{64}$/i.test(signature)) return false;
    const expected = createHmac('sha256', this.config.appSecret).update(rawBody).digest('hex');
    const provided = Buffer.from(signature.slice(7), 'hex');
    const actual = Buffer.from(expected, 'hex');
    return provided.length === actual.length && timingSafeEqual(provided, actual);
  }

  async sendApprovedTemplate(input: ApprovedTemplateSend): Promise<{ status: 'accepted' | 'blocked' | 'unknown_delivery'; providerReference: string | null; errorCode: string | null }> {
    if (!this.config.externalWrites || !this.config.accessToken || !this.config.phoneNumberId) return { status: 'blocked', providerReference: null, errorCode: 'external_writes_disabled_or_credentials_missing' };
    const url = `${this.config.apiBaseUrl || 'https://graph.facebook.com'}/${this.config.graphVersion}/${encodeURIComponent(this.config.phoneNumberId)}/messages`;
    try {
      const response = await this.transport(url, { method: 'POST', headers: { authorization: `Bearer ${this.config.accessToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to: input.to, type: 'template', template: { name: input.templateName, language: { code: input.languageCode }, components: input.components || [] } }) });
      const body = response.json as any;
      if (!response.ok) return { status: 'blocked', providerReference: null, errorCode: `provider_http_${response.status}` };
      const reference = typeof body?.messages?.[0]?.id === 'string' ? body.messages[0].id : null;
      return reference ? { status: 'accepted', providerReference: reference, errorCode: null } : { status: 'unknown_delivery', providerReference: null, errorCode: 'provider_reference_missing' };
    } catch { return { status: 'unknown_delivery', providerReference: null, errorCode: 'provider_timeout_or_network_error' }; }
  }

  normalizeWebhook(body: unknown): NormalizedWhatsAppEvent | null {
    return normalizeWhatsAppWebhookEvents(body)[0] || null;
  }
}

async function defaultTransport(url: string, init: RequestInit): Promise<WhatsAppTransportResponse> {
  const response = await fetch(url, init);
  let json: unknown = null;
  try { json = await response.json(); } catch { /* provider response is not JSON */ }
  return { ok: response.ok, status: response.status, json };
}
