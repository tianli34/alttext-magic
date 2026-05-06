/**
 * File: app/entry.client.tsx
 * Purpose: React Router Framework 模式客户端 hydration 入口。
 *          没有该入口时，页面只会完成 SSR，所有依赖 React 状态的交互都会失效。
 */
import { startTransition, StrictMode } from "react";
import { hydrateRoot } from "react-dom/client";
import { HydratedRouter } from "react-router/dom";

startTransition(() => {
  hydrateRoot(
    document,
    <StrictMode>
      <HydratedRouter />
    </StrictMode>,
  );
});
