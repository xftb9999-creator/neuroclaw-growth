import { describe, expect, it } from "vitest";

import { InMemoryMemoryStore } from "./index.js";

describe("memory store", () => {
  it("supports CRUD operations", async () => {
    const store = new InMemoryMemoryStore();
    const created = await store.addRecord({
      id: "mem_1",
      workspaceId: "ws_1",
      templateType: "content_acquisition",
      type: "successful_output",
      summary: "Initial summary",
      sourceRunId: "run_1",
      isPinned: false,
      isSuppressed: false,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    });

    expect(created.summary).toBe("Initial summary");
    expect(await store.listByWorkspace("ws_1")).toHaveLength(1);

    const updated = await store.updateRecord("mem_1", {
      summary: "Updated summary",
      isPinned: true
    });

    expect(updated.summary).toBe("Updated summary");
    expect(updated.isPinned).toBe(true);

    await store.deleteRecord("mem_1");
    expect(await store.listByWorkspace("ws_1")).toHaveLength(0);
  });
});
