---
描述：超能力规划闸门。编写包含文件与验证步骤的细粒度计划。编码前必须请求审批。
---

# 超能力编写计划（闸门）

## 任务
为本任务制定计划（完全按照用户提供的内容）：
**{{input}}**

如果 `{{input}}` 为空或缺失，请让用户用一句话重新描述任务，并**停止执行**。

## 规则
- **禁止修改代码**。
- 可以读取文件以理解上下文，但只输出计划，然后停止。
- 计划步骤必须细小（每步 2–10 分钟），并包含**验证命令**。

## 输出格式（严格使用）
## 目标
## 假设
## 计划
（每一步必须包含：文件、修改内容、验证方式）
## 风险与缓解措施
## 回滚方案

## 持久化（必填）
将计划输出写入：
- `artifacts/superpowers/plan.md`

如文件夹不存在则创建。
写入后，通过列出 `artifacts/superpowers/` 确认文件存在。

## 审批
询问：
**是否批准此计划？如确认无误，请回复 APPROVED。**

如果用户回复 APPROVED：
- 暂不执行实现。
- 回复：**“计划已批准。执行 `/superpowers-execute-plan` 开始实现。”**

## 持久化（必填）
生成上述计划内容后，**必须写入磁盘**：

1) 复制完整的计划 Markdown 内容。
2) 执行：

```bash
python .agent/skills/superpowers-workflow/scripts/write_artifact.py --path artifacts/superpowers/plan.md
```

将计划 Markdown 作为标准输入传给该命令。

写入后，通过列出 `artifacts/superpowers/` 确认文件存在。

如果无法执行该命令，请明确说明，并指导用户将计划内容复制粘贴到 `artifacts/superpowers/plan.md`。

本工作流中**不执行任何代码修改**。持久化完成后立即停止。