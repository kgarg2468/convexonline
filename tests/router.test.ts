import { describe, expect, test } from "vitest";
import { THREAD_ID, formatRoute, inboxFilterSearch, landingRoute, parseInboxFilter, parsePath, routeFor, sameRoute } from "../src/workspace/lib/router";

const ID = "j57c2m3k9x1p0q8w4r6t5y2n3b7v1a0z";

describe("parsePath", () => {
  test("names each view", () => {
    expect(parsePath("/overview")).toEqual({ view: "overview" });
    expect(parsePath("/inbox")).toEqual({ view: "inbox", threadId: null });
    expect(parsePath("/changes")).toEqual({ view: "corrections" });
    expect(parsePath("/knowledge")).toEqual({ view: "knowledge" });
    expect(parsePath("/settings")).toEqual({ view: "settings" });
  });

  test("tolerates trailing slashes", () => {
    expect(parsePath("/inbox/")).toEqual({ view: "inbox", threadId: null });
    expect(parsePath("/changes/")).toEqual({ view: "corrections" });
  });

  test("opens a thread by a well-formed id", () => {
    expect(parsePath(`/inbox/${ID}`)).toEqual({ view: "inbox", threadId: ID });
  });

  test("drops a malformed thread id but stays in the inbox", () => {
    expect(parsePath("/inbox/<script>")).toEqual({ view: "inbox", threadId: null });
    expect(parsePath("/inbox/too-short")).toEqual({ view: "inbox", threadId: null });
    expect(parsePath("/inbox/a%20b")).toEqual({ view: "inbox", threadId: null });
  });

  test("returns null for the root and unknown paths so the caller can pick the landing view", () => {
    expect(parsePath("/")).toBeNull();
    expect(parsePath("")).toBeNull();
    expect(parsePath("/dashboard")).toBeNull();
    expect(parsePath("/overview/extra")).toBeNull();
    expect(parsePath("/changes/extra")).toBeNull();
    expect(parsePath("/settings/team/x")).toBeNull();
    expect(parsePath("/Inbox")).toBeNull();
  });
});

describe("formatRoute", () => {
  test("round-trips every route", () => {
    for (const route of [
      routeFor("overview"),
      routeFor("inbox"),
      routeFor("inbox", ID),
      routeFor("corrections"),
      routeFor("knowledge"),
      routeFor("settings"),
    ]) {
      expect(parsePath(formatRoute(route))).toEqual(route);
    }
  });

  test("writes the inbox with and without a thread", () => {
    expect(formatRoute({ view: "inbox", threadId: null })).toBe("/inbox");
    expect(formatRoute({ view: "inbox", threadId: ID })).toBe(`/inbox/${ID}`);
  });
});

describe("landingRoute", () => {
  test("demo visitors land on the policy-change review, staff on the Overview", () => {
    expect(landingRoute(true)).toEqual({ view: "corrections" });
    expect(landingRoute(false)).toEqual({ view: "overview" });
  });
});

describe("inbox filter query", () => {
  test("reads a known status from ?filter= and ignores anything else", () => {
    expect(parseInboxFilter("?filter=needs_staff")).toBe("needs_staff");
    expect(parseInboxFilter("?filter=ready")).toBe("ready");
    expect(parseInboxFilter("?x=1&filter=closed")).toBe("closed");
    expect(parseInboxFilter("")).toBeNull();
    expect(parseInboxFilter("?filter=")).toBeNull();
    expect(parseInboxFilter("?filter=all")).toBeNull();
    expect(parseInboxFilter("?filter=<script>")).toBeNull();
    expect(parseInboxFilter("?other=needs_staff")).toBeNull();
  });

  test("round-trips the search it writes", () => {
    expect(inboxFilterSearch("needs_staff")).toBe("?filter=needs_staff");
    expect(parseInboxFilter(inboxFilterSearch("ready"))).toBe("ready");
  });
});

describe("sameRoute and THREAD_ID", () => {
  test("compares by path, not identity", () => {
    expect(sameRoute(routeFor("inbox", ID), { view: "inbox", threadId: ID })).toBe(true);
    expect(sameRoute(routeFor("inbox", ID), routeFor("inbox"))).toBe(false);
    expect(sameRoute(routeFor("knowledge"), routeFor("settings"))).toBe(false);
  });

  test("accepts Convex-shaped ids only", () => {
    expect(THREAD_ID.test(ID)).toBe(true);
    expect(THREAD_ID.test("")).toBe(false);
    expect(THREAD_ID.test("abc")).toBe(false);
    expect(THREAD_ID.test("a".repeat(65))).toBe(false);
    expect(THREAD_ID.test(`${ID}/x`)).toBe(false);
  });
});
