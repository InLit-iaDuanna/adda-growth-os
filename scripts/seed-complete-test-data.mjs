/**
 * Build a complete, synthetic demo fixture without touching the running demo
 * database. The generated JSON uses the normal file-dev repository shape and
 * can be started with APP_MODE=demo plus the documented demo secret.
 */
import { createHash, createHmac } from 'node:crypto';
import { copyFile, mkdir, readFile, rm, writeFile, rename, stat } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { captureContentFacts, contentDigest, checkContentApproval } from '../dist/packages/domain/src/content-policy.js';
import { parseMembersCsv, parseOrdersCsv, parseRefundsCsv } from '../dist/packages/domain/src/imports.js';
import { calculateMetrics } from '../dist/packages/domain/src/metric-service.js';
import { queryMetrics } from '../dist/packages/domain/src/control-service.js';
import { runDeterministicRouter } from '../dist/packages/domain/src/control-runtime.js';
import { commandControlRun } from '../dist/packages/domain/src/control-runs.js';
import { outreachApprovalHash } from '../dist/packages/domain/src/outreach-policy.js';
import { canReadDailyReport } from '../dist/packages/domain/src/report-policy.js';
import assert from 'node:assert/strict';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.resolve(process.argv[2] || path.join(root, 'data', 'complete-demo.json'));
const artifactDir = path.resolve(process.argv[3] || (process.argv[2] ? path.join(path.dirname(output), 'test-data') : path.join(root, 'artifacts', 'test-data')));
const artifact = path.join(artifactDir, 'complete-demo.json');
// This public fixture key is deliberately fixed. Never serialize inherited secrets.
const secret = 'local-complete-test-secret-change-me';
if (process.env.APP_MODE && !['demo', 'test'].includes(process.env.APP_MODE)) throw new Error('refusing_fixture_in_production');
const now = new Date().toISOString();
const anchor = Date.parse(now);
const tenantId = 'ten_demo_01';
const storeId = 'sto_demo_01';
const ownerId = 'usr_demo_owner';
const managerId = 'usr_demo_manager';
const reviewerId = 'usr_demo_reviewer';
const cashierId = 'usr_demo_cashier';
const clientAssetRoot = '/Users/isduanna/Library/Containers/com.tencent.xinWeChat/Data/Documents/xwechat_files/wxid_mikuncc9wuyq22_7875/temp/RWTemp/2026-09/d445a808a812b7ee01fd9a8405448a20';

function iso(date) { return date.toISOString(); }
function daysFromNow(days) { return iso(new Date(anchor + days * 86_400_000)); }
function daysAgo(days) { return daysFromNow(-days); }
function hash(value) { return createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex'); }
function hmac(value) { return createHmac('sha256', secret).update(value).digest('hex'); }
function rowHash(value) { return hash(JSON.stringify(value)); }
function clone(value) { return JSON.parse(JSON.stringify(value)); }
async function assetChecksum(fileName, fallback) {
  try { return hash(await readFile(path.join(clientAssetRoot, fileName))); }
  catch { return hash(fallback); }
}

// Keep staged rows in the same shape as the normal import preview.  The
// fixture already contains a committed snapshot, but these rows make the CSV
// files useful for an independent preview/commit exercise as well.
function makeImportRows(kind, raws, importId) {
  return raws.map((raw, index) => {
    let value;
    if (kind === 'orders') value = {
      tenantId: raw.tenant_id, storeId: raw.store_id, source: raw.source,
      externalOrderId: raw.external_order_id, memberId: raw.member_id || null,
      paidAt: raw.paid_at, currency: raw.currency, amountPaidMinor: Number(raw.amount_paid_minor), status: raw.status
    };
    else if (kind === 'refunds') value = {
      tenantId: raw.tenant_id, storeId: raw.store_id, source: raw.source,
      externalAdjustmentId: raw.external_adjustment_id, externalOrderId: raw.external_order_id,
      occurredAt: raw.occurred_at, amountMinor: Number(raw.amount_minor)
    };
    else value = {
      tenantId: raw.tenant_id, storeId: raw.store_id, externalMemberId: raw.id,
      displayName: raw.display_name || null, registeredAt: raw.registered_at,
      language: raw.language || null, contact: raw.contact || null,
      isSynthetic: /^(true|1|yes)$/i.test(raw.is_synthetic || '')
    };
    return { id: `staged_${importId}_${index + 2}`, importId, rowNumber: index + 2, kind, raw, value, valid: true };
  });
}

function metric(id, metricKey, value, numerator, denominator, sourceRefs, recordRefs = { orders: [], refunds: [], members: [] }) {
  return { id, storeIds: [storeId], formulaVersion: 'metric-engine-v3-order-identity', missingReason: null,
    recordRefs, metricKey, value, numerator, denominator, asOf: now, completeThrough: now,
    quality: 'verified', sourceRefs, sourceCoverage: [{ storeId, source: 'pos_demo', completeThrough: now, status: 'complete' }] };
}

async function ensureFixtureTarget(file) {
  let current;
  try { current = JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (!current.auditEvents?.some(item => item.action === 'test_data.fixture_seeded') || current.tenants?.some(item => item.id !== tenantId || item.mode !== 'demo') || current.members?.some(item => !item.isSynthetic)) throw new Error('refusing_to_overwrite_non_fixture_database:' + file);
  try { await stat(file + '.lock'); throw new Error('fixture_database_is_locked:' + file); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
async function atomicWrite(file, content, mode = 0o600) {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}`;
  await writeFile(temp, content, { mode });
  await rename(temp, file);
}
await ensureFixtureTarget(output);
if (artifact !== output) await ensureFixtureTarget(artifact);
const tempSeed = path.join(root, 'data', `.complete-seed-${process.pid}.json`);
await mkdir(path.dirname(tempSeed), { recursive: true });
const seed = spawnSync(process.execPath, ['dist/scripts/seed-demo.js'], {
  cwd: root,
  env: {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    APP_MODE: 'demo',
    ADDA_DATA_FILE: tempSeed,
    SESSION_SECRET: secret,
    AI_PROVIDER: 'deterministic_offline',
    LIVE_EXTERNAL_WRITES: 'false'
  },
  encoding: 'utf8'
});
if (seed.status !== 0) throw new Error(`demo_seed_failed:${seed.stderr || seed.stdout || seed.error || ''}`);
const state = JSON.parse(await readFile(tempSeed, 'utf8'));
await rm(tempSeed, { force: true });
await rm(`${tempSeed}.lock`, { force: true });

state.sessions = [];
state.tenants = [{ ...state.tenants[0], name: 'ADDA DEMO — complete synthetic fixture' }];
state.stores = [{ ...state.stores[0], name: 'DU Gate — complete synthetic fixture', orderSources: ['pos_demo'] }];
state.externalWritesKillSwitch = true;
state.workerHeartbeatAt = null;
state.workerInstanceId = 'complete-fixture-not-running';
state.campaigns = [];
state.brandDocuments = [];
state.brandRevisions = [];
state.brandFacts = [];
state.products = [];
state.priceVersions = [];
state.mediaAssets = [];
state.brandReferences = [];
state.members = [];
state.orders = [];
state.refunds = [];
state.imports = [];
state.importErrors = [];
state.importRows = [];
state.sourceWatermarks = [];
state.attributionEvidence = [];
state.sourceLinks = [];
state.touchEvents = [];
state.consentEvents = [];
state.suppressionEntries = [];
state.offers = [];
state.issuedCoupons = [];
state.redemptionAttempts = [];
state.contentBriefs = [];
state.contentRevisions = [];
state.contentHistory = [];
state.contentApprovals = [];
state.publicationIntents = [];
state.publicationReceipts = [];
state.partners = [];
state.events = [];
state.eventRegistrations = [];
state.eventCheckins = [];
state.referrals = [];
state.rewardLedger = [];
state.segmentDefinitions = [];
state.audienceSnapshots = [];
state.outreachCampaigns = [];
state.messageAttempts = [];
state.feedback = [];
state.feedbackClassifications = [];
state.supportCases = [];
state.replyRevisions = [];
state.voiceTasks = [];
state.connectorStates = [];
state.deliveryIntents = [];
state.webhookEvents = [];
state.dailyReports = [];
state.controlTasks = [];
state.controlRuns = [];
state.auditEvents = [];
state.jobs = [];

const campaignId = 'camp_spring_wellness';
const campaignNeedsInputId = 'camp_exam_reset_needs_input';
const campaign = {
  id: campaignId, tenantId, storeId, name: 'Lotus Reset · 春日自然茶饮', objective: 'verified first orders', budgetMinor: 150000,
  startAt: daysAgo(30), endAt: daysFromNow(90), productIds: ['prod_tea_original', 'prod_lemon_mate', 'prod_matcha_cloud'],
  assetIds: ['asset_lotus_water', 'asset_suiwu_logo'], status: 'approved', needsInput: [], createdBy: ownerId, createdAt: daysAgo(28), updatedAt: daysAgo(2), revision: 2
};
state.campaigns.push(campaign, {
  id: campaignNeedsInputId, tenantId, storeId, name: 'Exam Reset · 待确认活动', objective: null, budgetMinor: null,
  startAt: null, endAt: null, productIds: [], assetIds: [], status: 'needs_input', needsInput: ['verified_event_date', 'approved_budget'], createdBy: managerId, createdAt: daysAgo(3), updatedAt: daysAgo(3), revision: 1
});

const brandContent = 'SUIWU 随物\nADDA TEA\nScience meets a more natural life\nLive in harmony with life';
state.brandDocuments.push({ id: 'brand_doc_suiwu_01', tenantId, storeId: null, sourceType: 'markdown', sourceLabel: '甲方品牌资料（合成测试）', sourceUri: 'fixture://brand/suiwu-adda', checksum: hash(brandContent), createdBy: ownerId, createdAt: daysAgo(32) });
state.brandRevisions.push({ id: 'brand_rev_suiwu_01', documentId: 'brand_doc_suiwu_01', tenantId, version: 1, status: 'approved', content: brandContent, effectiveFrom: daysAgo(32), effectiveTo: null, approvedBy: ownerId, approvedAt: daysAgo(30), supersedesId: null, conflictKeys: [], createdAt: daysAgo(32) });
state.brandFacts.push(
  { id: 'fact_brand_name', tenantId, revisionId: 'brand_rev_suiwu_01', key: 'brand_name', value: 'SUIWU 随物', valueType: 'text', sourceCitation: 'brand_doc_suiwu_01#brand_name', status: 'approved', effectiveFrom: daysAgo(32), effectiveTo: null },
  { id: 'fact_sub_brand', tenantId, revisionId: 'brand_rev_suiwu_01', key: 'sub_brand', value: 'ADDA TEA', valueType: 'text', sourceCitation: 'brand_doc_suiwu_01#sub_brand', status: 'approved', effectiveFrom: daysAgo(32), effectiveTo: null },
  { id: 'fact_slogan', tenantId, revisionId: 'brand_rev_suiwu_01', key: 'slogan', value: 'Science meets a more natural life', valueType: 'text', sourceCitation: 'brand_doc_suiwu_01#slogan', status: 'approved', effectiveFrom: daysAgo(32), effectiveTo: null },
  { id: 'fact_service_promise', tenantId, revisionId: 'brand_rev_suiwu_01', key: 'service_promise', value: '顺应生命，自在健康', valueType: 'text', sourceCitation: 'brand_doc_suiwu_01#service_promise', status: 'approved', effectiveFrom: daysAgo(32), effectiveTo: null }
);

const products = [
  ['prod_tea_original', 'ADDA Original Tea', 'ADDA 原味茶', 18000],
  ['prod_lemon_mate', 'Lemon Mate', '柠檬玛黛茶', 16000],
  ['prod_matcha_cloud', 'Matcha Cloud', '抹茶云朵', 22000]
];
for (const [id, en, zh, amountMinor] of products) {
  state.products.push({ id, tenantId, storeId, externalSku: `SKU-${id.slice(5).toUpperCase()}`, names: { en, 'zh-CN': zh, bn: en }, status: 'active', needsInput: [], currentPriceVersionId: `price_${id}_v1`, createdAt: daysAgo(28), updatedAt: daysAgo(25) });
  state.priceVersions.push({ id: `price_${id}_v1`, tenantId, productId: id, version: 1, currency: 'BDT', amountMinor, validFrom: daysAgo(28), validTo: null, status: 'approved', sourceCitation: `brand_rev_suiwu_01#price:${id}`, createdBy: ownerId, createdAt: daysAgo(28) });
}
state.mediaAssets.push(
  { id: 'asset_lotus_water', tenantId, storeId, storageKey: 'brand/4da38778134ae0fc6f4fb0046521903b.jpg', checksum: null, mimeType: 'image/jpeg', rightsStatus: 'approved', allowedUses: ['content', 'manual_publish', 'social'], expiresAt: null, sourceCitation: 'client-asset-fixture: lotus water ripple', createdBy: ownerId, createdAt: daysAgo(27) },
  { id: 'asset_suiwu_logo', tenantId, storeId: null, storageKey: 'brand/99b0b4ec1602cc2760ffed5944b53444.jpg', checksum: null, mimeType: 'image/jpeg', rightsStatus: 'approved', allowedUses: ['brand', 'content', 'manual_publish'], expiresAt: null, sourceCitation: 'client-asset-fixture: SUIWU lotus logo', createdBy: ownerId, createdAt: daysAgo(27) },
  { id: 'asset_needs_confirmation', tenantId, storeId, storageKey: 'brand/7846e5a3d39a673b230a47f52f4532ca.jpg', checksum: hash('asset_needs_confirmation'), mimeType: 'image/jpeg', rightsStatus: 'unknown', allowedUses: [], expiresAt: null, sourceCitation: null, createdBy: managerId, createdAt: daysAgo(2) }
);
state.mediaAssets.find((item) => item.id === 'asset_lotus_water').checksum = await assetChecksum('4da38778134ae0fc6f4fb0046521903b.jpg', 'asset_lotus_water');
state.mediaAssets.find((item) => item.id === 'asset_suiwu_logo').checksum = await assetChecksum('99b0b4ec1602cc2760ffed5944b53444.jpg', 'asset_suiwu_logo');
state.brandReferences.push({ id: 'brand_ref_campaign_01', tenantId, storeId, resourceType: 'campaign', resourceId: campaignId, productPriceRefs: products.map(([id]) => ({ productId: id, priceVersionId: `price_${id}_v1` })), brandRevisionIds: ['brand_rev_suiwu_01'], status: 'valid', createdAt: daysAgo(24), invalidatedAt: null, invalidationReason: null });

const rawSourceTokens = { instagram: 'src-instagram-adda-synthetic-2026', campus: 'src-campus-adda-synthetic-2026', staff: 'src-staff-adda-synthetic-2026' };
state.sourceLinks.push(
  { id: 'source_instagram_01', tenantId, storeId, campaignId, label: 'Instagram / Lotus Reset', channel: 'instagram', variant: 'reel-a', tokenHash: hmac(rawSourceTokens.instagram), createdBy: managerId, createdAt: daysAgo(23), status: 'active' },
  { id: 'source_campus_01', tenantId, storeId, campaignId, label: 'DU campus club / Lotus Reset', channel: 'campus', variant: 'club-a', tokenHash: hmac(rawSourceTokens.campus), createdBy: managerId, createdAt: daysAgo(23), status: 'active' },
  { id: 'source_staff_01', tenantId, storeId, campaignId, label: 'Staff manual attribution', channel: 'manual', variant: 'counter', tokenHash: hmac(rawSourceTokens.staff), createdBy: ownerId, createdAt: daysAgo(20), status: 'active' }
);

const memberTokens = { ana: 'member-token-ana-synthetic', rina: 'member-token-rina-synthetic', zara: 'member-token-zara-synthetic', noor: 'member-token-noor-synthetic', sami: 'member-token-sami-synthetic' };
const memberRows = [
  ['member_ana', 'm_ana_001', 'Ana Synthetic', 'ana.synthetic@example.invalid', 'en', 50, true],
  ['member_rina', 'm_rina_001', 'Rina Synthetic', 'rina.synthetic@example.invalid', 'bn', 70, true],
  ['member_zara', 'm_zara_001', 'Zara Synthetic', 'zara.synthetic@example.invalid', 'en', 40, true],
  ['member_noor', 'm_noor_001', 'Noor Synthetic', 'noor.synthetic@example.invalid', 'bn', 5, false],
  ['member_sami', 'm_sami_001', 'Sami Synthetic', 'sami.synthetic@example.invalid', 'en', 2, false]
];
for (const [id, externalMemberId, displayName, contact, language, registeredDaysAgo, verified] of memberRows) {
  state.members.push({ id, tenantId, storeId, externalMemberId, displayName, registeredAt: daysAgo(registeredDaysAgo), language, contact: null, contactHmac: hmac(contact), publicAccessTokenHash: hmac(memberTokens[id.slice(7)]), isSynthetic: true, contactVerified: verified, verificationProof: verified ? 'test_outbox' : null, verificationExpiresAt: verified ? daysFromNow(30) : null, createdAt: daysAgo(registeredDaysAgo) });
}
const consent = (id, memberId, channel, granted, days) => ({ id, tenantId, memberId, channel, purpose: 'marketing', granted, noticeVersion: 'adda-demo-v1', source: granted ? 'fixture_seed' : 'fixture_revoke', occurredAt: daysAgo(days) });
state.consentEvents.push(consent('consent_ana', 'member_ana', 'whatsapp', true, 59), consent('consent_rina', 'member_rina', 'whatsapp', true, 69), consent('consent_zara', 'member_zara', 'email', true, 39), consent('consent_sami', 'member_sami', 'whatsapp', true, 1), consent('consent_sami_revoke', 'member_sami', 'whatsapp', false, 0));
state.suppressionEntries.push({ id: 'suppression_sami', tenantId, memberId: 'member_sami', channel: 'whatsapp', purpose: 'marketing', reason: 'synthetic opt-out test', occurredAt: daysAgo(0) });

const orderRows = [
  { id: 'ord_ana_001', tenantId, storeId, source: 'pos_demo', externalOrderId: 'POS-1001', memberId: 'member_ana', paidAt: daysAgo(45), currency: 'BDT', amountPaidMinor: 18000, status: 'paid', revision: 1, active: true, correctionOfId: null },
  { id: 'ord_ana_002', tenantId, storeId, source: 'pos_demo', externalOrderId: 'POS-1002', memberId: 'member_ana', paidAt: daysAgo(25), currency: 'BDT', amountPaidMinor: 16000, status: 'paid', revision: 1, active: true, correctionOfId: null },
  { id: 'ord_rina_001', tenantId, storeId, source: 'pos_demo', externalOrderId: 'POS-1003', memberId: 'member_rina', paidAt: daysAgo(35), currency: 'BDT', amountPaidMinor: 22000, status: 'paid', revision: 1, active: true, correctionOfId: null },
  { id: 'ord_zara_001', tenantId, storeId, source: 'pos_demo', externalOrderId: 'POS-1004', memberId: 'member_zara', paidAt: daysAgo(10), currency: 'BDT', amountPaidMinor: 18000, status: 'paid', revision: 1, active: true, correctionOfId: null },
  { id: 'ord_guest_001', tenantId, storeId, source: 'pos_demo', externalOrderId: 'POS-1005', memberId: null, paidAt: daysAgo(3), currency: 'BDT', amountPaidMinor: 12000, status: 'paid', revision: 1, active: true, correctionOfId: null },
  { id: 'ord_void_001', tenantId, storeId, source: 'pos_demo', externalOrderId: 'POS-1006', memberId: 'member_sami', paidAt: daysAgo(2), currency: 'BDT', amountPaidMinor: 16000, status: 'void', revision: 1, active: true, correctionOfId: null }
];
state.orders = orderRows.map((row) => ({ ...row, sourceRowHash: rowHash(row), createdAt: row.paidAt, updatedAt: row.paidAt }));
state.refunds.push(
  { id: 'ref_ana_002_partial', tenantId, storeId, source: 'pos_demo', externalAdjustmentId: 'REF-2001', externalOrderId: 'POS-1002', occurredAt: daysAgo(20), amountMinor: 4000, sourceRowHash: rowHash(['REF-2001', 'POS-1002', 4000]), createdAt: daysAgo(20) },
  { id: 'ref_zara_full', tenantId, storeId, source: 'pos_demo', externalAdjustmentId: 'REF-2002', externalOrderId: 'POS-1004', occurredAt: daysAgo(5), amountMinor: 18000, sourceRowHash: rowHash(['REF-2002', 'POS-1004', 18000]), createdAt: daysAgo(5) }
);
const ordersImportId = 'import_orders_complete';
const refundsImportId = 'import_refunds_complete';
state.imports.push(
  { id: ordersImportId, tenantId, storeId, kind: 'orders', source: 'pos_demo', fileName: 'orders-complete.csv', fileHash: hash('orders-complete-fixture'), status: 'committed', rowCount: orderRows.length, validRowCount: orderRows.length, errorCount: 0, completeThrough: now, createdBy: ownerId, createdAt: daysAgo(1), committedAt: daysAgo(1) },
  { id: refundsImportId, tenantId, storeId, kind: 'refunds', source: 'pos_demo', fileName: 'refunds-complete.csv', fileHash: hash('refunds-complete-fixture'), status: 'committed', rowCount: 2, validRowCount: 2, errorCount: 0, completeThrough: now, createdBy: ownerId, createdAt: daysAgo(1), committedAt: daysAgo(1) }
);
state.sourceWatermarks.push({ tenantId, storeId, source: 'pos_demo', completeThrough: now, updatedAt: now, confirmed: true });
state.attributionEvidence.push(
  { id: 'attr_ana_001', tenantId, storeId, orderExternalId: 'POS-1001', orderSource: 'pos_demo', orderId: 'ord_ana_001', campaignId, method: 'verified_coupon', occurredAt: daysAgo(45) },
  { id: 'attr_ana_002', tenantId, storeId, orderExternalId: 'POS-1002', orderSource: 'pos_demo', orderId: 'ord_ana_002', campaignId, method: 'linked_first_party_touch', occurredAt: daysAgo(25) },
  { id: 'attr_rina_001', tenantId, storeId, orderExternalId: 'POS-1003', orderSource: 'pos_demo', orderId: 'ord_rina_001', campaignId, method: 'verified_coupon', occurredAt: daysAgo(35) }
);
state.touchEvents.push(
  { id: 'touch_view_01', tenantId, storeId, sourceLinkId: 'source_instagram_01', eventType: 'view', sessionTokenHash: hmac('touch-view-01'), occurredAt: daysAgo(52) },
  { id: 'touch_click_01', tenantId, storeId, sourceLinkId: 'source_instagram_01', eventType: 'click', sessionTokenHash: hmac('touch-click-01'), occurredAt: daysAgo(51) },
  { id: 'touch_register_01', tenantId, storeId, sourceLinkId: 'source_instagram_01', eventType: 'member_register', sessionTokenHash: hmac('touch-register-01'), occurredAt: daysAgo(50) },
  { id: 'touch_coupon_01', tenantId, storeId, sourceLinkId: 'source_campus_01', eventType: 'coupon_issue', sessionTokenHash: hmac('touch-coupon-01'), occurredAt: daysAgo(35) }
);

const offerId = 'offer_first_cup_01';
const couponTokenFor = (memberId) => createHmac('sha256', secret).update(JSON.stringify(['coupon-v2', tenantId, storeId, offerId, memberId])).digest('base64url');
state.offers.push({ id: offerId, tenantId, storeId, campaignId, name: '[测试] First cup BDT 40 off', terms: 'Synthetic fixture only. First verified order; POS order match required.', validFrom: daysAgo(60), validTo: daysFromNow(30), status: 'active', maxRedemptions: 100, issuedCount: 3, createdBy: ownerId, createdAt: daysAgo(22) });
state.issuedCoupons.push(
  { id: 'coupon_ana_001', tenantId, storeId, offerId, campaignId, memberId: 'member_ana', sourceLinkId: 'source_instagram_01', tokenHash: hmac(couponTokenFor('member_ana')), status: 'redeemed', issuedAt: daysAgo(45), reservedAt: daysAgo(45), posOrderRef: 'POS-1001', posOrderSource: 'pos_demo', posOrderId: 'ord_ana_001', redeemedAt: daysAgo(45), reversedAt: null },
  { id: 'coupon_rina_001', tenantId, storeId, offerId, campaignId, memberId: 'member_rina', sourceLinkId: 'source_campus_01', tokenHash: hmac(couponTokenFor('member_rina')), status: 'pending_pos_verification', issuedAt: daysAgo(35), reservedAt: daysAgo(35), posOrderRef: 'POS-1003', posOrderSource: 'pos_demo', posOrderId: null, redeemedAt: null, reversedAt: null },
  { id: 'coupon_noor_001', tenantId, storeId, offerId, campaignId, memberId: 'member_noor', sourceLinkId: 'source_instagram_01', tokenHash: hmac(couponTokenFor('member_noor')), status: 'issued', issuedAt: daysAgo(1), reservedAt: null, posOrderRef: null, posOrderSource: null, posOrderId: null, redeemedAt: null, reversedAt: null }
);
state.redemptionAttempts.push(
  { id: 'redemption_ana_001', tenantId, storeId, couponId: 'coupon_ana_001', employeeUserId: cashierId, posOrderRef: 'POS-1001', posOrderSource: 'pos_demo', posOrderId: 'ord_ana_001', status: 'matched', errorCode: null, createdAt: daysAgo(45) },
  { id: 'redemption_rina_001', tenantId, storeId, couponId: 'coupon_rina_001', employeeUserId: cashierId, posOrderRef: 'POS-1003', posOrderSource: 'pos_demo', posOrderId: null, status: 'reserved', errorCode: null, createdAt: daysAgo(35) }
);

function contentPackage(briefId, revisionId, approved, productRefs, assetIds, sourceLinkId) {
  const packageData = {
    brief_id: briefId, campaign_id: campaignId, brand_revision_id: 'brand_rev_suiwu_01', target_metric: 'verified_first_orders', content_pillar: approved ? 'natural reset' : 'exam reset', channel: 'manual', product_refs: productRefs,
    hook_variants: ['A softer reset for your study break.', '把自然带回学习间隙。'],
    shot_list: [{ index: 1, duration_seconds: 5, visual: 'Lotus water ripple with approved product packshot.', spoken_line: 'A calmer cup for the next chapter.', onscreen_text: 'Science meets a more natural life', rights_needed: ['asset_use_approved'] }],
    operator_notes_zh: '仅使用已批准品牌事实、产品价格与甲方素材；孟语版本必须由本地复核人确认。',
    variants: [
      { locale: 'zh-CN', title: '给学习间隙一杯自然的重启', caption: '顺应生命，自在健康。', subtitle_srt: '1\n00:00:00,000 --> 00:00:05,000\n给学习间隙一杯自然的重启', cta: '查看活动', review_status: approved ? 'reviewed' : 'draft', reviewer_id: approved ? reviewerId : null },
      { locale: 'en', title: 'A softer reset for your study break', caption: 'A natural pause with ADDA TEA.', subtitle_srt: '1\n00:00:00,000 --> 00:00:05,000\nA softer reset for your study break', cta: 'View the offer', review_status: approved ? 'reviewed' : 'draft', reviewer_id: approved ? reviewerId : null },
      { locale: 'bn', title: 'পড়ার বিরতিতে একটি স্বাভাবিক বিরতি', caption: 'অনুমোদিত তথ্য যাচাইয়ের পর প্রকাশ করুন।', subtitle_srt: '1\n00:00:00,000 --> 00:00:05,000\nপড়ার বিরতিতে একটি স্বাভাবিক বিরতি', cta: 'অফার দেখুন', review_status: approved ? 'reviewed' : 'needs_local_review', reviewer_id: approved ? reviewerId : null }
    ],
    source_link_id: sourceLinkId, sources: [{ source_id: 'brand_rev_suiwu_01', revision_id: 'brand_rev_suiwu_01', kind: 'brand_fact', excerpt: 'SUIWU 随物 / ADDA TEA approved brand revision' }], needs_input: approved ? [] : ['bn_local_review_required'], risk_flags: approved ? [] : ['manual_review_required']
  };
  return packageData;
}
const approvedBriefId = 'brief_lotus_approved';
const draftBriefId = 'brief_lotus_draft';
state.contentBriefs.push(
  { id: approvedBriefId, tenantId, storeId, campaignId, targetMetric: 'verified_first_orders', contentPillar: 'natural reset', channel: 'manual', productIds: ['prod_tea_original', 'prod_lemon_mate'], assetIds: ['asset_lotus_water', 'asset_suiwu_logo'], sourceLinkId: 'source_instagram_01', createdBy: ownerId, createdAt: daysAgo(18) },
  { id: draftBriefId, tenantId, storeId, campaignId, targetMetric: 'verified_first_orders', contentPillar: 'exam reset', channel: 'manual', productIds: ['prod_matcha_cloud'], assetIds: ['asset_needs_confirmation'], sourceLinkId: 'source_campus_01', createdBy: managerId, createdAt: daysAgo(2) }
);
const approvedPackage = contentPackage(approvedBriefId, 'content_rev_approved', true, ['prod_tea_original', 'prod_lemon_mate'], ['asset_lotus_water', 'asset_suiwu_logo'], 'source_instagram_01');
const draftPackage = contentPackage(draftBriefId, 'content_rev_draft', false, ['prod_matcha_cloud'], ['asset_needs_confirmation'], 'source_campus_01');
const approvedFacts = captureContentFacts(state, state.contentBriefs.find((item) => item.id === approvedBriefId), approvedPackage);
const draftFacts = captureContentFacts(state, state.contentBriefs.find((item) => item.id === draftBriefId), draftPackage);
const approvedPackageHash = contentDigest(approvedPackage);
state.contentRevisions.push(
  { id: 'content_rev_approved', briefId: approvedBriefId, tenantId, revision: 1, status: 'approved', packageData: approvedPackage, contentHash: approvedPackageHash, generationFacts: approvedFacts, currentApprovalId: 'approval_lotus_approved', createdBy: ownerId, createdAt: daysAgo(17), updatedAt: daysAgo(15) },
  { id: 'content_rev_draft', briefId: draftBriefId, tenantId, revision: 1, status: 'needs_local_review', packageData: draftPackage, contentHash: contentDigest(draftPackage), generationFacts: draftFacts, currentApprovalId: null, createdBy: managerId, createdAt: daysAgo(2), updatedAt: daysAgo(2) }
);
state.contentApprovals.push({ id: 'approval_lotus_approved', tenantId, resourceType: 'content', resourceId: 'content_rev_approved', resourceRevisionId: 'content_rev_approved', payloadHash: approvedPackageHash, audienceSnapshotId: null, channel: 'manual', language: 'zh-CN,en,bn', budgetMinor: campaign.budgetMinor, campaignRevision: approvedFacts.campaignRevision, brandRevisionIds: approvedFacts.brandRevisionIds, productPriceRefs: approvedFacts.productPriceRefs, assetIds: approvedFacts.assetIds, policyVersion: 'content-policy-v2', factsHash: contentDigest(approvedFacts), approvedBy: ownerId, approvedAt: daysAgo(14), expiresAt: daysFromNow(14), status: 'approved', createdAt: daysAgo(15) });
state.publicationIntents.push({ id: 'publication_lotus_manual', tenantId, storeId, contentRevisionId: 'content_rev_approved', approvalId: 'approval_lotus_approved', payloadHash: approvedPackageHash, packageData: approvedPackage, channel: 'manual', mode: 'manual', status: 'operator_attested', createdBy: ownerId, createdAt: daysAgo(12) });
state.publicationReceipts.push({ id: 'receipt_lotus_manual', intentId: 'publication_lotus_manual', evidenceType: 'operator_attested', externalPostId: 'synthetic-post-001', evidenceUrl: 'https://example.invalid/synthetic-post-001', createdBy: ownerId, createdAt: daysAgo(11) });

state.partners.push({ id: 'partner_du_club', tenantId, name: 'DU Natural Living Club (synthetic)', kind: 'club', sourceUrl: 'https://example.invalid/du-natural-living', sourceNote: 'Synthetic partner record for approval and source checks.', verifiedAt: daysAgo(16), contactPermission: false, stage: 'agreed', followerCount: null, createdBy: managerId, createdAt: daysAgo(20) });
state.events.push({ id: 'event_study_break_01', tenantId, storeId, campaignId, templateId: 'tpl-study-break', name: '[测试] Study Break Tea Circle', startsAt: daysFromNow(-1), endsAt: daysFromNow(1), capacity: 30, registrationCount: 3, checkinCount: 2, status: 'open', createdBy: managerId, createdAt: daysAgo(10) });
state.eventRegistrations.push(
  { id: 'registration_ana', tenantId, eventId: 'event_study_break_01', memberId: 'member_ana', contactHmac: hmac('ana.synthetic@example.invalid'), status: 'registered', createdAt: daysFromNow(-0.8) },
  { id: 'registration_rina', tenantId, eventId: 'event_study_break_01', memberId: 'member_rina', contactHmac: hmac('rina.synthetic@example.invalid'), status: 'registered', createdAt: daysFromNow(-0.7) },
  { id: 'registration_sami', tenantId, eventId: 'event_study_break_01', memberId: 'member_sami', contactHmac: hmac('sami.synthetic@example.invalid'), status: 'registered', createdAt: daysFromNow(-0.6) }
);
state.eventCheckins.push({ id: 'checkin_ana', tenantId, eventId: 'event_study_break_01', memberId: 'member_ana', registrationId: 'registration_ana', checkedInBy: cashierId, method: 'staff_confirmed', createdAt: daysFromNow(-0.5) }, { id: 'checkin_rina', tenantId, eventId: 'event_study_break_01', memberId: 'member_rina', registrationId: 'registration_rina', checkedInBy: cashierId, method: 'scan', createdAt: daysFromNow(-0.4) });
state.referrals.push({ id: 'referral_ana_rina', tenantId, storeId, inviterMemberId: 'member_ana', inviteeMemberId: 'member_rina', sourceLinkId: 'source_campus_01', status: 'qualified', firstQualifiedOrderId: 'ord_rina_001', reason: null, createdAt: daysAgo(36) });
state.rewardLedger.push({ id: 'reward_ana_rina', tenantId, referralId: 'referral_ana_rina', amountMinor: 4000, currency: 'BDT', status: 'pending_review', approvedBy: null, approvedAt: null, reason: 'Synthetic reward awaiting owner approval.', createdAt: daysAgo(33) });

state.segmentDefinitions.push(
  { id: 'segment_unpurchased', tenantId, name: 'Registered but no purchase', rule: 'registered_unpurchased', version: 1, createdBy: managerId, createdAt: daysAgo(8), storeId },
  { id: 'segment_marketing_optin', tenantId, name: 'Marketing opt-in', rule: 'marketing_opt_in', version: 1, createdBy: managerId, createdAt: daysAgo(8), storeId }
);
const snapshotMemberIds = ['member_ana', 'member_rina', 'member_zara'].sort();
const snapshotSeed = 'fixture-seed-optin';
const snapshotHoldoutPercent = 33;
const stableAssignment = (memberId) => createHash('sha256').update(`${snapshotSeed}:${memberId}`).digest().readUInt32BE(0) % 10000 < snapshotHoldoutPercent * 100 ? 'holdout' : 'treatment';
const snapshotAssignments = Object.fromEntries(snapshotMemberIds.map((memberId) => [memberId, stableAssignment(memberId)]));
const snapshotPolicyHash = hash({ segmentId: 'segment_marketing_optin', segmentVersion: 1, storeId, memberIds: snapshotMemberIds, holdoutPercent: snapshotHoldoutPercent, seed: snapshotSeed, asOf: now });
state.audienceSnapshots.push({ id: 'audience_optin_01', tenantId, segmentId: 'segment_marketing_optin', seed: snapshotSeed, memberIds: snapshotMemberIds, holdoutPercent: snapshotHoldoutPercent, assignments: snapshotAssignments, frozenAt: daysAgo(6), policyHash: snapshotPolicyHash, storeId, asOf: now });
const outreach = { id: 'outreach_reengage_01', tenantId, storeId, segmentId: 'segment_marketing_optin', audienceSnapshotId: 'audience_optin_01', channel: 'manual', templateId: 'tpl_study_break_v1', templateText: '[测试] ADDA TEA synthetic reminder: review the approved study break offer.', templateApproved: true, budgetMinor: 0, costPerAttemptMinor: 0, quietStartLocal: '09:00', quietEndLocal: '21:00', frequencyCapDays: 7, status: 'approved', createdBy: managerId, createdAt: daysAgo(5), approvedBy: ownerId, approvedAt: daysAgo(4), policyVersion: 'crm-policy-v2', approvalHash: null, expiresAt: daysFromNow(2) };
outreach.approvalHash = outreachApprovalHash(outreach, state.audienceSnapshots[0], 1);
state.outreachCampaigns.push(outreach);
state.messageAttempts.push({ id: 'attempt_rina_holdout', tenantId, outreachId: 'outreach_reengage_01', memberId: 'member_rina', assignment: snapshotAssignments.member_rina, status: snapshotAssignments.member_rina === 'holdout' ? 'skipped_holdout' : 'external_blocked', reason: snapshotAssignments.member_rina === 'holdout' ? 'experiment_holdout' : 'global_kill_switch', providerReference: null, dispatchKey: 'dispatch-rina-01', approvalHash: outreach.approvalHash, costMinor: 0, createdAt: daysAgo(4) }, { id: 'attempt_ana_manual', tenantId, outreachId: 'outreach_reengage_01', memberId: 'member_ana', assignment: snapshotAssignments.member_ana, status: 'external_blocked', reason: 'global_kill_switch', providerReference: null, dispatchKey: 'dispatch-ana-01', approvalHash: outreach.approvalHash, costMinor: 0, createdAt: daysAgo(4) });

state.feedback.push(
  { id: 'feedback_urgent_01', tenantId, storeId, source: 'manual_import', sourceRef: 'ticket-synthetic-001', externalId: 'FB-001', originalText: 'Synthetic customer reports a possible food safety concern; do not publish a reply automatically.', evidenceExcerpt: 'possible food safety concern', receivedAt: daysAgo(2), customerRefHash: hmac('customer-urgent@example.invalid'), memberId: 'member_sami', tags: ['food_safety'], risk: 'urgent', riskReasons: ['food_safety'], status: 'escalated', classificationVersion: 1, createdBy: ownerId, createdAt: daysAgo(2), updatedAt: daysAgo(1), originalTextRetentionUntil: daysFromNow(30) },
  { id: 'feedback_routine_01', tenantId, storeId, source: 'manual_import', sourceRef: 'ticket-synthetic-002', externalId: 'FB-002', originalText: 'Synthetic customer asks whether the study break offer is still available.', evidenceExcerpt: 'study break offer', receivedAt: daysAgo(3), customerRefHash: hmac('customer-routine@example.invalid'), memberId: 'member_noor', tags: ['offer_question'], risk: 'none', riskReasons: [], status: 'in_progress', classificationVersion: 1, createdBy: managerId, createdAt: daysAgo(3), updatedAt: daysAgo(2), originalTextRetentionUntil: daysFromNow(30) }
);
state.feedbackClassifications.push({ id: 'classification_urgent_01', tenantId, feedbackId: 'feedback_urgent_01', tags: ['food_safety'], evidence: ['possible food safety concern'], method: 'rule', actorUserId: null, createdAt: daysAgo(2) }, { id: 'classification_routine_01', tenantId, feedbackId: 'feedback_routine_01', tags: ['offer_question'], evidence: ['study break offer'], method: 'human', actorUserId: managerId, createdAt: daysAgo(2) });
state.supportCases.push({ id: 'case_urgent_01', tenantId, storeId, feedbackId: 'feedback_urgent_01', ownerUserId: ownerId, slaDueAt: daysFromNow(2), status: 'open', escalationLevel: 'urgent', resolutionEvidence: null, createdAt: daysAgo(2), updatedAt: daysAgo(1) }, { id: 'case_routine_01', tenantId, storeId, feedbackId: 'feedback_routine_01', ownerUserId: managerId, slaDueAt: daysFromNow(1), status: 'in_progress', escalationLevel: 'normal', resolutionEvidence: null, createdAt: daysAgo(3), updatedAt: daysAgo(2) });
const routineReplyBody = 'Thanks for checking. A staff member will confirm the approved offer window.';
state.replyRevisions.push({ id: 'reply_routine_01', tenantId, caseId: 'case_routine_01', revision: 1, channel: 'manual', body: routineReplyBody, bodyHash: hash(routineReplyBody), status: 'pending_approval', createdBy: managerId, approvedBy: null, approvedAt: null, approvalHash: null, expiresAt: daysFromNow(7), createdAt: daysAgo(1) });
state.voiceTasks.push({ id: 'voice_task_urgent', tenantId, caseId: 'case_urgent_01', ownerUserId: ownerId, kind: 'safety_escalation', status: 'open', dueAt: daysFromNow(2), evidence: null, createdAt: daysAgo(2), completedAt: null }, { id: 'voice_task_routine', tenantId, caseId: 'case_routine_01', ownerUserId: managerId, kind: 'manual_reply', status: 'open', dueAt: daysFromNow(1), evidence: null, createdAt: daysAgo(1), completedAt: null, replyRevisionId: 'reply_routine_01' });

const ownerActor = { userId: ownerId, tenantId, role: 'OWNER', storeIds: [storeId], sessionId: 'complete-fixture' };
const reportMetrics = [
  ...queryMetrics(state, ownerActor, [{ metricKey: 'net_revenue_minor' }, { metricKey: 'qualified_order_count' }, { metricKey: 'average_order_value_minor' }, { metricKey: 'identity_coverage' }, { metricKey: 'repeat_30d_rate' }], now),
  ...queryMetrics(state, ownerActor, [{ metricKey: 'conversion_7d_rate' }], now)
];
const reportMetric = (key) => reportMetrics.find((item) => item.metricKey === key);
state.controlTasks.push({ id: 'control_task_review_outreach', tenantId, storeIds: [storeId], ownerUserId: managerId, title: '[测试] Review synthetic outreach holdout and blocked send', dueAt: daysFromNow(2), targetMetric: 'qualified_order_count', budgetMinor: 0, guardrails: ['manual approval', 'no external send in demo'], evidenceRefs: [reportMetric('qualified_order_count').id], status: 'open', createdAt: daysAgo(1) });
state.dailyReports.push({ id: 'report_daily_01', tenantId, storeId, storeIds: [storeId], metrics: reportMetrics, dataHash: hash(reportMetrics), version: 1, asOf: now, completeThrough: now, status: reportMetrics.every((item) => item.quality === 'verified') ? 'verified' : 'provisional', observations: [{ text: '[测试] POS order and refund metrics are computed from the fixture snapshot.', metricRefs: [reportMetric('qualified_order_count').id, reportMetric('net_revenue_minor').id] }], hypotheses: [{ text: 'Attribution should be reviewed by source before any campaign conclusion.', evidenceRefs: [reportMetric('identity_coverage').id] }], advice: [{ text: 'Review the blocked manual outreach before any send.', guardrails: ['owner approval required', 'no automatic external send'], evidenceRefs: [reportMetric('qualified_order_count').id] }], taskIds: ['control_task_review_outreach'], sourceRefs: [...new Set(reportMetrics.flatMap((item) => item.sourceRefs))], restatedFrom: null, createdBy: ownerId, createdAt: daysAgo(1) });
state.connectorStates.push({ id: 'connector_whatsapp_demo', tenantId, provider: 'whatsapp', mode: 'manual', status: 'unconfigured', enabled: false, killSwitch: true, capabilities: { readMetrics: false, reply: false, sendTemplate: false }, reason: 'synthetic fixture; credentials and approved templates absent', checkedAt: now, updatedAt: now });
state.auditEvents.push({ id: 'audit_fixture_seed', tenantId, storeId, actorUserId: ownerId, action: 'test_data.fixture_seeded', resourceType: 'fixture', resourceId: 'complete-demo', metadata: { synthetic: true, external_writes: false }, createdAt: now });

// Persist one completed read-only run for each product surface. These runs
// are made with the same durable command path as the UI; they never call a
// model or an external connector.
function materializeRun(plan, prompt, key) {
  let run = commandControlRun(state, ownerActor, 'create', null, { plan, prompt, store_id: storeId, request_key: key, budget_minor: 0, max_retries: 1, deadline_seconds: 180, execution: 'background' }, now);
  let step = 1;
  while (['queued', 'running'].includes(run.status)) {
    run = commandControlRun(state, ownerActor, 'advance', run.id, { expected_version: run.version }, daysFromNow(step / 86400));
    step += 1;
  }
  return run;
}
materializeRun('growth', '[测试] 生成门店增长检查：只读指标、品牌事实和 CRM 风险。', 'fixture-growth-run-20260926');
materializeRun('content', '[测试] 检查内容审批链和本地复核缺口。', 'fixture-content-run-20260926');
materializeRun('campus', '[测试] 检查校园伙伴与活动容量信息。', 'fixture-campus-run-20260926');
materializeRun('voice', '[测试] 检查顾客声音和待人工处理的工单。', 'fixture-voice-run-20260926');

const membersCsv = [
  'tenant_id,store_id,id,registered_at,display_name,language,contact,is_synthetic',
  ...memberRows.map(([id, external, name, contact, language, registeredDaysAgo]) => `${tenantId},${storeId},${external},${daysAgo(registeredDaysAgo)},${name},${language},${contact},true`)
].join('\n') + '\n';
const externalMemberByInternal = Object.fromEntries(memberRows.map(([id, external]) => [id, external]));
const ordersCsv = [
  'tenant_id,store_id,source,external_order_id,member_id,paid_at,currency,amount_paid_minor,status',
  ...orderRows.map((row) => `${tenantId},${storeId},${row.source},${row.externalOrderId},${row.memberId ? externalMemberByInternal[row.memberId] : ''},${row.paidAt},${row.currency},${row.amountPaidMinor},${row.status}`)
].join('\n') + '\n';
const refundsCsv = [
  'tenant_id,store_id,source,external_adjustment_id,external_order_id,occurred_at,amount_minor',
  ...state.refunds.map((row) => `${tenantId},${storeId},${row.source},${row.externalAdjustmentId},${row.externalOrderId},${row.occurredAt},${row.amountMinor}`)
].join('\n') + '\n';
state.imports.find((item) => item.id === ordersImportId).fileHash = hash(ordersCsv);
state.imports.find((item) => item.id === refundsImportId).fileHash = hash(refundsCsv);
state.importRows = [];
state.importRows.push(...makeImportRows('orders', orderRows.map((row) => ({ tenant_id: tenantId, store_id: storeId, source: row.source, external_order_id: row.externalOrderId, member_id: row.memberId ? externalMemberByInternal[row.memberId] : '', paid_at: row.paidAt, currency: row.currency, amount_paid_minor: String(row.amountPaidMinor), status: row.status })), ordersImportId));
state.importRows.push(...makeImportRows('refunds', state.refunds.map((row) => ({ tenant_id: tenantId, store_id: storeId, source: row.source, external_adjustment_id: row.externalAdjustmentId, external_order_id: row.externalOrderId, occurred_at: row.occurredAt, amount_minor: String(row.amountMinor) })), refundsImportId));

const manifest = {
  schema_version: 1,
  generated_at: now,
  synthetic_only: true,
  tenant_id: tenantId,
  store_id: storeId,
  app_start: { APP_MODE: 'demo', ADDA_DATA_FILE: './data/complete-demo.json', SESSION_SECRET: secret, AI_PROVIDER: 'deterministic_offline', LIVE_EXTERNAL_WRITES: 'false' },
  accounts: [
    { role: 'OWNER', email: 'owner@demo.adda.local', password: 'demo-only-password' },
    { role: 'GROWTH_MANAGER', email: 'manager@demo.adda.local', password: 'demo-only-password' },
    { role: 'LOCAL_REVIEWER', email: 'reviewer@demo.adda.local', password: 'demo-only-password' },
    { role: 'CASHIER', email: 'cashier@demo.adda.local', password: 'demo-only-password' }
  ],
  raw_tokens: {
    source_links: rawSourceTokens,
    member_tokens: memberTokens,
    coupon_tokens: { ana: couponTokenFor('member_ana'), rina: couponTokenFor('member_rina'), noor: couponTokenFor('member_noor') },
    verification_code: '000000'
  },
  ids: { campaign: campaignId, offer: offerId, approved_content_revision: 'content_rev_approved', draft_content_revision: 'content_rev_draft', event: 'event_study_break_01', outreach: 'outreach_reengage_01', urgent_case: 'case_urgent_01' },
  coverage: { brand: state.brandFacts.length, products: state.products.length, assets: state.mediaAssets.length, members: state.members.length, paid_orders: state.orders.filter((item) => item.status === 'paid').length, refunds: state.refunds.length, coupons: state.issuedCoupons.length, content_revisions: state.contentRevisions.length, events: state.events.length, feedback: state.feedback.length, reports: state.dailyReports.length },
  source_assets: ['4da38778134ae0fc6f4fb0046521903b.jpg', '7846e5a3d39a673b230a47f52f4532ca.jpg', '99b0b4ec1602cc2760ffed5944b53444.jpg', 'f78fd9085f6bde2ab8101aac1de72da9.jpg'],
  limits: ['All names, contacts, orders and feedback are synthetic.', 'No WhatsApp, payment, publishing or other external write is enabled.', 'The public source/member tokens are demo bearer tokens; never reuse them outside local testing.']
};
const scenarios = {
  schema_version: 1,
  login: manifest.accounts.map(({ role, email }) => ({ role, email, password: 'demo-only-password' })),
  expected_metrics: { net_revenue_minor: 64000, qualified_order_count: 4, average_order_value_minor: 16000, identity_coverage: 0.75, repeat_30d_rate: 0.5, conversion_7d_rate: 1 / 3 },
  content: { exportable_revision: 'content_rev_approved', export_expected: 'manual_ready', blocked_revision: 'content_rev_draft', blocked_reason: 'bn_local_review_required plus asset_rights_missing' },
  public_member: { source_token_name: 'campus', path_template: '/s/du-gate-demo/c/<source_token>', verification_code: '000000', coupon_token_names: ['ana', 'rina', 'noor'] },
  cashier: { pending_coupon: 'coupon_noor_001', reserve_expected: 'pending_pos_verification', unknown_order_match_expected: 'pos_order_not_found', authoritative_order: 'POS-1003' },
  imports: { files: ['members.csv', 'orders.csv', 'refunds.csv'], repeat_same_file_expected: 'deduplicated' },
  agent: { plans: ['growth', 'content', 'campus', 'voice'], mode: 'deterministic_offline', external_writes: false, actual_cost_minor: 0 }
};

await mkdir(path.dirname(output), { recursive: true });
await mkdir(artifactDir, { recursive: true });
const serialized = JSON.stringify(state, null, 2) + '\n';
await atomicWrite(output, serialized);
if (output !== artifact) await atomicWrite(artifact, serialized);
await atomicWrite(path.join(artifactDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
await atomicWrite(path.join(artifactDir, 'scenarios.json'), JSON.stringify(scenarios, null, 2) + '\n');
await atomicWrite(path.join(artifactDir, 'members.csv'), membersCsv);
await atomicWrite(path.join(artifactDir, 'orders.csv'), ordersCsv);
await atomicWrite(path.join(artifactDir, 'refunds.csv'), refundsCsv);
const originalAssetDir = path.join(artifactDir, 'assets', 'originals');
await mkdir(originalAssetDir, { recursive: true });
for (const fileName of manifest.source_assets) {
  try { await copyFile(path.join(clientAssetRoot, fileName), path.join(originalAssetDir, fileName)); } catch { /* source files are optional outside the client's local export */ }
}
console.log(JSON.stringify({ output, artifact, manifest: path.join(artifactDir, 'manifest.json'), coverage: manifest.coverage }));
