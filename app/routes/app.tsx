import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Outlet, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";

import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopDomain = session.shop;

  const shop = await prisma.shop.findUnique({
    where: { shopDomain },
    select: { id: true },
  });

  return {
    apiKey: process.env.SHOPIFY_API_KEY || "",
    shopId: shop?.id ?? "",
    helpFaqUrl: process.env.HELP_FAQ_URL || null,
    supportEmail: process.env.SUPPORT_EMAIL || null,
    docsUrl: process.env.DOCS_URL || null,
  };
};

export default function App() {
  const { apiKey, shopId, helpFaqUrl, supportEmail, docsUrl } =
    useLoaderData<typeof loader>();

  return (
    <AppProvider embedded apiKey={apiKey}>
      <s-app-nav>
        <s-link href="/app">Dashboard</s-link>
        <s-link href="/app/candidates">Candidates</s-link>
        <s-link href="/app/review">Review</s-link>
        <s-link href="/app/history">History</s-link>
        {shopId === "cmnidr9hh0000bsttv2rx99xq" && (
          <s-link href="/app/ai-stats">AI 调用统计</s-link>
        )}
        <s-link href="/app/billing">Billing</s-link>
        <s-link href="/app/settings">Settings</s-link>
        {helpFaqUrl && (
          <s-link href={helpFaqUrl} target="_blank">
            FAQ
          </s-link>
        )}
        {supportEmail && (
          <s-link href={`mailto:${supportEmail}`} target="_blank">
            联系支持
          </s-link>
        )}
        {docsUrl && (
          <s-link href={docsUrl} target="_blank">
            文档
          </s-link>
        )}
      </s-app-nav>
      <Outlet />
    </AppProvider>
  );
}

// Shopify needs React Router to catch some thrown responses, so that their headers are included in the response.
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
