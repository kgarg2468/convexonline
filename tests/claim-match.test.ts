import { describe, expect, it } from "vitest";
import { matchClaims } from "../src/workspace/inbox/claimMatch";

const ANSWER =
  "Hi Sam, Harbor View Rooms are $299 per night on Friday and Saturday. Rates include breakfast and parking but not the 10.5% lodging tax. Note that a two-night minimum applies on weekends from May through October.";

describe("matchClaims", () => {
  it("marks a statement that appears verbatim and leaves the rest plain", () => {
    const segments = matchClaims(ANSWER, [{ _id: "c1", statement: "Harbor View Rooms are $299 per night on Friday and Saturday." }]);
    expect(segments).toEqual([
      { text: "Hi Sam, ", claimId: null },
      { text: "Harbor View Rooms are $299 per night on Friday and Saturday.", claimId: "c1" },
      { text: " Rates include breakfast and parking but not the 10.5% lodging tax. Note that a two-night minimum applies on weekends from May through October.", claimId: null },
    ]);
    expect(segments.map((s) => s.text).join("")).toBe(ANSWER);
  });

  it("skips claims whose statement is a paraphrase, silently", () => {
    const segments = matchClaims(ANSWER, [
      { _id: "c2", statement: "Rates exclude the 10.5% lodging tax." },
      { _id: "c3", statement: "Weekends May through October have a two-night minimum." },
    ]);
    expect(segments).toEqual([{ text: ANSWER, claimId: null }]);
  });

  it("folds quotes, whitespace and case on both sides and keeps the answer's own characters", () => {
    const text = "We’d love to have you.\nDogs  are\twelcome in the “Garden Rooms”.";
    const segments = matchClaims(text, [{ _id: "c", statement: 'dogs are welcome in the "garden rooms".' }]);
    expect(segments).toEqual([
      { text: "We’d love to have you.\n", claimId: null },
      { text: "Dogs  are\twelcome in the “Garden Rooms”.", claimId: "c" },
    ]);
  });

  it("matches a statement without its final full stop when the answer punctuates differently", () => {
    const segments = matchClaims("Check-in is from 3:00 PM to 8:00 PM! Ask us about late arrival.", [
      { _id: "c", statement: "Check-in is from 3:00 PM to 8:00 PM." },
    ]);
    expect(segments[0]).toEqual({ text: "Check-in is from 3:00 PM to 8:00 PM", claimId: "c" });
    expect(segments[1]).toEqual({ text: "! Ask us about late arrival.", claimId: null });
  });

  it("keeps the first claim when two statements overlap, and orders segments by position", () => {
    const text = "Breakfast is served 8:00 to 10:00 AM daily. Rooms include Wi-Fi.";
    const segments = matchClaims(text, [
      { _id: "later", statement: "Rooms include Wi-Fi." },
      { _id: "first", statement: "Breakfast is served 8:00 to 10:00 AM" },
      { _id: "overlap", statement: "served 8:00 to 10:00 AM daily." },
    ]);
    expect(segments.map((s) => s.claimId)).toEqual(["first", null, "later"]);
  });

  it("returns nothing for an empty answer and ignores empty statements", () => {
    expect(matchClaims("", [{ _id: "c", statement: "x" }])).toEqual([]);
    expect(matchClaims("Some text.", [{ _id: "c", statement: "   " }])).toEqual([{ text: "Some text.", claimId: null }]);
  });
});
