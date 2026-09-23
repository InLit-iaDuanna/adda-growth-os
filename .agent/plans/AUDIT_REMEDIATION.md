 # Remediation ExecPlan — 首轮审查历史记录

 > 复审更正：下列计划中的最终 worker/生产基础部分未实现。当前状态以 docs/CAPABILITIES.md 为准；测试数量仅是本阶段历史结果。
 
 ## 目标和用户可见结果
 
 把审查报告中已复现的 R01–R12 从“离线原型缺陷”推进到可回归验证的正确行为，并把修复后的代码保留为一个可重启的实施基线。第一阶段不接真实模型、真实 WhatsApp 或生产数据库；其中适配器、模型技能及业务 worker 为内部未实现，真实联调另需外部条件。用户可见结果是：越权请求被拒且不产生部分写入；改价/过期/撤销/改稿后的旧审批不能导出；G06 预览和 G09 创建意图共用基础触达判断；最终 worker 发送仍待实现；多门店同号会员不被错误合并；过期数据不再标 verified；生产 Cookie 带 Secure；未到期租约任务不会被错误恢复。
 
 ## 仓库现状与依赖
 
 - 源码是 TypeScript 模块化单体，当前主要使用 \`node:http\` + JSON 文件仓储；\`DATABASE_URL\` 会明确报告 PostgreSQL adapter 未实现。
 - \`apps/web/src/server.ts\` 约 1,747 行，\`packages/db/src/repository.ts\` 约 1,683 行；路由和仓储均混有授权、政策和聚合逻辑。
 - 已有 48 个离线测试通过；审查材料中的 12 个定向反例目前刻意失败，证据位于审查报告/证据包，不得改断言来适配当前错误行为。
 - G00–G10 仍是 DEMO_READY/部分 in_progress；没有真实客户资料、模型凭证、WABA 凭证、部署环境或 UAT 签字。
 - 现有 G04/G06/G09 设计已经有审批 hash、受众快照、撤回/过期字段和离线停发边界，可作为修复的基础；不能把 \`contentHash\` 一项当成完整执行授权。
 
 ## Progress
 
 - [x] 阅读并核对审查报告、AGENTS.md、GOAL.md、TASKS.json、相关 Gxx 计划和关键源码入口。
 - [x] 将 R01–R12 按 P0/P1、代码位置、复现条件和验收行为整理为实施批次。
 - [x] 建立失败反例的隔离测试夹具并固定当前基线（R01–R12）。
 - [x] 实施第一批 P0 权限和执行前审批修复（R01–R04、R07–R08）。
 - [x] 实施第二批身份、指标质量、Cookie 和任务租约修复（R09–R12）。
 - [x] 实施 R05/R06 WhatsApp 原始协议离线归一化。
 - [ ] worker/outbox 发送及对账连接：内部未实现。
 - [ ] 将 PostgreSQL/迁移/生产初始化、真实模型和 UI 端到端列入后续交付，不在本计划中伪装完成。
 - [x] 运行原有 48 条测试、修复回归、typecheck/build，并更新 artifacts 和阻塞记录。
 
 ## 设计与文件路径
 
 ### 共享执行授权
 
 - 新增 \`packages/domain/src/execution-policy.ts\` 或同等领域模块：定义版本化审批快照、统一 \`validateApprovedExecution\`，检查 resource revision/hash、brand revision、product price versions、asset rights, campaign fields, channel/language, audience snapshot, budget, expiry and revoked/stale status。
 - \`packages/db/src/repository.ts\` 提供只读状态访问和原子变更；不在路由复制执行规则。审批与导出、publication intent、outreach dispatch 均调用同一函数。
 - \`apps/web/src/server.ts\` 仅负责 HTTP 解析、身份和错误映射；用字段级更新白名单处理 campaign PATCH。
 
 ### 触达政策
 
 - 新增 \`packages/domain/src/dispatch-policy.ts\`：\`evaluateDispatchPolicy(state, input)\` 返回统一 \`eligible\` 或明确 \`reason\`，至少覆盖 consent, contact verification, holdout, frequency cap, quiet hours, budget, suppression, template and kill switches。
 - \`outreachExportPreview\`、G09 intent 创建、worker 最终发送共用该政策；政策输出保存版本/输入快照摘要，便于审计和重算。
 - 创建 intent 可以先产生 \`blocked\` 或不入队，但绝不把不符合政策的会员标成 pending；最终发送前在事务/claim 内重新评估。
 
 ### 多门店身份与指标质量
 
 - 在 \`packages/domain/src/metric-engine.ts\` 使用内部 \`member.id\` 作为 canonical key；外部编号只用于导入解析，不做跨门店自动别名。
 - 对旧订单映射只接受 \`(tenantId, storeId, memberId/external source key)\`；经授权跨店合并需有显式身份关联记录。
 - 统一 \`MetricEvidence\` quality 计算函数，输入 \`asOf\`、\`completeThrough\`、是否有有效订单/导入，供 \`control-service.ts\`、\`server.ts /api/metrics\` 和 \`metricEvidenceForQueries\` 使用。 \`completeThrough < asOf\` 返回 provisional，并保留 missing reason。
 
 ### 会话与任务租约
 
 - 生产模式设置 \`Secure\`，并对 logout 清除 Cookie 使用相同属性；测试显式断言 cookie 属性。
 - Job 类型扩展 owner/lease expiry/heartbeat/fencing token；\`claimNextJob\` 原子写入 lease，\`recoverInterruptedJobs\` 只回收 lease 已过期的 running job；\`finishJob\` 校验 owner/token，避免旧 worker 覆盖新状态。
 - worker 业务 handler 先实现已有离线任务所需的最小处理集；未实现任务返回可审计失败，不能伪装成功。真实外发仍 external_blocked。
 
 ### WhatsApp 分层
 
 - \`packages/adapters/src/whatsapp.ts\` 增加 GET verify token/challenge、原始 POST payload 解析和标准化状态事件；保留对内部测试协议的兼容适配但不将其当真实联调。
 - webhook 路由只做签名/配置/解析/去重和入库；worker/outbox 承担发送。真实 provider 合同测试和受控联调仍是后续停止条件。
 - 外发为默认关闭；不要把 \`externalWritesEnabled\` 服务器配置与租户级权限混为一谈。
 
 ## 实施步骤
 
 1. 在独立测试夹具中固定 R01–R12 的预期行为和当前失败输出；测试名称写“应阻断/应保持一致”，不删除原测试。
 2. 先修 R01：拆 \`platformExternalWritesKillSwitch\` 与租户/连接器开关；平台状态只能由 platform operator 角色操作；有效停发按层级 OR 计算，审计 actor/scope/reason。
 3. 修 R02：\`LOCAL_REVIEWER\` 只能提交语言复核；campaign PATCH 按字段授权，遇到混合未授权字段整体 403 且不写入。
 4. 修 R03/R04：统一执行前审批校验；检查最新内容 hash、价格 version、brand/assets/campaign 绑定、状态、expiry 和撤销；导出先校验再创建 publication intent。
 5. 修 R07/R08：提取 dispatch policy，所有入口复用；补充“创建 intent 后退订/进入 holdout/验证过期，最终发送再次阻断”的测试。
 6. 修 R10/R11：内部会员 ID 归并；抽出质量判断并替换三处重复实现；补多店同号、stale watermark、无导入三组测试。
 7. 修 R12：生产 Cookie 添加 Secure，logout 同样清除；补属性断言。
 8. 修 R09：实现 lease/owner/token/expired recovery，补双 worker、心跳、旧 owner finish 和进程中断测试。
 9. 修 R05/R06：先实现协议层解析与契约测试，再接离线 worker handler；真实 WABA 未具备时保留 external_blocked。
 10. 在每一批后运行相应测试；全部通过后运行原有全套测试、typecheck/build/security scan，并保存命令与日志。
 11. 更新 \`docs/DECISIONS.md\`、\`docs/BLOCKERS.md\`、对应 \`.agent/plans/Gxx.md\`、\`TASKS.json\` 和 \`artifacts/G10/\`，明确哪些只是离线修复，哪些仍未验收。
 
 ## 验证命令及预期
 
 当前基线（本环境已通过的命令）：
 
 - \`npm test\`：48 个已有测试全部通过。
 - \`npm run typecheck\` / \`npm run build\`：通过。
 - \`npm run test:ai\`：仅确定性合约元数据检查，不作为真实模型验收。
 - \`npm run security:scan\`：项目自带有限扫描；补充回归需另行执行。
 - \`npm run fixtures:verify\`：fixtures 一致性，不等于业务实现正确。
 
 修复完成的门槛：
 
 - R01–R04、R07–R08、R10–R12 的定向回归全通过，且原有 48 条不回退。
 - R09 lease 并发与恢复测试通过。
 - R05/R06 的原始 WhatsApp 合同解析测试通过；无凭证时不宣称 live。
 - typecheck/build/test/security scan 通过。
 - 对所有不能在当前环境完成的 PostgreSQL、真实模型、真实渠道、UI 浏览器和 UAT 项目保留 \`external_blocked\`。
 
 ## 实际验证证据
 
 本轮已完成离线修复和回归。\`artifacts/audit-remediation/\` 保存了全量测试 stdout、退出码和独立基线退出码；原有测试链 48/48 通过，加入修复回归后当时 npm test 为 63/63 通过。构建、安全扫描、AI 合约元数据检查和 fixture 一致性检查也通过。AI 检查仍是 synthetic contract check，不是真实模型评测；WhatsApp 只完成原始协议/签名/challenge 离线验证，真实 WABA 外发仍 external_blocked。
 
 ## Surprises & Discoveries
 
 - GitHub 上传未完成不影响本计划；当前工作区源码是审查 ZIP 解包后的真实工程。
 - G07–G10 现有测试已经覆盖部分 WhatsApp 签名、审批绑定和停发逻辑，但没有覆盖跨入口政策一致性、混合字段授权、价格版本和 stale freshness。
 - \`packages/domain/src/control-service.ts\` 已有较正确的 freshness 判断；\`/api/metrics\`、\`metricEvidenceForQueries\` 与 \`computeMetricBundle\` 仍有重复且不一致的 quality/key 逻辑。
 - 指标身份修复的第一版对每笔订单线性扫描会员，导致 100k 合成性能门禁超过一分钟；已改为预建租户/门店/身份索引，修复后 p95 约 305 ms，并重新跑通指标回归。
 - \`setGlobalKillSwitch\` 与 \`createDeliveryIntent\` 都在 JSON 仓储中读写全局状态；迁移生产数据库时这些状态必须转为带 scope 的表和事务约束。
 - 当前生成/导出流程可以持久化 publication intent；修复应把 intent 与审批快照绑定，而不是仅在响应层增加错误检查。
 
 ## Decision Log
 
 - D-REM-01：先修 P0 授权、审批和触达一致性；不新增技能和渠道范围。
 - D-REM-02：以内部 canonical member ID 作为指标身份；外部 ID 必须带来源/门店命名空间。
 - D-REM-03：执行前校验是唯一放行点；approval status、content hash 单独存在不构成当前授权。
 - D-REM-04：继续保留 deterministic fake 和 JsonRepository 作为离线测试替身；production database/real model/live WhatsApp 仍需单独验收。
 - D-REM-05：修复请求字段授权采用失败关闭：混合包含未授权字段时整体拒绝，不执行部分更新。
 - D-REM-06：任务恢复按 lease expiry 回收，不按 running 状态无条件回收。
 
 ## 回滚与幂等
 
 - 每个批次使用独立小提交；测试夹具和实现可以逐批回滚。
 - 不删除历史审批、回执或任务；改为追加版本/状态和审计事件。
 - intent 创建按 tenant/store/provider/idempotency key 去重；未知外部结果不自动重试。
 - JSON 仓储迁移保持旧数据读取兼容；若增加字段，提供默认值和显式 schema version。
 - 任何真实外发、生产迁移或公开部署都不属于本计划授权范围。
 
 ## Outcomes & Next Checkpoint
 
 当前计划完成到“离线修复与门禁回归”。下一检查点是生产基础设施和真实验收：PostgreSQL/迁移、真实模型、WABA 凭证与回执、浏览器级业务验收、孟语人工签字和客户 UAT；这些未在本轮伪装完成。每个后续检查点仍需附命令、退出码、通过/未通过数量和外部阻塞项。
 
