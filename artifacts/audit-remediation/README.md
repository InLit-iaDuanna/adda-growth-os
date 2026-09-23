# Audit remediation evidence

This directory records the 2026-09-22 offline remediation run.

- The original acceptance chain (unit, G01–G10, integration and e2e) ran as 48 tests and exited 0.
- The current `npm test` chain includes the original tests plus metrics, WhatsApp, lease/cookie and P0 remediation suites: 63 tests, 63 passed, 0 failed, exit 0.
- `npm run typecheck`, `npm run build`, `npm run security:scan`, `npm run test:ai` and `npm run fixtures:verify` exited 0.
- The synthetic 100,000-order metric run completed after the identity index fix; its p95 is recorded in `artifacts/G10/performance-latest.json`.
- The AI script is a deterministic synthetic contract check, not a live model evaluation.
- WhatsApp evidence covers raw nested payload normalization, HMAC and verify-token challenge handling. No real WABA send or provider receipt was made; that remains `external_blocked`.
- PostgreSQL, production deployment, browser UAT, real model credentials, real customer data and customer sign-off remain outside this offline run.
- The worker now has lease/heartbeat/fencing and fails unsupported job types explicitly; only the existing maintenance handler is implemented. Real delivery/reconciliation handlers still require a provider contract and remain external-blocked.
