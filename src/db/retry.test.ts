import { describe, expect, it } from "vitest";
import { isConnectionLost, retryRead } from "./retry";

const lost = () => Object.assign(new Error("Failed query: select 1"), { cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }) });

describe("retryRead", () => {
  it("reads again once when the connection died under the first read", async () => {
    let calls = 0;
    const result = await retryRead(async () => {
      calls++;
      if (calls === 1) throw lost();
      return "ok";
    });
    expect(result).toBe("ok");
    expect(calls).toBe(2);
  });

  it("leaves other errors alone, and gives up after the second try", async () => {
    let calls = 0;
    await expect(
      retryRead(async () => {
        calls++;
        throw new Error("syntax error");
      }),
    ).rejects.toThrow("syntax error");
    expect(calls).toBe(1);
    await expect(retryRead(async () => Promise.reject(lost()))).rejects.toThrow("Failed query");
  });

  it("finds the code in wrapped errors", () => {
    expect(isConnectionLost(lost())).toBe(true);
    expect(isConnectionLost(Object.assign(new Error("x"), { code: "CONNECTION_ENDED" }))).toBe(true);
    expect(isConnectionLost(new Error("x"))).toBe(false);
  });
});
