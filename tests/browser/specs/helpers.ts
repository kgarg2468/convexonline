import { expect, type Locator, type Page } from "@playwright/test";

export const DEMO_INN = "Harbor Light Inn (demo)";

/** Seeded demo threads (see convex/demoContent.ts). */
export const THREADS = {
  ready: "Weekend rates for a Harbor View room",
  gap: "Hot tub in December?",
  petFee: "Pet fee question",
  dog: "Bringing our dog in October",
  twoDogs: "Two small dogs?",
  cancellation: "Cancellation policy",
  lateArrival: "Late arrival on Friday",
  breakfast: "Breakfast and Wi-Fi?",
};

/** Guest names as the review cards label them (derived from the seeded emails). */
export const GUESTS = {
  petFee: /Priya N/,
  dog: /Dana Ruiz/,
  twoDogs: /Kai M/,
};

/** From the sign-in screen, enter the demo as a fresh anonymous visitor and wait for the workspace. */
export async function enterDemo(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Open the demo workspace" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Policy changes" })).toBeVisible();
  await expect(page.getByText(DEMO_INN)).toBeVisible();
}

export function rail(page: Page) {
  return page.getByRole("navigation", { name: "Workspace" });
}

export async function openInbox(page: Page) {
  await rail(page).getByRole("button", { name: "Inbox" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Inbox" })).toBeVisible();
}

export async function openCorrections(page: Page) {
  await rail(page).getByRole("button", { name: "Policy changes" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Policy changes" })).toBeVisible();
}

export function queue(page: Page) {
  return page.getByRole("region", { name: "Guest threads" });
}

export async function openThread(page: Page, subject: string) {
  await queue(page).getByRole("button", { name: subject }).click();
  await expect(page.getByRole("heading", { level: 2, name: subject })).toBeVisible();
}

export async function takeThread(page: Page) {
  await page.getByRole("button", { name: "Take this thread" }).click();
  await expect(page.getByText(/You have this thread until/)).toBeVisible();
}

/**
 * Zero-state hero action; only present before the demo page edit. Asserts the
 * contract's 3 + 3 split twice: the mutation's own result sentence (held by the
 * workspace, so it outlives the hero) and the resulting persistent state (the
 * review strip and the restore control that replace the hero).
 */
export async function changePolicyPage(page: Page) {
  const hero = page.getByRole("region", { name: /Nothing needs a second look yet/ });
  await hero.getByRole("button", { name: "Change the policy page" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Policies page changed: 3 replies to review, 3 unaffected." }),
  ).toBeVisible();
  await expect(reviewStrip(page)).toContainText("3 replies need review");
  await expect(reviewStrip(page)).toContainText("3 replies re-checked and still true");
  await expect(hero).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Restore original policy page" })).toBeVisible();
}

export async function restorePolicyPage(page: Page) {
  await page.getByRole("button", { name: "Restore original policy page" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Policies page changed: 0 replies to review" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Change the policy page" })).toBeVisible();
}

export function reviewStrip(page: Page) {
  return page.getByRole("status").filter({ hasText: /repl(y|ies) needs? review/ });
}

export function deliveryList(scope: Page | Locator, title: "Reply delivery" | "Correction delivery") {
  return scope.locator(`.fd-outbox[aria-label="${title}"]`);
}

export async function expectNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    inner: window.innerWidth,
    bodyMargin: getComputedStyle(document.body).margin,
  }));
  expect(overflow.scroll, "page must not scroll sideways").toBeLessThanOrEqual(overflow.inner);
  expect(overflow.bodyMargin, "body margin reset").toBe("0px");
}
