---
描述：系统化调试工作流：复现 → 最小化 → 提出假设 → 埋点观测 → 修复 → 预防 → 验证。
---

# 超级能力 调试

读取并应用 `superpowers-debug` 技能。

使用**要求的报告格式**：
- 现象
- 复现步骤
- 根因
- 修复方案
- 回归防护
- 验证

## 持久化（强制）
生成上述调试内容后，**必须写入文件**：

1) 复制完整的调试 Markdown 内容。
2) 执行：

```bash
python .agent/skills/superpowers-workflow/scripts/write_artifact.py --path artifacts/superpowers/debug.md
```

将调试 Markdown 内容作为标准输入传给该命令。

写入完成后，列出 `artifacts/superpowers/` 目录以确认文件存在。

如果无法执行该命令，请明确说明，并指导用户将调试输出复制粘贴到 `artifacts/superpowers/debug.md`。

本工作流**不执行代码修改**。持久化完成后停止。