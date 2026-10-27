import { describe, expect, it } from "vitest";
import { createCreditPause } from "./credit-pause";

describe("createCreditPause", () => {
  it("runs as asked while there is credit, pauses once it runs out and then tries one item", () => {
    let now = 0;
    const pause = createCreditPause(() => now, 30);
    expect(pause.limits(60, 3)).toEqual({ limit: 60, concurrency: 3 });
    expect(pause.record({ stoppedBy: null, attempted: 60 })).toBeNull();

    expect(pause.record({ stoppedBy: "credit", attempted: 3 })).toBe("ran-out");
    expect(pause.limits(60, 3)).toBeNull();
    now = 29;
    expect(pause.limits(60, 3)).toBeNull();
    now = 30;
    expect(pause.limits(60, 3)).toEqual({ limit: 1, concurrency: 1 });

    // Still out: said once, and the pause starts again.
    expect(pause.record({ stoppedBy: "credit", attempted: 1 })).toBeNull();
    now = 45;
    expect(pause.limits(60, 3)).toBeNull();
    now = 60;
    expect(pause.record({ stoppedBy: null, attempted: 0 })).toBeNull();
    expect(pause.limits(60, 3)).toEqual({ limit: 1, concurrency: 1 });

    expect(pause.record({ stoppedBy: "errors", attempted: 1 })).toBe("back");
    expect(pause.limits(60, 3)).toEqual({ limit: 60, concurrency: 3 });
    expect(pause.record({ stoppedBy: "credit", attempted: 3 })).toBe("ran-out");
  });
});
