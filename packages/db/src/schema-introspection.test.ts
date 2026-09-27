import { afterAll, describe, expect, it } from "vitest";
import { getTableColumns, getTableName, is, sql } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";

import { closeDatabase, createInMemoryDb, type Database } from "./index.js";
import * as schema from "./schema.js";

/**
 * I-043 方案 A parity guard (report §6 recommendation): every temporal column
 * declared in schema.ts must match the physical column produced by
 * migrations.ts — and vice versa.
 *
 * Method: apply the migration chain to an in-memory PGlite database, read
 * `information_schema.columns`, and compare both directions against drizzle's
 * column metadata:
 *   * schema `timestamp({ withTimezone: true, mode: "string" })`
 *     (drizzle columnType "PgTimestampString") => physical
 *     `timestamp with time zone`;
 *   * physical `timestamp with time zone` => schema "PgTimestampString" with
 *     `withTimezone === true` (this is what catches a regression back to
 *     `text()`, or a timezone-less `timestamp()`).
 *
 * The internal `schema_migrations` table is not part of the application
 * schema and is therefore excluded by construction (we only walk tables
 * exported from schema.ts).
 */

type PhysicalColumnRow = {
  table_name: string;
  column_name: string;
  data_type: string;
};

type DrizzleColumnLike = {
  name: string;
  columnType: string;
  withTimezone?: boolean;
};

const SCHEMA_TIME_COLUMN_TYPE = "PgTimestampString";
const PHYSICAL_TIMESTAMPTZ = "timestamp with time zone";

let db: Database | undefined;

afterAll(async () => {
  if (db) await closeDatabase(db);
  db = undefined;
});

/** Deduped (table name -> columns) view of every pgTable exported by schema.ts. */
function schemaTables(): Map<string, DrizzleColumnLike[]> {
  const tables = new Map<string, DrizzleColumnLike[]>();
  for (const value of Object.values(schema)) {
    if (!is(value, PgTable)) continue;
    const tableName = getTableName(value);
    if (tables.has(tableName)) continue; // compatibility aliases share the same table
    tables.set(
      tableName,
      Object.values(getTableColumns(value)) as unknown as DrizzleColumnLike[]
    );
  }
  return tables;
}

async function physicalColumns(database: Database): Promise<Map<string, Map<string, string>>> {
  const result = (await database.execute(
    sql`SELECT table_name, column_name, data_type
        FROM information_schema.columns
        WHERE table_schema = 'public'`
  )) as unknown as { rows: PhysicalColumnRow[] };

  const byTable = new Map<string, Map<string, string>>();
  for (const row of result.rows) {
    const columns = byTable.get(row.table_name) ?? new Map<string, string>();
    columns.set(row.column_name, row.data_type);
    byTable.set(row.table_name, columns);
  }
  return byTable;
}

describe("I-043 schema ∥ migrations temporal parity", () => {
  it("declares every physical timestamptz column as timestamp({ withTimezone: true, mode: 'string' })", async () => {
    db = await createInMemoryDb();
    const physical = await physicalColumns(db);
    const tables = schemaTables();

    let schemaTimeTotal = 0;
    let physicalTimeTotal = 0;

    for (const [tableName, columns] of tables) {
      const physicalTable = physical.get(tableName);
      expect(physicalTable, `table ${tableName} missing from physical schema`).toBeDefined();

      // Direction 1: schema time column => physical timestamptz.
      for (const column of columns) {
        if (column.columnType !== SCHEMA_TIME_COLUMN_TYPE) continue;
        schemaTimeTotal += 1;
        expect(
          column.withTimezone,
          `${tableName}.${column.name} must declare withTimezone: true`
        ).toBe(true);
        expect(
          physicalTable!.get(column.name),
          `${tableName}.${column.name} declared as timestamp in schema.ts but missing/not timestamptz physically`
        ).toBe(PHYSICAL_TIMESTAMPTZ);
      }

      // Direction 2: physical timestamptz => schema time column (catches
      // `text()` or timezone-less declarations).
      for (const [columnName, dataType] of physicalTable!) {
        if (dataType !== PHYSICAL_TIMESTAMPTZ) continue;
        physicalTimeTotal += 1;
        const column = columns.find((candidate) => candidate.name === columnName);
        expect(
          column,
          `${tableName}.${columnName} is timestamptz physically but absent from schema.ts`
        ).toBeDefined();
        expect(
          column!.columnType,
          `${tableName}.${columnName} must be timestamp(..., { withTimezone: true, mode: "string" })`
        ).toBe(SCHEMA_TIME_COLUMN_TYPE);
        expect(
          column!.withTimezone,
          `${tableName}.${columnName} must declare withTimezone: true`
        ).toBe(true);
      }
    }

    // Both directions describe the same set (I-043 baseline: 76 columns / 34 tables).
    expect(schemaTimeTotal).toBeGreaterThan(0);
    expect(schemaTimeTotal).toBe(physicalTimeTotal);
  });
});
