import { describe, expect, it } from "vitest";
import { byLotNumber } from "./notice";

describe("byLotNumber", () => {
  it("orders lot numbers naturally", () => {
    const lots = ["10", "2", "1", "LOT-0011", "LOT-0002", "20"].map((lotNumber) => ({ lotNumber }));
    expect(lots.sort(byLotNumber).map((l) => l.lotNumber)).toEqual(["1", "2", "10", "20", "LOT-0002", "LOT-0011"]);
  });
});
