import { vi } from "vitest";
import type { Id } from "../convex/_generated/dataModel";
import type { T } from "./setup";

export type Route = { match: (url: string, init: RequestInit) => boolean; respond: (url: string, init: RequestInit) => Response | Promise<Response> };

/** Installs a global fetch that routes provider calls; unmatched URLs fail loudly. */
export function stubFetch(routes: Route[]) {
  const calls: Array<{ url: string; body: unknown; headers?: Record<string, string> }> = [];
  const impl = async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    let body: unknown = undefined;
    if (typeof init.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    calls.push({ url, body, headers: init.headers as Record<string, string> | undefined });
    const route = routes.find((r) => r.match(url, init));
    if (!route) throw new Error(`unexpected fetch to ${url}`);
    return await route.respond(url, init);
  };
  vi.stubGlobal("fetch", impl);
  return { calls, restore: () => vi.unstubAllGlobals() };
}

export const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** OpenAI Responses API envelope around a strict-JSON output object. */
export function responsesOutput(output: unknown) {
  return json(200, {
    status: "completed",
    output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: JSON.stringify(output) }] }],
  });
}

export type DraftOutput = {
  class?: "answerable" | "needs_staff_fact" | "needs_availability_or_approval";
  answer: string;
  abstain?: boolean;
  gapQuestion?: string | null;
  claims: Array<{ statement: string; url: string; quote: string; sourceId: string }>;
  stay?: { checkIn: string | null; checkOut: string | null; party: number | null; status: "inquiry" | "booked" | null };
};

export function draftOutput(d: DraftOutput) {
  return {
    class: d.class ?? "answerable",
    answer: d.answer,
    abstain: d.abstain ?? false,
    gapQuestion: d.gapQuestion ?? null,
    claims: d.claims,
    stay: d.stay ?? { checkIn: null, checkOut: null, party: null, status: null },
  };
}

export const judgeOutput = (entailed = true, promised = false, notes = "ok") => ({ entailed, promised, notes });

/** Routes drafter vs judge calls by the model name in the request body. */
export function openaiRoutes(opts: {
  draft: (body: Record<string, unknown>) => Response | Promise<Response>;
  judge?: (body: Record<string, unknown>) => Response | Promise<Response>;
}): Route[] {
  return [
    {
      match: (url) => url.includes("api.openai.com/v1/responses"),
      respond: (_url, init) => {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        const isJudge = typeof body.model === "string" && body.model.includes("astra");
        if (isJudge) return (opts.judge ?? (() => responsesOutput(judgeOutput())))(body);
        return opts.draft(body);
      },
    },
  ];
}

export function agentmailReplyRoute(respond: (url: string, init: RequestInit) => Response | Promise<Response>): Route {
  return { match: (url) => url.includes("api.agentmail.to") && url.includes("/reply"), respond };
}

export function withEnv(vars: Record<string, string | undefined>) {
  for (const [k, val] of Object.entries(vars)) {
    if (val === undefined) vi.stubEnv(k, "");
    else vi.stubEnv(k, val);
  }
  return () => vi.unstubAllEnvs();
}

export const TEST_SECRET = "whsec_" + btoa("front-desk-test-secret-key-0123456789");

/** A real inn with a bound inbox, one page version and an inbound thread ready to draft. */
export async function seedLiveInn(t: T, ownerId: Id<"users">, opts: { inboxId?: string; markdown?: string } = {}) {
  return await t.run(async (ctx) => {
    const innId = await ctx.db.insert("inns", {
      name: "Seagull Inn",
      siteUrl: "https://seagull.example",
      timezone: "UTC",
      isDemo: false,
      createdBy: ownerId,
      inboxId: opts.inboxId ?? "seagull@agentmail.to",
      inboxAddress: opts.inboxId ?? "seagull@agentmail.to",
    });
    await ctx.db.insert("memberships", { innId, userId: ownerId, role: "owner", name: "Owner" });
    const pageId = await ctx.db.insert("pages", {
      innId,
      url: "https://seagull.example/policies",
      title: "Policies",
      kind: "policies",
      watched: true,
    });
    const markdown = opts.markdown ?? "# Policies\n\nDogs are welcome for a $25 per night pet fee.\n\nCheck-in is from 3:00 PM.\n";
    const versionId = await ctx.db.insert("pageVersions", {
      pageId,
      markdown,
      hash: "h1",
      scrapedAt: Date.now(),
      changeStatus: "new",
    });
    await ctx.db.patch(pageId, { lastVersionId: versionId });
    return { innId, pageId, versionId, markdown };
  });
}

export async function seedInboundThread(
  t: T,
  innId: Id<"inns">,
  opts: { text?: string; providerMessageId?: string; inboxId?: string } = {},
) {
  return await t.run(async (ctx) => {
    const inn = (await ctx.db.get(innId))!;
    const now = Date.now();
    const threadId = await ctx.db.insert("threads", {
      innId,
      agentmailThreadId: "thr_1",
      guestEmail: "guest@example.com",
      subject: "Dog?",
      snippet: opts.text ?? "Can we bring our dog?",
      status: "new",
      lastInboundAt: now,
      searchableText: "Dog? guest@example.com Can we bring our dog?",
    });
    const messageId = await ctx.db.insert("messages", {
      threadId,
      direction: "in",
      agentmailMessageId: opts.providerMessageId ?? "<msg1@example.com>",
      from: "guest@example.com",
      to: inn.inboxId ?? "inbox",
      text: opts.text ?? "Can we bring our dog?",
      at: now,
      inboxId: opts.inboxId ?? inn.inboxId,
      agentmailThreadId: "thr_1",
    });
    await ctx.db.patch(threadId, { lastInboundMessageId: messageId });
    return { threadId, messageId };
  });
}

/** Lets `runAfter(0)` scheduled functions start, then waits for them to finish. */
export async function settle(t: ReturnType<typeof import("./setup").makeTest>): Promise<void> {
  await new Promise((r) => setTimeout(r, 30));
  await t.finishInProgressScheduledFunctions();
}
