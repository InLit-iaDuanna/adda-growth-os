# 技术架构

## 目标结构

```text
apps/web         Next.js：后台、消费者 H5、API/BFF
apps/worker      Node：导入、日报、模型任务、调度、回执处理
packages/domain  会员、活动、订单、归因、审批等纯业务逻辑
packages/db      Prisma schema、迁移、租户查询封装
packages/ai      七个技能、模型 adapter、schema、评测
packages/adapters  POS CSV、文件、身份验证、渠道与对象存储
packages/ui      组件、表单、国际化、品牌主题
packages/testing  fixtures、fake providers、测试帮助函数
```

核心服务仅 web + worker + PostgreSQL。pg-boss 负责后台任务，业务 outbox 在同一数据库事务内写入；outbox dispatcher 再投递任务，幂等消费。对象存储通过接口替换。
选择这条路线是减少首版跨语言开发与运维系统；不是断言它优于所有其他栈。软件版本在 G00 核对、锁定，并记录 Node、Postgres、包管理器及依赖兼容矩阵。

## 请求和权限

所有 API 在服务端验证会话；ActorContext 由验证后的会话/worker 授权创建，含 tenant、允许 store、role 和 purpose。
客户端对象 ID 只能定位资源，不能决定授权。每条实体检索、关联、导出和统计均传入 context；复合外键必须防止把 A tenant 的记录挂到 B tenant。
后台分析无任意 SQL endpoint。用户问题映射为允许的 MetricQuery，再调用固定计算服务；无法支持时返回具体限制。

## AI 执行

确定性 router 根据用户任务和数据可用性选择 skill handlers；多个技能可顺序或有限并发，但不自主循环互相授权。每次 run 记录 input snapshot、知识版本、模型/provider/version、tool traces、token usage、latency 和 outcome。
默认最大 6 个工具步骤、2 次可重试模型请求、180 秒任务 deadline，可按场景配置；每日租户预算由负责人设置。到预算/循环上限中止并展示原因，不暗中换昂贵模型。
AI 只输出结构化草稿；schema 校验、事实校验、本地化审核、审批与执行为不同阶段。模型不可访问 raw PII 或外部平台 token。

## 模型与检索

LLM_PROVIDER、LLM_MODEL、嵌入模型均环境配置，按授权地区和账户可用性选择，禁止硬编码不存在或不可用的模型。
已批准菜单与价格直接查结构化库。知识文档需要解析、版本、生效期和出处；未批准/冲突/已过期文档不可作为发布事实。
第一期支持表单录入、UTF-8 Markdown/TXT 和结构化 CSV。PDF/DOCX 解析可作为增量适配器，不能不加检查上传后就声称“已学习”。扫描件解析失败显示 unsupported，不虚构提取内容。
多语言检索必要时用经过测试的 embedding，但价格和权益不依赖向量相似度决定；知识审核优先于检索。

## 后台可靠性

请求只提交任务，不在 HTTP 生命周期内完成长生成或批量发送。任务持有明确重试策略、过期时间、幂等键、下一次运行时间、最后错误和外部业务引用。
外发状态：draft → pending_approval → approved → queued → dispatching → submitted → delivered/failed/unknown_delivery/cancelled。
重启时从持久状态恢复；dispatching 后没有确认的调用必须查询平台或进入 unknown_delivery，不盲目再发。收到回调先验签、幂等落库，再更新单调状态；迟到 sent 不得覆盖 delivered。
应用能最终收到重复任务；测试应证明不会发生重复核销、重复奖励或重复入账，而非引用队列文档自称端到端 exactly-once。

## 关键 API 合同（G00 后以 OpenAPI/Zod 实现）

POST /api/imports/preview; POST /api/imports/{id}/commit; GET /api/imports/{id}/reconciliation
POST /api/brand/documents; POST /api/brand/revisions/{id}/approve
POST /api/campaigns; POST /api/campaigns/{id}/source-links
POST /api/content/generate; POST /api/content/{id}/revisions; POST /api/content/{id}/submit
POST /api/approvals/{id}/approve; POST /api/approvals/{id}/reject
POST /api/members/register; POST /api/members/verify; POST /api/consents/revoke
POST /api/redemptions/reserve; POST /api/redemptions/{id}/match-pos
POST /api/events/{id}/checkins; POST /api/segments/preview
POST /api/outreach/preview; POST /api/outreach/{id}/submit
POST /api/webhooks/{provider}; GET /api/integrations/{id}/capabilities
POST /api/feedback/import; POST /api/cases/{id}/resolve
GET /api/metrics; POST /api/reports/daily; GET /api/ai/runs/{id}

公共与后台 route 分离；所有写入需要幂等策略，webhook 除外使用事件 ID 和验签。响应含 request_id；失败使用稳定 error_code、用户可读 message、retryable 和缺失配置项。

## UI

运营端支持桌面和移动端，收银界面单任务优先。后台 zh-CN/en；消费者 en/bn；品牌主题参数化，真实品牌色为空时只使用明确的临时中性主题。
金额显示 ৳，后台内部统一 currency；文本全部 UTF-8；孟语是左到右，不能误设为 RTL。日期按门店时区显示；所有国际化键缺失均可检测。

## 测试和部署命令合同

G00 建立 pnpm lint、typecheck、test:unit、test:integration、test:e2e、test:ai、build、db:migrate、db:seed:demo 和 dev。G10 增加 smoke:prod、backup 与 restore 验证说明。
建立 Dockerfile 和 compose，使用健康检查和仅内部数据库端口。DEMO tenant 显式标识，生产初始化不运行 demo seed。CI 不需真实渠道凭证即可完成离线门槛；live 验收另行记录。
