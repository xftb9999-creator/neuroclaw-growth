import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// RTL auto-cleanup when vitest globals are disabled.
afterEach(() => {
  cleanup();
});
