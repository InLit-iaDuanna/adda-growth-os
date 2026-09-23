import fs from 'node:fs/promises';
import path from 'node:path';
import { computeMetricBundle } from '../packages/domain/src/metric-engine';
import type { MemberRecord, OrderRecord, RefundRecord } from '../packages/domain/src/imports';

async function main(): Promise<void> {
  const count = Number(process.argv[2] || 100_000);
  const now = new Date('2026-09-22T12:00:00.000Z').toISOString();
  const orders: OrderRecord[] = Array.from({ length: count }, (_, index) => ({ id: `perf-${index}`, tenantId: 'perf-tenant', storeId: 'perf-store', source: 'synthetic', externalOrderId: `order-${index}`, memberId: index % 2 ? `member-${index % 20000}` : null, paidAt: '2026-01-01T12:00:00.000Z', currency: 'BDT', amountPaidMinor: 1000 + (index % 100), status: 'paid', revision: 1, sourceRowHash: `hash-${index}`, active: true, correctionOfId: null, createdAt: now, updatedAt: now }));
  const members: MemberRecord[] = Array.from({ length: 20_000 }, (_, index) => ({ id: `m-${index}`, tenantId: 'perf-tenant', storeId: 'perf-store', externalMemberId: `member-${index}`, displayName: null, registeredAt: '2025-12-01T12:00:00.000Z', language: 'en', contact: null, contactHmac: null, publicAccessTokenHash: null, isSynthetic: true, contactVerified: false, verificationProof: null, verificationExpiresAt: null, createdAt: now }));
  const refunds: RefundRecord[] = [];
  const runs: number[] = [];
  for (let i = 0; i < 5; i += 1) { const started = performance.now(); computeMetricBundle({ orders, refunds, members, attribution: [], asOf: now, completeThrough: now, timezone: 'Asia/Dhaka' }); runs.push(performance.now() - started); }
  runs.sort((a, b) => a - b);
  const result = { generated_orders: count, generated_members: members.length, runs_ms: runs, p95_ms: runs[Math.min(runs.length - 1, Math.ceil(runs.length * 0.95) - 1)], environment: { node: process.version, note: 'synthetic single-process metric-engine measurement; not the 4vCPU/8GiB/20-user service benchmark' } };
  await fs.mkdir('artifacts/G10', { recursive: true });
  await fs.writeFile(path.join('artifacts/G10', 'performance-latest.json'), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result));
}
main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
