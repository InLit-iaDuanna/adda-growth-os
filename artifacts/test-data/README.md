# ADDA 完整合成测试数据

这套数据只属于 `ten_demo_01` / `sto_demo_01` 合成租户，覆盖四端登录、品牌事实、产品价格、甲方素材、活动来源、顾客注册、领券、POS 订单、退款、内容审批、校园活动、CRM、顾客声音和 Agent 报表。所有姓名、联系方式、订单和反馈都是 synthetic；不会连接 WhatsApp、支付或真实发布渠道。甲方原图只作为素材样本随包保存，授权状态仍由 fixture 明确控制，不能据此推断商业使用权。

## 启动

先在工程根目录构建，再生成或使用 `data/complete-demo.json`：

```bash
npm run build
node scripts/seed-complete-test-data.mjs
APP_MODE=demo \
ADDA_DATA_FILE=./data/complete-demo.json \
SESSION_SECRET=local-complete-test-secret-change-me \
AI_PROVIDER=deterministic_offline \
LIVE_EXTERNAL_WRITES=false \
HOST=127.0.0.1 PORT=3000 \
node dist/apps/web/src/server.js
```

若只想使用已生成的文件，可先执行 `npm run demo:complete`；它会把 fixture 复制到隔离运行文件，并同时启动 Web 与 worker（默认端口 `3111`）。`npm run data:seed` 会从干净演示种子重新生成 JSON、CSV、manifest 和原图副本。另开终端运行 `node scripts/verify-complete-test-data.mjs --server=http://127.0.0.1:3111` 可复核领域合同与三类账号登录。

如需同时运行后台 worker，使用同一组环境变量启动 `dist/apps/worker/src/index.js`。本数据包默认离线确定性模式；CodeBuddy 测试另用 `AI_PROVIDER=codebuddy_cli`，不会把本 fixture 变成生产数据。

## 账号

四个账号的密码均为 `demo-only-password`：

| 角色 | 账号 | 用途 |
|---|---|---|
| OWNER | `owner@demo.adda.local` | 品牌、产品、活动、审批、报表 |
| GROWTH_MANAGER | `manager@demo.adda.local` | 活动、CRM、顾客声音、Agent |
| LOCAL_REVIEWER | `reviewer@demo.adda.local` | 孟语复核与内容审核 |
| CASHIER | `cashier@demo.adda.local` | 优惠券保留、POS 订单匹配、签到 |

顾客入口使用 `manifest.json` 中的 `raw_tokens.source_links.campus`，路径为：

```text
/s/du-gate-demo/c/<source-token>
```

验证验证码为 `000000`。`member_tokens` 和 `coupon_tokens` 仅用于本机流程检查。

## 可复现 CSV

- `members.csv`：五个合成会员，包含已验证、未验证、营销同意和退订场景。
- `orders.csv`：五个已支付订单和一个 void 订单，会员列使用 CSV 外部会员 ID，含已归因与未归因场景。
- `refunds.csv`：一个部分退款和一个全额退款。

CSV 可以在运营端导入预览/提交；JSON fixture 已经包含同一批已提交数据，二者不要在同一数据库重复导入。

## 覆盖场景

- 内容：一个已批准可导出 revision，一个等待孟语本地复核且素材权利未确认的 revision。
- 收银：一个已核销优惠券、一个等待 POS 匹配的优惠券、一个仅已发放优惠券。
- 活动：一个正在进行的 Study Break 活动，三人报名，两人签到，一条已达成推荐记录，时间均与生成时刻一致。
- CRM：营销同意人群、holdout、人工渠道 external blocked 尝试和零预算审批。
- 顾客声音：一个 food-safety 紧急 case 和一个普通 offer 问询 case。
- 指标：已确认 POS 水位、部分/全额退款、身份覆盖、复购和注册后 7 日转化；报表值由指标服务计算，不是手写展示值。

`assets/originals/` 保存当前工程目录中可读取的 4 张原图。fixture 中批准使用的两张素材使用文件 SHA-256；第三张素材仍是 `unknown`，用于验证内容不能绕过授权检查。

完整仓储快照见 [complete-demo.json](complete-demo.json)，账号、token、ID 与覆盖统计见 [manifest.json](manifest.json)，逐场景预期见 [scenarios.json](scenarios.json)。
