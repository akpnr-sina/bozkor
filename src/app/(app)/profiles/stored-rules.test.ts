import { describe, expect, it } from "vitest";
import { readStoredRules } from "./stored-rules";

describe("readStoredRules", () => {
  it("returns valid rules untouched", () => {
    const { rules, problems } = readStoredRules({ cpvInclude: ["3112"], keywordsAny: ["generator"] });
    expect(problems).toEqual([]);
    expect(rules).toMatchObject({ cpvInclude: ["3112"], keywordsAny: ["generator"] });
  });

  it("drops only the invalid items and reports them", () => {
    const { rules, problems } = readStoredRules({ cpvInclude: ["3112", "abc"], keywordsAll: ["--"], keywordsAny: ["cable"] });
    expect(rules).toMatchObject({ cpvInclude: ["3112"], keywordsAll: [], keywordsAny: ["cable"] });
    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain('"abc"');
  });

  it("resets an invalid field to its default", () => {
    const { rules, problems } = readStoredRules({ triageThreshold: "high", valueMinEur: 500, valueMaxEur: 100 });
    expect(rules.triageThreshold).toBe(60);
    expect(rules.valueMinEur).toBe(500);
    expect(rules.valueMaxEur).toBeNull();
    expect(problems).toHaveLength(2);
  });

  it("falls back to defaults for something that is not an object", () => {
    expect(readStoredRules("nonsense").rules).toMatchObject({ cpvInclude: [], noticeTypes: ["tender"] });
  });
});
