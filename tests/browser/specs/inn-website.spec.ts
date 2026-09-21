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
      await a.page.reload();
      await expect(a.page.getByRole("heading", { level: 1, name: "Inbox" })).toBeVisible({ timeout: 30_000 });
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

  test("an external property keeps the existing flow and shows no website editor", async ({ page }) => {
    test.setTimeout(120_000);
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const owner = account("owner");
    const property = `Inn ${randomUUID().slice(0, 6)}`;

    await page.goto("/");
    await signUp(page, owner);
    await createExternalProperty(page, property);
    await openSettings(page);
    await expect(page.getByRole("heading", { level: 2, name: "Property" })).toBeVisible();
    await expect(page.getByRole("link", { name: "https://example.com/" })).toBeVisible();
    // Give the reactive queries a moment to settle, then assert the section never appeared.
    await expect(page.getByRole("list", { name: "Team members" })).toContainText(owner.name);
    await expect(page.getByRole("region", { name: "Public website" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Save website" })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Open the public website" })).toHaveCount(0);
    expect(errors).toEqual([]);
  });
});
