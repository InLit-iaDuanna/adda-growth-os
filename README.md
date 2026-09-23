# ADDA Growth OS

面向门店的增长管理原型，包含订单与退款、会员、优惠券、内容审批、触达意图、反馈工单和指标报表。

当前实现使用 TypeScript、`node:http` 和 JSON 文件仓储。可用于本地演示和离线回归，尚不具备生产交付条件。`spec/` 中的 Next.js、PostgreSQL/Prisma 和 pg-boss 是目标架构，尚未落地。

## 本地运行

需要 Node.js 20 或以上版本。

```bash
npm ci
APP_MODE=demo npm run db:migrate
APP_MODE=demo npm run db:seed:demo
APP_MODE=demo npm run dev
```

打开 <http://127.0.0.1:3000>。种子命令输出登录账号，演示密码为 `demo-only-password`。演示数据均为合成数据，生产模式禁止导入。

```bash
npm run typecheck
npm test
npm run build
```

`npm test` 包含业务、集成、端到端 HTTP 与可用性回归测试。`npm run test:ai` 检查结构化输出契约和合成用例；`npm run fixtures:verify` 校验数值夹具。两者都不评估真实模型质量。2026-09-23 的独立浏览器操作复审记录见 [项目复审报告](reports/PROJECT_REVIEW_2026-09-23.md)。

工作台有中文和英文切换，演示页有英文和孟加拉语切换。工作台覆盖品牌事实、活动与优惠、内容审批、CSV 导入、会员触达、校园活动、反馈工单、日报与连接器状态；顾客来源链接支持注册、验证、查看优惠及领取券。页面中的“导出”“人工执行”“尝试发送”分别标注结果，不代表外部渠道已发送。

本地 CodeBuddy CLI 可单独执行一次真实模型冒烟测试：

```bash
npm run test:codebuddy-ai
```

该命令使用 `deepseek-v4.1-flash`，每次运行调用 1 次，输入只含合成且已核实的品牌事实，检查英/孟双语短文案和未核实优惠禁用，结果写入 [CodeBuddy 测试记录](reports/codebuddy-ai-test.json)。它不在 `npm test` 中自动运行，也没有把工作台的内容生成切换成外部模型；工作台仍使用确定性提供者。

## 配置与边界

- 配置从环境变量读取，参见 `.env.example`。`APP_MODE` 支持 `demo`、`test`、`production`，默认 `production`；数据文件默认为 `data/<mode>-db.json`，可通过 `ADDA_DATA_FILE` 指定。
- 生产模式要求至少 32 字符的 `SESSION_SECRET`。会话 Cookie 带 `Secure`，部署需提供 HTTPS。当前没有生产 OWNER 初始化或邀请流程。
- PostgreSQL 适配器未实现；设置 `DATABASE_URL` 会报错。`db:migrate` 目前只迁移 JSON 数据结构。
- 工作台运行时的 AI 内容生成使用确定性实现；CodeBuddy CLI 目前只接入独立测试脚本，尚未完成真人孟语评审。
- 真实外发默认关闭。WhatsApp 已实现本地 webhook 验签、状态解析和验证握手；配置密钥不等于完成发送接入，真实 WABA 联调仍待完成。
- `npm run worker` 目前只处理 `maintenance` 任务；其他任务返回 `worker_handler_unimplemented`。发送与回执对账处理器尚未实现。
- `test` 模式可使用本地 outbox；人工导出不代表平台发布。真实渠道、生产部署及客户 UAT 均需单独验收。

## 复审修复与恢复

当前包含前三轮离线修复。本轮 B01–B05 统一了订单身份、七天归因窗口和有效期校验，保留此前的审批、权限、指标与触达修复。

- 订单业务身份为租户、门店、来源和外部订单号；修订沿用同一身份。归因与券匹配可传 `order_source`，或明确的 `order_id`；存在同号异源订单时，不传来源会返回 `order_reference_ambiguous`。历史歧义归因保留 `unknown`，需要核实来源后补充明确证据。
- 第一方触点仅在订单前七天至支付时刻内参与归因，取最后一次；已核验的订单券证据优先，可以在支付后核验，但不能晚于报告 `as_of`。结果记录 `primary_source_v2` 和 `touch_window_days: 7`。窗口目前固定，没有配置界面。
- 日期需包含时间和时区。可选到期时间以 `null` 表示无限期；错误日期、无时区日期、结束不晚于开始的区间都拒绝保存。历史错误数据也会阻止审批或导出，须更正来源并重新走审批。

- 旧内容缺少生成事实时，需要重新生成、语言复核及批准。改价后只编辑说明文字不能刷新事实绑定。
- 日报或任务范围不完整时隐藏，按当前权限重新生成。未导入门店不能算零；订单表头空文件加明确完整水位可确认零成交。可通过门店 `orderSources` 配置登记预期来源；尚无配置界面。
- 相同请求键重放原结果；新的显式请求键可重新评估未发送的跳过项。已发送、已预留或未知送达不能据此再发。同活动同会员的新一轮营销应创建新活动并重新批准。
- 旧触达审批需通过编辑、重新批准升级绑定；历史意图继续计入额度。无法关联活动的旧意图阻止新的预算分配，需核实记录后处理。

```bash
npm run validate:release
npm run capabilities
```

前者保存命令、退出码、日志、完整源码集合、锁文件哈希和工具链版本；运行期间源码变化也会失败。后者生成 [能力记录](docs/CAPABILITIES.md)，新增、删除、修改源码或工具链不一致时拒绝使用旧证据。内部未实现能力和外部联调条件分别列在 [未完成事项](docs/BLOCKERS.md)。

## 目录

| 路径 | 内容 |
|---|---|
| `apps/web`、`apps/worker` | HTTP 应用与后台任务入口 |
| `packages/domain` | 业务规则、审批、触达政策和指标计算 |
| `packages/db`、`packages/adapters` | JSON 仓储、配置和渠道协议 |
| `tests`、`fixtures` | 自动化测试与合成数据 |
| `scripts` | 数据迁移、备份恢复、安全扫描和性能测量 |
| `spec`、`goals`、`TASKS.json` | 产品规格、里程碑和进度 |
| `docs/BLOCKERS.md`、`docs/DECISIONS.md` | 未完成事项与技术决策 |
| `artifacts/audit-remediation`、`artifacts/audit-n01-n08`、`artifacts/audit-b01-b05` | 三轮离线审查修复证据 |
