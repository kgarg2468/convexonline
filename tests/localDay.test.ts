import { describe, expect, it } from "vitest";
import { localDayOf, localDayStartMs } from "../convex/lib/localDay";

const HOUR = 60 * 60 * 1000;
const utc = (iso: string) => Date.parse(iso);

describe("localDayOf", () => {
  it("resolves the calendar day and its bounds in a fixed-offset zone", () => {
    // 03:30 UTC on the 15th is 23:30 on the 14th in New York (EDT, UTC-4).
    const day = localDayOf("America/New_York", utc("2026-06-15T03:30:00Z"));
    expect(day.dayKey).toBe("2026-06-14");
    expect(day.startMs).toBe(utc("2026-06-14T04:00:00Z"));
    expect(day.endMs).toBe(utc("2026-06-15T04:00:00Z"));
    expect(day.timezone).toBe("America/New_York");
    // Half-hour offsets work the same way.
    const kolkata = localDayOf("Asia/Kolkata", utc("2026-06-14T18:45:00Z"));
    expect(kolkata.dayKey).toBe("2026-06-15");
    expect(kolkata.startMs).toBe(utc("2026-06-14T18:30:00Z"));
  });

  it("spring-forward day is 23 hours long and starts at local midnight", () => {
    // New York moves from EST to EDT at 02:00 on 2026-03-08.
    const day = localDayOf("America/New_York", utc("2026-03-08T15:00:00Z"));
    expect(day.dayKey).toBe("2026-03-08");
    expect(day.startMs).toBe(utc("2026-03-08T05:00:00Z")); // midnight EST
    expect(day.endMs).toBe(utc("2026-03-09T04:00:00Z")); // midnight EDT
    expect(day.endMs - day.startMs).toBe(23 * HOUR);
  });

  it("fall-back day is 25 hours long", () => {
    // New York moves from EDT back to EST at 02:00 on 2026-11-01.
    const day = localDayOf("America/New_York", utc("2026-11-01T12:00:00Z"));
    expect(day.dayKey).toBe("2026-11-01");
    expect(day.startMs).toBe(utc("2026-11-01T04:00:00Z")); // midnight EDT
    expect(day.endMs).toBe(utc("2026-11-02T05:00:00Z")); // midnight EST
    expect(day.endMs - day.startMs).toBe(25 * HOUR);
    // The repeated 01:00 hour is still inside the same day.
    expect(localDayOf("America/New_York", utc("2026-11-01T05:30:00Z")).dayKey).toBe("2026-11-01");
    expect(localDayOf("America/New_York", utc("2026-11-01T06:30:00Z")).dayKey).toBe("2026-11-01");
  });

  it("a zone whose DST gap starts at midnight begins the day at the first existing instant", () => {
    // Chile: 2026-09-06 00:00 CLT jumps straight to 01:00 CLST.
    const day = localDayOf("America/Santiago", utc("2026-09-06T12:00:00Z"));
    expect(day.dayKey).toBe("2026-09-06");
    expect(day.startMs).toBe(utc("2026-09-06T04:00:00Z"));
    expect(day.endMs).toBe(utc("2026-09-07T03:00:00Z"));
    expect(day.endMs - day.startMs).toBe(23 * HOUR);
  });

  it("UTC boundaries are exact and UTC is the fallback for unusable zones", () => {
    const beforeMidnight = localDayOf("UTC", utc("2026-06-14T23:59:59.999Z"));
    expect(beforeMidnight.dayKey).toBe("2026-06-14");
    expect(beforeMidnight.endMs).toBe(utc("2026-06-15T00:00:00Z"));
    const atMidnight = localDayOf("UTC", utc("2026-06-15T00:00:00Z"));
    expect(atMidnight.dayKey).toBe("2026-06-15");
    expect(atMidnight.startMs).toBe(utc("2026-06-15T00:00:00Z"));
    for (const bad of ["", "Mars/Olympus", "not a zone"]) {
      const day = localDayOf(bad, utc("2026-06-15T00:00:00Z"));
      expect(day.timezone).toBe("UTC");
      expect(day.startMs).toBe(utc("2026-06-15T00:00:00Z"));
    }
    expect(localDayStartMs("UTC", utc("2026-06-15T13:00:00Z"))).toBe(utc("2026-06-15T00:00:00Z"));
  });

  it("every instant of a year lands inside [startMs, endMs) of its own day", () => {
    for (const zone of ["America/New_York", "Europe/London", "Pacific/Auckland", "Asia/Kolkata", "America/Santiago"]) {
      let previousStart = -Infinity;
      for (let t = utc("2026-01-01T00:00:00Z"); t < utc("2027-01-01T00:00:00Z"); t += 7 * HOUR + 17 * 60 * 1000) {
        const day = localDayOf(zone, t);
        expect(t).toBeGreaterThanOrEqual(day.startMs);
        expect(t).toBeLessThan(day.endMs);
        expect(day.endMs - day.startMs).toBeGreaterThanOrEqual(23 * HOUR);
        expect(day.endMs - day.startMs).toBeLessThanOrEqual(25 * HOUR);
        expect(day.startMs).toBeGreaterThanOrEqual(previousStart);
        previousStart = day.startMs;
      }
    }
  });
});
