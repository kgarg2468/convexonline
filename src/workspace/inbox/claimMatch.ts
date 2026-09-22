/**
 * Finds each claim's statement inside the draft's answer so the sentence can
 * be marked as cited (design-spec §4.2, §7.4). Pure: no React, no DOM.
 *
 * Matching is a substring search after folding both sides the same way:
 * typographic quotes become straight ones, runs of whitespace collapse to a
 * space, letters are lower-cased. A statement that ends in a full stop also
 * matches without it ("…on Saturday." against "…on Saturday!"). A claim with
 * no match is skipped; overlapping matches keep the first claim's span.
 */
export type ClaimLike = { _id: string; statement: string };

/** The id of a claim's card in the sources pane; cited sentences point at it with `aria-describedby`. */
export const claimCardId = (claimId: string) => `fd-claim-${claimId}`;

/** A run of the answer, cited (`claimId`) or plain (`null`). Concatenated in order the runs give back the answer verbatim. */
export type TextSegment = { text: string; claimId: string | null };

const QUOTES: Record<string, string> = {
  "‘": "'",
  "’": "'",
  "‚": "'",
  "‛": "'",
  "“": '"',
  "”": '"',
  "„": '"',
  "‟": '"',
};

/** The folded text and, for every folded index, the index of the source character it stands for. */
function fold(text: string): { out: string; map: number[] } {
  const chars: string[] = [];
  const map: number[] = [];
  let spaceAt = -1;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (/\s/.test(ch)) {
      if (spaceAt < 0) spaceAt = i;
      continue;
    }
    if (spaceAt >= 0 && chars.length > 0) {
      chars.push(" ");
      map.push(spaceAt);
    }
    spaceAt = -1;
    const lower = ch.toLowerCase();
    chars.push(QUOTES[ch] ?? (lower.length === 1 ? lower : ch));
    map.push(i);
  }
  return { out: chars.join(""), map };
}

export function matchClaims(text: string, claims: readonly ClaimLike[]): TextSegment[] {
  if (text.length === 0) return [];
  const hay = fold(text);
  const hits: { start: number; end: number; claimId: string }[] = [];
  for (const claim of claims) {
    let needle = fold(claim.statement).out;
    if (needle.length === 0) continue;
    let at = hay.out.indexOf(needle);
    if (at < 0 && needle.endsWith(".")) {
      needle = needle.slice(0, -1);
      at = needle.length > 0 ? hay.out.indexOf(needle) : -1;
    }
    if (at < 0) continue;
    const start = hay.map[at]!;
    const end = hay.map[at + needle.length - 1]! + 1;
    if (hits.some((h) => start < h.end && h.start < end)) continue;
    hits.push({ start, end, claimId: claim._id });
  }
  hits.sort((a, b) => a.start - b.start);

  const segments: TextSegment[] = [];
  let cursor = 0;
  for (const hit of hits) {
    if (hit.start > cursor) segments.push({ text: text.slice(cursor, hit.start), claimId: null });
    segments.push({ text: text.slice(hit.start, hit.end), claimId: hit.claimId });
    cursor = hit.end;
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor), claimId: null });
  return segments;
}
