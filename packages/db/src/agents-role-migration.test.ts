import { afterAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";

import {
  agents,
  closeDatabase,
  createInMemoryDb,
  MIGRATIONS,
  rollbackMigration,
  runMigrations,
  type Database
} from "./index.js";

/**
 * AW-5 片1 · migration `0015_agents_role` up/down 验证。
 *
 * up   = `ADD COLUMN IF NOT EXISTS role TEXT`（可空过渡，旧行/旧写入路径兼容）
 * down = `DROP COLUMN IF EXISTS role`（本地可逆；重跑 up 恢复同一契约）
 */

let db: Database | undefined;

afterAll(async () => {
  if (db) await closeDatabase(db);
  db = undefined;
});

async function agentRoleColumn(database: Database) {
  const result = (await database.execute(
    sql`SELECT is_nullable, data_type
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'agents' AND column_name = 'role'`
  )) as unknown as { rows: Array<{ is_nullable: string; data_type: string }> };
  return result.rows[0] ?? null;
}

describe("AW-5 片1: migration 0015_agents_role", () => {
  it("declares reversible up/down SQL", () => {
    const migration = MIGRATIONS.find((m) => m.id === "0015_agents_role");
    expect(migration).toBeDefined();
    expect(migration!.statements.join("\n")).toContain("ADD COLUMN IF NOT EXISTS role TEXT");
    expect(migration!.rollbackStatements?.join("\n")).toContain("DROP COLUMN IF EXISTS role");
  });

  it("up adds a nullable role; legacy rows stay valid; down/up roundtrip is reversible", async () => {
    db = await createInMemoryDb(); // 全链迁移（含 0015）
    const before = await agentRoleColumn(db);
    expect(before).not.toBeNull();
    expect(before!.is_nullable).toBe("YES");

    // 旧行兼容：不带 role 的插入保持合法，读回为 NULL。
    await db.insert(agents).values({
      id: "agent_legacy_row",
      slug: "legacy_row",
      name: "Legacy Row",
      baseEngine: "content_acquisition",
      persona: "legacy persona",
      outputStyle: "structured",
      status: "active",
      createdAt: new Date().toISOString()
    });

    // role 读写往返。
    await db.execute(
      sql`UPDATE agents SET role = 'content_editor' WHERE id = 'agent_legacy_row'`
    );
    const loaded = (await db.select().from(agents))[0];
    expect(loaded.role).toBe("content_editor");

    // down：0015 为最新已应用迁移，可回滚且列被移除。
    expect(await rollbackMigration(db, "0015_agents_role")).toBe(true);
    expect(await agentRoleColumn(db)).toBeNull();

    // up 重放：重跑迁移恢复同一契约。
    expect(await runMigrations(db)).toContain("0015_agents_role");
    const after = await agentRoleColumn(db);
    expect(after).not.toBeNull();
    expect(after!.is_nullable).toBe("YES");
  });
});
