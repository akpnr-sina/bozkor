import { describe, expect, it } from "vitest";
import { findQuote, normalizeQuoteText } from "./quotes";

const sources = {
  title: "Supply of Diesel Generating Sets \u2013 500 kVA",
  description:
    "The Contractor shall provide \u201Con-site\u201D installation and commissioning.\n\nDelivery   within 12 weeks of the order.",
  "lot:1:title": "Lot 1: Diesel Generating Sets",
  "lot:1:quantity": "3 units",
  "lot:2:description": "Fourniture de groupes électrogènes et câbles associés",
};

describe("normalizeQuoteText", () => {
  it("folds case, spacing, quotation marks and dashes", () => {
    expect(normalizeQuoteText("  The \u201CCONTRACTOR\u201D\n\tshall \u2014 provide\u2026 ")).toBe('the "contractor" shall - provide...');
    expect(normalizeQuoteText("it\u2019s \u00ABfine\u00BB")).toBe("it's \"fine\"");
  });

  it("applies NFKC to full-width forms and ligatures", () => {
    expect(normalizeQuoteText("\uFF15\uFF10\uFF10 \uFF4B\uFF36\uFF21 \uFB01lter")).toBe("500 kva filter");
  });

  it("drops invisible format characters, before composing accents", () => {
    expect(normalizeQuoteText("zero\u200Bwidth soft\u00ADhyphen \u200Emark")).toBe("zerowidth softhyphen mark");
    expect(normalizeQuoteText("cafe\u200B\u0301")).toBe("caf\u00E9");
  });
});

describe("findQuote", () => {
  it("finds an exact copy and returns the key of its source", () => {
    expect(findQuote("installation and commissioning", sources)).toBe("description");
    expect(findQuote("groupes électrogènes et câbles", sources)).toBe("lot:2:description");
  });

  it("ignores case and differences in spacing and line breaks", () => {
    expect(findQuote("the CONTRACTOR shall   provide", sources)).toBe("description");
    expect(findQuote("commissioning. Delivery within 12 weeks", sources)).toBe("description");
  });

  it("accepts straight quotation marks and plain hyphens for their typographic variants", () => {
    expect(findQuote('provide "on-site" installation', sources)).toBe("description");
    expect(findQuote("Generating Sets - 500 kVA", sources)).toBe("title");
    expect(findQuote("Generating Sets \u2014 500 kVA", sources)).toBe("title");
  });

  it("drops quotation marks and an ellipsis around the quote", () => {
    expect(findQuote("installation and commissioning...", sources)).toBe("description");
    expect(findQuote("installation and commissioning\u2026", sources)).toBe("description");
    expect(findQuote("...the Contractor shall provide", sources)).toBe("description");
    expect(findQuote("\u201CDelivery within 12 weeks of the order.\u201D", sources)).toBe("description");
  });

  it("matches full-width characters through NFKC", () => {
    expect(findQuote("Sets \u2013 \uFF15\uFF10\uFF10 kVA", sources)).toBe("title");
  });

  it("matches across zero-width spaces and soft hyphens in the source", () => {
    const marked = {
      description: "Delivery of tyres for light vehicles \u200B\u200Bowned by the buyer",
      "lot:1:description": "Ver\u00ADsicherung der Anlage",
    };
    expect(findQuote("light vehicles owned by the buyer", marked)).toBe("description");
    expect(findQuote("Versicherung der Anlage", marked)).toBe("lot:1:description");
  });

  it("returns the first source in order when several contain the quote", () => {
    expect(findQuote("Diesel Generating Sets", sources)).toBe("title");
  });

  it("rejects empty and very short quotes", () => {
    expect(findQuote("", sources)).toBeNull();
    expect(findQuote("   ", sources)).toBeNull();
    expect(findQuote("...", sources)).toBeNull();
    // "3 units" is in a source, but seven characters prove nothing.
    expect(findQuote("3 units", sources)).toBeNull();
  });

  it("rejects paraphrases, translations and quotes stitched across sources", () => {
    expect(findQuote("The supplier must install the generators", sources)).toBeNull();
    expect(findQuote("Supply of diesel generators", sources)).toBeNull();
    expect(findQuote("Diesel Generating Sets 3 units", sources)).toBeNull();
    expect(findQuote("installation ... within 12 weeks", sources)).toBeNull();
  });

  it("finds nothing in empty sources", () => {
    expect(findQuote("installation and commissioning", {})).toBeNull();
  });
});
