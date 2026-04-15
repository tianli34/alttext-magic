import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { useState } from "react";
import { Form, useActionData, useLoaderData } from "react-router";
import { login } from "../../shopify.server";
import { loginErrorMessage } from "./error.server";
export const loader = async ({ request }) => {
    const errors = loginErrorMessage(await login(request));
    return { errors };
};
export const action = async ({ request }) => {
    const errors = loginErrorMessage(await login(request));
    return {
        errors,
    };
};
export default function Auth() {
    const loaderData = useLoaderData();
    const actionData = useActionData();
    const [shop, setShop] = useState("");
    const { errors } = actionData || loaderData;
    return (_jsx(AppProvider, { embedded: false, children: _jsx("s-page", { children: _jsx(Form, { method: "post", children: _jsxs("s-section", { heading: "Log in", children: [_jsx("s-text-field", { name: "shop", label: "Shop domain", details: "example.myshopify.com", value: shop, onChange: (e) => setShop(e.currentTarget.value), autocomplete: "on", error: errors.shop }), _jsx("s-button", { type: "submit", children: "Log in" })] }) }) }) }));
}
