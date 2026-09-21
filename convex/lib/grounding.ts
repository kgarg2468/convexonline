/**
 * Mechanical grounding of a drafter result against the stored sources it was
 * given. A claim cites either a page version (sourceId = version id, url =
 * page url) or a staff fact (sourceId = fact id, url = `staff:<id>`). Every
 * quote must verify against the exact stored text; anything else is stripped
 * and the draft can never become `ready`.
 */
import { verifyQuote, type QuoteVerification } from "./quotes";

export type PageSource = { kind: "page"; id: string; url: string; markdown: string; pageId: string };
export type FactSource = { kind: "fact"; id: string; answer: string };
export type Source = PageSource | FactSource;

export type RawClaim = { statement: string; url: string; quote: string; sourceId: string };

export type GroundedClaim = RawClaim & {
  source: Source | null;
  verification: QuoteVerification | { verified: false; reason: "unknown_source" };
  status: "ok" | "stripped";
};

export function groundClaims(claims: RawClaim[], sources: Source[]): GroundedClaim[] {
  const byId = new Map(sources.map((s) => [s.id, s]));
  return claims.map((claim) => {
    const source = byId.get(claim.sourceId) ?? null;
    if (!source) {
      return { ...claim, source: null, verification: { verified: false, reason: "unknown_source" }, status: "stripped" };
    }
    const text = source.kind === "page" ? source.markdown : source.answer;
    const verification = verifyQuote(text, claim.quote);
    return { ...claim, source, verification, status: verification.verified ? "ok" : "stripped" };
  });
}

export type DraftDecisionInput = {
  class: "answerable" | "needs_staff_fact" | "needs_availability_or_approval";
  abstain: boolean;
  answer: string;
  claims: GroundedClaim[];
  judge: { entailed: boolean; promised: boolean } | { error: string } | null;
};

export type DraftDecision = {
  status: "ready" | "needs_edit";
  threadStatus: "ready" | "needs_staff";
  reason?: string;
};

/**
 * Only a non-abstaining, answerable draft whose every claim verified and whose
 * exact text the judge accepted becomes `ready`. Everything else stays visible
 * as needs_edit / needs_staff with the reason; there is no silent fallback.
 */
export function decideDraft(input: DraftDecisionInput): DraftDecision {
  if (input.class !== "answerable" || input.abstain) {
    return { status: "needs_edit", threadStatus: "needs_staff", reason: `drafter classified as ${input.class}` };
  }
  if (input.answer.trim().length === 0) {
    return { status: "needs_edit", threadStatus: "needs_staff", reason: "drafter returned an empty answer" };
  }
  const stripped = input.claims.filter((c) => c.status === "stripped");
  if (stripped.length > 0) {
    return {
      status: "needs_edit",
      threadStatus: "needs_staff",
      reason: `${stripped.length} claim(s) could not be verified against the stored source`,
    };
  }
  if (input.claims.length === 0) {
    return { status: "needs_edit", threadStatus: "needs_staff", reason: "answer cites no source" };
  }
  if (input.judge === null) {
    return { status: "needs_edit", threadStatus: "needs_staff", reason: "judge did not run" };
  }
  if ("error" in input.judge) {
    return { status: "needs_edit", threadStatus: "needs_staff", reason: `judge unavailable: ${input.judge.error}` };
  }
  if (!input.judge.entailed) {
    return { status: "needs_edit", threadStatus: "needs_staff", reason: "judge: statements not entailed by quotes" };
  }
  if (input.judge.promised) {
    return { status: "needs_edit", threadStatus: "needs_staff", reason: "judge: reply promises beyond the quotes" };
  }
  return { status: "ready", threadStatus: "ready" };
}
