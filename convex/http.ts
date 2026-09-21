import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { auth } from "./auth";

// Mounted under /api because convex.config.ts uses defineApp({ httpPrefix: "/api" }).
const http = httpRouter();

http.route({
  path: "/health",
  method: "GET",
  handler: httpAction(async () => {
    return new Response(JSON.stringify({ ok: true, service: "front-desk", ts: Date.now() }), {
      status: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  }),
});

// /api/.well-known/openid-configuration and /api/.well-known/jwks.json
auth.addHttpRoutes(http);

export default http;
