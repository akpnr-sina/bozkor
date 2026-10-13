import { describe, expect, it } from "vitest";
import { parseTimestamp, toZonedLocal, zonedLocalToUtc } from "./time";

const LONDON = "Europe/London";

describe("toZonedLocal", () => {
  it("formats summer time in London one hour ahead of UTC", () => {
    expect(toZonedLocal(new Date("2026-10-12T00:00:00Z"), LONDON)).toBe("2026-10-12T01:00:00");
  });

  it("formats winter time in London equal to UTC", () => {
    expect(toZonedLocal(new Date("2026-12-01T09:30:15Z"), LONDON)).toBe("2026-12-01T09:30:15");
  });

  it("formats Istanbul three hours ahead of UTC", () => {
    expect(toZonedLocal(new Date("2026-12-01T21:00:00Z"), "Europe/Istanbul")).toBe("2026-12-02T00:00:00");
  });
});

describe("zonedLocalToUtc", () => {
  it("round-trips across summer, winter and the day clocks change", () => {
    for (const iso of ["2026-07-01T12:00:00Z", "2026-12-01T12:00:00Z", "2026-10-25T02:30:00Z", "2026-03-29T01:30:00Z"]) {
      const date = new Date(iso);
      expect(zonedLocalToUtc(toZonedLocal(date, LONDON), LONDON)?.toISOString()).toBe(date.toISOString());
    }
  });

  it("resolves the repeated hour of the autumn change to standard time", () => {
    // 01:30 happens twice in London on 25 October 2026.
    expect(zonedLocalToUtc("2026-10-25T01:30:00", LONDON)?.toISOString()).toBe("2026-10-25T01:30:00.000Z");
  });

  it("rejects text that is not a date", () => {
    expect(zonedLocalToUtc("yesterday", LONDON)).toBeNull();
  });
});

describe("parseTimestamp", () => {
  it("honours explicit offsets", () => {
    expect(parseTimestamp("2026-10-12T16:26:28+01:00", LONDON)?.toISOString()).toBe("2026-10-12T15:26:28.000Z");
    expect(parseTimestamp("2026-11-11T12:00:00Z", LONDON)?.toISOString()).toBe("2026-11-11T12:00:00.000Z");
    expect(parseTimestamp("2026-11-06T23:59:00+00:00", LONDON)?.toISOString()).toBe("2026-11-06T23:59:00.000Z");
  });

  it("reads offset-less values in the given zone, not the server's", () => {
    expect(parseTimestamp("2026-10-12T16:00:00", LONDON)?.toISOString()).toBe("2026-10-12T15:00:00.000Z");
    expect(parseTimestamp("2026-11-11", LONDON)?.toISOString()).toBe("2026-11-11T00:00:00.000Z");
  });

  it("returns null for empty or unreadable values", () => {
    expect(parseTimestamp(null, LONDON)).toBeNull();
    expect(parseTimestamp("", LONDON)).toBeNull();
    expect(parseTimestamp("not a date", LONDON)).toBeNull();
  });
});
