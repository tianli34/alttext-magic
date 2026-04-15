import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { Outlet, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { authenticate } from "../shopify.server";
export const loader = async ({ request }) => {
    await authenticate.admin(request);
    // eslint-disable-next-line no-undef
    return { apiKey: process.env.SHOPIFY_API_KEY || "" };
};
export default function App() {
    const { apiKey } = useLoaderData();
    return (_jsxs(AppProvider, { embedded: true, apiKey: apiKey, children: [_jsxs("s-app-nav", { children: [_jsx("s-link", { href: "/app", children: "Dashboard" }), _jsx("s-link", { href: "/app/review", children: "Review" }), _jsx("s-link", { href: "/app/history", children: "History" }), _jsx("s-link", { href: "/app/billing", children: "Billing" }), _jsx("s-link", { href: "/app/settings", children: "Settings" }), _jsx("s-link", { href: "/app/help", children: "Help" })] }), _jsx(Outlet, {})] }));
}
// Shopify needs React Router to catch some thrown responses, so that their headers are included in the response.
export function ErrorBoundary() {
    return boundary.error(useRouteError());
}
export const headers = (headersArgs) => {
    return boundary.headers(headersArgs);
};
