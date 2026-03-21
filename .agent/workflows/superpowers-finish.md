---
描述：完成工作：验证、总结、后续事项、人工校验步骤。
---

# Superpowers 完成

阅读并应用 `superpowers-finish` 技能。

输出：
## 验证（命令 + 尽可能给出结果）
## 变更总结
## 后续事项（如需要）
## 人工校验步骤（如适用）

## 持久化（必填）
生成以上完成内容后，**必须**将其写入磁盘：

1) 复制完整的完成结果 Markdown 输出。
2) 执行：

```bash
python .agent/skills/superpowers-workflow/scripts/write_artifact.py --path artifacts/superpowers/finish.md
```

将完成结果 Markdown 作为标准输入传给该命令。

写入后，通过列出 `artifacts/superpowers/` 目录确认文件存在。

如果你无法执行该命令，请明确说明，并指导用户将完成结果复制粘贴到 `artifacts/superpowers/finish.md`。
不要在此工作流中执行变更。持久化后停止。