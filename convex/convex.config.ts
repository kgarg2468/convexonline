import { defineApp } from "convex/server";
import staticHosting from "@convex-dev/static-hosting/convex.config";
import presence from "@convex-dev/presence/convex.config";
import rateLimiter from "@convex-dev/rate-limiter/convex.config";
import aggregate from "@convex-dev/aggregate/convex.config";
import agentmail from "@agentmail/convex/convex.config";

// App-owned root routing: convex/http.ts owns "/" so Convex Auth's OIDC
// discovery + JWKS stay at the standard root paths, and the static SPA is
// registered as a catch-all from http.ts (registerStaticRoutes) instead of
// being mounted with an httpPrefix here.
const app = defineApp();
app.use(staticHosting);
// Thread presence ("who is looking at this thread"). The component has no
// HTTP routes; every public entry point is an app function in presence.ts.
app.use(presence);
// Per-inn OpenAI operation budget (convex/modelBudget.ts). The component has
// no HTTP routes and no public entry points; only internal mutations call it.
app.use(rateLimiter);
// Per-inn counts behind threads.stats (convex/aggregates.ts). One component
// instance per (table, sort key); every instance is namespaced by inn id.
app.use(aggregate, { name: "threadStatusCounts" });
app.use(aggregate, { name: "threadFirstResponseTimes" });
app.use(aggregate, { name: "sentRepliesBySentAt" });
app.use(aggregate, { name: "correctionStatusCounts" });
// Durable archive of verified inbound deliveries (convex/agentmailArchive.ts).
// Only `lib.handleEvent` is called, from inside inbound.receive's transaction
// and without callbacks; sending, provisioning and replies stay on the app's
// direct REST client, and no app function exposes the component's tables.
app.use(agentmail);

export default app;
