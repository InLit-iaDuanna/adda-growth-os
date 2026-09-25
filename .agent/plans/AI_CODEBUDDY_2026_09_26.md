# AI_CODEBUDDY_2026_09_26

## 目标

把 CodeBuddy CLI 接入现有统一工程的两个可审查入口：三语言内容生成和增长 Agent 路由。另提供数据生成、Agent 规划、内容写作、审核四个相互独立的角色会话，支持一次运行并发多个会话。

## 边界

- `deterministic_offline` 仍是默认模式，离线演示和现有回归不联网、不消耗模型请求。
- 只有显式设置 `AI_PROVIDER=codebuddy_cli` 才调用本机 `codebuddy`；调用失败返回明确的 `external_blocked`/`ai_output_invalid`，不回退成假成功。
- 每个角色默认是一次性、无工具、单回合会话；不允许模型访问 shell、文件、网络或外部发送能力。可选 `conversation_id` 只用于显式开启独立会话标识。
- 发送给模型的内容只来自当前租户/门店授权的冻结事实、指标和引用。服务端锁定身份、证据、预算和权限字段，模型只能产生草稿文本与建议。
- CodeBuddy 真实冒烟只使用合成数据，证据写入 `artifacts/G04/`；不把模型冒烟称为语言人员验收或生产就绪。

## 实施切片

1. 增加 CodeBuddy CLI provider、角色提示词、超时/输出上限和配置开关。
2. 接入 `/api/content/generate` 与 `/api/control/route`，对模型输出做领域合同校验和来源绑定。
3. 增加多角色合成数据冒烟脚本、运行说明、决策和阻塞记录。
4. 运行构建、145 项现有回归、provider 合同测试，并在本机实际运行至少一个数据生成会话和一个 Agent 会话。

## 回滚

删除 `AI_PROVIDER=codebuddy_cli` 即恢复离线确定性模式；代码保留 provider 但不执行外部调用。

## 进度

- [x] provider 与配置
- [x] 内容工作室实时 provider
- [x] Agent 路由实时 provider
- [x] 多角色脚本和证据
- [x] 全量验证与 Git 提交（`validate:unified`、`ai:roles`、147/147 回归已通过）
