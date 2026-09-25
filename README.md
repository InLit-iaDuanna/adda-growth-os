# ADDA Growth OS — 统一源码交付

**ADDA 是 SUIWU 随物旗下品牌。** 本工程以用户上传的 `adda-growth-os-source-2026-09-25.zip` 为基线，保留原业务后端，统一运营、审核、收银和顾客端，并接入持久化只读 Agent worker。不是独立 HTML 原型，也不是需要另找仓库拼装的补丁。

当前真实实现：TypeScript + Node HTTP + 文件事务仓储。`spec/` 中 Next.js、PostgreSQL/Prisma、pg-boss 等仍是目标架构；本次不冒充已完成这些迁移。真实模型通过显式 CodeBuddy CLI 开关接入内容写作和同步 Agent 路由，外部发送仍保持关闭。

## 一键本地演示

需要已安装 Node.js。此次实际验证版本为 **Node 22.16.0**。交付 ZIP 同时包含完整源文件和由它们编译的 `dist/`，无需联网安装依赖即可先试用：

```bash
cd adda-growth-os-unified
node scripts/demo.mjs
```

Windows 也可以双击 `START-DEMO.cmd`；macOS/Linux 可执行 `sh START-DEMO.command`。服务仅监听 `127.0.0.1`；同时启动 Web 与 worker，Ctrl+C 同时退出。数据写入 `data/local-demo.json`，重启后保留；不会读取 `.env` 中的生产密钥，不开启真实外发，不覆盖非 demo 数据库。

| 入口 | 路径 | 演示账号 |
|---|---|---|
| 运营工作台 / A 首页 + B 编排 | `http://127.0.0.1:3000/admin` | `owner@demo.adda.local` |
| 本地语言审核 | `http://127.0.0.1:3000/review` | `reviewer@demo.adda.local` |
| 收银与现场核验 | `http://127.0.0.1:3000/staff` | `cashier@demo.adda.local` |
| 顾客 H5 | 活动中创建的 `/s/<门店>/c/<来源令牌>` | 不使用运营账号；顾客持独立访问令牌 |

以上三个账号的密码均为 `demo-only-password`，**仅演示使用，不能用于生产**。根路径 `/` 兼容运营入口。没有来源令牌的顾客入口会明确禁用注册，不编造活动来源。

## 开发与测试

修改 TypeScript 后重新构建；从 Git 源码而非交付 ZIP 启动时也须先构建：

```bash
npm ci
npm run build
npm test
npm run demo:ready
```

`npm test` 编译并运行所有原有与新增 TS 测试，以及原有 MJS 证据校验测试。`npm run test:compiled` 直接验证附带编译产物，无需 tsx。保留原有分组测试脚本；它们在安装锁定依赖后可单独执行。

## 可选的 CodeBuddy 实际 AI

离线演示默认不调用模型。已登录 CodeBuddy CLI 的本机可以显式开启：

```bash
APP_MODE=demo \
AI_PROVIDER=codebuddy_cli \
CODEBUDDY_MODEL=deepseek-v4.1-flash \
SESSION_SECRET=local-demo-secret \
ADDA_DATA_FILE=./data/local-demo.json \
HOST=127.0.0.1 \
PORT=3000 \
node dist/apps/web/src/server.js
```

这条命令用于已经完成 demo 数据初始化的工程；`scripts/demo.mjs` 会刻意保持离线模式，需直接启动 Web 服务才会调用 CodeBuddy。

也可以运行四个相互独立的合成角色会话（数据生成、Agent 规划、内容写作、审核）：

```bash
AI_PROVIDER=codebuddy_cli npm run ai:roles
```

每次会话单回合、禁用 CodeBuddy 工具、带超时和输出上限；内容和 Agent 结果会再次经过服务端领域合同校验。内容写作的 `bn` 永远先标记 `needs_local_review`，Agent 建议预算固定为 0，模型失败返回 `external_blocked` 或 `ai_output_invalid`，不会退回假成功。合成运行记录在 `artifacts/G04/` 与 `artifacts/G08/`。后台持久化 control-run worker 仍使用离线确定性 provider，异步真实模型桥接需单独验收。

```bash
npm run validate:unified          # 完整源码、本地 HTTP/仓储回归与当前验证记录
npm run test:browser              # 原生 Playwright 交互；需 Python、playwright、requests、Chromium
npm run test:browser -- --dom-harness   # 受限环境的 DOM + 实际 HTTP 桥模式，不能当原生 E2E
```

浏览器脚本在独立临时测试数据库中创建明确标注的合成品牌、产品、活动、订单与会员，退出后清理。实际浏览器模式默认路径 `/usr/bin/chromium`，可用 `--chromium <可执行文件路径>` 指定。Python 依赖可用 `python -m pip install playwright requests` 安装。

## 可操作链路

运营端录入并审批品牌事实、产品价格与素材授权，再创建活动和来源链接。内容生成默认是确定性草稿；启用 CodeBuddy 后由 `content_writer` 生成草稿，但仍经过语言审核 → 提交 → 负责人批准或退回 → 导出人工发布包。编辑会重置本地复核并使旧审批失效；历史页保留已批准内容快照。导出成功不等于已发布。

Agent 编排可选后台执行或逐步调试。创建时固定门店、请求键、输入证据快照、截止时间和重试上限；worker 在每个检查点重新核对账号/租户/门店授权。离开页面不丢任务，取消后不再推进，重试不重复已完成的上游节点。输出必须通过来源引用与指标快照校验。后台任务默认是确定性只读执行；启用 CodeBuddy 时，已认证的同步 `/api/control/route` 才会调用 `agent_planner`，仍不执行外部动作。

顾客持来源链接注册，营销同意默认不勾选；可撤回同意。演示验证使用 `000000`，生产缺验证渠道会阻断。重复领券不会重复占用额度或累计领券转化事件。收银端保留券后，必须匹配已导入的权威 POS 订单；签到或券保留本身不产生营收。

## 源码结构

- `apps/web/src/server.ts`：实际 HTTP API，保留原业务路由并增加范围收窄、编排、批准历史与顾客状态读取。
- `apps/web/src/ui/`：运营/审核/收银共享控制器、页面模块、顾客页面、A+B 组件；`ui.ts` 仅保留统一导出入口。
- `packages/ui/src/theme.ts`：共享主题与母子品牌配置。深色编排仅是同一设计体系中的工作区，不再另建一套全局皮肤。
- `packages/domain/src/control-*`：请求、工具能力、证据快照、输出验证和运行状态机。
- `packages/adapters/src/codebuddy.ts`：CodeBuddy CLI provider、角色提示词、无工具会话、超时/输出上限和结构化 JSON 解析。
- `packages/adapters/src/control-worker.ts`、`apps/worker/`：实际后台检查点处理与串行 worker 循环。
- `packages/db/`：原 JSON 仓储，原子写入、文件锁、批准历史、去重与现有预算/回执账本。
- `tests/`、`artifacts/unified-2026-09-25/`：新增/原有测试及此次实际证据。

## 品牌资产与验证边界

四张甲方原图原样保留，校验值和用途说明在 `apps/web/public/assets/brand/client-assets.json`。界面以 ADDA 为主、SUIWU 为母品牌背书；不将母品牌英文标语改成 ADDA 功效承诺。图片用于此次页面，不等于自动批准营销素材授权。

此次网络无法完成 `npm ci`，构建使用环境预装的真实 TypeScript 5.8.3 / Node 类型定义；不是锁版本干净安装验收。完整应用 HTTP 与文件仓储测试已执行。浏览器原生导航被环境策略阻断，本次截图与点击检查使用内存 DOM + 真实 HTTP 客户端桥，没有伪造成功响应，但不验证原生 Cookie、同源、存储或导航。

生产数据库、受控 OWNER 初始化、模型成本结算、异步 provider bridge、WhatsApp 发送/对账 worker、真实孟语质量与客户 UAT 仍未交付或验收；详见 [本次交接](docs/UNIFIED_HANDOFF.md) 和 [阻塞项](docs/BLOCKERS.md)。不要将本地通过解释成 PRODUCTION_READY。旧 `artifacts/Gxx`、历史复审报告保留作为旧证据，不是本次验收。
