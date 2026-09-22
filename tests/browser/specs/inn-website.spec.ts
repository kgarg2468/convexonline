import { test, expect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { randomBytes, randomUUID } from "node:crypto";

/**
 * Hosted fictional inn websites against a deployed Front Desk, end to end.
 *
 * Every account is created during the run (unique example.invalid address,
 * random password that exists only in this process); nothing is read from the
 * environment or a file. Creating a fictional inn and saving its website only
 * write the website document: no crawl, no mailbox, no drafting, so no
 * Firecrawl, AgentMail or OpenAI call happens anywhere in these tests. The
 * public site is read back over plain HTTP (no cookies) and in a browser tab.
 * Screenshots go to the configured output directory (PW_OUTPUT_DIR).
 */

type Account = { name: string; email: string; password: string };

function account(role: string): Account {
  const id = randomUUID().slice(0, 8);
  return {
    name: `${role[0]!.toUpperCase()}${role.slice(1)} ${id}`,
    email: `${role}-${id}@example.invalid`,
    password: randomBytes(18).toString("base64url"),
  };
}

async function signUp(page: Page, who: Account) {
  await page.getByRole("tab", { name: "Create staff account" }).click();
  await page.getByLabel("Your name").fill(who.name);
  await page.getByLabel("Email").fill(who.email);
  await page.getByLabel("Password").fill(who.password);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("tab", { name: "Create staff account" })).toHaveCount(0, { timeout: 30_000 });
}

/** The pre-existing external flow, exactly as teams.spec.ts drives it. */
async function createExternalProperty(page: Page, name: string) {
  await expect(page.getByText("Set up your first property.")).toBeVisible();
  await page.getByLabel("Property name").fill(name);
  await page.getByLabel("Website").fill("https://example.com/");
  await page.getByRole("button", { name: "Create property" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Inbox" })).toBeVisible();
}

async function createFictionalInn(page: Page, name: string) {
  await expect(page.getByText("Set up your first property.")).toBeVisible();
  await page.getByRole("radio", { name: /fictional inn/i }).check();
  // No external URL is ever typed for a hosted site.
  await expect(page.getByLabel("Website")).toHaveCount(0);
  await expect(page.getByText("This creates a public website with illustrative policies.")).toBeVisible();
  await page.getByLabel("Property name").fill(name);
  await page.getByRole("button", { name: "Create fictional inn" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Inbox" })).toBeVisible({ timeout: 30_000 });
}

async function openSettings(page: Page) {
  await page.getByRole("navigation", { name: "Workspace" }).getByRole("button", { name: "Settings" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible();
}

async function openKnowledge(page: Page) {
  await page.getByRole("navigation", { name: "Workspace" }).getByRole("button", { name: "Knowledge" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Knowledge" })).toBeVisible();
}

const website = (page: Page) => page.getByRole("region", { name: "Public website" });
const invitations = (page: Page) => page.getByRole("list", { name: "Invitations" });

async function createInvitation(page: Page, label: string): Promise<string> {
  await page.getByLabel("Label (optional)").fill(label);
  await page.getByRole("button", { name: "Create invitation link" }).click();
  const link = page.getByLabel("Invitation link");
  await expect(link).toBeVisible();
  const value = await link.inputValue();
  await expect(invitations(page).getByRole("listitem").filter({ hasText: label })).toContainText("Open");
  return value;
}

async function fresh(browser: Browser): Promise<{ context: BrowserContext; page: Page; errors: string[] }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  return { context, page, errors };
}

async function signIn(page: Page, who: Account) {
  await expect(page.getByRole("tab", { name: "Sign in" })).toBeVisible();
  await page.getByLabel("Email").fill(who.email);
  await page.getByLabel("Password").fill(who.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("tab", { name: "Sign in" })).toHaveCount(0, { timeout: 30_000 });
}

/**
 * A deterministic transport delay for one Convex mutation, without touching
 * the app or the backend. The page's sync WebSocket is proxied through
 * Playwright: every frame is forwarded to the real deployment unchanged, except
 * that the client→server frame carrying the named mutation is parked until the
 * test releases it. The mutation then really runs on the server; only its
 * departure was delayed, so the UI's pending state can be observed for exactly
 * as long as the test needs. Must be installed before the first navigation.
 */
async function gateMutations(page: Page) {
  let target: string | null = null;
  const parked: Array<() => void> = [];
  await page.routeWebSocket(/\/api\/[^/]+\/sync/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((frame) => {
      if (
        target !== null &&
        typeof frame === "string" &&
        frame.includes('"type":"Mutation"') &&
        frame.includes(`"udfPath":"${target}"`)
      ) {
        parked.push(() => server.send(frame));
        return;
      }
      server.send(frame);
    });
    server.onMessage((frame) => ws.send(frame));
    ws.onClose((code, reason) => void server.close({ code, reason }));
    server.onClose((code, reason) => void ws.close({ code, reason }));
  });
  return {
    /** From now on, park the next frame(s) that carry this mutation. */
    hold(udfPath: string) {
      target = udfPath;
    },
    /** Resolves once a parked frame exists, i.e. the app is genuinely waiting on the server. */
    async parked() {
      await expect.poll(() => parked.length, { message: "the mutation frame was captured in transit" }).toBe(1);
    },
    /** Let the parked frame(s) through and stop parking. */
    release() {
      target = null;
      for (const send of parked.splice(0)) send();
    },
  };
}

/** Hosted site root: https origin plus /inn/<id>/ and nothing else. */
const HOSTED_ROOT = /^https:\/\/[^/]+\/inn\/[A-Za-z0-9]{8,64}\/$/;

test.describe("hosted fictional inn website", () => {
  test("owner creates a fictional inn, edits its public policy, the HTML changes and persists; staff cannot edit", async ({
    browser,
    request,
  }) => {
    test.setTimeout(240_000);
    const owner = account("owner");
    const staff = account("staff");
    const property = `Fictional Inn ${randomUUID().slice(0, 6)}`;
    const marker = `policy-${randomUUID().slice(0, 8)}`;
    const policyText = `Dogs must be leashed in the garden. Reference ${marker}.`;

    const a = await fresh(browser);
    const b = await fresh(browser);
    try {
      await a.page.goto("/");
      await signUp(a.page, owner);
      await createFictionalInn(a.page, property);
      await expect(a.page.getByRole("navigation", { name: "Workspace" })).toContainText(property);

      // Settings: the editor is there, showing the server's content, with nothing to save yet.
      await openSettings(a.page);
      const editor = website(a.page);
      await expect(editor).toBeVisible();
      await expect(editor.getByText("labelled as a fictional inn")).toBeVisible();
      const save = editor.getByRole("button", { name: "Save website" });
      await expect(save).toBeDisabled();
      await expect(editor.getByText("No unsaved changes.")).toBeVisible();
      await expect(editor.getByLabel("Public name")).toHaveValue(property);
      await expect(editor.getByLabel("Pet fee per dog per night (USD)")).toHaveValue("25");
      const siteUrl = await editor.getByRole("link", { name: "Open the public website" }).getAttribute("href");
      expect(siteUrl, "the site URL is the server-chosen hosted root").toMatch(HOSTED_ROOT);
      // The inn record's website is that same hosted address.
      await expect(a.page.getByRole("link", { name: siteUrl! })).toBeVisible();
      await a.page.screenshot({ path: test.info().outputPath("editor-before.png"), fullPage: true });

      // Public HTTP, no cookies: the seeded defaults render, labelled fictional, with no private data.
      const before = await request.get(`${siteUrl}policies`);
      expect(before.status()).toBe(200);
      expect(before.headers()["content-type"]).toContain("text/html");
      const beforeHtml = await before.text();
      expect(beforeHtml).toContain("Fictional inn");
      expect(beforeHtml).toContain(`${property} (fictional inn)`);
      expect(beforeHtml).toContain("$25 per dog per night");
      expect(beforeHtml).not.toContain(marker);
      expect(beforeHtml, "no staff email on the public site").not.toContain(owner.email);
      expect(beforeHtml, "no staff name on the public site").not.toContain(owner.name);
      expect(beforeHtml, "no password on the public site").not.toContain(owner.password);

      // Edit two fields: the form goes dirty, the save is explicit.
      await editor.getByLabel("Pet fee per dog per night (USD)").fill("40");
      await editor.getByLabel("Pet policy").fill(policyText);
      await expect(editor.getByText("Unsaved changes. Saving publishes them immediately.")).toBeVisible();
      await expect(save).toBeEnabled();
      await save.click();
      await expect(editor.getByText(/^Website saved /)).toBeVisible({ timeout: 30_000 });
      await expect(save).toBeDisabled();
      await expect(editor.getByRole("button", { name: "Discard changes" })).toHaveCount(0);
      await a.page.screenshot({ path: test.info().outputPath("editor-after-save.png"), fullPage: true });

      // The public HTML now says the new thing, and only the new thing.
      const after = await request.get(`${siteUrl}policies`);
      expect(after.status()).toBe(200);
      const afterHtml = await after.text();
      expect(afterHtml).toContain("$40 per dog per night");
      expect(afterHtml).toContain(marker);
      expect(afterHtml).not.toContain("$25 per dog per night");
      expect(afterHtml).not.toContain(owner.email);
      expect(afterHtml).not.toContain(owner.name);
      const home = await request.get(siteUrl!);
      expect(home.status()).toBe(200);
      expect(await home.text()).toContain("$40 per dog per night");

      // The same site in a browser tab: clearly fictional to a visitor.
      const visitor = await a.context.newPage();
      await visitor.goto(`${siteUrl}policies`);
      await expect(visitor.getByRole("note")).toContainText("Fictional inn");
      await expect(visitor.getByRole("heading", { level: 1 })).toHaveText(property);
      await expect(visitor.getByText(marker)).toBeVisible();
      await visitor.screenshot({ path: test.info().outputPath("public-policies.png"), fullPage: true });
      await visitor.close();

      // Saving the website never crawls: nothing was captured.
      await openKnowledge(a.page);
      await expect(a.page.getByText("No crawl has run yet.")).toBeVisible();
      await expect(a.page.getByText("No pages captured yet")).toBeVisible();

      // Reload: the saved values come back from the server, not from this tab.
      // The URL keeps the view, so the reload lands back on Knowledge.
      await a.page.reload();
      await expect(a.page.getByRole("heading", { level: 1, name: "Knowledge" })).toBeVisible({ timeout: 30_000 });
      await openSettings(a.page);
      await expect(website(a.page).getByLabel("Pet fee per dog per night (USD)")).toHaveValue("40");
      await expect(website(a.page).getByLabel("Pet policy")).toHaveValue(policyText);
      await expect(website(a.page).getByRole("button", { name: "Save website" })).toBeDisabled();

      // A staff member joins by invitation: sees the public site, gets no editor.
      const link = await createInvitation(a.page, "Night desk");
      await b.page.goto(link);
      await signUp(b.page, staff);
      await b.page.getByRole("button", { name: `Join ${property}` }).click();
      await expect(b.page.getByRole("heading", { level: 1, name: "Inbox" })).toBeVisible();
      await openSettings(b.page);
      const staffView = website(b.page);
      await expect(staffView).toBeVisible();
      await expect(staffView.getByText("Only the inn owner can edit the website.")).toBeVisible();
      await expect(staffView.getByRole("link", { name: "Open the public website" })).toHaveAttribute("href", siteUrl!);
      await expect(staffView).toContainText("$40 per dog per night");
      await expect(staffView.getByRole("button", { name: "Save website" })).toHaveCount(0);
      await expect(staffView.getByLabel("Pet policy")).toHaveCount(0);
      await expect(staffView.locator("input, textarea")).toHaveCount(0);
      await b.page.screenshot({ path: test.info().outputPath("staff-view.png"), fullPage: true });

      expect(a.errors, "no uncaught errors in the owner's tab").toEqual([]);
      expect(b.errors, "no uncaught errors in the staff tab").toEqual([]);
    } finally {
      await a.context.close();
      await b.context.close();
    }
  });

  test("the same owner in two sessions: a dirty draft survives the other session's save, discard loads the latest, saving overwrites deliberately; controls lock while a request is in flight", async ({
    browser,
    request,
  }) => {
    test.setTimeout(240_000);
    const owner = account("owner");
    const property = `Fictional Inn ${randomUUID().slice(0, 6)}`;
    const marker = randomUUID().slice(0, 8);
    const draftPolicy = `Draft one ${marker}: dogs must be leashed in the garden.`;
    const finalPolicy = `Draft two ${marker}: dogs must be leashed everywhere.`;
    const otherWifi = `Wi-Fi note from the other session ${marker}.`;
    const defaultPolicy =
      "Dogs are welcome in our designated pet-friendly rooms. Please let us know when booking so we can assign a suitable room.";
    const defaultWifi = "Free Wi-Fi is available throughout the inn.";

    const a = await fresh(browser);
    const b = await fresh(browser);
    try {
      const gate = await gateMutations(a.page);

      // Session A: sign up and create the fictional inn. The create request is
      // parked in transit, so the pending state is observable: the kind cannot
      // be switched under a create that already left with the other kind.
      await a.page.goto("/");
      await signUp(a.page, owner);
      await expect(a.page.getByText("Set up your first property.")).toBeVisible();
      const external = a.page.getByRole("radio", { name: /real property/i });
      const fictional = a.page.getByRole("radio", { name: /fictional inn/i });
      await fictional.check();
      await expect(a.page.getByLabel("Website")).toHaveCount(0);
      await a.page.getByLabel("Property name").fill(property);
      gate.hold("innWebsites:createFictional");
      await a.page.getByRole("button", { name: "Create fictional inn" }).click();
      await gate.parked();
      await expect(a.page.getByRole("button", { name: "Creating…" })).toBeDisabled();
      await expect(external).toBeDisabled();
      await expect(fictional).toBeDisabled();
      await expect(fictional).toBeChecked();
      await expect(a.page.getByLabel("Website")).toHaveCount(0);
      await a.page.screenshot({ path: test.info().outputPath("create-pending.png"), fullPage: true });
      gate.release();
      await expect(a.page.getByRole("heading", { level: 1, name: "Inbox" })).toBeVisible({ timeout: 30_000 });
      await expect(a.page.getByRole("navigation", { name: "Workspace" })).toContainText(property);
      await openSettings(a.page);
      const editorA = website(a.page);
      const saveA = editorA.getByRole("button", { name: "Save website" });
      await expect(editorA.getByLabel("Pet policy")).toHaveValue(defaultPolicy);
      const siteUrl = await editorA.getByRole("link", { name: "Open the public website" }).getAttribute("href");
      expect(siteUrl).toMatch(HOSTED_ROOT);

      // Session B: the same owner signs in elsewhere and lands in the same editor.
      await b.page.goto("/");
      await signIn(b.page, owner);
      await expect(b.page.getByRole("heading", { level: 1, name: "Inbox" })).toBeVisible({ timeout: 30_000 });
      await openSettings(b.page);
      const editorB = website(b.page);
      const saveB = editorB.getByRole("button", { name: "Save website" });
      await expect(editorB.getByLabel("Pet policy")).toHaveValue(defaultPolicy);
      await expect(editorB.getByLabel("Check-in time")).toHaveValue("3:00 PM");

      // A starts a draft and does not save. B saves a different field.
      await editorA.getByLabel("Pet policy").fill(draftPolicy);
      await expect(editorA.getByText("Unsaved changes. Saving publishes them immediately.")).toBeVisible();
      await expect(editorA.getByText(/saved from another session/)).toHaveCount(0);
      await editorB.getByLabel("Check-in time").fill("4:00 PM");
      await saveB.click();
      await expect(editorB.getByText(/^Website saved /)).toBeVisible({ timeout: 30_000 });

      // A's draft is intact, still based on the version it started from, and
      // A is told that the site changed underneath it.
      await expect(editorA.getByText(/saved from another session since you started editing/)).toBeVisible();
      await expect(editorA.getByLabel("Pet policy")).toHaveValue(draftPolicy);
      await expect(editorA.getByLabel("Check-in time")).toHaveValue("3:00 PM");
      await expect(saveA).toBeEnabled();
      await expect(editorA.getByRole("button", { name: "Discard changes" })).toBeEnabled();
      await a.page.screenshot({ path: test.info().outputPath("draft-changed-elsewhere.png"), fullPage: true });

      // Discard: the form shows the latest server version, warning gone.
      await editorA.getByRole("button", { name: "Discard changes" }).click();
      await expect(editorA.getByLabel("Pet policy")).toHaveValue(defaultPolicy);
      await expect(editorA.getByLabel("Check-in time")).toHaveValue("4:00 PM");
      await expect(editorA.getByText(/saved from another session/)).toHaveCount(0);
      await expect(editorA.getByText("No unsaved changes.")).toBeVisible();
      await expect(saveA).toBeDisabled();
      await expect(editorA.getByRole("button", { name: "Discard changes" })).toHaveCount(0);

      // Deliberate overwrite: A drafts again, B saves Wi-Fi meanwhile, A saves anyway.
      await editorA.getByLabel("Pet policy").fill(finalPolicy);
      await expect(editorA.getByLabel("Wi-Fi")).toHaveValue(defaultWifi);
      await editorB.getByLabel("Wi-Fi").fill(otherWifi);
      await saveB.click();
      await expect(editorB.getByText(/^Website saved /)).toBeVisible({ timeout: 30_000 });
      await expect(editorA.getByText(/saved from another session since you started editing/)).toBeVisible();
      await expect(editorA.getByLabel("Wi-Fi")).toHaveValue(defaultWifi);

      // A's save is parked in transit: every field, Save and Discard are locked
      // and the status says so, until the request is let through.
      gate.hold("innWebsites:update");
      await saveA.click();
      await gate.parked();
      await expect(editorA.getByRole("button", { name: "Saving…" })).toBeDisabled();
      await expect(editorA.getByRole("button", { name: "Discard changes" })).toBeDisabled();
      await expect(
        editorA.getByRole("status").filter({ hasText: "Saving to the public website…" }),
      ).toHaveText("Saving to the public website…");
      await expect(editorA.locator("input:disabled, textarea:disabled")).toHaveCount(11);
      await expect(editorA.locator("input:enabled, textarea:enabled")).toHaveCount(0);
      await expect(editorA.getByLabel("Pet policy")).toHaveValue(finalPolicy);
      await a.page.screenshot({ path: test.info().outputPath("save-pending.png"), fullPage: true });
      gate.release();
      await expect(editorA.getByText(/^Website saved /)).toBeVisible({ timeout: 30_000 });
      await expect(editorA.getByText(/saved from another session/)).toHaveCount(0);
      await expect(saveA).toBeDisabled();
      await expect(editorA.locator("input:disabled, textarea:disabled")).toHaveCount(0);
      await expect(editorA.getByLabel("Pet policy")).toHaveValue(finalPolicy);
      await expect(editorA.getByLabel("Check-in time")).toHaveValue("4:00 PM");
      await expect(editorA.getByLabel("Wi-Fi")).toHaveValue(defaultWifi);

      // B sees A's version: A's policy, B's earlier check-in, B's Wi-Fi overwritten.
      await expect(editorB.getByLabel("Pet policy")).toHaveValue(finalPolicy);
      await expect(editorB.getByLabel("Check-in time")).toHaveValue("4:00 PM");
      await expect(editorB.getByLabel("Wi-Fi")).toHaveValue(defaultWifi);
      await expect(saveB).toBeDisabled();
      await b.page.screenshot({ path: test.info().outputPath("other-session-after-overwrite.png"), fullPage: true });

      // The public site says the same.
      const policies = await request.get(`${siteUrl}policies`);
      expect(policies.status()).toBe(200);
      const policiesHtml = await policies.text();
      expect(policiesHtml).toContain(finalPolicy);
      expect(policiesHtml).not.toContain(draftPolicy);
      const pages = await editorA.getByRole("list", { name: "Public pages" }).getByRole("link").evaluateAll((links) =>
        links.map((l) => (l as HTMLAnchorElement).href),
      );
      expect(pages.length).toBeGreaterThan(0);
      for (const url of pages) {
        const res = await request.get(url);
        expect(res.status(), url).toBe(200);
        const html = await res.text();
        expect(html, `${url} keeps B's overwritten Wi-Fi note out`).not.toContain(otherWifi);
        expect(html, `${url} shows no staff data`).not.toContain(owner.email);
      }

      expect(a.errors, "no uncaught errors in session A").toEqual([]);
      expect(b.errors, "no uncaught errors in session B").toEqual([]);
    } finally {
      await a.context.close();
      await b.context.close();
    }
  });

  test("an external property keeps the existing flow, says why the server refused a bad time zone, and shows no website editor", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const owner = account("owner");
    const property = `Inn ${randomUUID().slice(0, 6)}`;
    const badZone = `Nowhere/${randomUUID().slice(0, 6)}`;

    await page.goto("/");
    await signUp(page, owner);

    // The server refuses an unknown IANA zone. The staff-facing notice is the
    // server's own sentence, naming the value typed, not a generic rejection.
    await expect(page.getByText("Set up your first property.")).toBeVisible();
    await page.getByLabel("Property name").fill(property);
    await page.getByLabel("Website").fill("https://example.com/");
    await page.getByLabel("Time zone").fill(badZone);
    await page.getByRole("button", { name: "Create property" }).click();
    const notice = page.getByRole("alert").filter({ hasText: badZone });
    await expect(notice).toBeVisible({ timeout: 30_000 });
    await expect(notice).toContainText("is not recognized");
    await expect(notice).toContainText("America/New_York");
    await expect(notice).not.toContainText("The server rejected that request");
    await expect(page.getByRole("heading", { level: 1, name: "Inbox" })).toHaveCount(0);
    // The form is still there with what was typed, so it can simply be corrected.
    await expect(page.getByLabel("Property name")).toHaveValue(property);
    await expect(page.getByLabel("Website")).toHaveValue("https://example.com/");
    await expect(page.getByRole("button", { name: "Create property" })).toBeEnabled();
    await page.screenshot({ path: test.info().outputPath("external-bad-timezone.png"), fullPage: true });

    // A valid zone: the pre-existing create flow goes through and the inn carries it.
    await page.getByLabel("Time zone").fill("America/New_York");
    await createExternalProperty(page, property);
    await expect(page.getByRole("navigation", { name: "Workspace" })).toContainText(property);
    // A brand-new inn: honest zero counts and no median rather than "0 min".
    const statsStrip = page.getByRole("list", { name: "Inbox statistics" });
    await expect(statsStrip).toContainText("0 replies today");
    await expect(statsStrip).toContainText("No first responses yet");
    await expect(statsStrip).toContainText("0 open");
    await expect(statsStrip).not.toContainText("0 min");
    await openSettings(page);
    await expect(page.getByRole("heading", { level: 2, name: "Property" })).toBeVisible();
    await expect(page.getByRole("link", { name: "https://example.com/" })).toBeVisible();
    await expect(page.getByRole("definition").filter({ hasText: "America/New_York" })).toBeVisible();
    // Give the reactive queries a moment to settle, then assert the section never appeared.
    await expect(page.getByRole("list", { name: "Team members" })).toContainText(owner.name);
    await expect(page.getByRole("region", { name: "Public website" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Save website" })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Open the public website" })).toHaveCount(0);
    expect(errors).toEqual([]);
  });
});
