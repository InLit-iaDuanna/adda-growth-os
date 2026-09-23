# R01–R12 regression matrix

| Finding | Remediation | Offline evidence |
|---|---|---|
| R01 | Platform kill switch requires `platform:manage`; tenant OWNER is rejected. | `tests/audit-remediation-p0.test.ts`, G09 |
| R02 | Campaign PATCH checks every mutable field; reviewer cannot mix approval with edits. | `tests/audit-remediation-p0.test.ts` |
| R03 | Content approval captures product price versions and export revalidates them. | `tests/g04.test.ts` A12 |
| R04 | Export rejects expired approval before creating publication intent. | `tests/g04.test.ts` A12 |
| R05 | Nested Cloud API status payloads normalize to stable, deduplicable internal events. | `tests/whatsapp-remediation.test.ts` |
| R06 | Verify-token challenge works without an operator session. | `tests/whatsapp-remediation.test.ts` |
| R07 | Preview and intent creation both reject unverified contacts. | `tests/audit-remediation-p0.test.ts` |
| R08 | Preview and intent creation both reject persistent holdout assignments. | `tests/audit-remediation-p0.test.ts` |
| R09 | Job leases, heartbeat, expiry recovery and owner/token fencing prevent duplicate takeover. | `tests/jobs-cookie-remediation.test.ts` |
| R10 | Metrics use canonical internal member IDs and leave ambiguous external IDs unlinked. | `tests/metrics-remediation.test.ts` |
| R11 | Stale source watermarks are `provisional`, with an explicit reason. | `tests/metrics-remediation.test.ts` |
| R12 | Production login/logout cookies include `Secure` while test HTTP remains usable. | `tests/jobs-cookie-remediation.test.ts` |

These are offline tests against the file repository and synthetic fixtures. They do not constitute live provider, production database, browser UAT or customer acceptance.
