import type { LoaderFunctionArgs } from "react-router";
import prisma from "../db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const shopParam = url.searchParams.get("shop") || process.env.TARGET_SHOP;

  if (!shopParam) {
    return Response.json({ error: "missing shop param" }, { status: 400 });
  }

  const offlineId = `offline_${shopParam}`;

  // 直接从 DB 取 raw session
  const raw = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
    `SELECT id, shop, "isOnline",
            "expires"::text AS expires_txt,
            "refreshTokenExpires"::text AS refresh_expires_txt,
            "refreshToken" IS NOT NULL AS has_refresh_token,
            "accessToken" IS NOT NULL AS has_access_token,
            length("accessToken") AS at_len,
            length("refreshToken") AS rt_len
     FROM "Session"
     WHERE shop = $1`,
    shopParam,
  );

  const sessionRow = raw[0] as Record<string, unknown> | undefined;

  if (!sessionRow) {
    return Response.json({ error: "no session", offline_id: offlineId, shop: shopParam });
  }

  const now = new Date();
  const expiresTxt = sessionRow.expires_txt as string | null;
  const expires = expiresTxt ? new Date(expiresTxt.endsWith("Z") ? expiresTxt : expiresTxt + "Z") : null;

  return Response.json({
    now_utc: now.toISOString(),
    now_local: now.toString(),
    TZ: process.env.TZ,
    offline_id: offlineId,
    session: {
      id: sessionRow.id,
      shop: sessionRow.shop,
      isOnline: sessionRow.isOnline,
      expires_raw: expiresTxt,
      expires_utc: expires?.toISOString(),
      expires_epoch: expires?.getTime(),
      refresh_expires_raw: sessionRow.refresh_expires_txt as string,
      has_access_token: sessionRow.has_access_token,
      has_refresh_token: sessionRow.has_refresh_token,
    },
    analysis: {
      now_epoch: now.getTime(),
      diff_ms: expires ? expires.getTime() - now.getTime() : null,
      isExpired: expires ? expires.getTime() < now.getTime() : null,
      would_trigger_exchange: expires
        ? (!sessionRow.has_access_token || expires.getTime() - 300000 < now.getTime())
        : null,
    },
  });
};
