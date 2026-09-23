export type MetricQuality = 'verified' | 'provisional' | 'missing';

export interface MetricQualityInput {
  hasData: boolean;
  hasImport?: boolean;
  asOf: string;
  completeThrough: string | null;
}

export interface MetricQualityResult {
  quality: MetricQuality;
  missingReason: string | null;
}

export function assessMetricQuality(input: MetricQualityInput): MetricQualityResult {
  if (!input.hasData && !input.hasImport) {
    return { quality: 'missing', missingReason: 'orders_not_imported' };
  }

  const asOfMs = Date.parse(input.asOf);
  const completeThroughMs = input.completeThrough ? Date.parse(input.completeThrough) : Number.NaN;
  if (!Number.isFinite(asOfMs) || !Number.isFinite(completeThroughMs) || completeThroughMs < asOfMs) {
    return { quality: 'provisional', missingReason: 'source_watermark_not_confirmed' };
  }

  return { quality: 'verified', missingReason: null };
}
