/**
 * Finds each claim's statement inside the draft's answer so the sentence can
 * be marked as cited (design-spec §4.2, §7.4). Pure: no React, no DOM.
 *
 * Two passes. First a substring search after folding both sides the same
 * way: typographic quotes become straight ones, runs of whitespace collapse
 * to a space, letters are lower-cased. A statement that ends in a full stop
 * also matches without it ("…on Saturday." against "…on Saturday!").
 *
 * Claims the first pass leaves unmatched get a paraphrase pass, because
 * generation only holds the source *quote* to be verbatim, not the
 * statement ("Check-in runs…" in the claim, "Check-in is…" in the answer).
 * The answer is split into sentences and each remaining claim is scored
 * against each sentence by content-word overlap: case folded, punctuation
 * and stop words dropped, token sets compared. Numbers, prices and times
 * are strong tokens — they weigh double and every one in the claim must be
 * present in the sentence, so "$25" never links to a sentence saying "$40".
 * A pair is accepted at ≥ 60% weighted overlap with at least three shared
 * tokens; a sentence links to at most one claim and a claim to at most one
 * sentence, best score first. Sentences already touched by an exact match
 * are not offered. A claim with no match either way is skipped;
 * overlapping exact matches keep the first claim's span.
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

type Span = { start: number; end: number };

/* ---------- paraphrase pass ---------- */

/** Function words that carry no claim content. "may" stays a content word: it is also a month. */
const STOP_WORDS = new Set([
  "a", "an", "the", "and", "or", "but", "of", "for", "to", "in", "on", "at", "by", "as", "from", "with", "into",
  "is", "are", "am", "be", "been", "being", "was", "were", "it", "its", "this", "that", "these", "those", "there",
  "here", "we", "our", "us", "you", "your", "i", "my", "me", "they", "their", "them", "he", "she", "his", "her",
  "have", "has", "had", "do", "does", "did", "not", "no", "so", "if", "then", "than", "will", "would", "can",
  "could", "should", "please", "hi", "hello", "thanks", "thank", "note", "also", "just", "any", "all", "some",
  "very", "about", "up", "out", "over", "per",
]);

/** A price, percentage, time or plain number, or a word (hyphens and apostrophes kept inside: "check-in", "we'd"). */
const TOKEN = /\$?\d+(?:[.,:]\d+)*%?|[a-z]+(?:['-][a-z]+)*/g;

const NUMBER_WEIGHT = 2;
const MIN_OVERLAP = 0.6;
const MIN_SHARED = 3;

type Tokens = { words: Set<string>; numbers: Set<string> };

/** Content tokens of already-folded text. Numbers lose their `$`, `%` and thousands separators, so "$299" equals "299". */
function tokenize(folded: string): Tokens {
  const words = new Set<string>();
  const numbers = new Set<string>();
  for (const [raw] of folded.matchAll(TOKEN)) {
    if (/\d/.test(raw)) numbers.add(raw.replace(/[$%,]/g, ""));
    else if (!STOP_WORDS.has(raw)) words.add(raw);
  }
  return { words, numbers };
}

/** Sentences of the answer as spans of the original text, split at `.`, `!` or `?` before whitespace, or at a line break. Leading whitespace is left out of the span. */
function sentences(text: string): Span[] {
  const spans: Span[] = [];
  let start = 0;
  const push = (end: number) => {
    let s = start;
    while (s < end && /\s/.test(text[s]!)) s++;
    if (s < end) spans.push({ start: s, end });
    start = end;
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === "\n") {
      push(i);
      continue;
    }
    if (ch === "." || ch === "!" || ch === "?") {
      let j = i + 1;
      while (j < text.length && (text[j] === "." || text[j] === "!" || text[j] === "?" || text[j] === '"' || text[j] === "”" || text[j] === "'" || text[j] === "’" || text[j] === ")")) j++;
      if (j >= text.length || /\s/.test(text[j]!)) {
        push(j);
        i = j - 1;
      }
    }
  }
  push(text.length);
  return spans;
}

/** Weighted share of the claim's content present in the sentence, or null when the pair fails a gate. */
function score(claim: Tokens, sentence: Tokens): { ratio: number; shared: number } | null {
  for (const n of claim.numbers) if (!sentence.numbers.has(n)) return null;
  let sharedWords = 0;
  for (const w of claim.words) if (sentence.words.has(w)) sharedWords++;
  const shared = sharedWords + claim.numbers.size;
  if (shared < MIN_SHARED) return null;
  const total = claim.words.size + claim.numbers.size * NUMBER_WEIGHT;
  const ratio = total === 0 ? 0 : (sharedWords + claim.numbers.size * NUMBER_WEIGHT) / total;
  return ratio >= MIN_OVERLAP ? { ratio, shared } : null;
}

function overlaps(a: Span, b: Span) {
  return a.start < b.end && b.start < a.end;
}

/* ---------- entry point ---------- */

export function matchClaims(text: string, claims: readonly ClaimLike[]): TextSegment[] {
  if (text.length === 0) return [];
  const hay = fold(text);
  const hits: { start: number; end: number; claimId: string }[] = [];
  const unmatched: { index: number; claim: ClaimLike }[] = [];
  claims.forEach((claim, index) => {
    let needle = fold(claim.statement).out;
    if (needle.length === 0) return;
    let at = hay.out.indexOf(needle);
    if (at < 0 && needle.endsWith(".")) {
      needle = needle.slice(0, -1);
      at = needle.length > 0 ? hay.out.indexOf(needle) : -1;
    }
    if (at < 0) {
      unmatched.push({ index, claim });
      return;
    }
    const start = hay.map[at]!;
    const end = hay.map[at + needle.length - 1]! + 1;
    if (hits.some((h) => start < h.end && h.start < end)) return;
    hits.push({ start, end, claimId: claim._id });
  });

  if (unmatched.length > 0) {
    const candidates: { claimIndex: number; sentenceIndex: number; ratio: number; shared: number }[] = [];
    const spans = sentences(text).filter((span) => !hits.some((h) => overlaps(span, h)));
    const spanTokens = spans.map((span) => tokenize(fold(text.slice(span.start, span.end)).out));
    for (const { index, claim } of unmatched) {
      const claimTokens = tokenize(fold(claim.statement).out);
      spanTokens.forEach((tokens, sentenceIndex) => {
        const s = score(claimTokens, tokens);
        if (s) candidates.push({ claimIndex: index, sentenceIndex, ...s });
      });
    }
    candidates.sort(
      (a, b) => b.ratio - a.ratio || b.shared - a.shared || a.claimIndex - b.claimIndex || a.sentenceIndex - b.sentenceIndex,
    );
    const takenClaims = new Set<number>();
    const takenSentences = new Set<number>();
    for (const c of candidates) {
      if (takenClaims.has(c.claimIndex) || takenSentences.has(c.sentenceIndex)) continue;
      takenClaims.add(c.claimIndex);
      takenSentences.add(c.sentenceIndex);
      const span = spans[c.sentenceIndex]!;
      hits.push({ start: span.start, end: span.end, claimId: claims[c.claimIndex]!._id });
    }
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
