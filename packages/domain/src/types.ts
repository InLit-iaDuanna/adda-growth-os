import type { AppMode } from '../../adapters/src/config';
import type {
  BrandDocument,
  BrandFact,
  BrandReference,
  BrandRevision,
  MediaAsset,
  PriceVersion,
  Product
} from './brand';
import type {
  AttributionEvidenceRecord,
  ImportBatch,
  ImportRowError,
  ImportStagedRow,
  MemberRecord,
  OrderRecord,
  RefundRecord,
  SourceWatermark
} from './imports';
import type {
  ConsentEvent,
  IssuedCoupon,
  Offer,
  RedemptionAttempt,
  SourceLink,
  SuppressionEntry,
  TouchEvent
} from './growth';
import type { ContentApproval, ContentBrief, ContentRevision, PublicationIntent, PublicationReceipt } from './content';
import type { EventCheckin, EventRecord, EventRegistration, EventTemplate, PartnerRecord, ReferralRecord, RewardLedgerEntry } from './campus';
import type { AudienceSnapshot, MessageAttempt, OutreachCampaign, SegmentDefinition } from './crm';
import type { FeedbackRecord, FeedbackClassification, SupportCase, ReplyRevision, VoiceTask } from './voice';
import type { ConnectorState, DeliveryIntent, WebhookEvent } from './connectors';
import type { DailyReport, ControlTask } from './control';

export type Role =
  | 'PLATFORM_OPERATOR'
  | 'OWNER'
  | 'GROWTH_MANAGER'
  | 'LOCAL_REVIEWER'
  | 'STORE_MANAGER'
  | 'CASHIER'
  | 'ANALYST';

export type CampaignStatus = 'draft' | 'needs_input' | 'pending_approval' | 'approved' | 'archived';

export interface Tenant {
  id: string;
  slug: string;
  name: string;
  mode: AppMode;
  status: 'active' | 'suspended';
  timezone: string;
  currency: string;
  launchDate: string | null;
  createdAt: string;
}

export interface Store {
  id: string;
  tenantId: string;
  slug: string;
  name: string;
  timezone: string;
  currency: string;
  orderSources?: string[];
  status: 'active' | 'inactive';
  createdAt: string;
}

export interface User {
  id: string;
  email: string;
  displayName: string;
  passwordHash: string;
  status: 'active' | 'disabled';
  createdAt: string;
}

export interface Membership {
  id: string;
  tenantId: string;
  userId: string;
  role: Role;
  storeIds: string[];
  revokedAt: string | null;
}

export interface Session {
  id: string;
  userId: string;
  tenantId: string;
  csrfToken: string;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
}

export interface Campaign {
  id: string;
  tenantId: string;
  storeId: string;
  name: string;
  objective: string | null;
  budgetMinor: number | null;
  startAt?: string | null;
  endAt?: string | null;
  productIds?: string[];
  assetIds?: string[];
  status: CampaignStatus;
  needsInput: string[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
}

export interface AuditEvent {
  id: string;
  tenantId: string;
  storeId: string | null;
  actorUserId: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface Job {
  id: string;
  tenantId: string | null;
  type: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  idempotencyKey: string;
  attempts: number;
  lastError: string | null;
  /** Worker lease owner. Optional for backwards-compatible reads of v1 files. */
  leaseOwnerId?: string | null;
  /** Fencing token for this lease; changes on every reclaim/claim. */
  leaseToken?: string | null;
  /** ISO timestamp at which a running lease may be recovered. */
  leaseExpiresAt?: string | null;
  /** Last lease renewal time, useful for worker liveness diagnostics. */
  leaseHeartbeatAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DatabaseState {
  schemaVersion: number;
  initializedAt: string;
  tenants: Tenant[];
  stores: Store[];
  users: User[];
  memberships: Membership[];
  sessions: Session[];
  campaigns: Campaign[];
  brandDocuments: BrandDocument[];
  brandRevisions: BrandRevision[];
  brandFacts: BrandFact[];
  products: Product[];
  priceVersions: PriceVersion[];
  mediaAssets: MediaAsset[];
  brandReferences: BrandReference[];
  members: MemberRecord[];
  orders: OrderRecord[];
  refunds: RefundRecord[];
  imports: ImportBatch[];
  importErrors: ImportRowError[];
  importRows: ImportStagedRow[];
  sourceWatermarks: SourceWatermark[];
  attributionEvidence: AttributionEvidenceRecord[];
  sourceLinks: SourceLink[];
  touchEvents: TouchEvent[];
  consentEvents: ConsentEvent[];
  suppressionEntries: SuppressionEntry[];
  offers: Offer[];
  issuedCoupons: IssuedCoupon[];
  redemptionAttempts: RedemptionAttempt[];
  contentBriefs: ContentBrief[];
  contentRevisions: ContentRevision[];
  contentApprovals: ContentApproval[];
  publicationIntents: PublicationIntent[];
  publicationReceipts: PublicationReceipt[];
  partners: PartnerRecord[];
  eventTemplates: EventTemplate[];
  events: EventRecord[];
  eventRegistrations: EventRegistration[];
  eventCheckins: EventCheckin[];
  referrals: ReferralRecord[];
  rewardLedger: RewardLedgerEntry[];
  segmentDefinitions: SegmentDefinition[];
  audienceSnapshots: AudienceSnapshot[];
  outreachCampaigns: OutreachCampaign[];
  messageAttempts: MessageAttempt[];
  feedback: FeedbackRecord[];
  feedbackClassifications: FeedbackClassification[];
  supportCases: SupportCase[];
  replyRevisions: ReplyRevision[];
  voiceTasks: VoiceTask[];
  connectorStates: ConnectorState[];
  deliveryIntents: DeliveryIntent[];
  webhookEvents: WebhookEvent[];
  dailyReports: DailyReport[];
  controlTasks: ControlTask[];
  externalWritesKillSwitch: boolean;
  auditEvents: AuditEvent[];
  jobs: Job[];
  workerHeartbeatAt: string | null;
  workerInstanceId: string | null;
}

export interface ActorContext {
  userId: string;
  tenantId: string;
  role: Role;
  storeIds: string[];
  sessionId: string;
}
