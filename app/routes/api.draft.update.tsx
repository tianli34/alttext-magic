/**
 * File: app/routes/api.draft.update.tsx
 * Purpose: POST /api/draft/update —— 保存用户对 AI 草稿的手动编辑。
 *
 * 请求体：{ candidateId: string, editedText: string }
 *  - candidateId：候选 ID
 *  - editedText：编辑后文本，长度 ≤ 512，不得纯空白
 *
 * 返回：{ success: true, draft: { id, editedText, updatedAt } }
 */
import type { ActionFunctionArgs } from "react-router";
import { z, ZodError } from "zod";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import {
  updateDraftEditedText,
  DraftUpdateError,
} from "../../server/modules/generation/draft.service";
import { createLogger } from "../../server/utils/logger";

const logger = createLogger({ module: "api.draft.update" });

/** 请求体 schema */
const bodySchema = z.object({
  candidateId: z.string().min(1),
  editedText: z
    .string()
    .min(1, "editedText 不得为空")
    .max(512, "editedText 长度不得超过 512 字符")
    .refine((val) => val.trim().length > 0, {
      message: "editedText 不得纯空白",
    }),
});

/** 将 Zod 错误转换为前端友好格式 */
function issuesFromZod(
  error: ZodError,
): Array<{ path: string; message: string }> {
  return error.issues.map((issue) => ({
    path: issue.path.join("."),
    message: issue.message,
  }));
}

export const action = async ({ request }: ActionFunctionArgs) => {
  // 1. 仅允许 POST
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  // 2. 解析并校验请求体
  let body: z.infer<typeof bodySchema>;
  try {
    body = bodySchema.parse(await request.json());
  } catch (err) {
    if (err instanceof ZodError) {
      return Response.json(
        { error: "Invalid body", issues: issuesFromZod(err) },
        { status: 400 },
      );
    }

    throw err;
  }

  // 3. Session 鉴权
  const { session } = await authenticate.admin(request);
  const shopDomain = session.shop;
  const shop = await prisma.shop.findUnique({
    where: { shopDomain },
    select: { id: true },
  });

  if (!shop) {
    logger.warn({ shopDomain }, "Shop not found for draft update");
    return Response.json({ error: "Shop not found" }, { status: 404 });
  }

  // 4. 调用服务层更新草稿
  try {
    const draft = await updateDraftEditedText(
      shop.id,
      body.candidateId,
      body.editedText,
    );

    return Response.json({
      success: true,
      draft: {
        id: draft.id,
        editedText: draft.editedText,
        updatedAt: draft.updatedAt.toISOString(),
      },
    });
  } catch (err) {
    if (err instanceof DraftUpdateError) {
      return Response.json(
        { error: err.message, code: err.code },
        { status: err.status },
      );
    }

    throw err;
  }
};
