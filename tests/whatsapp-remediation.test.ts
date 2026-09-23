import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { normalizeWhatsAppWebhookEvents, verifyWhatsAppWebhookChallenge } from '../packages/adapters/src/whatsapp';
import { startTestApp, TestClient } from '../packages/testing/src/http';

const nestedStatusPayload = {
  object: 'whatsapp_business_account',
  entry: [{
    id: 'waba-1',
    changes: [{
      field: 'messages',
      value: {
        messaging_product: 'whatsapp',
        metadata: { phone_number_id: 'phone-1' },
        statuses: [
          { id: 'wamid.1', status: 'sent', timestamp: '1710000000', recipient_id: '8801700000000' },
          { id: 'wamid.1', status: 'delivered', timestamp: '1710000005', recipient_id: '8801700000000' }
        ]
      }
    }]
  }]
};

test('R05: real WhatsApp nested status envelopes normalize as a stable batch', () => {
  const first = normalizeWhatsAppWebhookEvents(nestedStatusPayload);
  const second = normalizeWhatsAppWebhookEvents(JSON.parse(JSON.stringify(nestedStatusPayload)));
  assert.equal(first.length, 2);
  assert.deepEqual(first.map((item) => item.providerEventId), second.map((item) => item.providerEventId));
  assert.deepEqual(first.map((item) => item.providerMessageId), ['wamid.1', 'wamid.1']);
  assert.deepEqual(first.map((item) => item.status), ['accepted', 'delivered']);
  assert.equal(first[0].occurredAt, '2024-03-09T16:00:00.000Z');
  assert.equal(first[1].occurredAt, '2024-03-09T16:00:05.000Z');
});

test('R05: unknown provider status remains unknown_delivery and does not look successful', () => {
  const events = normalizeWhatsAppWebhookEvents({
    object: 'whatsapp_business_account',
    entry: [{ id: 'waba-1', changes: [{ value: { statuses: [{ id: 'wamid.unknown', status: 'future_status', timestamp: '1710000000' }] } }] }]
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].status, 'unknown_delivery');
});

test('R06: verify-token challenge is independent from operator authentication', async () => {
  assert.equal(verifyWhatsAppWebhookChallenge({ mode: 'subscribe', token: 'verify-me', challenge: 'challenge-123' }, 'verify-me'), 'challenge-123');
  assert.equal(verifyWhatsAppWebhookChallenge({ mode: 'subscribe', token: 'wrong', challenge: 'challenge-123' }, 'verify-me'), null);

  const app = await startTestApp({ seedDemo: true });
  try {
    app.config.whatsappVerifyToken = 'verify-me';
    const client = new TestClient(app.baseUrl);
    const verified = await client.request('/api/connectors/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=challenge-123');
    assert.equal(verified.response.status, 200);
    assert.equal(verified.body, 'challenge-123');
    const rejected = await client.request('/api/connectors/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=challenge-123');
    assert.equal(rejected.response.status, 403);
    assert.equal(rejected.body.error_code, 'webhook_verification_failed');
  } finally {
    await app.close();
  }
});

test('R05: POST accepts signed nested payloads and records each status without external send', async () => {
  const app = await startTestApp({ seedDemo: true });
  try {
    app.config.whatsappAppSecret = 'whatsapp-test-secret';
    const raw = JSON.stringify(nestedStatusPayload);
    const signature = 'sha256=' + createHmac('sha256', app.config.whatsappAppSecret).update(raw).digest('hex');
    const client = new TestClient(app.baseUrl);
    const response = await client.request('/api/connectors/whatsapp/webhook', { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature }, body: raw });
    assert.equal(response.response.status, 202);
    assert.equal(response.body.accepted, true);
    assert.equal(response.body.events.length, 2);
    assert.deepEqual(response.body.events.map((item: { status: string }) => item.status), ['accepted', 'delivered']);
    assert.equal(app.repository.snapshot().webhookEvents.length, 2);
    assert.equal(app.repository.snapshot().deliveryIntents.length, 0);
  } finally {
    await app.close();
  }
});

