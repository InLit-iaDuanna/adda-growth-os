import fs from 'node:fs';
import { validationDirectory, assertValidation } from './validation-evidence.mjs';

const evidencePath = `${validationDirectory}/validation.json`;
const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
const capabilities = JSON.parse(fs.readFileSync('docs/capabilities.json', 'utf8'));
const tests = assertValidation(evidence);
const rows = capabilities.map(c => `| ${c.name} | ${c.status} | ${c.evidence.map(file => `[${file}](../${file})`).join('、')} | ${c.limit} |`);
const text = `# 能力与验证记录

由 npm run capabilities 生成。能力范围维护在 docs/capabilities.json；测试数量来自实际运行记录，不由文档手填。离线通过只说明所列用例通过。

最近验证：${evidence.recorded_at}；Node ${evidence.node}。${tests.passed} 项通过，${tests.failed} 项失败，${tests.skipped} 项跳过。

[命令、退出码、日志和源码哈希](../${evidencePath})。生成时比较完整文件集合、哈希、锁文件、工具链和验证命令；新增、删除、修改源码均需重新验证。

| 能力 | 状态 | 实现或测试证据 | 尚未覆盖 |
|---|---|---|---|
${rows.join('\n')}

本记录的验证命令使用已有依赖，未做干净安装；命令本身不包含浏览器点击、生产数据库、真实模型、渠道或客户验收。独立浏览器与 CodeBuddy CLI 实测见项目复审报告。AI-contract 仅检查合成契约；安全扫描是有限静态检查。
`;
fs.writeFileSync('docs/CAPABILITIES.md', text);
console.log('docs/CAPABILITIES.md generated from recorded validation');
