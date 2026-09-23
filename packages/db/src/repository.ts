import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  AuditEvent,
  Campaign,
  DatabaseState,
  Job,
  Membership,
  Session,
  Store,
  Tenant,
  User
} from '../../domain/src/types';
import type {
  BrandDocument,
  BrandFact,
  BrandReference,
  BrandRevision,
  MediaAsset,
  PriceVersion,
  Product,
  PublishCheckInput,
  PublishCheckResult
} from '../../domain/src/brand';
import { checkPublish, checkContentFacts, checkContentApproval, contentDigest } from '../../domain/src/content-policy';
import type {
  AttributionEvidenceRecord,
  ImportBatch,
  ImportKind,
  ImportRowError,
  ImportStagedRow,
  MemberRecord,
  OrderRecord,
  ParsedMember,
  ParsedOrder,
  ParsedRefund,
  RefundRecord
} from '../../domain/src/imports';
import type {
  ConsentEvent,
  IssuedCoupon,
  Offer,
  RedemptionAttempt,
  SourceLink,
  TouchEvent
} from '../../domain/src/growth';
import { validateContentPackage, type ContentApproval, type ContentBrief, type ContentRevision, type PublicationIntent, type PublicationReceipt } from '../../domain/src/content';
import { defaultEventTemplates, type EventCheckin, type EventRecord, type EventRegistration, type EventTemplate, type PartnerRecord, type ReferralRecord, type RewardLedgerEntry } from '../../domain/src/campus';
import type { AudienceSnapshot, MessageAttempt, OutreachCampaign, SegmentDefinition, SegmentRule } from '../../domain/src/crm';
import type { FeedbackRecord, SupportCase, ReplyRevision, VoiceTask } from '../../domain/src/voice';
import { classifyFeedback, hashFeedbackCustomer, redactFeedbackText } from '../../domain/src/voice';
import type { ConnectorState, DeliveryIntent, WebhookEvent, DeliveryStatus } from '../../domain/src/connectors';
import { canAdvanceDelivery } from '../../domain/src/connectors';
import { canReadDailyReport, canReadControlTask } from '../../domain/src/report-policy';
import type { DailyReport, ControlTask } from '../../domain/src/control';
import { orderKey, resolveOrder, currentOrders } from '../../domain/src/order-identity';
import { activeDuring, DomainError, explicitTimestamp, nullableTimestamp, requireCondition, requireTimeRange, validTimeRange } from '../../domain/src/validation';
import { approvedOutreachContext, marketingConsentForChannel, outreachApprovalHash, outsideOutreachWindow, evaluateMemberDispatch } from '../../domain/src/outreach-policy';
import { existingDelivery, outreachBudget, outreachSpend, outreachLedger, refreshOutreachStatus, refreshDeliveryCampaign } from '../../domain/src/outreach-ledger';
import type { AppMode } from '../../adapters/src/config';

const SCHEMA_VERSION = 1;

export function nowIso(): string {
  return new Date().toISOString();
}

export function hashPassword(password: string, salt = randomBytes(16).toString('hex')): string {
  const digest = scryptSync(password, salt, 32).toString('hex');
  return `scrypt$${salt}$${digest}`;
}

export function verifyPassword(password: string, encoded: string): boolean {
  const [algorithm, salt, expectedHex] = encoded.split('$');
  if (algorithm !== 'scrypt' || !salt || !expectedHex) return false;
  const actual = scryptSync(password, salt, 32);
  const expected = Buffer.from(expectedHex, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function hashOpaque(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function emptyState(mode: AppMode): DatabaseState {
  return {
    schemaVersion: SCHEMA_VERSION,
    initializedAt: nowIso(),
    tenants: [],
    stores: [],
    users: [],
    memberships: [],
    sessions: [],
    campaigns: [],
    brandDocuments: [],
    brandRevisions: [],
    brandFacts: [],
    products: [],
    priceVersions: [],
    mediaAssets: [],
    brandReferences: [],
    members: [],
    orders: [],
    refunds: [],
    imports: [],
    importErrors: [],
    importRows: [],
    sourceWatermarks: [],
    attributionEvidence: [],
    sourceLinks: [],
    touchEvents: [],
    consentEvents: [],
    suppressionEntries: [],
    offers: [],
    issuedCoupons: [],
    redemptionAttempts: [],
    contentBriefs: [],
    contentRevisions: [],
    contentApprovals: [],
    publicationIntents: [],
    publicationReceipts: [],
    partners: [],
    eventTemplates: defaultEventTemplates,
    events: [],
    eventRegistrations: [],
    eventCheckins: [],
    referrals: [],
    rewardLedger: [],
    segmentDefinitions: [],
    audienceSnapshots: [],
    outreachCampaigns: [],
    messageAttempts: [],
    feedback: [],
    feedbackClassifications: [],
    supportCases: [],
    replyRevisions: [],
    voiceTasks: [],
    connectorStates: [],
    deliveryIntents: [],
    webhookEvents: [],
    dailyReports: [],
    controlTasks: [],
    externalWritesKillSwitch: false,
    auditEvents: [],
    jobs: [],
    workerHeartbeatAt: null,
    workerInstanceId: mode === 'demo' ? 'demo-not-running' : null
  };
}

async function fileExists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

/** JSON storage for local development and tests. */
export class JsonRepository {
  private state: DatabaseState | null = null;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(readonly filePath: string, readonly mode: AppMode) {}

  private async withFileLock<T>(callback: () => Promise<T>): Promise<T> {
    const lockPath = `${this.filePath}.lock`;
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
    for (let attempt = 0; attempt < 500; attempt += 1) {
      try { handle = await fs.open(lockPath, 'wx', 0o600); await handle.writeFile(String(process.pid)); break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        try {
          const lockOwner = Number((await fs.readFile(lockPath, 'utf8')).trim());
          let alive = true;
          if (Number.isSafeInteger(lockOwner) && lockOwner > 0) { try { process.kill(lockOwner, 0); } catch (probe) { if ((probe as NodeJS.ErrnoException).code === 'ESRCH') alive = false; } }
          const stat = await fs.stat(lockPath);
          if (!alive && Date.now() - stat.mtimeMs > 1000) await fs.unlink(lockPath);
        } catch { /* another process released it or is completing a write */ }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    if (!handle) throw new Error('repository_lock_timeout');
    try { return await callback(); }
    finally { await handle.close().catch(() => undefined); await fs.unlink(lockPath).catch(() => undefined); }
  }

  async ensure(): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await this.withFileLock(async () => { if (!(await fileExists(this.filePath))) await this.atomicWrite(emptyState(this.mode)); });
    await this.load();
  }

  async load(): Promise<DatabaseState> {
    const raw = await fs.readFile(this.filePath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<DatabaseState>;
    this.state = {
      ...emptyState(this.mode),
      ...parsed,
      schemaVersion: Number(parsed.schemaVersion || 0)
    };
    return structuredClone(this.state);
  }

  private requireState(): DatabaseState {
    if (!this.state) throw new Error('repository_not_initialized');
    return this.state;
  }

  async atomicWrite(next: DatabaseState): Promise<void> {
    const directory = path.dirname(this.filePath);
    await fs.mkdir(directory, { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.${randomBytes(5).toString('hex')}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(temporary, this.filePath);
  }

  async mutate<T>(mutator: (state: DatabaseState) => T | Promise<T>): Promise<T> {
    let result!: T;
    const operation = this.writeQueue.then(async () => {
      await this.withFileLock(async () => {
        const current = await this.load();
        result = await mutator(current);
        await this.atomicWrite(current);
        this.state = current;
      });
    });
    this.writeQueue = operation.then(() => undefined, () => undefined);
    await operation;
    return result;
  }

  snapshot(): DatabaseState {
    return structuredClone(this.requireState());
  }

  async migrate(): Promise<DatabaseState> {
    return this.mutate((state) => {
      if (state.schemaVersion < SCHEMA_VERSION) state.schemaVersion = SCHEMA_VERSION;
      for (const campaign of state.outreachCampaigns.filter(item => item.status === 'completed')) {
        const snapshot = state.audienceSnapshots.find(item => item.id === campaign.audienceSnapshotId && item.tenantId === campaign.tenantId);
        if (!snapshot || snapshot.memberIds.some(id => snapshot.assignments[id] !== 'holdout')) continue;
        const attempted = state.messageAttempts.some(item => item.outreachId === campaign.id) || state.deliveryIntents.some(item => item.outreachId === campaign.id);
        campaign.status = attempted ? 'blocked' : 'approved';
        state.auditEvents.push({ id: randomUUID(), tenantId: campaign.tenantId, storeId: campaign.storeId, actorUserId: null, action: 'outreach.empty_treatment_status_reconciled', resourceType: 'outreach', resourceId: campaign.id, metadata: { status: campaign.status }, createdAt: nowIso() });
      }
      return state;
    });
  }

  async seedDemo(): Promise<{ tenant: Tenant; store: Store; owner: User }> {
    if (this.mode !== 'demo' && this.mode !== 'test') {
      throw new Error('demo_seed_requires_APP_MODE_demo_or_test');
    }
    return this.mutate((state) => {
      const existing = state.tenants.find((tenant) => tenant.slug === 'demo-adda');
      if (existing) {
        const store = state.stores.find((item) => item.tenantId === existing.id)!;
        const ownerMembership = state.memberships.find((item) => item.tenantId === existing.id && item.role === 'OWNER')!;
        const owner = state.users.find((item) => item.id === ownerMembership.userId)!;
        return { tenant: existing, store, owner };
      }
      const createdAt = nowIso();
      const tenant: Tenant = {
        id: 'ten_demo_01',
        slug: 'demo-adda',
        name: 'ADDA DEMO (synthetic)',
        mode: 'demo',
        status: 'active',
        timezone: 'Asia/Dhaka',
        currency: 'BDT',
        launchDate: null,
        createdAt
      };
      const store: Store = {
        id: 'sto_demo_01',
        tenantId: tenant.id,
        slug: 'du-gate-demo',
        name: 'DEMO Store — synthetic only',
        timezone: 'Asia/Dhaka',
        currency: 'BDT',
        status: 'active',
        createdAt
      };
      const owner: User = {
        id: 'usr_demo_owner',
        email: 'owner@demo.adda.local',
        displayName: 'Demo Owner',
        passwordHash: hashPassword('demo-only-password'),
        status: 'active',
        createdAt
      };
      const manager: User = {
        id: 'usr_demo_manager',
        email: 'manager@demo.adda.local',
        displayName: 'Demo Manager',
        passwordHash: hashPassword('demo-only-password'),
        status: 'active',
        createdAt
      };
      const reviewer: User = {
        id: 'usr_demo_reviewer',
        email: 'reviewer@demo.adda.local',
        displayName: 'Demo Local Reviewer',
        passwordHash: hashPassword('demo-only-password'),
        status: 'active',
        createdAt
      };
      const cashier: User = {
        id: 'usr_demo_cashier',
        email: 'cashier@demo.adda.local',
        displayName: 'Demo Cashier',
        passwordHash: hashPassword('demo-only-password'),
        status: 'active',
        createdAt
      };
      state.tenants.push(tenant);
      state.stores.push(store);
      state.users.push(owner, manager, reviewer, cashier);
      const memberships: Membership[] = [
        { id: 'mem_demo_owner', tenantId: tenant.id, userId: owner.id, role: 'OWNER', storeIds: [store.id], revokedAt: null },
        { id: 'mem_demo_manager', tenantId: tenant.id, userId: manager.id, role: 'GROWTH_MANAGER', storeIds: [store.id], revokedAt: null },
        { id: 'mem_demo_reviewer', tenantId: tenant.id, userId: reviewer.id, role: 'LOCAL_REVIEWER', storeIds: [store.id], revokedAt: null },
        { id: 'mem_demo_cashier', tenantId: tenant.id, userId: cashier.id, role: 'CASHIER', storeIds: [store.id], revokedAt: null }
      ];
      state.memberships.push(...memberships);
      return { tenant, store, owner };
    });
  }

  async createTenant(input: Omit<Tenant, 'id' | 'createdAt'>): Promise<Tenant> {
    return this.mutate((state) => {
      const tenant: Tenant = { ...input, id: randomUUID(), createdAt: nowIso() };
      state.tenants.push(tenant);
      return tenant;
    });
  }

  async createStore(input: Omit<Store, 'id' | 'createdAt'>): Promise<Store> {
    return this.mutate((state) => {
      const store: Store = { ...input, id: randomUUID(), createdAt: nowIso() };
      state.stores.push(store);
      return store;
    });
  }

  async createUser(input: Omit<User, 'id' | 'createdAt' | 'passwordHash'> & { password: string }): Promise<User> {
    return this.mutate((state) => {
      const user: User = {
        id: randomUUID(),
        email: input.email.toLowerCase(),
        displayName: input.displayName,
        passwordHash: hashPassword(input.password),
        status: input.status,
        createdAt: nowIso()
      };
      state.users.push(user);
      return user;
    });
  }

  async addMembership(input: Omit<Membership, 'id'>): Promise<Membership> {
    return this.mutate((state) => {
      const membership: Membership = { ...input, id: randomUUID() };
      state.memberships.push(membership);
      return membership;
    });
  }

  findUserByEmail(email: string): User | undefined {
    return this.requireState().users.find((user) => user.email === email.toLowerCase());
  }

  findUserById(id: string): User | undefined {
    return this.requireState().users.find((user) => user.id === id);
  }

  findTenantById(id: string): Tenant | undefined {
    return this.requireState().tenants.find((tenant) => tenant.id === id);
  }

  findStoreById(id: string): Store | undefined {
    return this.requireState().stores.find((store) => store.id === id);
  }

  findMembership(tenantId: string, userId: string): Membership | undefined {
    return this.requireState().memberships.find(
      (membership) => membership.tenantId === tenantId && membership.userId === userId && !membership.revokedAt
    );
  }

  findSession(id: string): Session | undefined {
    return this.requireState().sessions.find((session) => session.id === id);
  }

  async createSession(input: Omit<Session, 'id' | 'createdAt'>): Promise<Session> {
    return this.mutate((state) => {
      const session: Session = { ...input, id: randomBytes(24).toString('base64url'), createdAt: nowIso() };
      state.sessions = state.sessions.filter((item) => item.expiresAt > nowIso() && !item.revokedAt);
      state.sessions.push(session);
      return session;
    });
  }

  async revokeSession(id: string): Promise<void> {
    await this.mutate((state) => {
      const session = state.sessions.find((item) => item.id === id);
      if (session) session.revokedAt = nowIso();
    });
  }

  async createCampaign(input: Omit<Campaign, 'id' | 'createdAt' | 'updatedAt' | 'revision'>): Promise<Campaign> {
    return this.mutate((state) => {
      const dates = { startAt: input.startAt ?? null, endAt: input.endAt ?? null };
      requireTimeRange(dates.startAt, dates.endAt, 'invalid_campaign_window');
      const campaign: Campaign = {
        ...input,
        ...dates,
        id: randomUUID(),
        createdAt: nowIso(),
        updatedAt: nowIso(),
        revision: 1
      };
      state.campaigns.push(campaign);
      return campaign;
    });
  }

  async createBrandDocument(input: {
    tenantId: string;
    storeId: string | null;
    sourceType: BrandDocument['sourceType'];
    sourceLabel: string;
    sourceUri: string | null;
    checksum: string;
    createdBy: string;
    content: string;
    effectiveFrom: string | null;
    effectiveTo: string | null;
    conflictKeys?: string[];
  }): Promise<{ document: BrandDocument; revision: BrandRevision; facts: BrandFact[] }> {
    return this.mutate((state) => {
      requireTimeRange(input.effectiveFrom, input.effectiveTo, 'invalid_brand_validity');
      const existing = state.brandDocuments.find((item) => item.tenantId === input.tenantId && item.checksum === input.checksum && (item.storeId || null) === (input.storeId || null));
      if (existing) {
        const revision = state.brandRevisions.find((item) => item.documentId === existing.id)!;
        return { document: existing, revision, facts: state.brandFacts.filter((item) => item.revisionId === revision.id) };
      }
      const createdAt = nowIso();
      const document: BrandDocument = {
        id: randomUUID(), tenantId: input.tenantId, storeId: input.storeId,
        sourceType: input.sourceType, sourceLabel: input.sourceLabel, sourceUri: input.sourceUri,
        checksum: input.checksum, createdBy: input.createdBy, createdAt
      };
      const previous = state.brandRevisions.filter((item) => item.documentId === document.id).sort((a, b) => b.version - a.version)[0];
      const revision: BrandRevision = {
        id: randomUUID(), documentId: document.id, tenantId: input.tenantId, version: (previous?.version || 0) + 1,
        status: input.conflictKeys?.length ? 'conflict' : 'draft', content: input.content,
        effectiveFrom: input.effectiveFrom, effectiveTo: input.effectiveTo, approvedBy: null, approvedAt: null,
        supersedesId: previous?.id || null, conflictKeys: input.conflictKeys || [], createdAt
      };
      const facts = extractFacts(input.tenantId, revision, input.content);
      state.brandDocuments.push(document);
      state.brandRevisions.push(revision);
      state.brandFacts.push(...facts);
      return { document, revision, facts };
    });
  }

  findBrandRevision(id: string): BrandRevision | undefined { return this.requireState().brandRevisions.find((item) => item.id === id); }
  findBrandDocument(id: string): BrandDocument | undefined { return this.requireState().brandDocuments.find((item) => item.id === id); }
  listBrandRevisions(tenantId: string): BrandRevision[] { return this.requireState().brandRevisions.filter((item) => item.tenantId === tenantId); }
  listBrandFacts(tenantId: string, approvedOnly = true): BrandFact[] {
    return this.requireState().brandFacts.filter((fact) => fact.tenantId === tenantId && (!approvedOnly || fact.status === 'approved'));
  }

  async approveBrandRevision(id: string, actorUserId: string): Promise<BrandRevision> {
    return this.mutate((state) => {
      const revision = state.brandRevisions.find((item) => item.id === id);
      if (!revision) throw new Error('brand_revision_not_found');
      if (revision.conflictKeys.length) throw new Error('brand_revision_conflict');
      requireTimeRange(revision.effectiveFrom, revision.effectiveTo, 'invalid_brand_validity');
      if (revision.effectiveTo && Date.parse(revision.effectiveTo) <= Date.now()) throw new Error('brand_revision_expired');
      const prior = state.brandRevisions.find((item) => item.documentId === revision.documentId && item.status === 'approved' && item.id !== id);
      if (prior) {
        prior.status = 'expired';
        for (const fact of state.brandFacts.filter((item) => item.revisionId === prior.id)) fact.status = 'expired';
      }
      revision.status = 'approved';
      revision.approvedBy = actorUserId;
      revision.approvedAt = nowIso();
      for (const fact of state.brandFacts.filter((item) => item.revisionId === revision.id)) fact.status = 'approved';
      return revision;
    });
  }

  async createProduct(input: Omit<Product, 'id' | 'createdAt' | 'updatedAt' | 'currentPriceVersionId'>): Promise<Product> {
    return this.mutate((state) => {
      const product: Product = { ...input, id: randomUUID(), currentPriceVersionId: null, createdAt: nowIso(), updatedAt: nowIso() };
      state.products.push(product);
      return product;
    });
  }
  findProduct(id: string): Product | undefined { return this.requireState().products.find((item) => item.id === id); }
  listProducts(tenantId: string, storeIds: string[]): Product[] { return this.requireState().products.filter((item) => item.tenantId === tenantId && storeIds.includes(item.storeId)); }

  async addPriceVersion(input: Omit<PriceVersion, 'id' | 'version' | 'createdAt'>): Promise<PriceVersion> {
    return this.mutate((state) => {
      requireTimeRange(input.validFrom, input.validTo, 'invalid_price_validity', true);
      const product = state.products.find((item) => item.id === input.productId && item.tenantId === input.tenantId);
      if (!product) throw new Error('product_not_found');
      const versions = state.priceVersions.filter((item) => item.productId === input.productId).sort((a, b) => b.version - a.version);
      const version: PriceVersion = { ...input, id: randomUUID(), version: (versions[0]?.version || 0) + 1, createdAt: nowIso() };
      state.priceVersions.push(version);
      if (product) {
        product.currentPriceVersionId = version.id;
        if (version.amountMinor !== null && version.status === 'approved') product.needsInput = product.needsInput.filter((item) => item !== 'price');
        product.updatedAt = nowIso();
      }
      for (const reference of state.brandReferences) {
        if (reference.productPriceRefs.some((ref) => ref.productId === input.productId && ref.priceVersionId !== version.id)) {
          reference.status = 'stale'; reference.invalidatedAt = nowIso(); reference.invalidationReason = 'price_version_changed';
        }
      }
      return version;
    });
  }
  listPriceVersions(tenantId: string, productId: string): PriceVersion[] { return this.requireState().priceVersions.filter((item) => item.tenantId === tenantId && item.productId === productId); }

  async createMediaAsset(input: Omit<MediaAsset, 'id' | 'createdAt'>): Promise<MediaAsset> {
    return this.mutate((state) => {
      requireCondition(nullableTimestamp(input.expiresAt), 'invalid_expires_at', 400);
      const existing = state.mediaAssets.find((item) => item.tenantId === input.tenantId && item.checksum === input.checksum && (item.storeId || null) === (input.storeId || null));
      if (existing) return existing;
      const asset: MediaAsset = { ...input, id: randomUUID(), createdAt: nowIso() };
      state.mediaAssets.push(asset);
      return asset;
    });
  }
  findMediaAsset(id: string): MediaAsset | undefined { return this.requireState().mediaAssets.find((item) => item.id === id); }

  async createBrandReference(input: Omit<BrandReference, 'id' | 'createdAt' | 'status' | 'invalidatedAt' | 'invalidationReason'>): Promise<BrandReference> {
    return this.mutate((state) => {
      for (const ref of input.productPriceRefs) {
        const product = state.products.find((item) => item.id === ref.productId && item.tenantId === input.tenantId && item.storeId === input.storeId);
        const price = state.priceVersions.find((item) => item.id === ref.priceVersionId && item.tenantId === input.tenantId && item.productId === ref.productId);
        if (!product || !price) throw new Error('brand_reference_product_or_price_not_found');
      }
      for (const revisionId of input.brandRevisionIds) {
        const revision = state.brandRevisions.find((item) => item.id === revisionId && item.tenantId === input.tenantId && item.status === 'approved');
        if (!revision) throw new Error('brand_reference_revision_not_approved');
        const document = state.brandDocuments.find((item) => item.id === revision.documentId);
        if (document?.storeId && document.storeId !== input.storeId) throw new Error('brand_reference_store_mismatch');
      }
      const reference: BrandReference = { ...input, id: randomUUID(), status: 'valid', createdAt: nowIso(), invalidatedAt: null, invalidationReason: null };
      state.brandReferences.push(reference);
      return reference;
    });
  }
  findBrandReference(id: string): BrandReference | undefined { return this.requireState().brandReferences.find((item) => item.id === id); }

  publishCheck(input: PublishCheckInput): PublishCheckResult {
    return checkPublish(this.requireState(), input, nowIso());
  }

  findImport(id: string): ImportBatch | undefined { return this.requireState().imports.find((item) => item.id === id); }
  listImports(tenantId: string, storeIds: string[]): ImportBatch[] { return this.requireState().imports.filter((item) => item.tenantId === tenantId && storeIds.includes(item.storeId)); }

  async stageImport(input: {
    tenantId: string;
    storeId: string;
    kind: ImportKind;
    source: string;
    fileName: string;
    fileHash: string;
    completeThrough: string | null;
    createdBy: string;
    rows: Array<{ rowNumber: number; raw: Record<string, string>; value?: ParsedOrder | ParsedRefund | ParsedMember; errors: Array<{ code: string; message: string }> }>;
  }): Promise<{ batch: ImportBatch; errors: ImportRowError[] }> {
    return this.mutate((state) => {
      const existing = state.imports.find((item) => item.tenantId === input.tenantId && item.storeId === input.storeId && item.kind === input.kind && item.source === input.source && item.fileHash === input.fileHash && item.completeThrough === input.completeThrough);
      if (existing) return { batch: existing, errors: state.importErrors.filter((error) => error.importId === existing.id) };
      const batch: ImportBatch = {
        id: randomUUID(), tenantId: input.tenantId, storeId: input.storeId, kind: input.kind, source: input.source, fileName: input.fileName,
        fileHash: input.fileHash, status: 'preview', rowCount: input.rows.length, validRowCount: 0, errorCount: 0,
        completeThrough: input.completeThrough, createdBy: input.createdBy, createdAt: nowIso(), committedAt: null
      };
      const errors: ImportRowError[] = [];
      const seenKeys = new Map<string, string>();
      for (const row of input.rows) {
        const rowErrors = [...row.errors];
        if (row.value) {
          const value = row.value as any;
          if (value.tenantId !== input.tenantId || value.storeId !== input.storeId) rowErrors.push({ code: 'scope_mismatch', message: 'tenant_id/store_id does not match authenticated import scope' });
          if (input.kind !== 'members' && value.source !== input.source) rowErrors.push({ code: 'source_mismatch', message: 'row source does not match the selected import source' });
          const key = input.kind === 'orders' ? orderKey(value) : input.kind === 'refunds' ? JSON.stringify([value.tenantId, value.storeId, value.source, value.externalAdjustmentId]) : value.externalMemberId;
          const rawHash = hashOpaque(JSON.stringify(row.raw));
          if (seenKeys.has(key) && seenKeys.get(key) !== rawHash) rowErrors.push({ code: 'conflicting_duplicate', message: 'duplicate key has different values in same file' });
          else seenKeys.set(key, rawHash);
          if (!rowErrors.length) {
            const staged: ImportStagedRow = { id: randomUUID(), importId: batch.id, rowNumber: row.rowNumber, kind: input.kind, raw: row.raw, value, valid: true };
            state.importRows.push(staged);
            batch.validRowCount += 1;
          }
        }
        for (const error of rowErrors) errors.push({ id: randomUUID(), importId: batch.id, rowNumber: row.rowNumber, code: error.code, message: error.message, rawRow: row.raw });
      }
      batch.errorCount = errors.length;
      state.imports.push(batch);
      state.importErrors.push(...errors);
      return { batch, errors };
    });
  }

  async commitImport(id: string): Promise<{ batch: ImportBatch; inserted: number; deduplicated: number; corrections: number; rejected: ImportRowError[] }> {
    return this.mutate((state) => {
      const batch = state.imports.find((item) => item.id === id);
      if (!batch) throw new Error('import_not_found');
      if (batch.status === 'committed') return { batch, inserted: 0, deduplicated: batch.rowCount, corrections: 0, rejected: state.importErrors.filter((error) => error.importId === id) };
      const staged = state.importRows.filter((row) => row.importId === id && row.valid);
      const rejected = state.importErrors.filter((error) => error.importId === id);
      let inserted = 0; let deduplicated = 0; let corrections = 0;
      for (const row of staged) {
        if (row.kind === 'orders') {
          const value = row.value as ParsedOrder;
          const existing = state.orders.filter((item) => orderKey(item) === orderKey(value) && item.active).sort((a, b) => b.revision - a.revision)[0];
          const sourceRowHash = hashOpaque(JSON.stringify(row.raw));
          if (existing && existing.sourceRowHash === sourceRowHash) { deduplicated += 1; continue; }
          if (existing) { existing.active = false; corrections += 1; }
          const order: OrderRecord = { id: randomUUID(), ...value, revision: (existing?.revision || 0) + 1, sourceRowHash, active: true, correctionOfId: existing?.id || null, createdAt: nowIso(), updatedAt: nowIso() };
          state.orders.push(order); inserted += 1;
        } else if (row.kind === 'refunds') {
          const value = row.value as ParsedRefund;
          const duplicate = state.refunds.find((item) => item.tenantId === batch.tenantId && item.storeId === batch.storeId && item.source === value.source && item.externalAdjustmentId === value.externalAdjustmentId);
          if (duplicate) { deduplicated += 1; continue; }
          const order = state.orders.filter((item) => orderKey(item) === orderKey(value) && item.active).sort((a, b) => b.revision - a.revision)[0];
          if (!order) { rejected.push({ id: randomUUID(), importId: id, rowNumber: row.rowNumber, code: 'order_not_found', message: 'refund references an unknown order', rawRow: row.raw }); continue; }
          const refunded = state.refunds.filter((item) => orderKey(item) === orderKey(value)).reduce((sum, item) => sum + item.amountMinor, 0);
          if (refunded + value.amountMinor > order.amountPaidMinor) { rejected.push({ id: randomUUID(), importId: id, rowNumber: row.rowNumber, code: 'refund_exceeds_order', message: 'cumulative refunds exceed order amount', rawRow: row.raw }); continue; }
          const refund: RefundRecord = { id: randomUUID(), ...value, sourceRowHash: hashOpaque(JSON.stringify(row.raw)), createdAt: nowIso() };
          state.refunds.push(refund); inserted += 1;
        } else {
          const value = row.value as ParsedMember;
          const existing = state.members.find((item) => item.tenantId === batch.tenantId && item.storeId === batch.storeId && item.externalMemberId === value.externalMemberId);
          if (existing) { deduplicated += 1; continue; }
          const member: MemberRecord = { id: randomUUID(), ...value, contactHmac: value.contact ? hashOpaque(value.contact.toLowerCase()) : null, publicAccessTokenHash: null, contactVerified: false, verificationProof: null, verificationExpiresAt: null, createdAt: nowIso() };
          state.members.push(member); inserted += 1;
        }
      }
      batch.status = 'committed';
      batch.committedAt = nowIso();
      batch.errorCount = rejected.length;
      state.importErrors = state.importErrors.filter((error) => error.importId !== id).concat(rejected);
      if (batch.completeThrough) {
        const existingWatermark = state.sourceWatermarks.find((item) => item.tenantId === batch.tenantId && item.storeId === batch.storeId && item.source === batch.source);
        if (existingWatermark) { existingWatermark.completeThrough = batch.completeThrough; existingWatermark.updatedAt = nowIso(); existingWatermark.confirmed = true; }
        else state.sourceWatermarks.push({ tenantId: batch.tenantId, storeId: batch.storeId, source: batch.source, completeThrough: batch.completeThrough, updatedAt: nowIso(), confirmed: true });
      }
      return { batch, inserted, deduplicated, corrections, rejected };
    });
  }

  importReconciliation(id: string): Record<string, unknown> {
    const batch = this.findImport(id);
    if (!batch) throw new Error('import_not_found');
    const errors = this.requireState().importErrors.filter((error) => error.importId === id);
    const rows = this.requireState().importRows.filter((row) => row.importId === id);
    return { import_id: id, status: batch.status, row_count: batch.rowCount, valid_row_count: batch.validRowCount, error_count: errors.length, staged_row_count: rows.length, errors: errors.map((error) => ({ row_number: error.rowNumber, code: error.code, message: error.message })), complete_through: batch.completeThrough, committed_at: batch.committedAt };
  }

  listOrders(tenantId: string, storeIds: string[]): OrderRecord[] { return this.requireState().orders.filter((item) => item.tenantId === tenantId && storeIds.includes(item.storeId)); }
  listRefunds(tenantId: string, storeIds: string[]): RefundRecord[] { return this.requireState().refunds.filter((item) => item.tenantId === tenantId && storeIds.includes(item.storeId)); }
  listMembers(tenantId: string, storeIds: string[]): MemberRecord[] { return this.requireState().members.filter((item) => item.tenantId === tenantId && storeIds.includes(item.storeId)); }
  listAttribution(tenantId: string, storeIds: string[]): AttributionEvidenceRecord[] { return this.requireState().attributionEvidence.filter((item) => item.tenantId === tenantId && storeIds.includes(item.storeId)); }

  async addAttributionEvidence(input: Omit<AttributionEvidenceRecord, 'id' | 'orderExternalId'> & { orderExternalId?: string }): Promise<AttributionEvidenceRecord> {
    return this.mutate((state) => {
      // campaignId may be an external/imported campaign key; tenant/store on
      // the evidence row are the authority boundary for metric aggregation.
      requireCondition(explicitTimestamp(input.occurredAt), 'invalid_occurred_at', 400);
      const resolved = resolveOrder(state.orders, input);
      if (!resolved.ok) throw new DomainError(resolved.errorCode);
      const order = resolved.order;
      const evidence: AttributionEvidenceRecord = { ...input, id: randomUUID(), orderId: order.id, orderSource: order.source, orderExternalId: order.externalOrderId };
      state.attributionEvidence.push(evidence);
      return evidence;
    });
  }

  async createSourceLink(input: Omit<SourceLink, 'id' | 'createdAt' | 'status'>): Promise<SourceLink> {
    return this.mutate((state) => {
      requireCondition(state.campaigns.some((campaign) => campaign.id === input.campaignId && campaign.tenantId === input.tenantId && campaign.storeId === input.storeId), 'campaign_not_found', 404);
      const existing = state.sourceLinks.find((item) => item.tenantId === input.tenantId && item.tokenHash === input.tokenHash);
      if (existing) return existing;
      const link: SourceLink = { ...input, id: randomUUID(), createdAt: nowIso(), status: 'active' };
      state.sourceLinks.push(link);
      return link;
    });
  }
  findSourceLinkByTokenHash(tokenHash: string): SourceLink | undefined { return this.requireState().sourceLinks.find((item) => item.tokenHash === tokenHash && item.status === 'active'); }
  findSourceLink(id: string): SourceLink | undefined { return this.requireState().sourceLinks.find((item) => item.id === id); }
  listSourceLinks(tenantId: string, storeIds: string[]): SourceLink[] { return this.requireState().sourceLinks.filter((item) => item.tenantId === tenantId && storeIds.includes(item.storeId)); }
  async addTouchEvent(input: Omit<TouchEvent, 'id' | 'occurredAt'> & { occurredAt?: string }): Promise<TouchEvent> {
    return this.mutate((state) => {
      requireCondition(state.sourceLinks.some((link) => link.id === input.sourceLinkId && link.tenantId === input.tenantId && link.storeId === input.storeId && link.status === 'active'), 'source_link_not_found', 404);
      const event: TouchEvent = { ...input, id: randomUUID(), occurredAt: input.occurredAt || nowIso() }; state.touchEvents.push(event); return event;
    });
  }

  findMember(tenantId: string, memberId: string): MemberRecord | undefined { return this.requireState().members.find((item) => item.tenantId === tenantId && item.id === memberId); }
  findMemberByExternalId(tenantId: string, storeId: string, externalId: string): MemberRecord | undefined { return this.requireState().members.find((item) => item.tenantId === tenantId && item.storeId === storeId && item.externalMemberId === externalId); }
  async createMember(input: Omit<MemberRecord, 'id' | 'createdAt' | 'contactVerified' | 'verificationProof' | 'verificationExpiresAt'>): Promise<MemberRecord> {
    return this.mutate((state) => {
      const existing = state.members.find((item) => item.tenantId === input.tenantId && item.storeId === input.storeId && input.contactHmac && item.contactHmac === input.contactHmac);
      if (existing) return existing;
      const member: MemberRecord = { ...input, id: randomUUID(), contactVerified: false, verificationProof: null, verificationExpiresAt: null, createdAt: nowIso() };
      state.members.push(member);
      return member;
    });
  }
  async verifyMemberContact(tenantId: string, memberId: string, proof: string, expiresAt: string): Promise<MemberRecord | undefined> {
    return this.mutate((state) => { const member = state.members.find((item) => item.tenantId === tenantId && item.id === memberId); if (!member) return undefined; member.contactVerified = true; member.verificationProof = proof; member.verificationExpiresAt = expiresAt; return member; });
  }
  async addConsent(input: Omit<ConsentEvent, 'id' | 'occurredAt'> & { occurredAt?: string }): Promise<ConsentEvent> {
    return this.mutate((state) => { const event: ConsentEvent = { ...input, id: randomUUID(), occurredAt: input.occurredAt || nowIso() }; state.consentEvents.push(event); if (!event.granted && event.purpose === 'marketing') state.suppressionEntries.push({ id: randomUUID(), tenantId: event.tenantId, memberId: event.memberId, channel: event.channel, purpose: event.purpose, reason: 'consent_revoked', occurredAt: event.occurredAt }); return event; });
  }
  consentGranted(tenantId: string, memberId: string, purpose: ConsentEvent['purpose']): boolean {
    const events = this.requireState().consentEvents.filter((item) => item.tenantId === tenantId && item.memberId === memberId && item.purpose === purpose).sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt));
    return events[0]?.granted === true && !this.requireState().suppressionEntries.some((item) => item.tenantId === tenantId && item.memberId === memberId && item.purpose === purpose && Date.parse(item.occurredAt) >= Date.parse(events[0].occurredAt));
  }

  async createOffer(input: Omit<Offer, 'id' | 'issuedCount' | 'createdAt' | 'status'>): Promise<Offer> {
    return this.mutate((state) => {
      requireTimeRange(input.validFrom, input.validTo, 'invalid_offer_validity', true);
      requireCondition(explicitTimestamp(input.validTo), 'invalid_valid_to', 400);
      const campaign = state.campaigns.find((item) => item.id === input.campaignId && item.tenantId === input.tenantId && item.storeId === input.storeId);
      requireCondition(campaign, 'campaign_not_found', 404);
      requireCondition(Boolean(campaign.objective?.trim()) && campaign.needsInput.length === 0, 'campaign_needs_input');
      const offer: Offer = { ...input, id: randomUUID(), status: 'active', issuedCount: 0, createdAt: nowIso() }; state.offers.push(offer); return offer;
    });
  }
  findOffer(id: string): Offer | undefined { return this.requireState().offers.find((item) => item.id === id); }
  async issueCoupon(input: { tenantId: string; storeId: string; offerId: string; memberId: string; sourceLinkId: string | null; tokenHash: string }): Promise<IssuedCoupon> {
    return this.mutate((state) => {
      const offer = state.offers.find((item) => item.id === input.offerId && item.tenantId === input.tenantId && item.storeId === input.storeId);
      if (!offer || offer.status !== 'active' || !activeDuring(nowIso(), offer.validFrom, offer.validTo) || (offer.maxRedemptions !== null && offer.issuedCount >= offer.maxRedemptions)) throw new Error('offer_unavailable');
      const campaign = state.campaigns.find((item) => item.id === offer.campaignId && item.tenantId === input.tenantId && item.storeId === input.storeId);
      if (!campaign?.objective?.trim() || campaign.needsInput.length) throw new Error('campaign_needs_input');
      const member = state.members.find((item) => item.id === input.memberId && item.tenantId === input.tenantId && item.storeId === input.storeId);
      if (!member) throw new Error('member_not_found');
      if (input.sourceLinkId) requireCondition(state.sourceLinks.some((link) => link.id === input.sourceLinkId && link.tenantId === input.tenantId && link.storeId === input.storeId && link.campaignId === offer.campaignId && link.status === 'active'), 'source_link_not_found', 404);
      const existing = state.issuedCoupons.find((item) => item.tokenHash === input.tokenHash);
      if (existing) return existing;
      const coupon: IssuedCoupon = { id: randomUUID(), tenantId: input.tenantId, storeId: input.storeId, offerId: offer.id, campaignId: offer.campaignId, memberId: member.id, sourceLinkId: input.sourceLinkId, tokenHash: input.tokenHash, status: 'issued', issuedAt: nowIso(), reservedAt: null, posOrderRef: null, redeemedAt: null, reversedAt: null };
      state.issuedCoupons.push(coupon); offer.issuedCount += 1; return coupon;
    });
  }
  findCouponByTokenHash(tokenHash: string): IssuedCoupon | undefined { return this.requireState().issuedCoupons.find((item) => item.tokenHash === tokenHash); }
  findCoupon(id: string): IssuedCoupon | undefined { return this.requireState().issuedCoupons.find((item) => item.id === id); }
  async reserveCoupon(input: { tokenHash: string; tenantId: string; storeId: string; employeeUserId: string; posOrderRef: string | null }): Promise<{ coupon?: IssuedCoupon; attempt: RedemptionAttempt }> {
    return this.mutate((state) => {
      const coupon = state.issuedCoupons.find((item) => item.tokenHash === input.tokenHash);
      const fail = (code: string): { coupon?: IssuedCoupon; attempt: RedemptionAttempt } => { const attempt: RedemptionAttempt = { id: randomUUID(), tenantId: input.tenantId, storeId: input.storeId, couponId: coupon?.id || 'unknown', employeeUserId: input.employeeUserId, posOrderRef: input.posOrderRef, status: 'rejected', errorCode: code, createdAt: nowIso() }; state.redemptionAttempts.push(attempt); return { attempt }; };
      if (!coupon) return fail('coupon_not_found');
      if (coupon.tenantId !== input.tenantId || coupon.storeId !== input.storeId) return fail('wrong_store');
      const offer = state.offers.find((item) => item.id === coupon.offerId);
      if (!offer || offer.status !== 'active') return fail('offer_cancelled');
      if (!validTimeRange(offer.validFrom, offer.validTo, true) || !explicitTimestamp(offer.validTo)) return fail('offer_validity_invalid');
      if (Date.parse(offer.validFrom) > Date.now()) return fail('offer_not_started');
      if (!activeDuring(nowIso(), offer.validFrom, offer.validTo)) { coupon.status = 'expired'; return fail('coupon_expired'); }
      if (coupon.status !== 'issued') return fail(coupon.status === 'cancelled' ? 'coupon_cancelled' : 'coupon_already_reserved');
      coupon.status = 'pending_pos_verification'; coupon.reservedAt = nowIso(); coupon.posOrderRef = input.posOrderRef;
      const attempt: RedemptionAttempt = { id: randomUUID(), tenantId: input.tenantId, storeId: input.storeId, couponId: coupon.id, employeeUserId: input.employeeUserId, posOrderRef: input.posOrderRef, status: 'reserved', errorCode: null, createdAt: nowIso() }; state.redemptionAttempts.push(attempt); return { coupon, attempt };
    });
  }
  async matchCoupon(couponId: string, tenantId: string, storeId: string, orderRef: string, orderSource?: string, orderId?: string): Promise<{ coupon?: IssuedCoupon; errorCode?: string }> {
    return this.mutate((state) => {
      const coupon = state.issuedCoupons.find((item) => item.id === couponId);
      if (!coupon || coupon.tenantId !== tenantId || coupon.storeId !== storeId) return { errorCode: 'coupon_not_found' };
      if (!['redeemed', 'pending_pos_verification'].includes(coupon.status)) return { errorCode: 'coupon_not_pending' };
      const resolved = resolveOrder(state.orders, { tenantId, storeId, orderExternalId: orderRef || undefined, orderSource, orderId });
      if (!resolved.ok) return { errorCode: resolved.errorCode === 'order_not_found' ? 'pos_order_not_found' : resolved.errorCode };
      const order = resolved.order;
      if (order.status !== 'paid') return { errorCode: 'pos_order_not_found' };
      if (coupon.status === 'redeemed') {
        const previous = resolveOrder(state.orders, { tenantId, storeId, orderId: coupon.posOrderId, orderSource: coupon.posOrderSource, orderExternalId: coupon.posOrderRef || undefined });
        return previous.ok && orderKey(previous.order) === orderKey(order) ? { coupon } : { errorCode: 'coupon_order_mismatch' };
      }
      const member = state.members.find((item) => item.id === coupon.memberId);
      if (order.memberId && order.memberId !== coupon.memberId && order.memberId !== member?.externalMemberId) return { errorCode: 'member_mismatch' };
      coupon.status = 'redeemed'; coupon.posOrderRef = order.externalOrderId; coupon.posOrderSource = order.source; coupon.posOrderId = order.id; coupon.redeemedAt = nowIso();
      state.attributionEvidence.push({ id: randomUUID(), tenantId, storeId, orderExternalId: order.externalOrderId, orderSource: order.source, orderId: order.id, campaignId: coupon.campaignId, method: 'verified_coupon', occurredAt: nowIso() });
      const attempt = state.redemptionAttempts.find((item) => item.couponId === coupon.id && item.status === 'reserved'); if (attempt) { attempt.status = 'matched'; attempt.posOrderRef = order.externalOrderId; attempt.posOrderSource = order.source; attempt.posOrderId = order.id; }
      return { coupon };
    });
  }
  listOffers(tenantId: string, storeIds: string[]): Offer[] { return this.requireState().offers.filter((item) => item.tenantId === tenantId && storeIds.includes(item.storeId)); }

  async createContentBrief(input: Omit<ContentBrief, 'id' | 'createdAt'>): Promise<ContentBrief> {
    return this.mutate((state) => { const brief: ContentBrief = { ...input, id: randomUUID(), createdAt: nowIso() }; state.contentBriefs.push(brief); return brief; });
  }
  findContentBrief(id: string): ContentBrief | undefined { return this.requireState().contentBriefs.find((item) => item.id === id); }
  listContentBriefs(tenantId: string, storeIds: string[]): ContentBrief[] { return this.requireState().contentBriefs.filter((item) => item.tenantId === tenantId && storeIds.includes(item.storeId)); }
  async createContentRevision(input: Omit<ContentRevision, 'id' | 'createdAt' | 'updatedAt' | 'revision' | 'contentHash' | 'status'>): Promise<ContentRevision> {
    return this.mutate((state) => {
      if (validateContentPackage(input.packageData).length) throw new Error('content_schema_invalid');
      const revisions = state.contentRevisions.filter((item) => item.briefId === input.briefId).sort((a, b) => b.revision - a.revision);
      const contentHash = createHash('sha256').update(JSON.stringify(input.packageData)).digest('hex');
      const revision: ContentRevision = { ...input, id: randomUUID(), revision: (revisions[0]?.revision || 0) + 1, status: 'needs_local_review', contentHash, createdAt: nowIso(), updatedAt: nowIso() };
      state.contentRevisions.push(revision);
      return revision;
    });
  }
  findContentRevision(id: string): ContentRevision | undefined { return this.requireState().contentRevisions.find((item) => item.id === id); }
  listContentRevisions(tenantId: string, storeIds: string[]): ContentRevision[] { return this.requireState().contentRevisions.filter((item) => item.tenantId === tenantId && this.requireState().contentBriefs.some((brief) => brief.id === item.briefId && storeIds.includes(brief.storeId))); }
  async updateContentRevision(id: string, packageData: ContentRevision['packageData'], _actorUserId: string): Promise<ContentRevision | undefined> {
    return this.mutate((state) => {
      if (validateContentPackage(packageData).length) throw new Error('content_schema_invalid');
      const current = state.contentRevisions.find((item) => item.id === id);
      if (!current) return undefined;
      current.currentApprovalId = null;
      current.packageData = structuredClone(packageData);
      for (const variant of current.packageData.variants.filter(v => v.locale === 'bn')) { variant.review_status = 'needs_local_review'; variant.reviewer_id = null; }
      current.contentHash = contentDigest(current.packageData); current.revision += 1; current.status = 'needs_local_review'; current.updatedAt = nowIso();
      for (const approval of state.contentApprovals.filter((item) => item.resourceRevisionId === id && item.status === 'approved')) { approval.status = 'stale'; }
      return current;
    });
  }
  async reviewContentBn(id: string, reviewerId: string, decision: 'reviewed' | 'rejected'): Promise<ContentRevision | undefined> {
    return this.mutate((state) => {
      const revision = state.contentRevisions.find((item) => item.id === id);
      if (!revision) return undefined;
      const variant = revision.packageData.variants.find((item) => item.locale === 'bn');
      if (!variant) return revision;
      revision.currentApprovalId = null;
      variant.review_status = decision; variant.reviewer_id = reviewerId;
      revision.contentHash = createHash('sha256').update(JSON.stringify(revision.packageData)).digest('hex');
      for (const approval of state.contentApprovals.filter((item) => item.resourceRevisionId === id && item.status === 'approved')) approval.status = 'stale';
      revision.status = decision === 'reviewed' ? 'draft' : 'rejected'; revision.updatedAt = nowIso();
      return revision;
    });
  }
  async createContentApproval(input: Pick<ContentApproval, 'tenantId' | 'resourceRevisionId' | 'payloadHash' | 'expiresAt'>): Promise<ContentApproval> {
    return this.mutate(state => {
      const revision = state.contentRevisions.find(r => r.id === input.resourceRevisionId && r.tenantId === input.tenantId);
      requireCondition(revision, 'content_revision_not_found', 404);
      requireCondition(revision.contentHash === input.payloadHash, 'stale_approval');
      const errors = checkContentFacts(state, revision, nowIso());
      requireCondition(!errors.length, errors[0]?.code || 'content_invalid');
      requireCondition(explicitTimestamp(input.expiresAt) && Date.parse(input.expiresAt) > Date.now(), 'approval_expired');
      const brief = state.contentBriefs.find(b => b.id === revision.briefId)!;
      const campaign = state.campaigns.find(c => c.id === brief.campaignId)!;
      const facts = revision.generationFacts!;
      const approval: ContentApproval = {
        ...input, ...structuredClone(facts), factsHash: contentDigest(facts), id: randomUUID(), resourceType: 'content', resourceId: revision.id,
        audienceSnapshotId: null, channel: brief.channel, language: 'en,bn', budgetMinor: campaign.budgetMinor,
        policyVersion: 'content-policy-v2', status: 'pending', approvedBy: null, approvedAt: null, createdAt: nowIso()
      };
      state.contentApprovals.push(approval);
      revision.status = 'pending_approval';
      revision.currentApprovalId = approval.id;
      return approval;
    });
  }
  findContentApproval(id: string): ContentApproval | undefined { return this.requireState().contentApprovals.find(item => item.id === id); }
  validateContentExecution(approvalId: string, now = nowIso()) {
    const state = this.requireState();
    return checkContentApproval(state, state.contentApprovals.find(a => a.id === approvalId), now);
  }
  async approveContent(id: string, actorUserId: string, currentHash: string): Promise<ContentApproval> {
    return this.mutate(state => {
      const approval = state.contentApprovals.find(a => a.id === id);
      requireCondition(approval, 'approval_not_found', 404);
      requireCondition(approval.status === 'pending', 'approval_not_pending');
      const check = checkContentApproval(state, approval, nowIso());
      requireCondition(check.ok, check.errors[0]?.code || 'approval_validation_failed');
      const revision = state.contentRevisions.find(r => r.id === approval.resourceRevisionId)!;
      requireCondition(currentHash === revision.contentHash, 'stale_approval');
      for (const prior of state.contentApprovals.filter(a => a.resourceRevisionId === revision.id && a.status === 'approved')) prior.status = 'stale';
      approval.status = 'approved'; approval.approvedBy = actorUserId; approval.approvedAt = nowIso();
      revision.status = 'approved'; revision.currentApprovalId = approval.id;
      return approval;
    });
  }
  async createPublicationIntent(input: Pick<PublicationIntent, 'tenantId' | 'storeId' | 'contentRevisionId' | 'channel' | 'mode' | 'createdBy'>): Promise<PublicationIntent> {
    return this.mutate(state => {
      const revision = state.contentRevisions.find(r => r.id === input.contentRevisionId && r.tenantId === input.tenantId);
      const brief = revision && state.contentBriefs.find(b => b.id === revision.briefId && b.tenantId === input.tenantId && b.storeId === input.storeId);
      requireCondition(revision && brief, 'content_revision_not_found', 404);
      const approval = state.contentApprovals.find(a => a.id === revision.currentApprovalId && a.tenantId === input.tenantId && a.status === 'approved');
      requireCondition(approval, 'approval_not_found', 404);
      const check = checkContentApproval(state, approval, nowIso());
      requireCondition(check.ok, check.errors[0]?.code || 'approval_validation_failed');
      requireCondition(input.channel === approval.channel, 'approval_scope_mismatch');
      requireCondition(input.mode === 'manual', 'live_publication_unimplemented');
      const intent: PublicationIntent = { ...input, id: randomUUID(), approvalId: approval.id, payloadHash: revision.contentHash, packageData: structuredClone(revision.packageData), status: 'manual_ready', createdAt: nowIso() };
      state.publicationIntents.push(intent);
      return intent;
    });
  }
  findPublicationIntent(id: string): PublicationIntent | undefined { return this.requireState().publicationIntents.find((item) => item.id === id); }
  async addPublicationReceipt(input: Omit<PublicationReceipt, 'id' | 'createdAt'>): Promise<PublicationReceipt> {
    return this.mutate((state) => { const receipt: PublicationReceipt = { ...input, id: randomUUID(), createdAt: nowIso() }; state.publicationReceipts.push(receipt); const intent = state.publicationIntents.find((item) => item.id === input.intentId); if (intent) intent.status = input.evidenceType === 'operator_attested' ? 'operator_attested' : input.evidenceType === 'provider_confirmed' ? 'provider_confirmed' : 'submitted'; return receipt; });
  }

  async createPartner(input: Omit<PartnerRecord, 'id' | 'createdAt' | 'stage' | 'verifiedAt'>): Promise<PartnerRecord> {
    return this.mutate((state) => { const partner: PartnerRecord = { ...input, id: randomUUID(), stage: 'identified', verifiedAt: null, createdAt: nowIso() }; state.partners.push(partner); return partner; });
  }
  listPartners(tenantId: string): PartnerRecord[] { return this.requireState().partners.filter((item) => item.tenantId === tenantId); }
  async updatePartnerStage(id: string, tenantId: string, stage: PartnerRecord['stage'], verifiedAt?: string | null): Promise<PartnerRecord | undefined> {
    return this.mutate((state) => { const partner = state.partners.find((item) => item.id === id && item.tenantId === tenantId); if (!partner) return undefined; partner.stage = stage; if (verifiedAt !== undefined) partner.verifiedAt = verifiedAt; return partner; });
  }
  listEventTemplates(): EventTemplate[] { return this.requireState().eventTemplates; }
  async createEvent(input: Omit<EventRecord, 'id' | 'registrationCount' | 'checkinCount' | 'createdAt' | 'status'>): Promise<EventRecord> {
    return this.mutate((state) => { if (!state.stores.some((store) => store.id === input.storeId && store.tenantId === input.tenantId)) throw new Error('store_not_found'); if (input.campaignId && !state.campaigns.some((campaign) => campaign.id === input.campaignId && campaign.tenantId === input.tenantId && campaign.storeId === input.storeId)) throw new Error('campaign_not_found'); const event: EventRecord = { ...input, id: randomUUID(), registrationCount: 0, checkinCount: 0, status: 'draft', createdAt: nowIso() }; state.events.push(event); return event; });
  }
  findEvent(id: string): EventRecord | undefined { return this.requireState().events.find((item) => item.id === id); }
  listEvents(tenantId: string, storeIds: string[]): EventRecord[] { return this.requireState().events.filter((item) => item.tenantId === tenantId && storeIds.includes(item.storeId)); }
  async updateEventSchedule(id: string, tenantId: string, input: { startsAt: string; endsAt: string; capacity: number }): Promise<EventRecord | undefined> {
    return this.mutate((state) => {
      const event = state.events.find((item) => item.id === id && item.tenantId === tenantId);
      if (!event) return undefined;
      requireCondition(event.status === 'draft', 'event_schedule_locked');
      requireCondition(Number.isFinite(Date.parse(input.startsAt)) && Number.isFinite(Date.parse(input.endsAt)) && Date.parse(input.endsAt) > Date.parse(input.startsAt), 'event_date_invalid', 400);
      requireCondition(Number.isSafeInteger(input.capacity) && input.capacity > 0 && input.capacity >= event.registrationCount, 'event_capacity_invalid', 400);
      event.startsAt = input.startsAt; event.endsAt = input.endsAt; event.capacity = input.capacity;
      return event;
    });
  }
  async setEventStatus(id: string, tenantId: string, status: EventRecord['status']): Promise<EventRecord | undefined> {
    return this.mutate((state) => {
      const event = state.events.find((item) => item.id === id && item.tenantId === tenantId);
      if (!event) return undefined;
      if (status === event.status) return event;
      if (status === 'open') {
        requireCondition(event.status === 'draft', 'event_status_transition_invalid');
        requireCondition(Boolean(event.startsAt && event.endsAt) && Date.parse(event.endsAt!) > Date.parse(event.startsAt!), 'event_date_required', 400);
      } else if (status === 'closed') requireCondition(event.status === 'open', 'event_status_transition_invalid');
      else if (status === 'cancelled') requireCondition(['draft', 'open'].includes(event.status), 'event_status_transition_invalid');
      else requireCondition(false, 'event_status_transition_invalid');
      event.status = status;
      return event;
    });
  }
  async registerEvent(input: { tenantId: string; eventId: string; memberId: string | null; contactHmac: string | null }): Promise<{ registration?: EventRegistration; errorCode?: string }> {
    return this.mutate((state) => {
      const event = state.events.find((item) => item.id === input.eventId && item.tenantId === input.tenantId);
      if (!event || event.status !== 'open') return { errorCode: 'event_not_open' };
      if (input.memberId) { const member = state.members.find((item) => item.id === input.memberId && item.tenantId === input.tenantId && item.storeId === event.storeId); if (!member) return { errorCode: 'member_not_found' }; }
      const duplicate = state.eventRegistrations.find((item) => item.eventId === event.id && item.status === 'registered' && ((input.memberId && item.memberId === input.memberId) || (input.contactHmac && item.contactHmac === input.contactHmac)));
      if (duplicate) return { registration: duplicate };
      if (event.registrationCount >= event.capacity) return { errorCode: 'event_capacity_full' };
      const registration: EventRegistration = { id: randomUUID(), tenantId: input.tenantId, eventId: event.id, memberId: input.memberId, contactHmac: input.contactHmac, status: 'registered', createdAt: nowIso() };
      state.eventRegistrations.push(registration); event.registrationCount += 1; return { registration };
    });
  }
  async checkinEvent(input: { tenantId: string; eventId: string; memberId: string | null; registrationId: string | null; checkedInBy: string; method: EventCheckin['method'] }): Promise<{ checkin?: EventCheckin; errorCode?: string }> {
    return this.mutate((state) => {
      const event = state.events.find((item) => item.id === input.eventId && item.tenantId === input.tenantId);
      if (!event) return { errorCode: 'event_not_found' };
      if (event.status !== 'open') return { errorCode: 'event_not_open' };
      if (!input.memberId && !input.registrationId) return { errorCode: 'registration_required' };
      const registration = input.registrationId ? state.eventRegistrations.find((item) => item.id === input.registrationId && item.tenantId === input.tenantId && item.eventId === event.id && item.status === 'registered') : state.eventRegistrations.find((item) => item.tenantId === input.tenantId && item.eventId === event.id && item.status === 'registered' && item.memberId === input.memberId);
      if (!registration) return { errorCode: 'registration_not_found' };
      if (input.memberId) { const member = state.members.find((item) => item.id === input.memberId && item.tenantId === input.tenantId && item.storeId === event.storeId); if (!member) return { errorCode: 'member_not_found' }; if (registration && registration.memberId && registration.memberId !== input.memberId) return { errorCode: 'member_mismatch' }; }
      const duplicate = state.eventCheckins.find((item) => item.eventId === event.id && ((input.memberId && item.memberId === input.memberId) || item.registrationId === registration.id));
      if (duplicate) return { checkin: duplicate };
      if (event.checkinCount >= event.capacity) return { errorCode: 'event_capacity_full' };
      const checkin: EventCheckin = { id: randomUUID(), tenantId: input.tenantId, eventId: event.id, memberId: input.memberId || registration.memberId, registrationId: registration.id, checkedInBy: input.checkedInBy, method: input.method, createdAt: nowIso() };
      state.eventCheckins.push(checkin); event.checkinCount += 1; return { checkin };
    });
  }
  listEventRegistrations(tenantId: string, eventId: string): EventRegistration[] { return this.requireState().eventRegistrations.filter((item) => item.tenantId === tenantId && item.eventId === eventId); }
  listEventCheckins(tenantId: string, eventId: string): EventCheckin[] { return this.requireState().eventCheckins.filter((item) => item.tenantId === tenantId && item.eventId === eventId); }

  async createReferral(input: Omit<ReferralRecord, 'id' | 'status' | 'firstQualifiedOrderId' | 'reason' | 'createdAt'>): Promise<ReferralRecord> {
    return this.mutate((state) => {
      requireCondition(state.members.some((member) => member.id === input.inviterMemberId && member.tenantId === input.tenantId && member.storeId === input.storeId), 'inviter_member_not_found', 404);
      requireCondition(state.members.some((member) => member.id === input.inviteeMemberId && member.tenantId === input.tenantId && member.storeId === input.storeId), 'invitee_member_not_found', 404);
      if (input.sourceLinkId) requireCondition(state.sourceLinks.some((link) => link.id === input.sourceLinkId && link.tenantId === input.tenantId && link.storeId === input.storeId && link.status === 'active'), 'source_link_not_found', 404);
      const existing = state.referrals.find((item) => item.tenantId === input.tenantId && item.inviteeMemberId === input.inviteeMemberId && item.status !== 'reversed');
      if (existing) throw new Error('referral_duplicate');
      if (input.inviterMemberId === input.inviteeMemberId) throw new Error('referral_self_invite');
      const priorOrder = state.orders.find((item) => item.tenantId === input.tenantId && item.storeId === input.storeId && item.memberId === input.inviteeMemberId && item.active && item.status === 'paid');
      const referral: ReferralRecord = { ...input, id: randomUUID(), status: priorOrder ? 'ineligible' : 'registered', firstQualifiedOrderId: null, reason: priorOrder ? 'invitee_has_visible_prior_order' : null, createdAt: nowIso() };
      state.referrals.push(referral);
      state.rewardLedger.push({ id: randomUUID(), tenantId: input.tenantId, referralId: referral.id, amountMinor: null, currency: 'BDT', status: referral.status === 'ineligible' ? 'not_payable' : 'pending_review', approvedBy: null, approvedAt: null, reason: referral.reason, createdAt: nowIso() });
      return referral;
    });
  }
  async evaluateReferral(id: string): Promise<{ referral?: ReferralRecord; reward?: RewardLedgerEntry; errorCode?: string }> {
    return this.mutate((state) => {
      const referral = state.referrals.find((item) => item.id === id);
      if (!referral) return { errorCode: 'referral_not_found' };
      if (referral.status === 'ineligible' || referral.status === 'reversed') return { referral, reward: state.rewardLedger.find((item) => item.referralId === id) };
      const order = state.orders.filter((item) => item.tenantId === referral.tenantId && item.storeId === referral.storeId && item.memberId === referral.inviteeMemberId && item.active && item.status === 'paid').sort((a, b) => Date.parse(a.paidAt) - Date.parse(b.paidAt))[0];
      if (!order) return { referral, reward: state.rewardLedger.find((item) => item.referralId === id) };
      const reward = state.rewardLedger.find((item) => item.referralId === id);
      if (Date.parse(order.paidAt) < Date.parse(referral.createdAt)) { referral.status = 'ineligible'; referral.firstQualifiedOrderId = null; referral.reason = 'invitee_prior_purchase_imported_late'; if (reward) { reward.status = 'not_payable'; reward.reason = referral.reason; } return { referral, reward }; }
      const refunded = state.refunds.filter((item) => orderKey(item) === orderKey(order)).reduce((sum, item) => sum + item.amountMinor, 0);
      if (refunded >= order.amountPaidMinor) { referral.status = 'reversed'; referral.reason = 'full_refund'; if (reward) { reward.status = 'reversed'; reward.reason = 'full_refund'; } return { referral, reward }; }
      referral.status = 'qualified'; referral.firstQualifiedOrderId = order.id; if (reward) { reward.status = 'eligible'; reward.reason = 'first_qualified_order_observed'; }
      return { referral, reward };
    });
  }
  async approveReward(id: string, actorUserId: string, amountMinor: number | null): Promise<RewardLedgerEntry> { return this.mutate((state) => { const reward = state.rewardLedger.find((item) => item.id === id); if (!reward) throw new Error('reward_not_found'); if (reward.status !== 'eligible') throw new Error('reward_not_eligible'); reward.status = 'approved'; reward.amountMinor = amountMinor; reward.approvedBy = actorUserId; reward.approvedAt = nowIso(); return reward; }); }
  listReferrals(tenantId: string, storeIds: string[]): ReferralRecord[] { return this.requireState().referrals.filter((item) => item.tenantId === tenantId && storeIds.includes(item.storeId)); }
  listRewards(tenantId: string, storeIds?: string[]): RewardLedgerEntry[] { const state = this.requireState(); if (!storeIds) return state.rewardLedger.filter((item) => item.tenantId === tenantId); const referralIds = new Set(state.referrals.filter((item) => item.tenantId === tenantId && storeIds.includes(item.storeId)).map((item) => item.id)); return state.rewardLedger.filter((item) => item.tenantId === tenantId && referralIds.has(item.referralId)); }

  // ----- CRM segmentation, audience freezes and controlled outreach (G06) -----
  previewSegment(input: {
    tenantId: string;
    storeIds: string[];
    rule: SegmentRule;
    asOf?: string;
    eventId?: string | null;
  }): {
    rule: SegmentRule;
    asOf: string;
    memberIds: string[];
    count: number;
    totalMembers: number;
    coverage: { eligible: number; total: number; ratio: number; knownHistory: number };
    reasons: Record<string, number>;
  } {
    const state = this.requireState();
    const asOf = input.asOf && Number.isFinite(Date.parse(input.asOf)) ? input.asOf : nowIso();
    const members = state.members.filter((member) => member.tenantId === input.tenantId && input.storeIds.includes(member.storeId));
    const memberIds: string[] = [];
    const reasons: Record<string, number> = {};
    for (const member of members) {
      const matches = segmentRuleMatches(state, member, input.rule, asOf, input.eventId || null);
      if (matches.ok) memberIds.push(member.id);
      reasons[matches.reason] = (reasons[matches.reason] || 0) + 1;
    }
    const knownHistory = members.filter((member) => state.orders.some((order) => order.tenantId === input.tenantId && order.storeId === member.storeId && order.active && order.status === 'paid' && orderMatchesMember(order, member))).length;
    return {
      rule: input.rule,
      asOf,
      memberIds,
      count: memberIds.length,
      totalMembers: members.length,
      coverage: { eligible: memberIds.length, total: members.length, ratio: members.length ? memberIds.length / members.length : 1, knownHistory },
      reasons
    };
  }

  async createSegmentDefinition(input: Omit<SegmentDefinition, 'id' | 'version' | 'createdAt'>): Promise<SegmentDefinition> {
    return this.mutate((state) => {
      const existing = state.segmentDefinitions.find((item) => item.tenantId === input.tenantId && item.name === input.name && item.rule === input.rule && (item.storeId || null) === (input.storeId || null));
      if (existing) return existing;
      const versions = state.segmentDefinitions.filter((item) => item.tenantId === input.tenantId && item.name === input.name);
      const definition: SegmentDefinition = { ...input, id: randomUUID(), version: versions.length + 1, createdAt: nowIso() };
      state.segmentDefinitions.push(definition);
      return definition;
    });
  }

  findSegmentDefinition(id: string): SegmentDefinition | undefined { return this.requireState().segmentDefinitions.find((item) => item.id === id); }
  listSegmentDefinitions(tenantId: string): SegmentDefinition[] { return this.requireState().segmentDefinitions.filter((item) => item.tenantId === tenantId); }

  async freezeAudience(input: {
    tenantId: string;
    segmentId: string;
    storeId?: string | null;
    storeIds?: string[];
    asOf?: string;
    holdoutPercent?: number;
    seed?: string;
  }): Promise<{ snapshot: AudienceSnapshot; preview: ReturnType<JsonRepository['previewSegment']> }> {
    return this.mutate((state) => {
      const segment = state.segmentDefinitions.find((item) => item.id === input.segmentId && item.tenantId === input.tenantId);
      if (!segment) throw new Error('segment_not_found');
      const storeIds = input.storeIds?.length ? input.storeIds : input.storeId ? [input.storeId] : segment.storeId ? [segment.storeId] : state.stores.filter((store) => store.tenantId === input.tenantId && store.status === 'active').map((store) => store.id);
      const asOf = input.asOf && Number.isFinite(Date.parse(input.asOf)) ? input.asOf : nowIso();
      const preview = segmentPreviewFromState(state, { tenantId: input.tenantId, storeIds, rule: segment.rule, asOf });
      const holdoutPercent = Number.isFinite(input.holdoutPercent) ? Math.max(0, Math.min(100, Math.round(input.holdoutPercent as number))) : 10;
      const seed = input.seed?.trim() || hashOpaque(`${input.tenantId}:${segment.id}:holdout-v1`);
      const sortedMemberIds = [...preview.memberIds].sort();
      // Reuse the frozen audience on retries, regardless of request time.
      const existing = state.audienceSnapshots.find((item) => item.tenantId === input.tenantId && item.segmentId === segment.id && item.seed === seed && item.holdoutPercent === holdoutPercent && item.storeId === (input.storeId || null) && item.memberIds.length === sortedMemberIds.length && item.memberIds.every((memberId, index) => memberId === sortedMemberIds[index]));
      if (existing) return { snapshot: existing, preview };
      const assignments: Record<string, 'treatment' | 'holdout'> = {};
      for (const memberId of sortedMemberIds) assignments[memberId] = stableHoldoutAssignment(seed, memberId, holdoutPercent);
      const policyHash = createHash('sha256').update(JSON.stringify({ segmentId: segment.id, segmentVersion: segment.version, storeId: input.storeId || null, memberIds: sortedMemberIds, holdoutPercent, seed, asOf })).digest('hex');
      const snapshot: AudienceSnapshot = { id: randomUUID(), tenantId: input.tenantId, segmentId: segment.id, seed, memberIds: sortedMemberIds, holdoutPercent, assignments, frozenAt: nowIso(), policyHash, storeId: input.storeId || null, asOf };
      state.audienceSnapshots.push(snapshot);
      return { snapshot, preview };
    });
  }

  findAudienceSnapshot(id: string): AudienceSnapshot | undefined { return this.requireState().audienceSnapshots.find((item) => item.id === id); }
  listAudienceSnapshots(tenantId: string): AudienceSnapshot[] { return this.requireState().audienceSnapshots.filter((item) => item.tenantId === tenantId); }

  async createOutreachCampaign(input: Omit<OutreachCampaign, 'id' | 'createdAt' | 'approvedBy' | 'approvedAt' | 'approvalHash'> & { approvalHash?: string | null }): Promise<OutreachCampaign> {
    return this.mutate((state) => {
      const snapshot = state.audienceSnapshots.find((item) => item.id === input.audienceSnapshotId && item.tenantId === input.tenantId);
      if (!snapshot) throw new Error('audience_snapshot_not_found');
      if (snapshot.storeId && snapshot.storeId !== input.storeId) throw new Error('audience_store_mismatch');
      if (!state.stores.some((store) => store.id === input.storeId && store.tenantId === input.tenantId && store.status === 'active')) throw new Error('store_not_found');
      const campaign: OutreachCampaign = {
        ...input,
        id: randomUUID(),
        createdAt: nowIso(),
        approvedBy: null,
        approvedAt: null,
        approvalHash: input.approvalHash || null,
        policyVersion: input.policyVersion || 'crm-policy-v2',
        expiresAt: input.expiresAt || new Date(Date.now() + 7 * 86_400_000).toISOString()
      };
      state.outreachCampaigns.push(campaign);
      return campaign;
    });
  }

  findOutreachCampaign(id: string): OutreachCampaign | undefined { return this.requireState().outreachCampaigns.find((item) => item.id === id); }
  listOutreachCampaigns(tenantId: string, storeIds: string[]): OutreachCampaign[] { return this.requireState().outreachCampaigns.filter((item) => item.tenantId === tenantId && storeIds.includes(item.storeId)); }
  listMessageAttempts(tenantId: string, outreachId?: string): MessageAttempt[] { return this.requireState().messageAttempts.filter((item) => item.tenantId === tenantId && (!outreachId || item.outreachId === outreachId)); }

  async updateOutreachCampaign(id: string, tenantId: string, patch: Partial<Pick<OutreachCampaign, 'templateId' | 'templateText' | 'templateApproved' | 'budgetMinor' | 'costPerAttemptMinor' | 'quietStartLocal' | 'quietEndLocal' | 'frequencyCapDays' | 'expiresAt'>>): Promise<OutreachCampaign | undefined> {
    return this.mutate((state) => {
      const campaign = state.outreachCampaigns.find((item) => item.id === id && item.tenantId === tenantId);
      if (!campaign) return undefined;
      for (const attempt of state.messageAttempts.filter(a => a.outreachId === campaign.id && ['queued', 'sent_test'].includes(a.status))) attempt.costMinor ??= campaign.costPerAttemptMinor;
      for (const intent of state.deliveryIntents.filter(i => i.tenantId === tenantId && (i.outreachId === campaign.id || i.approvalHash === campaign.approvalHash))) { intent.outreachId = campaign.id; intent.costMinor ??= campaign.costPerAttemptMinor; }
      for (const intent of state.deliveryIntents.filter(i => i.outreachId === campaign.id && i.status === 'pending' && !i.providerReference)) { intent.status = 'blocked'; intent.errorCode = 'outreach_approval_changed'; intent.updatedAt = nowIso(); }
      Object.assign(campaign, patch);
      campaign.status = 'pending_approval';
      campaign.approvedBy = null;
      campaign.approvedAt = null;
      campaign.approvalHash = null;
      return campaign;
    });
  }

  async submitOutreachForApproval(id: string, tenantId: string): Promise<OutreachCampaign> {
    return this.mutate((state) => {
      const campaign = state.outreachCampaigns.find((item) => item.id === id && item.tenantId === tenantId);
      if (!campaign) throw new Error('outreach_not_found');
      if (campaign.status === 'draft') campaign.status = 'pending_approval';
      return campaign;
    });
  }

  outreachExportPreview(input: { outreachId: string; tenantId: string; storeId: string; now?: string }): { items: Array<{ memberId: string; assignment: 'treatment' | 'holdout'; status: MessageAttempt['status'] | 'eligible'; reason: string | null }>; blockedCount: number } {
    const state = this.requireState();
    const campaign = state.outreachCampaigns.find((item) => item.id === input.outreachId && item.tenantId === input.tenantId && item.storeId === input.storeId);
    if (!campaign) throw new Error('outreach_not_found');
    const snapshot = approvedOutreachContext(state, campaign, nowIso());
    const dispatchTime = this.mode === 'test' && input.now && Number.isFinite(Date.parse(input.now)) ? input.now : nowIso();
    const quiet = outsideOutreachWindow(state, campaign, dispatchTime);
    let spent = outreachSpend(state, campaign);
    const items: Array<{ memberId: string; assignment: 'treatment' | 'holdout'; status: MessageAttempt['status'] | 'eligible'; reason: string | null }> = [];
    for (const memberId of snapshot.memberIds) {
      const assignment = snapshot.assignments[memberId] || 'treatment';
      const decision = evaluateMemberDispatch(state, campaign, { memberId, assignment, now: dispatchTime, quiet, spent });
      if (decision.status === 'eligible') spent += campaign.costPerAttemptMinor;
      items.push({ memberId, assignment, ...decision });
    }
    return { items, blockedCount: items.filter((item) => item.status !== 'eligible').length };
  }

  async approveOutreachCampaign(id: string, actorUserId: string): Promise<OutreachCampaign> {
    return this.mutate((state) => {
      const campaign = state.outreachCampaigns.find((item) => item.id === id);
      if (!campaign) throw new Error('outreach_not_found');
      if (['approved', 'queued', 'completed'].includes(campaign.status)) { approvedOutreachContext(state, campaign, nowIso()); return campaign; }
      if (!['draft', 'pending_approval'].includes(campaign.status)) throw new Error('outreach_not_approvable');
      if (!campaign.templateApproved) throw new Error('template_not_approved');
      if (!Number.isSafeInteger(campaign.budgetMinor) || campaign.budgetMinor < 0 || !Number.isSafeInteger(campaign.costPerAttemptMinor) || campaign.costPerAttemptMinor < 0) throw new Error('budget_invalid');
      const approvalExpiry = Date.parse(campaign.expiresAt || '');
      if (!Number.isFinite(approvalExpiry) || approvalExpiry <= Date.now()) throw new Error('outreach_approval_expired');
      const snapshot = state.audienceSnapshots.find((item) => item.id === campaign.audienceSnapshotId && item.tenantId === campaign.tenantId);
      const segment = state.segmentDefinitions.find((item) => item.id === campaign.segmentId && item.tenantId === campaign.tenantId);
      if (!snapshot || !segment) throw new Error('audience_snapshot_not_found');
      campaign.approvalHash = outreachApprovalHash(campaign, snapshot, segment.version);
      campaign.approvedBy = actorUserId;
      campaign.approvedAt = nowIso();
      campaign.status = 'approved';
      return campaign;
    });
  }

  async dispatchOutreach(input: {
    outreachId: string;
    tenantId: string;
    storeId: string;
    allowTestOutbox: boolean;
    now?: string;
    idempotencyKey?: string;
  }): Promise<{ campaign: OutreachCampaign; attempts: MessageAttempt[]; report: Record<string, unknown> }> {
    return this.mutate((state) => {
      const campaign = state.outreachCampaigns.find((item) => item.id === input.outreachId && item.tenantId === input.tenantId && item.storeId === input.storeId);
      if (!campaign) throw new Error('outreach_not_found');
      const snapshot = approvedOutreachContext(state, campaign, nowIso());
      const dispatchTime = this.mode === 'test' && input.now && Number.isFinite(Date.parse(input.now)) ? input.now : nowIso();
      const dispatchKey = input.idempotencyKey || `${campaign.id}:${snapshot.policyHash}`;
      const attempts: MessageAttempt[] = [];
      let spent = outreachSpend(state, campaign);
      const quiet = outsideOutreachWindow(state, campaign, dispatchTime);
      for (const memberId of snapshot.memberIds) {
        const assignment = snapshot.assignments[memberId] || 'treatment';
        const history = state.messageAttempts.filter(a => a.tenantId === input.tenantId && a.outreachId === campaign.id && a.memberId === memberId);
        const replay = history.find(a => a.dispatchKey === dispatchKey || (!a.dispatchKey && !input.idempotencyKey));
        if (replay) { attempts.push(replay); continue; }
        const existing = existingDelivery(state, campaign, memberId);
        if (existing?.attempt) { attempts.push(existing.attempt); continue; }
        // A provider intent already reserves this member. Record only a reference, not another charge.
        const previous = history.at(-1);
        let status: MessageAttempt['status'] = 'queued';
        let reason: string | null = null;
        let providerReference: string | null = null;
        const decision = evaluateMemberDispatch(state, campaign, { memberId, assignment, now: dispatchTime, quiet, spent });
        if (decision.status !== 'eligible') {
          status = decision.status;
          reason = decision.reason;
        } else if (!input.allowTestOutbox) {
          status = 'external_blocked'; reason = 'live_connector_unconfigured';
        } else {
          status = 'sent_test'; reason = 'test_outbox_only'; providerReference = `test-outbox:${hashOpaque(dispatchKey).slice(0, 16)}:${hashOpaque(memberId).slice(0, 16)}`;
          spent += campaign.costPerAttemptMinor;
        }
        const attempt: MessageAttempt = { id: randomUUID(), tenantId: input.tenantId, outreachId: campaign.id, memberId, assignment, status, reason, providerReference, dispatchKey, approvalHash: campaign.approvalHash!, costMinor: status === 'sent_test' ? campaign.costPerAttemptMinor : 0, deliveryIntentId: existing?.intent?.id, retryOfId: previous?.id, createdAt: dispatchTime };
        state.messageAttempts.push(attempt); attempts.push(attempt);
      }
      refreshOutreachStatus(state, campaign, snapshot);
      return { campaign, attempts, report: reportFromState(state, campaign, snapshot) };
    });
  }

  // ----- Customer voice / case loop (G07) -----
  async createFeedback(input: {
    tenantId: string;
    storeId: string;
    source: string;
    sourceRef?: string | null;
    externalId?: string | null;
    text: string;
    receivedAt?: string;
    memberId?: string | null;
    customerRef?: string | null;
    tags?: string[];
    createdBy?: string | null;
  }): Promise<{ feedback: FeedbackRecord; supportCase: SupportCase | null; deduplicated: boolean }> {
    return this.mutate((state) => {
      const duplicate = input.externalId ? state.feedback.find((item) => item.tenantId === input.tenantId && item.storeId === input.storeId && item.source === input.source && item.externalId === input.externalId) : undefined;
      if (duplicate) return { feedback: duplicate, supportCase: state.supportCases.find((item) => item.feedbackId === duplicate.id) || null, deduplicated: true };
      requireCondition(input.text.length <= 4000 && input.source.trim().length > 0, 'feedback_fields_invalid', 400);
      requireCondition(!input.receivedAt || explicitTimestamp(input.receivedAt), 'feedback_timestamp_invalid', 400);
      requireCondition(state.stores.some(store => store.id === input.storeId && store.tenantId === input.tenantId && store.status === 'active'), 'store_not_found', 404);
      const text = input.text.trim();
      if (!text) throw new Error('feedback_text_required');
      const receivedAt = input.receivedAt && Number.isFinite(Date.parse(input.receivedAt)) ? new Date(input.receivedAt).toISOString() : nowIso();
      const classified = classifyFeedback(text, input.tags || []);
      const member = input.memberId ? state.members.find((item) => item.id === input.memberId && item.tenantId === input.tenantId && item.storeId === input.storeId) : undefined;
      if (input.memberId && !member) throw new Error('feedback_member_not_found');
      const feedback: FeedbackRecord = {
        id: randomUUID(), tenantId: input.tenantId, storeId: input.storeId, source: input.source.trim().slice(0, 80),
        sourceRef: input.sourceRef ? input.sourceRef.slice(0, 240) : null, externalId: input.externalId ? input.externalId.slice(0, 240) : null,
        originalText: text, evidenceExcerpt: redactFeedbackText(text), receivedAt,
        customerRefHash: input.customerRef ? hashFeedbackCustomer(input.customerRef) : null, memberId: member?.id || null,
        tags: classified.tags, risk: classified.risk, riskReasons: classified.riskReasons, status: classified.risk === 'urgent' ? 'escalated' : 'open',
        classificationVersion: 1, createdBy: input.createdBy || null, createdAt: nowIso(), updatedAt: nowIso()
      };
      state.feedback.push(feedback);
      state.feedbackClassifications.push({ id: randomUUID(), tenantId: input.tenantId, feedbackId: feedback.id, tags: feedback.tags, evidence: classified.evidence, method: 'rule', actorUserId: input.createdBy || null, createdAt: nowIso() });
      const supportCase: SupportCase = createSupportCaseInState(state, feedback, input.createdBy || null);
      return { feedback, supportCase, deduplicated: false };
    });
  }

  listFeedback(tenantId: string, storeIds: string[]): FeedbackRecord[] { return this.requireState().feedback.filter((item) => item.tenantId === tenantId && storeIds.includes(item.storeId)); }
  findFeedback(id: string): FeedbackRecord | undefined { return this.requireState().feedback.find((item) => item.id === id); }
  listSupportCases(tenantId: string, storeIds: string[]): SupportCase[] { return this.requireState().supportCases.filter((item) => item.tenantId === tenantId && storeIds.includes(item.storeId)); }
  findSupportCase(id: string): SupportCase | undefined { return this.requireState().supportCases.find((item) => item.id === id); }
  listReplyRevisions(caseId: string, tenantId: string): ReplyRevision[] { return this.requireState().replyRevisions.filter((item) => item.caseId === caseId && item.tenantId === tenantId).sort((a, b) => a.revision - b.revision); }
  listVoiceTasks(tenantId: string, storeIds: string[]): VoiceTask[] { return this.requireState().voiceTasks.filter((item) => item.tenantId === tenantId && stateStoreIds(this.requireState(), item.caseId, storeIds)); }

  async correctFeedback(input: { feedbackId: string; tenantId: string; tags: string[]; actorUserId: string; evidence?: string[] }): Promise<FeedbackRecord> {
    return this.mutate((state) => {
      const feedback = state.feedback.find((item) => item.id === input.feedbackId && item.tenantId === input.tenantId);
      if (!feedback) throw new Error('feedback_not_found');
      const safeTags = [...new Set(input.tags.filter((tag) => /^[a-z0-9_\-]{1,48}$/i.test(tag)))].slice(0, 12);
      const risk = classifyFeedback(feedback.originalText, safeTags);
      feedback.tags = risk.tags;
      feedback.risk = risk.risk;
      feedback.riskReasons = risk.riskReasons;
      feedback.classificationVersion += 1;
      feedback.updatedAt = nowIso();
      state.feedbackClassifications.push({ id: randomUUID(), tenantId: input.tenantId, feedbackId: feedback.id, tags: feedback.tags, evidence: risk.evidence.length ? risk.evidence : [feedback.evidenceExcerpt], method: 'human', actorUserId: input.actorUserId, createdAt: nowIso() });
      if (feedback.risk === 'urgent' && !state.supportCases.some((item) => item.feedbackId === feedback.id && !['closed', 'resolved'].includes(item.status))) createSupportCaseInState(state, feedback, input.actorUserId);
      state.auditEvents.push({ id: randomUUID(), tenantId: input.tenantId, storeId: feedback.storeId, actorUserId: input.actorUserId, action: 'feedback.classification_corrected', resourceType: 'feedback', resourceId: feedback.id, metadata: { tags: feedback.tags, classification_version: feedback.classificationVersion }, createdAt: nowIso() });
      return feedback;
    });
  }

  async updateSupportCase(input: { caseId: string; tenantId: string; status?: SupportCase['status']; ownerUserId?: string | null; evidence?: string | null; actorUserId: string }): Promise<SupportCase> {
    return this.mutate((state) => {
      const item = state.supportCases.find((entry) => entry.id === input.caseId && entry.tenantId === input.tenantId);
      if (!item) throw new Error('case_not_found');
      if (input.status) item.status = input.status;
      if (input.ownerUserId !== undefined) { requireCondition(input.ownerUserId && state.memberships.some(m => m.tenantId === item.tenantId && m.userId === input.ownerUserId && !m.revokedAt && m.storeIds.includes(item.storeId) && ['OWNER','GROWTH_MANAGER','STORE_MANAGER'].includes(m.role)) && state.users.some(u => u.id === input.ownerUserId && u.status === 'active'), 'case_owner_invalid'); item.ownerUserId = input.ownerUserId; }
      if (input.evidence !== undefined) item.resolutionEvidence = input.evidence ? redactFeedbackText(input.evidence).slice(0, 1000) : null;
      item.updatedAt = nowIso();
      if ((item.status === 'resolved' || item.status === 'closed') && !item.resolutionEvidence) throw new Error('resolution_evidence_required');
      if (['closed','resolved'].includes(item.status)) requireCondition(!state.voiceTasks.some(t => t.caseId === item.id && t.kind === 'manual_reply' && t.status === 'open'), 'manual_reply_evidence_required');
      const feedback = state.feedback.find(f => f.id === item.feedbackId); if (feedback) { feedback.status = item.status; feedback.updatedAt = nowIso(); }
      if (item.status === 'closed' && item.resolutionEvidence) for (const task of state.voiceTasks.filter((task) => task.caseId === item.id && task.status === 'open')) { task.status = 'done'; task.completedAt = nowIso(); task.evidence = item.resolutionEvidence; }
      state.auditEvents.push({ id: randomUUID(), tenantId: input.tenantId, storeId: item.storeId, actorUserId: input.actorUserId, action: 'support_case.updated', resourceType: 'support_case', resourceId: item.id, metadata: { status: item.status, has_evidence: Boolean(item.resolutionEvidence) }, createdAt: nowIso() });
      return item;
    });
  }

  async createReplyRevision(input: { caseId: string; tenantId: string; channel: ReplyRevision['channel']; body: string; createdBy: string }): Promise<ReplyRevision> {
    return this.mutate((state) => {
      const supportCase = state.supportCases.find((item) => item.id === input.caseId && item.tenantId === input.tenantId);
      if (!supportCase) throw new Error('case_not_found');
      const prior = state.replyRevisions.filter((item) => item.caseId === input.caseId).sort((a, b) => b.revision - a.revision)[0];
      requireCondition(!['closed','resolved'].includes(supportCase.status), 'case_closed');
      requireCondition(input.body.trim() && input.body.length <= 4000, 'reply_body_invalid', 400);
      const body = input.body.trim();
      for (const old of state.replyRevisions.filter(r => r.caseId === input.caseId && ['draft','pending_approval','approved'].includes(r.status))) old.status = 'rejected';
      const revision: ReplyRevision = { id: randomUUID(), tenantId: input.tenantId, caseId: input.caseId, revision: (prior?.revision || 0) + 1, channel: input.channel, body, bodyHash: hashOpaque(body), status: 'draft', createdBy: input.createdBy, approvedBy: null, approvedAt: null, approvalHash: null, expiresAt: new Date(Date.now() + 7 * 86400000).toISOString(), createdAt: nowIso() };
      state.replyRevisions.push(revision);
      return revision;
    });
  }
  async submitReplyRevision(id: string, tenantId: string): Promise<ReplyRevision> { return this.mutate((state) => { const item = state.replyRevisions.find((entry) => entry.id === id && entry.tenantId === tenantId); if (!item) throw new Error('reply_not_found'); if (item.status !== 'draft') throw new Error('reply_not_editable'); item.status = 'pending_approval'; return item; }); }
  async approveReplyRevision(id: string, tenantId: string, actorUserId: string): Promise<ReplyRevision> { return this.mutate((state) => { const item = state.replyRevisions.find((entry) => entry.id === id && entry.tenantId === tenantId); if (!item) throw new Error('reply_not_found'); if (item.status !== 'pending_approval') throw new Error('reply_not_pending_approval'); if (hashOpaque(item.body) !== item.bodyHash) throw new Error('reply_hash_mismatch'); requireCondition(Date.parse(item.expiresAt) > Date.now(), 'reply_approval_expired'); item.approvalHash = hashOpaque(JSON.stringify([item.id,item.caseId,item.bodyHash,item.channel,item.expiresAt])); item.status = 'approved'; item.approvedBy = actorUserId; item.approvedAt = nowIso(); return item; }); }
  async executeReplyRevision(id: string, tenantId: string, actorUserId: string): Promise<{ revision: ReplyRevision; task: VoiceTask }> {
    return this.mutate((state) => {
      const item = state.replyRevisions.find((entry) => entry.id === id && entry.tenantId === tenantId);
      if (!item) throw new Error('reply_not_found');
      const existingTask = state.voiceTasks.find(t => t.replyRevisionId === item.id);
      if (existingTask) return { revision: item, task: existingTask };
      if (item.status !== 'approved') throw new Error('reply_not_approved');
      requireCondition(item.approvalHash === hashOpaque(JSON.stringify([item.id,item.caseId,hashOpaque(item.body),item.channel,item.expiresAt])) && Date.parse(item.expiresAt) > Date.now(), 'reply_approval_stale_or_expired');
      const supportCase = state.supportCases.find((entry) => entry.id === item.caseId && entry.tenantId === tenantId);
      if (!supportCase) throw new Error('case_not_found');
      item.status = 'manual_task';
      const task: VoiceTask = { id: randomUUID(), tenantId, caseId: item.caseId, ownerUserId: supportCase.ownerUserId || actorUserId, kind: 'manual_reply', replyRevisionId: item.id, status: 'open', dueAt: new Date(Date.now() + 24 * 3600_000).toISOString(), evidence: `reply_revision:${item.id}`, createdAt: nowIso(), completedAt: null };
      state.voiceTasks.push(task);
      return { revision: item, task };
    });
  }

  async completeVoiceTask(id: string, tenantId: string, actorUserId: string, evidence: string): Promise<VoiceTask> {
    return this.mutate(state => {
      const task = state.voiceTasks.find(t => t.id === id && t.tenantId === tenantId);
      requireCondition(task, 'task_not_found', 404);
      requireCondition(evidence.trim().length >= 3 && evidence.length <= 1000, 'task_evidence_required', 400);
      if (task.status === 'done') return task;
      requireCondition(task.status === 'open', 'task_not_open');
      if (task.replyRevisionId) { const reply = state.replyRevisions.find(r => r.id === task.replyRevisionId); requireCondition(reply && reply.status === 'manual_task', 'reply_superseded'); }
      task.status = 'done'; task.evidence = redactFeedbackText(evidence); task.completedAt = nowIso();
      const supportCase = state.supportCases.find(c => c.id === task.caseId)!;
      state.auditEvents.push({ id: randomUUID(), tenantId, storeId: supportCase.storeId, actorUserId, action: 'voice_task.operator_attested', resourceType: 'voice_task', resourceId: task.id, metadata: { evidence_type: 'operator_attested' }, createdAt: nowIso() });
      return task;
    });
  }

  voiceDailyReport(input: { tenantId: string; storeIds: string[]; asOf?: string }): Record<string, unknown> {
    const rows = this.listFeedback(input.tenantId, input.storeIds);
    const asOf = input.asOf && Number.isFinite(Date.parse(input.asOf)) ? input.asOf : nowIso();
    const day = asOf.slice(0, 10);
    const localDay = (date: string, storeId: string) => new Intl.DateTimeFormat('en-CA', { timeZone: this.requireState().stores.find(s => s.id === storeId)?.timezone || 'Asia/Dhaka' }).format(new Date(date));
    const selected = rows.filter(item => localDay(item.receivedAt, item.storeId) === localDay(asOf, item.storeId));
    const distinct = new Set(selected.map((item) => item.memberId || item.customerRefHash).filter(Boolean));
    const tagCounts: Record<string, number> = {};
    for (const row of selected) for (const tag of row.tags) tagCounts[tag] = (tagCounts[tag] || 0) + 1;
    return { as_of: asOf, date: day, feedback_records: selected.length, distinct_known_customers: distinct.size, tag_counts: tagCounts, urgent_count: selected.filter((item) => item.risk === 'urgent').length, source_refs: selected.map((item) => item.id) };
  }

  // ----- Connector state and delivery ledger (G09) -----
  listConnectorStates(tenantId: string): ConnectorState[] { return this.requireState().connectorStates.filter((item) => item.tenantId === tenantId); }
  getConnectorState(tenantId: string, provider: ConnectorState['provider']): ConnectorState | undefined { return this.requireState().connectorStates.find((item) => item.tenantId === tenantId && item.provider === provider); }
  async setConnectorState(input: Omit<ConnectorState, 'id' | 'updatedAt'>): Promise<ConnectorState> { return this.mutate((state) => { const prior = state.connectorStates.find((item) => item.tenantId === input.tenantId && item.provider === input.provider); if (prior) { Object.assign(prior, input, { updatedAt: nowIso() }); return prior; } const value: ConnectorState = { ...input, id: randomUUID(), updatedAt: nowIso() }; state.connectorStates.push(value); return value; }); }
  listDeliveryIntents(tenantId: string, storeIds: string[]): DeliveryIntent[] { return this.requireState().deliveryIntents.filter((item) => item.tenantId === tenantId && storeIds.includes(item.storeId)); }
  findDeliveryIntent(id: string, tenantId: string): DeliveryIntent | undefined { return this.requireState().deliveryIntents.find((item) => item.id === id && item.tenantId === tenantId); }
  async createDeliveryIntent(input: { tenantId: string; storeId: string; provider: 'whatsapp'; memberId: string; templateName: string; approvalHash: string; idempotencyKey: string; createdBy: string }): Promise<DeliveryIntent> {
    return this.mutate(state => {
      const replay = state.deliveryIntents.find(i => i.tenantId === input.tenantId && i.storeId === input.storeId && i.provider === input.provider && (i.idempotencyKey === input.idempotencyKey || i.requestKeys?.includes(input.idempotencyKey)));
      if (replay) {
        requireCondition(replay.memberId === input.memberId && replay.templateName === input.templateName && replay.approvalHash === input.approvalHash, 'idempotency_key_conflict');
        return replay;
      }
      const campaign = state.outreachCampaigns.find(c => c.tenantId === input.tenantId && c.storeId === input.storeId && c.channel === input.provider && c.approvalHash === input.approvalHash && c.templateId === input.templateName);
      requireCondition(campaign, 'approved_outreach_required');
      const dispatchTime = nowIso();
      const snapshot = approvedOutreachContext(state, campaign, dispatchTime);
      requireCondition(snapshot.memberIds.includes(input.memberId), 'approved_outreach_required');
      const existing = existingDelivery(state, campaign, input.memberId);
      if (existing?.intent) {
        requireCondition(existing.intent.approvalHash === input.approvalHash && existing.intent.templateName === input.templateName, 'delivery_already_dispatched');
        existing.intent.requestKeys = [...new Set([...(existing.intent.requestKeys || []), input.idempotencyKey])];
        return existing.intent;
      }
      requireCondition(!existing, 'delivery_already_dispatched');
      const policy = evaluateMemberDispatch(state, campaign, { memberId: input.memberId, assignment: snapshot.assignments[input.memberId] || 'treatment', quiet: outsideOutreachWindow(state, campaign, dispatchTime), spent: outreachSpend(state, campaign), now: dispatchTime });
      const connector = state.connectorStates.find(c => c.tenantId === input.tenantId && c.provider === input.provider);
      const connectorBlocked = !connector || !connector.enabled || connector.killSwitch || connector.status !== 'active' || !connector.capabilities.sendTemplate || connector.mode === 'manual' || state.externalWritesKillSwitch;
      const blocked = policy.status !== 'eligible' || connectorBlocked;
      const errorCode = policy.status !== 'eligible' ? policy.reason : state.externalWritesKillSwitch ? 'global_kill_switch' : 'connector_not_active';
      const intent: DeliveryIntent = { ...input, id: randomUUID(), outreachId: campaign.id, costMinor: blocked ? 0 : campaign.costPerAttemptMinor, requestKeys: [input.idempotencyKey], status: blocked ? 'blocked' : 'pending', providerReference: null, errorCode: blocked ? errorCode : null, createdAt: dispatchTime, updatedAt: dispatchTime };
      state.deliveryIntents.push(intent);
      refreshOutreachStatus(state, campaign, snapshot);
      return intent;
    });
  }
  async markDeliveryUnknown(id: string, tenantId: string, reason = 'provider_timeout'): Promise<DeliveryIntent> { return this.mutate((state) => { const item = state.deliveryIntents.find((entry) => entry.id === id && entry.tenantId === tenantId); if (!item) throw new Error('delivery_not_found'); if (item.status === 'pending' || item.status === 'accepted') { item.status = 'unknown_delivery'; item.errorCode = reason; item.updatedAt = nowIso(); refreshDeliveryCampaign(state, item); } return item; }); }
  async processWebhook(input: { provider: 'whatsapp'; tenantId: string | null; providerEventId: string; providerMessageId?: string | null; status: DeliveryStatus; occurredAt: string }): Promise<{ duplicate: boolean; intent: DeliveryIntent | null; event: WebhookEvent }> {
    return this.mutate((state) => {
      const duplicate = state.webhookEvents.find((item) => item.provider === input.provider && item.providerEventId === input.providerEventId);
      if (duplicate) return { duplicate: true, intent: input.providerMessageId ? state.deliveryIntents.find((item) => item.providerReference === input.providerMessageId) || null : null, event: duplicate };
      const event: WebhookEvent = { id: randomUUID(), tenantId: input.tenantId, provider: input.provider, providerEventId: input.providerEventId, providerMessageId: input.providerMessageId || null, status: input.status, occurredAt: Number.isFinite(Date.parse(input.occurredAt)) ? new Date(input.occurredAt).toISOString() : nowIso(), receivedAt: nowIso() };
      state.webhookEvents.push(event);
      const intent = input.tenantId ? state.deliveryIntents.find((item) => item.tenantId === input.tenantId && (item.providerReference === input.providerMessageId || item.id === input.providerMessageId || (input.providerMessageId && item.idempotencyKey === input.providerMessageId))) : undefined;
      if (intent && canAdvanceDelivery(intent.status, input.status)) { intent.status = input.status; intent.providerReference = input.providerMessageId || intent.providerReference; intent.updatedAt = nowIso(); refreshDeliveryCampaign(state, intent); }
      return { duplicate: false, intent: intent || null, event };
    });
  }

  // ----- Daily control reports (G08) -----
  listDailyReports(tenantId: string, storeIds: string[], storeId?: string | null): DailyReport[] {
    const state = this.requireState();
    const reports = state.dailyReports.filter(r => (!storeId || r.storeId === storeId) && canReadDailyReport(state, tenantId, storeIds, r));
    return reports.map(r => ({ ...r, restatedFrom: reports.some(prior => prior.id === r.restatedFrom) ? r.restatedFrom : null }));
  }
  listControlTasks(tenantId: string, storeIds: string[]): ControlTask[] {
    const state = this.requireState();
    return state.controlTasks.filter(task => canReadControlTask(state, tenantId, storeIds, task));
  }
  async completeControlTask(id: string, tenantId: string, actorUserId: string, evidence: string): Promise<ControlTask> {
    return this.mutate(state => {
      const task = state.controlTasks.find(t => t.id === id && t.tenantId === tenantId);
      const membership = state.memberships.find(m => m.tenantId === tenantId && m.userId === actorUserId && !m.revokedAt);
      requireCondition(task && membership && canReadControlTask(state, tenantId, membership.storeIds, task), 'control_task_not_found', 404);
      requireCondition(task.ownerUserId === actorUserId, 'control_task_owner_required', 403);
      requireCondition(evidence.trim(), 'task_evidence_required');
      task.status = 'done'; task.completionEvidence = evidence.trim().slice(0, 1000);
      return task;
    });
  }
  async createControlTask(input: Omit<ControlTask, 'id' | 'createdAt' | 'status'>): Promise<ControlTask> { return this.mutate((state) => { const existing = state.controlTasks.find(item => item.tenantId === input.tenantId && item.ownerUserId === input.ownerUserId && item.title === input.title && item.targetMetric === input.targetMetric && item.storeIds.length === input.storeIds.length && item.storeIds.every(storeId => input.storeIds.includes(storeId)) && ['open','in_progress'].includes(item.status)); if (existing) return existing; const task: ControlTask = { ...input, id: randomUUID(), status: 'open', createdAt: nowIso() }; state.controlTasks.push(task); return task; }); }
  async createDailyReport(input: Omit<DailyReport, 'id' | 'version' | 'createdAt' | 'restatedFrom'>): Promise<DailyReport> { return this.mutate((state) => { const prior = state.dailyReports.filter((item) => item.tenantId === input.tenantId && item.storeId === input.storeId && JSON.stringify([...item.storeIds].sort()) === JSON.stringify([...input.storeIds].sort())).sort((a, b) => b.version - a.version)[0]; const sameDay = prior && prior.asOf.slice(0, 10) === input.asOf.slice(0, 10); const report: DailyReport = { ...input, id: randomUUID(), version: (prior?.version || 0) + 1, restatedFrom: sameDay ? prior.id : null, createdAt: nowIso() }; state.dailyReports.push(report); return report; }); }
  async setGlobalKillSwitch(value: boolean): Promise<void> { await this.mutate((state) => { state.externalWritesKillSwitch = value; if (value) for (const intent of state.deliveryIntents.filter((item) => item.status === 'pending' || item.status === 'accepted')) { intent.status = intent.status === 'pending' && !intent.providerReference ? 'blocked' : 'unknown_delivery'; intent.errorCode = 'global_kill_switch'; intent.updatedAt = nowIso(); refreshDeliveryCampaign(state, intent); } }); }

  outreachReport(id: string, tenantId: string): Record<string, unknown> {
    const state = this.requireState();
    const campaign = state.outreachCampaigns.find((item) => item.id === id && item.tenantId === tenantId);
    if (!campaign) throw new Error('outreach_not_found');
    const snapshot = state.audienceSnapshots.find((item) => item.id === campaign.audienceSnapshotId && item.tenantId === tenantId);
    if (!snapshot) throw new Error('audience_snapshot_not_found');
    return reportFromState(state, campaign, snapshot);
  }

  listCampaigns(tenantId: string, storeIds: string[]): Campaign[] {
    return this.requireState().campaigns.filter(
      (campaign) => campaign.tenantId === tenantId && storeIds.includes(campaign.storeId)
    );
  }

  findCampaign(id: string): Campaign | undefined {
    return this.requireState().campaigns.find((campaign) => campaign.id === id);
  }

  async updateCampaign(id: string, patch: Partial<Pick<Campaign, 'name' | 'objective' | 'budgetMinor' | 'status' | 'needsInput' | 'startAt' | 'endAt' | 'productIds' | 'assetIds'>>): Promise<Campaign | undefined> {
    return this.mutate((state) => {
      const campaign = state.campaigns.find((item) => item.id === id);
      if (!campaign) return undefined;
      const changesApprovedPayload = (['name', 'objective', 'budgetMinor', 'startAt', 'endAt', 'productIds', 'assetIds'] as const).some(key => patch[key] !== undefined && JSON.stringify(patch[key]) !== JSON.stringify(campaign[key]));
      if (campaign.status === 'approved' && changesApprovedPayload && patch.status === undefined) patch.status = 'pending_approval';
      const dates = { ...campaign, ...patch };
      requireTimeRange(dates.startAt ?? null, dates.endAt ?? null, 'invalid_campaign_window');
      Object.assign(campaign, patch, { updatedAt: nowIso(), revision: campaign.revision + 1 });
      return campaign;
    });
  }

  async audit(event: Omit<AuditEvent, 'id' | 'createdAt'>): Promise<void> {
    await this.mutate((state) => {
      state.auditEvents.push({ ...event, id: randomUUID(), createdAt: nowIso() });
    });
  }

  async heartbeat(instanceId: string): Promise<void> {
    await this.mutate((state) => {
      state.workerHeartbeatAt = nowIso();
      state.workerInstanceId = instanceId;
    });
  }

  listJobs(tenantId?: string | null): Job[] {
    return this.requireState().jobs.filter((job) => tenantId === undefined || job.tenantId === tenantId);
  }

  /** Recover expired leases and legacy jobs without lease metadata. */
  async recoverInterruptedJobs(now: string | Date = new Date()): Promise<number> {
    return this.mutate((state) => {
      const nowMs = typeof now === 'string' ? Date.parse(now) : now.getTime();
      const cutoff = Number.isFinite(nowMs) ? nowMs : Date.now();
      let recovered = 0;
      for (const job of state.jobs) {
        if (job.status !== 'running') continue;
        const leaseMs = job.leaseExpiresAt ? Date.parse(job.leaseExpiresAt) : Number.NaN;
        if (Number.isFinite(leaseMs) && leaseMs > cutoff) continue;
        job.status = 'queued';
        job.lastError = 'worker_interrupted_requeued';
        job.leaseOwnerId = null;
        job.leaseToken = null;
        job.leaseExpiresAt = null;
        job.leaseHeartbeatAt = null;
        job.updatedAt = nowIso();
        recovered += 1;
      }
      return recovered;
    });
  }

  /** Atomically claim one queued job and assign it a renewable worker lease. */
  async claimNextJob(workerId = `worker-${randomUUID()}`, leaseSeconds = 60): Promise<Job | undefined> {
    return this.mutate((state) => {
      const job = state.jobs.find((item) => item.status === 'queued');
      if (!job) return undefined;
      const ttl = Number.isFinite(leaseSeconds) && leaseSeconds > 0 ? leaseSeconds : 60;
      job.status = 'running';
      job.attempts += 1;
      job.leaseOwnerId = workerId;
      job.leaseToken = randomUUID();
      job.leaseExpiresAt = new Date(Date.now() + ttl * 1000).toISOString();
      job.leaseHeartbeatAt = nowIso();
      job.updatedAt = nowIso();
      return job;
    });
  }

  /** Extend a lease while a long-running handler is still making progress. */
  async renewJobLease(id: string, workerId: string, leaseTokenOrSeconds?: string | number, leaseSeconds = 60): Promise<Job | undefined> {
    return this.mutate((state) => {
      const job = state.jobs.find((item) => item.id === id);
      const leaseToken = typeof leaseTokenOrSeconds === 'string' ? leaseTokenOrSeconds : undefined;
      const requestedSeconds = typeof leaseTokenOrSeconds === 'number' ? leaseTokenOrSeconds : leaseSeconds;
      if (!job || job.status !== 'running' || job.leaseOwnerId !== workerId || (job.leaseToken && leaseToken !== job.leaseToken)) return undefined;
      const ttl = Number.isFinite(requestedSeconds) && requestedSeconds > 0 ? requestedSeconds : 60;
      job.leaseExpiresAt = new Date(Date.now() + ttl * 1000).toISOString();
      job.leaseHeartbeatAt = nowIso();
      job.updatedAt = nowIso();
      return job;
    });
  }

  /** A stale worker cannot finish a job claimed by another worker. */
  async finishJob(id: string, status: 'succeeded' | 'failed', lastError: string | null = null, workerId?: string, leaseToken?: string): Promise<Job | undefined> {
    return this.mutate((state) => {
      const job = state.jobs.find((item) => item.id === id);
      if (!job) return undefined;
      if (workerId && (job.status !== 'running' || job.leaseOwnerId !== workerId || (job.leaseToken && leaseToken !== job.leaseToken))) return undefined;
      if (!workerId && job.status === 'running' && job.leaseOwnerId) return undefined;
      job.status = status;
      job.lastError = lastError;
      job.leaseOwnerId = null;
      job.leaseToken = null;
      job.leaseExpiresAt = null;
      job.leaseHeartbeatAt = null;
      job.updatedAt = nowIso();
      return job;
    });
  }

  async enqueueJob(input: Omit<Job, 'id' | 'createdAt' | 'updatedAt' | 'attempts' | 'status' | 'lastError'>): Promise<Job> {
    return this.mutate((state) => {
      const existing = state.jobs.find((job) => job.idempotencyKey === input.idempotencyKey);
      if (existing) return existing;
      const job: Job = {
        ...input,
        id: randomUUID(),
        status: 'queued',
        attempts: 0,
        lastError: null,
        leaseOwnerId: null,
        leaseExpiresAt: null,
        leaseToken: null,
        leaseHeartbeatAt: null,
        createdAt: nowIso(),
        updatedAt: nowIso()
      };
      state.jobs.push(job);
      return job;
    });
  }
}

type RepositoryState = DatabaseState;

function stateStoreIds(state: RepositoryState, caseId: string, storeIds: string[]): boolean {
  const supportCase = state.supportCases.find((item) => item.id === caseId);
  return Boolean(supportCase && storeIds.includes(supportCase.storeId));
}

function createSupportCaseInState(state: RepositoryState, feedback: FeedbackRecord, ownerUserId: string | null): SupportCase {
  const supportCase: SupportCase = {
    id: randomUUID(), tenantId: feedback.tenantId, storeId: feedback.storeId, feedbackId: feedback.id,
    ownerUserId, slaDueAt: new Date(Date.now() + (feedback.risk === 'urgent' ? 4 : 48) * 3600_000).toISOString(),
    status: feedback.risk === 'urgent' ? 'open' : 'in_progress', escalationLevel: feedback.risk === 'urgent' ? 'urgent' : 'normal',
    resolutionEvidence: null, createdAt: nowIso(), updatedAt: nowIso()
  };
  state.supportCases.push(supportCase);
  state.voiceTasks.push({ id: randomUUID(), tenantId: feedback.tenantId, caseId: supportCase.id, ownerUserId, kind: feedback.risk === 'urgent' ? 'safety_escalation' : 'human_review', status: 'open', dueAt: supportCase.slaDueAt, evidence: null, createdAt: nowIso(), completedAt: null });
  return supportCase;
}

function orderMatchesMember(order: OrderRecord, member: MemberRecord): boolean {
  return order.memberId === member.id || order.memberId === member.externalMemberId;
}

function refundedAmount(state: RepositoryState, order: OrderRecord): number {
  const seen = new Set<string>();
  return state.refunds.filter((refund) => {
    if (orderKey(refund) !== orderKey(order)) return false;
    const key = `${refund.source}|${refund.externalAdjustmentId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).reduce((sum, refund) => sum + refund.amountMinor, 0);
}

function countableOrdersForMember(state: RepositoryState, member: MemberRecord): OrderRecord[] {
  return currentOrders(state.orders).filter((order) => order.tenantId === member.tenantId && order.storeId === member.storeId && order.active && order.status === 'paid' && orderMatchesMember(order, member) && refundedAmount(state, order) < order.amountPaidMinor).sort((a, b) => Date.parse(a.paidAt) - Date.parse(b.paidAt));
}

function currentMarketingConsent(state: RepositoryState, tenantId: string, memberId: string): boolean {
  return marketingConsentForChannel(state, tenantId, memberId, 'manual');
}

function segmentRuleMatches(state: RepositoryState, member: MemberRecord, rule: SegmentRule, asOf: string, eventId: string | null): { ok: boolean; reason: string } {
  const orders = countableOrdersForMember(state, member);
  if (rule === 'registered_unpurchased') return orders.length === 0 ? { ok: true, reason: 'registered_without_purchase' } : { ok: false, reason: 'has_purchase' };
  if (rule === 'first_purchase_no_second') return orders.length === 1 ? { ok: true, reason: 'one_purchase' } : { ok: false, reason: orders.length === 0 ? 'no_purchase' : 'second_purchase_observed' };
  if (rule === 'inactive_14d') {
    if (!orders.length) return { ok: false, reason: 'no_purchase_history' };
    const last = Date.parse(orders[orders.length - 1].paidAt);
    return Date.parse(asOf) - last >= 14 * 86_400_000 ? { ok: true, reason: 'inactive_14d' } : { ok: false, reason: 'active_within_14d' };
  }
  if (rule === 'event_participant') {
    const participated = state.eventCheckins.some((checkin) => checkin.tenantId === member.tenantId && checkin.memberId === member.id && (!eventId || checkin.eventId === eventId)) || state.eventRegistrations.some((registration) => registration.tenantId === member.tenantId && registration.memberId === member.id && registration.status === 'registered' && (!eventId || registration.eventId === eventId));
    return participated ? { ok: true, reason: 'event_registration_or_checkin' } : { ok: false, reason: 'no_event_participation' };
  }
  const optedIn = currentMarketingConsent(state, member.tenantId, member.id);
  return optedIn ? { ok: true, reason: 'marketing_opt_in' } : { ok: false, reason: 'marketing_not_opted_in' };
}

function segmentPreviewFromState(state: RepositoryState, input: { tenantId: string; storeIds: string[]; rule: SegmentRule; asOf: string; eventId?: string | null }): {
  rule: SegmentRule;
  asOf: string;
  memberIds: string[];
  count: number;
  totalMembers: number;
  coverage: { eligible: number; total: number; ratio: number; knownHistory: number };
  reasons: Record<string, number>;
} {
  const members = state.members.filter((member) => member.tenantId === input.tenantId && input.storeIds.includes(member.storeId));
  const memberIds: string[] = [];
  const reasons: Record<string, number> = {};
  for (const member of members) {
    const matches = segmentRuleMatches(state, member, input.rule, input.asOf, input.eventId || null);
    if (matches.ok) memberIds.push(member.id);
    reasons[matches.reason] = (reasons[matches.reason] || 0) + 1;
  }
  const knownHistory = members.filter((member) => state.orders.some((order) => order.tenantId === input.tenantId && order.storeId === member.storeId && order.active && order.status === 'paid' && orderMatchesMember(order, member))).length;
  return { rule: input.rule, asOf: input.asOf, memberIds, count: memberIds.length, totalMembers: members.length, coverage: { eligible: memberIds.length, total: members.length, ratio: members.length ? memberIds.length / members.length : 1, knownHistory }, reasons };
}

function stableHoldoutAssignment(seed: string, memberId: string, holdoutPercent: number): 'treatment' | 'holdout' {
  const digest = createHash('sha256').update(`${seed}:${memberId}`).digest();
  const bucket = digest.readUInt32BE(0) % 10000;
  return bucket < holdoutPercent * 100 ? 'holdout' : 'treatment';
}

function reportFromState(state: RepositoryState, campaign: OutreachCampaign, snapshot: AudienceSnapshot): Record<string, unknown> {
  const attempts = state.messageAttempts.filter((attempt) => attempt.outreachId === campaign.id);
  const byMember = new Map<string, { status: string }>(attempts.map(attempt => [attempt.memberId, attempt]));
  for (const entry of outreachLedger(state).filter(e => e.outreachId === campaign.id && e.intent)) byMember.set(entry.memberId, { status: entry.intent!.status });
  const group = (assignment: 'treatment' | 'holdout') => {
    const assigned = snapshot.memberIds.filter((memberId) => snapshot.assignments[memberId] === assignment);
    const rows = assigned.map((memberId) => byMember.get(memberId));
    const statuses: Record<string, number> = {};
    for (const row of rows) {
      const status = row?.status || 'not_attempted';
      statuses[status] = (statuses[status] || 0) + 1;
    }
    const memberRecords = assigned.map((memberId) => state.members.find((member) => member.id === memberId)).filter((member): member is MemberRecord => Boolean(member));
    const purchases = state.orders.filter((order) => order.tenantId === campaign.tenantId && order.storeId === campaign.storeId && order.active && order.status === 'paid' && memberRecords.some((member) => orderMatchesMember(order, member)) && refundedAmount(state, order) < order.amountPaidMinor);
    const buyers = new Set(purchases.map((order) => order.memberId || 'anonymous')).size;
    return { assigned: assigned.length, attempted: rows.filter(Boolean).length, sent: rows.filter(row => row?.status === 'sent_test' || row?.status === 'delivered').length, statuses, qualified_order_count: purchases.length, buyer_count: buyers, revenue_minor: purchases.reduce((sum, order) => sum + order.amountPaidMinor - refundedAmount(state, order), 0), conversion_rate: assigned.length ? buyers / assigned.length : null };
  };
  const treatment = group('treatment');
  const holdout = group('holdout');
  const assigned = snapshot.memberIds.length;
  return {
    outreach_id: campaign.id,
    status: campaign.status,
    budget: outreachBudget(state, campaign),
    assigned_count: assigned,
    treatment,
    holdout,
    exploratory: assigned < 30,
    sample_size: assigned,
    analysis_population: 'all_frozen_assignments_including_holdout_and_not_sent',
    attempts: attempts.map((attempt) => ({ member_id: attempt.memberId, assignment: attempt.assignment, status: attempt.status, reason: attempt.reason, created_at: attempt.createdAt })),
    no_causal_claim: assigned < 30 ? 'sample_size_below_30' : null
  };
}

function extractFacts(tenantId: string, revision: BrandRevision, content: string): BrandFact[] {
  let parsed: unknown;
  try { parsed = JSON.parse(content); } catch { parsed = { source_text: content }; }
  const rows: Array<{ key: string; value: string | null; valueType: BrandFact['valueType'] }> = [];
  const walk = (value: unknown, prefix: string): void => {
    if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      const valueType: BrandFact['valueType'] = /date|_at$|launch/i.test(prefix) ? 'date' : /price|amount|cost|budget|currency/i.test(prefix) ? 'money' : /url|link|asset/i.test(prefix) ? 'url' : typeof value === 'boolean' ? 'boolean' : 'text';
      rows.push({ key: prefix, value: value === null ? null : String(value), valueType });
      return;
    }
    if (Array.isArray(value)) {
      if (value.every((item) => ['string', 'number', 'boolean'].includes(typeof item))) rows.push({ key: prefix, value: value.join(', '), valueType: 'text' });
      else value.forEach((item, index) => walk(item, `${prefix}[${index}]`));
      return;
    }
    if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) walk(child, prefix ? `${prefix}.${key}` : key);
  };
  walk(parsed, '');
  return rows.filter((row) => row.key).map((row) => ({
    id: randomUUID(), tenantId, revisionId: revision.id, key: row.key, value: row.value, valueType: row.valueType,
    sourceCitation: revision.id, status: revision.status, effectiveFrom: revision.effectiveFrom, effectiveTo: revision.effectiveTo
  }));
}
