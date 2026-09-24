# 前端结构重构 ExecPlan

## 目标和用户可见结果
在不改变现有业务流程、接口、权限和缺失状态语义的前提下，拆分前端渲染资源，使后台与顾客页样式可独立维护，后续视觉迭代不再修改业务事件处理代码。用户看到的页面结构、响应式布局和语言切换保持一致。

## 仓库现状与依赖
前端由 `apps/web/src/ui.ts` 服务端返回 HTML，并通过 `Function.toString()` 注入浏览器端应用函数。当前后台 CSS、顾客 CSS、模板和事件处理全部在单文件中，单文件约 233 行且有多行超长字符串。依赖现有 TypeScript 构建和 Node 测试，不新增运行时框架。

## Progress
- 已完成：检查 GOAL、TASKS、现有 UI 设计记录和回归测试。
- 已完成：拆分后台/顾客页样式到 `ui/styles.ts`。
- 已完成：抽取共享 HTML 文档壳到 `ui/page-shell.ts`。
- 已完成：运行类型、构建、前端回归和完整测试。

## 设计与文件路径
新增 `apps/web/src/ui/styles.ts`，导出后台和顾客页 CSS；新增 `apps/web/src/ui/page-shell.ts`，负责文档头、样式注入和脚本注入。`apps/web/src/ui.ts` 保留业务模板和浏览器端行为，仅调用壳层和样式函数。浏览器端函数继续以内联脚本运行，避免引入静态资源服务器和改变 CSP/部署行为。

## 实施步骤
1. 从 `ui.ts` 提取后台 CSS 与顾客 CSS 到 `ui/styles.ts`。
2. 抽取 HTML 文档包装与安全脚本参数化到 `ui/page-shell.ts`。
3. 替换 `renderAdminPage`、`renderConsumerPage` 的内联拼接，保留所有既有 DOM ID、表单 name 和脚本入口。
4. 执行 typecheck、build、单元/集成/e2e 与 usability 回归；失败记录实际错误。

## 验证命令及预期
`npm run typecheck`、`npm run build`、`npm run test:usability-regressions`、`npm run test:e2e` 应通过；必要时运行 `npm test`。

## 实际验证证据
`artifacts/ui-refactor-2026-09-24/validation.json` 记录本轮命令、退出码和测试结果。

## Surprises & Discoveries
共享壳需要对文档 title/lang 做 HTML 转义；顾客页原有 store slug 转义保留在脚本参数中，文档 title 由壳统一转义。

## Decision Log
D039：采用编译期拼接 CSS 和文档壳，不引入运行时静态资源请求，确保离线 DEMO 与现有服务端 HTML 行为一致。

## 回滚与幂等
新增文件可删除；`ui.ts` 的替换是机械性调用替换。若验证失败，恢复 `ui.ts` 中原 CSS/template 拼接即可，不触碰服务端路由和业务仓储。

## Outcomes & Next Checkpoint
前端资源边界已清晰，下一步可在不触碰业务脚本的情况下替换主题或接入静态资源构建。
