import { test, expect, type Page } from "@playwright/test";
import { THREADS, deliveryList, enterDemo, openCorrections, openInbox, rail, reviewStrip, takeThread } from "./helpers";

/**
 * Regression for the paginated "re-checked and still true" controls
 * (convex/corrections.ts `unaffectedControls`, CorrectionsView.tsx).
 *
 * The seed has 6 sent replies and the controls query walks 25 sent replies
 * per page, so the seed alone never crosses a page boundary. This test sends
 * 20 more replies through the public demo UI (simulated inquiry → claim →
 * simulated send), so the inn has 26 sent replies and the review screen's
 * first page is partial: 25 replies loaded, one older reply not yet.
 *
 * Every new inquiry uses the "Late check-in" example text, whose fixture
 * quote ("Check-in is from 3:00 PM to 8:00 PM.") is word for word the same in
 * both stored policies versions. After the scripted page edit those 20 replies
 * are unaffected controls beside the 3 seeded ones (cancellation, late
 * arrival, breakfast/smoking), and the 3 seeded pet-fee replies stay affected.
 *
 * Expected counts after the edit:
 *   affected replies   3  (unchanged by the new inquiries)
 *   control replies   23  (20 new + 3 seeded)
 *   control passages  24  (late arrival quotes two untouched passages)
 *
 * Reply order for the walk is newest first, so the one reply left on the
 * second page is the oldest seeded reply (the affected "Bringing our dog in
 * October"): the control count is already 23 on the partial first page, and
 * loading the last page must not change it or duplicate anything.
 */
const NEW_INQUIRIES = 20;
const EXISTING_CONTROL_REPLIES = 3;
const EXISTING_CONTROL_PASSAGES = 4;
const AFFECTED_REPLIES = 3;

function subjectFor(i: number) {
  return `Check-in window for booking ${String(i).padStart(2, "0")} (pagination)`;
}

/** One inquiry through the inbox: simulate → opened by id → claim → simulated send delivered. */
async function sendCheckInInquiry(page: Page, i: number) {
  const subject = subjectFor(i);
  await page.getByRole("button", { name: "Simulate a guest inquiry" }).click();
  await expect(page.getByRole("heading", { level: 2, name: "Simulate a guest inquiry" })).toBeVisible();
  await page.getByLabel("Start from an example").selectOption("checkin");
  // Exact: the queue's search box is labelled "Search subject, guest email or message".
  await page.getByLabel("Guest email", { exact: true }).fill(`pagination.${String(i).padStart(2, "0")}@example.com`);
  await page.getByLabel("Subject", { exact: true }).fill(subject);
  await page.getByRole("button", { name: "Create demo inquiry" }).click();

  // The check-in fixture answers from the policies page, so the draft is ready to send as is.
  await expect(page.getByRole("heading", { level: 2, name: subject, exact: true })).toBeVisible();
  await expect(page.getByText("Ready", { exact: true })).toBeVisible();
  await takeThread(page);
  const send = page.getByRole("button", { name: "Send (simulated)" });
  await expect(send).toBeEnabled();
  await send.click();
  await expect(deliveryList(page, "Reply delivery").getByText("Delivered (simulated)")).toBeVisible();
  await expect(page.getByRole("button", { name: "Send (simulated)" })).toHaveCount(0);
}

test.describe("correction review pagination", () => {
  test("controls that span two pages of sent replies say so, load the rest on request and never double-count", async ({ page }) => {
    // 20 create → claim → send cycles against the real backend; well above the default budget.
    test.setTimeout(120_000);
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));

    await enterDemo(page);
    await openInbox(page);
    for (let i = 1; i <= NEW_INQUIRIES; i += 1) {
      await sendCheckInInquiry(page, i);
    }

    // 26 sent replies now exceed one page, so the review screen can no longer
    // claim the whole history was checked before the edit: no zero-state hero,
    // only the compact demo control, and the strip says older replies are unloaded.
    await openCorrections(page);
    const strip = reviewStrip(page);
    await expect(strip).toContainText("0 replies need review");
    await expect(strip).toContainText("0 replies re-checked so far and still true, older replies not loaded yet");
    await expect(page.getByRole("region", { name: /Nothing needs a second look yet/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Load more sent replies" })).toBeVisible();

    // The scripted edit re-checks every sent claim of the page in one pass (not paginated).
    await page.getByRole("button", { name: "Change the policy page" }).click();
    await expect(
      page.getByRole("status").filter({
        hasText: `Policies page changed: ${AFFECTED_REPLIES} replies to review, ${NEW_INQUIRIES + EXISTING_CONTROL_REPLIES} unaffected.`,
      }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Restore original policy page" })).toBeVisible();

    // Partial first page: honest copy, and the count covers only loaded replies.
    const controlReplies = NEW_INQUIRIES + EXISTING_CONTROL_REPLIES;
    const controlPassages = NEW_INQUIRIES + EXISTING_CONTROL_PASSAGES;
    await expect(strip).toContainText(`${AFFECTED_REPLIES} replies need review`);
    await expect(strip).toContainText(`${controlReplies} replies re-checked so far and still true (${controlPassages} passages)`);
    await expect(strip).toContainText("older replies not loaded yet");
    await expect(strip).not.toContainText("not verified");
    await expect(rail(page).getByLabel(`${AFFECTED_REPLIES} replies need review`)).toBeVisible();

    const controls = page.locator(".fd-controls");
    const controlRows = controls.locator("li.fd-control");
    await expect(controlRows).toHaveCount(controlPassages);
    for (let i = 1; i <= NEW_INQUIRIES; i += 1) {
      await expect(controls.getByRole("button", { name: subjectFor(i), exact: true })).toHaveCount(1);
    }
    await expect(controls.getByRole("button", { name: THREADS.cancellation, exact: true })).toHaveCount(1);
    await expect(controls.getByRole("button", { name: THREADS.breakfast, exact: true })).toHaveCount(1);
    await expect(controls.getByRole("button", { name: THREADS.lateArrival, exact: true })).toHaveCount(2);
    await expect(controls.getByRole("button", { name: THREADS.petFee, exact: true })).toHaveCount(0);
    await expect(controls.getByRole("button", { name: THREADS.dog, exact: true })).toHaveCount(0);
    await expect(controls.getByRole("button", { name: THREADS.twoDogs, exact: true })).toHaveCount(0);

    // The affected set is untouched by the extra history: the three pet-fee replies, once each.
    const needsReview = page.getByRole("article").filter({ hasText: "Needs review" });
    await expect(needsReview).toHaveCount(AFFECTED_REPLIES);
    await expect(page.getByRole("article", { name: /Priya N/ })).toHaveCount(1);
    await expect(page.getByRole("article", { name: /Dana Ruiz/ })).toHaveCount(1);
    await expect(page.getByRole("article", { name: /Kai M/ })).toHaveCount(1);

    // Load the last page: the copy stops hedging, the total is exact and nothing was listed twice.
    await page.getByRole("button", { name: "Load more sent replies" }).click();
    await expect(page.getByRole("button", { name: /Load more sent replies|Loading older sent replies/ })).toHaveCount(0);
    await expect(strip).toContainText(`${controlReplies} replies re-checked and still true (${controlPassages} passages)`);
    await expect(strip).not.toContainText("so far");
    await expect(strip).not.toContainText("older replies not loaded yet");
    await expect(strip).not.toContainText("not verified");
    await expect(controlRows).toHaveCount(controlPassages);
    for (let i = 1; i <= NEW_INQUIRIES; i += 1) {
      await expect(controls.getByRole("button", { name: subjectFor(i), exact: true })).toHaveCount(1);
    }
    await expect(controls.getByRole("button", { name: THREADS.lateArrival, exact: true })).toHaveCount(2);
    await expect(controls.getByRole("button", { name: THREADS.dog, exact: true })).toHaveCount(0);
    await expect(needsReview).toHaveCount(AFFECTED_REPLIES);
    await expect(strip).toContainText(`${AFFECTED_REPLIES} replies need review`);

    expect(pageErrors, "no uncaught page errors during the flow").toEqual([]);
  });
});
