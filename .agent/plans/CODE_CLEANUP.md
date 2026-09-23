# 代码精简

## 目标和用户可见结果
合并重复逻辑，删去重复解释，使代码和 README 更易读。保持接口、权限、审批和触达行为。

## 仓库现状与依赖
当前代码使用 node:http 和 JSON 仓储。触达政策已有领域函数，但三个入口重复组装参数；已有 63 项回归可复用。

## Progress
- [x] 检查代码和仓库规则，保存重构前副本。
- [x] 合并触达参数、同意判断，精简注释和 README。
- [x] 运行全量测试和编译，记录结果。
- [x] 保存精简后的源码包：deliverables/ADDA_Growth_OS_clean_source.zip。

## 设计与文件路径
repository.ts 统一策略输入构造；worker 保留租约用途说明；README 只保留运行、配置和限制。领域政策的判断顺序不变。

## 实施步骤
提取三处相同策略参数，保持各入口的预算递增和幂等分支；合并营销同意查询；检查改动后运行现有回归。

## 验证命令及预期
npm test、npm run typecheck、npm run build：通过。使用现有测试，不更改断言。

## 实际验证证据
npm test：63/63，通过，退出码 0；npm run typecheck、npm run build：退出码 0；npm run security:scan：54 个文件、无发现，退出码 0。日志位于 artifacts/G10/code-cleanup/。

## Surprises & Discoveries
审批事务内的重复检查用于防止状态变化，不能作为普通重复代码删除。
noUnusedLocals/noUnusedParameters 检查发现未调用的 metricEvidenceForQueries、daysBetween 和未使用导入；已清理，检查加入 tsconfig。

## Decision Log
只抽取重复的业务逻辑，不引入框架、依赖或通用策略引擎。

## 回滚与幂等
重构前副本位于 .tmp-code-cleanup-before/。不迁移数据；保留原有幂等顺序。

## Outcomes & Next Checkpoint
代码精简及只读复审完成，回归通过。未改测试断言、API 错误码或生产功能范围。
