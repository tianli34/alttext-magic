import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Outlet, useLoaderData, useLocation, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";

import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { TimezoneProvider } from "../lib/timezone";
import { buildAppPath } from "../lib/app-navigation";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopDomain = session.shop;

  const shop = await prisma.shop.findUnique({
    where: { shopDomain },
    select: { id: true, timezone: true },
  });

  return {
    apiKey: process.env.SHOPIFY_API_KEY || "",
    shopId: shop?.id ?? "",
    timezone: shop?.timezone ?? "UTC",
    helpFaqUrl: process.env.HELP_FAQ_URL || null,
    supportEmail: process.env.SUPPORT_EMAIL || null,
    docsUrl: process.env.DOCS_URL || null,
  };
};

export default function App() {
  const { apiKey, shopId, timezone, helpFaqUrl, supportEmail, docsUrl } =
    useLoaderData<typeof loader>();
  const location = useLocation();

  return (
    <AppProvider embedded apiKey={apiKey}>
      <s-app-nav>
        <s-link href={buildAppPath("/app", location.search)}>Dashboard</s-link>
        <s-link href={buildAppPath("/app/candidates", location.search)}>Candidates</s-link>
        <s-link href={buildAppPath("/app/review", location.search)}>Review</s-link>
        <s-link href={buildAppPath("/app/history", location.search)}>History</s-link>
        {shopId === "fd6e7082-a067-4cc3-9d76-a081c0a3afb9" && (
          <s-link href={buildAppPath("/app/ai-stats", location.search)}>AI 调用统计</s-link>
        )}
        <s-link href={buildAppPath("/app/billing", location.search)}>Billing</s-link>
        <s-link href={buildAppPath("/app/settings", location.search)}>Settings</s-link>
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
      <TimezoneProvider timezone={timezone}>
        <Outlet />
      </TimezoneProvider>
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
