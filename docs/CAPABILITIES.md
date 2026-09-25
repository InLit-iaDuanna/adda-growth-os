# 当前能力与验证范围 — 2026-09-25

本次基于上传的完整源码实施。`npm run validate:unified` 中全部 7 个命令退出码为 0，源码在验证期间未改变。实际应用与证据测试 **145/145** 通过、0 失败、0 跳过。当前命令日志、源文件校验值与工具链见 [validation.json](../artifacts/unified-2026-09-25/validation.json)。

DOM + 真实 HTTP 桥检查 **89** 项通过；它不是原生浏览器 E2E。[详细检查](../artifacts/unified-2026-09-25/browser-checks.json)。预编译副本不含 node_modules 的启动/重启实测 **10** 项通过：[运行记录](../artifacts/unified-2026-09-25/runtime-smoke.json)。

工具链：Node v22.16.0、TypeScript 5.8.3、@types/node 24.0.4。npm ci 失败于 DNS；不是锁版本干净安装。浏览器原生导航被策略阻断，记录在 [native attempt](../artifacts/unified-2026-09-25/browser-native-attempt.json)。这些限制没有转换成通过项。

| 能力 | 当前状态 | 实现/测试 | 边界 |
|---|---|---|---|
| 持久化只读 Agent 编排 | 完整应用 HTTP / 文件并发回归通过 | [packages/domain/src/control-runs.ts](../packages/domain/src/control-runs.ts)、[packages/adapters/src/control-worker.ts](../packages/adapters/src/control-worker.ts)、[tests/unified-backend.test.ts](../tests/unified-backend.test.ts) | 固定四个流程、七种只读技能；持久化后台执行器仍为确定性模式，真实 provider 走独立的同步路由。 |
| SUIWU / ADDA 多端统一 | 统一源码、真实 API、DOM 检查通过 | [packages/ui/src/theme.ts](../packages/ui/src/theme.ts)、[apps/web/src/ui/admin-page.ts](../apps/web/src/ui/admin-page.ts)、[apps/web/src/ui/consumer-page.ts](../apps/web/src/ui/consumer-page.ts)、[tests/browser_unified.py](../tests/browser_unified.py) | 运营、审核、收银与顾客 H5；89 项 DOM/HTTP 桥检查不是浏览器原生 Cookie、导航和存储验收。 |
| 批准历史与重复领券 | 真实 HTTP / 仓储并发回归通过 | [tests/unified-backend.test.ts](../tests/unified-backend.test.ts)、[packages/db/src/repository.ts](../packages/db/src/repository.ts) | 历史批准内容 append-only；同会员同优惠一次领取，重复请求重用令牌；真实供应商副作用仍关闭。 |
| 报表与任务门店权限 | 离线回归通过 | [tests/audit-n01-n08.test.ts](../tests/audit-n01-n08.test.ts)、[packages/domain/src/report-policy.ts](../packages/domain/src/report-policy.ts) | 已存报表须证明完整范围；不能证明则隐藏。未做生产安全验收。 |
| 生成事实、审批、导出 | 离线回归通过 | [tests/audit-n01-n08.test.ts](../tests/audit-n01-n08.test.ts)、[packages/domain/src/content-policy.ts](../packages/domain/src/content-policy.ts)、[tests/audit-b01-b05.test.ts](../tests/audit-b01-b05.test.ts) | 人工导出；不证明真人文案质量或真实发布。 |
| 指标范围与完整性 | 离线回归通过 | [tests/metrics-remediation.test.ts](../tests/metrics-remediation.test.ts)、[packages/domain/src/metric-service.ts](../packages/domain/src/metric-service.ts)、[tests/audit-b01-b05.test.ts](../tests/audit-b01-b05.test.ts) | 来源以门店 orderSources 配置和已知导入/订单为准；无法发现从未登记的外部系统。 |
| 订单身份、复购与归因 | 离线回归通过 | [tests/audit-b01-b05.test.ts](../tests/audit-b01-b05.test.ts)、[packages/domain/src/order-identity.ts](../packages/domain/src/order-identity.ts)、[packages/domain/src/attribution-policy.ts](../packages/domain/src/attribution-policy.ts) | 历史歧义引用保留 unknown；新模型固定七天，尚无窗口配置或历史证据修复界面。 |
| 日期保存与执行检查 | 离线回归通过 | [tests/audit-b01-b05.test.ts](../tests/audit-b01-b05.test.ts)、[packages/domain/src/validation.ts](../packages/domain/src/validation.ts)、[packages/domain/src/content-policy.ts](../packages/domain/src/content-policy.ts) | 覆盖价格、素材、品牌、活动和相关输入；不代表所有领域字段已做全面数据治理。 |
| 验收记录新鲜度 | 自动化回归通过 | [tests/validation-evidence.test.mjs](../tests/validation-evidence.test.mjs)、[scripts/validation-evidence.mjs](../scripts/validation-evidence.mjs) | 完整文件集合、内容、工具链、命令和日志检查；不替代干净安装、可复现构建或签名。 |
| 触达预算、去重、重试 | 离线回归通过 | [tests/audit-n01-n08.test.ts](../tests/audit-n01-n08.test.ts)、[packages/domain/src/outreach-ledger.ts](../packages/domain/src/outreach-ledger.ts) | 待发额度预留及 test outbox；未知/失败结果保留额度，尚无人工对账释放界面。 |
| 任务租约与生产 Cookie | 离线回归通过 | [tests/jobs-cookie-remediation.test.ts](../tests/jobs-cookie-remediation.test.ts) | 不等于实际业务 worker 或生产认证系统已交付。 |
| WhatsApp 协议 | 本地协议测试通过 | [tests/whatsapp-remediation.test.ts](../tests/whatsapp-remediation.test.ts)、[tests/g07-g10.test.ts](../tests/g07-g10.test.ts) | 无真实 WABA 联调；发送适配器未接入业务 worker。 |
| 生产数据库 | 内部未实现 | [packages/adapters/src/config.ts](../packages/adapters/src/config.ts) | 当前仅有 JSON 文件仓储，缺 PostgreSQL 适配器和生产迁移。 |
| 发送与对账 worker | 内部未实现 | [apps/worker/src/index.ts](../apps/worker/src/index.ts) | 现已支持持久化只读 control run 与 maintenance；真实渠道发送、最终发送前授权和人工回执对账 worker 仍未接通。 |
| CodeBuddy CLI 真实模型技能 | 合成数据运行通过 | [packages/adapters/src/codebuddy.ts](../packages/adapters/src/codebuddy.ts)、[apps/web/src/server.ts](../apps/web/src/server.ts)、[artifacts/G04/codebuddy-runtime.json](../artifacts/G04/codebuddy-runtime.json)、[artifacts/G08/codebuddy-agent-runtime.json](../artifacts/G08/codebuddy-agent-runtime.json) | 显式 `AI_PROVIDER=codebuddy_cli` 后，content_writer 和 agent_planner 通过无工具单回合会话运行；默认离线。缺模型成本结算、异步 worker bridge、真人任务/孟语质量验收。 |
| 生产初始化与客户界面 | 部分实现 | [apps/web/src/ui.ts](../apps/web/src/ui.ts)、[tests/e2e.test.ts](../tests/e2e.test.ts) | 运营、语言审核、收银和顾客端已共用主题并连接实际 API；受控生产 OWNER 初始化/邀请未实现；原生浏览器导航验收待执行。 |
| 真实渠道与客户验收 | 内部开发及外部条件均待完成 | [docs/BLOCKERS.md](../docs/BLOCKERS.md) | 需完成上述内部能力，再取得凭证、批准测试对象、业务数据、语言评审及 UAT。 |

旧证据及旧规格保留，不代表本轮生产验收。历史生成页面见 CAPABILITIES_HISTORY_PRE_UNIFIED.md；原 `validate:release` / `capabilities` 脚本仍为历史格式的全门槛校验，须完成其实际运行后才能生成相应记录。本次本地记录使用 `validate:unified`。CodeBuddy 的合成运行已验证，但模型成本结算、异步桥接、外部渠道、生产数据库和客户 UAT 均没有因此变为完成。
