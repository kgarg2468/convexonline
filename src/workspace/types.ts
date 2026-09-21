/**
 * Client-side mirrors of the shapes returned by convex/*.ts handlers.
 * Each hook casts its query result to one of these. Keep them in sync with the
 * handler return values (see .context/build/integration-contracts.md), not
 * with the raw schema.
 */
import type { Id } from "../../convex/_generated/dataModel";

export type Viewer = {
  _id: Id<"users">;
  name: string | null;
  email: string | null;
  isAnonymous: boolean;
};

export type MembershipRole = "owner" | "staff" | "demo";

export type InnSummary = {
  innId: Id<"inns">;
  name: string;
  siteUrl: string;
  isDemo: boolean;
  role: MembershipRole;
};

export type LiveMailDecision =
  | { allowed: true }
  | { allowed: false; reason: "no_membership" | "anonymous_user" | "demo_inn" | "demo_role" };

export type InnDetail = {
  inn: {
    _id: Id<"inns">;
    name: string;
    siteUrl: string;
    timezone: string;
    isDemo: boolean;
    inboxAddress: string | null;
  };
  role: MembershipRole;
  liveMail: LiveMailDecision;
  staff: { userId: Id<"users">; name: string; role: MembershipRole }[];
};

export type ThreadStatus =
  | "new"
  | "drafting"
  | "needs_staff"
  | "ready"
  | "sent"
  | "waiting_guest"
  | "closed";

export type Stay = {
  checkIn?: string;
  checkOut?: string;
  party?: number;
  status: "inquiry" | "booked";
};

export type ThreadSummary = {
  _id: Id<"threads">;
  guestEmail: string;
  subject: string;
  snippet: string;
  status: ThreadStatus;
  stay: Stay | null;
  lastInboundAt: number;
  lastInboundMessageId: Id<"messages"> | null;
  claim: { userId: Id<"users">; name: string | null; expiresAt: number } | null;
};

export type ThreadStats = {
  open: number;
  needsStaff: number;
  ready: number;
  waitingGuest: number;
  sentToday: number;
  sentTotal: number;
  pendingCorrections: number;
  medianFirstResponseMs: number | null;
};

export type DraftClass = "answerable" | "needs_staff_fact" | "needs_availability_or_approval";
export type DraftStatus = "verifying" | "needs_edit" | "ready" | "sent" | "superseded";
export type ClaimStatus = "ok" | "stripped" | "needs_review" | "corrected";
/** Who authored the exact outgoing text. "fixture" is demo-only. */
export type TextSource = "model" | "staff" | "fixture";
export type JudgeVerdict = { entailed: boolean; promisedOutsideQuotes: boolean; notes: string };

export type OutboxStatus = "reserved" | "sending" | "sent" | "failed" | "unknown";

export type OutboxKind = "reply" | "correction" | "follow_up";

export type OutboxRow = {
  _id: Id<"outbox">;
  kind: OutboxKind;
  /** The exact draft / correction / follow-up this row delivers. Null on rows written before the projection carried them. */
  draftId: Id<"drafts"> | null;
  correctionId: Id<"corrections"> | null;
  followUpId: Id<"followUps"> | null;
  status: OutboxStatus;
  errorKind: string | null;
  errorMessage: string | null;
  reservedAt: number;
  sentAt: number | null;
  simulated: boolean;
};

export type ThreadDetail = {
  thread: ThreadSummary;
  inn: { _id: Id<"inns">; name: string; isDemo: boolean };
  messages: {
    _id: Id<"messages">;
    direction: "in" | "out";
    from: string;
    to: string;
    text: string;
    at: number;
  }[];
  draft: {
    _id: Id<"drafts">;
    class: DraftClass;
    answer: string;
    abstain: boolean;
    gapQuestion: string | null;
    status: DraftStatus;
    model: string;
    judgeVerdict: JudgeVerdict | null;
    /** The exact text the verdict applies to; sending "ready" requires answer === verifiedText. */
    verifiedText: string | null;
    statusReason: string | null;
    textSource: TextSource;
    replyToMessageId: Id<"messages"> | null;
  } | null;
  claims: {
    _id: Id<"claims">;
    statement: string;
    url: string;
    quote: string;
    verified: boolean;
    verifyMethod: "strict" | "normalized" | null;
    status: ClaimStatus;
    source: "page" | "fact";
    pageVersionId: Id<"pageVersions"> | null;
    staffFactId: Id<"staffFacts"> | null;
    /** Page version is still the page's latest / fact not superseded. */
    currentSource: boolean;
  }[];
  facts: { _id: Id<"staffFacts">; question: string; answer: string; authorName: string }[];
  sentReplies: {
    _id: Id<"sentReplies">;
    sentAt: number;
    kind: "reply" | "correction";
    text: string | null;
    textSource: TextSource | null;
    simulated: boolean;
    outboxId: Id<"outbox"> | null;
    correctionId: Id<"corrections"> | null;
  }[];
  corrections: {
    _id: Id<"corrections">;
    status: CorrectionStatus;
    oldQuote: string;
    newPassage: string | null;
    proposedText: string | null;
  }[];
  outbox: OutboxRow[];
  /** The reminder only (never mail). Approved follow-up emails come from `FollowUpEmailView`. */
  followUp: { dueAt: number; status: "scheduled" | "due" } | null;
};

/**
 * scheduled: approved, waiting for its due time. reserved: the due worker
 * handed it to the outbox; the approval is frozen (also the resting state of
 * an unknown delivery, which is never retried). sent / failed / cancelled are
 * final; `statusReason` says why for the last two.
 */
export type FollowUpEmailStatus = "scheduled" | "reserved" | "sent" | "failed" | "cancelled";

export type FollowUpEmail = {
  _id: Id<"followUps">;
  status: FollowUpEmailStatus;
  dueAt: number;
  /** The exact approved text. */
  text: string | null;
  approvedAt: number | null;
  approvedBy: Id<"users"> | null;
  approvedByName: string | null;
  inboundMessageId: Id<"messages"> | null;
  simulated: boolean;
  outboxId: Id<"outbox"> | null;
  delivery: { status: OutboxStatus; errorKind: string | null; errorMessage: string | null; sentAt: number | null } | null;
  sentAt: number | null;
  statusReason: string | null;
  cancelledAt: number | null;
};

/** Mirror of `followUps.emailForThread`. */
export type FollowUpEmailView = {
  /** The only text that can be approved; submit it verbatim. */
  text: string;
  minDueAt: number;
  maxDueAt: number;
  defaultDueAt: number;
  /** Demo inns simulate the send; nothing reaches a provider. */
  simulated: boolean;
  canApprove: boolean;
  blockedReason: string | null;
  /** The caller must hold the thread claim to approve or cancel. */
  requiresClaim: boolean;
  /** The approval for the guest's current message, if one is pending, reserved or sent. */
  current: FollowUpEmail | null;
  /** Every approval on the thread, newest first. */
  history: FollowUpEmail[];
};

export type ApproveFollowUpResult = { followUpId: Id<"followUps">; dueAt: number; replaced: boolean };

export type PageKind = "policies" | "rooms" | "rates" | "notices" | "other";
export type ChangeStatus = "new" | "same" | "changed";

export type PageSummary = {
  _id: Id<"pages">;
  url: string;
  title: string;
  kind: PageKind;
  watched: boolean;
  lastVersion: {
    _id: Id<"pageVersions">;
    hash: string;
    scrapedAt: number;
    changeStatus: ChangeStatus;
  } | null;
};

export type PageVersion = {
  _id: Id<"pageVersions">;
  markdown: string;
  hash: string;
  scrapedAt: number;
};

export type RecordVersionResult = {
  pageVersionId: Id<"pageVersions">;
  changeStatus: ChangeStatus;
  /** Claim counts. */
  affected: number;
  unaffected: number;
  /** Sent-reply counts (a reply with any vanished claim is affected, not a control). */
  affectedReplies: number;
  unaffectedReplies: number;
};

export type StaffFact = {
  _id: Id<"staffFacts">;
  question: string;
  answer: string;
  authorName: string;
  createdAt: number;
};

export type CorrectionStatus = "needs_review" | "approved" | "sent" | "dismissed" | "superseded";
export type CorrectionTextSource = "generated" | "staff" | "fixture";

export type Correction = {
  _id: Id<"corrections">;
  status: CorrectionStatus;
  threadId: Id<"threads">;
  sentReplyId: Id<"sentReplies">;
  claimId: Id<"claims">;
  subject: string;
  guestEmail: string;
  statement: string;
  /** Exact text of the reply the guest received. */
  sentText: string;
  pageUrl: string;
  oldQuote: string;
  newPassage: string | null;
  proposedText: string | null;
  evidenceQuote: string | null;
  textSource: CorrectionTextSource | null;
  judgeVerdict: JudgeVerdict | null;
  statusReason: string | null;
  oldVersionId: Id<"pageVersions">;
  newVersionId: Id<"pageVersions">;
  /** newVersionId is still the page's latest version. */
  isCurrent: boolean;
  reviewedAt: number | null;
  supersededById: Id<"corrections"> | null;
  createdAt: number;
};

export type UnaffectedControl = {
  claimId: Id<"claims">;
  threadId: Id<"threads">;
  subject: string;
  statement: string;
  quote: string;
  pageUrl: string;
};

export type DemoStatus = {
  policyVersion: "changed" | "original";
  sentReplies: number;
  affectedReplies: number;
  unaffectedReplies: number;
  pendingCorrections: number;
  approvedCorrections: number;
  sentCorrections: number;
} | null;

export type ClaimResult = { kind: "acquired" | "renewed" | "took_over_expired"; expiresAt: number };

export type IntegrationStatus = {
  openai: boolean;
  firecrawl: boolean;
  agentmail: boolean;
  webhookSecret: boolean;
  /** The deployment knows which provider webhook it owns; not proof that any inbox is subscribed. */
  webhookId: boolean;
  inboxConfigured: boolean;
  /** True only when this inn's inbox was confirmed subscribed to the webhook this deployment currently uses. */
  inboxWebhookReady: boolean;
  liveMail: LiveMailDecision;
};

export type CrawlRun = {
  _id: Id<"crawlRuns">;
  trigger: "staff" | "cron";
  startedAt: number;
  finishedAt: number | null;
  status: "running" | "done" | "failed";
  pagesStored: number;
  pagesSkipped: number;
  reason: string | null;
};

export type CrawlResult = { runId: Id<"crawlRuns">; pagesStored: number; pagesSkipped: number; affectedClaims: number };

export type WorkspaceView = "corrections" | "inbox" | "knowledge" | "settings";
