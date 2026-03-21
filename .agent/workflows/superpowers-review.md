# 超级能力评审
描述：按严重等级执行一次**超级能力风格**的评审流程。

阅读并应用 `superpowers-review` 技能。

输出内容：
- 阻塞项（Blockers）
- 主要问题（Majors）
- 次要问题（Minors）
- 细节瑕疵（Nits）
- 总结 + 后续行动

## 持久化（必填）
生成上述评审内容后，**必须**将其写入磁盘：

1. 复制完整的评审 Markdown 输出。
2. 执行命令：

```bash
python .agent/skills/superpowers-workflow/scripts/write_artifact.py --path artifacts/superpowers/review.md
```

将评审 Markdown 内容作为标准输入（stdin）传给该命令。

写入完成后，通过列出 `artifacts/superpowers/` 目录确认文件已存在。

如果你无法执行该命令，请明确说明，并指导用户将评审输出复制粘贴到 `artifacts/superpowers/review.md` 文件中。

**不要**在此工作流中执行任何代码修改。持久化完成后即停止流程。