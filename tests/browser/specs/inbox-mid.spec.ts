import { test, expect } from "@playwright/test";
import { THREADS, enterDemo, openInbox, openThread } from "./helpers";

/**
 * Runs in the `mid` project only (1000×800): between 900 and 1199px the inbox
 * is queue + thread and the sources pane opens as a sheet from the header.
 */
test.describe("inbox at two-pane width", () => {
  test("the header's Sources button is reachable by pointer and its sheet lists the draft's claims", async ({ page }) => {
    await enterDemo(page);
    await openInbox(page);
    await openThread(page, THREADS.ready);

    // No third column at this width: the pane beside the thread is gone.
    await expect(page.getByRole("complementary", { name: "Sources for this draft" })).toBeHidden();

    // The button must be the element under its own centre: the title box next
    // to it takes the slack, the actions never shrink under it.
    const sources = page.getByRole("button", { name: "Sources (3)" });
    await expect(sources).toBeVisible();
    const box = (await sources.boundingBox())!;
    const hit = await page.evaluate(
      ([x, y]) => document.elementFromPoint(x, y)?.closest("button")?.textContent ?? null,
      [box.x + box.width / 2, box.y + box.height / 2],
    );
    expect(hit, "Sources button is not covered by another header element").toContain("Sources (3)");

    await sources.click();
    const sheet = page.getByRole("dialog", { name: "Sources for this draft" });
    await expect(sheet).toBeVisible();
    await expect(sheet.getByText("Harbor View Rooms are $299 per night on Friday and Saturday.")).toBeVisible();
    await expect(
      sheet.getByText("“Harbor View Rooms are $259 per night midweek and $299 per night on Friday and Saturday.”"),
    ).toBeVisible();
    await expect(sheet.getByRole("link", { name: "/rates" }).first()).toHaveAttribute("href", /\/rates$/);
    await expect(sheet.getByText("Page current").first()).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
    // The thread is still open behind the sheet.
    await expect(page.getByRole("heading", { level: 2, name: THREADS.ready })).toBeVisible();
  });
});
