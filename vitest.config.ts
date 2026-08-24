import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@neuroclaw/shared": fileURLToPath(
        new URL("./packages/shared/src/index.ts", import.meta.url)
      ),
      "@neuroclaw/templates": fileURLToPath(
        new URL("./packages/templates/src/index.ts", import.meta.url)
      ),
      "@neuroclaw/policy": fileURLToPath(
        new URL("./packages/policy/src/index.ts", import.meta.url)
      ),
      "@neuroclaw/memory": fileURLToPath(
        new URL("./packages/memory/src/index.ts", import.meta.url)
      ),
      "@neuroclaw/observability": fileURLToPath(
        new URL("./packages/observability/src/index.ts", import.meta.url)
      ),
      "@neuroclaw/db": fileURLToPath(
        new URL("./packages/db/src/index.ts", import.meta.url)
      ),
      "@neuroclaw/agent-core": fileURLToPath(
        new URL("./packages/agent-core/src/index.ts", import.meta.url)
      ),
      "@neuroclaw/operator-browser": fileURLToPath(
        new URL("./packages/operator-browser/src/index.ts", import.meta.url)
      ),
      "@neuroclaw/tooling-mcp": fileURLToPath(
        new URL("./packages/tooling-mcp/src/index.ts", import.meta.url)
      ),
      "@neuroclaw/runtime-worker": fileURLToPath(
        new URL("./apps/runtime-worker/src/index.ts", import.meta.url)
      ),
      "@neuroclaw/temporal-worker": fileURLToPath(
        new URL("./apps/temporal-worker/src/index.ts", import.meta.url)
      )
    }
  },
  test: {
    environment: "node",
    include: ["**/*.test.ts"],
    testTimeout: 30000
  }
});
