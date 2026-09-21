import { afterEach, describe, expect, it, vi } from "vitest";
import { api, components, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { archiveEventId, archiveIdentity, HASHED_IDENTITY_PREFIX, MAX_ARCHIVE_ADDRESS, MAX_ARCHIVE_IDENTITY, MAX_ARCHIVE_METADATA, normalizedArchiveEvent } from "../convex/agentmailArchive";
import { MAX_INBOUND_TEXT, MAX_SUBJECT } from "../convex/lib/inboundPayload";
import { sha256Hex } from "../convex/lib/quotes";
import { signWebhook } from "../convex/lib/webhookSignature";
import { makeTest, signedInUser, type T } from "./setup";
import { seedLiveInn, TEST_SECRET, withEnv } from "./integrationSetup";

// The follow-up cancellation runs after the archive call inside inbound.receive;
// one test makes it throw to prove the component write rolls back with the receipt.
vi.mock("../convex/followUps", async (importOriginal) => {
  const original = await importOriginal<typeof import("../convex/followUps")>();
  return { ...original, cancelFollowUps: vi.fn(original.cancelFollowUps) };
});
import { cancelFollowUps } from "../convex/followUps";

const PATH = "/api/agentmail/webhook";

function received(overrides: Record<string, unknown> = {}, messageOverrides: Record<string, unknown> = {}) {
  return {
    type: "event",
    event_type: "message.received",
    event_id: "evt_1",
    message: {
      inbox_id: "seagull@agentmail.to",
      message_id: "<m1@email.amazonses.com>",
      thread_id: "thr_abc",
      from: "Dana Ruiz <dana@example.com>",
      to: "seagull@agentmail.to",
      subject: "Bringing our dog",
      text: "Can we bring our dog in October?",
      extracted_text: "Can we bring our dog in October?",
      in_reply_to: "<parent@mail.example>",
      headers: { "message-id": "<m1-rfc@mail.example>" },
      timestamp: "2026-09-21T10:00:00.000Z",
      ...messageOverrides,
    },
    ...overrides,
  };
}

async function signedPost(t: T, body: unknown, id: string, secret = TEST_SECRET) {
  const raw = JSON.stringify(body);
  const headers = await signWebhook(secret, raw, id);
  return t.fetch(PATH, { method: "POST", body: raw, headers: { "content-type": "application/json", ...headers } });
}

/** What the component itself archived, read through its own query from inside the app. */
const archived = (t: T, inboxId?: string) =>
  t.run(async (ctx) => (await ctx.runQuery(components.agentmail.lib.listInboundMessages, inboxId ? { inboxId } : {})) as Array<Record<string, unknown>>);

const appMessages = (t: T) => t.run((ctx) => ctx.db.query("messages").collect());
const appEvents = (t: T) => t.run((ctx) => ctx.db.query("webhookEvents").collect());

describe("inbound archive in the @agentmail/convex component", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.mocked(cancelFollowUps).mockReset();
  });

  it("namespaces the component event id by inn and hashes (never truncates) the provider id", async () => {
    const innA = "inn_a" as Id<"inns">;
    const innB = "inn_b" as Id<"inns">;
    const hash = await sha256Hex("evt_1");
    expect(await archiveEventId(innA, "evt_1")).toBe(`inn:inn_a:evt:sha256:${hash}`);
    expect(await archiveEventId(innB, "evt_1")).not.toBe(await archiveEventId(innA, "evt_1"));
    // Two ids that share a long prefix stay distinct however long they are.
    const long = "x".repeat(100_000);
    const a = await archiveEventId(innA, long + "1");
    const b = await archiveEventId(innA, long + "2");
    expect(a).not.toBe(b);
    expect(a.length).toBeLessThan(200);
  });

  it("keeps small provider identities exact and hashes (never truncates) oversized or prefix-reserved ones", async () => {
    expect(await archiveIdentity("thr_abc")).toEqual({ value: "thr_abc", hashed: false });
    expect(await archiveIdentity("<m1@email.amazonses.com>")).toEqual({ value: "<m1@email.amazonses.com>", hashed: false });
    const atLimit = "t".repeat(MAX_ARCHIVE_IDENTITY);
    expect(await archiveIdentity(atLimit)).toEqual({ value: atLimit, hashed: false });
    const over = atLimit + "1";
    const hashedOver = await archiveIdentity(over);
    expect(hashedOver).toEqual({ value: `${HASHED_IDENTITY_PREFIX}${await sha256Hex(over)}`, hashed: true });
    expect(hashedOver.value.length).toBe(HASHED_IDENTITY_PREFIX.length + 64);
    // Long ids sharing a prefix stay distinct.
    const shared = "thr_" + "9".repeat(100_000);
    expect((await archiveIdentity(shared + "a")).value).not.toBe((await archiveIdentity(shared + "b")).value);
    // A literal short id that starts with the reserved prefix is hashed too, so it can never
    // equal the hashed form of a different (oversized) id.
    const alias = hashedOver.value;
    const hashedAlias = await archiveIdentity(alias);
    expect(hashedAlias.hashed).toBe(true);
    expect(hashedAlias.value).not.toBe(hashedOver.value);
    expect(hashedAlias.value.startsWith(HASHED_IDENTITY_PREFIX)).toBe(true);
    // The component event id uses the same reserved prefix under its inn namespace.
    expect(await archiveEventId("inn_a" as Id<"inns">, "evt_1")).toContain(`:evt:${HASHED_IDENTITY_PREFIX}`);
  });

  it("archives oversized identities in hashed form with their original lengths, within a bounded event", async () => {
    const innId = "inn_a" as Id<"inns">;
    const inboxId = "i".repeat(200_000);
    const threadId = "thr_" + "9".repeat(200_000) + "a";
    const messageId = "<" + "m".repeat(200_000) + "@x>";
    const base = { eventId: "evt_1", from: "a", to: "b", subject: "s", text: "x", receivedAt: Date.parse("2026-09-21T10:00:00.000Z") };
    const event = await normalizedArchiveEvent(innId, { ...base, inboxId, providerThreadId: threadId, providerMessageId: messageId });
    const m = event.message as Record<string, string>;
    expect(m.inbox_id).toBe((await archiveIdentity(inboxId)).value);
    expect(m.thread_id).toBe((await archiveIdentity(threadId)).value);
    expect(m.message_id).toBe((await archiveIdentity(messageId)).value);
    for (const key of ["inbox_id", "thread_id", "message_id"]) expect(m[key].length).toBeLessThanOrEqual(MAX_ARCHIVE_IDENTITY);
    expect(event.metadata.hashed_identity_lengths).toEqual({ inbox_id: 200_000, thread_id: 200_005, message_id: 200_004 });
    expect(JSON.stringify(event).length).toBeLessThan(2_000);
    // A sibling with a distinct oversized thread id archives a distinct thread id.
    const sibling = await normalizedArchiveEvent(innId, { ...base, inboxId, providerThreadId: threadId.slice(0, -1) + "b", providerMessageId: messageId });
    expect((sibling.message as Record<string, string>).thread_id).not.toBe(m.thread_id);
    // Normal ids carry no hashed metadata at all.
    const normal = await normalizedArchiveEvent(innId, { ...base, inboxId: "seagull@agentmail.to", providerThreadId: "thr_1", providerMessageId: "<m1@x>" });
    expect(normal.metadata).not.toHaveProperty("hashed_identity_lengths");
  });

  it("normalizes only the app's parsed fields, with every string bounded", async () => {
    const innId = "inn_a" as Id<"inns">;
    const event = await normalizedArchiveEvent(innId, {
      eventId: "e".repeat(5_000),
      inboxId: "seagull@agentmail.to",
      providerMessageId: "<m1@x>",
      providerThreadId: "thr_1",
      from: "f".repeat(10_000),
      to: "t".repeat(10_000),
      subject: "s".repeat(10_000),
      text: "w ".repeat(60_000),
      inReplyTo: "r".repeat(10_000),
      rfcMessageId: "i".repeat(10_000),
      receivedAt: Date.parse("2026-09-21T10:00:00.000Z"),
    });
    expect(event).toMatchObject({ type: "event", event_type: "message.received" });
    expect(event.event_id).toBe(await archiveEventId(innId, "e".repeat(5_000)));
    const m = event.message as Record<string, unknown>;
    expect(Object.keys(m).sort()).toEqual(["from", "headers", "in_reply_to", "inbox_id", "message_id", "preview", "subject", "text", "thread_id", "timestamp", "to"]);
    expect(m).toMatchObject({ inbox_id: "seagull@agentmail.to", message_id: "<m1@x>", thread_id: "thr_1", timestamp: "2026-09-21T10:00:00.000Z" });
    expect((m.from as string).length).toBe(MAX_ARCHIVE_ADDRESS);
    expect((m.to as string).length).toBe(MAX_ARCHIVE_ADDRESS);
    expect((m.subject as string).length).toBe(MAX_SUBJECT);
    expect((m.text as string).length).toBe(MAX_INBOUND_TEXT);
    expect((m.preview as string).length).toBeLessThanOrEqual(200);
    expect((m.in_reply_to as string).length).toBe(MAX_ARCHIVE_METADATA);
    expect(((m.headers as Record<string, string>)["message-id"]).length).toBe(MAX_ARCHIVE_METADATA);
    expect(event.metadata).toEqual({ innId, original_event_id: "e".repeat(MAX_ARCHIVE_METADATA), original_event_id_length: 5_000 });
    // A single archived event never approaches the document limit, even though the component stores it twice.
    expect(JSON.stringify(event).length).toBeLessThan(200_000);
    // A pathological timestamp does not throw and still yields an ISO string.
    const odd = await normalizedArchiveEvent(innId, { eventId: "e", inboxId: "i", providerMessageId: "m", providerThreadId: "t", from: "a", to: "b", subject: "s", text: "x", receivedAt: Number.MAX_SAFE_INTEGER });
    const oddMessage = odd.message as Record<string, unknown>;
    expect(typeof oddMessage.timestamp).toBe("string");
    expect(oddMessage).not.toHaveProperty("headers");
    expect(oddMessage.in_reply_to).toBeUndefined();
  });

  it("a verified delivery is archived once in the component and stored once in the app; duplicates add nothing", async () => {
    withEnv({ AGENTMAIL_WEBHOOK_SECRET: TEST_SECRET });
    const t = makeTest();
    const owner = await signedInUser(t, { name: "Owner" });
    const { innId } = await seedLiveInn(t, owner.userId);

    expect(await (await signedPost(t, received(), "d1")).json()).toEqual({ ok: true, outcome: "stored" });

    const rows = await archived(t, "seagull@agentmail.to");
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row).toMatchObject({
      inboxId: "seagull@agentmail.to",
      threadId: "thr_abc",
      messageId: "<m1@email.amazonses.com>",
      eventId: await archiveEventId(innId, "evt_1"),
      from: "Dana Ruiz <dana@example.com>",
      to: ["seagull@agentmail.to"],
      subject: "Bringing our dog",
      preview: "Can we bring our dog in October?",
      text: "Can we bring our dog in October?",
      inReplyTo: "<parent@mail.example>",
      timestamp: Date.parse("2026-09-21T10:00:00.000Z"),
    });
    // The archived copy is the normalized event, not the raw external payload.
    const raw = row.raw as Record<string, unknown>;
    expect(raw).not.toHaveProperty("extracted_text");
    expect(raw.headers).toEqual({ "message-id": "<m1-rfc@mail.example>" });
    expect(row.extractedText).toBeUndefined();
    expect(row.html).toBeUndefined();
    // The app's own receipt is unchanged: one message, original identity intact.
    const messages = await appMessages(t);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ innId, agentmailMessageId: "<m1@email.amazonses.com>", agentmailThreadId: "thr_abc", rfcMessageId: "<m1-rfc@mail.example>" });
    expect((await appEvents(t))[0]).toMatchObject({ innId, eventId: "evt_1", providerMessageId: "<m1@email.amazonses.com>" });

    // Redelivery of the event and the same message under a new event id: no extra archive rows.
    expect(await (await signedPost(t, received(), "d2")).json()).toEqual({ ok: true, outcome: "duplicate" });
    expect(await (await signedPost(t, received({ event_id: "evt_2" }), "d3")).json()).toEqual({ ok: true, outcome: "duplicate" });
    expect(await archived(t)).toHaveLength(1);
    expect(await appMessages(t)).toHaveLength(1);
    expect(await appEvents(t)).toHaveLength(1);
  });

  it("an unknown inbox and a demo inn's inbox store neither an app message nor an archive row", async () => {
    withEnv({ AGENTMAIL_WEBHOOK_SECRET: TEST_SECRET });
    const t = makeTest();
    const owner = await signedInUser(t, { name: "Owner" });
    await seedLiveInn(t, owner.userId);
    await t.run(async (ctx) => {
      const demoId = await ctx.db.insert("inns", { name: "Demo", siteUrl: "https://demo.example", timezone: "UTC", isDemo: true, createdBy: owner.userId, inboxId: "demo@agentmail.to" });
      await ctx.db.insert("memberships", { innId: demoId, userId: owner.userId, role: "owner", name: "Owner" });
    });

    expect(await (await signedPost(t, received({}, { inbox_id: "stranger@agentmail.to" }), "u1")).json()).toEqual({ ok: true, outcome: "unknown_inbox" });
    expect(await (await signedPost(t, received({ event_id: "evt_demo" }, { inbox_id: "demo@agentmail.to" }), "u2")).json()).toEqual({ ok: true, outcome: "unknown_inbox" });
    expect(await archived(t)).toEqual([]);
    expect(await appMessages(t)).toEqual([]);
    expect(await appEvents(t)).toEqual([]);
  });

  it("the same provider event delivered to two inns is archived once per inn", async () => {
    withEnv({ AGENTMAIL_WEBHOOK_SECRET: TEST_SECRET });
    const t = makeTest();
    const a = await signedInUser(t, { name: "A" });
    const b = await signedInUser(t, { name: "B" });
    const innA = await seedLiveInn(t, a.userId, { inboxId: "a@agentmail.to" });
    const innB = await seedLiveInn(t, b.userId, { inboxId: "b@agentmail.to" });

    // Identical event_id, message_id and thread_id at both inns.
    expect(await (await signedPost(t, received({}, { inbox_id: "a@agentmail.to", to: "a@agentmail.to" }), "s1")).json()).toEqual({ ok: true, outcome: "stored" });
    expect(await (await signedPost(t, received({}, { inbox_id: "b@agentmail.to", to: "b@agentmail.to" }), "s2")).json()).toEqual({ ok: true, outcome: "stored" });

    const rowsA = await archived(t, "a@agentmail.to");
    const rowsB = await archived(t, "b@agentmail.to");
    expect(rowsA).toHaveLength(1);
    expect(rowsB).toHaveLength(1);
    expect(rowsA[0].eventId).toBe(await archiveEventId(innA.innId, "evt_1"));
    expect(rowsB[0].eventId).toBe(await archiveEventId(innB.innId, "evt_1"));
    expect(rowsA[0].eventId).not.toBe(rowsB[0].eventId);
    expect(await archived(t)).toHaveLength(2);
    expect(await a.as.query(api.threads.queue, { innId: innA.innId })).toHaveLength(1);
    expect(await b.as.query(api.threads.queue, { innId: innB.innId })).toHaveLength(1);
    // A redelivery at A is still a per-inn duplicate; B's copy is untouched.
    expect(await (await signedPost(t, received({}, { inbox_id: "a@agentmail.to", to: "a@agentmail.to" }), "s3")).json()).toEqual({ ok: true, outcome: "duplicate" });
    expect(await archived(t)).toHaveLength(2);
  });

  it("a tampered or unsigned delivery archives nothing", async () => {
    withEnv({ AGENTMAIL_WEBHOOK_SECRET: TEST_SECRET });
    const t = makeTest();
    const owner = await signedInUser(t, { name: "Owner" });
    await seedLiveInn(t, owner.userId);

    const raw = JSON.stringify(received());
    const h = await signWebhook(TEST_SECRET, raw, "t1");
    expect((await t.fetch(PATH, { method: "POST", body: raw.replace("dog", "cat"), headers: h })).status).toBe(401);
    expect((await t.fetch(PATH, { method: "POST", body: raw })).status).toBe(401);
    expect((await signedPost(t, received(), "t2", "whsec_" + btoa("someone-else"))).status).toBe(401);
    expect(await archived(t)).toEqual([]);
    expect(await appMessages(t)).toEqual([]);
    expect(await appEvents(t)).toEqual([]);
  });

  it("very long identifiers keep the archive bounded without changing the app's reply identity", async () => {
    withEnv({ AGENTMAIL_WEBHOOK_SECRET: TEST_SECRET });
    const t = makeTest();
    const owner = await signedInUser(t, { name: "Owner" });
    const { innId } = await seedLiveInn(t, owner.userId);
    const longEventId = "evt_" + "9".repeat(100_000);
    const longFrom = `Dana Ruiz <dana@example.com>` + " ".repeat(50_000);
    const longInReplyTo = "<" + "p".repeat(50_000) + "@mail.example>";
    const longRfc = "<" + "r".repeat(50_000) + "@mail.example>";
    const body = received({ event_id: longEventId }, { from: longFrom, in_reply_to: longInReplyTo, headers: { "message-id": longRfc } });
    expect(JSON.stringify(body).length).toBeGreaterThan(250_000);

    expect(await (await signedPost(t, body, "l1")).json()).toEqual({ ok: true, outcome: "stored" });

    const [row] = await archived(t, "seagull@agentmail.to");
    expect(row.eventId).toBe(await archiveEventId(innId, longEventId));
    expect((row.eventId as string).length).toBeLessThan(200);
    expect((row.from as string).length).toBe(MAX_ARCHIVE_ADDRESS);
    expect((row.inReplyTo as string).length).toBe(MAX_ARCHIVE_METADATA);
    expect(JSON.stringify(row).length).toBeLessThan(20_000);
    // The app's own rows keep the original, untruncated identity for threading and replies.
    const [message] = await appMessages(t);
    expect(message).toMatchObject({ agentmailMessageId: "<m1@email.amazonses.com>", agentmailThreadId: "thr_abc", from: longFrom, inReplyTo: longInReplyTo, rfcMessageId: longRfc });
    const [event] = await appEvents(t);
    expect(event).toMatchObject({ innId, eventId: longEventId, providerMessageId: "<m1@email.amazonses.com>" });
    // The same long event id is still a duplicate for this inn.
    expect(await (await signedPost(t, body, "l2")).json()).toEqual({ ok: true, outcome: "duplicate" });
    expect(await archived(t)).toHaveLength(1);
  });

  it("oversized shared-prefix thread and message ids archive as distinct bounded rows while the app keeps the exact ids", async () => {
    withEnv({ AGENTMAIL_WEBHOOK_SECRET: TEST_SECRET });
    const t = makeTest();
    const owner = await signedInUser(t, { name: "Owner" });
    const { innId } = await seedLiveInn(t, owner.userId);
    const threadPrefix = "thr_" + "9".repeat(300_000);
    const messagePrefix = "<" + "m".repeat(300_000);
    const first = received({ event_id: "evt_long_1" }, { thread_id: threadPrefix + "a", message_id: messagePrefix + "a@x>" });
    const second = received({ event_id: "evt_long_2" }, { thread_id: threadPrefix + "b", message_id: messagePrefix + "b@x>" });
    expect(JSON.stringify(first).length).toBeGreaterThan(600_000);

    expect(await (await signedPost(t, first, "p1")).json()).toEqual({ ok: true, outcome: "stored" });
    expect(await (await signedPost(t, second, "p2")).json()).toEqual({ ok: true, outcome: "stored" });

    const rows = await archived(t, "seagull@agentmail.to");
    expect(rows).toHaveLength(2);
    const byMessage = new Map(rows.map((r) => [r.messageId as string, r]));
    const firstRow = byMessage.get((await archiveIdentity(messagePrefix + "a@x>")).value)!;
    const secondRow = byMessage.get((await archiveIdentity(messagePrefix + "b@x>")).value)!;
    expect(firstRow).toBeDefined();
    expect(secondRow).toBeDefined();
    expect(firstRow.threadId).toBe((await archiveIdentity(threadPrefix + "a")).value);
    expect(secondRow.threadId).toBe((await archiveIdentity(threadPrefix + "b")).value);
    expect(firstRow.threadId).not.toBe(secondRow.threadId);
    expect(firstRow.inboxId).toBe("seagull@agentmail.to");
    for (const row of [firstRow, secondRow]) {
      expect((row.threadId as string).length).toBeLessThanOrEqual(MAX_ARCHIVE_IDENTITY);
      expect((row.messageId as string).length).toBeLessThanOrEqual(MAX_ARCHIVE_IDENTITY);
      expect(JSON.stringify(row).length).toBeLessThan(20_000);
    }
    // The archived raw copy carries the same bounded identities (the component has no events query to read its audit row).
    expect((firstRow.raw as Record<string, unknown>).thread_id).toBe(firstRow.threadId);
    expect((firstRow.raw as Record<string, unknown>).message_id).toBe(firstRow.messageId);
    // The app's own rows keep the exact provider ids, and so does its dedupe.
    const messages = await appMessages(t);
    expect(messages.map((m) => m.agentmailMessageId).sort()).toEqual([messagePrefix + "a@x>", messagePrefix + "b@x>"]);
    expect(messages.map((m) => m.agentmailThreadId).sort()).toEqual([threadPrefix + "a", threadPrefix + "b"]);
    expect((await appEvents(t)).map((e) => e.providerMessageId).sort()).toEqual([messagePrefix + "a@x>", messagePrefix + "b@x>"]);
    expect(await (await signedPost(t, first, "p3")).json()).toEqual({ ok: true, outcome: "duplicate" });
    expect(await archived(t)).toHaveLength(2);
    expect(await appMessages(t)).toHaveLength(2);
    expect(await owner.as.query(api.threads.queue, { innId })).toHaveLength(2);
  });

  it("the archive rolls back with the app receipt when the transaction fails after it", async () => {
    withEnv({ AGENTMAIL_WEBHOOK_SECRET: TEST_SECRET });
    const t = makeTest();
    const owner = await signedInUser(t, { name: "Owner" });
    await seedLiveInn(t, owner.userId);
    vi.mocked(cancelFollowUps).mockImplementationOnce(async () => {
      throw new Error("simulated failure after the archive call");
    });

    await expect(t.mutation(internal.inbound.receive, {
      eventId: "evt_fail",
      inboxId: "seagull@agentmail.to",
      providerMessageId: "<fail@x>",
      providerThreadId: "thr_fail",
      from: "dana@example.com",
      to: "seagull@agentmail.to",
      subject: "Boom",
      text: "This receipt fails late.",
      receivedAt: Date.now(),
    })).rejects.toThrow(/simulated failure/);
    expect(vi.mocked(cancelFollowUps)).toHaveBeenCalledTimes(1);

    expect(await archived(t)).toEqual([]);
    expect(await appMessages(t)).toEqual([]);
    expect(await appEvents(t)).toEqual([]);
    // The same delivery succeeds afterwards: nothing stale blocks it.
    expect(await (await signedPost(t, received({ event_id: "evt_fail" }, { message_id: "<fail@x>", thread_id: "thr_fail" }), "f1")).json()).toEqual({ ok: true, outcome: "stored" });
    expect(await archived(t)).toHaveLength(1);
    expect(await appMessages(t)).toHaveLength(1);
  });

  it("archiving schedules nothing on the component's workpools", async () => {
    withEnv({ AGENTMAIL_WEBHOOK_SECRET: TEST_SECRET });
    const t = makeTest();
    const owner = await signedInUser(t, { name: "Owner" });
    await seedLiveInn(t, owner.userId);
    expect(await (await signedPost(t, received(), "w1")).json()).toEqual({ ok: true, outcome: "stored" });
    const scheduled = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    // Only the app's own drafter for this inbound.
    expect(scheduled.map((s) => s.name)).toEqual(["generation:generateForThread"]);
  });
});
