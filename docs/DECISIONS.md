# 决策记录

D001：单一 TypeScript 业务代码库与独立 worker；不从多框架、多微服务开始。
D002：品牌事实、活动、会员、订单和审批为产品资产；七个技能共用这些事实。
D003：V1 第一方数据和人工闭环不依赖社交平台审批；live connector 单独验收。
D004：首个真渠道默认 WhatsApp Business Platform；未具备条件时保持 external_blocked。
D005：不推断完整跨平台归因；未识别部分单列 unknown。
D006：上线前须由甲方提供本地语言复核人；bn 自动翻译不能自行通过发布审核。
D007（G00）：在当前无 Docker/PostgreSQL 的执行环境中先交付可替换的 `file-dev` repository，保持 tenant/store/role 和 API 契约；不把它标记为生产数据库，后续接入 Prisma/PostgreSQL 需重新跑迁移与恢复验收。
D008（G00）：会话 cookie 使用服务端 session + HMAC 签名和 CSRF token；生产必须显式提供至少 32 位 `SESSION_SECRET`，DEMO seed 仅在 `APP_MODE=demo` 或 `test` 下允许。
D009（G01）：Brand Brain 的事实、价格和素材均追加版本并保存 checksum/来源；检索默认 approved-only，价格版本变化会将引用标记 stale，不能沿用旧批准。
D010（G02）：POS 上传先 staging/preview 再 commit；订单和退款以外部 ID 幂等，金额变更形成 correction 历史，指标只使用当前有效版本并保留 complete_through 水位。
D011（G03）：公共来源、会员访问和券均使用高熵不透明 token 的 HMAC hash；扫码/触点不计销售，券只有匹配权威 POS 订单后才产生 verified_coupon 归因。
D012（G04）：内容包采用 deterministic fake provider 作为离线合同测试，bn 默认 needs_local_review；approval 绑定 content hash 与引用，人工导出状态不等同于 published。
D013（G05）：校园合作和推荐只产生可审计台账；报名不等于签到，奖励必须等首次权威订单和退款观察期后人工批准，不自动付款。
D014（G06）：CRM 只使用代码规则计算分群；受众以持久化快照和稳定 seed 分配 treatment/holdout。发送与人工导出都在服务端重新检查联系方式验证、营销同意/退订、频控、当地发送时段、模板批准和预算；无真实连接器时只生成 test outbox 或 `external_blocked`，不伪造送达。
D015（G07）：所有反馈（普通和紧急）都进入有负责人/SLA 的 SupportCase；严重风险只触发人工升级与证据任务，系统不诊断、不承诺赔偿。回复版本 hash、审批和人工执行任务分离。
D016（G08）：控制台只允许白名单指标查询，快照包含 tenant/store、来源记录、截止水位、分母和数据质量；天气/校园数据缺失时显式 needs_input，日报追加版本而不是覆盖历史。
D017（G09）：WhatsApp adapter 默认 manual/unconfigured；live 需要服务端凭证、模板能力、同意、批准 intent、租户 kill switch 和真实回执。超时进入 unknown_delivery，禁止盲目重试；本地 fake transport 不能证明 live acceptance。
D018（G10）：file-dev 只用于当前离线切片；生产 PostgreSQL/Prisma、staging、真实孟语/渠道/UAT 仍是阻塞项。备份恢复必须写入新路径并校验 checksum，性能结果按实测保存，不修改目标自证。
D019（审查修复）：平台级停发开关只能由 `PLATFORM_OPERATOR` 修改；租户 OWNER 的 `integration:manage` 不再隐含平台控制权。
D020（审查修复）：活动 PATCH 按字段鉴权，混合包含未授权字段的请求整体拒绝；`LOCAL_REVIEWER` 不拥有业务审批权限。
D021（审查修复）：内容导出在创建 publication intent 前重新验证内容哈希、活动 revision、价格 version、品牌 revision、素材清单、有效期和发布检查；旧的未绑定审批必须重新审批。
D022（审查修复）：G06 预览、G09 intent 和离线 dispatch 共用 `dispatch-policy`；未验证联系方式、退订/抑制和 holdout 不得进入 pending intent。
D023（审查修复）：指标使用内部会员 ID 和统一 freshness 质量；租约恢复按过期时间及 owner/token fencing；生产 Cookie 显式带 `Secure`。
D024（代码精简）：统一触达参数和营销同意筛选，保留各入口的预算与幂等顺序。删除未调用的指标查询实现，启用 TypeScript 未使用代码检查；不引入新依赖。

D025（N01/N02/N08，替代 D021 的先查后写）：生成时持久化事实绑定；提交沿用该绑定；批准时选定 currentApprovalId 并替代旧审批。导出在 mutate 锁内重新读取、校验、保存 approvalId/payloadHash/内容包快照，响应使用该快照。缺生成事实的旧内容要求重新生成。
D026（N03）：日报及任务必须授权全部门店与证据引用；范围缺失或包含未授权引用则隐藏，不返回裁剪标签后的原总额。tenant-wide job 元数据仅供拥有全部门店权限的报表用户读取。
D027（N04/N05）：HTTP 指标、控制台问数和日报共用 calculateMetrics。逐请求门店核对配置及已知订单来源；缺失与确认零成交分开，混合币种/时区拒绝汇总。
D028（N06/N07）：messageAttempts 与 deliveryIntents 通过统一账本视图计费和频控；pending/accepted/unknown 占用额度，已消费成本冻结。业务去重按活动、会员、渠道；请求键仅控制重放。新显式键可重评未发跳过，历史不覆盖，成功/已预留/未知结果不盲重发。未决或供应商失败的额度待人工核实，不自动退回。修改审批使未发 pending 失效，已可能发送的记录保留。
D029（交付说明）：当前能力只在 docs/capabilities.json 维护范围，由脚本结合实际验证记录生成展示。生产数据层、业务 worker、模型、初始化和客户界面属于内部研发缺口，不能统称等待客户密钥。

D030（B01/B03）：订单业务键用租户、门店、来源、外部编号的 JSON 元组表示。复购、退款、导入和核销复用该身份。新归因在写锁内解析并绑定来源和内部版本记录；修订沿用业务身份。旧歧义记录不归因，已取消或统计期外的同号订单也不得被忽略后猜测来源。
D031（B02）：归因模型升级 primary_source_v2，第一方触点只取支付前七天内最后一次，含上下边界；核验券属于订单证据，不套触点窗口，但核验时间必须不晚于报告 as_of。输出记录窗口和版本。固定七天尚不支持配置。Golden 数据只做格式适配，计算调用同一业务引擎，不再保留第二套算法。
D032（B04/B05）：统一校验显式时区、实际日历日期和有效区间。未传字段采用约定默认值；显式 null 只允许在可选边界；非法输入不被默认值掩盖。保存与审批/执行分别检查，历史脏数据也拒绝。活动可以提前准备导出，但价格和素材必须在当前有效期内。
D033（审查 A01）：验证前后比较完整源文件集合与哈希、锁文件、Node/npm/安装包版本；能力生成复核命令集合和日志哈希。新增文件或验证过程中修改文件都令记录失效。此机制用于证据新鲜度，不构成防篡改签名或干净安装证明。

D034（2026-09-23 可用性复审）：后台采用可操作的响应式九模块工作台，顾客页完成英文/孟加拉语注册、验证、优惠和领券流程；后台中文/英文可切换。界面动作以服务端状态为准，人工导出与操作员留证不得被描述为已外发。
D035（数据与审批复审）：CSV 表头和来源范围先验证再暂存，空文件只有有效表头与明确完整水位才可能确认零成交；已批准活动资料变更重回审批；未排期校园活动不能开放；晚导入的先前订单会阻断推荐奖励。
D036（触达状态复审）：没有 treatment 成员或可确认送达的证据时不能依空集合逻辑标记 `completed`；既有误报在启动迁移时改为 `blocked` 或 `approved` 并记审计事件。无连接器仍明确 `external_blocked`。
D037（CodeBuddy 测试边界）：本机 CodeBuddy CLI 只在单独的合成事实冒烟脚本中调用 `deepseek-v4.1-flash`，请求预留台账保守限制 10000 次；不把模型接入业务运行时，也不将这次短文案测试称为真人孟语评审或真实内容质量验收。
D038（2026-09-23 视觉改版）：后台和顾客页使用暖纸色、深绿与陶土色建立品牌感和层级，移动端导航改为九项网格以保持入口可见；装饰图形仅用于界面层次，不代表甲方已确认的品牌规范，业务状态与事实边界不变。

D039（2026-09-24 前端结构重构）：将后台/顾客页 CSS 与共享 HTML 文档壳从 `apps/web/src/ui.ts` 拆到 `apps/web/src/ui/`；浏览器端行为继续以内联函数运行，保持离线 DEMO、DOM ID、接口和安全边界不变。

D040（2026-09-24 甲方素材）：SUIWU 随物作为母品牌，ADDA 作为子品牌；甲方提供的 JPG 进入本地品牌资源清单，授权范围确认前状态保持 `needs_confirmation`，仅用于界面演示与参考。

D041（2026-09-25 CodeBuddy CLI provider）：真实模型调用采用显式 `AI_PROVIDER=codebuddy_cli` 开关，默认仍为 `deterministic_offline`。CodeBuddy 每次以独立会话、单回合、无工具、超时和输出上限运行；内容写作与增长 Agent 使用不同角色提示词。服务端只把当前租户/门店的冻结批准事实和指标交给模型，并锁定来源、身份、预算、权限和孟语复核状态；JSON 或领域合同失败返回 `external_blocked`/`ai_output_invalid`，不回退成确定性假成功。真实冒烟只使用合成 demo 数据，证据保存在 `artifacts/G04/` 和 `artifacts/G08/`。持久化后台 control-run worker 当时仍保持离线确定性执行，异步 provider bridge 由 D044 完成。

D042（2026-09-26 完整合成测试数据）：新增可重复的 `scripts/seed-complete-test-data.mjs` 与 `npm run data:seed`。生成器从干净 demo seed 构建完整 JSON 仓储，另写 members/orders/refunds CSV 与 manifest；所有记录使用合成租户、固定 demo 账号和明确的 bearer token，外部连接器 kill switch 保持开启。fixture 可以用于本地 UI、HTTP、POS、顾客和 Agent 流程检查，但不能作为客户数据、真实渠道验收或生产初始化。

D043（2026-09-27 导航简化）：工作台侧栏保留全部已授权入口，按工作台、经营、内容、现场、系统分组；隐藏重复的编号和箭头装饰，桌面端取消侧栏内部滚动，移动端继续使用现有菜单按钮和两列入口。此次调整只改变导航呈现，不改变页面路由、权限或业务状态。

D044（2026-09-27 AI 审查修复）：CodeBuddy 结果依次经过进程/JSON、角色 JSON Schema、冻结证据与业务规则校验；`ok` 只表示前述合同通过，不代表人工审核通过。真实 provider 的持久化 control-run 由 worker 在文件锁外调用、在锁内 claim/commit，并在回写时重新检查截止时间、租户/门店权限、取消状态、版本和输出引用；超时、崩溃和撤销只能进入失败或可恢复状态。指标叙述必须由结构化指标引用渲染，模型不能用合法引用包装未经证实的数字。合成 fixture 的素材摘要使用图片字节、来源触点先于事件，收银正向券与 POS 会员一致，客服回复必须先批准再转人工任务。


## D2026-09-25 — Uploaded-source unified implementation

Owner supplied the complete archive. Preserve the implemented TypeScript / native HTTP / JSON file-dev architecture and working domain routes instead of replacing them with a standalone prototype or claiming a Next.js/PostgreSQL migration. UI is split into shared controller, pages, public renderer and a single token library; `/admin`, `/review`, `/staff` are role-appropriate views of the same application.

ADDA is the endorsed sub-brand; SUIWU 随物 is the parent. Preserve original image bytes and both parent slogans, never infer health claims or approve marketing asset rights from UI use.

Read-only control jobs run through persisted evidence snapshots and atomic checkpoints in the existing worker. No async network call or external side effect happens under the file lock. Recheck current membership before each worker checkpoint. Frozen results cannot change metric snapshots or fabricate source references; retry only declared transient failure and never successful upstream nodes. This does not implement a live LLM or delivery worker.

Keep legacy content revision IDs as working-document handles for API compatibility, while storing approved history append-only and rejecting stale editor hashes. One member can claim each offer once; idempotent replay derives and returns the same server-secret bearer, without storing its raw value. Dedupe its business conversion touch event; page views remain separate.

Run all original and new TypeScript tests after tsc compilation and preserve the MJS evidence tests. The archive may include that exact compiled dist for offline startup. Existing lock dependency declarations remain; preinstalled TypeScript 5.8.3 was used because npm ci failed DNS. Browser policy was not disabled: DOM tests use an explicit real-HTTP bridge and are not labeled native E2E. Production readiness remains false.
