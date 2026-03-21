
---
description: 以小步骤执行已批准的计划，每一步完成后进行校验。将执行产物写入磁盘。遇到失败立即停止。最终完成评审与总结。

---

# 超级能力 执行计划

## 持久化（必填）
必须将执行产物写入磁盘（而非仅保存在 IDE 中的文档）：

- 将执行记录追加到：`artifacts/superpowers/execution.md`
- 将最终总结写入：`artifacts/superpowers/finish.md`

要求：
1) 确保文件夹 `artifacts/superpowers/` 存在（如不存在则创建）。
2) 每完成一个计划步骤后，向 `artifacts/superpowers/execution.md` 追加一条记录。
3) 执行结束时，将最终总结写入 `artifacts/superpowers/finish.md`。
4) 写入完成后，通过列出 `artifacts/superpowers/` 目录确认文件存在。

如果无法直接写入这些文件，使用：
`python .agent/skills/superpowers-workflow/scripts/write_artifact.py --path <目标路径>` 来持久化内容。

## 前置条件（不可跳过）
1) 用户必须对书面计划回复 **APPROVED（已批准）**。
2) 已批准的计划必须在磁盘上存在于：
   - `artifacts/superpowers/plan.md`

如果 `artifacts/superpowers/plan.md` 不存在：
- 立即停止。
- 告知用户先运行 `/superpowers-write-plan`。
- 不修改代码。

## 加载计划
- 读取 `artifacts/superpowers/plan.md`。
- 在进行修改前，简要重述计划（1–2 行）。

## 检查并行执行机会（可选）
加载计划后，分析步骤是否可并行执行：

1. **检查独立步骤**：是否有 2 个及以上步骤操作不同文件且无依赖关系？
2. **如果是**：向用户提示：
   - “我发现步骤 X、Y、Z 相互独立，可以并行执行。”
   - “是否希望使用 `/superpowers-execute-plan-parallel` 以加快执行速度？”
   - “还是继续按顺序执行？（回复：PARALLEL 或 SEQUENTIAL）”
3. **如果选择 PARALLEL**：停止并指导用户改用 `/superpowers-execute-plan-parallel`。
4. **如果选择 SEQUENTIAL 或无独立步骤**：继续下面的顺序执行。

## 按需应用技能
相关场景下读取并应用以下技能：
- `superpowers-tdd`（优先）
- `superpowers-debug`（出现问题时）
- `superpowers-review`
- `superpowers-finish`
- `superpowers-rest-automation`（如相关）
- `superpowers-python-automation`（如为 Python）

## 执行规则（严格）
1) 每次只实现**一个**计划步骤。
2) 每一步完成后：
   - 运行该步骤的校验命令（如无法运行，则提供精确命令与预期结果）。
   - 向 `artifacts/superpowers/execution.md` 追加简短记录，包含：
     - 步骤名称
     - 被修改的文件
     - 修改内容（1–3 条要点）
     - 校验命令
     - 结果（通过/失败 或 “未运行”）
3) 如果校验失败：
   - 停止执行。
   - 切换到系统化调试（使用 `superpowers-debug`）。
   - 修复并校验通过前，不继续执行后续步骤。
4) 保持修改最小化，且范围限定在计划内。如果计划有误或缺少步骤：
   - 停止并更新计划（将更新后的计划写回 `artifacts/superpowers/plan.md`）
   - 如改动重大，需重新获取批准。

## 收尾（必填）
执行结束时：
1) 执行一轮评审（阻塞项/主要问题/次要问题/细节瑕疵）。
2) 将最终总结写入 `artifacts/superpowers/finish.md`，包含：
   - 运行的校验命令 + 结果
   - 修改总结
   - 后续事项（如有）
   - 人工校验步骤（如适用）
3) 通过列出 `artifacts/superpowers/` 确认产物文件存在。

完成收尾步骤后停止。

---
