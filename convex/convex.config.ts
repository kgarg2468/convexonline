import { defineApp } from "convex/server";
import staticHosting from "@convex-dev/static-hosting/convex.config";
import presence from "@convex-dev/presence/convex.config";
import rateLimiter from "@convex-dev/rate-limiter/convex.config";

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

export default app;
