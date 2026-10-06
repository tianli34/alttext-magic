/**
 * File: tests/e2e/helpers/generation-flow.ts
 * Purpose: 「候选列表 → 生成 → 自动写回」真实 UI 流程的公共驱动。
 *
 *          只勾选少量候选（默认 2 张）以控制单次运行的额度消耗与 AI 时长；
 *          生成完成后等待服务端自动写回批次关联落盘（onGenerationCompleted
 *          写入 sessionStorage 持久化），供两个场景分别接续：
 *          场景 1 篡改持久化后刷新页面走恢复路径；场景 2 屏蔽 SSE 走轮询兜底。
 */
import type { Frame } from "@playwright/test";

/** 与 app/hooks/useGenerationFlow.ts 的 ACTIVE_GENERATION_KEY 保持一致 */
const ACTIVE_GENERATION_KEY = "alttext.activeGenerationBatch";

/** 持久化结构（与 PersistedGeneration 对齐的最小字段集） */
export interface PersistedGenerationShape {
  batchId: string;
  totalCount: number;
  writebackBatchId?: string | null;
  generationTally?: {
    total: number;
    succeeded: number;
    skipped: number;
    failed: number;
  } | null;
}

/**
 * 走真实 UI 启动一次「生成 + 自动写回」，直到写回批次关联落盘（生成终态已到达）。
 * 前置失败（无候选/额度不足）以明确的中文错误抛出，不留给选择器超时。
 */
export async function startGenerationWithAutoWriteback(
  frame: Frame,
  options?: { pickCount?: number; generationTimeoutMs?: number },
): Promise<void> {
  const pickCount = options?.pickCount ?? 2;
  const generationTimeoutMs = options?.generationTimeoutMs ?? 10 * 60_000;

  // 前置检查：存在可生成候选（原生 checkbox，禁用态已由 :not([disabled]) 过滤）
  const checkboxes = frame.locator('input[type="checkbox"]:not([disabled])');
  await checkboxes.first().waitFor({ state: "attached", timeout: 30_000 }).catch(() => null);
  const candidateCount = await checkboxes.count();
  if (candidateCount === 0) {
    throw new Error(
      "候选列表没有可生成的候选：请先在应用内执行一次扫描，确保开发店存在待生成图片",
    );
  }

  // 只勾选前 N 张，控制额度消耗与时长
  for (let index = 0; index < Math.min(pickCount, candidateCount); index += 1) {
    await checkboxes.nth(index).check();
  }

  // 发起生成（工具栏按钮文案带选中数，用前缀匹配）
  await frame.getByText(/Generate Alt Text/).click();

  // 确认弹窗：等预检返回后点确认。余额不足时 Generate 不渲染，此处会超时——
  // 属于前置条件问题（额度不足），报错信息里说明清楚
  await frame.getByText("确认生成 Alt Text").waitFor({ state: "visible" });
  try {
    await frame.getByText("Generate", { exact: true }).click({ timeout: 30_000 });
  } catch {
    throw new Error(
      "确认弹窗中未出现 Generate 按钮：大概率是预检判定额度不足。" +
        "请先在应用内补充额度（Upgrade Plan / Buy Extra Pack）后重试",
    );
  }

  // 生成进度浮层出现（STARTING → GENERATING）
  await frame.getByText("正在生成 Alt Text…").waitFor({ state: "visible" });

  // 等待生成完成且自动写回批次已关联（终态回调把 writebackBatchId 写入持久化）
  await frame.waitForFunction(
    ([key]) => {
      const raw = window.sessionStorage.getItem(key);
      if (!raw) return false;
      try {
        return Boolean(
          (JSON.parse(raw) as { writebackBatchId?: string | null }).writebackBatchId,
        );
      } catch {
        return false;
      }
    },
    [ACTIVE_GENERATION_KEY] as [string],
    { timeout: generationTimeoutMs, polling: 500 },
  );
}

/** 读取持久化的进行中批次（供断言与篡改前快照使用） */
export async function readPersistedGeneration(
  frame: Frame,
): Promise<PersistedGenerationShape | null> {
  const raw = await frame.evaluate(
    (key) => window.sessionStorage.getItem(key),
    ACTIVE_GENERATION_KEY,
  );
  if (!raw) return null;
  return JSON.parse(raw) as PersistedGenerationShape;
}

/**
 * 篡改持久化：抹去生成计数（generationTally 置 null），模拟「未持久化 tally 的
 * 旧会话或降级」。现行实现在生成完成时会把计数一并持久化，正常刷新根本不触发
 * 回填循环；只有这种降级会话才会走 useGenerationFlow 的异步回填分支，
 * 从而把回填重试循环本身置于测试之下。
 */
export async function stripPersistedGenerationTally(frame: Frame): Promise<void> {
  await frame.evaluate((key) => {
    const raw = window.sessionStorage.getItem(key);
    if (!raw) return;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    parsed.generationTally = null;
    window.sessionStorage.setItem(key, JSON.stringify(parsed));
  }, ACTIVE_GENERATION_KEY);
}
