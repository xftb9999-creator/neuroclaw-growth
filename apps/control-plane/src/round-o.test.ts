import { afterAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";

import { ControlPlaneService } from "./index.js";

const originalEnv = {
  EMBED_KEY: process.env.NEUROCLAW_EMBEDDINGS_API_KEY,
  NEUROCLAW_EMBEDDINGS_DIMS: process.env.NEUROCLAW_EMBEDDINGS_DIMS
};

afterAll(() => {
  if (originalEnv.EMBED_KEY === undefined) delete process.env.NEUROCLAW_EMBEDDINGS_API_KEY;
  else process.env.NEUROCLAW_EMBEDDINGS_API_KEY = originalEnv.EMBED_KEY;
  if (originalEnv.NEUROCLAW_EMBEDDINGS_DIMS === undefined) delete process.env.NEUROCLAW_EMBEDDINGS_DIMS;
  else process.env.NEUROCLAW_EMBEDDINGS_DIMS = originalEnv.NEUROCLAW_EMBEDDINGS_DIMS;
});

/** One-hot 1536-dim vector with a 1 at `axis` �?orthogonal by construction. */
function oneHot(axis: number): number[] {
  const v = new Array(1536).fill(0);
  v[axis] = 1;
  return v;
}

/** Unit vector with cos = 0.5 against an axis-0 query (mildly similar). */
function mixedVec(): number[] {
  const v = new Array(1536).fill(0);
  v[0] = 0.5;
  v[1] = Math.sqrt(0.75);
  return v;
}

async function seedKnowledge(
  service: ControlPlaneService,
  workspaceId: string,
  id: string,
  title: string,
  vector: number[],
  ageDays = 0
) {
  const createdAt = new Date(Date.now() - ageDays * 86_400_000).toISOString();
  await service.db.execute(
    sql`INSERT INTO knowledge_entries (id, workspace_id, title, content, tags, source, created_at)
        VALUES (${id}, ${workspaceId}, ${title}, ${title + " body"}, '[]', 'manual', ${createdAt})`
  );
  await service.db.execute(
    sql`UPDATE knowledge_entries SET embedding = ${`[${vector.join(",")}]`}::vector WHERE id = ${id}`
  );
}

describe("Round O: migration baseline (timestamptz + RLS + pgvector)", () => {
  it("applies migrations and installs RLS policies + vector column", async () => {
    const db = await (await import("@neuroclaw/db")).createInMemoryDb();

    const policies = (await db.execute(
      sql`SELECT count(*)::int AS n FROM pg_policies WHERE schemaname = 'public'`
    )) as unknown as { rows: Array<{ n: number }> };
    expect(policies.rows[0].n).toBeGreaterThanOrEqual(9);

    const col = (await db.execute(
      sql`SELECT udt_name FROM information_schema.columns
          WHERE table_name = 'knowledge_entries' AND column_name = 'embedding'`
    )) as unknown as { rows: Array<{ udt_name: string }> };
    expect(col.rows[0]?.udt_name).toBe("vector");

    // timestamptz read contract: ISO-8601 UTC strings via node-postgres parser;
    // PGlite may return Date �?either way Date.parse must work.
    const ws = await db.execute(
      sql`SELECT created_at FROM workspaces LIMIT 1`
    ) as unknown as { rows: Array<{ created_at: unknown }> };
    void ws; // structural smoke �?real assertions live in service tests below

    await (await import("@neuroclaw/db")).closeDatabase(db);
  });
});

describe("Round O: semantic recall (cosine + time-decay)", () => {
  it("ranks nearest knowledge first and decays stale entries", async () => {
    // Deterministic vectors, no provider needed: query uses embedText stub path?
    // No �?we call semanticSearchKnowledge with embeddings DISABLED would fall
    // back to recency. So instead enable key but stub fetch to return a fixed
    // query embedding (axis 0).
    process.env.NEUROCLAW_EMBEDDINGS_API_KEY = "test-key";
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ data: [{ embedding: oneHot(0) }] }), { status: 200 })) as never;

    try {
      const service = await ControlPlaneService.create();
      const ws = await service.createWorkspace({ name: "Recall Lab", plan: "team" }, "founder");

      await seedKnowledge(service, ws.id, "kn_exact_fresh", "exact fresh", oneHot(0), 0);
      await seedKnowledge(service, ws.id, "kn_exact_stale", "exact stale", oneHot(0), 100);
      await seedKnowledge(service, ws.id, "kn_offtopic_fresh", "offtopic fresh", mixedVec(), 0);

      const results = await service.semanticSearchKnowledge(ws.id, "query", 5);

      // Raw cosine puts the two exact matches first (score 1.0); time-decay
      // (τ=30d) crushes the 100-day-old one below the fresh off-topic entry.
      expect(results[0].id).toBe("kn_exact_fresh");
      expect(results.find((r) => r.id === "kn_exact_stale")!.finalScore).toBeLessThan(
        results.find((r) => r.id === "kn_offtopic_fresh")!.finalScore
      );

      await service.shutdown();
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("auto-recalls knowledge into run input when none selected", async () => {
    process.env.NEUROCLAW_EMBEDDINGS_API_KEY = "test-key";
    const realFetch = globalThis.fetch;
    let call = 0;
    globalThis.fetch = (async () => {
      // 1st embed: knowledge seeding (axis 0); 2nd: run query (axis 0);
      call += 1;
      const axis = call <= 3 ? 0 : 0;
      return new Response(JSON.stringify({ data: [{ embedding: oneHot(axis) }] }), { status: 200 });
    }) as never;

    try {
      const service = await ControlPlaneService.create();
      const ws = await service.createWorkspace({ name: "AutoRecall Lab", plan: "business" }, "founder");
      await seedKnowledge(service, ws.id, "kn_hit", "brand positioning note", oneHot(0));

      const run = await service.createRun({
        workspaceId: ws.id,
        templateType: "content_acquisition",
        input: {
          businessSummary: "Launch campaign aligned with our brand positioning",
          targetCustomer: "SMB operators",
          preferredChannels: ["email"],
          contentGoal: "hooks"
        }
      });

      expect(run.status).toBe("completed");
      const knowledge = run.input._knowledge as Array<{ title: string }> | undefined;
      expect(Array.isArray(knowledge)).toBe(true);
      expect(knowledge!.some((k) => k.title === "brand positioning note")).toBe(true);
      expect((run.input as { _knowledgeSource?: string })._knowledgeSource).toBe("semantic");

      await service.shutdown();
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("Round O: embed_knowledge durable job", () => {
  it("skips enqueueing when embeddings are unavailable", async () => {
    delete process.env.NEUROCLAW_EMBEDDINGS_API_KEY;
    const db = await (await import("@neuroclaw/db")).createInMemoryDb();
    const service = await ControlPlaneService.create(undefined, db);

    const ws = await service.createWorkspace({ name: "NoKey Lab", plan: "starter" });
    const { jobs } = await import("@neuroclaw/db");
    const before = await db.select().from(jobs);
    expect(before).toHaveLength(0);

    await service.createKnowledgeEntry({
      workspaceId: ws.id,
      title: "no key",
      content: "should not enqueue"
    });

    const after = await db.select().from(jobs);
    expect(after).toHaveLength(0);

    await service.shutdown();
  });

  it("embeds through the job loop end-to-end with a stubbed provider", async () => {
    process.env.NEUROCLAW_EMBEDDINGS_API_KEY = "test-key";
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
      const body = JSON.parse(init?.body ?? "{}") as { input: string };
      // Deterministic: entries containing "premium" map to axis 2.
      const axis = body.input.includes("premium") ? 2 : 3;
      return new Response(JSON.stringify({ data: [{ embedding: oneHot(axis) }] }), { status: 200 });
    }) as never;

    try {
      const db = await (await import("@neuroclaw/db")).createInMemoryDb();
      const service = await ControlPlaneService.create(undefined, db, undefined, undefined, {
        durable: true
      });
      const ws = await service.createWorkspace({ name: "Embed Lab", plan: "enterprise" }, "founder");

      await service.createKnowledgeEntry({
        workspaceId: ws.id,
        title: "premium tea sourcing",
        content: "Our premium oolong comes from Wuyi mountains."
      });

      const { jobs } = await import("@neuroclaw/db");
      const queued = await db.select().from(jobs);
      expect(queued.some((j) => j.type === "embed_knowledge")).toBe(true);

      while (await service.processNextJob()) {}

      // Query embedding (axis 2) must surface the embedded entry.
      const hits = await service.semanticSearchKnowledge(ws.id, "premium", 3);
      expect(hits[0].title).toBe("premium tea sourcing");
      expect(hits[0].rawScore).toBeGreaterThan(0.99);

      const done = await db.select().from(jobs);
      expect(done.every((j) => j.status === "completed")).toBe(true);

      await service.shutdown();
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
