import { z } from "zod";
import dotenv from "dotenv";

// 在最早期加载 .env
dotenv.config();

/**
 * 日志级别枚举 —— 与 pino 保持一致
 */
const LogLevel = z.enum([
  "fatal",
  "error",
  "warn",
  "info",
  "debug",
  "trace",
  "silent",
]);

/**
 * 服务端环境变量 Schema
 * ─────────────────────
 * 每个字段都附带：类型校验 + 格式校验 + 语义化错误消息
 */
const envSchema = z.object({
  // ── Shopify ──────────────────────────────────────────────
  SHOPIFY_API_KEY: z
    .string({
      message: "SHOPIFY_API_KEY is required",
    })
    .min(1, "SHOPIFY_API_KEY must not be empty")
    .regex(/^[a-f0-9]{32}$/, "SHOPIFY_API_KEY must be a 32-char hex string"),

  SHOPIFY_API_SECRET: z
    .string({
      message: "SHOPIFY_API_SECRET is required",
    })
    .min(1, "SHOPIFY_API_SECRET must not be empty"),

  SHOPIFY_APP_URL: z
    .string({
      message: "SHOPIFY_APP_URL is required",
    })
    .url("SHOPIFY_APP_URL must be a valid URL")
    .refine(
      (url) => url.startsWith("https://"),
      "SHOPIFY_APP_URL must use HTTPS"
    ),

  // ── Database ─────────────────────────────────────────────
  DATABASE_URL: z
    .string({
      message: "DATABASE_URL is required",
    })
    .min(1, "DATABASE_URL must not be empty")
    .refine(
      (url) =>
        url.startsWith("postgresql://") || url.startsWith("postgres://"),
      "DATABASE_URL must be a valid PostgreSQL connection string"
    ),

  // ── Redis ────────────────────────────────────────────────
  REDIS_URL: z
    .string({
      message: "REDIS_URL is required",
    })
    .min(1, "REDIS_URL must not be empty"),

  // ── Security ─────────────────────────────────────────────
  TOKEN_ENCRYPTION_KEY: z
    .string({
      message: "TOKEN_ENCRYPTION_KEY is required",
    })
    .min(32, "TOKEN_ENCRYPTION_KEY must be at least 32 characters")
    .regex(
      /^[a-f0-9]+$/i,
      "TOKEN_ENCRYPTION_KEY must be a hex-encoded string"
    ),

  // ── Logging ──────────────────────────────────────────────
  LOG_LEVEL: LogLevel.default("info"),
});

/**
 * 导出推断类型，供其他模块使用
 */
export type Env = z.infer<typeof envSchema>;

/**
 * 解析 & 校验
 * ────────────
 * 使用 safeParse 以便在失败时给出友好的错误摘要，而不是直接抛异常栈
 */
function validateEnv(): Env {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    const formatted = result.error.issues
      .map((issue) => {
        const path = issue.path.join(".") || "(root)";
        return `  ✖ ${path}: ${issue.message}`;
      })
      .join("\n");

    console.error(
      "\n╔══════════════════════════════════════════════╗"
    );
    console.error(
      "║   ❌  Environment variable validation failed  ║"
    );
    console.error(
      "╚══════════════════════════════════════════════╝\n"
    );
    console.error(formatted);
    console.error(
      "\nPlease check your .env file or environment variables.\n"
    );

    process.exit(1);
  }

  return result.data;
}

/**
 * 全局单例 —— 应用启动时立即校验，失败即退出
 */
export const env: Env = validateEnv();