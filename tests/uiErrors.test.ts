import { ConvexError } from "convex/values";
import { describe, expect, it } from "vitest";
import { errorMessage } from "../src/workspace/lib/format";

// Disclosure and control-character boundary tests for the staff-facing error
// formatter. They pin what may reach the screen, not how the formatter works.

const GENERIC_INVALID = "The server rejected that request.";
const invalid = (message: string) => new ConvexError({ code: "invalid", message });
const claimed = (data: Record<string, unknown>) => new ConvexError({ code: "claimed", ...data });

const tz = (value: string) =>
  `Time zone "${value}" is not recognized; use an IANA name like America/New_York`;

// Built from code points so the source stays printable and no raw control
// bytes are checked in.
const cp = (code: number) => String.fromCodePoint(code);
const LINE_SEPARATOR = cp(0x2028); // Zl
const PARAGRAPH_SEPARATOR = cp(0x2029); // Zp
const RTL_OVERRIDE = cp(0x202e); // Cf, bidi
const LTR_ISOLATE = cp(0x2066); // Cf, bidi
const NEL = cp(0x0085); // Cc, C1 control
const CSI = cp(0x009b); // Cc, C1 control
const ZERO_WIDTH_SPACE = cp(0x200b); // Cf
const DEL = cp(0x007f); // Cc

describe("errorMessage: invalid", () => {
  it("keeps internal invariant failures thrown with code invalid off the screen", () => {
    // Real messages from convex/outbox.ts. Short and single-line, yet not for staff.
    expect(errorMessage(invalid("thread missing at commit"))).toBe(GENERIC_INVALID);
    expect(errorMessage(invalid("follow-ups commit through commitFollowUpDelivery"))).toBe(GENERIC_INVALID);
    expect(errorMessage(invalid("no draft for sent reply"))).toBe(GENERIC_INVALID);
  });

  it("keeps unknown short messages generic rather than inferring safety from length", () => {
    expect(errorMessage(invalid("nope"))).toBe(GENERIC_INVALID);
    expect(errorMessage(invalid(""))).toBe(GENERIC_INVALID);
    expect(errorMessage(new ConvexError({ code: "invalid" }))).toBe(GENERIC_INVALID);
  });

  it("shows the property form's own validation sentences", () => {
    expect(errorMessage(invalid("Inn name is required"))).toBe("Inn name is required");
    expect(errorMessage(invalid("Website is required"))).toBe("Website is required");
    expect(errorMessage(invalid("Website must start with https://"))).toBe("Website must start with https://");
    expect(
      errorMessage(invalid("Website must be a public https address (not localhost, a private network, or a bare IP)")),
    ).toBe("Website must be a public https address (not localhost, a private network, or a bare IP)");
    expect(errorMessage(invalid(tz("Nowhere/Abc123")))).toBe(tz("Nowhere/Abc123"));
  });

  it("does not treat a safe sentence as a prefix or suffix licence", () => {
    expect(errorMessage(invalid("Website is required. Stack: at commit (outbox.ts:269)"))).toBe(GENERIC_INVALID);
    expect(errorMessage(invalid(`${tz("X")} extra`))).toBe(GENERIC_INVALID);
    expect(errorMessage(invalid(`internal: ${tz("X")}`))).toBe(GENERIC_INVALID);
    expect(errorMessage(invalid(tz("")))).toBe(GENERIC_INVALID);
  });

  it("rejects time-zone feedback carrying separators, bidi or C1 controls", () => {
    const bad: Array<[string, string]> = [
      ["line separator", `Europe/${LINE_SEPARATOR}Paris`],
      ["paragraph separator", `Europe/${PARAGRAPH_SEPARATOR}Paris`],
      ["right-to-left override", `Europe/${RTL_OVERRIDE}Paris`],
      ["left-to-right isolate", `Europe/${LTR_ISOLATE}Paris`],
      ["NEL (C1)", `Europe/${NEL}Paris`],
      ["CSI (C1)", `Europe/${CSI}Paris`],
      ["zero-width space", `Europe/${ZERO_WIDTH_SPACE}Paris`],
      ["newline (C0)", "Europe/\nParis"],
      ["DEL", `Europe/${DEL}Paris`],
    ];
    for (const [label, value] of bad) {
      expect(errorMessage(invalid(tz(value))), label).toBe(GENERIC_INVALID);
    }
  });

  it("still allows ordinary non-ASCII letters in a typed zone", () => {
    expect(errorMessage(invalid(tz("Europe/Zürich")))).toBe(tz("Europe/Zürich"));
  });

  it("caps the length even for the anchored template", () => {
    const long = tz("X".repeat(400));
    expect(errorMessage(invalid(long))).toBe(GENERIC_INVALID);
  });
});

describe("errorMessage: claimed", () => {
  it("keeps an explicit safe server sentence", () => {
    expect(errorMessage(claimed({ message: "Claim the thread before approving a follow-up" }))).toBe(
      "Claim the thread before approving a follow-up",
    );
  });

  it("falls back to holder metadata when the explicit message carries controls", () => {
    const withHolder = claimed({ message: `Claim${RTL_OVERRIDE} the thread`, heldByName: "Dana" });
    expect(errorMessage(withHolder)).toMatch(/^Dana is working on this thread/);
    const multiline = claimed({ message: "Error: x\n    at commit (outbox.ts:1)", heldByName: "Dana" });
    expect(errorMessage(multiline)).toMatch(/^Dana is working on this thread/);
    const c1 = claimed({ message: `Claim${NEL}first`, heldByName: "Dana" });
    expect(errorMessage(c1)).toMatch(/^Dana is working on this thread/);
  });

  it("falls back to the active-claim sentence with no holder and no safe message", () => {
    expect(errorMessage(claimed({ message: `a${LINE_SEPARATOR}b` }))).toBe(
      "You need an active claim on this thread to continue.",
    );
    expect(errorMessage(claimed({}))).toBe("You need an active claim on this thread to continue.");
  });
});
