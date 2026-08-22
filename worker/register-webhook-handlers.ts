/**
 * File: worker/register-webhook-handlers.ts
 * Purpose: worker 启动时把各业务模块的 webhook topic 处理器注册进注册表。
 * webhook 模块自身不 import 业务模块（依赖反转），绑定关系统一收敛在此处。
 */
import { registerWebhookTopicHandler } from "../server/modules/webhook/webhook-topic-registry.js";
import { handleBulkOperationsFinishWebhook } from "../server/modules/scan/catalog/bulk-finish.service.js";
import { syncSubscriptionFromShopify } from "../server/modules/billing/subscription.service.js";
import { handleProductDeletedWebhook } from "../server/modules/scan/continuous/product-delete.service.js";

/** 注册当前已接入的全部 topic 处理器（重复注册时覆盖，幂等）。 */
export function registerWebhookTopicHandlers(): void {
  // BULK_OPERATIONS_FINISH: Shopify Bulk 查询完成 → 解析结果入列 + 补位提交
  registerWebhookTopicHandler(
    "BULK_OPERATIONS_FINISH",
    handleBulkOperationsFinishWebhook,
  );

  // APP_SUBSCRIPTIONS_UPDATE: 订阅状态变化 → 调用统一订阅同步服务
  registerWebhookTopicHandler("APP_SUBSCRIPTIONS_UPDATE", async (input) => {
    await syncSubscriptionFromShopify(input.shopDomain);
  });

  // PRODUCTS_DELETE: 商品删除 → 已发布层空收敛 (usages / targets / candidates → NOT_FOUND)
  registerWebhookTopicHandler("PRODUCTS_DELETE", handleProductDeletedWebhook);
}
