import { afterEach, describe, expect, it, vi } from "vitest";
import { createBoss } from "./boss";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("createBoss", () => {
  it("hands pg the options that keep a dead connection from hanging the pool", () => {
    vi.stubEnv("DATABASE_URL", "postgres://localhost/bozkor_test");
    // pg-boss's types leave these pg options out, so an inlined options object
    // would not compile with them and they are easy to drop. Read them where
    // pg-boss builds its pool from (its Db's config); constructing opens nothing.
    const db = createBoss().getDb() as unknown as { config: Record<string, unknown> };
    expect(db.config).toMatchObject({
      max: 4,
      idleTimeoutMillis: 5 * 60_000,
      keepAlive: true,
      keepAliveInitialDelayMillis: 10_000,
      query_timeout: 60_000,
    });
  });
});
