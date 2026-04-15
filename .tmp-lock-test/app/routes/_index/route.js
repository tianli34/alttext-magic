import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { redirect, Form, useLoaderData } from "react-router";
import { login } from "../../shopify.server";
import styles from "./styles.module.css";
export const loader = async ({ request }) => {
    const url = new URL(request.url);
    if (url.searchParams.get("shop")) {
        throw redirect(`/app?${url.searchParams.toString()}`);
    }
    return { showForm: Boolean(login) };
};
export default function App() {
    const { showForm } = useLoaderData();
    return (_jsx("div", { className: styles.index, children: _jsxs("div", { className: styles.content, children: [_jsx("h1", { className: styles.heading, children: "A short heading about [your app]" }), _jsx("p", { className: styles.text, children: "A tagline about [your app] that describes your value proposition." }), showForm && (_jsxs(Form, { className: styles.form, method: "post", action: "/auth/login", children: [_jsxs("label", { className: styles.label, children: [_jsx("span", { children: "Shop domain" }), _jsx("input", { className: styles.input, type: "text", name: "shop" }), _jsx("span", { children: "e.g: my-shop-domain.myshopify.com" })] }), _jsx("button", { className: styles.button, type: "submit", children: "Log in" })] })), _jsxs("ul", { className: styles.list, children: [_jsxs("li", { children: [_jsx("strong", { children: "Product feature" }), ". Some detail about your feature and its benefit to your customer."] }), _jsxs("li", { children: [_jsx("strong", { children: "Product feature" }), ". Some detail about your feature and its benefit to your customer."] }), _jsxs("li", { children: [_jsx("strong", { children: "Product feature" }), ". Some detail about your feature and its benefit to your customer."] })] })] }) }));
}
