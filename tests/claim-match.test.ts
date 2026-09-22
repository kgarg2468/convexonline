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

  it("links a paraphrased statement to the sentence sharing its content words", () => {
    const segments = matchClaims(ANSWER, [
      { _id: "c2", statement: "Rates exclude the 10.5% lodging tax." },
      { _id: "c3", statement: "Weekends May through October have a two-night minimum." },
    ]);
    expect(segments).toEqual([
      { text: "Hi Sam, Harbor View Rooms are $299 per night on Friday and Saturday. ", claimId: null },
      { text: "Rates include breakfast and parking but not the 10.5% lodging tax.", claimId: "c2" },
      { text: " ", claimId: null },
      { text: "Note that a two-night minimum applies on weekends from May through October.", claimId: "c3" },
    ]);
    expect(segments.map((s) => s.text).join("")).toBe(ANSWER);
  });

  it("links all three seeded claims of the demo's ready draft, exact and paraphrased alike", () => {
    const segments = matchClaims(ANSWER, [
      { _id: "c1", statement: "Harbor View Rooms are $299 per night on Friday and Saturday." },
      { _id: "c2", statement: "Rates exclude the 10.5% lodging tax." },
      { _id: "c3", statement: "Weekends May through October have a two-night minimum." },
    ]);
    expect(segments.filter((s) => s.claimId !== null).map((s) => s.claimId)).toEqual(["c1", "c2", "c3"]);
  });

  it("links 'Check-in runs…' to the sentence that says 'Check-in is…'", () => {
    const text = "Check-in is from 3:00 PM to 8:00 PM. Ask us about late arrival.";
    const segments = matchClaims(text, [{ _id: "c", statement: "Check-in runs from 3:00 PM to 8:00 PM." }]);
    expect(segments).toEqual([
      { text: "Check-in is from 3:00 PM to 8:00 PM.", claimId: "c" },
      { text: " Ask us about late arrival.", claimId: null },
    ]);
  });

  it("refuses a paraphrase whose number differs, even when every word matches", () => {
    const text = "Well-behaved dogs are welcome in the Garden Rooms for a $40 per night pet fee, limited to one dog per room.";
    const segments = matchClaims(text, [{ _id: "c", statement: "Dogs stay in the Garden Rooms for a $25 per night pet fee." }]);
    expect(segments).toEqual([{ text, claimId: null }]);
  });

  it("refuses a paraphrase whose polarity differs, so a negated sentence never cites the opposite claim", () => {
    const claims = [{ _id: "c1", statement: "Smoking is allowed on the balconies." }];
    expect(matchClaims("Smoking is not allowed on the balconies.", claims)).toEqual([
      { text: "Smoking is not allowed on the balconies.", claimId: null },
    ]);
    expect(matchClaims("Smoking isn't allowed on the balconies.", claims)).toEqual([
      { text: "Smoking isn't allowed on the balconies.", claimId: null },
    ]);
    // Agreeing negations still link, and a plain sentence never cites a negated claim.
    const negated = [{ _id: "c2", statement: "Pets are not allowed in the dining room." }];
    expect(matchClaims("Pets are not permitted in the dining room.", negated)).toEqual([
      { text: "Pets are not permitted in the dining room.", claimId: "c2" },
    ]);
    expect(matchClaims("Pets are allowed in the dining room.", negated)).toEqual([
      { text: "Pets are allowed in the dining room.", claimId: null },
    ]);
  });

  it("gives a sentence wanted by two claims to the better-scoring one, whatever the claim order", () => {
    const text = "Check-in is from 3:00 PM to 8:00 PM daily. We look forward to hosting you.";
    const segments = matchClaims(text, [
      { _id: "weaker", statement: "The check-in desk opens at 3:00 PM for arrivals daily." },
      { _id: "better", statement: "Check-in runs from 3:00 PM to 8:00 PM." },
    ]);
    expect(segments).toEqual([
      { text: "Check-in is from 3:00 PM to 8:00 PM daily.", claimId: "better" },
      { text: " We look forward to hosting you.", claimId: null },
    ]);
  });

  it("leaves an unrelated sentence unlinked", () => {
    const text = "Thanks for writing to us. We look forward to hosting you in October.";
    const segments = matchClaims(text, [{ _id: "c", statement: "Rates exclude the 10.5% lodging tax." }]);
    expect(segments).toEqual([{ text, claimId: null }]);
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
