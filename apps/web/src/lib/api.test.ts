import { describe, expect, it, vi } from "vitest";

import { ApiError, createWorkspace } from "./api.js";

describe("api client", () => {
  it("parses successful JSON responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ id: "ws_1" })
      })
    );

    await expect(
      createWorkspace({
        name: "Growth Lab",
        plan: "growth"
      })
    ).resolves.toEqual({ id: "ws_1" });
  });

  it("raises typed API errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        json: async () => ({ message: "Missing", code: "NOT_FOUND" })
      })
    );

    await expect(
      createWorkspace({
        name: "Growth Lab",
        plan: "growth"
      })
    ).rejects.toEqual(new ApiError("Missing", "NOT_FOUND", 404));
  });
});
