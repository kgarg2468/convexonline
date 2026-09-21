import { describe, expect, it } from "vitest";
import { normalizeText, verifyClaims, verifyQuote } from "../convex/lib/quotes";

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
