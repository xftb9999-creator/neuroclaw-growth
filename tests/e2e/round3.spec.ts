import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  // E2E 断言基于英文文案;界面默认中文,这里固定测试语言环境。
  await page.addInitScript(() => {
    window.localStorage.setItem("neuroclaw.locale", "en-US");
  });
});

async function createWorkspace(page: import("@playwright/test").Page, name = "Growth Lab") {
  await page.goto("/onboarding");
  await page.getByTestId("workspace-name").fill(name);
  await page.getByTestId("create-workspace").click();
  await expect(page).toHaveURL(/\/templates$/);
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
  await expect(page.getByTestId("run-status")).toHaveText("completed");
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
  await expect(page.getByTestId("run-status")).toHaveText("waiting_approval");
  await page.getByTestId("approve-run").click();
  await expect(page.getByTestId("run-status")).toHaveText("completed");

  await page.goto("/templates");
  await page.getByTestId("select-private_conversion").click();
  await page.getByTestId("field-businessSummary").fill("Send a high-touch conversion preview");
  await page.getByTestId("field-targetCustomer").fill("Warm inbound leads");
  await page.getByTestId("field-preferredChannels").fill("email");
  await page.getByTestId("field-offerAsset").fill("VIP audit");
  await page.getByTestId("launch-run").click();
  await page.getByTestId("reject-run").click();
  await expect(page.getByTestId("run-status")).toHaveText("cancelled");
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
