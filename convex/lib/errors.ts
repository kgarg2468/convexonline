import { ProviderError } from "../providers/shared";

/** A safe, user-visible reason for a failed provider step (never provider bodies or keys). */
export function describeError(e: unknown): { kind: string; message: string; ambiguous: boolean } {
  if (e instanceof ProviderError) {
    return { kind: `${e.provider}_${e.kind}`, message: e.message, ambiguous: e.ambiguous };
  }
  if (e instanceof Error && e.name === "ProviderError") {
    const pe = e as unknown as { provider?: string; kind?: string; ambiguous?: boolean };
    return { kind: `${pe.provider ?? "provider"}_${pe.kind ?? "error"}`, message: e.message, ambiguous: pe.ambiguous === true };
  }
  return { kind: "unexpected", message: "unexpected error", ambiguous: false };
}
