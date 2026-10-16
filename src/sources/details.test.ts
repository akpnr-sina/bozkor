import { describe, expect, it } from "vitest";
import {
  anyTrue,
  detailsOrNull,
  joinTexts,
  languageCodes,
  monthsBetween,
  percentWeights,
  periodMonths,
  plainText,
  weightKind,
} from "./details";
import type { NoticeDetails } from "./types";

const none: NoticeDetails = {
  durationMonths: null,
  framework: null,
  electronicOrdering: null,
  gpaCovered: null,
  awardCriteria: [],
  selectionCriteria: [],
  guaranteeRequired: null,
  performanceTerms: null,
  submissionLanguages: [],
};

describe("periodMonths", () => {
  it("turns days, weeks and years into months with one decimal", () => {
    expect(periodMonths(24, "MONTH")).toBe(24);
    expect(periodMonths(4, "YEAR")).toBe(48);
    expect(periodMonths(26, "WEEK")).toBe(6);
    expect(periodMonths(45, "DAY")).toBe(1.5);
    expect(periodMonths(12, " month ")).toBe(12);
  });

  it("gives null for an unknown unit or an empty period", () => {
    expect(periodMonths(3, "HOUR")).toBeNull();
    expect(periodMonths(0, "MONTH")).toBeNull();
    expect(periodMonths(Number.NaN, "MONTH")).toBeNull();
  });
});

describe("monthsBetween", () => {
  it("counts a contract from 1 April to 31 March as 12 months", () => {
    expect(monthsBetween(new Date("2027-04-01T00:00:00Z"), new Date("2028-03-31T00:00:00Z"))).toBe(12);
  });

  it("gives null without both dates or when the end comes first", () => {
    expect(monthsBetween(new Date("2027-04-01T00:00:00Z"), null)).toBeNull();
    expect(monthsBetween(new Date("2027-04-01T00:00:00Z"), new Date("2027-03-01T00:00:00Z"))).toBeNull();
  });
});

describe("anyTrue", () => {
  it("is null when no lot says, otherwise whether any lot says yes", () => {
    expect(anyTrue([])).toBeNull();
    expect(anyTrue([false, false])).toBe(false);
    expect(anyTrue([false, true])).toBe(true);
  });
});

describe("percentWeights", () => {
  it("reads eForms and OCDS weight codes", () => {
    expect(["per-exa", "dec-mid", "poi-exa", "ord-imp", "percentageExact", "", null].map(weightKind)).toEqual([
      "percent",
      "decimal",
      "points",
      "order",
      "percent",
      null,
      null,
    ]);
  });

  it("keeps percentages and turns decimals into percentages", () => {
    const weights = percentWeights(
      [
        { number: 60, kind: "percent" },
        { number: 0.25, kind: "decimal" },
        { number: 15, kind: "decimal" },
      ],
      false,
    );
    expect(weights).toEqual([60, 25, 15]);
  });

  it("turns points into shares of the lot's total, only when the whole lot is known", () => {
    const points = [
      { number: 50, kind: "points" as const },
      { number: 10, kind: "points" as const },
      { number: 0, kind: "points" as const },
    ];
    expect(percentWeights(points, true)).toEqual([83.3, 16.7, 0]);
    expect(percentWeights(points, false)).toEqual([null, null, null]);
  });

  it("gives no weight for an order of importance or a missing number", () => {
    expect(
      percentWeights(
        [
          { number: 1, kind: "order" },
          { number: null, kind: "percent" },
          { number: 40, kind: null },
        ],
        true,
      ),
    ).toEqual([null, null, null]);
  });
});

describe("languageCodes", () => {
  it("maps TED codes to ISO 639-1 and drops repeats", () => {
    expect(languageCodes(["NOR", "ENG", "en", "MUL", "xx", "English"])).toEqual(["NO", "EN", "XX"]);
  });
});

describe("plainText", () => {
  it("keeps paragraphs and line breaks and decodes entities once", () => {
    expect(plainText("<p>Rok isporuke: 30 dana.</p><p>Jamstvo &amp; servis<br/>na&nbsp;lokaciji &lt;HR&gt;</p>")).toBe(
      "Rok isporuke: 30 dana.\nJamstvo & servis\nna lokaciji <HR>",
    );
    expect(plainText("a &amp;lt; b")).toBe("a &lt; b");
  });

  it("collapses blank lines", () => {
    expect(plainText("<div>one</div>\n\n\n<div>two</div>")).toBe("one\n\ntwo");
  });
});

describe("joinTexts", () => {
  it("joins distinct texts with a blank line, or gives null", () => {
    expect(joinTexts(["Delivery to Riga.", " Delivery to Riga. ", null, "", "Penalties apply."])).toBe(
      "Delivery to Riga.\n\nPenalties apply.",
    );
    expect(joinTexts([null, " "])).toBeNull();
  });
});

describe("detailsOrNull", () => {
  it("is null when nothing is stated, so folding keeps an earlier notice's details", () => {
    expect(detailsOrNull(none)).toBeNull();
  });

  it("keeps details that state anything, even only a false", () => {
    expect(detailsOrNull({ ...none, framework: false })).toEqual({ ...none, framework: false });
    expect(detailsOrNull({ ...none, submissionLanguages: ["EN"] })).toEqual({ ...none, submissionLanguages: ["EN"] });
  });
});
