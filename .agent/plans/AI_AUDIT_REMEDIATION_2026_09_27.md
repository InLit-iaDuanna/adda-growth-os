# AI audit remediation — ExecPlan

## Goal

Make AI provider results truthfully distinguish transport, parsing, schema, evidence, policy and human review; connect the opt-in CodeBuddy provider to durable background control runs; and make the complete synthetic fixture internally consistent.

## Milestones

1. **Provider contracts** — parse CodeBuddy structured output, validate the declared role schema locally, use a strict content schema, expose stage status, and reject fabricated metric narratives.
2. **Durable live runs** — claim a persisted node under the repository lock, call CodeBuddy outside the lock, then commit only if the run lease/version, scope, cancellation state and budget still match. Keep deterministic offline mode as the default.
3. **Fixture and business probes** — use byte SHA-256 for assets, valid source/order/coupon chronology, a correct cashier positive case plus member-mismatch negative case, and a replayable approved reply task. Add regression tests and evidence.

## Validation

- `npm run build`
- targeted provider, control-run, fixture, cashier, and customer-voice tests
- `npm run validate:unified`
- `npm run test:data` and a clean complete-demo regeneration

## Boundaries

- Do not invoke a paid/live model or external channel during local validation.
- `AI_PROVIDER=codebuddy_cli` remains explicit; missing credentials are reported as external blocked.
- Synthetic fixtures remain clearly labeled and never become customer or production data.

## Checkpoint

- Provider contracts: implemented and covered by `tests/codebuddy-provider.test.ts` and the fabricated-metric regression.
- Durable live runs: implemented with a fake CodeBuddy executable regression; the real CLI remains opt-in and credential-dependent.
- Fixture/business probes: regenerated and verified with byte checksums, ordered attribution, cashier member matching, and approved-reply task idempotency.
