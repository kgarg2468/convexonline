import { test, expect, devices } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GUESTS, THREADS, changePolicyPage, enterDemo, openInbox, openThread, takeThread } from "./helpers";

/**
 * Screenshot capture for the visual review. Opt in with SCREENSHOTS=1; the
 * files land in .context/build (repo-relative) so a reviewer can look at the
 * real workspace at desktop and phone widths. Uses only the anonymous demo,
 * never credentials. Runs under the desktop project; the phone shot opens its
 * own iPhone-sized context.
 *
 *   SCREENSHOTS=1 npx playwright test screenshots --project=desktop
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(here, "..", "..", "..", ".context", "build");

test.describe("screenshots", () => {
  test.skip(!process.env.SCREENSHOTS, "set SCREENSHOTS=1 to capture");

  test("desktop workspace: review after the policy change, and a claimed thread", async ({ page }) => {
    await enterDemo(page);
    await changePolicyPage(page);
    await expect(page.getByRole("article", { name: GUESTS.petFee })).toBeVisible();
    await page.screenshot({ path: path.join(outDir, "ui-workspace-desktop-review.png"), fullPage: true });

    await openInbox(page);
    await openThread(page, THREADS.ready);
    await takeThread(page);
    await page.screenshot({ path: path.join(outDir, "ui-workspace-desktop.png"), fullPage: false });
  });

  test("mobile workspace: review list and thread detail", async ({ browser }) => {
    const context = await browser.newContext({ ...devices["iPhone 13"] });
    const page = await context.newPage();
    try {
      await enterDemo(page);
      await changePolicyPage(page);
      await expect(page.getByRole("article", { name: GUESTS.petFee })).toBeVisible();
      // The hero click left the page scrolled to where the button was; show the top of the review instead.
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({ path: path.join(outDir, "ui-workspace-mobile-review.png"), fullPage: false });

      await openInbox(page);
      await openThread(page, THREADS.ready);
      await takeThread(page);
      await page.screenshot({ path: path.join(outDir, "ui-workspace-mobile.png"), fullPage: false });
    } finally {
      await context.close();
    }
  });
});
