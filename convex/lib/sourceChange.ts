import { verifyQuote, type QuoteVerification } from "./quotes";

/**
 * When a watched page changes, every sent claim citing that page is
 * re-verified against the new version. Claims whose quote still holds are
 * unaffected controls; claims whose quote vanished are affected and get a
 * correction proposal. Claims citing other pages are never touched.
 */

export type CitingClaim = { pageId: string; quote: string };

export type SourceChangePartition<T extends CitingClaim> = {
  affected: Array<T & { verification: QuoteVerification }>;
  unaffected: Array<T & { verification: QuoteVerification | null }>;
};

export function partitionClaimsBySourceChange<T extends CitingClaim>(
  claims: T[],
  changedPageId: string,
  newMarkdown: string,
): SourceChangePartition<T> {
  const affected: SourceChangePartition<T>["affected"] = [];
  const unaffected: SourceChangePartition<T>["unaffected"] = [];
  for (const claim of claims) {
    if (claim.pageId !== changedPageId) {
      unaffected.push({ ...claim, verification: null });
      continue;
    }
    const verification = verifyQuote(newMarkdown, claim.quote);
    if (verification.verified) {
      unaffected.push({ ...claim, verification });
    } else {
      affected.push({ ...claim, verification });
    }
  }
  return { affected, unaffected };
}

/**
 * Best-effort locator for the passage that replaced a vanished quote: the
 * paragraph of the new markdown sharing the most words with the old quote.
 * Used only to show staff old/new side by side; the drafter writes the text.
 */
export function findReplacementPassage(newMarkdown: string, oldQuote: string): string | undefined {
  const words = new Set(
    oldQuote
      .toLowerCase()
      .split(/[^a-z0-9$]+/)
      .filter((w) => w.length > 2),
  );
  if (words.size === 0) return undefined;
  let best: { score: number; text: string } | undefined;
  for (const paragraph of newMarkdown.split(/\n\s*\n/)) {
    const text = paragraph.trim();
    if (!text) continue;
    const paragraphWords = text.toLowerCase().split(/[^a-z0-9$]+/);
    let score = 0;
    for (const w of paragraphWords) if (words.has(w)) score += 1;
    if (score > 0 && (best === undefined || score > best.score)) best = { score, text };
  }
  return best?.text;
}
