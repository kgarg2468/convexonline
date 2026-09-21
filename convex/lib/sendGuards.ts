/**
 * Pure decisions for reserving an outbound send. The mutation that applies a
 * decision reads every input and writes the reservation in one transaction,
 * so two racing callers cannot both reserve.
 */
import { isClaimActive, type ClaimState } from "./claimLocks";

export type SendDenial =
  | "claimed"
  | "not_ready"
  | "unverified_edit"
  | "stale_inbound"
  | "stale_source"
  | "in_flight"
  | "already_sent"
  | "no_reply_target";

export type DraftSendInput = {
  actor: string;
  now: number;
  thread: ClaimState & { lastInboundMessageId?: string };
  draft: {
    status: "verifying" | "needs_edit" | "ready" | "sent" | "superseded";
    answer: string;
    verifiedText?: string;
    textSource?: "model" | "staff" | "fixture";
    replyToMessageId?: string;
  };
  staffAuthored: boolean;
  /** Each cited page: is the cited version still the page's latest? Facts: still current? */
  sourcesCurrent: boolean;
  priorSent: boolean;
  outboxStatuses: Array<"reserved" | "sending" | "sent" | "failed" | "unknown">;
};

export type SendDecision =
  | { ok: true; textSource: "model" | "staff" | "fixture" }
  | { ok: false; reason: SendDenial };

export function decideDraftSend(input: DraftSendInput): SendDecision {
  const { thread, draft } = input;
  if (!isClaimActive(thread, input.now) || thread.claimedBy !== input.actor) return { ok: false, reason: "claimed" };
  if (input.priorSent || draft.status === "sent") return { ok: false, reason: "already_sent" };
  if (input.outboxStatuses.some((s) => s === "reserved" || s === "sending" || s === "unknown")) {
    return { ok: false, reason: "in_flight" };
  }
  if (!draft.replyToMessageId || thread.lastInboundMessageId !== draft.replyToMessageId) {
    return { ok: false, reason: draft.replyToMessageId ? "stale_inbound" : "no_reply_target" };
  }
  if (!input.sourcesCurrent) return { ok: false, reason: "stale_source" };
  if (draft.status === "ready") {
    if (draft.verifiedText !== draft.answer) return { ok: false, reason: "unverified_edit" };
    return { ok: true, textSource: draft.textSource ?? "model" };
  }
  if (draft.status === "needs_edit" && draft.textSource === "staff") {
    if (!input.staffAuthored) return { ok: false, reason: "unverified_edit" };
    return { ok: true, textSource: "staff" };
  }
  return { ok: false, reason: "not_ready" };
}

export type CorrectionProvenance = {
  proposedText?: string;
  textSource?: "generated" | "staff" | "fixture";
  evidenceQuote?: string;
  judgeVerdict?: { entailed: boolean; promisedOutsideQuotes: boolean };
};

/**
 * Whether the correction text may go to a guest as it stands. Staff-written
 * text is a human decision and passes on its own. A drafter proposal needs a
 * verified evidence quote and an accepting judge verdict; a demo fixture needs
 * its evidence quote. Anything else must be edited (which makes it staff text).
 */
export function isCorrectionTextApproved(c: CorrectionProvenance): boolean {
  if (!c.proposedText?.trim()) return false;
  if (c.textSource === "staff") return true;
  if (!c.evidenceQuote?.trim()) return false;
  if (c.textSource === "fixture") return true;
  if (c.textSource === "generated") {
    return c.judgeVerdict !== undefined && c.judgeVerdict.entailed && !c.judgeVerdict.promisedOutsideQuotes;
  }
  return false;
}

export type CorrectionSendInput = {
  actor: string;
  now: number;
  thread: ClaimState & { lastInboundMessageId?: string };
  correction: CorrectionProvenance & {
    status: "needs_review" | "approved" | "sent" | "dismissed" | "superseded";
    newVersionId: string;
  };
  pageLastVersionId?: string;
  outboxStatuses: Array<"reserved" | "sending" | "sent" | "failed" | "unknown">;
};

export type CorrectionSendDecision = { ok: true } | { ok: false; reason: SendDenial | "not_approved" | "unverified_proposal" };

export function decideCorrectionSend(input: CorrectionSendInput): CorrectionSendDecision {
  const { thread, correction } = input;
  if (!isClaimActive(thread, input.now) || thread.claimedBy !== input.actor) return { ok: false, reason: "claimed" };
  if (correction.status === "sent") return { ok: false, reason: "already_sent" };
  if (input.outboxStatuses.some((s) => s === "reserved" || s === "sending" || s === "unknown")) {
    return { ok: false, reason: "in_flight" };
  }
  if (correction.status !== "approved" || !correction.proposedText?.trim()) return { ok: false, reason: "not_approved" };
  if (!isCorrectionTextApproved(correction)) return { ok: false, reason: "unverified_proposal" };
  if (input.pageLastVersionId !== correction.newVersionId) return { ok: false, reason: "stale_source" };
  if (!thread.lastInboundMessageId) return { ok: false, reason: "no_reply_target" };
  return { ok: true };
}
