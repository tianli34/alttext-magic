"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * File: server/db/prisma.server.ts
 * Purpose: Provide the shared Prisma client singleton for server-side modules.
 */
const adapter_pg_1 = require("@prisma/adapter-pg");
const client_1 = require("@prisma/client");
const pg_1 = require("pg");
const pool = new pg_1.Pool({
    connectionString: process.env.DATABASE_URL,
});
const adapter = new adapter_pg_1.PrismaPg(pool);
const prisma = new client_1.PrismaClient({
    adapter,
});
exports.default = prisma;
