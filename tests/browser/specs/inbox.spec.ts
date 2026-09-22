import { test, expect } from "@playwright/test";
import { THREADS, deliveryList, enterDemo, openInbox, openThread, queue, takeThread } from "./helpers";

test.describe("inbox", () => {
  test("claim → edit → explicit staff-authored simulated send, with delivery state from the outbox", async ({ page }) => {
    await enterDemo(page);
    await openInbox(page);

    // Statistics strip from the seed: six replies were sent 14 minutes after
    // their inquiry (convex/demo.ts), one thread is ready and one needs a
    // staff fact. "Replies today" follows the inn's local calendar day on the
    // real server clock, so only its shape (a count plus the zone) is checked;
    // exact per-day send counts are covered by the backend aggregate tests.
    const statsStrip = page.getByRole("list", { name: "Inbox statistics" });
    await expect(statsStrip).toContainText("Median first response 14 min");
    await expect(statsStrip).toContainText("2 open (1 need you, 1 ready)");
    await expect(statsStrip).toContainText(/\d+ (reply|replies) today \(inn time, /);

    await openThread(page, THREADS.ready);

    // Unclaimed: read-only draft, no editor, send blocked and explained.
    await expect(page.getByText("Take the thread to edit or send.")).toBeVisible();
    await expect(page.getByLabel("Draft reply text")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Close thread" })).toBeDisabled();
    const send = page.getByRole("button", { name: "Send (simulated)" });
    await expect(send).toBeDisabled();
    await expect(page.locator("#fd-send-why")).toContainText("Take this thread to send.");

    await takeThread(page);

    // Verified fixture text: sendable as is, and labelled as simulated.
    await expect(send).toBeEnabled();
    await expect(page.locator("#fd-send-why")).toContainText("Simulated send");

    const editor = page.getByLabel("Draft reply text");
    await expect(editor).toBeEnabled();
    const original = await editor.inputValue();
    expect(original).toContain("$299");

    const edited = `${original}\n\nP.S. Smoke test edit.`;
    await editor.fill(edited);
    await expect(page.getByText("Unsaved edits.")).toBeVisible();
    // Unsaved text can never be sent.
    await expect(send).toBeDisabled();
    await page.getByRole("button", { name: "Save edits" }).click();

    // Saved state is asserted through what persists, not the transient "Saved."
    // line: the editor holds the saved text, nothing is unsaved, and the edit
    // dropped the verdict, so status and provenance change and sending now
    // needs the explicit staff-authored confirmation.
    const draftPanel = page.getByRole("region", { name: "Draft reply" });
    await expect(page.getByText("Unsaved edits.")).toHaveCount(0);
    await expect(editor).toHaveValue(edited);
    await expect(draftPanel.getByText("Needs edit", { exact: true })).toBeVisible();
    await expect(draftPanel.getByText("Staff-written", { exact: true })).toBeVisible();
    await expect(send).toBeDisabled();
    await expect(page.locator("#fd-send-why")).toContainText("Your edit was not verified");
    const confirm = page.getByLabel(/Send this unverified, staff-written text as my own words/);
    await expect(confirm).toBeVisible();
    await confirm.check();
    await expect(send).toBeEnabled();

    // Persisted: leave and come back (the checkbox resets, the text does not).
    await openThread(page, THREADS.gap);
    await openThread(page, THREADS.ready);
    await expect(page.getByLabel("Draft reply text")).toHaveValue(edited);
    await page.getByLabel(/Send this unverified, staff-written text as my own words/).check();
    await page.getByRole("button", { name: "Send (simulated)" }).click();

    // Delivery state comes from the outbox row, honestly labelled as simulated.
    const delivery = deliveryList(page, "Reply delivery");
    await expect(delivery.getByText("Delivered (simulated)")).toBeVisible();
    await expect(delivery.getByText(/simulated, nothing left this deployment/)).toBeVisible();
    // The draft's own status pill reads Sent (scoped to the panel: the queue's
    // status filter also has a hidden "Sent" option).
    await expect(draftPanel.getByText("Sent", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Send (simulated)" })).toHaveCount(0);
    await expect(page.getByLabel("Draft reply text")).toHaveCount(0);
    // The sent text is now a message in the thread and the thread waits on the guest.
    await expect(page.locator(".fd-msg--out")).toContainText("P.S. Smoke test edit.");
    // The thread's own status pill (the queue's filter has a hidden "Waiting on guest" option too).
    await expect(page.locator(".fd-thread__head").getByText("Waiting on guest", { exact: true })).toBeVisible();

    // The strip follows the send: one fewer open thread, and the new first
    // response (hours after a 3-hour-old inquiry) leaves the median of the six
    // 14-minute seeds unchanged. "Replies today" keeps its shape.
    await expect(statsStrip).toContainText(/\d+ (reply|replies) today \(inn time, /);
    await expect(statsStrip).toContainText("Median first response 14 min");
    await expect(statsStrip).toContainText("1 open (1 need you, 0 ready)");
  });

  test("citations show the verbatim quote, the source path and whether the source is still current", async ({ page }) => {
    await enterDemo(page);
    await openInbox(page);
    await openThread(page, THREADS.ready);

    await expect(page.getByText("3 citations verified")).toBeVisible();
    await expect(page.getByText("Stays within sources")).toBeVisible();
    await expect(page.getByText("Demo fixture text")).toBeVisible();

    const sources = page.getByRole("complementary", { name: "Sources for this draft" });
    await expect(sources.getByText("Harbor View Rooms are $299 per night on Friday and Saturday.")).toBeVisible();
    await expect(
      sources.getByText("“Harbor View Rooms are $259 per night midweek and $299 per night on Friday and Saturday.”"),
    ).toBeVisible();
    await expect(sources.getByRole("link", { name: "/rates" }).first()).toHaveAttribute("href", /\/rates$/);
    await expect(sources.getByText(/Exact|Verified/).first()).toBeVisible();
    await expect(sources.getByText("Page current").first()).toBeVisible();
    await expect(sources.getByText("Is parking available?")).toHaveCount(0);
  });

  test("gap → saved fact → ready draft citing the fact → simulated send", async ({ page }) => {
    await enterDemo(page);
    await openInbox(page);
    await openThread(page, THREADS.gap);

    await expect(page.getByText("The website does not answer this")).toBeVisible();
    await expect(page.getByText("Is the hot tub open in December, and is it shared or private?")).toBeVisible();
    await expect(page.getByLabel("Your answer")).toBeDisabled();
    await expect(page.getByText("Take the thread to answer.")).toBeVisible();

    await takeThread(page);

    const answer = "Yes, the hot tub is open all winter and it is shared; reserve 30-minute private slots at the desk.";
    await page.getByLabel("Your answer").fill(answer);
    await page.getByLabel("Remember this for").selectOption("thread");
    await page.getByRole("button", { name: "Save answer" }).click();

    // facts.add regenerated the draft: the gap form is gone and a ready draft cites the fact.
    await expect(page.getByText("The website does not answer this")).toHaveCount(0);
    await expect(page.getByText("Ready", { exact: true })).toBeVisible();
    await expect(page.getByText("1 citation verified")).toBeVisible();
    await expect(page.getByLabel("Draft reply text")).toHaveValue(new RegExp(answer.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

    const sources = page.getByRole("complementary", { name: "Sources for this draft" });
    await expect(sources.getByText(answer).first()).toBeVisible();
    // Fact-sourced claims name the staff fact and never render the internal staff: reference as a link.
    await expect(sources.getByText(/Staff fact · You \(demo\)/)).toBeVisible();
    await expect(sources.getByText("Fact current")).toBeVisible();
    await expect(sources.locator('a[href^="staff:"]')).toHaveCount(0);

    // Verified exact text: no confirmation needed; the simulated send delivers.
    const send = page.getByRole("button", { name: "Send (simulated)" });
    await expect(send).toBeEnabled();
    await expect(page.getByLabel(/staff-written text as my own words/)).toHaveCount(0);
    await send.click();
    await expect(deliveryList(page, "Reply delivery").getByText("Delivered (simulated)")).toBeVisible();
    await expect(page.locator(".fd-msg--out")).toContainText(answer);
  });

  test("a simulated guest inquiry opens the created thread with a grounded draft or a gap question", async ({ page }) => {
    await enterDemo(page);
    await openInbox(page);

    await page.getByRole("button", { name: "Simulate a guest inquiry" }).click();
    await expect(page.getByRole("heading", { level: 2, name: "Simulate a guest inquiry" })).toBeVisible();
    await page.getByLabel("Start from an example").selectOption("dog");
    await page.getByRole("button", { name: "Create demo inquiry" }).click();

    // Opened by the returned thread id, not by guessing from the list.
    await expect(page.getByRole("heading", { level: 2, name: "Can our dog come along?" })).toBeVisible();
    await expect(page.getByText("Ready", { exact: true })).toBeVisible();
    const sources = page.getByRole("complementary", { name: "Sources for this draft" });
    await expect(sources.getByText("“Well-behaved dogs are welcome in the Garden Rooms”")).toBeVisible();
    await expect(queue(page).getByRole("button", { name: "Can our dog come along?" })).toBeVisible();

    await page.getByRole("button", { name: "Simulate a guest inquiry" }).click();
    await page.getByLabel("Start from an example").selectOption("gap");
    await page.getByRole("button", { name: "Create demo inquiry" }).click();
    await expect(page.getByRole("heading", { level: 2, name: "Bicycle storage" })).toBeVisible();
    await expect(page.getByText("The website does not answer this")).toBeVisible();
    await expect(page.getByText(/What should we tell j\.nakamura@example\.com about/)).toBeVisible();
  });

  test("keyboard: j/k move through the queue, Enter opens the focused row, and ⌘⏎ cannot send an unclaimed thread", async ({ page }) => {
    await enterDemo(page);
    await openInbox(page);
    const rows = queue(page).locator("[data-queue-row]");
    await expect(rows.first()).toBeVisible();

    // `j` starts at the first row (nothing was selected), then walks down; `k` walks back up.
    await page.keyboard.press("j");
    await expect(rows.first()).toBeFocused();
    await page.keyboard.press("j");
    await expect(rows.nth(1)).toBeFocused();
    await page.keyboard.press("k");
    await expect(rows.first()).toBeFocused();

    // Walk down to the ready thread (the seed's order is not assumed), then Enter opens it
    // as a keyboard selection: `aria-current` on the row, no bar animation, the heading up.
    const ready = rows.filter({ hasText: THREADS.ready });
    const count = await rows.count();
    for (let i = 0; i < count && !(await ready.evaluate((el) => el === document.activeElement)); i += 1) {
      await page.keyboard.press("j");
    }
    await expect(ready).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(ready).toHaveAttribute("aria-current", "true");
    await expect(ready).toHaveAttribute("data-motion", "keyboard");
    await expect(page.getByRole("heading", { level: 2, name: THREADS.ready })).toBeVisible();

    // ⌘⏎ / Ctrl+Enter must never get past the claim gate: the thread is not
    // taken, so nothing is sent and the send button stays disabled.
    await page.keyboard.press("ControlOrMeta+Enter");
    await expect(page.getByRole("button", { name: "Send (simulated)" })).toBeDisabled();
    await expect(page.locator("#fd-send-why")).toContainText("Take this thread to send.");
    await expect(deliveryList(page, "Reply delivery").getByText(/Delivered/)).toHaveCount(0);
  });

  test("search matches subject, guest email and message text", async ({ page }) => {
    await enterDemo(page);
    await openInbox(page);

    const search = page.getByLabel("Search subject, guest email or message");
    await search.fill("priya");
    await expect(queue(page).getByRole("button", { name: THREADS.petFee })).toBeVisible();
    await expect(queue(page).getByRole("button", { name: THREADS.ready })).toHaveCount(0);
    await expect(page.getByText(/Search covers subject, guest email and message preview/)).toBeVisible();

    await search.fill("flight");
    await expect(queue(page).getByRole("button", { name: THREADS.lateArrival })).toBeVisible();

    await search.fill("");
    await expect(queue(page).getByRole("button", { name: THREADS.ready })).toBeVisible();
  });
});
