import { z } from "zod";
import dotenv from "dotenv";

// 在最早期加载 .env
dotenv.config();

// 读取 TZ 并立即设置 Node.js 运行时时区
// 必须在任何 Date 操作之前生效
const rawTz = process.env.TZ || "Asia/Shanghai";
process.env.TZ = rawTz;

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
  LOG_FORMAT: z.enum(["json", "pretty"]).default("pretty"),

  // ── Billing Adapter ─────────────────────────────────────
  BILLING_ADAPTER: z
    .enum(["shopify", "fake"])
    .default("fake"),

  // ── AI Provider ─────────────────────────────────────────
  // fake: 本地/测试用 FakeAIProvider；real: 使用真实主/副模型
  AI_PROVIDER: z.enum(["fake", "real"]).default("fake"),

  // 主模型配置
  AI_PRIMARY_PROVIDER: z.string().min(1).default("openai"),
  AI_PRIMARY_MODEL: z.string().min(1).default("gpt-4o"),
  AI_PRIMARY_API_KEY: z.string().default(""),
  AI_PRIMARY_ENDPOINT: z.string().url().optional(),

  // 副模型配置（fallback）
  AI_2nd_PROVIDER: z.string().min(1).default("openai"),
  AI_2nd_MODEL: z.string().min(1).default("gpt-4o-mini"),
  AI_2nd_API_KEY: z.string().default(""),
  AI_2nd_ENDPOINT: z.string().url().optional(),

  // 第 3 候补模型
  AI_3rd_PROVIDER: z.string().min(1).default("openai"),
  AI_3rd_MODEL: z.string().min(1).default("gpt-4o-mini"),
  AI_3rd_API_KEY: z.string().default(""),
  AI_3rd_ENDPOINT: z.string().url().optional(),

  // 第 4 候补模型
  AI_4th_PROVIDER: z.string().min(1).default("openai"),
  AI_4th_MODEL: z.string().min(1).default("gpt-4o-mini"),
  AI_4th_API_KEY: z.string().default(""),
  AI_4th_ENDPOINT: z.string().url().optional(),

  // 第 5 候补模型
  AI_5th_PROVIDER: z.string().min(1).default("openai"),
  AI_5th_MODEL: z.string().min(1).default("gpt-4o-mini"),
  AI_5th_API_KEY: z.string().default(""),
  AI_5th_ENDPOINT: z.string().url().optional(),

  // 第 6 候补模型
  AI_6th_PROVIDER: z.string().min(1).default("openai"),
  AI_6th_MODEL: z.string().min(1).default("gpt-4o-mini"),
  AI_6th_API_KEY: z.string().default(""),
  AI_6th_ENDPOINT: z.string().url().optional(),

  // 第 7 候补模型
  AI_7th_PROVIDER: z.string().min(1).default("openai"),
  AI_7th_MODEL: z.string().min(1).default("gpt-4o-mini"),
  AI_7th_API_KEY: z.string().default(""),
  AI_7th_ENDPOINT: z.string().url().optional(),

  // 第 8 候补模型
  AI_8th_PROVIDER: z.string().min(1).default("openai"),
  AI_8th_MODEL: z.string().min(1).default("gpt-4o-mini"),
  AI_8th_API_KEY: z.string().default(""),
  AI_8th_ENDPOINT: z.string().url().optional(),

  // ── Timezone ───────────────────────────────────────────
  // 项目级时区（默认北京时间），影响 Node.js Date 序列化与 pino 日志时间戳
  TZ: z.string().default("Asia/Shanghai"),

  // ── Generation Worker ───────────────────────────────────
  GENERATE_ALT_CONCURRENCY: z.coerce
    .number()
    .int()
    .positive()
    .max(50)
    .default(5),

  // ── 写回 Worker ─────────────────────────────────────────
  WRITEBACK_CONCURRENCY: z.coerce
    .number()
    .int()
    .positive()
    .max(5)
    .default(3),

  // ── Settings / Help Links ──────────────────────────────
  SETTINGS_HELP_FAQ_URL: z.string().url().optional(),
  SETTINGS_HELP_CONTACT_URL: z.string().url().optional(),
  SETTINGS_HELP_DOCS_URL: z.string().url().optional(),

  // ── Navigation Help Links ─────────────────────────────
  HELP_FAQ_URL: z.string().url().optional(),
  SUPPORT_EMAIL: z.string().email().optional(),
  DOCS_URL: z.string().url().optional(),
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
