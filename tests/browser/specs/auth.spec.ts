import { test, expect } from "@playwright/test";
import { DEMO_INN, THREADS, enterDemo, openInbox, openThread, queue, takeThread } from "./helpers";

test.describe("sign in and demo entry", () => {
  test("sign-in screen offers staff sign in and a demo, and the demo lands on the review screen", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("tab", { name: "Sign in" })).toBeVisible();
    await expect(page.getByRole("tab", { name: "Create staff account" })).toBeVisible();
    await expect(page.getByLabel("Email")).toBeVisible();
    await expect(page.getByLabel("Password")).toBeVisible();

    await page.getByRole("button", { name: "Open the demo workspace" }).click();

    await expect(page.getByRole("heading", { level: 1, name: "Policy changes" })).toBeVisible();
    await expect(page.getByText("See which replies need a second look")).toBeVisible();
    await expect(page.getByText(DEMO_INN)).toBeVisible();
    await expect(page.getByText("Demo workspace · no real email is sent")).toBeVisible();
    await expect(page.getByRole("button", { name: "Leave demo" })).toBeVisible();
    // Zero state is an explained action, not a blank.
    await expect(page.getByRole("heading", { name: /Nothing needs a second look yet/ })).toBeVisible();
    await expect(page.getByRole("button", { name: "Change the policy page" })).toBeEnabled();
  });

  test("a wrong staff password is refused with a readable message and no workspace", async ({ page }) => {
    await page.goto("/");
    await page.getByLabel("Email").fill("nobody-smoke@example.invalid");
    await page.getByLabel("Password").fill("definitely-not-a-real-password");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(page.getByRole("heading", { level: 1, name: "Policy changes" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeEnabled();
  });

  test("demo sessions are isolated: claims and sends in one never show in another", async ({ browser }) => {
    const a = await browser.newContext();
    const b = await browser.newContext();
    try {
      const pageA = await a.newPage();
      const pageB = await b.newPage();
      await enterDemo(pageA);
      await enterDemo(pageB);

      await openInbox(pageA);
      await openThread(pageA, THREADS.ready);
      await takeThread(pageA);
      await expect(queue(pageA).getByText("You have it")).toBeVisible();
      await pageA.getByRole("button", { name: "Send (simulated)" }).click();
      await expect(pageA.getByText("Delivered (simulated)")).toBeVisible();

      await openInbox(pageB);
      await openThread(pageB, THREADS.ready);
      // B's inn is a separate copy: nobody holds its thread and nothing was sent there.
      await expect(pageB.getByText("Nobody is working on this thread.")).toBeVisible();
      await expect(queue(pageB).getByText(/has it/)).toHaveCount(0);
      await expect(pageB.getByRole("button", { name: "Take this thread" })).toBeEnabled();
      await expect(pageB.getByText("Delivered (simulated)")).toHaveCount(0);
      await expect(pageB.getByRole("button", { name: "Send (simulated)" })).toBeVisible();
    } finally {
      await a.close();
      await b.close();
    }
  });

  test("settings never show secret values and do not claim the webhook is registered", async ({ page }) => {
    await enterDemo(page);
    await page.getByRole("navigation", { name: "Workspace" }).getByRole("button", { name: "Settings" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible();
    await expect(page.getByText("Providers on this deployment")).toBeVisible();
    await expect(page.getByText(/A configured key or secret is not proof that inbound mail is flowing/)).toBeVisible();
    // Booleans only: a configured/not-configured pill per provider, no inputs for keys.
    await expect(page.getByText(/^(Configured|Not configured)$/).first()).toBeVisible();
    await expect(page.locator('input[type="password"], input[name*="key" i], input[placeholder*="key" i]')).toHaveCount(0);
    // Readiness is a separate server-confirmed row; a demo inn has no live inbox and is never called Ready.
    await expect(page.getByText("This property's inbox subscribed")).toBeVisible();
    await expect(page.getByText("No live inbox (demo)")).toBeVisible();
    await expect(page.getByText(/^(Ready|Not ready)$/)).toHaveCount(0);
    await expect(page.getByText("Demo inns have no inbox.", { exact: false })).toBeVisible();
    await expect(page.getByText("Demo visitors cannot send real email.")).toBeVisible();
  });
});
