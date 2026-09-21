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
export const outboxKind = v.union(v.literal("reply"), v.literal("correction"), v.literal("follow_up"));
export const outboxStatus = v.union(
  v.literal("reserved"),
  v.literal("sending"),
  v.literal("sent"),
  v.literal("failed"),
  v.literal("unknown"),
);
export const followUpKind = v.union(v.literal("reminder"), v.literal("email"));
export const followUpStatus = v.union(
  v.literal("scheduled"),
  v.literal("cancelled"),
  v.literal("due"),
  v.literal("reserved"),
  v.literal("sent"),
  v.literal("failed"),
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

  /**
   * Editable content of a fictional inn website served by this deployment at
   * `/inn/<innId>/`. One document per inn; only inns created through
   * `innWebsites.createFictional` have one, and only such inns are ever
   * rendered. Bounded plain text and small integers, never HTML.
   */
  innWebsites: defineTable({
    innId: v.id("inns"),
    publicName: v.string(),
    intro: v.string(),
    checkIn: v.string(),
    checkOut: v.string(),
    petFeePerDogPerNight: v.number(),
    maxDogs: v.number(),
    petPolicy: v.string(),
    breakfastHours: v.string(),
    wifi: v.string(),
    roomsDescription: v.string(),
    notice: v.string(),
    updatedAt: v.number(),
    updatedBy: v.id("users"),
  }).index("by_inn", ["innId"]),

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
    /** Claim locks held by one member, so removing them never scans the whole inn. */
    .index("by_inn_claimedBy", ["innId", "claimedBy"])
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
    kind: outboxKind,
    draftId: v.optional(v.id("drafts")),
    correctionId: v.optional(v.id("corrections")),
    /** The staff-approved follow-up this row delivers (kind `follow_up` only). */
    followUpId: v.optional(v.id("followUps")),
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
    .index("by_correction", ["correctionId"])
    .index("by_followUp", ["followUpId"]),

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

  /**
   * Two kinds of row share this table. Reminder rows (kind absent or
   * `reminder`) only ever flip the thread to `needs_staff` when due. Email rows
   * (kind `email`) carry a staff approval of the fixed follow-up text and are
   * the only rows that may reach the outbox; a reminder never authorizes mail.
   */
  followUps: defineTable({
    threadId: v.id("threads"),
    scheduledId: v.optional(v.id("_scheduled_functions")),
    dueAt: v.number(),
    /**
     * Reminders: scheduled → due | cancelled. Emails: scheduled → reserved
     * (outbox row exists; approval immutable) → sent | failed, or cancelled
     * before dispatch. `reserved` also covers an unknown delivery outcome.
     */
    status: followUpStatus,
    kind: v.optional(followUpKind),
    /** Email rows: the inn and approval captured at approval time. */
    innId: v.optional(v.id("inns")),
    inboundMessageId: v.optional(v.id("messages")),
    approvedText: v.optional(v.string()),
    approvedBy: v.optional(v.id("users")),
    /**
     * The exact membership row the approver held when approving. Dispatch
     * requires this very row to still exist: removing the member withdraws
     * every approval made under it, and rejoining (a new row) never revives them.
     */
    approvedByMembershipId: v.optional(v.id("memberships")),
    approvedAt: v.optional(v.number()),
    /** The normal reply the follow-up chases. */
    originalSentReplyId: v.optional(v.id("sentReplies")),
    originalDraftId: v.optional(v.id("drafts")),
    originalOutboxId: v.optional(v.id("outbox")),
    providerInboxId: v.optional(v.string()),
    providerMessageId: v.optional(v.string()),
    simulated: v.optional(v.boolean()),
    /** Set once the due worker reserved delivery; the approval is frozen from then on. */
    outboxId: v.optional(v.id("outbox")),
    sentMessageId: v.optional(v.id("messages")),
    sentAt: v.optional(v.number()),
    /** Why the row is cancelled or failed; shown to staff. */
    statusReason: v.optional(v.string()),
    cancelledAt: v.optional(v.number()),
    cancelledBy: v.optional(v.id("users")),
  })
    .index("by_thread", ["threadId"])
    /** Email approvals made under one membership row, so removing it never scans the inn's history. */
    .index("by_approver_membership_status", ["approvedByMembershipId", "status"]),

  /**
   * Progress of `migrations.backfillAggregates`: one row per source table the
   * stats aggregates (convex/aggregates.ts) are built from. `threads.stats`
   * reads the component only once every row here is `done`; until then it
   * keeps counting the tables directly, so a half-built aggregate is never
   * shown. Written only by the internal migrator.
   */
  aggregateBackfills: defineTable({
    table: v.union(v.literal("threads"), v.literal("sentReplies"), v.literal("corrections")),
    /** Pagination cursor of the next batch; absent before the first batch and once done. */
    cursor: v.optional(v.string()),
    done: v.boolean(),
    processed: v.number(),
    startedAt: v.number(),
    updatedAt: v.number(),
  }).index("by_table", ["table"]),

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
    /**
     * True until the invite is used or revoked. Combined with `expiresAt` this
     * lets the outstanding-invite check read only rows that can still be
     * accepted instead of the inn's whole invitation history.
     */
    isOpen: v.boolean(),
  })
    .index("by_tokenHash", ["tokenHash"])
    /** `expiresAt` is always `createdAt + INVITE_TTL_MS`, so this also orders by creation time. */
    .index("by_inn_expiresAt", ["innId", "expiresAt"])
    .index("by_inn_open_expiresAt", ["innId", "isOpen", "expiresAt"]),
});
