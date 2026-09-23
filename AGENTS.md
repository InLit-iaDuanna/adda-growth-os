# Codex repository instructions

This is a deliverable product specification, not an implemented app. Read GOAL.md and TASKS.json, then the current goals/Gxx file and referenced specifications before coding. Respond to the project owner in Chinese.

## Execution discipline

Inspect the existing repository before modifying it. Preserve working code and existing instructions. For nontrivial work, maintain an ExecPlan under .agent/plans/ using .agent/PLANS.md. Work on one milestone at a time; make small, reviewable changes. Do not merely write more planning files: produce running end-to-end behavior.

Record decisions in docs/DECISIONS.md, blockers in docs/BLOCKERS.md, progress in TASKS.json and evidence in artifacts/<goal-id>/. Never mark a goal complete without executing its validation. Never fabricate test results, screenshots, external API responses, customer data, menu items or successful deployments.

Unknown brand facts stay missing. Missing credentials become external_blocked and a truthful disabled/manual state. Continue independent work without requesting all customer details upfront. Do not claim a mock adapter is a working live integration. No hidden fallback from failed live calls to fake success.

## Architecture

TypeScript modular monolith, Next.js Web/API, separate worker, PostgreSQL/Prisma, pg-boss, Zod, Better Auth, AI SDK via an explicit provider adapter. Choose compatible supported stable versions when implementing, verify upstream docs, pin versions and commit the lockfile. Use an ADR for justified changes. Do not use floating :latest production images, unreviewed remote install scripts, or extra workflow frameworks by default.

Keep domain logic in packages/domain and infrastructure in packages/adapters. Do not calculate business metrics in prompts or in display components. No direct SQL or arbitrary network/shell tools for the model. Model keys and platform tokens remain server-side. Do not require a paid service for offline demo tests.

## Non-negotiable invariants

- Authenticate and scope every object, background task, export, search, file URL and aggregation by tenant/store. Client-provided tenant_id is not authorization.
- Integer minor-unit money; UTC timestamps with explicit store timezone; no naive local dates.
- Schema-validate model output and tool input; citations must identify authorized, existing, approved sources.
- Approved content is an immutable revision. Bind approval to content hash, audience snapshot, budget, channel, language and expiry. Material changes invalidate approval.
- Model suggestions cannot approve themselves. External actions require server-side authorization and an explicit approved execution intent.
- Recheck consent, suppression, template, quiet hours, cap and budget immediately before dispatch. Registration is not marketing consent.
- External side effects use an outbox, dedupe and reconciliation. Queue guarantees do not imply exactly-once third-party delivery. Unknown delivery means investigate, not blind resend.
- Orders become authoritative through the POS import/authorized connector. Coupon reservation or staff check-in alone is not a paid order.
- Full refunds remove qualification; partial refunds reduce values; preserve the event trail and restate affected analytics.
- No sensitive inference, scraping private profiles, review manipulation, unapproved mass messaging or real spending in tests.
- Disable all live external writes by default. Tests use isolated demo/test tenants and fake providers with conspicuous labeling.

## Validation

G00 must implement documented pnpm scripts for lint, typecheck, test:unit, test:integration, test:e2e, test:ai and build. Before completion run applicable scripts and record the exact command and exit status. By G10 run all gates against a clean database and production build.

The root scripts/verify-fixtures.mjs checks specification fixtures only. Passing it is not proof the app implements the metrics. Port golden assertions into application tests.

Do not weaken tests to pass. No focused tests or skipped P0 cases in release. Separate deterministic offline model-contract tests, authorized live-model evaluations and real-channel acceptance. Missing credentials are a reported blocker, not a passing live test.

## Security and source reuse

Never commit secrets or production personal data. Use a supported auth library, scoped storage, schema validation, safe CSV export and redacted logs. Do not duplicate AGPL/GPL/enterprise code into a closed-source deliverable without a recorded licensing decision. Preserve notices for reused permitted code and generate a dependency/license inventory.

## Handoff at every checkpoint

Report: completed user-visible behavior; touched modules; tests actually run; evidence paths; open risks/blockers; exact next goal. Checkpoints must be restartable from repository files without this conversation. Do not claim work is continuing after the run has ended.
