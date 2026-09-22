/** Inline markdown emphasis markers: strong, emphasis and code spans. Single underscores stay (snake_case, URLs). */
const EMPHASIS = /\*\*|__|\*|`/g;

/**
 * A stored passage or evidence quote as prose: the inline emphasis markers the
 * page source carries (`**$40 per night pet fee**`) are removed so the diff
 * compares words, not markup, and "Rests on: …" reads as a sentence. Pure;
 * whitespace and every other character are kept as they were.
 */
export function plainText(text: string): string {
  return text.replace(EMPHASIS, "");
}
