---
描述：超级能力·头脑风暴。生成目标/约束/风险/方案/推荐结论/验收标准。
---

# 超级能力 头脑风暴

## 任务
针对以下任务进行头脑风暴（严格按用户提供内容）：
**{{input}}**

如果 `{{input}}` 为空或缺失，请让用户用一句话重新描述任务，并**停止执行**。

## 输出章节（必须严格使用）
## 目标
## 约束条件
## 已知上下文
## 风险
## 可选方案（2–4 个）
## 推荐方案
## 验收标准

## 持久化（强制）
生成头脑风暴内容后，**必须按以下流程写入文件**：

1) 先输出头脑风暴 Markdown 内容（即上述章节）。
2) 然后立即执行：

```bash
python .agent/skills/superpowers-workflow/scripts/write_artifact.py --path artifacts/superpowers/brainstorm.md
```

将头脑风暴 Markdown 内容作为标准输入传给该命令。

写入完成后，列出 `artifacts/superpowers/` 目录以确认文件存在。

如果无法执行该命令，请明确说明，并指导用户将输出内容复制粘贴到 `artifacts/superpowers/brainstorm.md`。

本工作流**不执行实际修改**。持久化完成后停止。