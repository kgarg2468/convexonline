import { test, expect } from "@playwright/test";
import { randomBytes, randomUUID } from "node:crypto";
import {
  enterDemo,
  expectClean,
  expectNoInjectedMarkup,
  guardPage,
  openInbox,
  openThread,
  queue,
  rail,
  takeThread,
  THREADS,
  XSS_BLOB,
  XSS_PAYLOADS,
} from "./helpers";

/**
 * Security end-to-end checks (design-spec §6) against a deployed Front Desk.
 *
 * Every payload is typed into a real field through the real UI and read back
 * from the rendered DOM; nothing is injected into the page by the test. Each
 * test registers a dialog listener, so an `alert(1)` that ever fires fails the
 * test rather than silently passing, and a `pageerror` listener, so a payload
 * that breaks the app is a failure too.
 *
 * Not covered here, deliberately:
 * - the public inn website's escaping is exercised in the hosted-site test at
 *   the bottom (it needs a real staff account: the demo inn has no website
 *   editor and no editable settings field at all, since a demo visitor holds
 *   the `demo` role on a `isDemo` inn);
 * - the server-side rendering, headers and the id/limit validators are proven
 *   directly in `tests/security.test.ts`.
 */

const SUBJECT_PAYLOAD = XSS_PAYLOADS[0];
const MESSAGE_PAYLOAD = `${XSS_BLOB} — please advise`;
/** Every character here is legal in an HTML `type=email` field, so this is a real user-typed value. */
const EMAIL_PAYLOAD = `xss'+onerror=1@example.com`;

test.describe("XSS through the real write paths", () => {
  test("a simulated guest inquiry renders its payload as text in the queue and the thread", async ({ page }) => {
    test.setTimeout(120_000);
    const guards = guardPage(page);
    await enterDemo(page);
    await openInbox(page);

    await page.getByRole("button", { name: "Simulate a guest inquiry" }).click();
    await expect(page.getByRole("heading", { level: 2, name: "Simulate a guest inquiry" })).toBeVisible();
    await page.getByLabel("Guest email", { exact: true }).fill(EMAIL_PAYLOAD);
    await page.getByLabel("Subject", { exact: true }).fill(SUBJECT_PAYLOAD);
    await page.getByLabel("Message", { exact: true }).fill(MESSAGE_PAYLOAD);
    await page.getByRole("button", { name: "Create demo inquiry" }).click();

    // The thread opens on the created id. Subject, guest address and message
    // body all come back as the literal characters that were typed.
    const heading = page.getByRole("heading", { level: 2, name: SUBJECT_PAYLOAD });
    await expect(heading).toBeVisible();
    await expect(heading).toHaveText(SUBJECT_PAYLOAD);
    await expect(page.getByText(MESSAGE_PAYLOAD, { exact: true }).first()).toBeVisible();
    await expect(page.getByText(EMAIL_PAYLOAD).first()).toBeVisible();
    // And in the queue row beside it.
    await expect(queue(page).getByRole("button", { name: SUBJECT_PAYLOAD })).toBeVisible();

    await expectNoInjectedMarkup(page, "demo inquiry");
    expectClean(guards, "demo inquiry");

    // Search is the other place the stored text is read back.
    await page.getByLabel("Search subject, guest email or message").fill("please advise");
    await expect(queue(page).getByRole("button", { name: SUBJECT_PAYLOAD })).toBeVisible();
    await expectNoInjectedMarkup(page, "queue search results");
    expectClean(guards, "queue search results");
  });

  test("a payload saved as the gap answer is quoted back into the draft and its sources as text", async ({ page }) => {
    test.setTimeout(120_000);
    const guards = guardPage(page);
    await enterDemo(page);
    await openInbox(page);
    await openThread(page, THREADS.gap);
    await takeThread(page);

    const answer = `${XSS_BLOB} — the hot tub is shared.`;
    await page.getByLabel("Your answer").fill(answer);
    await page.getByLabel("Remember this for").selectOption("thread");
    await page.getByRole("button", { name: "Save answer" }).click();

    // The demo regenerates a draft citing the fact verbatim: the payload now
    // travels through the draft text, the citation and the source card.
    await expect(page.getByText("The website does not answer this")).toHaveCount(0);
    await expect(page.getByLabel("Draft reply text")).toHaveValue(new RegExp(escapeRe(answer)));
    const sources = page.getByRole("complementary", { name: "Sources for this draft" });
    await expect(sources.getByText(answer).first()).toBeVisible();

    await expectNoInjectedMarkup(page, "gap answer → draft");
    expectClean(guards, "gap answer → draft");
  });

  test("a payload saved as a staff fact renders as text in the Knowledge view", async ({ page }) => {
    test.setTimeout(120_000);
    const guards = guardPage(page);
    await enterDemo(page);
    await rail(page).getByRole("button", { name: "Knowledge" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Knowledge" })).toBeVisible();
    // The view leads with the three-tile strip; the seed has three watched pages and one staff fact.
    const strip = page.getByRole("group", { name: "Knowledge statistics" });
    await expect(strip.locator(":scope > *")).toHaveCount(3);
    await expect(strip).toContainText("3 pages captured");
    await expect(strip).toContainText("3 watched for changes");
    await expect(strip).toContainText("1 staff fact");

    const question = `${XSS_PAYLOADS[1]} Do you allow dogs?`;
    const answer = `${XSS_BLOB} — yes, in the Garden Rooms.`;
    await page.getByRole("button", { name: "Add a fact" }).click();
    await page.getByLabel("Question guests ask").fill(question);
    await page.getByLabel("Answer").fill(answer);
    await page.getByRole("button", { name: "Save fact" }).click();

    await expect(page.getByText(question, { exact: true })).toBeVisible();
    await expect(page.getByText(answer)).toBeVisible();
    await expect(strip).toContainText("2 staff facts");
    await expectNoInjectedMarkup(page, "staff fact");
    expectClean(guards, "staff fact");

    // The same fact seen from the thread that can cite it.
    await openInbox(page);
    await openThread(page, THREADS.dog);
    await expectNoInjectedMarkup(page, "thread after a payload fact");
    expectClean(guards, "thread after a payload fact");
  });
});

test.describe("hostile ids in the address bar", () => {
  test("a garbage thread id is simply the inbox with nothing open, and the inbox still works", async ({ page }) => {
    test.setTimeout(120_000);
    const guards = guardPage(page);
    await enterDemo(page);

    for (const bad of ["not-a-real-id", "%2e%2e%2f%2e%2e%2fadmin", "<script>alert(1)</script>", "../../etc/passwd"]) {
      await page.goto(`/inbox/${encodeURIComponent(bad)}`);
      await expect(page.getByRole("heading", { level: 1, name: "Inbox" })).toBeVisible();
      await expect(queue(page).getByRole("button", { name: THREADS.ready })).toBeVisible();
      await expect(page.getByText("Pick a thread")).toBeVisible();
      await expectNoInjectedMarkup(page, `/inbox/${bad}`);
    }

    // Still a working inbox: a real thread opens normally afterwards.
    await openThread(page, THREADS.ready);
    expectClean(guards, "garbage thread ids");
  });

  /**
   * A deep link the server refuses: a well-formed-looking id that is not a
   * Convex id, and a real thread id belonging to another visitor's demo inn.
   * Neither may show data, open a dialog, or leave the app unusable.
   */
  test("a refused thread deep link shows nothing of the other inn and the app stays usable", async ({ browser }) => {
    test.setTimeout(180_000);
    const other = await browser.newContext();
    const foreign = await other.newPage();
    const mine = await browser.newContext();
    const page = await mine.newPage();
    const guards = guardPage(page);
    try {
      // A second, independent demo visitor with their own seeded inn.
      await enterDemo(foreign);
      await openInbox(foreign);
      await openThread(foreign, THREADS.ready);
      const foreignThreadId = new URL(foreign.url()).pathname.split("/").filter(Boolean)[1]!;
      expect(foreignThreadId, "the open thread's id is in the address bar").toMatch(/^[a-z0-9]{16,64}$/i);

      await enterDemo(page);
      for (const id of ["k".repeat(32), foreignThreadId]) {
        await page.goto(`/inbox/${id}`);
        // The refusal is said in the thread pane; the queue (this visitor's
        // own inn, seeded with the same demo threads) stays up beside it.
        await expect(page.getByRole("region", { name: "This thread could not be opened." })).toBeVisible();
        // Nothing of the other inn's thread is rendered: no thread heading, no message.
        await expect(page.getByRole("heading", { level: 2, name: THREADS.ready })).toHaveCount(0);
        await expect(page.getByRole("article")).toHaveCount(0);
        await expect(page.getByText("Harbor View Rooms")).toHaveCount(0);
        await expectNoInjectedMarkup(page, `/inbox/${id.slice(0, 8)}…`);

        // The app is usable again straight away.
        await page.goto("/inbox");
        await expect(page.getByRole("heading", { level: 1, name: "Inbox" })).toBeVisible();
        await expect(queue(page).getByRole("button", { name: THREADS.ready })).toBeVisible();
      }

      expect(guards.dialogs, "a refused id must never open a dialog").toEqual([]);
      // The only errors allowed are the server's own refusals of threads.get.
      for (const error of guards.errors) expect(error).toMatch(/threads:get/);
    } finally {
      await other.close();
      await mine.close();
    }
  });

  test("a refused thread deep link renders the inbox with an honest thread pane, not a blank document", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const guards = guardPage(page);
    await enterDemo(page);
    // Passes router.ts's shape check, fails Convex's v.id("threads"): the server refuses it.
    await page.goto(`/inbox/${"k".repeat(32)}`);
    await expect(page.getByRole("heading", { name: "This thread could not be opened." })).toBeVisible();
    await expect(page.getByRole("button", { name: "Back to inbox" })).toBeVisible();
    await expect(page.locator("#fd-queue-filter")).toBeVisible();
    await page.getByRole("button", { name: "Back to inbox" }).click();
    await expect(page).toHaveURL(/\/inbox$/);
    await expect(page.getByRole("heading", { name: "This thread could not be opened." })).toHaveCount(0);
    expectClean(guards, "refused thread deep link");
  });

  test("a hostile invitation fragment is reported as not valid and is never reflected", async ({ page }) => {
    test.setTimeout(120_000);
    const guards = guardPage(page);
    const hostile = `<img src=x onerror=alert(1)>`;

    await page.goto(`/#invite=${encodeURIComponent(hostile)}`);
    await expect(page.getByRole("tab", { name: "Sign in" })).toBeVisible();
    await expect(page.getByText("The invitation link you opened is not valid.")).toBeVisible();
    expect(page.url(), "the fragment is stripped from the address bar").not.toContain("invite=");
    await expect(page.getByText(hostile)).toHaveCount(0);
    await expectNoInjectedMarkup(page, "hostile invitation fragment");

    // A well-formed but unknown token gets the ordinary invitation flow and,
    // for a demo visitor, the "waiting" screen rather than a silent accept.
    await page.goto(`/#invite=${randomBytes(32).toString("hex")}`);
    await expect(page.getByText("You have a staff invitation.")).toBeVisible();
    await page.getByRole("button", { name: "Open the demo workspace" }).click();
    await expect(page.getByRole("heading", { name: "Staff invitation waiting" })).toBeVisible();
    await expectNoInjectedMarkup(page, "unknown invitation token");
    expectClean(guards, "invitation fragments");
  });
});

/**
 * The public inn website is server-rendered HTML (convex/innWebsites.ts +
 * lib/innWebsiteHtml.ts), so it is the one surface where escaping is ours
 * rather than React's. The demo inn has no editor, so this test creates a
 * throwaway staff account and a fictional inn, exactly as inn-website.spec.ts
 * does: unique example.invalid address, random password held only in this
 * process, nothing read from the environment.
 */
test.describe("public inn website", () => {
  test("payloads saved in the website editor are escaped in the served HTML and inert in a browser", async ({
    browser,
    request,
  }) => {
    test.setTimeout(240_000);
    const context = await browser.newContext();
    const page = await context.newPage();
    const guards = guardPage(page);
    try {
      const who = {
        name: `Owner ${randomUUID().slice(0, 8)}`,
        email: `owner-${randomUUID().slice(0, 8)}@example.invalid`,
        password: randomBytes(18).toString("base64url"),
      };
      // §6 names the property name and the invitation label too; both are
      // owner-only fields on a real (non-demo) inn, so they belong to this test.
      const property = `Fictional Inn ${randomUUID().slice(0, 6)} ${XSS_PAYLOADS[0]}`;
      const inviteLabel = `Night desk ${XSS_PAYLOADS[3]}`;

      await page.goto("/");
      await page.getByRole("tab", { name: "Create staff account" }).click();
      await page.getByLabel("Your name").fill(who.name);
      await page.getByLabel("Email").fill(who.email);
      await page.getByLabel("Password").fill(who.password);
      await page.getByRole("button", { name: "Create account" }).click();
      await expect(page.getByRole("tab", { name: "Create staff account" })).toHaveCount(0, { timeout: 30_000 });

      await expect(page.getByText("Set up your first property.")).toBeVisible();
      await page.getByRole("radio", { name: /fictional inn/i }).check();
      await page.getByLabel("Property name").fill(property);
      await page.getByRole("button", { name: "Create fictional inn" }).click();
      // A real inn lands on Overview.
      await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible({ timeout: 30_000 });

      await rail(page).getByRole("button", { name: "Settings" }).click();
      await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible();

      // The property name a payload was typed into is read back as text.
      await expect(page.locator("dd").filter({ hasText: XSS_PAYLOADS[0] })).toHaveText(property);
      await expectNoInjectedMarkup(page, "property name");

      // The invitation label is the other owner-only free-text field.
      await page.getByLabel("Label (optional)").fill(inviteLabel);
      await page.getByRole("button", { name: "Create invitation link" }).click();
      const invitations = page.getByRole("list", { name: "Invitations" });
      await expect(invitations.getByRole("listitem").filter({ hasText: inviteLabel })).toContainText("Open");
      await expectNoInjectedMarkup(page, "invitation label");
      // The one-use token appears in the link field only, never in the list.
      await expect(page.getByLabel("Invitation link")).toHaveValue(/#invite=[0-9a-f]{64}$/);
      await expect(invitations).not.toContainText("#invite=");

      const editor = page.getByRole("region", { name: "Public website" });
      const siteUrl = await editor.getByRole("link", { name: "Open the public website" }).getAttribute("href");
      expect(siteUrl).toMatch(/^https:\/\/[^/]+\/inn\/[A-Za-z0-9]{8,64}\/$/);

      await editor.getByLabel("Public name").fill(XSS_PAYLOADS[1]);
      await editor.getByLabel("Pet policy").fill(XSS_BLOB);
      await editor.getByLabel("Current notice").fill(XSS_PAYLOADS[3]);
      await editor.getByLabel("Wi-Fi").fill(XSS_PAYLOADS[0]);
      await editor.getByRole("button", { name: "Save website" }).click();
      await expect(editor.getByText(/^Website saved /)).toBeVisible({ timeout: 30_000 });

      // Over plain HTTP, with no cookies: the payloads are present as escaped
      // text and as nothing else, on every page, with the safety headers set.
      for (const path of ["", "policies", "rooms", "notices"]) {
        const res = await request.get(`${siteUrl}${path}`);
        expect(res.status(), path).toBe(200);
        const headers = res.headers();
        expect(headers["content-type"], path).toBe("text/html; charset=utf-8");
        expect(headers["x-content-type-options"], path).toBe("nosniff");
        const html = await res.text();
        expect(html, path).not.toMatch(/<script>alert/i);
        expect(html, path).not.toContain("<img src=x");
        expect(html, path).not.toContain("<svg/onload");
        expect(html, path).not.toMatch(/<[a-z][^>]*\son[a-z]+\s*=/i);
        expect(html, path).not.toMatch(/(?:href|src)\s*=\s*["']?\s*javascript:/i);
        expect(html, path).toContain("&lt;");
      }

      // And in a real browser tab: nothing executes, nothing is an element.
      const visitor = await context.newPage();
      const visitorGuards = guardPage(visitor);
      await visitor.goto(`${siteUrl}policies`);
      await expect(visitor.getByRole("note")).toContainText("Fictional inn");
      await expect(visitor.getByRole("heading", { level: 1 })).toHaveText(XSS_PAYLOADS[1]);
      await expectNoInjectedMarkup(visitor, "public policies page");
      expectClean(visitorGuards, "public policies page");
      await visitor.close();

      expectClean(guards, "website editor");
    } finally {
      await context.close();
    }
  });
});

function escapeRe(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
