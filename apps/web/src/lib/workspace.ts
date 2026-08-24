import { ApiError } from "./api.js";

export const workspaceStorageKey = "neuroclaw.workspaceId";
export const runDraftStorageKey = "neuroclaw.runDraft";

export function isWorkspaceMissingError(error: unknown): error is ApiError {
  return error instanceof ApiError && error.code === "WORKSPACE_NOT_FOUND";
}
