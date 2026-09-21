import { describe, expect, it } from "vitest";
import { decodeSupportedEntities, normalizeText, verifyClaims, verifyQuote } from "../convex/lib/quotes";

const PAGE = `# Policies

## Pets

Well-behaved dogs are welcome in the Garden Rooms for a **$25 per night pet fee**. Dogs may not be left unattended.

- Check-in is from 3:00 PM to 8:00 PM.
- “Quiet hours” run from 10 PM – 8 AM.
`;

describe("verifyQuote", () => {
  it("accepts an exact substring as strict", () => {
    expect(verifyQuote(PAGE, "Dogs may not be left unattended.")).toEqual({ verified: true, method: "strict" });
  });

  it("accepts a quote with markdown emphasis stripped as normalized", () => {
    expect(verifyQuote(PAGE, "Garden Rooms for a $25 per night pet fee")).toEqual({
      verified: true,
      method: "normalized",
    });
  });

  it("normalizes smart quotes, dashes, list markers and whitespace", () => {
    expect(verifyQuote(PAGE, '"Quiet hours" run from 10 PM - 8 AM.')).toMatchObject({ verified: true });
    expect(verifyQuote(PAGE, "check-in is  from 3:00 pm\nto 8:00 pm.")).toMatchObject({ verified: true });
  });

  it("rejects empty and whitespace-only quotes", () => {
    expect(verifyQuote(PAGE, "")).toEqual({ verified: false, reason: "empty" });
    expect(verifyQuote(PAGE, "   \n\t")).toEqual({ verified: false, reason: "empty" });
  });

  it("rejects quotes that are only markdown punctuation", () => {
    expect(verifyQuote(PAGE, "**")).toEqual({ verified: false, reason: "empty" });
    expect(verifyQuote(PAGE, "- ")).toEqual({ verified: false, reason: "empty" });
  });

  it("rejects paraphrases and invented text", () => {
    expect(verifyQuote(PAGE, "Dogs are $30 per night")).toEqual({ verified: false, reason: "not_found" });
    expect(verifyQuote(PAGE, "Dogs are welcome for a small fee")).toEqual({ verified: false, reason: "not_found" });
  });

  it("does not verify anything against an empty page", () => {
    expect(verifyQuote("", "dogs")).toEqual({ verified: false, reason: "not_found" });
    expect(verifyQuote("", "")).toEqual({ verified: false, reason: "empty" });
  });
});

describe("verifyQuote with HTML entities", () => {
  const RAW = "Guests < 12 stay free. Adults > 2 pay extra. Tom & Jerry welcome.";
  const ESCAPED_SOURCE = "Guests &lt; 12 stay free. Adults &gt; 2 pay extra.";

  it("accepts a quote copied from the prompt with < escaped as &lt;, as normalized", () => {
    expect(verifyQuote(RAW, "Guests &lt; 12 stay free.")).toEqual({ verified: true, method: "normalized" });
  });

  it("keeps an exact raw quote strict", () => {
    expect(verifyQuote(RAW, "Guests < 12 stay free.")).toEqual({ verified: true, method: "strict" });
  });

  it("accepts a quote when the source itself is already escaped", () => {
    expect(verifyQuote(ESCAPED_SOURCE, "Guests &lt; 12 stay free.")).toEqual({ verified: true, method: "strict" });
    expect(verifyQuote(ESCAPED_SOURCE, "Guests < 12 stay free.")).toEqual({ verified: true, method: "normalized" });
    expect(verifyQuote(ESCAPED_SOURCE, "Adults > 2 pay extra.")).toEqual({ verified: true, method: "normalized" });
  });

  it("decodes entities only once, so nested escapes stay distinct", () => {
    const nested = "Type &amp;lt; to get a literal entity.";
    expect(verifyQuote(nested, "Type &amp;lt; to get")).toEqual({ verified: true, method: "strict" });
    expect(verifyQuote(nested, "Type &lt; to get")).toEqual({ verified: false, reason: "not_found" });
    expect(verifyQuote(nested, "Type < to get")).toEqual({ verified: false, reason: "not_found" });
    expect(verifyQuote("Type < to get", "Type &amp;lt; to get")).toEqual({ verified: false, reason: "not_found" });
  });

  it("still rejects invented text that merely contains entities", () => {
    expect(verifyQuote(RAW, "Guests &lt; 18 stay free.")).toEqual({ verified: false, reason: "not_found" });
    expect(verifyQuote(RAW, "Guests &gt; 12 stay free.")).toEqual({ verified: false, reason: "not_found" });
    expect(verifyQuote(RAW, "Tom &amp; Jerry pay extra.")).toEqual({ verified: false, reason: "not_found" });
  });

  it("leaves unsupported entities untouched", () => {
    expect(verifyQuote("Costs &euro;50", "Costs €50")).toEqual({ verified: false, reason: "not_found" });
    expect(verifyQuote("Costs €50", "Costs &euro;50")).toEqual({ verified: false, reason: "not_found" });
    expect(verifyQuote("a &#60; b", "a < b")).toEqual({ verified: false, reason: "not_found" });
  });
});

describe("decodeSupportedEntities", () => {
  it("decodes the supported set in one pass", () => {
    expect(decodeSupportedEntities("&lt;&gt;&amp;&quot;&apos;&#39;")).toBe("<>&\"''");
    expect(decodeSupportedEntities("&amp;lt;")).toBe("&lt;");
    expect(decodeSupportedEntities("&nbsp;&#60;&LT;")).toBe("&nbsp;&#60;&LT;");
  });
});

describe("normalizeText", () => {
  it("keeps link text but drops URLs", () => {
    expect(normalizeText("see [our rates](https://x.example/rates) here")).toBe("see our rates here");
  });
  it("lowercases and collapses whitespace", () => {
    expect(normalizeText("  Hello   WORLD\n\n")).toBe("hello world");
  });
});

describe("verifyClaims", () => {
  it("marks failing claims stripped and passing claims ok", () => {
    const result = verifyClaims(PAGE, [
      { statement: "a", quote: "Dogs may not be left unattended." },
      { statement: "b", quote: "" },
      { statement: "c", quote: "Cats welcome" },
    ]);
    expect(result.map((r) => r.status)).toEqual(["ok", "stripped", "stripped"]);
    expect(result[1].verification).toEqual({ verified: false, reason: "empty" });
  });
});
