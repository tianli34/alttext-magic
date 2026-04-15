/**
 * File: app/db.server.ts
 * Purpose: Preserve the existing app-level Prisma import path while delegating
 * to the shared server Prisma singleton.
 */
export { default } from "../server/db/prisma.server";
