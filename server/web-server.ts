// server/web-server.ts
import http from "http";
import pinoHttp from "pino-http";
import { createRequestListener } from "@react-router/node";
import { rootLogger } from "../shared/logger/index.js";
import { v4 as uuidv4 } from "uuid";

// 1. 动态载入 React Router 构建产物
// @ts-ignore
const build = await import("../build/server/index.js");

// 2. 创建 React Router 请求监听器（build 产物类型在运行时满足 ServerBuild 契约）
// @ts-ignore
const handleRequest = createRequestListener({ build });

// 3. 配置生产环境的 pino-http 中间件
const httpLogger = pinoHttp({
  logger: rootLogger,
  genReqId(req, res) {
    const id = req.headers["x-request-id"] || req.headers["x-shopify-request-id"] || uuidv4();
    if (res) {
      res.setHeader("x-request-id", id as string);
    }
    return id;
  },
  customProps(req) {
    const url = new URL(req.url || "", `http://${req.headers.host || "localhost"}`);
    const shopDomain = url.searchParams.get("shop") || req.headers["x-shopify-shop-domain"] || undefined;
    return {
      request_id: req.id,
      shop_domain: shopDomain,
    };
  },
});

// 4. 创建原生 Node.js HTTP 服务器
const port = Number(process.env.PORT || 3222);
const server = http.createServer((req, res) => {
  // 先应用日志拦截器
  httpLogger(req, res, () => {
    // 委托给 React Router 的请求处理器
    handleRequest(req, res);
  });
});

// 5. 启动监听
server.listen(port, () => {
  rootLogger.info({ port }, "production.web-server.started");
});
