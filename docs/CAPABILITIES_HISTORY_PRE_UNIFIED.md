# 能力与验证记录

由 npm run capabilities 生成。能力范围维护在 docs/capabilities.json；测试数量来自实际运行记录，不由文档手填。离线通过只说明所列用例通过。

最近验证：2026-09-22T20:45:05.680Z；Node v22.22.0。122 项通过，0 项失败，0 项跳过。

[命令、退出码、日志和源码哈希](../artifacts/audit-b01-b05/validation.json)。生成时比较完整文件集合、哈希、锁文件、工具链和验证命令；新增、删除、修改源码均需重新验证。

| 能力 | 状态 | 实现或测试证据 | 尚未覆盖 |
|---|---|---|---|
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
| 发送与对账 worker | 内部未实现 | [apps/worker/src/index.ts](../apps/worker/src/index.ts) | 只有 maintenance handler；最终发送前校验、外部调用和中断恢复仍待实现。 |
| 真实模型技能 | 内部未实现 | [packages/domain/src/content-provider.ts](../packages/domain/src/content-provider.ts) | 使用确定性生成；缺 provider 接入、成本记录及真人评测。 |
| 生产初始化与客户界面 | 部分实现 | [apps/web/src/ui.ts](../apps/web/src/ui.ts)、[tests/e2e.test.ts](../tests/e2e.test.ts) | 缺受控 OWNER 初始化/邀请及完整业务界面；现有 e2e 为 HTTP 测试。 |
| 真实渠道与客户验收 | 内部开发及外部条件均待完成 | [docs/BLOCKERS.md](../docs/BLOCKERS.md) | 需完成上述内部能力，再取得凭证、批准测试对象、业务数据、语言评审及 UAT。 |

本记录的验证命令使用已有依赖，未做干净安装；命令本身不包含浏览器点击、生产数据库、真实模型、渠道或客户验收。独立浏览器与 CodeBuddy CLI 实测见项目复审报告。AI-contract 仅检查合成契约；安全扫描是有限静态检查。
