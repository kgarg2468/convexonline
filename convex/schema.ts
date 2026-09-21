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
export const claimStatus = v.union(v.literal("ok"), v.literal("stripped"), v.literal("needs_review"));
export const verifyMethod = v.union(v.literal("strict"), v.literal("normalized"));
export const factScope = v.union(v.literal("general"), v.literal("thread"));
export const correctionStatus = v.union(
  v.literal("needs_review"),
  v.literal("approved"),
  v.literal("sent"),
  v.literal("dismissed"),
);

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
  }).index("by_createdBy", ["createdBy"]),

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
    firstResponseMs: v.optional(v.number()),
  })
    .index("by_inn_status", ["innId", "status"])
    .index("by_inn_lastInbound", ["innId", "lastInboundAt"])
    .index("by_inn_agentmail_thread", ["innId", "agentmailThreadId"])
    .searchIndex("search_threads", {
      searchField: "snippet",
      filterFields: ["innId"],
    }),

  messages: defineTable({
    threadId: v.id("threads"),
    direction: v.union(v.literal("in"), v.literal("out")),
    agentmailMessageId: v.optional(v.string()),
    rfcMessageId: v.optional(v.string()),
    from: v.string(),
    to: v.string(),
    text: v.string(),
    html: v.optional(v.string()),
    at: v.number(),
    inReplyTo: v.optional(v.string()),
  })
    .index("by_thread", ["threadId"])
    .index("by_agentmail_message_id", ["agentmailMessageId"])
    .index("by_rfc_message_id", ["rfcMessageId"]),

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
    judgeVerdict: v.optional(
      v.object({ entailed: v.boolean(), promisedOutsideQuotes: v.boolean(), notes: v.string() }),
    ),
  }).index("by_thread", ["threadId"]),

  claims: defineTable({
    draftId: v.id("drafts"),
    threadId: v.id("threads"),
    innId: v.id("inns"),
    statement: v.string(),
    url: v.string(),
    pageId: v.id("pages"),
    pageVersionId: v.id("pageVersions"),
    quote: v.string(),
    verified: v.boolean(),
    verifyMethod: v.optional(verifyMethod),
    status: claimStatus,
    checkedAgainstVersionId: v.optional(v.id("pageVersions")),
  })
    .index("by_draft", ["draftId"])
    .index("by_page", ["pageId"])
    .index("by_pageVersion", ["pageVersionId"]),

  sentReplies: defineTable({
    threadId: v.id("threads"),
    innId: v.id("inns"),
    draftId: v.id("drafts"),
    agentmailMessageId: v.optional(v.string()),
    sentBy: v.id("users"),
    sentAt: v.number(),
  })
    .index("by_thread", ["threadId"])
    .index("by_draft", ["draftId"]),

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
  })
    .index("by_inn_status", ["innId", "status"])
    .index("by_sentReply", ["sentReplyId"])
    .index("by_claim", ["claimId"]),

  followUps: defineTable({
    threadId: v.id("threads"),
    scheduledId: v.optional(v.id("_scheduled_functions")),
    dueAt: v.number(),
    status: v.union(v.literal("scheduled"), v.literal("cancelled"), v.literal("sent")),
  }).index("by_thread", ["threadId"]),
});
