import { test, expect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { randomBytes, randomUUID } from "node:crypto";

/**
 * Staff invitations against a deployed Front Desk, end to end through the UI.
 *
 * Every account here is created during the run: a unique address under the
 * reserved example.invalid domain and a random 24-character password that
 * exists only in this process. Nothing is read from the environment, no
 * provider is involved (creating a property stores a record and nothing
 * else; no crawl, no mailbox), and no test-only server endpoint exists.
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

const TOKEN = /^[0-9a-f]{64}$/;

/** From the sign-in screen (wherever the page currently is), create a staff account and wait for the signed-in state. */
async function signUp(page: Page, who: Account) {
  await page.getByRole("tab", { name: "Create staff account" }).click();
  await page.getByLabel("Your name").fill(who.name);
  await page.getByLabel("Email").fill(who.email);
  await page.getByLabel("Password").fill(who.password);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("tab", { name: "Create staff account" })).toHaveCount(0, { timeout: 30_000 });
}

async function createProperty(page: Page, name: string) {
  await expect(page.getByText("Set up your first property.")).toBeVisible();
  await page.getByLabel("Property name").fill(name);
  await page.getByLabel("Website").fill("https://example.com/");
  await page.getByRole("button", { name: "Create property" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Inbox" })).toBeVisible();
}

async function openSettings(page: Page) {
  await page.getByRole("navigation", { name: "Workspace" }).getByRole("button", { name: "Settings" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible();
}

const members = (page: Page) => page.getByRole("list", { name: "Team members" });
const invitations = (page: Page) => page.getByRole("list", { name: "Invitations" });

/** Owner creates an invitation in Settings and returns the link the UI showed once. */
async function createInvitation(page: Page, label: string): Promise<string> {
  await page.getByLabel("Label (optional)").fill(label);
  await page.getByRole("button", { name: "Create invitation link" }).click();
  const link = page.getByLabel("Invitation link");
  await expect(link).toBeVisible();
  const value = await link.inputValue();
  const origin = new URL(page.url()).origin;
  expect(value.startsWith(`${origin}/#invite=`), "link is this origin's root plus a fragment").toBe(true);
  expect(new URL(value).search, "token is never in the query string").toBe("");
  expect(value.slice(`${origin}/#invite=`.length)).toMatch(TOKEN);
  await expect(invitations(page).getByRole("listitem").filter({ hasText: label })).toContainText("Open");
  return value;
}

/** A fresh context whose page errors (uncaught exceptions) are collected for assertion. */
async function fresh(browser: Browser): Promise<{ context: BrowserContext; page: Page; errors: string[] }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  return { context, page, errors };
}

test.describe("staff invitations", () => {
  test("owner invites, staff joins by link, replay is refused, removal revokes access", async ({ browser }) => {
    test.setTimeout(180_000);
    const owner = account("owner");
    const staff = account("staff");
    const intruder = account("intruder");
    const property = `Inn ${randomUUID().slice(0, 6)}`;

    const a = await fresh(browser);
    const b = await fresh(browser);
    const c = await fresh(browser);
    try {
      // Owner: account, property, invitation.
      await a.page.goto("/");
      await signUp(a.page, owner);
      await createProperty(a.page, property);
      await openSettings(a.page);
      await expect(members(a.page)).toContainText(owner.name);
      await expect(members(a.page).getByRole("button", { name: "Remove" })).toHaveCount(0);
      const link = await createInvitation(a.page, "Night desk");

      // Staff: opens the link signed out, is told an invitation is waiting, signs up, is asked to join.
      await b.page.goto(link);
      await expect(b.page.getByText("You have a staff invitation.")).toBeVisible();
      expect(b.page.url(), "fragment is stripped from the address bar").not.toContain("invite=");
      await signUp(b.page, staff);
      await expect(b.page.getByRole("region", { name: "Staff invitation" })).toBeVisible();
      await expect(b.page.getByText(`You are invited to join ${property} as staff.`)).toBeVisible();
      // Explicit join only: no property was opened by merely arriving.
      await expect(b.page.getByRole("heading", { level: 1, name: "Inbox" })).toHaveCount(0);
      await b.page.getByRole("button", { name: `Join ${property}` }).click();
      await expect(b.page.getByRole("heading", { level: 1, name: "Inbox" })).toBeVisible();
      await expect(b.page.getByRole("navigation", { name: "Workspace" })).toContainText(property);
      await expect(b.page.getByRole("navigation", { name: "Workspace" })).toContainText("staff");

      // Staff sees the team but has no management controls.
      await openSettings(b.page);
      await expect(members(b.page)).toContainText(owner.name);
      await expect(members(b.page)).toContainText(staff.name);
      await expect(b.page.getByText("Only the property owner can invite or remove staff.")).toBeVisible();
      await expect(b.page.getByRole("button", { name: "Create invitation link" })).toHaveCount(0);
      await expect(b.page.getByRole("button", { name: /^Revoke/ })).toHaveCount(0);
      await expect(b.page.getByRole("button", { name: "Remove" })).toHaveCount(0);

      // Owner sees the new member and the spent invitation without reloading.
      await expect(members(a.page)).toContainText(staff.name);
      const spent = invitations(a.page).getByRole("listitem").filter({ hasText: "Night desk" });
      await expect(spent).toContainText("Used");
      await expect(spent).toContainText(staff.name);
      await expect(spent.getByRole("button", { name: /^Revoke/ })).toHaveCount(0);

      // A third account replaying the same link is refused and lands nowhere.
      await c.page.goto(link);
      await signUp(c.page, intruder);
      await expect(c.page.getByRole("alert")).toContainText("has already been used");
      await expect(c.page.getByRole("button", { name: /^Join/ })).toHaveCount(0);
      await c.page.getByRole("button", { name: "Dismiss" }).click();
      await expect(c.page.getByText("Set up your first property.")).toBeVisible();
      await expect(c.page.getByText(property)).toHaveCount(0);

      // Owner removes the staff member after an inline confirmation.
      const staffRow = members(a.page).getByRole("listitem").filter({ hasText: staff.name });
      await staffRow.getByRole("button", { name: "Remove" }).click();
      await expect(a.page.getByRole("group", { name: `Remove ${staff.name}` })).toBeVisible();
      await a.page.getByRole("button", { name: "Yes, remove" }).click();
      await expect(members(a.page)).not.toContainText(staff.name);
      await expect(members(a.page)).toContainText(owner.name);

      // The removed member's open workspace goes away without a crash: either the
      // reactive membership list unmounts it, or the scoped access screen shows first.
      const back = b.page.getByRole("button", { name: "Back to properties" });
      const picker = b.page.getByText("Set up your first property.");
      await expect(back.or(picker)).toBeVisible();
      if (await back.isVisible()) {
        await expect(b.page.getByText("Your access to this property changed")).toBeVisible();
        await back.click();
      }
      await expect(picker).toBeVisible();
      await expect(b.page.getByRole("heading", { level: 1, name: "Settings" })).toHaveCount(0);
      await expect(b.page.getByText(property)).toHaveCount(0);
      expect(b.errors, "no uncaught errors in the removed member's tab").toEqual([]);
      expect(a.errors).toEqual([]);
      expect(c.errors).toEqual([]);
    } finally {
      await a.context.close();
      await b.context.close();
      await c.context.close();
    }
  });

  test("a revoked invitation cannot be joined, and the owner can only revoke open ones", async ({ browser }) => {
    test.setTimeout(150_000);
    const owner = account("owner");
    const staff = account("staff");
    const property = `Inn ${randomUUID().slice(0, 6)}`;

    const a = await fresh(browser);
    const b = await fresh(browser);
    try {
      await a.page.goto("/");
      await signUp(a.page, owner);
      await createProperty(a.page, property);
      await openSettings(a.page);
      const link = await createInvitation(a.page, "Revoked later");
      const row = invitations(a.page).getByRole("listitem").filter({ hasText: "Revoked later" });
      await row.getByRole("button", { name: /^Revoke/ }).click();
      await expect(row).toContainText("Revoked");
      await expect(row.getByRole("button", { name: /^Revoke/ })).toHaveCount(0);

      await b.page.goto(link);
      await signUp(b.page, staff);
      await expect(b.page.getByRole("alert")).toContainText("was revoked by the owner");
      await expect(b.page.getByRole("button", { name: /^Join/ })).toHaveCount(0);
      await b.page.getByRole("button", { name: "Dismiss" }).click();
      await expect(b.page.getByText("Set up your first property.")).toBeVisible();
      await expect(members(a.page)).not.toContainText(staff.name);
      expect(a.errors).toEqual([]);
      expect(b.errors).toEqual([]);
    } finally {
      await a.context.close();
      await b.context.close();
    }
  });

  test("a malformed invitation is reported as not valid and can be dismissed", async ({ page }) => {
    test.setTimeout(90_000);
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto("/#invite=not-a-real-token");
    await expect(page.getByText("You have a staff invitation.")).toBeVisible();
    expect(page.url()).not.toContain("invite=");
    await signUp(page, account("staff"));
    await expect(page.getByRole("alert")).toContainText("This invitation link is not valid");
    await expect(page.getByRole("button", { name: /^Join/ })).toHaveCount(0);
    await page.getByRole("button", { name: "Dismiss" }).click();
    await expect(page.getByText("Set up your first property.")).toBeVisible();
    // Dismissed for good: a reload does not bring it back.
    await page.reload();
    await expect(page.getByText("Set up your first property.")).toBeVisible();
    await expect(page.getByRole("region", { name: "Staff invitation" })).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  // Bad percent-encoding: decodeURIComponent throws on it, and the fragment is read during the very first render.
  const MALFORMED_LINK = "/#invite=%E0%A4%A";

  test("a malformed invitation link never crashes the page, is reported as not valid and can be dismissed", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(MALFORMED_LINK);
    await expect(page.getByRole("tab", { name: "Sign in" })).toBeVisible();
    await expect(page.getByText("The invitation link you opened is not valid.")).toBeVisible();
    await expect(page.getByText("You have a staff invitation.")).toHaveCount(0);
    expect(page.url(), "fragment is stripped from the address bar").not.toContain("invite=");
    expect(page.url()).not.toContain("%E0");
    await expect(page.getByText("%E0%A4%A")).toHaveCount(0);
    // Reload with the fragment already gone: still no crash, still the honest state.
    await page.reload();
    await expect(page.getByRole("tab", { name: "Sign in" })).toBeVisible();
    await expect(page.getByText("The invitation link you opened is not valid.")).toBeVisible();
    expect(errors, "no uncaught errors before sign-in").toEqual([]);

    await signUp(page, account("staff"));
    await expect(page.getByRole("region", { name: "Staff invitation" })).toBeVisible();
    await expect(page.getByRole("alert")).toContainText("This invitation link is not valid");
    await expect(page.getByRole("button", { name: /^Join/ })).toHaveCount(0);
    await expect(page.getByText("%E0%A4%A")).toHaveCount(0);
    await page.getByRole("button", { name: "Dismiss" }).click();
    await expect(page.getByText("Set up your first property.")).toBeVisible();
    await page.reload();
    await expect(page.getByText("Set up your first property.")).toBeVisible();
    await expect(page.getByRole("region", { name: "Staff invitation" })).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test("a malformed link opened after a real invitation replaces it instead of offering that property", async ({
    browser,
  }) => {
    test.setTimeout(150_000);
    const owner = account("owner");
    const staff = account("staff");
    const property = `Inn ${randomUUID().slice(0, 6)}`;

    const a = await fresh(browser);
    const b = await fresh(browser);
    try {
      await a.page.goto("/");
      await signUp(a.page, owner);
      await createProperty(a.page, property);
      await openSettings(a.page);
      const link = await createInvitation(a.page, "Superseded");

      // The real invitation is pending in tab b, then a broken link is opened in the same tab.
      await b.page.goto(link);
      await expect(b.page.getByText("You have a staff invitation.")).toBeVisible();
      await b.page.goto(MALFORMED_LINK);
      await expect(b.page.getByText("The invitation link you opened is not valid.")).toBeVisible();
      await expect(b.page.getByText("You have a staff invitation.")).toHaveCount(0);
      expect(b.page.url()).not.toContain("invite=");

      // Signing in must not quietly bring the earlier property back.
      await signUp(b.page, staff);
      await expect(b.page.getByRole("region", { name: "Staff invitation" })).toBeVisible();
      await expect(b.page.getByRole("alert")).toContainText("This invitation link is not valid");
      await expect(b.page.getByRole("button", { name: /^Join/ })).toHaveCount(0);
      await expect(b.page.getByText(property)).toHaveCount(0);
      await b.page.getByRole("button", { name: "Dismiss" }).click();
      await expect(b.page.getByText("Set up your first property.")).toBeVisible();
      await expect(b.page.getByText(property)).toHaveCount(0);

      // The owner's invitation is untouched: still open, nobody joined.
      await expect(invitations(a.page).getByRole("listitem").filter({ hasText: "Superseded" })).toContainText("Open");
      await expect(members(a.page)).not.toContainText(staff.name);
      expect(a.errors).toEqual([]);
      expect(b.errors).toEqual([]);
    } finally {
      await a.context.close();
      await b.context.close();
    }
  });

  test("an unrelated fragment is left alone and the demo never tries to accept an invitation", async ({ page }) => {
    await page.goto("/#about");
    await expect(page.getByRole("tab", { name: "Sign in" })).toBeVisible();
    expect(page.url()).toContain("#about");
    await expect(page.getByText("You have a staff invitation.")).toHaveCount(0);

    // A demo visitor holding an invitation is sent back to sign in; the token survives the round trip.
    await page.goto(`/#invite=${"0".repeat(64)}`);
    await expect(page.getByText("You have a staff invitation.")).toBeVisible();
    await page.getByRole("button", { name: "Open the demo workspace" }).click();
    await expect(page.getByRole("heading", { name: "Staff invitation waiting" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 1, name: "Policy changes" })).toHaveCount(0);
    await page.getByRole("button", { name: "Leave demo and sign in" }).click();
    await expect(page.getByRole("tab", { name: "Sign in" })).toBeVisible();
    await expect(page.getByText("You have a staff invitation.")).toBeVisible();
    // Invitations are per tab: a new tab in the same context has nothing pending.
    const other = await page.context().newPage();
    await other.goto("/");
    await expect(other.getByRole("tab", { name: "Sign in" })).toBeVisible();
    await expect(other.getByText("You have a staff invitation.")).toHaveCount(0);
    await other.close();
  });
});
