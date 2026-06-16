import { PrismaClient } from "@prisma/client";

const p = new PrismaClient();

const sessions = await p.session.findMany({
  where: { shop: "magic-ai-test-01.myshopify.com" },
  select: { id: true, isOnline: true, expires: true, accessToken: true },
});
console.log("Sessions:", JSON.stringify(sessions, null, 2));

const shop = await p.shop.findUnique({
  where: { shopDomain: "magic-ai-test-01.myshopify.com" },
  select: { id: true, shopDomain: true, timezone: true, uninstalledAt: true },
});
console.log("Shop:", JSON.stringify(shop, null, 2));

await p.$disconnect();
