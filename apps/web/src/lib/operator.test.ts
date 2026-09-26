// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_OPERATOR_ID, getOperatorId, setOperatorId } from "./operator.js";

describe("operator identity", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("defaults when nothing stored", () => {
    expect(getOperatorId()).toBe(DEFAULT_OPERATOR_ID);
  });

  it("persists and reads back a chosen identity", () => {
    setOperatorId("founder_a");
    expect(getOperatorId()).toBe("founder_a");
  });
});
