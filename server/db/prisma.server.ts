/**
 * File: server/db/prisma.server.ts
 * Purpose: Provide the shared Prisma client singleton for server-side modules.
 */

import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { Pool } from "pg";

// 挂载到 global 防止热重载重复创建
const globalForPrisma = global as unknown as {
  pool: Pool | undefined;
  prisma: PrismaClient | undefined;
};

const pool =
  globalForPrisma.pool ??
  new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 10,                                 // 限制每个 Pool 最大连接数
    idleTimeoutMillis: 30_000,               // 空闲连接 30s 后释放
    connectionTimeoutMillis: 5_000,          // 获取连接超时 5s（而不是无限等待）
  });

const adapter = new PrismaPg(pool);

const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({ adapter });

// 只在开发模式下缓存，生产模式模块本身就是单例
if (process.env.NODE_ENV !== "production") {
  globalForPrisma.pool = pool;
  globalForPrisma.prisma = prisma;
}

export default prisma;

