import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DataModelFromSchemaDefinition, GenericActionCtx, GenericMutationCtx } from "convex/server";
import staticHostingComponent from "@convex-dev/static-hosting/test";
import http from "../convex/http";
import { makeTest, type T } from "./setup";

/**
 * The demo video must be served by an exact root route that redirects to the
 * asset's own storage URL, because the static catch-all proxies storage with a
 * plain fetch and drops the range support native video seeking depends on.
 */
const VIDEO_PATH = "/front-desk-demo.mp4";

type StaticDataModel = DataModelFromSchemaDefinition<typeof staticHostingComponent.schema>;
type StaticCtx = GenericMutationCtx<StaticDataModel> & Pick<GenericActionCtx<StaticDataModel>, "storage">;

/** Registers the real static-hosting component, as mounted in convex.config.ts. */
function makeStaticTest() {
  const t = makeTest();
  staticHostingComponent.register(t);
  return t;
}

/**
 * Runs `handler` inside the static-hosting component's own database and file
 * storage. convex-test exposes `runInComponent` at runtime (it is what `t.run`
 * delegates to) but does not type it, so the accessor is narrowed here instead
 * of touching the shared harness.
 */
function runInStaticHosting<Output>(t: T, handler: (ctx: StaticCtx) => Promise<Output>) {
  const accessor = t as unknown as {
    runInComponent: (componentPath: string, handler: (ctx: StaticCtx) => Promise<Output>) => Promise<Output>;
  };
  return accessor.runInComponent("staticHosting", handler);
}

/**
 * Seeds an asset in the component's storage and manifest, the state an
 * `@convex-dev/static-hosting upload` leaves behind, and returns its storage URL.
 */
async function storeStaticAsset(t: T, path: string, body: string, contentType: string) {
  return await runInStaticHosting(t, async (ctx) => {
    const storageId = await ctx.storage.store(new Blob([body], { type: contentType }));
    await ctx.db.insert("staticAssets", { path, storageId, contentType, deploymentId: "deploy-1" });
    return (await ctx.storage.getUrl(storageId))!;
  });
}

/** Deletes the video's storage file, and optionally its manifest row. */
async function dropVideoFile(t: T, { keepRow }: { keepRow: boolean }) {
  await runInStaticHosting(t, async (ctx) => {
    const row = await ctx.db
      .query("staticAssets")
      .withIndex("by_path", (q) => q.eq("path", VIDEO_PATH))
      .unique();
    if (!row?.storageId) throw new Error("expected a seeded video asset");
    await ctx.storage.delete(row.storageId);
    if (!keepRow) await ctx.db.delete(row._id);
  });
}

describe("demo video routing", () => {
  beforeEach(() => {
    vi.stubEnv("CONVEX_SITE_URL", "https://some.convex.site");
    vi.stubEnv("JWKS", JSON.stringify({ keys: [] }));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("registers the video as an exact root route ahead of the static catch-all", () => {
    const [videoHandler, , videoPath] = http.lookup(VIDEO_PATH, "GET")!;
    expect(videoPath).toBe(VIDEO_PATH);
    const [spaHandler, , spaPath] = http.lookup("/other-file.mp4", "GET")!;
    expect(spaPath).toBe("/*");
    expect(videoHandler).not.toBe(spaHandler);
  });

  it("redirects to the current managed asset's storage URL without proxying the body", async () => {
    const t = makeStaticTest();
    const storageUrl = await storeStaticAsset(t, VIDEO_PATH, "not really an mp4", "video/mp4");
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    try {
      const res = await t.fetch(VIDEO_PATH);
      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe(storageUrl);
      expect(res.headers.get("Cache-Control")).toBe("no-store");
      expect(await res.text()).toBe("");
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("follows a re-upload to the new storage file", async () => {
    const t = makeStaticTest();
    const first = await storeStaticAsset(t, VIDEO_PATH, "v1", "video/mp4");
    expect((await t.fetch(VIDEO_PATH)).headers.get("Location")).toBe(first);

    // A new upload replaces the manifest row and its file (see the component's
    // recordAsset / publishDeployment); the redirect must not keep the old URL.
    await dropVideoFile(t, { keepRow: false });
    const second = await storeStaticAsset(t, VIDEO_PATH, "v2", "video/mp4");
    expect(second).not.toBe(first);
    expect((await t.fetch(VIDEO_PATH)).headers.get("Location")).toBe(second);
  });

  it("returns a plain 404 when the video is not deployed, with no SPA fallback", async () => {
    const t = makeStaticTest();
    await storeStaticAsset(t, "/index.html", "<!doctype html><div id=root>", "text/html; charset=utf-8");

    const res = await t.fetch(VIDEO_PATH);
    expect(res.status).toBe(404);
    expect(res.headers.get("Content-Type")).toContain("text/plain");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.text()).not.toContain("id=root");
  });

  it("returns 404 when the manifest row points at a missing storage file", async () => {
    const t = makeStaticTest();
    await storeStaticAsset(t, VIDEO_PATH, "gone", "video/mp4");
    await dropVideoFile(t, { keepRow: true });

    const res = await t.fetch(VIDEO_PATH);
    expect(res.status).toBe(404);
  });

  it("leaves the existing root routes on their own handlers", async () => {
    const t = makeStaticTest();
    const [videoHandler] = http.lookup(VIDEO_PATH, "GET")!;
    expect(http.lookup("/api/health", "GET")![0]).not.toBe(videoHandler);
    expect(http.lookup("/.well-known/jwks.json", "GET")![0]).not.toBe(videoHandler);
    expect((await t.fetch("/api/health")).status).toBe(200);
  });
});
