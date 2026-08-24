import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 60_000,
  use: {
    baseURL: "http://127.0.0.1:8787"
  },
  webServer: {
    command: "npm run start",
    url: "http://127.0.0.1:8787/health",
    reuseExistingServer: false,
    timeout: 120_000
  },
  projects: [
    {
      name: "desktop-chromium",
      use: {
        ...devices["Desktop Chrome"]
      }
    },
    {
      name: "mobile-chromium",
      use: {
        ...devices["iPhone 13"],
        browserName: "chromium"
      }
    }
  ]
});
