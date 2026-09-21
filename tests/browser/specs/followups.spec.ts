import { test, expect, type Page } from "@playwright/test";
import { THREADS, deliveryList, enterDemo, openInbox, openThread, takeThread } from "./helpers";

/**
 * Approved follow-up email on the seeded "Weekend rates" inquiry: the demo's
 * simulated reply arms the 48 h reminder (reminder-only), and only the
 * explicit approval here schedules mail. Nothing waits for the due time: the
 * due worker is covered by the integration suite, so the browser flow asserts
 * that no delivery is ever queued.
 */
const FOLLOW_UP_TEXT = "Just checking whether you still need help with your inquiry. Reply here if you have any questions.";

const panel = (page: Page) => page.getByRole("region", { name: "Follow-up email" });
const followUpDelivery = (page: Page) => page.locator('.fd-outbox[aria-label="Follow-up delivery"]');
const history = (page: Page) => page.locator(".fd-followup__history");

const pad = (n: number) => String(n).padStart(2, "0");
/** Local wall-clock text for a datetime-local input, matching the panel's own conversion. */
function localInput(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Runs in the page: the "UTC±HH:MM" offset the browser's zone uses at `ms`, as the panel labels it. */
function offsetLabelAt(ms: number): string {
  const offsetMin = -new Date(ms).getTimezoneOffset();
  const sign = offsetMin >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMin);
  const p = (n: number) => String(n).padStart(2, "0");
  return `UTC${sign}${p(Math.floor(abs / 60))}:${p(abs % 60)}`;
}

/** The instant the panel says the follow-up sends, read from its <time> element. */
async function shownDueAt(page: Page): Promise<number> {
  const iso = await panel(page).locator("time").first().getAttribute("datetime");
  expect(iso).not.toBeNull();
  return new Date(iso!).getTime();
}

test.describe("approved follow-up email", () => {
  test("simulated reply arms a reminder only; approval is explicit, claim-gated, exact-text, reschedulable and cancellable", async ({ page }) => {
    await enterDemo(page);
    await openInbox(page);
    await openThread(page, THREADS.ready);

    // Before the reply is sent nothing can be approved: the guest's message is unanswered.
    await expect(panel(page)).toHaveCount(0);
    await expect(page.getByText(/Reminder (set for|is due)/)).toHaveCount(0);

    await takeThread(page);
    await page.getByRole("button", { name: "Send (simulated)" }).click();
    await expect(deliveryList(page, "Reply delivery").getByText("Delivered (simulated)")).toBeVisible();

    // The reminder is armed and says so; it is not an email.
    await expect(page.getByText(/Reminder set for .* if the guest has not replied/)).toBeVisible();
    await expect(page.getByText("it never emails the guest")).toBeVisible();

    // The panel offers approval with the full exact text; nothing was approved by sending.
    const fu = panel(page);
    await expect(fu).toBeVisible();
    await expect(fu.getByText("Not approved")).toBeVisible();
    await expect(fu.getByText("Sending the reply did not approve it")).toBeVisible();
    await expect(fu.getByLabel("Proposed follow-up text")).toHaveText(FOLLOW_UP_TEXT);
    await expect(fu.getByText("Scheduled", { exact: true })).toHaveCount(0);
    await expect(history(page)).toHaveCount(0);
    await expect(followUpDelivery(page)).toHaveCount(0);

    // Default time: 48 h out in the browser's zone, which is named on the label
    // together with the offset that zone uses at the instant in the picker.
    const when = fu.getByLabel(/^Send at \(/);
    const tz = (await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone)) || "local time";
    const defaultValue = await when.inputValue();
    const defaultMs = new Date(defaultValue).getTime();
    const twoDays = 48 * 60 * 60 * 1000;
    expect(Math.abs(defaultMs - (Date.now() + twoDays))).toBeLessThan(5 * 60 * 1000);
    const defaultOffset = await page.evaluate(offsetLabelAt, defaultMs);
    await expect(fu.getByText(`Send at (${tz}, ${defaultOffset})`)).toBeVisible();

    // Approval needs the claim: released, the button is off and says why.
    await page.getByRole("button", { name: "Release" }).click();
    await expect(page.getByText("Nobody is working on this thread.")).toBeVisible();
    const approve = fu.getByRole("button", { name: "Approve follow-up email (simulated)" });
    await expect(approve).toBeDisabled();
    await expect(page.locator("#fd-followup-why")).toContainText("Take this thread to approve a follow-up.");
    await takeThread(page);
    await expect(approve).toBeEnabled();
    await expect(page.locator("#fd-followup-why")).toContainText("Simulated");

    // Unusable times are refused with feedback, and nothing is scheduled.
    await when.fill(localInput(new Date(Date.now() - 24 * 60 * 60 * 1000)));
    await approve.click();
    await expect(fu.getByRole("alert")).toContainText("must be scheduled between");
    await expect(fu.getByText("Scheduled", { exact: true })).toHaveCount(0);
    await when.fill(localInput(new Date(Date.now() + 40 * 24 * 60 * 60 * 1000)));
    await approve.click();
    await expect(fu.getByRole("alert")).toContainText("must be scheduled between");
    await expect(fu.getByText("Scheduled", { exact: true })).toHaveCount(0);

    // A chosen future instant is approved exactly as typed.
    const chosen = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
    chosen.setSeconds(0, 0);
    await when.fill(localInput(chosen));
    await approve.click();
    await expect(fu.getByText("Scheduled", { exact: true })).toBeVisible();
    await expect(fu.getByLabel("Approved follow-up text")).toHaveText(FOLLOW_UP_TEXT);
    expect(await shownDueAt(page)).toBe(chosen.getTime());
    await expect(fu.locator(".fd-followup__meta dd").nth(1)).toContainText(/^you/);
    await expect(fu.getByText(/nothing leaves this deployment/)).toBeVisible();
    await expect(fu.getByRole("button", { name: "Approve follow-up email (simulated)" })).toHaveCount(0);
    // Scheduled is not sent: no delivery row exists.
    await expect(followUpDelivery(page)).toHaveCount(0);
    await expect(fu.getByText(/^Sent/)).toHaveCount(0);

    // Rescheduling replaces the pending time and keeps the old approval as cancelled history.
    const later = new Date(chosen.getTime() + 24 * 60 * 60 * 1000);
    const reschedule = fu.getByRole("button", { name: "Reschedule follow-up (simulated)" });
    await expect(fu.getByLabel(/^New send time \(/)).toHaveValue(localInput(chosen));
    await fu.getByLabel(/^New send time \(/).fill(localInput(later));
    await reschedule.click();
    await expect.poll(() => shownDueAt(page)).toBe(later.getTime());
    await expect(history(page).getByText("Cancelled", { exact: true })).toBeVisible();
    await expect(history(page)).toContainText("rescheduled by staff");
    await expect(followUpDelivery(page)).toHaveCount(0);

    // Cancel: no pending approval, nothing queued, approval is offered again.
    await fu.getByRole("button", { name: "Cancel follow-up" }).click();
    await expect(fu.getByText("Not approved")).toBeVisible();
    await expect(fu.getByRole("button", { name: "Cancel follow-up" })).toHaveCount(0);
    await expect(history(page)).toContainText("cancelled by staff");
    await expect(history(page).getByText("Cancelled", { exact: true })).toHaveCount(2);
    await expect(followUpDelivery(page)).toHaveCount(0);
    await expect(fu.getByRole("button", { name: "Approve follow-up email (simulated)" })).toBeEnabled();

    // Approve again, then closing the thread withdraws it with the reason.
    await fu.getByRole("button", { name: "Approve follow-up email (simulated)" }).click();
    await expect(fu.getByText("Scheduled", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Close thread" }).click();
    await expect(page.locator(".fd-thread__head").getByText("Closed", { exact: true })).toBeVisible();
    await expect(fu.getByText("Scheduled", { exact: true })).toHaveCount(0);
    await expect(history(page)).toContainText("the thread was closed");
    await expect(fu.getByText("No follow-up can be approved: the thread is closed.")).toBeVisible();
    await expect(fu.getByRole("button", { name: /Approve follow-up email/ })).toHaveCount(0);
    await expect(followUpDelivery(page)).toHaveCount(0);
  });

  test.describe("in a DST-observing zone", () => {
    // Lord Howe Island moves its clocks forward by half an hour at 02:00 on
    // the first Sunday of October: on 2026-10-04 the local minutes 02:00-02:29
    // never happen (UTC+10:30 becomes UTC+11:00). Clocks fall back at 02:00 on
    // 2027-04-04, when 01:30-01:59 happen twice. The dates are fixed, so this
    // stays meaningful after they pass: the gap must fail parsing, before any
    // range check, rather than be normalised to a time nobody typed. The
    // repeated hour is only parsed (its offset label is checked), never
    // submitted: whether it lands inside the 30-day window depends on today.
    test.use({ timezoneId: "Australia/Lord_Howe" });

    test("a skipped local time is refused, offsets follow the typed instant, an ambiguous time parses", async ({ page }) => {
      await enterDemo(page);
      await openInbox(page);
      await openThread(page, THREADS.ready);
      await takeThread(page);
      await page.getByRole("button", { name: "Send (simulated)" }).click();
      await expect(deliveryList(page, "Reply delivery").getByText("Delivered (simulated)")).toBeVisible();

      const fu = panel(page);
      const when = fu.getByLabel(/^Send at \(/);
      const approve = fu.getByRole("button", { name: "Approve follow-up email (simulated)" });
      expect(await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone)).toBe("Australia/Lord_Howe");

      // The label's offset is the one in force at the instant typed, on either side of the transition.
      await when.fill("2026-10-03T12:00");
      await expect(fu.getByText("Send at (Australia/Lord_Howe, UTC+10:30)")).toBeVisible();
      await when.fill("2026-10-04T03:00");
      await expect(fu.getByText("Send at (Australia/Lord_Howe, UTC+11:00)")).toBeVisible();

      // Inside the spring-forward gap: refused as nonexistent, not normalised and range-checked.
      await when.fill("2026-10-04T02:15");
      await expect(fu.getByText("Send at (Australia/Lord_Howe)", { exact: true })).toBeVisible();
      await approve.click();
      await expect(fu.getByRole("alert")).toContainText("That time does not exist in Australia/Lord_Howe");
      await expect(fu.getByRole("alert")).not.toContainText("must be scheduled between");
      await expect(fu.getByText("Scheduled", { exact: true })).toHaveCount(0);

      // A repeated fall-back reading is a real instant: it parses to one of the
      // two offsets in force that hour. It is not submitted, since whether it
      // falls inside the scheduling window depends on when the test runs.
      await when.fill("2027-04-04T01:45");
      await expect(fu.getByText(/^Send at \(Australia\/Lord_Howe, UTC\+1[01]:[03]0\)$/)).toBeVisible();
      await expect(fu.getByText("Scheduled", { exact: true })).toHaveCount(0);

      // No value at all is a plain validation error, not a zone one. (The browser
      // itself rejects impossible calendar dates such as 31 November before the
      // panel sees them, so the picker cannot deliver one.)
      await when.fill("");
      await expect(fu.getByText("Send at (Australia/Lord_Howe)", { exact: true })).toBeVisible();
      await approve.click();
      await expect(fu.getByRole("alert")).toHaveText("Enter a valid date and time.");
      await expect(fu.getByText("Scheduled", { exact: true })).toHaveCount(0);
    });
  });

  test("a booked stay and an unanswered inquiry offer no follow-up", async ({ page }) => {
    await enterDemo(page);
    await openInbox(page);
    // Booked: the stay is not an inquiry, so no approval is offered.
    await openThread(page, THREADS.lateArrival);
    await expect(panel(page)).toHaveCount(0);
    // Open inquiry whose current message has no delivered reply yet.
    await openThread(page, THREADS.gap);
    await expect(panel(page)).toHaveCount(0);
  });
});
