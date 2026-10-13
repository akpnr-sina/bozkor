import { describe, expect, it } from "vitest";
import { isEmailAllowed, parseAllowedEmails } from "./allowlist";

describe("parseAllowedEmails", () => {
  it("trims, lowercases and drops empty entries", () => {
    expect(parseAllowedEmails(" A@bozkor.com, ,b@Bozkor.com ,")).toEqual(
      new Set(["a@bozkor.com", "b@bozkor.com"]),
    );
  });

  it("returns an empty set for a missing value", () => {
    expect(parseAllowedEmails(undefined).size).toBe(0);
  });
});

describe("isEmailAllowed", () => {
  const allowlist = "a@bozkor.com,b@bozkor.com";

  it("accepts a listed address regardless of case and whitespace", () => {
    expect(isEmailAllowed("  A@Bozkor.com ", allowlist)).toBe(true);
  });

  it("rejects an address that is not listed", () => {
    expect(isEmailAllowed("c@bozkor.com", allowlist)).toBe(false);
  });

  it("rejects everyone when the allowlist is empty", () => {
    expect(isEmailAllowed("a@bozkor.com", "")).toBe(false);
    expect(isEmailAllowed("a@bozkor.com", undefined)).toBe(false);
  });

  it("rejects non-string and blank input", () => {
    expect(isEmailAllowed(undefined, allowlist)).toBe(false);
    expect(isEmailAllowed(42, allowlist)).toBe(false);
    expect(isEmailAllowed("   ", allowlist)).toBe(false);
  });
});
