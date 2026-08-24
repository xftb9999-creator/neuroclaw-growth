import { describe, expect, it } from "vitest";

import { ApiError } from "./api.js";
import { isWorkspaceMissingError } from "./workspace.js";

describe("workspace helpers", () => {
  it("detects workspace-not-found API errors", () => {
    expect(isWorkspaceMissingError(new ApiError("Missing", "WORKSPACE_NOT_FOUND", 404))).toBe(true);
    expect(isWorkspaceMissingError(new ApiError("Missing", "NOT_FOUND", 404))).toBe(false);
    expect(isWorkspaceMissingError(new Error("Missing"))).toBe(false);
  });
});
