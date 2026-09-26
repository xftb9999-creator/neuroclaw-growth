import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { createInMemoryDb, jobs } from "@neuroclaw/db";
import { ControlPlaneService } from "./index.js";

const RUN_INPUT = {
  businessSummary: "Round L undo-window campaign",
  targetCustomer: "SMB operators",
  preferredChannels: ["email"],
  contentGoal: "Generate hooks"
};

describe("Round L: run cancel / undo window", () => {
  it("cancels a queued durable run; job loop skips it and marks the job done", async () => {
    const db = await createInMemoryDb();
    const service = await ControlPlaneService.create(undefined, db, undefined, undefined, {
      durable: true
    });
    const workspace = await service.createWorkspace({ name: "Cancel Lab", plan: "team" }, "founder");

    const run = await service.createRun({
      workspaceId: workspace.id,
      templateType: "content_acquisition",
      input: RUN_INPUT
    });
    expect(run.status).toBe("queued");

    const cancelled = await service.cancelRun(run.id);
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.completedAt).toBeDefined();

    // Drain the loop — must not execute the cancelled run.
    let processedAny = false;
    while (await service.processNextJob()) processedAny = true;
    expect(processedAny).toBe(true);

    const finalRun = await service.getRun(run.id);
    expect(finalRun.status).toBe("cancelled");
    expect(finalRun.outputPayload).toBeUndefined();

    const jobRows = await db.select().from(jobs).where(eq(jobs.runId, run.id));
    expect(jobRows[0]?.status).toBe("completed");

    await service.shutdown();
  });

  it("refuses to cancel completed runs", async () => {
    const service = await ControlPlaneService.create();
    const workspace = await service.createWorkspace({ name: "Cancel Inline Lab", plan: "starter" });

    const run = await service.createRun({
      workspaceId: workspace.id,
      templateType: "content_acquisition",
      input: RUN_INPUT
    });
    expect(run.status).toBe("completed");

    await expect(service.cancelRun(run.id)).rejects.toThrow(/cannot be cancelled/);

    await service.shutdown();
  });
});
