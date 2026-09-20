Shopify 应用的按月订阅计费，从开发者角度目前有**两条路线**，先选路线再写代码：

## 一、先做选择：Shopify App Pricing（托管计费）还是 Billing API

**路线 A：Shopify App Pricing（原 Managed Pricing，推荐）**

对于新的公开应用，只要支持其定价模型，Shopify App Pricing 就是默认的收费方式。你直接在应用提交表单中定义订阅计划，无需使用 Billing API。 对于已有应用，如果定价模型受支持，也推荐走 Shopify App Pricing；对大多数开发者来说，它比用 Billing API 自己写计费逻辑更简单、更一致。它支持：周期性收费——按免费、月付、年付或月付享年付折扣等计划定期向商家收费。注意：一旦选择了 Shopify App Pricing，就不能再通过 Billing API 创建新的周期性收费。

**路线 B：Billing API（手动计费）**

适合以下情况：一次性购买和不受支持的定价模型：使用 Billing API 的 Manual Pricing。Shopify App Pricing 不支持一次性应用购买。 已有的 Billing API 集成如果不迁移，Manual Pricing 仍然受支持，不需要迁移就能让现有的 billing.request 或 appSubscriptionCreate 集成继续运行。

另外要注意 API 版本问题：REST Admin API 自 2024 年 10 月 1 日起已是遗留 API。从 2025 年 4 月 1 日起，所有新的公开应用必须完全使用 GraphQL Admin API 构建。</parameter>所以旧的 `RecurringApplicationCharge` REST 资源不要再用，用 GraphQL 的 `AppSubscription`。

---

## 二、路线 A：Shopify App Pricing 的开发工作量（很少）

1. **Partner Dashboard 配置计划**：在应用的 Distribution → App Store listing → Pricing 里定义 Free / Basic / Pro 等月付计划、试用天数。
2. **代码里只需做两件事**：
   - **检查订阅状态**：查询店铺的当前订阅（Active Subscription API）。
   - **没订阅就跳转到 Shopify 托管的选套餐页面**。跳转地址形如 `https://admin.shopify.com/store/{storeHandle}/charges/{appHandle}/pricing_plans`，且<cite index="3-1">重定向时需要 target: "_top"（因为应用运行在 iframe 中）。SHOPIFY_APP_GID 是形如 gid://shopify/App/{app_id} 的应用 GID，其中 app_id 是 Partner Dashboard URL 中的数字 ID；activeSubscription 需要店铺的 GID。

示例（Remix / React Router 模板）：

```ts
// app/billing.server.ts
export async function requireActivePlan(admin, session) {
  const res = await admin.graphql(`
    query {
      currentAppInstallation {
        activeSubscriptions { id name status test currentPeriodEnd }
      }
    }`);
  const { data } = await res.json();
  const subs = data.currentAppInstallation.activeSubscriptions;

  if (subs.length === 0) {
    const storeHandle = session.shop.replace(".myshopify.com", "");
    throw redirect(
      `https://admin.shopify.com/store/${storeHandle}/charges/${process.env.APP_HANDLE}/pricing_plans`,
      { target: "_top" }
    );
  }
  return subs[0];
}
```

3. **监听 webhook** `app_subscriptions/update`，把 `status`（ACTIVE / CANCELLED / FROZEN / EXPIRED）同步到你自己的数据库，用于功能开关。

4. **迁移注意**：启用 Shopify App Pricing 后，Active Subscription API 只返回 Shopify App Pricing 的合约。对于已有的 Billing API 订阅和购买，要继续在 GraphQL Admin API 中查询 currentAppInstallation。如果 Active Subscription API 返回 null，在 currentAppInstallation 也确认没有订阅之前，不要把用户当作未付费。

---

## 三、路线 B：Billing API 自建按月订阅

核心流程：**创建订阅 → 商家在 Shopify 确认页批准 → 回跳 returnUrl → 查询/webhook 确认状态 → 开放功能**。

### 1. 创建订阅（GraphQL `appSubscriptionCreate`）

```graphql
mutation CreateSub($name: String!, $lineItems: [AppSubscriptionLineItemInput!]!,
                   $returnUrl: URL!, $trialDays: Int, $test: Boolean) {
  appSubscriptionCreate(
    name: $name
    lineItems: $lineItems
    returnUrl: $returnUrl
    trialDays: $trialDays
    test: $test
  ) {
    confirmationUrl
    appSubscription { id status }
    userErrors { field message }
  }
}
```

变量：

```json
{
  "name": "Pro Monthly",
  "returnUrl": "https://your-app.com/billing/callback?shop=xxx.myshopify.com",
  "trialDays": 7,
  "test": true,
  "lineItems": [{
    "plan": {
      "appRecurringPricingDetails": {
        "price": { "amount": 19.99, "currencyCode": "USD" },
        "interval": "EVERY_30_DAYS"
      }
    }
  }]
}
```

要点：
- `interval` 用 `EVERY_30_DAYS`（Shopify 的"月付"实际是 30 天周期）；年付用 `ANNUAL`。
- 拿到 `confirmationUrl` 后把商家重定向到该页面（同样需要 `_top` 跳出 iframe），商家点击"批准"后 Shopify 会跳回 `returnUrl`，并带上 `charge_id`。
- 一个店铺同一时间只能有一个活跃的 `AppSubscription`，创建新的会替换旧的（可配合 `replacementBehavior` 控制升降级行为）。

### 2. 用 Shopify 官方 SDK 简化（`@shopify/shopify-app-remix` / `shopify-app-js`）

在 `shopify.server.ts` 中声明计划：

```ts
export const MONTHLY_PLAN = "Pro Monthly";

const shopify = shopifyApp({
  // ...
  billing: {
    [MONTHLY_PLAN]: {
      amount: 19.99,
      currencyCode: "USD",
      interval: BillingInterval.Every30Days,
      trialDays: 7,
    },
  },
});
```

在需要付费的路由里：

```ts
export const loader = async ({ request }) => {
  const { billing } = await authenticate.admin(request);
  await billing.require({
    plans: [MONTHLY_PLAN],
    isTest: process.env.NODE_ENV !== "production",
    onFailure: async () =>
      billing.request({ plan: MONTHLY_PLAN, isTest: process.env.NODE_ENV !== "production" }),
  });
  // 到这里说明已有有效订阅
  return null;
};
```

SDK 还提供 `billing.check()`（只查不跳转）、`billing.cancel({ subscriptionId, prorate })` 用于取消/降级。

### 3. 校验与状态同步

- **回跳后查询**：在 `returnUrl` 的处理路由中，用 `currentAppInstallation { activeSubscriptions {...} }` 确认 `status == ACTIVE`，再在你的数据库中记录 `shop → plan, subscriptionId, currentPeriodEnd`。
- **Webhook**：订阅 `APP_SUBSCRIPTIONS_UPDATE`，处理 ACTIVE / CANCELLED / FROZEN（商家店铺欠费冻结）/ DECLINED / EXPIRED；应用被卸载时 `APP_UNINSTALLED` 会自动取消订阅，你也要清理本地状态。
- **不要只信本地数据库**：关键功能入口处定期（或每次请求）用 `billing.check`/GraphQL 复核，避免商家取消后仍能使用。

### 4. 测试

- 开发店铺上用 `test: true`/`isTest: true`，这样会走完整流程但不会真扣款。一个常见坑是 `require` 和 `request` 两处都要设置 isTest：需要在 billing request 中也设置 isTest: false（反之亦然），否则会出现"You will not be billed for this test charge"或真实扣费的意外情况。
- 提交审核前一定要在正式模式（`isTest: false`）下跑一次，审核团队会检查真实计费流程。

---

## 四、常见设计要点（两条路线通用）

| 事项 | 建议 |
|---|---|
| 多套餐 | 用一个 `plans` 表 + 店铺当前 `plan` 字段，功能限制（如订单数/店铺数）以 plan 为准 |
| 升降级 | Billing API：创建新订阅即替换旧订阅（可按比例结算）；App Pricing：Shopify 页面自动处理 |
| 免费试用 | `trialDays` 或在 Partner Dashboard 设置；试用期结束后 Shopify 自动开始扣费 |
| 商家欠费 | 状态变为 FROZEN，不应删除数据，只需限制功能，恢复后自动 ACTIVE |
| 收入结算 | Shopify 通过 Partner 账户按月付款给你，分成规则见 Partner 协议，你的应用不需要处理支付网关 |
| 用量计费 | 需要"月费 + 超量"时，Billing API 用 `appUsagePricingDetails` 行项 + `appUsageRecordCreate`；App Pricing 也支持按实际用量的固定、阶梯等用量计费（通过 App Events API 上报事件） |

**结论**：如果是新应用且只是标准的月付/年付套餐，直接用 **Shopify App Pricing**，代码只需"查订阅 + 跳转选套餐页 + 处理 webhook"三步；只有一次性收费、复杂自定义定价或已有旧集成时，才用 **Billing API 的 `appSubscriptionCreate`** 自己实现。