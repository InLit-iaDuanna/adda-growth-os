import type { ContentPackageData } from './content';

export interface ContentGenerationInput {
  briefId: string;
  campaignId: string;
  brandRevisionId: string;
  brandName: string;
  productRefs: Array<{ id: string; name: string; priceMinor: number | null; currency: string }>;
  channel: string;
  contentPillar: string;
  targetMetric: string;
  sourceLinkId: string | null;
  sourceExcerpt: string;
  hasApprovedAssets: boolean;
}

export interface ContentGenerationResult {
  ok: boolean;
  packageData?: ContentPackageData;
  errorCode?: string;
  manualEditReason?: string;
}

const injectionPattern = /(ignore\s+(all|previous)|导出.*(手机号|会员|联系人)|export.*(phone|member|contact)|任意\s*sql|run\s+sql|支付|payment|send\s+message)/i;

export function generateDeterministicContent(input: ContentGenerationInput, untrustedInstruction = ''): ContentGenerationResult {
  if (injectionPattern.test(untrustedInstruction)) return { ok: false, errorCode: 'unsafe_instruction', manualEditReason: '资料中的指令不具备工具或导出权限' };
  const needsInput: string[] = [];
  if (!input.brandName) needsInput.push('brand_name');
  if (!input.productRefs.length) needsInput.push('approved_product');
  if (input.productRefs.some((product) => product.priceMinor === null)) needsInput.push('price');
  if (!input.hasApprovedAssets) needsInput.push('approved_asset');
  const product = input.productRefs[0];
  const productLabel = product?.name || 'approved product';
  const priceLabel = product?.priceMinor === null || product?.priceMinor === undefined ? 'price pending confirmation' : `${product.currency} ${(product.priceMinor / 100).toFixed(2)}`;
  const enCaption = `${input.brandName || 'ADDA'} · ${productLabel}. A small moment for a real adda. ${priceLabel}.`;
  const bnCaption = `${input.brandName || 'ADDA'} · ${productLabel}। আড্ডার জন্য একটি ছোট মুহূর্ত। দাম অনুমোদনের পর প্রকাশ করুন।`;
  const zhCaption = `${input.brandName || 'ADDA'}：围绕已批准的 ${productLabel}，准备一条可人工复核的内容。`;
  const packageData: ContentPackageData = {
    brief_id: input.briefId, campaign_id: input.campaignId, brand_revision_id: input.brandRevisionId,
    target_metric: input.targetMetric, content_pillar: input.contentPillar, channel: input.channel,
    product_refs: input.productRefs.map((item) => item.id),
    hook_variants: [`A real adda starts with ${productLabel}`, `One cup, one shared moment`],
    shot_list: [{ index: 1, duration_seconds: 5, visual: `Approved asset or staff-shot detail of ${productLabel}`, spoken_line: enCaption, onscreen_text: productLabel, rights_needed: ['asset_use_approved'] }],
    operator_notes_zh: `仅使用已批准事实和素材；价格显示为 ${priceLabel}。孟语必须由指定复核人确认。`,
    variants: [
      { locale: 'zh-CN', title: `${productLabel} 内容草稿`, caption: zhCaption, subtitle_srt: '1\n00:00:00,000 --> 00:00:05,000\n准备人工复核的内容。', cta: '查看来源链接', review_status: 'reviewed', reviewer_id: null },
      { locale: 'en', title: `${productLabel} · Adda moment`, caption: enCaption, subtitle_srt: `1\n00:00:00,000 --> 00:00:05,000\n${enCaption}`, cta: 'Open the first-party link', review_status: 'draft', reviewer_id: null },
      { locale: 'bn', title: `${productLabel} · আড্ডার মুহূর্ত`, caption: bnCaption, subtitle_srt: `1\n00:00:00,000 --> 00:00:05,000\n${bnCaption}`, cta: 'প্রথম পক্ষের লিংক খুলুন', review_status: 'needs_local_review', reviewer_id: null }
    ],
    source_link_id: input.sourceLinkId, sources: [{ source_id: input.brandRevisionId, revision_id: input.brandRevisionId, kind: 'brand_fact', excerpt: input.sourceExcerpt }],
    needs_input: needsInput, risk_flags: needsInput.length ? ['manual_review_required'] : []
  };
  return { ok: true, packageData };
}
