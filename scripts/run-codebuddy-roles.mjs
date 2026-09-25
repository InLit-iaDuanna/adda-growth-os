import fs from 'node:fs/promises';
import path from 'node:path';
import { readConfig } from '../dist/packages/adapters/src/config.js';
import { runCodeBuddyRole } from '../dist/packages/adapters/src/codebuddy.js';

if (process.env.AI_PROVIDER !== 'codebuddy_cli') {
  console.error('AI_PROVIDER=codebuddy_cli is required; no model call was made.');
  process.exitCode = 2;
} else {
  const config = readConfig(process.env);
  const syntheticFacts = {
    tenant: 'synthetic_demo_only', store: 'synthetic_store_only', brand_name: 'ADDA TEA',
    campaign: 'Campus Adda', product: { id: 'prod_synthetic_tea', name: 'Approved tea', price_minor: null, currency: 'BDT' },
    source_id: 'brand_rev_synthetic_01', source_excerpt: 'Synthetic approved fact: brand name ADDA TEA.',
    restrictions: ['no real people', 'no price/date/discount/address claims', 'no external actions']
  };
  const requests = [
    { role: 'data_generator', conversationId: 'demo-data-generator', prompt: `只为测试租户生成 3 条合成活动数据。每行字段 id、campaign、status、value，value 不要代表真实经营数据。只输出 schema JSON。\n${JSON.stringify(syntheticFacts)}` },
    { role: 'agent_planner', conversationId: 'demo-agent-planner', prompt: `只输出下面骨架的合法 JSON，不要 Markdown 或解释；根据合成事实保持 needs_input，不要伪造指标或来源。${JSON.stringify({ skill: 'growth_analyst', status: 'needs_input', observations: [], hypotheses: [], proposedActions: [], metricEvidence: [], sourceRecords: [], needsInput: ['synthetic_metric_only'], limits: { maxSteps: 6, maxRetries: 2, deadlineSeconds: 180, budgetMinor: 0 }, locked: syntheticFacts, allowed_reference_ids: ['metric_synthetic_01'] })}` },
    { role: 'content_writer', conversationId: 'demo-content-writer', prompt: `根据合成事实写 zh-CN、en、bn 三语言可编辑内容包。bn 标记 needs_local_review，不能新增事实。locked=${JSON.stringify(syntheticFacts)}` },
    { role: 'reviewer', conversationId: 'demo-reviewer', prompt: `只输出一个合法 JSON 对象，不要 Markdown 或解释。字段固定为 status（只能是 pass、needs_input、fail）、issues（字符串数组）、evidence_refs（字符串数组）。草稿证据不完整时输出 needs_input。${JSON.stringify({ source_id: syntheticFacts.source_id, draft: 'ADDA TEA · Approved tea. দাম অনুমোদনের পর প্রকাশ করুন।' })}` }
  ];
  const results = await Promise.all(requests.map((request) => runCodeBuddyRole(config, request)));
  const report = { generated_at: new Date().toISOString(), provider: 'codebuddy-cli', model: config.codebuddyModel, synthetic_only: true, conversations: results.map((result) => ({ ...result, value: result.ok ? result.value : undefined })) };
  const reportPath = path.resolve(process.cwd(), 'artifacts/G04/codebuddy-roles.json');
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ report: reportPath, roles: results.map((result) => ({ role: result.role, ok: result.ok, error_code: result.ok ? null : result.errorCode, conversation_id: result.conversationId })) }));
  if (results.some((result) => !result.ok)) process.exitCode = 1;
}
