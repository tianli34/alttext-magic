
---
描述：对已通过审批的计划中相互独立的步骤进行**并行执行**。创建独立子代理，汇总执行结果。
---

# 超级能力 执行计划（并行模式）

## 概述
本工作流会识别已审批计划中的独立步骤，并通过独立子代理对这些步骤**并行运行**，从而执行计划。

## 何时使用并行模式
- 计划包含 **2 个及以上互不依赖** 的步骤
- 各步骤操作不同文件或独立模块
- 希望**加快执行速度**（并行 > 串行）

## 何时不使用并行模式
- 步骤之间存在依赖关系（步骤 2 需要步骤 1 的输出）
- 所有步骤都修改**同一个文件**
- 计划步骤数 **少于 2 个**
- 希望**简化调试**（串行更易调试）

**如不确定，请改用 `/superpowers-execute-plan`（串行模式）。**

---

## 前置条件（不可跳过）
1. 用户必须对书面计划回复 **APPROVED（已批准）**
2. 已批准的计划必须位于：`artifacts/superpowers/plan.md`

若 `artifacts/superpowers/plan.md` 不存在：
- 立即停止
- 告知用户先运行 `/superpowers-write-plan`
- 不再继续执行

---

## 加载并分析计划
1. 读取 `artifacts/superpowers/plan.md`
2. 解析所有计划步骤
3. 识别步骤间依赖关系：
   - 步骤 2 是否修改步骤 1 创建/修改的文件？
   - 步骤 2 是否需要步骤 1 先通过校验？
   - 它们是否修改相同文件？
4. 将步骤分组为执行批次：
   - **批次 1**：所有独立步骤（无依赖）
   - **批次 2**：依赖批次 1 完成的步骤
   - **批次 3**：依赖批次 2 完成的步骤
   - 以此类推

---

## 执行策略
### 对每个批次：
1. **为批次内所有步骤并行创建子代理**：
   ```bash
   # 示例：批次 1 包含 3 个独立步骤
   python .agent/skills/superpowers-workflow/scripts/spawn_subagent.py \
     --skill tdd \
     --task "步骤 1：为 sync.py 添加指数退避重试逻辑" &

   python .agent/skills/superpowers-workflow/scripts/spawn_subagent.py \
     --skill rest-automation \
     --task "步骤 2：为 fetch_items() 添加分页处理" &

   python .agent/skills/superpowers-workflow/scripts/spawn_subagent.py \
     --skill python-automation \
     --task "步骤 3：更新 CLI 参数以支持 --max-retries 标志" &

   # 等待全部完成
   wait
   ```

2. **收集各子代理结果**：
   - 查看 `artifacts/superpowers/subagents/` 中的日志文件
   - 提取每个步骤的最终结果
   - 检查成功/失败状态

3. **校验批次完成情况**：
   - 对批次内所有步骤运行校验命令
   - 若**任意步骤失败**：
     - 停止执行
     - 对失败步骤切换至 `/superpowers-debug`
     - **不进入**下一批次

4. **追加到执行日志**：
   - 将批次摘要写入 `artifacts/superpowers/execution.md`：
     ```markdown
     ## 批次 N（并行执行）
     - 步骤 X：[成功/失败] - 文件：[...] - 耗时：X 秒
     - 步骤 Y：[成功/失败] - 文件：[...] - 耗时：Y 秒

     校验结果：
     - 步骤 X：[命令] -> [结果]
     - 步骤 Y：[命令] -> [结果]
     ```

5. **进入下一批次**（所有步骤均通过时）

---

## 子代理技能选择
为每个步骤选择合适技能：

| 步骤类型               | 使用技能          |
|------------------------|-------------------|
| 添加测试、TDD 流程     | `tdd`             |
| 修复 Bug、排查失败     | `debug`           |
| 代码评审、质量检查     | `review`          |
| REST API 开发          | `rest-automation` |
| Python 工具/脚本       | `python-automation` |
| 通用功能实现           | `tdd`（默认）|

---

## 汇总阶段
所有批次执行完成后：

1. **集成校验**：
   - 运行完整测试套件（不只是单步骤测试）
   - 校验所有修改能协同工作
   - 检查并行修改间是否存在冲突

2. **冲突解决**：
   - 若并行步骤修改了相关代码：
     - 检查集成问题
     - 运行组合测试
     - 修复所有冲突

3. **最终产物**：
   - 更新 `artifacts/superpowers/execution.md`，包含：
     - 执行总批次
     - 完成总步骤数
     - 相比串行模式节省的总时间
     - 所有校验结果
   - 写入 `artifacts/superpowers/finish.md`，包含：
     - 修改摘要
     - 集成测试结果
     - 后续事项（如有）

---

## 示例：含 2 个批次的 5 步骤计划
**计划：**
1. 为 sync.py 添加重试逻辑（独立）
2. 为 API 客户端添加分页（独立）
3. 更新 CLI 参数（独立）
4. 添加集成测试（依赖 1、2、3）
5. 更新文档（依赖 4 通过）

**执行：**

**批次 1（并行）：**
- 为步骤 1、2、3 创建 3 个子代理
- 等待全部完成（约 5 分钟，串行约 15 分钟）
- 校验每个步骤

**批次 2（串行）：**
- 步骤 4：添加集成测试（需 1+2+3 完成）
- 校验测试通过

**批次 3（串行）：**
- 步骤 5：更新文档（需 4 完成）
- 校验文档准确

**总耗时：约 10 分钟，串行约 25 分钟 → 节省 60% 时间**

---

## 故障排查
### 子代理创建失败
- 检查 `gemini` 是否在环境变量 PATH 中（验证：`gemini --version`）
- 确认技能存在：`.agent/skills/superpowers-{skill}/SKILL.md`
- 查看子代理日志：`artifacts/superpowers/subagents/`

### 步骤冲突
- 冲突步骤自动回退为**串行执行**
- 在计划中明确标记依赖步骤，避免冲突

### 并行执行后校验失败
- 检查集成：并行步骤单独可用但可能存在冲突
- 运行 `/superpowers-debug` 排查
- 考虑改用串行模式重新运行：`/superpowers-execute-plan`

---

## 持久化（强制）
将执行记录写入文件：
- 批次摘要追加到：`artifacts/superpowers/execution.md`
- 最终摘要写入：`artifacts/superpowers/finish.md`

确保 `artifacts/superpowers/` 目录存在。
执行完成后列出 `artifacts/superpowers/` 内容，确认文件已生成。

---

## 结束
所有步骤完成后：
1. 运行 `/superpowers-review`（或内联评审）
2. 生成含耗时节省指标的最终摘要
3. 列出所有修改文件
4. 提供需人工验证的步骤

完成结束流程后停止。