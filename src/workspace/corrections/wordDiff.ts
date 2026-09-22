/** A run of the diff: text both passages share, or a change with what the old passage had and what the new one has. */
export type DiffHunk = { kind: "same"; text: string } | { kind: "change"; del: string; ins: string };

/** Beyond this many tokens on both sides the table is not built; the passages are shown as one whole change. */
const MAX_TOKENS = 600;

/** Words and the whitespace between them, so the passage keeps its layout when re-joined. */
function tokenize(text: string): string[] {
  return text.split(/(\s+)/).filter((t) => t.length > 0);
}

/** Whitespace runs compare equal to each other; words compare exactly. */
const key = (token: string) => (/^\s+$/.test(token) ? " " : token);

/**
 * Word-level diff of two passages (longest common subsequence over tokens).
 * Whitespace between two changed words is folded into the change on both
 * sides, so "$25 per night" → "$40 per night" highlights one word and
 * "a b c" → "x y z" highlights one run rather than three.
 */
export function wordDiff(oldText: string, newText: string): DiffHunk[] {
  const a = tokenize(oldText);
  const b = tokenize(newText);
  const n = a.length;
  const m = b.length;
  if (n > MAX_TOKENS || m > MAX_TOKENS) return [{ kind: "change", del: oldText, ins: newText }];

  const width = m + 1;
  const lcs = new Uint16Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    const ka = key(a[i]!);
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * width + j] =
        ka === key(b[j]!) ? lcs[(i + 1) * width + j + 1]! + 1 : Math.max(lcs[(i + 1) * width + j]!, lcs[i * width + j + 1]!);
    }
  }

  // Walk the table into raw ops, then fold them into hunks.
  const ops: { kind: "same" | "del" | "ins"; text: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (key(a[i]!) === key(b[j]!)) {
      ops.push({ kind: "same", text: a[i]! });
      i++;
      j++;
    } else if (lcs[(i + 1) * width + j]! >= lcs[i * width + j + 1]!) {
      ops.push({ kind: "del", text: a[i]! });
      i++;
    } else {
      ops.push({ kind: "ins", text: b[j]! });
      j++;
    }
  }
  while (i < n) ops.push({ kind: "del", text: a[i++]! });
  while (j < m) ops.push({ kind: "ins", text: b[j++]! });

  const hunks: DiffHunk[] = [];
  const last = () => hunks[hunks.length - 1];
  for (let k = 0; k < ops.length; k++) {
    const op = ops[k]!;
    if (op.kind === "same") {
      const prev = last();
      const next = ops[k + 1];
      // Whitespace-only common text between two changes joins the change.
      if (prev?.kind === "change" && next && next.kind !== "same" && /^\s+$/.test(op.text)) {
        prev.del += op.text;
        prev.ins += op.text;
        continue;
      }
      if (prev?.kind === "same") prev.text += op.text;
      else hunks.push({ kind: "same", text: op.text });
      continue;
    }
    const prev = last();
    if (prev?.kind === "change") {
      if (op.kind === "del") prev.del += op.text;
      else prev.ins += op.text;
    } else {
      hunks.push(op.kind === "del" ? { kind: "change", del: op.text, ins: "" } : { kind: "change", del: "", ins: op.text });
    }
  }
  return hunks;
}
