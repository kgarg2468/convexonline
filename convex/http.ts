import { httpRouter } from "convex/server";
import { registerStaticRoutes } from "@convex-dev/static-hosting";
import { components, internal } from "./_generated/api";
import { httpAction } from "./_generated/server";
import { auth } from "./auth";
import { readEnv } from "./lib/env";
import { parseWebhookBody } from "./lib/inboundPayload";
import { HOSTED_PATH_PREFIX, NOT_FOUND_BODY, parseHostedPath, renderHostedPage } from "./lib/innWebsiteHtml";
import { readSignatureHeaders, verifyWebhookSignature } from "./lib/webhookSignature";

// The app owns the HTTP root (see convex.config.ts). Exact routes are
// registered first and always win over the static catch-all below. Product
// endpoints live under an explicit /api prefix; Convex Auth's well-known
// routes stay at the root so OIDC discovery works.
const http = httpRouter();

const JSON_HEADERS = { "Content-Type": "application/json", "Cache-Control": "no-store" };
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });

http.route({
  path: "/api/health",
  method: "GET",
  handler: httpAction(async () => json(200, { ok: true, service: "front-desk", ts: Date.now() })),
});

/**
 * AgentMail delivery endpoint. The raw body is verified against the Svix
 * signing secret before anything is parsed; without a configured secret the
 * route refuses every delivery (503) rather than trusting the network.
 */
http.route({
  path: "/api/agentmail/webhook",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const secret = readEnv("AGENTMAIL_WEBHOOK_SECRET");
    if (!secret) return json(503, { ok: false, error: "webhook secret not configured" });
    const rawBody = await request.text();
    if (rawBody.length > 2_000_000) return json(413, { ok: false, error: "payload too large" });
    const verdict = await verifyWebhookSignature(secret, rawBody, readSignatureHeaders(request.headers));
    if (!verdict.ok) return json(401, { ok: false, error: "invalid signature", reason: verdict.reason });

    let body: unknown;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return json(400, { ok: false, error: "invalid json" });
    }
    const parsed = parseWebhookBody(body);
    if (parsed.kind === "invalid") return json(400, { ok: false, error: parsed.reason });
    if (parsed.kind === "ignored_event") return json(200, { ok: true, outcome: "ignored_event" });
    const result = await ctx.runMutation(internal.inbound.receive, parsed.event);
    return json(200, { ok: true, outcome: result.outcome });
  }),
});

/**
 * Hosted fictional inn websites: GET /inn/<innId>/{,policies,rooms,notices}.
 * A prefix route, so it wins over the static catch-all below but never touches
 * the exact root routes (auth well-known, /api/*). Everything is rendered from
 * the inn's structured content document with escaping; there is no user HTML.
 * `no-store` keeps crawlers (and Firecrawl) from reusing a stale body.
 */
const HTML_HEADERS = { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
const TEXT_HEADERS = { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };

http.route({
  pathPrefix: HOSTED_PATH_PREFIX,
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const notFound = () => new Response(NOT_FOUND_BODY, { status: 404, headers: TEXT_HEADERS });
    let pathname: string;
    try {
      pathname = new URL(request.url).pathname;
    } catch {
      return notFound();
    }
    const parsed = parseHostedPath(pathname);
    if (!parsed) return notFound();
    const content = await ctx.runQuery(internal.innWebsites.publicContent, { innId: parsed.innId });
    if (!content) return notFound();
    const html = renderHostedPage({ innId: parsed.innId, page: parsed.page, content });
    return new Response(html, { status: 200, headers: HTML_HEADERS });
  }),
});

// Convex Auth at the standard root paths so the auth.config.ts provider can
// resolve keys via OIDC discovery:
//   /.well-known/openid-configuration and /.well-known/jwks.json
auth.addHttpRoutes(http);

// Static SPA: catch-all for everything not matched by an exact route above.
registerStaticRoutes(http, components.staticHosting);

export default http;
