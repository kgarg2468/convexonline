import { test, expect } from "@playwright/test";
import {
  GUESTS,
  THREADS,
  changePolicyPage,
  deliveryList,
  enterDemo,
  openInbox,
  openThread,
  rail,
  restorePolicyPage,
  reviewStrip,
} from "./helpers";

test.describe("policy change review", () => {
  test("the zero state explains the walkthrough and shows the page before anything changes", async ({ page }) => {
    await enterDemo(page);

    await expect(reviewStrip(page)).toContainText("0 replies need review");
    // All three tiles are there before anything changes, the pages-changed one at zero.
    await expect(reviewStrip(page).locator(":scope > *")).toHaveCount(3);
    await expect(reviewStrip(page)).toContainText("0 replies re-checked and still true");
    await expect(reviewStrip(page)).toContainText("0 pages changed");
    await expect(page.getByText("Nothing is edited until you press the button.")).toBeVisible();

    await page.getByRole("button", { name: "Read the policies page as it is now" }).click();
    await expect(page.locator(".fd-version-pane mark")).toHaveText("$25 per night pet fee");
    await expect(page.getByText("Check-in is from 3:00 PM to 8:00 PM.")).toBeVisible();
    // Still nothing changed: the rail count is zero and there is no restore button.
    await expect(rail(page).getByLabel("0 replies need review")).toBeVisible();
    await expect(page.getByRole("button", { name: "Restore original policy page" })).toHaveCount(0);
  });

  test("changing the page yields exactly 3 affected replies and 3 unaffected controls", async ({ page }) => {
    await enterDemo(page);
    await changePolicyPage(page);

    const strip = reviewStrip(page);
    await expect(strip).toContainText("3 replies need review");
    await expect(strip).toContainText("3 replies re-checked and still true");
    await expect(strip).toContainText("1 page changed");
    await expect(rail(page).getByLabel("3 replies need review")).toBeVisible();

    // Affected: the three replies that quoted the pet fee.
    for (const guest of [GUESTS.petFee, GUESTS.dog, GUESTS.twoDogs]) {
      const card = page.getByRole("article", { name: guest });
      await expect(card.getByText("Needs review")).toBeVisible();
      await expect(card.locator(".fd-quote--old")).toContainText("$25 per night pet fee");
      await expect(card.locator(".fd-quote--new")).toContainText("$40 per night pet fee");
    }
    const card = page.getByRole("article", { name: GUESTS.petFee });
    await expect(card.getByText("When the reply was sent")).toBeVisible();
    await expect(card.getByRole("link", { name: "/policies" })).toBeVisible();
    // Honest provenance: the proposal is a fixture with verified evidence, not a model output.
    // Exact: the status-reason hint also contains "demo fixture proposal" in prose.
    await expect(card.getByText("Demo fixture proposal", { exact: true })).toBeVisible();
    await expect(card.getByText(/Rests on: “.*\$40 per night pet fee/)).toBeVisible();
    // The exact message the guest received is available.
    await card.getByRole("button", { name: "Show the message as sent" }).click();
    await expect(card.getByText("Hi Priya, the pet fee is $25 per night, and dogs stay in our Garden Rooms.", { exact: false })).toBeVisible();

    // Unaffected controls: the three replies that quoted untouched passages.
    const controls = page.locator(".fd-controls");
    await expect(controls.getByText("Cancellations at least 7 days before arrival are fully refunded.")).toBeVisible();
    await expect(controls.getByRole("button", { name: THREADS.cancellation })).toBeVisible();
    await expect(controls.getByRole("button", { name: THREADS.lateArrival }).first()).toBeVisible();
    await expect(controls.getByRole("button", { name: THREADS.breakfast })).toBeVisible();
    await expect(controls.getByRole("button", { name: THREADS.petFee })).toHaveCount(0);

    // Before/after is still inspectable.
    await card.getByRole("button", { name: "Show stored page versions" }).click();
    await expect(card.getByText("Cited version")).toBeVisible();
    await expect(card.getByText("Current version")).toBeVisible();
    await expect(card.locator(".fd-version-pane mark").first()).toContainText("$25 per night pet fee");

    // The scripted edit is reversible and the hero is gone.
    await expect(page.getByRole("button", { name: "Restore original policy page" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Change the policy page" })).toHaveCount(0);
  });

  test("claim → approve with staff text → simulated send; delivery comes from the outbox", async ({ page }) => {
    await enterDemo(page);
    await changePolicyPage(page);

    const card = page.getByRole("article", { name: GUESTS.petFee });
    const text = card.getByLabel("Correction text");
    await expect(text).toHaveValue(/\$40 per night pet fee/);

    // Approval is a thread action: nothing can be approved until the thread is held.
    await expect(card.getByText("Nobody holds this thread. Approving or sending needs it.")).toBeVisible();
    await expect(text).toBeDisabled();
    await expect(card.getByRole("button", { name: "Approve correction" })).toBeDisabled();
    await card.getByRole("button", { name: "Take this thread" }).click();
    await expect(card.getByText(/You hold this thread until/)).toBeVisible();
    await expect(text).toBeEnabled();

    const custom = "Hi Priya, a quick correction: the pet fee is now $40 per night. Sorry for the mix-up.";
    await text.fill(custom);
    await card.getByRole("button", { name: "Approve correction" }).click();

    // Approved is not sent.
    await expect(card.getByText("Approved, not sent")).toBeVisible();
    await expect(card.getByText(custom)).toBeVisible();
    await expect(card.getByText("Staff-written")).toBeVisible();
    await expect(card.getByRole("button", { name: "Approve correction" })).toHaveCount(0);
    await expect(card.getByText("Correction sent")).toHaveCount(0);
    await expect(page.getByText("Approved, waiting to be sent")).toBeVisible();
    await expect(reviewStrip(page)).toContainText("2 replies need review");

    const send = card.getByRole("button", { name: "Send correction (simulated)" });
    await expect(send).toBeEnabled();
    await expect(card.getByText(/Simulated send into the guest's thread/)).toBeVisible();
    await send.click();

    await expect(card.getByText("Correction sent")).toBeVisible();
    await expect(deliveryList(card, "Correction delivery").getByText("Delivered (simulated)")).toBeVisible();
    await expect(card.getByRole("button", { name: "Send correction (simulated)" })).toHaveCount(0);
    await expect(page.getByText("Already reviewed")).toBeVisible();

    // The correction is now a message in the guest's thread and its claim reads as corrected.
    await card.getByRole("button", { name: "Open thread" }).click();
    await expect(page.getByRole("heading", { level: 2, name: THREADS.petFee })).toBeVisible();
    await expect(page.locator(".fd-msg--out").last()).toContainText(custom);
    await expect(deliveryList(page, "Correction delivery").getByText("Delivered (simulated)")).toBeVisible();
    await expect(page.getByRole("complementary", { name: "Sources for this draft" }).getByText("Corrected")).toBeVisible();
  });

  test("the thread view links to the review and the claim taken there carries over", async ({ page }) => {
    await enterDemo(page);
    await changePolicyPage(page);
    await openInbox(page);
    await openThread(page, THREADS.petFee);
    await page.getByRole("button", { name: "Take this thread" }).click();
    await expect(page.getByText(/You have this thread until/)).toBeVisible();
    await page.getByRole("button", { name: "Review the correction" }).click();
    const card = page.getByRole("article", { name: GUESTS.petFee });
    await expect(card.getByText(/You hold this thread until/)).toBeVisible();
    await expect(card.getByRole("button", { name: "Approve correction" })).toBeEnabled();
  });

  test("restoring the page removes the obsolete review instead of leaving it open", async ({ page }) => {
    await enterDemo(page);
    await changePolicyPage(page);
    await expect(reviewStrip(page)).toContainText("3 replies need review");

    await restorePolicyPage(page);

    await expect(reviewStrip(page)).toContainText("0 replies need review");
    await expect(rail(page).getByLabel("0 replies need review")).toBeVisible();
    await expect(page.getByText("Nothing to review")).toBeVisible();
    // The old proposals are kept for the record, marked superseded, and can neither be approved nor sent.
    const card = page.getByRole("article", { name: GUESTS.petFee }).first();
    await expect(card.getByText("Superseded")).toBeVisible();
    await expect(card.getByText("quote restored by a newer page version")).toBeVisible();
    await expect(card.getByRole("button", { name: /Approve|Send correction/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Change the policy page" })).toBeVisible();
  });
});
