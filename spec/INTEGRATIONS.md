# 集成合同与真实能力状态

资料核对日期：2026-09-22。官方依据见 references/SOURCES.md。平台批准与实际凭证是上线条件，不是写代码能自动解决的事项。

## 首版矩阵

| 系统 | 默认交付模式 | live 的前提 | 不可用时 |
|---|---|---|---|
| POS | 标准 CSV 导入、映射与对账；选一家真实 POS 联调 | 商户授权、样本、字段与订单 ID 稳定性 | 明确数据截止，不声称实时 |
| WhatsApp Business Platform | 同意台账、模板/人群审批、adapter；默认首个 live connector | 甲方 WABA/发送号码、模板、token、webhook 和测试接收人许可 | 禁用自动发；生成受控人工待办，不能绕过同意 |
| Facebook/Instagram | 审批内容包、人工发布回填、指标导入 | 账户类型、OAuth、权限、应用审核、媒体条件和回执已核实 | manual_publish，非 auto_published |
| TikTok | 内容包/字幕导出、人工发布与链接回填 | 合适的已获批第三方服务或符合官方要求的已审核应用 | V1 不承诺自建内部工具可自动公开发布 |
| Google Business Profile | 反馈登记/合法导入与回复待办 | 项目 API 申请及账户资格、授权，实际门店验证 | 手工操作原后台，非爬取绕过 |
| 校园日历/热点/天气 | 人工维护 verified context sources | 来源/更新时间/允许使用范围、可用正式接口 | 明示 unavailable，不编造今日事件或天气 |
| Chatwoot/Postiz | 可选独立 adapter，不作核心运行依赖 | 客户选用、license/托管费用、API 权限与状态回执 | 使用本系统的人工闭环 |

## 已核对的关键限制

WhatsApp 官方 Business Messaging Policy 要求联系许可、尊重退出；主动会话使用批准模板；超出最近用户消息后的 24 小时客服窗口时，只能使用批准模板；自动响应必须有清楚的人工升级路径。V1 按此实现，但具体模板状态/限制在发送时再检查。
TikTok Direct Post 官方规定未审核客户端有私密可见等限制，且不接受只为本人/团队管理账号上传的内部用途；因此不能把自建单品牌内部工具的公开直发当成默认可行功能。
Google Business Profile 当前 API 申请先决条件包含管理已验证并活跃 60 天以上的业务档案及相关网站；新店自身可能尚不满足，但可适用的已合格管理主体需实际确认，不能简单说所有新店都绝对不能接。
本轮 Instagram 详细开发者页未成功读取，不据此编造权限名、token 类型或具体端点。G09 必须核对当时的官方文档和目标账号，并把已实测的 capability 写入验收记录。

## Adapter 接口的语义

getCapabilities() -> 每项 read_metrics/read_comments/reply/publish/send_template 的 mode/status/reason/checked_at。
preview(intent) -> 有效性、成本上限、缺失资料、媒体条件；不能产生外部副作用。
dispatch(approvedIntent, idempotencyKey) -> accepted / rejected / unknown；必须返回 external reference 或明确无引用。
getStatus(reference) -> 平台实际状态；无法读取时保留 unknown。
verifyWebhook(rawBody, headers) -> 必须使用对应平台官方签名算法；不可只检查查询 token。
normalizeWebhook(event) -> provider event ID、发生时间、外部对象 ID、状态；幂等且容忍乱序。

status 取 unconfigured / sandbox / pending_approval / active / limited / revoked / failed；mode 取 demo / manual / live。两者分开存，避免“手工可用”冒充“API active”。
生产环境启动时 LIVE_EXTERNAL_WRITES 默认 false。改为 true 还需租户级 kill switch、管理员审批和授权连接，不能一个布尔值绕过业务审批。

## 测试矩阵

Offline：fake provider 验证正确请求、验签边界、重试/超时/撤销，清楚标注模拟。
Sandbox：官方测试账号运行，记录环境和实际响应；不能证明真实收件人可触达。
Live acceptance：甲方指定、明确许可的少量测试接收人；验证模板/内容审批、发送、真实回执、退订后不再发送及撤销授权后的禁用状态。报告脱敏。
若供应商无法提供最终送达状态，交付仅可承诺该 capability 可观测到的最末状态，不虚构 delivered。
