// Convex Auth issues RS256 JWTs with iss = CONVEX_SITE_URL and aud = "convex".
// The standard provider entry resolves the signing keys through OIDC discovery
// at `${CONVEX_SITE_URL}/.well-known/openid-configuration`, which convex/http.ts
// serves at the deployment root (see convex.config.ts for why routes are root
// mounted). Do not switch to a `customJwt` provider: Convex Auth tokens carry
// no `kid` header and customJwt requires one ("JWT may be missing a kid").
export default {
  providers: [
    {
      domain: process.env.CONVEX_SITE_URL,
      applicationID: "convex",
    },
  ],
};
