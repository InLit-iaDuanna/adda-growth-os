import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

// Explicit, synthetic-only integration smoke test. Reserve one request before each invocation.
const model = 'deepseek-v4.1-flash';
const requestLimit = 10_000;
const usagePath = path.join(process.cwd(), 'reports', 'codebuddy-ai-usage.json');
await fs.mkdir(path.dirname(usagePath), { recursive: true });
let priorUsage = { requests_reserved: 0, manual_exploratory_attempts_upper_bound: 0 };
try { priorUsage = { ...priorUsage, ...JSON.parse(await fs.readFile(usagePath, 'utf8')) }; } catch (error) { if (error?.code !== 'ENOENT') throw error; }
assert.ok(Number.isSafeInteger(priorUsage.requests_reserved) && priorUsage.requests_reserved >= 0);
assert.ok(Number.isSafeInteger(priorUsage.manual_exploratory_attempts_upper_bound) && priorUsage.manual_exploratory_attempts_upper_bound >= 0);
const requestsReserved = priorUsage.requests_reserved + 1;
assert.ok(requestsReserved + priorUsage.manual_exploratory_attempts_upper_bound <= requestLimit, 'CodeBuddy request limit reached');
await fs.writeFile(usagePath, JSON.stringify({ model, request_limit: requestLimit, requests_reserved: requestsReserved, manual_exploratory_attempts_upper_bound: priorUsage.manual_exploratory_attempts_upper_bound, updated_at: new Date().toISOString() }, null, 2) + '\n');

const prompt = '你是 ADDA Growth OS 的测试 AI 内容来源。只用这些已核实的合成事实：品牌名 ADDA TEA；活动主题 Campus Adda；没有已核实价格、日期、折扣、地址。仅输出合法 JSON，格式 {"en":"...","bn":"..."}。分别写少于 100 字符的英语与孟加拉语社交文案；不要编造优惠或具体事实。';
const run = spawnSync('codebuddy', [
  '--print', '--model', model, '--tools', '', '--max-turns', '1', '--no-session-persistence', prompt
], { cwd: process.cwd(), encoding: 'utf8', timeout: 120_000, maxBuffer: 2_000_000 });

if (run.error) throw run.error;
if (run.status !== 0) throw new Error(`codebuddy_exit_${run.status}: ${run.stderr.trim()}`);
const raw = run.stdout.trim();
const json = raw.match(/\{[\s\S]*\}/)?.[0];
assert.ok(json, 'AI did not return JSON');
const copy = JSON.parse(json);
assert.equal(typeof copy.en, 'string');
assert.equal(typeof copy.bn, 'string');
assert.ok(copy.en.length > 0 && copy.en.length < 100);
assert.ok(copy.bn.length > 0 && copy.bn.length < 100);
assert.match(copy.en, /ADDA TEA/);
assert.match(copy.bn, /ADDA TEA/);
assert.match(copy.bn, /[\u0980-\u09ff]/);
assert.doesNotMatch(copy.en + copy.bn, /\d|BDT|Tk\.?|discount|off|%/i);

const report = { status: 'passed', model, requests_used_this_run: 1, tracked_requests_reserved: requestsReserved, manual_exploratory_attempts_upper_bound: priorUsage.manual_exploratory_attempts_upper_bound, request_limit: requestLimit, input: 'synthetic approved facts only', copy, checks: ['valid_json', 'en_and_bn', 'brand_mentioned', 'bengali_script', 'length_under_100', 'no_unverified_price_or_discount'], tested_at: new Date().toISOString() };
const reportPath = path.join(process.cwd(), 'reports', 'codebuddy-ai-test.json');
await fs.mkdir(path.dirname(reportPath), { recursive: true });
await fs.writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ status: report.status, model, requests_used_this_run: 1, tracked_requests_reserved: requestsReserved, report: reportPath }));
