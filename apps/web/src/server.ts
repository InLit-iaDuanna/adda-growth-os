import http, { type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { URL } from 'node:url';
import { readConfig, validateConfig, connectorSnapshot, type AppConfig } from '../../../packages/adapters/src/config';
import { normalizeWhatsAppWebhookEvents, verifyWhatsAppWebhookChallenge } from '../../../packages/adapters/src/whatsapp';
import {
  actorFromSession,
  hasBrandPermission,
  hasPermission,
  parseCookies,
  safeActor,
  signCookie,
  verifyCookie
} from '../../../packages/domain/src/auth';
import type { ActorContext, Campaign } from '../../../packages/domain/src/types';
import type { BrandDocument, BrandRevision, SourceType } from '../../../packages/domain/src/brand';
import type { SourceLink } from '../../../packages/domain/src/growth';
import type { ContentPackageData } from '../../../packages/domain/src/content';
import type { OutreachCampaign, SegmentRule } from '../../../packages/domain/src/crm';
import { captureContentFacts } from '../../../packages/domain/src/content-policy';
import { generateDeterministicContent } from '../../../packages/domain/src/content-provider';
import { JsonRepository, verifyPassword, nowIso } from '../../../packages/db/src/repository';
import { parseMembersCsv, parseOrdersCsv, parseRefundsCsv, type ImportKind } from '../../../packages/domain/src/imports';
import { calculateMetrics } from '../../../packages/domain/src/metric-service';
import type { RouterRequest } from '../../../packages/domain/src/control';
import { runDeterministicRouter } from '../../../packages/domain/src/control-runtime';
import { queryMetrics, runControl } from '../../../packages/domain/src/control-service';
import { ATTRIBUTION_MODEL } from '../../../packages/domain/src/attribution-policy';
import { DomainError, timestampInput, requireTimeRange } from '../../../packages/domain/src/validation';
import { renderAdminPage, renderConsumerPage } from './ui';

const MAX_BODY_BYTES = 256 * 1024;
const PUBLIC_ROOT = resolve(process.cwd(), 'apps/web/public/assets');
const PUBLIC_TYPES: Record<string, string> = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.json': 'application/json; charset=utf-8' };

function sessionCookie(config: AppConfig, value: string, maxAge: number): string {
  // Production requires HTTPS; local modes support HTTP.
  const secure = config.mode === 'production' ? '; Secure' : '';
  return `adda_session=${encodeURIComponent(value)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

interface AppServerOptions {
  config?: AppConfig;
  repository?: JsonRepository;
}

interface RequestContext {
  requestId: string;
  actor: ActorContext;
  sessionId: string;
  csrfToken: string;
}

export interface AppServer {
  server: Server;
  repository: JsonRepository;
  config: AppConfig;
}

export async function createAppServer(options: AppServerOptions = {}): Promise<AppServer> {
  const config = options.config || readConfig();
  const configErrors = validateConfig(config);
  if (configErrors.length) throw new Error(`invalid_configuration:${configErrors.join(',')}`);
  const repository = options.repository || new JsonRepository(config.dataFile, config.mode);
  await repository.ensure();
  await repository.migrate();

  const server = http.createServer(async (req, res) => {
    const requestId = randomUUID();
    res.setHeader('x-request-id', requestId);
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'same-origin');
    try {
      await route(req, res, requestId, repository, config);
    } catch (error) {
      if (error instanceof DomainError) { sendJson(res, error.status, { error_code: error.code, retryable: false, request_id: requestId }); return; }
      if (error instanceof SyntaxError || (error instanceof Error && ['invalid_json_body','request_body_too_large'].includes(error.message))) { sendJson(res, error instanceof SyntaxError ? 400 : error.message === 'request_body_too_large' ? 413 : 400, { error_code: 'invalid_request_body', retryable: false }); return; }
      const message = error instanceof Error ? error.message : 'internal_error';
      console.error(JSON.stringify({ request_id: requestId, error: message.startsWith('invalid_') ? message : 'internal_error' }));
      sendJson(res, 500, { error_code: 'internal_error', message: '服务暂时不可用 / Service unavailable', retryable: true, request_id: requestId });
    }
  });
  return { server, repository, config };
}

async function route(
  req: IncomingMessage,
  res: ServerResponse,
  requestId: string,
  repository: JsonRepository,
  config: AppConfig
): Promise<void> {
  const method = (req.method || 'GET').toUpperCase();
  const parsed = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const pathname = parsed.pathname;

  if (method === 'OPTIONS') {
    res.writeHead(204, { 'access-control-allow-origin': 'same-origin', 'access-control-allow-headers': 'content-type,x-csrf-token' });
    res.end();
    return;
  }

  const assetMatch = pathname.match(/^\/assets\/(.+)$/);
  if (method === 'GET' && assetMatch) {
    const relative = decodeURIComponent(assetMatch[1]);
    if (relative.includes('\0') || relative.split('/').some((part) => part === '..')) { res.writeHead(400); res.end('invalid_asset_path'); return; }
    const filePath = resolve(PUBLIC_ROOT, relative);
    if (!filePath.startsWith(`${PUBLIC_ROOT}/`)) { res.writeHead(400); res.end('invalid_asset_path'); return; }
    try {
      const body = await readFile(filePath);
      res.writeHead(200, { 'content-type': PUBLIC_TYPES[extname(filePath).toLowerCase()] || 'application/octet-stream', 'cache-control': 'public, max-age=3600', 'x-content-type-options': 'nosniff' });
      res.end(body);
    } catch { res.writeHead(404); res.end('asset_not_found'); }
    return;
  }

  // Reload changes written by another web process or worker.
  await repository.load();

  if (pathname === '/api/healthz' && method === 'GET') {
    const state = repository.snapshot();
    const hasBusinessData = state.campaigns.length > 0;
    sendJson(res, 200, {
      ok: true,
      service: 'adda-web',
      mode: config.mode,
      demo: config.mode === 'demo' || state.tenants.some((tenant) => tenant.mode === 'demo'),
      database_adapter: config.databaseAdapter,
      schema_version: state.schemaVersion,
      has_business_data: hasBusinessData,
      worker_heartbeat_at: state.workerHeartbeatAt,
      connectors: connectorSnapshot(config),
      missing_configuration: config.mode === 'production' && state.tenants.length === 0 ? ['brand_profile', 'store', 'menu', 'owner_invitation'] : []
    });
    return;
  }

  if (pathname === '/api/readyz' && method === 'GET') {
    const state = repository.snapshot();
    const ready = state.schemaVersion >= 1;
    sendJson(res, ready ? 200 : 503, { ok: ready, database: ready ? 'ready' : 'migrating', request_id: requestId });
    return;
  }

  if (pathname === '/' && method === 'GET') {
    sendHtml(res, 200, renderAdminPage());
    return;
  }

  const consumerMatch = pathname.match(/^\/s\/([^/]+)\/c\/([^/]+)$/);
  if (consumerMatch && method === 'GET') {
    const store = repository.snapshot().stores.find((item) => item.slug === decodeURIComponent(consumerMatch[1]));
    const token = decodeURIComponent(consumerMatch[2]);
    const link = repository.findSourceLinkByTokenHash(hashToken(token, config.sessionSecret));
    if (!store || !link || link.storeId !== store.id) { notFound(res, requestId); return; }
    await repository.addTouchEvent({ tenantId: link.tenantId, storeId: link.storeId, sourceLinkId: link.id, eventType: 'view', sessionTokenHash: hashToken(`${token}:${req.headers['user-agent'] || ''}`, config.sessionSecret) });
    sendHtml(res, 200, renderConsumerPage(store.slug, link.label, token));
    return;
  }
  const consumerJoinMatch = pathname.match(/^\/s\/([^/]+)(?:\/join)?$/);
  if (consumerJoinMatch && method === 'GET') {
    sendHtml(res, 200, renderConsumerPage(decodeURIComponent(consumerJoinMatch[1])));
    return;
  }

  // Public URLs carry opaque tokens, not contact details.
  if (pathname === '/api/members/register' && method === 'POST') {
    const body = await readJson(req);
    const sourceToken = typeof body.source_token === 'string' ? body.source_token : '';
    const link = repository.findSourceLinkByTokenHash(hashToken(sourceToken, config.sessionSecret));
    if (!link) { notFound(res, requestId); return; }
    const contact = typeof body.contact === 'string' ? body.contact.trim() : '';
    if (!contact || contact.length > 320) { badRequest(res, requestId, 'contact_required'); return; }
    const store = repository.findStoreById(link.storeId);
    const contactHash = hmacContact(contact, config.sessionSecret);
    const existingMember = repository.snapshot().members.find((item) => item.tenantId === link.tenantId && item.storeId === link.storeId && item.contactHmac === contactHash);
    if (existingMember) { sendJson(res, 409, { error_code: 'member_already_registered', message: '该联系方式已登记，请使用已有会员链接', retryable: false, request_id: requestId }); return; }
    const memberAccessToken = randomBytes(32).toString('base64url');
    const member = await repository.createMember({ tenantId: link.tenantId, storeId: link.storeId, externalMemberId: `public_${randomUUID()}`, displayName: typeof body.display_name === 'string' ? body.display_name.slice(0, 120) : null, registeredAt: nowIso(), language: body.language === 'bn' ? 'bn' : 'en', contact: null, contactHmac: contactHash, publicAccessTokenHash: hashToken(memberAccessToken, config.sessionSecret), isSynthetic: config.mode !== 'production' });
    await repository.addTouchEvent({ tenantId: link.tenantId, storeId: link.storeId, sourceLinkId: link.id, eventType: 'member_register', sessionTokenHash: hashToken(`${sourceToken}:${member.id}`, config.sessionSecret) });
    if (body.marketing_opt_in === true && ['email', 'sms', 'whatsapp'].includes(body.channel)) await repository.addConsent({ tenantId: link.tenantId, memberId: member.id, channel: body.channel, purpose: 'marketing', granted: true, noticeVersion: typeof body.notice_version === 'string' ? body.notice_version : 'unspecified', source: 'public_registration' });
    sendJson(res, 201, { member: { id: member.id, language: member.language, contact_verified: member.contactVerified, marketing_opt_in: repository.consentGranted(member.tenantId, member.id, 'marketing') }, member_token: memberAccessToken, source_link_id: link.id, store: store ? { slug: store.slug } : null });
    return;
  }

  if (pathname === '/api/members/verify' && method === 'POST') {
    const body = await readJson(req);
    const memberId = typeof body.member_id === 'string' ? body.member_id : '';
    const state = repository.snapshot();
    const member = state.members.find((item) => item.id === memberId && item.publicAccessTokenHash && typeof body.member_token === 'string' && item.publicAccessTokenHash === hashToken(body.member_token, config.sessionSecret));
    if (!member) { notFound(res, requestId); return; }
    if (config.mode === 'production' && !config.allowTestOutbox) {
      sendJson(res, 409, { error_code: 'verification_external_blocked', message: '生产没有验证渠道，不能伪造 verified 状态', retryable: false, request_id: requestId });
      return;
    }
    if (body.code !== '000000' && body.code !== 'demo-code') { sendJson(res, 400, { error_code: 'verification_code_invalid', message: '验证码不正确', retryable: false, request_id: requestId }); return; }
    const verified = await repository.verifyMemberContact(member.tenantId, member.id, 'test_outbox', new Date(Date.now() + 10 * 60 * 1000).toISOString());
    sendJson(res, 200, { member_id: member.id, contact_verified: Boolean(verified?.contactVerified), verification_mode: 'test_only' });
    return;
  }

  if (pathname === '/api/consents/revoke' && method === 'POST') {
    const body = await readJson(req);
    const memberId = typeof body.member_id === 'string' ? body.member_id : '';
    const state = repository.snapshot();
    const member = state.members.find((item) => item.id === memberId && item.publicAccessTokenHash && typeof body.member_token === 'string' && item.publicAccessTokenHash === hashToken(body.member_token, config.sessionSecret));
    if (!member) { notFound(res, requestId); return; }
    const channel = ['email', 'sms', 'whatsapp'].includes(body.channel) ? body.channel : 'unknown';
    const event = await repository.addConsent({ tenantId: member.tenantId, memberId: member.id, channel, purpose: 'marketing', granted: false, noticeVersion: typeof body.notice_version === 'string' ? body.notice_version : 'unspecified', source: 'public_revoke' });
    sendJson(res, 200, { revoked: true, consent_event_id: event.id });
    return;
  }

  if (pathname === '/api/public/coupons/issue' && method === 'POST') {
    const body = await readJson(req);
    const sourceToken = typeof body.source_token === 'string' ? body.source_token : '';
    const link = repository.findSourceLinkByTokenHash(hashToken(sourceToken, config.sessionSecret));
    if (!link) { notFound(res, requestId); return; }
    const memberId = typeof body.member_id === 'string' ? body.member_id : '';
    const offerId = typeof body.offer_id === 'string' ? body.offer_id : '';
    const memberToken = typeof body.member_token === 'string' ? body.member_token : '';
    const member = repository.snapshot().members.find((item) => item.id === memberId && item.tenantId === link.tenantId && item.storeId === link.storeId && item.publicAccessTokenHash === hashToken(memberToken, config.sessionSecret));
    if (!member) { notFound(res, requestId); return; }
    try {
      const couponToken = randomBytes(32).toString('base64url');
      const coupon = await repository.issueCoupon({ tenantId: link.tenantId, storeId: link.storeId, offerId, memberId, sourceLinkId: link.id, tokenHash: hashToken(couponToken, config.sessionSecret) });
      await repository.addTouchEvent({ tenantId: link.tenantId, storeId: link.storeId, sourceLinkId: link.id, eventType: 'coupon_issue', sessionTokenHash: hashToken(`${sourceToken}:${memberId}`, config.sessionSecret) });
      sendJson(res, 201, { coupon: { id: coupon.id, token: couponToken, status: coupon.status, expires_at: repository.findOffer(coupon.offerId)?.validTo || null } });
    } catch (error) {
      const code = error instanceof Error ? error.message : 'offer_unavailable';
      sendJson(res, 409, { error_code: code, message: '优惠券当前不可发放 / Offer unavailable', retryable: false, request_id: requestId });
    }
    return;
  }

  if (pathname === '/api/public/offers' && method === 'GET') {
    const sourceToken = parsed.searchParams.get('source_token') || '';
    const link = repository.findSourceLinkByTokenHash(hashToken(sourceToken, config.sessionSecret));
    if (!link) { notFound(res, requestId); return; }
    const now = nowIso();
    const campaign = repository.findCampaign(link.campaignId);
    const items = campaign?.objective?.trim() && campaign.needsInput.length === 0 ? repository.listOffers(link.tenantId, [link.storeId]).filter(offer => offer.campaignId === link.campaignId && offer.status === 'active' && Date.parse(offer.validFrom) <= Date.parse(now) && Date.parse(now) < Date.parse(offer.validTo)) : [];
    sendJson(res, 200, { items: items.map(offer => ({ id: offer.id, name: offer.name, terms: offer.terms, valid_to: offer.validTo })) });
    return;
  }

  if (pathname === '/api/auth/login' && method === 'POST') {
    const body = await readJson(req);
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    const user = repository.findUserByEmail(email);
    if (!user || user.status !== 'active' || !verifyPassword(password, user.passwordHash)) {
      sendJson(res, 401, { error_code: 'invalid_credentials', message: '邮箱或密码不正确 / Invalid credentials', retryable: false, request_id: requestId });
      return;
    }
    const membership = repository.snapshot().memberships.find((item) => item.userId === user.id && !item.revokedAt);
    if (!membership) {
      sendJson(res, 403, { error_code: 'membership_required', message: '账号尚未加入任何租户', retryable: false, request_id: requestId });
      return;
    }
    const csrfToken = randomBytes(24).toString('base64url');
    const session = await repository.createSession({
      userId: user.id,
      tenantId: membership.tenantId,
      csrfToken,
      expiresAt: new Date(Date.now() + config.sessionTtlSeconds * 1000).toISOString(),
      revokedAt: null
    });
    const cookie = signCookie(session.id, config.sessionSecret);
    res.setHeader('set-cookie', sessionCookie(config, cookie, config.sessionTtlSeconds));
    const actor = actorFromSession(session, membership.role, membership.storeIds);
    sendJson(res, 200, { ok: true, user: { id: user.id, display_name: user.displayName, email: user.email }, actor: safeActor(actor), csrf_token: csrfToken });
    return;
  }

  if (pathname === '/api/auth/logout' && method === 'POST') {
    const context = await authenticate(req, repository, config);
    if (context) {
      if (!checkCsrf(req, context)) {
        sendJson(res, 403, { error_code: 'csrf_failed', message: '请求校验失败 / CSRF check failed', retryable: false, request_id: requestId });
        return;
      }
      await repository.revokeSession(context.sessionId);
    }
    res.setHeader('set-cookie', sessionCookie(config, '', 0));
    sendJson(res, 200, { ok: true });
    return;
  }

  // Provider verification uses a token, independent of operator login.
  if (pathname === '/api/connectors/whatsapp/webhook' && method === 'GET') {
    const challenge = verifyWhatsAppWebhookChallenge({ mode: parsed.searchParams.get('hub.mode'), token: parsed.searchParams.get('hub.verify_token'), challenge: parsed.searchParams.get('hub.challenge') }, config.whatsappVerifyToken || '');
    if (challenge === null) {
      sendJson(res, 403, { error_code: config.whatsappVerifyToken ? 'webhook_verification_failed' : 'webhook_verification_not_configured', message: 'Webhook verification failed', retryable: false, request_id: requestId });
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    res.end(challenge);
    return;
  }

  // Provider callbacks require a signature, not an operator session.
  if (pathname === '/api/connectors/whatsapp/webhook' && method === 'POST') {
    const raw = await readRawBody(req);
    const signature = String(req.headers['x-hub-signature-256'] || '');
    if (!config.whatsappAppSecret || !verifyWebhookSignature(raw, signature, config.whatsappAppSecret)) {
      sendJson(res, 401, { error_code: 'webhook_signature_invalid', message: 'Webhook signature rejected', retryable: false, request_id: requestId });
      return;
    }
    let body: Record<string, any>;
    try { const parsed = JSON.parse(raw.toString('utf8')); if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid_json_body'); body = parsed as Record<string, any>; }
    catch { badRequest(res, requestId, 'invalid_json_body'); return; }
    const events = normalizeWhatsAppWebhookEvents(body);
    if (!events.length) { badRequest(res, requestId, 'provider_statuses_required'); return; }
    try {
      const processedEvents = [];
      for (const event of events) {
        const matchingIntent = event.providerMessageId ? repository.snapshot().deliveryIntents.find((item) => item.provider === 'whatsapp' && (item.id === event.providerMessageId || item.providerReference === event.providerMessageId)) : undefined;
        // Tenant scope comes from the persisted intent; the provider payload is
        // not allowed to select a tenant.
        processedEvents.push(await repository.processWebhook({ provider: 'whatsapp', tenantId: matchingIntent?.tenantId || null, providerEventId: event.providerEventId, providerMessageId: event.providerMessageId, status: event.status, occurredAt: event.occurredAt }));
      }
      const first = processedEvents[0];
      const duplicate = processedEvents.every((item) => item.duplicate);
      sendJson(res, duplicate ? 200 : 202, { accepted: true, duplicate, events: processedEvents.map((item) => ({ duplicate: item.duplicate, status: item.intent?.status || item.event.status, provider_event_id: item.event.providerEventId })), status: first.intent?.status || first.event.status, provider_event_id: first.event.providerEventId });
    } catch (error) { sendJson(res, 409, { error_code: error instanceof Error ? error.message : 'webhook_rejected', message: 'Webhook could not be applied', retryable: false, request_id: requestId }); }
    return;
  }

  if (pathname === '/api/me' && method === 'GET') {
    const context = await authenticate(req, repository, config);
    if (!context) {
      sendJson(res, 401, { error_code: 'unauthenticated', message: '请先登录 / Sign in first', retryable: false, request_id: requestId });
      return;
    }
    const user = repository.findUserById(context.actor.userId)!;
    sendJson(res, 200, {
      user: { id: user.id, display_name: user.displayName, email: user.email },
      actor: safeActor(context.actor),
      role: context.actor.role,
      tenant_id: context.actor.tenantId,
      store_ids: context.actor.storeIds,
      csrf_token: context.csrfToken
    });
    return;
  }

  const context = await authenticate(req, repository, config);
  if (!context) {
    sendJson(res, 401, { error_code: 'unauthenticated', message: '请先登录 / Sign in first', retryable: false, request_id: requestId });
    return;
  }

  // ----- Customer voice and human case loop (G07) -----
  if (pathname === '/api/feedback' && method === 'POST') {
    if (!hasPermission(context.actor, 'campaign:create')) return forbidden(res, requestId, 'feedback_write_forbidden');
    if (!checkCsrf(req, context)) return csrfFailure(res, requestId);
    const body = await readJson(req);
    const storeId = typeof body.store_id === 'string' ? body.store_id : context.actor.storeIds.length === 1 ? context.actor.storeIds[0] : '';
    if (!storeId || !context.actor.storeIds.includes(storeId) || typeof body.text !== 'string' || !body.text.trim() || typeof body.source !== 'string' || !body.source.trim()) return badRequest(res, requestId, 'feedback_fields_required');
    try {
      const result = await repository.createFeedback({ tenantId: context.actor.tenantId, storeId, source: body.source, sourceRef: typeof body.source_ref === 'string' ? body.source_ref : null, externalId: typeof body.external_id === 'string' ? body.external_id : null, text: body.text, receivedAt: typeof body.received_at === 'string' ? body.received_at : undefined, memberId: typeof body.member_id === 'string' ? body.member_id : null, customerRef: typeof body.customer_ref === 'string' ? hmacContact(body.customer_ref, config.sessionSecret) : null, tags: Array.isArray(body.tags) ? body.tags.filter((tag: unknown): tag is string => typeof tag === 'string') : [], createdBy: context.actor.userId });
      sendJson(res, result.deduplicated ? 200 : 201, { item: publicFeedback(result.feedback), case: result.supportCase ? publicSupportCase(result.supportCase) : null, deduplicated: result.deduplicated });
    } catch (error) { badRequest(res, requestId, error instanceof Error ? error.message : 'feedback_invalid'); }
    return;
  }
  if (pathname === '/api/feedback' && method === 'GET') {
    if (!hasPermission(context.actor, 'report:read')) return forbidden(res, requestId, 'feedback_read_forbidden');
    sendJson(res, 200, { items: repository.listFeedback(context.actor.tenantId, context.actor.storeIds).map(publicFeedback) });
    return;
  }
  const feedbackDetailMatch = pathname.match(/^\/api\/feedback\/([^/]+)$/);
  if (feedbackDetailMatch && method === 'GET') {
    if (!hasPermission(context.actor, 'report:read')) return forbidden(res, requestId, 'feedback_read_forbidden');
    const item = repository.findFeedback(decodeURIComponent(feedbackDetailMatch[1]));
    if (!item || item.tenantId !== context.actor.tenantId || !context.actor.storeIds.includes(item.storeId)) return notFound(res, requestId);
    const state = repository.snapshot();
    const supportCase = state.supportCases.find(c => c.feedbackId === item.id);
    const canReadOriginal = hasPermission(context.actor, 'campaign:create');
    if (canReadOriginal) await repository.audit({ tenantId: item.tenantId, storeId: item.storeId, actorUserId: context.actor.userId, action: 'feedback.original_read', resourceType: 'feedback', resourceId: item.id, metadata: {}, });
    sendJson(res, 200, { item: publicFeedback(item), original_text: canReadOriginal ? item.originalText : null, classifications: state.feedbackClassifications.filter(c => c.feedbackId === item.id), case: supportCase ? publicSupportCase(supportCase) : null, replies: supportCase ? repository.listReplyRevisions(supportCase.id, item.tenantId).map(reply => canReadOriginal ? publicReplyRevision(reply) : { ...publicReplyRevision(reply), body: null }) : [] }); return;
  }
  const voiceTaskMatch = pathname.match(/^\/api\/voice-tasks\/([^/]+)\/complete$/);
  if (voiceTaskMatch && method === 'POST') {
    if (!hasPermission(context.actor, 'campaign:create')) return forbidden(res, requestId, 'task_write_forbidden');
    if (!checkCsrf(req, context)) return csrfFailure(res, requestId);
    const task = repository.listVoiceTasks(context.actor.tenantId, context.actor.storeIds).find(t => t.id === voiceTaskMatch[1]);
    if (!task) return notFound(res, requestId);
    const body = await readJson(req);
    const updated = await repository.completeVoiceTask(task.id, context.actor.tenantId, context.actor.userId, typeof body.evidence === 'string' ? body.evidence : '');
    sendJson(res, 200, { task: publicVoiceTask(updated), evidence_type: 'operator_attested', provider_delivered: false }); return;
  }
  const feedbackClassificationMatch = pathname.match(/^\/api\/feedback\/([^/]+)\/classification$/);
  if (feedbackClassificationMatch && (method === 'POST' || method === 'PATCH')) {
    if (!hasPermission(context.actor, 'campaign:approve')) return forbidden(res, requestId, 'feedback_classification_forbidden');
    if (!checkCsrf(req, context)) return csrfFailure(res, requestId);
    const feedback = repository.findFeedback(decodeURIComponent(feedbackClassificationMatch[1]));
    if (!feedback || feedback.tenantId !== context.actor.tenantId || !context.actor.storeIds.includes(feedback.storeId)) return notFound(res, requestId);
    const body = await readJson(req);
    const updated = await repository.correctFeedback({ feedbackId: feedback.id, tenantId: context.actor.tenantId, tags: Array.isArray(body.tags) ? body.tags.filter((tag: unknown): tag is string => typeof tag === 'string') : [], evidence: Array.isArray(body.evidence) ? body.evidence.filter((item: unknown): item is string => typeof item === 'string') : [], actorUserId: context.actor.userId });
    sendJson(res, 200, { item: publicFeedback(updated), audit: 'classification_correction_recorded' });
    return;
  }
  if (pathname === '/api/support-cases' && method === 'GET') {
    if (!hasPermission(context.actor, 'report:read')) return forbidden(res, requestId, 'case_read_forbidden');
    sendJson(res, 200, { items: repository.listSupportCases(context.actor.tenantId, context.actor.storeIds).map(publicSupportCase), tasks: repository.listVoiceTasks(context.actor.tenantId, context.actor.storeIds).map(publicVoiceTask) });
    return;
  }
  const supportCaseMatch = pathname.match(/^\/api\/support-cases\/([^/]+)$/);
  if (supportCaseMatch && method === 'PATCH') {
    if (!hasPermission(context.actor, 'campaign:create')) return forbidden(res, requestId, 'case_write_forbidden');
    if (!checkCsrf(req, context)) return csrfFailure(res, requestId);
    const item = repository.findSupportCase(decodeURIComponent(supportCaseMatch[1]));
    if (!item || item.tenantId !== context.actor.tenantId || !context.actor.storeIds.includes(item.storeId)) return notFound(res, requestId);
    const body = await readJson(req);
    if (['closed', 'resolved'].includes(body.status) && (typeof body.evidence !== 'string' || !body.evidence.trim())) return badRequest(res, requestId, 'resolution_evidence_required');
    try { const updated = await repository.updateSupportCase({ caseId: item.id, tenantId: context.actor.tenantId, status: ['open', 'in_progress', 'resolved', 'closed'].includes(body.status) ? body.status : undefined, ownerUserId: body.owner_user_id === null || typeof body.owner_user_id === 'string' ? body.owner_user_id : undefined, evidence: typeof body.evidence === 'string' ? body.evidence : undefined, actorUserId: context.actor.userId }); sendJson(res, 200, { item: publicSupportCase(updated) }); }
    catch (error) { sendJson(res, 409, { error_code: error instanceof Error ? error.message : 'case_update_failed', retryable: false }); }
    return;
  }
  const caseRepliesMatch = pathname.match(/^\/api\/support-cases\/([^/]+)\/replies$/);
  if (caseRepliesMatch && method === 'POST') {
    if (!hasPermission(context.actor, 'campaign:create')) return forbidden(res, requestId, 'reply_write_forbidden');
    if (!checkCsrf(req, context)) return csrfFailure(res, requestId);
    const item = repository.findSupportCase(decodeURIComponent(caseRepliesMatch[1]));
    if (!item || item.tenantId !== context.actor.tenantId || !context.actor.storeIds.includes(item.storeId)) return notFound(res, requestId);
    const body = await readJson(req);
    if (typeof body.body !== 'string' || !body.body.trim()) return badRequest(res, requestId, 'reply_body_required');
    const channel = ['manual', 'email', 'sms', 'whatsapp'].includes(body.channel) ? body.channel : 'manual';
    const revision = await repository.createReplyRevision({ caseId: item.id, tenantId: context.actor.tenantId, channel, body: body.body, createdBy: context.actor.userId });
    sendJson(res, 201, { item: publicReplyRevision(revision), approval_required: true, delivery_mode: channel === 'manual' ? 'manual_task' : 'connector_checked' });
    return;
  }
  const replyActionMatch = pathname.match(/^\/api\/reply-revisions\/([^/]+)\/(submit|approve|execute)$/);
  if (replyActionMatch && method === 'POST') {
    if (!checkCsrf(req, context)) return csrfFailure(res, requestId);
    const id = decodeURIComponent(replyActionMatch[1]);
    const revision = repository.snapshot().replyRevisions.find((entry) => entry.id === id);
    const supportCase = revision ? repository.findSupportCase(revision.caseId) : undefined;
    if (!revision || !supportCase || revision.tenantId !== context.actor.tenantId || !context.actor.storeIds.includes(supportCase.storeId)) return notFound(res, requestId);
    try {
      if (replyActionMatch[2] === 'submit') { if (!hasPermission(context.actor, 'campaign:create')) return forbidden(res, requestId, 'reply_submit_forbidden'); const updated = await repository.submitReplyRevision(id, context.actor.tenantId); sendJson(res, 200, { item: publicReplyRevision(updated) }); return; }
      if (replyActionMatch[2] === 'approve') { if (!hasBrandPermission(context.actor, 'brand:approve')) return forbidden(res, requestId, 'reply_approval_forbidden'); const updated = await repository.approveReplyRevision(id, context.actor.tenantId, context.actor.userId); sendJson(res, 200, { item: publicReplyRevision(updated) }); return; }
      if (!hasPermission(context.actor, 'campaign:create')) return forbidden(res, requestId, 'reply_execute_forbidden');
      const result = await repository.executeReplyRevision(id, context.actor.tenantId, context.actor.userId); sendJson(res, 200, { item: publicReplyRevision(result.revision), task: publicVoiceTask(result.task), delivered: false, delivery_mode: 'manual_task' });
    } catch (error) { sendJson(res, 409, { error_code: error instanceof Error ? error.message : 'reply_action_failed', retryable: false }); }
    return;
  }
  if (pathname === '/api/reports/customer-voice/daily' && method === 'GET') {
    if (!hasPermission(context.actor, 'report:read')) return forbidden(res, requestId, 'report_read_forbidden');
    sendJson(res, 200, { report: repository.voiceDailyReport({ tenantId: context.actor.tenantId, storeIds: context.actor.storeIds, asOf: parsed.searchParams.get('as_of') || undefined }) });
    return;
  }

  // ----- Growth control router and daily report (G08) -----
  if (pathname === '/api/control/route' && method === 'POST') {
    if (!hasPermission(context.actor, 'report:read')) return forbidden(res, requestId, 'control_read_forbidden');
    if (!checkCsrf(req, context)) return csrfFailure(res, requestId);
    const body = await readJson(req);
    const input = { skill: body.skill, prompt: typeof body.prompt === 'string' ? body.prompt : '', metricQueries: Array.isArray(body.metric_queries) ? body.metric_queries : [], allowedTools: Array.isArray(body.allowed_tools) ? body.allowed_tools : [], budgetMinor: body.budget_minor, maxSteps: body.max_steps, maxRetries: body.max_retries, deadlineSeconds: body.deadline_seconds } as RouterRequest;
    try { const result = runControl(repository.snapshot(), context.actor, input, nowIso()); sendJson(res, 200, { result, model: { mode: 'deterministic_offline', external_call: false } }); }
    catch (error) { const code = error instanceof DomainError ? error.code : error instanceof Error ? error.message : 'router_contract_invalid'; sendJson(res, 400, { error_code: code, errors: [code], retryable: false }); }
    return;
  }
  if (pathname === '/api/reports/daily' && method === 'POST') {
    if (!hasPermission(context.actor, 'report:read')) return forbidden(res, requestId, 'report_write_forbidden');
    if (!checkCsrf(req, context)) return csrfFailure(res, requestId);
    const body = await readJson(req);
    const asOf = typeof body.as_of === 'string' && Number.isFinite(Date.parse(body.as_of)) ? body.as_of : nowIso();
    const storeId = typeof body.store_id === 'string' ? body.store_id : null;
    if (storeId && !context.actor.storeIds.includes(storeId)) return notFound(res, requestId);
    const reportStoreIds = storeId ? [storeId] : context.actor.storeIds;
    const metrics = queryMetrics(repository.snapshot(), { ...context.actor, storeIds: reportStoreIds }, [{ metricKey: 'qualified_order_count' }, { metricKey: 'net_revenue_minor' }, { metricKey: 'identity_coverage' }], asOf);
    const routerInput: RouterRequest = { skill: 'growth_analyst', prompt: '生成日报', metricQueries: metrics.map((metric) => ({ metricKey: metric.metricKey })), allowedTools: ['metric_query'], budgetMinor: 0, maxSteps: 6, maxRetries: 2, deadlineSeconds: 180 };
    const result = runDeterministicRouter(routerInput, metrics, context.actor.userId, asOf);
    const taskInputs = result.proposedActions.slice(0, 3);
    const tasks = [];
    for (const task of taskInputs) tasks.push(await repository.createControlTask({ tenantId: context.actor.tenantId, storeIds: storeId ? [storeId] : context.actor.storeIds, ownerUserId: task.ownerUserId, title: task.title, dueAt: task.dueAt, targetMetric: metrics[0]?.metricKey || 'qualified_order_count', budgetMinor: task.budgetMinor, guardrails: task.guardrails, evidenceRefs: task.evidenceRefs }));
    const report = await repository.createDailyReport({ tenantId: context.actor.tenantId, storeId, storeIds: storeId ? [storeId] : context.actor.storeIds, metrics, dataHash: createHash('sha256').update(JSON.stringify(metrics)).digest('hex'), asOf, completeThrough: metrics.map((metric) => metric.completeThrough).filter(Boolean).sort()[0] || null, status: metrics.every(metric => metric.quality === 'missing') ? 'missing' : metrics.every(metric => metric.quality === 'verified') ? 'verified' : 'provisional', observations: result.observations.map((item) => ({ text: item.text, metricRefs: item.sourceRefs })), hypotheses: result.hypotheses, advice: result.proposedActions.map((item) => ({ text: item.title, guardrails: item.guardrails, evidenceRefs: item.evidenceRefs })), taskIds: tasks.map((task) => task.id), sourceRefs: metrics.flatMap((metric) => metric.sourceRefs), createdBy: context.actor.userId });
    sendJson(res, 201, { report: publicDailyReport(report), tasks: tasks.map(publicControlTask), limits: result.limits });
    return;
  }
  if (pathname === '/api/reports/daily' && method === 'GET') {
    if (!hasPermission(context.actor, 'report:read')) return forbidden(res, requestId, 'report_read_forbidden');
    const storeId = parsed.searchParams.get('store_id'); if (storeId && !context.actor.storeIds.includes(storeId)) return notFound(res, requestId);
    sendJson(res, 200, { items: repository.listDailyReports(context.actor.tenantId, storeId ? [storeId] : context.actor.storeIds, storeId).map(publicDailyReport), tasks: repository.listControlTasks(context.actor.tenantId, storeId ? [storeId] : context.actor.storeIds).slice(0, 3).map(publicControlTask) });
    return;
  }
  const controlTaskMatch = pathname.match(/^\/api\/control-tasks\/([^/]+)\/complete$/);
  if (controlTaskMatch && method === 'POST') {
    if (!hasPermission(context.actor, 'report:read')) return forbidden(res, requestId, 'control_task_forbidden');
    if (!checkCsrf(req, context)) return csrfFailure(res, requestId);
    const body = await readJson(req);
    try { const task = await repository.completeControlTask(decodeURIComponent(controlTaskMatch[1]), context.actor.tenantId, context.actor.userId, typeof body.evidence === 'string' ? body.evidence : ''); sendJson(res, 200, { task: publicControlTask(task) }); } catch (error) { sendJson(res, 409, { error_code: error instanceof Error ? error.message : 'control_task_failed', retryable: false }); }
    return;
  }

  // ----- WhatsApp capability state and outbound ledger (G09) -----
  if (pathname === '/api/connectors' && method === 'GET') {
    if (!hasPermission(context.actor, 'integration:manage') && !hasPermission(context.actor, 'report:read')) return forbidden(res, requestId, 'connector_read_forbidden');
    const items = repository.listConnectorStates(context.actor.tenantId);
    sendJson(res, 200, { items: items.length ? items : [{ provider: 'whatsapp', mode: 'manual', status: 'unconfigured', enabled: false, reason: 'credentials_and_approved_template_required' }] });
    return;
  }
  if (pathname === '/api/connectors/kill-switch' && method === 'POST') {
    if (!hasPermission(context.actor, 'platform:manage')) return forbidden(res, requestId, 'platform_control_forbidden');
    if (!checkCsrf(req, context)) return csrfFailure(res, requestId);
    const body = await readJson(req); await repository.setGlobalKillSwitch(body.enabled !== false); sendJson(res, 200, { enabled: repository.snapshot().externalWritesKillSwitch }); return;
  }
  if (pathname === '/api/connectors/whatsapp/state' && method === 'POST') {
    if (!hasPermission(context.actor, 'integration:manage')) return forbidden(res, requestId, 'connector_manage_forbidden');
    if (!checkCsrf(req, context)) return csrfFailure(res, requestId);
    const body = await readJson(req); const status = ['unconfigured', 'sandbox', 'pending_approval', 'active', 'limited', 'revoked', 'failed'].includes(body.status) ? body.status : 'unconfigured'; const mode = ['manual', 'demo', 'live'].includes(body.mode) ? body.mode : 'manual';
    if (status === 'active' && !config.whatsappAppSecret) { sendJson(res, 409, { error_code: 'connector_credentials_missing', message: '不能在没有服务端 webhook secret 的情况下激活连接器', retryable: false }); return; }
    if (status === 'active' && mode === 'live' && config.mode === 'production' && (!config.whatsappAccessToken || !config.whatsappPhoneNumberId)) { sendJson(res, 409, { error_code: 'connector_credentials_missing', message: '生产 live 模式还需要访问令牌和发送号码 ID', retryable: false }); return; }
    if (status === 'active' && mode === 'live' && config.mode === 'production' && config.externalWritesEnabled !== true) { sendJson(res, 409, { error_code: 'external_writes_disabled', message: '生产外发总开关未开启', retryable: false }); return; }
    if (status === 'active' && body.send_template !== true) { sendJson(res, 409, { error_code: 'template_capability_required', message: '需要已核准模板能力', retryable: false }); return; }
    const item = await repository.setConnectorState({ tenantId: context.actor.tenantId, provider: 'whatsapp', mode, status, enabled: body.enabled === true && status === 'active', killSwitch: body.kill_switch === true, capabilities: { readMetrics: body.read_metrics === true, reply: body.reply === true, sendTemplate: body.send_template === true }, reason: typeof body.reason === 'string' ? body.reason.slice(0, 240) : status === 'active' ? 'configured' : 'credentials_or_approval_missing', checkedAt: nowIso() });
    sendJson(res, 200, { item }); return;
  }
  if (pathname === '/api/connectors/whatsapp/intents' && method === 'POST') {
    if (!hasPermission(context.actor, 'outreach:dispatch')) return forbidden(res, requestId, 'connector_dispatch_forbidden');
    if (!checkCsrf(req, context)) return csrfFailure(res, requestId);
    const body = await readJson(req); const storeId = typeof body.store_id === 'string' ? body.store_id : ''; const memberId = typeof body.member_id === 'string' ? body.member_id : ''; const idempotencyKey = typeof body.idempotency_key === 'string' ? body.idempotency_key : '';
    if (!storeId || !memberId || !idempotencyKey || !context.actor.storeIds.includes(storeId)) return badRequest(res, requestId, 'delivery_intent_fields_required');
    const member = repository.snapshot().members.find((item) => item.id === memberId && item.tenantId === context.actor.tenantId && item.storeId === storeId);
    if (!member) return notFound(res, requestId);
    const approvalHash = typeof body.approval_hash === 'string' ? body.approval_hash : '';
    const templateName = typeof body.template_name === 'string' ? body.template_name : '';
    const intent = await repository.createDeliveryIntent({ tenantId: context.actor.tenantId, storeId, provider: 'whatsapp', memberId, templateName, approvalHash, idempotencyKey, createdBy: context.actor.userId });
    sendJson(res, intent.status === 'pending' ? 202 : intent.status === 'delivered' ? 200 : 409, { intent, external_write: false, execution_ready: false, budget_reserved: ['pending', 'accepted', 'unknown_delivery'].includes(intent.status), retry_allowed: intent.status === 'blocked' && !intent.providerReference, retry_requires_new_key: intent.status === 'blocked', delivery_mode: intent.status === 'pending' ? 'reserved_offline' : intent.status === 'blocked' ? 'external_blocked' : 'reconciliation_required' }); return;
  }
  const intentTimeoutMatch = pathname.match(/^\/api\/connectors\/whatsapp\/intents\/([^/]+)\/timeout$/);
  if (intentTimeoutMatch && method === 'POST') {
    if (!hasPermission(context.actor, 'integration:manage')) return forbidden(res, requestId, 'connector_manage_forbidden'); if (!checkCsrf(req, context)) return csrfFailure(res, requestId);
    const intentId = decodeURIComponent(intentTimeoutMatch[1]);
    const intent = repository.findDeliveryIntent(intentId, context.actor.tenantId);
    if (!intent || !context.actor.storeIds.includes(intent.storeId)) return notFound(res, requestId);
    try { const item = await repository.markDeliveryUnknown(intentId, context.actor.tenantId); sendJson(res, 200, { intent: item, retry_allowed: false, reconciliation_required: true }); } catch (error) { sendJson(res, 404, { error_code: error instanceof Error ? error.message : 'delivery_not_found', retryable: false }); } return;
  }

  // ----- Rule-based CRM segmentation, approvals and controlled outreach (G06) -----
  if (pathname === '/api/segments/preview' && method === 'POST') {
    if (!hasPermission(context.actor, 'outreach:read') && !hasPermission(context.actor, 'outreach:create')) return forbidden(res, requestId, 'segment_read_forbidden');
    if (!checkCsrf(req, context)) return csrfFailure(res, requestId);
    const body = await readJson(req);
    const rule = (body.rule || body.segment_rule || body.segment) as SegmentRule;
    if (!['registered_unpurchased', 'first_purchase_no_second', 'inactive_14d', 'event_participant', 'marketing_opt_in'].includes(rule)) return badRequest(res, requestId, 'invalid_segment_rule');
    const requestedStore = typeof body.store_id === 'string' ? body.store_id : null;
    const storeIds = requestedStore ? [requestedStore] : context.actor.storeIds;
    if (requestedStore && !context.actor.storeIds.includes(requestedStore)) return notFound(res, requestId);
    const store = requestedStore ? repository.findStoreById(requestedStore) : null;
    if (store && (store.tenantId !== context.actor.tenantId || store.status !== 'active')) return notFound(res, requestId);
    const asOf = typeof body.as_of === 'string' && Number.isFinite(Date.parse(body.as_of)) ? body.as_of : nowIso();
    const result = repository.previewSegment({ tenantId: context.actor.tenantId, storeIds, rule, asOf, eventId: typeof body.event_id === 'string' ? body.event_id : null });
    const sample = result.memberIds.slice(0, 10).map((memberId) => ({ member_ref: hashToken(memberId, config.sessionSecret).slice(0, 16) }));
    sendJson(res, 200, {
      rule: result.rule,
      as_of: result.asOf,
      count: result.count,
      eligible_count: result.count,
      total_members: result.totalMembers,
      coverage: result.coverage,
      reasons: result.reasons,
      sample,
      sample_redacted: true,
      contact_fields_included: false,
      store_ids: storeIds
    });
    return;
  }

  if (pathname === '/api/segments' && method === 'GET') {
    if (!hasPermission(context.actor, 'outreach:read')) return forbidden(res, requestId, 'segment_read_forbidden');
    sendJson(res, 200, { items: repository.listSegmentDefinitions(context.actor.tenantId).filter((item) => !item.storeId || context.actor.storeIds.includes(item.storeId)).map(publicSegmentDefinition) });
    return;
  }

  if (pathname === '/api/outreach/preview' && method === 'POST') {
    if (!hasPermission(context.actor, 'outreach:create')) return forbidden(res, requestId, 'outreach_create_forbidden');
    if (!checkCsrf(req, context)) return csrfFailure(res, requestId);
    const body = await readJson(req);
    if (body.template_approved === true && !hasPermission(context.actor, 'outreach:approve')) return forbidden(res, requestId, 'template_approval_forbidden');
    if (!validLocalTime(body.quiet_start_local ?? '09:00') || !validLocalTime(body.quiet_end_local ?? '21:00')) return badRequest(res, requestId, 'invalid_outreach_window');
    const storeId = typeof body.store_id === 'string' ? body.store_id : '';
    const store = repository.findStoreById(storeId);
    if (!store || store.tenantId !== context.actor.tenantId || store.status !== 'active' || !context.actor.storeIds.includes(storeId)) return notFound(res, requestId);
    const rule = (body.rule || body.segment_rule || body.segment) as SegmentRule;
    if (!['registered_unpurchased', 'first_purchase_no_second', 'inactive_14d', 'event_participant', 'marketing_opt_in'].includes(rule)) return badRequest(res, requestId, 'invalid_segment_rule');
    const channel = ['email', 'sms', 'whatsapp', 'manual'].includes(body.channel) ? body.channel as OutreachCampaign['channel'] : 'manual';
    const templateId = typeof body.template_id === 'string' && body.template_id.trim() ? body.template_id.trim() : '';
    const templateText = typeof body.template_text === 'string' ? body.template_text.trim() : '';
    if (!templateId || !templateText || templateText.length > 4000) return badRequest(res, requestId, 'approved_template_required');
    const budgetMinor = body.budget_minor === undefined ? 0 : body.budget_minor;
    const costPerAttemptMinor = body.cost_per_attempt_minor === undefined ? 0 : body.cost_per_attempt_minor;
    if (!Number.isSafeInteger(budgetMinor) || budgetMinor < 0 || !Number.isSafeInteger(costPerAttemptMinor) || costPerAttemptMinor < 0) return badRequest(res, requestId, 'invalid_outreach_budget');
    const holdoutPercent = body.holdout_percent === undefined ? (body.holdout_pct === undefined ? 10 : body.holdout_pct) : body.holdout_percent;
    if (!Number.isSafeInteger(holdoutPercent) || holdoutPercent < 0 || holdoutPercent > 100) return badRequest(res, requestId, 'invalid_holdout_percent');
    const frequencyCapDays = body.frequency_cap_days === undefined ? 7 : body.frequency_cap_days;
    if (!Number.isSafeInteger(frequencyCapDays) || frequencyCapDays < 0) return badRequest(res, requestId, 'invalid_frequency_cap');
    const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 160) : `${rule} outreach`;
    const segment = await repository.createSegmentDefinition({ tenantId: context.actor.tenantId, name, rule, createdBy: context.actor.userId, storeId });
    const frozen = await repository.freezeAudience({ tenantId: context.actor.tenantId, segmentId: segment.id, storeId, storeIds: [storeId], asOf: typeof body.as_of === 'string' && Number.isFinite(Date.parse(body.as_of)) ? body.as_of : nowIso(), holdoutPercent, seed: typeof body.seed === 'string' ? body.seed : undefined });
    const campaign = await repository.createOutreachCampaign({
      tenantId: context.actor.tenantId,
      storeId,
      segmentId: segment.id,
      audienceSnapshotId: frozen.snapshot.id,
      channel,
      templateId,
      templateText,
      templateApproved: body.template_approved === true,
      budgetMinor,
      costPerAttemptMinor,
      quietStartLocal: typeof body.quiet_start_local === 'string' ? body.quiet_start_local : '09:00',
      quietEndLocal: typeof body.quiet_end_local === 'string' ? body.quiet_end_local : '21:00',
      frequencyCapDays,
      status: 'pending_approval',
      createdBy: context.actor.userId,
      policyVersion: 'crm-policy-v2',
      expiresAt: typeof body.expires_at === 'string' && Number.isFinite(Date.parse(body.expires_at)) ? body.expires_at : new Date(Date.now() + 7 * 86_400_000).toISOString()
    });
    await repository.audit({ tenantId: context.actor.tenantId, storeId, actorUserId: context.actor.userId, action: 'outreach.preview_created', resourceType: 'outreach', resourceId: campaign.id, metadata: { segment_rule: rule, assigned_count: frozen.snapshot.memberIds.length, holdout_percent: frozen.snapshot.holdoutPercent, contact_fields_included: false } });
    sendJson(res, 201, { campaign: publicOutreachCampaign(campaign), outreach_id: campaign.id, segment: publicSegmentDefinition(segment), segment_id: segment.id, audience: publicAudienceSnapshot(frozen.snapshot, config.sessionSecret), audience_snapshot_id: frozen.snapshot.id, preview: { count: frozen.preview.count, coverage: frozen.preview.coverage, reasons: frozen.preview.reasons, contact_fields_included: false } });
    return;
  }

  if (pathname === '/api/outreach' && method === 'GET') {
    if (!hasPermission(context.actor, 'outreach:read')) return forbidden(res, requestId, 'outreach_read_forbidden');
    sendJson(res, 200, { items: repository.listOutreachCampaigns(context.actor.tenantId, context.actor.storeIds).map(publicOutreachCampaign) });
    return;
  }

  const outreachReportMatch = pathname.match(/^\/api\/outreach\/([^/]+)\/report$/);
  if (outreachReportMatch && method === 'GET') {
    if (!hasPermission(context.actor, 'outreach:read')) return forbidden(res, requestId, 'outreach_read_forbidden');
    const campaign = repository.findOutreachCampaign(decodeURIComponent(outreachReportMatch[1]));
    if (!campaign || campaign.tenantId !== context.actor.tenantId || !context.actor.storeIds.includes(campaign.storeId)) return notFound(res, requestId);
    sendJson(res, 200, { report: repository.outreachReport(campaign.id, context.actor.tenantId) });
    return;
  }

  const outreachMatch = pathname.match(/^\/api\/outreach\/([^/]+)$/);
  if (outreachMatch && method === 'GET') {
    if (!hasPermission(context.actor, 'outreach:read')) return forbidden(res, requestId, 'outreach_read_forbidden');
    const campaign = repository.findOutreachCampaign(decodeURIComponent(outreachMatch[1]));
    if (!campaign || campaign.tenantId !== context.actor.tenantId || !context.actor.storeIds.includes(campaign.storeId)) return notFound(res, requestId);
    const snapshot = repository.findAudienceSnapshot(campaign.audienceSnapshotId);
    sendJson(res, 200, { campaign: publicOutreachCampaign(campaign), audience: snapshot ? publicAudienceSnapshot(snapshot, config.sessionSecret) : null, attempts: repository.listMessageAttempts(context.actor.tenantId, campaign.id).map(publicMessageAttempt) });
    return;
  }

  if (outreachMatch && (method === 'PATCH' || method === 'PUT')) {
    if (!hasPermission(context.actor, 'outreach:create')) return forbidden(res, requestId, 'outreach_edit_forbidden');
    if (!checkCsrf(req, context)) return csrfFailure(res, requestId);
    const campaign = repository.findOutreachCampaign(decodeURIComponent(outreachMatch[1]));
    if (!campaign || campaign.tenantId !== context.actor.tenantId || !context.actor.storeIds.includes(campaign.storeId)) return notFound(res, requestId);
    const body = await readJson(req);
    const patch: Partial<Pick<OutreachCampaign, 'templateId' | 'templateText' | 'templateApproved' | 'budgetMinor' | 'costPerAttemptMinor' | 'quietStartLocal' | 'quietEndLocal' | 'frequencyCapDays' | 'expiresAt'>> = {};
    if (body.template_id !== undefined) { if (typeof body.template_id !== 'string' || !body.template_id.trim()) return badRequest(res, requestId, 'approved_template_required'); patch.templateId = body.template_id.trim(); }
    if (body.template_text !== undefined) { if (typeof body.template_text !== 'string' || !body.template_text.trim() || body.template_text.length > 4000) return badRequest(res, requestId, 'invalid_template_text'); patch.templateText = body.template_text.trim(); }
    if (body.template_approved !== undefined) { if (typeof body.template_approved !== 'boolean') return badRequest(res, requestId, 'invalid_template_approval'); if (body.template_approved && !hasPermission(context.actor, 'outreach:approve')) return forbidden(res, requestId, 'template_approval_forbidden'); patch.templateApproved = body.template_approved; }
    if (body.budget_minor !== undefined) { if (!Number.isSafeInteger(body.budget_minor) || body.budget_minor < 0) return badRequest(res, requestId, 'invalid_outreach_budget'); patch.budgetMinor = body.budget_minor; }
    if (body.cost_per_attempt_minor !== undefined) { if (!Number.isSafeInteger(body.cost_per_attempt_minor) || body.cost_per_attempt_minor < 0) return badRequest(res, requestId, 'invalid_outreach_cost'); patch.costPerAttemptMinor = body.cost_per_attempt_minor; }
    if (body.quiet_start_local !== undefined) { if (!validLocalTime(body.quiet_start_local)) return badRequest(res, requestId, 'invalid_outreach_window'); patch.quietStartLocal = body.quiet_start_local; }
    if (body.quiet_end_local !== undefined) { if (!validLocalTime(body.quiet_end_local)) return badRequest(res, requestId, 'invalid_outreach_window'); patch.quietEndLocal = body.quiet_end_local; }
    if (body.frequency_cap_days !== undefined) { if (!Number.isSafeInteger(body.frequency_cap_days) || body.frequency_cap_days < 0) return badRequest(res, requestId, 'invalid_frequency_cap'); patch.frequencyCapDays = body.frequency_cap_days; }
    if (body.expires_at !== undefined) { if (typeof body.expires_at !== 'string' || !Number.isFinite(Date.parse(body.expires_at))) return badRequest(res, requestId, 'invalid_outreach_expiry'); patch.expiresAt = body.expires_at; }
    const updated = await repository.updateOutreachCampaign(campaign.id, context.actor.tenantId, patch);
    sendJson(res, 200, { campaign: publicOutreachCampaign(updated || campaign), approval_invalidated: true });
    return;
  }

  const outreachSubmitMatch = pathname.match(/^\/api\/outreach\/([^/]+)\/submit$/);
  if (outreachSubmitMatch && method === 'POST') {
    if (!hasPermission(context.actor, 'outreach:approve') && !hasPermission(context.actor, 'outreach:create')) return forbidden(res, requestId, 'outreach_approval_forbidden');
    if (!checkCsrf(req, context)) return csrfFailure(res, requestId);
    const campaign = repository.findOutreachCampaign(decodeURIComponent(outreachSubmitMatch[1]));
    if (!campaign || campaign.tenantId !== context.actor.tenantId || !context.actor.storeIds.includes(campaign.storeId)) return notFound(res, requestId);
    if (!hasPermission(context.actor, 'outreach:approve')) {
      const submitted = await repository.submitOutreachForApproval(campaign.id, context.actor.tenantId);
      sendJson(res, 202, { campaign: publicOutreachCampaign(submitted), approval: { status: 'pending_approval' } });
      return;
    }
    try {
      const approved = await repository.approveOutreachCampaign(campaign.id, context.actor.userId);
      await repository.audit({ tenantId: context.actor.tenantId, storeId: campaign.storeId, actorUserId: context.actor.userId, action: 'outreach.approved', resourceType: 'outreach', resourceId: campaign.id, metadata: { approval_hash: approved.approvalHash, audience_snapshot_id: approved.audienceSnapshotId } });
      sendJson(res, 200, {
        campaign: publicOutreachCampaign(approved),
        approval: {
          action_intent_id: approved.id,
          resource_revision_id: approved.id,
          payload_hash: approved.approvalHash,
          audience_snapshot_id: approved.audienceSnapshotId,
          channel: approved.channel,
          language: 'member_preference',
          budget_minor: String(approved.budgetMinor),
          policy_version: approved.policyVersion || 'crm-policy-v1',
          approved_by: approved.approvedBy,
          approved_at: approved.approvedAt,
          expires_at: approved.expiresAt,
          status: 'approved'
        }
      });
    } catch (error) {
      const code = error instanceof Error ? error.message : 'outreach_approval_failed';
      sendJson(res, 409, { error_code: code, message: '触达审批不能执行 / Outreach approval failed', retryable: false, request_id: requestId });
    }
    return;
  }

  const outreachExportMatch = pathname.match(/^\/api\/outreach\/([^/]+)\/export$/);
  if (outreachExportMatch && method === 'POST') {
    if (!hasPermission(context.actor, 'outreach:dispatch') && !hasPermission(context.actor, 'member:export')) return forbidden(res, requestId, 'outreach_export_forbidden');
    if (!checkCsrf(req, context)) return csrfFailure(res, requestId);
    const campaign = repository.findOutreachCampaign(decodeURIComponent(outreachExportMatch[1]));
    if (!campaign || campaign.tenantId !== context.actor.tenantId || !context.actor.storeIds.includes(campaign.storeId)) return notFound(res, requestId);
    const body = await readJson(req);
    try {
      const result = repository.outreachExportPreview({ outreachId: campaign.id, tenantId: context.actor.tenantId, storeId: campaign.storeId, now: config.mode === 'test' && typeof body.now === 'string' ? body.now : undefined });
      const eligible = result.items.filter((item) => item.status === 'eligible');
      const blockedReasons = result.items.filter((item) => item.status !== 'eligible').reduce((counts: Record<string, number>, item) => { const key = item.status; counts[key] = (counts[key] || 0) + 1; return counts; }, {});
      sendJson(res, 200, { status: 'manual_ready', items: eligible.map((item) => ({ member_ref: hashToken(item.memberId, config.sessionSecret).slice(0, 16), assignment: item.assignment })), blocked_count: result.blockedCount, blocked_reasons: blockedReasons, contact_fields_included: false, policy_enforced: true });
    } catch (error) {
      const code = error instanceof Error ? error.message : 'outreach_export_blocked';
      sendJson(res, 409, { error_code: code, message: '人工导出仍受同意、频控、预算和模板政策约束', retryable: false, request_id: requestId });
    }
    return;
  }

  const outreachDispatchMatch = pathname.match(/^\/api\/outreach\/([^/]+)\/dispatch$/);
  if (outreachDispatchMatch && method === 'POST') {
    if (!hasPermission(context.actor, 'outreach:dispatch')) return forbidden(res, requestId, 'outreach_dispatch_forbidden');
    if (!checkCsrf(req, context)) return csrfFailure(res, requestId);
    const campaign = repository.findOutreachCampaign(decodeURIComponent(outreachDispatchMatch[1]));
    if (!campaign || campaign.tenantId !== context.actor.tenantId || !context.actor.storeIds.includes(campaign.storeId)) return notFound(res, requestId);
    const body = await readJson(req);
    try {
      const result = await repository.dispatchOutreach({ outreachId: campaign.id, tenantId: context.actor.tenantId, storeId: campaign.storeId, allowTestOutbox: config.allowTestOutbox, now: config.mode === 'test' && typeof body.now === 'string' ? body.now : undefined, idempotencyKey: typeof body.idempotency_key === 'string' ? body.idempotency_key : undefined });
      await repository.audit({ tenantId: context.actor.tenantId, storeId: campaign.storeId, actorUserId: context.actor.userId, action: 'outreach.dispatched', resourceType: 'outreach', resourceId: campaign.id, metadata: { attempt_count: result.attempts.length, test_outbox: config.allowTestOutbox, status: result.campaign.status } });
      sendJson(res, 200, { campaign: publicOutreachCampaign(result.campaign), attempts: result.attempts.map(publicMessageAttempt), message_attempts: result.attempts.map(publicMessageAttempt), report: result.report, delivery_mode: config.allowTestOutbox ? 'test_outbox' : 'external_blocked' });
    } catch (error) {
      const code = error instanceof Error ? error.message : 'outreach_dispatch_failed';
      sendJson(res, 409, { error_code: code, message: '触达未执行 / Outreach dispatch blocked', retryable: false, request_id: requestId, delivery_mode: config.allowTestOutbox ? 'test_outbox' : 'external_blocked' });
    }
    return;
  }

  // ----- First-party source links, offers and cashier redemption (G03) -----
  const sourceLinkMatch = pathname.match(/^\/api\/campaigns\/([^/]+)\/source-links$/);
  if (sourceLinkMatch && method === 'POST') {
    if (!hasPermission(context.actor, 'campaign:create')) return forbidden(res, requestId, 'source_link_write_forbidden');
    if (!checkCsrf(req, context)) return csrfFailure(res, requestId);
    const campaign = repository.findCampaign(decodeURIComponent(sourceLinkMatch[1]));
    if (!campaign || campaign.tenantId !== context.actor.tenantId || !context.actor.storeIds.includes(campaign.storeId)) return notFound(res, requestId);
    const body = await readJson(req);
    const rawToken = randomBytes(32).toString('base64url');
    const link = await repository.createSourceLink({ tenantId: context.actor.tenantId, storeId: campaign.storeId, campaignId: campaign.id, label: typeof body.label === 'string' ? body.label.slice(0, 120) : 'source', channel: typeof body.channel === 'string' ? body.channel : 'manual', variant: typeof body.variant === 'string' ? body.variant : null, tokenHash: hashToken(rawToken, config.sessionSecret), createdBy: context.actor.userId });
    const store = repository.findStoreById(campaign.storeId);
    sendJson(res, 201, { item: publicSourceLink(link), token: rawToken, url: `/s/${store?.slug || campaign.storeId}/c/${rawToken}`, evidence: 'opaque_token_only' });
    return;
  }

  if (pathname === '/api/source-links' && method === 'GET') {
    if (!hasPermission(context.actor, 'campaign:read')) return forbidden(res, requestId, 'source_link_read_forbidden');
    sendJson(res, 200, { items: repository.listSourceLinks(context.actor.tenantId, context.actor.storeIds).map(publicSourceLink) });
    return;
  }

  if (pathname === '/api/offers' && method === 'POST') {
    if (!hasPermission(context.actor, 'campaign:create')) return forbidden(res, requestId, 'offer_write_forbidden');
    if (!checkCsrf(req, context)) return csrfFailure(res, requestId);
    const body = await readJson(req);
    const campaignId = typeof body.campaign_id === 'string' ? body.campaign_id : '';
    const campaign = repository.findCampaign(campaignId);
    if (!campaign || campaign.tenantId !== context.actor.tenantId || !context.actor.storeIds.includes(campaign.storeId)) return notFound(res, requestId);
    const validFrom = timestampInput(body.valid_from, 'valid_from', nowIso());
    const validTo = timestampInput(body.valid_to, 'valid_to', new Date(Date.now() + 86_400_000).toISOString());
    if (Date.parse(validTo) <= Date.parse(validFrom)) return badRequest(res, requestId, 'invalid_offer_window');
    const offer = await repository.createOffer({ tenantId: context.actor.tenantId, storeId: campaign.storeId, campaignId, name: typeof body.name === 'string' ? body.name.slice(0, 120) : 'approved offer', terms: typeof body.terms === 'string' ? body.terms : 'Terms require operator confirmation', validFrom, validTo, maxRedemptions: Number.isSafeInteger(body.max_redemptions) && body.max_redemptions > 0 ? body.max_redemptions : null, createdBy: context.actor.userId });
    sendJson(res, 201, { item: publicOffer(offer) });
    return;
  }

  if (pathname === '/api/offers' && method === 'GET') {
    if (!hasPermission(context.actor, 'campaign:read')) return forbidden(res, requestId, 'offer_read_forbidden');
    sendJson(res, 200, { items: repository.listOffers(context.actor.tenantId, context.actor.storeIds).map(publicOffer) });
    return;
  }

  if (pathname === '/api/redemptions/reserve' && method === 'POST') {
    if (!hasPermission(context.actor, 'campaign:create') && context.actor.role !== 'CASHIER') return forbidden(res, requestId, 'redemption_forbidden');
    if (!checkCsrf(req, context)) return csrfFailure(res, requestId);
    const body = await readJson(req);
    const couponToken = typeof body.coupon_token === 'string' ? body.coupon_token : '';
    const storeId = typeof body.store_id === 'string' ? body.store_id : '';
    if (!context.actor.storeIds.includes(storeId)) return notFound(res, requestId);
    const result = await repository.reserveCoupon({ tokenHash: hashToken(couponToken, config.sessionSecret), tenantId: context.actor.tenantId, storeId, employeeUserId: context.actor.userId, posOrderRef: typeof body.pos_order_ref === 'string' ? body.pos_order_ref : null });
    if (!result.coupon) { sendJson(res, 409, { error_code: result.attempt.errorCode || 'redemption_rejected', message: '券核验失败 / Redemption rejected', retryable: false, attempt: result.attempt }); return; }
    sendJson(res, 200, { coupon: publicCoupon(result.coupon), attempt: result.attempt, revenue_effect: 'none_until_pos_match' });
    return;
  }

  const couponMatch = pathname.match(/^\/api\/redemptions\/([^/]+)\/match-pos$/);
  if (couponMatch && method === 'POST') {
    if (!hasPermission(context.actor, 'campaign:create') && context.actor.role !== 'CASHIER') return forbidden(res, requestId, 'redemption_forbidden');
    if (!checkCsrf(req, context)) return csrfFailure(res, requestId);
    const body = await readJson(req);
    const storeId = typeof body.store_id === 'string' ? body.store_id : '';
    if (!context.actor.storeIds.includes(storeId)) return notFound(res, requestId);
    const result = await repository.matchCoupon(decodeURIComponent(couponMatch[1]), context.actor.tenantId, storeId, typeof body.pos_order_ref === 'string' ? body.pos_order_ref : '', body.order_source, body.order_id);
    if (!result.coupon) { sendJson(res, 409, { error_code: result.errorCode || 'pos_match_failed', message: 'POS 订单尚未核验 / POS match failed', retryable: false }); return; }
    sendJson(res, 200, { coupon: publicCoupon(result.coupon), revenue_effect: 'eligible_after_authoritative_pos_import' });
    return;
  }

  // ----- Content studio, local review and approval/export (G04) -----
  if (pathname === '/api/content/generate' && method === 'POST') {
    if (!hasPermission(context.actor, 'campaign:create')) return forbidden(res, requestId, 'content_generate_forbidden');
    if (!checkCsrf(req, context)) return csrfFailure(res, requestId);
    const body = await readJson(req);
    const campaign = typeof body.campaign_id === 'string' ? repository.findCampaign(body.campaign_id) : undefined;
    if (!campaign || campaign.tenantId !== context.actor.tenantId || !context.actor.storeIds.includes(campaign.storeId)) return notFound(res, requestId);
    const unsafeInstruction = typeof body.instruction === 'string' ? body.instruction : '';
    const state = repository.snapshot();
    const approvedRevision = state.brandRevisions.filter((item) => item.tenantId === context.actor.tenantId && item.status === 'approved' && state.brandDocuments.some((document) => document.id === item.documentId && (!document.storeId || document.storeId === campaign.storeId))).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    const requestedProductIds = Array.isArray(body.product_ids) ? body.product_ids.filter((item: unknown): item is string => typeof item === 'string') : (campaign.productIds || []);
    const productRefs = requestedProductIds.map((id) => {
      const product = state.products.find((item) => item.id === id && item.tenantId === context.actor.tenantId && item.storeId === campaign.storeId);
      const price = product?.currentPriceVersionId ? state.priceVersions.find((item) => item.id === product.currentPriceVersionId) : undefined;
      const name = product ? Object.values(product.names)[0] || product.externalSku : '';
      return { id, name, priceMinor: price?.status === 'approved' ? price.amountMinor : null, currency: price?.currency || 'BDT' };
    });
    if (!approvedRevision && !unsafeInstruction) {
      sendJson(res, 409, { error_code: 'needs_approved_brand_revision', message: '没有已批准品牌事实，先补充并批准资料', retryable: false, needs_input: ['approved_brand_facts'] });
      return;
    }
    if (!approvedRevision) {
      const failed = generateDeterministicContent({ briefId: 'not-created', campaignId: campaign.id, brandRevisionId: 'missing', brandName: '', productRefs, channel: String(body.channel || 'manual'), contentPillar: String(body.content_pillar || 'Campus Adda'), targetMetric: String(body.target_metric || 'verified_orders'), sourceLinkId: null, sourceExcerpt: '', hasApprovedAssets: false }, unsafeInstruction);
      sendJson(res, 422, { status: 'failed', error_code: failed.errorCode || 'content_generation_blocked', manual_edit_available: true, reason: failed.manualEditReason || 'approved facts missing' });
      return;
    }
    const brandNameFact = state.brandFacts.find((fact) => fact.revisionId === approvedRevision.id && (fact.key === 'brand_name' || fact.key.endsWith('.brand_name')) && fact.status === 'approved');
    const sourceLinkId = typeof body.source_link_id === 'string' && state.sourceLinks.some((item) => item.id === body.source_link_id && item.tenantId === context.actor.tenantId && item.campaignId === campaign.id) ? body.source_link_id : null;
    const brief = await repository.createContentBrief({ tenantId: context.actor.tenantId, storeId: campaign.storeId, campaignId: campaign.id, targetMetric: typeof body.target_metric === 'string' ? body.target_metric : 'verified_orders', contentPillar: typeof body.content_pillar === 'string' ? body.content_pillar : 'Campus Adda', channel: typeof body.channel === 'string' ? body.channel : 'manual', productIds: requestedProductIds, assetIds: Array.isArray(body.asset_ids) ? body.asset_ids.filter((item: unknown): item is string => typeof item === 'string') : (campaign.assetIds || []), sourceLinkId, createdBy: context.actor.userId });
    const generated = generateDeterministicContent({ briefId: brief.id, campaignId: campaign.id, brandRevisionId: approvedRevision.id, brandName: brandNameFact?.value || '', productRefs, channel: brief.channel, contentPillar: brief.contentPillar, targetMetric: brief.targetMetric, sourceLinkId, sourceExcerpt: brandNameFact?.value || 'approved brand revision', hasApprovedAssets: brief.assetIds.length > 0 && brief.assetIds.every((assetId) => state.mediaAssets.some((asset) => asset.id === assetId && asset.rightsStatus === 'approved')) }, unsafeInstruction);
    if (!generated.ok || !generated.packageData) {
      sendJson(res, 422, { status: 'failed', error_code: generated.errorCode || 'content_generation_failed', manual_edit_available: true, reason: generated.manualEditReason || 'provider returned no schema-valid package' });
      return;
    }
    const revision = await repository.createContentRevision({ briefId: brief.id, tenantId: context.actor.tenantId, packageData: generated.packageData, generationFacts: captureContentFacts(state, brief, generated.packageData), createdBy: context.actor.userId });
    sendJson(res, 201, { brief: publicContentBrief(brief), revision: publicContentRevision(revision), provider: { mode: 'demo', name: 'deterministic-fake', live: false } });
    return;
  }

  if (pathname === '/api/content' && method === 'GET') {
    if (!hasPermission(context.actor, 'campaign:read')) return forbidden(res, requestId, 'content_read_forbidden');
    const approvals = repository.snapshot().contentApprovals;
    sendJson(res, 200, { items: repository.listContentRevisions(context.actor.tenantId, context.actor.storeIds).map(revision => ({ ...publicContentRevision(revision), current_approval_id: revision.currentApprovalId || approvals.find(approval => approval.resourceRevisionId === revision.id && approval.status === 'pending')?.id || null })) });
    return;
  }

  const contentMatch = pathname.match(/^\/api\/content\/([^/]+)$/);
  if (contentMatch && method === 'GET') {
    const revision = repository.findContentRevision(decodeURIComponent(contentMatch[1]));
    const brief = revision ? repository.findContentBrief(revision.briefId) : undefined;
    if (!revision || !brief || revision.tenantId !== context.actor.tenantId || !context.actor.storeIds.includes(brief.storeId)) return notFound(res, requestId);
    sendJson(res, 200, { item: publicContentRevision(revision), package: revision.packageData });
    return;
  }

  if (contentMatch && (method === 'PATCH' || method === 'PUT')) {
    if (!hasPermission(context.actor, 'campaign:create')) return forbidden(res, requestId, 'content_edit_forbidden');
    if (!checkCsrf(req, context)) return csrfFailure(res, requestId);
    const revision = repository.findContentRevision(decodeURIComponent(contentMatch[1]));
    const brief = revision ? repository.findContentBrief(revision.briefId) : undefined;
    if (!revision || !brief || revision.tenantId !== context.actor.tenantId || !context.actor.storeIds.includes(brief.storeId)) return notFound(res, requestId);
    const body = await readJson(req);
    const packageData = (body.package_data && typeof body.package_data === 'object' ? body.package_data : revision.packageData) as ContentPackageData;
    try {
      const updated = await repository.updateContentRevision(revision.id, packageData, context.actor.userId);
      sendJson(res, 200, { item: publicContentRevision(updated || revision), approval_invalidated: true });
    } catch (error) {
      const code = error instanceof Error ? error.message : 'content_edit_failed';
      sendJson(res, 400, { error_code: code, message: '内容结构不符合合同 / Invalid content package', retryable: false, request_id: requestId });
    }
    return;
  }

  const contentReviewMatch = pathname.match(/^\/api\/content\/([^/]+)\/review-bn$/);
  if (contentReviewMatch && method === 'POST') {
    if (!hasBrandPermission(context.actor, 'brand:approve') && context.actor.role !== 'LOCAL_REVIEWER') return forbidden(res, requestId, 'local_review_forbidden');
    if (!checkCsrf(req, context)) return csrfFailure(res, requestId);
    const revision = repository.findContentRevision(decodeURIComponent(contentReviewMatch[1]));
    const brief = revision ? repository.findContentBrief(revision.briefId) : undefined;
    if (!revision || !brief || revision.tenantId !== context.actor.tenantId || !context.actor.storeIds.includes(brief.storeId)) return notFound(res, requestId);
    const body = await readJson(req);
    const decision = body.decision === 'rejected' ? 'rejected' : 'reviewed';
    const updated = await repository.reviewContentBn(revision.id, context.actor.userId, decision);
    sendJson(res, 200, { item: publicContentRevision(updated || revision), reviewer: context.actor.userId });
    return;
  }

  if (pathname === '/api/content/submit' && method === 'POST') {
    if (!hasPermission(context.actor, 'campaign:create')) return forbidden(res, requestId, 'content_submit_forbidden');
    if (!checkCsrf(req, context)) return csrfFailure(res, requestId);
    const body = await readJson(req);
    const revision = typeof body.revision_id === 'string' ? repository.findContentRevision(body.revision_id) : undefined;
    const brief = revision ? repository.findContentBrief(revision.briefId) : undefined;
    if (!revision || !brief || revision.tenantId !== context.actor.tenantId || !context.actor.storeIds.includes(brief.storeId)) return notFound(res, requestId);
    if (revision.packageData.needs_input.length) { sendJson(res, 409, { error_code: 'content_needs_input', message: '内容仍缺少批准资料', retryable: false, needs_input: revision.packageData.needs_input }); return; }
    if (revision.packageData.variants.some((variant) => variant.locale === 'bn' && variant.review_status !== 'reviewed')) { sendJson(res, 409, { error_code: 'bn_review_required', message: '孟语版本需要本地人工复核', retryable: false }); return; }
    const approval = await repository.createContentApproval({ tenantId: context.actor.tenantId, resourceRevisionId: revision.id, payloadHash: revision.contentHash, expiresAt: timestampInput(body.expires_at, 'expires_at', new Date(Date.now() + 7 * 86_400_000).toISOString()) });
    sendJson(res, 201, { approval: publicContentApproval(approval) });
    return;
  }

  const approvalMatch = pathname.match(/^\/api\/approvals\/([^/]+)\/approve$/);
  if (approvalMatch && method === 'POST') {
    if (!hasBrandPermission(context.actor, 'brand:approve')) return forbidden(res, requestId, 'approval_forbidden');
    if (!checkCsrf(req, context)) return csrfFailure(res, requestId);
    const approval = repository.findContentApproval(decodeURIComponent(approvalMatch[1]));
    const revision = approval ? repository.findContentRevision(approval.resourceRevisionId) : undefined;
    const brief = revision ? repository.findContentBrief(revision.briefId) : undefined;
    if (!approval || !revision || !brief || approval.tenantId !== context.actor.tenantId || !context.actor.storeIds.includes(brief.storeId)) return notFound(res, requestId);
    try {
      const approved = await repository.approveContent(approval.id, context.actor.userId, revision.contentHash);
      sendJson(res, 200, { approval: publicContentApproval(approved), revision: publicContentRevision(revision) });
    } catch (error) {
      const code = error instanceof Error ? error.message : 'approval_failed';
      sendJson(res, 409, { error_code: code, message: '审批不能执行 / Approval failed', retryable: false });
    }
    return;
  }

  if (pathname === '/api/content/export' && method === 'POST') {
    if (!hasPermission(context.actor, 'campaign:create')) return forbidden(res, requestId, 'content_export_forbidden');
    if (!checkCsrf(req, context)) return csrfFailure(res, requestId);
    const body = await readJson(req);
    const revision = typeof body.revision_id === 'string' ? repository.findContentRevision(body.revision_id) : undefined;
    const brief = revision ? repository.findContentBrief(revision.briefId) : undefined;
    if (!revision || !brief || revision.tenantId !== context.actor.tenantId || !context.actor.storeIds.includes(brief.storeId)) return notFound(res, requestId);
    const intent = await repository.createPublicationIntent({ tenantId: context.actor.tenantId, storeId: brief.storeId, contentRevisionId: revision.id, channel: brief.channel, mode: 'manual', createdBy: context.actor.userId });
    sendJson(res, 200, { intent: publicPublicationIntent(intent), package: intent.packageData, status: 'manual_ready', published: false, evidence_required: 'operator_attested_or_provider_confirmed' });
    return;
  }

  const publicationMatch = pathname.match(/^\/api\/publications\/([^/]+)\/attest$/);
  if (publicationMatch && method === 'POST') {
    if (!hasPermission(context.actor, 'campaign:create')) return forbidden(res, requestId, 'publication_attest_forbidden');
    if (!checkCsrf(req, context)) return csrfFailure(res, requestId);
    const intent = repository.findPublicationIntent(decodeURIComponent(publicationMatch[1]));
    if (!intent || intent.tenantId !== context.actor.tenantId || !context.actor.storeIds.includes(intent.storeId)) return notFound(res, requestId);
    const body = await readJson(req);
    const receipt = await repository.addPublicationReceipt({ intentId: intent.id, evidenceType: 'operator_attested', externalPostId: typeof body.external_post_id === 'string' ? body.external_post_id : null, evidenceUrl: typeof body.evidence_url === 'string' ? body.evidence_url : null, createdBy: context.actor.userId });
    sendJson(res, 200, { intent: publicPublicationIntent(repository.findPublicationIntent(intent.id) || intent), receipt });
    return;
  }

  // ----- Campus partners, events and referrals (G05) -----
  if (pathname === '/api/partners' && method === 'POST') {
    if (!hasPermission(context.actor, 'campaign:create')) return forbidden(res, requestId, 'partner_write_forbidden');
    if (!checkCsrf(req, context)) return csrfFailure(res, requestId);
    const body = await readJson(req);
    const sourceUrl = typeof body.source_url === 'string' ? body.source_url.trim() : '';
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!sourceUrl || !/^https?:\/\//i.test(sourceUrl) || !name) return badRequest(res, requestId, 'partner_source_required');
    const partner = await repository.createPartner({ tenantId: context.actor.tenantId, name, kind: ['organization', 'koc', 'club', 'other'].includes(body.kind) ? body.kind : 'other', sourceUrl, sourceNote: typeof body.source_note === 'string' ? body.source_note : null, contactPermission: body.contact_permission === true, followerCount: Number.isSafeInteger(body.follower_count) ? body.follower_count : null, createdBy: context.actor.userId });
    sendJson(res, 201, { item: partner, warning: 'source and verification are required; no person or follower facts were inferred' });
    return;
  }

  if (pathname === '/api/partners' && method === 'GET') {
    if (!hasPermission(context.actor, 'campaign:read')) return forbidden(res, requestId, 'partner_read_forbidden');
    sendJson(res, 200, { items: repository.listPartners(context.actor.tenantId) });
    return;
  }

  const partnerMatch = pathname.match(/^\/api\/partners\/([^/]+)$/);
  if (partnerMatch && method === 'PATCH') {
    if (!hasPermission(context.actor, 'campaign:create')) return forbidden(res, requestId, 'partner_write_forbidden');
    if (!checkCsrf(req, context)) return csrfFailure(res, requestId);
    const body = await readJson(req);
    const stage = body.stage;
    if (!['identified', 'verified', 'invited', 'agreed', 'active', 'reviewed', 'paused', 'closed'].includes(stage)) return badRequest(res, requestId, 'invalid_partner_stage');
    const updated = await repository.updatePartnerStage(decodeURIComponent(partnerMatch[1]), context.actor.tenantId, stage, stage === 'verified' ? nowIso() : undefined);
    if (!updated) return notFound(res, requestId);
    sendJson(res, 200, { item: updated });
    return;
  }

  if (pathname === '/api/events/templates' && method === 'GET') {
    sendJson(res, 200, { items: repository.listEventTemplates(), note: 'templates are parameterized; dates require verified context' });
    return;
  }

  if (pathname === '/api/events' && method === 'POST') {
    if (!hasPermission(context.actor, 'campaign:create')) return forbidden(res, requestId, 'event_write_forbidden');
    if (!checkCsrf(req, context)) return csrfFailure(res, requestId);
    const body = await readJson(req);
    const storeId = typeof body.store_id === 'string' ? body.store_id : '';
    const template = repository.listEventTemplates().find((item) => item.id === body.template_id || item.key === body.template_key);
    if (!template || !context.actor.storeIds.includes(storeId)) return badRequest(res, requestId, 'event_template_or_store_invalid');
    const startsAt = typeof body.starts_at === 'string' && Number.isFinite(Date.parse(body.starts_at)) ? body.starts_at : null;
    const endsAt = typeof body.ends_at === 'string' && Number.isFinite(Date.parse(body.ends_at)) ? body.ends_at : null;
    if ((body.starts_at && !startsAt) || (body.ends_at && !endsAt) || (startsAt && endsAt && Date.parse(endsAt) <= Date.parse(startsAt))) return badRequest(res, requestId, 'event_date_invalid');
    const capacity = Number.isSafeInteger(body.capacity) && body.capacity > 0 ? body.capacity : template.capacityDefault;
    try { const event = await repository.createEvent({ tenantId: context.actor.tenantId, storeId, campaignId: typeof body.campaign_id === 'string' ? body.campaign_id : null, templateId: template.id, name: typeof body.name === 'string' ? body.name : template.name, startsAt, endsAt, capacity, createdBy: context.actor.userId }); sendJson(res, 201, { item: event, needs_input: startsAt && endsAt ? [] : ['verified_event_date'] }); }
    catch (error) { sendJson(res, 409, { error_code: error instanceof Error ? error.message : 'event_invalid', retryable: false, request_id: requestId }); }
    return;
  }

  if (pathname === '/api/events' && method === 'GET') {
    if (!hasPermission(context.actor, 'campaign:read')) return forbidden(res, requestId, 'event_read_forbidden');
    sendJson(res, 200, { items: repository.listEvents(context.actor.tenantId, context.actor.storeIds) });
    return;
  }

  const eventScheduleMatch = pathname.match(/^\/api\/events\/([^/]+)$/);
  if (eventScheduleMatch && method === 'PATCH') {
    if (!hasPermission(context.actor, 'campaign:create')) return forbidden(res, requestId, 'event_write_forbidden');
    if (!checkCsrf(req, context)) return csrfFailure(res, requestId);
    const existingEvent = repository.findEvent(decodeURIComponent(eventScheduleMatch[1]));
    if (!existingEvent || existingEvent.tenantId !== context.actor.tenantId || !context.actor.storeIds.includes(existingEvent.storeId)) return notFound(res, requestId);
    const body = await readJson(req);
    try {
      const event = await repository.updateEventSchedule(existingEvent.id, context.actor.tenantId, { startsAt: body.starts_at, endsAt: body.ends_at, capacity: body.capacity });
      sendJson(res, 200, { item: event });
    } catch (error) { sendJson(res, 409, { error_code: error instanceof Error ? error.message : 'event_schedule_invalid', retryable: false }); }
    return;
  }

  const eventStatusMatch = pathname.match(/^\/api\/events\/([^/]+)\/status$/);
  if (eventStatusMatch && method === 'POST') {
    if (!hasPermission(context.actor, 'campaign:create')) return forbidden(res, requestId, 'event_write_forbidden');
    if (!checkCsrf(req, context)) return csrfFailure(res, requestId);
    const body = await readJson(req);
    const status = body.status;
    if (!['draft', 'open', 'closed', 'cancelled'].includes(status)) return badRequest(res, requestId, 'invalid_event_status');
    const existingEvent = repository.findEvent(decodeURIComponent(eventStatusMatch[1]));
    if (!existingEvent || existingEvent.tenantId !== context.actor.tenantId || !context.actor.storeIds.includes(existingEvent.storeId)) return notFound(res, requestId);
    try { const event = await repository.setEventStatus(existingEvent.id, context.actor.tenantId, status); sendJson(res, 200, { item: event || existingEvent }); }
    catch (error) { sendJson(res, 409, { error_code: error instanceof Error ? error.message : 'event_status_invalid', retryable: false }); }
    return;
  }

  const eventRegistrationMatch = pathname.match(/^\/api\/events\/([^/]+)\/registrations$/);
  if (eventRegistrationMatch && method === 'POST') {
    if (!hasPermission(context.actor, 'campaign:create')) return forbidden(res, requestId, 'event_registration_forbidden');
    if (!checkCsrf(req, context)) return csrfFailure(res, requestId);
    const body = await readJson(req);
    const event = repository.findEvent(decodeURIComponent(eventRegistrationMatch[1]));
    if (!event || event.tenantId !== context.actor.tenantId || !context.actor.storeIds.includes(event.storeId)) return notFound(res, requestId);
    const result = await repository.registerEvent({ tenantId: context.actor.tenantId, eventId: event.id, memberId: typeof body.member_id === 'string' ? body.member_id : null, contactHmac: typeof body.contact_hmac === 'string' ? body.contact_hmac : null });
    if (!result.registration) { sendJson(res, 409, { error_code: result.errorCode || 'registration_rejected', message: '报名失败 / Registration rejected', retryable: false }); return; }
    sendJson(res, 200, { registration: result.registration, counts: { registered: repository.findEvent(event.id)?.registrationCount || 0, checked_in: repository.findEvent(event.id)?.checkinCount || 0 } });
    return;
  }

  const eventCheckinMatch = pathname.match(/^\/api\/events\/([^/]+)\/checkins$/);
  if (eventCheckinMatch && method === 'POST') {
    if (!hasPermission(context.actor, 'campaign:create') && context.actor.role !== 'CASHIER') return forbidden(res, requestId, 'event_checkin_forbidden');
    if (!checkCsrf(req, context)) return csrfFailure(res, requestId);
    const body = await readJson(req);
    const event = repository.findEvent(decodeURIComponent(eventCheckinMatch[1]));
    if (!event || event.tenantId !== context.actor.tenantId || !context.actor.storeIds.includes(event.storeId)) return notFound(res, requestId);
    const result = await repository.checkinEvent({ tenantId: context.actor.tenantId, eventId: event.id, memberId: typeof body.member_id === 'string' ? body.member_id : null, registrationId: typeof body.registration_id === 'string' ? body.registration_id : null, checkedInBy: context.actor.userId, method: body.method === 'scan' ? 'scan' : 'staff_confirmed' });
    if (!result.checkin) { sendJson(res, 409, { error_code: result.errorCode || 'checkin_rejected', message: '签到失败 / Check-in rejected', retryable: false }); return; }
    sendJson(res, 200, { checkin: result.checkin, counts: { registered: event.registrationCount, checked_in: repository.findEvent(event.id)?.checkinCount || 0 } });
    return;
  }

  if (pathname === '/api/referrals' && method === 'POST') {
    if (!hasPermission(context.actor, 'campaign:create')) return forbidden(res, requestId, 'referral_write_forbidden');
    if (!checkCsrf(req, context)) return csrfFailure(res, requestId);
    const body = await readJson(req);
    const storeId = typeof body.store_id === 'string' ? body.store_id : '';
    if (!context.actor.storeIds.includes(storeId) || typeof body.inviter_member_id !== 'string' || typeof body.invitee_member_id !== 'string') return badRequest(res, requestId, 'referral_fields_required');
    try {
      const referral = await repository.createReferral({ tenantId: context.actor.tenantId, storeId, inviterMemberId: body.inviter_member_id, inviteeMemberId: body.invitee_member_id, sourceLinkId: typeof body.source_link_id === 'string' ? body.source_link_id : null });
      const reward = repository.listRewards(context.actor.tenantId).find((item) => item.referralId === referral.id);
      sendJson(res, 201, { item: referral, reward_status: reward?.status || 'pending_review' });
    } catch (error) {
      const code = error instanceof Error ? error.message : 'referral_rejected';
      sendJson(res, 409, { error_code: code, message: '推荐关系不符合规则 / Referral rejected', retryable: false });
    }
    return;
  }

  if (pathname === '/api/referrals' && method === 'GET') {
    if (!hasPermission(context.actor, 'campaign:read')) return forbidden(res, requestId, 'referral_read_forbidden');
    sendJson(res, 200, { items: repository.listReferrals(context.actor.tenantId, context.actor.storeIds), rewards: repository.listRewards(context.actor.tenantId, context.actor.storeIds) });
    return;
  }

  const referralEvaluateMatch = pathname.match(/^\/api\/referrals\/([^/]+)\/evaluate$/);
  if (referralEvaluateMatch && method === 'POST') {
    if (!hasPermission(context.actor, 'campaign:create')) return forbidden(res, requestId, 'referral_write_forbidden');
    if (!checkCsrf(req, context)) return csrfFailure(res, requestId);
    const referral = repository.snapshot().referrals.find((item) => item.id === decodeURIComponent(referralEvaluateMatch[1]));
    if (!referral || referral.tenantId !== context.actor.tenantId || !context.actor.storeIds.includes(referral.storeId)) return notFound(res, requestId);
    const result = await repository.evaluateReferral(referral.id);
    if (!result.referral) { sendJson(res, 404, { error_code: result.errorCode || 'referral_not_found', message: '推荐不存在', retryable: false }); return; }
    sendJson(res, 200, { referral: result.referral, reward: result.reward });
    return;
  }

  const rewardApproveMatch = pathname.match(/^\/api\/rewards\/([^/]+)\/approve$/);
  if (rewardApproveMatch && method === 'POST') {
    if (!hasBrandPermission(context.actor, 'brand:approve')) return forbidden(res, requestId, 'reward_approval_forbidden');
    if (!checkCsrf(req, context)) return csrfFailure(res, requestId);
    const body = await readJson(req);
    const rewardId = decodeURIComponent(rewardApproveMatch[1]);
    const rewardState = repository.snapshot();
    const rewardRecord = rewardState.rewardLedger.find((item) => item.id === rewardId);
    const rewardReferral = rewardRecord ? rewardState.referrals.find((item) => item.id === rewardRecord.referralId) : undefined;
    if (!rewardRecord || rewardRecord.tenantId !== context.actor.tenantId || !rewardReferral || !context.actor.storeIds.includes(rewardReferral.storeId)) return notFound(res, requestId);
    try {
      const reward = await repository.approveReward(rewardId, context.actor.userId, Number.isSafeInteger(body.amount_minor) ? body.amount_minor : null);
      sendJson(res, 200, { item: reward, payment: 'not_automated' });
    } catch (error) {
      const code = error instanceof Error ? error.message : 'reward_approval_failed';
      sendJson(res, 409, { error_code: code, message: '奖励需要人工核验，当前不能支付', retryable: false });
    }
    return;
  }

  // ----- Brand Brain / menu / asset slice (G01) -----
  if (pathname === '/api/brand/overview' && method === 'GET') {
    if (!hasBrandPermission(context.actor, 'brand:read')) return forbidden(res, requestId, 'brand_read_forbidden');
    const state = repository.snapshot();
    const documents = state.brandDocuments.filter((item) => item.tenantId === context.actor.tenantId && (!item.storeId || context.actor.storeIds.includes(item.storeId)));
    const revisions = state.brandRevisions.filter((item) => item.tenantId === context.actor.tenantId && documents.some((doc) => doc.id === item.documentId));
    const facts = state.brandFacts.filter((item) => item.tenantId === context.actor.tenantId && revisions.some((revision) => revision.id === item.revisionId));
    const products = state.products.filter((item) => item.tenantId === context.actor.tenantId && context.actor.storeIds.includes(item.storeId));
    const assets = state.mediaAssets.filter((item) => item.tenantId === context.actor.tenantId && (!item.storeId || context.actor.storeIds.includes(item.storeId)));
    const needsInput = new Set<string>();
    if (!revisions.some((revision) => revision.status === 'approved')) needsInput.add('approved_brand_facts');
    if (!facts.some((fact) => fact.key.endsWith('store.launch_date') && fact.value)) needsInput.add('launch_date');
    if (!products.length) needsInput.add('menu_prices');
    if (!assets.some((asset) => asset.rightsStatus === 'approved')) needsInput.add('approved_assets');
    sendJson(res, 200, {
      needs_input: Array.from(needsInput),
      documents: documents.map(publicDocument),
      revisions: revisions.map(publicRevision),
      facts: facts.filter((fact) => fact.status === 'approved').map(publicFact),
      products: products.map(publicProduct),
      assets: assets.map(publicAsset),
      source_policy: 'approved_only_by_default'
    });
    return;
  }

  if (pathname === '/api/brand/documents' && method === 'POST') {
    if (!hasBrandPermission(context.actor, 'brand:write')) return forbidden(res, requestId, 'brand_write_forbidden');
    if (!checkCsrf(req, context)) return csrfFailure(res, requestId);
    const body = await readJson(req, 2_500_000);
    const sourceType = body.source_type as SourceType;
    if (!['form', 'markdown', 'txt', 'csv'].includes(sourceType)) return badRequest(res, requestId, 'invalid_source_type');
    const content = typeof body.content === 'string' ? body.content : '';
    if (!content.trim() || content.length > 2_000_000) return badRequest(res, requestId, 'invalid_brand_content');
    const storeId = body.store_id === null || body.store_id === undefined ? null : String(body.store_id);
    if (storeId && !context.actor.storeIds.includes(storeId)) return notFound(res, requestId);
    const checksum = createHash('sha256').update(content).digest('hex');
    const conflictKeys = Array.isArray(body.conflict_keys) ? body.conflict_keys.filter((item: unknown): item is string => typeof item === 'string') : [];
    const result = await repository.createBrandDocument({
      tenantId: context.actor.tenantId, storeId, sourceType, sourceLabel: typeof body.source_label === 'string' ? body.source_label : 'operator_input',
      sourceUri: typeof body.source_uri === 'string' ? body.source_uri : null, checksum, createdBy: context.actor.userId, content,
      effectiveFrom: timestampInput(body.effective_from, 'effective_from', null),
      effectiveTo: timestampInput(body.effective_to, 'effective_to', null), conflictKeys
    });
    await repository.audit({ tenantId: context.actor.tenantId, storeId, actorUserId: context.actor.userId, action: 'brand.document.created', resourceType: 'brand_revision', resourceId: result.revision.id, metadata: { status: result.revision.status, checksum } });
    sendJson(res, 201, { document: publicDocument(result.document), revision: publicRevision(result.revision), facts: result.facts.map(publicFact) });
    return;
  }

  const brandApproveMatch = pathname.match(/^\/api\/brand\/revisions\/([^/]+)\/approve$/);
  if (brandApproveMatch && method === 'POST') {
    if (!hasBrandPermission(context.actor, 'brand:approve')) return forbidden(res, requestId, 'brand_approval_forbidden');
    if (!checkCsrf(req, context)) return csrfFailure(res, requestId);
    const revision = repository.findBrandRevision(decodeURIComponent(brandApproveMatch[1]));
    if (!revision || revision.tenantId !== context.actor.tenantId) return notFound(res, requestId);
    const document = repository.findBrandDocument(revision.documentId);
    if (document?.storeId && !context.actor.storeIds.includes(document.storeId)) return notFound(res, requestId);
    try {
      const approved = await repository.approveBrandRevision(revision.id, context.actor.userId);
      await repository.audit({ tenantId: context.actor.tenantId, storeId: null, actorUserId: context.actor.userId, action: 'brand.revision.approved', resourceType: 'brand_revision', resourceId: approved.id, metadata: { version: approved.version } });
      sendJson(res, 200, { revision: publicRevision(approved), approval: { status: 'approved', approved_by: context.actor.userId, approved_at: approved.approvedAt } });
    } catch (error) {
      const code = error instanceof Error ? error.message : 'brand_approval_failed';
      const status = code === 'brand_revision_not_found' ? 404 : 409;
      sendJson(res, status, { error_code: code, message: '品牌版本不能批准 / Brand revision cannot be approved', retryable: false, request_id: requestId });
    }
    return;
  }

  if (pathname === '/api/brand/facts' && method === 'GET') {
    const includeUnapproved = parsed.searchParams.get('include_unapproved') === '1';
    if (includeUnapproved && !hasBrandPermission(context.actor, 'brand:approve')) return forbidden(res, requestId, 'brand_unapproved_read_forbidden');
    const facts = repository.listBrandFacts(context.actor.tenantId, !includeUnapproved).filter((fact) => {
      const revision = repository.findBrandRevision(fact.revisionId);
      if (!revision) return false;
      const document = repository.findBrandDocument(revision.documentId);
      return !document?.storeId || context.actor.storeIds.includes(document.storeId);
    });
    sendJson(res, 200, { items: facts.map(publicFact), approved_only: !includeUnapproved });
    return;
  }

  if (pathname === '/api/products' && method === 'GET') {
    if (!hasBrandPermission(context.actor, 'brand:read')) return forbidden(res, requestId, 'product_read_forbidden');
    sendJson(res, 200, { items: repository.listProducts(context.actor.tenantId, context.actor.storeIds).map(publicProduct) });
    return;
  }

  if (pathname === '/api/products' && method === 'POST') {
    if (!hasBrandPermission(context.actor, 'product:write')) return forbidden(res, requestId, 'product_write_forbidden');
    if (!checkCsrf(req, context)) return csrfFailure(res, requestId);
    const body = await readJson(req);
    const storeId = typeof body.store_id === 'string' ? body.store_id : '';
    if (!context.actor.storeIds.includes(storeId) || repository.findStoreById(storeId)?.tenantId !== context.actor.tenantId) return notFound(res, requestId);
    const sku = typeof body.external_sku === 'string' ? body.external_sku.trim() : '';
    if (!sku) return badRequest(res, requestId, 'invalid_external_sku');
    const names = body.names && typeof body.names === 'object' && !Array.isArray(body.names) ? body.names : {};
    const needsInput: string[] = [];
    if (!Object.values(names).some((value) => typeof value === 'string' && value.trim())) needsInput.push('product_name');
    if (body.price_minor === undefined || body.price_minor === null) needsInput.push('price');
    const validFrom = timestampInput(body.valid_from, 'valid_from', nowIso());
    const validTo = timestampInput(body.valid_to, 'valid_to', null);
    requireTimeRange(validFrom, validTo, 'invalid_price_validity', true);
    const product = await repository.createProduct({ tenantId: context.actor.tenantId, storeId, externalSku: sku, names, status: body.status === 'inactive' ? 'inactive' : 'active', needsInput });
    if (Number.isSafeInteger(body.price_minor) && body.price_minor >= 0) {
      const price = await repository.addPriceVersion({ tenantId: context.actor.tenantId, productId: product.id, currency: typeof body.currency === 'string' ? body.currency : 'BDT', amountMinor: body.price_minor, validFrom, validTo, status: 'draft', sourceCitation: 'operator_input', createdBy: context.actor.userId });
      product.currentPriceVersionId = price.id;
    }
    sendJson(res, 201, { item: publicProduct(repository.findProduct(product.id) || product), needs_input: needsInput });
    return;
  }

  const productPriceMatch = pathname.match(/^\/api\/products\/([^/]+)\/prices$/);
  if (productPriceMatch && method === 'POST') {
    if (!hasBrandPermission(context.actor, 'product:write')) return forbidden(res, requestId, 'product_write_forbidden');
    if (!checkCsrf(req, context)) return csrfFailure(res, requestId);
    const product = repository.findProduct(decodeURIComponent(productPriceMatch[1]));
    if (!product || product.tenantId !== context.actor.tenantId || !context.actor.storeIds.includes(product.storeId)) return notFound(res, requestId);
    const body = await readJson(req);
    if (body.amount_minor !== null && (!Number.isSafeInteger(body.amount_minor) || body.amount_minor < 0)) return badRequest(res, requestId, 'invalid_price_minor');
    if (body.status === 'approved' && !hasBrandPermission(context.actor, 'brand:approve')) return forbidden(res, requestId, 'price_approval_forbidden');
    const price = await repository.addPriceVersion({ tenantId: context.actor.tenantId, productId: product.id, currency: typeof body.currency === 'string' ? body.currency : 'BDT', amountMinor: body.amount_minor ?? null, validFrom: timestampInput(body.valid_from, 'valid_from', nowIso()), validTo: timestampInput(body.valid_to, 'valid_to', null), status: body.status === 'approved' ? 'approved' : 'draft', sourceCitation: typeof body.source_citation === 'string' ? body.source_citation : 'operator_input', createdBy: context.actor.userId });
    await repository.audit({ tenantId: context.actor.tenantId, storeId: product.storeId, actorUserId: context.actor.userId, action: 'product.price_version.created', resourceType: 'price_version', resourceId: price.id, metadata: { version: price.version, amount_minor: price.amountMinor } });
    sendJson(res, 201, { item: price, stale_references: repository.snapshot().brandReferences.filter((item) => item.status === 'stale').map((item) => item.id) });
    return;
  }

  if (pathname === '/api/media-assets' && method === 'POST') {
    if (!hasBrandPermission(context.actor, 'asset:write')) return forbidden(res, requestId, 'asset_write_forbidden');
    if (!checkCsrf(req, context)) return csrfFailure(res, requestId);
    const body = await readJson(req);
    if (body.rights_status === 'approved' && !hasBrandPermission(context.actor, 'brand:approve')) return forbidden(res, requestId, 'asset_approval_forbidden');
    const storeId = body.store_id === null || body.store_id === undefined ? null : String(body.store_id);
    if (storeId && !context.actor.storeIds.includes(storeId)) return notFound(res, requestId);
    const storageKey = typeof body.storage_key === 'string' ? body.storage_key.trim() : '';
    const checksum = typeof body.checksum === 'string' ? body.checksum.trim() : '';
    if (!storageKey || !checksum) return badRequest(res, requestId, 'asset_checksum_required');
    const asset = await repository.createMediaAsset({ tenantId: context.actor.tenantId, storeId, storageKey, checksum, mimeType: typeof body.mime_type === 'string' ? body.mime_type : 'application/octet-stream', rightsStatus: ['approved', 'expired', 'rejected'].includes(body.rights_status) ? body.rights_status : 'unknown', allowedUses: Array.isArray(body.allowed_uses) ? body.allowed_uses.filter((item: unknown): item is string => typeof item === 'string') : [], expiresAt: timestampInput(body.expires_at, 'expires_at', null), sourceCitation: typeof body.source_citation === 'string' ? body.source_citation : null, createdBy: context.actor.userId });
    sendJson(res, 201, { item: publicAsset(asset) });
    return;
  }

  if (pathname === '/api/brand/references' && method === 'POST') {
    if (!hasBrandPermission(context.actor, 'brand:write')) return forbidden(res, requestId, 'brand_write_forbidden');
    if (!checkCsrf(req, context)) return csrfFailure(res, requestId);
    const body = await readJson(req);
    const storeId = typeof body.store_id === 'string' ? body.store_id : '';
    if (!context.actor.storeIds.includes(storeId)) return notFound(res, requestId);
    try {
      const reference = await repository.createBrandReference({ tenantId: context.actor.tenantId, storeId, resourceType: ['campaign', 'content', 'publication'].includes(body.resource_type) ? body.resource_type : 'campaign', resourceId: typeof body.resource_id === 'string' ? body.resource_id : '', productPriceRefs: Array.isArray(body.product_price_refs) ? body.product_price_refs.filter((item: any) => item && typeof item.product_id === 'string' && typeof item.price_version_id === 'string').map((item: any) => ({ productId: item.product_id, priceVersionId: item.price_version_id })) : [], brandRevisionIds: Array.isArray(body.brand_revision_ids) ? body.brand_revision_ids.filter((item: unknown): item is string => typeof item === 'string') : [] });
      sendJson(res, 201, { item: reference });
    } catch (error) { sendJson(res, 409, { error_code: error instanceof Error ? error.message : 'brand_reference_invalid', retryable: false, request_id: requestId }); }
    return;
  }

  const brandReferenceMatch = pathname.match(/^\/api\/brand\/references\/([^/]+)$/);
  if (brandReferenceMatch && method === 'GET') {
    const reference = repository.findBrandReference(decodeURIComponent(brandReferenceMatch[1]));
    if (!reference || reference.tenantId !== context.actor.tenantId || !context.actor.storeIds.includes(reference.storeId)) return notFound(res, requestId);
    sendJson(res, 200, { item: reference, executable: reference.status === 'valid' });
    return;
  }

  if (pathname === '/api/brand/publish-check' && method === 'POST') {
    if (!hasBrandPermission(context.actor, 'brand:read')) return forbidden(res, requestId, 'brand_read_forbidden');
    if (!checkCsrf(req, context)) return csrfFailure(res, requestId);
    const body = await readJson(req);
    const storeId = typeof body.store_id === 'string' ? body.store_id : '';
    if (!context.actor.storeIds.includes(storeId)) return notFound(res, requestId);
    const result = repository.publishCheck({ tenantId: context.actor.tenantId, storeId, productIds: Array.isArray(body.product_ids) ? body.product_ids.filter((item: unknown): item is string => typeof item === 'string') : [], assetIds: Array.isArray(body.asset_ids) ? body.asset_ids.filter((item: unknown): item is string => typeof item === 'string') : [], startAt: body.start_at ?? null, endAt: body.end_at ?? null });
    sendJson(res, result.ok ? 200 : 409, result);
    return;
  }

  // ----- POS/member staging and metric facts (G02) -----
  if (pathname === '/api/imports/preview' && method === 'POST') {
    if (!hasBrandPermission(context.actor, 'import:write')) return forbidden(res, requestId, 'import_write_forbidden');
    if (!checkCsrf(req, context)) return csrfFailure(res, requestId);
    const body = await readJson(req, 9_000_000);
    const kind = body.kind as ImportKind;
    if (!['orders', 'refunds', 'members'].includes(kind)) return badRequest(res, requestId, 'invalid_import_kind');
    const storeId = typeof body.store_id === 'string' ? body.store_id : '';
    if (!context.actor.storeIds.includes(storeId) || repository.findStoreById(storeId)?.tenantId !== context.actor.tenantId) return notFound(res, requestId);
    const content = typeof body.content === 'string' ? body.content : '';
    if (!content.trim() || content.length > 8_000_000) return badRequest(res, requestId, 'invalid_import_content');
    const source = typeof body.source === 'string' && body.source.trim() ? body.source.trim() : 'manual_csv';
    const fileHash = createHash('sha256').update(content).digest('hex');
    const parsed = kind === 'orders' ? parseOrdersCsv(content) : kind === 'refunds' ? parseRefundsCsv(content) : parseMembersCsv(content);
    const requiredHeaders = kind === 'orders' ? ['tenant_id', 'store_id', 'source', 'external_order_id', 'paid_at', 'currency', 'amount_paid_minor', 'status'] : kind === 'refunds' ? ['tenant_id', 'store_id', 'source', 'external_adjustment_id', 'external_order_id', 'occurred_at', 'amount_minor'] : ['tenant_id', 'store_id', 'id', 'registered_at'];
    if (requiredHeaders.some(header => !parsed.headers.includes(header)) || new Set(parsed.headers).size !== parsed.headers.length) return badRequest(res, requestId, 'invalid_import_headers');
    const completeThrough = typeof body.complete_through === 'string' && Number.isFinite(Date.parse(body.complete_through)) ? body.complete_through : null;
    const staged = await repository.stageImport({ tenantId: context.actor.tenantId, storeId, kind, source, fileName: typeof body.file_name === 'string' ? body.file_name : `${kind}.csv`, fileHash, completeThrough, createdBy: context.actor.userId, rows: parsed.rows });
    sendJson(res, 201, { import: publicImport(staged.batch), preview: { headers: parsed.headers, row_count: parsed.rows.length, valid_row_count: staged.batch.validRowCount, error_count: staged.errors.length, errors: staged.errors.slice(0, 200).map(publicImportError) }, idempotent_replay: staged.batch.createdAt !== staged.batch.committedAt && staged.batch.fileHash === fileHash });
    return;
  }

  const importCommitMatch = pathname.match(/^\/api\/imports\/([^/]+)\/commit$/);
  if (importCommitMatch && method === 'POST') {
    if (!hasBrandPermission(context.actor, 'import:write')) return forbidden(res, requestId, 'import_write_forbidden');
    if (!checkCsrf(req, context)) return csrfFailure(res, requestId);
    const batch = repository.findImport(decodeURIComponent(importCommitMatch[1]));
    if (!batch || batch.tenantId !== context.actor.tenantId || !context.actor.storeIds.includes(batch.storeId)) return notFound(res, requestId);
    try {
      const result = await repository.commitImport(batch.id);
      await repository.audit({ tenantId: context.actor.tenantId, storeId: batch.storeId, actorUserId: context.actor.userId, action: 'import.committed', resourceType: 'import', resourceId: batch.id, metadata: { inserted: result.inserted, deduplicated: result.deduplicated, corrections: result.corrections, rejected: result.rejected.length } });
      sendJson(res, 200, { import: publicImport(result.batch), reconciliation: { ...repository.importReconciliation(batch.id), inserted: result.inserted, deduplicated: result.deduplicated, corrections: result.corrections, rejected: result.rejected.map(publicImportError) } });
    } catch (error) {
      const code = error instanceof Error ? error.message : 'import_commit_failed';
      sendJson(res, code === 'import_not_found' ? 404 : 409, { error_code: code, message: '导入无法提交 / Import cannot be committed', retryable: false, request_id: requestId });
    }
    return;
  }

  const importReconcileMatch = pathname.match(/^\/api\/imports\/([^/]+)\/reconciliation$/);
  if (importReconcileMatch && method === 'GET') {
    const batch = repository.findImport(decodeURIComponent(importReconcileMatch[1]));
    if (!batch || batch.tenantId !== context.actor.tenantId || !context.actor.storeIds.includes(batch.storeId)) return notFound(res, requestId);
    sendJson(res, 200, repository.importReconciliation(batch.id));
    return;
  }

  if (pathname === '/api/imports' && method === 'GET') {
    if (!hasBrandPermission(context.actor, 'brand:read')) return forbidden(res, requestId, 'import_read_forbidden');
    sendJson(res, 200, { items: repository.listImports(context.actor.tenantId, context.actor.storeIds).map(publicImport) });
    return;
  }

  if (pathname === '/api/attribution/evidence' && method === 'POST') {
    if (!hasBrandPermission(context.actor, 'import:write')) return forbidden(res, requestId, 'attribution_write_forbidden');
    if (!checkCsrf(req, context)) return csrfFailure(res, requestId);
    const body = await readJson(req);
    const storeId = typeof body.store_id === 'string' ? body.store_id : '';
    if (!context.actor.storeIds.includes(storeId)) return notFound(res, requestId);
    if ((!body.order_id && typeof body.order_external_id !== 'string') || typeof body.campaign_id !== 'string' || !body.campaign_id.trim() || !['verified_coupon', 'linked_first_party_touch', 'declared_source'].includes(body.method)) return badRequest(res, requestId, 'invalid_attribution_evidence');
    const occurredAt = timestampInput(body.occurred_at, 'occurred_at', nowIso());
    const evidence = await repository.addAttributionEvidence({ tenantId: context.actor.tenantId, storeId, orderExternalId: body.order_external_id, orderSource: body.order_source, orderId: body.order_id, campaignId: body.campaign_id, method: body.method, occurredAt });
    sendJson(res, 201, { item: evidence });
    return;
  }

  if (pathname === '/api/campaigns' && method === 'GET') {
    if (!hasPermission(context.actor, 'campaign:read')) return forbidden(res, requestId, 'campaign_read_forbidden');
    const requestedStore = parsed.searchParams.get('store_id');
    const storeIds = requestedStore ? [requestedStore] : context.actor.storeIds;
    if (requestedStore && !context.actor.storeIds.includes(requestedStore)) return notFound(res, requestId);
    const items = repository.listCampaigns(context.actor.tenantId, storeIds).map(publicCampaign);
    sendJson(res, 200, { items, scope: { tenant_id: context.actor.tenantId, store_ids: storeIds } });
    return;
  }

  if (pathname === '/api/campaigns' && method === 'POST') {
    if (!hasPermission(context.actor, 'campaign:create')) return forbidden(res, requestId, 'campaign_create_forbidden');
    if (!checkCsrf(req, context)) return csrfFailure(res, requestId);
    const body = await readJson(req);
    const storeId = typeof body.store_id === 'string' ? body.store_id : '';
    const store = repository.findStoreById(storeId);
    if (!store || store.tenantId !== context.actor.tenantId || !context.actor.storeIds.includes(store.id)) return notFound(res, requestId);
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name || name.length > 160) return badRequest(res, requestId, 'invalid_campaign_name');
    const objective = typeof body.objective === 'string' && body.objective.trim() ? body.objective.trim() : null;
    const budget = body.budget_minor === undefined || body.budget_minor === null ? null : body.budget_minor;
    if (budget !== null && (!Number.isSafeInteger(budget) || budget < 0)) return badRequest(res, requestId, 'invalid_budget_minor');
    const startAt = timestampInput(body.start_at, 'start_at', null);
    const endAt = timestampInput(body.end_at, 'end_at', null);
    const productIds = Array.isArray(body.product_ids) ? body.product_ids.filter((item: unknown): item is string => typeof item === 'string') : [];
    const assetIds = Array.isArray(body.asset_ids) ? body.asset_ids.filter((item: unknown): item is string => typeof item === 'string') : [];
    const needsInput = [] as string[];
    if (!objective) needsInput.push('objective');
    const campaign = await repository.createCampaign({
      tenantId: context.actor.tenantId,
      storeId,
      name,
      objective,
      budgetMinor: budget,
      startAt,
      endAt,
      productIds,
      assetIds,
      status: needsInput.length ? 'needs_input' : 'draft',
      needsInput,
      createdBy: context.actor.userId
    });
    await repository.audit({ tenantId: context.actor.tenantId, storeId, actorUserId: context.actor.userId, action: 'campaign.created', resourceType: 'campaign', resourceId: campaign.id, metadata: { revision: campaign.revision } });
    sendJson(res, 201, { item: publicCampaign(campaign) });
    return;
  }

  const campaignMatch = pathname.match(/^\/api\/campaigns\/([^/]+)$/);
  if (campaignMatch) {
    const campaignId = decodeURIComponent(campaignMatch[1]);
    const campaign = repository.findCampaign(campaignId);
    if (!campaign || campaign.tenantId !== context.actor.tenantId || !context.actor.storeIds.includes(campaign.storeId)) return notFound(res, requestId);
    if (method === 'GET') {
      if (!hasPermission(context.actor, 'campaign:read')) return forbidden(res, requestId, 'campaign_read_forbidden');
      sendJson(res, 200, { item: publicCampaign(campaign) });
      return;
    }
    if (method === 'PATCH' || method === 'PUT') {
      if (!checkCsrf(req, context)) return csrfFailure(res, requestId);
      const body = await readJson(req);
      if (Object.prototype.hasOwnProperty.call(body, 'budget_minor') && !hasPermission(context.actor, 'campaign:edit_budget')) return forbidden(res, requestId, 'budget_edit_forbidden');
      if (Object.prototype.hasOwnProperty.call(body, 'status') && body.status === 'approved' && !hasPermission(context.actor, 'campaign:approve')) return forbidden(res, requestId, 'campaign_approval_forbidden');
      const mutableFields = ['name', 'objective', 'start_at', 'end_at', 'product_ids', 'asset_ids', 'needs_input', 'status'];
      const nonStatusEdit = mutableFields.some((field) => field !== 'status' && Object.prototype.hasOwnProperty.call(body, field));
      if (nonStatusEdit && !hasPermission(context.actor, 'campaign:create')) return forbidden(res, requestId, 'campaign_edit_forbidden');
      if (Object.prototype.hasOwnProperty.call(body, 'status') && body.status !== 'approved' && !hasPermission(context.actor, 'campaign:create')) return forbidden(res, requestId, 'campaign_status_edit_forbidden');
      const patch: Partial<Pick<Campaign, 'name' | 'objective' | 'budgetMinor' | 'status' | 'needsInput' | 'startAt' | 'endAt' | 'productIds' | 'assetIds'>> = {};
      if (body.name !== undefined) { if (typeof body.name !== 'string' || !body.name.trim()) return badRequest(res, requestId, 'invalid_campaign_name'); patch.name = body.name.trim(); }
      if (body.objective !== undefined) { if (body.objective !== null && typeof body.objective !== 'string') return badRequest(res, requestId, 'invalid_objective'); patch.objective = body.objective; }
      if (body.budget_minor !== undefined) { if (body.budget_minor !== null && (!Number.isSafeInteger(body.budget_minor) || body.budget_minor < 0)) return badRequest(res, requestId, 'invalid_budget_minor'); patch.budgetMinor = body.budget_minor; }
      if (body.status !== undefined) { if (!['draft', 'needs_input', 'pending_approval', 'approved', 'archived'].includes(body.status)) return badRequest(res, requestId, 'invalid_campaign_status'); patch.status = body.status; }
      if (body.start_at !== undefined) patch.startAt = timestampInput(body.start_at, 'start_at', null);
      if (body.end_at !== undefined) patch.endAt = timestampInput(body.end_at, 'end_at', null);
      if (body.product_ids !== undefined) patch.productIds = Array.isArray(body.product_ids) ? body.product_ids.filter((item: unknown): item is string => typeof item === 'string') : [];
      if (body.asset_ids !== undefined) patch.assetIds = Array.isArray(body.asset_ids) ? body.asset_ids.filter((item: unknown): item is string => typeof item === 'string') : [];
      const needsInput = patch.objective === null ? ['objective'] : patch.objective ? [] : campaign.needsInput;
      if (body.needs_input !== undefined && Array.isArray(body.needs_input)) patch.needsInput = body.needs_input.filter((item: unknown): item is string => typeof item === 'string');
      else if (patch.objective !== undefined) patch.needsInput = needsInput;
      const finalObjective = patch.objective !== undefined ? patch.objective : campaign.objective;
      const finalNeedsInput = new Set(patch.needsInput ?? campaign.needsInput);
      if (!finalObjective?.trim()) finalNeedsInput.add('objective');
      patch.needsInput = Array.from(finalNeedsInput);
      if (patch.status === 'approved' && patch.needsInput.length) return badRequest(res, requestId, 'campaign_needs_input');
      if (patch.status === undefined && campaign.status === 'needs_input' && patch.needsInput.length === 0) patch.status = 'draft';
      const updated = await repository.updateCampaign(campaign.id, patch);
      await repository.audit({ tenantId: context.actor.tenantId, storeId: campaign.storeId, actorUserId: context.actor.userId, action: 'campaign.updated', resourceType: 'campaign', resourceId: campaign.id, metadata: { revision: updated?.revision || campaign.revision } });
      sendJson(res, 200, { item: publicCampaign(updated || campaign), approval_invalidated: campaign.revision !== (updated?.revision || campaign.revision) });
      return;
    }
  }

  if (pathname === '/api/exports/members' && method === 'GET') {
    if (!hasPermission(context.actor, 'member:export')) return forbidden(res, requestId, 'member_export_forbidden');
    const outreachId = parsed.searchParams.get('outreach_id');
    if (outreachId) {
      const outreach = repository.findOutreachCampaign(outreachId);
      if (!outreach || outreach.tenantId !== context.actor.tenantId || !context.actor.storeIds.includes(outreach.storeId)) return notFound(res, requestId);
      try {
        const result = repository.outreachExportPreview({ outreachId: outreach.id, tenantId: context.actor.tenantId, storeId: outreach.storeId, now: config.mode === 'test' ? (parsed.searchParams.get('now') || undefined) : undefined });
        const eligible = result.items.filter((item) => item.status === 'eligible');
        sendJson(res, 200, { status: 'manual_ready', outreach_id: outreach.id, items: eligible.map((item) => ({ member_ref: hashToken(item.memberId, config.sessionSecret).slice(0, 16), assignment: item.assignment })), blocked_count: result.blockedCount, contact_fields_included: false, policy_enforced: true });
      } catch (error) {
        const code = error instanceof Error ? error.message : 'outreach_export_blocked';
        sendJson(res, 409, { error_code: code, message: '人工导出仍受触达政策约束 / Manual export is policy constrained', retryable: false, request_id: requestId });
      }
      return;
    }
    sendJson(res, 200, { status: 'not_implemented', message: '会员导出需要明确的受众审批；当前没有联系人明文导出。', items: [] });
    return;
  }

  if (pathname === '/api/integrations' && method === 'GET') {
    if (!hasPermission(context.actor, 'integration:manage')) return forbidden(res, requestId, 'integration_manage_forbidden');
    sendJson(res, 200, { connectors: connectorSnapshot(config) });
    return;
  }

  if (pathname === '/api/metrics' && method === 'GET') {
    if (!hasPermission(context.actor, 'report:read')) return forbidden(res, requestId, 'report_read_forbidden');
    const storeId = parsed.searchParams.get('store_id');
    if (storeId && !context.actor.storeIds.includes(storeId)) return notFound(res, requestId);
    const asOf = parsed.searchParams.get('as_of') || nowIso();
    const { storeIds, orders, bundle, imports, completeThrough, freshness, sourceCoverage } = calculateMetrics(repository.snapshot(), context.actor, storeId, asOf);
    const quality = freshness.quality;
    if (quality === 'missing') {
      sendJson(res, 200, { items: [], quality, missing_reason: freshness.missingReason, source_coverage: sourceCoverage, scope: { tenant_id: context.actor.tenantId, store_ids: storeIds } });
      return;
    }
    const sourceRefs = imports.map(item => ({ source_id: item.id, revision_id: item.id, kind: 'metric_snapshot', excerpt: `committed ${item.kind} import ${item.fileName}` }));
    const scope = { tenant_id: context.actor.tenantId, store_id: storeId || null, store_ids: storeIds };
    const periodStart = orders.map((item) => item.paidAt).sort()[0] || asOf;
    const contractItems = bundle.results.filter((item) => typeof item.value !== 'object' || item.value === null).map((item) => ({
      metric_key: item.metric_key,
      formula_version: item.formula_version,
      scope,
      period_start: periodStart,
      period_end: asOf,
      value: typeof item.value === 'number' ? item.value : null,
      unit: item.metric_key.includes('rate') || item.metric_key.includes('coverage') || item.metric_key.includes('share') ? 'ratio' : item.metric_key.includes('revenue') || item.metric_key.includes('value') || item.metric_key.includes('order_value') ? 'minor_units' : 'count',
      numerator: item.numerator ?? null,
      denominator: item.denominator ?? null,
      as_of: item.as_of,
      complete_through: completeThrough,
      quality,
      coverage: typeof item.coverage === 'object' && item.coverage ? (typeof item.coverage.identity_coverage === 'number' ? item.coverage.identity_coverage : null) : null,
      source_refs: sourceRefs,
      missing_reason: freshness.missingReason
    }));
    const attributionItems = Object.entries(bundle.summary.primary_attributed_revenue_minor as Record<string, number>).map(([campaignId, value]) => ({ metric_key: `primary_attributed_revenue_minor:${campaignId}`, formula_version: ATTRIBUTION_MODEL.version, attribution_model: ATTRIBUTION_MODEL, scope, period_start: periodStart, period_end: asOf, value, unit: 'minor_units', numerator: null, denominator: null, as_of: asOf, complete_through: completeThrough, quality, coverage: null, source_refs: sourceRefs, missing_reason: freshness.missingReason }));
    sendJson(res, 200, { items: [...contractItems, ...attributionItems], summary: { ...bundle.summary, scope, source_coverage: sourceCoverage, complete_through: completeThrough, quality, missing_reason: freshness.missingReason } });
    return;
  }

  if (pathname === '/api/jobs' && method === 'GET') {
    if (!hasPermission(context.actor, 'report:read')) return forbidden(res, requestId, 'job_read_forbidden');
    const tenantStores = repository.snapshot().stores.filter(s => s.tenantId === context.actor.tenantId).map(s => s.id);
    if (!tenantStores.every(id => context.actor.storeIds.includes(id))) { sendJson(res, 200, { items: [] }); return; }
    const items = repository.listJobs(context.actor.tenantId).map((job) => ({ id: job.id, type: job.type, status: job.status, attempts: job.attempts, updated_at: job.updatedAt }));
    sendJson(res, 200, { items });
    return;
  }

  sendJson(res, 404, { error_code: 'not_found', message: '资源不存在 / Not found', retryable: false, request_id: requestId });
}

async function authenticate(req: IncomingMessage, repository: JsonRepository, config: AppConfig): Promise<RequestContext | null> {
  const cookies = parseCookies(req.headers.cookie);
  const signed = cookies.adda_session;
  if (!signed) return null;
  const sessionId = verifyCookie(signed, config.sessionSecret);
  if (!sessionId) return null;
  const session = repository.findSession(sessionId);
  if (!session || session.revokedAt || Date.parse(session.expiresAt) <= Date.now()) return null;
  const user = repository.findUserById(session.userId);
  const tenant = repository.findTenantById(session.tenantId);
  if (!user || user.status !== 'active' || !tenant || tenant.status !== 'active') return null;
  const membership = repository.findMembership(session.tenantId, session.userId);
  if (!membership) return null;
  const activeStoreIds = membership.storeIds.filter((storeId) => { const store = repository.findStoreById(storeId); return Boolean(store && store.tenantId === session.tenantId && store.status === 'active'); });
  const actor = actorFromSession(session, membership.role, activeStoreIds);
  return { requestId: randomUUID(), actor, sessionId: session.id, csrfToken: session.csrfToken };
}

function checkCsrf(req: IncomingMessage, context: RequestContext): boolean {
  return req.headers['x-csrf-token'] === context.csrfToken;
}

function validLocalTime(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  return Boolean(match && Number(match[1]) < 24 && Number(match[2]) < 60);
}

async function readJson(req: IncomingMessage, maxBytes = MAX_BODY_BYTES): Promise<Record<string, any>> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > maxBytes) throw new Error('request_body_too_large');
    chunks.push(buffer);
  }
  if (!chunks.length) return {};
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid_json_body');
  return parsed as Record<string, any>;
}

function publicCampaign(campaign: Campaign): Record<string, unknown> {
  return {
    id: campaign.id,
    tenant_id: campaign.tenantId,
    store_id: campaign.storeId,
    name: campaign.name,
    objective: campaign.objective,
    budget_minor: campaign.budgetMinor,
    start_at: campaign.startAt || null,
    end_at: campaign.endAt || null,
    product_ids: campaign.productIds || [],
    asset_ids: campaign.assetIds || [],
    status: campaign.status,
    needs_input: campaign.needsInput,
    revision: campaign.revision,
    created_at: campaign.createdAt,
    updated_at: campaign.updatedAt
  };
}

function publicDocument(document: BrandDocument): Record<string, unknown> {
  return { id: document.id, tenant_id: document.tenantId, store_id: document.storeId, source_type: document.sourceType, source_label: document.sourceLabel, source_uri: document.sourceUri, checksum: document.checksum, created_by: document.createdBy, created_at: document.createdAt };
}

function publicRevision(revision: BrandRevision): Record<string, unknown> {
  return { id: revision.id, document_id: revision.documentId, tenant_id: revision.tenantId, version: revision.version, status: revision.status, effective_from: revision.effectiveFrom, effective_to: revision.effectiveTo, approved_by: revision.approvedBy, approved_at: revision.approvedAt, supersedes_id: revision.supersedesId, conflict_keys: revision.conflictKeys, created_at: revision.createdAt };
}

function publicFact(fact: any): Record<string, unknown> {
  return { id: fact.id, tenant_id: fact.tenantId, revision_id: fact.revisionId, key: fact.key, value: fact.value, value_type: fact.valueType, source_citation: fact.sourceCitation, status: fact.status, effective_from: fact.effectiveFrom, effective_to: fact.effectiveTo };
}

function publicProduct(product: any): Record<string, unknown> {
  return { id: product.id, tenant_id: product.tenantId, store_id: product.storeId, external_sku: product.externalSku, names: product.names, status: product.status, needs_input: product.needsInput, current_price_version_id: product.currentPriceVersionId, updated_at: product.updatedAt };
}

function publicAsset(asset: any): Record<string, unknown> {
  return { id: asset.id, tenant_id: asset.tenantId, store_id: asset.storeId, storage_key: asset.storageKey, checksum: asset.checksum, mime_type: asset.mimeType, rights_status: asset.rightsStatus, allowed_uses: asset.allowedUses, expires_at: asset.expiresAt, source_citation: asset.sourceCitation, created_at: asset.createdAt };
}

function publicSourceLink(link: SourceLink): Record<string, unknown> {
  return { id: link.id, tenant_id: link.tenantId, store_id: link.storeId, campaign_id: link.campaignId, label: link.label, channel: link.channel, variant: link.variant, status: link.status, created_at: link.createdAt };
}

function publicOffer(offer: any): Record<string, unknown> {
  return { id: offer.id, tenant_id: offer.tenantId, store_id: offer.storeId, campaign_id: offer.campaignId, name: offer.name, terms: offer.terms, valid_from: offer.validFrom, valid_to: offer.validTo, status: offer.status, max_redemptions: offer.maxRedemptions, issued_count: offer.issuedCount, created_at: offer.createdAt };
}

function publicCoupon(coupon: any): Record<string, unknown> {
  return { id: coupon.id, tenant_id: coupon.tenantId, store_id: coupon.storeId, offer_id: coupon.offerId, campaign_id: coupon.campaignId, member_id: coupon.memberId, status: coupon.status, issued_at: coupon.issuedAt, reserved_at: coupon.reservedAt, pos_order_ref: coupon.posOrderRef, order_source: coupon.posOrderSource ?? null, order_id: coupon.posOrderId ?? null, redeemed_at: coupon.redeemedAt };
}

function publicContentBrief(brief: any): Record<string, unknown> {
  return { id: brief.id, tenant_id: brief.tenantId, store_id: brief.storeId, campaign_id: brief.campaignId, target_metric: brief.targetMetric, content_pillar: brief.contentPillar, channel: brief.channel, product_ids: brief.productIds, asset_ids: brief.assetIds, source_link_id: brief.sourceLinkId, created_by: brief.createdBy, created_at: brief.createdAt };
}

function publicContentRevision(revision: any): Record<string, unknown> {
  return { id: revision.id, brief_id: revision.briefId, tenant_id: revision.tenantId, revision: revision.revision, status: revision.status, content_hash: revision.contentHash, generation_facts: revision.generationFacts || null, current_approval_id: revision.currentApprovalId || null, created_by: revision.createdBy, created_at: revision.createdAt, updated_at: revision.updatedAt, needs_input: revision.packageData?.needs_input || [], risk_flags: revision.packageData?.risk_flags || [] };
}

function publicContentApproval(approval: any): Record<string, unknown> {
  return { id: approval.id, resource_id: approval.resourceId, resource_revision_id: approval.resourceRevisionId, payload_hash: approval.payloadHash, audience_snapshot_id: approval.audienceSnapshotId, channel: approval.channel, language: approval.language, budget_minor: approval.budgetMinor, campaign_revision: approval.campaignRevision ?? null, brand_revision_ids: approval.brandRevisionIds ?? [], product_price_refs: approval.productPriceRefs ?? [], asset_ids: approval.assetIds ?? [], policy_version: approval.policyVersion, approved_by: approval.approvedBy, approved_at: approval.approvedAt, expires_at: approval.expiresAt, status: approval.status, created_at: approval.createdAt };
}

function publicPublicationIntent(intent: any): Record<string, unknown> {
  return { id: intent.id, tenant_id: intent.tenantId, store_id: intent.storeId, content_revision_id: intent.contentRevisionId, approval_id: intent.approvalId, payload_hash: intent.payloadHash, channel: intent.channel, mode: intent.mode, status: intent.status, created_by: intent.createdBy, created_at: intent.createdAt };
}

function publicSegmentDefinition(segment: any): Record<string, unknown> {
  return { id: segment.id, tenant_id: segment.tenantId, store_id: segment.storeId || null, name: segment.name, rule: segment.rule, version: segment.version, created_by: segment.createdBy, created_at: segment.createdAt };
}

function publicAudienceSnapshot(snapshot: any, secret: string): Record<string, unknown> {
  const treatment = snapshot.memberIds.filter((memberId: string) => snapshot.assignments[memberId] === 'treatment').length;
  const holdout = snapshot.memberIds.length - treatment;
  return {
    id: snapshot.id,
    tenant_id: snapshot.tenantId,
    segment_id: snapshot.segmentId,
    store_id: snapshot.storeId || null,
    assigned_count: snapshot.memberIds.length,
    treatment_count: treatment,
    holdout_count: holdout,
    holdout_percent: snapshot.holdoutPercent,
    seed_fingerprint: hashToken(snapshot.seed, secret).slice(0, 16),
    policy_hash: snapshot.policyHash,
    frozen_at: snapshot.frozenAt,
    as_of: snapshot.asOf || null,
    member_refs: snapshot.memberIds.slice(0, 10).map((memberId: string) => hashToken(memberId, secret).slice(0, 16)),
    member_ids_included: false,
    contact_fields_included: false
  };
}

function publicOutreachCampaign(campaign: any): Record<string, unknown> {
  return {
    id: campaign.id,
    tenant_id: campaign.tenantId,
    store_id: campaign.storeId,
    segment_id: campaign.segmentId,
    audience_snapshot_id: campaign.audienceSnapshotId,
    channel: campaign.channel,
    template_id: campaign.templateId,
    template_approved: campaign.templateApproved,
    budget_minor: campaign.budgetMinor,
    cost_per_attempt_minor: campaign.costPerAttemptMinor,
    quiet_start_local: campaign.quietStartLocal,
    quiet_end_local: campaign.quietEndLocal,
    frequency_cap_days: campaign.frequencyCapDays,
    status: campaign.status,
    policy_version: campaign.policyVersion,
    approval_hash: campaign.approvalHash,
    approved_by: campaign.approvedBy,
    approved_at: campaign.approvedAt,
    expires_at: campaign.expiresAt,
    created_by: campaign.createdBy,
    created_at: campaign.createdAt,
    // Do not echo message text into list/report responses by default.
    template_text_present: Boolean(campaign.templateText)
  };
}

function publicMessageAttempt(attempt: any): Record<string, unknown> {
  return { id: attempt.id, outreach_id: attempt.outreachId, member_ref: attempt.memberId, assignment: attempt.assignment, status: attempt.status, reason: attempt.reason, provider_reference: attempt.providerReference, dispatch_key: attempt.dispatchKey, retry_of_id: attempt.retryOfId, delivery_intent_id: attempt.deliveryIntentId, created_at: attempt.createdAt };
}

function publicFeedback(item: any): Record<string, unknown> {
  return { id: item.id, tenant_id: item.tenantId, store_id: item.storeId, source: item.source, source_ref: item.sourceRef, external_id: item.externalId, evidence_excerpt: item.evidenceExcerpt, received_at: item.receivedAt, customer_ref_present: Boolean(item.customerRefHash), member_ref: item.memberId ? hashToken(item.memberId, 'feedback-display').slice(0, 16) : null, tags: item.tags, risk: item.risk, risk_reasons: item.riskReasons, status: item.status, classification_version: item.classificationVersion, created_at: item.createdAt, updated_at: item.updatedAt };
}
function publicSupportCase(item: any): Record<string, unknown> {
  return { id: item.id, tenant_id: item.tenantId, store_id: item.storeId, feedback_id: item.feedbackId, owner_user_id: item.ownerUserId, sla_due_at: item.slaDueAt, status: item.status, escalation_level: item.escalationLevel, has_resolution_evidence: Boolean(item.resolutionEvidence), created_at: item.createdAt, updated_at: item.updatedAt };
}
function publicReplyRevision(item: any): Record<string, unknown> {
  return { id: item.id, case_id: item.caseId, revision: item.revision, channel: item.channel, body: item.body, body_hash: item.bodyHash, approval_hash: item.approvalHash, expires_at: item.expiresAt, status: item.status, created_by: item.createdBy, approved_by: item.approvedBy, approved_at: item.approvedAt, created_at: item.createdAt };
}
function publicVoiceTask(item: any): Record<string, unknown> {
  return { id: item.id, case_id: item.caseId, owner_user_id: item.ownerUserId, kind: item.kind, status: item.status, due_at: item.dueAt, evidence: item.evidence, created_at: item.createdAt, completed_at: item.completedAt };
}
function publicControlTask(item: any): Record<string, unknown> {
  return { id: item.id, store_ids: item.storeIds, owner_user_id: item.ownerUserId, title: item.title, due_at: item.dueAt, target_metric: item.targetMetric, budget_minor: item.budgetMinor, guardrails: item.guardrails, evidence_refs: item.evidenceRefs, status: item.status, completion_evidence: item.completionEvidence || null, created_at: item.createdAt };
}
function publicDailyReport(item: any): Record<string, unknown> {
  return { id: item.id, tenant_id: item.tenantId, store_id: item.storeId, store_ids: item.storeIds, version: item.version, as_of: item.asOf, complete_through: item.completeThrough, status: item.status, metrics: item.metrics, data_hash: item.dataHash, observations: item.observations, hypotheses: item.hypotheses, advice: item.advice, task_ids: item.taskIds, source_refs: item.sourceRefs, restated_from: item.restatedFrom, created_by: item.createdBy, created_at: item.createdAt };
}

async function readRawBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of req) { const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); length += buffer.length; if (length > MAX_BODY_BYTES) throw new Error('request_body_too_large'); chunks.push(buffer); }
  return Buffer.concat(chunks);
}

function verifyWebhookSignature(raw: Buffer, signature: string, secret: string): boolean {
  if (!/^sha256=[a-f0-9]{64}$/i.test(signature)) return false;
  const expected = createHmac('sha256', secret).update(raw).digest('hex');
  const provided = signature.slice('sha256='.length);
  const a = Buffer.from(provided, 'hex'); const b = Buffer.from(expected, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

function hashToken(token: string, secret: string): string {
  return createHmac('sha256', secret).update(token).digest('hex');
}

function hmacContact(contact: string, secret: string): string {
  return createHmac('sha256', secret).update(contact.trim().toLowerCase()).digest('hex');
}

function publicImport(batch: any): Record<string, unknown> {
  return { id: batch.id, tenant_id: batch.tenantId, store_id: batch.storeId, kind: batch.kind, source: batch.source, file_name: batch.fileName, file_hash: batch.fileHash, status: batch.status, row_count: batch.rowCount, valid_row_count: batch.validRowCount, error_count: batch.errorCount, complete_through: batch.completeThrough, created_by: batch.createdBy, created_at: batch.createdAt, committed_at: batch.committedAt };
}

function publicImportError(error: any): Record<string, unknown> {
  return { row_number: error.rowNumber, code: error.code, message: error.message };
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  if (res.headersSent) return;
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

function sendHtml(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

function badRequest(res: ServerResponse, requestId: string, code: string): void {
  sendJson(res, 400, { error_code: code, message: '请求参数无效 / Invalid request', retryable: false, request_id: requestId });
}

function forbidden(res: ServerResponse, requestId: string, code: string): void {
  sendJson(res, 403, { error_code: code, message: '当前角色或门店范围不允许此操作 / Forbidden', retryable: false, request_id: requestId });
}

function notFound(res: ServerResponse, requestId: string): void {
  sendJson(res, 404, { error_code: 'not_found', message: '资源不存在 / Not found', retryable: false, request_id: requestId });
}

function csrfFailure(res: ServerResponse, requestId: string): void {
  sendJson(res, 403, { error_code: 'csrf_failed', message: '请求校验失败 / CSRF check failed', retryable: false, request_id: requestId });
}

export async function startFromEnv(): Promise<void> {
  const app = await createAppServer();
  app.server.listen(app.config.port, app.config.host, () => {
    console.log(JSON.stringify({ service: 'adda-web', event: 'listening', host: app.config.host, port: app.config.port, mode: app.config.mode, started_at: nowIso() }));
  });
}

if (require.main === module) {
  startFromEnv().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
