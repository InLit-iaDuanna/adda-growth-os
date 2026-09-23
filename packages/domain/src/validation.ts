export function explicitTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) return false;
  const [year, month, day] = value.slice(0, 10).split('-').map(Number);
  const days = [31, year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1] && Number(value.slice(11, 13)) < 24 && Number(value.slice(14, 16)) < 60 && Number(value.slice(17, 19)) < 60;
}

export const nullableTimestamp = (value: unknown): value is string | null => value === null || explicitTimestamp(value);

export function validTimeRange(from: unknown, to: unknown, requiredStart = false): boolean {
  if (!nullableTimestamp(from) || !nullableTimestamp(to) || (requiredStart && from === null)) return false;
  return from === null || to === null || Date.parse(to) > Date.parse(from);
}

export function requireTimeRange(from: unknown, to: unknown, code: string, requiredStart = false): void {
  requireCondition(validTimeRange(from, to, requiredStart), code, 400);
}

export function activeDuring(now: string, from: string | null, to: string | null): boolean {
  return explicitTimestamp(now) && validTimeRange(from, to) && (from === null || Date.parse(from) <= Date.parse(now)) && (to === null || Date.parse(now) < Date.parse(to));
}

export function timestampInput(value: unknown, field: string, fallback: string): string;
export function timestampInput(value: unknown, field: string, fallback: null): string | null;
export function timestampInput(value: unknown, field: string, fallback: string | null): string | null {
  if (value === undefined) return fallback;
  requireCondition(fallback === null ? nullableTimestamp(value) : explicitTimestamp(value), `invalid_${field}`, 400);
  return value as string | null;
}

export class DomainError extends Error {
  constructor(readonly code: string, readonly status = 409) { super(code); }
}

export function requireCondition(condition: unknown, code: string, status = 409): asserts condition {
  if (!condition) throw new DomainError(code, status);
}
