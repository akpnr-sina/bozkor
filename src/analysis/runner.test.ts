import { describe, expect, it } from "vitest";
import { parseJsonText } from "./runner";

describe("parseJsonText", () => {
  it("reads plain JSON, and the outermost object of wrapped text", () => {
    expect(parseJsonText('{"a":1}')).toEqual({ a: 1 });
    expect(parseJsonText('```json\n{"a":{"b":[1,2]}}\n```')).toEqual({ a: { b: [1, 2] } });
    expect(parseJsonText('İşte yanıt: {"a":"x}y"} Bitti.')).toEqual({ a: "x}y" });
  });

  it("throws when there is no JSON object", () => {
    expect(() => parseJsonText("JSON yok")).toThrow();
    expect(() => parseJsonText('{"a":')).toThrow();
  });
});
