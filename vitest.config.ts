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
      "@neuroclaw/agent-workforce-contract": fileURLToPath(
        new URL("./packages/agent-workforce-contract/src/index.ts", import.meta.url)
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
    environmentOptions: {
      jsdom: {
        url: "http://localhost"
      }
    },
    include: ["**/*.test.ts", "**/*.test.tsx"],
    testTimeout: 60000,
    setupFiles: ["./apps/web/src/test/setup.ts"],
    // R2-A1: PGlite (embedded Postgres) pays a one-shot WASM/JIT warmup per
    // worker process (~10s). Parallel workers saturate the CPU and cause
    // timeout flakes — run files serially in one fork instead.
    pool: "forks",
    maxWorkers: 1,
    isolate: true,
    execArgv: ["--no-experimental-webstorage"]
  },
  coverage: {
    provider: "v8",
    // Round R baseline scope: the web layer (components + libs) where the
    // test pyramid lives. Full-repo coverage runs in CI against pg16
    // (PGlite-under-instrumentation is ~10x slower locally).
    include: ["apps/web/src/**"],
    exclude: [
      "apps/web/src/test/**",
      "apps/web/src/**/__tests__/**",
      "apps/web/src/**/*.test.*",
      "apps/web/dist/**"
    ],
    reportsDirectory: "coverage",
    // Ratchet tier 1 (Round S): measured 12.61% lines / 69.58% branches —
    // thresholds lock in current coverage with headroom for refactors;
    // raise with each legacy-page test migration wave.
    thresholds: {
      "apps/web/src/**": {
        lines: 11,
        branches: 60,
        functions: 27,
        statements: 11
      }
    }
  }
});
