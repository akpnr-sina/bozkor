import { describe, expect, it } from "vitest";
import { facts, lot } from "../../tests/helpers/facts";
import { checkFactsQuotes, evidencedFacts } from "./facts-evidence";
import { readFactsOutput } from "./facts-schema";

const sources = { title: "Maintenance of agricultural machinery", description: "Supply of tyres and fitting services." };

describe("evidencedFacts", () => {
  it("keeps a lot's goods or services class only when its category quote is in the notice", () => {
    const quoted = facts({ lots: [lot({ productTr: "bakım hizmeti", category: "OTHER_GOODS", objectType: "SERVICES", categoryQuote: "Maintenance of agricultural machinery" })] });
    expect(evidencedFacts(quoted, checkFactsQuotes(quoted, sources)).lots[0]!.objectType).toBe("SERVICES");
    const unquoted = facts({ lots: [lot({ productTr: "bakım hizmeti", category: "OTHER_GOODS", objectType: "SERVICES", categoryQuote: "Servicing of all vehicles" })] });
    expect(evidencedFacts(unquoted, checkFactsQuotes(unquoted, sources)).lots[0]!.objectType).toBe("UNKNOWN");
  });
});

describe("readFactsOutput", () => {
  it("reads answers stored before lot lists and goods classes existed", () => {
    const current = facts({ lots: [lot({ productTr: "lastik", category: "OTHER_GOODS" })] });
    const old = JSON.parse(JSON.stringify(current)) as Record<string, unknown> & { lots: Record<string, unknown>[] };
    delete old.lots[0]!.objectType;
    for (const key of ["installation", "commissioningTraining", "localService"]) delete (old[key] as Record<string, unknown>).lots;
    const read = readFactsOutput(old)!;
    expect(read.lots[0]!.objectType).toBe("UNKNOWN");
    expect(read.installation.lots).toEqual([]);
  });
});
