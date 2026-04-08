/**
 * Validates that the core Prisma tables and key unique indexes exist in PostgreSQL.
 * Intended to run after `prisma migrate dev` / `prisma migrate deploy`.
 */
import "dotenv/config";
import pino from "pino";
import { Client } from "pg";
import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
});

const logger = pino({
  name: "validate-database-schema",
});

const schemaName = "public";

const requiredTables = [
  "alt_target",
  "alt_candidate",
  "candidate_group_projection",
  "credit_bucket",
  "shop_operation_lock",
] as const;

type RequiredIndex = {
  tableName: (typeof requiredTables)[number];
  columns: readonly string[];
  mustBeUnique: boolean;
  allowPrimaryKey: boolean;
};

const requiredIndexes: readonly RequiredIndex[] = [
  {
    tableName: "alt_target",
    columns: ["shop_id", "alt_plane", "write_target_id", "locale"],
    mustBeUnique: true,
    allowPrimaryKey: false,
  },
  {
    tableName: "alt_candidate",
    columns: ["alt_target_id"],
    mustBeUnique: true,
    allowPrimaryKey: false,
  },
  {
    tableName: "candidate_group_projection",
    columns: ["shop_id", "group_type", "alt_candidate_id"],
    mustBeUnique: true,
    allowPrimaryKey: false,
  },
  {
    tableName: "credit_bucket",
    columns: ["shop_id", "bucket_type", "cycle_key"],
    mustBeUnique: true,
    allowPrimaryKey: false,
  },
  {
    tableName: "shop_operation_lock",
    columns: ["shop_id"],
    mustBeUnique: true,
    allowPrimaryKey: true,
  },
] as const;

type TableRow = {
  tablename: string;
};

type IndexRow = {
  table_name: string;
  index_name: string;
  is_unique: boolean;
  is_primary: boolean;
  column_names: string | string[];
};

const sameColumns = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index]);

const normalizeColumnNames = (columnNames: string | string[]): string[] => {
  if (Array.isArray(columnNames)) {
    return columnNames;
  }

  return columnNames
    .replace(/^\{/, "")
    .replace(/\}$/, "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
};

async function main(): Promise<void> {
  const env = envSchema.parse(process.env);
  const client = new Client({
    connectionString: env.DATABASE_URL,
  });

  await client.connect();

  try {
    const tableResult = await client.query<TableRow>(
      `
        SELECT tablename
        FROM pg_tables
        WHERE schemaname = $1
          AND tablename = ANY($2::text[])
      `,
      [schemaName, [...requiredTables]],
    );

    const existingTables = new Set(tableResult.rows.map((row) => row.tablename));
    const missingTables = requiredTables.filter((tableName) => !existingTables.has(tableName));

    if (missingTables.length > 0) {
      throw new Error(`Missing tables: ${missingTables.join(", ")}`);
    }

    const indexResult = await client.query<IndexRow>(
      `
        SELECT
          table_info.table_name,
          table_info.index_name,
          table_info.is_unique,
          table_info.is_primary,
          COALESCE(table_info.column_names, ARRAY[]::text[]) AS column_names
        FROM (
          SELECT
            table_class.relname AS table_name,
            index_class.relname AS index_name,
            index_meta.indisunique AS is_unique,
            index_meta.indisprimary AS is_primary,
            array_agg(attribute.attname ORDER BY key_column.ordinality) AS column_names
          FROM pg_class AS table_class
          INNER JOIN pg_namespace AS namespace
            ON namespace.oid = table_class.relnamespace
          INNER JOIN pg_index AS index_meta
            ON index_meta.indrelid = table_class.oid
          INNER JOIN pg_class AS index_class
            ON index_class.oid = index_meta.indexrelid
          INNER JOIN LATERAL unnest(index_meta.indkey) WITH ORDINALITY AS key_column(attnum, ordinality)
            ON TRUE
          INNER JOIN pg_attribute AS attribute
            ON attribute.attrelid = table_class.oid
           AND attribute.attnum = key_column.attnum
          WHERE namespace.nspname = $1
            AND table_class.relname = ANY($2::text[])
          GROUP BY
            table_class.relname,
            index_class.relname,
            index_meta.indisunique,
            index_meta.indisprimary
        ) AS table_info
      `,
      [schemaName, [...requiredTables]],
    );

    const missingIndexes = requiredIndexes.filter((requiredIndex) => {
      return !indexResult.rows.some((indexRow) => {
        const uniqueMatch = requiredIndex.mustBeUnique ? indexRow.is_unique : true;
        const primaryMatch = requiredIndex.allowPrimaryKey ? true : !indexRow.is_primary;

        return (
          indexRow.table_name === requiredIndex.tableName &&
          uniqueMatch &&
          primaryMatch &&
          sameColumns(normalizeColumnNames(indexRow.column_names), requiredIndex.columns)
        );
      });
    });

    if (missingIndexes.length > 0) {
      throw new Error(
        `Missing indexes: ${missingIndexes
          .map((index) => `${index.tableName}(${index.columns.join(", ")})`)
          .join("; ")}`,
      );
    }

    logger.info(
      {
        schemaName,
        tables: [...requiredTables],
        indexes: requiredIndexes.map((index) => ({
          tableName: index.tableName,
          columns: index.columns,
        })),
      },
      "database schema validation passed",
    );
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  logger.error({ err: error }, "database schema validation failed");
  process.exitCode = 1;
});
