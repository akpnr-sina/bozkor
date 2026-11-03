import { describe, expect, it } from "vitest";
import { NAV, navItemOf, navNumber, pageIndex } from "./nav";

describe("the menu", () => {
  it("lists the pages in order, the manufacturers after the inbox", () => {
    expect(NAV.map((item) => [item.href, item.group])).toEqual([
      ["/panel", "Takip"],
      ["/inbox", "Takip"],
      ["/manufacturers", "Takip"],
      ["/profiles", "Yönetim"],
      ["/sources", "Yönetim"],
      ["/settings", "Yönetim"],
    ]);
    expect(NAV.find((item) => item.href === "/manufacturers")?.label).toBe("Üreticiler");
  });

  it("numbers each page among all of them", () => {
    expect(navNumber("/manufacturers")).toBe("03");
    expect(pageIndex("/inbox")).toBe("02 / 06");
    expect(pageIndex("/settings")).toBe("06 / 06");
  });

  it("finds the menu item of a page below it", () => {
    expect(navItemOf("/manufacturers/BZ-09082A7038E3")?.href).toBe("/manufacturers");
    expect(navItemOf("/tenders/abc")?.href).toBe("/inbox");
    expect(navItemOf("/manufacturersx")).toBeUndefined();
    expect(navItemOf("/login")).toBeUndefined();
  });
});
