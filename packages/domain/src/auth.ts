import { createHmac, timingSafeEqual } from 'node:crypto';
import type { ActorContext, Role, Session, Store, Tenant } from './types';

export type Permission =
  | 'platform:manage'
  | 'campaign:read'
  | 'campaign:create'
  | 'campaign:edit_budget'
  | 'campaign:approve'
  | 'member:export'
  | 'outreach:read'
  | 'outreach:create'
  | 'outreach:approve'
  | 'outreach:dispatch'
  | 'integration:manage'
  | 'report:read'
  | 'settings:manage';
// Brand and menu operations remain separate from settings permissions.
export type BrandPermission = 'brand:read' | 'brand:write' | 'brand:approve' | 'product:write' | 'asset:write' | 'import:write';

const permissions: Record<Role, ReadonlySet<Permission | BrandPermission>> = {
  PLATFORM_OPERATOR: new Set(['platform:manage', 'integration:manage']),
  OWNER: new Set([
    'campaign:read', 'campaign:create', 'campaign:edit_budget', 'campaign:approve',
    'member:export', 'outreach:read', 'outreach:create', 'outreach:approve', 'outreach:dispatch', 'integration:manage', 'report:read', 'settings:manage', 'brand:read', 'brand:write', 'brand:approve', 'product:write', 'asset:write', 'import:write'
  ]),
  GROWTH_MANAGER: new Set([
    'campaign:read', 'campaign:create', 'campaign:edit_budget', 'campaign:approve',
    'member:export', 'outreach:read', 'outreach:create', 'outreach:approve', 'outreach:dispatch', 'report:read', 'brand:read', 'brand:write', 'brand:approve', 'product:write', 'asset:write', 'import:write'
  ]),
  LOCAL_REVIEWER: new Set(['campaign:read', 'outreach:read', 'report:read', 'brand:read']),
  STORE_MANAGER: new Set(['campaign:read', 'campaign:create', 'campaign:edit_budget', 'outreach:read', 'outreach:create', 'report:read', 'brand:read', 'product:write', 'asset:write', 'import:write']),
  CASHIER: new Set(['campaign:read']),
  ANALYST: new Set(['campaign:read', 'outreach:read', 'report:read', 'brand:read'])
};

export function hasPermission(actor: ActorContext, permission: Permission): boolean {
  return permissions[actor.role].has(permission);
}

export function hasBrandPermission(actor: ActorContext, permission: BrandPermission): boolean {
  return permissions[actor.role].has(permission);
}

export function roleCan(role: Role, permission: Permission): boolean {
  return permissions[role].has(permission);
}

export function canAccessStore(actor: ActorContext, store: Store): boolean {
  return actor.tenantId === store.tenantId && actor.storeIds.includes(store.id);
}

export function canAccessStoreScope(allowed: string[], required: string[] | undefined): boolean {
  return Boolean(required?.length && required.every(id => allowed.includes(id)));
}

export function canAccessTenant(actor: ActorContext, tenant: Tenant): boolean {
  return actor.tenantId === tenant.id;
}

export function actorFromSession(
  session: Session,
  role: Role,
  storeIds: string[]
): ActorContext {
  return { userId: session.userId, tenantId: session.tenantId, role, storeIds, sessionId: session.id };
}

export function signCookie(value: string, secret: string): string {
  const digest = createHmac('sha256', secret).update(value).digest('base64url');
  return `${value}.${digest}`;
}

export function verifyCookie(signed: string, secret: string): string | null {
  const separator = signed.lastIndexOf('.');
  if (separator <= 0) return null;
  const value = signed.slice(0, separator);
  const provided = signed.slice(separator + 1);
  const expected = createHmac('sha256', secret).update(value).digest('base64url');
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return value;
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  for (const part of (header || '').split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) result[key] = decodeURIComponent(value);
  }
  return result;
}

export function safeActor(actor: ActorContext): Record<string, unknown> {
  return {
    user_id: actor.userId,
    tenant_id: actor.tenantId,
    role: actor.role,
    store_ids: actor.storeIds,
    permissions: Array.from(permissions[actor.role]).sort()
  };
}
