/**
 * File: app/routes/api.dev.clear-alt.status.tsx
 * Purpose: [TEMP-DEVTOOLS] GET /api/dev/clear-alt/status —— 轮询当前店铺最近一次
 *          「清空产品图片 alt」后台任务的状态与日志（含增量日志）。
 *
 *          仅非生产环境可用（与 start 路由同一开关）。
 *
 * 响应体: { job: ClearAltJobSnapshot | null }
 */
import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import {
  getClearAltJob,
  isDevToolsEnabled,
} from "../../server/modules/devtools/clear-media-alt-job.server";

export const action = () =>
  Response.json({ error: "Method not allowed. Use GET." }, { status: 405 });

export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (!isDevToolsEnabled()) {
    return Response.json(
      { error: "Not found (dev-only tool)" },
      { status: 404 },
    );
  }

  const { session } = await authenticate.admin(request);

  // 支持 ?after=<已看到的日志绝对索引> 只回传增量，减少轮询体积；
  // 切片与 offset 计算收在 job 模块内，路由保持极简
  const afterParam = new URL(request.url).searchParams.get("after");
  const afterIndex =
    afterParam === null ? Number.NaN : Number.parseInt(afterParam, 10);
  const after =
    Number.isInteger(afterIndex) && afterIndex >= 0 ? afterIndex : undefined;

  const job = getClearAltJob(session.shop, after);
  if (!job) {
    return Response.json({ job: null });
  }

  return Response.json({ job });
};
