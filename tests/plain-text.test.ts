import { describe, expect, it } from "vitest";
import { plainText } from "../src/workspace/corrections/plainText";

describe("plainText", () => {
  it("strips strong emphasis so the fixture passage reads as prose", () => {
    expect(plainText("Well-behaved dogs are welcome in the Garden Rooms for a **$40 per night pet fee**, limited to one dog per room.")).toBe(
      "Well-behaved dogs are welcome in the Garden Rooms for a $40 per night pet fee, limited to one dog per room.",
    );
  });

  it("strips single-asterisk and double-underscore emphasis", () => {
    expect(plainText("Check-in is *from* 3:00 PM and __ends__ at 8:00 PM.")).toBe("Check-in is from 3:00 PM and ends at 8:00 PM.");
  });

  it("strips code spans", () => {
    expect(plainText("Use the `side gate` after 8 PM.")).toBe("Use the side gate after 8 PM.");
  });

  it("leaves prose without markers untouched, including prices and snake_case", () => {
    const text = "A $25 per night pet fee applies; see pet_policy for details.";
    expect(plainText(text)).toBe(text);
  });

  it("removes unbalanced markers rather than guessing at their pairing", () => {
    expect(plainText("a **$40 per night fee, limited")).toBe("a $40 per night fee, limited");
  });

  it("keeps whitespace and line breaks exactly", () => {
    expect(plainText("**Pets**\n\n  Dogs   welcome.")).toBe("Pets\n\n  Dogs   welcome.");
  });
});
