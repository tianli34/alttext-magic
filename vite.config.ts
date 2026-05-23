import { reactRouter } from "@react-router/dev/vite";
import { defineConfig, type UserConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";
import pinoHttp from "pino-http";
import { rootLogger } from "./shared/logger/index.js";
import { v4 as uuidv4 } from "uuid";

if (
  process.env.HOST &&
  (!process.env.SHOPIFY_APP_URL ||
    process.env.SHOPIFY_APP_URL === process.env.HOST)
) {
  process.env.SHOPIFY_APP_URL = process.env.HOST;
  delete process.env.HOST;
}

const host = new URL(process.env.SHOPIFY_APP_URL || "http://localhost")
  .hostname;

let hmrConfig;
if (host === "localhost") {
  hmrConfig = {
    protocol: "ws",
    host: "localhost",
    port: 64999,
    clientPort: 64999,
  };
} else {
  hmrConfig = {
    protocol: "wss",
    host: host,
    port: parseInt(process.env.FRONTEND_PORT!) || 8002,
    clientPort: 443,
  };
}

export default defineConfig({
  server: {
    allowedHosts: [host],
    cors: {
      preflightContinue: true,
    },
    port: Number(process.env.PORT || 3222),
    hmr: hmrConfig,
    fs: {
      allow: ["app", "node_modules",'./shared'],
    },
  },
  plugins: [
    reactRouter(),
    tsconfigPaths(),
    {
      name: "vite-pino-http-logger",
      configureServer(server) {
        const httpLogger = pinoHttp({
          logger: rootLogger,
          genReqId(req, res) {
            const id = req.headers["x-request-id"] || req.headers["x-shopify-request-id"] || uuidv4();
            if (res) {
              res.setHeader("x-request-id", id);
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

        server.middlewares.use((req, res, next) => {
          httpLogger(req, res, next);
        });
      },
    },
  ],
  build: {
    assetsInlineLimit: 0,
  },
  optimizeDeps: {
    include: ["@shopify/app-bridge-react"],
  },
}) satisfies UserConfig;
