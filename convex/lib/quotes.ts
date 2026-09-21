/**
 * Quote verification: a claim's `quote` must be a substring of the stored page
 * version. Drafters strip markdown emphasis and smart punctuation, so both
 * sides are normalized before the fallback comparison. Empty quotes never
 * verify: an empty string is a substring of everything and would let a claim
 * through with no evidence.
 *
 * Sources are shown to the drafter with `<` escaped as `&lt;` (see the OpenAI
 * adapter), so a faithfully copied quote may carry that entity while the stored
 * source has the raw character. Both sides therefore have a small, fixed set of
 * HTML entities decoded exactly once before the normalized comparison. Decoding
 * is a single pass so nested escapes stay nested: `&amp;lt;` becomes `&lt;`,
 * never `<`. A source that literally contains `&lt;` and a quote written either
 * way still meet on the decoded form. The original quote and source are never
 * rewritten; only the comparison is normalized.
 */

export type QuoteVerification =
  | { verified: true; method: "strict" | "normalized" }
  | { verified: false; reason: "empty" | "not_found" };

const PUNCTUATION_MAP: Record<string, string> = {
  "‘": "'",
  "’": "'",
  "‚": "'",
  "‛": "'",
  "“": '"',
  "”": '"',
  "„": '"',
  "‟": '"',
  "–": "-",
  "—": "-",
  "−": "-",
  "…": "...",
  " ": " ",
};

const ENTITY_MAP: Record<string, string> = {
  "&lt;": "<",
  "&gt;": ">",
  "&amp;": "&",
  "&quot;": '"',
  "&apos;": "'",
  "&#39;": "'",
};

/**
 * Decodes only the entities the adapter's escaping can produce (plus the
 * common text-safe ones), in one pass, so `&amp;lt;` yields `&lt;`, not `<`.
 * Numeric references beyond `&#39;` are left untouched on purpose.
 */
export function decodeSupportedEntities(input: string): string {
  return input.replace(/&(?:lt|gt|amp|quot|apos|#39);/g, (m) => ENTITY_MAP[m] ?? m);
}

export function normalizeText(input: string): string {
  let out = decodeSupportedEntities(input.normalize("NFKC"));
  out = out.replace(/[‘’‚‛“”„‟–—−… ]/g, (c) => PUNCTUATION_MAP[c] ?? c);
  // Markdown images and links: keep the visible text, drop the URL.
  out = out.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
  out = out.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
  // Emphasis, code, strikethrough, headings, blockquotes and list markers.
  out = out.replace(/[*_`~]+/g, "");
  out = out.replace(/^[ \t]*#{1,6}[ \t]*/gm, "");
  out = out.replace(/^[ \t]*>[ \t]?/gm, "");
  out = out.replace(/^[ \t]*(?:[-+•]|\d+[.)])[ \t]+/gm, "");
  // Whitespace and case.
  out = out.replace(/\s+/g, " ").trim().toLowerCase();
  return out;
}

export function isEmptyQuote(quote: string): boolean {
  return normalizeText(quote).length === 0;
}

export function verifyQuote(pageMarkdown: string, quote: string): QuoteVerification {
  if (isEmptyQuote(quote)) {
    return { verified: false, reason: "empty" };
  }
  const strict = quote.trim();
  if (strict.length > 0 && pageMarkdown.includes(strict)) {
    return { verified: true, method: "strict" };
  }
  if (normalizeText(pageMarkdown).includes(normalizeText(quote))) {
    return { verified: true, method: "normalized" };
  }
  return { verified: false, reason: "not_found" };
}

export type ClaimInput = { statement: string; quote: string };
export type VerifiedClaim<T extends ClaimInput> = T & {
  verification: QuoteVerification;
  status: "ok" | "stripped";
};

/** Verifies every claim against one page; failing claims are marked stripped. */
export function verifyClaims<T extends ClaimInput>(pageMarkdown: string, claims: T[]): VerifiedClaim<T>[] {
  return claims.map((claim) => {
    const verification = verifyQuote(pageMarkdown, claim.quote);
    return { ...claim, verification, status: verification.verified ? "ok" : "stripped" };
  });
}

export async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
