import { test, expect, devices, type Page } from "@playwright/test";
import { THREADS, enterDemo, expectNoHorizontalOverflow, rail } from "./helpers";

/** From the review the demo lands on, open the Overview through the rail (or the phone's tab bar). */
async function openOverview(page: Page) {
  await rail(page).getByRole("button", { name: "Overview" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();
  await expect(page).toHaveURL(/\/overview$/);
}

const strip = (page: Page) => page.getByRole("group", { name: "Needs action" });
const upNext = (page: Page) => page.getByRole("region", { name: "Up next" });
const kpis = (page: Page) => page.getByRole("list", { name: "Key figures" });

/**
 * The seed (convex/demoContent.ts): six replies sent 14 minutes after their
 * inquiry within the last few days, one thread ready to send, one waiting on
 * a staff fact, no page change and no corrections.
 */
test.describe("overview", () => {
  test("the rail opens the dashboard: needs-action tiles, up next, key figures and comparisons from the seed", async ({ page }) => {
    await enterDemo(page);
    await openOverview(page);

    // Header line: scope only (the inn's local date, its zone, the window); the counts are the strip's.
    await expect(page.locator("header")).toContainText(/\w{3}, \w{3} \d{1,2} · inn time, \w+ · last 7 days/);

    // Needs-action strip: four real buttons; zero tiles read "Clear".
    await expect(strip(page).getByRole("button")).toHaveCount(4);
    await expect(strip(page).getByRole("button", { name: /^Needs you/ })).toContainText("1");
    await expect(strip(page).getByRole("button", { name: /^Needs you/ })).toContainText("Waiting on a staff answer");
    await expect(strip(page).getByRole("button", { name: /^Ready to send/ })).toContainText("1");
    await expect(strip(page).getByRole("button", { name: /^Policy changes to review/ })).toContainText("Clear");
    await expect(strip(page).getByRole("button", { name: /^Follow-ups due/ })).toContainText("Clear");

    // Up next: the thread waiting on staff first, then the one ready to send.
    const rows = upNext(page).getByRole("button");
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText(THREADS.gap);
    await expect(rows.nth(0)).toContainText("Needs you");
    await expect(rows.nth(1)).toContainText(THREADS.ready);
    await expect(rows.nth(1)).toContainText("Ready to send");

    // Key figures: four tiles, tabular values, honest empty comparisons.
    const tiles = kpis(page).getByRole("listitem");
    await expect(tiles).toHaveCount(4);
    await expect(tiles.nth(0)).toContainText("Replies sent · 7d");
    await expect(tiles.nth(0)).toContainText("6");
    await expect(tiles.nth(1)).toContainText("Median first response · 7d");
    await expect(tiles.nth(1)).toContainText("14 min");
    await expect(tiles.nth(2)).toContainText("Verified before send · 7d");
    await expect(tiles.nth(2)).toContainText("100%");
    await expect(tiles.nth(3)).toContainText("Corrections sent · 30d");
    await expect(tiles.nth(3)).toContainText("No corrections sent yet");
    for (let i = 0; i < 4; i++) {
      const numeric = await tiles.nth(i).locator("span").nth(1).evaluate((el) => getComputedStyle(el).fontVariantNumeric);
      expect(numeric, `KPI value ${i} uses tabular figures`).toContain("tabular-nums");
    }
    // Breakdown: the day series (described for screen readers) and both categorical bars carry their numbers in text.
    const breakdown = page.getByRole("region", { name: "Breakdown" });
    await expect(breakdown).toContainText("Replies per day · last 14 days");
    await expect(breakdown).toContainText(/Replies per day, oldest first: (\d+, ){13}\d+\. 6 in total\./);
    await expect(breakdown).toContainText("Verified and sent as written 6");
    await expect(breakdown).toContainText("Inquiries 7");
    await expect(breakdown).toContainText("Booked stays 1");

    // Comparisons: A and B columns side by side, in that order, for the week; the other two are honest empties.
    const comparisons = page.getByRole("region", { name: "Comparisons" });
    const thisWeek = comparisons.getByText("This week", { exact: true });
    const lastWeek = comparisons.getByText("Last week", { exact: true });
    await expect(thisWeek).toBeVisible();
    await expect(lastWeek).toBeVisible();
    const [a, b] = await Promise.all([thisWeek.boundingBox(), lastWeek.boundingBox()]);
    expect(b!.x, "B column sits to the right of A on a desktop").toBeGreaterThan(a!.x + 100);
    expect(Math.abs(b!.y - a!.y), "A and B column labels share a baseline").toBeLessThan(2);
    // dt and dd are adjacent elements: their text concatenates without a space.
    await expect(comparisons).toContainText(/Replies sent\s*6/);
    await expect(comparisons).toContainText(/Median first response\s*14 min/);
    await expect(comparisons).toContainText("No page has changed yet.");
    await expect(comparisons).toContainText("Staff sent every draft as written · last 5 replies");
  });

  test("an up-next row opens its thread", async ({ page }) => {
    await enterDemo(page);
    await openOverview(page);
    await upNext(page).getByRole("button", { name: THREADS.gap }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Inbox" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: THREADS.gap })).toBeVisible();
    await expect(page).toHaveURL(/\/inbox\/[a-z0-9]+$/);
  });

  test("a needs-action tile deep-links to the filtered inbox", async ({ page }) => {
    await enterDemo(page);
    await openOverview(page);
    await strip(page).getByRole("button", { name: /^Needs you/ }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Inbox" })).toBeVisible();
    await expect(page.getByLabel("Filter by status")).toHaveValue("needs_staff");
    const queue = page.getByRole("region", { name: "Guest threads" });
    await expect(queue.getByRole("button", { name: THREADS.gap })).toBeVisible();
    await expect(queue.getByRole("button", { name: THREADS.ready })).toHaveCount(0);
    // The filter stays in the address bar, so the entry is shareable and survives back/forward.
    await expect(page).toHaveURL(/\/inbox\?filter=needs_staff$/);
    await page.goBack();
    await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();
    await expect(page).toHaveURL(/\/overview$/);
    await page.goForward();
    await expect(page.getByLabel("Filter by status")).toHaveValue("needs_staff");
    await expect(page).toHaveURL(/\/inbox\?filter=needs_staff$/);

    // Back to the dashboard, then the other tile.
    await openOverview(page);
    await strip(page).getByRole("button", { name: /^Ready to send/ }).click();
    await expect(page.getByLabel("Filter by status")).toHaveValue("ready");
    await expect(page).toHaveURL(/\/inbox\?filter=ready$/);
    await expect(queue.getByRole("button", { name: THREADS.ready })).toBeVisible();
    await expect(queue.getByRole("button", { name: THREADS.gap })).toHaveCount(0);

    // The status select writes the filter back to the address bar in place.
    await page.getByLabel("Filter by status").selectOption("all");
    await expect(page).toHaveURL(/\/inbox$/);
  });

  test("the filtered inbox is bookmarkable and the `g o` chord reaches the Overview", async ({ page }) => {
    await page.goto("/inbox?filter=ready");
    await page.getByRole("button", { name: "Open the demo workspace" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Inbox" })).toBeVisible();
    await expect(page.getByLabel("Filter by status")).toHaveValue("ready");
    const queue = page.getByRole("region", { name: "Guest threads" });
    await expect(queue.getByRole("button", { name: THREADS.ready })).toBeVisible();
    await expect(queue.getByRole("button", { name: THREADS.gap })).toHaveCount(0);

    await page.keyboard.press("g");
    await page.keyboard.press("o");
    await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();
    await expect(page).toHaveURL(/\/overview$/);
    await expect(rail(page).getByRole("button", { name: "Overview" })).toHaveAttribute("aria-current", "page");
  });

  test("on a phone the tiles sit two per row, the comparisons put A above B, and nothing overflows", async ({ browser }) => {
    const context = await browser.newContext({ ...devices["iPhone 13"] });
    const page = await context.newPage();
    try {
      await enterDemo(page);
      await openOverview(page);
      await expectNoHorizontalOverflow(page);

      const tiles = strip(page).getByRole("button");
      await expect(tiles).toHaveCount(4);
      const [first, second, third] = await Promise.all([tiles.nth(0).boundingBox(), tiles.nth(1).boundingBox(), tiles.nth(2).boundingBox()]);
      expect(Math.abs(second!.y - first!.y), "the first two tiles share a row").toBeLessThan(2);
      expect(second!.x, "the second tile sits to the right of the first").toBeGreaterThan(first!.x + first!.width - 1);
      expect(third!.y, "the third tile starts the second row").toBeGreaterThan(first!.y + first!.height - 1);

      const comparisons = page.getByRole("region", { name: "Comparisons" });
      const [a, b] = await Promise.all([
        comparisons.getByText("This week", { exact: true }).boundingBox(),
        comparisons.getByText("Last week", { exact: true }).boundingBox(),
      ]);
      expect(b!.y, "B stacks under A").toBeGreaterThan(a!.y + 40);
      expect(Math.abs(b!.x - a!.x), "A and B share the left edge").toBeLessThan(2);

      // The tab bar carries all five views and the tile still deep-links.
      await expect(rail(page).getByRole("button")).toHaveCount(5);
      await strip(page).getByRole("button", { name: /^Needs you/ }).click();
      await expect(page.getByRole("heading", { level: 1, name: "Inbox" })).toBeVisible();
      await expect(page.getByLabel("Filter by status")).toHaveValue("needs_staff");
      await expectNoHorizontalOverflow(page);
    } finally {
      await context.close();
    }
  });
});
