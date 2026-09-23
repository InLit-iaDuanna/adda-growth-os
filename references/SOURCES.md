# 参考资料与复用决策

核对日期：2026-09-22。仅引用官方文档/原项目。功能描述来自公开资料；没有进行这些项目的部署、性能、安全或甲方账号联调。以下短述不是第三方源码复制。

## S01 — Codex AGENTS.md

[Codex AGENTS.md](https://developers.openai.com/codex/guides/agents-md)

官方项目指令发现机制；用于 AGENTS.md，不保证一轮完成整个项目。

## S02 — Codex execution plans

[Codex execution plans](https://developers.openai.com/cookbook/articles/codex_exec_plans)

官方关于持续计划和可验证行为的指导；本包采用自行编写的计划模板。

## S03 — WhatsApp Business Messaging Policy

[WhatsApp Business Messaging Policy](https://business.whatsapp.com/policy)

同意、退出、模板、24小时窗口、自动响应人工升级。

## S04 — TikTok Content Sharing Guidelines

[TikTok Content Sharing Guidelines](https://developers.tiktok.com/doc/content-sharing-guidelines)

未审核客户端限制以及不接受仅内部团队上传用途。

## S05 — Google Business Profile API prerequisites

[Google Business Profile API prerequisites](https://developers.google.com/my-business/content/prereqs)

API 申请条件、60天已验证活跃档案要求及批准流程。

## S06 — Postiz

[Postiz](https://github.com/gitroomhq/postiz-app)

参考内容日历、发布状态和渠道 adapter；README 声明 AGPL-3.0，不直接复制进闭源项目。

## S07 — Chatwoot

[Chatwoot](https://github.com/chatwoot/chatwoot)

参考统一会话、标签、工单与人工协作；LICENSE 区分 enterprise/，其他相关代码 MIT Expat，第三方各自授权。

## S08 — Twenty

[Twenty](https://github.com/twentyhq/twenty)

参考 CRM 对象、视图、联系人和工作流；不是奶茶会员系统的现成替代，复制前另核具体许可。

## S09 — Vercel AI SDK

[Vercel AI SDK](https://github.com/vercel/ai)

TypeScript、多模型 provider、结构化生成；本方案的模型应用层候选。

## S10 — AI SDK tool calling

[AI SDK tool calling](https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling)

类型化工具与批准机制；应用仍须独立服务端授权和持久化审批。

## S11 — pg-boss

[pg-boss](https://github.com/timgit/pg-boss)

PostgreSQL 后台任务队列；不能因此推导第三方发送端到端只发生一次。

## S12 — Better Auth

[Better Auth](https://github.com/better-auth/better-auth)

TypeScript 认证组件；使用实际稳定版本并落实业务资源权限。

## S13 — Langfuse

[Langfuse](https://github.com/langfuse/langfuse)

可选模型 tracing/评测参考；官方说明除 ee 文件夹外 MIT。

## S14 — WhatsApp Business Platform capability and onboarding

[WhatsApp Business Platform features](https://business.whatsapp.com/products/business-platform-features)

官方能力页用于核对客户 opt-in、模板和发起式消息前置条件；本地实现仍要求服务端凭证、持久化批准 intent 和人工降级。

[WhatsApp API onboarding resources](https://business.whatsapp.com/resources/resource-library/api-onboarding)

官方 onboarding 资源用于核对账号、权限和 opt-in 准备项；本轮没有真实 WABA 账号或 provider 请求。

## 本项目的选择

直接采用/按依赖选型：AI SDK、pg-boss、Better Auth，以及 Next.js/PostgreSQL/Prisma/Zod 等基础组件，实施时锁定兼容版本。
设计参考：Postiz（内容发布）、Twenty（关系管理）、Chatwoot（客服协作）。
可选外部服务适配：Postiz、Chatwoot、Langfuse，不要求全部自托管，也不要求所有系统一起部署。

不因为 GitHub 可见或使用“开源”标签，就承诺能够闭源改造和转售。Postiz AGPL-3.0、Chatwoot enterprise 和 Langfuse ee 等边界必须按实际文件/部署/分发方式审核；不作法律结论。复用须保留必要通知并维护依赖清单。模型、消息和托管服务条款另行核对。

## 尚待验证

Meta Instagram 的部分官方开发者页面本轮读取失败。不要假定某种账号、scope 或端点已验证；G09 使用实施当时官方文档与甲方账户实测。本文没有对甲方真正持有的任何平台权限作出保证。
