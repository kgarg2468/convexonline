import { test, expect } from "@playwright/test";
import {
  GUESTS,
  THREADS,
  changePolicyPage,
  deliveryList,
  enterDemo,
  expectNoHorizontalOverflow,
  openInbox,
  rail,
  takeThread,
} from "./helpers";

test.describe("mobile", () => {
  test("sign-in and review screens fit the viewport and keyboard focus stays visible", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("button", { name: "Open the demo workspace" })).toBeVisible();
    await expectNoHorizontalOverflow(page);

    await enterDemo(page);
    await expectNoHorizontalOverflow(page);

    await page.keyboard.press("Tab");
    const focused = page.locator(":focus");
    await expect(focused).toBeVisible();
    const box = await focused.boundingBox();
    const width = page.viewportSize()!.width;
    expect(box, "focused element has a box").not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(width + 1);

    await changePolicyPage(page);
    await expectNoHorizontalOverflow(page);
    const card = page.getByRole("article", { name: GUESTS.petFee });
    await card.getByRole("button", { name: "Show stored page versions" }).click();
    await expect(page.getByText("Current version")).toBeVisible();
    await expectNoHorizontalOverflow(page);

    // The review actions work at phone width too.
    await card.getByRole("button", { name: "Take this thread" }).click();
    await expect(card.getByText(/You hold this thread until/)).toBeVisible();
    await card.getByRole("button", { name: "Approve correction" }).click();
    await expect(card.getByText("Approved, not sent")).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });

  test("inbox is list then detail with a way back, and a send fits the screen", async ({ page }) => {
    await enterDemo(page);
    await openInbox(page);
    await expectNoHorizontalOverflow(page);

    const queue = page.getByRole("region", { name: "Guest threads" });
    await expect(queue).toBeVisible();
    await expect(page.getByText("Pick a thread")).toHaveCount(0);

    await queue.getByRole("button", { name: THREADS.ready }).click();
    await expect(page.getByRole("heading", { level: 2, name: THREADS.ready })).toBeVisible();
    await expect(queue).toHaveCount(0);
    await expectNoHorizontalOverflow(page);

    await takeThread(page);
    await page.getByRole("button", { name: "Send (simulated)" }).click();
    await expect(deliveryList(page, "Reply delivery").getByText("Delivered (simulated)")).toBeVisible();
    await expectNoHorizontalOverflow(page);

    await page.getByRole("button", { name: "All threads" }).click();
    await expect(page.getByRole("region", { name: "Guest threads" })).toBeVisible();
    await expect(rail(page)).toBeVisible();
  });
});
