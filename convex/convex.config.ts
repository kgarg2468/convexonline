import { defineApp } from "convex/server";
import staticHosting from "@convex-dev/static-hosting/convex.config";

// App-owned root routing: convex/http.ts owns "/" so Convex Auth's OIDC
// discovery + JWKS stay at the standard root paths, and the static SPA is
// registered as a catch-all from http.ts (registerStaticRoutes) instead of
// being mounted with an httpPrefix here.
const app = defineApp();
app.use(staticHosting);

export default app;
