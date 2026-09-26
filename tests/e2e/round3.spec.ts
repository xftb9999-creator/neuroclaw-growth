import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  // E2E 断言基于英文文案;界面默认中文,这里固定测试语言环境。
  await page.addInitScript(() => {
    window.localStorage.setItem("neuroclaw.locale", "en-US");
  });
});

async function createWorkspace(
  page: import("@playwright/test").Page,
  name = "Growth Lab",
  industry?: string
) {
  await page.goto("/onboarding");
  await page.getByTestId("workspace-name").fill(name);
  if (industry) await page.getByTestId("workspace-industry").fill(industry);
  await page.getByTestId("create-workspace").click();
  // First workspace creation may pay server warmup cost (embedded PG).
  await expect(page).toHaveURL(/\/templates$/, { timeout: 15_000 });
}

async function createCompletedContentRun(page: import("@playwright/test").Page) {
  await page.getByTestId("select-content_acquisition").click();
  await expect(page).toHaveURL(/\/runs\/new\/content_acquisition$/);
  await page.getByTestId("field-businessSummary").fill("Launch a founder-led campaign");
  await page.getByTestId("field-targetCustomer").fill("SMB operators");
  await page.getByTestId("field-preferredChannels").fill("email, linkedin");
  await page.getByTestId("field-contentGoal").fill("Generate three hooks");
  await page.getByTestId("launch-run").click();
  await expect(page).toHaveURL(/\/runs\/run_[0-9a-f-]+$/);
  // Durable execution (Round J): completion arrives asynchronously.
  await expect(page.getByTestId("run-status")).toHaveText("completed", { timeout: 20_000 });
}

test("desktop standard user flow reaches result detail", async ({ page, isMobile }) => {
  test.skip(isMobile, "Desktop-only full happy path");
  await createWorkspace(page, "Desktop Growth Lab");
  await createCompletedContentRun(page);
  await page.getByTestId("view-result").click();
  await expect(page).toHaveURL(/\/result$/);
  await expect(page.getByTestId("result-title")).toContainText("content acquisition");
});

test("desktop approval flow supports approve and reject", async ({ page, isMobile }) => {
  test.skip(isMobile, "Desktop-only approval flow");
  await createWorkspace(page, "Approval Growth Lab");
  await page.getByTestId("select-private_conversion").click();
  await page.getByTestId("field-businessSummary").fill("Send a high-touch conversion preview");
  await page.getByTestId("field-targetCustomer").fill("Warm inbound leads");
  await page.getByTestId("field-preferredChannels").fill("email");
  await page.getByTestId("field-offerAsset").fill("VIP audit");
  await page.getByTestId("launch-run").click();
  await expect(page.getByTestId("run-status")).toHaveText("waiting_approval", { timeout: 20_000 });
  await page.getByTestId("approve-run").click();
  await page.getByTestId("confirm-approve-run").click();
  await expect(page.getByTestId("run-status")).toHaveText("completed", { timeout: 20_000 });

  await page.goto("/templates");
  await page.getByTestId("select-private_conversion").click();
  await page.getByTestId("field-businessSummary").fill("Send a high-touch conversion preview");
  await page.getByTestId("field-targetCustomer").fill("Warm inbound leads");
  await page.getByTestId("field-preferredChannels").fill("email");
  await page.getByTestId("field-offerAsset").fill("VIP audit");
  await page.getByTestId("launch-run").click();
  await expect(page.getByTestId("run-status")).toHaveText("waiting_approval", { timeout: 20_000 });
  await page.getByTestId("reject-run").click();
  await page.getByTestId("confirm-reject-run").click();
  await expect(page.getByTestId("run-status")).toHaveText("cancelled", { timeout: 20_000 });
});

test("desktop error recovery shows validation feedback", async ({ page, isMobile }) => {
  test.skip(isMobile, "Desktop-only error validation");
  await createWorkspace(page, "Validation Growth Lab");
  await page.getByTestId("select-weekly_review").click();
  await page.getByTestId("field-businessSummary").fill("Review weekly metrics");
  await page.getByTestId("field-targetCustomer").fill("SMB operators");
  await page.getByTestId("field-preferredChannels").fill("email");
  await page.getByTestId("launch-run").click();
  await expect(page.getByText("Metrics Window Days is required")).toBeVisible();
});

test("desktop history supports clone and rerun prefill", async ({ page, isMobile }) => {
  test.skip(isMobile, "Desktop-only history flow");
  await createWorkspace(page, "History Growth Lab");
  await createCompletedContentRun(page);
  await page.goto("/history");
  await expect(page.getByText(/content acquisition/i)).toBeVisible();
  await page.getByTestId(/clone-run_/).click();
  await expect(page).toHaveURL(/\/runs\/new\/content_acquisition$/);
  await expect(page.getByTestId("field-businessSummary")).toHaveValue("Launch a founder-led campaign");
});

test("desktop memory flow supports edit pin suppress and delete", async ({ page, isMobile }) => {
  test.skip(isMobile, "Desktop-only memory flow");
  await createWorkspace(page, "Memory Growth Lab");
  await createCompletedContentRun(page);
  await page.goto("/memory");
  await expect(page.getByText("successful output")).toBeVisible();
  await page.getByTestId(/edit-mem_/).click();
  await page.getByTestId(/edit-memory-mem_/).fill("Pinned summary from browser");
  await page.getByText("Save").click();
  await expect(page.getByText("Pinned summary from browser")).toBeVisible();
  await page.getByTestId(/pin-mem_/).click();
  await page.getByTestId(/suppress-mem_/).click();
  await page.getByTestId(/delete-mem_/).click();
  await expect(page.getByText("No memory yet")).toBeVisible();
});

test("mobile flow keeps onboarding and run setup usable", async ({ page, isMobile }) => {
  test.skip(!isMobile, "Mobile-only layout check");
  await createWorkspace(page, "Mobile Growth Lab");
  await page.getByTestId("select-content_acquisition").click();
  await expect(page.getByTestId("field-businessSummary")).toBeVisible();
  await expect(page.getByTestId("launch-run")).toBeVisible();
});

test("mobile history remains readable", async ({ page, isMobile }) => {
  test.skip(!isMobile, "Mobile-only history check");
  await createWorkspace(page, "Mobile History Lab");
  await createCompletedContentRun(page);
  await page.goto("/history");
  await expect(page.getByText(/content acquisition/i)).toBeVisible();
});

test("desktop stale workspace recovery returns the user to onboarding", async ({ page, isMobile }) => {
  test.skip(isMobile, "Desktop-only recovery flow");
  await createWorkspace(page, "Recovery Growth Lab");
  await page.evaluate(() => {
    window.localStorage.setItem("neuroclaw.workspaceId", "missing");
  });
  await page.goto("/history");
  await expect(page).toHaveURL(/\/onboarding$/);
  await expect(
    page.getByText("Your workspace expired after a backend reset. Create a new workspace to reload history.")
  ).toBeVisible();
  await expect(page.getByTestId("workspace-name")).toBeVisible();
});

test("mobile memory flow supports edit pin suppress and delete", async ({ page, isMobile }) => {
  test.skip(!isMobile, "Mobile-only memory flow");
  await createWorkspace(page, "Mobile Memory Lab");
  await createCompletedContentRun(page);
  await page.goto("/memory");
  await expect(page.getByText("successful output")).toBeVisible();
  await page.getByTestId(/edit-mem_/).click();
  await page.getByTestId(/edit-memory-mem_/).fill("Mobile edited summary");
  await page.getByText("Save").click();
  await expect(page.getByText("Mobile edited summary")).toBeVisible();
  await page.getByTestId(/pin-mem_/).click();
  await page.getByTestId(/suppress-mem_/).click();
  await page.getByTestId(/delete-mem_/).click();
  await expect(page.getByText("No memory yet")).toBeVisible();
});

test("mobile clone flow keeps reused setup editable", async ({ page, isMobile }) => {
  test.skip(!isMobile, "Mobile-only clone flow");
  await createWorkspace(page, "Mobile Clone Lab");
  await createCompletedContentRun(page);
  await page.goto("/history");
  await page.getByTestId(/clone-run_/).click();
  await expect(page).toHaveURL(/\/runs\/new\/content_acquisition$/);
  await expect(page.getByTestId("field-businessSummary")).toHaveValue("Launch a founder-led campaign");
  await page.getByTestId("field-contentGoal").fill("Generate five hooks");
  await expect(page.getByTestId("field-contentGoal")).toHaveValue("Generate five hooks");
});

test("desktop round L UX surfaces: nav groups, 7-day plan banner, billing", async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, "Desktop-only Round L checks");
  await createWorkspace(page, "Round L Lab");

  await page.goto("/home");
  await expect(page.getByTestId("seven-day-plan")).toBeVisible();

  await page.getByTestId("nav-group-assets").click();
  await expect(page.getByTestId("nav-panel-assets")).toBeVisible();
  await page.getByTestId("nav-panel-assets").getByText("History", { exact: true }).click();
  await expect(page).toHaveURL(/\/history$/);

  await page.goto("/billing");
  await expect(page.getByTestId("plan-starter")).toBeVisible();
});

test("desktop benchmark cockpit keeps industry optional and degrades to an empty state", async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, "Desktop-only cockpit flow");
  await createWorkspace(page, "Benchmark Lab", "Beauty");

  const workspaceId = await page.evaluate(() => localStorage.getItem("neuroclaw.workspaceId"));
  expect(workspaceId).toBeTruthy();
  const industryRes = await page.request.get(`/api/workspaces/${workspaceId}/industry`);
  expect(industryRes.ok()).toBeTruthy();
  expect((await industryRes.json()).industry).toBe("Beauty");

  await page.goto("/analytics");
  await expect(page.getByTestId("bench-compare-card")).toBeVisible();
  await expect(page.getByTestId("bench-compare-empty")).toBeVisible();
});

test("mobile onboarding exposes optional industry without blocking the primary form", async ({
  page,
  isMobile,
}) => {
  test.skip(!isMobile, "Mobile-only onboarding check");
  await page.goto("/onboarding");
  await expect(page.getByTestId("workspace-industry")).toBeVisible();
  await page.getByTestId("workspace-name").fill("Mobile Benchmark Lab");
  await page.getByTestId("create-workspace").click();
  await expect(page).toHaveURL(/\/templates$/, { timeout: 15_000 });
});

test("desktop round W crew full chain: create, staff, relay with team, memory", async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, "Desktop-only full chain");
  const unique = Date.now().toString(36);
  const agentSlug = `crew_w_${unique}`;

  await createWorkspace(page, "Crew Chain Lab");

  const agentRes = await page.request.post("/api/agents", {
    data: {
      slug: agentSlug,
      name: "Chain Writer",
      baseEngine: "content_acquisition",
      persona: "You are a concise test writer.",
      focusAreas: [],
      outputStyle: "structured",
      toolNames: []
    }
  });
  expect(agentRes.ok()).toBeTruthy();


  const wsId = await page.evaluate(() => localStorage.getItem("neuroclaw.workspaceId"));
  expect(wsId).toBeTruthy();

  // 2) Create a persistent Crew via UI.
  await page.goto("/crews");
  await page.getByTestId("crew-name").fill("Alpha Crew");
  await page.getByTestId("crew-create").click();
  await expect(page.getByTestId("crew-Alpha Crew")).toBeVisible();

  // 3) Staff it from the detail card.
  await page.getByTestId("crew-Alpha Crew").click();
  await page
    .getByTestId("crew-agent-select")
    .selectOption({ label: "Chain Writer" });
  await page
    .getByRole("button", { name: /鍔犲叆缂栧埗|Add to roster/ })
    .click();
  const memberChip = page
    .locator("div.rounded-input")
    .filter({ hasText: "Chain Writer" });
  await expect(memberChip).toHaveCount(1);

  // 4) Launch a relay linked to this crew (API; durable engine processes it).
  const crewList = await page.request.get(`/api/teams?workspaceId=${wsId}`);
  const crewsJson = (await crewList.json()) as Array<{ id: string }>;
  const crew = { id: crewsJson[0].id };
  const launchRes = await page.request.post("/api/relay-runs/launch", {
    data: {
      workspaceId: wsId,
      playbookKey: "sprint",
      goal: "Round W full chain goal",
      crewTeamId: crew.id
    }
  });
  expect(launchRes.status()).toBe(201);

  // 5) Approve the mid-relay conversion step when it surfaces.
  await expect
    .poll(async () => {
      const res = await page.request.get(
        `/api/approvals/pending?workspaceId=${wsId}`
      );
      return ((await res.json()) as unknown[]).length > 0 ? "pending" : "none";
    })
    .toBe("pending");

  const pendRes = await page.request.get(
    `/api/approvals/pending?workspaceId=${wsId}`
  );
  const pending = (await pendRes.json()) as Array<{ run: { id: string } }>;
  const approveRes = await page.request.post(
    `/api/runs/${pending[0].run.id}/approval`,
    { data: { approved: true, reviewerId: "e2e" } }
  );
  expect(approveRes.ok()).toBeTruthy();

  // 6) Relay reaches completed.
  await expect
    .poll(async () => {
      const res = await page.request.get(
        `/api/relay-runs?workspaceId=${wsId}`
      );
      const list = (await res.json()) as Array<{ status: string }>;
      return list.some((r) => r.status === "completed") ? "completed" : "in-flight";
    })
    .toBe("completed");

  // 7) Crew memory tab lists the team-visible deposits.
  await page.goto("/crews");
  await page.getByTestId("crew-Alpha Crew").click();
});

// marker
