import { chromium } from "playwright";

const BASE = "http://127.0.0.1:8787";
const ROUTES = [
  "/",
  "/onboarding",
  "/home",
  "/templates",
  "/launch",
  "/agents",
  "/agents/new",
  "/workflows",
  "/library",
  "/knowledge",
  "/profile",
  "/history",
  "/memory",
  "/inbox",
  "/schedule",
  "/analytics",
  "/team",
  "/team/team_stale_demo",
  "/team/team_stale_demo/results",
  "/runs/run_stale_demo",
  "/?embed=1"
];

const browser = await chromium.launch({ headless: true });
const report = [];

for (const route of ROUTES) {
  const context = await browser.newContext();
  await context.addInitScript(() => {
    window.localStorage.setItem("neuroclaw.locale", "zh-CN");
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (err) => errors.push(`PAGEERROR: ${err.message}`));
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(`CONSOLE: ${msg.text().slice(0, 160)}`);
  });

  let status = "";
  try {
    const response = await page.goto(BASE + route, { waitUntil: "networkidle", timeout: 15000 });
    status = `HTTP ${response?.status() ?? "?"}`;
    // 给恢复逻辑一点时间
    await page.waitForTimeout(800);
    const rootText = await page.evaluate(() => document.getElementById("root")?.innerText?.length ?? 0);
    if (rootText === 0) errors.push("BLANK_ROOT");
  } catch (visitError) {
    errors.push(`NAV_FAIL: ${visitError instanceof Error ? visitError.message.slice(0, 120) : String(visitError)}`);
  }

  report.push({ route, status, errors });
  await context.close();
}

await browser.close();

for (const item of report) {
  const flag = item.errors.length > 0 ? "ERR " : "OK  ";
  console.log(`${flag} ${item.route} [${item.status}]`);
  for (const err of item.errors) console.log(`     ${err}`);
}
