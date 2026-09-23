export type PartnerStage = 'identified' | 'verified' | 'invited' | 'agreed' | 'active' | 'reviewed' | 'paused' | 'closed';

export interface PartnerRecord {
  id: string;
  tenantId: string;
  name: string;
  kind: 'organization' | 'koc' | 'club' | 'other';
  sourceUrl: string;
  sourceNote: string | null;
  verifiedAt: string | null;
  contactPermission: boolean;
  stage: PartnerStage;
  followerCount: number | null;
  createdBy: string;
  createdAt: string;
}

export interface EventTemplate {
  id: string;
  key: string;
  name: string;
  capacityDefault: number;
  budgetMinorDefault: number | null;
  requiredPermissions: string[];
  successMetric: string;
}

export interface EventRecord {
  id: string;
  tenantId: string;
  storeId: string;
  campaignId: string | null;
  templateId: string;
  name: string;
  startsAt: string | null;
  endsAt: string | null;
  capacity: number;
  registrationCount: number;
  checkinCount: number;
  status: 'draft' | 'open' | 'closed' | 'cancelled';
  createdBy: string;
  createdAt: string;
}

export interface EventRegistration {
  id: string;
  tenantId: string;
  eventId: string;
  memberId: string | null;
  contactHmac: string | null;
  status: 'registered' | 'cancelled';
  createdAt: string;
}

export interface EventCheckin {
  id: string;
  tenantId: string;
  eventId: string;
  memberId: string | null;
  registrationId: string | null;
  checkedInBy: string;
  method: 'staff_confirmed' | 'scan';
  createdAt: string;
}

export interface ReferralRecord {
  id: string;
  tenantId: string;
  storeId: string;
  inviterMemberId: string;
  inviteeMemberId: string;
  sourceLinkId: string | null;
  status: 'registered' | 'qualified' | 'ineligible' | 'reversed';
  firstQualifiedOrderId: string | null;
  reason: string | null;
  createdAt: string;
}

export interface RewardLedgerEntry {
  id: string;
  tenantId: string;
  referralId: string;
  amountMinor: number | null;
  currency: string;
  status: 'pending_review' | 'eligible' | 'approved' | 'reversed' | 'not_payable';
  approvedBy: string | null;
  approvedAt: string | null;
  reason: string | null;
  createdAt: string;
}

export const defaultEventTemplates: EventTemplate[] = [
  { id: 'tpl-cup-tasting', key: 'cup_tasting', name: 'Tea tasting', capacityDefault: 20, budgetMinorDefault: null, requiredPermissions: ['asset_use'], successMetric: 'verified_first_orders' },
  { id: 'tpl-study-break', key: 'study_break', name: 'Study break adda', capacityDefault: 30, budgetMinorDefault: null, requiredPermissions: ['venue_confirmation'], successMetric: 'registrations_and_checkins' },
  { id: 'tpl-club-collab', key: 'club_collab', name: 'Club collaboration', capacityDefault: 40, budgetMinorDefault: null, requiredPermissions: ['partner_agreement'], successMetric: 'verified_first_orders' },
  { id: 'tpl-open-mic', key: 'open_mic', name: 'Open mic', capacityDefault: 50, budgetMinorDefault: null, requiredPermissions: ['venue_confirmation', 'content_rights'], successMetric: 'verified_first_orders' },
  { id: 'tpl-campus-walk', key: 'campus_walk', name: 'Campus walk', capacityDefault: 25, budgetMinorDefault: null, requiredPermissions: ['route_review'], successMetric: 'checkins' },
  { id: 'tpl-friends-table', key: 'friends_table', name: 'Friends table', capacityDefault: 16, budgetMinorDefault: null, requiredPermissions: ['venue_confirmation'], successMetric: 'verified_first_orders' },
  { id: 'tpl-exam-reset', key: 'exam_reset', name: 'Exam reset', capacityDefault: 30, budgetMinorDefault: null, requiredPermissions: ['date_confirmation'], successMetric: 'registrations_and_checkins' },
  { id: 'tpl-story-circle', key: 'story_circle', name: 'Tea story circle', capacityDefault: 18, budgetMinorDefault: null, requiredPermissions: ['content_rights'], successMetric: 'verified_first_orders' },
  { id: 'tpl-mate-meetup', key: 'mate_meetup', name: 'ADDA MATE meetup', capacityDefault: 24, budgetMinorDefault: null, requiredPermissions: ['venue_confirmation'], successMetric: 'verified_first_orders' },
  { id: 'tpl-creator-session', key: 'creator_session', name: 'Creator session', capacityDefault: 12, budgetMinorDefault: null, requiredPermissions: ['ugc_rights'], successMetric: 'approved_ugc' },
  { id: 'tpl-community-day', key: 'community_day', name: 'Community day', capacityDefault: 60, budgetMinorDefault: null, requiredPermissions: ['partner_agreement', 'venue_confirmation'], successMetric: 'verified_first_orders' },
  { id: 'tpl-feedback-lab', key: 'feedback_lab', name: 'Feedback lab', capacityDefault: 15, budgetMinorDefault: null, requiredPermissions: ['notice_version'], successMetric: 'feedback_resolution' }
];
