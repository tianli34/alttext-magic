/**
 * File: app/routes/api.dev.clear-alt.start.tsx
 * Purpose: [TEMP-DEVTOOLS] POST /api/dev/clear-alt/start —— Dashboard 临时按钮入口，
 *          以后台任务方式启动「清空当前店铺全部产品图片 alt」（等价 npm run clear:alt）。
 *
 *          仅非生产环境可用：NODE_ENV === "production" 且未显式 ENABLE_DEV_TOOLS=1 时返回 404。
 *          只作用于当前登录店铺（session.shop），不接受任意 shop 参数，避免误伤其他店铺。
 *
 * 请求体: { apply?: boolean }  缺省 false = dry-run 预览; true = 实际清空
 * 响应体: { job: ClearAltJobSnapshot }
 */
import type { ActionFunctionArgs } from "react-router";
import { z, ZodError } from "zod";
import { authenticate } from "../shopify.server";
import { getOfflineAccessTokenByDomain } from "../../server/shopify/offline-admin.server";
import {
  isDevToolsEnabled,
  startClearAltJob,
} from "../../server/modules/devtools/clear-media-alt-job.server";
import { createLogger } from "../../server/utils/logger";

const logger = createLogger({ module: "api.dev.clear-alt.start" });

/** 请求体 schema：apply 缺省 false（dry-run 更安全） */
const bodySchema = z.object({ apply: z.boolean().default(false) });

/** 官方 offline admin 链路获取 token（自带临期刷新，避免与脚本式手工刷新冲突） */
async function resolveAccessTokenByDomain(shopDomain: string): Promise<string> {
  return getOfflineAccessTokenByDomain(shopDomain);
}

export const loader = () =>
  Response.json({ error: "Method not allowed. Use POST." }, { status: 405 });

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  // 临时工具：生产环境直接视为不存在
  if (!isDevToolsEnabled()) {
    return Response.json(
      { error: "Not found (dev-only tool)" },
      { status: 404 },
    );
  }

  const { session } = await authenticate.admin(request);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  let parsed: z.infer<typeof bodySchema>;
  try {
    parsed = bodySchema.parse(body);
  } catch (err) {
    if (err instanceof ZodError) {
      const issues = err.issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
      }));
      return Response.json(
        { error: "Invalid request body", issues },
        { status: 400 },
      );
    }
    return Response.json({ error: "Invalid request body" }, { status: 400 });
  }

  logger.warn(
    { shopDomain: session.shop, apply: parsed.apply },
    "[TEMP-DEVTOOLS] clear-alt job requested from Dashboard",
  );

  const { started, job } = startClearAltJob({
    shopDomain: session.shop,
    apply: parsed.apply,
    resolveAccessToken: resolveAccessTokenByDomain,
  });

  if (!started) {
    return Response.json(
      { error: "该店铺已有清空任务正在执行中", job },
      { status: 409 },
    );
  }

  return Response.json({ job });
};
