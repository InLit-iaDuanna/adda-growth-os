# 数据模型与不变量

## 通用约定

内部 ID 使用 UUID/高熵 ID；所有业务实体含 tenant_id、created_at、updated_at，门店限定实体另含 store_id。引用关系必须具有同 tenant/store 的复合约束或同等事务校验。金额使用 bigint/int64 的 minor units；数量用明确小数精度；禁止浮点货币。
时间存 UTC timestamptz，来源保留原始 timezone 与 occurred_at、received_at。store.timezone 默认 Asia/Dhaka，营业日边界可配置，首版默认当地 00:00。导入无时区时间必须明确映射后确认。

## 实体清单（Codex 在 G00–G03 逐步实现迁移）

| 领域 | 实体 | 核心字段和约束 |
|---|---|---|
| 组织 | tenants, stores | slug、timezone、currency、launch_date、business_day_start、status |
| 人员 | users, memberships, store_grants | 认证主体、role、允许门店、撤销时间；权限由服务端派生 |
| 品牌 | brand_documents, brand_revisions, brand_facts | source、version、status、effective_from/to、approver、supersedes_id |
| 素材 | media_assets, asset_permissions | storage_key、owner、版权/出镜授权、allowed_uses、expires_at、checksum |
| 菜单 | products, product_variants, price_versions | 外部 SKU、语言名称、真实售价、门店可售、有效期；缺成本=unknown |
| 活动 | campaigns, campaign_revisions, campaign_costs | 目标指标、日期、预算、优惠规则、容量、负责人、固定成本分类 |
| 内容 | content_briefs, content_revisions, localized_variants | 栏目、渠道、hooks、shots、字幕、事实引用、审核、内容 hash |
| 发布 | publication_intents, publication_receipts | revision_id、channel、scheduled_at、manual/live、external_post_id、证据状态 |
| 校园 | organizations, partners, partner_engagements | 来源、核实、联系许可、交付约定、费用草稿、负责人 |
| 来源 | source_links, touch_events | campaign/content/partner、opaque_token_hash、发生时间、同意、第一方会话 |
| 会员 | members, member_contacts, contact_verifications | tenant 范围身份、verified 状态、加密联系地址、HMAC 查重、语言 |
| 同意 | consent_events, suppression_entries | channel、purpose、notice_version、source、granted/revoked、时间、证据 |
| 券 | offers, issued_coupons, redemption_attempts | 规则版本、token_hash、member、有效期、门店、POS 引用、核验状态 |
| 订单 | orders, order_lines, order_adjustments | source、external_order_id、member_id 可空、paid_at、金额、退款事件 |
| 导入 | imports, import_rows, import_errors, source_watermarks | 文件 hash、映射版本、预览结果、提交人、错误行、完整数据截止时间 |
| 归因 | attribution_assignments, attribution_evidence | order_id、唯一 primary campaign、method、规则版本、源证据 |
| 活动到场 | events, registrations, checkins | 容量、已确认报名、签到员工、现场核验、重复唯一约束 |
| 推荐 | referrals, reward_ledger | inviter/invitee、first_qualified_order、pending/eligible/approved/reversed |
| 触达 | segment_definitions, audience_snapshots, outreach_campaigns, message_attempts | 规则、冻结成员、同意版本、预算、模板、回执 |
| 客服 | feedback_items, feedback_labels, cases, case_events | source_id、原文、去重、标签、严重度、owner、SLA、解决证据 |
| 治理 | approvals, action_intents, outbox_events, audit_events | payload_hash、actor、resource_revision、purpose、expiry、结果 |
| AI | ai_runs, ai_artifacts, evaluation_results | 输入快照、模型、技能、知识版本、引用、成本、结果、人工评语 |
| 报告 | metric_snapshots, daily_reports, experiment_assignments | formula_version、scope、as_of、complete_through、cohort、分配种子 |
| 集成 | integrations, credentials_refs, provider_events | capability、mode、last_sync、验签配置、外部事件唯一键 |

以上是领域清单，不要求每个逻辑实体必然单独一张表；合并需说明迁移和约束不变量。不得以 40 个空 CRUD 页面替代纵向闭环。

## POS 导入

标准订单字段：source、store_external_id、external_order_id、paid_at、currency、amount_paid_minor、tax_collected_minor、status、external_member_ref 可空。amount_paid 已扣优惠，不得再次扣折扣；用于分析的订单净额扣已记录退款与相关税额，税字段缺失则不能宣称“不含税营收”。
本包 fixture 的金额均假定为已映射的、不含代收税且已扣折扣的金额，不代表实际 POS 的原始格式。
退款单独字段：external_adjustment_id、external_order_id、occurred_at、amount_minor、tax_refund_minor、reason。允许部分退款、多次退款、迟到退款，累计退款不得超过可退金额；非法记录隔离，不悄悄截断。
导入流程：上传 → 字段映射 → 数据预览/错误行 → 确认 → staging → 事务提交 → 对账报告。重新上传同一文件/同一订单不得增加销售。相同 external_order_id 不同金额必须更新为有审计的修订/纠错，而非静默重复插入。
唯一键至少包含 tenant、store、source、external_order_id；退款唯一键含 source adjustment ID。POS 更新和退款都保留原始行、文件和映射版本。

## 会员身份

member 是品牌 tenant 范围身份，门店端只能访问自身授权消费范围和必需联系字段。不能仅因姓名相同或相似头像合并；人工合并需证据、角色、审计，并重新计算受影响指标。
手机号/email 原文加密；用于确定性查重的 normalized_contact HMAC 使用秘密密钥，不能简单裸 SHA 哈希手机号。验证渠道需 proof 和 expiry；测试验证码只存在 DEMO 的 test outbox。
匿名订单计入总销售，不计入已识别顾客的复购分母；报告显示匹配覆盖率。历史不完整时标为“首次观测购买”，不能宣称“生平第一次来店”。

## 券和订单的连接

领券/保留券状态：issued → reserved/pending_pos_verification → redeemed；另有 expired/cancelled/reversed。
收银员验证一次性 token、门店、日期、条款、库存/活动容量及会员约束后，录入实际 POS order_ref。该动作不是 POS 支付，也不自动修改 POS 价格；折扣在现有 POS 中由员工按已批准条款处理。
导入匹配后检查金额、SKU、状态、member 归属和优惠条件；没有匹配单不计成交。配置对账期限，超时转 discrepancy 待人工处理；不自动伪造订单。
并发核销采用事务和唯一约束，至少测试 20 个同时请求仅一个成功。网络失败不能退回离线多次兑现。

## 审批与证据

批准对象必须冻结 revision + audience snapshot + channel + budget + policy version + expiry 的 hash。品牌版本、日期、条款、价格、素材许可或受众发生实质变化时标记 stale_approval。
发布与消息回执分别保存 provider-confirmed、operator-attested 和 imported-evidence；显示证据等级，不把员工填链接等同于 API 已验证。
消息截图等可能含 PII，限制可见范围和保留期；审计日志只记录必要字段，不复制整段私聊。

## 删除与留存

删除请求先撤销触达与访问，按批准的留存策略删除/去标识联系信息、映射、原始文本和不必保留的日志。保留订单/审计是否必要由合同及适用义务确定，不写死永久保留。备份到期删除并记录擦除与恢复后再删除流程。
