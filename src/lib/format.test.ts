import { describe, expect, it } from "vitest";
import { countryName, formatAgo, formatClock, formatLongDate } from "./format";

describe("formatClock", () => {
  it("shows the time alone on the same Istanbul day, with the day otherwise", () => {
    const now = new Date("2026-10-20T15:00:00Z"); // 18:00 in Istanbul
    expect(formatClock(new Date("2026-10-20T11:20:00Z"), now)).toBe("14:20");
    // 23:30 UTC on the 19th is already 02:30 on the 20th in Istanbul.
    expect(formatClock(new Date("2026-10-19T23:30:00Z"), now)).toBe("02:30");
    expect(formatClock(new Date("2026-10-19T20:00:00Z"), now)).toBe("19.10 23:00");
  });
});

describe("formatAgo", () => {
  it("says how long ago, short", () => {
    const now = new Date("2026-10-20T15:00:00Z");
    const ago = (minutes: number) => formatAgo(new Date(now.getTime() - minutes * 60_000), now);
    expect(ago(0.5)).toBe("şimdi");
    expect(ago(12)).toBe("12 dk");
    expect(ago(59)).toBe("59 dk");
    expect(ago(60)).toBe("1 sa");
    expect(ago(60 * 23 + 59)).toBe("23 sa");
    expect(ago(60 * 49)).toBe("2 gün");
  });
});

describe("formatLongDate and countryName", () => {
  it("names the day and the country in Turkish", () => {
    expect(formatLongDate(new Date("2026-10-20T15:00:00Z"))).toBe("20 Ekim 2026 · Salı");
    expect(countryName("DE")).toBe("Almanya");
    expect(countryName("gb")).toBe("Birleşik Krallık");
    expect(countryName(null)).toBe("Belirtilmemiş");
    expect(countryName("??")).toBe("??");
  });
});
