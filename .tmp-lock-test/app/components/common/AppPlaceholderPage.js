import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
export function AppPlaceholderPage({ title, description, }) {
    return (_jsx("s-page", { heading: title, children: _jsx("s-section", { heading: title, children: _jsx("s-box", { padding: "base", borderWidth: "base", borderRadius: "base", background: "subdued", children: _jsxs("s-stack", { direction: "block", gap: "small", children: [_jsx("s-heading", { children: title }), _jsx("s-paragraph", { children: description })] }) }) }) }));
}
