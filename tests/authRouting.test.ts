import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import http from "../convex/http";
import { makeTest } from "./setup";

/**
 * Convex Auth signs RS256 tokens without a `kid` header, so the deployment's
 * auth.config.ts must use the standard OIDC provider (domain + applicationID),
 * which resolves keys via `${CONVEX_SITE_URL}/.well-known/openid-configuration`.
 * That only works when the discovery document and JWKS are served at the root
 * of convex/http.ts, which in turn requires the app to own root routing and
 * register the static SPA as a catch-all instead of mounting it with a prefix.
 */
const SITE_URL = "https://some.convex.site";
const JWKS = JSON.stringify({ keys: [{ kty: "RSA", n: "test", e: "AQAB" }] });

describe("root auth routing", () => {
  beforeEach(() => {
    vi.stubEnv("CONVEX_SITE_URL", SITE_URL);
    vi.stubEnv("JWKS", JWKS);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("registers the well-known auth endpoints, /api/health and the webhook as exact root routes", () => {
    const exact = (path: string, method: "GET" | "POST" = "GET") => http.lookup(path, method)?.[2];
    expect(exact("/.well-known/openid-configuration")).toBe("/.well-known/openid-configuration");
    expect(exact("/.well-known/jwks.json")).toBe("/.well-known/jwks.json");
    expect(exact("/api/health")).toBe("/api/health");
    expect(exact("/api/agentmail/webhook", "POST")).toBe("/api/agentmail/webhook");
  });

  it("serves OIDC discovery at the root and advertises the root JWKS URL", async () => {
    const t = makeTest();
    const res = await t.fetch("/.well-known/openid-configuration");
    expect(res.status).toBe(200);
    const doc = (await res.json()) as { issuer: string; jwks_uri: string };
    expect(doc.issuer).toBe(SITE_URL);
    expect(doc.jwks_uri).toBe(`${SITE_URL}/.well-known/jwks.json`);

    const jwks = await t.fetch(new URL(doc.jwks_uri).pathname);
    expect(jwks.status).toBe(200);
    expect(await jwks.json()).toEqual(JSON.parse(JWKS));
  });

  it("keeps /api/health working at the root", async () => {
    const t = makeTest();
    const res = await t.fetch("/api/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, service: "front-desk" });
  });

  it("routes everything else to the static SPA catch-all, distinct from the exact routes", () => {
    const [spaHandler, , spaPath] = http.lookup("/inns/abc/threads", "GET")!;
    expect(spaPath).toBe("/*");
    const [healthHandler] = http.lookup("/api/health", "GET")!;
    const [jwksHandler] = http.lookup("/.well-known/jwks.json", "GET")!;
    expect(spaHandler).not.toBe(healthHandler);
    expect(spaHandler).not.toBe(jwksHandler);
    // An unknown /api path is not swallowed by an /api prefix, it falls to the SPA.
    expect(http.lookup("/api/nope", "GET")?.[2]).toBe("/*");
  });
});
