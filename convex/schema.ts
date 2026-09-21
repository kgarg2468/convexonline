import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { authTables } from "@convex-dev/auth/server";

export const membershipRole = v.union(v.literal("owner"), v.literal("staff"), v.literal("demo"));
export const pageKind = v.union(
  v.literal("policies"),
  v.literal("rooms"),
  v.literal("rates"),
  v.literal("notices"),
  v.literal("other"),
);
export const changeStatus = v.union(v.literal("new"), v.literal("same"), v.literal("changed"));
export const threadStatus = v.union(
  v.literal("new"),
  v.literal("drafting"),
  v.literal("needs_staff"),
  v.literal("ready"),
  v.literal("sent"),
  v.literal("waiting_guest"),
  v.literal("closed"),
);
export const stayStatus = v.union(v.literal("inquiry"), v.literal("booked"));
export const stay = v.object({
  checkIn: v.optional(v.string()),
  checkOut: v.optional(v.string()),
  party: v.optional(v.number()),
  status: stayStatus,
});
export const draftClass = v.union(
  v.literal("answerable"),
  v.literal("needs_staff_fact"),
  v.literal("needs_availability_or_approval"),
);
export const draftStatus = v.union(
  v.literal("verifying"),
  v.literal("needs_edit"),
  v.literal("ready"),
  v.literal("sent"),
  v.literal("superseded"),
);
export const claimStatus = v.union(
  v.literal("ok"),
  v.literal("stripped"),
  v.literal("needs_review"),
  v.literal("corrected"),
);
export const verifyMethod = v.union(v.literal("strict"), v.literal("normalized"));
export const factScope = v.union(v.literal("general"), v.literal("thread"));
export const correctionStatus = v.union(
  v.literal("needs_review"),
  v.literal("approved"),
  v.literal("sent"),
  v.literal("dismissed"),
  v.literal("superseded"),
);
/** Who authored the exact outgoing text. "fixture" is demo-only and never has model provenance. */
export const textSource = v.union(v.literal("model"), v.literal("staff"), v.literal("fixture"));
export const outboxStatus = v.union(
  v.literal("reserved"),
  v.literal("sending"),
  v.literal("sent"),
  v.literal("failed"),
  v.literal("unknown"),
);
export const judgeVerdict = v.object({
  entailed: v.boolean(),
  promisedOutsideQuotes: v.boolean(),
  notes: v.string(),
});

export default defineSchema({
  ...authTables,

  inns: defineTable({
    name: v.string(),
    siteUrl: v.string(),
    inboxId: v.optional(v.string()),
    inboxAddress: v.optional(v.string()),
    timezone: v.string(),
    /** Demo inns are seeded per anonymous user and never touch live mail. */
    isDemo: v.boolean(),
    createdBy: v.id("users"),
    /** Set when the inbox was provisioned through the provider (server-controlled client_id). */
    inboxClientId: v.optional(v.string()),
    /**
     * Provider webhook id the bound inbox was confirmed subscribed to. Set only
     * after the provider acknowledged the subscription; readiness compares it
     * with the deployment's current AGENTMAIL_WEBHOOK_ID.
     */
    inboxWebhookId: v.optional(v.string()),
    inboxWebhookConfirmedAt: v.optional(v.number()),
    lastCrawlStartedAt: v.optional(v.number()),
  })
    .index("by_createdBy", ["createdBy"])
    .index("by_inboxId", ["inboxId"]),

  crawlRuns: defineTable({
    innId: v.id("inns"),
    userId: v.optional(v.id("users")),
    trigger: v.union(v.literal("staff"), v.literal("cron")),
    startedAt: v.number(),
    finishedAt: v.optional(v.number()),
    status: v.union(v.literal("running"), v.literal("done"), v.literal("failed")),
    pagesStored: v.number(),
    pagesSkipped: v.number(),
    reason: v.optional(v.string()),
  })
    .index("by_inn_startedAt", ["innId", "startedAt"])
    .index("by_user_startedAt", ["userId", "startedAt"]),

  memberships: defineTable({
    innId: v.id("inns"),
    userId: v.id("users"),
    role: membershipRole,
    name: v.string(),
  })
    .index("by_user", ["userId"])
    .index("by_inn", ["innId"])
    .index("by_inn_user", ["innId", "userId"]),

  pages: defineTable({
    innId: v.id("inns"),
    url: v.string(),
    title: v.string(),
    kind: pageKind,
    watched: v.boolean(),
    lastVersionId: v.optional(v.id("pageVersions")),
    lastCheckedAt: v.optional(v.number()),
  })
    .index("by_inn", ["innId"])
    .index("by_inn_url", ["innId", "url"]),

  pageVersions: defineTable({
    pageId: v.id("pages"),
    markdown: v.string(),
    hash: v.string(),
    scrapedAt: v.number(),
    changeStatus,
    diffText: v.optional(v.string()),
  }).index("by_page_scrapedAt", ["pageId", "scrapedAt"]),

  threads: defineTable({
    innId: v.id("inns"),
    agentmailThreadId: v.optional(v.string()),
    guestEmail: v.string(),
    subject: v.string(),
    snippet: v.string(),
    status: threadStatus,
    stay: v.optional(stay),
    claimedBy: v.optional(v.id("users")),
    claimedAt: v.optional(v.number()),
    lastInboundAt: v.number(),
    /** The newest inbound message; drafts and sends are bound to it. */
    lastInboundMessageId: v.optional(v.id("messages")),
    firstResponseMs: v.optional(v.number()),
    /** subject + guest email + snippet, for the search index. */
    searchableText: v.optional(v.string()),
    lastGenerationAt: v.optional(v.number()),
  })
    .index("by_inn_status", ["innId", "status"])
    .index("by_inn_lastInbound", ["innId", "lastInboundAt"])
    .index("by_inn_agentmail_thread", ["innId", "agentmailThreadId"])
    .searchIndex("search_threads", {
      searchField: "searchableText",
      filterFields: ["innId"],
    }),

  /** Provider webhook deliveries already applied, scoped to the inn that owns the inbox. */
  webhookEvents: defineTable({
    innId: v.id("inns"),
    eventId: v.string(),
    providerMessageId: v.string(),
    receivedAt: v.number(),
  })
    .index("by_inn_event", ["innId", "eventId"])
    .index("by_inn_message", ["innId", "providerMessageId"]),

  messages: defineTable({
    threadId: v.id("threads"),
    /**
     * Denormalized owner inn (always the thread's inn) so In-Reply-To parents
     * can be looked up directly inside the receiving inn. Optional only while
     * rows written before the field existed are backfilled by
     * `migrations.backfillMessageInnIds`; every writer sets it.
     */
    innId: v.optional(v.id("inns")),
    direction: v.union(v.literal("in"), v.literal("out")),
    agentmailMessageId: v.optional(v.string()),
    rfcMessageId: v.optional(v.string()),
    from: v.string(),
    to: v.string(),
    text: v.string(),
    html: v.optional(v.string()),
    at: v.number(),
    inReplyTo: v.optional(v.string()),
    /** Provider inbox that received/sent the message (AgentMail ids are per inbox). */
    inboxId: v.optional(v.string()),
    agentmailThreadId: v.optional(v.string()),
  })
    .index("by_thread", ["threadId"])
    .index("by_agentmail_message_id", ["agentmailMessageId"])
    .index("by_rfc_message_id", ["rfcMessageId"])
    .index("by_inn_rfc_message_id", ["innId", "rfcMessageId"]),

  drafts: defineTable({
    threadId: v.id("threads"),
    replyToMessageId: v.optional(v.id("messages")),
    class: draftClass,
    answer: v.string(),
    abstain: v.boolean(),
    gapQuestion: v.optional(v.string()),
    status: draftStatus,
    model: v.string(),
    usage: v.optional(v.object({ input: v.number(), output: v.number(), costUsd: v.number() })),
    judgeVerdict: v.optional(judgeVerdict),
    /** Exact text the current verdict/verification applies to; sends require answer === verifiedText. */
    verifiedText: v.optional(v.string()),
    statusReason: v.optional(v.string()),
    textSource: v.optional(textSource),
    stay: v.optional(stay),
  }).index("by_thread", ["threadId"]),

  claims: defineTable({
    draftId: v.id("drafts"),
    threadId: v.id("threads"),
    innId: v.id("inns"),
    statement: v.string(),
    url: v.string(),
    /** Page provenance (absent for staff-fact claims). */
    pageId: v.optional(v.id("pages")),
    pageVersionId: v.optional(v.id("pageVersions")),
    /** Staff-fact provenance (absent for page claims). */
    staffFactId: v.optional(v.id("staffFacts")),
    quote: v.string(),
    verified: v.boolean(),
    verifyMethod: v.optional(verifyMethod),
    status: claimStatus,
    checkedAgainstVersionId: v.optional(v.id("pageVersions")),
  })
    .index("by_draft", ["draftId"])
    .index("by_page", ["pageId"])
    .index("by_pageVersion", ["pageVersionId"])
    .index("by_staffFact", ["staffFactId"]),

  /**
   * Every outbound attempt (reply or correction). A row is reserved in the same
   * transaction that authorizes the send and carries the immutable text; the
   * delivery action only ever receives the outbox id.
   */
  outbox: defineTable({
    innId: v.id("inns"),
    threadId: v.id("threads"),
    kind: v.union(v.literal("reply"), v.literal("correction")),
    draftId: v.optional(v.id("drafts")),
    correctionId: v.optional(v.id("corrections")),
    /** Our inbound message the reply threads under, and its provider ids. */
    replyToMessageId: v.id("messages"),
    providerInboxId: v.optional(v.string()),
    providerMessageId: v.optional(v.string()),
    text: v.string(),
    textSource,
    reservedBy: v.id("users"),
    reservedAt: v.number(),
    status: outboxStatus,
    simulated: v.boolean(),
    errorKind: v.optional(v.string()),
    errorMessage: v.optional(v.string()),
    sentProviderMessageId: v.optional(v.string()),
    sentAt: v.optional(v.number()),
  })
    .index("by_thread", ["threadId"])
    .index("by_draft", ["draftId"])
    .index("by_correction", ["correctionId"]),

  sentReplies: defineTable({
    threadId: v.id("threads"),
    innId: v.id("inns"),
    draftId: v.id("drafts"),
    agentmailMessageId: v.optional(v.string()),
    sentBy: v.id("users"),
    sentAt: v.number(),
    kind: v.optional(v.union(v.literal("reply"), v.literal("correction"))),
    correctionId: v.optional(v.id("corrections")),
    outboxId: v.optional(v.id("outbox")),
    messageId: v.optional(v.id("messages")),
    text: v.optional(v.string()),
    textSource: v.optional(textSource),
    simulated: v.optional(v.boolean()),
  })
    .index("by_thread", ["threadId"])
    .index("by_draft", ["draftId"])
    .index("by_correction", ["correctionId"]),

  staffFacts: defineTable({
    innId: v.id("inns"),
    question: v.string(),
    answer: v.string(),
    scope: factScope,
    threadId: v.optional(v.id("threads")),
    author: v.id("users"),
    authorName: v.string(),
    createdAt: v.number(),
    supersededBy: v.optional(v.id("staffFacts")),
  })
    .index("by_inn_scope", ["innId", "scope"])
    .index("by_thread", ["threadId"]),

  corrections: defineTable({
    innId: v.id("inns"),
    sentReplyId: v.id("sentReplies"),
    threadId: v.id("threads"),
    claimId: v.id("claims"),
    pageId: v.id("pages"),
    oldVersionId: v.id("pageVersions"),
    newVersionId: v.id("pageVersions"),
    oldQuote: v.string(),
    newPassage: v.optional(v.string()),
    proposedText: v.optional(v.string()),
    status: correctionStatus,
    reviewedBy: v.optional(v.id("users")),
    reviewedAt: v.optional(v.number()),
    /** Provenance of the correction itself: passage of `newVersionId` the text rests on. */
    evidenceQuote: v.optional(v.string()),
    evidenceVerifyMethod: v.optional(verifyMethod),
    textSource: v.optional(v.union(v.literal("generated"), v.literal("staff"), v.literal("fixture"))),
    judgeVerdict: v.optional(judgeVerdict),
    statusReason: v.optional(v.string()),
    supersededById: v.optional(v.id("corrections")),
    sentReplyIdForCorrection: v.optional(v.id("sentReplies")),
  })
    .index("by_inn_status", ["innId", "status"])
    .index("by_sentReply", ["sentReplyId"])
    .index("by_claim", ["claimId"]),

  followUps: defineTable({
    threadId: v.id("threads"),
    scheduledId: v.optional(v.id("_scheduled_functions")),
    dueAt: v.number(),
    status: v.union(v.literal("scheduled"), v.literal("cancelled"), v.literal("due"), v.literal("sent")),
  }).index("by_thread", ["threadId"]),

  /**
   * One-use staff invitations. Only the SHA-256 of the capability token is
   * stored; the raw token exists solely in the creating action's return value.
   */
  teamInvites: defineTable({
    innId: v.id("inns"),
    tokenHash: v.string(),
    createdBy: v.id("users"),
    createdAt: v.number(),
    expiresAt: v.number(),
    usedBy: v.optional(v.id("users")),
    usedAt: v.optional(v.number()),
    revokedAt: v.optional(v.number()),
    label: v.optional(v.string()),
  })
    .index("by_tokenHash", ["tokenHash"])
    .index("by_inn_expiresAt", ["innId", "expiresAt"]),
});
