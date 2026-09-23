import fs from 'node:fs';

const file = new URL('../fixtures/ai_eval_cases.json', import.meta.url);
const document = JSON.parse(fs.readFileSync(file, 'utf8'));
const cases = document?.cases;
if (!Array.isArray(cases) || cases.length === 0) throw new Error('AI fixture cases missing');
for (const [index, item] of cases.entries()) {
  for (const key of ['id', 'scenario_zh', 'expected_behavior', 'status']) {
    if (typeof item?.[key] !== 'string') throw new Error(`case ${index} missing ${key}`);
  }
}
const boundaryCases = cases.filter((item) => /block|deny|suppress|do_not|escalate|invalidate|insufficient|unknown|terminate|reconcile|return_null|needs_verified|separate_metric/i.test(item.expected_behavior));
if (boundaryCases.length === 0) throw new Error('AI fixture must include safety boundary cases');
console.log(JSON.stringify({ ok: true, cases: cases.length, boundary_cases: boundaryCases.length, synthetic: document.synthetic === true, note: 'offline contract fixture check; not a live model evaluation' }));
