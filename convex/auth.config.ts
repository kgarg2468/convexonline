// Convex Auth issues RS256 JWTs with iss = CONVEX_SITE_URL and aud = "convex".
// Because app HTTP routes are mounted under /api (see convex.config.ts), the
// OIDC discovery document is not at the issuer root, so the JWKS URL is given
// explicitly instead of relying on discovery.
const siteUrl = process.env.CONVEX_SITE_URL;
if (!siteUrl) {
  throw new Error("CONVEX_SITE_URL is not set on this deployment");
}

export default {
  providers: [
    {
      type: "customJwt",
      issuer: siteUrl,
      jwks: `${siteUrl}/api/.well-known/jwks.json`,
      algorithm: "RS256",
      applicationID: "convex",
    },
  ],
};
