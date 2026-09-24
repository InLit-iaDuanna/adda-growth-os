# 甲方品牌素材接入 ExecPlan

## 目标和用户可见结果
将甲方提供的 SUIWU 随物品牌素材接入 ADDA 前端，并明确 ADDA 是随物旗下品牌。后台主视觉使用水面素材，后台与顾客页显示母品牌/子品牌关系。

## 仓库现状与依赖
原前端使用占位字母 A 和暖纸/深绿视觉，没有甲方素材目录，也没有静态资源路由。用户提供 11 张 JPG，包含随物 Logo、莲花/水面图片和门店参考图。

## Progress
- 已完成：导入 11 张 JPG 与素材 manifest。
- 已完成：前端页头、后台主视觉和顾客页品牌层级更新。
- 已完成：增加受限 `/assets/*` 静态资源路由和 E2E 检查。
- 已完成：类型、构建、E2E 和完整测试。

## 设计与文件路径
素材放在 `apps/web/public/assets/brand/`，清单为 `manifest.json`。静态资源只允许访问该目录及其子路径，拒绝目录穿越。素材版权状态保留为 `needs_confirmation`，用于本地演示和界面参考。

## 验证命令及预期
`npm run typecheck`、`npm run build`、`npm run test:e2e`、`npm test` 全部通过；E2E 检查清单和 Logo 可访问。

## 实际验证证据
写入 `artifacts/ui-refactor-2026-09-24/validation.json`。

## Decision Log
D040：SUIWU 随物是母品牌，ADDA 是子品牌；素材可用于当前界面演示，但在授权范围确认前不标记为可对外发布素材。

## 回滚与幂等
删除 `apps/web/public/assets/brand/` 并恢复页头背景与文字即可回滚；静态资源路由独立于业务 API。

## Outcomes & Next Checkpoint
下一步可在甲方确认授权范围、正式 Logo 文件和品牌字体后，替换当前 JPG 视觉资源并制作正式主题变量。
