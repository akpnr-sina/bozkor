import { describe, expect, it } from "vitest";
import { bidWindow, RUBRIC_GROUPS, RUBRIC_METRICS, rubricInterval } from "./rubric";

describe("RUBRIC_METRICS", () => {
  it("has each metric's weight as in section 4", () => {
    expect(Object.fromEntries(RUBRIC_METRICS.map((m) => [m.id, m.weight]))).toEqual({
      A1: 5, A2: 4, A3: 3, A4: 3,
      B1: 5, B2: 4, B3: 4, B4: 2,
      C1: 4, C2: 4, C3: 4, C4: 3,
      D1: 9, D2: 4, D3: 4, D4: 3,
      E1: 6, E2: 3, E3: 3, E4: 3,
      F1: 4, F2: 3, F3: 2, F4: 1,
      G1: 2, G2: 1, G3: 1, G4: 1,
      H1: 2, H2: 1, H3: 1, H4: 1,
    });
  });

  it("has the 32 metrics of section 4 with the group weights of the rubric", () => {
    expect(RUBRIC_METRICS).toHaveLength(32);
    expect(new Set(RUBRIC_METRICS.map((m) => m.id)).size).toBe(32);
    const byGroup = Object.fromEntries(
      Object.keys(RUBRIC_GROUPS).map((group) => [group, RUBRIC_METRICS.filter((m) => m.group === group).reduce((sum, m) => sum + m.weight, 0)]),
    );
    expect(byGroup).toEqual({ A: 15, B: 15, C: 15, D: 20, E: 15, F: 10, G: 5, H: 5 });
  });
});

describe("rubricInterval", () => {
  it("spans 0-100 when nothing is known", () => {
    expect(rubricInterval({})).toEqual({ lower: 0, upper: 100, verifiedWeightPct: 0, assessedWeightPct: 0 });
  });

  it("treats a missing or out-of-scale rating as unknown", () => {
    const unknown = { lower: 0, upper: 100, verifiedWeightPct: 0, assessedWeightPct: 0 };
    expect(rubricInterval({ D1: { rating: null, quality: "VERIFIED" } })).toEqual(unknown);
    expect(rubricInterval({ D1: { rating: 7, quality: "VERIFIED" } })).toEqual(unknown);
    expect(rubricInterval({ D1: { rating: Number.NaN, quality: "PROVISIONAL" } })).toEqual(unknown);
  });

  it("narrows by evidence: verified to a point, provisional by 1.5 within 0-5", () => {
    const result = rubricInterval({
      D1: { rating: 5, quality: "VERIFIED" },
      A1: { rating: 4, quality: "PROVISIONAL" },
      C3: { rating: 1, quality: "PROVISIONAL" },
      B1: { rating: 3, quality: "CONFLICT" },
      E1: { rating: null, quality: "MISSING" },
    });
    // D1: 9 x 5/5 both ways. A1: 5 x 2.5/5 .. 5 x 5/5. C3: 4 x 0 .. 4 x 2.5/5. Others 0 .. full weight.
    expect(result.lower).toBe(9 + 2.5);
    expect(result.upper).toBe(9 + 5 + 2 + (100 - 9 - 5 - 4));
    expect(result).toMatchObject({ verifiedWeightPct: 9, assessedWeightPct: 18 });
  });
});

describe("bidWindow", () => {
  // Wednesday 14 October 2026, 10:00 Istanbul.
  const now = new Date("2026-10-14T07:00:00Z");

  it("counts weekdays from tomorrow to the deadline day", () => {
    // Thu 15, Fri 16, Mon 19, Tue 20, Wed 21.
    expect(bidWindow(new Date("2026-10-21T09:00:00Z"), now)).toEqual({ workingDays: 5, rating: 1 });
    expect(bidWindow(new Date("2026-10-22T09:00:00Z"), now)).toEqual({ workingDays: 6, rating: 2 });
    expect(bidWindow(new Date("2026-10-28T09:00:00Z"), now)).toEqual({ workingDays: 10, rating: 2 });
    expect(bidWindow(new Date("2026-10-29T09:00:00Z"), now)).toEqual({ workingDays: 11, rating: 3 });
    expect(bidWindow(new Date("2026-11-11T09:00:00Z"), now)).toEqual({ workingDays: 20, rating: 3 });
    expect(bidWindow(new Date("2026-11-12T09:00:00Z"), now)).toEqual({ workingDays: 21, rating: 4 });
  });

  it("gives a deadline later today 0 days but still a score of 1, and skips weekends", () => {
    expect(bidWindow(new Date("2026-10-14T13:00:00Z"), now)).toEqual({ workingDays: 0, rating: 1 });
    // Sunday 18 October: Thu 15 and Fri 16 only.
    expect(bidWindow(new Date("2026-10-18T09:00:00Z"), now)).toEqual({ workingDays: 2, rating: 1 });
  });

  it("scores long windows high, a passed deadline 0, an unknown one not at all", () => {
    expect(bidWindow(new Date("2026-12-02T09:00:00Z"), now)).toEqual({ workingDays: 35, rating: 4 });
    expect(bidWindow(new Date("2026-12-03T09:00:00Z"), now)).toEqual({ workingDays: 36, rating: 5 });
    expect(bidWindow(new Date("2026-10-14T06:00:00Z"), now)).toEqual({ workingDays: 0, rating: 0 });
    expect(bidWindow(null, now)).toEqual({ workingDays: null, rating: null });
  });

  it("uses the Istanbul calendar but does not count a day that starts right at the deadline", () => {
    // 23:59 in London on Thursday is 01:59 on Friday in Istanbul: Thursday is the last working day.
    expect(bidWindow(new Date("2026-10-15T22:59:00Z"), now)).toEqual({ workingDays: 1, rating: 1 });
    // 09:00 on Friday in Istanbul counts Friday.
    expect(bidWindow(new Date("2026-10-16T06:00:00Z"), now)).toEqual({ workingDays: 2, rating: 1 });
  });
});
